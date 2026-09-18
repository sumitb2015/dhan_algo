# VectorBT Backtest Engine

A backtest engine built on [VectorBT](https://vectorbt.dev/), sitting alongside
the existing pandas-based `scripts/analysis/backtest_*.py` scripts rather than
replacing them. `data.py`/`costs.py`/`engine.py`/`tearsheet.py` are generic
building blocks for fast, signal-driven directional backtests (crossovers,
breakouts, momentum) on equities/index/futures OHLCV data — see
`example_ema_crossover.py`. `options_engine.py` is the dashboard's
`/backtest-signals` page: it runs `backtest_short_straddle.py`'s own multi-leg
options simulation and wraps the resulting trades in a `vbt.Portfolio` purely
so VectorBT computes stats/tearsheet on them, letting `/backtest-signals` be
compared directly against `/backtest` (same simulation, two stats engines).

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
- `options_engine.py` — the multi-leg options adapter powering the dashboard's
  `/backtest-signals` page. Does **not** reimplement `backtest_short_straddle.py`'s
  bar-by-bar entry/SL/target/trailing-SL/roll decisions (those are path-dependent
  and stay exactly as `/backtest` runs them) — it takes that script's resulting
  per-cycle, per-leg entry/exit prices and feeds them into a single grouped,
  cash-shared `vbt.Portfolio.from_signals` (one column per leg), so VectorBT
  computes its own Sharpe/Sortino/drawdown/tearsheet from the *same* trades. See
  its module docstring for the two simplifications this implies (leg exits
  booked at the cycle's shared entry/exit timestamp; rolls netted into one
  synthetic trade per leg-slot per cycle). Driven by
  `run_backtest_cli.py` (same CLI arg surface as `backtest_short_straddle.py`,
  plus `--cost-profile`/`--tearsheet-file`).

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
- Multi-leg options support (`options_engine.py`) reuses `backtest_short_straddle.py`'s
  own decision engine rather than reimplementing it in VectorBT-native signal
  arrays — a true bar-by-bar per-leg SL/roll simulation is inherently
  path-dependent and doesn't reduce to a vectorized signal series. What VectorBT
  contributes here is its own stats/tearsheet computation on those trades, not
  an independent second simulation.
- `optimize`, `quick-stats` and `strategy-compare` (the other three installed
  skills) are usable as-is once a real strategy is wired — they operate on
  whatever backtest script shape they're pointed at, no engine changes needed.
