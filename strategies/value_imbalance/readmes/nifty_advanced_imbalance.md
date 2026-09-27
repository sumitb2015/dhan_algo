## Summary

Intraday Nifty options seller. Sells an ATM straddle or an OTM strangle and holds a
**value-imbalance** book: as one leg decays faster than the other, it either averages down
the winning leg or rolls the losing leg to a fresh strike, keeping the book approximately
premium-balanced without going fully directional. Five selectable adjustment modes trade off
margin efficiency against tail-risk hedging. Intraday only — no overnight carry.

## Entry

- Waits for CE and PE premiums to balance within a threshold before selling (mode-dependent; the underlying framework uses **15%** for straddle / **25%** for strangle balance checks).
- **Straddle** (`--entry-type straddle`, default): sells ATM CE + ATM PE, **1** lot each (`--lots`).
- **Strangle** (`--entry-type strangle`): sells OTM CE/PE chosen by distance (`--ce-offset`/`--pe-offset`, default **200** pts each), delta (`--target-delta`, default **0.20**), or premium (`--target-premium`, default **50.0**).
- Monitoring starts at `--start-time` (default **09:20** IST).

## Exit

- **`winner_roll_atm`** (default mode): once premium imbalance exceeds `--threshold-lot` (**25.0%**) plus the entry-baseline offset, sells 1 more lot on the winning leg (up to `--max-lots`, default **4**); once `--threshold-strike` (**40.0%**) is breached, shifts the losing leg to a value-matched further-OTM strike instead.
- **`loser_ratio_roll`**: rolls the losing leg further OTM and adds `--loser-ratio-lots` (default **1**) to it.
- **`hedged_addition`**: adds winner lots but buys a 200-pt-further hedge each time.
- **`reentry_straddle`** (straddle only): each leg gets its own SL at `--leg-sl-pct` (**20%**) above entry; a stopped leg re-enters once its price drops back to the original entry premium. `--max-lots` has no effect in this mode.
- **Inversion guard**: `CE strike > PE strike` is enforced at entry and after every roll (all modes except `reentry_straddle`'s independent legs) — a violation forces an emergency exit, 5-minute pause, and fresh cycle.
- **Cycle reset**: straddle ATM shift ≥100 pts from entry, or strangle spot breach of either strike, exits everything, pauses 5 minutes, and restarts.
- Hard intraday square-off at **15:17 IST**.

## Target

- Global daily profit target `--target-profit`, default **₹4,000**.
- Optional **Scalp Lock**: `--scalp-floor-pct` (default **0.0**, disabled) exits immediately once combined premium decays this % from entry; `--multi-cycle` auto-restarts a fresh cycle after a Scalp Lock/target exit, with `--cycle-cooldown` (default **300s**) between cycles.

## Stop Loss

- Global daily stop loss `--stop-loss`, default **₹4,000**.
- Trailing SL on combined premium: arms once profit reaches `--trail-start-pct` (**5.0%**) of entry premium, then exits if combined premium rises `--trail-gap-pts` (**15.0** pts) above its best (lowest) level since arming.
- `reentry_straddle` mode additionally stops each leg independently at `--leg-sl-pct` (**20%**) above its own entry price.
