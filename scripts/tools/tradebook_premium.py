"""
Outputs minute-by-minute combined open sell premium (mark-to-market).
Uses the positions API for correct net lots, and 1-min candle closes for prices.
The tradebook is only used to find entry minutes for currently-open positions.
current_premium uses live LTPs (not candle closes) for accuracy.
"""
import sys
import os
import json
import time
from datetime import datetime, date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

SESSION_START = "09:15"
SESSION_END   = "15:30"


def get_trade_minute(trade: dict) -> str:
    raw = trade.get('exchangeTime') or trade.get('createTime') or ''
    try:
        for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%dT%H:%M:%S'):
            try:
                return datetime.strptime(raw[:19], fmt).strftime('%H:%M')
            except ValueError:
                continue
    except Exception:
        pass
    return raw[11:16] if len(raw) >= 16 else SESSION_START


def build_minute_list(is_post_session: bool) -> list[str]:
    now_str  = datetime.now().strftime('%H:%M')
    end_str  = SESSION_END if is_post_session or now_str >= SESSION_END else now_str
    start_dt = datetime.strptime(SESSION_START, '%H:%M')
    end_dt   = datetime.strptime(end_str, '%H:%M')
    minutes: list[str] = []
    current = start_dt
    while current <= end_dt:
        minutes.append(current.strftime('%H:%M'))
        current += timedelta(minutes=1)
    return minutes


def fetch_price_series(
    helper: DhanHelper,
    sid: str,
    instrument: str,
    today: str,
    all_minutes: list[str],
) -> dict[str, float]:
    """Fetch 1-min candles for a security and forward-fill into a {HH:MM: close} map."""
    try:
        df = helper.get_intraday_minute_data(
            security_id=sid,
            exchange_segment='NSE_FNO',
            instrument_type=instrument,
            interval='1',
            from_date=today,
            to_date=today,
        )
    except Exception:
        return {}

    if df.empty or 'close' not in df.columns or 'timestamp' not in df.columns:
        return {}

    raw: dict[str, float] = {}
    for _, row in df.iterrows():
        try:
            dt  = datetime.fromtimestamp(int(row['timestamp']))
            raw[dt.strftime('%H:%M')] = float(row['close'])
        except Exception:
            continue

    filled: dict[str, float] = {}
    last = 0.0
    for m in all_minutes:
        if m in raw:
            last = raw[m]
        filled[m] = last
    return filled


def main() -> None:
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'success': False, 'error': 'Failed to authenticate'}))
        sys.exit(1)

    helper = DhanHelper(dhan)
    today  = date.today().isoformat()

    trades     = helper.get_trade_book()
    fno_trades = [t for t in trades if t.get('exchangeSegment') == 'NSE_FNO']

    # ── Lot size / instrument helpers ────────────────────────────────────
    master        = helper._load_master_list()
    master_by_sid = master.copy()
    master_by_sid['_sid_str'] = master_by_sid['SECURITY_ID'].astype(str)
    master_by_sid = master_by_sid.set_index('_sid_str')

    _lot_cache: dict[str, float] = {}

    def get_lot_size(sid: str, trading_symbol: str = '') -> float:
        try:
            val = master_by_sid.loc[sid, 'LOT_SIZE']
            if hasattr(val, 'iloc'):
                val = val.iloc[0]
            lot = float(val)
            if lot > 1:
                return lot
        except (KeyError, TypeError, ValueError):
            pass
        underlying = trading_symbol.split('-')[0] if trading_symbol else ''
        if underlying:
            if underlying not in _lot_cache:
                try:
                    _lot_cache[underlying] = float(helper.get_lot_size(underlying))
                except Exception:
                    _lot_cache[underlying] = 1.0
            return _lot_cache[underlying]
        return 1.0

    def get_instrument(sid: str) -> str:
        try:
            val = master_by_sid.loc[sid, 'INSTRUMENT']
            if hasattr(val, 'iloc'):
                val = val.iloc[0]
            return str(val)
        except (KeyError, TypeError):
            return 'OPTIDX'

    def short_name(sym: str) -> str:
        parts = sym.split('-')
        return f"{parts[-2]} {parts[-1]}" if len(parts) >= 2 else sym

    # ── Current open SELL positions (source of truth for lots) ───────────
    pos_df = helper.get_positions()
    open_positions: list[dict] = []
    if pos_df is not None and not pos_df.empty:
        for _, row in pos_df.iterrows():
            if str(row.get('exchangeSegment', '')) != 'NSE_FNO':
                continue
            qty = int(row.get('netQty', 0) or 0)
            if qty >= 0:
                continue
            sid = str(row.get('securityId', '') or '')
            sym = str(row.get('tradingSymbol', '') or '')
            ls  = get_lot_size(sid, sym)
            open_positions.append({'sid': sid, 'sym': sym, 'lots': abs(qty) / ls})

    if not open_positions:
        print(json.dumps({
            'success': True, 'data': [], 'by_symbol': {}, 'symbols': [],
            'current_premium': 0.0, 'session_date': today,
            'trades_count': len(fno_trades),
        }))
        return

    # ── Find each position's entry minute from the tradebook ─────────────
    fno_trades.sort(key=lambda t: (t.get('exchangeTime') or t.get('createTime') or ''))
    open_sid_set = {p['sid'] for p in open_positions}
    entry_minutes: dict[str, str] = {}
    for trade in fno_trades:
        sid = str(trade.get('securityId', ''))
        if sid in open_sid_set and trade.get('transactionType') == 'SELL':
            if sid not in entry_minutes:
                entry_minutes[sid] = get_trade_minute(trade)
    for p in open_positions:
        entry_minutes.setdefault(p['sid'], SESSION_START)

    # ── Minute list ───────────────────────────────────────────────────────
    now_hm  = datetime.now().strftime('%H:%M')
    is_post = now_hm > SESSION_END
    all_minutes = build_minute_list(is_post)

    # ── Fetch 1-min candles for each currently-open security ─────────────
    price_maps: dict[str, dict[str, float]] = {}
    for p in open_positions:
        price_maps[p['sid']] = fetch_price_series(
            helper, p['sid'], get_instrument(p['sid']), today, all_minutes,
        )
        time.sleep(0.3)

    # ── Combined series: open positions × candle closes since entry ───────
    series: list[dict] = []
    for minute in all_minutes:
        combined = 0.0
        for p in open_positions:
            if entry_minutes[p['sid']] > minute:
                continue
            combined += p['lots'] * price_maps.get(p['sid'], {}).get(minute, 0.0)
        series.append({'time': minute, 'premium': round(combined, 2)})

    # ── Per-symbol series ─────────────────────────────────────────────────
    by_symbol: dict[str, list[dict]] = {}
    for p in open_positions:
        entry_min = entry_minutes[p['sid']]
        sym_series: list[dict] = []
        for minute in all_minutes:
            if entry_min > minute:
                sym_series.append({'time': minute, 'premium': 0.0})
                continue
            price = price_maps.get(p['sid'], {}).get(minute, 0.0)
            sym_series.append({'time': minute, 'premium': round(p['lots'] * price, 2)})
        by_symbol[p['sym']] = sym_series

    symbols = sorted(
        [{'securityId': p['sid'], 'tradingSymbol': p['sym'], 'displayName': short_name(p['sym'])}
         for p in open_positions],
        key=lambda s: s['displayName'],
    )

    # ── current_premium: positions × live LTP (not candle closes) ────────
    current_premium = 0.0
    try:
        pos_sids = [int(p['sid']) for p in open_positions if p['sid']]
        pos_ltp_map: dict[str, float] = {}
        if pos_sids:
            ltp_res = dhan.ohlc_data(securities={'NSE_FNO': pos_sids})
            if isinstance(ltp_res, dict) and ltp_res.get('status') == 'success':
                ltp_data = ltp_res.get('data') or {}
                if 'data' in ltp_data:
                    ltp_data = ltp_data['data']
                for k, v in (ltp_data.get('NSE_FNO') or {}).items():
                    pos_ltp_map[str(k)] = float(v.get('last_price', 0) or 0)
        for p in open_positions:
            current_premium += p['lots'] * pos_ltp_map.get(p['sid'], 0.0)
    except Exception as e:
        print(f'WARN: current_premium LTP fetch failed: {e}', file=sys.stderr)
    current_premium = round(current_premium, 2)

    print(json.dumps({
        'success':         True,
        'data':            series,
        'by_symbol':       by_symbol,
        'symbols':         symbols,
        'current_premium': current_premium,
        'session_date':    today,
        'trades_count':    len(fno_trades),
    }))


if __name__ == '__main__':
    main()
