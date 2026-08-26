"""
Fetches and caches Kotak Neo option instruments (NIFTY/BANKNIFTY/FINNIFTY on
nse_fo, SENSEX on bse_fo, CRUDEOIL/CRUDEOILM on mcx_fo) for the strike ->
trading_symbol lookup used by the copy-trade bridge, the scalper's Kotak broker
routes and the Crude Oil options page.

Deliberately emits the SAME row shape as
scripts/tools/zerodha_instruments_cache.py, so the bridge's symbol resolver
works against either broker's cache unchanged.

Usage:
    venv\\Scripts\\python.exe scripts/tools/kotak_instruments_cache.py --underlying NIFTY
    venv\\Scripts\\python.exe scripts/tools/kotak_instruments_cache.py --underlying SENSEX
    venv\\Scripts\\python.exe scripts/tools/kotak_instruments_cache.py --underlying CRUDEOIL

Writes debug/kotak_<underlying>_instruments.json and caches the raw master CSV
under debug/kotak_master/. Prints a single JSON status line to stdout.
"""
import sys
import os
import csv
import json
import argparse
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
os.chdir(ROOT)

# Kotak exchange segment each underlying's options trade on.
UNDERLYING_SEGMENT = {
    'NIFTY':     'nse_fo',
    'BANKNIFTY': 'nse_fo',
    'FINNIFTY':  'nse_fo',
    'SENSEX':    'bse_fo',
    # MCX commodity options. Kotak calls the segment `mcx_fo` — `com_fo` (the
    # name used elsewhere for commodities) is rejected by scrip_master with
    # "Exchange Segment is not available".
    'CRUDEOIL':  'mcx_fo',
    'CRUDEOILM': 'mcx_fo',
}

# Option instrument types worth caching, per segment. MCX lists options ON THE
# FUTURE (OPTFUT), so the equity-derivative filter drops every crude contract.
# BSE (bse_fo, i.e. SENSEX) tags its index options 'IO' rather than NSE's
# 'OPTIDX' — the default filter silently dropped every SENSEX row, caching an
# empty instrument list and leaving Kotak+SENSEX unable to resolve a strike.
SEGMENT_OPTION_TYPES = {
    'mcx_fo': ('OPTFUT', 'OPTCOM'),
    'bse_fo': ('IO',),
}
DEFAULT_OPTION_TYPES = ('OPTIDX', 'OPTSTK')

MASTER_DIR = os.path.join(ROOT, 'debug', 'kotak_master')


def output_file(underlying: str) -> str:
    return os.path.join(ROOT, 'debug', f'kotak_{underlying.lower()}_instruments.json')


def master_file(segment: str) -> str:
    return os.path.join(MASTER_DIR, f'{segment}.csv')


def map_mcx_expiry_date(raw) -> str:
    """Expiry date for an mcx_fo or bse_fo contract: the UTC date of a genuine epoch.

    Neither segment shares nse_fo's decade shift — verified against the live
    master for mcx_fo (raw 1787011199 belongs to symbols tagged `17AUG26`) and
    for bse_fo (raw 1787855399 belongs to SENSEX26AUG85000CE, i.e. 2026-08-27).
    Applying map_expiry_date()'s +10 years to either would return a decade
    late (2036 for the SENSEX example above).

    It must be read in UTC, not local time. Kotak stamps 23:59:59 UTC, so
    parsing in IST rolls every expiry forward one day (2026-08-17 -> 2026-08-18)
    and no strike would ever match the expiry the chain asked for.
    """
    text = str(raw).strip()
    try:
        if text.isdigit():
            return datetime.fromtimestamp(int(text), tz=timezone.utc).strftime('%Y-%m-%d')
        return datetime.fromisoformat(text[:10]).strftime('%Y-%m-%d')
    except (ValueError, OverflowError, OSError):
        return text


def map_expiry_date(raw) -> str:
    """Correct Kotak's 1980-based expiry epoch by adding 10 calendar years.

    NSE segments only — see map_mcx_expiry_date() for mcx_fo AND bse_fo, both
    of which use a real epoch and must not be shifted.

    Parsing their timestamp with a 1970 epoch lands exactly a decade early
    (2016 -> actually 2026).

    Two tempting shortcuts are both wrong, and both were checked against the
    live master:

      - The string-prefix patch in C:\\kotak_algo\\server.py ('201x' -> '202x')
        leaves anything past 2029 untouched: NSE's long-dated NIFTY contracts
        came back as 2020-06-25 / 2021-06-24 instead of 2030 / 2031.
      - The SDK's own `+ 315511200 seconds` is 3651 days, but a decade spanning
        two leap years is 3652 — so it lands a day early and turns a Tuesday
        expiry into a Monday.

    Calendar arithmetic is the only version that holds for every year.
    """
    text = str(raw).strip()
    try:
        if text.isdigit():
            dt = datetime.fromtimestamp(int(text))
        else:
            dt = datetime.fromisoformat(text[:10])
        try:
            return dt.replace(year=dt.year + 10).strftime('%Y-%m-%d')
        except ValueError:
            # 29 Feb in a leap year whose +10 counterpart is not one. NSE never
            # expires on the 29th, but silently returning the wrong decade would
            # be worse than stepping back a day.
            return dt.replace(year=dt.year + 10, day=dt.day - 1).strftime('%Y-%m-%d')
    except (ValueError, OverflowError, OSError):
        return text


def _cache_is_fresh(path: str) -> bool:
    """A master CSV is usable only if it was downloaded today — contracts and
    freeze quantities change between sessions."""
    if not os.path.exists(path):
        return False
    try:
        mdate = datetime.fromtimestamp(os.path.getmtime(path)).strftime('%Y-%m-%d')
        return mdate == datetime.now().strftime('%Y-%m-%d')
    except OSError:
        return False


def load_master(client, segment: str, log):
    """Return the master CSV rows for a segment, downloading if stale.

    Falls back to a stale cache when the download fails: an out-of-date contract
    list is far better than no symbol resolution at all, which would stop
    replication outright.
    """
    import requests

    path = master_file(segment)
    if _cache_is_fresh(path):
        log(f'{segment}: using cached master')
    else:
        os.makedirs(MASTER_DIR, exist_ok=True)
        try:
            url = client.scrip_master(exchange_segment=segment)
            if not isinstance(url, str):
                raise RuntimeError(f'scrip_master returned {url!r}')
            log(f'{segment}: downloading master CSV')
            resp = requests.get(url, timeout=(3.05, 60))
            resp.raise_for_status()
            with open(path, 'w', encoding='utf-8', newline='') as f:
                f.write(resp.text)
        except Exception as e:
            if not os.path.exists(path):
                raise RuntimeError(f'{segment} master download failed and no cache exists: {e}')
            log(f'{segment}: download failed ({e}) — falling back to stale cache')

    with open(path, encoding='utf-8', newline='') as f:
        return list(csv.DictReader(f))


def _column(row: dict, *names):
    """Read a master column, tolerating the stray delimiters in Kotak's header.

    The strike column really is named `dStrikePrice;` — trailing semicolon
    included — in the published CSV, so exact-name lookups are not safe on their
    own.
    """
    for name in names:
        if name in row:
            return row[name]
    wanted = {n.strip().strip(';').lower() for n in names}
    for key, value in row.items():
        if key and key.strip().strip(';').lower() in wanted:
            return value
    return None


def _num(value, default=0.0) -> float:
    try:
        return float(str(value).strip().strip(';'))
    except (TypeError, ValueError):
        return default


def build_rows(master_rows, underlying: str, segment: str = 'nse_fo'):
    option_types = SEGMENT_OPTION_TYPES.get(segment, DEFAULT_OPTION_TYPES)
    # bse_fo (SENSEX) shares mcx_fo's real, unshifted epoch — see
    # map_mcx_expiry_date's docstring.
    expiry_mapper = map_mcx_expiry_date if segment in ('mcx_fo', 'bse_fo') else map_expiry_date

    rows = []
    for row in master_rows:
        if str(_column(row, 'pSymbolName') or '').strip().upper() != underlying:
            continue
        if str(_column(row, 'pInstType') or '').strip().upper() not in option_types:
            continue
        opt_type = str(_column(row, 'pOptionType') or '').strip().upper()
        if opt_type not in ('CE', 'PE'):
            continue
        trading_symbol = str(_column(row, 'pTrdSymbol') or '').strip()
        if not trading_symbol:
            continue
        rows.append({
            # Read verbatim from the master, never constructed: Kotak mixes
            # monthly (NIFTY26SEP29200PE) and weekly (NIFTY2680429350PE)
            # formats, and a hand-built symbol silently resolves to nothing.
            'tradingsymbol': trading_symbol,
            'instrument_token': str(_column(row, 'pSymbol') or '').strip(),
            # Strikes and base prices are scaled x100 in the master.
            'strike': _num(_column(row, 'dStrikePrice;', 'dStrikePrice')) / 100.0,
            'expiry': expiry_mapper(_column(row, 'pExpiryDate')),
            'instrument_type': opt_type,
            'lot_size': int(_num(_column(row, 'iLotSize', 'lLotSize'), 0)),
            'exchange_segment': str(_column(row, 'pExchSeg') or '').strip(),
            # Market orders above the freeze quantity are rejected outright, so
            # the bridge slices to it rather than assuming Zerodha's 1800.
            'freeze_qty': int(_num(_column(row, 'lFreezeQty'), 0)),
        })
    return rows


def refresh(underlying: str = 'NIFTY', client=None, log=None):
    """Rebuild the instrument cache for one underlying. Returns the row list.

    Importable so the copy-trade bridge can refresh in-process (mirroring how it
    refreshes the Zerodha cache) instead of spawning this script.
    """
    underlying = underlying.upper()
    log = log or (lambda msg: print(f'[kotak_instruments] {msg}', file=sys.stderr, flush=True))
    if client is None:
        from lib.kotak.authentication import get_kotak_client
        client = get_kotak_client()

    segment = UNDERLYING_SEGMENT.get(underlying, 'nse_fo')
    rows = build_rows(load_master(client, segment, log), underlying, segment)

    out_file = output_file(underlying)
    os.makedirs(os.path.dirname(out_file), exist_ok=True)
    tmp = out_file + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(rows, f)
    os.replace(tmp, out_file)
    log(f'{underlying}: cached {len(rows)} contracts')
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--underlying', default='NIFTY')
    args = parser.parse_args()

    try:
        rows = refresh(args.underlying)
    except Exception as e:
        print(json.dumps({'success': False, 'error': str(e)}))
        sys.exit(1)

    expiries = sorted({r['expiry'] for r in rows})
    print(json.dumps({
        'success': True,
        'count': len(rows),
        'expiries': expiries[:8],
    }))


if __name__ == '__main__':
    main()
