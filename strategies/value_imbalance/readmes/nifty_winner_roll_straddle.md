## Summary

Intraday short ATM Nifty straddle that rolls only the **winning** leg (the lower-premium side)
toward spot as it decays relative to the losing leg, instead of rolling both legs to a new ATM
or shifting a single leg by a fixed distance. Each roll value-matches the winner to a new strike
near the loser's premium and re-baselines the imbalance check, so the strategy keeps harvesting
decay from the cheaper side without giving up the straddle structure.

## Entry

- Sells `--lots` (default **1**) of ATM CE + ATM PE at `--start-time` (default **09:20** IST).
- Entry-balance gate: waits (`BALANCING` status) for CE/PE premiums to be within
  `--entry-balance-threshold` (default **10.0%**) of each other before entering.

## Roll (winner-only)

- Every poll, computes `|CE-PE| / max(CE,PE)` against a rolling baseline (re-set after each roll
  via fresh LTPs). Once the lower-premium ("winner") leg has fallen to `--roll-threshold-pct`
  (default **50.0%**, must exceed `--entry-balance-threshold`) of the higher-premium ("loser")
  leg beyond the baseline offset, rolls **only the winner** to a value-matched strike closer to
  spot, then re-baselines and repeats.
- Capped at `--max-rolls` (default **5**) rolls per cycle, with `--roll-cooldown` (default
  **60s**) between rolls.
- **Strike-inversion guard**: since rolling the winner toward spot can cross the loser's strike
  (CE strike > PE strike must hold), a crossing roll is blocked — the strategy emergency-exits
  both legs, pauses 5 minutes, then starts a fresh ATM cycle instead.
- **ATM-shift reset**: if spot moves `--atm-shift-reset-pts` (default **100.0** pts) away from
  the cycle's entry ATM strike, squares off everything and starts a fresh cycle at the new ATM.

## Exit

- Hard intraday square-off at `--eod-time`, default **15:17 IST**.
- Phantom-leg detection and `resolve_exit_qty_broker`-sized exits, same as the rest of the
  `value_imbalance/` family.

## Target

- `--target-profit`, default **20%** of combined entry premium (or an absolute INR value).

## Stop Loss

- `--stop-loss`, default **20%** of combined entry premium (or an absolute INR value).
- Trailing SL: arms once MTM profit reaches `--trail-start-rs` (default **₹500**), then trails
  `--trail-gap-rs` (default **₹300**) below the best profit seen.
