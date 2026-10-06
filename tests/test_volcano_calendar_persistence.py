"""volcano_calendar position persistence and fill price (migrated onto lib/algo_kit).
Stub broker, no network, no orders.

Run from the project root:  venv/bin/python tests/test_volcano_calendar_persistence.py [strategy.py]
(The optional path lets the same checks run against a pre-migration copy to prove parity.)
"""
import glob, importlib.util, json, logging, os, sys, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


class FakeHelper:
    def __init__(self):
        self.subs, self.filled, self.order = [], True, {"averageTradedPrice": 87.25}
        self.orders = []

    def start_websocket(self, *a, **k): pass
    def get_lot_size(self, s): return 65
    def subscribe_instruments(self, x): self.subs += x
    def is_market_open(self): return True
    def wait_for_fill(self, oid, timeout=5): return self.filled
    def get_order_by_id(self, oid): return self.order
    def get_net_quantity(self, sid): return 0


H = FakeHelper()
login = types.ModuleType("login"); login.get_dhan_client = lambda: object(); sys.modules["login"] = login
dh = types.ModuleType("lib.dhan_helper"); dh.DhanHelper = lambda dhan: H; sys.modules["lib.dhan_helper"] = dh

PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "strategies", "volcano_calendar", "nifty_volcano_calendar.py")


class _NoFile(logging.NullHandler):          # keep test runs out of the strategy's real daily log
    def __init__(self, *a, **k):
        super().__init__()


_real_fh, logging.FileHandler = logging.FileHandler, _NoFile
spec = importlib.util.spec_from_file_location("volcano", PATH)
vc = importlib.util.module_from_spec(spec); spec.loader.exec_module(vc)
logging.FileHandler = _real_fh
vc.notify = lambda *a, **k: None

KEY = "volcano_persist_test"
LEG = {"id": 123, "strike": 25000, "qty": 65, "side": "SELL", "opt_type": "CE", "expiry": "2999-01-01"}
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


def clean():
    for f in glob.glob(f"{ROOT}/debug/{KEY}*"):
        os.remove(f)


def new(dry):
    return vc.Strategy(dry_run=dry, state_key=KEY)


def path():
    return f"{ROOT}/debug/{KEY}_position.json"


clean()
s = new(True)
check("no file: starts flat", not s.position_open)

s.position_open, s.status, s.entry_month = True, "RUNNING", "2026-10"
s.near_expiry, s.far_expiry, s.consecutive_stops, s.realized_pnl = "2999-01-01", "2999-02-01", 2, -150.0
s.legs = {**s.legs, "short_call": dict(LEG)}
s.target_rs, s.stop_rs = 3400.0, 3400.0
s.save_position()
d = json.load(open(path()))
check("file keeps its schema (version, dry_run, updated_at, payload)",
      d["version"] == 1 and d["dry_run"] is True and "updated_at" in d and d["entry_month"] == "2026-10"
      and d["legs"]["short_call"]["id"] == 123 and d["consecutive_stops"] == 2 and not os.path.exists(path() + ".tmp"))

H.subs.clear()
s2 = new(True)
check("restart restores the open position", s2.position_open and s2.legs["short_call"]["id"] == 123
      and s2.realized_pnl == -150.0 and s2.near_expiry == "2999-01-01" and s2.target_rs == 3400.0)
check("restart resubscribes the tracked leg", ("NSE_FNO", "123", 15) in H.subs)
check("cycle memory restored", s2.entry_month == "2026-10" and s2.consecutive_stops == 2)

check("paper position refused by live run", refuses(lambda: new(False)))

s2.position_open = False
s2.save_position()
s3 = new(False)
check("flat file restores cycle memory in either mode, no refusal",
      not s3.position_open and s3.entry_month == "2026-10" and s3.consecutive_stops == 2)

open(path(), "w").write("{corrupt")
check("corrupt position file refuses to start", refuses(lambda: new(True)))
clean()

lv = new(False)                                       # fill prices are only read in a live run
H.filled, H.order = True, {"averageTradedPrice": 87.25}
check("fill price comes from the order, not the wait bool", lv.exec.fill_price("o1", 90.0) == 87.25)
H.filled = False
check("a fill price is read off the order record even when wait_for_fill said no (confirming is a separate step)",
      lv.exec.fill_price("o1", 90.0) == 87.25)
H.order = {"averageTradedPrice": 0}
check("an order record with no price falls back to the quote", lv.exec.fill_price("o1", 90.0) == 90.0)
check("paper / empty id returns fallback", lv.exec.fill_price("PAPER", 90.0) == 90.0 and lv.exec.fill_price(None, 90.0) == 90.0)
check("a paper run never reads fills", (setattr(H, "order", {"averageTradedPrice": 87.25}) or True)
      and s.exec.fill_price("o1", 90.0) == 90.0)

clean()

# ── expired positions (near-leg settlement) ──
def write_pos(dry, near):
    json.dump({"version": 1, "dry_run": dry, "position_open": True, "status": "RUNNING", "near_expiry": near,
               "far_expiry": "2999-02-01", "legs": {}, "realized_pnl": 0.0}, open(path(), "w"))

write_pos(False, "2020-01-01")
check("expired LIVE position (near expiry passed) refuses to start", refuses(lambda: new(False)))
write_pos(True, "2020-01-01")
check("expired PAPER position is discarded, starts flat", not new(True).position_open)
write_pos(False, "2999-01-01")
check("live position with a future near expiry still loads", new(False).position_open)
clean()


# ── closing a leg on a NON-Dhan broker ──
class NetBroker:
    """Zerodha/Kotak stand-in: order ids are not Dhan ids; truth is the broker's own net position."""
    def __init__(self, net):
        self.net, self.orders = net, []

    def get_owned_net_qty(self, strike, expiry, opt_type): return self.net

    def buy(self, strike, expiry, opt_type, qty, product="INTRADAY"):
        self.net += qty; self.orders.append(("BUY", qty)); return "Z-BUY-1"

    def sell(self, strike, expiry, opt_type, qty, product="INTRADAY"):
        self.net -= qty; self.orders.append(("SELL", qty)); return "Z-SELL-1"


class DhanMustNotBeAsked(FakeHelper):
    def wait_for_fill(self, oid, timeout=5):
        raise AssertionError("Dhan cannot confirm another broker's order id")

    def get_ltp(self, sid, exchange=None, instrument=None): return 80.0


vc.time.sleep = lambda s: None
H2 = DhanMustNotBeAsked()
vc.DhanHelper = lambda dhan: H2
live = new(False)
live.helper, live.broker_name, live.broker = H2, "zerodha", NetBroker(net=-LEG["qty"])
live.exec = vc.LegExecutor(live.broker, H2, "zerodha", vc.PRODUCT, dry_run=False, ltp_fn=live._ltp, log=vc.logger,
                           sleep=lambda x: vc.time.sleep(x), clock=lambda: vc.time.time())
r = live.exec.close_leg(dict(LEG), name="short_call"); closed, px = r.confirmed, r.exit_price
check("non-Dhan close is confirmed from the broker's net position, not Dhan's order status",
      closed is True and live.broker.orders == [("BUY", LEG["qty"])] and live.broker.net == 0)
check("non-Dhan fill price falls back to the LTP (never asks Dhan about a foreign id)",
      live.exec.fill_price("Z-BUY-1", 91.5) == 91.5)

stuck = new(False)
stuck.helper, stuck.broker_name = H2, "kotak"
class NeverMoves(NetBroker):
    def buy(self, *a, **k): self.orders.append(("BUY", a[3])); return "Z-BUY-2"
stuck.broker = NeverMoves(net=-LEG["qty"])
stuck.exec = vc.LegExecutor(stuck.broker, H2, "kotak", vc.PRODUCT, dry_run=False, ltp_fn=stuck._ltp, log=vc.logger,
                            sleep=lambda x: vc.time.sleep(x), clock=lambda: vc.time.time(), confirm_timeout=5)
vc.time.time, _t = (lambda: _t[0]), [0.0]
vc.time.sleep = lambda s: _t.__setitem__(0, _t[0] + s)
closed = stuck.exec.close_leg(dict(LEG), name="short_call").confirmed
check("non-Dhan close that never shows in the net position stays tracked (not silently flat)", closed is False)
clean()
print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
