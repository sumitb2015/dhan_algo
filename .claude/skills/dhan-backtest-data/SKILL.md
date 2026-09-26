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
| `openstatz` tearsheet | installed (v0.4.1) | `ostz.dashboard(returns, output="tearsheet.html", open_browser=False)` (self-contained offline interactive HTML) |
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

## What data exists (verified 2026-09-26; run `describe()` for the truth)
| Data | Location | Coverage |
|---|---|---|
| Index daily | `Historical Data/NIFTY_50_Daily_5Y.csv`, `NIFTY_500_Daily.csv`, `Indices/<NAME>.csv` (BANKNIFTY, FINNIFTY, INDIA_VIX, SENSEX plus 25 broad and sector indices) | NIFTY 2019-01-01 to 2026-09-18 (1901 sessions) |
| Stock daily | `Daily_Historical_Data_Fresh/<SYMBOL>_Daily_2Y.csv` (500 files) | filename says 2Y; RELIANCE runs from 2019 |
| Futures daily / 1-min | `Historical Data/{NIFTY,BANKNIFTY}_Futures_Daily.csv`, `*_Futures_1min_Manual.csv` (has `OI`, `Contract`) | manually maintained; check `describe()` |
| Index 1-min | `Historical Data/NIFTY_50_1Min_5Y.csv` | 2021-06-21 to 2026-06-18, 1244 sessions |
| Stock 1-min | `Intraday_Historical_Data/1min/<SYMBOL>.parquet` + `manifest.json` | **Nifty 50 members only, about 4 months**: never call an edge robust on it |
| Option prices | `Options Data/nifty_options.db`, table `option_prices(expiry, datetime, option_type, strike, strike_relative, open, high, low, close, spot, volume, oi, iv)` | **22.21 M rows, 7.6 GB**, 2020-12-31 to 2026-09-22, **298 expiries**, 1418 sessions. Covers **NIFTY only**, 21 relative strikes (`ATM`, `ATM±1` to `ATM±10`), 276 absolute strikes (13,100 to 26,850). Mirrored in `Options Data/NIFTY/` (21 folders x 298 CSVs). |

Options research does not go through the loader: use the SQLite table directly and follow `dhan-expired-options-data`;
`scripts/analysis/backtest_short_straddle.py` and `backtest_rolling_straddle.py` are the reference implementations.
Refresh data with the scripts under `scripts/downloader/` (`refresh_dashboard_data.py`, `fetch_today_quotes.py`); never
fetch from a second provider to fill a gap.

## Strategy Backtest Feasibility & Scope Limits
**Can any strategy be backtested?** No. Backtest feasibility is strictly gated by data availability and contract coverage:
- **Full Support**:
  - **Nifty Near-ATM Options Selling / Straddles / Strangles** (`strategies/value_imbalance/`): Tested via `backtest_short_straddle.py` / `backtest_rolling_straddle.py` on 298 expiries (1-min resolution, ATM±10).
  - **Nifty 500 Positional Momentum / CNC** (`strategies/momentum_investing/`): Tested via `backtest_momentum_portfolio.py` using 500 stock daily CSVs (2019-2026).
  - **Nifty Index Breakout / Trend / Intraday**: Tested via VectorBT on `Historical Data/NIFTY_50_1Min_5Y.csv` (1244 sessions).
- **Partial / Restricted Support**:
  - **Wide-Wing / Deep OTM Options** (e.g. `nifty_volcano_calendar.py`, `nifty_flyagonal.py`): Missing strikes >500 points from ATM (ATM-400 / ATM-800 wings) and far-month expiries (>35 DTE).
  - **OI Imbalance / PCR Directional** (`strategies/oi_directional/`, `st_oi_bearcall/`): 1-min OI is present, but only across the 21 relative strikes stored (not full-chain PCR).
  - **Intraday Cash Equity** (`strategies/intraday_equity/`): 1-min stock parquet data covers only ~81 sessions (4 months).
- **No Support (Missing Data)**:
  - **BankNifty / Sensex / Stock Options**: Zero expired option contracts in the repo.
  - **MCX Crude Oil Futures / Options** (`strategies/crudeoil/`): No historical 1-minute MCX candle dataset exists.

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

## Options Backtesting Architecture & Sensitivity Scans
For multi-leg intraday and positional options strategies, do not use VectorBT. Query the SQLite store directly:
- **Data Source**: `Options Data/nifty_options.db` (table `option_prices`, 22.2M rows, 298 expiries, 1-min resolution, 21 relative strikes `ATM` and `ATM±1` to `ATM±10`, step 50 pts).
- **Core Strategy Simulators**:
  - `scripts/analysis/backtest_straddle_diff_sl_shift.py`: Full simulation of intraday straddles with balanced entry gate (`diff < 10%`), leg SL %, OTM strike shift, combined profit target and stop loss.
  - `scripts/analysis/run_straddle_scans.py`: Grid scan engine running 5 dimensions of sensitivity:
    1. **Entry Gate Filter** (`diff_pct` < 5%, 10%, 15%, 20%, raw)
    2. **Leg SL Tightness** (15%, 20%, 25%, 30%, 40%)
    3. **Adjustment Architecture** (Shift 1 OTM vs Shift 2 OTM vs Hold Runner vs Close All)
    4. **Profit Target Barrier** (+10%, +15%, +20%, +30%, EOD only)
    5. **Entry Timing** (09:20, 09:30, 09:45, 10:00)
    6. **Day-of-Week & Gamma Risk** (Mon–Fri breakdown)
  - `scripts/analysis/backtest_short_straddle.py` & `backtest_rolling_straddle.py`: Strike-buffer and delta-proximity rolling straddle engines.

## OpenStatz Tearsheet Reporting
`openstatz` (v0.4.1) is installed and replaces static reporting with self-contained, interactive offline HTML dashboards:
```python
import openstatz as ostz

# 1. Convert trade P&L (₹) to daily percentage returns on deployed capital (e.g. ₹1.5L/lot)
capital = 150_000.0
daily_returns = df.set_index("date")["net_inr"] / capital
daily_returns.name = "Nifty Intraday Straddle"  # Controls the tearsheet <h1> and legend

# 2. Generate the modern interactive dashboard (no server needed, purely offline HTML)
ostz.dashboard(
    daily_returns,
    output="debug/straddle_backtest_tearsheet.html",
    title="Nifty Straddle Tearsheet",
    open_browser=False
)
```

## Structured Backtest Archival Architecture (`debug/backtests/options/`)
Never overwrite a single `backtest_result.json` file. All completed options backtests are persisted in dedicated, structured directories:

```
debug/backtests/options/<id>/
├── metadata.json       # Fast-indexed KPIs (id, name, timestamp, trades, win_rate, total_pnl, max_dd, tags, artifact flags)
├── result.json         # Complete simulation payload (summary, cycles, equity_curve, monthly_pnl, params, vbt)
├── trades.csv          # Full cycle-by-cycle trade ledger (date, spot, atm, entry/exit prices, gross/net P&L, taxes, shifts)
├── tearsheet.html      # Interactive OpenStatz HTML tearsheet (self-contained, offline)
└── scans_summary.json  # Multi-parameter sensitivity scan grids, heatmaps, and DTE matrices
```

### Automatic API Archiving (`rs_dashboard/app/api/backtest/route.ts`)
When a simulation finishes—either via the asynchronous polling endpoint or synchronous execution—the backend invokes `autoArchiveBacktest(result)`. It auto-generates a timestamped identifier (e.g. `nifty_intraday_straddle_20260926_114500`), writes `result.json` and `metadata.json`, and indexes the run for instant retrieval.

### Backtest History API (`/api/backtest/history`)
- `GET /api/backtest/history`: Returns array of `BacktestMetadata` across all archived runs, sorted newest first.
- `GET /api/backtest/history?id=<id>`: Returns `{ metadata, result }` to reconstruct full performance charts without re-simulating.
- `GET /api/backtest/history?id=<id>&file=tearsheet`: Serves `tearsheet.html` directly with `Content-Type: text/html` for in-browser rendering.
- `GET /api/backtest/history?id=<id>&file=csv`: Serves `trades.csv` with `Content-Disposition: attachment`.

### Dashboard History Viewer (`OptionsBacktester.tsx`)
- **Past Backtests Modal**: Accessible via the header button beside "Change Settings" and the "Past Runs" bottom toolbar button. Features instant search across strategy names, dates, and tags.
- **Load Backtest**: Restores strategy parameters (dates, entry/exit times, legs, lot size, target/SL) and sets `result` so all charts, monthly heatmaps, drawdowns, and cycle logs render immediately.
- **Tearsheet Modal**: Embeds the interactive OpenStatz HTML tearsheet in an expanded modal view with an "Open in New Tab" link.

## Options Strategy Quant Invariants
Empirical findings verified across 248 sessions of 1-minute historical data and 4,155 real Dhan F&O trades (2025–2026):
1. **Balanced Entry Gate is Alpha-Critical**: Enforcing `|CE - PE| / max(CE, PE) < 10%` before entering a straddle cuts max drawdown by 52% and boosts Net P&L by +600% vs blind entry at 09:30. Unbalanced entries create persistent one-sided delta drag.
2. **1-Strike OTM Shift Outperforms Runners and Exits**: When leg SL is hit, shifting 1 strike OTM (+50 pts for CE, -50 pts for PE) halves the max drawdown compared to holding an unhedged runner (-₹21.7k vs -₹58.1k). However, shifting 2+ times flips net P&L negative due to double-churn commission drag.
3. **SEBI 2025 Tuesday Expiry Rule & DTE Dynamics**: From 2025 onwards, SEBI mandated NIFTY weekly index derivatives expire on **TUESDAYS** (prior to 2025 it was Thursday). In the 2025–2026 dataset, 49 of 53 0-DTE expiries occurred on Tuesday (3 on Monday due to holidays, 0 on Thursday). Never hardcode expiry days; resolve dynamically via `dte = (expiry_date - trade_date)`. In backtesting:
   - **Tuesday (0-DTE) is profitable (+₹6.4k net)** because accelerated theta decay overcomes friction.
   - **Wednesday & Thursday (4–5 DTE) bleed heavily (-₹19.2k combined)** because slow decay on high-premium contracts (~₹200) cannot compensate for 40-pt leg SL hits and high STT.
4. **Decay Profile Favors EOD Hold**: Capping gains at +20% prematurely clips afternoon theta decay. Holding until 15:15 (while maintaining an adverse -20% combined stop loss) captures significantly higher net decay.
5. **Dhan F&O Ledger Taxation Invariant**: Naive backtests assuming flat ₹20/order or flat ₹40/cycle severely distort reality (under-reporting costs by ₹41k+ across 231 sessions). An audit of 4,155 real Dhan broker trades revealed real transaction friction averages **~₹50.14 per executed order**:
   - Brokerage: ₹20 / order
   - GST on Brokerage: 18% (₹3.60)
   - STT: **0.10% (₹1,000/cr) on option SELL premium turnover**
   - Exchange Transaction Fee: ~0.05% on premium turnover + GST
   - SEBI Turnover Fee + Stamp Duty: ₹3/cr
   Any strategy averaging >4 orders/day will bleed net capital unless gross edge exceeds ₹300/day.

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


