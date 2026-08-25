#!/usr/bin/env python
"""
Focus Tool worker — booked P&L across leg-wise SL / partial closes.

    venv\\Scripts\\python.exe tests/test_focus_tool_booked_pnl.py

Reproduction (2026-08-25 live): worker entered a NIFTY straddle, CE SL × fired
and closed the call, PE stayed open. The status snapshot's `pnl` (and therefore
the dashboard row) only showed the leftover PE's live MTM — the closed CE's
realised loss vanished. A second bug followed: after the PE also went flat the
row stayed `armed`, so the worker immediately re-entered.

These helpers are the pure half of that fix. Safe to run any time — no broker.
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from scripts.tools.focus_tool_rows_worker import (  # noqa: E402
    bank_closed_leg, cumulative_row_pnl, apply_leg_drop,
)

failures = []
checked = 0


def check(name, got, want):
    global checked
    checked += 1
    if got != want:
        failures.append(f'{name}\n    expected: {want!r}\n    got:      {got!r}')


def test_bank_closed_leg_short_loss():
    # CE sold @ 38, closed when premium hit 46 (SL ×1.2), qty 130.
    delta = bank_closed_leg({'entryPrice': 38.0, 'qty': 130}, ltp=46.0)
    check('CE SL banks the short loss', delta, (38.0 - 46.0) * 130)


def test_bank_closed_leg_short_profit():
    delta = bank_closed_leg({'entryPrice': 50.0, 'qty': 65}, ltp=30.0)
    check('closed leg banks the short profit', delta, (50.0 - 30.0) * 65)


def test_bank_closed_leg_refuses_missing_mark():
    check('no LTP → no bank (never silently bank 0)', bank_closed_leg(
        {'entryPrice': 38.0, 'qty': 130}, ltp=0.0), 0.0)
    check('no entry → no bank', bank_closed_leg(
        {'entryPrice': 0.0, 'qty': 130}, ltp=46.0), 0.0)


def test_cumulative_includes_booked_plus_live():
    fill = {
        'bookedPnl': -1040.0,
        'PE': {'strike': 24200, 'qty': 130, 'entryPrice': 49.6},
    }
    live = {'PE': 40.0}
    # booked −1040 + PE MTM (49.6-40)*130 = −1040 + 1248 = 208
    check('leg-wise SL cumulative P&L',
          round(cumulative_row_pnl(fill, live), 2), 208.0)


def test_cumulative_without_booked_is_live_only():
    fill = {'PE': {'strike': 24200, 'qty': 130, 'entryPrice': 49.6}}
    check('no booked → live only',
          round(cumulative_row_pnl(fill, {'PE': 40.0}), 2), 1248.0)


def test_apply_leg_drop_clears_ghost_and_pops_when_flat():
    fills = {
        'row1': {
            'bookedPnl': 100.0,
            'PE': {'strike': 24200, 'qty': 130, 'entryPrice': 49.6},
            'expiry': '2026-08-25', 'underlying': 'NIFTY',
        },
    }
    changed, booked_out = apply_leg_drop(fills, 'row1', 'PE')
    check('drop reports changed', changed, True)
    check('ghost PE gone from ledger', 'row1' in fills, False)
    check('booked carried out for session total', booked_out, 100.0)


def test_apply_leg_drop_leaves_other_leg():
    fills = {
        'row1': {
            'bookedPnl': -500.0,
            'CE': {'strike': 24200, 'qty': 130, 'entryPrice': 37.0},
            'PE': {'strike': 24200, 'qty': 130, 'entryPrice': 49.6},
        },
    }
    changed, booked_out = apply_leg_drop(fills, 'row1', 'CE')
    check('partial drop changed', changed, True)
    check('PE still held', 'PE' in fills['row1'], True)
    check('CE gone', 'CE' in fills['row1'], False)
    check('row not popped while PE remains', booked_out, 0.0)


if __name__ == '__main__':
    test_bank_closed_leg_short_loss()
    test_bank_closed_leg_short_profit()
    test_bank_closed_leg_refuses_missing_mark()
    test_cumulative_includes_booked_plus_live()
    test_cumulative_without_booked_is_live_only()
    test_apply_leg_drop_clears_ghost_and_pops_when_flat()
    test_apply_leg_drop_leaves_other_leg()

    print(f'{checked} checks, {len(failures)} failures')
    for f in failures:
        print('FAIL:', f)
    sys.exit(1 if failures else 0)
