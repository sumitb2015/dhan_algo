---
name: dhan-indicators
description: How technical indicators are computed, shared and tested in this repo, and how to add or change one safely. Use whenever the user adds or modifies an indicator (Supertrend, EMA, ATR, ADX, VWAP, RSI, MACD...), asks which implementation to use, sees a live strategy and its backtest disagree, gets different indicator values on two machines, writes a custom or Numba-accelerated indicator, cleans buy/sell signals, or builds a signal that must behave the same live and in a backtest. Covers helper.get_indicators_ta specs, lib/intraday_signals.py, the six Supertrend implementations and where they differ, the TA-Lib host dependence, closed-candle and warm-up rules, and when Numba is and is not worth it.
---

# Indicators in dhan_algo

An indicator that differs by 2 % between the backtest and the live strategy is not a rounding issue: it moves a stop,
a flip bar, and a position size. Most indicator bugs here were two implementations of the same thing drifting apart.
This skill says where indicators come from, which copies exist, and the rules that keep live and backtest identical.

## Where indicators come from
| Source | Use for | Notes |
|---|---|---|
| `helper.get_indicators_ta(symbol, interval, [specs], days)` | live strategies and dashboard routes | `pandas_ta` under the hood via `calculate_ta_indicators(df, specs)` |
| `lib/intraday_signals.py` | pure, broker-free signals shared by live and backtest | `ema`, `_rma`, `true_range`, `atr` (Wilder), `adx`, `supertrend`, `session_vwap`, `resample_tf` |
| `lib/pivots.py` | swing high/low with confirmation lag | `docs/PIVOT_DETECTION.md` |
| `pandas_ta` directly | research and backtests | installed (0.4.71b0) |
`openalgo.ta` is **not installed**; skills that say `from openalgo import ta` need the mapping in `dhan-backtest-data`.

### Spec formats accepted by `calculate_ta_indicators`
- Strings: `EMA20`, `SMA50`, `RSI14`, `ATR14`, `ADX14` (number = length), `MACD` (12/26/9), `BBANDS` or `BB` (20, 2),
  `VWAP`, `SUPERTREND` (pandas_ta defaults 7 / 3.0). Any other name is tried as a `pandas_ta` method with defaults.
- Dicts for anything parameterised: `{"kind": "supertrend", "length": 10, "multiplier": 3.0}`,
  `{"kind": "macd", "fast": 12, "slow": 26}`. Output columns follow pandas_ta naming (`SUPERT_10_3.0`, `SUPERTd_10_3.0`),
  so select by prefix (`c.startswith("SUPERTd_")`), as the strategies do.
Column names in: `Open High Low Close Volume` (the helper lower-cases copies for pandas_ta). Empty frame in, empty frame out.

## Supertrend: six implementations that do not all agree
| Implementation | Used by | ATR smoothing |
|---|---|---|
| `lib/intraday_signals.supertrend(df, period, multiplier)` returns `st_line`, `st_dir` | intraday_equity live and its backtest | Wilder RMA, TA-Lib-seeded (`_rma(offset=1)`) |
| `scripts/tools/level_chart_fetch._supertrend` | Level Chart | Wilder (`_wilder_atr`), deliberately not `pandas_ta` |
| `pandas_ta.supertrend` via `calculate_ta_indicators` | `st_oi_bearcall`, `nifty_vix_straddle` (`_resample_and_supertrend`), `options_chart_fetch` | RMA by default |
| `scripts/analysis/backtest_ema_breakout.compute_supertrend` | that backtest only | `ewm(span=period)`, i.e. alpha 2/(n+1), **not Wilder** |
Measured on this repo's data (period 10, multiplier 3): the `lib` version and `pandas_ta` agree on direction for 99.93 %
(NIFTY daily), 100 % (RELIANCE daily) and 99.80 % (NIFTY 15 m) of bars, but their band *levels* differ by up to 526 points
on NIFTY daily around flips, so use one implementation for direction *and* stop level. The `ewm(span)` variant agrees on direction
for only 96.1 % of NIFTY daily bars (its ATR(10) is 2.2 % higher), so any conclusion from that backtest does not transfer to the strategies.
Rule: new code calls `lib/intraday_signals.supertrend` or the `pandas_ta` path the strategy already uses; do not add a
seventh. If you consolidate, replace one at a time and add a test that pins the old output, because a "cleanup" changes
historical backtest numbers.

## Host dependence: TA-Lib
`pandas_ta` silently switches to TA-Lib when `import talib` works. `lib/intraday_signals.ema` and `_rma` are written to
reproduce that path bit for bit (SMA-seeded EMA; RMA seeded from `TR[1..n]`), and their docstrings cite drifts of about 0.2 price
points (EMA) and 1.5 % (ATR warm-up) when the seeding differs. **This venv has no TA-Lib** (`import talib` fails), while the `_rma` docstring
records TA-Lib 0.6.8 on the machine it was written on, so `helper.get_indicators_ta()` can return slightly different
values on two hosts. Before comparing a live
signal with a backtest, check `python -c "import talib"` on both; do not chase a 0.2-point EMA gap for an afternoon.
Never replace `ema` with a plain `ewm(span=n, adjust=False)`: it starts from the first value, not an SMA seed.

## Rules for a new or changed indicator
1. **Pure function, one home.** `def f(df, ...) -> Series/DataFrame`, no broker, no clock, no I/O, in `lib/`. The live
   strategy and the backtest import the same function (`intraday_signals` is the model; see `dhan-new-strategy`).
2. **Act on closed bars only.** The last row of a live candle frame is still forming. The strategies read
   `df.iloc[-2]` ("last completed bar"); a signal computed on `iloc[-1]` repaints and backtests will not reproduce it.
3. **Warm-up is NaN, and NaN means no signal.** Never fill it. Drop or gate the first `length` bars (RMA-based
   indicators are still settling for a while after `length` bars: the `_rma` docstring measures about 1.5 % drift through the
   warm-up when seeding differs, so give ATR/ADX a generous margin before trusting them).
4. **Resample on the NSE grid.** Use `resample_tf` (`origin='start_day'`, buckets at 09:15); the default pandas origin makes a
   partial first bar and shifts every higher-timeframe value. Hourly bars start 09:00 (first bar holds 45 minutes).
5. **Clean signals.** Raw crossovers repeat. Keep the first `True` until the opposite signal fires (the `exrem` pattern in
   `dhan-backtest-data`), and never let two rules both own the exit.
6. **Mix categories, do not stack copies.** RSI + Stochastic + CCI are one momentum vote three times. Pair trend +
   momentum + volatility or volume (EMA stack + RSI + ATR, or Supertrend + ADX + VWAP as `intraday_signals` does).
7. **Test it.** Pin a known input and the expected output in `tests/test_<name>.py` (`tests/test_intraday_signals.py` shows the
   shape), and add a parity test against `pandas_ta` when the strategy cross-checks `get_indicators_ta()`.
8. **Refresh once per candle, not per second.** Indicator recomputation on a fresh candle pull every second was the throughput
   bug fixed in `466e225`; recompute when a new bar closes.

## Numba: usually not worth it here
`numba` 0.67 is installed (a VectorBT dependency) and unused in the repo. Measured on the 464,476-bar NIFTY 1-minute file:
the repo's Python `_rma` loop takes **0.35 s** (1.6 ms on daily bars); a Numba version is bit-identical (max diff 0) and
about 240x faster. A single pass does not justify the complexity. Reach for it only when the same loop runs thousands of times:
a parameter grid (`/optimize`), or many symbols over 1-minute history. If you do:
- `@njit(cache=True, nogil=True)`, and **never `fastmath=True`**: it breaks NaN handling, and NaN carries meaning here.
- `cache=True` needs the function in a real file (`<stdin>` fails: "no locator available").
- Numba functions take and return NumPy arrays, no Series. Wrap them in a normal function that restores the index.
- Handle NaN explicitly inside the loop (skip or carry the previous value, as `_rma` does) and keep it O(n).
- Assert equality with the pandas version before using it (`np.nanmax(np.abs(a - b)) < 1e-9`), and keep the pandas version as the
  reference implementation.

## Related
`dhan-backtest-data` (loader, session filter, signal cleaning), `dhan-new-strategy` (pure decision functions, live/backtest
parity), `dhan-live-chart` (indicator series on a chart), `docs/PIVOT_DETECTION.md`.
