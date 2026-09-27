## Summary

Intraday short ATM Nifty straddle that continuously rolls to the new ATM strike whenever spot
moves far enough away from the active strike, rather than adjusting lots or shifting a single
leg. Two selectable rolling triggers — a fixed-points buffer or a percentage move — control how
far spot must travel before a roll fires.

## Entry

- Sells `--lots` (default **1**) of ATM CE + ATM PE at `--start-time` (default **09:20** IST).
- Optional entry-balance gate: waits (`BALANCING` status) for CE/PE premiums to be within `--entry-balance-threshold` (default **15.0%**) of each other, up to `--entry-balance-timeout` (default **30s**), before entering anyway at current premiums.

## Exit

- **Rolling** (not a full exit, but a strike swap): every poll, checks spot against the roll boundary —
  - `--roll-type points` (default): rolls when spot moves `±--roll-buffer` (default **35.0** pts) from the active ATM.
  - `--roll-type percentage`: rolls on every `±--roll-trigger-pct` (default **0.4%**) move from the reference spot.
  - Capped at `--max-rolls` (default **5**) rolls per session, with `--roll-cooldown` (default **60s**) between rolls; once the cap is hit, `--exit-on-max-rolls` (on by default) force-closes on the next bound breach instead of riding a stale strike.
- Hard intraday square-off at `--eod-time`, default **15:17 IST**.

## Target

- `--target-profit`, default **25%** of combined entry premium (or an absolute INR value).

## Stop Loss

- `--stop-loss`, default **25%** of combined entry premium (or an absolute INR value).
- Trailing SL: arms once MTM profit reaches `--trail-start-rs` (default **₹500**), then trails `--trail-gap-rs` (default **₹300**) below the best profit seen.
