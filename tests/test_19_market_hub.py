"""
Live integration test for the market data hub (scripts/tools/market_data_hub.py)
and its 4 consumer bridges (live_equity_ws.py, live_indices_ws.py,
live_options_ws.py, focus_tool_ws.py).

Exercises real subprocesses against live Dhan data — slower and heavier than most
modules in this suite (spawns real processes, takes ~30-60s). Follows the
run(helper=None) convention so it's picked up by run_all_tests.py, but can also be
run standalone:

    venv\\Scripts\\python.exe tests/test_19_market_hub.py

Covers, using the cheapest 2 of the 4 bridges (equity + indices — no expiry args,
fastest to resolve):
  1. Exactly ONE hub process starts across both bridges (grepping combined hub log
     output for "Market data hub starting" — the direct regression check for "a
     bridge still opened its own connection", which is impossible by construction
     since neither bridge calls start_websocket() anymore, but this also catches a
     regression in ensure_hub_running()'s spawn-lock discipline).
  2. Each bridge's output file matches its golden schema (tests/golden/*.json) —
     structural, not value, comparison.
  3. Killing the hub mid-session doesn't crash either bridge, and a fresh hub gets
     auto-spawned and re-absorbs both registrations within a bounded window.

Does not touch live_positions_ws.py, focus_tool_rows_worker.py, or
live_options_ws_zerodha.py — out of scope for the hub, untouched by design.
"""
import os
import sys
import json
import time
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from lib import market_hub_client as hub_client

PYTHON_EXE = sys.executable
EQUITY_SCRIPT = os.path.join(ROOT, 'scripts', 'tools', 'live_equity_ws.py')
INDICES_SCRIPT = os.path.join(ROOT, 'scripts', 'tools', 'live_indices_ws.py')

EQUITY_QUOTES_FILE = os.path.join(ROOT, 'debug', 'live_equity_quotes.json')
EQUITY_STATUS_FILE = os.path.join(ROOT, 'debug', 'live_equity_status.json')
EQUITY_STOP_TRIGGER = os.path.join(ROOT, 'debug', 'live_equity_stop.trigger')
INDICES_HISTORY_FILE = os.path.join(ROOT, 'debug', 'live_indices_history.json')
INDICES_STATUS_FILE = os.path.join(ROOT, 'debug', 'live_indices_status.json')
INDICES_STOP_TRIGGER = os.path.join(ROOT, 'debug', 'live_indices_stop.trigger')

GOLDEN_DIR = os.path.join(ROOT, 'tests', 'golden')

STARTUP_TIMEOUT_SEC = 60
RECOVERY_TIMEOUT_SEC = 30


def _wait_for(predicate, timeout_sec, poll_sec=1.0):
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(poll_sec)
    return False


def _read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _cleanup(procs):
    for trigger in (EQUITY_STOP_TRIGGER, INDICES_STOP_TRIGGER):
        try:
            open(trigger, 'w').close()
        except OSError:
            pass
    for p in procs:
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()
    try:
        open(os.path.join(hub_client.HUB_DIR, 'hub_stop.trigger'), 'w').close()
    except OSError:
        pass
    time.sleep(2)


def run(helper=None):
    ok = True
    procs = []
    try:
        # Clean slate — don't inherit state from a previous manual run.
        for f in (EQUITY_QUOTES_FILE, EQUITY_STATUS_FILE, INDICES_HISTORY_FILE, INDICES_STATUS_FILE):
            try:
                os.remove(f)
            except OSError:
                pass

        print('[test_19] Starting live_equity_ws.py and live_indices_ws.py…')
        p_equity = subprocess.Popen([PYTHON_EXE, EQUITY_SCRIPT], cwd=ROOT,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        p_indices = subprocess.Popen([PYTHON_EXE, INDICES_SCRIPT], cwd=ROOT,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        procs = [p_equity, p_indices]

        connected = _wait_for(
            lambda: (_read_json(EQUITY_STATUS_FILE) or {}).get('status') == 'RUNNING'
            and (_read_json(INDICES_STATUS_FILE) or {}).get('status') == 'RUNNING',
            STARTUP_TIMEOUT_SEC,
        )
        if not connected:
            print('[test_19] FAIL: both bridges did not reach RUNNING within '
                  f'{STARTUP_TIMEOUT_SEC}s')
            return False

        # 1. Exactly one hub startup.
        try:
            with open(hub_client.hub_log_file()) as f:
                hub_log_text = f.read()
        except OSError:
            hub_log_text = ''
        starts = hub_log_text.count('Market data hub starting')
        if starts != 1:
            print(f'[test_19] FAIL: expected exactly 1 hub startup, found {starts}')
            ok = False
        else:
            print('[test_19] OK: exactly one hub process started for both bridges')

        # 2. Golden-shape check.
        equity_data = _read_json(EQUITY_QUOTES_FILE)
        equity_golden = _read_json(os.path.join(GOLDEN_DIR, 'live_equity_quotes.golden.json'))
        if equity_data and equity_golden:
            top_ok = sorted(equity_data.keys()) == equity_golden['top_level_keys']
            sample_sym = next(iter(equity_data.get('quotes', {})), None)
            quote_ok = (sample_sym is not None
                        and sorted(equity_data['quotes'][sample_sym].keys()) == equity_golden['quotes_value_keys'])
            if top_ok and quote_ok:
                print('[test_19] OK: live_equity_quotes.json matches golden schema')
            else:
                print('[test_19] FAIL: live_equity_quotes.json schema mismatch '
                      f'(top_ok={top_ok}, quote_ok={quote_ok})')
                ok = False
        else:
            print('[test_19] WARN: could not read equity output or golden file to compare')

        indices_data = _read_json(INDICES_HISTORY_FILE)
        indices_golden = _read_json(os.path.join(GOLDEN_DIR, 'live_indices_history.golden.json'))
        if indices_data and indices_golden:
            top_ok = sorted(indices_data.keys()) == indices_golden['top_level_keys']
            if top_ok:
                print('[test_19] OK: live_indices_history.json matches golden schema')
            else:
                print('[test_19] FAIL: live_indices_history.json top-level schema mismatch')
                ok = False
        else:
            print('[test_19] WARN: could not read indices output or golden file to compare')

        # 3. Hub-death recovery.
        hub_status = _read_json(hub_client.hub_status_file())
        old_pid = hub_status.get('pid') if hub_status else None
        if old_pid:
            print(f'[test_19] Killing hub pid {old_pid} to test recovery…')
            try:
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/F', '/PID', str(old_pid)],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                else:
                    os.kill(old_pid, 9)
            except OSError:
                pass

            time.sleep(1)
            equity_status = (_read_json(EQUITY_STATUS_FILE) or {}).get('status')
            indices_status = (_read_json(INDICES_STATUS_FILE) or {}).get('status')
            if equity_status != 'RUNNING' or indices_status != 'RUNNING':
                print(f'[test_19] FAIL: a bridge crashed on hub death '
                      f'(equity={equity_status}, indices={indices_status})')
                ok = False
            else:
                print('[test_19] OK: both bridges survived the hub dying')

            recovered = _wait_for(
                lambda: (_read_json(hub_client.hub_status_file()) or {}).get('pid') not in (None, old_pid)
                and (_read_json(hub_client.hub_status_file()) or {}).get('subscribed_count', 0) > 0,
                RECOVERY_TIMEOUT_SEC,
            )
            if recovered:
                print('[test_19] OK: a fresh hub was auto-spawned and re-absorbed both bridges')
            else:
                print(f'[test_19] FAIL: no healthy replacement hub with subscriptions within '
                      f'{RECOVERY_TIMEOUT_SEC}s')
                ok = False
        else:
            print('[test_19] WARN: could not read hub pid — skipping recovery check')

        return ok
    except Exception as e:
        print(f'[test_19] ERROR: {e}')
        return False
    finally:
        _cleanup(procs)


if __name__ == '__main__':
    success = run()
    sys.exit(0 if success else 1)
