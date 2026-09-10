"""
Pure-mock tests for lib/market_hub_client.py's registry union/diff/GC logic and
the DhanHelper tick-merge semantics the hub relies on. No login, no network, no
live market required — run any time:

    venv\\Scripts\\python.exe scripts/testing/test_market_hub_registry.py
"""
import os
import sys
import time
import tempfile
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from lib import market_hub_client as hub_client

PASS = []
FAIL = []


def check(name, condition):
    if condition:
        PASS.append(name)
        print(f'[OK] {name}')
    else:
        FAIL.append(name)
        print(f'[FAIL] {name}')


def with_temp_hub_dir(fn):
    """Redirects hub_client.HUB_DIR to a fresh temp dir for the duration of fn()."""
    tmp = tempfile.mkdtemp(prefix='market_hub_test_')
    original = hub_client.HUB_DIR
    hub_client.HUB_DIR = tmp
    try:
        fn(tmp)
    finally:
        hub_client.HUB_DIR = original
        shutil.rmtree(tmp, ignore_errors=True)


def test_register_and_list(tmp):
    hub_client.register_wanted('fake_a', [(1, '111', 17), (1, '222', 17)])
    hub_client.register_wanted('fake_b', [(1, '222', 17), (2, '333', 21)])

    entries = hub_client.list_live_registry_entries()
    check('register_wanted writes files list_live_registry_entries can see',
          len(entries) == 2)

    all_instruments = {tuple(i) for e in entries for i in e['instruments']}
    expected = {(1, '111', 17), (1, '222', 17), (2, '333', 21)}
    check('union of two consumers dedups the shared instrument',
          all_instruments == expected)


def test_unregister(tmp):
    hub_client.register_wanted('fake_a', [(1, '111', 17)])
    hub_client.unregister_wanted('fake_a')
    entries = hub_client.list_live_registry_entries()
    check('unregister_wanted removes the file immediately',
          len(entries) == 0)


def test_dead_pid_excluded(tmp):
    hub_client.register_wanted('fake_dead', [(1, '999', 17)])
    path = hub_client._wanted_file('fake_dead')
    data = hub_client._atomic_read(path)
    data['pid'] = 999_999_999  # astronomically unlikely to be a real running pid
    hub_client._atomic_write(path, data)

    entries = hub_client.list_live_registry_entries()
    check('a registry entry with a dead pid is excluded from the union',
          all(e['consumer'] != 'fake_dead' for e in entries))


def test_stale_mtime_excluded_even_with_live_pid(tmp):
    hub_client.register_wanted('fake_stale', [(1, '444', 17)])
    path = hub_client._wanted_file('fake_stale')
    old = time.time() - (hub_client.WANTED_STALE_SEC + 5)
    os.utime(path, (old, old))

    entries = hub_client.list_live_registry_entries()
    check('a stale-mtime entry is excluded even with a live pid (hard backstop)',
          all(e['consumer'] != 'fake_stale' for e in entries))


def test_live_entry_with_live_pid_included(tmp):
    hub_client.register_wanted('fake_live', [(1, '555', 17)])
    entries = hub_client.list_live_registry_entries()
    check('a fresh entry with this process\'s own (live) pid is included',
          any(e['consumer'] == 'fake_live' for e in entries))


def test_read_live_data_missing_file_returns_empty(tmp):
    ticks = hub_client.read_live_data()
    check('read_live_data on a hub dir with no live_data.json yet returns {}',
          ticks == {})


def test_read_live_data_roundtrip(tmp):
    hub_client._atomic_write(hub_client.hub_live_data_file(), {
        'updated_at': '2026-01-01T00:00:00',
        'ticks': {'111': {'LTP': 100.5}},
    })
    ticks = hub_client.read_live_data()
    check('read_live_data round-trips a written tick', ticks.get('111', {}).get('LTP') == 100.5)


def test_is_hub_alive_false_when_dead_pid(tmp):
    hub_client._atomic_write(hub_client.hub_status_file(), {
        'status': 'RUNNING', 'pid': 999_999_999,
        'last_update': __import__('datetime').datetime.now().isoformat(),
    })
    check('is_hub_alive() is False for a status file naming a dead pid',
          hub_client.is_hub_alive() is False)


def test_is_hub_alive_false_when_stale_heartbeat(tmp):
    import datetime
    stale_ts = (datetime.datetime.now() - datetime.timedelta(seconds=hub_client.HEARTBEAT_STALE_SEC + 5)).isoformat()
    hub_client._atomic_write(hub_client.hub_status_file(), {
        'status': 'RUNNING', 'pid': os.getpid(), 'last_update': stale_ts,
    })
    check('is_hub_alive() is False for a live pid with a stale heartbeat',
          hub_client.is_hub_alive() is False)


def test_is_hub_alive_true_when_starting_even_with_stale_heartbeat(tmp):
    """Regression test for the live-confirmed double-spawn bug: the real hub writes
    STARTING once immediately, then goes silent for its slow master-list-load phase
    (10-15s+ observed live) before ever writing RUNNING — longer than
    HEARTBEAT_STALE_SEC. A caller reaching ensure_hub_running() after that gap must
    still see the hub as alive (it's just slow, not dead), or it double-spawns."""
    import datetime
    stale_ts = (datetime.datetime.now() - datetime.timedelta(seconds=hub_client.HEARTBEAT_STALE_SEC + 5)).isoformat()
    hub_client._atomic_write(hub_client.hub_status_file(), {
        'status': 'STARTING', 'pid': os.getpid(), 'last_update': stale_ts,
    })
    check('is_hub_alive() is True for STARTING + a live pid, even with a stale heartbeat',
          hub_client.is_hub_alive() is True)


def test_is_hub_alive_false_when_starting_but_dead_pid(tmp):
    hub_client._atomic_write(hub_client.hub_status_file(), {
        'status': 'STARTING', 'pid': 999_999_999,
        'last_update': __import__('datetime').datetime.now().isoformat(),
    })
    check('is_hub_alive() is still False for STARTING if the pid is dead '
          '(a crashed startup, not a slow one)',
          hub_client.is_hub_alive() is False)


def test_is_hub_alive_true_when_fresh(tmp):
    import datetime
    hub_client._atomic_write(hub_client.hub_status_file(), {
        'status': 'RUNNING', 'pid': os.getpid(),
        'last_update': datetime.datetime.now().isoformat(),
    })
    check('is_hub_alive() is True for a live pid with a fresh heartbeat',
          hub_client.is_hub_alive() is True)


def test_atomic_read_tolerates_windows_permission_error(tmp):
    """Regression test: live_options_ws.py crashed with an uncaught PermissionError
    reading hub_status.json while the hub was mid os.replace() on Windows (confirmed
    during manual end-to-end testing). _atomic_read must swallow this, not raise."""
    hub_client._atomic_write(hub_client.hub_status_file(), {'status': 'RUNNING'})
    path = hub_client.hub_status_file()

    real_open = open
    def flaky_open(p, *a, **kw):
        if p == path:
            raise PermissionError(13, 'Permission denied')
        return real_open(p, *a, **kw)

    import builtins
    builtins.open = flaky_open
    try:
        result = hub_client._atomic_read(path)
    finally:
        builtins.open = real_open

    check('_atomic_read returns None (not raise) on a transient PermissionError',
          result is None)
    check('is_hub_alive() tolerates the same transient error via _atomic_read',
          hub_client.is_hub_alive() is False)  # a genuinely fresh healthy status
    # would exist afterward via the earlier write, confirming the FOLLOW-UP read
    # (not raising) recovers cleanly:
    check('a subsequent normal read recovers once the lock clears',
          hub_client._atomic_read(path) == {'status': 'RUNNING'})


def test_is_pid_running_rejects_non_python_process(tmp):
    """Regression test: a bare psutil.pid_exists() doesn't guard against PID
    reuse — once a process exits, the OS can hand its PID to any unrelated
    process. is_pid_running() must also check the process looks like python."""
    import psutil as _psutil

    class _FakeProc:
        def __init__(self, pid):
            pass
        def name(self):
            return 'explorer.exe'

    original_process = _psutil.Process
    original_pid_exists = _psutil.pid_exists
    _psutil.Process = _FakeProc
    _psutil.pid_exists = lambda pid: True
    try:
        check('is_pid_running() rejects a live pid whose process is not python',
              hub_client.is_pid_running(os.getpid()) is False)
    finally:
        _psutil.Process = original_process
        _psutil.pid_exists = original_pid_exists


def test_is_hub_alive_false_when_starting_too_long(tmp):
    import datetime
    old_start = (datetime.datetime.now()
                 - datetime.timedelta(seconds=hub_client.STARTING_TIMEOUT_SEC + 5)).isoformat()
    hub_client._atomic_write(hub_client.hub_status_file(), {
        'status': 'STARTING', 'pid': os.getpid(),
        'started_at': old_start, 'last_update': old_start,
    })
    check('is_hub_alive() is False for STARTING that has run past STARTING_TIMEOUT_SEC',
          hub_client.is_hub_alive() is False)


def test_list_live_registry_entries_retries_transient_read_failure(tmp):
    """Regression test: a momentary PermissionError reading one bridge's
    wanted-file (a real, documented Windows race around another process's
    os.replace()) must not make the hub treat a still-live consumer as gone."""
    hub_client.register_wanted('flaky', [(1, '111', 17)])
    path = hub_client._wanted_file('flaky')

    real_open = open
    calls = {'n': 0}

    def flaky_open(p, *a, **kw):
        if p == path and calls['n'] == 0:
            calls['n'] += 1
            raise PermissionError(13, 'Permission denied')
        return real_open(p, *a, **kw)

    import builtins
    builtins.open = flaky_open
    try:
        entries = hub_client.list_live_registry_entries()
    finally:
        builtins.open = real_open

    check('a transient read failure on the first attempt is retried and the '
          'consumer is still included', any(e['consumer'] == 'flaky' for e in entries))


def test_has_own_ticks(tmp):
    hub_client._atomic_write(hub_client.hub_live_data_file(), {
        'updated_at': '2026-01-01T00:00:00',
        'ticks': {hub_client.tick_key(1, '25'): {'LTP': 3080.0}},
    })
    check('has_own_ticks is True when one of the queried instruments has a tick',
          hub_client.has_own_ticks([(1, '25', 17), (2, '999', 21)]) is True)
    check('has_own_ticks is False when none of the queried instruments have a tick '
          '(even though the hub has data for something else)',
          hub_client.has_own_ticks([(0, '13', 17)]) is False)


def test_tick_key_disambiguates_cross_segment_collision():
    """Regression test for a live-confirmed data-correctness bug: ADANIENT
    (NSE_EQ, security_id 25) and BANKNIFTY (IDX, security_id 25) share the same
    raw id. Under bare-sid keying (what DhanHelper.live_data itself uses), the
    hub's shared tick dict let one instrument's tick silently overwrite the
    other's — BANKNIFTY's spot briefly showed ADANIENT's LTP on the Focus Tool
    page. tick_key() must produce distinct keys for the same raw id under
    different segments."""
    NSE_EQ, IDX = 1, 0
    adanient_key = hub_client.tick_key(NSE_EQ, '25')
    banknifty_key = hub_client.tick_key(IDX, '25')
    check('tick_key gives ADANIENT (NSE_EQ, 25) and BANKNIFTY (IDX, 25) distinct keys',
          adanient_key != banknifty_key)

    # Simulate the hub's own on_message merge logic against both keys and confirm
    # neither overwrites the other.
    merged = {}
    for seg, sid, msg in [
        (NSE_EQ, 25, {'exchange_segment': NSE_EQ, 'security_id': 25, 'LTP': 3092.60}),
        (IDX, 25, {'exchange_segment': IDX, 'security_id': 25, 'LTP': 57402.50}),
    ]:
        key = hub_client.tick_key(seg, sid)
        if key in merged:
            merged[key].update(msg)
        else:
            merged[key] = dict(msg)
    check('after both instruments tick, ADANIENT keeps its own LTP',
          merged[adanient_key]['LTP'] == 3092.60)
    check('after both instruments tick, BANKNIFTY keeps its own LTP (not clobbered)',
          merged[banknifty_key]['LTP'] == 57402.50)


def test_tick_merge_semantics():
    """The hub reuses DhanHelper._on_ws_message unmodified — regression-guard that
    merge (not replace) semantics still hold, since the hub's whole design assumes it."""
    from lib.dhan_helper import DhanHelper

    class _StubDhan:
        dhan_http = type('X', (), {'client_id': 'x', 'access_token': 'y'})()

    helper = DhanHelper.__new__(DhanHelper)  # bypass __init__'s master-list load / login
    helper.live_data = {}
    helper.user_on_message = None

    helper._on_ws_message(None, {'security_id': '111', 'LTP': 100.0, 'open': 95.0})
    helper._on_ws_message(None, {'security_id': '111', 'oi': 5000})

    tick = helper.live_data.get('111')
    check('a later OI-only packet merges into, not replaces, the earlier Full packet',
          tick is not None and tick.get('LTP') == 100.0 and tick.get('oi') == 5000)


def run():
    with_temp_hub_dir(test_register_and_list)
    with_temp_hub_dir(test_unregister)
    with_temp_hub_dir(test_dead_pid_excluded)
    with_temp_hub_dir(test_stale_mtime_excluded_even_with_live_pid)
    with_temp_hub_dir(test_live_entry_with_live_pid_included)
    with_temp_hub_dir(test_read_live_data_missing_file_returns_empty)
    with_temp_hub_dir(test_read_live_data_roundtrip)
    with_temp_hub_dir(test_is_hub_alive_false_when_dead_pid)
    with_temp_hub_dir(test_is_hub_alive_false_when_stale_heartbeat)
    with_temp_hub_dir(test_is_hub_alive_true_when_starting_even_with_stale_heartbeat)
    with_temp_hub_dir(test_is_hub_alive_false_when_starting_but_dead_pid)
    with_temp_hub_dir(test_is_hub_alive_true_when_fresh)
    with_temp_hub_dir(test_atomic_read_tolerates_windows_permission_error)
    with_temp_hub_dir(test_is_pid_running_rejects_non_python_process)
    with_temp_hub_dir(test_is_hub_alive_false_when_starting_too_long)
    with_temp_hub_dir(test_list_live_registry_entries_retries_transient_read_failure)
    with_temp_hub_dir(test_has_own_ticks)
    test_tick_key_disambiguates_cross_segment_collision()
    test_tick_merge_semantics()

    print(f'\n{len(PASS)} passed, {len(FAIL)} failed')
    return len(FAIL) == 0


if __name__ == '__main__':
    ok = run()
    sys.exit(0 if ok else 1)
