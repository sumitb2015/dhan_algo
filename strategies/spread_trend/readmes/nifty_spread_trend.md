## Summary

Trend-following options-selling strategy on Nifty (or Bank Nifty). Sells a Bull Put Spread
when price is above EMA20 with a bullish Supertrend, or a Bear Call Spread when price is below
EMA20 with a bearish Supertrend — both indicators must agree. Defined-risk (hedged) intraday
credit spreads, not naked selling.

## Entry

- Trend gate: `Close > EMA(--ema-period, default 20)` **and** `Supertrend(--supertrend-period 7, --supertrend-multiplier 3.0)` bullish → sell Bull Put Spread; the mirror condition → sell Bear Call Spread. A single indicator flip alone does not trigger a trade (unless `--no-ema` or `--no-supertrend` disables one filter).
- Candle interval `--interval`, default **5** minutes (also supports 1 or 3).
- Short strike offset `--ce-offset`/`--pe-offset`, default **100** pts from spot; spread width `--spread-width`, default **100** pts.
- `--lots`, default **1** per spread leg.
- Entry order: buys the long hedge leg first and confirms the fill, then sells the short leg — never runs naked-margin, even momentarily.

## Exit

- Signal reversal: exits early if the trend flips (unless `--no-exit-on-signal-change` is set, in which case it holds to SL/target/EOD), gated by `--min-hold-minutes` (default **5**) minimum hold.
- Exit order: buys back the short leg first and confirms the fill, then sells the long hedge — minimizes exposure during close-out.
- `--cooldown-minutes` (default **5**) after a standard exit before re-entry is permitted.
- EOD square-off at `--eod-time`, default **15:15 IST**.

## Target

- Global daily profit target `--target-profit`, default **₹2,000**.

## Stop Loss

- Global daily stop loss `--stop-loss`, default **₹2,000**.
