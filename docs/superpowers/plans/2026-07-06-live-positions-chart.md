# Live Positions Chart — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Positions" tab to the options page that plots combined net premium (sell legs minus buy legs) and VIX on a dual-axis live chart, polling the Dhan portfolio API every 3 s.

**Architecture:** A new API route (`/api/options/positions-live`) calls the Dhan REST API directly (no Python spawn) to fetch open positions and LTPs in two HTTP calls, plus VIX in the same OHLC call. A self-contained React component (`OptionsPositionsTab`) manages its own polling state and renders the dual-axis `ComposedChart`. `OptionsCharts.tsx` gets a minimal diff to wire in the new tab.

**Tech Stack:** Next.js App Router (TypeScript), Recharts (`ComposedChart`, `Line`, `YAxis` x2), Dhan REST API v2, Tailwind CSS

## Global Constraints

- Follow existing Tailwind patterns: `bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5` for card containers
- Table headers: `text-xs font-bold text-white bg-zinc-800`
- No text color opacity modifiers (`text-white/70` is forbidden — use solid zinc steps: `text-zinc-400`, `text-zinc-300`, etc.)
- Tooltip: use `ChartTooltip` component and `tooltipProps` pattern already used in `OptionsCharts.tsx`
- All `fetch` calls are client-side — no new server actions

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `rs_dashboard/app/api/options/positions-live/route.ts` | Fetch Dhan positions + LTPs + VIX, compute net premium, return JSON |
| Create | `rs_dashboard/components/OptionsPositionsTab.tsx` | Self-contained tab component: polling, chart, stat tiles, legs table |
| Modify | `rs_dashboard/components/OptionsCharts.tsx` | Add tab union type, tab button, import, conditional render |

---

## Task 1: API Route — `/api/options/positions-live`

**Files:**
- Create: `rs_dashboard/app/api/options/positions-live/route.ts`

**Interfaces:**
- Produces:
  ```ts
  GET /api/options/positions-live
  →
  {
    has_positions: boolean,
    net_premium: number,
    vix: number,
    legs: {
      symbol: string,
      strike: number,
      type: 'CE' | 'PE',
      side: 'SELL' | 'BUY',
      ltp: number,
      netQty: number,
    }[],
    timestamp: string,
    error?: 'auth' | 'api',
  }
  ```

- [ ] **Step 1: Create the route file with token helper and 2 s cache**

Create `rs_dashboard/app/api/options/positions-live/route.ts`:

```ts
import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const TOKEN_FILE    = path.join(process.cwd(), '..', 'access_token.json');
const POSITIONS_URL = 'https://api.dhan.co/v2/positions';
const OHLC_URL      = 'https://api.dhan.co/v2/marketfeed/ohlc';
const VIX_ID        = 21;

interface TokenCache { clientId: string; token: string; ts: number }
let tokenCache: TokenCache | null = null;
const TOKEN_TTL = 5 * 60 * 1000;

function getToken(): { clientId: string; token: string } | null {
  try {
    if (tokenCache && Date.now() - tokenCache.ts < TOKEN_TTL) {
      return { clientId: tokenCache.clientId, token: tokenCache.token };
    }
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as {
      dhanClientId: string;
      accessToken: string;
    };
    tokenCache = { clientId: raw.dhanClientId, token: raw.accessToken, ts: Date.now() };
    return { clientId: tokenCache.clientId, token: tokenCache.token };
  } catch {
    return null;
  }
}

interface RouteCache { data: unknown; ts: number }
let routeCache: RouteCache | null = null;
const ROUTE_TTL = 2000;

export async function GET() {
  // serve from cache if fresh
  if (routeCache && Date.now() - routeCache.ts < ROUTE_TTL) {
    return NextResponse.json(routeCache.data);
  }

  const auth = getToken();
  if (!auth) {
    const payload = { has_positions: false, net_premium: 0, vix: 0, legs: [], timestamp: new Date().toISOString(), error: 'auth' };
    return NextResponse.json(payload);
  }

  const headers = {
    'access-token': auth.token,
    'client-id':    auth.clientId,
    'Content-Type': 'application/json',
    'Accept':       'application/json',
  };

  // ── Step A: fetch open positions ──────────────────────────────────
  let rawPositions: DhanPosition[] = [];
  try {
    const res = await fetch(POSITIONS_URL, {
      headers,
      signal: AbortSignal.timeout(6000),
    });
    const json = await res.json() as DhanPosition[] | { data?: DhanPosition[] };
    // SDK wraps in { data: [...] } or returns array directly
    rawPositions = Array.isArray(json) ? json : (json as { data?: DhanPosition[] }).data ?? [];
  } catch {
    const payload = { has_positions: false, net_premium: 0, vix: 0, legs: [], timestamp: new Date().toISOString(), error: 'api' };
    return NextResponse.json(payload);
  }

  // filter to options legs only
  const optLegs = rawPositions.filter(p =>
    (/-CE-|-PE-/i.test(p.tradingSymbol ?? '')) && (p.netQty ?? 0) !== 0
  );

  // ── Step B: fetch LTPs for option legs + VIX in one OHLC call ────
  // Group security IDs by exchange segment; options are NSE_FNO
  const secIds: number[] = optLegs.map(p => Number(p.securityId)).filter(Boolean);

  const ohlcBody: Record<string, number[]> = { NSE_IDX: [VIX_ID] };
  if (secIds.length > 0) ohlcBody['NSE_FNO'] = secIds;

  let ltpMap: Record<string, number> = {};
  let vix = 0;
  try {
    const res = await fetch(OHLC_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(ohlcBody),
      signal: AbortSignal.timeout(6000),
    });
    const json = await res.json() as {
      status?: string;
      data?: Record<string, Record<string, { last_price?: number }>>;
    };
    if (json.status === 'success' && json.data) {
      vix = json.data?.NSE_IDX?.[String(VIX_ID)]?.last_price ?? 0;
      const fnoData = json.data?.NSE_FNO ?? {};
      for (const [id, entry] of Object.entries(fnoData)) {
        ltpMap[id] = entry.last_price ?? 0;
      }
    }
  } catch {
    // VIX and LTPs will be 0; proceed with what we have
  }

  // ── Step C: build legs + compute net premium ──────────────────────
  type Leg = {
    symbol: string; strike: number; type: 'CE' | 'PE';
    side: 'SELL' | 'BUY'; ltp: number; netQty: number;
  };

  let netPremium = 0;
  const legs: Leg[] = optLegs.map(p => {
    const ltp  = ltpMap[String(p.securityId)] ?? (p.lastPrice ?? 0);
    const qty  = p.netQty ?? 0;
    const side: 'SELL' | 'BUY' = qty < 0 ? 'SELL' : 'BUY';
    const sym  = p.tradingSymbol ?? '';
    const cepe = /-CE-/i.test(sym) ? 'CE' : 'PE';

    // Extract strike from symbol e.g. "NIFTY-CE-24500-25JUL25" → 24500
    const strikeMatch = sym.match(/-(CE|PE)-(\d+)-/i);
    const strike = strikeMatch ? Number(strikeMatch[2]) : 0;

    netPremium += side === 'SELL' ? ltp : -ltp;

    return { symbol: sym, strike, type: cepe, side, ltp, netQty: qty };
  });

  const payload = {
    has_positions: legs.length > 0,
    net_premium: Math.round(netPremium * 100) / 100,
    vix: Math.round(vix * 100) / 100,
    legs,
    timestamp: new Date().toISOString(),
  };

  routeCache = { data: payload, ts: Date.now() };
  return NextResponse.json(payload);
}

// ── Dhan position shape (v2 API) ──────────────────────────────────
interface DhanPosition {
  tradingSymbol?: string;
  securityId?: string | number;
  netQty?: number;
  lastPrice?: number;
  exchangeSegment?: string;
}
```

- [ ] **Step 2: Verify the route starts without type errors**

```powershell
cd rs_dashboard
npx tsc --noEmit 2>&1 | Select-String "positions-live"
```

Expected: no output (no errors in the new file). If errors appear, fix types before proceeding.

- [ ] **Step 3: Smoke-test the route with curl (dev server must be running)**

```powershell
cd rs_dashboard
npm run dev
# In a second terminal:
curl http://localhost:3000/api/options/positions-live
```

Expected response shape (no positions case):
```json
{"has_positions":false,"net_premium":0,"vix":14.5,"legs":[],"timestamp":"..."}
```
VIX should be a non-zero number if market is open or yesterday's close.

- [ ] **Step 4: Commit**

```powershell
git add rs_dashboard/app/api/options/positions-live/route.ts
git commit -m "feat(options): add positions-live API route with Dhan positions + LTPs + VIX"
```

---

## Task 2: `OptionsPositionsTab` Component

**Files:**
- Create: `rs_dashboard/components/OptionsPositionsTab.tsx`

**Interfaces:**
- Consumes: `GET /api/options/positions-live` (from Task 1)
- Produces: `export default function OptionsPositionsTab(): JSX.Element`

**Poll interval feature (added per user requirement):**
- Poll interval selector in the component UI: `5s | 10s | 20s | 30s | Live`
- "Live" = 2 s polling (fastest rate)
- Default: 5 s
- When the interval changes, the existing `setInterval` is cleared and restarted at the new rate
- Selector style matches the premium tab's interval toggle: `bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl` with active state `bg-zinc-700 text-zinc-200 border border-zinc-600`; "Live" active state uses `bg-blue-500/10 text-blue-400 border border-blue-500/20`

- [ ] **Step 1: Create the component file**

Create `rs_dashboard/components/OptionsPositionsTab.tsx`:

```tsx
'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';

const POLL_OPTIONS = [
  { label: '5s',   ms: 5000  },
  { label: '10s',  ms: 10000 },
  { label: '20s',  ms: 20000 },
  { label: '30s',  ms: 30000 },
  { label: 'Live', ms: 2000  },
] as const;
type PollMs = typeof POLL_OPTIONS[number]['ms'];

// ── Types ────────────────────────────────────────────────────────────

interface Leg {
  symbol: string;
  strike: number;
  type: 'CE' | 'PE';
  side: 'SELL' | 'BUY';
  ltp: number;
  netQty: number;
}

interface ApiResponse {
  has_positions: boolean;
  net_premium: number;
  vix: number;
  legs: Leg[];
  timestamp: string;
  error?: string;
}

interface DataPoint {
  time: string;
  netPremium: number;
  vix: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return iso.slice(11, 19);
  }
}

function fmtNum(n: number, dec = 2): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}

// ── Custom tooltip ───────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-zinc-950/95 border border-zinc-700 rounded-xl px-3 py-2 text-xs shadow-xl">
      <p className="text-zinc-400 mb-1 font-medium">{label}</p>
      {payload.map(p => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
          <span className="text-zinc-300">{p.name}:</span>
          <span className="text-white font-semibold">{fmtNum(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Stat tile ────────────────────────────────────────────────────────

function StatTile({ label, value, sub, valueClass }: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 min-w-[130px]">
      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1">{label}</p>
      <p className={`text-lg font-bold ${valueClass ?? 'text-white'}`}>{value}</p>
      {sub && <p className="text-[10px] text-zinc-500 mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────

export default function OptionsPositionsTab() {
  const [dataPoints, setDataPoints]   = useState<DataPoint[]>([]);
  const [legs, setLegs]               = useState<Leg[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [pollMs, setPollMs]           = useState<PollMs>(5000);
  const entryPremiumRef               = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res  = await fetch('/api/options/positions-live');
        const data = await res.json() as ApiResponse;
        if (cancelled) return;

        if (data.error === 'auth') {
          setError('Authentication error — run login.py to refresh the access token.');
          setLoading(false);
          return;
        }
        if (data.error === 'api') {
          setError('Could not reach the Dhan API. Check connectivity.');
          setLoading(false);
          return;
        }

        setLegs(data.legs);
        setLoading(false);
        setError(null);

        if (!data.has_positions) return;

        // lock entry premium to first non-zero value
        if (entryPremiumRef.current === null && data.net_premium !== 0) {
          entryPremiumRef.current = data.net_premium;
        }

        const point: DataPoint = {
          time:       fmtTime(data.timestamp),
          netPremium: data.net_premium,
          vix:        data.vix,
        };
        setDataPoints(prev => [...prev, point]);
      } catch {
        if (!cancelled) setError('Network error fetching positions.');
      }
    }

    poll(); // immediate first call
    const id = setInterval(poll, pollMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [pollMs]); // restart interval when poll rate changes

  // ── Derived values ───────────────────────────────────────────────

  const latest       = dataPoints[dataPoints.length - 1];
  const entryPremium = entryPremiumRef.current;
  const netPremium   = latest?.netPremium ?? 0;
  const vix          = latest?.vix ?? 0;
  const changeFromEntry = entryPremium !== null ? netPremium - entryPremium : null;

  // For a net-sell position, premium decreasing is good (profit)
  // "improving" = net_premium falling when net sell; rising when net buy
  // We colour by direction of change relative to entry
  const changeBeneficial = changeFromEntry !== null && changeFromEntry < 0;
  const changeColour = changeFromEntry === null
    ? 'text-zinc-400'
    : changeBeneficial ? 'text-emerald-400' : 'text-red-400';

  // Y axis domain helpers — add 10 % padding
  const premiums = dataPoints.map(d => d.netPremium);
  const vixes    = dataPoints.map(d => d.vix);
  const premiumDomain = premiums.length > 1
    ? [
        Math.floor(Math.min(...premiums) * 0.9),
        Math.ceil(Math.max(...premiums)  * 1.1),
      ]
    : ['auto', 'auto'];
  const vixDomain = vixes.length > 1
    ? [
        Math.floor(Math.min(...vixes) * 0.95 * 10) / 10,
        Math.ceil( Math.max(...vixes) * 1.05 * 10) / 10,
      ]
    : ['auto', 'auto'];

  // ── Render ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-400 text-sm">
        <svg className="animate-spin h-5 w-5 mr-2 text-emerald-400" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        Loading positions…
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-2 mt-4 px-4 py-3 bg-red-900/20 border border-red-700/40 rounded-xl text-sm text-red-400">
        {error}
      </div>
    );
  }

  if (!legs.length) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-500 text-sm">
        No open F&amp;O option positions
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">

      {/* Stat row */}
      <div className="flex gap-3 flex-wrap">
        <StatTile
          label="Net Premium"
          value={fmtNum(netPremium)}
          sub={netPremium >= 0 ? 'Net credit' : 'Net debit'}
          valueClass={netPremium >= 0 ? 'text-emerald-400' : 'text-red-400'}
        />
        <StatTile
          label="Change from Entry"
          value={changeFromEntry !== null ? (changeFromEntry >= 0 ? '+' : '') + fmtNum(changeFromEntry) : '—'}
          sub={entryPremium !== null ? `Entry: ${fmtNum(entryPremium)}` : undefined}
          valueClass={changeColour}
        />
        <StatTile
          label="India VIX"
          value={fmtNum(vix)}
          valueClass="text-amber-400"
        />
        <StatTile
          label="Open Legs"
          value={String(legs.length)}
          valueClass="text-zinc-200"
        />
      </div>

      {/* Dual-axis chart */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
        <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-white">Combined Premium vs VIX</h3>
            <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              LIVE
            </span>
          </div>
          {/* Poll interval selector */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl">
            {POLL_OPTIONS.map(({ label, ms }) => (
              <button
                key={label}
                onClick={() => setPollMs(ms)}
                className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  pollMs === ms
                    ? label === 'Live'
                      ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                      : 'bg-zinc-700 text-zinc-200 border border-zinc-600'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {dataPoints.length < 2 ? (
          <div className="flex items-center justify-center h-[420px] text-zinc-500 text-sm">
            Collecting data…
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={420}>
            <ComposedChart data={dataPoints} margin={{ top: 5, right: 60, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
              <XAxis
                dataKey="time"
                tick={{ fill: '#71717a', fontSize: 11 }}
                axisLine={{ stroke: '#3f3f46' }}
                tickLine={false}
                minTickGap={60}
              />
              <YAxis
                yAxisId="premium"
                domain={premiumDomain as [number, number]}
                tick={{ fill: '#71717a', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={55}
                tickFormatter={(v: number) => v.toFixed(0)}
              />
              <YAxis
                yAxisId="vix"
                orientation="right"
                domain={vixDomain as [number, number]}
                tick={{ fill: '#f59e0b', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={45}
                tickFormatter={(v: number) => v.toFixed(1)}
              />
              <Tooltip content={<ChartTooltip />} />
              <Legend
                wrapperStyle={{ fontSize: 12, paddingTop: 12 }}
                formatter={(value: string) => (
                  <span style={{ color: '#a1a1aa', fontSize: 11 }}>{value}</span>
                )}
              />

              {entryPremium !== null && (
                <ReferenceLine
                  yAxisId="premium"
                  y={entryPremium}
                  stroke="#ffffff"
                  strokeDasharray="4 3"
                  strokeOpacity={0.4}
                  label={{
                    value: 'Entry',
                    position: 'insideTopLeft',
                    fill: '#a1a1aa',
                    fontSize: 10,
                  }}
                />
              )}

              <Line
                yAxisId="premium"
                type="monotone"
                dataKey="netPremium"
                name="Net Premium"
                stroke="#10b981"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3 }}
              />
              <Line
                yAxisId="vix"
                type="monotone"
                dataKey="vix"
                name="India VIX"
                stroke="#f59e0b"
                strokeWidth={1.5}
                strokeDasharray="5 3"
                dot={false}
                activeDot={{ r: 3 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Positions table */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-zinc-800">
              <th className="text-left px-4 py-2.5 text-xs font-bold text-white">Symbol</th>
              <th className="text-center px-4 py-2.5 text-xs font-bold text-white">Strike</th>
              <th className="text-center px-4 py-2.5 text-xs font-bold text-white">Type</th>
              <th className="text-center px-4 py-2.5 text-xs font-bold text-white">Side</th>
              <th className="text-right px-4 py-2.5 text-xs font-bold text-white">LTP</th>
              <th className="text-right px-4 py-2.5 text-xs font-bold text-white">Qty</th>
            </tr>
          </thead>
          <tbody>
            {legs.map((leg, i) => (
              <tr key={i} className="border-t border-zinc-800 hover:bg-zinc-800/40 transition-colors">
                <td className="px-4 py-2.5 text-zinc-300 font-mono text-[11px]">{leg.symbol}</td>
                <td className="px-4 py-2.5 text-center text-zinc-200 font-semibold">{leg.strike.toLocaleString('en-IN')}</td>
                <td className="px-4 py-2.5 text-center">
                  <span className={`font-bold ${leg.type === 'CE' ? 'text-blue-400' : 'text-red-400'}`}>
                    {leg.type}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-center">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    leg.side === 'SELL'
                      ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                      : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                  }`}>
                    {leg.side}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right text-zinc-200 font-semibold">{fmtNum(leg.ltp)}</td>
                <td className="px-4 py-2.5 text-right text-zinc-400">{leg.netQty}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  );
}
```

- [ ] **Step 2: Check for TypeScript errors in the new component**

```powershell
cd rs_dashboard
npx tsc --noEmit 2>&1 | Select-String "OptionsPositionsTab"
```

Expected: no output. Fix any type errors before continuing.

- [ ] **Step 3: Commit**

```powershell
git add rs_dashboard/components/OptionsPositionsTab.tsx
git commit -m "feat(options): add OptionsPositionsTab component with dual-axis premium/VIX chart"
```

---

## Task 3: Wire Positions Tab into `OptionsCharts.tsx`

**Files:**
- Modify: `rs_dashboard/components/OptionsCharts.tsx`

**Interfaces:**
- Consumes: `OptionsPositionsTab` (default export from Task 2)

Three surgical edits to `OptionsCharts.tsx`:

- [ ] **Step 1: Add import at the top of the imports block**

Find this line (around line 18):
```ts
import OptionsPCDiffTab from './OptionsPCDiffTab';
```
Add immediately after:
```ts
import OptionsPositionsTab from './OptionsPositionsTab';
```

- [ ] **Step 2: Extend the activeTab union type (line 170)**

Find:
```ts
const [activeTab, setActiveTab] = useState<'premium' | 'skew' | 'oi' | 'cumulative' | 'chain' | 'intelligence' | 'vix' | 'buildup' | 'multistrike' | 'pcdiff'>('premium');
```
Replace with:
```ts
const [activeTab, setActiveTab] = useState<'premium' | 'skew' | 'oi' | 'cumulative' | 'chain' | 'intelligence' | 'vix' | 'buildup' | 'multistrike' | 'pcdiff' | 'positions'>('premium');
```

- [ ] **Step 3: Hide header controls when `positions` tab is active**

The expiry `<select>` is already hidden on `vix` (line 512: `activeTab !== 'vix'`). Extend all four control guards to also hide on `positions`:

Find:
```ts
          {activeTab !== 'vix' && (
```
Replace with:
```ts
          {activeTab !== 'vix' && activeTab !== 'positions' && (
```

Find:
```ts
          {(activeTab === 'premium' || activeTab === 'multistrike' || activeTab === 'pcdiff') && !isLive && (
```
(This condition already excludes `positions` implicitly — no change needed.)

Find:
```ts
          {(activeTab === 'premium' || activeTab === 'multistrike' || activeTab === 'pcdiff') && isLive && (
```
(Already excludes `positions` — no change needed.)

Find:
```ts
          {(activeTab === 'premium' || activeTab === 'multistrike' || activeTab === 'pcdiff') && (
```
(Already excludes `positions` — no change needed.)

Find:
```ts
          {(activeTab === 'premium' || activeTab === 'multistrike' || activeTab === 'pcdiff') && <StatusBadge status={bridgeStatus.status} />}
```
(Already excludes `positions` — no change needed.)

- [ ] **Step 4: Add the Positions tab button**

Find the tab array in the tab bar (starts around line 589). It ends with:
```ts
              { key: 'pcdiff',       label: 'PC Diff'      },
            ] as const).map(...)
```
Replace that closing line with:
```ts
              { key: 'pcdiff',       label: 'PC Diff'      },
              { key: 'positions',    label: 'Positions'    },
            ] as const).map(...)
```

- [ ] **Step 5: Add the conditional render**

Find:
```ts
          {activeTab === 'vix'          && <OptionsVixTab />}
```
Add a new line immediately after:
```ts
          {activeTab === 'positions'    && <OptionsPositionsTab />}
```

- [ ] **Step 6: TypeScript check**

```powershell
cd rs_dashboard
npx tsc --noEmit 2>&1 | Select-String "OptionsCharts"
```

Expected: no output.

- [ ] **Step 7: Commit**

```powershell
git add rs_dashboard/components/OptionsCharts.tsx
git commit -m "feat(options): wire Positions tab into OptionsCharts"
```

---

## Task 4: End-to-End Verification

- [ ] **Step 1: Start the dev server**

```powershell
cd rs_dashboard
npm run dev
```

Navigate to `http://localhost:3000/options`.

- [ ] **Step 2: Verify empty state**

Click the **Positions** tab. If no F&O positions are open you should see:

> "No open F&O option positions"

Confirm no JS console errors.

- [ ] **Step 3: Verify header controls are hidden**

While on the Positions tab, confirm the Expiry dropdown, candle-interval toggle, Go Live / Stop button, and bridge status badge are all absent from the header.

- [ ] **Step 4: Verify chart builds up (if market is open or positions are open)**

If positions are open:
- Stat tiles should populate within 3 s
- Chart should show at least two points after 6 s
- VIX line should appear on the right axis with amber tick labels
- Net Premium line should appear on the left axis with zinc tick labels
- Entry ReferenceLine should appear as a dashed white horizontal

- [ ] **Step 5: Verify tab switch resets state**

Switch to the Premium tab and back to Positions. Confirm the data points array is empty again (fresh series, no leftover history). This is expected React unmount/mount behavior.

- [ ] **Step 6: Final commit if any fixups were needed**

```powershell
git add -p
git commit -m "fix(options): positions tab verification fixups"
```
