# Futures Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/futures` page to the Next.js dashboard that shows a quick-glance stats table for NIFTY and BANKNIFTY futures contracts (price, OHLC, volume, OI, OI change, basis, days to expiry, intraday OI sparkline), reading from pre-downloaded 1-minute CSV files.

**Architecture:** Update the Python download script to always write an OI column; create a Next.js API route that reads both futures CSVs and computes per-contract stats; build a client component with two cards (NIFTY / BANKNIFTY), each with a contract tab selector, stats grid, and SVG sparkline.

**Tech Stack:** Python 3 / pandas (download script), Next.js App Router (TypeScript), Tailwind CSS, lucide-react icons, inline SVG for sparklines.

## Global Constraints

- All Python commands run from project root `c:\dhan_algo\dhan_algo` using `venv\Scripts\python.exe`
- `PROJECT_ROOT` in API routes = `path.resolve(process.cwd(), '..')` (one level up from `rs_dashboard/`)
- Table headers: `text-xs font-bold text-white bg-zinc-800` — no opacity modifiers on text colors
- Solid zinc colors only for text: `text-zinc-100/200/300/400/500` — never `text-white/70` etc.
- Pages must show `DATA: YYYY-MM-DD` chip in sticky header
- NavBar active state uses `bg-emerald-500/10 text-emerald-300 border-emerald-500/30`
- Futures CSVs live at `Historical Data/NIFTY_Futures_1min_Manual.csv` and `Historical Data/BANKNIFTY_Futures_1min_Manual.csv`
- NIFTY spot CSV: `Historical Data/NIFTY_50_Daily_5Y.csv` — columns: `Datetime, Open, High, Low, Close, Volume`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/downloader/download_futures_manual.py` | Modify | Always write OI column, zero-fill when API doesn't return it |
| `rs_dashboard/app/api/futures/route.ts` | Create | Parse CSVs, compute per-contract stats, return FuturesResponse |
| `rs_dashboard/components/FuturesDashboard.tsx` | Create | Client component — two cards with tabs, stats grid, OI sparkline |
| `rs_dashboard/app/futures/page.tsx` | Create | Thin page wrapper, sets metadata title |
| `rs_dashboard/components/NavBar.tsx` | Modify | Add `{ href: '/futures', label: 'Futures' }` link |

---

## Task 1: Update download script to always write OI column

**Files:**
- Modify: `scripts/downloader/download_futures_manual.py:47-58`

**Interfaces:**
- Produces: CSVs with columns `Datetime, Open, High, Low, Close, Volume, OI, Contract` — Task 2 depends on `OI` always existing

- [ ] **Step 1: Open the file and locate the DataFrame construction in `fetch_chunk`**

Read `scripts/downloader/download_futures_manual.py` lines 47–58. The current code conditionally adds OI after building the DataFrame:
```python
df = pd.DataFrame({
    "Datetime": pd.to_datetime(data["timestamp"], unit="s")
                  .tz_localize("UTC").tz_convert("Asia/Kolkata").tz_localize(None),
    "Open":   data["open"],
    "High":   data["high"],
    "Low":    data["low"],
    "Close":  data["close"],
    "Volume": data["volume"],
})
if "open_interest" in data:
    df["OI"] = data["open_interest"]
df.set_index("Datetime", inplace=True)
```

- [ ] **Step 2: Replace the DataFrame construction to always include OI**

Replace those lines with:
```python
df = pd.DataFrame({
    "Datetime": pd.to_datetime(data["timestamp"], unit="s")
                  .tz_localize("UTC").tz_convert("Asia/Kolkata").tz_localize(None),
    "Open":   data["open"],
    "High":   data["high"],
    "Low":    data["low"],
    "Close":  data["close"],
    "Volume": data["volume"],
    "OI":     data.get("open_interest", [0] * len(data["open"])),
})
df.set_index("Datetime", inplace=True)
```

- [ ] **Step 3: Verify the change is syntactically correct**

Run:
```powershell
venv\Scripts\python.exe -c "import ast; ast.parse(open('scripts/downloader/download_futures_manual.py').read()); print('OK')"
```
Expected output: `OK`

- [ ] **Step 4: Commit**

```powershell
git add scripts/downloader/download_futures_manual.py
git commit -m "feat(downloader): always write OI column in futures CSV, zero-fill when absent"
```

> **Note for user:** Re-run `venv\Scripts\python.exe scripts/downloader/download_futures_manual.py` after this task to regenerate the CSVs with the OI column. The page will show `—` for OI stats until this is done.

---

## Task 2: Create API route `/api/futures/route.ts`

**Files:**
- Create: `rs_dashboard/app/api/futures/route.ts`

**Interfaces:**
- Consumes: `Historical Data/NIFTY_Futures_1min_Manual.csv` and `BANKNIFTY_Futures_1min_Manual.csv` with columns `Datetime, Open, High, Low, Close, Volume, OI, Contract`; `Historical Data/NIFTY_50_Daily_5Y.csv` with columns `Datetime, Open, High, Low, Close, Volume`
- Produces: `GET /api/futures` → `FuturesResponse` (exported type used by Task 3)

```ts
export interface ContractStats {
  expiry: string;       // "2026-07-28"
  label: string;        // "Jul 28"
  daysToExpiry: number;
  price: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  oi: number;
  oiChange: number;
  oiHasData: boolean;
  basis: number | null;
  sparkline: { time: string; oi: number }[];
}

export interface FuturesResponse {
  success: boolean;
  dataDate: string;
  instruments: {
    NIFTY: ContractStats[];
    BANKNIFTY: ContractStats[];
  };
  error?: string;
}
```

- [ ] **Step 1: Create the route file with the full implementation**

Create `rs_dashboard/app/api/futures/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ContractStats {
  expiry: string;
  label: string;
  daysToExpiry: number;
  price: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  oi: number;
  oiChange: number;
  oiHasData: boolean;
  basis: number | null;
  sparkline: { time: string; oi: number }[];
}

export interface FuturesResponse {
  success: boolean;
  dataDate: string;
  instruments: {
    NIFTY: ContractStats[];
    BANKNIFTY: ContractStats[];
  };
  error?: string;
}

interface Row {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi: number;
  contract: string;
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function parseFuturesCsv(filePath: string): Row[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const idx = (col: string) => headers.indexOf(col);
  const hasOI = idx('OI') !== -1;
  return lines.slice(1).flatMap(line => {
    const v = line.split(',');
    const get = (col: string) => (v[idx(col)] ?? '').trim();
    const row: Row = {
      datetime: get('Datetime'),
      open: parseFloat(get('Open')) || 0,
      high: parseFloat(get('High')) || 0,
      low: parseFloat(get('Low')) || 0,
      close: parseFloat(get('Close')) || 0,
      volume: parseFloat(get('Volume')) || 0,
      oi: hasOI ? (parseFloat(get('OI')) || 0) : 0,
      contract: get('Contract'),
    };
    return row.datetime && row.contract ? [row] : [];
  });
}

function toDate(datetime: string): string {
  return datetime.split(' ')[0]; // "2026-07-01"
}

function toTime(datetime: string): string {
  return (datetime.split(' ')[1] ?? '').substring(0, 5); // "09:15"
}

function fmtLabel(expiry: string): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [, m, d] = expiry.split('-');
  return `${months[parseInt(m) - 1]} ${parseInt(d)}`;
}

function niftySpotClose(): number | null {
  const p = path.join(PROJECT_ROOT, 'Historical Data', 'NIFTY_50_Daily_5Y.csv');
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, 'utf-8').trim().split('\n');
  if (lines.length < 2) return null;
  const headers = lines[0].split(',').map(h => h.trim());
  const closeIdx = headers.indexOf('Close');
  if (closeIdx === -1) return null;
  const last = lines[lines.length - 1].split(',');
  return parseFloat(last[closeIdx]) || null;
}

// ─── Per-contract computation ─────────────────────────────────────────────────

function buildContracts(
  rows: Row[],
  spotClose: number | null,
  useSpot: boolean
): ContractStats[] {
  const byContract = new Map<string, Row[]>();
  for (const row of rows) {
    if (!byContract.has(row.contract)) byContract.set(row.contract, []);
    byContract.get(row.contract)!.push(row);
  }

  const result: ContractStats[] = [];

  for (const [expiry, cRows] of byContract) {
    cRows.sort((a, b) => a.datetime.localeCompare(b.datetime));

    const dates = [...new Set(cRows.map(r => toDate(r.datetime)))].sort();
    const latestDate = dates[dates.length - 1];
    const prevDate = dates.length > 1 ? dates[dates.length - 2] : null;

    const todayRows = cRows.filter(r => toDate(r.datetime) === latestDate);
    const prevRows = prevDate ? cRows.filter(r => toDate(r.datetime) === prevDate) : [];

    const hasOI = todayRows.some(r => r.oi > 0);
    const latestOI = todayRows.length ? todayRows[todayRows.length - 1].oi : 0;
    const prevOI = prevRows.length ? prevRows[prevRows.length - 1].oi : 0;

    const latestClose = todayRows.length ? todayRows[todayRows.length - 1].close : 0;
    const expiryMs = new Date(expiry).getTime();
    const daysToExpiry = Math.ceil((expiryMs - Date.now()) / 86400000);

    result.push({
      expiry,
      label: fmtLabel(expiry),
      daysToExpiry,
      price: latestClose,
      open: todayRows.length ? todayRows[0].open : 0,
      high: todayRows.length ? Math.max(...todayRows.map(r => r.high)) : 0,
      low: todayRows.length ? Math.min(...todayRows.map(r => r.low)) : 0,
      volume: todayRows.reduce((s, r) => s + r.volume, 0),
      oi: latestOI,
      oiChange: latestOI - prevOI,
      oiHasData: hasOI,
      basis: useSpot && spotClose !== null ? latestClose - spotClose : null,
      sparkline: todayRows.map(r => ({ time: toTime(r.datetime), oi: r.oi })),
    });
  }

  return result.sort((a, b) => a.expiry.localeCompare(b.expiry));
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const spotClose = niftySpotClose();

    const niftyRows = parseFuturesCsv(
      path.join(PROJECT_ROOT, 'Historical Data', 'NIFTY_Futures_1min_Manual.csv')
    );
    const bnfRows = parseFuturesCsv(
      path.join(PROJECT_ROOT, 'Historical Data', 'BANKNIFTY_Futures_1min_Manual.csv')
    );

    if (!niftyRows.length && !bnfRows.length) {
      return NextResponse.json<FuturesResponse>({
        success: false,
        dataDate: '',
        instruments: { NIFTY: [], BANKNIFTY: [] },
        error: 'No futures data found. Run scripts/downloader/download_futures_manual.py first.',
      });
    }

    const niftyContracts = buildContracts(niftyRows, spotClose, true);
    const bnfContracts = buildContracts(bnfRows, null, false);

    const allDates = [...niftyRows, ...bnfRows]
      .map(r => toDate(r.datetime))
      .filter(Boolean)
      .sort();
    const dataDate = allDates[allDates.length - 1] ?? '';

    return NextResponse.json<FuturesResponse>({
      success: true,
      dataDate,
      instruments: { NIFTY: niftyContracts, BANKNIFTY: bnfContracts },
    });
  } catch (e: unknown) {
    return NextResponse.json<FuturesResponse>({
      success: false,
      dataDate: '',
      instruments: { NIFTY: [], BANKNIFTY: [] },
      error: e instanceof Error ? e.message : 'Unknown error',
    });
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```powershell
cd rs_dashboard; npx tsc --noEmit 2>&1 | Select-Object -First 30
```
Expected: no errors (or only pre-existing errors unrelated to the new file).

- [ ] **Step 3: Start the dev server and test the route manually**

```powershell
cd rs_dashboard; npm run dev
```
Then in a new terminal:
```powershell
curl http://localhost:3000/api/futures
```
Expected: JSON with `success: true`, `dataDate` set to the most recent date in the CSVs, and `instruments.NIFTY` / `instruments.BANKNIFTY` each containing an array of contracts with all fields populated.

If OI column is missing from the CSV (download script not yet re-run): `oiHasData: false` and `oi: 0` — this is correct.

- [ ] **Step 4: Commit**

```powershell
cd ..; git add rs_dashboard/app/api/futures/route.ts
git commit -m "feat(api): add /api/futures route — reads NIFTY and BANKNIFTY futures CSVs"
```

---

## Task 3: Create `FuturesDashboard` component

**Files:**
- Create: `rs_dashboard/components/FuturesDashboard.tsx`

**Interfaces:**
- Consumes: `GET /api/futures` → `FuturesResponse` (from Task 2)
- Produces: default export `FuturesDashboard` React component (used by Task 4's page wrapper)

- [ ] **Step 1: Create the full component**

Create `rs_dashboard/components/FuturesDashboard.tsx`:

```tsx
'use client';

import React, { useState, useEffect, useCallback } from 'react';
import NavBar from '@/components/NavBar';
import { Activity, RefreshCw, AlertCircle, Loader2 } from 'lucide-react';
import type { ContractStats, FuturesResponse } from '@/app/api/futures/route';

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtPrice(v: number): string {
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtLakh(v: number): string {
  if (v >= 10000000) return (v / 10000000).toFixed(2) + 'Cr';
  if (v >= 100000) return (v / 100000).toFixed(1) + 'L';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
  return v.toFixed(0);
}

function fmtChange(v: number): string {
  return (v >= 0 ? '+' : '') + fmtLakh(Math.abs(v));
}

function fmtBasis(v: number | null): string {
  if (v === null) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}

function oiChangeColor(v: number): string {
  if (v > 0) return 'text-emerald-400';
  if (v < 0) return 'text-red-400';
  return 'text-zinc-400';
}

function basisColor(v: number | null): string {
  if (v === null) return 'text-zinc-500';
  if (v > 0) return 'text-emerald-400';
  if (v < 0) return 'text-red-400';
  return 'text-zinc-300';
}

function dteColor(days: number): string {
  if (days <= 5) return 'text-red-400 font-bold';
  if (days <= 15) return 'text-amber-400';
  return 'text-zinc-300';
}

// ─── OI Sparkline ─────────────────────────────────────────────────────────────

function OISparkline({ data }: { data: { time: string; oi: number }[] }) {
  if (data.length < 2) return (
    <div className="h-20 flex items-center justify-center text-[11px] text-zinc-600">
      Not enough data for sparkline
    </div>
  );

  const W = 500;
  const H = 80;
  const pad = 6;
  const innerW = W - pad * 2;
  const innerH = H - pad * 2;

  const oiVals = data.map(d => d.oi);
  const minOI = Math.min(...oiVals);
  const maxOI = Math.max(...oiVals);
  const range = maxOI - minOI || 1;

  const points = data.map((d, i) => {
    const x = pad + (i / (data.length - 1)) * innerW;
    const y = pad + innerH - ((d.oi - minOI) / range) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      style={{ height: 80 }}
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        stroke="#38bdf8"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ─── Contract card ────────────────────────────────────────────────────────────

function ContractCard({
  name,
  contracts,
}: {
  name: string;
  contracts: ContractStats[];
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  const contract = contracts[activeIdx] ?? contracts[0];

  if (!contract) {
    return (
      <div className="flex-1 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 flex items-center justify-center text-zinc-500 text-sm">
        No {name} data
      </div>
    );
  }

  const tabLabels = ['Near', 'Mid', 'Far'];

  return (
    <div className="flex-1 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 min-w-[320px]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-base font-bold text-zinc-100">{name}</span>
        {/* Contract tabs */}
        <div className="flex items-center gap-1 p-0.5 bg-zinc-950/60 border border-zinc-800 rounded-xl">
          {contracts.map((c, i) => (
            <button
              key={c.expiry}
              onClick={() => setActiveIdx(i)}
              className={`px-3 py-1 text-[11px] font-semibold rounded-lg transition-all ${
                activeIdx === i
                  ? 'bg-sky-500/15 text-sky-400 border border-sky-500/25'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {c.label}
              <span className="ml-1 opacity-50 text-[10px]">{tabLabels[i] ?? ''}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Price — prominent */}
      <div className="mb-4">
        <div className="text-3xl font-bold text-white tracking-tight">
          {fmtPrice(contract.price)}
        </div>
        <div className={`text-[11px] mt-0.5 ${dteColor(contract.daysToExpiry)}`}>
          Expiry {contract.expiry} · {contract.daysToExpiry}d left
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 mb-5">
        <StatRow label="Open" value={fmtPrice(contract.open)} />
        <StatRow label="High" value={fmtPrice(contract.high)} valueClass="text-emerald-300" />
        <StatRow label="Low" value={fmtPrice(contract.low)} valueClass="text-red-400" />
        <StatRow label="Volume" value={fmtLakh(contract.volume)} />
        <StatRow
          label="OI"
          value={contract.oiHasData ? fmtLakh(contract.oi) : '—'}
          valueClass={contract.oiHasData ? 'text-zinc-100' : 'text-zinc-600'}
        />
        <StatRow
          label="OI Change"
          value={contract.oiHasData ? fmtChange(contract.oiChange) : '—'}
          valueClass={contract.oiHasData ? oiChangeColor(contract.oiChange) : 'text-zinc-600'}
        />
        <StatRow
          label="Basis"
          value={fmtBasis(contract.basis)}
          valueClass={basisColor(contract.basis)}
        />
        <StatRow
          label="Expiry"
          value={contract.expiry}
          valueClass="text-zinc-300"
        />
      </div>

      {/* OI Sparkline */}
      <div className="border-t border-zinc-800 pt-3">
        <div className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider mb-1.5">
          Intraday OI
        </div>
        {contract.oiHasData ? (
          <OISparkline data={contract.sparkline} />
        ) : (
          <div className="h-20 flex items-center justify-center text-[11px] text-zinc-600 text-center px-4">
            OI data not available — re-run <code className="text-zinc-500 mx-1">download_futures_manual.py</code> to fetch OI
          </div>
        )}
      </div>
    </div>
  );
}

function StatRow({
  label,
  value,
  valueClass = 'text-zinc-100',
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-zinc-500 shrink-0">{label}</span>
      <span className={`text-[12px] font-semibold tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

export default function FuturesDashboard() {
  const [data, setData] = useState<FuturesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/futures');
      const json: FuturesResponse = await res.json();
      if (!json.success) throw new Error(json.error ?? 'API error');
      setData(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  return (
    <div className="flex flex-col min-h-screen bg-black text-zinc-100">

      {/* Header */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/60 backdrop-blur-md px-5 py-3 flex items-center gap-4 z-20 flex-wrap">
        <div className="flex items-center gap-3 shrink-0">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-sky-600 to-cyan-400 flex items-center justify-center shadow-lg shadow-sky-500/10">
            <Activity className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight bg-gradient-to-r from-white via-zinc-200 to-zinc-500 bg-clip-text text-transparent leading-none">
              Futures Monitor
            </h1>
            {data?.dataDate && (
              <p className="text-[10px] text-zinc-400 font-medium mt-0.5">
                DATA: {data.dataDate}
              </p>
            )}
          </div>
        </div>

        <NavBar />

        <button
          onClick={fetchData}
          disabled={loading}
          className="p-1.5 border border-zinc-800 rounded-lg bg-zinc-900/40 text-zinc-400 hover:text-white transition-all hover:border-zinc-700 disabled:opacity-40 ml-auto"
          title="Reload data"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </header>

      {/* Body */}
      <main className="flex-1 px-5 py-6 max-w-screen-xl mx-auto w-full">
        {loading ? (
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
        ) : null}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```powershell
cd rs_dashboard; npx tsc --noEmit 2>&1 | Select-Object -First 30
```
Expected: no new errors.

- [ ] **Step 3: Commit**

```powershell
cd ..; git add rs_dashboard/components/FuturesDashboard.tsx
git commit -m "feat(dashboard): add FuturesDashboard component with contract tabs, stats grid, OI sparkline"
```

---

## Task 4: Create page wrapper, add NavBar link, and verify end-to-end

**Files:**
- Create: `rs_dashboard/app/futures/page.tsx`
- Modify: `rs_dashboard/components/NavBar.tsx`

**Interfaces:**
- Consumes: `FuturesDashboard` default export from Task 3
- Produces: `/futures` route accessible from NavBar

- [ ] **Step 1: Create the page wrapper**

Create `rs_dashboard/app/futures/page.tsx`:

```tsx
import FuturesDashboard from '@/components/FuturesDashboard';

export const metadata = { title: 'Futures Monitor' };

export default function FuturesPage() {
  return <FuturesDashboard />;
}
```

- [ ] **Step 2: Add the NavBar link**

Open `rs_dashboard/components/NavBar.tsx`. The current `NAV_LINKS` array ends with:
```ts
  { href: '/diffusion', label: 'Diffusion' },
  { href: '/distribution', label: 'Distribution' },
```

Insert the Futures entry between them:
```ts
  { href: '/diffusion', label: 'Diffusion' },
  { href: '/futures', label: 'Futures' },
  { href: '/distribution', label: 'Distribution' },
```

- [ ] **Step 3: Verify TypeScript compiles**

```powershell
cd rs_dashboard; npx tsc --noEmit 2>&1 | Select-Object -First 30
```
Expected: no new errors.

- [ ] **Step 4: Start the dev server and verify the page**

```powershell
cd rs_dashboard; npm run dev
```

Open `http://localhost:3000/futures` in the browser and verify:
1. Page loads without a white screen or console errors
2. Sticky header shows "Futures Monitor" and the `DATA: YYYY-MM-DD` chip
3. NavBar shows "Futures" highlighted when on `/futures`
4. Two cards appear side by side: NIFTY (left) and BANKNIFTY (right)
5. Each card shows Near/Mid/Far contract tabs (however many contracts are in the CSVs)
6. Clicking tabs switches the stats shown in that card
7. Stats grid shows: price, OHLC, volume, OI (or `—` if OI not in CSV yet), OI change, basis (NIFTY only), expiry, days to expiry
8. Days to expiry shows red when ≤ 5 days
9. OI sparkline area shows either the SVG line or the "re-run download script" notice
10. Refresh button (top right) reloads data without a full page reload

- [ ] **Step 5: Commit**

```powershell
cd ..; git add rs_dashboard/app/futures/page.tsx rs_dashboard/components/NavBar.tsx
git commit -m "feat(pages): add /futures page and NavBar link"
```
