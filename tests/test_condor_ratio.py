"""
Tests for strategies/condor_to_ratio/nifty_condor_ratio.py.

Run from project root:
    venv/bin/python tests/test_condor_ratio.py
"""

import glob
import importlib.util
import math
import os
import sys
import types
from datetime import date, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from lib.options_pricing import greeks_from_days  # noqa: E402

SPOT = 25000.0
EXPIRIES = ["2026-10-27", "2026-11-23", "2026-12-29"]


class FakeHelper:
    def __init__(self):
        self.prices = {"NIFTY": SPOT}
        self.orders = []
        self.net = {}
        self.subs = []
        self.last_api_error = None
        self.expiries = list(EXPIRIES)

    def start_websocket(self, *a, **k): pass
    def get_lot_size(self, s): return 65
    def get_expiries(self, s): return self.expiries
    def option(self, symbol, strike, opt_type):
        sid = int(strike) * 10 + (1 if opt_type == "CE" else 2)
        px = self.prices.get(str(sid), 100.0)
        return {
            "CONTRACT_INFO": {"SECURITY_ID": sid},
            "last_price": px,
            "LTP": px,
        }
    def get_ltp(self, sid, exchange=None, instrument=None):
        if str(sid) in ("NIFTY", "13"):
            return SPOT
        return self.prices.get(str(sid), 100.0)
    def subscribe_instruments(self, x): self.subs += x
    def unsubscribe_instruments(self, x): pass
    def is_market_open(self): return True
    def get_option_chain_df(self, symbol, expiry): return None
    def wait_for_fill(self, oid, timeout=5): return True
    def get_order_by_id(self, oid):
        idx = int(oid[1:])
        sid = self.orders[idx][1]
        return {"averageTradedPrice": self.prices.get(sid, 100.0)}
    def get_owned_net_qty(self, strike, expiry, opt_type):
        sid = str(int(strike) * 10 + (1 if opt_type == "CE" else 2))
        return self.net.get(sid, 0)


H = FakeHelper()
login = types.ModuleType("login")
login.get_dhan_client = lambda: object()
sys.modules["login"] = login

dh = types.ModuleType("lib.dhan_helper")
dh.DhanHelper = lambda dhan: H
sys.modules["lib.dhan_helper"] = dh

PATH = os.path.join(ROOT, "strategies", "condor_to_ratio", "nifty_condor_ratio.py")
import logging


class _NoFile(logging.NullHandler):
    def __init__(self, *a, **k):
        super().__init__()


_real_fh, logging.FileHandler = logging.FileHandler, _NoFile
spec = importlib.util.spec_from_file_location("nifty_condor_ratio", PATH)
cr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cr)
logging.FileHandler = _real_fh

cr.time.sleep = lambda s: None
cr.notify = lambda *a, **k: None

KEY = "condor_ratio_test"


def clean():
    for f in glob.glob(f"{ROOT}/debug/{KEY}*"):
        try:
            os.remove(f)
        except Exception:
            pass


ok = fail = 0


def check(name, cond):
    global ok, fail
    if cond:
        ok += 1
        print(f"  [OK] {name}")
    else:
        fail += 1
        print(f"  [FAIL] {name}")


def run_tests():
    global ok, fail
    print("=== Testing Pure Decision Functions ===")

    # 1. Black-Scholes Delta Checks
    ce_atm_d = greeks_from_days("CE", 25000, 25000, 30, 0.15, min_days=0.5).delta
    pe_atm_d = greeks_from_days("PE", 25000, 25000, 30, 0.15, min_days=0.5).delta
    check("ATM CE Delta approx 0.50", 0.45 <= ce_atm_d <= 0.58)
    check("ATM PE Delta approx -0.50", -0.55 <= pe_atm_d <= -0.42)

    ce_itm_d = greeks_from_days("CE", 25000, 24000, 30, 0.15, min_days=0.5).delta
    check("Deep ITM CE Delta near 1.0", ce_itm_d > 0.85)

    ce_otm_d = greeks_from_days("CE", 25000, 27000, 30, 0.15, min_days=0.5).delta
    check("Deep OTM CE Delta near 0.0", ce_otm_d < 0.10)

    # 2. Iron Condor Strikes Selection
    condor_strikes = cr.choose_iron_condor_strikes(None, 25000.0, 30, short_delta=0.30, hedge_delta=0.10)
    pe_h = condor_strikes["pe_hedge"]["strike"]
    pe_s = condor_strikes["pe_short"]["strike"]
    ce_s = condor_strikes["ce_short"]["strike"]
    ce_h = condor_strikes["ce_hedge"]["strike"]
    check(f"Condor monotonic order: {pe_h} < {pe_s} < {ce_s} < {ce_h}", pe_h < pe_s < ce_s < ce_h)
    check("Condor PE short is OTM (below spot)", pe_s < 25000)
    check("Condor CE short is OTM (above spot)", ce_s > 25000)

    # 3. Ratio Spread Strikes Selection
    # Bearish (Call side)
    call_ratio = cr.choose_ratio_strikes(None, 25000.0, 30, direction="BEARISH", long_delta=0.50, short_delta=0.40, hedge_delta=0.10)
    c_long = call_ratio["long_leg"]["strike"]
    c_short = call_ratio["short_leg"]["strike"]
    c_hedge = call_ratio["hedge_leg"]["strike"]
    check(f"Call Ratio monotonic order: {c_long} < {c_short} < {c_hedge}", c_long < c_short < c_hedge)
    check("Call Ratio uses CE opt_type", call_ratio["opt_type"] == "CE")

    # Bullish (Put side)
    put_ratio = cr.choose_ratio_strikes(None, 25000.0, 30, direction="BULLISH", long_delta=0.50, short_delta=0.40, hedge_delta=0.10)
    p_long = put_ratio["long_leg"]["strike"]
    p_short = put_ratio["short_leg"]["strike"]
    p_hedge = put_ratio["hedge_leg"]["strike"]
    check(f"Put Ratio monotonic order: {p_long} > {p_short} > {p_hedge}", p_long > p_short > p_hedge)
    check("Put Ratio uses PE opt_type", put_ratio["opt_type"] == "PE")

    # Shifted Ratio Spread Strikes Selection
    shifted_ratio = cr.choose_ratio_shift_strikes(None, 25000.0, 30, direction="BEARISH")
    check("Shifted Ratio long < short < hedge", shifted_ratio["long_leg"]["strike"] < shifted_ratio["short_leg"]["strike"] < shifted_ratio["hedge_leg"]["strike"])

    # 4. Trigger Checks
    check("Condor Trigger: CE decayed to 0.08 -> BEARISH", cr.check_condor_trigger(0.08, 0.45, trigger_delta=0.10) == "BEARISH")
    check("Condor Trigger: PE decayed to -0.09 -> BULLISH", cr.check_condor_trigger(0.48, -0.09, trigger_delta=0.10) == "BULLISH")
    check("Condor Trigger: Neither decayed (0.28, -0.31) -> None", cr.check_condor_trigger(0.28, -0.31, trigger_delta=0.10) is None)

    check("Ratio Shift Trigger: Short delta decayed to 0.09 (<= 0.10) -> True", cr.check_ratio_shift_trigger(0.09, 0.10) is True)
    check("Ratio Shift Trigger: Short delta at 0.25 (> 0.10) -> False", cr.check_ratio_shift_trigger(0.25, 0.10) is False)

    check("Ratio Reversal Trigger: Short delta expanded to 0.65 (>= 0.60) -> True", cr.check_ratio_reversal_trigger(0.65, 0.60) is True)
    check("Ratio Reversal Trigger: Short delta at 0.42 (< 0.60) -> False", cr.check_ratio_reversal_trigger(0.42, 0.60) is False)

    # 5. Trailing Stop
    active, best, exit_now = cr.update_trail(4000.0, 0.0, False, 5000.0, 2500.0)
    check("Trail inactive before start_rs", active is False and exit_now is False)

    active, best, exit_now = cr.update_trail(6000.0, 0.0, False, 5000.0, 2500.0)
    check("Trail activates at 6000", active is True and best == 6000.0 and exit_now is False)

    active, best, exit_now = cr.update_trail(3000.0, 6000.0, True, 5000.0, 2500.0)
    check("Trail exits on giveback (3000 < 6000 - 2500)", exit_now is True)

    # 6. Monthly Expiry Selection
    exp_list = ["2026-10-06", "2026-10-13", "2026-10-20", "2026-10-27", "2026-11-03", "2026-11-23"]
    m_exps = cr.monthly_expiries(exp_list)
    check("Monthly expiries groups last per month", m_exps == ["2026-10-27", "2026-11-23"])

    chosen_e = cr.pick_cycle_expiry(exp_list, date(2026, 10, 1), 15, 45, expiry_type="monthly")
    check("Pick cycle monthly expiry in DTE range", chosen_e == "2026-10-27")

    print("\n=== Testing CLI Validation ===")
    parser = cr.build_parser()

    # --live without unvalidated flag must fail validation
    args_live = parser.parse_args(["--live"])
    errs = cr.validate_args(args_live)
    check("--live rejected without --i-understand-this-is-unvalidated", any("unvalidated" in e for e in errs))

    args_live_ok = parser.parse_args(["--live", "--i-understand-this-is-unvalidated"])
    check("--live accepted with --i-understand-this-is-unvalidated", len(cr.validate_args(args_live_ok)) == 0)

    # Invalid delta
    args_bad_delta = parser.parse_args(["--condor-hedge-delta", "0.40", "--condor-short-delta", "0.20"])
    check("Hedge delta >= short delta rejected", any("strictly less than" in e for e in cr.validate_args(args_bad_delta)))

    print("\n=== Testing Strategy Lifecycle & Stub-Broker ===")
    clean()

    strat = cr.NiftyCondorToRatioStrategy(
        dry_run=True,
        lots=1,
        target=(10000.0, False),
        stop=(10000.0, False),
        condor_short_delta=0.30,
        condor_hedge_delta=0.10,
        condor_exit_delta=0.10,
        state_key=KEY,
        broker="dhan",
    )
    strat.expiry = "2026-10-27"

    # Step 1: Enter Iron Condor
    entered = strat.enter_iron_condor(25000.0, None, 25)
    check("Iron Condor entered successfully", entered is True and strat.position_open is True)
    check("Stage is CONDOR", strat.stage == cr.STAGE_CONDOR)
    check("Has 4 active legs", len(strat.legs) == 4)

    # Verify atomic position file written
    check("Position file exists", os.path.exists(strat.position_path))

    # Step 2: Transition from Condor to Call Ratio Spread
    exited = strat.exit_all("Test transition trigger")
    check("Condor exited cleanly", exited is True and strat.position_open is False)

    entered_ratio = strat.enter_ratio_spread(24800.0, None, 25, direction="BEARISH", is_shift=False)
    check("Call Ratio Spread entered", entered_ratio is True and strat.stage == cr.STAGE_RATIO)
    check("Direction is BEARISH", strat.direction == "BEARISH")
    check("Ratio Spread has 3 legs", len(strat.legs) == 3)
    check("Ratio short has 2x qty", strat.legs["ratio_short"]["qty"] == 2 * strat.lots * strat.lot_size)

    # Step 3: Shift Ratio Spread
    strat.exit_all("Test shift")
    shifted = strat.enter_ratio_spread(24500.0, None, 20, direction="BEARISH", is_shift=True)
    check("Shifted Ratio Spread entered", shifted is True and strat.stage == cr.STAGE_RATIO)

    # Step 4: Reversal Flip
    strat.exit_all("Test reversal")
    reversed_ratio = strat.enter_ratio_spread(25500.0, None, 20, direction="BULLISH", is_shift=False)
    check("Reversed Put Ratio Spread entered", reversed_ratio is True and strat.direction == "BULLISH")
    check("Put Ratio uses PE opt_type", strat.legs["ratio_short"]["opt_type"] == "PE")

    # Step 5: Test Persistence & Reload
    strat.save_position()
    strat2 = cr.NiftyCondorToRatioStrategy(dry_run=True, state_key=KEY, broker="dhan")
    check("Restored open position from disk", strat2.position_open is True)
    check("Restored direction BULLISH", strat2.direction == "BULLISH")
    check("Restored legs count 3", len(strat2.legs) == 3)

    # Clean exit
    strat2.exit_all("Test cleanup")
    check("Final position is flat", strat2.position_open is False)
    clean()

    print(f"\n==========================================")
    print(f"Results: {ok} passed, {fail} failed.")
    print(f"==========================================")
    if fail > 0:
        sys.exit(1)


if __name__ == "__main__":
    run_tests()
