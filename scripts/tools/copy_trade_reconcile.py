"""
Reconcile the Dhan (parent) NIFTY option book against Zerodha (child).

Answers the two questions you cannot answer from the bridge's own status file:

  1. Is every open Dhan position mirrored on Zerodha at the right quantity?
  2. Are there ZOMBIES — Zerodha positions the bridge opened that the parent
     has since closed (or never held)?

Read-only. This tool never places or cancels an order; it prints a verdict and
exits non-zero if anything needs attention, so it is safe to run any time and
safe to wire into a dashboard route or a scheduled check.

Zerodha positions are classified against the bridge's own per-day replication
scope (`symbols` in debug/copy_trade_replicated.json), exactly like the bridge's
safety watchdog. A position the bridge never traded is reported as UNTRACKED
(informational) rather than a zombie — your manual Zerodha trades are not the
bridge's business and must never be flagged for closing.

Usage:
    venv\\Scripts\\python.exe scripts/tools/copy_trade_reconcile.py
    venv\\Scripts\\python.exe scripts/tools/copy_trade_reconcile.py --json

Exit codes: 0 = in sync, 1 = discrepancies found, 2 = could not check.
"""
import sys
import os
import json
import argparse
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
os.chdir(ROOT)

# Reuse the bridge's own lookup/normalisation helpers rather than
# reimplementing them — a divergence between how the bridge resolves a symbol
# and how this tool resolves it would produce phantom discrepancies.
from scripts.tools.copy_trade_bridge import (  # noqa: E402
    find_zerodha_symbol, normalize_opt_type, load_config, load_replicated_symbols,
    read_json, LOG_FILE, STATUS_FILE, HEARTBEAT_INTERVAL_SEC,
)

# Log results that mean "a parent fill was NOT mirrored to the child". Each one
# is a known desync the bridge already gave up on and logged loudly.
UNREPLICATED_RESULTS = {
    'retry_exhausted':    'retry queue gave up — fill never reached Zerodha',
    'baseline_skipped':   'filled while the bridge was down — deliberately not replicated',
    'safety_exit_gave_up': 'watchdog could not force-close an orphaned child position',
    'margin_blocked':     'refused up front — insufficient Zerodha margin',
    'pending_confirm_timeout': 'Kotak order status never resolved within CONFIRM_TIMEOUT_SEC — parent/child may be desynced, verify manually',
}


def dhan_expiry(raw) -> str:
    """Normalise a Dhan expiry to the bare 'YYYY-MM-DD' the Zerodha cache uses.

    The order-update WS is confirmed to send 'YYYY-MM-DD' (see
    debug/copy_trade_raw_events.json), but the positions endpoint's
    `drvExpiryDate` has NOT been observed with a live position, so DD-MM-YYYY and
    a trailing timestamp are both handled. A mis-parsed expiry would not fail
    quietly — the leg simply would not resolve and would be reported as MISSING —
    but converting it correctly beats reporting a phantom discrepancy.
    """
    s = str(raw or '').strip()
    if not s:
        return ''
    s = s.split('T')[0].split(' ')[0]  # drop any trailing time
    parts = s.replace('/', '-').split('-')
    if len(parts) == 3 and len(parts[0]) == 2 and len(parts[2]) == 4:
        return f'{parts[2]}-{parts[1]}-{parts[0]}'  # DD-MM-YYYY -> YYYY-MM-DD
    return s


def collect_dhan_legs(helper):
    """Open NIFTY NFO option legs on the parent, keyed by Zerodha tradingsymbol.

    Returns (legs, error). A non-None error means the position state is UNKNOWN
    and the caller must not conclude anything — treating a failed API call as
    "parent is flat" is how a reconcile tool would invent zombies that do not
    exist.
    """
    df = helper.get_positions()
    if helper.last_api_error is not None:
        return None, f'Dhan positions call failed: {helper.last_api_error}'
    legs = {}
    if df is None or df.empty:
        return legs, None
    for _, row in df.iterrows():
        try:
            qty = int(float(row.get('netQty', 0) or 0))
        except (TypeError, ValueError):
            continue
        if qty == 0:
            continue
        segment = str(row.get('exchangeSegment', '') or '')
        sym = str(row.get('tradingSymbol', '') or '')
        if segment and segment != 'NSE_FNO':
            continue
        if not sym.upper().startswith('NIFTY'):
            continue
        opt_type = normalize_opt_type(row.get('drvOptionType'))
        if opt_type is None:
            continue  # a future, or an option type we refuse to guess
        legs[(dhan_expiry(row.get('drvExpiryDate')), float(row.get('drvStrikePrice', 0) or 0), opt_type)] = {
            'dhan_symbol': sym,
            'qty': qty,
        }
    return legs, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', action='store_true', help='emit JSON only (last line), for API routes')
    args = ap.parse_args()

    def out(*a):
        if not args.json:
            print(*a)

    report = {
        'ts': datetime.now().isoformat(),
        'ok': False,
        'checked': False,
        'zombies': [],
        'missing': [],
        'qty_mismatch': [],
        'untracked': [],
        'hedges': [],
        'in_sync': [],
        'unreplicated_fills': [],
        'bridge': {},
        'errors': [],
    }

    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper
    from scripts.tools.zerodha_instruments_cache import restore_session_from_json
    from scripts.tools.live_options_ws_zerodha import load_zerodha_instruments_cache

    cfg = load_config()
    children = [c for c in cfg.get('children', []) if c.get('enabled')]
    multiplier = 1
    if children:
        try:
            multiplier = max(1, int(children[0].get('multiplier', 1)))
        except (TypeError, ValueError):
            multiplier = 1
    report['armed'] = bool(cfg.get('armed'))
    report['multiplier'] = multiplier

    # ---- bridge health -------------------------------------------------
    status = read_json(STATUS_FILE, {})
    if isinstance(status, dict) and status:
        age = None
        if status.get('last_update_ts'):
            try:
                age = round(datetime.now().timestamp() - float(status['last_update_ts']), 1)
            except (TypeError, ValueError):
                age = None
        # A heartbeat older than a few intervals means the process is hung or
        # dead even though the file still says RUNNING.
        stale = (status.get('status') == 'RUNNING' and age is not None
                 and age > HEARTBEAT_INTERVAL_SEC * 4)
        report['bridge'] = {
            'status': status.get('status'),
            'pid': status.get('pid'),
            'heartbeat_age_sec': age,
            'stale_heartbeat': stale,
            'ws_thread_alive': status.get('ws_thread_alive'),
            'ws_connected': status.get('ws_connected'),
            'ws_connected_for_sec': status.get('ws_connected_for_sec'),
            'ws_last_event_age_sec': status.get('ws_last_event_age_sec'),
            'ws_connect_failures': status.get('ws_connect_failures'),
            'poll_count': status.get('poll_count'),
            'failed_replications': status.get('failed_replications'),
            'pending_retries': status.get('pending_retries'),
            'detail': status.get('detail'),
        }

    # ---- log audit: fills the bridge knows it never replicated ---------
    log = read_json(LOG_FILE, {'entries': []})
    for e in (log.get('entries', []) if isinstance(log, dict) else []):
        why = UNREPLICATED_RESULTS.get(e.get('result'))
        if why:
            report['unreplicated_fills'].append({
                'ts': e.get('ts'),
                'result': e.get('result'),
                'symbol': e.get('zerodha_symbol') or e.get('parent_symbol') or e.get('symbol'),
                'side': e.get('side'),
                'qty': e.get('child_qty') or e.get('qty'),
                'why': why,
                'error': e.get('error'),
            })

    # ---- live position comparison --------------------------------------
    dhan = get_dhan_client()
    if not dhan:
        report['errors'].append('Dhan auth failed — run login.py')
        return finish(report, args, out)
    helper = DhanHelper(dhan)

    dhan_legs, err = collect_dhan_legs(helper)
    if err:
        report['errors'].append(err)
        return finish(report, args, out)

    kite = restore_session_from_json()
    if kite is None:
        report['errors'].append('No Zerodha session — run zerodha_autologin.py')
        return finish(report, args, out)
    try:
        zpos = kite.positions().get('net', [])
    except Exception as e:
        # Includes the daily-token-expiry case; must not be read as "child flat".
        report['errors'].append(f'Zerodha positions call failed ({e}) — run zerodha_autologin.py')
        return finish(report, args, out)

    try:
        instruments = load_zerodha_instruments_cache()
    except Exception as e:
        report['errors'].append(f'Zerodha instrument cache load failed: {e}')
        return finish(report, args, out)

    scope = load_replicated_symbols()
    report['replication_scope'] = sorted(scope)

    # Hedges are long OTM options the bridge bought purely to free up margin.
    # They have NO Dhan counterpart by design, so the zombie rule (open on
    # Zerodha, absent on Dhan, inside bridge scope) would flag every single one
    # and turn a healthy account into a permanent NEEDS ATTENTION.
    try:
        from scripts.tools.copy_trade_hedge import hedge_symbols_today
        hedge_scope = hedge_symbols_today()
    except Exception as e:
        hedge_scope = set()
        report['errors'].append(f'could not read hedge state ({e}) — hedges may show as zombies')
    report['hedge_scope'] = sorted(hedge_scope)

    zerodha_qty = {}
    for p in zpos:
        try:
            q = int(p.get('quantity', 0) or 0)
        except (TypeError, ValueError):
            continue
        if q != 0:
            zerodha_qty[p.get('tradingsymbol')] = q

    matched_child_symbols = set()
    for (expiry, strike, opt_type), leg in sorted(dhan_legs.items()):
        zsym = find_zerodha_symbol(instruments, strike, expiry, opt_type)
        expected = leg['qty'] * multiplier
        if zsym is None:
            report['missing'].append({
                'dhan_symbol': leg['dhan_symbol'], 'expiry': expiry, 'strike': strike,
                'opt_type': opt_type, 'dhan_qty': leg['qty'], 'expected_child_qty': expected,
                'reason': 'no matching Zerodha contract in the instrument cache',
            })
            continue
        matched_child_symbols.add(zsym)
        actual = zerodha_qty.get(zsym, 0)
        row = {
            'dhan_symbol': leg['dhan_symbol'], 'zerodha_symbol': zsym,
            'dhan_qty': leg['qty'], 'expected_child_qty': expected, 'actual_child_qty': actual,
        }
        if actual == expected:
            report['in_sync'].append(row)
        elif actual == 0:
            row['reason'] = 'parent holds this leg, child has no position'
            report['missing'].append(row)
        else:
            row['shortfall'] = expected - actual
            report['qty_mismatch'].append(row)

    # Anything open on Zerodha that the parent does NOT hold. Scope-aware: only
    # symbols the bridge itself traded today count as zombies.
    for zsym, q in sorted(zerodha_qty.items()):
        if zsym in matched_child_symbols:
            continue
        entry = {'zerodha_symbol': zsym, 'child_qty': q}
        # Hedge check comes FIRST: a hedge can also be in the replicated scope
        # (both are bridge-placed), and misreporting it as a zombie would invite
        # a manual close that silently removes the account's margin headroom.
        if zsym in hedge_scope:
            entry['reason'] = 'margin hedge bought by the bridge — no parent leg expected'
            report['hedges'].append(entry)
        elif zsym in scope:
            entry['reason'] = 'bridge opened this leg; parent no longer holds it — ZOMBIE'
            report['zombies'].append(entry)
        else:
            entry['reason'] = 'not in the bridge replication scope — assumed manual, left alone'
            report['untracked'].append(entry)

    report['checked'] = True
    report['ok'] = not (report['zombies'] or report['missing'] or report['qty_mismatch'])
    return finish(report, args, out)


def finish(report, args, out):
    b = report.get('bridge', {})
    out('=' * 72)
    out('COPY-TRADE RECONCILE  ' + report['ts'])
    out('=' * 72)
    out(f"  armed={report.get('armed')}  multiplier={report.get('multiplier')}")
    if b:
        out(f"  bridge: {b.get('status')} pid={b.get('pid')} heartbeat_age={b.get('heartbeat_age_sec')}s"
            f"{'  *** STALE ***' if b.get('stale_heartbeat') else ''}")
        # ws_connected is absent from status files written before it was added.
        conn = b.get('ws_connected')
        conn_txt = 'n/a (bridge predates this field)' if conn is None else ('CONNECTED' if conn else '*** DISCONNECTED ***')
        out(f"  order-update WS: {conn_txt}  thread_alive={b.get('ws_thread_alive')}"
            f"  connect_failures={b.get('ws_connect_failures')}")
        age = b.get('ws_last_event_age_sec')
        out(f"  REST poll fallback: {b.get('poll_count')} polls"
            f"   last order event: {f'{age}s ago' if age is not None else 'none seen'}")
        if b.get('detail'):
            out(f"  detail: {b['detail']}")
    else:
        out('  bridge: no status file — bridge has never run')

    for err in report['errors']:
        out(f'  !! {err}')

    if not report['checked']:
        out('\n  POSITION COMPARISON NOT PERFORMED — resolve the errors above.')
    else:
        out(f"\n  in sync:       {len(report['in_sync'])}")
        for r in report['in_sync']:
            out(f"    OK    {r['zerodha_symbol']:22s} dhan={r['dhan_qty']:+6d} child={r['actual_child_qty']:+6d}")
        if report['zombies']:
            out(f"\n  ZOMBIES:       {len(report['zombies'])}  (open on Zerodha, parent flat)")
            for r in report['zombies']:
                out(f"    ZOMBIE {r['zerodha_symbol']:22s} child={r['child_qty']:+6d}  {r['reason']}")
        if report['missing']:
            out(f"\n  MISSING:       {len(report['missing'])}  (parent holds, child does not)")
            for r in report['missing']:
                out(f"    MISS  {r.get('zerodha_symbol') or r.get('dhan_symbol'):22s} "
                    f"dhan={r.get('dhan_qty'):+6d} expected={r.get('expected_child_qty'):+6d}  {r.get('reason')}")
        if report['qty_mismatch']:
            out(f"\n  QTY MISMATCH:  {len(report['qty_mismatch'])}")
            for r in report['qty_mismatch']:
                out(f"    QTY   {r['zerodha_symbol']:22s} expected={r['expected_child_qty']:+6d} "
                    f"actual={r['actual_child_qty']:+6d} shortfall={r['shortfall']:+6d}")
        if report['hedges']:
            out(f"\n  margin hedges: {len(report['hedges'])}  (bridge-bought, no parent leg expected)")
            for r in report['hedges']:
                out(f"    HEDGE {r['zerodha_symbol']:22s} child={r['child_qty']:+6d}")
        if report['untracked']:
            out(f"\n  untracked:     {len(report['untracked'])}  (not bridge-traded — left alone)")
            for r in report['untracked']:
                out(f"    ----  {r['zerodha_symbol']:22s} child={r['child_qty']:+6d}")

    if report['unreplicated_fills']:
        out(f"\n  fills the bridge logged as NOT replicated: {len(report['unreplicated_fills'])}")
        for r in report['unreplicated_fills'][-15:]:
            out(f"    {r['ts']}  {r['result']:20s} {str(r['symbol']):22s} {str(r['side']):5s} "
                f"qty={r['qty']}  ({r['why']})")

    out('\n  VERDICT: ' + ('IN SYNC' if report['ok'] and report['checked']
                           else 'NEEDS ATTENTION' if report['checked'] else 'UNKNOWN'))
    out('=' * 72)

    if args.json:
        print(json.dumps(report))
    return 0 if (report['ok'] and report['checked']) else (1 if report['checked'] else 2)


if __name__ == '__main__':
    sys.exit(main())
