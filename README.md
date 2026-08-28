# Dhan Algo Trading & Quantitative Dashboard

A high-performance algorithmic trading library and quantitative research platform wrapping the **DhanHQ**, **Zerodha Kite Connect**, and **Kotak Neo** broker APIs for live F&O strategy execution, accompanied by a real-time **Next.js 16 (App Router)** analytics dashboard.

---

## 🌟 Key Capabilities

- **Multi-Broker Live Execution**: Integrated execution across DhanHQ, Zerodha Kite, and Kotak Neo with automated copy-trading and unified position tracking.
- **Automated F&O Strategy Engine**: Production-ready strategies for NIFTY, BANKNIFTY, SENSEX, and MCX CRUDEOILM with dynamic strike adjustments, scalp locks, multi-cycle management, and emergency inversion guards.
- **Next.js Quantitative Terminal (`rs_dashboard/`)**:
  - **Live Scalper & Advanced Scalper**: Real-time Greeks, order tickets, multi-leg execution, and instant square-off.
  - **Options Analytics**: IV history, options premium bar, straddle/strangle matrix, open interest profiles, and volume footprints.
  - **Relative Strength & Market Breadth**: Nifty 50/500 RS screeners, RRG charts, sector breadth, and diffusion indices.
  - **Portfolio & Trader's Diary**: Real-time MTM tracking, FIFO trade matching, charges breakdown, and interactive equity curves.
- **Fast Security Master Cache**: 288K+ cached instruments with $O(1)$ in-memory lookups for equity, indices, futures, and option contracts.
- **WebSocket Streaming**: High-throughput live tick streaming bridges for equity, options, indices, and order fill events.

---

## 📁 Repository Structure

```
dhan_algo/
├── lib/                             # Core Python libraries
│   ├── dhan_helper.py               # Central DhanHQ abstraction & market feed engine
│   ├── execution_broker.py          # Unified Multi-Broker interface (Dhan / Zerodha / Kotak)
│   ├── strategy_risk.py             # Safe multi-instance exit sizing & risk guards
│   ├── strategy_state_helper.py     # Strategy lifecycle state bridge (JSON + IPC triggers)
│   ├── zerodha/                     # Kite Connect session & margin calculations
│   └── kotak/                       # Kotak Neo session (TOTP + MPIN) & order routing
│
├── strategies/                      # Algorithmic Trading Strategies
│   ├── value_imbalance/             # Advanced Imbalance, Straddles, Strangles, VWAP & Delta Neutral
│   ├── spread_trend/                # Trend-following Credit Spreads (EMA20 + Supertrend)
│   ├── st_oi_bearcall/              # Dual Supertrend + OI Short-Buildup Bear Call Spread
│   ├── oi_directional/              # OI imbalance + PCR-driven directional option selling
│   ├── crudeoil/                    # MCX CRUDEOILM (Supertrend trailing, Renko SAR, VWAP+ST, ORB)
│   ├── intraday_equity/             # Nifty-50 cash VWAP+RS automated trader
│   └── momentum_investing/          # Nifty-500 multi-day composite RS momentum portfolio
│
├── rs_dashboard/                    # Next.js 16 Quantitative Dashboard
│   ├── app/                         # App router pages & 45+ API routes
│   ├── components/                  # Dark/light themed quant components (Recharts, Lightweight Charts)
│   └── lib/                         # Client caches, token managers, broker position transformers
│
├── scripts/                         # Tools & Data Pipeline
│   ├── downloader/                  # Historical EOD & intraday data downloaders
│   ├── analysis/                    # Backtests, screeners, reports, and tearsheets
│   ├── data_utils/                  # Parquet converter, resampling, and indicator append
│   └── tools/                       # WebSocket bridges, CSP scanners, and copy-trade bridges
│
├── tests/                           # Unit, parity, and integration test suite
├── login.py                         # DhanHQ OAuth login & token caching
├── master_list.csv                  # Cached 288K+ security master dataset
├── requirements.txt                 # Python dependencies
└── .env                             # API credentials (gitignored)
```

---

## 🚀 Getting Started

### 1. Prerequisites
- **Python**: `3.10` - `3.12`
- **Node.js**: `>= 20.x`
- **Package Managers**: `uv` or `pip`, `npm`

---

### 2. Python Environment Setup

```bash
# Clone the repository
git clone git@github.com:sumitb2015/dhan_algo.git
cd dhan_algo

# Create and activate virtual environment using uv (recommended) or python venv:
uv venv --python 3.12 venv
source venv/bin/activate    # On Windows: .\venv\Scripts\activate

# Install dependencies
uv pip install -r requirements.txt
uv pip install --no-deps openstatz==0.4.1
uv pip install --no-deps "git+https://github.com/Kotak-Neo/Kotak-neo-api-v2.git@539b6022c2c5fe138d6d0a893bbe554cacca10b6"
```

---

### 3. Dashboard Setup (`rs_dashboard`)

```bash
cd rs_dashboard
npm install
npm run dev   # Dashboard accessible at http://localhost:3000
```

---

### 4. Configuration (`.env`)

Create `.env` at the project root with your DhanHQ API credentials:

```env
client_id=YOUR_DHAN_CLIENT_ID
api_key=YOUR_DHAN_API_KEY
api_secret=YOUR_DHAN_API_SECRET
```

*(Optional: Create `.env.zerodha` and `.env.kotak` if using multi-broker features or copy-trading.)*

Authenticate your Dhan session (access tokens are valid for ~24 hours):
```bash
python login.py
```

---

## 📈 Running Strategies

All strategies support both **Dry Run** (simulated orders) and **Live Trading** (`--live`):

```bash
# 1. Advanced Value Imbalance Strangle (Winner Roll ATM mode)
python strategies/value_imbalance/nifty_advanced_imbalance.py --entry-type strangle --mode winner_roll_atm

# 2. Spread Trend Bear Call / Bull Put Credit Spread (Live with 1 lot)
python strategies/spread_trend/nifty_spread_trend.py --live --lots 1

# 3. Dual Supertrend + OI Bear Call
python strategies/st_oi_bearcall/nifty_st_oi_bearcall.py --lots 2

# 4. Crude Oil MCX Futures (VWAP + Supertrend Trailing)
python strategies/crudeoil/crudeoilm_vwap_supertrend.py --live --lots 1

# 5. Multi-Day Momentum Investing Portfolio Rebalance
python strategies/momentum_investing/nifty500_momentum.py --once
```

---

## 📊 Live WebSocket Bridges & Background Daemons

Run market tick bridges to stream high-frequency data into shared memory/disk for the dashboard:

```bash
# Stream Nifty 50 cash equity ticks
python scripts/tools/live_equity_ws.py

# Stream F&O option ticks
python scripts/tools/live_options_ws.py

# Multi-broker Copy Trade Bridge
python scripts/tools/copy_trade_bridge.py
```

---

## 🧪 Running Tests

```bash
# Run pure unit & logic test suites (safe to run anytime)
pytest tests/test_strategy_risk.py tests/test_pivots.py tests/test_intraday_signals.py
pytest tests/test_orb_logic.py tests/test_copy_trade_kotak_rejection.py tests/test_crudeoil_vwap_st_logic.py

# Run dashboard TypeScript tests
cd rs_dashboard && npm test
```

---

## 🛡️ Risk Management & Architecture Principles

- **Safe Exit Sizing (`lib/strategy_risk.py`)**: Sizing logic avoids relying on raw broker net positions to prevent multi-instance conflicts on shared strikes.
- **Inversion Guard**: Strangle strategies strictly validate `CE strike > PE strike`; crossing triggers an emergency square-off and a fresh cycle reset.
- **IPC State Bridge**: Strategies save runtime metrics to `debug/<strategy>_state.json` every cycle; the dashboard coordinates graceful stops via `debug/<strategy>_shutdown.trigger`.
- **Intraday Auto-Square-Off**: Hardcoded auto-exit at **15:17 IST** across all intraday strategies.

---

## 📄 License & Disclaimer

This project is for educational, research, and personal algorithmic trading purposes. Algorithmic and derivative trading involves significant financial risk. Validate all strategies in simulated/dry-run mode before deploying real capital.
