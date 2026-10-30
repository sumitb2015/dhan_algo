"""scripts/tools/price_pnf_candles.py: equity resolution and contract-leg parsing (no Dhan session, no network)."""
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


class ParseLegs(unittest.TestCase):
    def test_one_or_two_fno_legs(self):
        m = _load()
        self.assertEqual(m.parse_legs("NSE_FNO:53872:OPTIDX"), [("NSE_FNO", "53872", "OPTIDX")])
        self.assertEqual(m.parse_legs("MCX_COMM:1:OPTFUT, MCX_COMM:2:OPTFUT"), [("MCX_COMM", "1", "OPTFUT"), ("MCX_COMM", "2", "OPTFUT")])

    def test_rejects_other_segments_instruments_ids_and_counts(self):
        m = _load()
        for bad in ["", "NSE_EQ:1:EQUITY", "NSE_FNO:abc:OPTIDX", "NSE_FNO:1:INDEX", "NSE_FNO:1", "a:1:OPTIDX,b:2:OPTIDX",
                    "NSE_FNO:1:OPTIDX,NSE_FNO:2:OPTIDX,NSE_FNO:3:OPTIDX"]:
            with self.assertRaises(ValueError, msg=bad):
                m.parse_legs(bad)


if __name__ == "__main__":
    unittest.main()
