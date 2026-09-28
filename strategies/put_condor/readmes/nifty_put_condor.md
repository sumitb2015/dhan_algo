## Summary

**UNVALIDATED — dry-run only.** No backtest and only one static worked example in the source
evidence; `--live` requires `--i-understand-this-is-unvalidated`. A puts-only monthly positional
structure: a near-the-money bear put spread (BUY the higher strike, SELL the lower strike) stacked
above a second, further-OTM bear put spread (SELL the higher strike, BUY the lower strike) — a
standard 4-leg **put condor** (BUY/SELL/SELL/BUY by strike), described in the source as "two stacked
bear put spreads." Defined risk on both sides by construction; max profit sits in a moderate-decline
zone between the two short strikes.

## Entry

- One cycle per monthly expiry: when flat, enters the first monthly expiry whose DTE is inside
  `--min-dte`–`--max-dte` (default **20–38** days), skipping the expiry it last traded. After an
  expiry that is the next trading day.
- Entry window on any trading day: `--entry-time` (default **09:45**) to `--entry-end` (default **15:00**).
- Sizing: `--lots` (default **1**) applies equally to all four legs.
- Strikes, each an independent point offset below spot rounded to `--strike-step` (default **50**):
  upper long put at spot − `--upper-long-offset` (default **150**), upper short put at spot −
  `--upper-short-offset` (**350**), lower short put at spot − `--lower-short-offset` (**550**), lower
  long put at spot − `--lower-long-offset` (**700**). Offsets must be strictly increasing; if rounding
  collapses two strikes together, that cycle's entry is skipped.
- Order: both long legs first, then both short legs. Any leg with a missing/zero quote aborts entry
  before placing anything; a mid-entry failure unwinds every placed leg, shorts first.

## Exit

Checked in order, first match wins (no decision on a tick where a leg has no quote):
1. Target hit.
2. Stop hit.
3. Expiry-day EOD: flattens everything at `--eod-exit-time`, default **15:17**, on the position's own
   monthly expiry day.
4. **Partial booking** (once, `--lots >= 2` only): close half the entry lots on all four legs (shorts
   first) when P&L reaches `--partial-booking-profit` (default **2.5%** of deployed margin), keep the
   rest open at the same target/stop.
5. Otherwise holds untouched until the next check.
- Every exit closes shorts first and keeps the longs as the hedge until no short remains.
- A dashboard Stop request, or `--max-consecutive-stops` (default **3**) breach, can also end/pause a
  cycle (the latter pauses new entries without closing an already-open position).
- **No adjustment** in v1 — the source teases a rally-side adjustment for "part two" but gives no rule.

## Target

- `--target-profit`, default **10%** of the margin actually blocked for the combo (resolved once at
  entry, never re-based after a partial close — falls back to `--fallback-margin-per-lot`, default
  ₹80,000/lot, if the margin call fails).

## Stop Loss

- `--stop-loss`, default **4%** of the same deployed-margin base. With the default offsets this is a
  backstop that normally can't fire: the worst case, before or at expiry, is the net debit paid
  (~2.6% of margin in a 2026-09-28 dry run), because the upper spread is wider than the lower one.
  The computed max loss/profit is logged at every entry.
