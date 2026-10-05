"""st_oi_bearcall's quote / fill / LTP helpers (migrated onto lib/algo_kit) behave exactly as before.
Stub helper, no network, no orders. The strategy has no other test, so this pins the helpers moved.

Run from the project root:  venv/bin/python tests/test_st_oi_bearcall_kit_parity.py [strategy.py]
(The optional path runs the same checks against a pre-migration copy to prove parity.)
"""
import glob, importlib.util, os, sys, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.argv = [sys.argv[0]] + sys.argv[1:2] + ["--instance-id", "parity_test"]   # isolates this run's log file
PATH = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].endswith(".py") else \
    os.path.join(ROOT, "strategies", "st_oi_bearcall", "nifty_st_oi_bearcall.py")
sys.argv = [sys.argv[0], "--instance-id", "parity_test"]

login = types.ModuleType("login"); login.get_dhan_client = lambda: object(); sys.modules["login"] = login
dh = types.ModuleType("lib.dhan_helper"); dh.DhanHelper = lambda dhan: None; sys.modules["lib.dhan_helper"] = dh
spec = importlib.util.spec_from_file_location("bearcall", PATH)
bc = importlib.util.module_from_spec(spec); spec.loader.exec_module(bc)


class Helper:
    def __init__(self, filled=True, order=None, ltps=None):
        self.filled, self.order, self.ltps, self.waited = filled, order, ltps or {}, []

    def wait_for_fill(self, oid, timeout=5):
        self.waited.append((oid, timeout)); return self.filled

    def get_order_by_id(self, oid): return self.order
    def get_ltps(self, pairs): self.asked = pairs; return self.ltps


S = bc.NiftySTOIBearCallStrategy.__new__(bc.NiftySTOIBearCallStrategy)
S.lot_size, S.expiry, S.symbol = 75, "2026-10-13", "NIFTY"
S.short_id, S.long_id, S.index_segment, S.index_security_id = 101, 102, "IDX_I", "13"

GOOD = {"last_price": 120.5, "CONTRACT_INFO": {"SECURITY_ID": "777", "SM_EXPIRY_DATE": "2026-10-20",
                                               "LOT_SIZE": 65, "SYMBOL_NAME": "NIFTY-X"}}
ok = fail = 0


def check(name, cond):
    global ok, fail
    cond = bool(cond)
    print(("PASS " if cond else "FAIL ") + name)
    ok += cond
    fail += (not cond)


# ── is_quote_invalid: STRICT (a chain-fallback shape has no security id to order with) ──
check("None / {} invalid", S.is_quote_invalid(None) and S.is_quote_invalid({}))
check("zero price invalid", S.is_quote_invalid({"last_price": 0, "CONTRACT_INFO": {}}))
check("non-CONTRACT_INFO dict invalid (strict)", S.is_quote_invalid({"foo": 1}))
check("non-dict invalid", S.is_quote_invalid("x"))
check("good quote valid", not S.is_quote_invalid(GOOD))
check("LTP key used when last_price missing", not S.is_quote_invalid({"LTP": 5.0, "CONTRACT_INFO": {}}))

# ── _extract_quote_fields ──
check("extract: full quote", tuple(S._extract_quote_fields(GOOD, 25000, "CE")) == (777, 120.5, "2026-10-20", 65, "NIFTY-X"))
check("extract: missing quote -> (None, 0.0, None, lot, None)",
      tuple(S._extract_quote_fields(None, 25000, "CE")) == (None, 0.0, None, 75, None))
check("extract: foreign shape -> (None, 0.0, None, lot, None)",
      tuple(S._extract_quote_fields({"foo": 1}, 25000, "CE")) == (None, 0.0, None, 75, None))
bare = {"LTP": 5.0, "CONTRACT_INFO": {"SECURITY_ID": 9}}
check("extract: defaults for expiry / lot / symbol",
      tuple(S._extract_quote_fields(bare, 25000, "CE")) == (9, 5.0, "2026-10-13", 75, "NIFTY-25000-CE"))

# ── get_execution_price ──
S.helper = Helper(filled=True, order={"averageTradedPrice": 87.25})
check("fill price read from the order", S.get_execution_price("A1", 90.0) == 87.25 and S.helper.waited == [("A1", 5)])
S.helper = Helper(filled=True, order={"avgFilledPrice": 55.5})
check("avgFilledPrice key honoured", S.get_execution_price("A1", 90.0) == 55.5)
S.helper = Helper(filled=True, order={"price": 41.0})
check("price key honoured", S.get_execution_price("A1", 90.0) == 41.0)
S.helper = Helper(filled=False)
check("unconfirmed fill -> fallback", S.get_execution_price("A1", 90.0) == 90.0)
S.helper = Helper(filled=True, order={"averageTradedPrice": 0})
check("zero fill price -> fallback", S.get_execution_price("A1", 90.0) == 90.0)
S.helper = Helper(filled=True, order=None)
check("missing order record -> fallback", S.get_execution_price("A1", 90.0) == 90.0)
S.helper = Helper()
check("no order id -> fallback, nothing waited", S.get_execution_price(None, 0.0) == 0.0 and S.helper.waited == [])

# ── fetch_ltps ──
S.helper = Helper(ltps={"101": 12.5, "102": 3.25, "13": 25010.0})
check("fetch_ltps returns (short, long, spot)", S.fetch_ltps() == (12.5, 3.25, 25010.0))
check("fetch_ltps asks for the 3 instruments in order",
      S.helper.asked == [("NSE_FNO", 101), ("NSE_FNO", 102), ("IDX_I", "13")])
S.helper = Helper(ltps={"101": 12.5})
check("fetch_ltps zero-fills missing prices", S.fetch_ltps() == (12.5, 0.0, 0.0))

for f in glob.glob(f"{ROOT}/debug/logs/st_oi_bearcall/*parity_test*.log"):
    os.remove(f)
print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
