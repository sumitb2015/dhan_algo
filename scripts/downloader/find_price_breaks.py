"""
List price-basis breaks (splits, bonuses, demergers) in the daily stock CSVs
that corporate_actions.json doesn't cover yet.

A break is a day whose open is at least 30% away from the prior close AND whose
whole range sits outside the prior day's range, so nobody traded through the
gap. That's the shape of a corporate action. A real crash that opens near the
prior close and sells off intraday fails the second test and is not reported.
rs_dashboard/lib/rankingFactors.ts uses the same rule.

This script only reports; it never edits anything. Confirm each candidate
against an exchange or company announcement, then add a `price_adjustments`
entry (the printed stub has the factor already computed) with its source.

Usage:
    venv/bin/python scripts/downloader/find_price_breaks.py
    venv/bin/python scripts/downloader/find_price_breaks.py --sessions 0   # whole history
    venv/bin/python scripts/downloader/find_price_breaks.py --symbols HEG TRENT
"""
import argparse
import json
import os
import sys

import pandas as pd

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_ROOT)

from lib.market_data_hygiene import drop_no_trade_bars  # noqa: E402

STOCKS_DIR = os.path.join(PROJECT_ROOT, "Daily_Historical_Data_Fresh")
REGISTRY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "corporate_actions.json")
GAP_RATIO = 0.7


def load_registered() -> set[tuple[str, str]]:
    try:
        with open(REGISTRY_FILE, encoding="utf-8") as f:
            reg = json.load(f)
    except (OSError, ValueError):
        return set()
    out = set()
    for a in reg.get("price_adjustments", []):
        if "symbol" not in a:
            continue
        # A from_date marks the seam where an already-adjusted stretch meets a raw one,
        # which is itself a break this entry accounts for.
        for key in ("break_date", "from_date"):
            if a.get(key):
                out.add((a["symbol"], a[key]))
    return out


def find_breaks(df: pd.DataFrame, sessions: int) -> list[dict]:
    prev, cur = df.shift(1), df
    ratio = cur["Open"] / prev["Close"]
    valid = (prev["Close"] > 0) & (cur["Open"] > 0) & (prev["Low"] > 0) & (cur["High"] > 0)
    hit = valid & (
        ((ratio < GAP_RATIO) & (cur["High"] < prev["Low"]))
        | ((ratio > 1 / GAP_RATIO) & (cur["Low"] > prev["High"]))
    )
    if sessions > 0:
        hit &= df.index >= len(df) - sessions
    return [
        {"break_date": df.at[i, "Datetime"], "prev_close": float(df.at[i - 1, "Close"]),
         "open": float(df.at[i, "Open"]), "factor": round(float(ratio[i]), 6)}
        for i in df.index[hit]
    ]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--sessions", type=int, default=300,
                    help="Only scan the most recent N sessions per stock (0 = whole history). Default 300 (~14 months).")
    ap.add_argument("--symbols", nargs="*", help="Limit to these symbols")
    args = ap.parse_args()

    registered = load_registered()
    files = sorted(f for f in os.listdir(STOCKS_DIR) if f.endswith("_Daily_2Y.csv"))
    if args.symbols:
        wanted = {s.upper() for s in args.symbols}
        files = [f for f in files if f[: -len("_Daily_2Y.csv")] in wanted]

    unregistered, covered = [], 0
    for fname in files:
        symbol = fname[: -len("_Daily_2Y.csv")]
        try:
            df = pd.read_csv(os.path.join(STOCKS_DIR, fname), on_bad_lines="skip")
        except (OSError, pd.errors.ParserError):
            continue
        if not {"Datetime", "Open", "High", "Low", "Close", "Volume"}.issubset(df.columns):
            continue
        df["Datetime"] = df["Datetime"].astype(str).str[:10]
        df = drop_no_trade_bars(df.sort_values("Datetime")).reset_index(drop=True)
        for b in find_breaks(df, args.sessions):
            if (symbol, b["break_date"]) in registered:
                covered += 1
            else:
                unregistered.append({"symbol": symbol, **b})

    scope = "whole history" if args.sessions == 0 else f"last {args.sessions} sessions"
    print(f"Scanned {len(files)} stock CSVs ({scope}): {covered} registered break(s), {len(unregistered)} unregistered.")
    for b in unregistered:
        print(f"  {b['symbol']:<12} {b['break_date']}  close {b['prev_close']:.2f} -> open {b['open']:.2f}  "
              f"({(b['factor'] - 1) * 100:+.1f}%)")
    if unregistered:
        print("\nStubs for corporate_actions.json -> price_adjustments (fill in type/ex_date/evidence/source after confirming):")
        stubs = [{"symbol": b["symbol"], "break_date": b["break_date"], "factor": b["factor"],
                  "adjust_volume": None, "type": None, "ex_date": None, "evidence": "", "source": ""}
                 for b in unregistered]
        print(json.dumps(stubs, indent=2))


if __name__ == "__main__":
    main()
