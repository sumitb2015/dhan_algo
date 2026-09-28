"""Stub-broker tests for strategies/put_condor/nifty_put_condor.py. No network, no orders.

Run from the project root:  venv/bin/python tests/test_put_condor.py
"""
import argparse, glob, importlib.util, os, sys, types
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

SPOT = 26188.0
EXPIRIES = ["2026-09-29", "2026-10-06", "2026-10-27", "2026-11-03", "2026-11-23"]


class FakeHelper:
    NSE_HOLIDAYS = set()

    def __init__(self):
        self.prices = {"NIFTY": SPOT}
        self.orders = []            # (side, sid, qty)
        self.net = {}
        self.fail_sell_ids, self.fail_buy_ids, self.no_confirm_ids = set(), set(), set()
        self.subs = []
        self.last_api_error = None
        self.expiries = list(EXPIRIES)

    def start_websocket(self, *a, **k): pass
    def get_lot_size(self, s): return 65
    def get_expiries(self, s): return self.expiries
    def find_option(self, u, exp, strike, t, **k): return {"SECURITY_ID": int(strike) * 10 + 2}
    def get_option_id(self, *a, **k): return None
    def get_ltp(self, sid, exchange=None, instrument=None): return self.prices.get(str(sid), 0.0)
    def get_ltps(self, inst): return {str(s): self.prices.setdefault(str(s), 100.0) for _, s in inst}
    def subscribe_instruments(self, x): self.subs += x
    def unsubscribe_instruments(self, x): pass
    def is_market_open(self): return True
    def get_multi_leg_margin_summary(self, scripts, **k): return {"final_margin": 100000.0}
    def wait_for_fill(self, oid, timeout=5): return tuple(self.orders[int(oid[1:])][:2]) not in self.no_confirm_ids
    def cancel_order(self, oid): return True
    def get_order_status(self, oid): return "CANCELLED"
    def get_order_by_id(self, oid): return {"averageTradedPrice": self.prices.get(self.orders[int(oid[1:])][1], 100.0)}
    def get_net_quantity(self, sid): return self.net.get(str(sid), 0)

    def _place(self, side, sid, qty, fail):
        if str(sid) in fail:
            return None
        self.orders.append((side, str(sid), qty))
        self.net[str(sid)] = self.net.get(str(sid), 0) + (qty if side == "BUY" else -qty)
        return f"o{len(self.orders) - 1}"

    def sell(self, sid, qty, price=None, product="INTRADAY"):
        assert product == "MARGIN", product
        return self._place("SELL", sid, qty, self.fail_sell_ids)

    def buy(self, sid, qty, price=None, product="INTRADAY"):
        assert product == "MARGIN", product
        return self._place("BUY", sid, qty, self.fail_buy_ids)


H = FakeHelper()
login = types.ModuleType("login"); login.get_dhan_client = lambda: object(); sys.modules["login"] = login
dh = types.ModuleType("lib.dhan_helper"); dh.DhanHelper = lambda dhan: H; sys.modules["lib.dhan_helper"] = dh

PATH = os.path.join(ROOT, "strategies", "put_condor", "nifty_put_condor.py")
import logging


class _NoFile(logging.NullHandler):          # keep test runs out of the strategy's real daily log
    def __init__(self, *a, **k):
        super().__init__()


_real_fh, logging.FileHandler = logging.FileHandler, _NoFile
spec = importlib.util.spec_from_file_location("put_condor", PATH)
pc = importlib.util.module_from_spec(spec); spec.loader.exec_module(pc)
logging.FileHandler = _real_fh
pc.time.sleep = lambda s: None
pc.notify = lambda *a, **k: None

KEY = "put_condor_smoke_test"
TODAY = date.today()
SID = {"pe_long_upper": 260502, "pe_short_upper": 258502, "pe_short_lower": 256502, "pe_long_lower": 255002}
LOT = 65


def new(dry, **k):
    return pc.Strategy(dry_run=dry, state_key=KEY, **k)


def clean():
    for f in glob.glob(f"{ROOT}/debug/{KEY}*"):
        os.remove(f)


def reset():
    H.__init__()
    clean()


ok = fail = 0


def check(name, cond):
    global ok, fail
    cond = bool(cond)
    print(("PASS " if cond else "FAIL ") + name)
    ok += cond
    fail += (not cond)


def refuses(fn):
    try:
        fn()
        return False
    except (SystemExit, Exception):
        return True


# ── pure logic ──
check("strikes at spot 26188 = 26050/25850/25650/25500",
      pc.choose_strikes(SPOT, 150, 350, 550, 700, 50) ==
      {"pe_long_upper": 26050, "pe_short_upper": 25850, "pe_short_lower": 25650, "pe_long_lower": 25500})
check("last-Friday trap: 2026-09-25 picks 2026-10-27, not the 2026-09-29 expiry 4 days out",
      pc.pick_cycle_expiry(EXPIRIES, date(2026, 9, 25), 20, 38) == "2026-10-27")
check("day after expiry picks next monthly",
      pc.pick_cycle_expiry(EXPIRIES, date(2026, 9, 30), 20, 38) == "2026-10-27")
check("skip_expiry blocks re-entering a traded cycle",
      pc.pick_cycle_expiry(EXPIRIES, date(2026, 10, 10), 20, 38, skip_expiry="2026-10-27") is None)
check("weekly expiries are ignored (monthly only)",
      pc.monthly_expiries(EXPIRIES) == ["2026-09-29", "2026-10-27", "2026-11-23"])
check("resolve_levels pct and rupees, stop negative",
      pc.resolve_levels(100000, (2.5, True), (10, True), (-4, True)) == (2500.0, 10000.0, -4000.0)
      and pc.resolve_levels(100000, (500, False), (9000, False), (3000, False)) == (500.0, 9000.0, -3000.0))


VIDEO = {"pe_long_upper": 26000, "pe_short_upper": 25800, "pe_short_lower": 25600, "pe_long_lower": 25450}
pay = pc.payoff_summary(VIDEO, {"pe_long_upper": 129, "pe_long_lower": 40, "pe_short_upper": 90,
                                "pe_short_lower": 50}, 65)
check("video example reproduced: 29pt debit -> max loss 1885 (~1900), max profit 11115 (~11000), BE 25971",
      pay["net_debit_pts"] == 29 and pay["max_loss_rs"] == 1885 and pay["max_profit_rs"] == 11115
      and pay["breakeven"] == 25971 and pay["crash_pnl_rs"] == 1365)


def args(*extra):
    return pc.build_parser().parse_args(list(extra))


check("offset gap below strike step rejected", pc.validate(args("--upper-short-offset", "180"))[0])
check("partial >= target rejected", pc.validate(args("--partial-booking-profit", "12%"))[0])
check("--live without ack rejected", pc.validate(args("--live"))[0])
a = args("--entry-time", "9:45")
check("'9:45' normalised to '09:45'", not pc.validate(a)[0] and a.entry_time == "09:45")
check("defaults validate clean", pc.validate(args())[0] == [])

# ── 1 dry run: enter, P&L, target, realized reset next cycle, lots never mutated ──
reset()
s = new(True, lots=2)
s.enter_position(SPOT, TODAY)
check("dry entry opens 4 legs on the 2026-10-27 monthly",
      s.position_open and all(s.legs.values()) and s.expiry == "2026-10-27" and H.orders == [])
check("dry entry resolved levels off margin 100000", (s.partial_rs, s.target_rs, s.stop_rs) == (2500.0, 10000.0, -4000.0))
H.prices[str(SID["pe_long_upper"])] = 150.0          # long upper +50 on 130 qty
pnl = s.total_pnl()
check("total_pnl = 50 * 130", abs(pnl - 6500.0) < 1e-6)
check("target exit books once", s.exit_all("Target hit") and abs(s.realized_pnl - 6500.0) < 1e-6
      and not s.position_open and abs(s.lifetime_realized - 6500.0) < 1e-6)
s.last_cycle_expiry = None
s.enter_position(SPOT, TODAY)
check("next cycle starts with realized 0, lifetime kept", s.realized_pnl == 0.0 and s.lifetime_realized == 6500.0)
H.prices[str(SID["pe_long_upper"])] = 100.0
check("total_pnl None when a leg has no quote",
      (H.prices.__setitem__(str(SID["pe_short_lower"]), 0.0), s.total_pnl())[1] is None)

# ── 2 live: last short fails -> unwind, shorts closed before longs, cycle skipped ──
reset()
s = new(False)
H.fail_sell_ids = {str(SID["pe_short_lower"])}
s.enter_position(SPOT, TODAY)
check("failed entry is flat", not s.position_open and not any(s.legs.values()))
check("placement longs first, unwind closes the short before the longs",
      [(o[0], o[1]) for o in H.orders] == [
          ("BUY", str(SID["pe_long_upper"])), ("BUY", str(SID["pe_long_lower"])),
          ("SELL", str(SID["pe_short_upper"])), ("BUY", str(SID["pe_short_upper"])),
          ("SELL", str(SID["pe_long_upper"])), ("SELL", str(SID["pe_long_lower"]))])
check("cycle with fills is skipped (no re-entry churn)", s.last_cycle_expiry == "2026-10-27")
check("net flat at broker", all(v == 0 for v in H.net.values()))

# ── 3 live: first buy fails, nothing filled -> retry allowed, capped ──
reset()
s = new(False)
H.fail_buy_ids = {str(SID["pe_long_upper"])}
s.enter_position(SPOT, TODAY)
check("nothing filled -> flat, retry allowed", not s.position_open and s.last_cycle_expiry is None and s.entry_attempts == 1)
s.enter_position(SPOT, TODAY); s.enter_position(SPOT, TODAY)
check("3rd failure skips the cycle", s.last_cycle_expiry == "2026-10-27" and s.entry_attempts == 0)

# ── 4 live: unconfirmed entry leg stays tracked and is unwound against broker truth ──
reset()
s = new(False)
H.no_confirm_ids = {("SELL", str(SID["pe_short_upper"]))}
s.enter_position(SPOT, TODAY)
check("unconfirmed short: whole book unwound, flat", not s.position_open and all(v == 0 for v in H.net.values()))

# ── 5 live: exit where a short close fails -> longs held, FLATTENING, retry succeeds ──
reset()
s = new(False)
s.enter_position(SPOT, TODAY)
n = len(H.orders)
H.fail_buy_ids = {str(SID["pe_short_lower"])}
check("exit_all False when a short close fails", s.exit_all("Stop hit: x") is False)
check("longs NOT closed while a short is open",
      s.legs["pe_long_upper"] and s.legs["pe_long_lower"] and s.legs["pe_short_lower"]
      and s.legs["pe_short_upper"] is None and s.status == "FLATTENING"
      and all(o[0] == "BUY" for o in H.orders[n:]))
H.fail_buy_ids = set()
check("retry flattens", s.exit_all("retry FLATTENING") and not s.position_open)
check("stop counted even though it completed on the retry", s.consecutive_stops == 1)

# ── 6 live partial booking: 3 lots, short fails once, then completes ──
reset()
s = new(False, lots=3)
s.enter_position(SPOT, TODAY)
n = len(H.orders)
H.fail_buy_ids = {str(SID["pe_short_lower"])}
s.book_partial()
check("partial: short failure leaves longs untouched",
      all(o[0] == "BUY" for o in H.orders[n:]) and s.legs["pe_long_upper"]["qty"] == 3 * LOT
      and not s.partial_booked)
H.fail_buy_ids = set()
s.book_partial()
check("partial: every leg down to 2 lots", all(l["qty"] == 2 * LOT for l in s.legs.values()) and s.partial_booked)
check("partial: configured lots and entry_lots unchanged", s.lots == 3 and s.entry_lots == 3)
check("partial: each leg reduced exactly once (4 closes of 65)",
      sorted(o[2] for o in H.orders[n:]) == [LOT] * 4)

# ── 7 partial with 1 lot is a no-op ──
reset()
s = new(False, lots=1)
s.enter_position(SPOT, TODAY)
n = len(H.orders)
s.book_partial()
check("1 lot: partial marks booked, no orders", s.partial_booked and len(H.orders) == n)

# ── 8 exit sizing clamps to broker truth ──
reset()
s = new(False, lots=2)
s.enter_position(SPOT, TODAY)
H.net[str(SID["pe_short_upper"])] = -LOT
n = len(H.orders)
s.exit_all("clamp")
closes = [o for o in H.orders[n:] if o[1] == str(SID["pe_short_upper"])]
check("buy-to-close clamped to 65, not own 130", closes and closes[0][2] == LOT)

# ── 9 restart: restore, resubscribe, reconcile (sibling extra OK, shortfall refuses) ──
reset()
s = new(False)
s.enter_position(SPOT, TODAY)
H.subs.clear()
s2 = new(False)
check("restart restores legs and resubscribes 4", s2.position_open and len(H.subs) == 4
      and s2.legs["pe_short_upper"]["strike"] == 25850)
H.net[str(SID["pe_short_upper"])] -= LOT                 # a sibling instance also short here
check("sibling extra qty does not block restart", not refuses(lambda: new(False)))
H.net[str(SID["pe_long_lower"])] = 0
check("broker shortfall refuses to start", refuses(lambda: new(False)))

# ── 10 UNWINDING restart skips reconcile ──
s2.status = "UNWINDING"; s2.save_position()
check("UNWINDING restart does not refuse on a missing leg", not refuses(lambda: new(False)))

# ── 11 expired live position refuses; expired paper is discarded ──
s2.status = "RUNNING"; s2.expiry = "2020-01-01"; s2.save_position()
check("expired LIVE position refuses to start", refuses(lambda: new(False)))
clean(); H.__init__()
p = new(True); p.enter_position(SPOT, TODAY); p.expiry = "2020-01-01"; p.save_position()
p2 = new(True)
check("expired PAPER position discarded", not p2.position_open)

# ── 12 paper vs live, corrupt file ──
clean(); H.__init__()
p = new(True); p.enter_position(SPOT, TODAY)
check("paper position refused by live run", refuses(lambda: new(False)))
clean()
open(f"{ROOT}/debug/{KEY}_position.json", "w").write("{not json")
check("corrupt position file refuses to start", refuses(lambda: new(True)))
clean()

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
