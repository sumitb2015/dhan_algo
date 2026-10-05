"""
Unit tests for Nifty Delta-Controlled, Low-Gamma Diagonal Covered-Call Strategy.
Tests pure calculation functions: Black-Scholes Greeks, short call scoring,
portfolio Greek aggregation, dynamic position sizing, and roll trigger rules.
"""

import math
import os
import sys
import unittest

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from strategies.diagonal_call.nifty_diagonal_call import (
    score_short_call,
    calculate_portfolio_greeks,
    calculate_required_short_lots,
    check_short_roll_triggers,
    check_long_roll_triggers,
)


from lib.options_pricing import greeks_from_days  # noqa: E402


class TestDiagonalCallCalculations(unittest.TestCase):
    def test_compute_bs_greeks(self):
        spot = 22400.0
        # ITM call (e.g. 22000 CE, 90 DTE)
        g_long = greeks_from_days("CE", spot, 22000.0, 90, 0.14)
        self.assertGreater(g_long.delta, 0.55)
        self.assertLess(g_long.delta, 0.85)
        self.assertGreater(g_long.gamma, 0.0)
        self.assertLess(g_long.theta, 0.0)  # negative price decay for long
        self.assertGreater(g_long.vega, 0.0)

        # OTM call (e.g. 23000 CE, 30 DTE)
        g_short = greeks_from_days("CE", spot, 23000.0, 30, 0.13)
        self.assertGreater(g_short.delta, 0.10)
        self.assertLess(g_short.delta, 0.30)
        self.assertGreater(g_short.gamma, 0.0)
        self.assertLess(g_short.theta, 0.0)

    def test_score_short_call(self):
        # theta_day is negative, score = (-theta_day) / gamma
        score = score_short_call(theta_day=-5.50, gamma=0.00045)
        self.assertAlmostEqual(score, 5.50 / 0.00045, places=2)

        # Non-positive decay or zero gamma yields 0
        self.assertEqual(score_short_call(theta_day=1.0, gamma=0.00045), 0.0)
        self.assertEqual(score_short_call(theta_day=-5.0, gamma=0.0), 0.0)

    def test_calculate_required_short_lots(self):
        # Example from user prompt:
        # 3 long calls x 0.60 delta = 1.80 lots
        # Lot size = 65 -> Long delta shares = 3 x 65 x 0.60 = 117 shares
        # Target portfolio delta = +0.15 lots = 0.15 x 65 = +9.75 shares
        # Required short delta shares = 117 - 9.75 = 107.25 shares
        # Short call delta = 0.20
        # Required short lots = 107.25 / (0.20 x 65) = 107.25 / 13 = 8.25 -> 8 lots!
        long_delta_shares = 3 * 65 * 0.60
        target_net_delta_shares = 0.15 * 65
        lots = calculate_required_short_lots(
            long_delta_shares=long_delta_shares,
            target_net_delta_shares=target_net_delta_shares,
            short_call_delta=0.20,
            lot_size=65,
            max_short_ratio=1.25,
            max_short_lots=10,
        )
        self.assertEqual(lots, 8)

        # Clamped by default max_short_lots=6
        lots_capped = calculate_required_short_lots(
            long_delta_shares=long_delta_shares,
            target_net_delta_shares=target_net_delta_shares,
            short_call_delta=0.20,
            lot_size=65,
            max_short_ratio=1.25,
            max_short_lots=6,
        )
        self.assertEqual(lots_capped, 6)

    def test_calculate_required_short_lots_clamped(self):
        # Max exposure rule: short delta cannot exceed 1.25 x long delta
        long_delta_shares = 100.0
        # Requesting a negative target net delta that would imply massive shorts
        lots = calculate_required_short_lots(
            long_delta_shares=long_delta_shares,
            target_net_delta_shares=-200.0,
            short_call_delta=0.10,
            lot_size=65,
            max_short_ratio=1.25,
            max_short_lots=25,
        )
        max_allowed_delta = 100.0 * 1.25  # 125
        max_allowed_lots = int(125 / (0.10 * 65))  # 19 lots
        self.assertEqual(lots, max_allowed_lots)

        # Hard ceiling clamps down even if delta formula allows 19 lots
        lots_clamped_ceiling = calculate_required_short_lots(
            long_delta_shares=long_delta_shares,
            target_net_delta_shares=-200.0,
            short_call_delta=0.10,
            lot_size=65,
            max_short_ratio=1.25,
            max_short_lots=6,
        )
        self.assertEqual(lots_clamped_ceiling, 6)

    def test_calculate_portfolio_greeks(self):
        long_leg = {"lots": 3, "strike": 22000, "dte": 90, "iv": 0.14}
        short_leg = {"lots": 8, "strike": 23000, "dte": 30, "iv": 0.13}
        spot = 22400.0
        lot_size = 65

        greeks = calculate_portfolio_greeks(long_leg, short_leg, spot, lot_size)
        self.assertIn("net_delta_shares", greeks)
        self.assertIn("portfolio_gamma", greeks)
        self.assertIn("portfolio_theta_day", greeks)
        self.assertIn("delta_zone", greeks)
        self.assertIn("gamma_status", greeks)

        # Portfolio should collect net daily theta from 8 short options
        self.assertGreater(greeks["portfolio_theta_day"], 0.0)

    def test_check_short_roll_triggers(self):
        short_leg = {"lots": 8, "strike": 23000, "dte": 30, "entry_price": 100.0}

        # 1. Normal hold
        roll, reason = check_short_roll_triggers(
            short_leg, current_short_ltp=80.0, current_short_delta=0.20,
            net_delta_shares=10.0, portfolio_gamma=-0.12, short_roll_dte=14, short_roll_delta=0.35,
        )
        self.assertFalse(roll)

        # 2. Profit-taking: captured 65% decay (LTP dropped to 30)
        roll, reason = check_short_roll_triggers(
            short_leg, current_short_ltp=30.0, current_short_delta=0.08,
            net_delta_shares=10.0, portfolio_gamma=-0.05, short_profit_pct=65.0,
        )
        self.assertTrue(roll)
        self.assertIn("PROFIT_TARGET_CAPTURED", reason)

        # 3. DTE threshold: DTE dropped to 12 days
        short_leg_near = {"lots": 8, "strike": 23000, "dte": 12, "entry_price": 100.0}
        roll, reason = check_short_roll_triggers(
            short_leg_near, current_short_ltp=50.0, current_short_delta=0.20,
            net_delta_shares=10.0, portfolio_gamma=-0.10, short_roll_dte=14,
        )
        self.assertTrue(roll)
        self.assertIn("DTE_THRESHOLD", reason)

        # 4. Short delta expansion: short delta surged to 0.38 (rally)
        roll, reason = check_short_roll_triggers(
            short_leg, current_short_ltp=150.0, current_short_delta=0.38,
            net_delta_shares=5.0, portfolio_gamma=-0.14, short_roll_delta=0.35,
        )
        self.assertTrue(roll)
        self.assertIn("SHORT_DELTA_EXPANSION", reason)

        # 5. Portfolio defensive delta: net delta drops below -40
        roll, reason = check_short_roll_triggers(
            short_leg, current_short_ltp=110.0, current_short_delta=0.30,
            net_delta_shares=-45.0, portfolio_gamma=-0.14,
        )
        self.assertTrue(roll)
        self.assertIn("PORTFOLIO_DELTA_DEFENSIVE", reason)

        # 6. Gamma breach: portfolio gamma < -0.20
        roll, reason = check_short_roll_triggers(
            short_leg, current_short_ltp=110.0, current_short_delta=0.30,
            net_delta_shares=-10.0, portfolio_gamma=-0.22, min_gamma_limit=-0.20,
        )
        self.assertTrue(roll)
        self.assertIn("GAMMA_LIMIT_BREACH", reason)

    def test_check_long_roll_triggers(self):
        long_leg = {"lots": 3, "strike": 22000, "dte": 30}
        roll, reason = check_long_roll_triggers(long_leg, long_roll_dte=35)
        self.assertTrue(roll)
        self.assertIn("LONG_DTE_THRESHOLD", reason)

        long_leg_fresh = {"lots": 3, "strike": 22000, "dte": 85}
        roll, reason = check_long_roll_triggers(long_leg_fresh, long_roll_dte=35)
        self.assertFalse(roll)

    def test_dynamic_iv_clamping(self):
        # Test extreme VIX values are clamped between 0.08 and 0.40
        from unittest.mock import MagicMock
        from strategies.diagonal_call.nifty_diagonal_call import NiftyDiagonalCallStrategy

        mock_helper = MagicMock()
        mock_helper.get_lot_size.return_value = 65
        strat = NiftyDiagonalCallStrategy(helper=mock_helper, live=False)
        # Mock VIX LTP = 13.5 -> 0.135
        strat.helper.get_ltp.return_value = 13.5
        self.assertEqual(strat._get_current_iv(), 0.135)

        # Mock VIX LTP = 5.0 -> clamped to 0.08
        strat.helper.get_ltp.return_value = 5.0
        self.assertEqual(strat._get_current_iv(), 0.08)

        # Mock VIX LTP = 55.0 -> clamped to 0.40
        strat.helper.get_ltp.return_value = 55.0
        self.assertEqual(strat._get_current_iv(), 0.40)

        # Mock VIX failure -> fallback to 0.14
        strat.helper.get_ltp.side_effect = Exception("API error")
        self.assertEqual(strat._get_current_iv(), 0.14)

    def test_multi_broker_wait_for_fill(self):
        from unittest.mock import MagicMock
        from strategies.diagonal_call.nifty_diagonal_call import NiftyDiagonalCallStrategy

        mock_helper = MagicMock()
        mock_helper.get_lot_size.return_value = 65

        # Dhan broker: calls helper.wait_for_fill
        strat_dhan = NiftyDiagonalCallStrategy(helper=mock_helper, broker="dhan", live=True)
        strat_dhan.helper.wait_for_fill.return_value = True
        filled = strat_dhan._wait_for_fill("12345", 24000, "2026-10-27", "CE", +65, 0)
        self.assertTrue(filled)
        strat_dhan.helper.wait_for_fill.assert_called_once_with("12345", timeout=15)

        # Zerodha broker: checks broker.get_owned_net_qty against net_before + signed_qty
        strat_zero = NiftyDiagonalCallStrategy(helper=mock_helper, broker="zerodha", live=True)
        strat_zero.broker = MagicMock()
        strat_zero.broker.get_owned_net_qty.return_value = 130  # expected = 65 + 65
        filled = strat_zero._wait_for_fill("2410040001", 24000, "2026-10-27", "CE", +65, 65, timeout=2)
        self.assertTrue(filled)

    def test_long_cost_recovery_and_free_long_call(self):
        from unittest.mock import MagicMock
        from strategies.diagonal_call.nifty_diagonal_call import NiftyDiagonalCallStrategy

        mock_helper = MagicMock()
        mock_helper.get_lot_size.return_value = 65
        strat = NiftyDiagonalCallStrategy(helper=mock_helper, live=False)

        # Example from user prompt:
        # Long: 3 x 65 = 195 units @ Rs 804.16 -> Initial Debit = Rs 1,56,811.20
        strat.long_leg = {"strike": 23000, "lots": 3, "entry_price": 804.16}
        strat.initial_long_debit = 804.16 * 195  # 156,811.20

        # Stage 1: Collected Rs 42,000 from short calls
        strat.cumulative_short_premium = 42000.0
        lcr_pct, total_short, is_free = strat.compute_lcr()
        # 42000 / 156811.20 = 26.78% -> 26.8%
        self.assertAlmostEqual(lcr_pct, 26.8, places=1)
        self.assertFalse(is_free)

        # Stage 2: Short calls accumulate Rs 1,60,000 -> LCR > 100% -> Free Long Call!
        strat.cumulative_short_premium = 160000.0
        lcr_pct, total_short, is_free = strat.compute_lcr()
        self.assertGreaterEqual(lcr_pct, 100.0)
        self.assertTrue(is_free)
        self.assertTrue(strat.is_free_long_call)

    def test_phantom_leg_detection_sides(self):
        from lib.strategy_risk import detect_phantom_leg_broker
        from unittest.mock import MagicMock

        mock_broker = MagicMock()

        # Case 1: Long leg is active at broker (net_qty = +195). Side to close is SELL.
        mock_broker.get_owned_net_qty.return_value = 195
        is_phantom = detect_phantom_leg_broker(mock_broker, 24000, "2026-10-27", "CE", 195, side="SELL")
        self.assertFalse(is_phantom)

        # Case 2: Long leg vanished at broker (net_qty = 0). Side to close is SELL.
        mock_broker.get_owned_net_qty.return_value = 0
        is_phantom = detect_phantom_leg_broker(mock_broker, 24000, "2026-10-27", "CE", 195, side="SELL")
        self.assertTrue(is_phantom)

        # Case 3: Short leg is active at broker (net_qty = -195). Side to close is BUY.
        mock_broker.get_owned_net_qty.return_value = -195
        is_phantom = detect_phantom_leg_broker(mock_broker, 24500, "2026-10-27", "CE", 195, side="BUY")
        self.assertFalse(is_phantom)

        # Case 4: Short leg vanished at broker (net_qty = 0). Side to close is BUY.
        mock_broker.get_owned_net_qty.return_value = 0
        is_phantom = detect_phantom_leg_broker(mock_broker, 24500, "2026-10-27", "CE", 195, side="BUY")
        self.assertTrue(is_phantom)





# ── Failure-path tests (order confirmation, exit ordering, entry retry) ─────────

import tempfile
from datetime import date, datetime, timedelta
from unittest import mock

import pandas as pd

import strategies.diagonal_call.nifty_diagonal_call as dc


class FakeBroker:
    """Dhan-style execution broker whose fills are controlled by `fill`."""

    def __init__(self):
        self.net = {}
        self.calls = []        # (side, strike, qty) in placement order
        self.fill = True
        self.fills_by_oid = {}
        self._oid = 0
        self.pending = {}      # oid -> (key, signed) for a late fill applied on cancel

    def _place(self, side, strike, expiry, opt_type, qty, product):
        self._oid += 1
        oid = str(self._oid)
        self.calls.append((side, strike, qty))
        signed = qty if side == "BUY" else -qty
        key = (strike, expiry)
        self.fills_by_oid[oid] = self.fill
        if self.fill:
            self.net[key] = self.net.get(key, 0) + signed
        else:
            self.pending[oid] = (key, signed)
        return oid

    def buy(self, strike, expiry, opt_type, qty, product="INTRADAY"):
        return self._place("BUY", strike, expiry, opt_type, qty, product)

    def sell(self, strike, expiry, opt_type, qty, product="INTRADAY"):
        return self._place("SELL", strike, expiry, opt_type, qty, product)

    def get_owned_net_qty(self, strike, expiry, opt_type):
        return self.net.get((strike, expiry), 0)


class FakeHelper:
    def __init__(self, broker, late_fill_on_cancel=False):
        self.broker = broker
        self.cancelled = []
        self.late_fill_on_cancel = late_fill_on_cancel
        self.ltp = 100.0
        self.vix = 14.0
        self._master_list = pd.DataFrame()
        self.quote_overrides = {}   # {(expiry, strike): (bid, ask)}; everything else quotes a tight 1% spread

    def get_option_chain_df(self, _symbol, expiry, exchange_segment=None):
        ml = self._master_list
        if ml is None or ml.empty:
            return pd.DataFrame()
        rows = ml[(ml["SM_EXPIRY_DATE"] == expiry) & (ml["OPTION_TYPE"] == "CE")]
        out = []
        for _, r in rows.iterrows():
            bid, ask = self.quote_overrides.get((expiry, int(r["STRIKE_PRICE"])), (99.5, 100.5))
            out.append({"Strike": float(r["STRIKE_PRICE"]), "ce_top_bid_price": bid, "ce_top_ask_price": ask})
        return pd.DataFrame(out)

    def get_lot_size(self, _):
        return 65

    def start_websocket(self, *_a, **_k):
        pass

    def subscribe_instruments(self, *_a, **_k):
        pass

    def wait_for_fill(self, oid, timeout=15):
        return self.broker.fills_by_oid.get(str(oid), False)

    def cancel_order(self, oid):
        self.cancelled.append(str(oid))
        if self.late_fill_on_cancel and str(oid) in self.broker.pending:
            key, signed = self.broker.pending.pop(str(oid))
            self.broker.net[key] = self.broker.net.get(key, 0) + signed
        return True

    def get_order_update(self, _):
        return None

    def get_order_by_id(self, _):
        return None

    def get_ltp(self, sec_id, *_a, **_k):
        return self.vix if str(sec_id) == "21" else self.ltp

    def get_expiries(self, _):
        return [(date.today() + timedelta(days=90)).strftime("%Y-%m-%d")]


LONG = {"security_id": "1", "strike": 24000, "expiry": "2099-01-01", "dte": 90, "delta": 0.6,
        "opt_type": "CE", "side": "BUY", "lots": 3, "entry_price": 900.0, "iv": 0.14}
SHORT = {"security_id": "2", "strike": 25500, "expiry": "2098-12-01", "dte": 30, "delta": 0.18,
         "opt_type": "CE", "side": "SELL", "lots": 4, "entry_price": 60.0, "iv": 0.14}


class _DiagBase(unittest.TestCase):
    """Shared fixtures (no tests of its own, so subclasses are not re-run by inheritance)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        patches = [
            mock.patch.object(dc, "debug_dir", self.tmp.name),
            mock.patch.object(dc, "save_strategy_state", lambda *a, **k: None),
            mock.patch.object(dc, "notify", lambda *a, **k: None),
            mock.patch.object(dc.time, "sleep", lambda *_: None),
            mock.patch.object(dc.ExecutionBroker, "create", lambda *a, **k: self.broker),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.tmp.cleanup)
        self.broker = FakeBroker()

    def make(self, late_fill_on_cancel=False):
        helper = FakeHelper(self.broker, late_fill_on_cancel)
        s = dc.NiftyDiagonalCallStrategy(live=True, helper=helper, instance_id="unittest")
        s.broker = self.broker
        return s

    def open_position(self, s):
        s.long_leg = dict(LONG)
        s.short_leg = dict(SHORT)
        s.position_open = True
        self.broker.net[(24000, "2099-01-01")] = 3 * 65
        self.broker.net[(25500, "2098-12-01")] = -4 * 65

class TestDiagonalFailurePaths(_DiagBase):
    def test_exit_all_never_sells_long_while_short_open(self):
        s = self.make()
        self.open_position(s)
        self.broker.fill = False                       # short buyback will not fill
        self.assertFalse(s.exit_all("TEST"))
        sides = [c[0] for c in self.broker.calls]
        self.assertEqual(sides, ["BUY"])                # only the short buyback was attempted
        self.assertIsNotNone(s.short_leg)
        self.assertIsNotNone(s.long_leg)
        self.assertTrue(s.position_open)
        self.assertEqual(s.pending_exit_reason, "TEST")
        self.assertEqual(s.status, "EXIT_PENDING")

        self.broker.fill = True                         # retry succeeds: short first, then long
        self.assertTrue(s.exit_all("TEST"))
        self.assertEqual([c[0] for c in self.broker.calls][-2:], ["BUY", "SELL"])
        self.assertFalse(s.position_open)
        self.assertIsNone(s.pending_exit_reason)

    def test_exit_pending_survives_restart(self):
        s = self.make()
        self.open_position(s)
        self.broker.fill = False
        s.exit_all("TEST")
        s2 = self.make()
        self.assertEqual(s2.pending_exit_reason, "RESTART_RESUME_EXIT")
        self.assertIsNotNone(s2.short_leg)

    def test_long_roll_buys_new_before_selling_old(self):
        s = self.make()
        self.open_position(s)
        new_long = dict(LONG, strike=24500, expiry="2099-03-01", security_id="9")
        s.select_long_call = lambda spot: dict(new_long)
        s.roll_long_leg(24500.0, "TEST")
        self.assertEqual([c[0] for c in self.broker.calls], ["BUY", "SELL"])
        self.assertEqual(self.broker.calls[0][1], 24500)
        self.assertEqual(s.long_leg["strike"], 24500)
        self.assertIsNotNone(s.short_leg)

    def test_long_roll_failed_buy_keeps_old_long(self):
        s = self.make()
        self.open_position(s)
        s.select_long_call = lambda spot: dict(LONG, strike=24500, expiry="2099-03-01")
        self.broker.fill = False
        s.roll_long_leg(24500.0, "TEST")
        self.assertEqual([c[0] for c in self.broker.calls], ["BUY"])   # old long never sold
        self.assertEqual(s.long_leg["strike"], 24000)
        self.assertGreater(s.roll_cooldown_until, 0)

    def test_entry_timeout_cancels_and_does_not_hold_long(self):
        s = self.make()
        s.select_long_call = lambda spot: dict(LONG)
        s.select_short_call = lambda spot, ld, long_leg=None: dict(SHORT)
        self.broker.fill = False
        self.assertFalse(s.enter_cycle(24500.0))
        self.assertEqual(self.broker.calls, [("BUY", 24000, 195)])
        self.assertEqual(s.helper.cancelled, ["1"])
        self.assertIsNone(s.long_leg)
        self.assertFalse(s.position_open)

    def test_entry_late_fill_after_cancel_is_adopted_not_rebought(self):
        s = self.make(late_fill_on_cancel=True)
        s.select_long_call = lambda spot: dict(LONG)
        s.select_short_call = lambda spot, ld, long_leg=None: dict(SHORT)
        self.broker.fill = False
        # long order fills only when cancelled-race resolves; short then also times out
        s.enter_cycle(24500.0)
        buys = [c for c in self.broker.calls if c[0] == "BUY" and c[1] == 24000]
        self.assertEqual(len(buys), 1)                  # long bought exactly once

    def test_no_synthetic_prices_when_quote_missing(self):
        s = self.make()
        exp = (date.today() + timedelta(days=90)).strftime("%Y-%m-%d")
        s.helper._master_list = pd.DataFrame([{
            "UNDERLYING_SYMBOL": "NIFTY", "SM_EXPIRY_DATE": exp, "OPTION_TYPE": "CE",
            "STRIKE_PRICE": 24000.0, "SECURITY_ID": 77,
        }])
        s.helper.ltp = 0.0
        self.assertIsNone(s.select_long_call(24500.0))

    def test_halve_does_not_change_state_when_buyback_fails(self):
        s = self.make()
        self.open_position(s)
        self.broker.fill = False
        s.halve_short_position(24500.0, "TEST")
        self.assertEqual(s.short_leg["lots"], 4)
        self.assertFalse(s.drawdown_halved)
        self.broker.fill = True
        s.roll_cooldown_until = 0.0
        s.halve_short_position(24500.0, "TEST")
        self.assertEqual(s.short_leg["lots"], 2)
        self.assertTrue(s.drawdown_halved)

    def test_publish_state_keeps_last_spot_for_greeks(self):
        s = self.make()
        self.open_position(s)
        s._publish_state(24500.0)
        s._publish_state(0.0)
        self.assertEqual(s.last_spot, 24500.0)



class _FixedDate(date):
    @classmethod
    def today(cls):
        return cls(2026, 10, 5)


MONTHLIES = ["2026-10-27", "2026-11-24", "2026-12-29", "2027-01-26"]
WEEKLIES = ["2026-10-13", "2026-11-03", "2026-11-10"]


class _SelBase(_DiagBase):
    def setUp(self):
        super().setUp()
        p = mock.patch.object(dc, "date", _FixedDate)
        p.start()
        self.addCleanup(p.stop)

    def make_with_chain(self):
        s = self.make()
        rows = [
            {"UNDERLYING_SYMBOL": "NIFTY", "SM_EXPIRY_DATE": e, "OPTION_TYPE": "CE",
             "STRIKE_PRICE": float(k), "SECURITY_ID": int(f"{i}{k}")}
            for i, e in enumerate(MONTHLIES + WEEKLIES) for k in range(23000, 28001, 50)
        ]
        s.helper._master_list = pd.DataFrame(rows)
        s.helper.get_expiries = lambda _u: sorted(MONTHLIES + WEEKLIES)
        return s

    def long_leg(self, expiry="2026-12-29"):
        return dict(LONG, expiry=expiry, dte=85, strike=24000)

class TestDiagonalSelectionAndAdjustments(_SelBase):
    def test_is_monthly_expiry(self):
        for e in MONTHLIES:
            self.assertTrue(dc.is_monthly_expiry(e), e)
        for e in WEEKLIES:
            self.assertFalse(dc.is_monthly_expiry(e), e)

    def test_long_call_uses_monthly_only(self):
        s = self.make_with_chain()
        leg = s.select_long_call(24500.0)
        self.assertEqual(leg["expiry"], "2026-12-29")

    def test_short_call_weekly_or_monthly_before_long_near_target_delta(self):
        s = self.make_with_chain()
        sh = s.select_short_call(24500.0, 117.0, long_leg=self.long_leg())
        self.assertIn(sh["expiry"], MONTHLIES + WEEKLIES)
        self.assertGreaterEqual(sh["dte"], s.short_min_dte)  # inside 25-45 DTE
        self.assertLessEqual(sh["dte"], s.short_max_dte)
        self.assertLess(sh["expiry"], "2026-12-29")          # expires before the long
        self.assertLess(abs(sh["delta"] - 0.18), 0.035)     # not drifted to the 0.22 edge
        self.assertGreaterEqual(sh["delta"], 0.15 - 0.005)

    def test_spread_helpers_fail_closed(self):
        s = self.make_with_chain()
        self.assertTrue(s._is_liquid((99.5, 100.5)))          # 1.0%
        self.assertFalse(s._is_liquid((90.0, 110.0)))         # 20%
        self.assertFalse(s._is_liquid((0.0, 100.0)))          # no bid
        self.assertFalse(s._is_liquid((100.0, 0.0)))          # no ask
        self.assertFalse(s._is_liquid((101.0, 100.0)))        # crossed
        self.assertFalse(s._is_liquid(None))                  # strike absent from the chain

    def test_short_call_skips_wide_spread_strike(self):
        s = self.make_with_chain()
        first = s.select_short_call(24500.0, 117.0, long_leg=self.long_leg())
        s.helper.quote_overrides[(first["expiry"], first["strike"])] = (60.0, 140.0)
        second = s.select_short_call(24500.0, 117.0, long_leg=self.long_leg())
        self.assertIsNotNone(second)
        self.assertNotEqual((second["expiry"], second["strike"]), (first["expiry"], first["strike"]))

    def test_short_call_none_when_no_strike_is_liquid(self):
        s = self.make_with_chain()
        s._ce_quotes = lambda expiry: {}                      # chain with no quotes at all
        self.assertIsNone(s.select_short_call(24500.0, 117.0, long_leg=self.long_leg()))

    def test_long_call_skips_wide_spread_strike(self):
        s = self.make_with_chain()
        first = s.select_long_call(24500.0)
        s.helper.quote_overrides[(first["expiry"], first["strike"])] = (10.0, 190.0)
        second = s.select_long_call(24500.0)
        self.assertIsNotNone(second)
        self.assertNotEqual(second["strike"], first["strike"])

    def test_short_call_never_outlives_long(self):
        s = self.make_with_chain()
        self.assertIsNone(s.select_short_call(24500.0, 117.0, long_leg=self.long_leg("2026-10-27")))

    def test_short_call_refuses_low_iv(self):
        s = self.make_with_chain()
        s.helper.vix = 8.0
        self.assertIsNone(s.select_short_call(24500.0, 117.0, long_leg=self.long_leg()))

    def test_short_call_not_sold_out_of_band(self):
        s = self.make_with_chain()
        s.helper._master_list = s.helper._master_list[s.helper._master_list["STRIKE_PRICE"] < 24600]
        self.assertIsNone(s.select_short_call(24500.0, 117.0, long_leg=self.long_leg()))

    def test_short_roll_keeps_old_short_when_no_replacement(self):
        s = self.make()
        self.open_position(s)
        s.select_short_call = lambda *a, **k: None
        s.roll_short_leg(24500.0, "TEST")
        self.assertEqual(self.broker.calls, [])
        self.assertEqual(s.short_leg["strike"], 25500)

    def test_short_roll_selects_before_closing(self):
        s = self.make()
        self.open_position(s)
        order = []
        new = dict(SHORT, strike=25800, expiry="2098-12-29", security_id="5")
        s.select_short_call = lambda *a, **k: (order.append("select"), dict(new))[1]
        orig_buy = self.broker.buy
        self.broker.buy = lambda **k: (order.append("buy"), orig_buy(**k))[1]
        s.roll_short_leg(24500.0, "DTE_THRESHOLD test")
        self.assertEqual(order[0], "select")
        self.assertEqual([c[0] for c in self.broker.calls], ["BUY", "SELL"])
        self.assertEqual(s.short_leg["strike"], 25800)

    def test_adjust_roll_sets_cooldown(self):
        s = self.make()
        self.open_position(s)
        s.select_short_call = lambda *a, **k: dict(SHORT, strike=25800, expiry="2098-12-29")
        s.roll_short_leg(24500.0, "GAMMA_LIMIT_BREACH (x)")
        self.assertGreater(s.adjust_cooldown_until, 0)

    def test_add_short_lots_noop_at_cap(self):
        s = self.make()
        self.open_position(s)
        s.short_leg["lots"] = s.max_short_lots
        self.assertFalse(s.add_short_lots(24500.0))
        self.assertEqual(self.broker.calls, [])

    def test_add_short_lots_adds_and_averages_entry(self):
        s = self.make()
        self.open_position(s)
        s.short_leg["lots"] = 2
        self.broker.net[(25500, "2098-12-01")] = -2 * 65
        s.short_leg["current_ltp"] = 40.0
        self.assertTrue(s.add_short_lots(24500.0))
        self.assertGreater(s.short_leg["lots"], 2)
        self.assertEqual(self.broker.calls[0][0], "SELL")
        self.assertLess(s.short_leg["entry_price"], 60.0)   # averaged with the cheaper fill

    def test_restore_short_leg_when_long_only(self):
        s = self.make()
        self.open_position(s)
        s.short_leg = None
        self.broker.net[(25500, "2098-12-01")] = 0
        s.select_short_call = lambda *a, **k: dict(SHORT)
        s.restore_short_leg(24500.0)
        self.assertEqual(s.short_leg["strike"], 25500)
        self.assertEqual(self.broker.calls[0][0], "SELL")

    def test_lcr_free_regime_has_hysteresis(self):
        s = self.make()
        s.initial_long_debit = 100000.0
        s.long_leg = dict(LONG)
        s.cumulative_short_premium = 105000.0
        self.assertTrue(s.compute_lcr()[2])
        s.cumulative_short_premium = 95000.0
        self.assertTrue(s.compute_lcr()[2])                 # 95% stays free
        s.cumulative_short_premium = 85000.0
        self.assertFalse(s.compute_lcr()[2])

    def test_long_roll_realized_loss_raises_lcr_denominator(self):
        s = self.make()
        self.open_position(s)
        s.initial_long_debit = 175500.0
        s.long_leg["current_ltp"] = 800.0                   # old long sold at a loss vs 900 entry
        s.select_long_call = lambda spot: dict(LONG, strike=24500, expiry="2099-03-01", entry_price=850.0)
        s.roll_long_leg(24500.0, "TEST")
        self.assertGreater(s.initial_long_debit, 175500.0)

    def test_reconcile_missing_long_queues_unwind(self):
        s = self.make()
        s.long_leg, s.short_leg = dict(LONG), dict(SHORT)
        self.broker.net[(25500, "2098-12-01")] = -4 * 65     # short present, long absent
        s._reconcile_broker()
        self.assertEqual(s.pending_exit_reason, "RECONCILE_LONG_MISSING")

    def test_broker_net_lookup_failure_raises_instead_of_returning_zero(self):
        s = self.make()
        s.broker.get_owned_net_qty = mock.Mock(side_effect=ConnectionError("down"))
        with self.assertRaises(RuntimeError):
            s._get_broker_net(24000, "2099-01-01")

    def test_live_requires_unvalidated_ack_and_targets_default_off(self):
        with mock.patch.object(sys, "argv", ["x", "--live"]):
            with self.assertRaises(SystemExit):
                dc.parse_args()
        with mock.patch.object(sys, "argv", ["x", "--live", "--i-understand-this-is-unvalidated"]):
            a = dc.parse_args()
        self.assertEqual((a.target_profit, a.stop_loss), ("", ""))



class TestDiagonalReviewFixes(_SelBase):
    def make_nondhan(self):
        helper = FakeHelper(self.broker)
        s = dc.NiftyDiagonalCallStrategy(live=True, broker="zerodha", helper=helper, instance_id="unittest_nd")
        s.broker = self.broker
        # the real poll loop is deadline-based and spins for its full timeout once sleep() is patched out
        s._wait_for_fill = lambda oid, strike, expiry, opt, signed, before, timeout=15: (
            self.broker.get_owned_net_qty(strike, expiry, opt) - before == signed
        )
        return s

    def run_with_clock(self, s, hh, mm, trig, ticks_after=None):
        class FDT(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 10, 5, hh, mm, 0)
        with mock.patch.object(dc, "datetime", FDT), mock.patch.object(dc, "check_shutdown_trigger", trig), \
                mock.patch.object(dc, "exit_if_market_closed", lambda *a, **k: None):
            s.run()

    # -- monthly detection ---------------------------------------------------
    def test_monthly_expiries_survive_holiday_shift(self):
        listed = ["2026-08-04", "2026-08-18", "2026-08-24", "2026-09-29"]
        self.assertEqual(dc.monthly_expiries(listed), {"2026-08-24", "2026-09-29"})
        self.assertFalse(dc.is_monthly_expiry("2026-08-24"))   # the heuristic alone would drop it

    def test_long_call_never_a_weekly(self):
        s = self.make_with_chain()
        self.assertIn(s.select_long_call(24500.0)["expiry"], MONTHLIES)

    # -- non-Dhan orders cannot be cancelled ------------------------------------
    def test_nondhan_timeout_is_unknown_not_retried(self):
        s = self.make_nondhan()
        s.select_long_call = lambda spot: dict(LONG)
        s.select_short_call = lambda spot, ld, long_leg=None: dict(SHORT)
        self.broker.fill = False
        self.assertFalse(s.enter_cycle(24500.0))
        self.assertTrue(s.entry_halted)                      # halted, not backoff-retried
        self.assertEqual(self.broker.calls, [("BUY", 24000, 195)])
        self.assertEqual(s.helper.cancelled, [])             # nothing cancellable

    def test_nondhan_late_fill_inside_grace_is_adopted(self):
        s = self.make_nondhan()
        reads = {"n": 0}
        real = self.broker.get_owned_net_qty

        def lagging(strike, expiry, opt_type):
            reads["n"] += 1
            if reads["n"] > 5:                               # position shows up after a few polls
                self.broker.net[(strike, expiry)] = 195
            return real(strike, expiry, opt_type)
        self.broker.get_owned_net_qty = lagging
        self.broker.fill = False
        status, moved = s._confirm_fill_or_cancel("1", 24000, "2099-01-01", "CE", 195, 0)
        self.assertEqual((status, moved), ("FILLED", 195))

    def test_unknown_exit_outcome_slows_retry(self):
        s = self.make_nondhan()
        self.open_position(s)
        self.broker.fill = False
        self.assertFalse(s.exit_all("TEST"))
        self.assertEqual(s.exit_retry_sleep, dc.UNKNOWN_EXIT_RETRY_SEC)
        self.assertEqual([c[0] for c in self.broker.calls], ["BUY"])   # long untouched

    # -- notifications -------------------------------------------------------
    def test_incomplete_exit_notifies_once_then_rate_limits(self):
        s = self.make()
        self.open_position(s)
        self.broker.fill = False
        with mock.patch.object(dc, "notify") as n:
            for _ in range(4):
                s.exit_all("TEST")
            self.assertEqual(n.call_count, 1)
            self.broker.fill = True
            self.assertTrue(s.exit_all("TEST"))
            self.assertEqual(n.call_count, 2)                 # completion always notifies

    # -- phantom P&L -----------------------------------------------------------
    def test_leg_already_flat_books_no_pnl(self):
        s = self.make()
        self.open_position(s)
        self.broker.net[(25500, "2098-12-01")] = 0            # short already closed elsewhere
        s.short_leg["current_ltp"] = 10.0
        closed, _, done = s._close_leg(s.short_leg, "BUY")
        self.assertEqual((closed, done), (True, 0))
        self.broker.net[(24000, "2099-01-01")] = 3 * 65
        self.assertTrue(s.exit_all("TEST"))
        self.assertEqual(s.cumulative_short_premium, 0.0)              # no short P&L booked for a leg closed elsewhere

    def test_partial_broker_quantity_is_flat_after_one_close(self):
        s = self.make()
        self.open_position(s)
        self.broker.net[(25500, "2098-12-01")] = -2 * 65      # broker shows 2 of the 4 tracked lots
        closed, _, done = s._close_leg(s.short_leg, "BUY")
        self.assertEqual((closed, done), (True, 2 * 65))

    # -- persistence & display -------------------------------------------------
    def test_resell_block_persists(self):
        s = self.make()
        self.open_position(s)
        s.short_resell_blocked = True
        s.save_position()
        s2 = self.make()
        self.assertTrue(s2.short_resell_blocked)

    def test_lcr_display_is_capped(self):
        s = self.make()
        s.initial_long_debit = 1000.0
        s.long_leg = dict(LONG)
        s.cumulative_short_premium = 5_000_000.0
        self.assertEqual(s.compute_lcr()[0], dc.LCR_DISPLAY_CAP_PCT)

    # -- run loop ----------------------------------------------------------------
    def test_stop_while_flat_exits_even_off_hours(self):
        s = self.make()
        s.pending_exit_reason = "DASHBOARD_SHUTDOWN_TRIGGER"
        self.run_with_clock(s, 22, 0, lambda k: False)
        self.assertEqual(s.status, "STOPPED")

    def test_pending_exit_with_legs_waits_for_session(self):
        s = self.make()
        self.open_position(s)
        s.pending_exit_reason = "TEST"
        n = {"i": 0}

        def trig(_k):
            n["i"] += 1
            if n["i"] > 2:
                raise KeyboardInterrupt
            return False
        s.exit_all = mock.Mock(return_value=True)
        self.run_with_clock(s, 22, 0, trig)
        # off-hours with legs: only the KeyboardInterrupt path exits (once)
        self.assertEqual(s.exit_all.call_count, 1)
        self.assertEqual(s.exit_all.call_args.kwargs["reason"], "KEYBOARD_INTERRUPT")

    def test_keyboard_interrupt_exit_failure_does_not_crash(self):
        s = self.make()
        self.open_position(s)

        def trig(_k):
            raise KeyboardInterrupt
        s.exit_all = mock.Mock(side_effect=RuntimeError("lookup failed"))
        self.run_with_clock(s, 11, 0, trig)                    # must return, not raise

    def test_restore_short_waits_for_start_time(self):
        s = self.make()
        self.open_position(s)
        s.short_leg = None
        self.broker.net[(25500, "2098-12-01")] = 0
        s.status = "RUNNING"
        s.restore_short_leg = mock.Mock()
        n = {"i": 0}

        def trig(_k):
            n["i"] += 1
            if n["i"] > 3:
                raise KeyboardInterrupt
            return False
        s.exit_all = mock.Mock(return_value=True)
        s.helper.get_ltp = lambda sid, *a, **k: 24500.0 if str(sid) == "NIFTY" else (14.0 if str(sid) == "21" else 100.0)
        self.run_with_clock(s, 9, 20, trig)                    # 09:20 < --start-time 09:30
        s.restore_short_leg.assert_not_called()


if __name__ == "__main__":
    unittest.main()
