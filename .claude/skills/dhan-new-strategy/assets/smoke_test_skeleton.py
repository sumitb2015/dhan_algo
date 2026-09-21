"""
Stub-broker smoke test for a strategy built from assets/strategy_skeleton.py (or any strategy that
follows the same Strategy class shape). Copy it next to your strategy, point SKEL at your file and adapt
the strike arithmetic (this one assumes the skeleton's default choose_strikes: ATM +/- 100 at spot 25000).

It drives the real ExecutionBroker/state helpers with a fake DhanHelper, so it is safe against a live
account: no network, no orders. What it proves, per the standard kit:
  dry-run parity, all-or-nothing entry + rollback, failed rollback -> UNWINDING (never silently flat),
  failed close -> leg stays tracked + FLATTENING, exit sizing clamped to broker truth, restart restore +
  resubscribe, reconcile refusal, paper-vs-live refusal, corrupt-file refusal.

Run from the project root:  venv/bin/python <this file> [path/to/strategy.py]
"""
import importlib.util, os, sys, types, glob

def _root(d=os.path.dirname(os.path.abspath(__file__))):
    while not os.path.exists(os.path.join(d, "login.py")):
        if os.path.dirname(d) == d:
            raise RuntimeError("run inside the dhan_algo repo")
        d = os.path.dirname(d)
    return d
ROOT = _root()
sys.path.insert(0, ROOT)

class FakeHelper:
    def __init__(self):
        self.prices = {"NIFTY": 25000.0}
        self.orders = []            # (side, id, qty)
        self.net = {}               # security id -> net qty
        self.fail_sell_ids, self.fail_buy_ids = set(), set()
        self.subs = []
        self.n = 0
    def start_websocket(self, *a, **k): pass
    def get_lot_size(self, s): return 75
    def get_nearest_expiry(self, s): return "2026-09-29"
    def option(self, u, strike, t):
        sid = strike * 10 + (1 if t == "CE" else 2)
        self.prices.setdefault(str(sid), 100.0)
        return {"CONTRACT_INFO": {"SECURITY_ID": sid}, "last_price": self.prices[str(sid)]}
    def find_option(self, u, exp, strike, t): return {"SECURITY_ID": strike * 10 + (1 if t == "CE" else 2)}
    def get_option_id(self, *a, **k): return None
    def get_ltp(self, sid, exchange=None, instrument=None): return self.prices.get(str(sid), 0.0)
    def subscribe_instruments(self, x): self.subs += x
    def unsubscribe_instruments(self, x): pass
    def is_market_open(self): return True
    def wait_for_fill(self, oid, timeout=5): return True
    def get_order_by_id(self, oid): return {"averageTradedPrice": self.prices.get(self.orders[int(oid[1:])][1], 100.0)}
    def get_net_quantity(self, sid): return self.net.get(str(sid), 0)
    def _place(self, side, sid, qty, fail):
        if str(sid) in fail: return None
        self.orders.append((side, str(sid), qty))
        self.net[str(sid)] = self.net.get(str(sid), 0) + (qty if side == "BUY" else -qty)
        return f"o{len(self.orders)-1}"
    def sell(self, sid, qty, price=None, product="INTRADAY"): return self._place("SELL", sid, qty, self.fail_sell_ids)
    def buy(self, sid, qty, price=None, product="INTRADAY"): return self._place("BUY", sid, qty, self.fail_buy_ids)

H = FakeHelper()
login = types.ModuleType("login"); login.get_dhan_client = lambda: object(); sys.modules["login"] = login
dh = types.ModuleType("lib.dhan_helper"); dh.DhanHelper = lambda dhan: H; sys.modules["lib.dhan_helper"] = dh

SKEL = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, ".claude/skills/dhan-new-strategy/assets/strategy_skeleton.py")
spec = importlib.util.spec_from_file_location("skel", SKEL)
skel = importlib.util.module_from_spec(spec); spec.loader.exec_module(skel)
KEY = "skeleton_smoke_test"
def new(dry, **k): return skel.Strategy(dry_run=dry, state_key=KEY, **k)
def clean():
    for f in glob.glob(f"{ROOT}/debug/{KEY}*"): os.remove(f)
ok = fail = 0
def check(name, cond):
    global ok, fail
    cond = bool(cond); print(("PASS " if cond else "FAIL ") + name); ok += cond; fail += (not cond)

skel.time.sleep = lambda s: None
clean()

# pure logic
check("update_trail arms then fires", skel.update_trail(2500, 0, False, 2000, 1000) == (True, 2500, False)
      and skel.update_trail(1400, 2500, True, 2000, 1000)[2] is True)
check("inverted() detects CE<=PE", skel.inverted(24900, 25000) and not skel.inverted(25100, 24900))

# 1 dry run: enter, position persisted, price moves to target, exit books profit
s = new(True, target=(1000.0, False))
s.enter_position(25000.0)
check("dry entry opens both legs", s.position_open and s.legs["CE"] and s.legs["PE"])
check("dry entry placed no broker orders", H.orders == [])
for leg in s.legs.values(): H.prices[str(leg["id"])] = 80.0          # premiums decay 100 -> 80
pnl = s.total_pnl()
check("total_pnl = (100-80)*75*2", abs(pnl - 3000.0) < 1e-6)
check("exit_all True and books realized once", s.exit_all("t") and abs(s.realized_pnl - 3000.0) < 1e-6 and not s.position_open)
clean()

# 2 live: PE sell fails -> CE rolled back, flat
H.__init__(); s = new(False)
pe_id = (25000 - 100) * 10 + 2
H.fail_sell_ids = {str(pe_id)}
s.enter_position(25000.0)
check("PE sell failed -> flat", not s.position_open and s.legs == {"CE": None, "PE": None})
check("CE leg was rolled back (SELL then BUY)", [o[0] for o in H.orders] == ["SELL", "BUY"])
clean()

# 3 live: PE sell fails AND rollback fails -> UNWINDING with CE tracked (never silently flat)
H.__init__(); s = new(False)
ce_id = (25000 + 100) * 10 + 1
H.fail_sell_ids = {str(pe_id)}; H.fail_buy_ids = {str(ce_id)}
s.enter_position(25000.0)
check("failed rollback -> UNWINDING, CE tracked", s.status == "UNWINDING" and s.position_open and s.legs["CE"] is not None)
H.fail_buy_ids = set()
check("retry closes it", s.exit_all("retry") and not s.position_open)
clean()

# 4 live: both legs enter; exit close fails -> stays tracked, FLATTENING; then succeeds
H.__init__(); s = new(False)
s.enter_position(25000.0)
check("live entry placed 2 sells", [o[0] for o in H.orders] == ["SELL", "SELL"] and s.position_open)
H.fail_buy_ids = {str(ce_id)}
check("exit_all False when a close fails", s.exit_all("x") is False)
check("failed leg still tracked, other cleared, FLATTENING", s.legs["CE"] is not None and s.legs["PE"] is None and s.status == "FLATTENING")
H.fail_buy_ids = set()
check("retry gets flat", s.exit_all("retry") and not s.position_open)
clean()

# 5 exit sizing clamps to broker truth (sibling closed half)
H.__init__(); s = new(False, lots=2)
s.enter_position(25000.0)
H.net[str(ce_id)] = -75                                              # broker shows only 1 lot short
H.orders.clear(); s.exit_all("clamp")
ce_buys = [o for o in H.orders if o[0] == "BUY" and o[1] == str(ce_id)]
check("CE buy-to-close clamped to 75, not own 150", ce_buys and ce_buys[0][2] == 75)
clean()

# 6 restart restore + resubscribe + reconcile ok
H.__init__(); s = new(False)
s.enter_position(25000.0)
H.subs.clear()
s2 = new(False)
check("restart restores open legs", s2.position_open and s2.legs["CE"]["strike"] == 25100)
check("restart resubscribes legs", len(H.subs) == 2)
# 7 reconcile mismatch refuses to start
H.net[str(ce_id)] = 0
try: new(False); refused = False
except SystemExit: refused = True
check("reconcile mismatch refuses to start", refused)
# 8 paper file cannot be loaded by live run
clean(); H.__init__(); p = new(True); p.enter_position(25000.0)
try: new(False); refused = False
except SystemExit: refused = True
check("paper position refused by live run", refused)
clean()

# 9 corrupt file refuses
open(f"{ROOT}/debug/{KEY}_position.json", "w").write("{not json")
try: new(True); refused = False
except Exception: refused = True
check("corrupt position file refuses to start", refused)
clean()
print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
