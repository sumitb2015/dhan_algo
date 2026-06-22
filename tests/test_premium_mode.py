import sys
import os
import unittest
import pandas as pd
from unittest.mock import MagicMock, patch

# Add parent directory to path to import strategies and lib
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from strategies.nifty_value_imbalance_strangle import ValueImbalanceStrangle
from strategies.nifty_advanced_imbalance import NiftyAdvancedImbalance

class TestPremiumStrikeSelection(unittest.TestCase):
    def setUp(self):
        # Create a mock option chain DataFrame
        # Strikes: 23800 to 24200
        data = {
            'ce_last_price': [120.0, 100.0, 85.0, 70.0, 52.0, 44.0, 31.0, 20.0, 10.0],
            'pe_last_price': [10.0, 22.0, 33.0, 48.0, 65.0, 80.0, 95.0, 110.0, 130.0],
            'ce_delta': [0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05],
            'pe_delta': [-0.05, -0.1, -0.2, -0.3, -0.4, -0.5, -0.6, -0.7, -0.8]
        }
        self.strikes = [23800, 23850, 23900, 23950, 24000, 24050, 24100, 24150, 24200]
        self.chain_df = pd.DataFrame(data, index=self.strikes)
        
        # Mock the get_dhan_client in setUp so we don't hit live OAuth prompts
        self.patcher1 = patch('strategies.nifty_value_imbalance_strangle.get_dhan_client')
        self.mock_get_dhan1 = self.patcher1.start()
        self.mock_get_dhan1.return_value = MagicMock()

        self.patcher2 = patch('strategies.nifty_advanced_imbalance.get_dhan_client')
        self.mock_get_dhan2 = self.patcher2.start()
        self.mock_get_dhan2.return_value = MagicMock()

        # Mock DhanHelper for both strategies
        self.patcher3 = patch('strategies.nifty_value_imbalance_strangle.DhanHelper')
        self.mock_helper1 = self.patcher3.start()
        self.mock_helper1.return_value = MagicMock()

        self.patcher4 = patch('strategies.nifty_advanced_imbalance.DhanHelper')
        self.mock_helper2 = self.patcher4.start()
        self.mock_helper2.return_value = MagicMock()

        self.patcher_sleep = patch('time.sleep', return_value=None)
        self.mock_sleep = self.patcher_sleep.start()

    def tearDown(self):
        self.patcher1.stop()
        self.patcher2.stop()
        self.patcher3.stop()
        self.patcher4.stop()
        self.patcher_sleep.stop()

    def test_strangle_premium_selection_standard(self):
        # Strangle with premium mode, target-premium = 50.0
        # Spot is 24000
        # CE OTM strikes are > 24000: 24050 (44.0), 24100 (31.0), 24150 (20.0), 24200 (10.0).
        # Prices below or equal to 50: 44.0, 31.0, 20.0, 10.0. Max/closest below is 44.0 (Strike 24050).
        # PE OTM strikes are < 24000: 23950 (48.0), 23900 (33.0), 23850 (22.0), 23800 (10.0).
        # Prices below or equal to 50: 48.0, 33.0, 22.0, 10.0. Max/closest below is 48.0 (Strike 23950).
        strat = ValueImbalanceStrangle(
            strike_selection="premium",
            target_premium=50.0,
            ce_offset=200,
            pe_offset=200
        )
        ce_strike, pe_strike = strat.select_strikes(24000.0, self.chain_df)
        self.assertEqual(ce_strike, 24050)
        self.assertEqual(pe_strike, 23950)

    def test_strangle_premium_selection_low_target(self):
        # Target premium = 15.0
        # For CE: OTM strikes <= 15 is 24200 (10.0).
        # For PE: OTM strikes <= 15 is 23800 (10.0).
        strat = ValueImbalanceStrangle(
            strike_selection="premium",
            target_premium=15.0
        )
        ce_strike, pe_strike = strat.select_strikes(24000.0, self.chain_df)
        self.assertEqual(ce_strike, 24200)
        self.assertEqual(pe_strike, 23800)

    def test_strangle_premium_selection_no_strike_below(self):
        # Target premium = 5.0 (No OTM strikes <= 5.0 exist)
        # Should fallback to closest absolute price
        # For CE, closest to 5.0 is 24200 (10.0)
        # For PE, closest to 5.0 is 23800 (10.0)
        strat = ValueImbalanceStrangle(
            strike_selection="premium",
            target_premium=5.0
        )
        ce_strike, pe_strike = strat.select_strikes(24000.0, self.chain_df)
        self.assertEqual(ce_strike, 24200)
        self.assertEqual(pe_strike, 23800)

    def test_advanced_premium_selection_standard(self):
        # Advanced strategy strangle premium mode, target-premium = 35.0
        # Spot is 24000
        # For CE: OTM strikes <= 35 are 24100 (31.0), 24150 (20.0), 24200 (10.0). Max is 31.0 (Strike 24100).
        # For PE: OTM strikes <= 35 are 23900 (33.0), 23850 (22.0), 23800 (10.0). Max is 33.0 (Strike 23900).
        strat = NiftyAdvancedImbalance(
            entry_type="strangle",
            use_premium=True,
            target_premium=35.0
        )
        ce_strike, pe_strike = strat.select_strikes(24000.0, self.chain_df)
        self.assertEqual(ce_strike, 24100)
        self.assertEqual(pe_strike, 23900)

    def test_strangle_inversion_prevention(self):
        # Strangle in distance mode with inverted offsets (negative values)
        # Spot is 24000
        # CE = 24000 + (-300) = 23700
        # PE = 24000 - (-300) = 24300
        # Since CE (23700) <= PE (24300), select_strikes must return None, None
        strat = ValueImbalanceStrangle(
            strike_selection="distance",
            ce_offset=-300,
            pe_offset=-300
        )
        ce_strike, pe_strike = strat.select_strikes(24000.0, self.chain_df)
        self.assertIsNone(ce_strike)
        self.assertIsNone(pe_strike)
    def test_advanced_inversion_prevention(self):
        # Advanced strategy strangle with inverted offsets
        strat = NiftyAdvancedImbalance(
            entry_type="strangle",
            ce_offset=-300,
            pe_offset=-300
        )
        ce_strike, pe_strike = strat.select_strikes(24000.0, self.chain_df)
        self.assertIsNone(ce_strike)
        self.assertIsNone(pe_strike)

    def test_strangle_exit_all_positions_with_sync(self):
        # Strangle strategy exit_all_positions with mock quantities
        strat = ValueImbalanceStrangle(
            strike_selection="distance"
        )
        # Mock class fields
        strat.ce_id = 12345
        strat.pe_id = 67890
        strat.dry_run = False # Make it run live orders code path
        
        # Scenario 1: Both legs are open short (net_qty is negative)
        strat.helper.get_net_quantity.side_effect = lambda sid: -75 if sid in ["12345", "67890"] else 0
        strat.helper.buy.reset_mock()
        strat.exit_all_positions("Normal exit")
        
        # Verify it attempts to buy back exactly 75 qty for both
        strat.helper.buy.assert_any_call("12345", 75)
        strat.helper.buy.assert_any_call("67890", 75)
        self.assertEqual(strat.helper.buy.call_count, 2)
        
        # Scenario 2: PE is already flat (net_qty is 0)
        strat.helper.get_net_quantity.side_effect = lambda sid: -75 if sid == "12345" else 0
        strat.helper.buy.reset_mock()
        strat.exit_all_positions("PE flat exit")
        
        # Verify it only buys CE
        strat.helper.buy.assert_called_once_with("12345", 75)

    def test_advanced_exit_all_positions_with_sync(self):
        # Advanced strategy exit_all_positions with wings
        strat = NiftyAdvancedImbalance(
            entry_type="strangle"
        )
        strat.ce_id = 111
        strat.pe_id = 222
        strat.ce_wings = [{'id': 333, 'strike': 24200, 'lots': 1}]
        strat.pe_wings = [{'id': 444, 'strike': 23800, 'lots': 1}]
        strat.dry_run = False
        
        # Scenario: Shorts are open (-75), Wing 333 is open (+75), Wing 444 is already flat (0)
        strat.helper.get_net_quantity.side_effect = lambda sid: -75 if sid in ["111", "222"] else (75 if sid == "333" else 0)
        strat.helper.buy.reset_mock()
        strat.helper.sell.reset_mock()
        
        strat.exit_all_positions("Advanced exit check")
        
        # Shorts should be bought back
        strat.helper.buy.assert_any_call("111", 75)
        strat.helper.buy.assert_any_call("222", 75)
        self.assertEqual(strat.helper.buy.call_count, 2)
        
        # Wing 333 (long) should be sold back
        strat.helper.sell.assert_called_once_with("333", 75)

    @patch('strategies.nifty_short_straddle.get_dhan_client')
    @patch('strategies.nifty_short_straddle.DhanHelper')
    def test_short_straddle_exit_all_positions_with_sync(self, mock_dhan_helper_cls, mock_get_dhan):
        mock_dhan = MagicMock()
        mock_get_dhan.return_value = mock_dhan
        
        mock_helper = MagicMock()
        mock_dhan_helper_cls.return_value = mock_helper
        
        # Setup mock behavior
        mock_helper.get_lot_size.return_value = 25
        mock_helper.get_prev_day_levels.return_value = {"high": 24000, "low": 23800, "close": 23900}
        
        # Nifty Spot LTP is 24000
        # CE quote and PE quote
        mock_helper.option.side_effect = lambda sym, strike, opt_type: {
            'CONTRACT_INFO': {
                'SYMBOL_NAME': f'NIFTY-{strike}-{opt_type}',
                'SECURITY_ID': 12345 if opt_type == 'CE' else 67890,
                'SM_EXPIRY_DATE': '2026-06-25',
                'LOT_SIZE': 25
            },
            'last_price': 50.0
        }
        
        class TestCompleteException(BaseException):
            pass
            
        # Run test 1: Both legs open short
        prices = [24000.0, 50.0, 50.0, 100.0, 100.0]
        mock_helper.get_ltp.side_effect = lambda sym, *args, **kwargs: prices.pop(0) if prices else 100.0
        mock_helper.get_net_quantity.side_effect = lambda sid: -50 if sid in ["12345", "67890"] else 0
        mock_helper.wait_for_market_open.side_effect = [None, TestCompleteException()]
        mock_helper.buy.reset_mock()
        
        from strategies.nifty_short_straddle import run_nifty_straddle_strategy
        
        with self.assertRaises(TestCompleteException):
            run_nifty_straddle_strategy(dry_run=False, num_lots=2)
            
        # Verify it tries to buy back 50 qty for both
        mock_helper.buy.assert_any_call("12345", 50)
        mock_helper.buy.assert_any_call("67890", 50)
        self.assertEqual(mock_helper.buy.call_count, 2)
        
        # Run test 2: CE is flat, PE is short
        prices = [24000.0, 50.0, 50.0, 100.0, 100.0]
        mock_helper.get_ltp.side_effect = lambda sym, *args, **kwargs: prices.pop(0) if prices else 100.0
        mock_helper.get_net_quantity.side_effect = lambda sid: 0 if sid == "12345" else -50
        mock_helper.wait_for_market_open.side_effect = [None, TestCompleteException()]
        mock_helper.buy.reset_mock()
        
        with self.assertRaises(TestCompleteException):
            run_nifty_straddle_strategy(dry_run=False, num_lots=2)
            
        # Verify it only buys PE (67890)
        mock_helper.buy.assert_called_once_with("67890", 50)

    @patch('strategies.nifty_value_imbalance.get_dhan_client')
    @patch('strategies.nifty_value_imbalance.DhanHelper')
    def test_value_imbalance_straddle_exit_all_positions_with_sync(self, mock_dhan_helper_cls, mock_get_dhan):
        mock_dhan = MagicMock()
        mock_get_dhan.return_value = mock_dhan
        mock_helper = MagicMock()
        mock_dhan_helper_cls.return_value = mock_helper
        
        mock_helper.get_lot_size.return_value = 25
        mock_helper.get_prev_day_levels.return_value = {"high": 24000, "low": 23800, "close": 23900}
        
        from strategies.nifty_value_imbalance import ValueImbalanceStrategy
        
        strat = ValueImbalanceStrategy(dry_run=False, initial_lots=1)
        strat.ce_id = 999
        strat.pe_id = 888
        
        # Scenario 1: Both legs are open short (-25)
        strat.helper.get_net_quantity.side_effect = lambda sid: -25 if sid in ["999", "888"] else 0
        strat.helper.buy.reset_mock()
        
        strat.exit_all_positions("Normal target exit")
        
        strat.helper.buy.assert_any_call("999", 25)
        strat.helper.buy.assert_any_call("888", 25)
        self.assertEqual(strat.helper.buy.call_count, 2)
        
        # Scenario 2: CE is already flat (0)
        strat.helper.get_net_quantity.side_effect = lambda sid: 0 if sid == "999" else -25
        strat.helper.buy.reset_mock()
        
        strat.exit_all_positions("CE flat exit")
        
        strat.helper.buy.assert_called_once_with("888", 25)

if __name__ == '__main__':
    unittest.main()
