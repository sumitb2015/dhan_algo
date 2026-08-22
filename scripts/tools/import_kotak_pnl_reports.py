"""
Imports Kotak statement exports (.xlsx) into a diary-shaped JSON the dashboard reads.

WHY A FILE IMPORTER AND NOT AN API CALL
---------------------------------------
Kotak Neo has no historical trade endpoint. `NeoAPI.trade_report()` (neo_api_client/api/
trade_report_api.py) issues a bare GET with no date parameters and returns only the CURRENT trading
day's trade book; `order_report()` is the same. So Kotak history cannot be backfilled the way
get_trade_pnl_by_segment.py backfills Dhan via `get_trade_history(from_date, to_date, page)`.
The broker's own statement exports are the only source of dated, charge-accurate history.

TWO EXPORT FORMATS -- PREFER THE TRANSACTION STATEMENT
------------------------------------------------------
1. "Transaction_Statement_*.xlsx"  (sheet "On Market")  -- PREFERRED.
   One row per FILL, with Trade Date, Trade Time, Buy/Sell, Qty, Rate and per-trade charges. This is
   the Kotak equivalent of Dhan's trade history, so it supports exact per-day P&L via FIFO matching,
   exactly like get_trade_pnl_by_segment.py does for Dhan.
2. "Gain_Loss_*.xlsx"  (sheet "Realized Gain-Loss")  -- FALLBACK.
   Aggregated per scrip over a DATE RANGE with no per-trade date, so it cannot be split into days.

Where both cover the same dates the transaction statement wins, for two reasons beyond granularity:

  * The Gain/Loss "F&O" export OMITS THE COMMODITY SEGMENT. On the first real pair of exports
    (Z644S, 2026-08-01..22) it listed 60 NIFTY/SENSEX legs and no MCX crude at all, hiding a real
    -5048.30 net. Reading Gain/Loss alone silently overstated the account by that much.
  * Verified equivalence on the overlapping (derivatives-only) slice: FIFO over the transaction
    statement gives gross 21695.99 / charges 7022.42 / net 14673.57 against the Gain/Loss export's
    21695.73 / 7023.18 / 14672.55 -- agreeing to ~1 rupee, which is rate rounding (the statement
    carries 2dp fill rates, the Gain/Loss 4dp average prices).

FIFO MATCHING AND ITS ONE FAILURE MODE
---------------------------------------
Fills are sorted by (trade date, trade time) and matched FIFO per security, signed, so a Buy closes
an open short and a Sell closes an open long. Realized P&L is attributed to the CLOSING trade's
date; charges are attributed to the date of the trade that incurred them (so a day can carry charges
with no P&L, matching the Dhan side).

The failure mode to watch is a position opened BEFORE the export window and closed inside it: FIFO
has no cost basis for it, and since shorting is legitimate in F&O the closing fill is instead read as
OPENING an opposite lot. That shows up as leftover open quantity at the end of the run, which is why
`openAtEnd` is computed and surfaced -- a non-empty value means the window is not self-contained and
some P&L is misattributed. Widen the export range until it clears.

CHARGE SEMANTICS (GAIN/LOSS FALLBACK) -- THE "REALISED P&L" COLUMN IS ALREADY PART-NET
-----------------------------------------------------------------
The trap here is that Kotak's P&L columns are charge-inclusive to DIFFERENT degrees, and taking the
obvious-looking one as "gross" double-counts charges against the Dhan side of the diary:
  * Column "Total (T = B - A)" sits under the group header "Gross Realized P&L (Including all
    charges Excluding STT)". Buy Amt (A) and Sell Amt (B) are themselves charge-inclusive, so this
    column is ALREADY net of GST + brokerage + misc, and only STT/CTT is still to come off.
  * Column "Gross P&L (T + (C + D + E))" adds those three back -- THIS is the true pre-charge gross,
    and the one the diary's `grossPnl` must use to line up with Dhan's.
  * Column "Net P&L (T - S)" then takes STT off T, which lands on the true all-in net.
Verified on Gain_Loss_Z644S_20260801_20260822: header Realised P&L 17354.50 (= sum of T) plus the
non-STT charges 4341.23 gives a true gross of 21695.73; less all-in charges 7023.18 that is
14672.55 -- exactly the header "Net P&L". So Kotak's headline net IS a genuine all-in net; it is the
"Realised P&L" headline that is part-net and must not be read as gross.

To mirror get_trade_pnl_by_segment.py's split, `statutoryCharges` = all-in charges minus brokerage
(i.e. GST + misc + STT/CTT), matching that script's STATUTORY_CHARGE_FIELDS convention.

USAGE
-----
    venv\\Scripts\\python.exe scripts/tools/import_kotak_pnl_reports.py [--dir PATH] [extra files...]

Drop exports into debug/kotak_pnl_reports/ and re-run. Writes debug/kotak_trade_history.json.
"""
import sys
import os
import re
import json
import glob
import argparse
from collections import defaultdict, deque
from datetime import datetime, date

import pandas as pd

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEBUG_DIR = os.path.join(PROJECT_ROOT, 'debug')
REPORT_DIR = os.path.join(DEBUG_DIR, 'kotak_pnl_reports')
OUTPUT_FILE = os.path.join(DEBUG_DIR, 'kotak_trade_history.json')

SHEET_CANDIDATES = ['Realized Gain-Loss', 'Realised Gain-Loss']

# Column indices in the "Realized Gain-Loss" sheet. The sheet uses a two-row header (a merged group
# row above a sub-label row), so pandas cannot infer these -- they are positional by necessity.
C_SCRIP, C_SECTYPE, C_QTY = 0, 1, 3
C_BUY_AMT, C_SELL_AMT = 4, 5
C_REALISED_T = 9             # "Total (T = B - A)" -- already net of GST/brokerage/misc, pre-STT
C_BUY_BROKERAGE = 11
C_SELL_BROKERAGE = 16
C_TOTAL_CHARGES = 20         # all-in: GST + brokerage + misc + STT/CTT, both legs
C_NET_PNL = 21               # "Net P&L (T - S)" -- true all-in net
C_GROSS_PNL = 22             # "Gross P&L (T + (C + D + E))" -- true pre-charge gross


def _num(v) -> float:
    """Sheet cells arrive as str/float/'-'/'1,234.56'. Anything non-numeric reads as 0."""
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(',', '')
    if not s or s == '-':
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def _find_cell(df, needle: str):
    """Locate a label cell in the header block and return (row, col). The block's position shifts
    between export variants, so scanning beats hardcoding coordinates."""
    target = needle.strip().lower()
    for r in range(min(len(df), 15)):
        for c in range(min(df.shape[1], 12)):
            v = df.iat[r, c]
            if isinstance(v, str) and v.strip().lower() == target:
                return r, c
    return None, None


def _value_right_of(df, needle: str, max_span: int = 5):
    """First non-empty cell to the right of a label -- labels and values are separated by a variable
    number of merged/blank spacer columns."""
    r, c = _find_cell(df, needle)
    if r is None:
        return None
    for cc in range(c + 1, min(c + 1 + max_span, df.shape[1])):
        v = df.iat[r, cc]
        if v is not None and not (isinstance(v, float) and pd.isna(v)) and str(v).strip():
            return v
    return None


DATE_RE = re.compile(r'From\s*:\s*(\d{4}-\d{2}-\d{2})\s*To\s*:\s*(\d{4}-\d{2}-\d{2})', re.I)
FNAME_RE = re.compile(r'_(\d{8})_(\d{8})')


def _period_of(df, path: str):
    """Date range from the 'Transaction Period' cell, falling back to the filename stamps."""
    raw = _value_right_of(df, 'Transaction Period')
    if isinstance(raw, str):
        m = DATE_RE.search(raw)
        if m:
            return m.group(1), m.group(2)
    m = FNAME_RE.search(os.path.basename(path))
    if m:
        f, t = m.group(1), m.group(2)
        return '%s-%s-%s' % (f[:4], f[4:6], f[6:]), '%s-%s-%s' % (t[:4], t[4:6], t[6:])
    return None, None


SECTION_LABELS = ('derivatives', 'equity', 'commodity', 'currency', 'script name', 'disclaimer')


def _scrip_rows(df):
    """Yield real scrip rows only.

    Bounded by the 'Script Name' header row above and the 'Disclaimer' block below. The bounds
    matter: the summary block at the top REUSES the same columns for unrelated figures, so a
    "does column 1 look like a Security Type?" test alone lets `Transaction Type | ALL` through --
    and that row's column 9 holds the Futures Turnover, which silently inflated gross P&L by
    exactly that turnover (10815.36 on the first real export) before this was bounded.
    """
    start, end = None, len(df)
    for r in range(len(df)):
        v = df.iat[r, C_SCRIP]
        if not isinstance(v, str):
            continue
        low = v.strip().lower()
        if start is None and low == 'script name':
            start = r + 1
        elif start is not None and low == 'disclaimer':
            end = r
            break
    if start is None:
        raise ValueError("no 'Script Name' header row -- unrecognised sheet layout")

    for r in range(start, end):
        name = df.iat[r, C_SCRIP]
        if not isinstance(name, str) or not name.strip():
            continue
        low = name.strip().lower()
        # Section banners ('Derivatives') and '<Section> Total' subtotals -- summing a subtotal row
        # would double every figure under it.
        if low.endswith('total') or low in SECTION_LABELS:
            continue
        sectype = df.iat[r, C_SECTYPE]
        # A real scrip row always carries a Security Type (IO / OPTIDX / FUTIDX / ...).
        if not isinstance(sectype, str) or not sectype.strip():
            continue
        yield r, name.strip(), sectype.strip()


def parse_gain_loss(path: str) -> dict:
    xl = pd.ExcelFile(path)
    sheet = next((s for s in SHEET_CANDIDATES if s in xl.sheet_names), None)
    if sheet is None:
        raise ValueError('no Gain/Loss sheet (sheets: %s)' % xl.sheet_names)
    df = xl.parse(sheet, header=None)

    from_date, to_date = _period_of(df, path)
    if not from_date or not to_date:
        raise ValueError('could not determine the date range')

    legs, gross, charges, brokerage, realised_t = [], 0.0, 0.0, 0.0, 0.0
    for r, name, sectype in _scrip_rows(df):
        g = _num(df.iat[r, C_GROSS_PNL])       # true pre-charge gross; see module docstring
        ch = _num(df.iat[r, C_TOTAL_CHARGES])
        bk = _num(df.iat[r, C_BUY_BROKERAGE]) + _num(df.iat[r, C_SELL_BROKERAGE])
        gross += g
        charges += ch
        brokerage += bk
        realised_t += _num(df.iat[r, C_REALISED_T])
        legs.append({
            'symbol': re.sub(r'\s+', ' ', name),
            'securityType': sectype,
            'quantity': int(_num(df.iat[r, C_QTY])),
            'buyValue': round(_num(df.iat[r, C_BUY_AMT]), 2),
            'sellValue': round(_num(df.iat[r, C_SELL_AMT]), 2),
            'grossPnl': round(g, 2),
            'charges': round(ch, 2),
            'brokerage': round(bk, 2),
            'statutoryCharges': round(ch - bk, 2),
            'netPnl': round(g - ch, 2),
        })

    # Cross-check the leg sums against the broker's own headline figures. A mismatch means the column
    # layout moved (a new export variant) -- surfaced in the UI rather than silently trusted.
    # Note the headline "Realised P&L" is the part-net T column, so it reconciles against realised_t,
    # NOT against our `gross`; the headline "Net P&L" is what our `gross - charges` must match.
    hdr_realised = _num(_value_right_of(df, 'Realised P&L') or _value_right_of(df, 'Realized P&L'))
    hdr_charges = _num(_value_right_of(df, 'Charges'))
    hdr_net = _num(_value_right_of(df, 'Net P&L'))

    return {
        'sourceFile': os.path.basename(path),
        'sourceKind': 'gain-loss',
        'clientCode': str(_value_right_of(df, 'Client Code') or '').strip() or None,
        'segmentType': str(_value_right_of(df, 'Segment Type') or '').strip() or None,
        'fromDate': from_date,
        'toDate': to_date,
        'spanDays': (date.fromisoformat(to_date) - date.fromisoformat(from_date)).days + 1,
        'daily': from_date == to_date,
        'grossPnl': round(gross, 2),
        'charges': round(charges, 2),
        'brokerage': round(brokerage, 2),
        'statutoryCharges': round(charges - brokerage, 2),
        'netPnl': round(gross - charges, 2),
        'tradeCount': len(legs),
        'legs': legs,
        'brokerReported': {
            'realisedPnl': round(hdr_realised, 2),   # part-net T column, not a gross figure
            'charges': round(hdr_charges, 2),
            'netPnl': round(hdr_net, 2),
        },
        'reconciled': (abs(realised_t - hdr_realised) < 1.0
                       and abs(charges - hdr_charges) < 1.0
                       and abs((gross - charges) - hdr_net) < 1.0),
    }


# ── Transaction statement (preferred): one row per fill, FIFO-matched into exact daily P&L ──────

TXN_SHEET = 'On Market'
TXN_COLUMNS = ['tradeDate', 'tradeTime', 'orderTime', 'security', 'isin', 'exchange', 'source',
               'txnType', 'productType', 'quantity', 'rate', 'total', 'gst', 'brokerage', 'misc',
               'charges', 'stt']


def _segment_of(security: str, exchange: str) -> str:
    """Map Kotak's instrument-type prefix to the diary's segment vocabulary.

    Kotak labels the exchange 'NSEDERV' even for BSE (SENSEX) options, so the prefix is what
    separates index derivatives from commodities -- not the exchange column.
    """
    s = (security or '').upper()
    if s.startswith(('OPTFUT', 'FUTCOM')) or (exchange or '').upper().startswith('MCX'):
        return 'COMMODITY'
    if s.startswith(('OPTIDX', 'FUTIDX', 'OPTSTK', 'FUTSTK')):
        return 'FNO'
    return 'FNO'


def _iso_date(v) -> str:
    """Kotak writes DD/MM/YYYY here (unlike the ISO dates in the Gain/Loss header)."""
    if isinstance(v, datetime):
        return v.date().isoformat()
    parts = str(v).strip().split('/')
    if len(parts) == 3 and len(parts[2]) == 4:
        return '%s-%s-%s' % (parts[2], parts[1].zfill(2), parts[0].zfill(2))
    return str(v).strip()[:10]


def parse_transaction_statement(path: str) -> dict:
    xl = pd.ExcelFile(path)
    if TXN_SHEET not in xl.sheet_names:
        raise ValueError('no "%s" sheet (sheets: %s)' % (TXN_SHEET, xl.sheet_names))
    raw = xl.parse(TXN_SHEET, header=None)

    hdr = next((r for r in range(min(len(raw), 30))
                if isinstance(raw.iat[r, 0], str) and raw.iat[r, 0].strip().lower() == 'trade date'), None)
    if hdr is None:
        raise ValueError("no 'Trade Date' header row -- unrecognised sheet layout")

    client = str(_value_right_of(raw, 'Client Code') or '').strip() or None
    from_date, to_date = _period_of(raw, path)

    df = raw.iloc[hdr + 1:, :len(TXN_COLUMNS)].copy()
    df.columns = TXN_COLUMNS
    df = df[df['tradeDate'].notna()]

    fills = []
    for _, r in df.iterrows():
        sec = str(r['security']).strip()
        if not sec or sec.lower() == 'nan':
            continue
        # "Total Charges" here excludes STT (verified: gst + brokerage + misc == charges), unlike the
        # Gain/Loss sheet's same-named column which includes it. All-in is charges + stt.
        ch = _num(r['charges'])
        stt = _num(r['stt'])
        fills.append({
            'date': _iso_date(r['tradeDate']),
            'time': str(r['tradeTime']).strip(),
            'security': re.sub(r'\s+', ' ', sec),
            'segment': _segment_of(sec, str(r['exchange'])),
            'side': 1 if str(r['txnType']).strip().lower().startswith('b') else -1,
            'quantity': _num(r['quantity']),
            'rate': _num(r['rate']),
            'brokerage': _num(r['brokerage']),
            'charges': ch + stt,
            'statutoryCharges': ch + stt - _num(r['brokerage']),
        })
    if not fills:
        raise ValueError('no fills found')

    fills.sort(key=lambda f: (f['date'], f['time']))

    books = defaultdict(deque)                     # security -> deque of [qty, rate, side]
    gross_by_date_seg = defaultdict(float)         # (date, segment) -> realized gross
    gross_by_security = defaultdict(float)
    closed_by_date_seg = defaultdict(int)          # closing-fill count, for a "trades" figure
    for f in fills:
        qty, book = f['quantity'], books[f['security']]
        while qty > 0 and book and book[0][2] == -f['side']:
            lot = book[0]
            take = min(qty, lot[0])
            # Selling closes a long at (sell - buy); buying closes a short at (buy_open - buy_close).
            pnl = (f['rate'] - lot[1]) * take * (-1 if f['side'] == 1 else 1)
            gross_by_date_seg[(f['date'], f['segment'])] += pnl
            gross_by_security[f['security']] += pnl
            closed_by_date_seg[(f['date'], f['segment'])] += 1
            lot[0] -= take
            qty -= take
            if lot[0] == 0:
                book.popleft()
        if qty > 0:
            book.append([qty, f['rate'], f['side']])

    # Leftover inventory means the window is not self-contained -- see the module docstring.
    open_at_end = {s: sum(l[0] * l[2] for l in b) for s, b in books.items() if any(l[0] for l in b)}
    open_at_end = {s: q for s, q in open_at_end.items() if q}

    # Charges land on the date of the fill that incurred them, so a day can carry charges with no
    # realized P&L (an opening-only day) -- the same convention the Dhan side uses.
    charges_by_date_seg = defaultdict(float)
    statutory_by_date_seg = defaultdict(float)
    brokerage_by_date_seg = defaultdict(float)
    fills_by_date_seg = defaultdict(int)
    for f in fills:
        k = (f['date'], f['segment'])
        charges_by_date_seg[k] += f['charges']
        statutory_by_date_seg[k] += f['statutoryCharges']
        brokerage_by_date_seg[k] += f['brokerage']
        fills_by_date_seg[k] += 1

    keys = sorted(set(charges_by_date_seg) | set(gross_by_date_seg))
    rows = []
    for d_, seg in keys:
        g = gross_by_date_seg[(d_, seg)]
        c = charges_by_date_seg[(d_, seg)]
        rows.append({
            'date': d_, 'segment': seg,
            'grossPnl': round(g, 2),
            'charges': round(c, 2),
            'statutoryCharges': round(statutory_by_date_seg[(d_, seg)], 2),
            'brokerage': round(brokerage_by_date_seg[(d_, seg)], 2),
            'netPnl': round(g - c, 2),
            'tradeCount': fills_by_date_seg[(d_, seg)],
        })

    dates = sorted({r['date'] for r in rows})
    total_gross = sum(r['grossPnl'] for r in rows)
    total_charges = sum(r['charges'] for r in rows)
    return {
        'sourceFile': os.path.basename(path),
        'sourceKind': 'transaction-statement',
        'clientCode': client,
        'fromDate': from_date or (dates[0] if dates else None),
        'toDate': to_date or (dates[-1] if dates else None),
        'daily': True,
        'segments': sorted({r['segment'] for r in rows}),
        'grossPnl': round(total_gross, 2),
        'charges': round(total_charges, 2),
        'brokerage': round(sum(r['brokerage'] for r in rows), 2),
        'statutoryCharges': round(sum(r['statutoryCharges'] for r in rows), 2),
        'netPnl': round(total_gross - total_charges, 2),
        'tradeCount': len(fills),
        'tradedDates': dates,
        'rows': rows,
        'openAtEnd': open_at_end,
        'securities': gross_by_security,
        'securitySegments': {f['security']: f['segment'] for f in fills},
        'securityCharges': _charges_by_security(fills),
        'reconciled': not open_at_end,
    }


def _charges_by_security(fills: list) -> dict:
    out = defaultdict(lambda: {'charges': 0.0, 'statutoryCharges': 0.0, 'tradeCount': 0})
    for f in fills:
        e = out[f['security']]
        e['charges'] += f['charges']
        e['statutoryCharges'] += f['statutoryCharges']
        e['tradeCount'] += 1
    return dict(out)


def parse_report(path: str) -> dict:
    """Dispatch on sheet layout — filenames are not reliable enough to key on."""
    sheets = pd.ExcelFile(path).sheet_names
    if TXN_SHEET in sheets:
        return parse_transaction_statement(path)
    return parse_gain_loss(path)


def _overlaps(a: dict, b: dict) -> bool:
    return a['fromDate'] <= b['toDate'] and b['fromDate'] <= a['toDate']


def build(paths: list) -> dict:
    periods, failures = [], []
    for p in sorted(paths):
        try:
            periods.append(parse_report(p))
        except Exception as e:
            failures.append({'sourceFile': os.path.basename(p), 'error': str(e)})
            print('[kotak-import] SKIP %s: %s' % (os.path.basename(p), e), file=sys.stderr)

    # Overlapping ranges would double-count the shared days, so at most one export may own any given
    # date. Precedence, in order:
    #   1. a transaction statement over a Gain/Loss export -- it is per-fill, and the Gain/Loss F&O
    #      export omits the commodity segment entirely (see module docstring);
    #   2. the narrower range -- a per-day export beats the month containing it;
    #   3. the earlier start, purely so the outcome is deterministic.
    periods.sort(key=lambda x: (0 if x['sourceKind'] == 'transaction-statement' else 1,
                                _span_days(x), x['fromDate'] or ''))
    accepted, skipped = [], []
    for p in periods:
        clash = next((a for a in accepted if _overlaps(a, p)), None)
        if clash:
            reason = 'overlaps %s (%s..%s)' % (clash['sourceFile'], clash['fromDate'], clash['toDate'])
            if p['sourceKind'] == 'gain-loss' and clash['sourceKind'] == 'transaction-statement':
                reason += '; superseded by the per-fill transaction statement'
            skipped.append({
                'sourceFile': p['sourceFile'], 'fromDate': p['fromDate'], 'toDate': p['toDate'],
                'sourceKind': p['sourceKind'], 'reason': reason,
            })
            print('[kotak-import] SKIP %s: %s' % (p['sourceFile'], reason), file=sys.stderr)
            continue
        accepted.append(p)
    accepted.sort(key=lambda x: x['toDate'] or '')

    by_date_seg = defaultdict(lambda: defaultdict(lambda: {
        'grossPnl': 0.0, 'charges': 0.0, 'statutoryCharges': 0.0, 'netPnl': 0.0, 'tradeCount': 0,
    }))
    approx_dates = set()
    for p in accepted:
        if p['sourceKind'] == 'transaction-statement':
            # Exact: every row already carries its own trade date and segment.
            for r in p['rows']:
                acc = by_date_seg[r['date']][r['segment']]
                for k in ('grossPnl', 'charges', 'statutoryCharges', 'netPnl', 'tradeCount'):
                    acc[k] += r[k]
        else:
            # Fallback: the whole range collapses onto its end date. F&O only -- the Gain/Loss export
            # has no commodity rows to attribute anywhere.
            acc = by_date_seg[p['toDate']]['FNO']
            for k in ('grossPnl', 'charges', 'statutoryCharges', 'netPnl', 'tradeCount'):
                acc[k] += p[k]
            if not p['daily']:
                approx_dates.add(p['toDate'])

    def _points(seg_filter=None):
        out = []
        for d_ in sorted(by_date_seg):
            segs = by_date_seg[d_]
            keys = [seg_filter] if seg_filter else list(segs)
            agg = {'grossPnl': 0.0, 'charges': 0.0, 'statutoryCharges': 0.0, 'netPnl': 0.0,
                   'tradeCount': 0}
            hit = False
            for k in keys:
                if k not in segs:
                    continue
                hit = True
                for f in agg:
                    agg[f] += segs[k][f]
            if not hit:
                continue
            pt = {'date': d_}
            pt.update({k: (v if k == 'tradeCount' else round(v, 2)) for k, v in agg.items()})
            if d_ in approx_dates:
                pt['approx'] = True
            out.append(pt)
        return out

    all_segments = sorted({seg for segs in by_date_seg.values() for seg in segs})
    daily_pnl = _points()
    by_segment = {'ALL': daily_pnl}
    for seg in all_segments:
        by_segment[seg] = _points(seg)

    symbols = {}
    for p in accepted:
        if p['sourceKind'] == 'transaction-statement':
            for sec, g in p['securities'].items():
                ch = p['securityCharges'].get(sec, {})
                s = symbols.setdefault(sec, _blank_symbol(sec, p['securitySegments'].get(sec, 'FNO')))
                s['tradeCount'] += ch.get('tradeCount', 0)
                s['realizedPnl'] += g
                s['charges'] += ch.get('charges', 0.0)
                s['statutoryCharges'] += ch.get('statutoryCharges', 0.0)
                s['netRealizedPnl'] += g - ch.get('charges', 0.0)
        else:
            for leg in p['legs']:
                s = symbols.setdefault(leg['symbol'], _blank_symbol(leg['symbol'], 'FNO'))
                s['tradeCount'] += 1
                s['realizedPnl'] += leg['grossPnl']
                s['charges'] += leg['charges']
                s['statutoryCharges'] += leg['statutoryCharges']
                s['netRealizedPnl'] += leg['netPnl']
    for s in symbols.values():
        for k in ('realizedPnl', 'charges', 'statutoryCharges', 'netRealizedPnl'):
            s[k] = round(s[k], 2)

    # A window that does not close out means FIFO lacked a cost basis somewhere -- surfaced, not hidden.
    open_at_end = {}
    for p in accepted:
        for sec, q in (p.get('openAtEnd') or {}).items():
            open_at_end[sec] = open_at_end.get(sec, 0) + q

    return {
        'generatedAt': datetime.now().isoformat(),
        'broker': 'KOTAK',
        'clientCode': next((p['clientCode'] for p in accepted if p['clientCode']), None),
        'fromDate': min((p['fromDate'] for p in accepted if p['fromDate']), default=None),
        'toDate': max((p['toDate'] for p in accepted if p['toDate']), default=None),
        'segments': all_segments,
        'periodCount': len(accepted),
        'exactPeriodCount': sum(1 for p in accepted if p['sourceKind'] == 'transaction-statement'),
        'approxPeriodCount': sum(1 for p in accepted
                                 if p['sourceKind'] == 'gain-loss' and not p['daily']),
        'tradedDayCount': len(daily_pnl),
        'totalGrossPnl': round(sum(p['grossPnl'] for p in accepted), 2),
        'totalCharges': round(sum(p['charges'] for p in accepted), 2),
        'totalBrokerage': round(sum(p['brokerage'] for p in accepted), 2),
        'totalNetPnl': round(sum(p['netPnl'] for p in accepted), 2),
        'periods': [{k: v for k, v in p.items()
                     if k not in ('legs', 'rows', 'securities', 'securityCharges', 'securitySegments')}
                    for p in accepted],
        'dailyPnl': daily_pnl,
        'dailyPnlBySegment': by_segment,
        'symbols': sorted(symbols.values(), key=lambda s: s['netRealizedPnl']),
        'openAtEnd': open_at_end,
        'skipped': skipped,
        'failures': failures,
    }


def _blank_symbol(symbol: str, segment: str) -> dict:
    return {'symbol': symbol, 'segment': segment, 'tradeCount': 0, 'realizedPnl': 0.0,
            'charges': 0.0, 'statutoryCharges': 0.0, 'netRealizedPnl': 0.0}


def _span_days(p: dict) -> int:
    """Range width in days, for the overlap-precedence sort. Unknown ranges sort last."""
    if p.get('spanDays'):
        return p['spanDays']
    if p.get('fromDate') and p.get('toDate'):
        return (date.fromisoformat(p['toDate']) - date.fromisoformat(p['fromDate'])).days + 1
    return 10 ** 6


def main():
    ap = argparse.ArgumentParser(description='Import Kotak Gain/Loss P&L exports into the diary.')
    ap.add_argument('--dir', default=REPORT_DIR, help='folder scanned for .xlsx exports')
    ap.add_argument('extra', nargs='*', help='additional .xlsx files to include')
    args = ap.parse_args()

    os.makedirs(args.dir, exist_ok=True)
    # ~$foo.xlsx are Excel lock files written while a workbook is open -- not real exports.
    paths = [p for p in glob.glob(os.path.join(args.dir, '*.xlsx'))
             if not os.path.basename(p).startswith('~$')]
    paths += [p for p in args.extra if os.path.exists(p)]
    if not paths:
        print('[kotak-import] no .xlsx found in %s' % args.dir, file=sys.stderr)

    result = build(paths)
    os.makedirs(DEBUG_DIR, exist_ok=True)
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=1)

    print(json.dumps({
        'ok': True,
        'files': len(paths),
        'periods': result['periodCount'],
        'fromDate': result['fromDate'],
        'toDate': result['toDate'],
        'grossPnl': result['totalGrossPnl'],
        'charges': result['totalCharges'],
        'netPnl': result['totalNetPnl'],
        'skipped': len(result['skipped']),
        'failures': len(result['failures']),
        'output': OUTPUT_FILE,
    }))


if __name__ == '__main__':
    main()
