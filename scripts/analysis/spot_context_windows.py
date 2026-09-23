"""
Spot-only context for options research: how often does an index move beyond a given
band within N trading days, split by India VIX at entry, and how often does VIX fall/rise
over the same window?

CONTEXT ONLY. It uses spot and India VIX, never option prices, so it says nothing about
premiums, P&L or charges. Windows overlap (every close is an entry), so rows are not
independent. Windows whose entry day has no India VIX row are dropped from every row
(6 of 1,901 days), so 'all' can differ by about 0.1 point from an unfiltered count.
Read-only: it writes nothing.

Data (Dhan-sourced, repo CSVs): Historical Data/NIFTY_50_Daily_5Y.csv (or --spot-csv),
Historical Data/Indices/INDIA_VIX.csv.

Usage (from the project root, venv python):
  python scripts/analysis/spot_context_windows.py --horizon 10 --bands 2 3
  python scripts/analysis/spot_context_windows.py --horizon 4 --bands 1.65 --up 1.94 --down 2.98
  python scripts/analysis/spot_context_windows.py --horizon 10 --bands 3 --since 2025-01-01 --json

Columns per row (percent of windows):
  close>|b|     close on the last day is beyond +-b%
  touch b       the high/low path reached +-b% on any day (either side)
  touch +up / touch -down   optional one-sided levels (--up, --down, in percent)
  VIX fell/rose the change in VIX from entry to the last day was <= -1 / >= +1 point
"""

import argparse
import json
import os
import sys

import pandas as pd

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_SPOT = os.path.join(PROJECT_ROOT, "Historical Data", "NIFTY_50_Daily_5Y.csv")
VIX_PATH = os.path.join(PROJECT_ROOT, "Historical Data", "Indices", "INDIA_VIX.csv")

VIX_BANDS = [
    ("all", None, None),
    ("VIX<12", None, 12),
    ("VIX 12-13", 12, 13),
    ("VIX 13-18", 13, 18),
    ("VIX>=18", 18, None),
]


def load(spot_csv):
    def read(path):
        d = pd.read_csv(path)
        d.columns = [c.lower() for c in d.columns]
        d["date"] = pd.to_datetime(d["datetime"]).dt.tz_localize(None).dt.normalize()
        return d

    spot, vix = read(spot_csv), read(VIX_PATH)
    df = spot.merge(vix[["date", "close"]].rename(columns={"close": "vix"}), on="date", how="left")
    return df.sort_values("date").reset_index(drop=True)


def windows(df, horizon):
    rows = []
    for i in range(len(df) - horizon):
        entry = df["close"].iloc[i]
        w = df.iloc[i + 1 : i + horizon + 1]
        rows.append(
            {
                "date": df["date"].iloc[i],
                "vix": df["vix"].iloc[i],
                "ret": w["close"].iloc[-1] / entry - 1,
                "mx": w["high"].max() / entry - 1,
                "mn": w["low"].min() / entry - 1,
                "dvix": df["vix"].iloc[i + horizon] - df["vix"].iloc[i],
            }
        )
    return pd.DataFrame(rows)


def summarise(x, bands, up, down):
    out = {"n": int(len(x))}
    if x.empty:
        return out
    for b in bands:
        f = b / 100.0
        out[f"close>|{b}%|"] = float((x["ret"].abs() > f).mean())
        out[f"touch {b}%"] = float(((x["mx"] >= f) | (x["mn"] <= -f)).mean())
    if up is not None:
        out[f"touch +{up}%"] = float((x["mx"] >= up / 100.0).mean())
    if down is not None:
        out[f"touch -{down}%"] = float((x["mn"] <= -down / 100.0).mean())
    out["VIX fell>=1pt"] = float((x["dvix"] <= -1).mean())
    out["VIX rose>=1pt"] = float((x["dvix"] >= 1).mean())
    out["median dVIX"] = float(x["dvix"].median())
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--horizon", type=int, required=True, help="trading days held after the entry close")
    ap.add_argument("--bands", type=float, nargs="+", default=[3.0], help="symmetric bands in percent")
    ap.add_argument("--up", type=float, help="extra one-sided upper level in percent")
    ap.add_argument("--down", type=float, help="extra one-sided lower level in percent")
    ap.add_argument("--since", help="only entries on or after YYYY-MM-DD")
    ap.add_argument("--spot-csv", default=DEFAULT_SPOT, help="daily OHLC CSV (Datetime,Open,High,Low,Close)")
    ap.add_argument("--json", action="store_true", help="print JSON instead of a table")
    a = ap.parse_args()

    df = load(a.spot_csv)
    r = windows(df, a.horizon)
    if a.since:
        r = r[r["date"] >= pd.Timestamp(a.since)]
    r = r.dropna(subset=["vix"])
    result = {
        "spot_csv": os.path.relpath(a.spot_csv, PROJECT_ROOT),
        "data_range": [str(df["date"].min().date()), str(df["date"].max().date())],
        "horizon_trading_days": a.horizon,
        "rows": {},
    }
    for name, lo, hi in VIX_BANDS:
        x = r
        if lo is not None:
            x = x[x["vix"] >= lo]
        if hi is not None:
            x = x[x["vix"] < hi]
        result["rows"][name] = summarise(x, a.bands, a.up, a.down)

    if a.json:
        print(json.dumps(result, indent=2))
        return
    print(f"# {result['spot_csv']}  {result['data_range'][0]} -> {result['data_range'][1]}  horizon={a.horizon} trading days")
    print("# spot-only context; overlapping windows; no option prices\n")
    cols = [k for k in result["rows"]["all"] if k != "n"]
    print("| entry regime | n | " + " | ".join(cols) + " |")
    print("|---|---|" + "---|" * len(cols))
    for name, row in result["rows"].items():
        cells = []
        for k in cols:
            v = row.get(k)
            cells.append("-" if v is None else (f"{v:.2f}" if k == "median dVIX" else f"{v:.1%}"))
        print(f"| {name} | {row['n']} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    sys.exit(main())
