"""strategies/timed_condor/nifty_timed_condor.py: entry, rollback, exit rules, crash and restart recovery.

Stub broker with failure injection, no network, no orders. The strategy is a worked example of the algo_kit parts
(LegExecutor, PositionStore, TrailingStop, TargetSpec), so these tests also exercise that composition.

Run from the project root:  venv/bin/python tests/test_timed_condor.py
"""
import glob, importlib.util, json, os, sys, types
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
TODAY = date.today().isoformat()


class FakeHelper:
    def __init__(self):
        self.prices = {"NIFTY": 25000.0}
        self.orders, self.net = [], {}            # (side, sid, qty); sid -> net qty
        self.fail_sell, self.fail_buy, self.subs = set(), set(), []
        self.last_api_error = None
        self.sell_hook = None

    def start_websocket(self, *a, **k): pass
    def get_lot_size(self, s): return 75
    def get_nearest_expiry(self, s): return "2999-01-01"
    def is_market_open(self, *a, **k): return True
    def get_ltp(self, sid, exchange=None, instrument=None): return self.prices.get(str(sid), 0.0)
    def get_ltps(self, inst): return {str(s): self.prices.get(str(s), 0.0) for _, s in inst}
    def subscribe_instruments(self, x): self.subs += x
    def unsubscribe_instruments(self, x): pass
    def wait_for_fill(self, oid, timeout=5): return True
    def get_order_status(self, oid): return "TRADED"
    def cancel_order(self, oid): return True
    def get_order_by_id(self, oid): return {"averageTradedPrice": self.prices.get(self.orders[int(oid[1:])][1], 100.0)}
    def get_net_quantity(self, sid): return self.net.get(str(sid), 0)

    @staticmethod
    def sid(strike, opt): return strike * 10 + (1 if opt == "CE" else 2)
    def find_option(self, u, exp, strike, t, **k): return {"SECURITY_ID": self.sid(int(strike), t)}
    def get_option_id(self, *a, **k): return None

    def option(self, u, strike, t):
        sid = self.sid(int(strike), t)
        return {"CONTRACT_INFO": {"SECURITY_ID": sid}, "last_price": self.prices.get(str(sid), 0.0)}

    def _place(self, side, sid, qty, fail):
        if str(sid) in fail: return None
        self.orders.append((side, str(sid), qty))
        self.net[str(sid)] = self.net.get(str(sid), 0) + (qty if side == "BUY" else -qty)
        return f"o{len(self.orders) - 1}"

    def sell(self, sid, qty, price=None, product="INTRADAY"):
        assert product == "INTRADAY", product
        if self.sell_hook: self.sell_hook(sid)
        return self._place("SELL", sid, qty, self.fail_sell)

    def buy(self, sid, qty, price=None, product="INTRADAY"):
        assert product == "INTRADAY", product
        return self._place("BUY", sid, qty, self.fail_buy)


H = FakeHelper()
login = types.ModuleType("login"); login.get_dhan_client = lambda: object(); sys.modules["login"] = login
dh = types.ModuleType("lib.dhan_helper"); dh.DhanHelper = lambda dhan: H; sys.modules["lib.dhan_helper"] = dh
sys.argv = [sys.argv[0], "--instance-id", "tc_test"]
spec = importlib.util.spec_from_file_location("tc", os.path.join(ROOT, "strategies", "timed_condor", "nifty_timed_condor.py"))
tc = importlib.util.module_from_spec(spec); spec.loader.exec_module(tc)
tc.time.sleep = lambda s: None
tc.notify = lambda *a, **k: None

KEY = "timed_condor_unit_test"
S = {"long_ce": 25400, "short_ce": 25200, "short_pe": 24800, "long_pe": 24600}      # spot 25000, offset 200, wing 200
SID = {n: H.sid(S[n], "CE" if n.endswith("ce") else "PE") for n in S}
BASE = {"long_ce": 20.0, "long_pe": 20.0, "short_ce": 80.0, "short_pe": 80.0}        # credit 120 per unit


def reset():
    H.__init__()
    for n, px in BASE.items(): H.prices[str(SID[n])] = px
    for f in glob.glob(f"{ROOT}/debug/{KEY}*"): os.remove(f)


def new(dry, **k):
    return tc.TimedCondor(dry_run=dry, state_key=KEY, **k)


ok = fail = 0
def check(name, cond):
    global ok, fail
    cond = bool(cond); print(("PASS " if cond else "FAIL ") + name); ok += cond; fail += (not cond)


def refuses(fn):
    try: fn(); return False
    except (SystemExit, Exception): return True


# ── pure logic ──
check("condor_strikes: shorts +/-200, wings 200 beyond",
      tc.condor_strikes(25010.0, 200, 200) == S and tc.valid_condor(S))
check("condor_strikes rounds spot to the strike step", tc.condor_strikes(25024.0, 200, 200)["short_ce"] == 25200
      and tc.condor_strikes(25026.0, 200, 200)["short_ce"] == 25250)
check("net_credit = shorts minus wings", tc.net_credit(BASE) == 120.0)
check("max loss per unit = wing width - credit", tc.max_loss_per_unit(200, 120.0) == 80.0)
check("valid_condor rejects crossed strikes", not tc.valid_condor({**S, "short_pe": 25300}))

# ── dry run: four legs, no orders, levels resolved off the credit ──
reset(); s = new(True)
s.enter_position(25000.0, TODAY)
check("dry entry opens all four legs", s.position_open and all(s.legs[n] for n in tc.LEG_ORDER) and s.status == "RUNNING")
check("dry entry placed no broker orders", H.orders == [])
check("entry credit = 120 x 75 = 9000; target 50% = 4500; stop 100% = -9000",
      s.entry_credit_rs == 9000.0 and s.target_rs == 4500.0 and s.stop_rs == -9000.0)
check("entered_on is today and persisted", s.entered_on == TODAY and json.load(open(f"{ROOT}/debug/{KEY}_position.json"))["entered_on"] == TODAY)

# ── live: protective legs first ──
reset(); s = new(False)
s.enter_position(25000.0, TODAY)
check("live entry order: BUY wing, BUY wing, SELL short, SELL short",
      [o[0] for o in H.orders] == ["BUY", "BUY", "SELL", "SELL"] and s.position_open)
check("wings bought before any short sold", {o[1] for o in H.orders[:2]} == {str(SID["long_ce"]), str(SID["long_pe"])})

# ── total P&L continuity ──
for n in ("short_ce", "short_pe"): H.prices[str(SID[n])] = 20.0                       # shorts decay 80 -> 20
check("total_pnl = 2 shorts x (80-20) x 75 = 9000", abs(s.total_pnl() - 9000.0) < 1e-6)
check("a zero price is skipped, never booked as a collapse", (H.prices.__setitem__(str(SID["short_ce"]), 0.0) or True)
      and abs(s.total_pnl() - 4500.0) < 1e-6)
H.prices[str(SID["short_ce"])] = 20.0

# ── exit rules ──
check("target fires at +4500", "Target hit" in (s.exit_reason(4500.0, "10:00") or ""))
s.trail.reset()
check("stop fires at -9000", "Stop hit" in (s.exit_reason(-9000.0, "10:00") or ""))
s.trail.reset()
check("EOD fires", "EOD" in (s.exit_reason(100.0, "15:17") or ""))
s.trail.reset()
check("nothing fires in the middle of the day", s.exit_reason(100.0, "11:00") is None)
s.target_rs = None; s.trail.reset()
check("trail arms at +1500 then fires on a 750 giveback",
      s.exit_reason(2000.0, "11:00") is None and s.exit_reason(2900.0, "11:00") is None
      and "Trailing stop" in (s.exit_reason(2100.0, "11:00") or ""))
s.target_rs = 4500.0

# ── full exit books the P&L ──
s.trail.reset()
H.orders.clear()
check("exit_all closes shorts first, then wings, and books 9000",
      s.exit_all("t") and not s.position_open and abs(s.realized_pnl - 9000.0) < 1e-6
      and [o[0] for o in H.orders] == ["BUY", "BUY", "SELL", "SELL"])

# ── entry failures ──
reset(); s = new(False)
H.fail_sell = {str(SID["short_pe"])}                                                    # last leg fails
s.enter_position(25000.0, TODAY)
check("last short fails: everything placed is closed, flat, day consumed",
      not s.position_open and s.status == "WAITING" and s.entered_on == TODAY and all(v == 0 for v in H.net.values()))
check("rollback closed the short before the wings",
      [o[0] for o in H.orders[3:]] == ["BUY", "SELL", "SELL"] and H.orders[3][1] == str(SID["short_ce"]))

reset(); s = new(False)
H.fail_buy = {str(SID["long_ce"])}                                                      # first wing fails
s.enter_position(25000.0, TODAY)
check("first wing fails: nothing placed, flat", not s.position_open and H.orders == [])

reset(); s = new(False)
H.fail_sell = {str(SID["short_pe"])}; H.fail_buy = {str(SID["short_ce"])}                # and the rollback fails too
s.enter_position(25000.0, TODAY)
check("failed rollback -> UNWINDING with the short still tracked (never silently flat)",
      s.position_open and s.status == "UNWINDING" and s.legs["short_ce"] is not None)
H.fail_buy = set(); H.fail_sell = set()
check("retry gets flat", s.exit_all("retry") and not s.position_open and all(v == 0 for v in H.net.values()))

# ── crash between legs, then restart ──
class Crash(BaseException): pass
reset(); s = new(False)
def crash_on_first_short(sid):
    if str(sid) == str(SID["short_ce"]): raise Crash()
H.sell_hook = crash_on_first_short
try: s.enter_position(25000.0, TODAY); crashed = False
except Crash: crashed = True
H.sell_hook = None
check("process death before the first short order", crashed)
s2 = new(False)
check("restart finds the wings tracked as UNWINDING", s2.status == "UNWINDING" and s2.legs["long_ce"] and s2.legs["short_ce"])
H.orders.clear()
check("restart flattens: sells the wings, reads the never-placed shorts flat, sells no short",
      s2.exit_all("restart") and not s2.position_open and all(o[0] == "SELL" for o in H.orders) and len(H.orders) == 2)

# ── restart rules ──
reset(); s = new(False); s.enter_position(25000.0, TODAY); H.subs.clear()
s3 = new(False)
check("restart restores the open book and resubscribes all 4 legs", s3.position_open and len(H.subs) == 4)
check("restart restores the trail and the day's entry", s3.entered_on == TODAY and s3.target_rs == 4500.0)
H.net[str(SID["short_ce"])] = 0                                                         # broker no longer shows a short
check("restart onto a position the broker does not show refuses to start", refuses(lambda: new(False)))
reset(); p = new(True); p.enter_position(25000.0, TODAY)
check("a paper position cannot be picked up by a live run", refuses(lambda: new(False)))
reset(); s = new(False); s.enter_position(25000.0, TODAY); s.exit_all("done")
s4 = new(False)
check("a finished day is remembered: no second entry after a restart", not s4.position_open and s4.entered_on == TODAY)
open(f"{ROOT}/debug/{KEY}_position.json", "w").write("{corrupt")
check("a corrupt position file refuses to start", refuses(lambda: new(True)))

# ── CLI ──
a = tc.build_parser().parse_args([])
check("defaults are dry-run and valid", a.live is False and tc.validate(a) == [])
check("--live without the acknowledgement is refused",
      any("unvalidated" in e for e in tc.validate(tc.build_parser().parse_args(["--live"]))))
check("--live with the acknowledgement is allowed",
      tc.validate(tc.build_parser().parse_args(["--live", "--i-understand-this-is-unvalidated"])) == [])
check("offsets must be multiples of the strike step",
      len(tc.validate(tc.build_parser().parse_args(["--short-offset", "70", "--wing-width", "0"]))) == 2)

for f in glob.glob(f"{ROOT}/debug/{KEY}*") + glob.glob(f"{ROOT}/debug/logs/timed_condor/*tc_test*"): os.remove(f)
print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
