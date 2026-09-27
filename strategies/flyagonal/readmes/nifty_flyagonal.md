## Summary

**UNVALIDATED — dry-run by default.** Positional (multi-day, `MARGIN`), defined-risk, five-leg
Nifty structure combining a call broken-wing butterfly with a put diagonal, adapted from a
US-SPX video with no Nifty backtest evidence. The edge hypothesis: the butterfly profits if
Nifty drifts up and vol falls, the put diagonal profits if Nifty falls and vol rises, and
short-dated shorts decay faster than the longs.

## Entry

- Any weekday from `--entry-time` (default **09:30**), market open, no open position.
- Front expiry F: first listed expiry **8–10** days out (`--entry-dte-min/max`). Back expiry B (long put): later expiry **15–20** days out (`--back-dte-min/max`), closest to 2× F's DTE.
- Strikes from spot, rounded to `--strike-step` (default **50**): butterfly body ~3% above spot, wings at `--fly-lower-pct` (2.2%) / `--fly-upper-pct` (4.1%); short put at `--put-pct` (3.0%) below spot; long back put offset `--diag-offset` (50 pts) further out.
- Legs placed longs-first: buy K1, buy K3, buy long back put, then sell 2× K2 (body), sell short put — so shorts are always covered.
- Size fixed at `--lots` (default **1**), capped by `--max-lots` (default **5**). Skips the tick entirely if any leg price is missing/zero, or net debit exceeds `--max-net-debit`.

## Exit

Checked in order each poll:
1. Stop: `total_pnl <= -stop` (`--stop-loss`, default **none**).
2. Target: `total_pnl >= --target-profit` (default **10%** of max loss).
3. Time: front DTE `< --exit-dte` (default **4**), or reaches it at/after `--exit-time` (default **15:15**).
- Exits close shorts first, then longs. Dashboard Stop (or Ctrl-C) also flattens immediately — nothing else supervises the time exit.

## Target

- `--target-profit`, default **10%** of the position's max loss at F's expiry (`max(wing gap, put gap) + net debit`, × units).
- After an adjustment, the target drops to `--adjusted-target`, default **5%**.

## Stop Loss

- `--stop-loss`, default **none** (the source video has no stop rule) — INR or % of max loss if set.
- One capped adjustment rule: if net position delta per lot `<= -(--adjust-delta)` (default **0.10**), rolls the short front put **up** `--adjust-step` (default **50** pts) to add positive delta — at most `--max-adjustments` (default **1**) per cycle.
- `--max-cumulative-loss` (optional) halts new entries once breached; must be manually cleared to resume.
