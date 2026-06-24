# Dhan Algo Trading — Strategies Documentation

This folder contains the core algorithmic trading strategies implemented under the DhanHQ API framework. The codebase leverages custom mathematical models, technical indicators, and dynamic risk management to execute options trading in both straddles, strangles, and vertical spreads.

---

## 📁 Directory Structure & Strategy Paths
For general project setup, SDK usage, and credentials setup, refer to the [Root README](file:///c:/dhan_algo/dhan_algo/README.md).

```
strategies/
├── value_imbalance/
│   ├── nifty_advanced_imbalance.py      # Core value-imbalance strategy with 4 selectable modes
│   ├── nifty_value_imbalance_straddle.py # LegacyStraddle with lot additions
│   ├── nifty_value_imbalance_strangle.py # LegacyStrangle with target strike adjustments
│   └── strategy.md                      # Detailed guide to Value-Imbalance strategies
│
├── spread_trend/
│   └── nifty_spread_trend.py            # Trend-following vertical spreads (Supertrend + EMA20)
│
├── expiry/
│   ├── nifty_expiry.py                  # 0DTE Expiry-day option selling with post-SL rebalancing
│   └── strategy.md                      # Detailed walkthrough of the Expiry strategy
│
└── Archives/
    └── nifty_short_straddle.py          # Archived basic straddle strategy
```

---

## ⚙️ Global Risk Management & Rules
Every strategy in this repository adheres to strict risk controls:
*   **Intraday Auto-Exit**: Hardcoded or configurable square-offs between **15:15 and 15:17 IST** to avoid broker auto-square-off charges.
*   **Global Profit Target & Stop Loss**: Monitored on a sub-second basis. Once breached, the strategy exits all legs and pauses operations for the day.
*   **Martingale Caps**: Position additions are strictly capped (default: `max_lots = 4` per leg).
*   **WebSocket Priority**: The helper's live WebSocket data feed is used to fetch LTPs instantly, bypassing REST API rate limits (120–250 calls/min).

---

## 1. Nifty Value-Imbalance Strategies (`strategies/value_imbalance/`)

These strategies execute straddles or strangles and dynamically rebalance them under market trends using four selectable adjustment modes, target OTM strike shifts, or lot additions.

For detailed mechanics, mathematical formulas, CLI parameter reference tables, step-by-step walkthroughs, and detailed trade flow examples, refer to the [Value-Imbalance Strategy Guide](file:///c:/dhan_algo/dhan_algo/strategies/value_imbalance/strategy.md).

### Quick Commands

*   **Advanced Straddle (Default Winner Roll, 1 lot dry run)**:
    ```powershell
    python strategies/value_imbalance/nifty_advanced_imbalance.py --mode winner_roll_atm
    ```
*   **Advanced Strangle (Distance, OTM Loser Ratio Roll with 2-lot increments)**:
    ```powershell
    python strategies/value_imbalance/nifty_advanced_imbalance.py --entry-type strangle --mode loser_ratio_roll --loser-ratio-lots 2
    ```
*   **Legacy Straddle (Lot Addition dry run)**:
    ```powershell
    python strategies/value_imbalance/nifty_value_imbalance_straddle.py
    ```
*   **Legacy Strangle (Premium-based entry <= Rs. 40 dry run)**:
    ```powershell
    python strategies/value_imbalance/nifty_value_imbalance_strangle.py --premium --target-premium 40.0
    ```

---

## 2. Nifty Expiry (0DTE) Strategy (`nifty_expiry.py`)

This strategy is optimized for expiry day trading. It monitors decay on both legs and applies individual stop losses with optional post-SL rebalancing.

> [!NOTE]
> For a deep-dive explanation of the execution mechanics, numerical calculations, and rebalancing flow, refer to the [Expiry Strategy Guide](file:///c:/dhan_algo/dhan_algo/strategies/expiry/strategy.md).

### Quick Commands
*   **Dry run with post-SL rebalancing**:
    ```powershell
    python strategies/expiry/nifty_expiry.py --adjustment winner_addition --post-sl-balance
    ```
*   **Live strangle entry using premium targets**:
    ```powershell
    python strategies/expiry/nifty_expiry.py --live --lots 1 --entry-type strangle --premium --target-premium 50.0 --adjustment winner_addition --post-sl-balance
    ```

---

## 3. Nifty Spread Trend-Following Strategy (`nifty_spread_trend.py`)

A trend-following options selling strategy that sells Bear Call Spreads or Bull Put Spreads depending on the alignment of the price relative to the **EMA 20** and the **Supertrend (7, 3)** indicators.

### A. Trend Definition

```
        Close > EMA 20  AND  Supertrend = Bullish (1)
                        │
                        ▼ Yes
              [BULLISH TREND SIGNAL]
            Sell Put Vertical Spread
                        │
                        ▼ No
        Close < EMA 20  AND  Supertrend = Bearish (-1)
                        │
                        ▼ Yes
             [BEARISH TREND SIGNAL]
            Sell Call Vertical Spread
```

### B. Execution Security & Margin efficiency
*   **On Entry**: Buys the Long hedge leg first, confirms execution fill, then sells the Short option. This locks in the margin benefit immediately and prevents high naked margin requirements.
*   **On Exit**: Buys back the Short option first, confirms execution fill, then sells the Long hedge.

### C. CLI Parameters

| CLI Flag | Default | Description |
| :--- | :--- | :--- |
| **`--live`** | *Flag* | Run in live order placement mode. |
| **`--symbol`** | `NIFTY` | Underlying index to trade (`NIFTY`, `BANKNIFTY`). |
| **`--interval`** | `5` | Timeframe interval in minutes (`1`, `5`, `15`, `30`, `60`). |
| **`--spread-width`** | `100` | Width of the vertical spread in points (Short strike to Long strike). |
| **`--lots N`** | `1` | Number of lots per spread leg. |
| **`--target-profit AMT`** | `2000.0` | Global daily profit target in INR. |
| **`--stop-loss AMT`** | `2000.0` | Global daily stop loss in INR. |
| **`--no-exit-on-signal-change`** | *Flag* | Disables early exits on trend reversals (holds to SL/Target/EOD). |
| **`--cooldown-minutes N`** | `5` | Cooldown period in minutes post standard exits. |

### D. Execution Examples
```powershell
# 1. Standard dry run (Nifty, 5-minute, 1 lot)
python strategies/spread_trend/nifty_spread_trend.py

# 2. Custom parameters dry run (Nifty, 15-minute, wider offsets, 2 lots)
python strategies/spread_trend/nifty_spread_trend.py --interval 15 --ce-offset 150 --pe-offset 150 --spread-width 100 --lots 2

# 3. Bank Nifty dry run
python strategies/spread_trend/nifty_spread_trend.py --symbol BANKNIFTY --ce-offset 200 --pe-offset 200 --spread-width 100

# 4. Live execution with daily profit target and stop loss limit
python strategies/spread_trend/nifty_spread_trend.py --live --lots 1 --target-profit 4000 --stop-loss 2000
```
