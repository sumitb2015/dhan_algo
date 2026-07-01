# Futures Dashboard — Design Spec

**Date:** 2026-07-01  
**Status:** Approved

---

## Overview

A new `/futures` page in the Next.js dashboard (`rs_dashboard/`) showing a quick-glance stats dashboard for NIFTY and BANKNIFTY futures contracts. Data is sourced from pre-downloaded 1-minute CSV files. No live API calls at page render time.

---

## 1. Data Layer

### File: `scripts/downloader/download_futures_manual.py`

**Change:** The script conditionally writes an OI column only when the Dhan intraday API returns `open_interest`. Update it to always write an OI column, zero-filling rows where the API didn't return OI data.

**Output CSV columns (after change):**
```
Datetime, Open, High, Low, Close, Volume, OI, Contract
```

- `Contract` column holds the expiry date string (e.g., `"2026-07-28"`)
- `OI` is an integer (or 0 when unavailable)
- Existing file paths unchanged:
  - `Historical Data/NIFTY_Futures_1min_Manual.csv`
  - `Historical Data/BANKNIFTY_Futures_1min_Manual.csv`

**Usage:** User re-runs the script after this change to get OI-enriched CSVs. The page degrades gracefully if OI column is absent (shows `—`).

---

## 2. API Route

### File: `rs_dashboard/app/api/futures/route.ts`

**Method:** `GET`

**Data sources read:**
- `../Historical Data/NIFTY_Futures_1min_Manual.csv`
- `../Historical Data/BANKNIFTY_Futures_1min_Manual.csv`
- `../Historical Data/NIFTY_50_Daily_5Y.csv` (for NIFTY spot price / basis)

**Processing per instrument:**

1. Parse CSV, parse `Datetime` as local time, parse `OI` as number (default 0 if column absent)
2. Group rows by `Contract` (expiry date string), sort contracts ascending by expiry date → near/mid/far
3. For each contract:
   - **Latest date**: the most recent date present in that contract's rows
   - **Today's candles**: rows where date == latest date
   - **OHLC**: open = first candle's Open, high = max High, low = min Low, close = last candle's Close
   - **Volume**: sum of today's Volume (cumulative)
   - **Latest OI**: last row's OI
   - **Previous session OI**: last OI value from rows on the day before latest date
   - **OI change**: latest OI − previous session OI
   - **Days to expiry**: `parseDate(contract) − today` in calendar days
   - **Sparkline data**: `{ time: "HH:MM", oi: number }[]` for all today's candles
4. **NIFTY basis**: latest futures close − latest close from `NIFTY_50_Daily_5Y.csv`
5. **BANKNIFTY basis**: `null` (no spot index CSV available; shown as `—` in UI)
6. **dataDate**: the most recent latest date across all contracts and instruments

**Response type:**
```ts
interface ContractStats {
  expiry: string;          // "2026-07-28"
  label: string;           // "Jul 28"
  daysToExpiry: number;
  price: number;           // latest close
  open: number;
  high: number;
  low: number;
  volume: number;
  oi: number;
  oiChange: number;
  oiHasData: boolean;      // false if OI column missing or all zeros
  basis: number | null;
  sparkline: { time: string; oi: number }[];
}

interface FuturesResponse {
  success: boolean;
  dataDate: string;        // "YYYY-MM-DD"
  instruments: {
    NIFTY: ContractStats[];      // [near, mid, far] sorted by expiry
    BANKNIFTY: ContractStats[];
  };
  error?: string;
}
```

**Caching:** No server-side cache (CSVs are re-downloaded manually, so stale cache is not a risk). Each request reads from disk.

---

## 3. Frontend Component

### Files:
- `rs_dashboard/app/futures/page.tsx` — thin wrapper, sets `metadata.title = 'Futures Monitor'`
- `rs_dashboard/components/FuturesDashboard.tsx` — full client component (`'use client'`)

### Layout

**Header (sticky):**
- Icon (activity/chart icon from lucide) + "Futures Monitor" title
- `DATA: YYYY-MM-DD` chip (zinc-800 pill, updated from API response)
- NavBar
- Refresh button (re-fetches from API)

**Body:**
- Two cards side by side on wide screens, stacked on narrow screens
  - Left: NIFTY
  - Right: BANKNIFTY

**Each card contains:**

1. **Contract tabs** — pill-style selector at the card top:
   - Labels: "Jul 28 · Near", "Aug 28 · Mid", "Sep 25 · Far" (or however many contracts exist, up to 3)
   - Active contract's stats shown below

2. **Stats grid** (2-column grid inside card):

   | Stat | Notes |
   |------|-------|
   | Price | Large, prominent, white |
   | Open | Today's first 1-min open |
   | High | Today's session high |
   | Low | Today's session low |
   | Volume | Cumulative today, formatted as `1.2L` / `12.5K` |
   | OI | Latest, formatted as `45.2L` |
   | OI Change | vs previous session close; green if positive, red if negative |
   | Basis | Futures − Spot; `—` for BANKNIFTY |
   | Days to Expiry | Integer, highlighted red if ≤ 5 |
   | Expiry Date | Raw date string |

3. **OI Sparkline** — SVG line chart, full card width, ~80px tall:
   - X axis: time (09:15 → 15:30)
   - Y axis: OI value, auto-scaled to min/max of today's data
   - Single line, sky-blue color
   - If `oiHasData` is false: show a muted "OI not available — re-run download script" message instead

### NavBar

Add `{ href: '/futures', label: 'Futures' }` to `NAV_LINKS` in `rs_dashboard/components/NavBar.tsx`, positioned between `Diffusion` and `Distribution`.

---

## 4. Error & Edge Cases

| Scenario | Behavior |
|----------|----------|
| CSV file missing | API returns `success: false`, page shows error state |
| OI column absent in CSV | `oiHasData: false`; OI cells show `—`, sparkline shows notice |
| Contract data for today absent | Stats computed from most recent available date; DATA chip reflects actual date |
| Only 1 or 2 contracts in master list | Tabs show only available contracts (no "Far" tab if only near+mid) |
| BANKNIFTY basis | Always `null` / `—`; no error |

---

## 5. Files Changed / Created

| File | Action |
|------|--------|
| `scripts/downloader/download_futures_manual.py` | Edit — always write OI column (zero-fill) |
| `rs_dashboard/app/api/futures/route.ts` | Create |
| `rs_dashboard/app/futures/page.tsx` | Create |
| `rs_dashboard/components/FuturesDashboard.tsx` | Create |
| `rs_dashboard/components/NavBar.tsx` | Edit — add Futures link |
