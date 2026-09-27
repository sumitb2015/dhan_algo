## Summary

Bear-Call-Spread-only strategy on Nifty (or Bank Nifty), gated by a **dual Supertrend**
confirmation — the index's own trend and the candidate short option's own trend must both turn
bearish before entry — plus an optional OI short-buildup filter for a stricter signal. Never
enters on index weakness alone.

## Entry

State machine: IDLE → WATCHING → ENTERED.
- **IDLE**: index Supertrend(`--index-st-period` 10, `--index-st-multiplier` 2.0) on `--index-interval` (default **3**-min) candles turns bearish → locks a candidate strike at `ATM + --ce-offset` (default **100** pts) and moves to WATCHING.
- **WATCHING** (polled every `--poll-interval`, default **30s**): re-checks the index Supertrend is still bearish; abandons the cycle (cooldown) if it flips or if `--max-wait-minutes` (default **45**) elapses. Waits for the candidate CE's **own** Supertrend(`--option-st-period` 10, `--option-st-multiplier` 2.0 on `--option-interval` default **3**-min bars) to also turn bearish.
- Optional (`--require-short-buildup`, off by default): additionally requires CE price change vs prior close `<= --min-price-drop-pct` (default **-0.5%**) and CE OI change `>= --min-oi-rise-pct` (default **5.0%**) — the standard short-buildup signature.
- Entry order: buys the long (higher-strike) hedge CE first and confirms the fill, then sells the short candidate CE. Spread width `--spread-width`, default **100** pts. `--lots`, default **1**.

## Exit

- Exit order: buys back the short CE first and confirms the fill, then sells the long hedge CE; halts the strategy rather than risk a naked leg if either close fails to fill.
- Early exit: candidate option's own Supertrend flips back bullish (unless `--no-exit-on-option-st-flip`), or index Supertrend flips back bullish (unless `--no-exit-on-signal-flip`) — both gated by `--min-hold-minutes` (default **5**).
- EOD square-off at `--eod-time`, default **15:15**, hard backstop at **15:17 IST** regardless of the configured value.
- `--cooldown-minutes` (default **5**) after an exit or an abandoned watch cycle.

## Target

- Daily profit target `--target-profit`, default **₹2,000**.

## Stop Loss

- Daily stop loss `--stop-loss`, default **₹2,000**.
