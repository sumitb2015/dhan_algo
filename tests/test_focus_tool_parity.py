#!/usr/bin/env python
"""
The server-side half of the Focus Tool parity suite.

    venv\\Scripts\\python.exe tests/test_focus_tool_parity.py

Two implementations decide when the Focus Tool opens and closes real positions:
lib/focusToolRules.ts in the browser tab, and the evaluate_* functions in
scripts/tools/focus_tool_rows_worker.py here. They read the same config file and
whichever is up at the time is the one placing orders, so a disagreement means
the screen shows one thing and the account does another.

This runs the Python side against rs_dashboard/lib/focusToolRules.cases.json —
the same fixture rs_dashboard/lib/focusToolRules.test.ts runs the TypeScript
side against. Reasons are compared character for character, because the reason
is what gets logged and shown, and the order of the checks is what decides which
one you see.

Unlike the rest of tests/, this touches no broker and has no side effects: every
function under test is pure. It is safe to run any time, and it is NOT part of
run_all_tests.py's live-account suite.
"""

import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

CASES_FILE = os.path.join(ROOT, 'rs_dashboard', 'lib', 'focusToolRules.cases.json')

from scripts.tools.focus_tool_rows_worker import (   # noqa: E402
    evaluate_entry, evaluate_global_risk, evaluate_row_exit, evaluate_leg_exit,
    dte_for, dte_matches, parse_hhmm,
)

failures = []
checked = 0


def check(name, got, want):
    global checked
    checked += 1
    if got != want:
        failures.append(f'{name}\n    expected: {want!r}\n    got:      {got!r}')


def load_cases():
    with io.open(CASES_FILE, encoding='utf-8') as f:
        return json.load(f)


# ── Fixture -> the shapes the Python rules take ──────────────────────────────

def premium_and_entry(case_live, side):
    """Qty-weighted average premium and entry premium across the legs this
    Side trades AND that are still open — matching lib/focusToolRules.test.ts's
    own `live()` fixture helper, which builds RowLive.entryPremium the same
    way FocusTool.tsx does (qty-weighted), and matching sidePremium in
    lib/focusToolRules.ts, which is qty-weighted too (not a plain CE+PE sum —
    a straddle with uneven CE/PE lots must not be measured as if both sides
    were worth one lot each)."""
    legs = ['CE', 'PE'] if side == 'BOTH' else [side]
    num_p = den_p = 0.0
    num_e = den_e = 0.0
    for leg in legs:
        qty = abs(case_live['ceQty'] if leg == 'CE' else case_live['peQty'])
        if qty == 0:
            continue
        ltp = case_live['ceLtp'] if leg == 'CE' else case_live['peLtp']
        entry = case_live['ceEntry'] if leg == 'CE' else case_live['peEntry']
        num_p += ltp * qty
        den_p += qty
        num_e += entry * qty
        den_e += qty
    premium = num_p / den_p if den_p > 0 else 0.0
    entry_premium = num_e / den_e if den_e > 0 else 0.0
    return premium, entry_premium


def test_entry(cases):
    for c in cases['entry']:
        row, ctx = c['row'], c['ctx']
        group = {'enabled': ctx['groupEnabled'], 'product': ctx['product']}
        now_minutes = parse_hhmm(ctx['nowHm'])
        enter, reason = evaluate_entry(
            row, group, now_minutes, ctx['dte'], ctx['strikesReady'], flat=ctx['flat'])
        check(f"entry :: {c['name']}", (enter, reason),
              (c['expect']['enter'], c['expect']['reason']))


def test_global_risk(cases):
    for c in cases['globalRisk']:
        cfg = {
            'riskEnabled': c['cfg']['riskEnabled'],
            'targetRupees': c['cfg']['targetRupees'],
            'stopRupees': c['cfg']['stopRupees'],
            'trailEnabled': c['cfg']['trailEnabled'],
            'triggerRupees': c['cfg']['triggerRupees'],
            'lockRupees': c['cfg']['lockRupees'],
        }
        exit_all, reason, lock_floor, trail_state = evaluate_global_risk(
            cfg, c['ctx']['totalPnl'], c['ctx']['peakPnl'], c['ctx']['lockFloor'])
        check(f"risk :: {c['name']}",
              (exit_all, reason, lock_floor, trail_state),
              (c['expect']['exitAll'], c['expect']['reason'],
               c['expect']['lockFloor'], c['expect']['trailState']))


def test_row_exit(cases):
    for c in cases['rowExit']:
        row, live = c['row'], c['live']
        premium, entry = premium_and_entry(live, row['side'])
        got = evaluate_row_exit(
            row, float(c['spot']), premium, entry,
            float(live.get('pnl') or 0.0), live.get('vwap'), live.get('vwapClose'))
        check(f"rowExit :: {c['name']}", got, c['expect'])


def test_leg_stop(cases):
    for c in cases['legStop']:
        leg, live = c['leg'], c['live']
        qty = live['ceQty'] if leg == 'CE' else live['peQty']
        entry = live['ceEntry'] if leg == 'CE' else live['peEntry']
        ltp = live['ceLtp'] if leg == 'CE' else live['peLtp']
        # A flat leg carries no ledger entry at all on this side, which is how
        # the worker represents "not held" — matching netQty 0 in the browser.
        fill = {leg: {'strike': 24000, 'qty': abs(qty), 'entryPrice': entry}} if qty else {}
        fired, reason = evaluate_leg_exit(c['row'], leg, fill, ltp)
        check(f"legStop :: {c['name']}", reason if fired else None, c['expect'])


def test_dte(cases):
    for c in cases['dte']:
        check(f"dte :: {c['expiry']!r} from {c['today']}",
              dte_for(c['expiry'], c['today']), c['expect'])


def test_local_invariants():
    """Properties the shared fixture cannot express."""
    check('dteMatches Any admits a lapsed expiry', dte_matches('Any', -1), True)
    check('dteMatches Any admits unknown', dte_matches('Any', None), True)
    check('dteMatches 0 rejects unknown', dte_matches('0', None), False)
    check('dteMatches 0+1 rejects 2', dte_matches('0+1', 2), False)

    check('parse_hhmm rejects a bad hour', parse_hhmm('24:00'), None)
    check('parse_hhmm rejects a bad minute', parse_hhmm('10:60'), None)
    check('parse_hhmm rejects empty', parse_hhmm(''), None)
    check('parse_hhmm accepts a single-digit hour', parse_hhmm('9:20'), 560)

    # Two failed quote reads sum to zero. Without the > 0 guards that reads as
    # "collapsed below VWAP" and as an infinite loss multiple.
    dead = {'levelHigh': '', 'levelLow': '', 'levelVw': True,
            'slRupees': '', 'slMultiplier': '2', 'side': 'BOTH'}
    check('zero premium never fires a premium rule',
          evaluate_row_exit(dead, 24000.0, 0.0, 180.0, 0.0, 195.0, 0.0), None)

    # The floor can only ever rise, and the fall through it fires.
    cfg = {'riskEnabled': False, 'targetRupees': '', 'stopRupees': '',
           'trailEnabled': True, 'triggerRupees': '2000', 'lockRupees': '500'}
    floor, peak, seen = None, 0.0, []
    for pnl in (500, 2000, 3500, 5000, 4200, 4800, 3000):
        peak = max(peak, pnl)
        exit_all, _r, floor, _t = evaluate_global_risk(cfg, pnl, peak, floor)
        seen.append(floor)
        if exit_all:
            break
    monotonic = all(seen[i] >= seen[i - 1]
                    for i in range(1, len(seen)) if seen[i - 1] is not None)
    check('trail floor is monotonic', monotonic, True)
    check('trail floor ends at the ratcheted peak', floor, 4500)


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass

    if not os.path.exists(CASES_FILE):
        print(f'FIXTURE MISSING: {CASES_FILE}')
        return 1

    cases = load_cases()
    test_entry(cases)
    test_global_risk(cases)
    test_row_exit(cases)
    test_leg_stop(cases)
    test_dte(cases)
    test_local_invariants()

    if failures:
        print(f'\n{len(failures)} of {checked} checks FAILED:\n')
        for f in failures:
            print('  ' + f)
        print('\nThe browser and the worker disagree about when to trade. '
              'Fix both, or the screen and the account will diverge.')
        return 1

    print(f'All {checked} parity checks passed '
          f'(shared fixture: rs_dashboard/lib/focusToolRules.cases.json)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
