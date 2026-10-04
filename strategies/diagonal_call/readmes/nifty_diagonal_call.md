## Summary

Positional (`MARGIN`), delta-controlled diagonal covered call on Nifty. Buys far-dated calls (60–120 DTE, ~0.60 delta) for upside convexity and margin reduction, while continuously selling medium-dated OTM calls (25–45 DTE, ~0.18 delta) to harvest theta decay. Short positions are sized dynamically to maintain a net delta of +10 to +20, and selected to maximize theta decay relative to gamma. The long calls do not need to recover their purchase price to profit: cumulative short call premium finances the long calls over successive monthly cycles.

## Entry

- **Timing**: Market open after `--start-time` (default **09:30 AM IST**), evaluated during rebalance windows (**10:00, 12:00, 14:00**).
- **Long Leg (First)**: Buys 60–120 DTE Call (`CE`), 0.55–0.65 delta (preferred ~0.60). Sized at `--long-lots` (default **3** lots). Long leg is confirmed before short leg is sold.
- **Short Leg (Second)**: Sells 25–45 DTE OTM Call (`CE`), 0.15–0.22 delta (preferred ~0.18–0.20), choosing the strike closest to the target delta (theta/gamma only breaks ties), on a monthly expiry that ends before the long. Weekly options are excluded and nothing is sold out of the delta band.
- **Dynamic Sizing**: Short lots are sized so net portfolio delta targets `--target-net-delta` (default **+13** units), capped at `--max-short-lots` (default **6** lots) and `--max-short-ratio` (default **1.25×** long delta).
- **Execution**: Long-dated call is placed first to ensure hedge margin benefits before selling the short call.

## Exit

- **Short-Call Roll / Profit Take**: Rolls the short call into a fresh 25–45 DTE strike when:
  - Short option decays by `--short-profit-pct` (default **65%** profit captured).
  - Short DTE drops to `≤ 14` days (`--short-roll-dte`).
  - Short delta expands `> 0.35` (`--short-roll-delta`) or portfolio delta drops `< -40`.
  - Portfolio gamma breaches `--min-gamma-limit` (default **-0.20**).
- **Long-Call Roll**: When long call DTE reaches `< 35` days (`--long-roll-dte`), closes it and opens a fresh 60–120 DTE call.
- **Order of Execution**: Exits always close short calls first before closing long calls.
- **Overnight Hold**: Strategy carries forward overnight at 15:25 without intraday auto-square-off.

## Target

- **Profit Target**: `--target-profit` (default: **off**; optional cumulative target in INR or `%` of capital).
- **Short Leg Target**: Book profit and roll when short leg reaches **65%** decay (`--short-profit-pct`).
- **Free Long Call**: When cumulative short premium equals 100% of initial long debit, short delta is clamped to far OTM (0.08–0.15 delta) with reduced short lots to let the funded long call ride upside moves risk-free.

## Stop Loss

- **Hard Stop Loss**: `--stop-loss` (default: **off**; optional cumulative stop in INR or `%`). `--drawdown-exit-pct` is the standing stop.
- **Daily Loss Limit**: Suspends discretionary adjustments for the rest of the day (expiry/critical-delta rolls still run) if intraday MTM drops by `--daily-loss-pct` (default **1.5%** of capital).
- **Drawdown Halving**: Halves short exposure immediately if portfolio drawdown reaches `--drawdown-halve-pct` (default **5.0%**).
- **Drawdown Exit**: Liquidates all positions and halts if drawdown hits `--drawdown-exit-pct` (default **8.0%**).
