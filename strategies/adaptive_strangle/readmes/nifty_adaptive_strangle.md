## Summary

Positional (`MARGIN`) bi-weekly option selling strategy on Nifty. Sells far-OTM strangles on the 2nd weekly expiry (8–15 DTE) at low delta (~0.10) with zero upfront hedge drag to maximize theta decay. Dynamically buys protective OTM wings if a short leg comes under pressure (delta `>= 0.22` or IV surge `>= 20%`), and optionally transitions into a directional spread if the market establishes a strong trend.

## Entry

- **Timing**: Second weekly expiry (`helper.get_expiries("NIFTY")[1]`, 8 to 15 DTE) between 09:30 and 15:00 IST.
- **Strikes**: Sells 0.10 Delta Call and Put (`--entry-delta 0.10`).
- **Initial Hedges**: None upfront to avoid hedge drag in range-bound markets.
- **Position Sizing**: `--lots` (default **1** lot).

## Exit

- **Conditional Hedging**: Buys an OTM wing (~0.08 delta) on the threatened side if short delta reaches `>= 0.22` or IV surges by `>= 20%`.
- **Directional Trend Conversion**: If `--enable-directional-conversion` is enabled and short delta reaches `>= 0.30`, closes the winning leg to lock profit and converts the losing leg into a directional spread.
- **Expiry Exit**: Squares off all legs at `--eod-exit-time` (**15:15 IST**) on expiry day.

## Target

- **Profit Target**: `--target-profit` (default: **50%** of initial credit collected or fixed INR).

## Stop Loss

- **Hard Stop Loss**: `--stop-loss` (default: **100%** of initial credit collected or fixed INR).
- **Trailing Stop Loss**: Rupee-MTM trailing stop via `--trail-start-rs` (e.g. ₹5,000) and `--trail-gap-rs` (e.g. ₹2,500).
