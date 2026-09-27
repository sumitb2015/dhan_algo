## Summary

Positional (multi-day carry, `MARGIN`) Nifty short strangle managed purely by absolute delta
drift rather than premium value. Enters weekly, holds legs independently, and rolls each leg
on its own delta threshold — distinct from the intraday `value_imbalance/` strangles, which
rebalance on premium imbalance instead.

## Entry

- Enters once per week, on `--entry-weekday` (default **Wednesday**) from `--entry-time` (default **09:20 IST**).
- Traded expiry is the expiry **after** the soonest listed one (≈13 days out at entry).
- CE and PE strikes chosen independently: filter to strikes with delta magnitude `<= --entry-delta` (default **0.15**), take the strike with the largest qualifying delta (closest to 0.15 from below).
- Two entry-only gates: inversion guard (`CE strike > PE strike`) and premium symmetry — `min(ce,pe)/max(ce,pe) >= --premium-symmetry-min` (default **0.80**). Either failing skips that week's entry attempt (retried next poll, still Wednesday).
- Sizing via `--lots` (bypasses margin-based auto-sizing) or `--target-capital` (default **₹400,000**) with `--min-lots` (default **1**).

## Exit

- Scheduled exit on `--exit-weekday` (default **Tuesday**) at `--exit-time` (default **15:15**) — buys back both legs and goes idle until next Wednesday.
- Legs are placed with `product=MARGIN`, never intraday, so nothing force-squares off same-day.

## Target

- No fixed rupee/percentage profit target — the position is closed only by the scheduled Tuesday exit or a roll/emergency event; profit is realized through weekly premium decay and rolls.

## Stop Loss

- No global rupee stop loss. Each leg is rolled independently on delta drift: `abs(delta) >= --roll-up-delta` (default **0.35**, run too far ITM) or `abs(delta) < --roll-down-delta` (default **0.08**, decayed too far OTM) — buy back and re-sell at `--entry-delta` on the same expiry.
- Post-roll inversion check: if a roll causes `CE strike <= PE strike`, triggers `EMERGENCY_FLATTENED` — both legs closed, 5-minute cooldown before re-entry eligibility.
- Hard backstop: a resting SL-M order per leg (Dhan only) at `entry_premium × --hard-sl-multiple` (default **3x**), a dead-man's-switch in case the process can't poll in time — not a normal exit path.
