# Futures OI Buildup Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "OI Buildup" tab to the existing `/futures` page showing all ~209 F&O stock futures classified into Long Buildup / Short Buildup / Short Covering / Long Unwinding based on day-over-day price and OI change.

**Architecture:** A new `download_futstk_oi_snapshot()` Python function extends the existing download script to fetch daily FUTSTK OI for all near-month stock futures contracts and writes a flat snapshot CSV. A new Next.js API route reads that CSV and groups rows into 4 categories. A new React component renders a 2×2 grid of sortable tables; the existing `FuturesDashboard` gains a tab bar to switch between the current index cards and the new OI Buildup view.

**Tech Stack:** Python 3.12 + pandas + requests (existing), Next.js App Router, TypeScript, Tailwind CSS (dark zinc theme)

## Global Constraints

- Dark zinc theme: `bg-black` page, `bg-zinc-900/40 border border-zinc-800 rounded-2xl` cards
- Table headers: `text-xs font-bold text-white bg-zinc-800`, sticky top-0
- No Tailwind opacity modifiers on text (use `text-zinc-100/200/300/400/500` solid values)
- `PROJECT_ROOT = path.resolve(process.cwd(), '..')` in all API routes
- FUTSTK exchange segment: `"NSE_FNO"`
- `"oi": true` must be included in every `v2/charts/historical` request body
- No new npm dependencies
- TypeScript strict — no `any` types
- Snapshot CSV lives at: `Historical Data/FUTSTK_OI_Snapshot.csv`
- `_write_status()` must be called at regular intervals during the 209-stock download loop

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Modify | `scripts/downloader/download_futures_manual.py` | Add `download_futstk_oi_snapshot()` + wire into `main()` |
| Create | `Historical Data/FUTSTK_OI_Snapshot.csv` | Output of download; read by API route |
| Create | `rs_dashboard/app/api/futures-oi/route.ts` | Reads snapshot CSV, returns grouped JSON |
| Create | `rs_dashboard/components/OIBuildupDashboard.tsx` | 2×2 grid of sortable tables |
| Modify | `rs_dashboard/components/FuturesDashboard.tsx` | Add tab bar + `refreshKey` wiring |

---

## Task 1: Python download function

**Files:**
- Modify: `scripts/downloader/download_futures_manual.py`

**Interfaces:**
- Produces: `Historical Data/FUTSTK_OI_Snapshot.csv` with columns `Symbol,Expiry,Price,PriceChgPct,OI,OIChgPct,Category`
- Produces: status updates to `debug/futures_refresh_status.json` via `_write_status()`

- [ ] **Step 1: Add `download_futstk_oi_snapshot()` function**

Insert this function before the `main()` function (after `download_futures_daily`, around line 173):

```python
def download_futstk_oi_snapshot(helper: DhanHelper, url: str, headers: dict, save_dir: str):
    """Fetch near-month FUTSTK daily OI for all F&O stocks and write a classification snapshot."""
    print("\n>>> STOCK FUTURES OI SNAPSHOT <<<")

    df_master = helper._load_master_list()
    futstk = df_master[df_master["INSTRUMENT"] == "FUTSTK"].copy()
    # Exclude test contracts (symbols starting with a digit)
    futstk = futstk[~futstk["UNDERLYING_SYMBOL"].str[0].str.isdigit()]
    futstk["SM_EXPIRY_DATE"] = pd.to_datetime(futstk["SM_EXPIRY_DATE"])
    # Keep near-month only: lowest future expiry per underlying
    futstk = futstk[futstk["SM_EXPIRY_DATE"] > pd.Timestamp(datetime.now())]
    near_month = (futstk.sort_values("SM_EXPIRY_DATE")
                  .drop_duplicates("UNDERLYING_SYMBOL", keep="first"))

    total = len(near_month)
    print(f"  Found {total} near-month FUTSTK contracts")

    from_date = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
    to_date   = datetime.now().strftime("%Y-%m-%d")

    rows = []
    skipped = 0

    for i, (_, row) in enumerate(near_month.iterrows()):
        sec_id = str(row["SECURITY_ID"])
        symbol = row["UNDERLYING_SYMBOL"]
        expiry = row["SM_EXPIRY_DATE"].strftime("%Y-%m-%d")

        if (i + 1) % 20 == 0:
            _write_status(f"Stock futures OI: {i + 1}/{total}…")
            print(f"  [{i + 1}/{total}] processed (last: {symbol})")

        payload = {
            "securityId": sec_id,
            "exchangeSegment": "NSE_FNO",
            "instrument": "FUTSTK",
            "oi": True,
            "fromDate": from_date,
            "toDate":   to_date,
        }
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=30)
        except Exception:
            skipped += 1
            continue

        if resp.status_code != 200:
            skipped += 1
            continue

        data = resp.json()
        if not isinstance(data, dict) or not data.get("close") or len(data["close"]) < 2:
            skipped += 1
            continue

        closes = data["close"]
        ois    = data.get("open_interest", [0] * len(closes))

        close_today = closes[-1]
        close_prev  = closes[-2]
        oi_today    = ois[-1]
        oi_prev     = ois[-2]

        if oi_prev == 0:
            skipped += 1
            continue

        price_chg_pct = (close_today - close_prev) / close_prev * 100
        oi_chg_pct    = (oi_today - oi_prev) / oi_prev * 100

        if price_chg_pct >= 0 and oi_chg_pct >= 0:
            category = "LONG_BUILDUP"
        elif price_chg_pct < 0 and oi_chg_pct >= 0:
            category = "SHORT_BUILDUP"
        elif price_chg_pct >= 0 and oi_chg_pct < 0:
            category = "SHORT_COVERING"
        else:
            category = "LONG_UNWINDING"

        rows.append({
            "Symbol":      symbol,
            "Expiry":      expiry,
            "Price":       round(close_today, 2),
            "PriceChgPct": round(price_chg_pct, 2),
            "OI":          int(oi_today),
            "OIChgPct":    round(oi_chg_pct, 2),
            "Category":    category,
        })
        time.sleep(0.2)

    if not rows:
        print(f"  [FAIL] No FUTSTK OI data collected ({skipped} skipped)")
        return

    df_out = pd.DataFrame(rows)
    out = os.path.join(save_dir, "FUTSTK_OI_Snapshot.csv")
    df_out.to_csv(out, index=False)

    counts = df_out["Category"].value_counts()
    print(f"  [SUCCESS] {out} ({len(df_out)} stocks, {skipped} skipped)")
    for cat, n in counts.items():
        print(f"    {cat}: {n}")
```

- [ ] **Step 2: Wire into `main()`**

Replace lines 276–281 in `main()`:
```python
        for underlying, segment in [("NIFTY", "NSE_FNO"), ("BANKNIFTY", "NSE_FNO")]:
            _write_status(f"Downloading {underlying} 1-min data…")
            download_futures(helper, intraday_url, headers, underlying, segment, save_dir)
            _write_status(f"Downloading {underlying} daily OI data…")
            download_futures_daily(helper, daily_url, headers, underlying, segment, save_dir)

        _write_status("Done", done=True)
```

with:
```python
        for underlying, segment in [("NIFTY", "NSE_FNO"), ("BANKNIFTY", "NSE_FNO")]:
            _write_status(f"Downloading {underlying} 1-min data…")
            download_futures(helper, intraday_url, headers, underlying, segment, save_dir)
            _write_status(f"Downloading {underlying} daily OI data…")
            download_futures_daily(helper, daily_url, headers, underlying, segment, save_dir)

        _write_status("Downloading stock futures OI snapshot…")
        download_futstk_oi_snapshot(helper, daily_url, headers, save_dir)

        _write_status("Done", done=True)
```

- [ ] **Step 3: Run the script and verify output**

```powershell
$env:PYTHONIOENCODING = "utf-8"
cd "c:\dhan_algo\dhan_algo"
venv\Scripts\python.exe scripts/downloader/download_futures_manual.py
```

Expected output (after the NIFTY/BANKNIFTY sections):
```
>>> STOCK FUTURES OI SNAPSHOT <<<
  Found 209 near-month FUTSTK contracts
  [20/209] processed (last: ...)
  ...
  [SUCCESS] Historical Data\FUTSTK_OI_Snapshot.csv (N stocks, M skipped)
    LONG_BUILDUP: ...
    SHORT_BUILDUP: ...
    SHORT_COVERING: ...
    LONG_UNWINDING: ...
```

Also verify the CSV has the correct columns:
```powershell
python -c "
import pandas as pd
df = pd.read_csv('Historical Data/FUTSTK_OI_Snapshot.csv')
print(df.columns.tolist())
print(df['Category'].value_counts())
print(df.head(3))
"
```

Expected: columns `['Symbol', 'Expiry', 'Price', 'PriceChgPct', 'OI', 'OIChgPct', 'Category']`, 4 categories present, at least 100 rows total.

- [ ] **Step 4: Commit**

```bash
git add scripts/downloader/download_futures_manual.py
git commit -m "feat(futures): add download_futstk_oi_snapshot for stock F&O OI classification"
```

---

## Task 2: API route `/api/futures-oi`

**Files:**
- Create: `rs_dashboard/app/api/futures-oi/route.ts`

**Interfaces:**
- Consumes: `Historical Data/FUTSTK_OI_Snapshot.csv` (columns from Task 1)
- Produces (exported types used by Task 3):
  ```ts
  export interface OIRow {
    symbol: string; expiry: string;
    price: number; priceChgPct: number;
    oi: number; oiChgPct: number;
  }
  export interface OIBuildupResponse {
    success: boolean; dataDate: string;
    longBuildup: OIRow[]; shortBuildup: OIRow[];
    shortCovering: OIRow[]; longUnwinding: OIRow[];
    error?: string;
  }
  ```

- [ ] **Step 1: Create the route file**

Create `rs_dashboard/app/api/futures-oi/route.ts` with this exact content:

```typescript
import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');

// ─── Types ────────────────────────────────────────────────────────────────────

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
  dataDate: string;
  longBuildup: OIRow[];
  shortBuildup: OIRow[];
  shortCovering: OIRow[];
  longUnwinding: OIRow[];
  error?: string;
}

// ─── CSV parser ───────────────────────────────────────────────────────────────

function parseSnapshot(filePath: string): (OIRow & { category: string })[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const idx = (col: string) => headers.indexOf(col);
  return lines.slice(1).flatMap(line => {
    const v = line.split(',');
    const get = (col: string) => (v[idx(col)] ?? '').trim();
    const symbol = get('Symbol');
    if (!symbol) return [];
    return [{
      symbol,
      expiry:      get('Expiry'),
      price:       parseFloat(get('Price')) || 0,
      priceChgPct: parseFloat(get('PriceChgPct')) || 0,
      oi:          parseInt(get('OI')) || 0,
      oiChgPct:    parseFloat(get('OIChgPct')) || 0,
      category:    get('Category'),
    }];
  });
}

function sortByAbsOI(rows: OIRow[]): OIRow[] {
  return [...rows].sort((a, b) => Math.abs(b.oiChgPct) - Math.abs(a.oiChgPct));
}

// ─── GET handler ──────────────────────────────────────────────────────────────

export async function GET() {
  const filePath = path.join(PROJECT_ROOT, 'Historical Data', 'FUTSTK_OI_Snapshot.csv');

  if (!fs.existsSync(filePath)) {
    return NextResponse.json<OIBuildupResponse>({
      success: false,
      dataDate: '',
      longBuildup: [], shortBuildup: [], shortCovering: [], longUnwinding: [],
      error: 'No snapshot found. Click "Download Data" to fetch stock futures OI.',
    });
  }

  try {
    const allRows = parseSnapshot(filePath);
    const filterSort = (cat: string): OIRow[] =>
      sortByAbsOI(allRows.filter(r => r.category === cat));

    const dataDate = new Date(fs.statSync(filePath).mtime)
      .toISOString().split('T')[0];

    return NextResponse.json<OIBuildupResponse>({
      success: true,
      dataDate,
      longBuildup:   filterSort('LONG_BUILDUP'),
      shortBuildup:  filterSort('SHORT_BUILDUP'),
      shortCovering: filterSort('SHORT_COVERING'),
      longUnwinding: filterSort('LONG_UNWINDING'),
    });
  } catch (e: unknown) {
    return NextResponse.json<OIBuildupResponse>({
      success: false,
      dataDate: '',
      longBuildup: [], shortBuildup: [], shortCovering: [], longUnwinding: [],
      error: e instanceof Error ? e.message : 'Unknown error',
    });
  }
}
```

- [ ] **Step 2: Start the dev server and verify the route**

```powershell
cd rs_dashboard
npm run dev
```

In a second terminal:
```powershell
curl http://localhost:3000/api/futures-oi
```

Expected: JSON with `success: true`, `dataDate` set to today, and four arrays each containing objects with keys `symbol, expiry, price, priceChgPct, oi, oiChgPct`. Each array is sorted by `|oiChgPct|` descending.

If `FUTSTK_OI_Snapshot.csv` does not yet exist: response is `success: false` with the prompt-to-download error message.

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/app/api/futures-oi/route.ts
git commit -m "feat(futures): add /api/futures-oi route for OI buildup classification"
```

---

## Task 3: `OIBuildupDashboard` component

**Files:**
- Create: `rs_dashboard/components/OIBuildupDashboard.tsx`

**Interfaces:**
- Consumes: `OIRow`, `OIBuildupResponse` from `@/app/api/futures-oi/route`
- Consumes prop: `refreshKey: number` (incremented by parent when download completes, triggers re-fetch)
- Produces: default export `OIBuildupDashboard` used by Task 4

- [ ] **Step 1: Create the component**

Create `rs_dashboard/components/OIBuildupDashboard.tsx`:

```tsx
'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import type { OIRow, OIBuildupResponse } from '@/app/api/futures-oi/route';

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtPrice(v: number): string {
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtLakh(v: number): string {
  if (v >= 10000000) return (v / 10000000).toFixed(2) + 'Cr';
  if (v >= 100000)   return (v / 100000).toFixed(1) + 'L';
  if (v >= 1000)     return (v / 1000).toFixed(1) + 'K';
  return v.toFixed(0);
}

function fmtPct(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

// ─── Sortable quadrant table ──────────────────────────────────────────────────

type SortKey = keyof OIRow;

function QuadrantTable({
  title,
  rows,
  sortKey,
  sortDir,
  onSort,
}: {
  title: string;
  rows: OIRow[];
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
}) {
  const sorted = [...rows].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const arrow = (k: SortKey) => sortKey === k ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';

  const thCls =
    'px-3 py-2 text-left text-xs font-bold text-white cursor-pointer select-none ' +
    'hover:text-zinc-200 transition-colors whitespace-nowrap';
  const thRCls = thCls + ' text-right';

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-zinc-800">
        <span className="text-sm font-bold text-zinc-100">{title}</span>
      </div>
      <div className="overflow-y-auto" style={{ maxHeight: 280 }}>
        <table className="w-full text-[12px] border-collapse">
          <thead className="sticky top-0 bg-zinc-800">
            <tr>
              <th className={thCls}    onClick={() => onSort('symbol')}>SYMBOL{arrow('symbol')}</th>
              <th className={thRCls}   onClick={() => onSort('price')}>PRICE{arrow('price')}</th>
              <th className={thRCls}   onClick={() => onSort('priceChgPct')}>CHANGE%{arrow('priceChgPct')}</th>
              <th className={thRCls}   onClick={() => onSort('oi')}>OI{arrow('oi')}</th>
              <th className={thRCls}   onClick={() => onSort('oiChgPct')}>CHANGE OI%{arrow('oiChgPct')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-zinc-600 text-[11px]">
                  No data
                </td>
              </tr>
            ) : sorted.map(r => (
              <tr
                key={r.symbol}
                className="border-t border-zinc-800/50 hover:bg-zinc-800/30 transition-colors"
              >
                <td className="px-3 py-2 font-semibold text-zinc-100">{r.symbol}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-200">
                  {fmtPrice(r.price)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums font-semibold ${
                  r.priceChgPct >= 0 ? 'text-emerald-400' : 'text-red-400'
                }`}>
                  {fmtPct(r.priceChgPct)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-200">
                  {fmtLakh(r.oi)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums font-semibold ${
                  r.oiChgPct >= 0 ? 'text-emerald-400' : 'text-red-400'
                }`}>
                  {fmtPct(r.oiChgPct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function OIBuildupDashboard({ refreshKey }: { refreshKey: number }) {
  const [data, setData]       = useState<OIBuildupResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('oiChgPct');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch('/api/futures-oi');
      const json: OIBuildupResponse = await res.json();
      if (!json.success) throw new Error(json.error ?? 'API error');
      setData(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData, refreshKey]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center py-32 gap-2 text-zinc-400">
      <Loader2 className="h-5 w-5 animate-spin" />
      <span className="text-sm">Loading OI data…</span>
    </div>
  );

  if (error) return (
    <div className="flex flex-col items-center justify-center py-24 gap-3 text-zinc-400">
      <AlertCircle className="h-8 w-8" />
      <span className="text-sm text-center max-w-md">{error}</span>
    </div>
  );

  if (!data) return null;

  const quadrants: { title: string; rows: OIRow[] }[] = [
    { title: `Long Buildup (${data.longBuildup.length})`,   rows: data.longBuildup },
    { title: `Short Buildup (${data.shortBuildup.length})`, rows: data.shortBuildup },
    { title: `Short Covering (${data.shortCovering.length})`, rows: data.shortCovering },
    { title: `Long Unwinding (${data.longUnwinding.length})`, rows: data.longUnwinding },
  ];

  return (
    <div>
      {data.dataDate && (
        <p className="text-[10px] text-zinc-500 mb-3 font-medium">DATA: {data.dataDate}</p>
      )}
      <div className="grid grid-cols-2 gap-4">
        {quadrants.map(q => (
          <QuadrantTable
            key={q.title}
            title={q.title}
            rows={q.rows}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```powershell
cd rs_dashboard
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/components/OIBuildupDashboard.tsx
git commit -m "feat(futures): add OIBuildupDashboard 2x2 grid component"
```

---

## Task 4: Tab bar in `FuturesDashboard`

**Files:**
- Modify: `rs_dashboard/components/FuturesDashboard.tsx`

**Interfaces:**
- Consumes: `OIBuildupDashboard` default export from `@/components/OIBuildupDashboard`
- `refreshKey: number` state — incremented when download completes so OI tab auto-reloads

- [ ] **Step 1: Add import and new state**

At the top of the file, add the import after the existing imports:

```tsx
import OIBuildupDashboard from '@/components/OIBuildupDashboard';
```

Inside `FuturesDashboard()`, after the existing state declarations (after line 223), add:

```tsx
  const [activeTab, setActiveTab]   = useState<'index' | 'oi'>('index');
  const [refreshKey, setRefreshKey] = useState(0);
```

- [ ] **Step 2: Increment `refreshKey` when download completes**

In the `pollDownload` callback, after `fetchData()` is called (line 247), add:

```tsx
        setRefreshKey(k => k + 1);
```

The `pollDownload` block should become:

```tsx
  const pollDownload = useCallback(async () => {
    try {
      const res = await fetch('/api/futures-refresh');
      const json: FuturesRefreshStatus = await res.json();
      setDlStatus(json);
      if (!json.running && json.done) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        fetchData();
        setRefreshKey(k => k + 1);
      }
    } catch { /* ignore */ }
  }, [fetchData]);
```

- [ ] **Step 3: Add the tab bar to the header**

Replace the `<NavBar />` line (line 291) with:

```tsx
        <NavBar />

        {/* Tab selector */}
        <div className="flex items-center gap-1 p-0.5 bg-zinc-950/60 border border-zinc-800 rounded-xl shrink-0">
          {(['index', 'oi'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1 text-[11px] font-semibold rounded-lg transition-all ${
                activeTab === tab
                  ? 'bg-sky-500/15 text-sky-400 border border-sky-500/25'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {tab === 'index' ? 'Index Futures' : 'OI Buildup'}
            </button>
          ))}
        </div>
```

- [ ] **Step 4: Replace the body with conditional render**

Replace the entire `<main>` block (lines 322–340) with:

```tsx
      {/* Body */}
      <main className="flex-1 px-5 py-6 max-w-screen-2xl mx-auto w-full">
        {activeTab === 'index' ? (
          loading ? (
            <div className="flex items-center justify-center py-32 gap-2 text-zinc-400">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Loading futures data…</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-32 gap-3 text-red-400">
              <AlertCircle className="h-8 w-8" />
              <span className="text-sm text-center max-w-md">{error}</span>
            </div>
          ) : data ? (
            <div className="flex gap-5 flex-wrap">
              <ContractCard name="NIFTY" contracts={data.instruments.NIFTY} />
              <ContractCard name="BANKNIFTY" contracts={data.instruments.BANKNIFTY} />
            </div>
          ) : null
        ) : (
          <OIBuildupDashboard refreshKey={refreshKey} />
        )}
      </main>
```

Note: `max-w-screen-xl` is widened to `max-w-screen-2xl` so the 2×2 grid has more room.

- [ ] **Step 5: Verify TypeScript and browser**

```powershell
cd rs_dashboard
npx tsc --noEmit
```

Expected: no errors.

Open `http://localhost:3000/futures` in a browser. Verify:
1. Two tabs appear in the header: "Index Futures" and "OI Buildup"
2. "Index Futures" tab shows the NIFTY / BANKNIFTY contract cards (existing behaviour unchanged)
3. "OI Buildup" tab shows the 2×2 grid with Long Buildup / Short Buildup / Short Covering / Long Unwinding quadrants
4. Counts in each quadrant header are non-zero (if snapshot CSV exists)
5. Clicking any column header sorts all four quadrants simultaneously
6. "Download Data" button triggers the full download (including FUTSTK snapshot); when it completes, the OI Buildup tab auto-refreshes

- [ ] **Step 6: Commit**

```bash
git add rs_dashboard/components/FuturesDashboard.tsx
git commit -m "feat(futures): add Index Futures / OI Buildup tab bar"
```
