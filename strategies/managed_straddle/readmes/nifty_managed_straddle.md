## Summary

Nifty Managed Straddle enters a short ATM straddle at or after 09:20 IST once the difference between ATM CE and PE prices is less than 10%. It caps drawdown using a 20% stop-loss on the combined entry premium, and manages individual legs with a 20% stop-loss and 30% profit target. When either leg triggers an exit, it rolls to a replacement strike whose premium matches the opposite leg's live price.

## Entry

- **Time**: At or after 09:20 IST on 1-minute cadence.
- **Strike**: ATM strike `round(Spot / 50) * 50`.
- **Condition**: `abs(CE - PE) / max(CE, PE) < 10.0%`. If difference is >= 10%, monitors without entering.
- **Action**: Sell 1 lot ATM CE and 1 lot ATM PE.

## Exit

- **Combined Stop Loss**: Exit both legs immediately if `(ce_ltp + pe_ltp) >= combined_p0 * 1.20` (+20% expansion).
- **Mandatory EOD Cutoff**: Global exit at 15:15 IST.
- **Trailing Stop**: Optional rupee MTM trail arming at ₹2,000 with ₹1,000 gap.

## Target

- **Leg Target**: 30% decay on individual leg (`ltp <= entry * 0.70`).
- **Adjustment**: Close winning leg and roll to a new strike matching the opposite leg's current LTP.

## Stop Loss

- **Leg Stop Loss**: 20% rise on individual leg (`ltp >= entry * 1.20`).
- **Adjustment**: Close losing leg and roll to a new strike matching the opposite leg's current LTP.

