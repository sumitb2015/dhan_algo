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
  - `--roll-type atm`: follows the true ATM — rolls once spot is `25 + --atm-hysteresis` (default **5** pts, so 30) past the held strike, i.e. just after the ATM flips. Hysteresis stops churn when spot dithers around the 25-pt midpoint. For tight tracking also pass a low `--roll-cooldown` and a high `--max-rolls`.
  - `--roll-type percentage`: rolls on every `±--roll-trigger-pct` (default **0.4%**) move from the reference spot.
  - Capped at `--max-rolls` (default **5**) rolls per session, with `--roll-cooldown` (default **60s**) between rolls; once the cap is hit, `--exit-on-max-rolls` (on by default) force-closes on the next bound breach instead of riding a stale strike.
- Hard intraday square-off at `--eod-time`, default **15:17 IST**.

## Target

- `--target-profit`, default **25%** of combined entry premium (or an absolute INR value).

## Stop Loss

- `--stop-loss`, default **25%** of combined entry premium (or an absolute INR value).
- Trailing SL: arms once MTM profit reaches `--trail-start-rs` (default **₹500**), then trails `--trail-gap-rs` (default **₹300**) below the best profit seen.

## Backtested preset (expiry-day profile)

```
python strategies/value_imbalance/nifty_rolling_straddle.py --roll-type atm --atm-hysteresis 50 \
  --expiry-day-only --start-time 10:00 --target-profit 0 --stop-loss 50% --trail-start-rs 0 \
  --max-rolls 5 --entry-balance-threshold 10 --entry-balance-timeout 600
```

Derived from a 1-min backtest over Jan-2023 to Sep-2026 (925 sessions): trade expiry day only, roll only
once spot is 75 pts from the held strike, no profit target, no trailing SL, 50% stop on entry premium, enter
at 10:00 after waiting up to 10 min for CE/PE balance. The defaults above lose money on every window tested
(about -Rs 390/day net); the preset is positive in both 2023-24 and 2025-26 (+Rs 342/day and +Rs 1,055/day
net at 0.5 pt slippage per fill, 102 and 91 expiry days). Caveats: results are sensitive to the roll
trigger (60 pts goes negative), the edge is concentrated in 2025-26, single-day losses reach about Rs -12k
per lot, and it has not been forward-tested. Dry-run first.

## Rules mode (`--roll-type rules`) — UNVALIDATED

A self-contained rule set, selected with `--roll-type rules` (existing modes are unchanged). **Requires `--capital`.**
No backtest yet; dry-run first.

| Rule | Behaviour (flag, default) |
|---|---|
| Entry | 09:20 normal days, 09:30 on expiry (`--start-time`, `--expiry-start-time`); sell ATM CE+PE only once the higher leg is below `--roll-imbalance-ratio` (2.0×) the lower — otherwise wait (applies to the first straddle and every roll's re-entry); if still skewed at `--no-roll-after` (14:30) the entry is skipped for the day |
| Day filters | optional skip if VIX > `--vix-max` or open gap > `--gap-skip-pct` (both off by default). If `--vix-max` is set and VIX can't be read after 3 tries, the day is skipped (fails closed) |
| Roll trigger | **imbalance always on** (higher leg ≥ `--roll-imbalance-ratio` 2.0× lower) **plus one primary trigger** via `--roll-trigger`: `spot_pct` (move ≥ `--roll-trigger-pct` 0.4% from ref spot) or `delta` (either leg \|Δ\| ≥ `--roll-delta` 0.60, option chain, polled every 5s). Whichever hits first rolls; no cooldown (`--roll-cooldown` is ignored in this mode) |
| Roll cap | `--max-rolls` (3 in this mode); no rolls at/after `--no-roll-after` 14:30 |
| Per-leg SL | once no further roll is possible (cap reached **or** past `--no-roll-after`) the last straddle is kept and each leg is stopped on its own when its premium ≥ `--leg-sl-mult` (1.5) × its entry premium; the surviving leg keeps running to its own SL / 15:15 (combined 1.25× SL applies only while both legs are open). Imbalance rolls are armed only after a straddle has been seen balanced, so one sold already ≥2× skewed does not roll straight back into the same skew |
| Straddle SL | combined premium ≥ `--straddle-sl-mult` 1.25 × that straddle's entry premium → roll if rolls remain and before 14:30, otherwise exit for the day |
| Daily stop | total day P&L ≤ −`--day-stop-pct-capital` 1.5% of `--capital` → exit, no re-entry |
| Profit lock | on total day P&L as % of the **first** straddle's premium: +20% → lock 0, +30% → +10%, +40% → +20%, then +8% per further +10% (`--trail-start/--trail-step/--trail-lock-step`); P&L falling to the lock exits for the day |
| Time exit | 15:15 (`--eod-time`) |

Notes: a roll is 4 legs, so costs/slippage/STT matter. A `delta`, `imbalance` or SL roll may re-sell the same
strike (resets premiums). If the chain has no Greeks the delta trigger stays silent. Still to check in a
backtest: roll cost vs edge, trend days (roll cap + daily stop together), delta vs spot trigger on expiry day.
