## Summary

**Positional (Multi-Day, `MARGIN`), Delta-Controlled, Low-Gamma Diagonal Covered Call.**
Combines long-dated call options (60–120 DTE, 0.55–0.65 delta) for convex upside exposure and vega stability, with medium-dated short calls (25–45 DTE, 0.15–0.22 delta) to harvest steady theta decay. Instead of selling a fixed number of lots, short calls are dynamically sized from delta and selected by maximizing the **Theta / |Gamma|** efficiency ratio to prevent gamma blowups during market rallies. Dry-run by default (`--live` required for real orders).

## Architecture & Economics (Long-Call Financing)

The long calls do **NOT** have to recover to their initial purchase price for the strategy to be profitable. The strategy functions as a **long-call financing engine**:
- **Convexity & Margin Shield**: Long call caps upside risk, provides convexity, and drastically cuts F&O exchange margin requirements.
- **Financing Engine**: Short calls continuously harvest theta decay across multiple monthly cycles.
- **Long Cost Recovery (LCR)**: Tracks cumulative net short premium against initial long debit:
  `LCR % = (Cumulative Net Short Premium / Initial Long Debit) × 100%`
- **"Free Long Call" Regime**: Once LCR reaches **100%**, the long calls are fully funded. The algo drops short candidate delta to **0.08–0.15** and clamps short sizing to **≤ 0.60× long delta**, cutting negative gamma to near zero and letting the remaining long call participate freely in large upside moves.

## Entry & Strike Selection

- **Long Leg (First)**: 60–120 DTE Call (`CE`), 0.55–0.65 delta (preferred ~0.60). Sized at `--long-lots` (default **3** lots). Long leg is always entered and confirmed before selling any short leg.
- **Short Leg (Second)**: 25–45 DTE Call (`CE`), 0.15–0.22 delta (preferred ~0.18–0.20). Weekly options are strictly excluded to avoid severe gamma acceleration.
- **Optimization Score**: Selects the strike with the highest efficiency ratio:
  `Score = Daily Theta Decay (₹) / |Gamma|`

## Dynamic Sizing Formula

Short position size is dynamically calibrated so that net portfolio delta stays in the target buffer (+10 to +20 units):

```text
Target Short Delta = Total Long Delta - Target Net Delta (+13 units)
Required Lots      = round(Target Short Delta / (Short Delta × Lot Size))
Max Allowed Lots   = floor(1.25 × Total Long Delta / (Short Delta × Lot Size))
Final Short Lots   = min(Required Lots, Max Allowed Lots, Max Lots Cap)
```

- **Ceiling Protections**: Capped by `--max-short-lots` (default **6** lots) and `--max-short-ratio` (default **1.25×** long delta).

## Delta & Gamma Risk Zones

- 🟢 **Normal Zone (`0` to `+20` Net Delta)**: Hold and let theta decay work.
- 🟡 **Slightly Bearish (`-20` to `-40` Net Delta)**: Monitor. Do not add short calls.
- 🔴 **Defensive (`< -40` Net Delta)**: Mandatory defensive action — roll short calls higher (lower delta) or buy back lots.
- 🟢 **Bullish (`> +30` Net Delta)**: Opportunity to sell additional short delta back to `+10`..`+20` zone if gamma permits.
- **Gamma Floor**: Strategy maintains portfolio gamma `> -0.15`. A drop below `-0.20` triggers emergency defensive rolls.

## Roll & Exit Rules

1. **Short-Call Roll**: Triggered if short DTE `≤ 14` days, short delta `> 0.35`, net delta `< -40`, gamma `< -0.20`, or short profit reaches **60–70%** (default: 65% decay captured). Closes short and rolls to a fresh 25–45 DTE call (0.15 to 0.22 delta).
2. **Long-Call Roll**: Triggered when long call DTE drops `< 35` days. Rolls out to a fresh 60–120 DTE call (0.55 to 0.65 delta).
3. **Daily Loss Limit**: Halts new adjustments if intraday MTM drops by `--daily-loss-pct` (default **1.5%** of capital).
4. **Drawdown Halving**: If strategy drawdown reaches `--drawdown-halve-pct` (default **5.0%**), halves short exposure immediately.
5. **Drawdown Exit / Hard Stop**: Closes all positions if drawdown reaches `--drawdown-exit-pct` (default **8.0%**) or `--stop-loss` is hit.
6. **Target Profit**: Optional global target in INR or % (`--target-profit`).

## Schedule & Rebalance Windows

- **Start Time**: No new entries before **09:30 AM IST**.
- **Scheduled Rebalance Windows**: Evaluated at **10:00 AM**, **12:00 PM**, and **02:00 PM IST**.
- **Continuous Guard**: Emergency delta, gamma, and profit locks evaluated every 1–2s.
- **Positional Carry**: At **15:25 IST**, transitions to overnight hold without squaring off.
