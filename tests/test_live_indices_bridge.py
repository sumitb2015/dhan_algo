"""scripts/tools/live_indices_ws.py: two bridges must not be able to run at once or corrupt each other's files.

Regression for the FileNotFoundError seen 41 times in debug/live_indices_ws.log: two bridges started within seconds of each
other (the start route only blocks a second start once the status is RUNNING, and a fresh bridge sits in STARTING for many
seconds), both wrote `<file>.tmp`, one consumed the other's temp file and died on os.replace.

No Dhan connection and no real debug/ files: paths are redirected into a temp directory. Run from the project root:
    venv/bin/python -m unittest tests.test_live_indices_bridge
"""
import importlib.util
import os
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
BRIDGE = os.path.join(ROOT, 'scripts', 'tools', 'live_indices_ws.py')

spec = importlib.util.spec_from_file_location('live_indices_ws_under_test', BRIDGE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

# Runs in a child process: the same atomic_write the bridge uses, hammered on one shared path.
WRITER = textwrap.dedent('''
    import importlib.util, sys, time
    spec = importlib.util.spec_from_file_location('b', sys.argv[1])
    b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
    payload = {'ticks': [{'t': i, **{f's{j}': j * 1.5 for j in range(26)}} for i in range(300)]}
    fails = 0
    for _ in range(1500):
        try: b.atomic_write(sys.argv[2], payload)
        except FileNotFoundError: fails += 1
        time.sleep(0.001)
    print(fails)
''')


class AtomicWriteRace(unittest.TestCase):
    def test_two_processes_writing_one_file_never_fail(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'shared.json')
            procs = [subprocess.Popen([sys.executable, '-c', WRITER, BRIDGE, path], stdout=subprocess.PIPE, text=True) for _ in range(2)]
            fails = [int(p.communicate(timeout=120)[0].strip()) for p in procs]
            self.assertEqual(fails, [0, 0], 'a second writer consumed the first one\'s temp file')

    def test_failed_write_leaves_no_temp_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'x.json')
            with self.assertRaises(TypeError):
                bridge.atomic_write(path, {'bad': object()})  # json.dump fails part-way
            self.assertEqual(os.listdir(d), [])


class InstanceLock(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = bridge.LOCK_FILE
        bridge.LOCK_FILE = os.path.join(self.tmp.name, 'bridge.lock')
        self.children = []

    def tearDown(self):
        bridge.LOCK_FILE = self.saved
        for c in self.children:
            c.kill()
            c.wait()
        self.tmp.cleanup()

    def live_pid(self):
        p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        self.children.append(p)
        return p.pid

    def dead_pid(self):
        p = subprocess.Popen([sys.executable, '-c', 'pass'])
        p.wait()
        return p.pid

    def put(self, text, age=0):
        with open(bridge.LOCK_FILE, 'w') as f:
            f.write(text)
        if age:
            t = time.time() - age
            os.utime(bridge.LOCK_FILE, (t, t))

    def test_first_bridge_takes_the_lock(self):
        self.assertIsNone(bridge.acquire_instance_lock())
        with open(bridge.LOCK_FILE) as f:
            self.assertEqual(f.read().strip(), str(os.getpid()))

    def test_second_bridge_is_refused_while_the_first_is_alive(self):
        other = self.live_pid()
        self.put(str(other))
        self.assertEqual(bridge.acquire_instance_lock(), other)
        with open(bridge.LOCK_FILE) as f:
            self.assertEqual(f.read().strip(), str(other), 'a refused bridge must not touch the owner\'s lock')

    def test_dead_owner_is_stale_and_taken_over(self):
        self.put(str(self.dead_pid()))
        self.assertIsNone(bridge.acquire_instance_lock())
        with open(bridge.LOCK_FILE) as f:
            self.assertEqual(f.read().strip(), str(os.getpid()))

    def test_fresh_empty_lock_counts_as_held(self):
        # The owner has created the file but not yet written its pid: not stale, must not be stolen.
        self.put('')
        self.assertEqual(bridge.acquire_instance_lock(), 0)

    def test_old_empty_lock_is_stale(self):
        self.put('', age=60)
        self.assertIsNone(bridge.acquire_instance_lock())

    def test_release_only_removes_our_own_lock(self):
        other = self.live_pid()
        self.put(str(other))
        bridge.release_instance_lock()
        self.assertTrue(os.path.exists(bridge.LOCK_FILE), 'released a lock this process does not own')
        os.remove(bridge.LOCK_FILE)
        self.assertIsNone(bridge.acquire_instance_lock())
        bridge.release_instance_lock()
        self.assertFalse(os.path.exists(bridge.LOCK_FILE))


if __name__ == '__main__':
    unittest.main()
