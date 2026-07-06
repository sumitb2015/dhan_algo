"""
Fetch current open F&O option positions with live LTPs and VIX via DhanHelper.

Prints one JSON line to stdout:
  { "has_positions": true, "net_premium": 79450.0, "vix": 13.4,
    "legs": [...], "timestamp": "2026-07-06T08:30:00+00:00" }

On error:
  { "error": "<reason>" }

Logs go to stderr.
"""
import sys
import os
import re
import json
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

VIX_ID = 21


def main():
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'error': 'auth_failed'}))
        return

    helper = DhanHelper(dhan)

    # Fetch positions
    pos_df = helper.get_positions()
    if pos_df is None or pos_df.empty:
        print(json.dumps({'has_positions': False, 'net_premium': 0, 'vix': 0, 'legs': [],
                          'timestamp': datetime.now(timezone.utc).isoformat()}))
        return

    # Filter to open option legs
    opt_rows = []
    for _, row in pos_df.iterrows():
        seg      = str(row.get('exchangeSegment', '') or '')
        opt_type = str(row.get('drvOptionType', '') or '')
        sym      = str(row.get('tradingSymbol', '') or '')
        qty      = int(row.get('netQty', 0) or 0)
        is_opt   = seg == 'NSE_FNO' and (
            opt_type in ('CALL', 'PUT') or bool(re.search(r'-(CE|PE)', sym, re.I))
        )
        if is_opt and qty != 0:
            opt_rows.append(row)

    if not opt_rows:
        print(json.dumps({'has_positions': False, 'net_premium': 0, 'vix': 0, 'legs': [],
                          'timestamp': datetime.now(timezone.utc).isoformat()}))
        return

    # Fetch LTPs for all option legs + VIX in one SDK call
    sec_ids = [int(row.get('securityId', 0)) for row in opt_rows if row.get('securityId')]
    ltp_map: dict = {}
    vix = 0.0

    try:
        securities = {'NSE_IDX': [VIX_ID]}
        if sec_ids:
            securities['NSE_FNO'] = sec_ids

        res = dhan.ohlc_data(securities=securities)
        if isinstance(res, dict) and res.get('status') == 'success':
            data = res.get('data', {})
            for sid, entry in (data.get('NSE_FNO') or {}).items():
                ltp_map[str(sid)] = float(entry.get('last_price', 0) or 0)
            idx_entry = (data.get('NSE_IDX') or {}).get(str(VIX_ID), {})
            vix = float(idx_entry.get('last_price', 0) or 0)
        else:
            print(f'WARN: ohlc_data status={res.get("status") if isinstance(res, dict) else res}',
                  file=sys.stderr)
    except Exception as e:
        print(f'WARN: ohlc_data failed: {e}', file=sys.stderr)

    # Build legs and compute net premium
    legs = []
    net_premium = 0.0

    for row in opt_rows:
        sid      = str(row.get('securityId', '') or '')
        qty      = int(row.get('netQty', 0) or 0)
        sym      = str(row.get('tradingSymbol', '') or '')
        side     = 'SELL' if qty < 0 else 'BUY'
        abs_qty  = abs(qty)
        ltp      = ltp_map.get(sid, 0.0)

        opt_type = str(row.get('drvOptionType', '') or '')
        if opt_type == 'CALL':
            cepe = 'CE'
        elif opt_type == 'PUT':
            cepe = 'PE'
        else:
            cepe = 'CE' if re.search(r'-CE', sym, re.I) else 'PE'

        strike      = float(row.get('drvStrikePrice', 0) or 0)
        entry_price = float(row.get('sellAvg', 0) or 0) if side == 'SELL' \
                      else float(row.get('buyAvg', 0) or 0)

        if side == 'SELL':
            net_premium += ltp * abs_qty
        else:
            net_premium -= ltp * abs_qty

        pnl = (entry_price - ltp) * abs_qty if side == 'SELL' else (ltp - entry_price) * abs_qty

        legs.append({
            'symbol':     sym,
            'strike':     strike,
            'type':       cepe,
            'side':       side,
            'ltp':        round(ltp, 2),
            'entryPrice': round(entry_price, 2),
            'pnl':        round(pnl, 2),
            'netQty':     qty,
        })

    print(json.dumps({
        'has_positions': len(legs) > 0,
        'net_premium':   round(net_premium, 2),
        'vix':           round(vix, 2),
        'legs':          legs,
        'timestamp':     datetime.now(timezone.utc).isoformat(),
    }))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
