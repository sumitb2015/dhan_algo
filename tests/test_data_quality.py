"""Run: venv/bin/python tests/test_data_quality.py"""
import os, sys
from datetime import date, timedelta
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import pandas as pd
from lib import data_quality as dq


def frame(closes):
    d0 = date(2026, 1, 1)
    return pd.DataFrame({"date": [d0 + timedelta(days=i) for i in range(len(closes))], "close": closes})


def test_bonus_and_seam_flagged():
    hits = dq.find_suspect_breaks({"B": frame([100, 100, 66.7, 67]), "S": frame([100, 150, 151])})
    assert {(h["symbol"], h["ratio"]) for h in hits} == {("B", 0.667), ("S", 1.5)}, hits


def test_ordinary_moves_ignored():
    hits = dq.find_suspect_breaks({"X": frame([100, 129, 127]), "Y": frame([100, 62, 60]), "Z": frame([100, 101, 99])})
    assert hits == [], hits           # +29% and -38% are not clean fractions; small moves never qualify


def test_threshold():
    assert dq.find_suspect_breaks({"A": frame([100, 80, 81])}) == []      # 4/5 fraction but only -20%: below min_move


if __name__ == "__main__":
    for n, f in sorted(globals().items()):
        if n.startswith("test_"):
            f(); print("ok", n)
