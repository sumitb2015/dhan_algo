"""Fill the pre-2019 Yahoo daily cache (Historical Data/Yahoo_Daily_Pre2019/<SYMBOL>.csv) for NSE stocks.

Daily_Historical_Data_Fresh starts on 2019-01-01. The Point & Figure page (price_pnf_candles.load_yahoo_pre) and the
/candlestick page put Yahoo's daily history from 2008 in front of it, rescaled onto the CSV's price basis. This script only
FETCHES and caches the raw Yahoo rows (split-adjusted, not dividend-adjusted) in the same file the P&F loader uses; each
reader does its own rebase against the rows it shows.

    venv/bin/python scripts/tools/yahoo_pre2019.py SHRIRAMFIN      # one symbol (no-op when already cached)
    venv/bin/python scripts/tools/yahoo_pre2019.py --all           # every symbol with a daily CSV and no cache yet

Market data only (Yahoo Finance, as the daily-CSV pipeline). The last stdout line is JSON for the dashboard route.
"""

import argparse
import json
import os
import sys
import time
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from price_pnf_candles import (  # noqa: E402
    DAILY_DIR, YAHOO_OVERLAP_DAYS, YAHOO_PRE_DIR, YAHOO_START, fetch_yahoo_daily, read_daily_csv,
)


def cache_path(symbol: str, directory: str = YAHOO_PRE_DIR) -> str:
    return os.path.join(directory, f"{symbol}.csv")


def fill_one(symbol: str, daily_dir: str = DAILY_DIR, cache_dir: str = YAHOO_PRE_DIR, fetch=fetch_yahoo_daily) -> dict:
    """Fetch and cache one symbol's Yahoo daily rows from 2008 to 90 days past its CSV's first day.
    Never overwrites a cache file; writes nothing when Yahoo returns nothing (a network error must not look like
    'no history' for good)."""
    path = cache_path(symbol, cache_dir)
    if os.path.isfile(path):
        return {"symbol": symbol, "ok": True, "cached": True}
    csv = read_daily_csv(symbol, daily_dir)
    if csv.empty:
        return {"symbol": symbol, "ok": False, "error": "no daily CSV"}
    end = (csv.index.min() + timedelta(days=YAHOO_OVERLAP_DAYS)).strftime("%Y-%m-%d")
    yahoo = fetch(symbol, YAHOO_START, end)
    if yahoo.empty:
        return {"symbol": symbol, "ok": False, "error": "no Yahoo data"}
    os.makedirs(cache_dir, exist_ok=True)
    tmp = f"{path}.tmp"
    yahoo.to_csv(tmp)
    os.replace(tmp, path)  # a reader never sees a half-written file
    return {"symbol": symbol, "ok": True, "cached": False, "rows": int(len(yahoo))}


def all_symbols(daily_dir: str = DAILY_DIR) -> list:
    return sorted(f[: -len("_Daily_2Y.csv")] for f in os.listdir(daily_dir) if f.endswith("_Daily_2Y.csv"))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("symbol", nargs="?")
    ap.add_argument("--all", action="store_true", help="every symbol with a daily CSV and no cache file yet")
    ap.add_argument("--pause", type=float, default=0.4, help="seconds between Yahoo calls in --all")
    a = ap.parse_args()
    if a.all:
        todo = [s for s in all_symbols() if not os.path.isfile(cache_path(s))]
        done, failed = 0, []
        for i, s in enumerate(todo, 1):
            r = fill_one(s)
            if r["ok"]:
                done += 1
            else:
                failed.append(s)
            print(f"[{i}/{len(todo)}] {s}: {'ok' if r['ok'] else r['error']}", file=sys.stderr, flush=True)
            time.sleep(a.pause)
        print(json.dumps({"ok": True, "fetched": done, "failed": failed}))
        return
    if not a.symbol:
        ap.error("give a SYMBOL or --all")
    print(json.dumps(fill_one(a.symbol.strip().upper())))


if __name__ == "__main__":
    main()
