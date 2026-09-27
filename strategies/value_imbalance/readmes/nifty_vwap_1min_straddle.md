## Summary

Intraday mean-reversion short Nifty straddle. Sells the ATM straddle only while its combined
premium (CE+PE) sits at or just below its own **session VWAP** and is actively declining, then
buys it back once the premium rises back above VWAP by a buffer. No lot additions or strike
adjustments — a simple sell-monitor-exit-repeat loop, re-centering on a fresh ATM whenever spot
moves to a new 50-point bracket.

## Entry

All four gates must pass simultaneously:
- **VWAP ready** — at least `--vwap-warmup-bars` (default **10**) completed 1-min bars since session open (09:15 IST).
- **Price gate** — combined CE+PE LTP `≤` its own session VWAP `+ --entry-band` (default **5** pts).
- **Decline gate** — combined premium falling over the last `--decline-ticks` (default **5**) WebSocket ticks.
- **Balance gate** — `|CE − PE| / max(CE, PE) < --max-premium-diff` (default **15%**).
- Sells `--lots` (default **1**) of ATM CE + ATM PE.

## Exit

- VWAP exit: combined premium rises above `VWAP + --exit-buffer` (default **10** pts) — buys back both legs.
- ATM re-centering: if spot moves to a new 50-point bracket while flat, re-subscribes new ATM legs and resets VWAP; while in a position, the re-center is deferred until the position closes.
- Cooldown: `--cooldown-seconds` (default **90**) pause after a losing cycle; `--max-trades-per-day` (default **15**, `0` = unlimited) caps entries.
- Liquidity guard: skips entry if either leg's bid-ask spread exceeds `--max-spread-pct` (default **8%**) of mid-price.
- Hard intraday square-off at **15:17 IST**.

## Target

- Session profit target `--target-profit`, default **₹4,000** — strategy pauses until next day once reached.

## Stop Loss

- Session stop loss `--stop-loss`, default **₹4,000**.
- Hard per-cycle stop `--max-loss-per-trade`, default **₹1,500** (independent of VWAP; `0` disables), so a losing move can't be masked by VWAP drifting along with it.
