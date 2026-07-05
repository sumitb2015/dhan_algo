# Expiry Analysis Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new "Expiry Analysis" page under Market Health that scatter-plots weekly Nifty OC returns (Wednesday open → Tuesday close) with a user-adjustable probability boundary slider to identify outlier expiry weeks.

**Architecture:** The API route reads `NIFTY_50_Daily_5Y.csv` via the existing synchronous `readNifty50Index()`, buckets daily rows into Wed-open→Tue-close weeks, and returns raw bucket data as JSON. The client component holds all buckets in state and re-classifies dots (within/upside/downside) client-side on every slider change — no extra network round-trips. Date range changes trigger a new API fetch.

**Tech Stack:** Next.js App Router, Recharts v3 (`ScatterChart`), Tailwind CSS v4, TypeScript — all already in the project.

## Global Constraints

- `readNifty50Index()` is **synchronous** — no `await`, no `async` wrapper needed.
- `OHLCVRow.date` is `string` in `'YYYY-MM-DD'` format; `.open` and `.close` are `number`.
- All text color opacity modifiers on text are forbidden — use solid zinc steps (e.g., `text-zinc-400` not `text-white/70`).
- Table headers: `text-xs font-bold text-white bg-zinc-800` — verbatim from CLAUDE.md.
- DATA chip (`DATA: YYYY-MM-DD`) is required in the sticky header of every data page.
- `isAnimationActive={false}` on all Recharts series.
- No CSS modules — all styling via Tailwind utility classes.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `app/api/expiry-analysis/route.ts` | GET endpoint: CSV read, Wed→Tue bucketing, JSON response |
| Create | `app/expiry-analysis/page.tsx` | Thin Next.js App Router page |
| Create | `components/ExpiryAnalysis.tsx` | Full client component: controls, scatter chart, stats, outlier table |
| Modify | `components/NavBar.tsx` | Add link under "Market Health" group |

---

## Task 1: API Route — Weekly Bucketing

**Files:**
- Create: `app/api/expiry-analysis/route.ts`

**Interfaces:**
- Consumes: `readNifty50Index(): OHLCVRow[]` from `@/lib/dataLoader`; `OHLCVRow` from `@/lib/rs`
- Produces:
  ```ts
  GET /api/expiry-analysis?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
  → { weeks: WeeklyBucket[], dataStart: string, dataEnd: string }

  type WeeklyBucket = {
    wedDate: string   // 'YYYY-MM-DD'
    tueDate: string   // 'YYYY-MM-DD'
    wedOpen: number
    tueClose: number
    returnPct: number // rounded to 2 dp
  }
  ```

- [ ] **Step 1: Create the API route file**

Create `rs_dashboard/app/api/expiry-analysis/route.ts` with this exact content:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { readNifty50Index } from '@/lib/dataLoader';

export interface WeeklyBucket {
  wedDate: string;
  tueDate: string;
  wedOpen: number;
  tueClose: number;
  returnPct: number;
}

// 5-minute in-memory cache keyed by startDate+endDate
const cache = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const startDate = searchParams.get('startDate') ?? '';
  const endDate = searchParams.get('endDate') ?? '';
  const cacheKey = `${startDate}|${endDate}`;

  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    return NextResponse.json(hit.data);
  }

  try {
    const rows = readNifty50Index();

    // Filter to requested date range
    const filtered = rows.filter((r) => {
      if (startDate && r.date < startDate) return false;
      if (endDate && r.date > endDate) return false;
      return true;
    });

    // Bucket Wed (open) → Tue (close) weeks
    // getDay(): 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
    const weeks: WeeklyBucket[] = [];
    let openBucket: { wedDate: string; wedOpen: number } | null = null;

    for (const row of filtered) {
      // Use UTC to avoid TZ-shifting the date string
      const dayOfWeek = new Date(row.date + 'T00:00:00Z').getUTCDay();

      if (dayOfWeek === 3) {
        // Wednesday → open a new bucket (replace any previously unclosed one)
        openBucket = { wedDate: row.date, wedOpen: row.open };
      } else if (dayOfWeek === 2 && openBucket) {
        // Tuesday → close the bucket
        const raw = ((row.close - openBucket.wedOpen) / openBucket.wedOpen) * 100;
        weeks.push({
          wedDate: openBucket.wedDate,
          tueDate: row.date,
          wedOpen: openBucket.wedOpen,
          tueClose: row.close,
          returnPct: Math.round(raw * 100) / 100,
        });
        openBucket = null;
      }
    }

    const dataStart = rows.length > 0 ? rows[0].date : '';
    const dataEnd = rows.length > 0 ? rows[rows.length - 1].date : '';

    const payload = { weeks, dataStart, dataEnd };
    cache.set(cacheKey, { data: payload, ts: Date.now() });
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Start the dev server and verify the endpoint**

```powershell
cd rs_dashboard
npm run dev
```

In a browser or Postman, visit:
```
http://localhost:3000/api/expiry-analysis?startDate=2023-01-01&endDate=2026-07-04
```

Expected response shape (values will vary):
```json
{
  "weeks": [
    { "wedDate": "2023-01-04", "tueDate": "2023-01-10", "wedOpen": 18105.45, "tueClose": 17959.35, "returnPct": -0.81 },
    ...
  ],
  "dataStart": "2021-...",
  "dataEnd": "2026-..."
}
```

Confirm: `weeks` array is non-empty, each element has all 5 fields, `returnPct` is a reasonable ±% number (Nifty weekly moves are typically within ±5%).

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/app/api/expiry-analysis/route.ts
git commit -m "feat(expiry-analysis): add weekly bucketing API route"
```

---

## Task 2: NavBar Link + Page Scaffold

**Files:**
- Modify: `components/NavBar.tsx` lines 46–51 (Market Health group links array)
- Create: `app/expiry-analysis/page.tsx`

**Interfaces:**
- Consumes: `ExpiryAnalysis` default export from `@/components/ExpiryAnalysis` (created in Task 3)
- Produces: `/expiry-analysis` route rendered by Next.js

- [ ] **Step 1: Add the nav link to NavBar.tsx**

In `rs_dashboard/components/NavBar.tsx`, find the Market Health group (the one with `icon: Activity`). Add one entry to its `links` array:

```ts
// BEFORE (lines ~44–51):
{
  label: 'Market Health',
  icon: Activity,
  links: [
    { href: '/breadth',      label: 'Breadth',      desc: 'Market index moving average breadth status' },
    { href: '/diffusion',    label: 'Diffusion',     desc: 'Diffusion index indicators & trend line charts' },
    { href: '/distribution', label: 'Distribution',  desc: 'Returns frequency & statistical distribution' },
    { href: '/live',         label: 'Live',          desc: 'Live ticking market breadth & indexes' },
  ],
},

// AFTER — append one line inside links:
{
  label: 'Market Health',
  icon: Activity,
  links: [
    { href: '/breadth',           label: 'Breadth',          desc: 'Market index moving average breadth status' },
    { href: '/diffusion',         label: 'Diffusion',         desc: 'Diffusion index indicators & trend line charts' },
    { href: '/distribution',      label: 'Distribution',      desc: 'Returns frequency & statistical distribution' },
    { href: '/live',              label: 'Live',              desc: 'Live ticking market breadth & indexes' },
    { href: '/expiry-analysis',   label: 'Expiry Analysis',   desc: 'Weekly OC return distribution & outlier analysis' },
  ],
},
```

- [ ] **Step 2: Create the page file**

Create `rs_dashboard/app/expiry-analysis/page.tsx`:

```tsx
import ExpiryAnalysis from '@/components/ExpiryAnalysis';

export const metadata = { title: 'Expiry Analysis | Dhan Algo' };

export default function ExpiryAnalysisPage() {
  return <ExpiryAnalysis />;
}
```

- [ ] **Step 3: Create the component stub so the page compiles**

Create `rs_dashboard/components/ExpiryAnalysis.tsx` with a minimal stub:

```tsx
'use client';

export default function ExpiryAnalysis() {
  return (
    <div className="min-h-screen bg-black flex items-center justify-center text-zinc-400 text-sm">
      Expiry Analysis — coming soon
    </div>
  );
}
```

- [ ] **Step 4: Verify the page renders and the nav link works**

Navigate to `http://localhost:3000/expiry-analysis` — should show the stub text.
Open the "Market Health" nav dropdown — "Expiry Analysis" should appear and navigate correctly.

- [ ] **Step 5: Commit**

```bash
git add rs_dashboard/components/NavBar.tsx rs_dashboard/app/expiry-analysis/page.tsx rs_dashboard/components/ExpiryAnalysis.tsx
git commit -m "feat(expiry-analysis): add page scaffold and nav link"
```

---

## Task 3: ExpiryAnalysis Component — Full UI

**Files:**
- Modify: `components/ExpiryAnalysis.tsx` (replace stub with full implementation)

**Interfaces:**
- Consumes:
  - `GET /api/expiry-analysis` — `WeeklyBucket[]` as defined in Task 1
  - `NavBar` default export from `@/components/NavBar`
- Produces: complete page with controls, scatter chart, stats tiles, outlier table

- [ ] **Step 1: Install no new packages**

All required packages already exist: `recharts` (v3.8.1), `lucide-react`, `tailwindcss`. Confirm with:
```powershell
cat rs_dashboard/package.json | Select-String "recharts"
```
Expected: `"recharts": "^3.8.1"` (or similar).

- [ ] **Step 2: Replace the stub with the full component**

Replace the entire contents of `rs_dashboard/components/ExpiryAnalysis.tsx` with:

```tsx
'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { TrendingUp } from 'lucide-react';
import NavBar from '@/components/NavBar';

// ─── Types ────────────────────────────────────────────────────────────────────

interface WeeklyBucket {
  wedDate: string;
  tueDate: string;
  wedOpen: number;
  tueClose: number;
  returnPct: number;
}

interface ClassifiedBucket extends WeeklyBucket {
  tueTimestamp: number;
  status: 'within' | 'upside' | 'downside';
}

interface ScatterPoint {
  x: number;
  y: number;
  wedDate: string;
  tueDate: string;
  returnPct: number;
  status: 'within' | 'upside' | 'downside';
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoYearsAgo(n: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Returns symmetric two-tailed percentile boundaries.
 * probability = 0.95 → lower = 2.5th pct, upper = 97.5th pct.
 */
function computeBoundaries(
  returnPcts: number[],
  probability: number,
): { lower: number; upper: number } {
  if (returnPcts.length === 0) return { lower: 0, upper: 0 };
  const sorted = [...returnPcts].sort((a, b) => a - b);
  const n = sorted.length;
  const tail = (1 - probability) / 2;
  const lowerIdx = Math.max(0, Math.floor(tail * n));
  const upperIdx = Math.min(n - 1, Math.floor((1 - tail) * n) - 1);
  return { lower: sorted[lowerIdx], upper: sorted[upperIdx] };
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d} ${months[parseInt(m, 10) - 1]} ${y}`;
}

// ─── Custom tooltip ───────────────────────────────────────────────────────────

function CustomTooltip({ active, payload }: { active?: boolean; payload?: { payload: ScatterPoint }[] }) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  const color =
    d.status === 'upside' ? '#34d399' : d.status === 'downside' ? '#f87171' : '#71717a';
  const sign = d.returnPct >= 0 ? '+' : '';
  const label =
    d.status === 'within' ? 'Within boundary' : d.status + ' outlier';
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs shadow-xl">
      <div className="text-zinc-400 mb-1">
        {fmtDate(d.wedDate)} → {fmtDate(d.tueDate)}
      </div>
      <div style={{ color }} className="font-mono font-bold text-sm">
        {sign}{d.returnPct.toFixed(2)}%
      </div>
      <div className="text-zinc-500 capitalize mt-0.5">{label}</div>
    </div>
  );
}

// ─── Dot shapes ───────────────────────────────────────────────────────────────

function SmallDot(props: { cx?: number; cy?: number }) {
  return <circle cx={props.cx} cy={props.cy} r={3} fill="#52525b" opacity={0.65} />;
}
function GreenDot(props: { cx?: number; cy?: number }) {
  return <circle cx={props.cx} cy={props.cy} r={5} fill="#34d399" />;
}
function RedDot(props: { cx?: number; cy?: number }) {
  return <circle cx={props.cx} cy={props.cy} r={5} fill="#f87171" />;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ExpiryAnalysis() {
  const [weeks, setWeeks] = useState<WeeklyBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dataEnd, setDataEnd] = useState('');

  const [startDate, setStartDate] = useState(isoYearsAgo(5));
  const [endDate, setEndDate] = useState(isoToday);

  // probability as integer 70–99 (represents %)
  const [probability, setProbability] = useState(95);

  // Fetch whenever date range changes
  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/expiry-analysis?startDate=${startDate}&endDate=${endDate}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setWeeks(data.weeks ?? []);
        setDataEnd(data.dataEnd ?? '');
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [startDate, endDate]);

  // Re-classify whenever weeks or probability changes (no API call)
  const { lower, upper, withinData, upsideData, downsideData, outliers } = useMemo(() => {
    const { lower, upper } = computeBoundaries(
      weeks.map((w) => w.returnPct),
      probability / 100,
    );

    const classified: ClassifiedBucket[] = weeks.map((w) => ({
      ...w,
      tueTimestamp: new Date(w.tueDate + 'T00:00:00Z').getTime(),
      status:
        w.returnPct < lower ? 'downside' : w.returnPct > upper ? 'upside' : 'within',
    }));

    const toPoint = (c: ClassifiedBucket): ScatterPoint => ({
      x: c.tueTimestamp,
      y: c.returnPct,
      wedDate: c.wedDate,
      tueDate: c.tueDate,
      returnPct: c.returnPct,
      status: c.status,
    });

    const withinData  = classified.filter((c) => c.status === 'within').map(toPoint);
    const upsideData  = classified.filter((c) => c.status === 'upside').map(toPoint);
    const downsideData = classified.filter((c) => c.status === 'downside').map(toPoint);
    const outliers = classified
      .filter((c) => c.status !== 'within')
      .sort((a, b) => Math.abs(b.returnPct) - Math.abs(a.returnPct));

    return { lower, upper, withinData, upsideData, downsideData, outliers };
  }, [weeks, probability]);

  // Stats
  const totalExpiries = weeks.length;
  const totalOutliers = outliers.length;
  const outlierPct =
    totalExpiries > 0 ? ((totalOutliers / totalExpiries) * 100).toFixed(1) : '0.0';

  // X-axis tick: show year only
  const xTickFormatter = (ts: number) =>
    new Date(ts).getUTCFullYear().toString();

  const sign = (n: number) => (n >= 0 ? '+' : '');

  return (
    <div className="min-h-screen bg-black text-white">
      {/* ── Sticky header ── */}
      <header className="sticky top-0 z-30 bg-zinc-950/90 backdrop-blur-md border-b border-zinc-800 px-4 py-2 flex items-center gap-3">
        <TrendingUp className="text-emerald-400 w-5 h-5 flex-shrink-0" />
        <div className="flex-shrink-0">
          <h1 className="text-sm font-bold text-white leading-tight">Expiry Analysis</h1>
          <p className="text-xs text-zinc-500 leading-tight">Weekly OC Return Distribution</p>
        </div>
        <div className="flex-1 min-w-0">
          <NavBar />
        </div>
        {dataEnd && (
          <span className="flex-shrink-0 text-xs text-zinc-500 font-mono border border-zinc-800 rounded px-2 py-0.5 whitespace-nowrap">
            DATA: {dataEnd}
          </span>
        )}
      </header>

      <main className="p-4 space-y-4 max-w-[1600px] mx-auto">
        {/* ── Controls ── */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-400 whitespace-nowrap">Start Date</label>
              <input
                type="date"
                value={startDate}
                max={endDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-400 whitespace-nowrap">End Date</label>
              <input
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div className="flex items-center gap-3 flex-1 min-w-[300px]">
              <label className="text-xs text-zinc-400 whitespace-nowrap">
                Probability Boundary (%)
              </label>
              <input
                type="range"
                min={70}
                max={99}
                step={1}
                value={probability}
                onChange={(e) => setProbability(Number(e.target.value))}
                className="flex-1 accent-emerald-500"
              />
              <span className="text-xs font-mono text-emerald-400 whitespace-nowrap min-w-[220px]">
                {probability}% → lower: {lower.toFixed(2)}% / upper: {sign(upper)}{upper.toFixed(2)}%
              </span>
            </div>
          </div>
          <p className="text-xs text-zinc-600 mt-2">
            Current Return Column: <span className="text-zinc-500">Weekly Return %</span>
            &nbsp;| Total Records: {totalExpiries} expiries.
            Based on the selected {probability}% coverage, the lower boundary is the{' '}
            {(((1 - probability / 100) / 2) * 100).toFixed(1)}th percentile and the upper boundary
            is the {((1 - (1 - probability / 100) / 2) * 100).toFixed(1)}th percentile.
          </p>
        </div>

        {/* ── Scatter chart ── */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <div className="mb-4">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              ✈ Outliers Distribution (Survivability Scatter Plot)
            </h2>
            <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
              Dots inside the horizontal dashed lines represent within-boundary expiries.
              Dots outside represent extreme outliers (red/green). This scatter map, inspired by
              Abraham Wald&apos;s aircraft survivability analysis, highlights where the market was
              hit by extreme moves.
            </p>
          </div>

          {loading ? (
            <div className="h-[420px] flex items-center justify-center text-zinc-500 text-sm">
              Loading weekly data…
            </div>
          ) : error ? (
            <div className="h-[420px] flex items-center justify-center text-red-400 text-sm">
              Error: {error}
            </div>
          ) : weeks.length === 0 ? (
            <div className="h-[420px] flex items-center justify-center text-zinc-500 text-sm">
              No data for the selected date range.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={420}>
              <ScatterChart margin={{ top: 16, right: 80, bottom: 24, left: 8 }}>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="x"
                  type="number"
                  domain={['auto', 'auto']}
                  scale="time"
                  tickFormatter={xTickFormatter}
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  axisLine={false}
                  tickLine={false}
                  label={{
                    value: 'Expiry End Date',
                    position: 'insideBottom',
                    offset: -12,
                    fontSize: 10,
                    fill: '#52525b',
                  }}
                />
                <YAxis
                  dataKey="y"
                  type="number"
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => `${v}%`}
                  width={52}
                  label={{
                    value: 'Return (%)',
                    angle: -90,
                    position: 'insideLeft',
                    offset: 8,
                    fontSize: 10,
                    fill: '#52525b',
                  }}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
                  formatter={(value) => (
                    <span style={{ color: '#a1a1aa' }}>{value}</span>
                  )}
                />
                <ReferenceLine
                  y={upper}
                  stroke="#34d399"
                  strokeDasharray="6 3"
                  strokeWidth={1.5}
                  label={{
                    value: `Upper Boundary (${sign(upper)}${upper.toFixed(2)}%)`,
                    position: 'right',
                    fontSize: 9,
                    fill: '#34d399',
                  }}
                />
                <ReferenceLine
                  y={lower}
                  stroke="#f87171"
                  strokeDasharray="6 3"
                  strokeWidth={1.5}
                  label={{
                    value: `Lower Boundary (${lower.toFixed(2)}%)`,
                    position: 'right',
                    fontSize: 9,
                    fill: '#f87171',
                  }}
                />
                <Scatter
                  name="Within Boundary"
                  data={withinData}
                  isAnimationActive={false}
                  shape={<SmallDot />}
                />
                <Scatter
                  name="Upside Outlier"
                  data={upsideData}
                  isAnimationActive={false}
                  shape={<GreenDot />}
                />
                <Scatter
                  name="Downside Outlier"
                  data={downsideData}
                  isAnimationActive={false}
                  shape={<RedDot />}
                />
              </ScatterChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* ── Stats row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Total Expiries', value: String(totalExpiries), colorClass: 'text-white' },
            { label: 'Total Outliers', value: `${totalOutliers} (${outlierPct}%)`, colorClass: 'text-amber-400' },
            { label: 'Downside Outliers 🔴', value: String(downsideData.length), colorClass: 'text-red-400' },
            { label: 'Upside Outliers 🟢', value: String(upsideData.length), colorClass: 'text-emerald-400' },
          ].map((stat) => (
            <div
              key={stat.label}
              className="bg-zinc-900 border border-zinc-800 rounded-xl p-4"
            >
              <div className="text-xs text-zinc-500 mb-2">{stat.label}</div>
              <div className={`text-3xl font-bold font-mono ${stat.colorClass}`}>
                {stat.value}
              </div>
            </div>
          ))}
        </div>

        {/* ── Outlier table ── */}
        {outliers.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-800">
              <h2 className="text-sm font-bold text-white">Outlier Expiries Table</h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                All weekly expiries that fell outside the specified boundaries, sorted by absolute
                return size.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-left">
                      Start Date (Wed)
                    </th>
                    <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-left">
                      End Date (Tue)
                    </th>
                    <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right">
                      Weekly Return %
                    </th>
                    <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-left">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {outliers.map((w, i) => {
                    const isUp = w.status === 'upside';
                    return (
                      <tr
                        key={w.tueDate}
                        className={i % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-950'}
                      >
                        <td className="px-4 py-2 font-mono text-zinc-300">{w.wedDate}</td>
                        <td className="px-4 py-2 font-mono text-zinc-300">{w.tueDate}</td>
                        <td
                          className={`px-4 py-2 font-mono font-bold text-right ${
                            isUp ? 'text-emerald-400' : 'text-red-400'
                          }`}
                        >
                          {sign(w.returnPct)}{w.returnPct.toFixed(2)}%
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs border ${
                              isUp
                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                                : 'bg-red-500/10 text-red-400 border-red-500/30'
                            }`}
                          >
                            {isUp ? 'Upside Outlier' : 'Downside Outlier'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Verify the page compiles without TypeScript errors**

```powershell
cd rs_dashboard
npx tsc --noEmit 2>&1 | Select-String "ExpiryAnalysis"
```

Expected: no output (no errors in the new file). If there are errors, fix them before proceeding.

- [ ] **Step 4: Visual verification in the browser**

Navigate to `http://localhost:3000/expiry-analysis`. Check each item:

1. **Scatter chart loads** — ~250 gray dots visible across the date range
2. **Reference lines** — two dashed horizontal lines appear at the boundary values
3. **Slider moves** — dragging the probability slider to 80% immediately repaints ~20% of dots red/green without a page reload
4. **Date range** — change start date to 3 years ago; chart re-fetches and shows fewer dots
5. **Tooltip** — hover any dot; tooltip shows Wed date → Tue date, return%, status label
6. **Outlier table** — rows match the colored outlier dots in the chart (count should equal downsideData.length + upsideData.length)
7. **Stats tiles** — Total Outliers tile should equal the sum of Upside + Downside counts
8. **Nav** — "Market Health" dropdown includes "Expiry Analysis" and clicking it stays on the page
9. **DATA chip** — shows the latest Tuesday date from the CSV in the sticky header

- [ ] **Step 5: Commit**

```bash
git add rs_dashboard/components/ExpiryAnalysis.tsx
git commit -m "feat(expiry-analysis): implement scatter chart, controls, stats, outlier table"
```

---

## Self-Review Notes

- **Spec coverage:** API route ✓ · NavBar link ✓ · Page scaffold ✓ · Controls (date pickers + slider) ✓ · Scatter chart with 3 series + reference lines ✓ · Custom tooltip ✓ · Stats row ✓ · Outlier table ✓ · DATA chip ✓ · Abraham Wald copy ✓
- **No placeholders:** All code blocks are complete and runnable.
- **Type consistency:** `WeeklyBucket`, `ClassifiedBucket`, `ScatterPoint` defined once in Task 3 and the API interface declared once in Task 1. `tueTimestamp` is explicitly computed in `useMemo` inside `classified` before being used as `x` in `ScatterPoint`.
- **readNifty50Index is synchronous** — no `await` used anywhere in the API route.
