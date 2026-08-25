#!/usr/bin/env python
"""
Focus Tool worker — ownership when two rows share one broker strike.

    venv\\Scripts\\python.exe tests/test_focus_tool_shared_strike.py

Reproduction (2026-08-25 live): a second row was armed on the same NIFTY
24150 ATM straddle an existing row already held. Symptoms: the new row's
combined premium/SL x reflected the FULL broker position (both rows' lots),
not its own 1 lot; and after its own SL fired, it stayed stuck "active"
instead of retiring. Root cause: every place computing "how much does THIS
row own" fell back to the raw broker position on a missing/zero own qty,
instead of falling back to zero.

These helpers are the pure half of that fix. Safe to run any time — no broker.
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from scripts.tools.focus_tool_rows_worker import broker_avg_trusted  # noqa: E402

failures = []
checked = 0


def check(name, got, want):
    global checked
    checked += 1
    if got != want:
        failures.append(f'{name}\n    expected: {want!r}\n    got:      {got!r}')


def test_trusted_when_own_ledger_fully_accounts_for_the_broker_position():
    # This row's own ledger says 195, and the broker shows exactly 195 at
    # that security — nothing else holds this leg, safe to adopt the average.
    check('sole owner: broker qty == own qty -> trusted',
          broker_avg_trusted(195, 195), True)


def test_untrusted_when_another_row_shares_the_strike():
    # A second row's own ledger also holds 260 at this same security — the
    # broker's combined qty (455) exceeds this row's own 195. The average is
    # a blend of both rows' entries, not this row's own true cost basis.
    check('shared with another row\'s own ledger -> untrusted',
          broker_avg_trusted(455, 195), False)


def test_untrusted_for_an_untracked_residual_leftover():
    # No second row's ledger accounts for the gap — it's a leftover from a
    # leg-wise SL close or a partial fill that never fully reconciled. A
    # plain "how many rows hold this key" count would miss this entirely
    # (there IS no second ledger entry), which is exactly the gap this
    # broker-qty-match check closes over the old shared_leg_keys approach.
    check('untracked residual (broker qty > own, no other ledger) -> untrusted',
          broker_avg_trusted(390, 195), False)


def test_untrusted_when_snapshot_missing_or_stale():
    check('security not found in snapshot (unknown) -> untrusted',
          broker_avg_trusted(None, 195), False)
    check('broker qty smaller than own (stale read) -> untrusted',
          broker_avg_trusted(65, 195), False)


def test_trusted_at_zero_only_when_genuinely_flat_both_sides():
    check('both zero -> trusted (genuinely flat)',
          broker_avg_trusted(0, 0), True)


if __name__ == '__main__':
    test_trusted_when_own_ledger_fully_accounts_for_the_broker_position()
    test_untrusted_when_another_row_shares_the_strike()
    test_untrusted_for_an_untracked_residual_leftover()
    test_untrusted_when_snapshot_missing_or_stale()
    test_trusted_at_zero_only_when_genuinely_flat_both_sides()

    print(f'{checked} checks, {len(failures)} failures')
    for f in failures:
        print('FAIL:', f)
    sys.exit(1 if failures else 0)
