## Summary

**Positional (Bi-Weekly Carry, `MARGIN`) Option Selling Strategy.**
Sells far-OTM Nifty strangles on the 2nd weekly expiry (~8–15 DTE) at low delta (~0.10 delta) with zero upfront hedge drag. Dynamically buys protective OTM wings on Greek threat triggers (Delta or Vega/IV surge) and optionally transitions into a directional vehicle upon confirmed Nifty index trends. Dry-run by default (`--live` required for real orders).

## Entry & Strike Selection

- **Underlying**: `NIFTY` index options.
- **Expiry Horizon**: Second weekly expiry (`helper.get_expiries("NIFTY")[1]`, 8 to 15 DTE).
- **Strikes**: Sells 0.10 Delta Call and Put (`--entry-delta 0.10`).
- **Initial Hedges**: Starts with zero upfront hedges to maximize theta capture and avoid hedge drag in range-bound environments.
- **Position Sizing**: Configured via `--lots` (default **1** lot).

## Conditional Hedging Triggers

1. **Delta Threat Trigger**:
   - If Nifty drifts toward either leg and its delta rises to `>= 0.22` (`--hedge-delta-trigger 0.22`):
   - Immediately buys an OTM hedge on that side targeting `~0.08` delta (`--hedge-target-delta 0.08`), transforming the threatened side into a defined-risk credit spread.
2. **Vega / IV Surge Trigger**:
   - If implied volatility surges by `>= 20%` (`--vega-surge-pct 20.0`), purchases protective wings on both sides to neutralize short Vega exposure.

## Directional Trend Conversion

- Enabled via `--enable-directional-conversion`:
  - If a short leg expands to `>= 0.30` Delta (`--conversion-delta-trigger 0.30`) and Nifty index confirms directional trend:
  - **Harvest Winning Leg**: Closes the decayed opposite leg to lock in realized profit.
  - **Deploy Directional Vehicle**: Converts losing side into a directional spread (`--conversion-style spread` for vertical credit/debit spread, or `ratio` for 1×2 ratio spread) to ride trend momentum.

## Exit & Risk Management

- **Target Profit**: `--target-profit` (default: 50% of credit collected or INR).
- **Stop Loss**: `--stop-loss` (default: 100% of initial credit or INR).
- **Trailing Stop Loss**: Rupee-MTM trailing stop (`--trail-start-rs`, `--trail-gap-rs`).
- **Expiry Exit**: Flatten all legs at `--eod-exit-time` (**15:15 IST**) on expiry day.
