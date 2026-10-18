# Breakdown Auto-Scalper Strategy (Multi-Strike Option Premium Breakdown)

`strategies/breakdown_scalper/strategy.md`  
Dashboard UI: [`/breakdown-scalper`](http://localhost:3000/breakdown-scalper)

An automated intraday options-selling strategy and multi-strike scanner. It systematically identifies and shorts option contracts whose premiums have broken down below **Supertrend (10, 2)**, **Session VWAP**, and **EMA 20** on completed closed candles, strictly gated by an **Underlying Index Market Direction Filter** and managed with a dynamic **downward-ratchet Trailing Stop-Loss**.

---

## 1. Executive Summary & Core Hypothesis

### The Hypothesis
Option sellers earn positive Theta (time decay) and volatility collapse. When an option's market price drops below all three major momentum and trend benchmarks:
1. **Supertrend (10, 2)** — Trend polarity indicator indicating directional sell pressure.
2. **Session VWAP** — Volume-weighted average price indicating institutional seller dominance.
3. **EMA 20** — Intermediate moving average indicating short-term momentum exhaustion.

...the option is experiencing aggressive short-buildup or long-liquidation. Shorting these collapsing premiums offers rapid decay capture.

### The Critical Flaw of Unfiltered Multi-Strike Selling
If a naive scanner simply shorts every option that trades below these 3 indicators across ATM $\pm$ 6 strikes:
- **Correlated Multi-Strike Exposure**: In a strong bullish trend, 5 to 6 Put strikes will break down simultaneously. Shorting all 6 is **not** 6 diversified setups; it is **one giant concentrated directional bet**.
- **Sudden Index Reversals**: A sharp 50-point flash reversal in Nifty causes all 6 short puts to spike simultaneously, triggering severe multi-strike stop-losses and slippage.
- **Sideways Whipsaw**: In a choppy range-bound market, option premiums repeatedly oscillate across VWAP and EMA20, generating continuous false breakdowns.

### The Engineered Solution: 6 Safeguards
To make this viable and robust, this strategy incorporates:
1. **Underlying Index Direction Bias Gate** (Bullish $\rightarrow$ PEs only; Bearish $\rightarrow$ CEs only; Sideways $\rightarrow$ zero new trades).
2. **Fresh Breakdown on Closed Candles** (Current bar closes below all 3; previous bar was NOT below all 3; no intrabar repainting).
3. **Multi-Strike Signal Ranking** (Scores freshness, ATM proximity, liquidity, and OI buildup to pick the single best strike).
4. **Strict Portfolio Exposure Limits** (Max 2 concurrent positions, max 1 on the same side).
5. **Downward-Ratchet Trailing Stop-Loss** (Trails down as new lowest premiums print; NEVER loosens or moves up).
6. **Hard Daily Loss Circuit Breaker & 15:15 IST Mandatory Square-Off**.

---

## 2. Strategy Architecture & Workflow

```
                        ┌───────────────────────────────┐
                        │   1. Market Direction Filter  │
                        │    Nifty Spot vs VWAP & EMAs  │
                        └──────────────┬────────────────┘
                                       │
            ┌──────────────────────────┼──────────────────────────┐
            ▼                          ▼                          ▼
     [BULLISH TREND]            [SIDEWAYS / CHOP]          [BEARISH TREND]
   Spot > VWAP & EMA9 > 20     Unaligned or Flat        Spot < VWAP & EMA9 < 20
   Eligible: PE Shorts only    NO NEW TRADES (Lockout)  Eligible: CE Shorts only
            │                                                     │
            └──────────────────────────┬──────────────────────────┘
                                       │
                                       ▼
                        ┌───────────────────────────────┐
                        │   2. Multi-Strike Scanner     │
                        │   ATM ± 6 Strikes (26 Legs)   │
                        └──────────────┬────────────────┘
                                       │
                                       ▼
                        ┌───────────────────────────────┐
                        │  3. Triple Breakdown Check    │
                        │  Closed Bar < ST, VWAP, EMA20 │
                        │  Fresh Crossover (Prev != OK) │
                        └──────────────┬────────────────┘
                                       │
                                       ▼
                        ┌───────────────────────────────┐
                        │    4. Signal Ranking Engine   │
                        │  Rank by Freshness + Proximity│
                        │  + Depth/Volume + OI Buildup  │
                        └──────────────┬────────────────┘
                                       │
                                       ▼
                        ┌───────────────────────────────┐
                        │    5. Portfolio Limit Gate    │
                        │  Open < Max Total (2)         │
                        │  Same-Side < Max Same-Side (1)│
                        │  Daily Loss < Circuit Breaker │
                        └──────────────┬────────────────┘
                                       │ [Qualified]
                                       ▼
                        ┌───────────────────────────────┐
                        │     6. Order Execution        │
                        │  SIM Paper or Real Fast Order │
                        └──────────────┬────────────────┘
                                       │
                                       ▼
                        ┌───────────────────────────────┐
                        │   7. Dynamic Trade Manager    │
                        │  - Downward-Ratchet Trail SL  │
                        │  - Scalp Target Profit Floor  │
                        │  - Indicator Recovery Exit    │
                        │  - 15:15 IST Mandatory EOD    │
                        └───────────────────────────────┘
```

---

## 3. The 6 Core Rules in Detail

### Rule 1: Underlying Index Market Direction Gate
No trade is ever initiated based solely on the option's chart. The underlying index (NIFTY 50) dictates directional clearance:
- **BULLISH**:
  - `NIFTY Spot > Session VWAP` AND `EMA 9 > EMA 20`
  - *Action*: Only Put Options (`PE`) are eligible for shorting. Call shorting is strictly locked out.
- **BEARISH**:
  - `NIFTY Spot < Session VWAP` AND `EMA 9 < EMA 20`
  - *Action*: Only Call Options (`CE`) are eligible for shorting. Put shorting is strictly locked out.
- **SIDEWAYS / UNALIGNED**:
  - Spot and EMAs are conflicting or flat within neutral threshold.
  - *Action*: Strategy goes into **Standby**. No new positions are permitted.

### Rule 2: Fresh Breakdown on Closed Candles
To eliminate false intraday whipsaws and repainting errors:
1. **Completed Bars Only**: Signals are calculated only on completed closed bars (1m, 3m, or 5m). Real-time ticks during an open bar never trigger entries.
2. **Triple Confluence**:
   - `Close < Supertrend(10, 2)`
   - `Close < Session VWAP`
   - `Close < EMA 20`
3. **Freshness Requirement**:
   - `Current Bar` meets all 3 breakdown conditions.
   - `Previous Bar` did **NOT** meet all 3 conditions.
   - Prevents chasing options that broke down 30 minutes ago and are already overextended into support.
   - **Entry recency gate** (engine): a breakdown more than 3 closed bars old is never eligible (it still scores). After any exit the same contract is locked for 5 minutes, so a stop-out is not re-shorted while it stays below the indicators.

### Rule 3: Signal Ranking & Selection Engine
When multiple options break down during the same candle (e.g. 3 PEs break down at once), the engine ranks them on a 100-point scale:
- **Freshness Score (40 pts)**:
  - 40 pts if the breakdown occurred on the most recent completed bar.
  - Scaled down linearly if older.
- **Proximity to ATM (30 pts)**:
  - Highest points awarded to options between 1 to 3 strikes OTM/ATM ($0.30 - $0.50 delta range) where gamma is manageable and premium decay is brisk.
  - Deep OTM options (< ₹25) penalized due to unfavourable risk-to-reward ratio and high fixed transaction friction.
- **Liquidity & Depth (15 pts)**:
  - Traded volume and tight bid-ask spreads ensure immediate order execution with negligible slippage.
- **OI Buildup Confirmation (15 pts)**:
  - Bonus points awarded if Open Interest is expanding alongside falling premium (classic institutional short buildup).

### Rule 4: Portfolio Exposure Controls
- **Max Concurrent Positions**: Default **2 positions**.
- **Max Same-Side Positions**: Default **1 position**. If the strategy is already short 24500 PE, it will not open 24450 PE, preventing double exposure to a sudden index drop.
- **Contract Deduplication**: Active or recently exited strikes cannot be re-entered while a position in that strike remains open.

### Rule 5: Dynamic Lock & Trail Stop-Loss Engine
Option premium moves quickly during squeezes, but premature trailing before a trade develops causes unnecessary stop-outs. This engine uses a 2-stage Lock & Trail protection mechanism:
- **Phase 1 (Full Initial Breathing Room)**: The trade starts with a static Initial SL (`Entry Price × (1 + slPct / 100)`). The stop stays firmly at the initial SL until the position achieves the threshold profit `trailStartPct` (default 15% decay), preventing normal entry noise from triggering an early exit.
- **Phase 2 (Lock to Cost / Breakeven)**: Once option premium drops by $\ge \text{trailStartPct}$ (e.g. 15% profit), the stop-loss immediately locks to **cost (`entryPrice`)**, eliminating all principal downside risk.
- **Phase 3 (Step-and-Offset Trailing)**: For every additional `trailStepPts` ($x$ points) gain in option premium beyond the trigger threshold, the stop-loss ratchets down by `trailByPts` ($y$ points):
  $$\text{Extra Gain} = (\text{entryPrice} - \text{lowestPrice}) - (\text{entryPrice} \times \frac{\text{trailStartPct}}{100})$$
  $$\text{Steps} = \left\lfloor \frac{\text{Extra Gain}}{\text{trailStepPts}} \right\rfloor$$
  $$\text{Trailing SL} = \text{entryPrice} - (\text{Steps} \times \text{trailByPts})$$
- **Inviolable Invariant**: $\text{Trailing SL}$ can **only move downward**. It never increases or loosens.

### Rule 6: Exits & Circuit Breakers
1. **Scalp Profit Target**: (Optional, default 35% decay) Immediately books profit if premium collapses to target.
2. **Indicator Recovery Exit**: (Optional) Closes position if option price recovers back above its Supertrend or EMA 20.
3. **Mandatory EOD Square-Off**: Exactly at **15:15 IST**, all active positions are closed at market to prevent overnight gap risk.
4. **Daily Loss Circuit Breaker** (today's IST P&L in the active mode only; SIM never counts against REAL): If total realized + unrealized P&L drops below `-₹5,000` (configurable), the auto-trader immediately shuts down and locks out any further entries for the remainder of the session.

---

## 4. Operational Parameters & Presets

| Parameter | Default | Range | Description |
|---|---|---|---|
| `timeframe` | `5m` | `1m`, `3m`, `5m` | Candle interval for indicator calculation |
| `stPeriod` | `10` | `7` – `14` | Supertrend ATR lookback period |
| `stMultiplier` | `2.0` | `1.5` – `3.0` | Supertrend volatility multiplier |
| `emaPeriod` | `20` | `9` – `50` | Moving average period for option breakdown |
| `slPct` | `25%` | `10%` – `50%` | Initial Stop-Loss percentage above entry price |
| `trailStartPct` | `15%` | `5%` – `50%` | Profit threshold to lock SL to cost and begin trailing |
| `trailStepPts` | `5 pts` | `0.5` – `50 pts` | For every X points gain in option premium beyond trigger |
| `trailByPts` | `2 pts` | `0.5` – `50 pts` | Ratchet stop-loss down by Y points per step |
| `targetPct` | `35%` | `0%` – `80%` | Scalp Profit Target (0 = disabled, ride trail) |
| `maxPositions` | `2` | `1` – `5` | Maximum simultaneous open positions |
| `maxSameSide` | `1` | `1` – `3` | Maximum concurrent positions on CE or PE side |
| `lotsPerTrade` | `1` | `1` – `10` | Lots to short per trade |
| `dailyLossLimit`| `₹5,000` | `₹1,000` – `₹25,000` | Hard daily circuit breaker cutoff |
| `eodExit` | `15:15` | `15:00` – `15:20` | Mandatory intraday square-off time (IST) |
| `recoveryExit` | `true` | `true` / `false` | Close if premium reclaims Supertrend or EMA20 |

---

## 5. Execution Modes

- **SIM Mode (Paper Ledger)**:
  - Full simulated trade lifecycle tracked in `debug/breakdown_scalper_state.json`.
  - Realistic simulated fills, exact tick-by-tick trailing stops, zero capital risk.
  - Perfect for forward-testing live market hours.
- **REAL Mode (Broker Live Execution)**:
  - Real intraday short orders dispatched via `/api/scalper/fast-order` to Dhan / Kotak Neo.
  - Server-side fill confirmation and real-time order status tracking.
  - Requires user to explicitly switch toggle in settings drawer.

---

## 6. Testing & Validation Checklist

Before trading real capital on this strategy:
- [x] **Unit Testing**: Complete unit test coverage for breakdown evaluations, signal ranking, and trailing SL ratchet (`lib/breakdownScalper.test.ts`).
- [x] **Ledger Testing**: Atomic position mutations, P&L calculations, and duplicate prevention (`lib/breakdownLedger.test.ts`).
- [x] **Live Tick Bridge**: 1-minute live accumulator merging intraday candles without gaps (`liveMinRef`).
- [x] **Circuit Breaker Verification**: Ensure engine stops automatically on `-₹5,000` daily loss.
- [x] **EOD Exit Verification**: Ensure all open positions auto-exit at 15:15 IST.


---

## 5. Live-order behaviour (REAL mode)

- **Brokers**: Dhan (security id, `NSE_FNO`/`BSE_FNO`, INTRADAY) and Kotak (trading symbol, `nse_fo`/`bse_fo`, MIS). NIFTY, BANKNIFTY, SENSEX. Zerodha is SIM-only here.
- **One exit per position, across tabs and reloads**: each position's exit state (sending / accepted / unknown) lives in browser storage shared by every tab. A rejected exit retries after 15 s; a ledger-close failure retries only the ledger, never the order.
- **Unknown-status exit**: never resent automatically (a resend after fast-order's 60 s idempotency window would book a second BUY; Kotak has no key). The engine halts and the row is excluded from auto-management until the user presses Close and confirms from the order book that it filled (ledger-only close) or did not (one new exit).
- **Chain pin**: stops are evaluated only from the chain on screen, so the underlying/expiry selectors lock while today's positions are open and a reload jumps to their chain. A position on another chain is shown in a red banner as unwatched.
- **Daily loss limit** prices every open row of the active mode (last seen price when off-screen); a row with no price pauses entries.
- **Unknown or unrecorded entry** halts the engine; 3 rejected auto entries in a row also halt it.
- **Engine runs in the browser tab only**; stops are software-only (no resting broker stop). One tab at a time acts (tab lock); keep it open and visible.
- Entry/exit prices in the ledger are the LTP at the decision, not the broker fill.

---

## 6. Daily backtest (page panel "Strategy backtest · NIFTY")

- **Engine**: `rs_dashboard/lib/breakdownBacktest.ts` `simulateDay` replays a session minute by minute through the live
  engine's own functions (`evaluateOptionBreakdown`, `evaluateUnderlyingTrend`, `rankBreakdownSignals`,
  `evaluatePositionRisk`) with the page's current rules (ledger config snapshot, stored with the results).
- **Fills**: signals on bars closed before minute m; entry at bar m's open; stops/targets/recovery inside each bar in
  the order open → high → low → close (adverse first, recovery on every point as the live tick check does); every fill
  lies on the price segment the trigger happened on (a level crossed intrabar fills at the level, a stop ratcheted below
  the price fills at the price, a gap at the open fills at the open); EOD at the open of the cutoff bar. Costs per F&O
  order (`DHAN_OPTION_COSTS`, brokerage from the rules). Rules setting `slippagePts` (default 0) is lost on every fill.
- **Slots**: a position closed inside bar m still holds its slot (and its P&L counts as open for the loss limit) for
  entries at bar m's open; the slot frees from bar m+1. Before 2026-10-18 it was reused at bar m's own open, a
  look-ahead that inflated the 6-month run from ₹1.83 L to ₹2.49 L.
- **Audit**: the runner re-checks every stored trade against the rules and the bar files (`auditResults`) and stores it
  as `results.json` `audit`; the page's audit card renders only that.
- **Warm-up**: the previous session is enough to settle the indicators from 09:15 (`WARMUP_SESSIONS_NEEDED = 1`; the
  data file carries up to 2). The options DB holds a weekly contract only from the day after the previous expiry, so
  Wednesday sessions start with no previous session and their early-session indicators differ from live; every
  other day is fully warmed. The DB also stores only ATM±10 strikes per minute, so a strike far from the previous
  day's spot can have no warm-up bars either. Each trade records `warmupBars`; the audit counts "cold-contract
  entries" (< EMA period × timeframe bars). In the 2026-04-16 → 10-13 run these were 179 of 807 trades and ~90% of
  the net; the warm subset (628 trades) netted ₹12.4k. Read the cold share before trusting a result.
- **Trend**: the options DB's 1-minute spot closes; VWAP = running mean (the live feed also falls back to it, the index
  has no volume); EMA9/20 = `ewm(adjust=False)` on today's timeframe closes, as `cyber_scalper_feed.py`.
- **Data** (`scripts/tools/breakdown_backtest_data.py`, cached per session under `debug/breakdown_backtest/`): runs are
  offline, from `Options Data/nifty_options.db` only (the runner passes `--offline`; a session not in the DB fails). The
  script's expired-options / intraday API paths below are currently unused.
  Every session carries the 2 previous sessions of the same contracts, so indicators are warm from 09:15; sessions on or
  before the previous weekly expiry come from the expired API with `expiry_code=2`. The expired API is slow (~25-60 s a
  call, one at a time to stay inside the account-wide DH-904 limit): a cold expiry week takes 20-40 minutes, once.
- **Runs**: `rs_dashboard/scripts/breakdown-backtest.ts` (detached, one at a time). Opening the page after 15:35 IST
  appends any missing sessions (catch-up); Run now / Re-run (1 week or 1 month) in the panel. A rules change pauses
  appends until a Re-run, so every stored day used the same rules. NIFTY only (the options DB has no other index).

### Backtest data source (Rules drawer → "Backtest Data Source")
`config.dataSource` = `dhan` (default, `Options Data/nifty_options.db`) or `breeze` (`Options Data/breeze_nifty_options.db`, ICICI Breeze,
ATM±20 strikes, 14 days per Tuesday expiry). Each source keeps its own store (`results.json` / `results.breeze.json`) and per-day cache
(`data/` / `data/breeze/`); switching source changes the config key, so use Re-run. Breeze caveats: bars exist only for minutes with a
trade (~330 of 375 per contract), `spot` is sparse (the data script forward-fills it, else derives it from put-call parity), `iv` /
`strike_relative` are NULL, and there is no Dhan warm-up cache, so the first session of a contract uses what the DB holds. Fills and
stops can therefore differ from the Dhan DB; do not compare the two sources day by day as if they were the same tape.
