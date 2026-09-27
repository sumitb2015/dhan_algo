## Summary

Continuous stop-and-reverse (SAR) MCX CRUDEOILM futures strategy driven by Renko bricks built
from 5-minute candle closes. Always holds a position during session hours — no daily profit/loss
caps, purely structural: flips only after a run of consecutive opposite-colored bricks.

## Entry

- Initial entry (and any restart): takes the direction of the latest completed Renko brick — green → LONG, red → SHORT.
- Bricks are close-only (highs/lows ignored), box size `--box-size` (default **5** points), anchored to the first candle close of the lookback window (`--days`, default **5**).
- `--qty` (default **10** barrels = 1 lot; MCX lot size is 10) sent directly to the broker — unlike the other crudeoil strategies, this one takes raw quantity, not `--lots`.

## Exit

- No target/stop-based exit — pure SAR: while LONG, holds through 1–2 red bricks; **3 consecutive red bricks** (`--reverse-bricks`, default **3**) exits and immediately enters SHORT (symmetric for SHORT).
- Only the EOD time (`--eod-time`, default **23:30**) flattens the position outright.
- If a reversal re-entry order fails, stays flat and retries on the next poll.
- Positions are **not** recovered on restart — only realized P&L is restored; flatten manually first if restarting while holding a position.

## Target

- None. This strategy has no profit target — it holds continuously and flips direction on brick reversal signals.

## Stop Loss

- None (no per-trade or daily rupee stop). Risk is bounded only by the reversal rule (3 consecutive opposite bricks) and the EOD flatten.
