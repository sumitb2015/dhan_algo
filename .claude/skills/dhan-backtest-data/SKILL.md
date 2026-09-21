---
name: dhan-backtest-data
description: Repo override for the installed VectorBT backtesting skills (backtest, optimize, quick-stats, strategy-compare, setup, vectorbt-expert). Use whenever the user asks to backtest, optimize parameters, compare strategies, or fetch historical data for research in this repo. The vendor skills assume an OpenAlgo server (`client.history()`), `from openalgo import ta` and yfinance, none of which exist here, and this repo's data is Dhan-only. This skill supplies the substitutions - a tested loader over the repo's own Dhan CSV/Parquet/SQLite files, the data map with real coverage, session/lot-size/cost rules, and the data-quality traps found in those files - so generated backtests actually run and stay Dhan-sourced. Also use before writing any new scripts/analysis/backtest_*.py.
---

# Backtesting on Dhan Data (override for the vendor VectorBT skills)

The installed `backtest`, `optimize`, `quick-stats`, `strategy-compare`, `setup` and `vectorbt-expert` skills come from
the OpenAlgo pack (`marketcalls/vectorbt-backtesting-skills`). Their method is sound (VectorBT `from_signals`,
benchmark comparison, realistic fees, plain-language report). Their **data layer is not usable here**:

| Vendor step | Why it fails in this repo | Use instead |
|---|---|---|
| `client.history()` via OpenAlgo | no OpenAlgo server, `openalgo` is not installed | `scripts/dhan_data.py` `load_ohlcv()` |
| `from openalgo import ta` (EMA, RSI, Supertrend, `exrem`) | package not installed | `pandas_ta` (installed) or `lib/intraday_signals.py`; inline `exrem` (below) |
| yfinance / `^NSEI` benchmark or fallback | not Dhan; breaks the Dhan-only data rule | `benchmark()` (NIFTY 50 from the repo CSV) |
| `openstatz` tearsheet | not installed | printed stats table + Plotly equity/drawdown (Plotly 6.9 installed) |
| hard-coded NIFTY `min_size=65`, BANKNIFTY `30` | lot size changed several times; today's lot on old data is wrong | size in lots from a dated table, or `DhanHelper.get_lot_size()` for a live-sized run |
| outputs into `backtesting/<name>/` | not gitignored, so every run leaves untracked files | keepers go to `scripts/analysis/backtest_<name>.py` (existing convention); scratch stays uncommitted |
Read the vendor skill for *how* to structure the run; apply this table for *where the data and indicators come from*.
Do not run `npx skills add ...` or `pip install openalgo`: that adds a second data/execution path this repo deliberately does not have.

**Keeping the override alive.** The six vendor skills are installed by `npx skills` (pinned in `skills-lock.json`, source
`marketcalls/vectorbt-backtesting-skills`; the real files live in `.agents/skills/`, `.claude/skills/` symlinks to them).
Each one carries a one-paragraph "Repo override" note pointing here. An `npx skills update` rewrites those files and drops
the note, so after any update run:
```bash
python3 .claude/skills/dhan-backtest-data/scripts/apply_vendor_overrides.py --check   # exit 1 if a note is missing
python3 .claude/skills/dhan-backtest-data/scripts/apply_vendor_overrides.py           # re-insert, idempotent
```
The lock hashes for those six files will not match the patched text; that is expected, and the lock file is left alone.

## The loader
```python
import sys; sys.path.insert(0, "<repo>/.claude/skills/dhan-backtest-data/scripts")
from dhan_data import load_ohlcv, benchmark, describe

df = load_ohlcv("RELIANCE", "D", start="2021-01-01")   # open high low close volume, tz-naive IST index
bm = benchmark("D", start="2021-01-01")                # NIFTY 50
print(describe("RELIANCE", "D"))                       # rows, sessions, first, last: put this in the report
```
Same shape the vendor templates expect from OpenAlgo, so their strategy/portfolio code works unchanged after the
fetch step. Intervals: `D`, `1m`, `3m`, `5m`, `15m`, `60m`... Bars above 1 m go through `lib.intraday_signals.resample_tf`,
so backtest bars equal the live strategies' bars. `python dhan_data.py` runs a self-check.

## What data exists (verified 2026-09-21; run `describe()` for the truth)
| Data | Location | Coverage |
|---|---|---|
| Index daily | `Historical Data/NIFTY_50_Daily_5Y.csv`, `NIFTY_500_Daily.csv`, `Indices/<NAME>.csv` (BANKNIFTY, FINNIFTY, INDIA_VIX, SENSEX plus 25 broad and sector indices) | NIFTY 2019-01-01 to 2026-09-18 (1901 sessions) |
| Stock daily | `Daily_Historical_Data_Fresh/<SYMBOL>_Daily_2Y.csv` (500 files) | filename says 2Y; RELIANCE runs from 2019 |
| Futures daily / 1-min | `Historical Data/{NIFTY,BANKNIFTY}_Futures_Daily.csv`, `*_Futures_1min_Manual.csv` (has `OI`, `Contract`) | manually maintained; check `describe()` |
| Index 1-min | `Historical Data/NIFTY_50_1Min_5Y.csv` | 2021-06-21 to 2026-06-18, 1244 sessions |
| Stock 1-min | `Intraday_Historical_Data/1min/<SYMBOL>.parquet` + `manifest.json` | **Nifty 50 members only, about 4 months**: never call an edge robust on it |
| Option prices | `Options Data/nifty_options.db`, table `option_prices(expiry, datetime, option_type, strike, strike_relative, open, high, low, close, spot, volume, oi, iv)` | 22.1 M rows, 2020-12-31 to 2026-09-15, 297 expiries |
Options research does not go through the loader: use the SQLite table directly and follow `dhan-expired-options-data`;
`scripts/analysis/backtest_short_straddle.py` and `backtest_rolling_straddle.py` are the reference implementations.
Refresh data with the scripts under `scripts/downloader/` (`refresh_dashboard_data.py`, `fetch_today_quotes.py`); never
fetch from a second provider to fill a gap.

## Traps found in the repo's own data
- **NIFTY 1-min contains out-of-session bars**: 26,187 pre-open bars (09:00 to 09:14) and 36,811 post-close bars
  (15:30 to 23:59, nearly all zero-volume, mostly 2021-22, on 218 of 1249 days). Unfiltered, every resample gets
  partial 09:00/09:05/09:10 bins. `load_ohlcv` drops them by default (`session=("09:15","15:29")`) and yields exactly
  375 / 75 / 25 bars per session at 1 m / 5 m / 15 m. Pass `session=None` only to inspect the raw file.
- **60-minute bars**: 09:15 is not divisible by 60, so the first hourly bar is 09:00 to 09:59 holding only 45 minutes
  (documented in `resample_tf`). Treat it as structurally different or use 15 m / 30 m.
- **Short intraday windows**: stock 1-min data spans about 81 sessions. State the window and the number of trades;
  `intraday_equity` ships dry-run-only because its best rule set still returned -0.09R per trade over 81 sessions, and
  the same at zero cost, against a +0.15R out-of-sample gate.
- **Look-ahead**: a signal computed on a bar's close cannot fill at that bar's close in live trading. Shift entries
  and exits by one bar, or fill at the next open, and compare to the unshifted run: a big gap means the edge was
  the look-ahead (`vectorbt-expert/rules/pitfalls.md`).
- **Survivorship**: the stock files are today's index constituents. A strategy that ranks "Nifty 500" over 2019 sees
  only the survivors.

## Indicators and signals
`pandas_ta` for standard indicators (the live helper uses it too: `helper.get_indicators_ta`); `lib/intraday_signals.py`
for `ema`, `atr` (Wilder), `adx`, `supertrend`, `session_vwap`, `resample_tf`. `openalgo.ta` names map directly
(`ta.ema` to `pandas_ta.ema`, `ta.rsi` to `pandas_ta.rsi`, `ta.supertrend` to the repo's). Signal cleaning, which the vendor
skills call `ta.exrem`, inline:
```python
def exrem(a, b):   # first True of `a` until `b` fires; both boolean Series with .fillna(False) applied
    out, on = pd.Series(False, index=a.index), False
    for i, (x, y) in enumerate(zip(a.values, b.values)):
        if not on and x: out.iloc[i] = True; on = True
        elif on and y: on = False
    return out
```
Supertrend has several implementations in this repo that do not all agree; see `dhan-indicators` before choosing one.

## Costs
There is no shared cost model. The intraday equity backtest charges a flat `cost_per_order = 25.0` per fill
(`IntradayConfig`); the momentum backtest takes `--fee-pct` / `--fixed-fee` and `--no-costs`; the vendor
`vectorbt-expert/rules/indian-market-costs.md` gives a Zerodha reference (delivery 0.111 % + Rs 20, intraday 0.0225 % + Rs 20,
futures 0.018 % + Rs 20). Pick one, print it in the report, and always show net-of-cost next to gross: an edge that
only exists at zero cost (as in the intraday equity study) is not an edge.

## A minimal run that works here
```python
import pandas_ta as ta, vectorbt as vbt
df, bm = load_ohlcv("RELIANCE", "D", start="2021-01-01"), benchmark("D", start="2021-01-01")
c = df["close"]; f, s = ta.ema(c, 20), ta.ema(c, 50)
buy  = ((f > s) & (f.shift() <= s.shift())).fillna(False)
sell = ((f < s) & (f.shift() >= s.shift())).fillna(False)
pf = vbt.Portfolio.from_signals(c, exrem(buy, sell), exrem(sell, buy), init_cash=1_000_000,
                                fees=0.00111, fixed_fees=20, min_size=1, size_granularity=1, freq="1D")
bh = vbt.Portfolio.from_holding(bm["close"].reindex(c.index).ffill(), init_cash=1_000_000, freq="1D")
print(pf.stats()); print("benchmark return", bh.total_return())
```
Verified in this venv (vectorbt 1.1.0, pandas_ta 0.4.71b0). Run with `venv/bin/python` from the project root.

## Before you trust a result
- [ ] Report `describe()` for every series (window, sessions) and the trade count.
- [ ] Net and gross of costs, against the NIFTY benchmark.
- [ ] Shifted-signal (next-bar) run agrees with the unshifted one.
- [ ] Out-of-sample split or walk-forward (`vectorbt-expert/rules/walk-forward.md`), not only an optimised in-sample grid
      (`/optimize` heat-maps show where the curve-fit is).
- [ ] If the idea already has a `scripts/analysis/backtest_*.py`, extend or compare to it before writing a new one.
- [ ] Anything meant to trade live: put the signal logic in `lib/` as pure functions and import it from both the
      backtest and the strategy (the `lib/intraday_signals.py` pattern, see `dhan-new-strategy`).

## Related
`dhan-indicators` (which indicator implementation, warm-up and closed-candle rules), `dhan-expired-options-data` (options
history), `dhan-new-strategy` (taking a validated idea live), the vendor `vectorbt-expert` rule files for VectorBT mechanics
(position sizing, stops, walk-forward, robustness), which apply unchanged.
