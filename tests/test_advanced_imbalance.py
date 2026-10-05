"""Scenario tests for strategies/value_imbalance/nifty_advanced_imbalance.py.

The cycle code runs for real against a fake market and a fake execution broker:
`World` scripts the CE/PE/spot prices tick by tick (advanced once per monitor
tick), tracks broker positions from the orders the strategy places, and fixes
the clock. No network, no sleeping, no dashboard state files.
"""
import os
import sys
import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import strategies.value_imbalance.nifty_advanced_imbalance as mod
from strategies.value_imbalance.nifty_advanced_imbalance import NiftyAdvancedImbalance, build_parser, validate_args

EXPIRY = "2026-10-06"
LOT = 75
SPOT_ID = "13"


def opt_id(strike, side):
    return strike * 10 + (1 if side == "CE" else 2)


class FakeBroker:
    """ExecutionBroker stand-in. Net quantity per (strike, side); orders are recorded."""

    def __init__(self):
        self.net = {}
        self.orders = []          # (action, strike, side, qty)
        self.fail_next_sell = False
        self._n = 0

    def _fill(self, action, strike, side, qty):
        self._n += 1
        self.orders.append((action, strike, side, qty))
        sign = 1 if action == "BUY" else -1
        self.net[(strike, side)] = self.net.get((strike, side), 0) + sign * qty
        return f"O{self._n}"

    def buy(self, strike, expiry, side, qty, product="INTRADAY"):
        return self._fill("BUY", strike, side, qty)

    def sell(self, strike, expiry, side, qty, product="INTRADAY"):
        if self.fail_next_sell:
            self.fail_next_sell = False
            self.orders.append(("SELL-REJECTED", strike, side, qty))
            return None
        return self._fill("SELL", strike, side, qty)

    def get_owned_net_qty(self, strike, expiry, side):
        return self.net.get((strike, side), 0)


class World:
    """Scripted market. `ticks` is a list of {(strike, side) | 'spot': price} updates;
    tick 0 is applied immediately, the next one after every RUNNING state save."""

    def __init__(self, ticks):
        self.ticks = list(ticks)
        self.prices = {}          # str(security id) -> price
        self.strike_prices = {}   # (strike, side) -> price
        self.minute = 0
        self.guard = 0
        self.advance()

    def set(self, key, price):
        if key == "spot":
            self.prices[SPOT_ID] = price
        else:
            self.strike_prices[key] = price
            self.prices[str(opt_id(*key))] = price

    def advance(self):
        self.guard += 1
        if self.guard > 500:
            raise RuntimeError("scenario did not terminate")
        if self.ticks:
            for key, price in self.ticks.pop(0).items():
                self.set(key, price)
        self.minute += 1

    def now(self):
        return datetime(2026, 10, 5, 11, 0) .replace(minute=self.minute % 60, hour=11 + self.minute // 60)

    # --- helper API surface used by the strategy ---
    def get_ltps(self, items):
        return {str(i): self.prices.get(str(i), 0.0) for _, i in items}

    def get_ltp(self, sid, **kw):
        return self.prices.get(str(sid), 0.0)

    def option(self, underlying, strike, side):
        price = self.strike_prices.get((strike, side), 0.0)
        if price <= 0:
            return None
        return {"CONTRACT_INFO": {"SECURITY_ID": opt_id(strike, side), "LOT_SIZE": LOT,
                                  "SM_EXPIRY_DATE": EXPIRY, "SYMBOL_NAME": f"NIFTY-{strike}-{side}"},
                "last_price": price}

    def chain(self, *a, **k):
        strikes = sorted({s for s, _ in self.strike_prices})
        df = pd.DataFrame({
            "ce_last_price": [self.strike_prices.get((s, "CE"), 0.0) for s in strikes],
            "pe_last_price": [self.strike_prices.get((s, "PE"), 0.0) for s in strikes],
        }, index=[float(s) for s in strikes])
        return df


class AdvancedImbalanceScenarios(unittest.TestCase):
    CE_STRIKE, PE_STRIKE = 24200, 23800   # strangle used by most scenarios

    def build(self, ticks, *, entry=(60.0, 60.0), mode="loser_ratio_roll", **kw):
        """Strategy mid-cycle: short CE/PE already filled at `entry`, `ticks` to play."""
        self.world = World(ticks)
        w = self.world
        # tick 0 was applied in World(); fill in whatever it did not script
        for key, price in (((self.CE_STRIKE, "CE"), entry[0]), ((self.PE_STRIKE, "PE"), entry[1])):
            if key not in w.strike_prices:
                w.set(key, price)
        if SPOT_ID not in w.prices:
            w.set("spot", 24000.0)

        helper = MagicMock()
        helper.get_lot_size.return_value = LOT
        helper.get_ltps.side_effect = w.get_ltps
        helper.get_ltp.side_effect = w.get_ltp
        helper.option.side_effect = w.option
        helper.get_option_chain_df.side_effect = w.chain
        helper.wait_for_fill.return_value = False      # use the quoted price as the fill
        helper.is_market_open.return_value = True

        patches = [
            patch.object(mod, "get_dhan_client", return_value=MagicMock()),
            patch.object(mod, "DhanHelper", return_value=helper),
            patch.object(mod, "check_shutdown_trigger", return_value=False),
            patch.object(mod, "save_strategy_state", side_effect=self._save),
            patch.object(mod, "notify"),
            patch.object(mod.time, "sleep"),
            patch.object(mod, "datetime", SimpleNamespace(now=w.now, strptime=datetime.strptime)),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

        self.saved = []
        params = dict(entry_type="strangle", mode=mode, dry_run=False, profit_target=None,
                      stop_loss=1e9, trail_start_rs=1e9, state_key="test_adv")
        params.update(kw)
        if params["profit_target"] is None:
            params["profit_target"] = 1e9          # effectively off
        s = NiftyAdvancedImbalance(**params)
        s.profit_target = kw.get("profit_target")  # None -> disabled unless the test sets one
        s.broker = FakeBroker()
        s.nifty_lot_size = LOT
        s.expiry = EXPIRY
        s.ce_strike, s.pe_strike = self.CE_STRIKE, self.PE_STRIKE
        s.initial_ce_strike, s.initial_pe_strike = self.CE_STRIKE, self.PE_STRIKE
        s.ce_id, s.pe_id = opt_id(self.CE_STRIKE, "CE"), opt_id(self.PE_STRIKE, "PE")
        s.ce_avg_price, s.pe_avg_price = entry
        s.initial_ce_entry_price, s.initial_pe_entry_price = entry
        s.broker.net[(self.CE_STRIKE, "CE")] = -s.initial_lots * LOT
        s.broker.net[(self.PE_STRIKE, "PE")] = -s.initial_lots * LOT
        if mode == "reentry_straddle":
            s.ce_active = s.pe_active = True
            s.ce_original_entry_premium, s.pe_original_entry_premium = entry
            s.ce_sl = round(entry[0] * (1 + s.leg_sl_pct), 2)
            s.pe_sl = round(entry[1] * (1 + s.leg_sl_pct), 2)
        s.sleep_cooldown = MagicMock()
        self.s = s
        return s

    def _save(self, key, state):
        self.saved.append(state)
        if state.get("status") == "RUNNING":
            self.world.advance()

    def run_cycle(self, s=None):
        s = s or self.s
        s._monitor_cycle(24000.0)

    def flat(self, s=None):
        s = s or self.s
        return all(v == 0 for v in s.broker.net.values())

    # ------------------------------------------------------------------
    def test_trail_exit_banks_cycle_pnl_into_daily(self):
        """Regression: only scalp-lock / day-limit exits banked P&L into daily_pnl, so a
        trail exit left the day total at 0 and the global target/stop compared against
        a fabricated number."""
        s = self.build([
            {(self.CE_STRIKE, "CE"): 60, (self.PE_STRIKE, "PE"): 60},
            {(self.CE_STRIKE, "CE"): 40, (self.PE_STRIKE, "PE"): 40},   # +3000 -> arms (trail 500)
            {(self.CE_STRIKE, "CE"): 30, (self.PE_STRIKE, "PE"): 30},   # +4500 best
            {(self.CE_STRIKE, "CE"): 42, (self.PE_STRIKE, "PE"): 42},   # +2700 -> gave back 1800 > 300
        ], trail_start_rs=500.0, trail_gap_rs=300.0)
        self.run_cycle()
        self.assertTrue(self.flat())
        self.assertAlmostEqual(s.daily_pnl, (60 - 42) * LOT * 2)
        s.sleep_cooldown.assert_called_once_with(mod.COOLDOWN_SEC)

    def test_straddle_shift_exit_banks_pnl(self):
        s = self.build([
            {(self.CE_STRIKE, "CE"): 60, (self.PE_STRIKE, "PE"): 60},
            {(self.CE_STRIKE, "CE"): 70, (self.PE_STRIKE, "PE"): 50, "spot": 24350.0},
        ], entry_type="straddle", mode="loser_ratio_roll")
        # straddle: both legs at one strike
        self.run_cycle()
        # entry_type straddle uses initial_ce_strike for drift; 24350 vs 24200 -> 150 >= 100
        self.assertTrue(self.flat())
        self.assertAlmostEqual(s.daily_pnl, ((60 - 70) + (60 - 50)) * LOT)

    def test_strangle_breach_exits(self):
        s = self.build([
            {(self.CE_STRIKE, "CE"): 60, (self.PE_STRIKE, "PE"): 60},
            {(self.CE_STRIKE, "CE"): 90, (self.PE_STRIKE, "PE"): 20, "spot": 24200.0},
        ])
        self.run_cycle()
        self.assertTrue(self.flat())
        self.assertAlmostEqual(s.daily_pnl, ((60 - 90) + (60 - 20)) * LOT)

    def test_global_stop_loss_ends_day(self):
        s = self.build([
            {(self.CE_STRIKE, "CE"): 60, (self.PE_STRIKE, "PE"): 60},
            {(self.CE_STRIKE, "CE"): 100, (self.PE_STRIKE, "PE"): 60},
        ])
        s.stop_loss = -2000.0
        s._wait_next_day = MagicMock()
        self.run_cycle()
        self.assertTrue(self.flat())
        s._wait_next_day.assert_called_once()
        self.assertAlmostEqual(s.daily_pnl, (60 - 100) * LOT)

    def test_scalp_lock_multi_cycle_banks_and_cools_down(self):
        s = self.build([
            {(self.CE_STRIKE, "CE"): 60, (self.PE_STRIKE, "PE"): 60},
            {(self.CE_STRIKE, "CE"): 40, (self.PE_STRIKE, "PE"): 40},   # +3000 = 33% of 9000
        ], scalp_floor_pct=30.0, multi_cycle=True, cycle_cooldown=120)
        self.run_cycle()
        self.assertTrue(self.flat())
        self.assertAlmostEqual(s.daily_pnl, (60 - 40) * LOT * 2)
        s.sleep_cooldown.assert_called_once_with(120)

    def test_scalp_lock_without_multi_cycle_waits_for_next_day(self):
        s = self.build([
            {(self.CE_STRIKE, "CE"): 60, (self.PE_STRIKE, "PE"): 60},
            {(self.CE_STRIKE, "CE"): 40, (self.PE_STRIKE, "PE"): 40},
        ], scalp_floor_pct=30.0)
        s._wait_next_day = MagicMock()
        self.run_cycle()
        s._wait_next_day.assert_called_once()
        s.sleep_cooldown.assert_not_called()

    # --- rolls -------------------------------------------------------
    def test_loser_ratio_roll_rolls_and_adds_lots(self):
        """CE decays (winner), PE spikes (loser): the PE rolls further OTM with one more lot."""
        s = self.build([
            {(self.CE_STRIKE, "CE"): 60, (self.PE_STRIKE, "PE"): 60},
            {(self.CE_STRIKE, "CE"): 30, (self.PE_STRIKE, "PE"): 120,
             (23700, "PE"): 62, (23750, "PE"): 80},
        ], max_lots=4, loser_ratio_lots=1, threshold_lot=25.0, threshold_strike=40.0)
        # One roll then an out-of-script guard exit via breach on the following tick.
        self.world.ticks.append({"spot": 23700.0})
        self.run_cycle()
        pe_orders = [o for o in s.broker.orders if o[2] == "PE"]
        self.assertIn(("BUY", self.PE_STRIKE, "PE", LOT), pe_orders)           # old loser closed
        sells = [o for o in pe_orders if o[0] == "SELL"]
        self.assertEqual(len(sells), 1)
        self.assertEqual(sells[0][3], 2 * LOT)                                  # 1 -> 2 lots
        self.assertEqual(s.adjustment_count, 1)
        self.assertTrue(self.flat())                                            # breach exit closed all
        self.assertAlmostEqual(s.realized_pnl, (60 - 120) * LOT, delta=1e-6)    # roll realised the loser
        # day P&L == everything that happened, exactly once
        legs = (60 - 30) * LOT + (s.pe_avg_price - self.world.prices[str(s.pe_id)]) * 2 * LOT
        self.assertAlmostEqual(s.daily_pnl, s.realized_pnl + legs, places=4)

    def test_roll_with_no_quote_for_new_strike_exits_cleanly(self):
        """Regression: after the old leg was bought back, a missing quote for the new strike left
        state pointing at the closed leg (phantom position, double-counted P&L)."""
        s = self.build([
            {(self.CE_STRIKE, "CE"): 60, (self.PE_STRIKE, "PE"): 60},
            {(self.CE_STRIKE, "CE"): 30, (self.PE_STRIKE, "PE"): 120},   # no PE strikes below -> no new quote
        ])
        # Rebalance finds a strike from the chain, but option() has no quote and the chain row is the
        # only source; make the chain row exist yet the quote path fail: remove strike price after pick.
        orig_chain = self.world.chain

        def chain_then_drop(*a, **k):
            df = orig_chain()
            df.loc[23700.0] = [0.0, 62.0]       # chain shows a PE price...
            return df
        s.helper.get_option_chain_df.side_effect = chain_then_drop
        s.helper.option.side_effect = lambda *a: None            # ...but no tradable quote
        self.run_cycle()
        self.assertTrue(self.flat())
        # PE loser was closed once, at 120: realised -4500. CE closed at 30: +2250. Total once.
        self.assertAlmostEqual(s.daily_pnl, (60 - 120) * LOT + (60 - 30) * LOT, places=4)
        self.assertEqual(sum(1 for o in s.broker.orders if o[:3] == ("BUY", self.PE_STRIKE, "PE")), 1)

    def test_roll_sell_rejection_exits_and_banks(self):
        s = self.build([
            {(self.CE_STRIKE, "CE"): 60, (self.PE_STRIKE, "PE"): 60},
            {(self.CE_STRIKE, "CE"): 30, (self.PE_STRIKE, "PE"): 120, (23700, "PE"): 62},
        ])
        s.broker.fail_next_sell = True
        self.run_cycle()
        self.assertTrue(self.flat())
        self.assertAlmostEqual(s.daily_pnl, (60 - 120) * LOT + (60 - 30) * LOT, places=4)

    def test_winner_roll_inversion_exits_cycle(self):
        # PE winner at 23800, CE at 23850 -> PE can't roll up without crossing
        self.CE_STRIKE, self.PE_STRIKE = 23850, 23800
        s = self.build([
            {(self.CE_STRIKE, "CE"): 60, (self.PE_STRIKE, "PE"): 60, "spot": 23825.0},
            {(self.CE_STRIKE, "CE"): 120, (self.PE_STRIKE, "PE"): 30},
        ], mode="winner_roll_atm")
        s.entry_type = "strangle"
        self.run_cycle()
        self.assertTrue(self.flat())
        self.assertAlmostEqual(s.daily_pnl, ((60 - 120) + (60 - 30)) * LOT)

    # --- add-lot modes -----------------------------------------------
    def test_legacy_adds_winner_lot_then_exits_at_max(self):
        s = self.build([
            {(self.CE_STRIKE, "CE"): 60, (self.PE_STRIKE, "PE"): 60},
            {(self.CE_STRIKE, "CE"): 30, (self.PE_STRIKE, "PE"): 90},
            {(self.CE_STRIKE, "CE"): 25, (self.PE_STRIKE, "PE"): 95},
            {(self.CE_STRIKE, "CE"): 20, (self.PE_STRIKE, "PE"): 99},
        ], mode="legacy", max_lots=2, threshold_lot=25.0, threshold_strike=40.0)
        self.run_cycle()
        self.assertTrue(self.flat())
        self.assertEqual(s.adjustment_count, 1)
        ce_sells = [o for o in s.broker.orders if o[:3] == ("SELL", self.CE_STRIKE, "CE")]
        self.assertEqual(len(ce_sells), 1)
        self.assertEqual(s.ce_lots, 2)
        self.assertAlmostEqual(s.ce_avg_price, (60 + 30) / 2)      # averaged short price

    def test_hedged_addition_buys_wing_and_unwinds_it(self):
        s = self.build([
            {(self.CE_STRIKE, "CE"): 60, (self.PE_STRIKE, "PE"): 60, (self.CE_STRIKE + 200, "CE"): 10},
            {(self.CE_STRIKE, "CE"): 30, (self.PE_STRIKE, "PE"): 90},
            {(self.CE_STRIKE, "CE"): 25, (self.PE_STRIKE, "PE"): 95},
        ], mode="hedged_addition", max_lots=2)
        self.world.ticks.append({"spot": 24300.0})   # breach -> exit
        self.run_cycle()
        self.assertIn(("BUY", self.CE_STRIKE + 200, "CE", LOT), s.broker.orders)
        self.assertTrue(self.flat())                  # wing sold back, shorts bought back

    def test_hedged_wing_dumped_if_short_sale_rejected(self):
        s = self.build([
            {(self.CE_STRIKE, "CE"): 60, (self.PE_STRIKE, "PE"): 60, (self.CE_STRIKE + 200, "CE"): 10},
            {(self.CE_STRIKE, "CE"): 30, (self.PE_STRIKE, "PE"): 90},
        ], mode="hedged_addition", max_lots=3)
        self.world.ticks.append({"spot": 24300.0})
        s.broker.fail_next_sell = True
        self.run_cycle()
        self.assertEqual(s.adjustment_count, 0)
        self.assertTrue(self.flat())                  # no orphaned long wing

    # --- reentry_straddle + recovery ---------------------------------
    def test_reentry_leg_stops_out_then_reenters(self):
        self.CE_STRIKE = self.PE_STRIKE = 24000
        s = self.build([
            {(24000, "CE"): 60, (24000, "PE"): 60},
            {(24000, "CE"): 75, (24000, "PE"): 55},     # CE SL @ 72
            {(24000, "CE"): 58, (24000, "PE"): 55},     # back under entry -> re-enter
            {"spot": 24200.0},                          # straddle shift ends the cycle
        ], entry_type="straddle", mode="reentry_straddle", leg_sl_pct=0.20)
        self.run_cycle()
        ce_orders = [o[0] for o in s.broker.orders if o[1:3] == (24000, "CE")]
        self.assertEqual(ce_orders, ["BUY", "SELL", "BUY"])   # SL out, re-entry, final exit
        self.assertTrue(self.flat())

    def test_recovery_reweight_opens_long_wing_on_stop_out(self):
        """Regression: `next_otm_strike` was never imported, so the first stop-out with
        --recovery-reweight crashed the strategy with a NameError."""
        self.CE_STRIKE = self.PE_STRIKE = 24000
        s = self.build([
            {(24000, "CE"): 60, (24000, "PE"): 60, (24050, "CE"): 30},
            {(24000, "CE"): 75, (24000, "PE"): 55},     # CE stops out -> recovery long CE 24050
            {"spot": 24200.0},
        ], entry_type="straddle", mode="reentry_straddle", leg_sl_pct=0.20,
            recovery_reweight=True, recovery_sl_pct=0.30)
        self.run_cycle()
        self.assertIn(("BUY", 24050, "CE", LOT), s.broker.orders)
        self.assertEqual(s.ce_recovery_count, 1)
        self.assertTrue(self.flat())                  # recovery sold back by the final exit

    # --- unit-level --------------------------------------------------
    def test_update_trail(self):
        s = self.build([{}], trail_start_rs=500.0, trail_gap_rs=300.0)
        self.assertFalse(s._update_trail(420.0))
        self.assertFalse(s.trail_active)
        self.assertFalse(s._update_trail(620.0))
        self.assertTrue(s.trail_active)
        self.assertFalse(s._update_trail(1150.0))
        self.assertEqual(s.best_pnl, 1150.0)
        self.assertFalse(s._update_trail(900.0))      # giveback 250 < 300
        self.assertTrue(s._update_trail(840.0))       # giveback 310 > 300

    def test_scalp_decay_pct_tracks_held_lots(self):
        s = self.build([{}], scalp_floor_pct=30.0)
        s.ce_lots = s.pe_lots = 2
        basis = (60 * 2 + 60 * 2) * LOT
        self.assertAlmostEqual(s._scalp_decay_pct(basis * 0.3), 30.0)

    def test_new_day_resets_daily_pnl(self):
        s = self.build([{}])
        s.daily_pnl = 5000.0
        s.pnl_date = datetime(2026, 10, 4).date()
        # run()'s per-iteration rollover logic
        s.helper.wait_for_market_open = MagicMock()
        with patch.object(s, "_prepare_cycle", return_value=None), \
                patch.object(mod, "exit_if_market_closed"):
            calls = {"n": 0}

            def stop_after_one(*a, **k):
                calls["n"] += 1
                if calls["n"] > 1:
                    raise SystemExit
                return False
            with patch.object(s, "_stop_if_requested", side_effect=stop_after_one):
                with self.assertRaises(SystemExit):
                    s.run()
        self.assertEqual(s.daily_pnl, 0.0)


class ConfigValidation(unittest.TestCase):
    def errors(self, *argv):
        return validate_args(build_parser().parse_args(list(argv)))

    def test_default_straddle_winner_roll_is_rejected(self):
        self.assertTrue(self.errors())          # default mode + default entry-type

    def test_documented_example_is_valid(self):
        self.assertEqual(self.errors("--entry-type", "strangle", "--mode", "winner_roll_atm"), [])

    def test_reentry_straddle_valid(self):
        self.assertEqual(self.errors("--mode", "reentry_straddle"), [])

    def test_recovery_flags_need_reentry_mode(self):
        self.assertTrue(self.errors("--mode", "legacy", "--recovery-reweight"))

    def test_strike_threshold_must_exceed_lot_threshold(self):
        self.assertTrue(self.errors("--mode", "legacy", "--threshold-lot", "40", "--threshold-strike", "30"))


if __name__ == "__main__":
    unittest.main()
