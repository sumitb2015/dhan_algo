"""Pure-logic tests for the CrudeOilM VWAP + Supertrend strategy.

No broker, no network: every function under test is a module-level pure function.
Importing the strategy module is safe for the same reason test_orb_logic.py is —
get_dhan_client() is called in __init__, not at import time.

    venv\\Scripts\\python.exe -m unittest discover -s tests -p test_crudeoil_vwap_st_logic.py -v
"""

import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.trade_stops import ratchet_stop, stop_hit
from strategies.crudeoil.crudeoilm_vwap_supertrend import (
    CHOP_EXIT_BUFFER,
    Snapshot,
    CrudeOilMVwapSupertrendStrategy as VwapSt,
    NO_DATA,
    advance_regime,
    compute_oi_bias,
    desired_direction,
    entry_allowed,
)

# Regime defaults, mirroring the CLI.
REG = dict(adx_enter=22.0, adx_exit=18.0, chop_max=55.0, confirm=2)


class TestDesiredDirection(unittest.TestCase):
    """The original dual-band rule — previously untested despite its docstring."""

    def test_above_both_is_long(self):
        self.assertEqual(desired_direction(105.0, 100.0, 101.0, "NONE"), "LONG")

    def test_below_both_is_short(self):
        self.assertEqual(desired_direction(95.0, 100.0, 99.0, "NONE"), "SHORT")

    def test_mixed_zone_holds_the_current_state(self):
        # Above the Supertrend but below VWAP: losing one band is not a signal.
        self.assertEqual(desired_direction(100.5, 100.0, 101.0, "NONE"), "NONE")
        self.assertEqual(desired_direction(100.5, 100.0, 101.0, "LONG"), "LONG")
        self.assertEqual(desired_direction(100.5, 100.0, 101.0, "SHORT"), "SHORT")

    def test_partial_view_never_acts(self):
        for price, st, vwap in ((0.0, 100.0, 101.0), (105.0, 0.0, 101.0), (105.0, 100.0, 0.0)):
            self.assertEqual(desired_direction(price, st, vwap, "SHORT"), "SHORT")

    def test_min_distance_rejects_a_hairline_clearance(self):
        # 100.4 clears both bands, but not by 1.0 point.
        self.assertEqual(desired_direction(100.4, 100.0, 100.2, "NONE"), "LONG")
        self.assertEqual(desired_direction(100.4, 100.0, 100.2, "NONE", 1.0), "NONE")
        # A decisive move still gets through.
        self.assertEqual(desired_direction(102.0, 100.0, 100.2, "NONE", 1.0), "LONG")

    def test_min_distance_also_guards_a_flip(self):
        self.assertEqual(desired_direction(99.6, 100.0, 99.8, "LONG", 1.0), "LONG")
        self.assertEqual(desired_direction(97.0, 100.0, 99.8, "LONG", 1.0), "SHORT")


class TestAdvanceRegime(unittest.TestCase):

    def test_trend_needs_confirm_candles(self):
        regime, streak, _ = advance_regime("CHOP", 0, adx=30.0, chop=40.0, **REG)
        self.assertEqual((regime, streak), ("CHOP", 1))  # first candle only arms it
        regime, streak, _ = advance_regime(regime, streak, adx=30.0, chop=40.0, **REG)
        self.assertEqual((regime, streak), ("TREND", 0))

    def test_a_single_strong_candle_does_not_flip_the_regime(self):
        regime, streak, _ = advance_regime("CHOP", 0, adx=30.0, chop=40.0, **REG)
        self.assertEqual(regime, "CHOP")
        # ...and the streak resets the moment the candidate stops agreeing.
        regime, streak, _ = advance_regime(regime, streak, adx=10.0, chop=80.0, **REG)
        self.assertEqual((regime, streak), ("CHOP", 0))

    def test_neutral_band_holds_the_current_regime(self):
        # ADX 20 is below --adx-enter but above --adx-exit: neither side claims it.
        for current in ("TREND", "CHOP"):
            regime, streak, reason = advance_regime(current, 0, adx=20.0, chop=50.0, **REG)
            self.assertEqual(regime, current)
            self.assertEqual(streak, 0)
            self.assertIn("holding", reason)

    def test_hysteresis_a_trend_survives_adx_between_the_thresholds(self):
        """The whole point: a market parked at ADX ~20 must not flap the regime."""
        regime, streak = "TREND", 0
        for _ in range(10):
            regime, streak, _ = advance_regime(regime, streak, adx=20.0, chop=52.0, **REG)
        self.assertEqual(regime, "TREND")

    def test_trend_reverts_on_adx_below_the_exit_threshold(self):
        regime, streak, _ = advance_regime("TREND", 0, adx=15.0, chop=50.0, **REG)
        self.assertEqual((regime, streak), ("TREND", 1))
        regime, streak, _ = advance_regime(regime, streak, adx=15.0, chop=50.0, **REG)
        self.assertEqual(regime, "CHOP")

    def test_trend_reverts_on_choppiness_above_the_buffer(self):
        high = REG["chop_max"] + CHOP_EXIT_BUFFER + 1.0
        regime, streak, _ = advance_regime("TREND", 0, adx=25.0, chop=high, **REG)
        regime, streak, _ = advance_regime(regime, streak, adx=25.0, chop=high, **REG)
        self.assertEqual(regime, "CHOP")

    def test_choppiness_inside_the_buffer_does_not_end_a_trend(self):
        inside = REG["chop_max"] + 1.0  # above chop_max, below chop_max + buffer
        regime, streak = "TREND", 0
        for _ in range(5):
            regime, streak, _ = advance_regime(regime, streak, adx=25.0, chop=inside, **REG)
        self.assertEqual(regime, "TREND")

    def test_missing_data_fails_closed_immediately(self):
        for adx, chop in ((NO_DATA, 40.0), (30.0, NO_DATA)):
            regime, streak, reason = advance_regime("TREND", 1, adx=adx, chop=chop, **REG)
            self.assertEqual((regime, streak), ("CHOP", 0))
            self.assertIn("failing closed", reason)


GATE = dict(st_val=100.0, vwap_val=110.0, atr_val=10.0, min_band_gap_atr=0.5,
            use_regime=True, use_htf=True)


class TestEntryAllowed(unittest.TestCase):

    def test_all_gates_passing(self):
        ok, why = entry_allowed("LONG", regime="TREND", htf_dir=1, **GATE)
        self.assertTrue(ok)
        self.assertEqual(why, "")

    def test_chop_regime_blocks(self):
        ok, why = entry_allowed("LONG", regime="CHOP", htf_dir=1, **GATE)
        self.assertFalse(ok)
        self.assertIn("regime", why)

    def test_htf_disagreement_blocks(self):
        ok, why = entry_allowed("LONG", regime="TREND", htf_dir=-1, **GATE)
        self.assertFalse(ok)
        self.assertIn("disagrees", why)
        ok, _ = entry_allowed("SHORT", regime="TREND", htf_dir=-1, **GATE)
        self.assertTrue(ok)

    def test_unknown_htf_fails_closed(self):
        """A stale/absent higher-timeframe bias must block, not wave through."""
        ok, why = entry_allowed("LONG", regime="TREND", htf_dir=0, **GATE)
        self.assertFalse(ok)
        self.assertIn("unavailable", why)

    def test_collapsed_bands_block(self):
        gate = dict(GATE, st_val=100.0, vwap_val=102.0)  # 2.0 gap, need 5.0
        ok, why = entry_allowed("LONG", regime="TREND", htf_dir=1, **gate)
        self.assertFalse(ok)
        self.assertIn("band gap", why)

    def test_band_gap_is_direction_agnostic(self):
        # VWAP below the Supertrend is just as valid a 10-point separation.
        gate = dict(GATE, st_val=110.0, vwap_val=100.0)
        ok, _ = entry_allowed("SHORT", regime="TREND", htf_dir=-1, **gate)
        self.assertTrue(ok)

    def test_missing_atr_blocks_the_band_gap_check(self):
        gate = dict(GATE, atr_val=0.0)
        ok, why = entry_allowed("LONG", regime="TREND", htf_dir=1, **gate)
        self.assertFalse(ok)
        self.assertIn("ATR unavailable", why)

    def test_disabled_gates_are_bypassed(self):
        gate = dict(GATE, st_val=100.0, vwap_val=100.1, min_band_gap_atr=0.0,
                    use_regime=False, use_htf=False)
        ok, why = entry_allowed("LONG", regime="CHOP", htf_dir=0, **gate)
        self.assertTrue(ok, why)

    def test_no_signal_is_not_an_entry(self):
        ok, _ = entry_allowed("NONE", regime="TREND", htf_dir=1, **GATE)
        self.assertFalse(ok)

    def test_oi_confirms_a_long(self):
        ok, why = entry_allowed("LONG", regime="TREND", htf_dir=1, oi_bias="BULLISH",
                                use_oi=True, **GATE)
        self.assertTrue(ok, why)

    def test_oi_disagreement_blocks(self):
        ok, why = entry_allowed("LONG", regime="TREND", htf_dir=1, oi_bias="BEARISH",
                                use_oi=True, **GATE)
        self.assertFalse(ok)
        self.assertIn("OI bias is BEARISH", why)

    def test_oi_neutral_does_not_confirm(self):
        """NEUTRAL is not disagreement, but it is not confirmation either -- a
        confirmation gate that waves through 'no clear signal' isn't confirming anything."""
        ok, why = entry_allowed("SHORT", regime="TREND", htf_dir=-1, oi_bias="NEUTRAL",
                                use_oi=True, **GATE)
        self.assertFalse(ok)

    def test_oi_unavailable_fails_closed(self):
        ok, why = entry_allowed("LONG", regime="TREND", htf_dir=1, oi_bias="UNAVAILABLE",
                                use_oi=True, **GATE)
        self.assertFalse(ok)
        self.assertIn("UNAVAILABLE", why)

    def test_oi_gate_off_by_default_is_bypassed(self):
        """use_oi defaults False -- adding the OI param must not change any existing
        caller that doesn't pass it."""
        ok, why = entry_allowed("LONG", regime="TREND", htf_dir=1, oi_bias="BEARISH", **GATE)
        self.assertTrue(ok, why)


class TestComputeOiBias(unittest.TestCase):
    """Ported from strategies/oi_directional/nifty_oi_directional.py's expansion check:
    OI has to be growing AWAY from zero in one direction, not just present."""

    def test_needs_at_least_two_snapshots(self):
        bias, reason = compute_oi_bias([])
        self.assertEqual(bias, "UNAVAILABLE")
        bias, reason = compute_oi_bias([500.0])
        self.assertEqual(bias, "UNAVAILABLE")

    def test_ce_dominant_and_growing_is_bearish(self):
        # CE OI pulling further ahead of PE OI -> resistance building overhead.
        bias, _ = compute_oi_bias([1000.0, 1500.0])
        self.assertEqual(bias, "BEARISH")

    def test_pe_dominant_and_growing_is_bullish(self):
        bias, _ = compute_oi_bias([-1000.0, -1500.0])
        self.assertEqual(bias, "BULLISH")

    def test_ce_dominant_but_shrinking_is_neutral(self):
        # Same sign as bearish, but NOT expanding -- must not be mistaken for a signal.
        bias, _ = compute_oi_bias([1500.0, 1000.0])
        self.assertEqual(bias, "NEUTRAL")

    def test_pe_dominant_but_shrinking_is_neutral(self):
        bias, _ = compute_oi_bias([-1500.0, -1000.0])
        self.assertEqual(bias, "NEUTRAL")

    def test_sign_flip_registers_as_the_new_sides_bias(self):
        # curr > prev is trivially true crossing zero upward, so a PE-to-CE flip reads
        # as BEARISH -- this is the same behavior as the ported oi_directional formula,
        # not a bug introduced here. A magnitude-based "flip" gate would need a
        # different formula; this one is a faithful port of the existing convention.
        bias, _ = compute_oi_bias([-200.0, 300.0])
        self.assertEqual(bias, "BEARISH")
        bias, _ = compute_oi_bias([300.0, -200.0])
        self.assertEqual(bias, "BULLISH")

    def test_only_the_last_two_entries_matter(self):
        bias, _ = compute_oi_bias([-9999.0, 1000.0, 1500.0])
        self.assertEqual(bias, "BEARISH")


class TestStopRatchet(unittest.TestCase):
    """The trail borrowed from lib/trade_stops.py, exercised the way this strategy uses
    it: the reference level is the Supertrend band rather than a pivot."""

    def test_long_stop_only_tightens(self):
        stop = 95.0                                   # entry 100, 1.5x ATR of ~3.3
        stop = ratchet_stop("LONG", stop, 97.0)       # band rises
        self.assertEqual(stop, 97.0)
        stop = ratchet_stop("LONG", stop, 96.0)       # pullback band — ignored
        self.assertEqual(stop, 97.0)

    def test_short_stop_only_tightens(self):
        stop = 105.0
        stop = ratchet_stop("SHORT", stop, 103.0)
        self.assertEqual(stop, 103.0)
        stop = ratchet_stop("SHORT", stop, 104.0)
        self.assertEqual(stop, 103.0)

    def test_stop_hit_directions(self):
        self.assertTrue(stop_hit("LONG", 96.9, 97.0))
        self.assertFalse(stop_hit("LONG", 97.1, 97.0))
        self.assertTrue(stop_hit("SHORT", 103.1, 103.0))
        self.assertFalse(stop_hit("SHORT", 102.9, 103.0))

    def test_a_zero_quote_is_never_a_stop_out(self):
        """get_ltp() returns 0.0 on failure; 0.0 is below every long stop."""
        self.assertFalse(stop_hit("LONG", 0.0, 97.0))
        self.assertFalse(stop_hit("SHORT", 0.0, 103.0))


class TestTrailingStopMethod(unittest.TestCase):
    """_update_trailing_stop() is the riskiest new money-path code: it decides when a
    live stop moves. Exercised on a bare instance — no broker, no __init__."""

    def _strat(self, **over):
        s = object.__new__(VwapSt)
        s.direction = over.get("direction", "LONG")
        s.entry_price = over.get("entry_price", 100.0)
        s.ltp = over.get("ltp", 100.0)
        s.stop_level = over.get("stop_level", 97.0)
        s.stop_source = "ATR"
        s.atr_stop_mult = over.get("atr_stop_mult", 1.5)
        s.trail_trigger_atr = over.get("trail_trigger_atr", 1.0)
        s._snapshot = Snapshot(
            close=over.get("ltp", 100.0), st=over.get("st", 99.0), vwap=100.0,
            candle_ts="2026-08-24 17:30:00", atr=over.get("atr", 2.0),
            adx=30.0, chop=40.0, htf_dir=1, regime="TREND", regime_reason="",
            oi_bias="UNAVAILABLE", oi_reason="", oi_diff=0.0,
        )
        s._snap_lock = threading.Lock()
        return s

    def test_no_trail_before_the_profit_trigger(self):
        s = self._strat(ltp=101.0, st=99.5)   # +1.0 move, needs 1.0 x ATR = 2.0
        s._update_trailing_stop()
        self.assertEqual(s.stop_level, 97.0)
        self.assertEqual(s.stop_source, "ATR")

    def test_trail_arms_once_far_enough_in_profit(self):
        s = self._strat(ltp=103.0, st=99.5)   # +3.0 move, past 2.0
        s._update_trailing_stop()
        self.assertEqual(s.stop_level, 99.5)
        self.assertEqual(s.stop_source, "SUPERTREND")

    def test_trail_never_loosens(self):
        s = self._strat(ltp=103.0, st=99.5)
        s._update_trailing_stop()
        s._snapshot = s._snapshot._replace(st=98.0)   # band falls back
        s._update_trailing_stop()
        self.assertEqual(s.stop_level, 99.5)

    def test_band_already_on_the_wrong_side_is_not_adopted(self):
        """Adopting a band above price on a long would stop out on the arming tick."""
        s = self._strat(ltp=103.0, st=104.0)
        s._update_trailing_stop()
        self.assertEqual(s.stop_level, 97.0)

    def test_short_side_trails_downward(self):
        s = self._strat(direction="SHORT", entry_price=100.0, ltp=97.0,
                        stop_level=103.0, st=100.5)
        s._update_trailing_stop()
        self.assertEqual(s.stop_level, 100.5)
        s._snapshot = s._snapshot._replace(st=102.0)
        s._update_trailing_stop()
        self.assertEqual(s.stop_level, 100.5)

    def test_disabled_stop_never_trails(self):
        s = self._strat(ltp=103.0, st=99.5, atr_stop_mult=0.0, stop_level=0.0)
        s._update_trailing_stop()
        self.assertEqual(s.stop_level, 0.0)

    def test_missing_quote_does_not_move_the_stop(self):
        s = self._strat(ltp=0.0, st=99.5)
        s._update_trailing_stop()
        self.assertEqual(s.stop_level, 97.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
