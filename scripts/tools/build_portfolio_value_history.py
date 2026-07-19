"""
Reconstructs historical portfolio value using REAL trade history, instead of assuming today's
holding quantities applied throughout the backfill window (which is wrong whenever positions were
built up or trimmed during the window — see debug/portfolio_value_history.json for the forward-only
daily-snapshot tracker this complements).

For each currently-held symbol, walks the actual buy/sell trades (matched by ISIN, across any *_EQ
exchange segment) to compute the quantity held on each historical date, then values that quantity at
the symbol's actual historical close price from Daily_Historical_Data_Fresh/. Symbols with no
downloaded price history (e.g. LIQUIDBEES, a liquid/money-market ETF not part of the Nifty 500
universe this app tracks) fall back to a fixed annual accrual rate discounted from today's value.

Only reconstructs the CURRENT holdings basket — positions fully exited before today aren't included,
since they're not part of what the live dashboard displays today.

Called on-demand from the Reports page (like the other portfolio_* reports) since it makes ~150+
paginated trade-history API calls and takes a while. Writes debug/portfolio_value_history_reconstructed.json
for the Next.js dashboard to read.
"""
import sys
import os
import json
import time
from datetime import datetime, timezone, timedelta

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from scripts.tools.get_holdings_data import classify_asset

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.path.join(PROJECT_ROOT, 'Daily_Historical_Data_Fresh')
DEBUG_DIR = os.path.join(PROJECT_ROOT, 'debug')
OUTPUT_FILE = os.path.join(DEBUG_DIR, 'portfolio_value_history_reconstructed.json')
TRACKED_FILE = os.path.join(DEBUG_DIR, 'portfolio_value_history.json')

IST = timezone(timedelta(hours=5, minutes=30))
BACKFILL_FROM = '2026-04-01'
NO_HISTORY_ANNUAL_ACCRUAL_RATE = 0.065
PAGE_DELAY_SECONDS = 0.3  # unpaced pagination returns flaky/incomplete pages under this API


def fetch_all_trades(dhan, from_date: str, to_date: str) -> pd.DataFrame:
    rows = []
    page = 0
    while True:
        res = dhan.get_trade_history(from_date, to_date, page)
        data = res.get('data', []) if isinstance(res, dict) else []
        if not data:
            break
        rows.extend(data)
        page += 1
        if page > 500:
            print(f"[build_portfolio_value_history] safety cap hit at page {page}", file=sys.stderr)
            break
        time.sleep(PAGE_DELAY_SECONDS)
    return pd.DataFrame(rows)


def load_symbol_csv(symbol: str):
    path = os.path.join(DATA_DIR, f'{symbol}_Daily_2Y.csv')
    if not os.path.exists(path):
        return None
    # Some downloaded CSVs have a malformed trailing row (extra field) from a live-quote patch bug —
    # skip unparseable rows rather than failing the whole file.
    try:
        df = pd.read_csv(path, on_bad_lines='skip', engine='python')
    except Exception:
        return None
    if 'Close' not in df.columns:
        return None
    date_col = 'Datetime' if 'Datetime' in df.columns else df.columns[0]
    df = df.copy()
    df['date'] = df[date_col].astype(str).str.slice(0, 10)
    df['Close'] = pd.to_numeric(df['Close'], errors='coerce')
    df = df.dropna(subset=['Close'])
    return dict(zip(df['date'], df['Close'].astype(float)))


def build_qty_checkpoints(eq_trades: pd.DataFrame, isin: str, current_qty: float):
    """Returns (qty_before_window, [(date, qty_after_that_date's_trades), ...] sorted ascending)."""
    sym_trades = eq_trades[eq_trades['isin'] == isin]
    if sym_trades.empty:
        return current_qty, []

    sym_trades = sym_trades.assign(date=sym_trades['exchangeTime'].astype(str).str.slice(0, 10))
    sym_trades = sym_trades.sort_values('exchangeTime')

    net_signed = 0.0
    for _, r in sym_trades.iterrows():
        signed = r['tradedQuantity'] if r['transactionType'] == 'BUY' else -r['tradedQuantity']
        net_signed += signed
    qty_before_window = current_qty - net_signed

    running = qty_before_window
    checkpoints = []
    for date, group in sym_trades.groupby('date', sort=True):
        for _, r in group.iterrows():
            running += r['tradedQuantity'] if r['transactionType'] == 'BUY' else -r['tradedQuantity']
        checkpoints.append((date, running))
    checkpoints.sort(key=lambda c: c[0])
    return qty_before_window, checkpoints


def qty_as_of(date: str, qty_before_window: float, checkpoints: list) -> float:
    qty = qty_before_window
    for cp_date, cp_qty in checkpoints:
        if cp_date <= date:
            qty = cp_qty
        else:
            break
    return qty


def accrued_price(current_price: float, date: str, as_of_date: str, rate: float = NO_HISTORY_ANNUAL_ACCRUAL_RATE) -> float:
    d1 = datetime.strptime(date, '%Y-%m-%d')
    d2 = datetime.strptime(as_of_date, '%Y-%m-%d')
    years = (d2 - d1).days / 365.0
    if years <= 0:
        return current_price
    return current_price / ((1 + rate) ** years)


def main():
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"success": False, "error": "Failed to authenticate with Dhan"}))
        sys.exit(1)

    helper = DhanHelper(dhan)
    today = datetime.now(IST).strftime('%Y-%m-%d')

    df_holdings = helper.get_holdings()
    if df_holdings.empty:
        print(json.dumps({"success": False, "error": "No holdings found"}))
        sys.exit(1)

    if 'lastTradedPrice' not in df_holdings.columns:
        for alias in ('lastPrice', 'currentMarketPrice', 'ltp'):
            if alias in df_holdings.columns:
                df_holdings['lastTradedPrice'] = df_holdings[alias]
                break
    if 'lastTradedPrice' not in df_holdings.columns:
        df_holdings['lastTradedPrice'] = 0.0

    holdings = []
    for _, row in df_holdings.iterrows():
        qty = int(row.get('totalQty', 0) or 0)
        if qty <= 0:
            continue
        symbol = str(row.get('tradingSymbol', '')).removesuffix('-EQ')
        avg_cost = float(row.get('avgCostPrice', 0) or 0)
        ltp = float(row.get('lastTradedPrice', 0) or 0) or avg_cost
        holdings.append({
            'symbol': symbol,
            'isin': str(row.get('isin', '')),
            'qty': qty,
            'currentPrice': ltp,
            'assetType': classify_asset(symbol),
        })

    print(f"[build_portfolio_value_history] fetching trade history {BACKFILL_FROM}..{today}", file=sys.stderr)
    all_trades = fetch_all_trades(dhan, BACKFILL_FROM, today)
    eq_trades = pd.DataFrame()
    if not all_trades.empty and 'exchangeSegment' in all_trades.columns:
        eq_trades = all_trades[all_trades['exchangeSegment'].astype(str).str.endswith('_EQ')]
    print(f"[build_portfolio_value_history] {len(all_trades)} total trades, {len(eq_trades)} equity/ETF trades", file=sys.stderr)

    tracked_dates = set()
    if os.path.exists(TRACKED_FILE):
        try:
            tracked = json.load(open(TRACKED_FILE, encoding='utf-8')).get('history', [])
            tracked_dates = {t['date'] for t in tracked}
        except Exception:
            pass

    per_symbol = []
    all_dates = set()
    for h in holdings:
        qty_before_window, checkpoints = build_qty_checkpoints(eq_trades, h['isin'], h['qty'])
        price_map = load_symbol_csv(h['symbol'])
        if price_map is not None:
            price_map = {d: c for d, c in price_map.items() if d >= BACKFILL_FROM}
            all_dates.update(price_map.keys())
        per_symbol.append({**h, 'qty_before_window': qty_before_window, 'checkpoints': checkpoints, 'price_map': price_map})

    dates = sorted(d for d in all_dates if d >= BACKFILL_FROM and d not in tracked_dates)

    points = []
    for date in dates:
        total = 0.0
        equity_total = 0.0
        etf_total = 0.0
        for h in per_symbol:
            qty = qty_as_of(date, h['qty_before_window'], h['checkpoints'])
            if qty <= 0:
                continue
            if h['price_map'] is not None and date in h['price_map']:
                price = h['price_map'][date]
            else:
                price = accrued_price(h['currentPrice'], date, today)
            value = qty * price
            total += value
            if h['assetType'] == 'ETF':
                etf_total += value
            else:
                equity_total += value
        points.append({
            'date': date,
            'totalCurrentValue': round(total, 2),
            'equityValue': round(equity_total, 2),
            'etfValue': round(etf_total, 2),
            'synthetic': True,
        })

    output = {
        'generatedAt': datetime.now().isoformat(),
        'backfillFrom': BACKFILL_FROM,
        'tradesUsed': int(len(eq_trades)),
        'symbolsReconstructed': len(holdings),
        'points': points,
    }
    os.makedirs(DEBUG_DIR, exist_ok=True)
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(output, f)

    print(json.dumps({'success': True, 'points': len(points), 'tradesUsed': len(eq_trades)}))


if __name__ == '__main__':
    main()
