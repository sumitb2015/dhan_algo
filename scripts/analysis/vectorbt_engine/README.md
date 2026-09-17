# VectorBT Backtest Engine

A reusable, vectorized backtest engine built on [VectorBT](https://vectorbt.dev/),
sitting alongside the existing pandas-based `scripts/analysis/backtest_*.py`
scripts rather than replacing them. Use this engine for fast, signal-driven
directional backtests (crossovers, breakouts, momentum) on equities/index/futures
OHLCV data; the existing bespoke scripts remain the right tool for anything with
option-chain-specific payoff logic (straddles/strangles, rolling, IV-driven
entries) that doesn't reduce to a single close-price series.

## Why a separate engine, and why not OpenAlgo

This was bootstrapped from the `marketcalls/vectorbt-backtesting-skills` package
(`npx skills add marketcalls/vectorbt-backtesting-skills`), installed under
`.claude/skills/{backtest,optimize,quick-stats,setup,strategy-compare,vectorbt-expert}/`.
That package's own knowledge base (`.claude/skills/vectorbt-expert/rules/`) is a
good reference for VectorBT mechanics in general (simulation modes, position
sizing, stop-loss/take-profit, walk-forward, parameter optimization, plotting) —
read it when extending this engine.

Its data-fetching rule defaults to OpenAlgo's own SDK for Indian market data.
This repo's CLAUDE.md requires Dhan as the sole data source (never Zerodha/Kite,
and by the same logic not a third-party feed like OpenAlgo either), so this
engine is wired to the skill's own "Custom Data Provider" extension point
instead: `data.py` reads this repo's existing Dhan-sourced CSV caches
(`Historical Data/`, `Daily_Historical_Data_Fresh/`) rather than calling any
broker API. That also means it works after-hours with no access token.

## Modules

- `data.py` — Dhan-sourced OHLCV loaders (`load_index_daily`, `load_equity_daily`,
  `load_benchmark_returns`, `clip_date_range`). Every loader returns a tz-naive
  `DatetimeIndex` frame with lowercase `open/high/low/close/volume` columns.
- `costs.py` — Indian market fee models (`INTRADAY_EQUITY`, `DELIVERY_EQUITY`,
  `FNO_FUTURES`, `FNO_OPTIONS`), ported from the skill's `indian-market-costs.md`.
  Pass a `CostProfile` into `engine.run_backtest(...)`.
- `engine.py` — `run_backtest(close, entries, exits, cost_profile, ...)` wraps
  `vbt.Portfolio.from_signals`; `compare_to_benchmark(run, benchmark_close)`
  builds a strategy-vs-buy-and-hold table; `print_report(...)` prints both.
- `tearsheet.py` — `generate_tearsheet(...)` wraps OpenStatz's
  `ostz.dashboard(...)` (never QuantStats or the legacy `ostz.reports.html` —
  see the skill's `openstatz-tearsheet.md`), producing a self-contained offline
  HTML dashboard. Takes the benchmark as an already-loaded returns Series (from
  `data.load_benchmark_returns`) rather than fetching one itself, so the
  tearsheet's benchmark stays Dhan-sourced instead of the skill's own yfinance
  example (`^NSEI`).
- `example_ema_crossover.py` — runnable proof of the whole pipeline (data load →
  signals → backtest → comparison table → tearsheet). It is a demo, not a wired
  strategy — no live strategy under `strategies/` is hooked to this engine yet.

## Usage

```bash
venv/bin/python scripts/analysis/vectorbt_engine/example_ema_crossover.py
venv/bin/python scripts/analysis/vectorbt_engine/example_ema_crossover.py --symbol NIFTY --start 2022-01-01 --fast 10 --slow 30
```

To write a new backtest script against this engine:

```python
from scripts.analysis.vectorbt_engine import data, costs, engine, tearsheet

df = data.load_equity_daily("RELIANCE")
close = df["close"]

entries = ...   # your boolean signal series, aligned to close.index
exits = ...

run = engine.run_backtest(close, entries, exits,
                           cost_profile=costs.DELIVERY_EQUITY,
                           symbol="RELIANCE", strategy_name="My Strategy")

benchmark_close = data.load_index_daily("NIFTY")["close"]
comparison = engine.compare_to_benchmark(run, benchmark_close)
engine.print_report(run, comparison)

tearsheet.generate_tearsheet(
    run.portfolio.returns(), strategy_name="My Strategy - RELIANCE",
    output_path=Path("my_strategy_tearsheet.html"),
    benchmark_returns=data.load_benchmark_returns(run.portfolio.wrapper.index),
)
```

## Dependencies

`vectorbt==1.1.0` (the actively-maintained rewrite — see the comment block in
`requirements.txt` above the pin) plus `openstatz==0.4.1` (already required by
`backtest_momentum_portfolio.py`, installed `--no-deps`). Both are already
verified importable in this project's `venv`.

## Not yet done

- No live strategy from `strategies/` is wired to this engine — it was built
  engine-first, on purpose, so its data/cost/tearsheet plumbing gets reviewed
  before any strategy-specific signal logic is layered on top.
- No options/F&O payoff support — VectorBT's `Portfolio.from_signals` models a
  single tradeable close-price series, which fits directional equity/index/
  futures strategies well but not multi-leg option structures. The existing
  `backtest_short_straddle.py` / `backtest_rolling_straddle.py` style scripts
  remain the right tool for those.
- `optimize`, `quick-stats` and `strategy-compare` (the other three installed
  skills) are usable as-is once a real strategy is wired — they operate on
  whatever backtest script shape they're pointed at, no engine changes needed.
