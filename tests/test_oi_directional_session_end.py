"""oi_directional: after the 15:17 session end, a dry run must wait, not spin.

Before the fix the outer loop restarted immediately in dry-run (the market-hours wait is bypassed), re-hit the
15:17 check and wrote ~6,000 log lines a second. Stub helper, fake clock, no network, no orders.

Run from the project root:  venv/bin/python tests/test_oi_directional_session_end.py
"""
import importlib.util, os, sys, types
from datetime import datetime as real_datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.argv = [sys.argv[0], "--instance-id", "session_end_test"]
login = types.ModuleType("login"); login.get_dhan_client = lambda: object(); sys.modules["login"] = login
dh = types.ModuleType("lib.dhan_helper")
class _H:
    def __init__(self, *a, **k): pass
dh.DhanHelper = _H; sys.modules["lib.dhan_helper"] = dh
spec = importlib.util.spec_from_file_location("oi", os.path.join(ROOT, "strategies", "oi_directional", "nifty_oi_directional.py"))
oi = importlib.util.module_from_spec(spec); spec.loader.exec_module(oi)


class Clock:
    def __init__(self, start): self.now_dt = start
    def advance(self, s):
        from datetime import timedelta
        self.now_dt += timedelta(seconds=s)


def strat(dry):
    o = oi.NiftyOIDirectional.__new__(oi.NiftyOIDirectional)
    o.dry_run = dry; o.states = []
    o._save_state = lambda *a, **k: o.states.append(a[-1] if a else k.get("status"))
    return o


def run_with(clock, dry, shutdown_after=None):
    class FakeDT:
        @staticmethod
        def now(): return clock.now_dt
    sleeps = []
    oi.datetime = FakeDT
    oi.time.sleep = lambda s: (sleeps.append(s), clock.advance(s))
    calls = [0]
    def shut(key):
        calls[0] += 1
        return shutdown_after is not None and calls[0] > shutdown_after
    oi.check_shutdown_trigger = shut
    o = strat(dry)
    try:
        o._wait_out_session_end(); exit_code = None
    except SystemExit as e:
        exit_code = e.code
    return o, sleeps, exit_code


ok = fail = 0
def check(name, cond):
    global ok, fail
    cond = bool(cond); print(("PASS " if cond else "FAIL ") + name); ok += cond; fail += (not cond)


# live mode: nothing to do (wait_for_market_open handles it)
o, sleeps, code = run_with(Clock(real_datetime(2026, 10, 5, 15, 20)), dry=False)
check("live: returns immediately, no sleep, no state write", sleeps == [] and o.states == [] and code is None)

# dry-run at 22:00: waits in 1s slices until midnight, then returns (7200s = 2h)
o, sleeps, code = run_with(Clock(real_datetime(2026, 10, 5, 22, 0)), dry=True)
check("dry-run 22:00: sleeps until the clock passes midnight", code is None and abs(sum(sleeps) - 7200) <= 5)
check("dry-run: sleeps in 1s slices (shutdown-aware), never a busy loop", sleeps and set(sleeps) == {1})
check("dry-run: heartbeat state is WAITING, written every ~5s (not every iteration of a hot loop)",
      set(o.states) == {"WAITING"} and 1000 < len(o.states) < 2000)

# dry-run at 15:18 (just after the session end): same wait
o, sleeps, code = run_with(Clock(real_datetime(2026, 10, 5, 15, 18)), dry=True)
check("dry-run 15:18: waits ~8h42m to midnight", code is None and abs(sum(sleeps) - (8 * 3600 + 42 * 60)) <= 5)

# before 15:17 nothing to wait for
o, sleeps, code = run_with(Clock(real_datetime(2026, 10, 5, 10, 0)), dry=True)
check("dry-run 10:00: no wait", sleeps == [] and code is None)

# shutdown during the wait exits cleanly with STOPPED
o, sleeps, code = run_with(Clock(real_datetime(2026, 10, 5, 22, 0)), dry=True, shutdown_after=12)
check("shutdown trigger during the wait exits 0 and publishes STOPPED", code == 0 and o.states[-1] == "STOPPED" and len(sleeps) < 20)

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
