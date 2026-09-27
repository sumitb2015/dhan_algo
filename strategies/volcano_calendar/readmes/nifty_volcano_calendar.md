## Summary

**UNVALIDATED — dry-run only.** No backtest and no losing-month example anywhere in the source
evidence; `--live` requires `--i-understand-this-is-unvalidated`. A "zero adjustment" monthly
income structure on Nifty combining a **Put Butterfly** (defined-risk downside) with a **Call
Calendar** (upside, financed by selling near-month theta against a longer-dated long call at
the same strike). The only 5-leg, dual-expiry structure in the repo, held to monthly expiry
with a flat 2%/2% target-stop on deployed margin.

## Entry

- Once per calendar month, on the last trading Friday (walks back to Thursday, then earlier weekdays, on an NSE holiday).
- Entry window: `--entry-time` (default **15:16**) for `--entry-window-min` (default **4** minutes).
- Sizing: `--lots` (default **1**) sets the 1× legs; the put-butterfly body is always 2× lots.
- Strikes (ATM = floor(spot/step)×`--strike-step`, default **50**): buy PE wing at ATM − 2×`--wing-points` (default **800**), sell 2× PE body at ATM − wing-points (**400**), buy PE at ATM, buy CE at ATM + `--ce-offset-points` (default **300**) on the **far** expiry, sell CE at the same strike on the **near** (current monthly) expiry.
- Far expiry chosen by `--far-expiry` (`next-month` or `two-months`, default **next-month**).
- Order: all 3 long legs first (PE wing, PE ATM, CE far), then sell PE body (×2), then sell CE near. Any leg with a missing/zero quote aborts entry before placing anything.

## Exit

Checked in order, first match wins:
1. Target hit.
2. Stop hit.
3. Near-expiry EOD: on the current monthly expiry's trading day, flatten everything (including the far CE leg) at `--eod-exit-time`, default **15:17**.
4. Otherwise holds untouched — no daily/intraday exit — until the next check.
- A dashboard Stop request, or `--max-consecutive-stops` (default **3**) breach, can also end/pause a cycle (the latter pauses new entries without closing an already-open position).
- **No adjustment** in v1 — matches the source's "zero adjustment" design.

## Target

- `--target-profit`, default **2%** of the margin actually blocked for the combo (resolved once at entry, not against entry premium — falls back to `--fallback-margin-per-lot`, default ₹170,000/lot, if the margin call fails).

## Stop Loss

- `--stop-loss`, default **2%** of the same deployed-margin base.
