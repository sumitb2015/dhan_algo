"""
Offline tests for strategies/flyagonal/nifty_flyagonal.py (no network, no orders).

Covers the pure decision functions and, with a stub broker, the failure paths from the
dhan-new-strategy kit: entry rollback, failed rollback -> UNWINDING, failed close keeps the leg
tracked + FLATTENING, exit sizing clamped to broker truth, restart restore, paper-vs-live refusal,
corrupt-file refusal.

Run from the project root:  venv/bin/python tests/test_flyagonal.py
"""
import importlib.util
import os
import sys
import tempfile
import types
from datetime import date

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

import pandas as pd  # noqa: E402

from datetime import date as _d, timedelta as _td  # noqa: E402
_today = _d.today()
FRONT, BACK = (_today + _td(days=9)).isoformat(), (_today + _td(days=18)).isoformat()   # 9 / 18 DTE: source rule 8-10 and 2x
STEP_PRICES = {}   # (expiry, type, strike) -> price


def make_chain(expiry):
    strikes = range(22000, 24500, 50)
    rows = {}
    for k in strikes:
        rows[float(k)] = {
            "ce_last_price": STEP_PRICES.get((expiry, "CE", k), 50.0),
            "ce_delta": 0.3, "pe_last_price": STEP_PRICES.get((expiry, "PE", k), 50.0),
            "pe_delta": -0.2,
        }
    df = pd.DataFrame.from_dict(rows, orient="index")
    df.index.name = "Strike"
    return df


class FakeHelper:
    def __init__(self):
        self.orders, self.net = [], {}
        self.fail_sell, self.fail_buy, self.nofill = set(), set(), set()
        self.cancelled = []

    def get_lot_size(self, s): return 65
    def is_market_open(self): return True
    def get_ltp(self, *a, **k): return 23346.0
    def get_expiries(self, s): return [FRONT, BACK]
    def get_option_chain_df(self, s, e): return make_chain(e)
    def find_option(self, u, exp, strike, t): return {"SECURITY_ID": int(strike) * 10 + (1 if t == "CE" else 2) + (100000000 if exp == BACK else 0)}
    def get_option_id(self, *a, **k): return None
    def get_net_quantity(self, sid): return self.net.get(str(sid), 0)
    def wait_for_fill(self, oid, timeout=5): return oid not in self.nofill
    def get_order_by_id(self, oid): return {"averageTradedPrice": 50.0}
    def cancel_order(self, oid): self.cancelled.append(oid); return True

    def _place(self, side, sid, qty, fail):
        if str(sid) in fail:
            return None
        self.orders.append((side, str(sid), qty))
        self.net[str(sid)] = self.net.get(str(sid), 0) + (qty if side == "BUY" else -qty)
        return f"o{len(self.orders) - 1}"

    def sell(self, sid, qty, price=None, product="INTRADAY"):
        assert product == "MARGIN", "every order must be MARGIN"
        return self._place("SELL", sid, qty, self.fail_sell)

    def buy(self, sid, qty, price=None, product="INTRADAY"):
        assert product == "MARGIN", "every order must be MARGIN"
        return self._place("BUY", sid, qty, self.fail_buy)


H = FakeHelper()
login = types.ModuleType("login"); login.get_dhan_client = lambda: object(); sys.modules["login"] = login
dh = types.ModuleType("lib.dhan_helper"); dh.DhanHelper = lambda dhan: H; sys.modules["lib.dhan_helper"] = dh
saved = {}
ss = types.ModuleType("lib.strategy_state_helper")
ss.save_strategy_state = lambda k, d: saved.__setitem__(k, d)
ss.check_shutdown_trigger = lambda k: False
ss.instance_log_suffix = lambda: ""
from lib import strategy_state_helper as _real  # noqa: E402
ss.parse_target_spec = _real.parse_target_spec
sys.modules["lib.strategy_state_helper"] = ss

spec = importlib.util.spec_from_file_location("fly", os.path.join(ROOT, "strategies", "flyagonal", "nifty_flyagonal.py"))
fly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fly)
fly.DEBUG_DIR = tempfile.mkdtemp()

from lib.execution_broker import ExecutionBroker  # noqa: E402


def new_strategy(live=False, argv=()):
    args = fly.parse_args(list(argv) + (["--live"] if live else []))
    s = fly.NiftyFlyagonal(args, "nifty_flyagonal_test")
    s.helper = H
    s.broker = ExecutionBroker("dhan", H, "NIFTY", log=lambda *_: None)
    s.lot_size = 65
    s.market_open = True
    s.spot = 23346.0
    return s


def reset():
    H.orders.clear(); H.net.clear(); H.fail_sell.clear(); H.fail_buy.clear(); H.nofill.clear(); H.cancelled.clear()
    STEP_PRICES.clear()
    p = os.path.join(fly.DEBUG_DIR, "nifty_flyagonal_test_portfolio.json")
    if os.path.exists(p):
        os.remove(p)


def sid(strike, typ, exp=FRONT):
    return str(strike * 10 + (1 if typ == "CE" else 2) + (100000000 if exp == BACK else 0))


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        check.failed = True
check.failed = False


# ── pure logic ───────────────────────────────────────────────────────────────
st = fly.build_structure(23346.4, 50, 0.0, 0.9, 1.9, 3.0, 50)
check("structure matches vault illustration", st == {"k1": 23350, "k2": 23550, "k3": 23800, "ps": 22650, "pl": 22600})
try:
    fly.build_structure(23346.4, 50, 0.0, 1.5, 1.9, 3.0, 50); ok = False
except ValueError:
    ok = True
check("non-broken-wing rejected", ok)
_T = date(2026, 9, 21)
timedelta = _td
_D = lambda n: (_T + timedelta(days=n)).isoformat()
check("expiry window picks 8-10 DTE front, back 16-20",
      fly.pick_expiries([_D(1), _D(9), _D(16), _D(23)], _T, 8, 10, 16, back_dte_max=20) == (_D(9), _D(16)))
check("back expiry is the one closest to 2x the front DTE",
      fly.pick_expiries([_D(9), _D(16), _D(18), _D(20)], _T, 8, 10, 16, back_dte_max=20) == (_D(9), _D(18)))
check("back expiry outside 16-20 -> None",
      fly.pick_expiries([_D(9), _D(15), _D(23)], _T, 8, 10, 16, back_dte_max=20) is None)
check("Nifty weekly cadence: front 8 DTE, back 15 DTE accepted with default window",
      fly.pick_expiries([_D(1), _D(8), _D(15), _D(22)], _T, 8, 10, 15, back_dte_max=20) == (_D(8), _D(15)))
check("no expiry in window -> None", fly.pick_expiries([_D(1), _D(23)], _T, 8, 10, 16, back_dte_max=20) is None)
check("just-cycled expiry skipped",
      fly.pick_expiries([_D(9), _D(18), _D(25)], _T, 8, 10, 16, skip_expiry=_D(9), back_dte_max=20) is None)
_d = fly.parse_args([])
check("defaults follow the source: 3% shorts, butterfly above spot",
      (_d.put_pct, _d.fly_body_pct) == (3.0, 3.0) and _d.fly_lower_pct > 0 and (_d.back_dte_min, _d.back_dte_max) == (15, 20))
_st = fly.build_structure(23346.4, 50, _d.fly_lower_pct, _d.fly_body_pct, _d.fly_upper_pct, _d.put_pct, _d.diag_offset)
check("default strikes: body ~+3%, short put ~-3%", abs(_st["k2"] / 23346.4 - 1.03) < 0.005 and abs(_st["ps"] / 23346.4 - 0.97) < 0.005)
pr = {"call_lo": 100, "call_hi": 30, "put_long": 40, "call_body": 60, "put_short": 55}
check("net debit", fly.net_debit_points(pr) == 100 + 30 + 40 - 120 - 55)
check("max loss = max(wing gap, put gap) + debit", fly.max_loss_points(st, -5.0) == 45.0 and fly.max_loss_points(st, 10.0) == 60.0)
check("max loss floored at 1", fly.max_loss_points(st, -500.0) == 1.0)
check("time exit rule", fly.time_exit_due(3, "09:30", 4, "15:15") and not fly.time_exit_due(4, "10:00", 4, "15:15")
      and fly.time_exit_due(4, "15:15", 4, "15:15") and not fly.time_exit_due(5, "23:00", 4, "15:15"))
check("adjustment trigger + cap", fly.adjustment_due(-0.4, 0.3, 0, 1) and not fly.adjustment_due(-0.4, 0.3, 1, 1)
      and not fly.adjustment_due(0.4, 0.3, 0, 1) and not fly.adjustment_due(-0.4, 0.3, 0, 0))
check("leg pnl signs", fly.leg_pnl("BUY", 10, 12, 100) == 200 and fly.leg_pnl("SELL", 10, 12, 100) == -200)

# ── entry: dry-run parity ────────────────────────────────────────────────────
reset()
s = new_strategy()
s.attempt_entry()
check("dry entry -> ENTERED with 5 legs, no broker orders", s.status == "ENTERED" and len(s.legs) == 5 and not H.orders)
check("dry entry sets max loss > 0", s.max_loss_rs > 0)
check("portfolio file written with dry_run", os.path.exists(s.portfolio_path))
s.monitor()
check("monitor computes total pnl", isinstance(s.total_pnl, float))

# ── entry: live, all filled, MARGIN, longs before shorts ─────────────────────
reset()
s = new_strategy(live=True)
s.attempt_entry()
sides = [o[0] for o in H.orders]
check("live entry places 5 orders longs first", s.status == "ENTERED" and sides == ["BUY", "BUY", "BUY", "SELL", "SELL"])
check("body leg is 2 lots", any(o[2] == 2 * 65 for o in H.orders))

# ── entry: short leg fails -> rollback closes what was placed ────────────────
reset()
H.fail_sell.add(sid(24050, "CE"))
s = new_strategy(live=True)
s.attempt_entry()
check("failed body sell -> rolled back to IDLE, broker flat", s.status == "IDLE" and all(v == 0 for v in H.net.values()) and not s.legs)

# ── entry: nothing placed -> stays flat, no cycle burn ───────────────────────
reset()
H.fail_buy.add(sid(23850, "CE"))
s = new_strategy(live=True)
s.attempt_entry()
check("first order fails -> IDLE, expiry not burned", s.status == "IDLE" and s.last_cycle_expiry is None)

# ── entry: rollback close fails -> UNWINDING, legs stay tracked ──────────────
reset()
H.fail_sell.add(sid(22650, "PE"))       # last leg fails
H.fail_buy.add(sid(24050, "CE"))        # ... and the body buy-back fails during rollback
s = new_strategy(live=True)
s.attempt_entry()
check("failed rollback -> FLATTENING with body leg still tracked", s.status == "FLATTENING" and s.legs.get("call_body"))
H.fail_buy.clear()
s.exit_all("retry")
check("retry closes to IDLE and broker flat", s.status == "IDLE" and all(v == 0 for v in H.net.values()))

# ── exit sizing clamped to broker truth (sibling instance) ───────────────────
reset()
s = new_strategy(live=True)
s.attempt_entry()
H.net[sid(24050, "CE")] = -65                   # someone flattened one lot of the 2-lot body
before = len(H.orders)
s.exit_all("test")
body_close = [o for o in H.orders[before:] if o[1] == sid(24050, "CE")]
check("body buy-back clamped to broker's remaining 65", body_close and body_close[0][2] == 65)

# ── unconfirmed entry fill -> cancel + tracked ───────────────────────────────
reset()
s = new_strategy(live=True)
H.nofill.add("o3")                              # the body sell never confirms
s.attempt_entry()
check("unconfirmed entry order is cancelled", "o3" in H.cancelled)
check("unconfirmed entry ends flat, not phantom", s.status in ("IDLE", "FLATTENING") and not (s.status == "ENTERED"))

# ── adjustment rolls the short put up once ───────────────────────────────────
reset()
s = new_strategy()
s.attempt_entry()
for leg in s.legs.values():
    leg["last_delta"] = {"call_lo": 0.6, "call_body": 0.8, "call_hi": 0.4, "put_short": -0.05, "put_long": -0.03}[leg["name"]]
s.helper.get_option_chain_df = lambda sy, e: make_chain(e)
s.net_delta = fly.net_delta_per_lot(s.legs)
old = s.legs["put_short"]["strike"]
s.adjust_roll_put_up()
check("adjustment rolled put up 50 and counted", s.legs["put_short"]["strike"] == old + 50 and s.adjustments == 1)

# ── restart: restore, paper/live refusal, corrupt file ───────────────────────
reset()
s = new_strategy()
s.attempt_entry()
s2 = new_strategy()
s2.load_portfolio()
check("restart restores open position", s2.status == "ENTERED" and len(s2.legs) == 5 and s2.lot_size == 65)
s3 = new_strategy(live=True)
try:
    s3.load_portfolio(); ok = False
except SystemExit:
    ok = True
check("paper position refused by a live run", ok)
with open(s.portfolio_path, "w") as f:
    f.write("{not json")
try:
    new_strategy().load_portfolio(); ok = False
except Exception:
    ok = True
check("corrupt portfolio refuses to start", ok)

# ── target / stop / time exits via monitor ───────────────────────────────────
reset()
s = new_strategy(argv=["--max-adjustments", "0", "--stop-loss", "1%"])
s.attempt_entry()
STEP_PRICES[(FRONT, "CE", 24050)] = 500.0       # body reprices far up -> big loss
s.monitor()
check("stop-loss exit fires and books realized loss", s.status == "IDLE" and s.cumulative_pnl < 0)

reset()
s = new_strategy(argv=["--max-adjustments", "0"])
s.attempt_entry()
STEP_PRICES[(FRONT, "CE", 24050)] = 1.0         # shorts collapse -> profit
s.monitor()
check("target exit fires", s.status == "IDLE" and s.cumulative_pnl > 0)

# ── review fixes ─────────────────────────────────────────────────────────────
# crash mid-entry: book must already be persisted as UNWINDING with the placed legs
reset()
s = new_strategy(live=True)
orig_sell = H.sell
def boom(sid_, qty, price=None, product="INTRADAY"):
    raise RuntimeError("process died")
H.sell = boom
try:
    s.attempt_entry()
except RuntimeError:
    pass
H.sell = orig_sell
r = new_strategy(live=True)
try:
    r.load_portfolio()
except SystemExit:
    pass   # reconcile may refuse on the recorded-but-unplaced short leg: that is the safe outcome
import json as _json
saved_file = _json.load(open(s.portfolio_path))
check("mid-entry crash leaves a persisted UNWINDING book with the placed longs",
      saved_file["status"] == "UNWINDING" and {"call_lo", "call_hi", "put_long"} <= set(saved_file["legs"]))

# dead quote on a held leg must not trap the time exit
reset()
s = new_strategy(argv=["--max-adjustments", "0"])
s.attempt_entry()
STEP_PRICES[(FRONT, "CE", 24300)] = 0.0
s.args.exit_dte = 100
s.monitor()
check("stale price does not block the time exit", s.status == "IDLE")

# a failed position lookup is not "flat"
reset()
s = new_strategy(live=True)
s.attempt_entry()
def bad_net(sid_): raise RuntimeError("positions api down")
H.get_net_quantity = bad_net
ok_exit = s.exit_all("test")
del H.get_net_quantity
check("failed lookup keeps legs tracked (FLATTENING), not phantom-flat", ok_exit is False and s.status == "FLATTENING" and s.legs)

# stop with the market closed must not queue overnight orders
reset()
s = new_strategy(live=True)
s.attempt_entry()
n_orders = len(H.orders)
H.is_market_open = lambda: False
s.shutdown("Shutdown requested")
H.is_market_open = lambda: True
check("closed-market stop sends no orders and keeps the position", len(H.orders) == n_orders and s.status == "ENTERED")
check("adjust-delta default is reachable (0.10)", fly.parse_args([]).adjust_delta == 0.10)

print("\nALL PASSED" if not check.failed else "\nFAILURES")
sys.exit(1 if check.failed else 0)
