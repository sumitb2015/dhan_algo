## Summary

Intraday Nifty short-options strategy that picks its CE and PE strikes **independently**,
each the strike whose delta is closest to a target absolute delta (default **0.5**), rather
than requiring both legs to share a strike or a balanced premium. When one leg decays far
enough relative to the other, the cheaper leg is closed and rolled to a strike whose premium
matches the more expensive leg's value. Unlike every other strategy in this repo, an inverted
strangle (CE strike below PE strike) is a valid, expected outcome here — the inversion guard
is deliberately not applied.

## Entry

- Selects the CE strike and the PE strike each closest to `--target-delta` (default **0.5**), independently — the two legs may land on different or even inverted strikes.
- No CE/PE balance-wait gate: sells `--lots` (default **1**) of each leg as soon as both report a valid LTP.
- Monitoring starts at `--start-time` (default **09:20** IST).

## Exit

- Winner-roll adjustment: once `min(CE,PE)/max(CE,PE) < (100 − threshold_lot)%` — with the default `--threshold-lot 50.0`, that's `min/max < 50%` — the winning (cheaper) leg is bought back and re-sold at a new OTM strike whose premium matches the losing leg's current value.
- **No inversion guard** — the resulting position can legitimately be a straddle, strangle, or inverted strangle.
- Cycle reset: spot drifts ≥100 points from the entry spot — exits both legs, pauses 5 minutes, and restarts with a fresh delta-based strike selection.
- Hard intraday square-off at **15:17 IST**.

## Target

- Global daily profit target `--target-profit`, default **₹4,000** (INR or a % of entry premium, e.g. `20%`).

## Stop Loss

- Global daily stop loss `--stop-loss`, default **₹4,000** (INR or a % of entry premium).
- Trailing SL: arms once profit reaches `--trail-start-pct` (**5.0%**) of entry premium, then exits if combined premium rises `--trail-gap-pts` (**15.0** pts) above its best level since arming.
