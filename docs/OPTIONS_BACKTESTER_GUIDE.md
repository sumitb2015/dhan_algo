# Options Backtester: Comprehensive Feature & Architecture Guide

This document provides complete documentation for the StockMock-style Options Backtesting engine in the Dhan Algo Trading platform, spanning the quantitative Python simulation engine ([`scripts/analysis/backtest_short_straddle.py`](../scripts/analysis/backtest_short_straddle.py)), the Next.js API route ([`rs_dashboard/app/api/backtest/route.ts`](../rs_dashboard/app/api/backtest/route.ts)), and the interactive dashboard terminal ([`rs_dashboard/components/OptionsBacktester.tsx`](../rs_dashboard/components/OptionsBacktester.tsx)).

---

## 1. System Architecture

```
┌────────────────────────────────────────────────────────┐
│  Next.js Frontend (rs_dashboard/app/backtest)          │
│  OptionsBacktester.tsx                                 │
│  - Strike selection toolbar (ATM, offset, CP, Delta)   │
│  - Multi-leg builder & table                           │
│  - Strategy timing, Range Breakout & Positional sliders│
│  - Strategy SL/TP & Protect Profits (Lock & Trail)     │
│  - Past Backtests drawer & interactive charts          │
└───────────────────────────┬────────────────────────────┘
                            │ POST /api/backtest (JSON)
                            ▼
┌────────────────────────────────────────────────────────┐
│  API Bridge (rs_dashboard/app/api/backtest/route.ts)   │
│  - Spawns background Python worker via venv            │
│  - Polls debug/backtest_status.json for live progress  │
│  - Auto-archives finished runs to debug/backtests/     │
└───────────────────────────┬────────────────────────────┘
                            │ CLI arguments & flags
                            ▼
┌────────────────────────────────────────────────────────┐
│  Python Quant Engine (backtest_short_straddle.py)      │
│  - Fast SQLite reader over Options Data/nifty_options.db│
│  - 1-minute multi-leg simulation cycle                 │
│  - Realistic Dhan brokerage, STT & slippage friction   │
│  - Structured JSON & CSV output generation             │
└────────────────────────────────────────────────────────┘
```

---

## 2. Core Feature Catalog

### 2.1 Range Breakout Entry
- **Purpose**: Wait for the market to establish an initial balance / opening range before committing capital.
- **Workflow**:
  1. Operator defines **Entry Time** (start of range observation, e.g., `09:12`) and **Until Time** (end of observation window, e.g., `09:31`).
  2. The UI automatically renders the exact observation description:
     $$\text{Closing Time} = \text{range\_until\_time} - 1\text{ minute}$$
     *Example*: `High & Low of the Range will be considered between 9:12 open and 9:30 closing time.`
  3. During the observation period ($t < \text{range\_until\_time}$), the engine records the highest and lowest spot prices:
     $$\text{range\_high} = \max(\text{spot}), \quad \text{range\_low} = \min(\text{spot})$$
  4. Once $t \ge \text{range\_until\_time}$, trade entry triggers on the first candle where:
     $$\text{spot} > \text{range\_high} \quad \text{or} \quad \text{spot} < \text{range\_low}$$

---

### 2.2 Positional Trading Days (Multi-Day Holding)
- **Purpose**: Simulate multi-day positional strategies (e.g. entering on Thursday or Friday and holding overnight until Tuesday weekly expiry).
- **Controls**:
  - **Entry Date Slider**: 4 to 0 trading days before weekly expiry (excluding holidays). Default: `3`.
  - **Exit Date Slider**: 4 to 0 trading days before weekly expiry (excluding holidays). Default: `0` (expiry day).
  - **Constraint Enforcement**: Exit date is automatically clamped to $\le \text{Entry Date}$ (cannot exit before entering).
- **Execution Mechanism**:
  - `day_bars` is sliced across the full holding range:
    $$\text{trade\_bars} = \{ b \in \text{cycle.bars} \mid \text{entry\_trade\_date} \le b.\text{dt.date}() \le \text{exit\_trade\_date} \}$$
  - The strategy holds positions overnight across intermediate sessions and weekends.
  - End-of-Day (EOD) square-off is suppressed on intermediate days and only executes on the designated `exit_trade_date` at `eod_time` (or upon earlier target/stop hit).

---

### 2.3 Re-Entry vs. Re-Executing Logic
StockMock distinguishes between **Re-Entry** and **Re-Executing Logic**. Both ensure capital does not sit idle after an exit, but execute fundamentally different strategies:

| Feature | Execution Behavior | Strike Selection | Trigger Condition |
|---|---|---|---|
| **Re-Entry (ASAP)** | Enters immediately on the same bar. | **Same strike / leg** as original. | Next tick / bar close $\times$ slippage. |
| **Re-Entry (Cost)** | Waits for price to retrace. | **Same strike / leg** as original. | Option price returns to original entry price (`reentry_cost_target`). |
| **Re-Execute** | Reruns entire entry logic. | **Fresh strike** chosen by original rules (ATM offset, Delta, etc.) at current spot. | Immediately upon SL or Target hit. |

- **Journey After Cutoff (`no_reentry_after_time`)**:
  - Operator can set a cutoff time (e.g. `15:15`).
  - After this time, any active `waiting_reentry_cost` order is cancelled with status `NO_REENTRY_CUTOFF`, and no new re-entry/re-execute orders are placed.

---

### 2.4 Square Off One Leg vs. Square Off All Legs
- **Square Off One Leg** (Default):
  - When Leg 1 hits SL or Target, only Leg 1 exits (and potentially re-enters or re-executes). Sibling legs continue to run untouched.
- **Square Off All Legs**:
  - The moment any single leg hits SL or Target, the entire strategy is immediately flattened.
  - All remaining open legs are squared off at the bar close with reason `SQUARE_OFF_ALL`.
  - Any pending re-entries or wait-and-trade triggers are cancelled with reason `CANCELLED_BY_SQUARE_OFF`.

---

### 2.5 Strategy Target Profit & Strategy Stop Loss
Controls risk and return at the total portfolio / combined strategy level:
- **MTM (`mtm`)**: Absolute rupee value across the entire trade (e.g., Target: $+₹5,000$, Stop Loss: $-₹3,000$).
- **Percentage (`pct`)**: Percentage of total premium collected across all legs at initial entry:
  $$\text{base\_credit} = \sum_{\text{legs}} \text{entry\_price} \times \text{lots} \times \text{lot\_size}$$
  $$\text{pnl\_pct} = \frac{\text{current\_strategy\_mtm}}{\text{base\_credit}} \times 100$$
- **Realized P&L Inclusion**: `current_strategy_mtm` aggregates both closed legs (from prior rolls or re-entries) and current open legs, ensuring cumulative losses or gains are never lost.

---

### 2.6 Protect The Profits (Lock & Trail)
A non-linear ratcheting profit protection engine:
1. **Lock**:
   - When strategy MTM reaches $\ge X$, lock minimum profit at $Y$.
   - If MTM subsequently falls $\le Y$, all legs are squared off immediately with reason `PROTECT_PROFIT`.
2. **Trail**:
   - For every $X$ step increase in MTM, increase locked profit by $Y$.
3. **Lock + Trail**:
   - When strategy MTM reaches $X$, lock profit at $Y$.
   - For each additional step $A$ of profit above $X$, increase locked profit by $B$.
   - Ratchet rule: `current_locked_profit` can only move upward; it never decreases.

---

### 2.7 Wait & Trade (Momentum Confirmation)
- Legs do not enter immediately at `entry_time`. Instead, a baseline reference price $P_0$ is recorded.
- Leg arms a trigger:
  - `% ↑` / `Pts ↑`: Triggers entry once option price rises by the specified percentage or points (momentum buy/sell).
  - `% ↓` / `Pts ↓`: Triggers entry once option price decays by the specified percentage or points.
- Fill price is bound by the bar's `open` and trigger level degraded by entry slippage.

---

### 2.8 Balanced Entry (Price Difference Threshold)
- For straddle/strangle setups, monitors CE and PE premiums at the entry boundary.
- If:
  $$\frac{|\text{CE\_price} - \text{PE\_price}|}{\max(\text{CE\_price}, \text{PE\_price})} \times 100 > \text{max\_diff\_pct}$$
- The entry is postponed to subsequent bars until the premiums balance within threshold, preventing entries with high initial delta imbalance.

---

## 3. Quirks, Gotchas & Edge Cases Encountered

During development and rigorous verification, several non-obvious domain-specific quirks were identified and resolved:

### Quirk 1: Multi-Day Positional Static vs. Dynamic DTE
- **The Issue**: In an intraday simulation, DTE is fixed because all candles are on the same calendar date. In positional simulations holding from Thursday to Tuesday, calculating DTE once at cycle start and passing it as a static number meant that on Tuesday (0-DTE), Black-Scholes fallbacks and Delta calculations were still using Thursday's DTE (3.0 days).
- **The Fix**: `_simulate_one_day` computes dynamic DTE per candle:
  $$\text{cur\_days\_to\_expiry} = \max\left(0.0, \frac{\text{expiry\_dt} - \text{bar.dt}}{86400}\right)$$
  ensuring Greek and volatility decay models match the exact time remaining on every bar.

---

### Quirk 2: Overnight Gap Openings Past Stop Loss
- **The Issue**: If a short leg has an entry price of 100 and a 30% SL (trigger 130), and the market gaps up overnight such that the next morning's candle opens at 160 (High 170, Low 155), naive backtesters fill the exit at $130 \times \text{slip}$. In reality, a stop order in a gap market cannot fill better than the market open.
- **The Fix**: The fill price is bounded by the candle open:
  - Short leg: $\text{exit\_price} = \max(\text{sl\_trigger}, \text{leg\_open}) \times \text{slip}$
  - Long leg: $\text{exit\_price} = \min(\text{sl\_trigger}, \text{leg\_open}) \times \text{slip}$
  This eliminates artificial positive bias during overnight gap moves.

---

### Quirk 3: Positional Entry Date Spillover
- **The Issue**: In multi-day `day_bars`, if a strategy had a balanced entry filter (`max_diff_pct`) or `range_breakout` that never triggered on the designated entry date before the 15:00 cutoff, on Day 2 morning the loop would evaluate `not entered and t >= entry_time` and enter on Day 2.
- **The Fix**: Initial entry is strictly gated to the chosen entry day:
  ```python
  if not entered and (entry_trade_date is None or bar.dt.date() == entry_trade_date) and t >= entry_time:
  ```
  If entry conditions are not met on the scheduled entry date, the cycle cleanly concludes as `NO_ENTRY`.

---

### Quirk 4: Positional Slider UI Direction Inversion
- **The Issue**: In StockMock, the Entry Date slider displays `4` on the left and `0` on the right (higher numbers of days before expiry are on the left). Standard HTML `<input type="range">` puts `0` on the left and `4` on the right.
- **The Fix**: The UI inverts the slider value:
  ```tsx
  value={4 - daysBeforeExpiry}
  onChange={e => setDaysBeforeExpiry(4 - Number(e.target.value))}
  ```
  While displaying labels with singular/plural grammar: `0 trading day before weekly expiry(excluding holidays)` vs. `3 trading days...`.

---

### Quirk 5: Range Breakout Observation Time Math
- **The Issue**: When configuring a range from 09:12 to 09:30, 1-minute OHLC bars are labeled by open time. The 09:30 candle does not close until 09:31. If until time is set to 09:30, the 09:30 candle is excluded from the range.
- **The Fix**: Setting until time to `09:31` allows the observation window to span the full 09:30 bar. The UI dynamically computes and displays:
  $$\text{Close Time} = \text{Until Time} - 1\text{ minute}$$
  making the observation boundaries transparent to operators.

---

### Quirk 6: Overall Strategy Percentage SL with Rolls / Re-Entries
- **The Issue**: Comparing `(cur_net - net_credit_now) / net_credit_now` only evaluates currently active legs. When legs roll or re-execute, earlier realized losses were dropped from the denominator, resetting accumulated strategy losses.
- **The Fix**: Retained `initial_net_credit` recorded at initial entry, evaluating:
  $$\text{pnl\_pct} = \frac{\text{current\_strategy\_mtm}}{|\text{initial\_net\_credit}|} \times 100$$
  where `current_strategy_mtm = closed_legs_pnl + open_legs_pnl`.

---

### Quirk 7: SEBI Expiry Day Shift (Tuesday Invariant)
- **The Issue**: SEBI shifted Nifty weekly derivative expiries from Thursdays to Tuesdays starting in 2025. Hardcoding Thursday expiry assumptions breaks post-2025 simulations.
- **The Fix**: The database and backtest cycle parser resolve actual expiry dates directly from the database contract metadata (`cycle.expiry_date`), dynamically adapting across Thursday and Tuesday expiry eras.

---

### Quirk 8: History & LocalStorage State Serialization
- **The Issue**: Loading a past backtest from the archive or hydrating from browser `localStorage` previously dropped newly added leg fields (`wait_and_trade`, `re_entry_sl_count`, `re_execute_sl_count`, `cp_operator`) and strategy toggles (`square_off_mode`).
- **The Fix**: Standardized `LegConfig` TypeScript schema across UI, REST bridge, and Python JSON serializer. Added on-mount hydration and explicit type mapping in `handleLoadHistoryItem`.

---

## 4. CLI Argument Reference (`backtest_short_straddle.py`)

| Argument | Type | Default | Description |
|---|---|---|---|
| `--start-date` | `str` | `2021-01-01` | Start date (YYYY-MM-DD) |
| `--end-date` | `str` | `2026-06-30` | End date (YYYY-MM-DD) |
| `--strategy-type` | `str` | `intraday` | `intraday`, `expiry_day`, `first_day`, or `positional` |
| `--entry-days-before-expiry` | `int` | `3` | Trading days before weekly expiry to enter (0=expiry day) |
| `--exit-days-before-expiry` | `int` | `0` | Trading days before weekly expiry to exit (0=expiry day) |
| `--entry-time` | `str` | `09:20` | Trade entry time (HH:MM) |
| `--eod-time` | `str` | `15:15` | End-of-day square-off time (HH:MM) |
| `--legs` | `json` | DEFAULT_LEGS | JSON array of leg definitions |
| `--use-db` | flag | `False` | Read option quotes from SQLite cache |
| `--square-off-mode` | `str` | `one_leg` | `one_leg` or `all_legs` |
| `--profit-target-val` | `float`| `0.0` | Strategy target value |
| `--profit-target-type`| `str` | `pct` | `pct` (% of entry credit) or `mtm` (₹) |
| `--overall-sl-val` | `float`| `0.0` | Strategy stop loss value |
| `--overall-sl-type` | `str` | `pct` | `pct` (% of entry credit) or `mtm` (₹) |
| `--protect-profit-mode`| `str`| `none` | `none`, `lock`, `trail`, or `lock_trail` |
| `--lock-profit-reaches`| `float`| `0.0` | MTM threshold to activate profit lock |
| `--lock-profit-min` | `float`| `0.0` | Minimum profit locked |
| `--trail-profit-step`| `float`| `0.0` | MTM increase step for trailing |
| `--trail-profit-by` | `float`| `0.0` | Profit amount to trail by per step |
| `--range-breakout` | flag | `False` | Enable Range Breakout entry |
| `--range-until-time` | `str` | `09:31` | Observation window end time (HH:MM) |
| `--no-reentry-after-time`| `str`| `None` | Cutoff time after which re-entries stop |
| `--max-diff-pct` | `float`| `0.0` | Max CE/PE price difference % for entry gate |
| `--entry-cutoff-time`| `str`| `15:00` | Latest time to wait for balanced entry |
