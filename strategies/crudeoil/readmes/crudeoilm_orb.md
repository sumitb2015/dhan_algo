## Summary

Opening Range Breakout strategy on MCX CRUDEOILM futures, with the stop supplied by market
structure (swing pivots) rather than the range itself. The opening range gives the entry level;
pivots give the trailing exit, and optionally filter out weak breakouts.

## Entry

- Records the opening range high/low (ORH/ORL) during `--or-minutes` (default **15**) after `--session-start` (default **09:00**); no trading during the window.
- After the window, on the last **closed** candle: LONG if `close > ORH` (and, unless `--no-pivot-filter`, close is also above the last confirmed pivot high); SHORT if `close < ORL` (and below the last confirmed pivot low). Requires a close beyond the level, not a mere wick-through.
- If no pivot has confirmed yet, the pivot filter is skipped rather than blocking the trade.
- One entry per side per day (lift with `--allow-reentry`). `--lots`, default **1** (10 barrels each).

## Exit

Priority order:
1. Dashboard shutdown trigger.
2. EOD (`--eod-time`, default **23:30**).
3. Daily profit target.
4. Daily stop loss.
5. Stop hit — whichever stage is currently active (range edge or trailed pivot).
- Restart restores today's P&L and the one-trade-per-side caps, so a restart cannot re-take a side already traded.

## Target

- Daily profit cap `--target-profit`, default **₹3,000**.

## Stop Loss

- Daily stop-loss cap `--stop-loss`, default **₹3,000**.
- Two-stage per-trade stop: **Stage 1** on entry, stop is the opposite edge of the opening range (e.g. long → ORL). **Stage 2**, once a pivot confirms (`--pivot-n` candles either side on `--pivot-interval`-minute candles, defaults **5** / **1**), the stop moves to the pivot and ratchets only — it never loosens.
