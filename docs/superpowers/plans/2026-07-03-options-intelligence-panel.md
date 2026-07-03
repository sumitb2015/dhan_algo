# Options Market Intelligence Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Intelligence" tab to the Options page that synthesises Gamma Exposure (GEX), PCR trend, and IV percentile into a market regime badge, directional bias badge, GEX profile chart, intraday signal timeline, and key structural levels grid.

**Architecture:** A new Next.js route `/api/options/intelligence` reads the daily `debug/iv_snapshots_YYYY-MM-DD.csv` (written by `iv_snapshot_collector.py`) and returns a pre-computed timeline and GEX profile. A new component `OptionsIntelligenceTab.tsx` fetches this route plus the existing `/api/options/chain` and renders four sections. `OptionsCharts.tsx` is minimally modified to wire up the new tab.

**Tech Stack:** Next.js App Router (TypeScript), Recharts (`BarChart`, `AreaChart`, `LineChart`, `Cell`, `ReferenceLine`), Tailwind CSS.

## Global Constraints

- All files live under `rs_dashboard/` — run `npm run dev` (port 3000) to verify UI changes.
- Read `rs_dashboard/AGENTS.md` → `rs_dashboard/node_modules/next/dist/docs/` before writing any code: this Next.js version has breaking changes vs training data.
- No text color opacity modifiers (never `text-white/70`); use solid zinc colors (`text-zinc-400`, `text-zinc-300`, etc.).
- Table/stat header style: `text-xs font-bold text-white bg-zinc-800`.
- `PROJECT_ROOT = path.resolve(process.cwd(), '..')` in all API routes (one level up from `rs_dashboard/`).
- Python venv path (for other routes reference): `path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe')`.
- NIFTY lot size = 75 (hardcoded constant `LOT_SIZE`).
- NIFTY strike step = 50 (hardcoded constant `STRIKE_STEP`).
- GEX formula: `per_strike_net_gex = (CE_OI × CE_gamma − PE_OI × PE_gamma) × LOT_SIZE × spot / 100`.
- Regime thresholds: IV 80th-percentile (Volatile), net_gex > 0 (Pinning), net_gex < 0 (Trending), else Indecisive.
- Bias thresholds: PCR > 1.3 AND rising → Bullish; PCR < 0.7 AND falling → Bearish; else Neutral.
- PCR = PE_OI / CE_OI (same formula used everywhere in the codebase).

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| **Create** | `rs_dashboard/app/api/options/intelligence/route.ts` | Read snapshot CSV, compute GEX timeline + profile, return intelligence response |
| **Create** | `rs_dashboard/components/OptionsIntelligenceTab.tsx` | Full Intelligence tab: regime header, GEX chart, signal timeline, key levels |
| **Modify** | `rs_dashboard/components/OptionsCharts.tsx` line 165 | Add `'intelligence'` to `activeTab` union type, add tab button, render component |

---

## Task 1: API Route `/api/options/intelligence`

**Files:**
- Create: `rs_dashboard/app/api/options/intelligence/route.ts`

**Interfaces:**
- Consumes: `debug/iv_snapshots_YYYY-MM-DD.csv` (same CSV read by `app/api/options/iv-history/route.ts`)
- Produces `GET /api/options/intelligence?date=YYYY-MM-DD&wings=10` → JSON:
  ```ts
  {
    success: boolean;
    hasData: boolean;
    date: string;
    atm: number;
    expiry: string;
    current: {
      net_gex: number;
      pcr: number;
      atm_iv: number;
      iv_min: number;
      iv_max: number;
      pcr_30min_ago: number | null;
    } | null;
    gex_profile: Array<{ strike: number; net_gex: number; ce_gex: number; pe_gex: number }>;
    gex_flip_strike: number | null;
    timeline: Array<{ time: string; ts: number; pcr: number; atm_iv: number; net_gex: number }>;
  }
  ```

- [ ] **Step 1: Create the route file with all helpers**

Create `rs_dashboard/app/api/options/intelligence/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR    = path.join(PROJECT_ROOT, 'debug');
const LOT_SIZE     = 75;
const STRIKE_STEP  = 50;

function todayIST(): string {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function parseNumber(s: string): number {
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// "YYYY-MM-DD HH:MM:SS" IST → epoch ms
function istStringToEpoch(ts: string): number {
  const [datePart, timePart] = ts.split(' ');
  return new Date(`${datePart}T${timePart}+05:30`).getTime();
}

const EMPTY_RESPONSE = (date: string) => ({
  success: true, hasData: false, date, atm: 0, expiry: '',
  current: null, gex_profile: [], gex_flip_strike: null, timeline: [],
});

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const date  = searchParams.get('date')  ?? todayIST();
  const wings = Math.min(Math.max(parseInt(searchParams.get('wings') ?? '10', 10), 1), 10);

  const csvPath = path.join(DEBUG_DIR, `iv_snapshots_${date}.csv`);
  if (!fs.existsSync(csvPath)) {
    return NextResponse.json(EMPTY_RESPONSE(date));
  }

  const raw   = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    return NextResponse.json(EMPTY_RESPONSE(date));
  }

  const headers = lines[0].split(',').map(h => h.trim());
  const colMap  = new Map(headers.map((h, i) => [h, i]));
  const col     = (name: string) => colMap.get(name) ?? -1;

  const allRows = lines.slice(1).map(line => {
    const c = line.split(',');
    const g = (name: string) => c[col(name)] ?? '';
    return {
      timestamp: g('timestamp'),
      spot:      parseNumber(g('spot')),
      expiry:    g('expiry').trim(),
      strike:    parseInt(g('strike'), 10),
      CE_OI:     parseNumber(g('CE_OI')),
      CE_IV:     parseNumber(g('CE_IV')),
      CE_gamma:  parseNumber(g('CE_gamma')),
      PE_OI:     parseNumber(g('PE_OI')),
      PE_IV:     parseNumber(g('PE_IV')),
      PE_gamma:  parseNumber(g('PE_gamma')),
    };
  }).filter(r => !isNaN(r.strike) && r.timestamp.length > 0);

  if (allRows.length === 0) {
    return NextResponse.json(EMPTY_RESPONSE(date));
  }

  const firstRow  = allRows[0];
  const atm       = Math.round(firstRow.spot / STRIKE_STEP) * STRIKE_STEP;
  const expiry    = firstRow.expiry;
  const wingRange = wings * STRIKE_STEP;

  // Group rows by timestamp
  const byTs = new Map<string, { spot: number; rows: typeof allRows }>();
  for (const row of allRows) {
    if (!byTs.has(row.timestamp)) byTs.set(row.timestamp, { spot: row.spot, rows: [] });
    byTs.get(row.timestamp)!.rows.push(row);
  }

  const sortedEntries = [...byTs.entries()].sort(([a], [b]) => a.localeCompare(b));

  // Build timeline — one point per timestamp
  const timeline = sortedEntries.map(([timestamp, { spot, rows }]) => {
    const wing = rows.filter(r => Math.abs(r.strike - atm) <= wingRange);
    const sumCE = wing.reduce((s, r) => s + r.CE_OI, 0);
    const sumPE = wing.reduce((s, r) => s + r.PE_OI, 0);
    const pcr   = sumCE > 0 ? Math.round((sumPE / sumCE) * 100) / 100 : 0;

    const atmRow = wing.reduce<typeof allRows[0] | null>((best, r) =>
      !best || Math.abs(r.strike - atm) < Math.abs(best.strike - atm) ? r : best, null);
    const atm_iv = atmRow ? Math.round(atmRow.CE_IV * 10) / 10 : 0;

    const net_gex = Math.round(
      wing.reduce((s, r) =>
        s + (r.CE_OI * r.CE_gamma - r.PE_OI * r.PE_gamma) * LOT_SIZE * spot / 100, 0),
    );

    return { time: timestamp.slice(11, 16), ts: istStringToEpoch(timestamp), pcr, atm_iv, net_gex };
  });

  // GEX profile from most-recent snapshot
  const [latestTs, { spot: latestSpot, rows: latestRows }] = sortedEntries[sortedEntries.length - 1];
  const gex_profile = latestRows
    .filter(r => Math.abs(r.strike - atm) <= wingRange)
    .sort((a, b) => a.strike - b.strike)
    .map(r => ({
      strike:  r.strike,
      net_gex: Math.round((r.CE_OI * r.CE_gamma - r.PE_OI * r.PE_gamma) * LOT_SIZE * latestSpot / 100),
      ce_gex:  Math.round(r.CE_OI * r.CE_gamma * LOT_SIZE),
      pe_gex:  Math.round(r.PE_OI * r.PE_gamma * LOT_SIZE),
    }));

  // GEX flip strike — first sign change in cumulative GEX (ascending strikes)
  let cumGex = 0;
  let gex_flip_strike: number | null = null;
  for (const { strike, net_gex } of gex_profile) {
    const prevSign = cumGex === 0 ? 0 : Math.sign(cumGex);
    cumGex += net_gex;
    if (prevSign !== 0 && Math.sign(cumGex) !== prevSign) {
      gex_flip_strike = strike;
      break;
    }
  }

  // Current values
  const latestTl   = timeline[timeline.length - 1];
  const ivValues   = timeline.map(t => t.atm_iv).filter(v => v > 0);
  const iv_min     = ivValues.length > 0 ? Math.min(...ivValues) : 0;
  const iv_max     = ivValues.length > 0 ? Math.max(...ivValues) : 0;

  const nowTs      = istStringToEpoch(latestTs);
  const target30   = nowTs - 30 * 60 * 1000;
  const closest30  = timeline.reduce<typeof timeline[0] | null>((best, t) =>
    !best || Math.abs(t.ts - target30) < Math.abs(best.ts - target30) ? t : best, null);
  const pcr_30min_ago = closest30 && closest30.ts !== latestTl?.ts ? closest30.pcr : null;

  const current = latestTl ? {
    net_gex: latestTl.net_gex, pcr: latestTl.pcr, atm_iv: latestTl.atm_iv,
    iv_min, iv_max, pcr_30min_ago,
  } : null;

  const response = NextResponse.json({
    success: true, hasData: timeline.length >= 2,
    date, atm, expiry, current, gex_profile, gex_flip_strike, timeline,
  });
  response.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
  return response;
}
```

- [ ] **Step 2: Verify the route returns correct data**

Ensure `iv_snapshot_collector.py` has run today (check `debug/iv_snapshots_YYYY-MM-DD.csv` exists and has > 1 line).

Open `http://localhost:3000/api/options/intelligence` in a browser.

Expected response shape (with data):
```json
{
  "success": true,
  "hasData": true,
  "date": "2026-07-03",
  "atm": 24300,
  "expiry": "2026-07-03",
  "current": {
    "net_gex": 450000,
    "pcr": 1.23,
    "atm_iv": 12.4,
    "iv_min": 10.2,
    "iv_max": 14.8,
    "pcr_30min_ago": 1.18
  },
  "gex_profile": [
    { "strike": 23800, "net_gex": -120000, "ce_gex": 50000, "pe_gex": 170000 },
    ...
  ],
  "gex_flip_strike": 24150,
  "timeline": [
    { "time": "09:15", "ts": 1751516100000, "pcr": 1.1, "atm_iv": 12.0, "net_gex": -200000 },
    ...
  ]
}
```

Checks:
- `gex_profile` has 21 entries (ATM±10 = 21 strikes of 50pt spacing)
- `gex_flip_strike` is a multiple of 50
- `timeline` entries are sorted chronologically by `ts`
- When snapshot CSV doesn't exist: `{ "success": true, "hasData": false, ... }` (not a 404 error)

- [ ] **Step 3: Verify no-data graceful response**

Temporarily call `http://localhost:3000/api/options/intelligence?date=2000-01-01`. Expected: `{ "success": true, "hasData": false, "timeline": [], "gex_profile": [] }` with status 200 (not an error response).

- [ ] **Step 4: Commit**

```bash
git add rs_dashboard/app/api/options/intelligence/route.ts
git commit -m "feat(options): add /api/options/intelligence route for GEX and regime signals"
```

---

## Task 2: `OptionsIntelligenceTab` Component

**Files:**
- Create: `rs_dashboard/components/OptionsIntelligenceTab.tsx`

**Interfaces:**
- Consumes:
  - `GET /api/options/chain?underlying=NIFTY&expiry={expiry}` → `{ success, data: { chain: { oc: Record<string, ChainEntry> }, spot: number } }`
  - `GET /api/options/intelligence` → shape from Task 1
- Produces: `export default function OptionsIntelligenceTab({ expiry }: { expiry: string })`

- [ ] **Step 1: Create the full component**

Create `rs_dashboard/components/OptionsIntelligenceTab.tsx`:

```tsx
'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  BarChart, Bar, Cell, LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';

// ─── Constants ────────────────────────────────────────────────────

const UNDERLYING  = 'NIFTY';
const LOT_SIZE    = 75;
const STRIKE_STEP = 50;
const CHAIN_POLL  = 30_000;  // 30 s
const INTEL_POLL  = 60_000;  // 60 s

// ─── Types ────────────────────────────────────────────────────────

interface ChainGreeks { gamma?: number; delta?: number; iv?: number }
interface ChainSide   { last_price?: number; oi?: number; implied_volatility?: number; greeks?: ChainGreeks }
interface ChainEntry  { ce?: ChainSide; pe?: ChainSide }

interface GexProfileEntry { strike: number; net_gex: number; ce_gex: number; pe_gex: number }

interface IntelCurrent {
  net_gex: number; pcr: number; atm_iv: number;
  iv_min: number; iv_max: number; pcr_30min_ago: number | null;
}

interface IntelResponse {
  success: boolean; hasData: boolean; date: string; atm: number; expiry: string;
  current: IntelCurrent | null;
  gex_profile: GexProfileEntry[];
  gex_flip_strike: number | null;
  timeline: Array<{ time: string; ts: number; pcr: number; atm_iv: number; net_gex: number }>;
}

// ─── Helpers ──────────────────────────────────────────────────────

function fmtGex(n: number): string {
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '+';
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(1)}L`;
  return `${sign}${abs.toLocaleString('en-IN')}`;
}

function fmtStrike(n: number): string {
  return n.toLocaleString('en-IN');
}

// Compute GEX profile from chain API data when no snapshot history
function computeGexFromChain(
  oc: Record<string, ChainEntry>, atm: number, spot: number, wings: number,
): GexProfileEntry[] {
  const wingRange = wings * STRIKE_STEP;
  return Object.entries(oc)
    .map(([key, entry]) => ({ strike: Number(key), entry }))
    .filter(({ strike }) => !isNaN(strike) && Math.abs(strike - atm) <= wingRange)
    .sort((a, b) => a.strike - b.strike)
    .map(({ strike, entry }) => {
      const ceOI    = entry.ce?.oi ?? 0;
      const peOI    = entry.pe?.oi ?? 0;
      const ceGamma = entry.ce?.greeks?.gamma ?? 0;
      const peGamma = entry.pe?.greeks?.gamma ?? 0;
      const ce_gex  = Math.round(ceOI * ceGamma * LOT_SIZE);
      const pe_gex  = Math.round(peOI * peGamma * LOT_SIZE);
      const net_gex = Math.round((ce_gex - pe_gex) * spot / 100);
      return { strike, net_gex, ce_gex, pe_gex };
    });
}

// Max pain — same algorithm as OptionsSmartChainTab
function computeMaxPain(entries: Array<{ strike: number; entry: ChainEntry }>): number {
  if (!entries.length) return 0;
  let maxPain = entries[0].strike;
  let minPayout = Infinity;
  for (const { strike: K } of entries) {
    let payout = 0;
    for (const { strike: s, entry } of entries) {
      payout += (entry.ce?.oi ?? 0) * Math.max(0, K - s);
      payout += (entry.pe?.oi ?? 0) * Math.max(0, s - K);
    }
    if (payout < minPayout) { minPayout = payout; maxPain = K; }
  }
  return maxPain;
}

function computeGexFlipStrike(profile: GexProfileEntry[]): number | null {
  let cumGex = 0;
  for (const { strike, net_gex } of profile) {
    const prevSign = cumGex === 0 ? 0 : Math.sign(cumGex);
    cumGex += net_gex;
    if (prevSign !== 0 && Math.sign(cumGex) !== prevSign) return strike;
  }
  return null;
}

function deriveRegime(netGex: number, atmIV: number, ivMin: number, ivMax: number, hasData: boolean) {
  if (!hasData || atmIV === 0) return { label: 'Indecisive', color: 'text-zinc-400', dot: 'bg-zinc-500' };
  const ivRange       = ivMax - ivMin;
  const ivPercentile  = ivRange > 0.01 ? (atmIV - ivMin) / ivRange : 0;
  if (ivPercentile > 0.8)  return { label: 'Volatile',   color: 'text-red-400',   dot: 'bg-red-500'   };
  if (netGex > 0)           return { label: 'Pinning',    color: 'text-amber-400', dot: 'bg-amber-500' };
  if (netGex < 0)           return { label: 'Trending',   color: 'text-blue-400',  dot: 'bg-blue-500'  };
  return { label: 'Indecisive', color: 'text-zinc-400', dot: 'bg-zinc-500' };
}

function deriveBias(pcr: number, pcr30: number | null) {
  const rising  = pcr30 !== null && pcr > pcr30;
  const falling = pcr30 !== null && pcr < pcr30;
  if (pcr > 1.3 && rising)  return { label: 'Bullish', color: 'text-emerald-400', dot: 'bg-emerald-500' };
  if (pcr < 0.7 && falling) return { label: 'Bearish', color: 'text-red-400',     dot: 'bg-red-500'     };
  return { label: 'Neutral', color: 'text-amber-400', dot: 'bg-amber-500' };
}

// ─── Sub-components ───────────────────────────────────────────────

function StatChip({ label, value, color = 'text-white' }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col px-4 border-r border-zinc-800 last:border-r-0">
      <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">{label}</span>
      <span className={`text-sm font-bold tabular-nums ${color}`}>{value}</span>
    </div>
  );
}

function KeyTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-lg px-4 py-3 flex flex-col gap-0.5">
      <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">{label}</span>
      <span className="text-xl font-bold tabular-nums text-white">{value}</span>
      {sub && <span className="text-xs text-zinc-500">{sub}</span>}
    </div>
  );
}

function GexTooltip({ active, payload }: Record<string, unknown>) {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const d = (payload[0] as { payload: GexProfileEntry }).payload;
  return (
    <div className="bg-zinc-950/95 border border-zinc-700/60 rounded-xl px-3.5 py-2.5 text-xs shadow-2xl min-w-[180px] backdrop-blur">
      <p className="text-zinc-300 font-bold mb-1.5">Strike {fmtStrike(d.strike)}</p>
      <div className="flex justify-between gap-4 mb-0.5">
        <span className="text-zinc-400">Net GEX</span>
        <span className={`font-bold tabular-nums ${d.net_gex >= 0 ? 'text-blue-400' : 'text-red-400'}`}>{fmtGex(d.net_gex)}</span>
      </div>
      <div className="flex justify-between gap-4 mb-0.5">
        <span className="text-zinc-400">CE GEX</span>
        <span className="text-blue-300 tabular-nums">{fmtGex(d.ce_gex)}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-zinc-400">PE GEX</span>
        <span className="text-red-300 tabular-nums">{fmtGex(d.pe_gex)}</span>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────

export default function OptionsIntelligenceTab({ expiry }: { expiry: string }) {
  const [intel, setIntel]       = useState<IntelResponse | null>(null);
  const [spot, setSpot]         = useState(0);
  const [atm, setAtm]           = useState(0);
  const [maxPain, setMaxPain]   = useState(0);
  const [ceWall, setCeWall]     = useState(0);
  const [peWall, setPeWall]     = useState(0);
  const [expectedMove, setExpectedMove] = useState<number>(0);
  const [gexProfile, setGexProfile]     = useState<GexProfileEntry[]>([]);
  const [gexFlipStrike, setGexFlipStrike] = useState<number | null>(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  const chainTimerRef = useRef<NodeJS.Timeout | null>(null);
  const intelTimerRef = useRef<NodeJS.Timeout | null>(null);

  const fetchIntel = useCallback(async () => {
    try {
      const res  = await fetch('/api/options/intelligence');
      const json = await res.json() as IntelResponse;
      if (json.success) setIntel(json);
    } catch {
      // silent — chain data still provides GEX profile
    }
  }, []);

  const fetchChain = useCallback(async () => {
    if (!expiry) return;
    setLoading(true);
    setError('');
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

      const spotPrice = json.data.spot ?? 0;
      const atmStrike = Math.round(spotPrice / STRIKE_STEP) * STRIKE_STEP;
      const oc        = json.data.chain.oc;

      setSpot(spotPrice);
      setAtm(atmStrike);

      // All entries for max pain
      const allEntries = Object.entries(oc)
        .map(([key, entry]) => ({ strike: Number(key), entry }))
        .filter(e => !isNaN(e.strike))
        .sort((a, b) => a.strike - b.strike);

      setMaxPain(computeMaxPain(allEntries));

      // CE/PE OI walls from ATM±10
      let maxCE = 0, maxPE = 0, ceW = 0, peW = 0;
      for (const { strike, entry } of allEntries) {
        if (Math.abs(strike - atmStrike) > 10 * STRIKE_STEP) continue;
        const ceOI = entry.ce?.oi ?? 0;
        const peOI = entry.pe?.oi ?? 0;
        if (ceOI > maxCE) { maxCE = ceOI; ceW = strike; }
        if (peOI > maxPE) { maxPE = peOI; peW = strike; }
      }
      setCeWall(ceW);
      setPeWall(peW);

      // Expected move from ATM straddle
      const atmEntry = allEntries.find(e => e.strike === atmStrike);
      const atmStraddle = (atmEntry?.entry?.ce?.last_price ?? 0) + (atmEntry?.entry?.pe?.last_price ?? 0);
      setExpectedMove(Math.round(atmStraddle));

      // GEX profile: use snapshot history if available, else compute from chain greeks
      if (intel?.hasData && intel.gex_profile.length > 0) {
        setGexProfile(intel.gex_profile);
        setGexFlipStrike(intel.gex_flip_strike);
      } else {
        const profile = computeGexFromChain(oc, atmStrike, spotPrice, 10);
        setGexProfile(profile);
        setGexFlipStrike(computeGexFlipStrike(profile));
      }
    } catch (err) {
      setError(`Fetch error: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [expiry, intel]);

  useEffect(() => {
    fetchIntel();
    intelTimerRef.current = setInterval(fetchIntel, INTEL_POLL);
    return () => { if (intelTimerRef.current) clearInterval(intelTimerRef.current); };
  }, [fetchIntel]);

  useEffect(() => {
    fetchChain();
    chainTimerRef.current = setInterval(fetchChain, CHAIN_POLL);
    return () => { if (chainTimerRef.current) clearInterval(chainTimerRef.current); };
  }, [fetchChain]);

  // ── Derived display values ──────────────────────────────────────

  const current    = intel?.current ?? null;
  const hasData    = intel?.hasData ?? false;
  const netGex     = current?.net_gex ?? (gexProfile.reduce((s, e) => s + e.net_gex, 0));
  const pcr        = current?.pcr ?? 0;
  const atmIV      = current?.atm_iv ?? 0;
  const ivMin      = current?.iv_min ?? 0;
  const ivMax      = current?.iv_max ?? 0;
  const pcr30      = current?.pcr_30min_ago ?? null;
  const timeline   = intel?.timeline ?? [];

  const regime     = deriveRegime(netGex, atmIV, ivMin, ivMax, hasData);
  const bias       = deriveBias(pcr, pcr30);

  const ivRangeStr = ivMin > 0 && ivMax > 0 ? `${ivMin.toFixed(1)}–${ivMax.toFixed(1)}%` : '—';
  const emStr      = expectedMove > 0 ? `±${fmtStrike(expectedMove)}` : '—';
  const rangeStr   = expectedMove > 0 && atm > 0
    ? `${fmtStrike(atm - expectedMove)}–${fmtStrike(atm + expectedMove)}`
    : '—';

  // X-axis domain 09:15–15:30 IST
  const SESSION_START = new Date(`${(intel?.date ?? new Date().toISOString().slice(0, 10))}T09:15:00+05:30`).getTime();
  const SESSION_END   = new Date(`${(intel?.date ?? new Date().toISOString().slice(0, 10))}T15:30:00+05:30`).getTime();

  return (
    <div className="flex flex-col gap-5">

      {error && (
        <div className="px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">{error}</div>
      )}

      {/* ① Regime Header */}
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          {/* Market Regime tile */}
          <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl px-5 py-4 flex flex-col gap-2">
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Market Regime</span>
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${regime.dot}`} />
              <span className={`text-2xl font-bold ${regime.color}`}>{regime.label}</span>
            </div>
            <p className="text-[10px] text-zinc-500 leading-relaxed">
              {regime.label === 'Pinning'    ? 'Dealers net long gamma — expect mean reversion. Straddles favoured.' :
               regime.label === 'Trending'   ? 'Dealers net short gamma — expect directional moves. Avoid naked straddles.' :
               regime.label === 'Volatile'   ? 'IV at intraday high — elevated premium. Consider spreads over naked.' :
               'Insufficient snapshot data to classify regime.'}
            </p>
          </div>
          {/* Directional Bias tile */}
          <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl px-5 py-4 flex flex-col gap-2">
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Directional Bias</span>
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${bias.dot}`} />
              <span className={`text-2xl font-bold ${bias.color}`}>{bias.label}</span>
            </div>
            <p className="text-[10px] text-zinc-500 leading-relaxed">
              {bias.label === 'Bullish' ? `PCR ${pcr.toFixed(2)} rising — put writers defending support.` :
               bias.label === 'Bearish' ? `PCR ${pcr.toFixed(2)} falling — call writers defending resistance.` :
               `PCR ${pcr > 0 ? pcr.toFixed(2) : '—'} — no clear directional pressure.`}
            </p>
          </div>
        </div>
        {/* Stat chips */}
        <div className="flex items-center py-2 bg-zinc-900/40 border border-zinc-800/50 rounded-xl">
          <StatChip label="Net GEX" value={netGex !== 0 ? fmtGex(netGex) : '—'} color={netGex > 0 ? 'text-blue-400' : netGex < 0 ? 'text-red-400' : 'text-zinc-400'} />
          <StatChip label="Chain PCR" value={pcr > 0 ? pcr.toFixed(2) : '—'} color={pcr > 1.3 ? 'text-emerald-400' : pcr < 0.7 ? 'text-red-400' : 'text-amber-400'} />
          <StatChip label="ATM IV" value={atmIV > 0 ? `${atmIV.toFixed(1)}%` : '—'} />
          <StatChip label="IV Range" value={ivRangeStr} />
        </div>
      </div>

      {/* ② GEX Profile */}
      <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-bold text-white uppercase tracking-widest">GEX Profile</span>
          <div className="flex items-center gap-4 text-[10px] text-zinc-500">
            <span><span className="inline-block w-2 h-2 rounded-sm bg-blue-500 mr-1" />Stabilising</span>
            <span><span className="inline-block w-2 h-2 rounded-sm bg-red-500 mr-1" />Amplifying</span>
          </div>
        </div>
        {gexProfile.length === 0 ? (
          <div className="h-[300px] flex items-center justify-center text-zinc-600 text-xs">
            {loading ? 'Loading…' : 'No GEX data'}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={gexProfile} margin={{ top: 8, right: 16, bottom: 40, left: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
              <XAxis
                dataKey="strike"
                tick={{ fill: '#a1a1aa', fontSize: 9 }}
                angle={-45}
                textAnchor="end"
                tickFormatter={s => String(s)}
                interval={0}
              />
              <YAxis
                tick={{ fill: '#a1a1aa', fontSize: 9 }}
                tickFormatter={v => fmtGex(Number(v))}
                width={72}
              />
              <Tooltip content={<GexTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
              <ReferenceLine y={0} stroke="#52525b" strokeWidth={1.5} />
              {atm > 0 && (
                <ReferenceLine x={atm} stroke="#f59e0b" strokeDasharray="4 2"
                  label={{ value: 'ATM', fill: '#f59e0b', fontSize: 9, position: 'insideTopLeft' }} />
              )}
              {maxPain > 0 && maxPain !== atm && (
                <ReferenceLine x={maxPain} stroke="#a78bfa" strokeDasharray="4 2"
                  label={{ value: 'MaxPain', fill: '#a78bfa', fontSize: 9, position: 'insideTopRight' }} />
              )}
              {gexFlipStrike && (
                <ReferenceLine x={gexFlipStrike} stroke="#22d3ee" strokeDasharray="4 2"
                  label={{ value: 'GEX Flip', fill: '#22d3ee', fontSize: 9, position: 'insideTopLeft' }} />
              )}
              <Bar dataKey="net_gex" name="Net GEX" maxBarSize={28}>
                {gexProfile.map(({ strike, net_gex }) => (
                  <Cell key={strike} fill={net_gex >= 0 ? '#3b82f6' : '#ef4444'} fillOpacity={0.8} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ③ Intraday Signal Timeline */}
      <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-xl p-4">
        <span className="text-xs font-bold text-white uppercase tracking-widest">Intraday Signals</span>
        {!hasData || timeline.length < 2 ? (
          <div className="mt-4 flex items-center gap-2 text-xs text-zinc-500">
            <span className="w-2 h-2 rounded-full bg-zinc-600 flex-shrink-0" />
            Intraday signals require the snapshot collector — start it from the{' '}
            <a href="/iv-charts" className="text-blue-400 underline underline-offset-2">IV Charts page</a>.
          </div>
        ) : (
          <div className="flex flex-col gap-3 mt-3">
            {/* PCR */}
            <div>
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider">PCR</span>
              <ResponsiveContainer width="100%" height={150}>
                <LineChart data={timeline} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis dataKey="ts" type="number" scale="time" domain={[SESSION_START, SESSION_END]}
                    tickFormatter={ts => new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
                    tick={{ fill: '#71717a', fontSize: 9 }} ticks={[...Array(7)].map((_, i) => SESSION_START + i * 60 * 60 * 1000)} />
                  <YAxis tick={{ fill: '#71717a', fontSize: 9 }} width={36} domain={['auto', 'auto']} />
                  <Tooltip
                    labelFormatter={ts => new Date(Number(ts)).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
                    contentStyle={{ background: '#09090b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 11 }}
                    labelStyle={{ color: '#a1a1aa' }} />
                  <ReferenceLine y={1.3} stroke="#10b981" strokeDasharray="3 2" strokeOpacity={0.5} />
                  <ReferenceLine y={0.7} stroke="#ef4444" strokeDasharray="3 2" strokeOpacity={0.5} />
                  <Line type="monotone" dataKey="pcr" stroke="#f59e0b" strokeWidth={1.5} dot={false} name="PCR" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {/* ATM IV */}
            <div>
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider">ATM IV (%)</span>
              <ResponsiveContainer width="100%" height={150}>
                <LineChart data={timeline} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis dataKey="ts" type="number" scale="time" domain={[SESSION_START, SESSION_END]}
                    tickFormatter={ts => new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
                    tick={{ fill: '#71717a', fontSize: 9 }} ticks={[...Array(7)].map((_, i) => SESSION_START + i * 60 * 60 * 1000)} />
                  <YAxis tick={{ fill: '#71717a', fontSize: 9 }} width={36} domain={['auto', 'auto']} />
                  <Tooltip
                    labelFormatter={ts => new Date(Number(ts)).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
                    contentStyle={{ background: '#09090b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 11 }}
                    labelStyle={{ color: '#a1a1aa' }} />
                  <Line type="monotone" dataKey="atm_iv" stroke="#60a5fa" strokeWidth={1.5} dot={false} name="ATM IV" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {/* Net GEX */}
            <div>
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Net GEX</span>
              <ResponsiveContainer width="100%" height={150}>
                <AreaChart data={timeline} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
                  <defs>
                    <linearGradient id="gexGreen" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.05} />
                    </linearGradient>
                    <linearGradient id="gexRed" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#ef4444" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis dataKey="ts" type="number" scale="time" domain={[SESSION_START, SESSION_END]}
                    tickFormatter={ts => new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
                    tick={{ fill: '#71717a', fontSize: 9 }} ticks={[...Array(7)].map((_, i) => SESSION_START + i * 60 * 60 * 1000)} />
                  <YAxis tick={{ fill: '#71717a', fontSize: 9 }} width={48} tickFormatter={v => fmtGex(Number(v))} />
                  <Tooltip
                    labelFormatter={ts => new Date(Number(ts)).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
                    formatter={(v: number) => [fmtGex(v), 'Net GEX']}
                    contentStyle={{ background: '#09090b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 11 }}
                    labelStyle={{ color: '#a1a1aa' }} />
                  <ReferenceLine y={0} stroke="#52525b" strokeWidth={1.5} />
                  <Area type="monotone" dataKey="net_gex" stroke="#10b981" strokeWidth={1.5} dot={false}
                    fill="url(#gexGreen)" name="Net GEX" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      {/* ④ Key Levels */}
      <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-xl p-4">
        <span className="text-xs font-bold text-white uppercase tracking-widest">Key Levels</span>
        <div className="grid grid-cols-3 gap-3 mt-3">
          <KeyTile label="Max Pain" value={maxPain > 0 ? fmtStrike(maxPain) : '—'} sub="option payout minimum" />
          <KeyTile label="GEX Flip Strike" value={gexFlipStrike ? fmtStrike(gexFlipStrike) : '—'} sub="gamma sign change" />
          <KeyTile label="Expected Move" value={emStr} sub={rangeStr} />
          <KeyTile label="PE OI Wall" value={peWall > 0 ? fmtStrike(peWall) : '—'} sub="highest PE open interest" />
          <KeyTile label="CE OI Wall" value={ceWall > 0 ? fmtStrike(ceWall) : '—'} sub="highest CE open interest" />
          <KeyTile label="IV Range" value={ivRangeStr} sub="intraday ATM IV min–max" />
        </div>
      </div>

    </div>
  );
}
```

- [ ] **Step 2: Verify component renders without TypeScript errors**

```bash
cd rs_dashboard && npx tsc --noEmit
```

Expected: exit 0 (no type errors). Fix any type errors before continuing.

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/components/OptionsIntelligenceTab.tsx
git commit -m "feat(options): add OptionsIntelligenceTab component with GEX regime panel"
```

---

## Task 3: Wire Intelligence Tab into `OptionsCharts.tsx`

**Files:**
- Modify: `rs_dashboard/components/OptionsCharts.tsx`

**Interfaces:**
- Consumes: `OptionsIntelligenceTab` component (from Task 2)
- Produces: working 6th tab in the options page

- [ ] **Step 1: Add import**

In `rs_dashboard/components/OptionsCharts.tsx`, find the existing imports block (lines 11–13):
```tsx
import OptionsSkewTab from './OptionsSkewTab';
import OptionsOITab from './OptionsOITab';
import OptionsCumulativeOITab from './OptionsCumulativeOITab';
import OptionsSmartChainTab from './OptionsSmartChainTab';
```

Add one line after:
```tsx
import OptionsSkewTab from './OptionsSkewTab';
import OptionsOITab from './OptionsOITab';
import OptionsCumulativeOITab from './OptionsCumulativeOITab';
import OptionsSmartChainTab from './OptionsSmartChainTab';
import OptionsIntelligenceTab from './OptionsIntelligenceTab';
```

- [ ] **Step 2: Extend the activeTab union type**

On line 165:
```tsx
// before
const [activeTab, setActiveTab] = useState<'premium' | 'skew' | 'oi' | 'cumulative' | 'chain'>('premium');
```
Change to:
```tsx
// after
const [activeTab, setActiveTab] = useState<'premium' | 'skew' | 'oi' | 'cumulative' | 'chain' | 'intelligence'>('premium');
```

- [ ] **Step 3: Add the tab button**

Find the tab bar array (lines 574–580):
```tsx
{([
  { key: 'premium',    label: 'Premium'       },
  { key: 'skew',       label: 'Skew'          },
  { key: 'oi',         label: 'Open Interest' },
  { key: 'cumulative', label: 'Cumulative OI' },
  { key: 'chain',      label: 'Smart Chain'   },
] as const).map(({ key, label }) => (
```

Replace with:
```tsx
{([
  { key: 'premium',      label: 'Premium'       },
  { key: 'skew',         label: 'Skew'          },
  { key: 'oi',           label: 'Open Interest' },
  { key: 'cumulative',   label: 'Cumulative OI' },
  { key: 'chain',        label: 'Smart Chain'   },
  { key: 'intelligence', label: 'Intelligence'  },
] as const).map(({ key, label }) => (
```

- [ ] **Step 4: Render the component**

Find line 598 (where Smart Chain is rendered):
```tsx
{activeTab === 'chain'      && <OptionsSmartChainTab   expiry={expiry} />}
```

Add immediately after:
```tsx
{activeTab === 'chain'      && <OptionsSmartChainTab   expiry={expiry} />}
{activeTab === 'intelligence' && <OptionsIntelligenceTab expiry={expiry} />}
```

- [ ] **Step 5: Verify TypeScript**

```bash
cd rs_dashboard && npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 6: Visual verification in browser**

With `npm run dev` running at `http://localhost:3000`:

1. Navigate to `/options`
2. Select any expiry from the dropdown
3. Click the **Intelligence** tab — it should appear after "Smart Chain"
4. **Regime Header**: Two badge tiles visible (Market Regime + Directional Bias). If snapshot collector is not running, regime shows "Indecisive".
5. **GEX Profile**: Bar chart renders with 21 bars (ATM±10), blue for positive, red for negative. ATM reference line visible.
6. **Intraday Timeline**: If snapshot collector has not been run, the placeholder message shows with a link to `/iv-charts`. If it has been run today, three stacked charts render.
7. **Key Levels**: 6-tile grid with Max Pain, GEX Flip Strike, Expected Move, PE OI Wall, CE OI Wall, IV Range. Max Pain and OI Wall values should match what Smart Chain tab shows.
8. Switching back to other tabs (Premium, Smart Chain) still works — no regressions.

- [ ] **Step 7: Commit**

```bash
git add rs_dashboard/components/OptionsCharts.tsx
git commit -m "feat(options): wire Intelligence tab into OptionsCharts page"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✓ Regime badge (Volatile / Pinning / Trending / Indecisive) — Task 2 `deriveRegime()`
- ✓ Directional bias badge (Bullish / Neutral / Bearish) — Task 2 `deriveBias()`
- ✓ Stat chips (Net GEX, PCR, ATM IV, IV Range) — Task 2 StatChip row
- ✓ GEX Profile bar chart with colored bars, zero line, ATM/MaxPain/GEX Flip references — Task 2 BarChart section
- ✓ Intraday timeline (PCR, ATM IV, Net GEX) with graceful degradation — Task 2 Section ③
- ✓ Key Levels grid (Max Pain, GEX Flip, Expected Move, PE Wall, CE Wall, IV Range) — Task 2 Section ④
- ✓ `/api/options/intelligence` route — Task 1
- ✓ `OptionsCharts.tsx` tab integration — Task 3
- ✓ Fallback: GEX profile computed from chain API when no snapshot data — Task 2 `computeGexFromChain()`
- ✓ `gex_flip_strike` validated as multiple of 50 — enforced by STRIKE_STEP alignment in the API

**Type consistency:**
- `GexProfileEntry` defined once at top of `OptionsIntelligenceTab.tsx` and used throughout — ✓
- `IntelResponse.gex_profile` is `GexProfileEntry[]` matching `computeGexFromChain` return type — ✓
- `computeGexFlipStrike` takes `GexProfileEntry[]` (same as produced by both code paths) — ✓
- `deriveRegime` / `deriveBias` return `{ label, color, dot }` — both used identically in JSX — ✓
