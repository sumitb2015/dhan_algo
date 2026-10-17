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

### Rule 5: Dynamic Trailing Stop-Loss Engine
Option premium moves quickly during squeezes. A static stop is insufficient:
- **Initial Stop-Loss**: Fixed percentage above entry price (e.g. `Entry Price + 30%`).
- **Lowest Price Tracking**: The algorithm tracks `lowestPrice = min(lowestPrice, currentLtp)` continuously.
- **Dynamic Ratchet Trailing SL**:
  $$\text{Trailing SL} = \text{lowestPrice} \times \left(1 + \frac{\text{trailPct}}{100}\right)$$
  - As the option premium drops from ₹100 $\rightarrow$ ₹80 $\rightarrow$ ₹60, the stop-loss ratchets down:
    - Entry ₹100: Initial SL = ₹130, Trail SL = ₹120
    - Price drops to ₹80: Trail SL ratchets down to $80 \times 1.20 = \text{₹96}$ (locking in profit!)
    - Price drops to ₹60: Trail SL ratchets down to $60 \times 1.20 = \text{₹72}$
  - **Inviolable Invariant**: $\text{Trailing SL}$ can **only move downward**. It never increases or loosens.

### Rule 6: Exits & Circuit Breakers
1. **Scalp Profit Target**: (Optional, default 50% decay) Immediately books profit if premium collapses to target.
2. **Indicator Recovery Exit**: (Optional) Closes position if option price recovers back above its Supertrend or EMA 20.
3. **Mandatory EOD Square-Off**: Exactly at **15:15 IST**, all active positions are closed at market to prevent overnight gap risk.
4. **Daily Loss Circuit Breaker**: If total realized + unrealized P&L drops below `-₹5,000` (configurable), the auto-trader immediately shuts down and locks out any further entries for the remainder of the session.

---

## 4. Operational Parameters & Presets

| Parameter | Default | Range | Description |
|---|---|---|---|
| `timeframe` | `5m` | `1m`, `3m`, `5m` | Candle interval for indicator calculation |
| `stPeriod` | `10` | `7` – `14` | Supertrend ATR lookback period |
| `stMultiplier` | `2.0` | `1.5` – `3.0` | Supertrend volatility multiplier |
| `emaPeriod` | `20` | `9` – `50` | Moving average period for option breakdown |
| `slPct` | `30%` | `15%` – `50%` | Initial Stop-Loss percentage above entry price |
| `trailPct` | `20%` | `10%` – `30%` | Trailing Stop-Loss percentage above lowest price |
| `targetPct` | `50%` | `0%` – `80%` | Scalp Profit Target (0 = disabled, ride trail) |
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
