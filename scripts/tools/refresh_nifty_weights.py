"""
Build index_constituents/nifty50_weights.csv, the weight seed behind /nifty-contribution.

NSE's constituent CSV carries no weights, so the seed is a weight snapshot taken from a published
weightage table, paired with each stock's closing price on the snapshot date (read from the repo's own
Daily_Historical_Data_Fresh CSVs). The page derives free-float share factors from that pair
(weight / ref_price) and carries the weights forward with live prices; see rs_dashboard/lib/niftyContribution.ts.

Usage:
    python scripts/tools/refresh_nifty_weights.py --table weights.md [--fallback-table other.md] [--as-of 2026-10-27]

--table is any text file with one `<rank> | <SYMBOL> | <weight>%` row per stock (a markdown table saved from
the StockMojo / Moneycontrol weightage page works, as does a hand-made one). Run it again after each NSE
rebalance (March / September) or whenever the page's reconciliation flag says the seed has drifted.
Writes nothing unless all 50 current constituents are present and the weights sum to about 100.
"""
import argparse
import csv
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CONSTITUENTS = os.path.join(ROOT, 'index_constituents', 'nifty50.csv')
DAILY_DIR = os.path.join(ROOT, 'Daily_Historical_Data_Fresh')
OUT = os.path.join(ROOT, 'index_constituents', 'nifty50_weights.csv')

ROW = re.compile(r'^\|?\s*\d+\s*\|\s*([A-Z0-9&-]+)\s*\|\s*([\d.]+)\s*%')


def read_weights(path: str) -> dict[str, float]:
    weights: dict[str, float] = {}
    with open(path, encoding='utf-8') as f:
        for line in f:
            m = ROW.match(line.strip())
            if m:
                weights[m.group(1)] = float(m.group(2))
    return weights


def close_on_or_before(symbol: str, as_of: str | None) -> tuple[str, float] | None:
    path = os.path.join(DAILY_DIR, f'{symbol}_Daily_2Y.csv')
    if not os.path.exists(path):
        return None
    best = None
    with open(path, newline='') as f:
        for row in csv.DictReader(f):
            day = (row.get('Datetime') or '')[:10]
            try:
                close = float(row['Close'])
            except (KeyError, ValueError):
                continue
            if close > 0 and day and (as_of is None or day <= as_of):
                best = (day, close)  # rows are chronological, so the last match wins
    return best


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--table', required=True, help='text/markdown file of "<rank> | SYMBOL | weight %%" rows')
    ap.add_argument('--fallback-table', help='second table used only for constituents the primary lacks')
    ap.add_argument('--as-of', help='YYYY-MM-DD the weights describe (default: newest close available)')
    args = ap.parse_args()

    with open(CONSTITUENTS, newline='', encoding='utf-8') as f:
        names = {r['Symbol']: r['Company Name'] for r in csv.DictReader(f)}
    weights = read_weights(args.table)

    if args.fallback_table:
        # A source that lags an index change lists fewer names (Moneycontrol had no BSE). Take just the absent
        # names from the fallback and rescale the primary so the file still sums to 100.
        fallback = read_weights(args.fallback_table)
        absent = {s: fallback[s] for s in names if s not in weights and s in fallback}
        if absent:
            scale = (100 - sum(absent.values())) / sum(weights.values())
            weights = {s: w * scale for s, w in weights.items()}
            weights.update(absent)
            print(f'filled from fallback: {absent}; primary rescaled by {scale:.4f}', file=sys.stderr)

    missing = sorted(set(names) - set(weights))
    extra = sorted(set(weights) - set(names))
    total = sum(weights.get(s, 0) for s in names)
    if missing or extra or not 95 <= total <= 105:
        print(f'refusing to write: missing={missing} extra={extra} sum={total:.2f}', file=sys.stderr)
        return 1

    rows = []
    for sym in sorted(names, key=lambda s: -weights[s]):
        got = close_on_or_before(sym, args.as_of)
        if got is None:
            print(f'refusing to write: no Daily CSV close for {sym}', file=sys.stderr)
            return 1
        rows.append((sym, names[sym], weights[sym], got[1], got[0]))

    # One as_of for the file: the oldest close used, so the page never claims fresher data than it has.
    as_of = min(r[4] for r in rows)
    tmp = OUT + '.tmp'
    with open(tmp, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['symbol', 'name', 'weight_pct', 'ref_price', 'as_of'])
        for sym, name, wt, px, day in rows:
            if day != as_of:
                print(f'note: {sym} close is from {day}, not {as_of}', file=sys.stderr)
            w.writerow([sym, name, f'{wt:g}', f'{px:g}', as_of])
    os.replace(tmp, OUT)
    print(f'wrote {len(rows)} rows, weights sum {total:.2f}%, as_of {as_of} -> {OUT}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
