"""
Fetches trades and computes realized P&L per segment (and per symbol within each segment).
F&O/Commodity use FIFO lot matching (each SELL matched against the oldest open BUY lot, or vice versa
for a short) — same-day round trips have no cost-basis ambiguity, and FIFO matched Dhan's own Trader's
Diary figures closely. Equity uses day-priority matching instead (see day_priority_match): same-day
buys matched against same-day sells first, remainder against the carried position at weighted-average
cost — selected empirically as the closest reproduction of Dhan's own published monthly figures (July
2026 matched to Rs 0.17). Any quantity left over at the end (still open) is reported separately, not
folded into "realized".

Equity can't legitimately go short (delivery), so an unmatched SELL there means inventory existed
before whatever window we fetched — its exit P&L would be silently excluded. To avoid that, equity
trades are fetched over a much longer lookback (EQUITY_LOOKBACK_DAYS, default ~2 years) than
F&O/commodity (DEFAULT_FROM_DATE, default Apr 1) in the SAME paginated fetch — one call covering the
longer range. That longer history is used ONLY to resolve correct FIFO cost basis; the REPORTED
realized P&L for every segment (including equity) is still filtered to DEFAULT_FROM_DATE..today, so
"Overall Net P&L" reflects one consistent reporting period rather than mixing years-old, already-closed
equity round trips into a total that's otherwise scoped to the last ~3.5 months.

Charges (brokerage, STT, exchange fees, stamp duty, SEBI/service tax) are summed per trade and
subtracted to get a net P&L, since gross realized P&L alone overstates what was actually earned.

Called on-demand from the Reports page — this account is F&O-heavy enough that a 2-year fetch can
mean many thousands of trades and 10+ minutes of paginated calls. Writes
debug/portfolio_trade_history.json for the /portfolio/trades dashboard page to read.
"""
import sys
import os
import json
import time
from collections import defaultdict
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEBUG_DIR = os.path.join(PROJECT_ROOT, 'debug')
OUTPUT_FILE = os.path.join(DEBUG_DIR, 'portfolio_trade_history.json')
SYNC_STATUS_FILE = os.path.join(DEBUG_DIR, 'portfolio_trades_sync_status.json')

IST = timezone(timedelta(hours=5, minutes=30))
DEFAULT_FROM_DATE = '2026-04-01'   # F&O / Commodity window — these square off same-day, so this is complete
EQUITY_LOOKBACK_DAYS = 730          # ~2 years — equity positions can be held far longer than F&O/commodity
PAGE_DELAY_SECONDS = 0.3            # unpaced pagination returns flaky/incomplete pages under this API

SEGMENT_MAP = {
    'NSE_EQ': 'EQUITY', 'BSE_EQ': 'EQUITY',
    'NSE_FNO': 'FNO', 'BSE_FNO': 'FNO',
    'MCX_COMM': 'COMMODITY', 'NSE_COMM': 'COMMODITY',
}

# Dhan's security master occasionally reassigns a security ID for the same underlying instrument
# (e.g. an AMC rebrand). Confirmed manually per-pair — NOT a fuzzy name-match, since that risks
# merging genuinely different securities. Only add an entry here once you've verified (via offsetting
# open quantities, matching ISIN, etc.) that both IDs really are the same holding.
SECURITY_ID_MERGES = {
    # Nippon Nifty 50 ETF (NIFTYBEES): old ID 590103 -> current ID 10576. Confirmed 2026-07-18 — a
    # BUY 500 under 590103 and an unmatched SELL of the same 500 under 10576 (offsetting open qty).
    '590103': '10576',
}

CHARGE_FIELDS = ['sebiTax', 'stt', 'brokerageCharges', 'serviceTax', 'exchangeTransactionCharges', 'stampDuty']

# Dhan's own "Trader's Diary" widget shows a "Charges" figure that EXCLUDES brokerage — confirmed by
# brute-forcing all field-subset combinations against 4 months of known totals (April-July 2026): this
# exact subset reproduced Dhan's displayed Charges column to within a few paise every month, while
# Net P&L still nets out ALL charges including brokerage (Overall - Net == the FULL charge total, not
# this subset). So: netPnl = grossPnl - full charges (all 6 fields); the separately-tracked
# "statutoryCharges" (this subset) is only for matching what Dhan's UI *displays* as "Charges".
STATUTORY_CHARGE_FIELDS = ['sebiTax', 'stt', 'serviceTax', 'exchangeTransactionCharges', 'stampDuty']


def write_sync_status(error: str = None) -> None:
    """Stamp the sync-status file the dashboard polls. `error` is surfaced verbatim in the UI so a
    broker-side outage reads as "sync failed" instead of silently stale data."""
    try:
        os.makedirs(DEBUG_DIR, exist_ok=True)
        status = {}
        if os.path.exists(SYNC_STATUS_FILE):
            try:
                status = json.load(open(SYNC_STATUS_FILE, encoding='utf-8')) or {}
            except Exception:
                status = {}
        status.update({'done': True, 'finished': datetime.now().isoformat(), 'error': error})
        with open(SYNC_STATUS_FILE, 'w', encoding='utf-8') as f:
            json.dump(status, f)
    except Exception as e:
        print(f"[get_trade_pnl_by_segment] could not write sync status: {e}", file=sys.stderr)


class TradeFetchError(RuntimeError):
    """Dhan's /trades endpoint returned an error rather than an empty page."""


def fetch_all_trades(dhan, from_date: str, to_date: str) -> list:
    rows = []
    page = 0
    while True:
        res = dhan.get_trade_history(from_date, to_date, page)
        # An API failure and a genuinely empty page both arrive as an empty `data` list. Treating the
        # former as "no more pages" is what silently froze the dashboard at the last good sync (and, on
        # an incremental run, dropped the refetched boundary day's trades outright) — so fail loudly.
        if isinstance(res, dict) and res.get('status') == 'failure':
            remarks = res.get('remarks')
            detail = remarks if isinstance(remarks, str) else json.dumps(remarks or {})
            raise TradeFetchError(
                f"Dhan /trades {from_date}..{to_date} page {page} failed: {detail}")
        data = res.get('data', []) if isinstance(res, dict) else []
        if not data:
            break
        rows.extend(data)
        page += 1
        if page % 50 == 0:
            print(f"[get_trade_pnl_by_segment] ...{page} pages, {len(rows)} trades so far", file=sys.stderr)
        if page > 3000:
            print(f"[get_trade_pnl_by_segment] safety cap hit at page {page}", file=sys.stderr)
            break
        time.sleep(PAGE_DELAY_SECONDS)
    return rows


def fetch_today_trade_book(dhan, helper=None) -> list:
    """get_trade_history (used by fetch_all_trades) reflects settled/contract-note trades and lags
    same-day fills — Dhan typically doesn't surface today's trades there until EOD processing. get_trade_book
    (no date range) has no such lag: it returns today's executed trades live. Overlaying it is what makes
    today's trades show up in the dashboard immediately instead of only after next day's sync."""
    try:
        res = dhan.get_trade_book()
        if isinstance(res, dict) and res.get('status') == 'failure':
            print(f"[get_trade_pnl_by_segment] trade book returned failure: {res.get('remarks')}", file=sys.stderr)
            return []
        data = res.get('data', []) if isinstance(res, dict) else []
        if not isinstance(data, list):
            return []
        # customSymbol is null on trade-book rows (only populated once contract notes settle).
        # It MUST resolve to the same string get_trade_history's settled customSymbol uses for
        # the same securityId — process_segment_trades groups FNO/COMMODITY trades by
        # (securityId, customSymbol), and Dhan's own raw tradingSymbol ("NIFTY 22 SEP 24700 CALL")
        # does not match the settled customSymbol format ("NIFTY-Sep2026-24700-CE") for the same
        # contract. That split a still-open prior-day position from its same-day closing trade into
        # two separate FIFO groups, silently stranding real closed-today P&L as "still open" —
        # confirmed live on 2026-09-04: one contract's ~Rs 1,060 same-day realized gain vanished
        # from the day's total this way. Resolve the settled-format symbol from the master list by
        # securityId instead, so a trade-book row's key always matches its later settled counterpart.
        # tradingSymbol is now only a last-resort fallback if the master-list lookup itself fails.
        for t in data:
            if t.get('customSymbol'):
                continue
            resolved = _lookup_symbol_name(helper, t.get('securityId')) if helper is not None else None
            t['customSymbol'] = resolved or t.get('tradingSymbol', '')
        return data
    except Exception as e:
        print(f"[get_trade_pnl_by_segment] trade book fetch failed: {e}", file=sys.stderr)
        return []


def _lookup_symbol_name(helper, security_id) -> str:
    """Settled-format display symbol (e.g. "NIFTY-Sep2026-24700-CE") for a raw securityId, from the
    master list DhanHelper already holds in memory — same access pattern as
    scripts/tools/live_options_tracker.py's get_valid_expiries(). Returns '' on any failure (missing
    id, master list not loaded, wrong dtype) so callers can fall back without this raising."""
    try:
        sid = int(security_id)
        ml = helper._master_list
        match = ml.loc[ml['SECURITY_ID'] == sid, 'SYMBOL_NAME']
        return str(match.iloc[0]) if not match.empty else ''
    except Exception:
        return ''


def merge_live_trades(existing: list, live: list) -> list:
    """Append live trade-book rows not already present in existing (deduped by exchangeTradeId)."""
    seen = {t.get('exchangeTradeId') for t in existing if t.get('exchangeTradeId')}
    merged = list(existing)
    for t in live:
        tid = t.get('exchangeTradeId')
        if tid and tid in seen:
            continue
        merged.append(t)
        if tid:
            seen.add(tid)
    return merged


def trade_charges(t: dict) -> float:
    return sum(float(t.get(f) or 0) for f in CHARGE_FIELDS)


def trade_statutory_charges(t: dict) -> float:
    return sum(float(t.get(f) or 0) for f in STATUTORY_CHARGE_FIELDS)


def annotate_trades(trades: list) -> None:
    """Attach segment/charges/merged securityId — the fields the compute pipeline expects on raw API rows."""
    for t in trades:
        t['segment'] = SEGMENT_MAP.get(t.get('exchangeSegment'), 'OTHER')
        t['charges'] = round(trade_charges(t), 2)
        t['statutoryCharges'] = round(trade_statutory_charges(t), 2)
        t['securityId'] = SECURITY_ID_MERGES.get(str(t.get('securityId', '')), str(t.get('securityId', '')))
        # Normalize here, once, so every downstream consumer (merge_live_trades' dedup,
        # the persisted trade log) can just read t['exchangeTradeId'] — Dhan's settled
        # trade-history endpoint and its live trade-book endpoint don't reliably agree on
        # which of these two field names carries the id (scripts/tools/get_crudeoil_trades_data.py
        # and get_holdings_data.py already carry this same fallback for that reason).
        t['exchangeTradeId'] = str(t.get('exchangeTradeId') or t.get('tradeId') or '')


def log_entry_to_internal(t: dict) -> dict:
    """Convert a stored trade-log entry (display shape) back to the internal/raw-ish shape the compute
    pipeline uses — enables incremental sync to reuse stored trades without refetching 2 years of data.

    Must carry exchangeTradeId through this round-trip: merge_live_trades() dedupes today's re-fetched
    live trade-book rows against this reloaded set by exchangeTradeId, and a stored entry with none of
    its own can never match, so the same trade gets appended again on the next incremental sync. This
    is not hypothetical — it duplicated a real SELL and a real BUY in production (see debug output from
    the 2026-09-02 Trader's Diary showing 28 trades where only 26 were genuinely distinct).
    """
    return {
        'exchangeTime': t.get('time', ''),
        'segment': t.get('segment', 'OTHER'),
        'customSymbol': t.get('symbol', ''),
        'securityId': str(t.get('securityId', '')),
        'transactionType': t.get('transactionType', ''),
        'tradedQuantity': t.get('quantity', 0),
        'tradedPrice': t.get('price', 0),
        'charges': t.get('charges', 0.0),
        'statutoryCharges': t.get('statutoryCharges', 0.0),
        'productType': t.get('productType', ''),
        'drvOptionType': t.get('optionType') if t.get('optionType') else 'NA',
        'drvStrikePrice': t.get('strikePrice') or 0.0,
        'drvExpiryDate': t.get('expiryDate') if t.get('expiryDate') else 'NA',
        'exchangeTradeId': t.get('exchangeTradeId') or '',
    }


def fifo_match(trades: list):
    """
    trades: list of dicts sorted by exchangeTime ascending, each with transactionType/tradedQuantity/tradedPrice.
    Returns (events, open_qty, open_avg_price, opened_unmatched_sell) where open_qty > 0 is a long lot,
    < 0 is a short lot. events is a list of (date, realized_amount, realized_charges, realized_stat_charges)
    — one per closing match, dated by the CLOSING trade (not the entry) so callers can filter realized P&L
    to a reporting window while still using the full trade list to resolve correct cost basis.
    opened_unmatched_sell is True if a SELL was ever seen with no long lot to match against — for equity
    that means inventory existed before the fetched range (can't legitimately short equity delivery),
    so P&L for that portion is missing the entry cost this function has no visibility into.
    """
    lots = []  # [qty, price, charges_per_unit, stat_charges_per_unit] — qty > 0 = long lot, qty < 0 = short lot
    events = []
    opened_unmatched_sell = False

    for t in trades:
        qty = float(t['tradedQuantity'])
        price = float(t['tradedPrice'])
        is_buy = t['transactionType'] == 'BUY'
        remaining = qty
        date = (t.get('exchangeTime') or '')[:10]

        total_charges = float(t.get('charges') or 0.0)
        total_stat_charges = float(t.get('statutoryCharges') or 0.0)
        cpu = total_charges / qty if qty > 0 else 0.0
        scpu = total_stat_charges / qty if qty > 0 else 0.0

        # Match against opposite-side open lots first (closes existing position)
        while remaining > 1e-9 and lots and ((lots[0][0] < 0) if is_buy else (lots[0][0] > 0)):
            lot_qty, lot_price, lot_cpu, lot_scpu = lots[0]
            matched = min(remaining, abs(lot_qty))
            if is_buy:
                realized = matched * (lot_price - price)  # covering a short: profit = sold_high - bought_low
                lot_qty += matched
            else:
                realized = matched * (price - lot_price)  # closing a long: profit = sold_high - bought_low
                lot_qty -= matched
            
            matched_charges = matched * (lot_cpu + cpu)
            matched_stat_charges = matched * (lot_scpu + scpu)
            events.append((date, realized, matched_charges, matched_stat_charges))
            remaining -= matched
            if abs(lot_qty) < 1e-9:
                lots.pop(0)
            else:
                lots[0][0] = lot_qty

        if remaining > 1e-9:
            if not is_buy:
                opened_unmatched_sell = True
            lots.append([remaining if is_buy else -remaining, price, cpu, scpu])

    open_qty = sum(q for q, _, _, _ in lots)
    open_cost = sum(q * p for q, p, _, _ in lots)
    open_avg_price = (open_cost / open_qty) if abs(open_qty) > 1e-9 else 0.0
    return events, open_qty, open_avg_price, opened_unmatched_sell


def day_priority_match(trades: list):
    """
    Equity accounting that reproduces Dhan's own Trader's Diary numbers most closely: within each day
    per scrip, SELLs are matched against SAME-DAY BUYs first (chronological FIFO — same-day round trips
    net out as intraday P&L regardless of CNC/INTRADAY product type), and only the remainder hits the
    carried delivery position at its weighted-average cost. Leftover day buys then merge into the carried
    average. Selected empirically: tested FIFO, plain weighted-average, productType-split, and this
    day-priority model against Dhan's published monthly gross P&L (Apr-Jul 2026) — day-priority matched
    July to Rs 0.17 and cut total 4-month error to ~Rs 2.9K (from ~Rs 8.6K for plain avg-cost, ~Rs 23K
    for FIFO). The small residual left is a month-boundary allocation split on scrips sold across two
    months (offsetting +/- ~Rs 1.1K in Apr/May) — same totals, different monthly split, unresolvable
    from trade records alone. Returns the same shape as fifo_match.
    """
    events = []
    carry_qty = 0.0
    carry_ac = 0.0
    carry_cpu = 0.0
    carry_scpu = 0.0
    opened_unmatched_sell = False

    by_day = defaultdict(list)
    for t in trades:
        by_day[(t.get('exchangeTime') or '')[:10]].append(t)

    for date in sorted(by_day):
        day = sorted(by_day[date], key=lambda t: t.get('exchangeTime') or '')
        day_buy_lots = []   # [qty, price, charges_per_unit, stat_charges_per_unit] — chronological
        day_sells = []      # [qty, price, charges_per_unit, stat_charges_per_unit]
        for t in day:
            q = float(t['tradedQuantity'])
            p = float(t['tradedPrice'])
            total_charges = float(t.get('charges') or 0.0)
            total_stat_charges = float(t.get('statutoryCharges') or 0.0)
            cpu = total_charges / q if q > 0 else 0.0
            scpu = total_stat_charges / q if q > 0 else 0.0

            if t['transactionType'] == 'BUY':
                day_buy_lots.append([q, p, cpu, scpu])
            else:
                day_sells.append([q, p, cpu, scpu])

        for sq, sp, scpu, s_scpu in day_sells:
            remaining = sq
            while remaining > 1e-9 and day_buy_lots:
                lot_qty, lot_price, lot_cpu, lot_scpu = day_buy_lots[0]
                matched = min(remaining, lot_qty)
                realized = matched * (sp - lot_price)
                matched_charges = matched * (scpu + lot_cpu)
                matched_stat_charges = matched * (s_scpu + lot_scpu)
                events.append((date, realized, matched_charges, matched_stat_charges))
                
                lot_qty -= matched
                remaining -= matched
                if lot_qty < 1e-9:
                    day_buy_lots.pop(0)
                else:
                    day_buy_lots[0][0] = lot_qty
            if remaining > 1e-9:
                sell = min(remaining, carry_qty)
                if sell > 1e-9:
                    realized = sell * (sp - carry_ac)
                    matched_charges = sell * (scpu + carry_cpu)
                    matched_stat_charges = sell * (s_scpu + carry_scpu)
                    events.append((date, realized, matched_charges, matched_stat_charges))
                    carry_qty -= sell
                remaining -= sell
                if remaining > 1e-9:
                    # sold more than day buys + carried position — inventory predates the fetched range
                    opened_unmatched_sell = True
                    carry_qty -= remaining

        for lot_qty, lot_price, lot_cpu, lot_scpu in day_buy_lots:
            new_qty = carry_qty + lot_qty
            if new_qty > 1e-9:
                carry_ac = (max(carry_qty, 0.0) * carry_ac + lot_qty * lot_price) / new_qty
                carry_cpu = (max(carry_qty, 0.0) * carry_cpu + lot_qty * lot_cpu) / new_qty
                carry_scpu = (max(carry_qty, 0.0) * carry_scpu + lot_qty * lot_scpu) / new_qty
            else:
                carry_ac = 0.0
                carry_cpu = 0.0
                carry_scpu = 0.0
            carry_qty = new_qty

    return events, carry_qty, carry_ac, opened_unmatched_sell


def process_segment_trades(by_security: dict, segment_totals: dict, symbol_rows: list,
                            open_positions_by_security: dict, report_from_date: str,
                            daily_events: list = None, matcher=fifo_match, segment_daily_events: dict = None):
    """
    report_from_date filters which realized events (and which trades' charges/counts) count toward the
    reporting totals — trades is the FULL trade list available for this security (may extend earlier,
    for cost-basis accuracy), but only events/trades dated >= report_from_date are counted. Symbols with
    no in-window activity and nothing currently open are skipped entirely (irrelevant to this report).
    If daily_events is passed, in-window (date, realized, charges, stat_charges) events are appended to it
    for the combined day-by-day P&L view (weekly/monthly diary), independent of the per-symbol/segment aggregation below.
    """
    for key, trades in by_security.items():
        if isinstance(key, tuple):
            sec_id, symbol = key
        else:
            sec_id = key
            symbol = trades[0].get('customSymbol', sec_id)

        trades = sorted(trades, key=lambda t: t.get('exchangeTime') or '')
        segment = trades[0]['segment']
        events, open_qty, open_avg_price, opened_unmatched_sell = matcher(trades)

        in_window_events = [(date, r, c, sc) for date, r, c, sc in events if date >= report_from_date]
        if daily_events is not None:
            daily_events.extend(in_window_events)
        if segment_daily_events is not None:
            segment_daily_events[segment].extend(in_window_events)
        realized = sum(r for _, r, _, _ in in_window_events)
        charges = sum(c for _, _, c, _ in in_window_events)
        statutory_charges = sum(sc for _, _, _, sc in in_window_events)
        window_trades = [t for t in trades if (t.get('exchangeTime') or '')[:10] >= report_from_date]
        trade_count = len(window_trades)

        if trade_count == 0 and abs(open_qty) < 1e-9:
            continue  # no activity in the reporting window and nothing currently open

        # Equity can't legitimately go short (delivery) — an unmatched SELL there means inventory
        # existed before the fetched range, so its realized P&L is missing that entry cost.
        # F&O/commodity going short mid-window is normal trading, not a gap, so this only applies to equity.
        pre_window_gap = segment == 'EQUITY' and opened_unmatched_sell

        seg = segment_totals[segment]
        seg['realizedPnl'] += realized
        seg['charges'] += charges
        seg['statutoryCharges'] += statutory_charges
        seg['tradeCount'] += trade_count
        seg['symbolCount'] += 1
        if pre_window_gap:
            seg['preWindowGapSymbols'] += 1

        open_unrealized = None
        if abs(open_qty) > 1e-9:
            pos = open_positions_by_security.get(sec_id)
            if pos:
                open_unrealized = pos['unrealizedProfit']
            if open_unrealized is not None:
                seg['openPositionsUnrealized'] += open_unrealized
                seg['openPositionsCount'] += 1

        symbol_rows.append({
            'securityId': sec_id,
            'symbol': symbol,
            'segment': segment,
            'tradeCount': trade_count,
            'realizedPnl': round(realized, 2),
            'charges': round(charges, 2),
            'statutoryCharges': round(statutory_charges, 2),
            'netRealizedPnl': round(realized - charges, 2),
            'openQty': round(open_qty, 4),
            'openAvgPrice': round(open_avg_price, 2) if abs(open_qty) > 1e-9 else None,
            'openUnrealizedPnl': round(open_unrealized, 2) if open_unrealized is not None else None,
            'preWindowGap': pre_window_gap,
        })


def main():
    args = [a for a in sys.argv[1:]]
    incremental = '--incremental' in args
    positional = [a for a in args if not a.startswith('--')]
    from_date = positional[0] if positional else DEFAULT_FROM_DATE

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"success": False, "error": "Failed to authenticate with Dhan"}))
        sys.exit(1)

    helper = DhanHelper(dhan)
    today_dt = datetime.now(IST)
    today = today_dt.strftime('%Y-%m-%d')

    if incremental and os.path.exists(OUTPUT_FILE):
        # Incremental sync: keep everything already stored before the last stored trade date, refetch
        # from that date (inclusive — it may have been synced mid-day) through today, and recompute.
        # Recompute is cheap (pure in-memory); only the API fetch is expensive, and it's now a few pages.
        stored = json.load(open(OUTPUT_FILE, encoding='utf-8'))
        from_date = stored.get('fromDate', from_date)
        equity_from_date = stored.get('equityFromDate', (today_dt - timedelta(days=EQUITY_LOOKBACK_DAYS)).strftime('%Y-%m-%d'))
        stored_trades = [log_entry_to_internal(t) for t in stored.get('trades', [])]
        resync_from = max((t['exchangeTime'][:10] for t in stored_trades), default=from_date)

        print(f"[get_trade_pnl_by_segment] incremental sync: refetching {resync_from}..{today} "
              f"({len(stored_trades)} stored trades kept before {resync_from})", file=sys.stderr)
        try:
            fetched = fetch_all_trades(dhan, resync_from, today)
        except TradeFetchError as e:
            # Abort WITHOUT rewriting OUTPUT_FILE — the merge below would otherwise drop the stored
            # boundary day's trades and present the truncated result as a successful sync.
            print(f"[get_trade_pnl_by_segment] {e}", file=sys.stderr)
            write_sync_status(str(e))
            print(json.dumps({'success': False, 'error': str(e)}))
            sys.exit(1)
        annotate_trades(fetched)
        # Drop the refetched boundary date from stored (it may have been partial) and merge
        all_trades = [t for t in stored_trades if t['exchangeTime'][:10] < resync_from] + \
                     [t for t in fetched if (t.get('exchangeTime') or '')[:10] >= resync_from]
        print(f"[get_trade_pnl_by_segment] {len(fetched)} trades refetched, {len(all_trades)} total after merge", file=sys.stderr)
    else:
        equity_from_date = (today_dt - timedelta(days=EQUITY_LOOKBACK_DAYS)).strftime('%Y-%m-%d')
        print(f"[get_trade_pnl_by_segment] fetching trade history {equity_from_date}..{today} "
              f"(equity lookback; F&O/commodity scoped to {from_date}..{today})", file=sys.stderr)
        try:
            all_trades = fetch_all_trades(dhan, equity_from_date, today)
        except TradeFetchError as e:
            print(f"[get_trade_pnl_by_segment] {e}", file=sys.stderr)
            write_sync_status(str(e))
            print(json.dumps({'success': False, 'error': str(e)}))
            sys.exit(1)
        print(f"[get_trade_pnl_by_segment] {len(all_trades)} trades fetched", file=sys.stderr)
        annotate_trades(all_trades)

    live_today = fetch_today_trade_book(dhan, helper=helper)
    if live_today:
        annotate_trades(live_today)
        before = len(all_trades)
        all_trades = merge_live_trades(all_trades, live_today)
        print(f"[get_trade_pnl_by_segment] {len(live_today)} live trade-book rows fetched, "
              f"{len(all_trades) - before} new today-trades merged in", file=sys.stderr)

    all_trades.sort(key=lambda t: t.get('exchangeTime') or '')
    windowed_trades = [t for t in all_trades if (t.get('exchangeTime') or '')[:10] >= from_date]

    # Fetch current open positions (F&O/commodity) to value any leftover open lots from the FIFO walk
    open_positions_by_security = {}
    try:
        df_positions = helper.get_positions()
        if not df_positions.empty:
            for _, row in df_positions.iterrows():
                sec_id = SECURITY_ID_MERGES.get(str(row.get('securityId', '')), str(row.get('securityId', '')))
                open_positions_by_security[sec_id] = {
                    'netQty': float(row.get('netQty', 0) or 0),
                    'lastPrice': float(row.get('lastPrice', 0) or 0),
                    'unrealizedProfit': float(row.get('unrealizedProfit', 0) or 0),
                }
    except Exception:
        pass

    segment_totals = defaultdict(lambda: {
        'realizedPnl': 0.0, 'charges': 0.0, 'statutoryCharges': 0.0, 'tradeCount': 0, 'symbolCount': 0,
        'openPositionsUnrealized': 0.0, 'openPositionsCount': 0, 'preWindowGapSymbols': 0,
    })
    symbol_rows = []
    daily_events = []  # (date, realized, charges, stat_charges) across all segments — combined for the weekly/monthly diary view
    segment_daily_events = defaultdict(list)

    # Equity: FIFO-match over the FULL lookback (up to ~2 years) so cost basis for positions opened
    # before the reporting window resolves correctly — but only COUNT realized events whose closing
    # trade falls within report_from_date..today, so this reports on the same period as F&O/Commodity
    # rather than mixing in years-old, already-closed round trips.
    by_security_equity = defaultdict(list)
    for t in all_trades:
        if t['segment'] == 'EQUITY':
            by_security_equity[t['securityId']].append(t)
    process_segment_trades(by_security_equity, segment_totals, symbol_rows, open_positions_by_security, from_date, daily_events, matcher=day_priority_match, segment_daily_events=segment_daily_events)

    # F&O / Commodity: same-day square-offs, so the shorter window is complete — no need for 2 years.
    # Group by (securityId, customSymbol) to prevent contract reuse collisions across months.
    by_security_fno_comm = defaultdict(list)
    for t in windowed_trades:
        if t['segment'] in ('FNO', 'COMMODITY'):
            by_security_fno_comm[(t['securityId'], t['customSymbol'])].append(t)
    process_segment_trades(by_security_fno_comm, segment_totals, symbol_rows, open_positions_by_security, from_date, daily_events, segment_daily_events=segment_daily_events)

    def aggregate_daily_pnl(daily_evs, trades_list):
        gross_by_date = defaultdict(float)
        for date, r, c, sc in daily_evs:
            gross_by_date[date] += r

        raw_charges_by_date = defaultdict(float)
        raw_stat_charges_by_date = defaultdict(float)
        trades_by_date = defaultdict(int)
        for t in trades_list:
            d = (t.get('exchangeTime') or '')[:10]
            raw_charges_by_date[d] += t['charges']
            raw_stat_charges_by_date[d] += t['statutoryCharges']
            trades_by_date[d] += 1

        all_dates = sorted(set(gross_by_date) | set(trades_by_date))
        pnl_list = []
        for d in all_dates:
            gross = gross_by_date.get(d, 0.0)
            charges = raw_charges_by_date.get(d, 0.0)
            stat = raw_stat_charges_by_date.get(d, 0.0)
            pnl_list.append({
                'date': d,
                'grossPnl': round(gross, 2),
                'charges': round(charges, 2),
                'statutoryCharges': round(stat, 2),
                'netPnl': round(gross - charges, 2),
                'tradeCount': trades_by_date.get(d, 0),
            })
        return pnl_list

    daily_pnl = aggregate_daily_pnl(daily_events, windowed_trades)

    daily_pnl_by_segment = {
        'ALL': daily_pnl,
        'EQUITY': aggregate_daily_pnl(segment_daily_events['EQUITY'], [t for t in windowed_trades if t['segment'] == 'EQUITY']),
        'FNO': aggregate_daily_pnl(segment_daily_events['FNO'], [t for t in windowed_trades if t['segment'] == 'FNO']),
        'COMMODITY': aggregate_daily_pnl(segment_daily_events['COMMODITY'], [t for t in windowed_trades if t['segment'] == 'COMMODITY']),
    }

    segments_output = {}
    for seg_name, seg in segment_totals.items():
        segments_output[seg_name] = {
            'realizedPnl': round(seg['realizedPnl'], 2),
            'charges': round(seg['charges'], 2),
            'statutoryCharges': round(seg['statutoryCharges'], 2),
            'netRealizedPnl': round(seg['realizedPnl'] - seg['charges'], 2),
            'openPositionsUnrealized': round(seg['openPositionsUnrealized'], 2),
            'openPositionsCount': seg['openPositionsCount'],
            'tradeCount': seg['tradeCount'],
            'symbolCount': seg['symbolCount'],
            'preWindowGapSymbols': seg['preWindowGapSymbols'],
        }

    # Trade log for display: equity shows its full lookback, F&O/commodity stay scoped to the shorter
    # window (otherwise this log would balloon with years of high-frequency options/futures trades).
    log_source = [t for t in all_trades if t['segment'] == 'EQUITY'] + \
                 [t for t in windowed_trades if t['segment'] in ('FNO', 'COMMODITY')]
    log_source.sort(key=lambda t: t.get('exchangeTime') or '')
    trade_log = [{
        'date': t.get('exchangeTime', '')[:10],
        'time': t.get('exchangeTime', ''),
        'segment': t['segment'],
        'symbol': t.get('customSymbol', ''),
        'securityId': t.get('securityId', ''),
        'transactionType': t.get('transactionType', ''),
        'quantity': t.get('tradedQuantity', 0),
        'price': t.get('tradedPrice', 0),
        'charges': t['charges'],
        'statutoryCharges': t['statutoryCharges'],
        'productType': t.get('productType', ''),
        'optionType': t.get('drvOptionType') if t.get('drvOptionType') not in (None, 'NA') else None,
        'strikePrice': t.get('drvStrikePrice') if t.get('drvStrikePrice') else None,
        'expiryDate': t.get('drvExpiryDate') if t.get('drvExpiryDate') not in (None, 'NA') else None,
        # Round-tripped through log_entry_to_internal() on the next incremental sync so
        # merge_live_trades() can still dedupe this trade against a freshly re-fetched trade book.
        'exchangeTradeId': t.get('exchangeTradeId') or '',
    } for t in log_source]

    output = {
        'generatedAt': datetime.now().isoformat(),
        'fromDate': from_date,
        'equityFromDate': equity_from_date,
        'toDate': today,
        'totalTrades': len(log_source),
        'totalTradesFetched': len(all_trades),
        'segments': segments_output,
        'symbols': sorted(symbol_rows, key=lambda r: -abs(r['netRealizedPnl'])),
        'trades': trade_log,
        'dailyPnl': daily_pnl,
        'dailyPnlBySegment': daily_pnl_by_segment,
    }
    os.makedirs(DEBUG_DIR, exist_ok=True)
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(output, f)

    write_sync_status(None)
    print(json.dumps({'success': True, 'totalTrades': len(log_source), 'segments': list(segments_output.keys())}))


if __name__ == '__main__':
    main()
