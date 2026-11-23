"""Parity: lib/scanner_score.py must reproduce the dashboard scanner (rs_dashboard/lib/scannerMath.ts).

The fixture rs_dashboard/lib/scannerMath.parity.json is written by the TypeScript test
(UPDATE_PARITY=1 node --test lib/scannerMath.test.ts) from synthetic series with edge cases: a short history
(degraded RS lookback), a 40-session hole and a flat series. No broker, no network.
Run: venv/bin/python tests/test_scanner_score_parity.py
"""
import json
import math
import os
import sys

import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)
from lib import scanner_score as ss  # noqa: E402

FIXTURE = os.path.join(ROOT, "rs_dashboard", "lib", "scannerMath.parity.json")
FLOAT_TOL = 1e-6


def _frame(rows):
    return pd.DataFrame(rows)[["date", "open", "high", "low", "close", "volume"]]


def _load():
    with open(FIXTURE, "r", encoding="utf-8") as f:
        fx = json.load(f)
    bench = _frame(fx["index"])
    stocks = {s: _frame(r) for s, r in fx["stocks"].items()}
    return fx, bench, stocks


def _close(a, b):
    if isinstance(b, bool) or isinstance(a, bool):
        return bool(a) == bool(b)
    if isinstance(b, (int, float)) and isinstance(a, (int, float)):
        return math.isclose(float(a), float(b), rel_tol=FLOAT_TOL, abs_tol=FLOAT_TOL)
    return a == b


def test_fields_and_order_match_typescript():
    fx, bench, stocks = _load()
    for snap in fx["snapshots"]:
        as_of = snap["asOf"]
        idx = bench[bench["date"] <= as_of]
        book = ss.build_book({s: r[r["date"] <= as_of] for s, r in stocks.items()}, idx)
        ranked = book.ranked_rows(as_of)
        assert [r[0] for r in ranked] == snap["order"], (as_of, [r[0] for r in ranked], snap["order"])
        rs_score = {r[0]: r[2] for r in ranked}
        for sym, want in snap["rows"].items():
            f = book.fields[sym]
            row = f[f["date"] <= as_of].iloc[-1]
            for key, val in want.items():
                got = rs_score[sym] if key == "rsScore" else row[key]
                if key in ("score", "rsScore"):
                    assert int(got) == int(val), (as_of, sym, key, got, val)
                else:
                    assert _close(got.item() if hasattr(got, "item") else got, val), (as_of, sym, key, got, val)


def test_js_round_is_half_up():
    assert ss._js_round(2.5) == 3 and ss._js_round(3.5) == 4 and ss._js_round(-0.5) == 0


if __name__ == "__main__":
    test_fields_and_order_match_typescript()
    test_js_round_is_half_up()
    print("scanner parity: ok")
