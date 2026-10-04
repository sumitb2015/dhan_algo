## Summary

**UNVALIDATED — dry-run default.** Sourced from YouTube video:
[What If the Iron Condor Starts Trending? | Ratio Spread Strategy](https://www.youtube.com/watch?v=T4gvTshMEyA&t=1609s).
`--live` requires `--i-understand-this-is-unvalidated`.
Starts with a neutral monthly Iron Condor (Sell 0.30 Delta CE & PE, Buy 0.10 Delta CE & PE hedges).
Instead of continuously rolling or defending the Iron Condor when a strong trend begins, the strategy
changes structure and transitions from an **Iron Condor → Directional Ratio Spread** as soon as either
short leg decays to **0.10 Delta**.

## Mechanics & Stages

1. **Initial Neutral Iron Condor**:
   - Sell 0.30 Delta Call & Put (1× lots each).
   - Buy 0.10 Delta Call & Put hedges (1× lots each) for defined risk and margin efficiency.
2. **Transition Trigger (Iron Condor → Ratio Spread)**:
   - When Call short leg decays to `<= 0.10 Delta`: Market moved DOWN -> Exit Condor -> Deploy **Call Ratio Spread** (Bearish).
   - When Put short leg decays to `<= 0.10 Delta`: Market moved UP -> Exit Condor -> Deploy **Put Ratio Spread** (Bullish).
3. **Ratio Spread Structure**:
   - Buy 1× 0.50 Delta option (ATM).
   - Sell 2× 0.40 Delta options (OTM).
   - Buy 1× 0.10 Delta option hedge (Far OTM tail protection).
4. **Trending Continuation Shift**:
   - If market continues trending in our direction and combined sold leg delta decays from ~0.80 down to `<= 0.20` (or `<= 0.10` per contract):
   - Exit Ratio Spread -> Re-deploy shifted Ratio Spread in same direction with less aggressive strikes (Buy 0.40 Delta, Sell 2× 0.30 Delta, Buy 0.08 Delta hedge).
5. **Reversal Reset Rule**:
   - If market reverses strongly against the Ratio Spread and combined sold leg delta rises from ~0.80 up to `>= 1.20` (or `>= 0.60` per contract):
   - Exit Ratio Spread -> Flip direction and deploy fresh Ratio Spread on the opposite side.

## Exit Rules

- **Target Profit**: `--target-profit` (default **15%** of margin / entry value, or ₹15,000 per lot).
- **Stop Loss**: `--stop-loss` (default **15%** of margin / entry value, or -₹15,000 per lot).
- **Trailing Stop Loss**: Rupee-MTM trailing stop (--trail-start-rs ₹5,000, --trail-gap-rs ₹2,500).
- **Expiry Square-Off**: Flatten all legs at `--eod-exit-time` (**15:15**) on monthly expiry day.
