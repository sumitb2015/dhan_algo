## Summary

A deliberately simplified sibling of the VWAP + Supertrend strategy: same dual-confirmation,
always-on, stop-and-reverse MCX CRUDEOILM futures skeleton, but with the regime gate, OI
confirmation, and churn brakes all removed. Confirms direction with Supertrend **and** EMA20
instead of VWAP — the only hysteresis is the "in between" zone where the two bands disagree.

## Entry

- Flat + price above **both** Supertrend(`--supertrend-period` 7, `--supertrend-multiplier` 2.0) and EMA(`--ema-length` 20) → LONG; below both → SHORT; in between → stays flat.
- No regime/OI/churn filtering — as always-on as the raw price rule allows, gated only by `--flip-cooldown` (default **60s**) between flips/entries.
- `--lots` (default **5**) sent to the broker verbatim; `--contract-size` (default **10** barrels/lot) used only for P&L.

## Exit

Priority order:
1. Dashboard shutdown trigger.
2. EOD time reached (`--eod-time`, default **23:30**) — flatten and stop.
3. Daily profit target hit.
4. Daily stop loss hit.
5. Per-trade stop / trailing SL hit → flat (does not end the day).
6. Signal flip → stop-and-reverse (or exit-to-flat with `--no-reverse`).
- Positions are **not** recovered on restart — only realized P&L and trade count are restored.

## Target

- Daily profit cap `--target-profit`, default **₹5,000**.

## Stop Loss

- Daily stop-loss cap `--stop-loss`, default **₹5,000**.
- Initial per-trade stop at `--atr-stop-mult` (default **1.5**) ATRs from entry fill (`0` disables).
- Trailing SL: arms once price has moved `--trail-sl-trigger` (default **10**) points in profit from entry, then trails `--trail-sl-offset` (default **₹1**) behind the best price reached, ratcheting only (`0` disables the trail).
