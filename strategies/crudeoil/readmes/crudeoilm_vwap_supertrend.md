## Summary

MCX CRUDEOILM futures strategy requiring dual confirmation from Supertrend **and** session
VWAP: long only while price is above both bands, short only while below both, flipping
directly between sides. A regime gate (ADX, Choppiness Index, higher-timeframe Supertrend,
band-separation) restricts new entries to trending conditions and flattens on chop, since a
directional dual-band rule is at its weakest in a range.

## Entry

- Flat + price above **both** Supertrend(`--supertrend-period` 7, `--supertrend-multiplier` 2.0) and session VWAP → LONG; below both → SHORT; in between → stays flat.
- New positions only open while the regime is **TREND**: ADX ≥ `--adx-enter` (default **22**), Choppiness Index below `--chop-max`, higher-timeframe Supertrend agreeing (`--htf-interval`, auto-probed), and `|ST − VWAP| >= --min-band-gap-atr` ATRs.
- Optional OI confirmation gate (`--require-oi-confirmation`, off by default): CE/PE short-buildup bias on the CRUDEOIL option chain must agree with the trade direction.
- Churn brakes: `--max-trades-per-day` (default **6**), `--loss-streak-pause` (default **2** losers → pause **30 min**), `--flip-cooldown` (default **60s**), `--cooldown-candles` (default **1**) after any flat-going exit.
- `--lots` (default **5**) sent to the broker verbatim; `--contract-size` (default **10** barrels/lot) used only for P&L math.

## Exit

Priority order:
1. Dashboard shutdown trigger.
2. EOD time reached (`--eod-time`, default **23:30**) — flatten and stop.
3. Daily profit target hit — flatten and stop for the day.
4. Daily stop loss hit — flatten and stop for the day.
5. Per-trade stop / Supertrend trail hit → flat (does not end the day).
6. Regime turns CHOP → flat, stands aside (does not end the day).
7. Signal flip → stop-and-reverse, only if the new side passes the entry gates; otherwise exits to flat.
- Positions are **not** recovered on restart (only P&L and churn-brake counters); regime restarts as CHOP and must re-confirm.

## Target

- Daily profit cap `--target-profit`, default **₹5,000**.

## Stop Loss

- Daily stop-loss cap `--stop-loss`, default **₹5,000**.
- Per-trade: initial stop at `--atr-stop-mult` (default **1.5**) ATRs from entry; once `--trail-trigger-atr` (default **1.0**) ATRs in profit, the stop hands over to the Supertrend band and ratchets only (never loosens).
