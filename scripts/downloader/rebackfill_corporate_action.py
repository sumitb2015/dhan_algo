"""
One-off, symbol-scoped corrective re-backfill for a CONFIRMED stock split/bonus.

Neither of the two normal refresh paths adjusts for corporate actions:
`download_yahoo_daily.py` calls `yf.download(..., auto_adjust=False, ...)` at every
call site, and `DhanHelper.get_historical_data()` is a raw passthrough. Flipping
`auto_adjust` on the incremental Yahoo path is unsafe on its own — that path
re-fetches and overwrites a rolling 1-year window every run (see
`download_yahoo_stocks`'s `pd.concat(...).drop_duplicates(keep="last")`), so an
`auto_adjust=True` flag there would rescale that whole rolling window on every run
while data older than 1 year (from historical seeding) stayed unadjusted forever —
a new discontinuity at the 1-year boundary instead of at the split date.

This script instead does a full, single-shot, single-symbol overwrite from
`yf.download(ticker, period="max", auto_adjust=True, repair=True)` — the entire
history for that one symbol, adjusted once, written wholesale — leaving the daily
incremental pipeline (`refresh_dashboard_data.py`, `download_yahoo_daily.py`)
completely untouched. Run this only against a symbol with a CONFIRMED split/bonus;
don't run it speculatively (see corporate_actions.json's own caveat about VEDL,
which looked like a split candidate via `compare_dhan_yahoo.py`'s ratio heuristic
but empirically is not one — yfinance's own `repair` found nothing to fix there).

Usage:
    venv/bin/python scripts/downloader/rebackfill_corporate_action.py --symbol RELIANCE
    venv/bin/python scripts/downloader/rebackfill_corporate_action.py --symbol RELIANCE --dry-run

Always writes a timestamped .bak copy of the existing CSV before overwriting, since
this is a full overwrite rather than the merge/dedupe pattern the rest of the
downloader pipeline uses.
"""
import os
import sys
import json
import shutil
import argparse
import warnings
from datetime import datetime

import pandas as pd
import yfinance as yf

warnings.filterwarnings("ignore")

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_ROOT)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from download_yahoo_daily import to_yahoo_ticker, extract_ohlcv_from_yf  # noqa: E402

STOCKS_DIR = os.path.join(PROJECT_ROOT, "Daily_Historical_Data_Fresh")
REGISTRY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "corporate_actions.json")


def load_registry() -> dict:
    if not os.path.exists(REGISTRY_FILE):
        return {}
    try:
        with open(REGISTRY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def rebackfill_symbol(symbol: str, dry_run: bool = False) -> None:
    symbol = symbol.strip().upper()
    csv_path = os.path.join(STOCKS_DIR, f"{symbol}_Daily_2Y.csv")
    ticker = to_yahoo_ticker(symbol)

    print(f"Fetching full adjusted history for {ticker} (period=max, auto_adjust=True, repair=True)...")
    raw = yf.download(ticker, period="max", auto_adjust=True, repair=True, progress=False)
    if raw is None or raw.empty:
        print(f"  No data returned for {ticker} — aborting, nothing written.")
        return

    new_df = extract_ohlcv_from_yf(raw, ticker)
    if new_df.empty:
        print(f"  Extracted OHLCV was empty for {ticker} — aborting, nothing written.")
        return

    print(f"  Fetched {len(new_df)} rows, {new_df['Datetime'].min()} .. {new_df['Datetime'].max()}")

    if os.path.exists(csv_path):
        old_df = pd.read_csv(csv_path)
        print(f"  Existing CSV has {len(old_df)} rows, {old_df['Datetime'].min()} .. {old_df['Datetime'].max()}")
        merged = old_df.merge(new_df, on="Datetime", suffixes=("_old", "_new"), how="inner")
        if not merged.empty:
            merged["close_diff_pct"] = (
                (merged["Close_new"] - merged["Close_old"]).abs() / merged["Close_old"].replace(0, pd.NA) * 100
            )
            biggest = merged.reindex(merged["close_diff_pct"].abs().sort_values(ascending=False).index).head(5)
            print("  Largest Close differences (old on-disk vs. new adjusted), for manual spot-check:")
            for _, row in biggest.iterrows():
                print(f"    {row['Datetime']}: old={row['Close_old']:.2f} new={row['Close_new']:.2f} "
                      f"diff={row['close_diff_pct']:.1f}%")
    else:
        print("  No existing CSV — this will create a new one.")

    if dry_run:
        print("  --dry-run: not writing anything.")
        return

    if os.path.exists(csv_path):
        stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        backup_path = csv_path.replace(".csv", f".pre-corporate-action-fix.{stamp}.bak")
        shutil.copy2(csv_path, backup_path)
        print(f"  Backed up existing CSV to {backup_path}")

    tmp_path = csv_path + ".tmp"
    new_df.to_csv(tmp_path, index=False)
    os.replace(tmp_path, csv_path)
    print(f"  Wrote {len(new_df)} rows to {csv_path}")

    registry = load_registry()
    entry = registry.get(symbol)
    if entry is None:
        print(f"  Note: {symbol} has no entry in {REGISTRY_FILE} — add one (date/type/note) to record why this "
              f"corrective rebackfill was run, for anyone reading the CSV history later.")


def main():
    parser = argparse.ArgumentParser(
        description="One-off corrective full re-backfill for a confirmed stock split/bonus."
    )
    parser.add_argument("--symbol", required=True, help="NSE stock symbol to re-backfill (e.g. RELIANCE)")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and compare only; don't write anything")
    args = parser.parse_args()

    rebackfill_symbol(args.symbol, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
