## Summary

**UNVALIDATED — dry-run only.** Backtested at −0.09R over 81 sessions even at zero cost, so
`--live` requires `--i-understand-the-backtest-failed`. Multi-symbol intraday cash-equity
auto-trader across all 50 Nifty names: buys stocks showing VWAP + trend confluence while
outperforming NIFTY intraday, sized by ATR risk with an R-multiple target and a hard
end-of-day square-off. The only multi-symbol strategy in the repo — it can hold several
positions from the universe at once.

## Entry

Evaluated on the last confirmed bar. Hard gates, all must pass:
- Price at least `--min-vwap-edge` (default **2.0** bps) above session VWAP.
- Supertrend bullish on the higher-timeframe confirmation frame (`--htf`, default **30** min).
- HTF ADX ≥ `--adx-min` (default **20.0**).
- Outperforming NIFTY since the open (relative strength).
- Not stretched beyond `--vwap-stretch` (default **1.50** ATR) from VWAP.
- Candidates ranked by score (0–100), filtered by `--min-score` (default **60.0**), capped at `--max-positions` (**3**) and `--max-per-sector` (**2**). Entry window `--entry-start` (**09:30**) to `--entry-cutoff` (**14:45**).

## Exit

Priority order: `SQUARE_OFF` → `STOP` → `TARGET` → `ST_FLIP` → `VWAP_LOSS` (off by default) → `RS_LOSS`.
- Hard square-off at `--square-off`, default **15:17 IST**, retried every 15s until 15:25.
- Safety rails: `--max-trades` (**12**), `--max-symbol-trades` (**2**), `--symbol-cooldown` (**900s**), `--entry-spacing` (**60s**), order-reject backoff.

## Target

- Per-trade target: `--target-r` (default **2.0**) × R (the initial risk distance).
- Daily profit target `--target-profit`, default **₹10,000**.

## Stop Loss

- Per-trade stop: `--atr-stop-mult` (default **1.5**) × ATR from entry.
- Daily stop loss `--max-daily-loss`, default **₹6,000**.
