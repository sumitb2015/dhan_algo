# QuilTrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `/options/quiltrade` page showing NIFTY options ATM±10 strikes grouped into four OI-buildup quadrants (Long Buildup, Short Buildup, Short Covering, Long Unwinding) with live prices, plus Positions/Orders/Tradebook tabs and a live P&L header.

**Architecture:** A thin page wrapper renders `QuilTradeTab`, which owns the sticky header (NavBar, expiry selector, live P&L badge) and composes two self-contained child components: `QuilTradeQuadrants` (polls `/api/options/chain`, classifies and renders the 2×2 grid) and `QuilTradePositions` (polls a new `/api/quiltrade/poll` route for Positions/Orders/Tradebook tables). The new API route wraps the existing `scalper_api.py poll` command and filters results to NIFTY-symbol rows server-side.

**Tech Stack:** Next.js 14 App Router, React, TypeScript, Tailwind CSS. Existing routes: `/api/options/chain`, `/api/options/expiries`, `/api/portfolio`. New route: `/api/quiltrade/poll` wrapping `scripts/tools/scalper_api.py poll`.

## Global Constraints

- NIFTY only — `STRIKE_STEP = 50`, ATM±10 strikes (`WINGS = 10`)
- Table headers: `text-xs font-bold text-white` on solid `bg-zinc-800` (no slash-opacity text colors anywhere, e.g. never `text-white/70`)
- Quadrant colors (must match `OptionsBuildupTab.tsx`'s existing badge palette): Long Buildup = emerald, Short Buildup = red, Short Covering = sky, Long Unwinding = amber
- Working directory for all commands: `c:\dhan_algo\dhan_algo\rs_dashboard`
- No changes to `scripts/tools/scalper_api.py` — filtering happens in the new Next.js route only

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `rs_dashboard/app/api/quiltrade/poll/route.ts` | Create | Wraps `scalper_api.py poll`, filters positions/orders/trades to NIFTY rows |
| `rs_dashboard/components/QuilTradeQuadrants.tsx` | Create | Fetches option chain, classifies buildup, renders 2×2 quadrant grid |
| `rs_dashboard/components/QuilTradePositions.tsx` | Create | Positions/Orders/Tradebook tab strip, polls `/api/quiltrade/poll` |
| `rs_dashboard/components/QuilTradeTab.tsx` | Create | Page shell: header (NavBar, expiry selector, P&L badge), composes the two components above |
| `rs_dashboard/app/options/quiltrade/page.tsx` | Create | Thin page wrapper |
| `rs_dashboard/components/NavBar.tsx` | Modify (1 line) | Add QuilTrade link to Derivatives group |

---

## Task 1: Create `/api/quiltrade/poll` route

**Files:**
- Create: `rs_dashboard/app/api/quiltrade/poll/route.ts`

**Interfaces:**
- Consumes: `scripts/tools/scalper_api.py poll` (existing, unmodified) — stdout's last JSON line is `{ success: boolean, positions: Record<string, unknown>[], orders: Record<string, unknown>[], trades: Record<string, unknown>[] }`. Each row has a `tradingSymbol` field (e.g. `"NIFTY-14JUL2026-25000-CE"`, `"BANKNIFTY-..."`).
- Produces: `GET /api/quiltrade/poll` → `NextResponse.json({ success, positions, orders, trades })` where all three arrays are filtered to rows whose `tradingSymbol` starts with `NIFTY-` (case-insensitive) — used by Task 3.

- [ ] **Step 1: Create the route file**

Create `rs_dashboard/app/api/quiltrade/poll/route.ts` with this exact content:

```ts
import { NextResponse } from 'next/server';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const PYTHON_EXE     = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const SCALPER_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'scalper_api.py');

const NIFTY_PREFIX = /^NIFTY-/i;

function isNiftyRow(row: Record<string, unknown>): boolean {
  const sym = String(row.tradingSymbol ?? '');
  return NIFTY_PREFIX.test(sym);
}

function filterToNifty(data: {
  success: boolean;
  positions?: Record<string, unknown>[];
  orders?: Record<string, unknown>[];
  trades?: Record<string, unknown>[];
}) {
  return {
    success: data.success,
    positions: (data.positions ?? []).filter(isNiftyRow),
    orders: (data.orders ?? []).filter(isNiftyRow),
    trades: (data.trades ?? []).filter(isNiftyRow),
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    const { stdout } = await execFileAsync(PYTHON_EXE, [SCALPER_SCRIPT, 'poll'], {
      cwd: PROJECT_ROOT,
      timeout: 20_000,
      windowsHide: true,
    });
    const lines = stdout.trim().split('\n').filter(Boolean);
    const data = JSON.parse(lines[lines.length - 1]);
    return NextResponse.json(filterToNifty(data));
  } catch (err: unknown) {
    const e = err as { stdout?: string; message?: string; stderr?: string };
    if (e.stdout) {
      try {
        const lines = String(e.stdout).trim().split('\n').filter(Boolean);
        return NextResponse.json(filterToNifty(JSON.parse(lines[lines.length - 1])));
      } catch {}
    }
    console.error('[/api/quiltrade/poll] error:', e.message, e.stderr ?? '');
    return NextResponse.json(
      { success: false, error: 'Failed to fetch positions', detail: String(e.message) },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles without errors**

Run from `rs_dashboard/`:
```powershell
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 3: Manual smoke test of the route**

```powershell
npm run dev
```
In a second terminal:
```powershell
curl http://localhost:3000/api/quiltrade/poll
```
Expected: JSON with `success: true` and `positions`/`orders`/`trades` arrays (empty arrays are fine if no NIFTY options positions are currently open — verify no BANKNIFTY/FINNIFTY rows leak through if you happen to hold any).

- [ ] **Step 4: Commit**

```powershell
git add rs_dashboard/app/api/quiltrade/poll/route.ts
git commit -m "feat(quiltrade): add NIFTY-filtered positions/orders/trades poll route"
```

---

## Task 2: Create `QuilTradeQuadrants.tsx`

**Files:**
- Create: `rs_dashboard/components/QuilTradeQuadrants.tsx`

**Interfaces:**
- Consumes: `GET /api/options/chain?underlying=NIFTY&expiry=<date>` (existing) → `{ success, data?: { chain: { oc?: Record<string, { ce?: ChainSide; pe?: ChainSide }> }; spot: number }; error?: string }` where `ChainSide = { last_price?: number; previous_close_price?: number; oi?: number; previous_oi?: number }`.
- Produces: `export default function QuilTradeQuadrants({ expiry }: { expiry: string })` — used by Task 4. Renders its own loading/error state; no return value consumed by the parent.

- [ ] **Step 1: Create the file with full implementation**

Create `rs_dashboard/components/QuilTradeQuadrants.tsx` with this exact content:

```tsx
'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────

interface ChainSide {
  last_price?: number;
  previous_close_price?: number;
  oi?: number;
  previous_oi?: number;
}

interface ChainEntry { ce?: ChainSide; pe?: ChainSide; }

type QuadrantLabel = 'Long Buildup' | 'Short Buildup' | 'Short Covering' | 'Long Unwinding';

interface ParsedStrike {
  strike: number;
  ce: ChainSide;
  pe: ChainSide;
}

interface Tile {
  strike: number;
  type: 'CE' | 'PE';
  ltp: number;
  priceChgPct: number | null;
  oiChgPct: number | null;
}

// ─── Constants ────────────────────────────────────────────────────

const UNDERLYING  = 'NIFTY';
const STRIKE_STEP = 50;
const POLL_MS     = 30_000;
const WINGS       = 10;

const QUADRANTS: { label: QuadrantLabel; classes: string; dot: string }[] = [
  { label: 'Long Buildup',   classes: 'border-emerald-500/25 bg-emerald-500/5', dot: 'bg-emerald-400' },
  { label: 'Short Buildup',  classes: 'border-red-500/25 bg-red-500/5',         dot: 'bg-red-400' },
  { label: 'Short Covering', classes: 'border-sky-500/25 bg-sky-500/5',         dot: 'bg-sky-400' },
  { label: 'Long Unwinding', classes: 'border-amber-500/25 bg-amber-500/5',     dot: 'bg-amber-400' },
];

const TILE_CLASSES: Record<QuadrantLabel, string> = {
  'Long Buildup':   'text-emerald-300 bg-emerald-500/10 border-emerald-500/25',
  'Short Buildup':  'text-red-300 bg-red-500/10 border-red-500/25',
  'Short Covering': 'text-sky-300 bg-sky-500/10 border-sky-500/25',
  'Long Unwinding': 'text-amber-300 bg-amber-500/10 border-amber-500/25',
};

// ─── Helpers ──────────────────────────────────────────────────────

function classifyBuildup(side: ChainSide): QuadrantLabel | null {
  const curOI  = side.oi ?? 0;
  const prevOI = side.previous_oi;
  if (!prevOI || prevOI === 0) return null;
  const oiChg    = curOI - prevOI;
  const priceChg = (side.last_price ?? 0) - (side.previous_close_price ?? 0);
  if (oiChg === 0) return null;
  if (oiChg > 0 && priceChg >= 0) return 'Long Buildup';
  if (oiChg > 0 && priceChg <  0) return 'Short Buildup';
  if (oiChg < 0 && priceChg >= 0) return 'Short Covering';
  return 'Long Unwinding';
}

function pctChg(current: number, prev: number | undefined): number | null {
  if (!prev || prev === 0) return null;
  return ((current - prev) / prev) * 100;
}

function tileFromSide(strike: number, type: 'CE' | 'PE', side: ChainSide): Tile {
  return {
    strike,
    type,
    ltp: side.last_price ?? 0,
    priceChgPct: pctChg(side.last_price ?? 0, side.previous_close_price),
    oiChgPct: pctChg(side.oi ?? 0, side.previous_oi),
  };
}

function fmtPct(pct: number | null): string {
  if (pct === null) return '—';
  return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
}

// ─── Tile ─────────────────────────────────────────────────────────

function QuadrantTile({ tile, label }: { tile: Tile; label: QuadrantLabel }) {
  return (
    <div className={`flex flex-col gap-0.5 px-2.5 py-2 rounded-lg border text-[11px] font-semibold tabular-nums ${TILE_CLASSES[label]}`}>
      <div className="flex items-center gap-1.5">
        <span className="font-bold">{tile.strike.toLocaleString('en-IN')}</span>
        <span className="text-[9px] px-1 py-0.5 rounded bg-black/20">{tile.type}</span>
      </div>
      <div className="flex items-center gap-2 text-[10px] opacity-90">
        <span>₹{tile.ltp.toFixed(1)}</span>
        <span>{fmtPct(tile.priceChgPct)}</span>
        <span>OI {fmtPct(tile.oiChgPct)}</span>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────

export default function QuilTradeQuadrants({ expiry }: { expiry: string }) {
  const [allStrikes, setAllStrikes]   = useState<ParsedStrike[]>([]);
  const [spot, setSpot]               = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchChain = useCallback(async () => {
    if (!expiry) return;
    setLoading(true);
    try {
      const res  = await fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${expiry}`);
      const json = await res.json() as {
        success: boolean;
        data?: { chain: { oc?: Record<string, ChainEntry> }; spot: number };
        error?: string;
      };
      if (!json.success || !json.data?.chain?.oc) {
        setError(json.error ?? 'No chain data');
        return;
      }

      const oc = json.data.chain.oc;
      const parsed: ParsedStrike[] = Object.entries(oc)
        .map(([key, entry]) => ({ strike: Number(key), entry }))
        .filter(x => !isNaN(x.strike))
        .sort((a, b) => a.strike - b.strike)
        .map(({ strike, entry }) => ({
          strike,
          ce: entry.ce ?? {},
          pe: entry.pe ?? {},
        }));

      setAllStrikes(parsed);
      setSpot(json.data.spot ?? 0);
      setLastUpdated(new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }));
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [expiry]);

  useEffect(() => {
    fetchChain();
    intervalRef.current = setInterval(fetchChain, POLL_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchChain]);

  const atm = spot > 0 ? Math.round(spot / STRIKE_STEP) * STRIKE_STEP : 0;

  const atmIdx = atm > 0 && allStrikes.length > 0
    ? allStrikes.reduce((best, { strike }, i) =>
        Math.abs(strike - atm) < Math.abs(allStrikes[best].strike - atm) ? i : best, 0)
    : Math.floor(allStrikes.length / 2);

  const visible = allStrikes.slice(
    Math.max(0, atmIdx - WINGS),
    Math.min(allStrikes.length, atmIdx + WINGS + 1),
  );

  const tilesByQuadrant: Record<QuadrantLabel, Tile[]> = {
    'Long Buildup': [], 'Short Buildup': [], 'Short Covering': [], 'Long Unwinding': [],
  };

  for (const row of visible) {
    const ceLabel = classifyBuildup(row.ce);
    if (ceLabel) tilesByQuadrant[ceLabel].push(tileFromSide(row.strike, 'CE', row.ce));
    const peLabel = classifyBuildup(row.pe);
    if (peLabel) tilesByQuadrant[peLabel].push(tileFromSide(row.strike, 'PE', row.pe));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4 text-[10px] text-zinc-500 font-medium">
        {loading && <span className="text-zinc-400 animate-pulse">Refreshing…</span>}
        {lastUpdated && <span>Updated {lastUpdated}</span>}
        {atm > 0 && (
          <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
            ATM {atm.toLocaleString('en-IN')}
          </span>
        )}
        <span className="ml-auto">Auto-refresh: 30s · ATM ±{WINGS} strikes</span>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {QUADRANTS.map(q => (
          <div key={q.label} className={`border rounded-2xl p-4 ${q.classes}`}>
            <div className="flex items-center gap-2 mb-3">
              <span className={`h-2 w-2 rounded-full ${q.dot}`} />
              <span className="text-sm font-bold text-white">{q.label}</span>
              <span className="text-[10px] text-zinc-500 ml-auto">
                {tilesByQuadrant[q.label].length} legs
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {tilesByQuadrant[q.label].map(tile => (
                <QuadrantTile key={`${tile.strike}-${tile.type}`} tile={tile} label={q.label} />
              ))}
              {tilesByQuadrant[q.label].length === 0 && (
                <span className="text-[11px] text-zinc-600 py-2">
                  {loading ? 'Loading…' : 'No legs'}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles without errors**

```powershell
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 3: Commit**

```powershell
git add rs_dashboard/components/QuilTradeQuadrants.tsx
git commit -m "feat(quiltrade): add OI-buildup quadrant grid component"
```

---

## Task 3: Create `QuilTradePositions.tsx`

**Files:**
- Create: `rs_dashboard/components/QuilTradePositions.tsx`

**Interfaces:**
- Consumes: `GET /api/quiltrade/poll` (Task 1) → `{ success, positions: Record<string, unknown>[], orders: Record<string, unknown>[], trades: Record<string, unknown>[] }`. Row field names (from DhanHQ raw API, confirmed in `Scalper.tsx`): positions have `tradingSymbol`, `netQty`, `buyAvg`, `sellAvg`, `lastTradedPrice`, `realizedProfit`, `unrealizedProfit`, `productType`; orders have `tradingSymbol`, `orderStatus`, `transactionType`, `quantity`, `price`, `orderType`, `createTime`; trades have `tradingSymbol`, `transactionType`, `tradedQuantity`, `tradedPrice`, `createTime`.
- Produces: `export default function QuilTradePositions()` — used by Task 4. Self-contained, no props.

- [ ] **Step 1: Create the file with full implementation**

Create `rs_dashboard/components/QuilTradePositions.tsx` with this exact content:

```tsx
'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────

type TabKey = 'positions' | 'orders' | 'trades';

interface PollResponse {
  success: boolean;
  positions: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  trades: Record<string, unknown>[];
  error?: string;
}

interface ColumnDef {
  key: string;
  label: string;
  numeric?: boolean;
  highlight?: 'side' | 'pnl';
}

// ─── Constants ────────────────────────────────────────────────────

const POLL_MS = 5_000;

const COLUMNS: Record<TabKey, ColumnDef[]> = {
  positions: [
    { key: 'tradingSymbol',    label: 'Symbol' },
    { key: 'netQty',           label: 'Qty',          numeric: true },
    { key: 'buyAvg',           label: 'Buy Avg',      numeric: true },
    { key: 'sellAvg',          label: 'Sell Avg',     numeric: true },
    { key: 'lastTradedPrice',  label: 'LTP',          numeric: true },
    { key: 'realizedProfit',   label: 'Realized P&L', numeric: true, highlight: 'pnl' },
    { key: 'unrealizedProfit', label: 'Unreal. P&L',  numeric: true, highlight: 'pnl' },
    { key: 'productType',      label: 'Product' },
  ],
  orders: [
    { key: 'tradingSymbol',   label: 'Symbol' },
    { key: 'orderStatus',     label: 'Status' },
    { key: 'transactionType', label: 'Side',   highlight: 'side' },
    { key: 'quantity',        label: 'Qty',    numeric: true },
    { key: 'price',           label: 'Price',  numeric: true },
    { key: 'orderType',       label: 'Type' },
    { key: 'createTime',      label: 'Time' },
  ],
  trades: [
    { key: 'tradingSymbol',   label: 'Symbol' },
    { key: 'transactionType', label: 'Side',   highlight: 'side' },
    { key: 'tradedQuantity',  label: 'Qty',    numeric: true },
    { key: 'tradedPrice',     label: 'Price',  numeric: true },
    { key: 'createTime',      label: 'Time' },
  ],
};

const TAB_LABELS: Record<TabKey, string> = {
  positions: 'Positions',
  orders: 'Orders',
  trades: 'Tradebook',
};

// ─── Helpers ──────────────────────────────────────────────────────

function fmtCell(col: ColumnDef, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (col.numeric) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(value);
  }
  return String(value);
}

function cellClass(col: ColumnDef, value: unknown): string {
  if (col.highlight === 'side') {
    return String(value) === 'BUY'
      ? 'text-emerald-400 font-semibold'
      : 'text-red-400 font-semibold';
  }
  if (col.highlight === 'pnl') {
    const n = Number(value);
    return n > 0 ? 'text-emerald-400 font-semibold' : n < 0 ? 'text-red-400 font-semibold' : 'text-zinc-300';
  }
  return 'text-zinc-300';
}

// ─── Table ────────────────────────────────────────────────────────

function DataTable({ tab, rows }: { tab: TabKey; rows: Record<string, unknown>[] }) {
  const cols = COLUMNS[tab];
  const thCls = 'text-xs font-bold text-white bg-zinc-800 px-3 py-2 whitespace-nowrap';

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr>
            {cols.map(col => (
              <th key={col.key} className={`${thCls} ${col.numeric ? 'text-right' : 'text-left'}`}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
              {cols.map(col => (
                <td
                  key={col.key}
                  className={`px-3 py-2 tabular-nums ${col.numeric ? 'text-right' : 'text-left'} ${cellClass(col, row[col.key])}`}
                >
                  {fmtCell(col, row[col.key])}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={cols.length} className="px-3 py-8 text-center text-zinc-600">
                No {TAB_LABELS[tab].toLowerCase()}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────

export default function QuilTradePositions() {
  const [activeTab, setActiveTab] = useState<TabKey>('positions');
  const [data, setData] = useState<PollResponse>({ success: true, positions: [], orders: [], trades: [] });
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchPoll = useCallback(async () => {
    try {
      const res  = await fetch('/api/quiltrade/poll');
      const json = await res.json() as PollResponse;
      if (!json.success) {
        setError(json.error ?? 'Failed to fetch positions');
        setStale(true);
        return;
      }
      setData(json);
      setError('');
      setStale(false);
    } catch (e) {
      setError(String(e));
      setStale(true);
    }
  }, []);

  useEffect(() => {
    fetchPoll();
    intervalRef.current = setInterval(fetchPoll, POLL_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchPoll]);

  const rows = data[activeTab];

  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
        {(['positions', 'orders', 'trades'] as TabKey[]).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-colors ${
              activeTab === tab
                ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
                : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
            }`}
          >
            {TAB_LABELS[tab]} ({data[tab].length})
          </button>
        ))}
        {stale && (
          <span className="text-[10px] text-amber-400 font-semibold ml-auto">Stale data</span>
        )}
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border-b border-red-500/30 px-4 py-2">
          {error}
        </div>
      )}

      <DataTable tab={activeTab} rows={rows} />
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles without errors**

```powershell
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 3: Commit**

```powershell
git add rs_dashboard/components/QuilTradePositions.tsx
git commit -m "feat(quiltrade): add positions/orders/tradebook tab strip"
```

---

## Task 4: Create `QuilTradeTab.tsx`

**Files:**
- Create: `rs_dashboard/components/QuilTradeTab.tsx`

**Interfaces:**
- Consumes: `GET /api/options/expiries?underlying=NIFTY` (existing) → `{ success: boolean, data?: string[], error?: string }`.
- Consumes: `GET /api/portfolio` (existing) → `{ success: boolean, total_realized_pnl?: number, total_unrealized_pnl?: number, total_pnl?: number, error?: string }`.
- Consumes: `QuilTradeQuadrants` (Task 2, prop `expiry: string`), `QuilTradePositions` (Task 3, no props).
- Consumes: `NavBar` default export from `./NavBar` (existing, no props).
- Produces: `export default function QuilTradeTab()` — used by Task 5.

- [ ] **Step 1: Create the file with full implementation**

Create `rs_dashboard/components/QuilTradeTab.tsx` with this exact content:

```tsx
'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import NavBar from './NavBar';
import QuilTradeQuadrants from './QuilTradeQuadrants';
import QuilTradePositions from './QuilTradePositions';

const UNDERLYING = 'NIFTY';
const PNL_POLL_MS = 5_000;

interface PortfolioResponse {
  success: boolean;
  total_realized_pnl?: number;
  total_unrealized_pnl?: number;
  total_pnl?: number;
  error?: string;
}

function fmtPnl(n: number): string {
  return (n >= 0 ? '+' : '') + '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function QuilTradeTab() {
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [expiriesLoading, setExpiriesLoading] = useState(false);
  const [expiriesError, setExpiriesError] = useState('');

  const [pnl, setPnl] = useState<PortfolioResponse | null>(null);
  const pnlIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    setExpiriesLoading(true);
    fetch(`/api/options/expiries?underlying=${UNDERLYING}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[]; error?: string }) => {
        if (j.success && j.data?.length) {
          setExpiries(j.data);
          setExpiry(j.data[0]);
        } else {
          setExpiriesError(j.error ?? 'Failed to load expiries');
        }
      })
      .catch(e => setExpiriesError(String(e)))
      .finally(() => setExpiriesLoading(false));
  }, []);

  const fetchPnl = useCallback(async () => {
    try {
      const res  = await fetch('/api/portfolio');
      const json = await res.json() as PortfolioResponse;
      setPnl(json);
    } catch {
      // keep last-known P&L on transient failure
    }
  }, []);

  useEffect(() => {
    fetchPnl();
    pnlIntervalRef.current = setInterval(fetchPnl, PNL_POLL_MS);
    return () => { if (pnlIntervalRef.current) clearInterval(pnlIntervalRef.current); };
  }, [fetchPnl]);

  const totalPnl = pnl?.success ? (pnl.total_pnl ?? 0) : null;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 flex-wrap
                      px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <h1 className="text-sm font-bold text-white tracking-tight">QuilTrade</h1>
            <p className="text-[10px] text-zinc-400 font-medium">OI buildup quadrants &amp; live trading terminal</p>
          </div>

          <NavBar />

          {totalPnl !== null && (
            <div className={`text-[11px] font-bold px-2.5 py-1 rounded-lg border tabular-nums flex items-center gap-1.5 shrink-0 ${
              totalPnl > 0
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : totalPnl < 0
                  ? 'bg-red-500/10 text-red-400 border-red-500/20'
                  : 'bg-zinc-900 border-zinc-800 text-zinc-400'
            }`}>
              <span className="text-[9px] uppercase text-zinc-500 font-extrabold tracking-wider">P&amp;L:</span>
              <span>{fmtPnl(totalPnl)}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wide">Expiry</label>
          <select
            value={expiry}
            onChange={e => setExpiry(e.target.value)}
            disabled={expiriesLoading}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-zinc-200 disabled:opacity-50"
          >
            {expiries.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-5 px-6 py-5">
        {expiriesError && (
          <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2">
            {expiriesError}
          </div>
        )}

        <QuilTradeQuadrants expiry={expiry} />
        <QuilTradePositions />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles without errors**

```powershell
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 3: Commit**

```powershell
git add rs_dashboard/components/QuilTradeTab.tsx
git commit -m "feat(quiltrade): add page shell with header P&L and expiry selector"
```

---

## Task 5: Create the page route and wire into NavBar

**Files:**
- Create: `rs_dashboard/app/options/quiltrade/page.tsx`
- Modify: `rs_dashboard/components/NavBar.tsx:46` (Derivatives group `links` array)

**Interfaces:**
- Consumes: `QuilTradeTab` default export from `@/components/QuilTradeTab` (Task 4).

- [ ] **Step 1: Create the page wrapper**

Create `rs_dashboard/app/options/quiltrade/page.tsx` with this exact content:

```tsx
import QuilTradeTab from '@/components/QuilTradeTab';

export const metadata = { title: 'QuilTrade' };

export default function QuilTradePage() {
  return <QuilTradeTab />;
}
```

- [ ] **Step 2: Add the nav link**

In `rs_dashboard/components/NavBar.tsx`, find (inside the `Derivatives` group's `links` array, right after the `/options` entry):

```tsx
      { href: '/options', label: 'Options', desc: 'Max pain, PCR & live options chain' },
      { href: '/options/delta', label: 'Net Delta', desc: 'Track live delta risk and net delta exposure of active positions' },
```

Replace with:

```tsx
      { href: '/options', label: 'Options', desc: 'Max pain, PCR & live options chain' },
      { href: '/options/quiltrade', label: 'QuilTrade', desc: 'OI buildup quadrants, live positions & P&L' },
      { href: '/options/delta', label: 'Net Delta', desc: 'Track live delta risk and net delta exposure of active positions' },
```

- [ ] **Step 3: Verify TypeScript compiles without errors**

```powershell
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 4: Start dev server and do a manual smoke test**

```powershell
npm run dev
```

Navigate to `http://localhost:3000/options/quiltrade`. Verify:

1. Header shows "QuilTrade" title, NavBar, expiry dropdown populated with real expiries, and a P&L badge (green/red/gray) once `/api/portfolio` responds
2. `Derivatives` nav dropdown shows a "QuilTrade" entry between "Options" and "Net Delta"; clicking it navigates to `/options/quiltrade`
3. Four quadrant panels render (Long Buildup emerald, Short Buildup red, Short Covering sky, Long Unwinding amber), each showing strike/CE-PE tiles or "No legs" if empty
4. Changing the expiry dropdown re-fetches the chain and updates the quadrant grid within ~30s (or immediately on next poll)
5. Below the grid, the Positions/Orders/Tradebook tab strip renders with row counts in each tab label; switching tabs shows the correct table columns
6. No console errors in the browser dev tools

- [ ] **Step 5: Commit**

```powershell
git add rs_dashboard/app/options/quiltrade/page.tsx rs_dashboard/components/NavBar.tsx
git commit -m "feat(quiltrade): add page route and nav entry"
```
