## Summary

Intraday mean-reversion short Nifty straddle (same VWAP mechanics as the 1-Min VWAP Straddle)
with an added **volatility-trend filter**: it only sells while both the straddle's own premium
and India VIX are each below their own Supertrend — i.e. only while implied volatility itself
is trending down, not just while premium happens to look cheap relative to VWAP.

## Entry

All gates must pass simultaneously:
- **VWAP ready** — at least `--vwap-warmup-bars` (default **10**) completed 1-min bars.
- **Price gate** — combined CE+PE LTP `≤` its own session VWAP.
- **Straddle Supertrend gate** — combined premium below its own Supertrend(`--st-period` **10**, `--st-multiplier` **2.0**, resampled to `--st-interval` **3**-min bars).
- **VIX Supertrend gate** — India VIX below its own Supertrend(`--vix-st-period` **10**, `--vix-st-multiplier` **2.0**, `--vix-st-interval` **3**-min bars).
- **Balance gate** — `|CE − PE| / max(CE, PE) < --max-premium-diff` (default **15%**).
- Sells `--lots` (default **1**) of ATM CE + ATM PE.

## Exit

- **VIX Supertrend flip** — India VIX crosses back above its own Supertrend, exits regardless of where premium sits vs VWAP.
- **VWAP exit buffer** — combined premium rises above `VWAP + --exit-buffer` (default **5** pts).
- Cooldown `--cooldown-seconds` (default **90**) after a losing cycle; `--max-trades-per-day` (default **15**) caps entries.
- Liquidity guard: skips entry if either leg's spread exceeds `--max-spread-pct` (default **8%**).
- Hard intraday square-off at **15:17 IST**.

## Target

- Session profit target `--target-profit`, default **₹4,000**.

## Stop Loss

- Session stop loss `--stop-loss`, default **₹4,000**.
- Hard per-cycle stop `--max-loss-per-trade`, default **₹1,500** (independent of VWAP/Supertrend; `0` disables).
