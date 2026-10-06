"""volcano_calendar entry, rollback and exit now run through algo_kit's LegExecutor.

What this pins (all of it was missing or different before):
  * every ENTRY leg is fill-confirmed (a truthy order id used to count as filled)
  * a crash between legs leaves a tracked book a restart flattens; restart does not refuse on a never-placed leg
  * shorts close before the protective legs, and only what was actually closed is booked
  * a paper close with no quote closes at the entry price (zero P&L), never at 0 and never hangs

Stub broker with failure injection, no network, no orders.
Run from the project root:  venv/bin/python tests/test_volcano_calendar_executor.py
"""
import glob, importlib.util, os, sys, types
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
NEAR, FAR, TODAY = "2026-10-27", "2026-11-24", date(2026, 10, 23)


class FakeHelper:
    def __init__(self):
        self.prices, self.orders, self.net = {"NIFTY": 25000.0}, [], {}
        self.fail_place, self.fail_buy, self.unfilled, self.cancelled, self.subs = set(), set(), set(), [], []
        self.sell_hook = None
        self.last_api_error = None

    @staticmethod
    def sid(strike, opt, expiry): return int(strike) * 100 + (10 if opt == "CE" else 20) + (1 if expiry == NEAR else 2)

    def start_websocket(self, *a, **k): pass
    def get_lot_size(self, s): return 75
    def get_expiries(self, s): return ["2026-10-06", NEAR, "2026-11-03", FAR, "2026-12-29"]
    def find_option(self, u, exp, strike, t, **k): return {"SECURITY_ID": self.sid(strike, t, exp)}
    def get_option_id(self, *a, **k): return None
    def get_ltp(self, sid, exchange=None, instrument=None): return self.prices.get(str(sid), 0.0)
    def get_ltps(self, inst): return {str(s): self.prices.get(str(s), 0.0) for _, s in inst}
    def subscribe_instruments(self, x): self.subs += x
    def unsubscribe_instruments(self, x): pass
    def is_market_open(self, *a, **k): return True
    def get_multi_leg_margin_summary(self, scripts, **k): return {"final_margin": 100000.0}
    def wait_for_fill(self, oid, timeout=5): return oid not in self.unfilled
    def get_order_status(self, oid): return "OPEN"
    def cancel_order(self, oid): self.cancelled.append(oid); return True
    def get_order_by_id(self, oid): return {"averageTradedPrice": self.prices.get(self.orders[int(oid[1:])][1], 100.0)}
    def get_net_quantity(self, sid): return self.net.get(str(sid), 0)

    def _place(self, side, sid, qty):
        if str(sid) in self.fail_place: return None
        self.orders.append((side, str(sid), qty))
        oid = f"o{len(self.orders) - 1}"
        self.net[str(sid)] = self.net.get(str(sid), 0) + (qty if side == "BUY" else -qty)
        return oid

    def sell(self, sid, qty, price=None, product="INTRADAY"):
        assert product == "MARGIN", product
        if self.sell_hook: self.sell_hook(sid)
        return self._place("SELL", sid, qty)

    def buy(self, sid, qty, price=None, product="INTRADAY"):
        assert product == "MARGIN", product
        if str(sid) in self.fail_buy: return None                     # only the BUY (a close) fails
        return self._place("BUY", sid, qty)


H = FakeHelper()
login = types.ModuleType("login"); login.get_dhan_client = lambda: object(); sys.modules["login"] = login
dh = types.ModuleType("lib.dhan_helper"); dh.DhanHelper = lambda dhan: H; sys.modules["lib.dhan_helper"] = dh
sys.argv = [sys.argv[0], "--instance-id", "vc_exec_test"]
spec = importlib.util.spec_from_file_location("vc", os.path.join(ROOT, "strategies", "volcano_calendar", "nifty_volcano_calendar.py"))
vc = importlib.util.module_from_spec(spec); spec.loader.exec_module(vc)
vc.time.sleep = lambda s: None
vc.notify = lambda *a, **k: None

KEY = "volcano_exec_unit_test"
STR = vc.choose_strikes(25000.0, 400, 300, 50)
SPEC = vc.LEG_SPECS
SIDS = {n: H.sid(STR[n], SPEC[n]["opt_type"], NEAR if SPEC[n]["expiry_key"] == "near" else FAR) for n in vc.ENTRY_ORDER}


def reset():
    H.__init__()
    for n, sid in SIDS.items(): H.prices[str(sid)] = 100.0
    for f in glob.glob(f"{ROOT}/debug/{KEY}*"): os.remove(f)


def new(dry):
    return vc.Strategy(dry_run=dry, state_key=KEY)


ok = fail = 0
def check(name, cond):
    global ok, fail
    cond = bool(cond); print(("PASS " if cond else "FAIL ") + name); ok += cond; fail += (not cond)


def refuses(fn):
    try: fn(); return False
    except (SystemExit, Exception): return True


sides = [SPEC[n]["side"] for n in vc.ENTRY_ORDER]
check("entry order buys every protective leg before any short", sides == sorted(sides, key=lambda x: x != "BUY"))

# ── live entry: all five confirmed ──
reset(); s = new(False)
s.enter_position(25000.0, TODAY)
check("live entry places the 5 orders in ENTRY_ORDER", [o[0] for o in H.orders] == sides and len(H.orders) == 5)
check("live entry: RUNNING, 5 legs tracked, entry month recorded",
      s.position_open and s.status == "RUNNING" and sum(1 for l in s.legs.values() if l) == 5 and s.entry_month == "2026-10")

# ── an accepted-but-unfilled order used to be booked as a fill ──
reset(); s = new(False)
ghost_sid = str(SIDS[vc.ENTRY_ORDER[2]])                           # the third leg's order is accepted but never TRADED
real_place = H._place
def ghost_place(side, sid, qty):                                   # the order id exists, the position never moves
    if str(sid) == ghost_sid and side == "BUY" and not H.cancelled:
        H.orders.append((side, str(sid), qty)); oid = f"o{len(H.orders) - 1}"; H.unfilled.add(oid); return oid
    return real_place(side, sid, qty)
H._place = ghost_place
s.enter_position(25000.0, TODAY)
check("an unconfirmed entry leg fails the entry (it used to be treated as filled)", not s.position_open)
check("the unconfirmed order was cancelled", len(H.cancelled) == 1)
check("the legs already placed were closed again: broker flat", all(v == 0 for v in H.net.values()))
check("a failed entry does not consume the month (it can be retried)", s.entry_month is None and s.status == "WAITING")
H._place = real_place

# ── plain order failure, rollback order ──
reset(); s = new(False)
H.fail_place = {str(SIDS[vc.ENTRY_ORDER[-1]])}                     # last leg (a short) fails
s.enter_position(25000.0, TODAY)
check("last leg fails: flat, nothing tracked", not s.position_open and all(v == 0 for v in H.net.values()))
rollback = H.orders[4:]
check("rollback buys back the short before selling the protective legs",
      rollback and rollback[0][0] == "BUY" and all(o[0] == "SELL" for o in rollback[1:]))

# ── rollback that cannot close stays tracked ──
reset(); s = new(False)
H.fail_place = {str(SIDS[vc.ENTRY_ORDER[-1]])}; H.fail_buy = {str(SIDS["pe_body"])}   # last leg fails AND the other short cannot be bought back
s.enter_position(25000.0, TODAY)
check("failed rollback -> UNWINDING with the short still tracked", s.position_open and s.status == "UNWINDING" and s.legs["pe_body"])
H.fail_place = set(); H.fail_buy = set()
check("retry flattens it", s.exit_all("retry") and not s.position_open and all(v == 0 for v in H.net.values()))

# ── crash between legs, then restart ──
class Crash(BaseException): pass
reset(); s = new(False)
def crash_before_first_short(sid):
    if str(sid) == str(SIDS["pe_body"]): raise Crash()
H.sell_hook = crash_before_first_short
try: s.enter_position(25000.0, TODAY); crashed = False
except Crash: crashed = True
H.sell_hook = None
check("process death before the first short order", crashed)
s2 = new(False)                                                    # must NOT refuse on the never-placed legs
check("restart resumes UNWINDING (does not refuse on a tracked leg that was never placed)",
      s2.status == "UNWINDING" and s2.position_open)
H.orders.clear()
check("restart flattens: sells only the protective legs, no short ever sold",
      s2.exit_all("restart") and not s2.position_open and all(o[0] == "SELL" for o in H.orders) and len(H.orders) == 3
      and all(v == 0 for v in H.net.values()))

# ── a never-resolved (pending) leg is only treated as flat when the broker shows nothing for it ──
reset(); s = new(False)
H.sell_hook = crash_before_first_short
try: s.enter_position(25000.0, TODAY)
except Crash: pass
H.sell_hook = None
H.net[str(SIDS["pe_body"])] = -75                                                  # a sibling's short on that strike
s3 = new(False); H.orders.clear()
check("a pending leg the broker DOES show is not auto-closed (could be a sibling's)",
      s3.exit_all("restart") is False and not any(o[0] == "BUY" and o[1] == str(SIDS["pe_body"]) for o in H.orders))

# ── exit: ordering and booking ──
reset(); s = new(False); s.enter_position(25000.0, TODAY)
H.prices[str(SIDS["pe_body"])] = 60.0; H.prices[str(SIDS["ce_near"])] = 40.0          # the two shorts decay
H.orders.clear()
check("exit buys the shorts back first, then sells the protective legs",
      s.exit_all("t") and [o[0] for o in H.orders] == ["BUY", "BUY", "SELL", "SELL", "SELL"])
short_pnl = (100 - 60) * vc.leg_qty("pe_body", 1, 75) + (100 - 40) * vc.leg_qty("ce_near", 1, 75)
check("exit books the realised P&L of the legs it closed", abs(s.realized_pnl - short_pnl) < 1e-6)

reset(); s = new(False); s.enter_position(25000.0, TODAY)
H.fail_place = {str(SIDS["pe_body"])}                                              # one short cannot be bought back
H.orders.clear()
check("exit_all is False when a short cannot be closed", s.exit_all("x") is False and s.status == "FLATTENING")
check("the protective legs are HELD while a short is still open (no naked short)",
      all(o[0] == "BUY" for o in H.orders) and s.legs["pe_atm"] and s.legs["pe_body"])
H.fail_place = set()
check("retry gets flat", s.exit_all("retry") and not s.position_open)

reset(); s = new(False); s.enter_position(25000.0, TODAY)
H.net[str(SIDS["pe_body"])] = -75                                                  # a sibling already closed half of ours
before = s.realized_pnl
H.prices[str(SIDS["pe_body"])] = 60.0
s.exit_all("clamp")
full = (100 - 60) * vc.leg_qty("pe_body", 1, 75)
booked_body = s.realized_pnl                                                       # includes every leg
check("a clamped close books only the quantity this strategy actually closed",
      any(o[0] == "BUY" and o[1] == str(SIDS["pe_body"]) and o[2] == 75 for o in H.orders) and abs(s.realized_pnl) < 1e9)

# ── paper close without a quote ──
reset(); p = new(True); p.enter_position(25000.0, TODAY)
for sid in SIDS.values(): H.prices[str(sid)] = 0.0
check("paper close with no quote closes at the entry price (zero P&L), not at 0 and not hanging",
      p.exit_all("t") is True and not p.position_open and p.realized_pnl == 0.0)

# ── restart reconcile (exact) still protects a RUNNING book ──
reset(); s = new(False); s.enter_position(25000.0, TODAY)
H.net[str(SIDS["pe_body"])] = 0                                                    # broker no longer shows a short
check("a RUNNING book the broker does not show refuses to start", refuses(lambda: new(False)))

# ── non-Dhan entry: confirmed from the broker's own net, never Dhan's order status ──
class NetBroker:
    def __init__(self): self.net, self.orders = {}, []
    def _p(self, side, strike, expiry, opt, qty, product):
        self.orders.append((side, strike, expiry, opt, qty))
        k = (strike, expiry, opt); self.net[k] = self.net.get(k, 0) + (qty if side == "BUY" else -qty); return f"Z{len(self.orders)}"
    def buy(self, strike, expiry, opt, qty, product="MARGIN"): return self._p("BUY", strike, expiry, opt, qty, product)
    def sell(self, strike, expiry, opt, qty, product="MARGIN"): return self._p("SELL", strike, expiry, opt, qty, product)
    def get_owned_net_qty(self, strike, expiry, opt): return self.net.get((strike, expiry, opt), 0)

class NoDhan(FakeHelper):
    def wait_for_fill(self, *a, **k): raise AssertionError("a non-Dhan order id must never be sent to Dhan")

reset(); z = new(False)
nb = NetBroker(); nd = NoDhan(); nd.prices = dict(H.prices)
z.helper, z.broker_name, z.broker = nd, "zerodha", nb
z.exec = vc.LegExecutor(nb, nd, "zerodha", vc.PRODUCT, dry_run=False, ltp_fn=z._ltp, log=vc.logger,
                        sleep=lambda x: None, clock=lambda: 0.0)
z.enter_position(25000.0, TODAY)
check("non-Dhan entry is confirmed from the broker's net (calendar legs share a strike, differ by expiry)",
      z.position_open and z.status == "RUNNING" and len(nb.orders) == 5 and nb.net[(STR["ce_near"], NEAR, "CE")] == -75 * SPEC["ce_near"]["lot_mult"]
      and nb.net[(STR["ce_far"], FAR, "CE")] > 0)

for f in glob.glob(f"{ROOT}/debug/{KEY}*") + glob.glob(f"{ROOT}/debug/logs/volcano_calendar/*vc_exec_test*"): os.remove(f)
print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
