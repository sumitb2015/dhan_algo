## Summary

Intraday Nifty options seller. Sells an ATM straddle or an OTM strangle and holds a
**value-imbalance** book: as one leg decays faster than the other, it either averages down
the winning leg or rolls the losing leg to a fresh strike, keeping the book approximately
premium-balanced without going fully directional. Five selectable adjustment modes trade off
margin efficiency against tail-risk hedging. Intraday only — no overnight carry.

## Entry

- Waits for CE and PE premiums to balance within a threshold before selling (CE/PE premium gap must be under **10%** for a straddle / **25%** for a strangle).
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
- Any other cycle exit (trail, deadlock, a leg already at `--max-lots`, a failed roll order) also pauses 5 minutes before a fresh cycle. Every cycle's P&L is banked into the day total, which resets when the calendar date rolls.
- Hard intraday square-off at **15:17 IST**.

## Target

- Global daily profit target `--target-profit`, default **25%** of the entry premium collected (or a ₹ amount). Reaching it ends the day.
- Optional **Scalp Lock**: `--scalp-floor-pct` (default **0.0**, disabled) exits immediately once cycle profit reaches this % of the entry premium value; without `--multi-cycle` that ends the day, with it a fresh cycle starts after `--cycle-cooldown` (default **300s**).

## Stop Loss

- Global daily stop loss `--stop-loss`, default **25%** of the entry premium collected (or a ₹ amount). Reaching it ends the day.
- Trailing SL on rupee MTM (realized + open, so it survives rolls): arms once cycle profit reaches `--trail-start-rs` (**₹500**), then exits if MTM gives back `--trail-gap-rs` (**₹300**) from its best.
- `reentry_straddle` mode additionally stops each leg independently at `--leg-sl-pct` (**20%**) above its own entry price.
