"""
Today's 1-minute closes of an index (Dhan intraday API), for the Algo Lab live engine's ctx.spotBars1m.

Read-only, one-off: spawned by rs_dashboard/app/api/algo-lab/spot/route.ts, which caches it per minute and paces it
on the shared dhan-spawn:<underlying> lane (Dhan's Data API limit is account-wide). Closes only: the backtest store
holds only the spot close, so strategies must not depend on the index high/low.

Output (last stdout line): {"ok": true, "date": "YYYY-MM-DD", "bars": [["HH:MM", close], ...]}
                       or {"ok": false, "error": "..."}

Usage: python scripts/tools/algo_lab_spot_bars.py --underlying NIFTY
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

IST = timezone(timedelta(hours=5, minutes=30))
INDEX_EXCHANGE = {'NIFTY': 'IDX_I', 'BANKNIFTY': 'IDX_I', 'SENSEX': 'BSE'}


def emit(obj):
    print(json.dumps(obj))
    sys.exit(0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--underlying', required=True, choices=list(INDEX_EXCHANGE))
    args = ap.parse_args()

    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper

    dhan = get_dhan_client()
    if not dhan:
        emit({'ok': False, 'error': 'Auth failed: run login.py'})
    helper = DhanHelper(dhan, skip_session_validation=True, master_list_cache=True)
    sec = helper.find_index(args.underlying, exchange=INDEX_EXCHANGE[args.underlying])
    if not sec:
        emit({'ok': False, 'error': f'index {args.underlying} not found'})
    today = datetime.now(IST).strftime('%Y-%m-%d')
    df = helper.get_intraday_minute_data(int(sec['SECURITY_ID']), 'IDX_I', 'INDEX', '1', today, today)
    if df is None or df.empty:
        emit({'ok': False, 'error': helper.last_api_error or 'no intraday bars yet'})
    bars = []
    for _, row in df.iterrows():
        ts = row.get('timestamp')
        if ts is None:
            continue
        t = datetime.fromtimestamp(float(ts), tz=IST)
        hm = t.strftime('%H:%M')
        if t.strftime('%Y-%m-%d') == today and '09:15' <= hm <= '15:29' and row.get('close'):
            bars.append([hm, float(row['close'])])
    emit({'ok': True, 'date': today, 'bars': bars})


if __name__ == '__main__':
    main()
