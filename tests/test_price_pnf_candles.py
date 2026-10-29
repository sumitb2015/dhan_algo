"""scripts/tools/price_pnf_candles.py: equity resolution only (no Dhan session, no network)."""
import importlib.util
import os
import sys
import unittest

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "tools", "price_pnf_candles.py")


def _load():
    sys.path.insert(0, os.path.join(ROOT, "scripts", "tools"))
    spec = importlib.util.spec_from_file_location("price_pnf_candles", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class ResolveEquity(unittest.TestCase):
    def test_prefers_eq_over_be_and_ignores_other_exchanges_and_series(self):
        m = _load()
        master = pd.DataFrame({
            "EXCH_ID": ["NSE", "NSE", "BSE", "NSE"],
            "INSTRUMENT": ["EQUITY"] * 4,
            "UNDERLYING_SYMBOL": ["ABC"] * 4,
            "SERIES": ["BE", "EQ", "EQ", "SM"],
            "SECURITY_ID": [11, 22, 33, 44],
            "SYMBOL_NAME": ["ABC BE", "ABC LIMITED", "ABC BSE", "ABC SM"],
        })
        self.assertEqual(m.resolve_equity(master, "ABC"), ("22", "ABC LIMITED"))
        self.assertIsNone(m.resolve_equity(master, "XYZ"))


if __name__ == "__main__":
    unittest.main()
