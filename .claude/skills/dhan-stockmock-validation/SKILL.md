---
name: dhan-stockmock-validation
description: Specialized skill for ultra-fast StockMock API backtesting and side-by-side validation against our local Dhan Algo Backtesting Engine (`scripts/analysis/backtest_short_straddle.py`). Bypasses browser automation, utilizes direct curl_cffi HTTP execution with user credentials, automatically encodes complex multi-leg strategy payloads (ATM, Closest Premium, Wait & Trade, TRB, Lock & Trail), and produces discrepancy diagnostics.
---

# StockMock Fast API Backtesting & Engine Validation Skill

This skill provides direct, programmatic execution of option backtests against **StockMock** (`stockmock.in`) and automatic side-by-side verification against the repository's local Dhan Options Backtest Engine (`scripts/analysis/backtest_short_straddle.py`).

---

## 1. Authentication & API Flow Architecture

The platform uses a direct REST API bridge without running heavy headless browsers or getting trapped in Cloudflare browser challenges:

1. **Authentication Endpoint**: `POST https://www.stockmock.in/api/login`
   - **Credentials**: `STOCKMOCK_PHONE` / `STOCKMOCK_PASSWORD` in `.env.stockmock` at the repo root
     (git-ignored; copy `.env.stockmock.example`). Never write them into this file.
   - **Engine**: Executed via Python's `curl_cffi` using `impersonate="chrome120"` to bypass Cloudflare TLS fingerprinting.
   - **Token Persistence**: JWT session token cached in `debug/stockmock_token.json` (valid for 24h).
2. **Backtesting Endpoint**: `POST https://www.stockmock.in/api/startBacktesting`
   - **Headers**:
     - `Content-Type: application/json`
     - `token: <JWT_TOKEN>`
     - `feversion: 2`
   - **Cookies**: `_rdl34hcrd=<JWT_TOKEN>`, `sm_token=<JWT_TOKEN>`
   - **Speed**: Sub-second round-trip time per backtest simulation.

---

## 2. Fast CLI Runner (`stockmock_client.py`)

The skill ships an optimized CLI client located at:
`[stockmock_client.py](file:///.claude/skills/dhan-stockmock-validation/scripts/stockmock_client.py)`

### Standard Commands

#### 1. Quick ATM Straddle Backtest (Print P&L Table)
```bash
venv/bin/python .claude/skills/dhan-stockmock-validation/scripts/stockmock_client.py \
  --strategy straddle \
  --start-date 2026-09-01 \
  --end-date 2026-09-10 \
  --entry-time 09:22 \
  --exit-time 15:15
```

#### 2. Validate Side-by-Side Against Local Dhan Engine
```bash
venv/bin/python .claude/skills/dhan-stockmock-validation/scripts/stockmock_client.py \
  --strategy straddle \
  --start-date 2026-09-01 \
  --end-date 2026-09-10 \
  --entry-time 09:22 \
  --exit-time 15:15 \
  --validate
```

#### 3. Closest Premium (CP) with Time Range Breakout (TRB) & MTM Stop Loss
```bash
venv/bin/python .claude/skills/dhan-stockmock-validation/scripts/stockmock_client.py \
  --strategy cp \
  --cp-val 35 \
  --trb-time 09:45 \
  --start-date 2026-09-01 \
  --end-date 2026-09-10 \
  --mtm-sl 2000 \
  --mtm-tp 2000 \
  --validate
```

#### 4. Raw JSON Output for Scripting / Pipelines
```bash
venv/bin/python .claude/skills/dhan-stockmock-validation/scripts/stockmock_client.py \
  --strategy straddle \
  --start-date 2026-09-04 \
  --end-date 2026-09-04 \
  --json
```

---

> **Rate when validating (2026-10-05):** the local engine now prices through `lib/options_pricing.py` (6.5%). The runs it was validated against StockMock with used 6%, so validate with `backtest_short_straddle.py --rate 0.06` to reproduce them; the rate only matters for delta-selected legs (an ATM straddle is identical at either rate; a 25-delta strangle moved ₹103,144 -> ₹102,435 over 2025-01..2026-06). A re-validation at the library rate has NOT been run (it needs the user's StockMock login).

## 3. StockMock Serialization Reference & Quirks

When constructing custom payloads for StockMock, note these reverse-engineered rules:

### 3.1 NIFTY Lot Size Normalization
StockMock's internal base divider for NIFTY is **75** (`lots = qty / 75`).
- To test **1 lot** of NIFTY in StockMock's API, the quantity in the leg string must be `75`.
- StockMock then applies the historical contract's actual lot size (e.g. 65 in Sept 2026, 50 in 2024).
- Passing `65` raw will cause StockMock to evaluate `65 / 75 = 0.866 lots`!
- The helper `build_leg_string()` in `stockmock_client.py` handles this automatically.

### 3.2 Legs String Schema (`Q(e)`)
Each leg is formatted as:
```
<Index>_<LegID>::<Rule>_<Side>_<Type>_<Qty>::<SL>::<TP>::<Expiry>::<TrailingSL>::<WaitTrade>::<EntryType>::<TRB>::null::<StraddleRatio>::<ReEntrySL>::<ReEntryTP>::<Journey>::<Depth>::<Hedge>
```
- **ATM Straddle Leg**: `N_L1::0_S_CE_75::null::null::CW::null::null::atm::null::null::null::null::null::null::null::null`
- **Closest Premium <= 35**: `N_L1::CP35;cl_S_CE_75::null::null::CW::null::null::cp::null::null::null::null::null::null::null::null`
- **Wait & Trade 10%**: `N_L1::0_S_CE_75::null::null::CW::null::WP_10::atm::null::null::null::null::null::null::null::null`
- **Range Breakout (09:45)**: `N_L1::CP35;cl_S_CE_75::null::null::CW::null::null::cp::Lo_09:45:00::null::null::null::null::null::null::null`

### 3.3 Top-Level Request Payload
```json
{
  "positions": "<comma_separated_legs>",
  "entryExitTime": "09:22:00,15:15:00",
  "noReEntryAfter": null,
  "strategy": "intraday",
  "entryExitDays": "0,0",
  "useFutureAsBasePrice": false,
  "fromDate": "2026-09-01",
  "toDate": "2026-09-11",
  "isCTC": false,
  "maxReEntryValue": 0,
  "stopEntireTradeAndReRunCount": 0,
  "isExtendedWeek": false,
  "isMidExpiryExit": false,
  "midExpiryExitDTE": 0,
  "isMultiDayWaitEntry": false,
  "stopEntireTrade": false,
  "href": "https://www.stockmock.in/#!/home/share?p=...&et=09:22:00,15:15:00&s=intraday&ed=0,0"
}
```
*Note*: `href` is mandatory. The backend validates the encoded URL hash against the payload.

---

## 4. Verification & Discrepancy Diagnostics

When comparing StockMock P&L against the Dhan Algo backtest engine:

1. **Gross vs Net**:
   - StockMock P&L is **Gross** (zero STT, zero GST, zero exchange turnover fees).
   - In our engine, pass `--commission-per-lot 0 --slippage-pct 0.0` for true apple-to-apple comparison.
2. **Slippages**:
   - StockMock has user profile setting `slippages: 0.5` by default.
   - To match StockMock's slipped numbers, pass `--slippage-pct 0.5` to our engine.
3. **Bar Snapshot Differences**:
   - StockMock captures tick snapshots at minute boundaries from synthetic broker streams.
   - Our Dhan local SQLite database stores cleared exchange 1-minute OHLC bars.
   - Normal expected difference is typically ₹10 to ₹50 per cycle (< 2%).
