"""
Replace a stock's full daily history with fresh Dhan data, after showing exactly what differs.

Use when a CSV in Daily_Historical_Data_Fresh/ is corrupt in the middle of its history (the incremental refresh
only ever looks at the last rows, so it never self-corrects). Example: MOTHERSON had ~20 quarter-end sessions with
prices ~25% low and ~1/4 volume, a different series spliced in.

Default is a DIFF ONLY: it prints how many rows differ by more than --tol and the worst ones, and writes nothing.
--apply backs the file up to debug/repair_backups/ and replaces it. Source is Dhan only.

Usage:
    venv/bin/python scripts/downloader/repair_symbol_history.py MOTHERSON
    venv/bin/python scripts/downloader/repair_symbol_history.py MOTHERSON --apply
"""
import argparse
import json
import os
import shutil
import sys
from datetime import datetime

import pandas as pd

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backfill_stocks_history import fetch_range_chunked          # noqa: E402  (365-day chunking, Dhan only)
from fix_flat_stock_candles import load_csv, save_csv            # noqa: E402

STOCKS_DIR = os.path.join(PROJECT_ROOT, "Daily_Historical_Data_Fresh")
BACKUP_DIR = os.path.join(PROJECT_ROOT, "debug", "repair_backups")


def check_symbol(helper, symbol: str, start: str, tol: float, apply: bool, verbose: bool = True) -> dict:
    """Compare one CSV with Dhan's history; optionally replace it. Returns a stats dict."""
    path = os.path.join(STOCKS_DIR, f"{symbol}_Daily_2Y.csv")
    old = load_csv(path)
    if old.empty:
        return {"symbol": symbol, "status": "no csv"}
    sec = helper.get_security_id(symbol=symbol, instrument="EQUITY")
    if not sec:
        return {"symbol": symbol, "status": "not in master list"}
    segment = "BSE_EQ" if sec.get("EXCH_ID") == "BSE" else "NSE_EQ"
    new = fetch_range_chunked(helper, int(sec["SECURITY_ID"]), segment, sec.get("INSTRUMENT", "EQUITY"),
                              start, datetime.now().strftime("%Y-%m-%d"))
    if new.empty:
        return {"symbol": symbol, "status": "no Dhan data"}
    new = new[new.index.dayofweek < 5]

    both = old.join(new, how="inner", lsuffix="_old", rsuffix="_new")
    diff = ((both["Close_new"] / both["Close_old"] - 1.0).abs() * 100.0)
    bad = diff[diff > tol]
    r = new["Close"].pct_change().abs()
    stats = {"symbol": symbol, "status": "ok", "old": len(old), "dhan": len(new), "overlap": len(both),
             "mismatch": int(len(bad)), "worst_pct": round(float(bad.max()), 1) if len(bad) else 0.0,
             "dhan_max_move": round(float(r.max()) * 100, 1), "dhan_moves_gt25": int((r > 0.25).sum())}
    if verbose:
        print(f"{symbol}: old {len(old)}, Dhan {len(new)}, overlap {len(both)}, mismatching rows (>{tol}%): {len(bad)}")
        for d, v in bad.sort_values(ascending=False).head(6).items():
            print(f"  {d.date()}  old {both.loc[d, 'Close_old']:.2f}  Dhan {both.loc[d, 'Close_new']:.2f}  ({v:.1f}%)")
        print(f"  Dhan series: worst daily move {r.max() * 100:.1f}% on {r.idxmax().date()}")
    if apply and len(bad):
        os.makedirs(BACKUP_DIR, exist_ok=True)
        backup = os.path.join(BACKUP_DIR, f"{symbol}_{datetime.now():%Y%m%d_%H%M%S}.csv")
        shutil.copy2(path, backup)
        # Dhan wins on every date it returns; keep newer old rows (e.g. a live-patched today row) it lacks.
        keep_old = old[~old.index.isin(new.index) & (old.index > new.index.max())]
        combined = pd.concat([new, keep_old]).sort_index()
        combined = combined[~combined.index.duplicated(keep="last")]
        save_csv(combined, path)
        stats["applied"] = True
        stats["backup"] = backup
        if verbose:
            print(f"  REPLACED ({len(combined)} rows), backup {backup}")
    return stats


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("symbols", nargs="*", help="symbols to check (default with --universe: the Nifty 500 list)")
    p.add_argument("--universe", action="store_true", help="check every Nifty 500 symbol (slow: ~5 s each)")
    p.add_argument("--start", default="2019-01-01")
    p.add_argument("--tol", type=float, default=0.5, help="close difference in %% that counts as a mismatch")
    p.add_argument("--apply", action="store_true", help="back up and replace mismatching files (default: diff only)")
    p.add_argument("--report", help="write the per-symbol stats as JSON to this path")
    args = p.parse_args()

    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper
    helper = DhanHelper(get_dhan_client())

    symbols = list(args.symbols)
    if args.universe:
        from lib.momentum import load_universe
        symbols = [u["symbol"] for u in load_universe("nifty500")]
    if not symbols:
        p.error("give symbols or --universe")

    results = []
    for i, sym in enumerate(symbols, 1):
        try:
            res = check_symbol(helper, sym, args.start, args.tol, args.apply, verbose=not args.universe)
        except Exception as e:                       # one bad symbol must not stop a long sweep
            res = {"symbol": sym, "status": f"error: {e}"}
        results.append(res)
        if args.universe:
            print(f"[{i}/{len(symbols)}] {sym}: {res.get('status')} mismatch={res.get('mismatch', '-')}", flush=True)
        if args.report:
            with open(args.report, "w") as f:
                json.dump(results, f, indent=1)
    flagged = [r for r in results if r.get("mismatch")]
    print(f"\nchecked {len(results)}, with mismatching rows: {len(flagged)}"
          f"{'' if args.apply else ' (DIFF ONLY — nothing written; re-run with --apply)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
