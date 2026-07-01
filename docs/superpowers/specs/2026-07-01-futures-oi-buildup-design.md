# Futures OI Buildup Dashboard — Design Spec

**Date:** 2026-07-01  
**Feature:** Stock Futures OI Buildup subpage within the existing `/futures` page

---

## Goal

Add an "OI Buildup" tab to the existing Futures page (`/futures`) that shows all ~209 F&O stocks classified into four categories based on day-over-day price and OI change: Long Buildup, Short Buildup, Short Covering, and Long Unwinding. Displayed as a 2×2 grid of sortable tables, inspired by standard F&O OI analysis dashboards.

## Architecture

Data flows in three stages:

1. **Download** — user clicks "Download Data" on the Futures page; `download_futures_manual.py` fetches FUTSTK daily OI data for all ~209 near-month stock futures contracts and writes `Historical Data/FUTSTK_OI_Snapshot.csv`.
2. **API** — `GET /api/futures-oi` reads the snapshot CSV and returns rows grouped into 4 categories as JSON.
3. **UI** — `OIBuildupDashboard.tsx` renders a 2×2 grid of sortable tables; `FuturesDashboard.tsx` gains a tab bar switching between the existing "Index Futures" view and the new "OI Buildup" view.

---

## Data Layer

### Download function: `download_futstk_oi_snapshot()`

**File:** `scripts/downloader/download_futures_manual.py`

Added to `main()` after the existing NIFTY/BANKNIFTY downloads. Called as:
```python
_write_status("Downloading stock futures OI snapshot…")
download_futstk_oi_snapshot(helper, daily_url, headers, save_dir)
```

**Logic:**
1. Query master list for all `INSTRUMENT == "FUTSTK"` rows, filtering out test contracts (symbols starting with digits). Keep only the near-month contract per underlying (lowest expiry date that is in the future).
2. For each of the ~209 contracts, call `POST v2/charts/historical` with:
   ```json
   {
     "securityId": "<id>",
     "exchangeSegment": "NSE_FNO",
     "instrument": "FUTSTK",
     "oi": true,
     "fromDate": "<today - 7 days>",
     "toDate": "<today>"
   }
   ```
3. Take the last 2 rows from the response (today and previous trading day). Skip if fewer than 2 rows or if both OI values are zero.
4. Compute:
   - `price_chg_pct = (close[-1] - close[-2]) / close[-2] * 100`
   - `oi_chg_pct = (oi[-1] - oi[-2]) / oi[-2] * 100` (skip if `oi[-2] == 0`)
5. Classify:
   - `LONG_BUILDUP`: `price_chg_pct >= 0` and `oi_chg_pct >= 0`
   - `SHORT_BUILDUP`: `price_chg_pct < 0` and `oi_chg_pct >= 0`
   - `SHORT_COVERING`: `price_chg_pct >= 0` and `oi_chg_pct < 0`
   - `LONG_UNWINDING`: `price_chg_pct < 0` and `oi_chg_pct < 0`
6. Sleep 0.2s between calls. Expected runtime: ~90 seconds for 209 stocks.

**Output file:** `Historical Data/FUTSTK_OI_Snapshot.csv`

Columns:
```
Symbol, Expiry, Price, PriceChgPct, OI, OIChgPct, Category
```

Example row:
```
RELIANCE,2026-07-28,2950.40,1.23,24500000,8.45,LONG_BUILDUP
```

One row per stock (near-month contract only). File is fully overwritten on each download run.

---

## API Route

**File:** `rs_dashboard/app/api/futures-oi/route.ts`

### Types (exported)

```ts
export interface OIRow {
  symbol: string;
  expiry: string;
  price: number;
  priceChgPct: number;
  oi: number;
  oiChgPct: number;
}

export interface OIBuildupResponse {
  success: boolean;
  dataDate: string;        // date of the snapshot file (mtime, YYYY-MM-DD)
  longBuildup: OIRow[];
  shortBuildup: OIRow[];
  shortCovering: OIRow[];
  longUnwinding: OIRow[];
  error?: string;
}
```

### GET handler

1. Read `Historical Data/FUTSTK_OI_Snapshot.csv` via `fs.readFileSync`.
2. Parse CSV rows into `OIRow[]`.
3. Group by `Category` into 4 arrays.
4. Sort each array by `Math.abs(oiChgPct)` descending (highest OI activity first).
5. `dataDate` = `fs.statSync(filePath).mtime` formatted as `YYYY-MM-DD`.
6. Return `OIBuildupResponse`. If file does not exist, return `success: false` with error message prompting user to run the download.

---

## UI Components

### Tab bar in `FuturesDashboard.tsx`

Add a `activeTab: 'index' | 'oi'` state. Render a two-tab pill selector in the header, between the title and the download button:

```
[ Index Futures ]  [ OI Buildup ]
```

- When `activeTab === 'index'`: render existing NIFTY/BANKNIFTY contract cards (current behaviour, unchanged).
- When `activeTab === 'oi'`: render `<OIBuildupDashboard />`.

The "Download Data" button and the reload button remain in the header regardless of active tab. Both tabs share the same download flow.

### `OIBuildupDashboard.tsx`

**New file:** `rs_dashboard/components/OIBuildupDashboard.tsx`

**Props:** none — fetches its own data from `/api/futures-oi`.

**State:**
- `data: OIBuildupResponse | null`
- `loading: boolean`
- `error: string | null`
- `sortKey: keyof OIRow` (default: `'oiChgPct'`)
- `sortDir: 'asc' | 'desc'` (default: `'desc'` for absolute OI change)

**Layout:** 2×2 CSS grid (`grid-cols-2 gap-4`). Four `<QuadrantTable>` components, one per category.

**`QuadrantTable` sub-component props:**
```ts
{ title: string; rows: OIRow[]; sortKey: keyof OIRow; sortDir: 'asc'|'desc'; onSort: (key) => void }
```

Each quadrant:
- Header: `"Long Buildup (N)"` bold, expand icon (full-screen not needed — just cosmetic spacer to match layout)
- Table columns (matching screenshot exactly): `SYMBOL · PRICE · CHANGE% · OI · CHANGE OI%`
- All columns sortable (click header to toggle asc/desc)
- Sort state is **shared** across all four quadrants (clicking a column header sorts all four simultaneously)
- Scrollable body (`max-h-64 overflow-y-auto` for each quadrant)
- Color rules:
  - `CHANGE%`: green if ≥ 0, red if < 0
  - `CHANGE OI%`: green if ≥ 0, red if < 0
  - `PRICE` and `OI`: `text-zinc-100` (no color)
- OI formatted with `fmtLakh()` (same helper as `FuturesDashboard`)
- `CHANGE%` formatted as `+1.23%` / `-1.23%`
- `CHANGE OI%` formatted as `+8.45%` / `-8.45%`
- Empty quadrant: centered `"No data"` text in `text-zinc-600`

**Styling:** consistent with existing dashboard — `bg-zinc-900/40 border border-zinc-800 rounded-2xl`, table headers `text-xs font-bold text-white bg-zinc-800`.

**Data fetch:** `useEffect` on mount; also re-fetches when parent calls a refresh (via a `refreshKey` prop incremented by the "Download Data" completion in `FuturesDashboard`).

---

## Global Constraints

- Dark zinc theme throughout: `bg-black`, `bg-zinc-900/40`, `border-zinc-800`
- Table headers: `text-xs font-bold text-white bg-zinc-800` (no smaller than 12px)
- No Tailwind opacity modifiers on text colors (use `text-zinc-100/200/300/400/500` solid values)
- `DATA: YYYY-MM-DD` chip displayed in header showing snapshot date
- `PROJECT_ROOT = path.resolve(process.cwd(), '..')` in all API routes
- FUTSTK exchange segment: `"NSE_FNO"`
- No new npm dependencies
- TypeScript strict — no `any` types
