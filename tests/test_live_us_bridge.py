"""scripts/tools/live_us_ws.py: retry / stop behaviour, exercised against a local fake WebSocket server.

No Dhan connection, no real token, no real debug/ files: every path the bridge uses is redirected into a temp directory and the feed
host is pointed at a server started here. Run:  venv/bin/python -m unittest tests.test_live_us_bridge   (from the project root)
"""
import asyncio
import importlib.util
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from http import HTTPStatus

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from websockets.asyncio.server import serve  # noqa: E402

spec = importlib.util.spec_from_file_location('live_us_ws_under_test', os.path.join(ROOT, 'scripts', 'tools', 'live_us_ws.py'))
bridge_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge_mod)


def error_packet(code):
    return struct.pack('<BiiBB', 0, 0, 0, 13, 50) + struct.pack('<h', code)


class BridgeTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = self.tmp.name
        self.saved = {k: getattr(bridge_mod, k) for k in (
            'DEBUG_DIR', 'WATCHLIST_FILE', 'UNIVERSE_FILE', 'QUOTES_FILE', 'STATUS_FILE', 'STOP_TRIGGER', 'TOKEN_FILE', 'ENV_FILE', 'FEED_HOST', 'BACKOFF_START', 'BACKOFF_MAX')}
        bridge_mod.DEBUG_DIR = d
        bridge_mod.WATCHLIST_FILE = os.path.join(d, 'wl.json')
        bridge_mod.UNIVERSE_FILE = os.path.join(d, 'universe.json')
        bridge_mod.QUOTES_FILE = os.path.join(d, 'q.json')
        bridge_mod.STATUS_FILE = os.path.join(d, 's.json')
        bridge_mod.STOP_TRIGGER = os.path.join(d, 'stop.trigger')
        bridge_mod.TOKEN_FILE = os.path.join(d, 'token.json')
        bridge_mod.ENV_FILE = os.path.join(d, 'env')
        with open(bridge_mod.WATCHLIST_FILE, 'w') as f:
            json.dump({'ids': ['10000025']}, f)
        with open(bridge_mod.TOKEN_FILE, 'w') as f:
            json.dump({'accessToken': 'tok', 'dhanClientId': '1000000001'}, f)

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(bridge_mod, k, v)
        self.tmp.cleanup()

    def status(self):
        with open(bridge_mod.STATUS_FILE) as f:
            return json.load(f)

    async def run_with_timeout(self, bridge, seconds):
        return await asyncio.wait_for(bridge.run(), timeout=seconds)


class FatalConnectTests(BridgeTestCase):
    async def test_missing_token_file_is_fatal_and_not_retried(self):
        os.remove(bridge_mod.TOKEN_FILE)
        bridge_mod.FEED_HOST = 'ws://127.0.0.1:1/'        # never reached
        b = bridge_mod.Bridge()
        t0 = time.monotonic()
        code = await self.run_with_timeout(b, 5)
        self.assertEqual(code, 2)
        self.assertLess(time.monotonic() - t0, 3)           # returned at once, did not sit in a backoff
        self.assertEqual(self.status()['status'], 'ERROR')
        self.assertIn('credentials', self.status()['error'])

    async def test_http_403_on_upgrade_is_fatal_after_exactly_one_attempt(self):
        attempts = []

        def deny(connection, request):
            attempts.append(1)
            return connection.respond(HTTPStatus.FORBIDDEN, 'no')

        async with serve(lambda ws: None, '127.0.0.1', 0, process_request=deny) as server:
            port = server.sockets[0].getsockname()[1]
            bridge_mod.FEED_HOST = f'ws://127.0.0.1:{port}/'
            code = await self.run_with_timeout(bridge_mod.Bridge(), 8)
        self.assertEqual(code, 2)
        self.assertEqual(len(attempts), 1)
        self.assertEqual(self.status()['status'], 'ERROR')
        self.assertIn('403', self.status()['error'])

    async def test_http_503_is_retried_with_backoff_until_stopped(self):
        attempts = []

        def unavailable(connection, request):
            attempts.append(time.monotonic())
            return connection.respond(HTTPStatus.SERVICE_UNAVAILABLE, 'later')

        bridge_mod.BACKOFF_START, bridge_mod.BACKOFF_MAX = 0.3, 0.6
        async with serve(lambda ws: None, '127.0.0.1', 0, process_request=unavailable) as server:
            port = server.sockets[0].getsockname()[1]
            bridge_mod.FEED_HOST = f'ws://127.0.0.1:{port}/'
            task = asyncio.create_task(bridge_mod.Bridge().run())
            await asyncio.sleep(2.5)
            self.assertFalse(task.done(), 'a 503 must not stop the bridge')
            open(bridge_mod.STOP_TRIGGER, 'w').close()
            code = await asyncio.wait_for(task, 5)
        self.assertEqual(code, 0)
        self.assertGreaterEqual(len(attempts), 3)
        self.assertGreaterEqual(attempts[1] - attempts[0], 0.25)   # the first retry waits BACKOFF_START, not double


class SingletonGuardTests(BridgeTestCase):
    def write_status(self, **kw):
        with open(bridge_mod.STATUS_FILE, 'w') as f:
            json.dump({'status': 'RUNNING', 'heartbeat': int(time.time() * 1000), **kw}, f)

    def spawn(self, *argv):
        p = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: (p.kill(), p.wait()))
        return p

    def test_a_live_python_bridge_with_a_fresh_heartbeat_blocks_a_second_start(self):
        p = self.spawn(sys.executable, '-c', 'import time; time.sleep(60)')
        self.write_status(pid=p.pid)
        self.assertEqual(bridge_mod.another_bridge_running(), p.pid)
        self.assertIsNone(p.poll(), 'the guard must only LOOK at the other process - on Windows os.kill(pid, 0) would terminate it')

    def test_stale_heartbeat_dead_pid_and_non_python_pid_do_not_block(self):
        p = self.spawn(sys.executable, '-c', 'import time; time.sleep(60)')
        self.write_status(pid=p.pid, heartbeat=int((time.time() - 120) * 1000))
        self.assertIsNone(bridge_mod.another_bridge_running())            # heartbeat too old
        dead = self.spawn(sys.executable, '-c', 'pass')
        dead.wait()
        self.write_status(pid=dead.pid)
        self.assertIsNone(bridge_mod.another_bridge_running())            # process gone
        if shutil.which('sleep') is None:
            self.skipTest('no non-python process available to stand in for a recycled PID on this platform')
        sleeper = self.spawn('sleep', '60')
        self.write_status(pid=sleeper.pid)
        self.assertIsNone(bridge_mod.another_bridge_running())            # a recycled PID that is not python

    def test_stopped_error_and_own_pid_do_not_block(self):
        p = self.spawn(sys.executable, '-c', 'import time; time.sleep(60)')
        for st in ('STOPPED', 'ERROR'):
            self.write_status(pid=p.pid, status=st)
            self.assertIsNone(bridge_mod.another_bridge_running(), st)
        self.write_status(pid=os.getpid())
        self.assertIsNone(bridge_mod.another_bridge_running())


class BackoffHeartbeatTests(BridgeTestCase):
    async def test_heartbeat_stays_fresh_during_a_long_backoff(self):
        def unavailable(connection, request):
            return connection.respond(HTTPStatus.SERVICE_UNAVAILABLE, 'later')

        bridge_mod.BACKOFF_START, bridge_mod.BACKOFF_MAX = 6.0, 6.0
        async with serve(lambda ws: None, '127.0.0.1', 0, process_request=unavailable) as server:
            port = server.sockets[0].getsockname()[1]
            bridge_mod.FEED_HOST = f'ws://127.0.0.1:{port}/'
            task = asyncio.create_task(bridge_mod.Bridge().run())
            await asyncio.sleep(1.5)
            first = self.status()
            await asyncio.sleep(2.5)
            second = self.status()
            open(bridge_mod.STOP_TRIGGER, 'w').close()
            await asyncio.wait_for(task, 5)
        self.assertEqual(first['status'], 'RECONNECTING')
        self.assertGreater(second['heartbeat'], first['heartbeat'] + 1500)   # refreshed while still sleeping
        self.assertLess(time.time() * 1000 - second['heartbeat'], 15_000)


class ErrorPacketTests(BridgeTestCase):
    async def test_unlisted_error_packet_is_logged_but_a_listed_one_is_fatal(self):
        async def handler(ws):
            await ws.send(error_packet(999))     # not in the spec's table: must not stop the bridge
            await asyncio.sleep(1.5)
            await ws.send(error_packet(808))     # authentication failure: fatal
            await asyncio.sleep(2)

        async with serve(handler, '127.0.0.1', 0) as server:
            port = server.sockets[0].getsockname()[1]
            bridge_mod.FEED_HOST = f'ws://127.0.0.1:{port}/'
            b = bridge_mod.Bridge()
            task = asyncio.create_task(b.run())
            await asyncio.sleep(0.8)
            self.assertFalse(task.done(), 'an unlisted error code must not stop the bridge')
            self.assertIn('unlisted', b.last_error or '')
            code = await asyncio.wait_for(task, 6)
        self.assertEqual(code, 2)
        self.assertEqual(self.status()['status'], 'ERROR')
        self.assertIn('808', self.status()['error'])



class WatchlistUnionTests(BridgeTestCase):
    def write(self, path, obj):
        with open(path, 'w') as f:
            json.dump(obj, f)

    def test_universe_is_ignored_unless_enabled(self):
        self.write(bridge_mod.UNIVERSE_FILE, {'enabled': False, 'ids': ['10000001', '10000002']})
        self.assertEqual(bridge_mod.read_watchlist(), ['10000025'])
        os.remove(bridge_mod.UNIVERSE_FILE)
        self.assertEqual(bridge_mod.read_watchlist(), ['10000025'])

    def test_union_keeps_watchlist_first_and_dedupes(self):
        self.write(bridge_mod.UNIVERSE_FILE, {'enabled': True, 'ids': ['10000001', '10000025', 'x1', '10000002']})
        self.assertEqual(bridge_mod.read_watchlist(), ['10000025', '10000001', '10000002'])

    def test_turning_the_universe_off_leaves_only_the_watchlist(self):
        self.write(bridge_mod.UNIVERSE_FILE, {'enabled': True, 'ids': ['10000001']})
        self.assertEqual(len(bridge_mod.read_watchlist()), 2)
        self.write(bridge_mod.UNIVERSE_FILE, {'enabled': False, 'ids': ['10000001']})
        self.assertEqual(bridge_mod.read_watchlist(), ['10000025'])

    def test_cap_trims_universe_never_the_watchlist(self):
        mine = [str(20000000 + i) for i in range(5)]
        self.write(bridge_mod.WATCHLIST_FILE, {'ids': mine})
        self.write(bridge_mod.UNIVERSE_FILE, {'enabled': True, 'ids': [str(10000000 + i) for i in range(1000)]})
        out = bridge_mod.read_watchlist()
        self.assertEqual(len(out), bridge_mod.MAX_WATCHLIST)
        self.assertEqual(out[:5], mine)
        self.assertTrue(bridge_mod.MAX_WATCHLIST * 2 <= 5000)


if __name__ == '__main__':
    unittest.main()
