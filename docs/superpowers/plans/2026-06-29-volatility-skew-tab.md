# Volatility Skew Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Skew" tab to the existing `/options` page showing the Nifty options IV smile chart, CE−PE differential chart, and raw data table, polling every 10 seconds.

**Architecture:** Reuse the existing `/api/options/chain` endpoint (reduce its TTL to 10s); create a new `OptionsSkewTab.tsx` component; add a two-tab bar to the top of the existing `OptionsCharts.tsx` main content area.

**Tech Stack:** Next.js App Router, React 18, TypeScript, Recharts (already installed), Tailwind CSS.

## Global Constraints

- All files are under `rs_dashboard/` — run `npm run dev` from that directory.
- TypeScript strict mode is on — no `any`, no implicit undefined access.
- Tailwind only — no inline `style=` except where Recharts requires it (e.g., label fill/fontSize).
- Table headers: `text-xs font-bold text-white` on `bg-zinc-800` background (project convention).
- NIFTY strike step = 50; wing count = ±10 strikes (21 total).
- Chart colours: CE = `#60a5fa` (blue-400), PE = `#fbbf24` (amber-400).
- Do not add comments unless the why is non-obvious.

---

### Task 1: Reduce chain route cache TTL from 30 s to 10 s

**Files:**
- Modify: `rs_dashboard/app/api/options/chain/route.ts:13`

**Interfaces:**
- Produces: nothing consumed by later tasks; this is a standalone config change.

- [ ] **Step 1: Edit the constant**

  Open `rs_dashboard/app/api/options/chain/route.ts`. Find line 13:

  ```ts
  const CACHE_TTL = 30_000; // 30 s
  ```

  Change to:

  ```ts
  const CACHE_TTL = 10_000; // 10 s
  ```

- [ ] **Step 2: Verify TypeScript compiles**

  ```powershell
  cd rs_dashboard
  npx tsc --noEmit
  ```

  Expected: no errors.

- [ ] **Step 3: Commit**

  ```powershell
  git add rs_dashboard/app/api/options/chain/route.ts
  git commit -m "perf: reduce options chain cache TTL to 10s for skew polling"
  ```

---

### Task 2: Create OptionsSkewTab component

**Files:**
- Create: `rs_dashboard/components/OptionsSkewTab.tsx`

**Interfaces:**
- Consumes: `GET /api/options/chain?underlying=NIFTY&expiry=<string>` — response shape:
  ```ts
  { success: boolean; data?: { chain: { oc?: Record<string, OcEntry> }; spot: number }; error?: string }
  ```
  where `OcEntry = { ce?: OcSide; pe?: OcSide }` and `OcSide = { last_price?: number; implied_volatility?: number; greeks?: { iv?: number }; oi?: number }`.
- Produces: `export default function OptionsSkewTab({ expiry }: { expiry: string }): JSX.Element`

- [ ] **Step 1: Create the file with complete implementation**

  Create `rs_dashboard/components/OptionsSkewTab.tsx` with the following content:

  ```tsx
  'use client';

  import React, { useState, useEffect, useRef } from 'react';
  import {
    LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
    Tooltip, ResponsiveContainer, ReferenceLine, Cell, Legend,
  } from 'recharts';

  // ─── Types ────────────────────────────────────────────────────────

  interface SkewRow {
    strike: number;
    ceIV: number;
    peIV: number;
    diff: number;
    ceLTP: number;
    peLTP: number;
  }

  interface OcSide {
    last_price?: number;
    implied_volatility?: number;
    greeks?: { iv?: number };
    oi?: number;
  }

  interface OcEntry { ce?: OcSide; pe?: OcSide }

  // ─── Constants ────────────────────────────────────────────────────

  const UNDERLYING  = 'NIFTY';
  const STRIKE_STEP = 50;
  const WING_COUNT  = 10;
  const POLL_MS     = 10_000;

  // ─── Helpers ──────────────────────────────────────────────────────

  function getIV(side?: OcSide): number {
    if (!side) return 0;
    return side.implied_volatility ?? side.greeks?.iv ?? 0;
  }

  function fmtPct(n: number): string {
    return `${n.toFixed(2)}%`;
  }

  // ─── Tooltips ─────────────────────────────────────────────────────

  const SmileTooltip = ({ active, payload, label }: Record<string, unknown>) => {
    if (!active || !Array.isArray(payload) || !payload.length) return null;
    return (
      <div className="bg-zinc-950/95 border border-zinc-700/60 rounded-xl px-3.5 py-2.5 text-xs shadow-2xl backdrop-blur">
        <p className="text-zinc-400 mb-2 font-semibold">Strike {String(label)}</p>
        {(payload as Array<{ color: string; name: string; value: number }>).map(p => (
          <div key={p.name} className="flex justify-between gap-6 mb-0.5">
            <span style={{ color: p.color }} className="font-semibold">{p.name}</span>
            <span className="tabular-nums text-white font-bold">{fmtPct(p.value)}</span>
          </div>
        ))}
      </div>
    );
  };

  const DiffTooltip = ({ active, payload, label }: Record<string, unknown>) => {
    if (!active || !Array.isArray(payload) || !payload.length) return null;
    const val = (payload as Array<{ value: number }>)[0]?.value ?? 0;
    return (
      <div className="bg-zinc-950/95 border border-zinc-700/60 rounded-xl px-3.5 py-2.5 text-xs shadow-2xl backdrop-blur">
        <p className="text-zinc-400 mb-1 font-semibold">Strike {String(label)}</p>
        <p className={`font-bold tabular-nums ${val >= 0 ? 'text-blue-400' : 'text-amber-400'}`}>
          CE−PE: {val >= 0 ? '+' : ''}{fmtPct(val)}
        </p>
      </div>
    );
  };

  // ─── Main ─────────────────────────────────────────────────────────

  export default function OptionsSkewTab({ expiry }: { expiry: string }) {
    const [skewData, setSkewData]       = useState<SkewRow[]>([]);
    const [spot, setSpot]               = useState(0);
    const [atm, setAtm]                 = useState(0);
    const [lastUpdated, setLastUpdated] = useState<string | null>(null);
    const [loading, setLoading]         = useState(false);
    const [error, setError]             = useState('');
    const intervalRef = useRef<NodeJS.Timeout | null>(null);

    const fetchSkew = async () => {
      if (!expiry) return;
      try {
        const res  = await fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${expiry}`);
        const json = await res.json() as {
          success: boolean;
          data?: { chain: { oc?: Record<string, OcEntry> }; spot: number };
          error?: string;
        };

        if (!json.success || !json.data?.chain?.oc) {
          setError(json.error ?? 'No chain data');
          return;
        }

        const spotPrice = json.data.spot;
        const atmStrike = Math.round(spotPrice / STRIKE_STEP) * STRIKE_STEP;

        const rows: SkewRow[] = Object.entries(json.data.chain.oc)
          .map(([k, v]) => {
            const strike = Number(k);
            const ceIV   = getIV(v.ce);
            const peIV   = getIV(v.pe);
            return { strike, ceIV, peIV, diff: ceIV - peIV, ceLTP: v.ce?.last_price ?? 0, peLTP: v.pe?.last_price ?? 0 };
          })
          .filter(r => !isNaN(r.strike) && Math.abs(r.strike - atmStrike) <= WING_COUNT * STRIKE_STEP)
          .sort((a, b) => a.strike - b.strike);

        setSpot(spotPrice);
        setAtm(atmStrike);
        setSkewData(rows);
        setLastUpdated(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
        setError('');
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    };

    useEffect(() => {
      if (!expiry) return;
      setLoading(true);
      void fetchSkew();
      intervalRef.current = setInterval(() => { void fetchSkew(); }, POLL_MS);
      return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
    }, [expiry]);

    if (loading && !skewData.length) {
      return (
        <div className="flex items-center justify-center py-20 text-zinc-500 text-sm">
          Loading skew data…
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-4">

        {/* Status bar */}
        <div className="flex items-center gap-4 px-4 py-2 bg-zinc-900 rounded-lg border border-zinc-800">
          <span className="text-zinc-400 text-xs">
            Spot: <span className="text-white font-semibold tabular-nums">{spot > 0 ? spot.toLocaleString('en-IN') : '—'}</span>
          </span>
          <span className="text-zinc-400 text-xs">
            ATM: <span className="text-white font-semibold tabular-nums">{atm > 0 ? atm.toLocaleString('en-IN') : '—'}</span>
          </span>
          <span className="text-zinc-400 text-xs">
            Expiry: <span className="text-zinc-300 font-medium">{expiry}</span>
          </span>
          {lastUpdated && (
            <span className="text-zinc-400 text-xs">
              Updated: <span className="text-zinc-300 tabular-nums">{lastUpdated}</span>
            </span>
          )}
          {lastUpdated && (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              LIVE
            </span>
          )}
        </div>

        {error && (
          <div className="px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">
            {error}
          </div>
        )}

        {/* IV Smile */}
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
          <h3 className="text-xs font-bold text-white mb-3">IV Smile</h3>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={skewData} margin={{ top: 4, right: 24, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="4 4" stroke="#27272a" vertical={false} />
              <XAxis
                dataKey="strike"
                tick={{ fill: '#a1a1aa', fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: '#27272a' }}
              />
              <YAxis
                tick={{ fill: '#a1a1aa', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => `${v}%`}
              />
              <Tooltip content={<SmileTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1 }} />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
                formatter={(v: string) => <span style={{ color: '#d4d4d8', fontWeight: 600 }}>{v}</span>}
              />
              {atm > 0 && (
                <ReferenceLine
                  x={atm}
                  stroke="#a1a1aa"
                  strokeDasharray="4 4"
                  label={{ value: 'ATM', fill: '#a1a1aa', fontSize: 10, position: 'top' }}
                />
              )}
              <Line type="monotone" dataKey="ceIV" name="CE IV" stroke="#60a5fa" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="peIV" name="PE IV" stroke="#fbbf24" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* IV Differential */}
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
          <h3 className="text-xs font-bold text-white mb-3">IV Differential (CE − PE)</h3>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={skewData} margin={{ top: 4, right: 24, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="4 4" stroke="#27272a" vertical={false} />
              <XAxis
                dataKey="strike"
                tick={{ fill: '#a1a1aa', fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: '#27272a' }}
              />
              <YAxis
                tick={{ fill: '#a1a1aa', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => `${v}%`}
              />
              <Tooltip content={<DiffTooltip />} cursor={{ fill: '#27272a' }} />
              <ReferenceLine y={0} stroke="#a1a1aa" strokeWidth={1} />
              {atm > 0 && <ReferenceLine x={atm} stroke="#a1a1aa" strokeDasharray="4 4" />}
              <Bar dataKey="diff" name="CE−PE IV" radius={[2, 2, 0, 0]}>
                {skewData.map(row => (
                  <Cell key={row.strike} fill={row.diff >= 0 ? '#60a5fa' : '#fbbf24'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Raw data table */}
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-zinc-800">
              <tr>
                {['Strike', 'CE IV', 'PE IV', 'CE−PE', 'CE LTP', 'PE LTP'].map(h => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-bold text-white">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {skewData.map(row => (
                <tr
                  key={row.strike}
                  className={`border-t border-zinc-800/60 ${row.strike === atm ? 'bg-zinc-700/30' : 'hover:bg-zinc-800/30'}`}
                >
                  <td className="px-3 py-1.5 font-semibold tabular-nums text-zinc-200">
                    {row.strike.toLocaleString('en-IN')}
                    {row.strike === atm && (
                      <span className="ml-1.5 text-[10px] px-1 py-0.5 bg-zinc-700 rounded text-zinc-400">ATM</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 tabular-nums text-blue-400">{fmtPct(row.ceIV)}</td>
                  <td className="px-3 py-1.5 tabular-nums text-amber-400">{fmtPct(row.peIV)}</td>
                  <td className={`px-3 py-1.5 tabular-nums font-semibold ${row.diff >= 0 ? 'text-blue-400' : 'text-amber-400'}`}>
                    {row.diff >= 0 ? '+' : ''}{fmtPct(row.diff)}
                  </td>
                  <td className="px-3 py-1.5 tabular-nums text-zinc-300">{row.ceLTP.toFixed(1)}</td>
                  <td className="px-3 py-1.5 tabular-nums text-zinc-300">{row.peLTP.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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

  ```powershell
  git add rs_dashboard/components/OptionsSkewTab.tsx
  git commit -m "feat: add OptionsSkewTab component with IV smile, differential, and table"
  ```

---

### Task 3: Wire tab bar into OptionsCharts

**Files:**
- Modify: `rs_dashboard/components/OptionsCharts.tsx`

**Interfaces:**
- Consumes: `OptionsSkewTab({ expiry: string })` from Task 2
- Produces: `/options` page now has Premium | Skew tab bar

This task makes three targeted edits to `OptionsCharts.tsx`. Read the file before editing.

- [ ] **Step 1: Add import at the top of the file**

  Find the end of the existing imports block (after the last `import` statement, before `// ─── Types`). Add:

  ```ts
  import OptionsSkewTab from './OptionsSkewTab';
  ```

- [ ] **Step 2: Add activeTab state**

  Find the existing state declarations block (starts around `const [expiry, setExpiry]`). Add this line immediately after the last `useState` call in that block (before the first `useEffect`):

  ```ts
  const [activeTab, setActiveTab] = useState<'premium' | 'skew'>('premium');
  ```

- [ ] **Step 3: Add tab bar and conditional render**

  Find this exact line in the render section (around line 511):

  ```tsx
        <div className="flex-1 flex flex-col gap-4 px-6 py-5">
  ```

  Replace it with:

  ```tsx
        <div className="flex-1 flex flex-col gap-4 px-6 py-5">

          {/* Tab bar */}
          <div className="flex border-b border-zinc-800 -mx-6 px-6 -mt-5 mb-1">
            {(['premium', 'skew'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2.5 text-xs font-semibold capitalize transition-all border-b-2 -mb-px ${
                  activeTab === tab
                    ? 'text-white border-blue-500'
                    : 'text-zinc-400 border-transparent hover:text-zinc-200'
                }`}
              >
                {tab === 'premium' ? 'Premium' : 'Skew'}
              </button>
            ))}
          </div>

          {activeTab === 'skew' && <OptionsSkewTab expiry={expiries[0] ?? ''} />}

          {activeTab === 'premium' && <>
  ```

  Then find the closing `</div>` of that same `flex-1` div. It is the second-to-last `</div>` in the file (around line 775), right before the outer `</div>` that closes the entire component. Replace:

  ```tsx
        </div>
      </div>
  ```

  with:

  ```tsx
          </>}

        </div>
      </div>
  ```

  > **How to locate the right closing div:** Search for `</div>` at the end of the file. The structure is:
  > ```
  >   </div>   ← closes flex-1 content div  (edit this one)
  > </div>     ← closes outer component div
  > ```
  > The outer `</div>` is the very last one before `);` which ends the `return`.

- [ ] **Step 4: Verify TypeScript compiles**

  ```powershell
  cd rs_dashboard
  npx tsc --noEmit
  ```

  Expected: no errors.

- [ ] **Step 5: Start dev server and verify in browser**

  ```powershell
  cd rs_dashboard
  npm run dev
  ```

  Open `http://localhost:3000/options`. Verify:
  - Tab bar shows "Premium" and "Skew" at the top of the content area
  - "Premium" tab is selected by default; existing charts render normally
  - Clicking "Skew" shows the loading state then the skew content (status bar, two charts, table)
  - After ~10 seconds, the "Updated" timestamp in the status bar refreshes and the LIVE badge pulses
  - Clicking back to "Premium" restores the existing charts without any regression

- [ ] **Step 6: Commit**

  ```powershell
  git add rs_dashboard/components/OptionsCharts.tsx
  git commit -m "feat: add Premium/Skew tab bar to options page"
  ```

---

## Self-Review Checklist

**Spec coverage:**
- [x] IV smile chart (CE IV + PE IV lines) — Task 2, `LineChart` section
- [x] IV differential chart (CE−PE bar chart, positive=blue, negative=amber) — Task 2, `BarChart` section
- [x] ±10 strikes around ATM — Task 2, `WING_COUNT = 10` filter
- [x] Nearest expiry only (auto) — Task 3, `expiries[0] ?? ''` passed to tab
- [x] 10-second polling — Task 2, `POLL_MS = 10_000`
- [x] Status bar with spot, ATM, timestamp, LIVE badge — Task 2
- [x] Raw data table with ATM row highlighted — Task 2
- [x] Placed as tab inside `/options` page — Task 3
- [x] Cache TTL reduced to match poll interval — Task 1

**No placeholders:** confirmed — all steps contain complete code.

**Type consistency:** `SkewRow`, `OcSide`, `OcEntry` defined in Task 2 and used only within `OptionsSkewTab.tsx`. `OptionsSkewTab` prop `expiry: string` matches the `expiries[0] ?? ''` in Task 3.
