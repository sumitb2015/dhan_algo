# Breadth Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `/breadth` as a deep-dive analysis tool with data-journalism aesthetics, a three-universe side-by-side comparison grid (N50 Index | N50 Stocks | N500 Stocks), inline formula tooltips, and a full Nifty 50 constituent breadth suite.

**Architecture:** API route extended to run `computeBreadthStats` for both N50 and N500 symbol lists in parallel; `BreadthStats` field `rsiNeutral` renamed to `rsiBucket40to70`; `IndexStats.nifty50BreadthPct` removed. Component fully rewritten — all amber terminal chrome replaced with Tailwind zinc-based cards, prominent tabular numbers, and CSS-only hover tooltips. Sections ordered: Header → Regime Banner → Three-column grid → Detail sections.

**Tech Stack:** Next.js (App Router), React 18, TypeScript, Tailwind CSS, Lucide React icons. Dashboard runs at `localhost:3000`; dev server started with `cd rs_dashboard && npm run dev`.

## Global Constraints

- All Tailwind text-color opacity modifiers (`text-white/70`) are forbidden — use solid zinc shades instead.
- No semi-circle SVG gauges.
- No amber structural chrome — amber only appears if copied from an existing NavBar or other shared component.
- No `font-mono` except the `DATA:` date chip.
- All `<thead>/<th>` use `text-xs font-bold text-white bg-zinc-800`.
- Regime is driven by `nifty500Breadth.aboveEma200Pct` (unchanged logic).
- Dev server must be running for browser verification steps (`cd rs_dashboard && npm run dev`).
- Never use `adxLabel`/`chopLabel` from old code — they return hex colors; use the new `adxInfo`/`chopInfo` helpers defined in Task 4 that return Tailwind class names.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `rs_dashboard/app/api/breadth/route.ts` | Modify | Add `nifty50Breadth: BreadthStats`; rename `rsiNeutral→rsiBucket40to70`; remove `nifty50BreadthPct`; remove `computeNifty50BreadthPct()` |
| `rs_dashboard/components/BreadthAnalysis.tsx` | Full rewrite | All UI — shared primitives, regime banner, three-column grid, detail sections |

---

### Task 1: API — N50 breadth suite + field renames

**Files:**
- Modify: `rs_dashboard/app/api/breadth/route.ts`

**Interfaces:**
- Produces: `BreadthResponse.nifty50Breadth: BreadthStats`, `BreadthStats.rsiBucket40to70` (was `rsiNeutral`). `IndexStats` no longer has `nifty50BreadthPct`.

- [ ] **Step 1: Update `BreadthStats` interface — rename `rsiNeutral` → `rsiBucket40to70`**

In `route.ts`, find the `BreadthStats` interface and change the field:

```ts
// Before (line ~43):
rsiNeutral: number;      // RSI 40–70

// After:
rsiBucket40to70: number;   // RSI 40–70 (split in UI into 60–70 elevated + 40–60 neutral)
```

- [ ] **Step 2: Remove `nifty50BreadthPct` from `IndexStats`**

```ts
// Remove this line from the IndexStats interface:
nifty50BreadthPct: number;  // % of Nifty 50 stocks above their 200d SMA
```

- [ ] **Step 3: Add `nifty50Breadth` to `BreadthResponse`**

```ts
export interface BreadthResponse {
  nifty50: IndexStats;
  nifty50Breadth: BreadthStats;   // ← add this line
  nifty500Breadth: BreadthStats;
  regimeLabel: string;
  regimeColor: 'green' | 'lime' | 'yellow' | 'orange' | 'red';
  dataDate: string;
}
```

- [ ] **Step 4: Update `computeBreadthStats` return — rename the field**

Inside `computeBreadthStats`, find the return statement and change `rsiNeutral` to `rsiBucket40to70`:

```ts
return {
  totalScanned: total,
  aboveEma20Count: aboveEma20,
  aboveEma50Count: aboveEma50,
  aboveEma200Count: aboveEma200,
  aboveEma20Pct,
  aboveEma50Pct,
  aboveEma200Pct,
  new52WHighCount: new52WHigh,
  new52WLowCount: new52WLow,
  advancing1W,
  declining1W,
  unchanged1W,
  advDecRatio,
  rsiOverbought,
  rsiBucket40to70: rsiNeutral,   // ← renamed field, same value
  rsiOversold,
  participationScore,
  bullPowerCount: bullPower,
  bullPowerPct: pct(bullPower),
  bearPowerCount: bearPower,
  bearPowerPct: pct(bearPower),
  rsiAbove60,
  rsiAbove60Pct: pct(rsiAbove60),
  rsiBelow40,
  rsiBelow40Pct: pct(rsiBelow40),
  netAdvanceDecline,
};
```

- [ ] **Step 5: Remove `computeNifty50BreadthPct` and update `computeIndexStats` return**

Delete the entire `computeNifty50BreadthPct()` function (lines ~355–367 in original).

In `computeIndexStats`, remove the `nifty50BreadthPct: 0` line from the return object:

```ts
return {
  close: +close.toFixed(2),
  ema20: +e20.toFixed(2),
  ema50: +e50.toFixed(2),
  ema200: +e200.toFixed(2),
  pctVsEma20: +pctVsEma20.toFixed(2),
  pctVsEma50: +pctVsEma50.toFixed(2),
  pctVsEma200: +pctVsEma200.toFixed(2),
  adx14: adx14 !== null ? +adx14.toFixed(2) : null,
  chopIndex: chopIndex !== null ? +chopIndex.toFixed(2) : null,
  trendState,
  dataDate: last.date,
  // nifty50BreadthPct removed — now in nifty50Breadth.aboveEma200Pct
};
```

- [ ] **Step 6: Update `GET()` — run N50 breadth in parallel, wire response**

Replace the `GET` handler body with:

```ts
export async function GET() {
  try {
    if (breadthCache && Date.now() - breadthCache.ts < CACHE_TTL) {
      return NextResponse.json({ success: true, data: breadthCache.data });
    }

    const nifty50Rows = readNifty50Index();
    const nifty500Symbols = readNifty500List();

    const [nifty50, nifty50Breadth, nifty500Breadth] = await Promise.all([
      Promise.resolve(computeIndexStats(nifty50Rows)),
      computeBreadthStats(NIFTY50_SYMBOLS),
      computeBreadthStats(nifty500Symbols),
    ]);

    const { label: regimeLabel, color: regimeColor } = deriveRegime(nifty500Breadth.aboveEma200Pct);

    const data: BreadthResponse = {
      nifty50,
      nifty50Breadth,
      nifty500Breadth,
      regimeLabel,
      regimeColor,
      dataDate: nifty50.dataDate,
    };

    breadthCache = { data, ts: Date.now() };
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('[/api/breadth] Error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 7: Verify API response in browser**

With dev server running, open `http://localhost:3000/api/breadth` and confirm:
- Response has `data.nifty50Breadth` with all `BreadthStats` fields (including `rsiBucket40to70`)
- Response has `data.nifty500Breadth` with `rsiBucket40to70` (not `rsiNeutral`)
- `data.nifty50` does NOT have `nifty50BreadthPct`
- `data.nifty50Breadth.totalScanned` is ~50
- `data.nifty500Breadth.totalScanned` is ~450–500

- [ ] **Step 8: Commit**

```bash
git add rs_dashboard/app/api/breadth/route.ts
git commit -m "feat(breadth): add N50 constituent breadth suite, rename rsiNeutral→rsiBucket40to70"
```

---

### Task 2: Component foundation — design system, shared primitives, Header

**Files:**
- Modify: `rs_dashboard/components/BreadthAnalysis.tsx` (full replacement)

**Interfaces:**
- Produces: `Tooltip`, `KPITile`, `MetricRow`, `SectionCard`, `CardHeader` components; helper functions `fmt`, `fmtPct`, `valueColorClass`, `pctSignalClass`, `pctBarClass`, `getTrendStrengthScore`; `REGIME_META` constant; main `BreadthAnalysis` export with sticky header and loading/error states.

- [ ] **Step 1: Replace the entire file with the new foundation**

Write `rs_dashboard/components/BreadthAnalysis.tsx`:

```tsx
'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import type { BreadthResponse, IndexStats, BreadthStats } from '@/app/api/breadth/route';
import NavBar from './NavBar';

// ─── Regime metadata ──────────────────────────────────────────────────────────

const REGIME_META = {
  green:  { label: 'BULL MARKET',    condition: '≥60% stocks above 200d SMA', action: 'Favour long/momentum strategies.',                           bg: 'bg-emerald-950', border: 'border-emerald-900', accent: 'border-l-emerald-500', text: 'text-emerald-400' },
  lime:   { label: 'CAUTIOUS BULL',  condition: '50–60% stocks above 200d SMA', action: 'Selective longs; avoid low-quality stocks.',               bg: 'bg-lime-950',    border: 'border-lime-900',    accent: 'border-l-lime-500',    text: 'text-lime-400'    },
  yellow: { label: 'CAUTION / CHOP', condition: '45–50% stocks above 200d SMA', action: 'Ideal for non-directional options (Straddles/Strangles).', bg: 'bg-yellow-950',  border: 'border-yellow-900',  accent: 'border-l-yellow-500',  text: 'text-yellow-400'  },
  orange: { label: 'TRANSITION',     condition: '40–45% stocks above 200d SMA', action: 'Reduce leverage; wait for breakout confirmation.',          bg: 'bg-orange-950',  border: 'border-orange-900',  accent: 'border-l-orange-500',  text: 'text-orange-400'  },
  red:    { label: 'BEAR MARKET',    condition: '<40% stocks above 200d SMA',   action: 'Avoid longs; hedge portfolio; favour cash.',                bg: 'bg-red-950',     border: 'border-red-900',     accent: 'border-l-red-500',     text: 'text-red-400'     },
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number, dec = 2): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtPct(n: number): string {
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

function valueColorClass(n: number): string {
  return n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-400';
}

function pctSignalClass(pct: number): string {
  if (pct >= 60) return 'text-emerald-400';
  if (pct >= 50) return 'text-lime-400';
  if (pct >= 45) return 'text-yellow-400';
  if (pct >= 40) return 'text-orange-400';
  return 'text-red-400';
}

function pctBarClass(pct: number): string {
  if (pct >= 60) return 'bg-emerald-500';
  if (pct >= 50) return 'bg-lime-500';
  if (pct >= 45) return 'bg-yellow-500';
  if (pct >= 40) return 'bg-orange-500';
  return 'bg-red-500';
}

function getTrendStrengthScore(stats: IndexStats): number {
  let score = 50;
  if (stats.trendState === 'Strong Uptrend') score += 20;
  else if (stats.trendState === 'Uptrend') score += 10;
  else if (stats.trendState === 'Above EMA 200') score += 5;
  else if (stats.trendState === 'Below EMA 200') score -= 10;
  else if (stats.trendState === 'Downtrend') score -= 20;
  if (stats.adx14 !== null) {
    if (stats.adx14 >= 25) score += 15;
    else if (stats.adx14 < 20) score -= 5;
  }
  return Math.max(0, Math.min(100, score));
}

// ─── Primitive components ─────────────────────────────────────────────────────

function Tooltip({ label, content, scale }: { label: string; content: string; scale?: string }) {
  return (
    <span className="relative group inline-block">
      <span className="border-b border-dotted border-zinc-600 cursor-help text-zinc-400 text-xs font-medium uppercase tracking-widest leading-none">
        {label}
      </span>
      <span className="pointer-events-none absolute left-0 bottom-full mb-2 z-50 hidden group-hover:block w-72 bg-zinc-800 border border-zinc-700 rounded p-3 shadow-xl">
        <span className="block text-zinc-200 text-xs font-semibold mb-1">{label}</span>
        <span className="block text-zinc-300 text-xs leading-relaxed">{content}</span>
        {scale && <span className="block text-zinc-500 text-xs mt-2 leading-relaxed border-t border-zinc-700 pt-2">{scale}</span>}
      </span>
    </span>
  );
}

interface KPITileProps {
  label: string; tooltip: string; tooltipScale?: string;
  value: React.ReactNode; valueClass?: string;
  subLabel?: string; subClass?: string;
}
function KPITile({ label, tooltip, tooltipScale, value, valueClass, subLabel, subClass }: KPITileProps) {
  return (
    <div>
      <Tooltip label={label} content={tooltip} scale={tooltipScale} />
      <div className={`text-2xl font-bold tabular-nums mt-1 ${valueClass ?? 'text-zinc-100'}`}>{value}</div>
      {subLabel && <div className={`text-xs mt-0.5 ${subClass ?? 'text-zinc-400'}`}>{subLabel}</div>}
    </div>
  );
}

interface MetricRowProps {
  label: string; tooltip: string; tooltipScale?: string;
  children: React.ReactNode;
  bar?: { pct: number; colorClass: string };
}
function MetricRow({ label, tooltip, tooltipScale, children, bar }: MetricRowProps) {
  return (
    <div className="py-3 border-b border-zinc-800/50 last:border-b-0">
      <div className="flex items-start justify-between gap-2">
        <Tooltip label={label} content={tooltip} scale={tooltipScale} />
        <div className="text-right">{children}</div>
      </div>
      {bar && (
        <div className="h-1.5 w-full bg-zinc-800 rounded-full mt-2">
          <div className={`h-full rounded-full ${bar.colorClass}`} style={{ width: `${Math.min(100, bar.pct)}%` }} />
        </div>
      )}
    </div>
  );
}

function SectionCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden ${className ?? ''}`}>
      {children}
    </div>
  );
}

function CardHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="bg-zinc-800 px-4 py-3">
      <div className="text-xs font-bold text-white uppercase tracking-widest">{title}</div>
      {subtitle && <div className="text-xs text-zinc-500 mt-0.5">{subtitle}</div>}
    </div>
  );
}

// ─── Main component (stub — sections added in Tasks 3–6) ─────────────────────

export default function BreadthAnalysis() {
  const [data, setData] = useState<BreadthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/breadth');
      const json = await res.json();
      if (json.success) {
        setData(json.data);
        setLastUpdated(new Date());
      } else {
        setError(json.error ?? 'Failed to load breadth data');
      }
    } catch {
      setError('Network error. Failed to load breadth data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  return (
    <div className="bg-zinc-950 min-h-screen flex flex-col">
      {/* Sticky Header */}
      <header className="bg-zinc-900 border-b border-zinc-800 px-4 py-3 flex items-center gap-4 sticky top-0 z-30 flex-wrap">
        <div>
          <div className="text-sm font-bold text-zinc-100 tracking-wide uppercase">Market Breadth</div>
          <div className="text-xs text-zinc-500 tracking-widest">Nifty 50 · Nifty 500 Universe</div>
        </div>
        <NavBar />
        <div className="ml-auto flex items-center gap-3">
          {data && (
            <span className="font-mono text-xs bg-zinc-800 text-zinc-400 px-2 py-1 rounded border border-zinc-700">
              DATA: {data.dataDate}
            </span>
          )}
          {lastUpdated && (
            <span className="text-xs text-zinc-500">
              {lastUpdated.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })} IST
            </span>
          )}
          <button
            onClick={fetchData}
            className="w-8 h-8 flex items-center justify-center bg-zinc-800 border border-zinc-700 rounded hover:border-zinc-600 text-zinc-400 cursor-pointer"
            title="Refresh"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin text-amber-400' : ''} />
          </button>
        </div>
      </header>

      {/* Loading */}
      {loading && !data && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <RefreshCw size={20} className="animate-spin text-zinc-400" />
          <div className="text-sm text-zinc-400 uppercase tracking-widest">Computing Breadth…</div>
          <div className="text-xs text-zinc-600 uppercase tracking-widest">Scanning Nifty 500 Universe</div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="m-4 p-3 border border-red-900 bg-red-950 text-red-400 text-sm rounded">
          {error}
        </div>
      )}

      {/* Content — populated in Tasks 3–6 */}
      {data && (
        <main className="flex-1 overflow-y-auto">
          <div className="px-4 py-6">
            <p className="text-zinc-500 text-sm">Sections loading…</p>
          </div>
        </main>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify page loads without TypeScript errors**

Open `http://localhost:3000/breadth` — should show the sticky header with "MARKET BREADTH" title, NavBar, DATA chip, and either a spinner or "Sections loading…" placeholder. No red TypeScript errors in the terminal.

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/components/BreadthAnalysis.tsx
git commit -m "feat(breadth): component foundation — design tokens, Tooltip, MetricRow, SectionCard, Header"
```

---

### Task 3: Regime Banner

**Files:**
- Modify: `rs_dashboard/components/BreadthAnalysis.tsx`

**Interfaces:**
- Consumes: `REGIME_META`, `KPITile`, `Tooltip`; `BreadthResponse.regimeColor`, `BreadthResponse.nifty500Breadth`
- Produces: `RegimeBanner` component

- [ ] **Step 1: Add `RegimeBanner` component before the `BreadthAnalysis` default export**

```tsx
function RegimeBanner({ data }: { data: BreadthResponse }) {
  const meta = REGIME_META[data.regimeColor];
  const b = data.nifty500Breadth;

  const partClass = b.participationScore >= 70 ? 'text-emerald-400' : b.participationScore >= 55 ? 'text-lime-400' : b.participationScore >= 45 ? 'text-yellow-400' : b.participationScore >= 35 ? 'text-orange-400' : 'text-red-400';
  const partLabel = b.participationScore >= 70 ? 'Strong Participation' : b.participationScore >= 55 ? 'Good Participation' : b.participationScore >= 45 ? 'Neutral' : b.participationScore >= 35 ? 'Weak Participation' : 'Very Weak';

  const adClass = b.advDecRatio >= 2 ? 'text-emerald-400' : b.advDecRatio >= 1 ? 'text-lime-400' : b.advDecRatio >= 0.5 ? 'text-yellow-400' : 'text-red-400';
  const adLabel = b.advDecRatio >= 3 ? 'Strongly Bullish' : b.advDecRatio >= 2 ? 'Bullish' : b.advDecRatio >= 1 ? 'Neutral-Bull' : b.advDecRatio >= 0.5 ? 'Neutral-Bear' : 'Bearish';

  const netClass = b.netAdvanceDecline >= 0 ? 'text-emerald-400' : 'text-red-400';
  const netStr = (b.netAdvanceDecline > 0 ? '+' : '') + b.netAdvanceDecline;

  return (
    <div className={`${meta.bg} ${meta.border} border-b border-l-4 ${meta.accent} px-6 py-5 flex items-center gap-8 flex-wrap`}>
      <div>
        <div className="text-xs text-zinc-500 uppercase tracking-widest mb-1">Market Regime · Nifty 500</div>
        <div className={`text-3xl font-black tracking-wider ${meta.text}`}>{meta.label}</div>
      </div>

      <div className="w-px h-12 bg-zinc-800 hidden sm:block" />

      <KPITile
        label="Participation Score"
        tooltip="Weighted composite of Nifty 500 breadth metrics."
        tooltipScale="SMA200 pct ×0.40 + SMA50 pct ×0.30 + SMA20 pct ×0.20 + A/D transform ×0.10"
        value={<>{b.participationScore}<span className="text-base text-zinc-500">/100</span></>}
        valueClass={partClass}
        subLabel={partLabel}
        subClass={partClass}
      />

      <div className="w-px h-12 bg-zinc-800 hidden sm:block" />

      <KPITile
        label="A/D Ratio (1W)"
        tooltip="Advancing ÷ Declining stocks over past 7 calendar days. Nifty 500 universe."
        tooltipScale="≥3 strongly bullish · ≥2 bullish · ≥1 neutral-bull · <0.5 bearish"
        value={<>{b.advDecRatio.toFixed(2)}<span className="text-base text-zinc-500">x</span></>}
        valueClass={adClass}
        subLabel={adLabel}
        subClass={adClass}
      />

      <div className="w-px h-12 bg-zinc-800 hidden sm:block" />

      <KPITile
        label="Net Advance-Decline"
        tooltip="Advancing minus Declining stocks (past 7 calendar days). Nifty 500 universe."
        value={netStr}
        valueClass={netClass}
        subLabel={`${b.advancing1W} adv · ${b.declining1W} dec`}
        subClass="text-zinc-500"
      />

      <div className="ml-auto text-right hidden lg:block max-w-xs">
        <div className="text-xs text-zinc-500 uppercase tracking-widest">{meta.condition}</div>
        <div className="text-sm text-zinc-300 mt-1">{meta.action}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount `RegimeBanner` in the main component**

Replace the `{data && ...}` block's `<main>` content:

```tsx
{data && (
  <main className="flex-1 overflow-y-auto">
    <RegimeBanner data={data} />
    <div className="px-4 py-6">
      <p className="text-zinc-500 text-sm">Grid loading…</p>
    </div>
  </main>
)}
```

- [ ] **Step 3: Verify in browser**

Open `http://localhost:3000/breadth`. The regime banner should appear below the header, color-coded to the current regime, with Participation Score, A/D Ratio, and Net A/D tiles. Hover over each label to confirm tooltip appears.

- [ ] **Step 4: Commit**

```bash
git add rs_dashboard/components/BreadthAnalysis.tsx
git commit -m "feat(breadth): add RegimeBanner with KPI tiles and tooltips"
```

---

### Task 4: Three-column grid — Index column

**Files:**
- Modify: `rs_dashboard/components/BreadthAnalysis.tsx`

**Interfaces:**
- Consumes: `MetricRow`, `SectionCard`, `CardHeader`, `getTrendStrengthScore`; `IndexStats`
- Produces: `TrendBadge`, `adxInfo()`, `chopInfo()`, `IndexColumn` components

- [ ] **Step 1: Add badge and helper components before `BreadthAnalysis` export**

```tsx
function TrendBadge({ state }: { state: string }) {
  const cls =
    state === 'Strong Uptrend' ? 'bg-emerald-950 text-emerald-400 border-emerald-800' :
    state === 'Uptrend'        ? 'bg-lime-950 text-lime-400 border-lime-800' :
    state === 'Above EMA 200'  ? 'bg-yellow-950 text-yellow-400 border-yellow-800' :
    state === 'Below EMA 200'  ? 'bg-orange-950 text-orange-400 border-orange-800' :
    state === 'Downtrend'      ? 'bg-red-950 text-red-400 border-red-800' :
    'bg-zinc-800 text-zinc-400 border-zinc-700';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border ${cls}`}>
      {state}
    </span>
  );
}

function adxInfo(adx: number | null): { label: string; cls: string } {
  if (adx === null) return { label: 'N/A', cls: 'text-zinc-500' };
  if (adx >= 40) return { label: 'Strong Trend', cls: 'text-emerald-400' };
  if (adx >= 25) return { label: 'Trending', cls: 'text-lime-400' };
  if (adx >= 20) return { label: 'Weak Trend', cls: 'text-yellow-400' };
  return { label: 'No Trend / Choppy', cls: 'text-orange-400' };
}

function chopInfo(chop: number | null): { label: string; cls: string } {
  if (chop === null) return { label: 'N/A', cls: 'text-zinc-500' };
  if (chop < 38.2) return { label: 'Trending', cls: 'text-emerald-400' };
  if (chop < 61.8) return { label: 'Transitioning', cls: 'text-yellow-400' };
  return { label: 'Choppy', cls: 'text-orange-400' };
}
```

- [ ] **Step 2: Add `IndexColumn` component**

```tsx
function IndexColumn({ stats }: { stats: IndexStats }) {
  const score = getTrendStrengthScore(stats);
  const scoreClass = score >= 70 ? 'text-emerald-400' : score >= 55 ? 'text-lime-400' : score >= 45 ? 'text-yellow-400' : score >= 35 ? 'text-orange-400' : 'text-red-400';
  const scoreLabel = score >= 70 ? 'Strong' : score >= 55 ? 'Good' : score >= 45 ? 'Neutral' : score >= 35 ? 'Weakening' : 'Weak';
  const adx = adxInfo(stats.adx14);
  const chop = chopInfo(stats.chopIndex);

  return (
    <SectionCard>
      <CardHeader title="NIFTY 50 INDEX" subtitle="Trend analysis — EMA-based" />
      <div className="px-4 py-2">
        {/* Close — prominent */}
        <div className="py-3 border-b border-zinc-800/50">
          <div className="text-xs text-zinc-500 uppercase tracking-widest mb-1">Close</div>
          <div className="text-3xl font-bold tabular-nums text-zinc-100">{fmt(stats.close)}</div>
        </div>

        <MetricRow
          label="Trend State"
          tooltip="EMA alignment: Strong Uptrend = Close > EMA20 > EMA50 > EMA200. Each step down removes one condition."
          tooltipScale="Strong Uptrend · Uptrend · Above EMA200 · Below EMA200 · Downtrend"
        >
          <TrendBadge state={stats.trendState} />
        </MetricRow>

        <MetricRow
          label="EMA 20"
          tooltip="20-day exponential moving average. Multiplier k = 2/(20+1) = 0.0952. Index uses EMA; stock breadth uses SMA."
        >
          <span>
            <span className="text-zinc-200 font-semibold tabular-nums">{fmt(stats.ema20)}</span>
            <span className={`text-xs ml-2 ${valueColorClass(stats.pctVsEma20)}`}>{fmtPct(stats.pctVsEma20)}</span>
          </span>
        </MetricRow>

        <MetricRow
          label="EMA 50"
          tooltip="50-day EMA — medium-term trend anchor. Index uses EMA; stock breadth uses SMA."
        >
          <span>
            <span className="text-zinc-200 font-semibold tabular-nums">{fmt(stats.ema50)}</span>
            <span className={`text-xs ml-2 ${valueColorClass(stats.pctVsEma50)}`}>{fmtPct(stats.pctVsEma50)}</span>
          </span>
        </MetricRow>

        <MetricRow
          label="EMA 200"
          tooltip="200-day EMA — long-term structural trend level. Primary input for regime classification."
        >
          <span>
            <span className="text-zinc-200 font-semibold tabular-nums">{fmt(stats.ema200)}</span>
            <span className={`text-xs ml-2 ${valueColorClass(stats.pctVsEma200)}`}>{fmtPct(stats.pctVsEma200)}</span>
          </span>
        </MetricRow>

        <MetricRow
          label="ADX (14)"
          tooltip="Average Directional Index (Wilder smoothing, 14-period). Measures trend strength regardless of direction."
          tooltipScale=">40 strong trend · 25–40 trending · 20–25 weak · <20 no trend / choppy"
        >
          <span>
            <span className={`font-bold tabular-nums ${adx.cls}`}>{stats.adx14?.toFixed(1) ?? 'N/A'}</span>
            <span className={`text-xs ml-2 ${adx.cls}`}>{adx.label}</span>
          </span>
        </MetricRow>

        <MetricRow
          label="Chop Index"
          tooltip="Choppiness Index = 100 × log₁₀(ΣTR₁₄ / (HH₁₄ − LL₁₄)) / log₁₀(14). Below 38.2 = directional trend."
          tooltipScale="<38.2 trending · 38.2–61.8 transitioning · >61.8 choppy / ranging"
        >
          <span>
            <span className={`font-bold tabular-nums ${chop.cls}`}>{stats.chopIndex?.toFixed(1) ?? 'N/A'}</span>
            <span className={`text-xs ml-2 ${chop.cls}`}>{chop.label}</span>
          </span>
        </MetricRow>

        <MetricRow
          label="Trend Strength Score"
          tooltip="Composite: base 50; +20 Strong Uptrend / +10 Uptrend / +5 Above EMA200 / −10 Below EMA200 / −20 Downtrend. +15 if ADX≥25, −5 if ADX<20. Clamped 0–100."
          tooltipScale="≥70 strong · 55–70 good · 45–55 neutral · 35–45 weakening · <35 bearish"
        >
          <span>
            <span className={`text-xl font-bold tabular-nums ${scoreClass}`}>{score}</span>
            <span className="text-zinc-500 text-sm">/100</span>
            <span className={`text-xs ml-2 ${scoreClass}`}>{scoreLabel}</span>
          </span>
        </MetricRow>
      </div>
    </SectionCard>
  );
}
```

- [ ] **Step 3: Add the three-column grid to `<main>` in `BreadthAnalysis`**

Replace the "Grid loading…" placeholder:

```tsx
{data && (
  <main className="flex-1 overflow-y-auto">
    <RegimeBanner data={data} />
    <div className="px-4 py-6 space-y-8">
      {/* Three-column comparison grid */}
      <div className="grid grid-cols-3 gap-4">
        <IndexColumn stats={data.nifty50} />
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg flex items-center justify-center text-zinc-600 text-sm p-8">N50 Stocks — Task 5</div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg flex items-center justify-center text-zinc-600 text-sm p-8">N500 Stocks — Task 5</div>
      </div>
    </div>
  </main>
)}
```

- [ ] **Step 4: Verify in browser**

Open `http://localhost:3000/breadth`. The three-column grid should appear with the Nifty 50 Index card fully populated on the left and two placeholder boxes on the right. All metric labels should have dotted underlines; hovering shows tooltip cards.

- [ ] **Step 5: Commit**

```bash
git add rs_dashboard/components/BreadthAnalysis.tsx
git commit -m "feat(breadth): add IndexColumn with trend state, EMA levels, ADX, Chop, trend score"
```

---

### Task 5: Three-column grid — Breadth columns (N50 + N500)

**Files:**
- Modify: `rs_dashboard/components/BreadthAnalysis.tsx`

**Interfaces:**
- Consumes: `MetricRow`, `SectionCard`, `CardHeader`, `pctSignalClass`, `pctBarClass`, `Tooltip`; `BreadthStats`
- Produces: `BreadthColumn` component

- [ ] **Step 1: Add `BreadthColumn` component before `BreadthAnalysis` export**

```tsx
function BreadthColumn({ title, subtitle, stats }: { title: string; subtitle: string; stats: BreadthStats }) {
  const total = stats.totalScanned;

  const partClass = stats.participationScore >= 70 ? 'text-emerald-400' : stats.participationScore >= 55 ? 'text-lime-400' : stats.participationScore >= 45 ? 'text-yellow-400' : stats.participationScore >= 35 ? 'text-orange-400' : 'text-red-400';
  const partLabel = stats.participationScore >= 70 ? 'Strong' : stats.participationScore >= 55 ? 'Good' : stats.participationScore >= 45 ? 'Neutral' : stats.participationScore >= 35 ? 'Weak' : 'Very Weak';

  const adClass = stats.advDecRatio >= 2 ? 'text-emerald-400' : stats.advDecRatio >= 1 ? 'text-lime-400' : stats.advDecRatio >= 0.5 ? 'text-yellow-400' : 'text-red-400';
  const adLabel = stats.advDecRatio >= 3 ? 'Strongly Bullish' : stats.advDecRatio >= 2 ? 'Bullish' : stats.advDecRatio >= 1 ? 'Neutral-Bull' : stats.advDecRatio >= 0.5 ? 'Neutral-Bear' : 'Bearish';
  const netClass = stats.netAdvanceDecline >= 0 ? 'text-emerald-400' : 'text-red-400';

  const rsiElevated = stats.rsiAbove60 - stats.rsiOverbought;
  const rsiNeutral40to60 = stats.rsiBucket40to70 - rsiElevated;

  const hlRatio = stats.new52WLowCount > 0 ? stats.new52WHighCount / stats.new52WLowCount : stats.new52WHighCount;
  const hlClass = hlRatio >= 2 ? 'text-emerald-400' : hlRatio >= 1 ? 'text-yellow-400' : 'text-red-400';

  return (
    <SectionCard>
      <CardHeader title={title} subtitle={subtitle} />
      <div className="px-4 py-2">
        {/* Participation Score prominent */}
        <div className="py-3 border-b border-zinc-800/50">
          <div className="mb-1">
            <Tooltip
              label="Participation Score"
              content="Weighted composite of breadth metrics."
              scale="SMA200 pct ×0.40 + SMA50 pct ×0.30 + SMA20 pct ×0.20 + A/D transform ×0.10"
            />
          </div>
          <div className="flex items-baseline gap-2">
            <span className={`text-3xl font-bold tabular-nums ${partClass}`}>{stats.participationScore}</span>
            <span className="text-base text-zinc-500">/100</span>
            <span className={`text-xs ${partClass}`}>{partLabel}</span>
          </div>
        </div>

        <MetricRow
          label="Above SMA 200"
          tooltip="Stocks with close > 200-day simple moving average. Primary breadth/regime indicator. Note: stock breadth uses SMA; Nifty 50 Index uses EMA."
          tooltipScale="≥60% bull · 50–60% cautious · 45–50% caution/chop · 40–45% transition · <40% bear"
          bar={{ pct: stats.aboveEma200Pct, colorClass: pctBarClass(stats.aboveEma200Pct) }}
        >
          <span>
            <span className={`text-xl font-bold tabular-nums ${pctSignalClass(stats.aboveEma200Pct)}`}>{stats.aboveEma200Pct}%</span>
            <span className="text-xs text-zinc-500 ml-1">({stats.aboveEma200Count}/{total})</span>
          </span>
        </MetricRow>

        <MetricRow
          label="Above SMA 50"
          tooltip="Stocks above 50-day simple moving average — medium-term market breadth."
          bar={{ pct: stats.aboveEma50Pct, colorClass: pctBarClass(stats.aboveEma50Pct) }}
        >
          <span>
            <span className={`text-xl font-bold tabular-nums ${pctSignalClass(stats.aboveEma50Pct)}`}>{stats.aboveEma50Pct}%</span>
            <span className="text-xs text-zinc-500 ml-1">({stats.aboveEma50Count}/{total})</span>
          </span>
        </MetricRow>

        <MetricRow
          label="Above SMA 20"
          tooltip="Stocks above 20-day simple moving average — short-term breadth momentum."
          bar={{ pct: stats.aboveEma20Pct, colorClass: pctBarClass(stats.aboveEma20Pct) }}
        >
          <span>
            <span className={`text-xl font-bold tabular-nums ${pctSignalClass(stats.aboveEma20Pct)}`}>{stats.aboveEma20Pct}%</span>
            <span className="text-xs text-zinc-500 ml-1">({stats.aboveEma20Count}/{total})</span>
          </span>
        </MetricRow>

        <MetricRow
          label="Bull Power"
          tooltip="Close > SMA20 > SMA50 > SMA200 — all three MAs fully bullish-aligned. Strongest structural buy signal."
        >
          <span>
            <span className="text-emerald-400 font-bold tabular-nums">{stats.bullPowerCount}</span>
            <span className="text-xs text-zinc-500 ml-1">({stats.bullPowerPct}%)</span>
          </span>
        </MetricRow>

        <MetricRow
          label="Bear Power"
          tooltip="Close < SMA20 < SMA50 < SMA200 — all three MAs fully bearish-aligned. Strongest structural sell signal."
        >
          <span>
            <span className="text-red-400 font-bold tabular-nums">{stats.bearPowerCount}</span>
            <span className="text-xs text-zinc-500 ml-1">({stats.bearPowerPct}%)</span>
          </span>
        </MetricRow>

        <MetricRow
          label="A/D Ratio (1W)"
          tooltip="Advancing ÷ Declining stocks over past 7 calendar days (not trading days — weekend gaps included)."
          tooltipScale="≥3 strongly bullish · ≥2 bullish · ≥1 neutral-bull · <0.5 bearish"
        >
          <span>
            <span className={`font-bold tabular-nums ${adClass}`}>{stats.advDecRatio.toFixed(2)}x</span>
            <span className={`text-xs ml-1 ${adClass}`}>{adLabel}</span>
          </span>
        </MetricRow>

        <MetricRow
          label="Net A/D"
          tooltip="Advancing stocks minus Declining stocks (past 7 calendar days)."
        >
          <span className={`font-semibold tabular-nums ${netClass}`}>
            {stats.netAdvanceDecline > 0 ? '+' : ''}{stats.netAdvanceDecline}
          </span>
        </MetricRow>

        <MetricRow
          label="RSI Overbought >70"
          tooltip="14-period Wilder RSI > 70. High reading = crowded market, elevated mean-reversion risk."
          bar={{ pct: total > 0 ? (stats.rsiOverbought / total) * 100 : 0, colorClass: 'bg-red-500' }}
        >
          <span>
            <span className="text-red-400 font-semibold tabular-nums">{stats.rsiOverbought}</span>
            <span className="text-xs text-zinc-500 ml-1">({total > 0 ? ((stats.rsiOverbought / total) * 100).toFixed(1) : 0}%)</span>
          </span>
        </MetricRow>

        <MetricRow
          label="RSI Elevated 60–70"
          tooltip="RSI 60–70 = bullish momentum zone, not yet overextended. Derived: rsiAbove60 − rsiOverbought."
          bar={{ pct: total > 0 ? (rsiElevated / total) * 100 : 0, colorClass: 'bg-orange-500' }}
        >
          <span>
            <span className="text-orange-400 font-semibold tabular-nums">{rsiElevated}</span>
            <span className="text-xs text-zinc-500 ml-1">({total > 0 ? ((rsiElevated / total) * 100).toFixed(1) : 0}%)</span>
          </span>
        </MetricRow>

        <MetricRow
          label="RSI Neutral 40–60"
          tooltip="RSI 40–60 = neutral zone, no strong directional momentum. Derived: rsiBucket40to70 − (rsiAbove60 − rsiOverbought)."
          bar={{ pct: total > 0 ? (rsiNeutral40to60 / total) * 100 : 0, colorClass: 'bg-zinc-500' }}
        >
          <span>
            <span className="text-zinc-400 font-semibold tabular-nums">{rsiNeutral40to60}</span>
            <span className="text-xs text-zinc-500 ml-1">({total > 0 ? ((rsiNeutral40to60 / total) * 100).toFixed(1) : 0}%)</span>
          </span>
        </MetricRow>

        <MetricRow
          label="RSI Oversold <40"
          tooltip="14-period Wilder RSI < 40. Potential mean-reversion / oversold bounce candidates."
          bar={{ pct: total > 0 ? (stats.rsiOversold / total) * 100 : 0, colorClass: 'bg-emerald-500' }}
        >
          <span>
            <span className="text-emerald-400 font-semibold tabular-nums">{stats.rsiOversold}</span>
            <span className="text-xs text-zinc-500 ml-1">({total > 0 ? ((stats.rsiOversold / total) * 100).toFixed(1) : 0}%)</span>
          </span>
        </MetricRow>

        <MetricRow
          label="52W Highs"
          tooltip="Stocks within 0.5% of their 52-week high (trailing 252 trading days). Threshold: (close − high52W) / high52W ≥ −0.005."
        >
          <span>
            <span className="text-emerald-400 font-semibold tabular-nums">{stats.new52WHighCount}</span>
            <span className="text-xs text-zinc-500 ml-1">({total > 0 ? ((stats.new52WHighCount / total) * 100).toFixed(1) : 0}%)</span>
          </span>
        </MetricRow>

        <MetricRow
          label="52W Lows"
          tooltip="Stocks within 0.5% of their 52-week low (trailing 252 trading days). Threshold: (close − low52W) / low52W ≤ 0.005."
        >
          <span>
            <span className="text-red-400 font-semibold tabular-nums">{stats.new52WLowCount}</span>
            <span className="text-xs text-zinc-500 ml-1">({total > 0 ? ((stats.new52WLowCount / total) * 100).toFixed(1) : 0}%)</span>
          </span>
        </MetricRow>

        <MetricRow
          label="H/L Ratio"
          tooltip="New 52W Highs ÷ New 52W Lows. Measures balance of bullish vs bearish price extremes."
          tooltipScale="≥2 bullish · ≥1 slightly bullish · <0.5 bearish"
        >
          <span className={`font-bold tabular-nums ${hlClass}`}>
            {stats.new52WLowCount > 0 ? hlRatio.toFixed(2) + 'x' : `${stats.new52WHighCount}H / 0L`}
          </span>
        </MetricRow>
      </div>
    </SectionCard>
  );
}
```

- [ ] **Step 2: Replace placeholder columns with `BreadthColumn` in the three-column grid**

In `BreadthAnalysis` main, update the three-column grid:

```tsx
<div className="grid grid-cols-3 gap-4">
  <IndexColumn stats={data.nifty50} />
  <BreadthColumn title="NIFTY 50 STOCKS" subtitle="50 constituents" stats={data.nifty50Breadth} />
  <BreadthColumn title="NIFTY 500 STOCKS" subtitle="500 universe" stats={data.nifty500Breadth} />
</div>
```

- [ ] **Step 3: Verify in browser**

Open `http://localhost:3000/breadth`. All three columns should be fully populated. Scan visually:
- N50 Stocks column shows `totalScanned` ~50, N500 column ~450–500.
- All percentage bars are colored correctly (emerald ≥60%, red <40%).
- Hovering RSI Neutral 40–60 tooltip explains the derivation formula.
- N50 and N500 breadth columns are visually identical in structure — easy to compare divergences.

- [ ] **Step 4: Commit**

```bash
git add rs_dashboard/components/BreadthAnalysis.tsx
git commit -m "feat(breadth): add BreadthColumn for N50 and N500 — 14 metric rows with tooltips and mini-bars"
```

---

### Task 6: Detail sections + wire final layout + remove old dead code

**Files:**
- Modify: `rs_dashboard/components/BreadthAnalysis.tsx`

**Interfaces:**
- Consumes: `SectionCard`, `CardHeader`, `Tooltip`, `pctSignalClass`, `pctBarClass`, `REGIME_META`; `BreadthStats`, `BreadthResponse`
- Produces: `MAPenetrationTable`, `RSIDistribution`, `Extremes52W`, `RegimeGuide` components; complete `BreadthAnalysis` export with all sections wired

- [ ] **Step 1: Add `MAPenetrationTable` component**

```tsx
function MAPenetrationTable({ n50, n500 }: { n50: BreadthStats; n500: BreadthStats }) {
  const rows = (stats: BreadthStats) => [
    {
      label: 'Above SMA 20', count: stats.aboveEma20Count, pct: stats.aboveEma20Pct,
      signal: stats.aboveEma20Pct > 60 ? 'Short-term broadly bullish' : stats.aboveEma20Pct > 40 ? 'Mixed; watch for expansion' : 'Short-term breadth weak',
    },
    {
      label: 'Above SMA 50', count: stats.aboveEma50Count, pct: stats.aboveEma50Pct,
      signal: stats.aboveEma50Pct > 55 ? 'Medium-term healthy breadth' : stats.aboveEma50Pct > 40 ? 'Neutral; caution advised' : 'Medium-term deteriorating',
    },
    {
      label: 'Above SMA 200', count: stats.aboveEma200Count, pct: stats.aboveEma200Pct,
      signal: stats.aboveEma200Pct >= 60 ? 'Structural bull' : stats.aboveEma200Pct >= 50 ? 'Cautiously positive' : stats.aboveEma200Pct >= 40 ? 'Transition zone' : 'Structural bear',
    },
  ];

  return (
    <div>
      <div className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">MA Penetration Detail</div>
      <div className="grid grid-cols-2 gap-4">
        {([['NIFTY 50 STOCKS', n50], ['NIFTY 500 STOCKS', n500]] as [string, BreadthStats][]).map(([label, stats]) => (
          <SectionCard key={label}>
            <CardHeader title={label} subtitle="Simple moving average penetration" />
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-zinc-800">
                    {['Indicator', 'Count', '% Universe', 'Below', 'Signal'].map(h => (
                      <th key={h} className="text-left px-3 py-2 text-xs font-bold text-white uppercase tracking-widest border-b border-zinc-700">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows(stats).map(row => {
                    const rowBg = row.pct >= 60 ? 'bg-emerald-950/40' : row.pct < 40 ? 'bg-red-950/40' : '';
                    return (
                      <tr key={row.label} className={`border-b border-zinc-800/50 ${rowBg}`}>
                        <td className="px-3 py-2.5 text-xs text-zinc-300">{row.label}</td>
                        <td className={`px-3 py-2.5 text-sm font-bold tabular-nums ${pctSignalClass(row.pct)}`}>{row.count}</td>
                        <td className={`px-3 py-2.5 text-sm font-bold tabular-nums ${pctSignalClass(row.pct)}`}>{row.pct}%</td>
                        <td className="px-3 py-2.5 text-xs text-zinc-500">{stats.totalScanned - row.count} ({(100 - row.pct).toFixed(1)}%)</td>
                        <td className="px-3 py-2.5 text-xs text-zinc-400">{row.signal}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </SectionCard>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add `RSIDistribution` component**

```tsx
function RSIDistribution({ n50, n500 }: { n50: BreadthStats; n500: BreadthStats }) {
  function buildSegs(stats: BreadthStats) {
    const total = stats.totalScanned;
    const elevated = stats.rsiAbove60 - stats.rsiOverbought;
    const neutral = stats.rsiBucket40to70 - elevated;
    return [
      { label: '>70 Overbought', count: stats.rsiOverbought, pct: total > 0 ? (stats.rsiOverbought / total) * 100 : 0, bg: 'bg-red-500' },
      { label: '60–70 Elevated', count: elevated, pct: total > 0 ? (elevated / total) * 100 : 0, bg: 'bg-orange-500' },
      { label: '40–60 Neutral', count: neutral, pct: total > 0 ? (neutral / total) * 100 : 0, bg: 'bg-zinc-600' },
      { label: '<40 Oversold', count: stats.rsiOversold, pct: total > 0 ? (stats.rsiOversold / total) * 100 : 0, bg: 'bg-emerald-500' },
    ];
  }

  return (
    <div>
      <div className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">
        <Tooltip label="RSI Distribution (14-Period)" content="Wilder RSI computed over trailing 60 closes per stock. Buckets: >70 overbought, 60–70 elevated, 40–60 neutral, <40 oversold." />
      </div>
      <div className="grid grid-cols-2 gap-4">
        {([['NIFTY 50 STOCKS', n50], ['NIFTY 500 STOCKS', n500]] as [string, BreadthStats][]).map(([label, stats]) => {
          const segs = buildSegs(stats);
          return (
            <SectionCard key={label}>
              <CardHeader title={label} subtitle="RSI zone breakdown" />
              <div className="px-4 py-4">
                <div className="h-10 flex rounded overflow-hidden gap-px mb-4">
                  {segs.map(seg => (
                    <div
                      key={seg.label}
                      className={`${seg.bg} flex items-center justify-center`}
                      style={{ width: `${seg.pct}%`, minWidth: seg.pct > 0 ? 2 : 0 }}
                    >
                      {seg.pct > 8 && (
                        <span className="text-xs text-white font-bold">{seg.pct.toFixed(0)}%</span>
                      )}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-y-2">
                  {segs.map(seg => (
                    <div key={seg.label} className="flex items-center justify-between pr-4">
                      <div className="flex items-center gap-1.5">
                        <div className={`w-2 h-2 rounded-sm flex-shrink-0 ${seg.bg}`} />
                        <span className="text-xs text-zinc-400">{seg.label}</span>
                      </div>
                      <span className="text-xs font-semibold tabular-nums text-zinc-200">
                        {seg.count} <span className="text-zinc-500">({seg.pct.toFixed(1)}%)</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </SectionCard>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add `Extremes52W` component**

```tsx
function Extremes52W({ n50, n500 }: { n50: BreadthStats; n500: BreadthStats }) {
  function Panel({ stats, label }: { stats: BreadthStats; label: string }) {
    const total = stats.totalScanned;
    const highPct = total > 0 ? (stats.new52WHighCount / total) * 100 : 0;
    const lowPct = total > 0 ? (stats.new52WLowCount / total) * 100 : 0;
    const ratio = stats.new52WLowCount > 0 ? stats.new52WHighCount / stats.new52WLowCount : stats.new52WHighCount;
    const ratioClass = ratio >= 2 ? 'text-emerald-400' : ratio >= 1 ? 'text-yellow-400' : 'text-red-400';
    const ratioLabel = ratio >= 2 ? 'Bullish — highs dominating' : ratio >= 1 ? 'Slightly bullish' : ratio >= 0.5 ? 'Slightly bearish' : 'Bearish — lows dominating';

    return (
      <SectionCard>
        <CardHeader title={label} subtitle="Within 0.5% of 52-week extreme" />
        <div className="px-4 py-4 space-y-4">
          <div>
            <div className="flex justify-between mb-1.5">
              <Tooltip label="New 52W Highs" content="Stocks within 0.5% of their 52-week high. Formula: (close − high52W) / high52W ≥ −0.005." />
              <span className="text-emerald-400 text-sm font-semibold tabular-nums">
                {stats.new52WHighCount} <span className="text-zinc-500 text-xs">({highPct.toFixed(1)}%)</span>
              </span>
            </div>
            <div className="h-2 bg-zinc-800 rounded-full">
              <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${highPct}%` }} />
            </div>
          </div>

          <div>
            <div className="flex justify-between mb-1.5">
              <Tooltip label="New 52W Lows" content="Stocks within 0.5% of their 52-week low. Formula: (close − low52W) / low52W ≤ 0.005." />
              <span className="text-red-400 text-sm font-semibold tabular-nums">
                {stats.new52WLowCount} <span className="text-zinc-500 text-xs">({lowPct.toFixed(1)}%)</span>
              </span>
            </div>
            <div className="h-2 bg-zinc-800 rounded-full">
              <div className="h-full bg-red-500 rounded-full" style={{ width: `${lowPct}%` }} />
            </div>
          </div>

          <div className="pt-3 border-t border-zinc-800">
            <Tooltip
              label="H/L Ratio"
              content="New 52W Highs ÷ New 52W Lows. Positive divergence: N50 highs dominate while N500 shows fewer — signals narrow market leadership."
              scale="≥2 bullish · ≥1 slightly bullish · <0.5 bearish"
            />
            <div className={`text-2xl font-bold tabular-nums mt-1 ${ratioClass}`}>
              {stats.new52WLowCount > 0 ? ratio.toFixed(2) + 'x' : `${stats.new52WHighCount}H / 0L`}
            </div>
            <div className={`text-xs mt-0.5 ${ratioClass}`}>{ratioLabel}</div>
          </div>
        </div>
      </SectionCard>
    );
  }

  return (
    <div>
      <div className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">52-Week Extremes</div>
      <div className="grid grid-cols-2 gap-4">
        <Panel stats={n50} label="NIFTY 50 STOCKS" />
        <Panel stats={n500} label="NIFTY 500 STOCKS" />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add `RegimeGuide` component**

```tsx
function RegimeGuide({ activeColor }: { activeColor: BreadthResponse['regimeColor'] }) {
  return (
    <SectionCard>
      <CardHeader title="REGIME INTERPRETATION GUIDE" subtitle="Breadth-derived market regime thresholds — based on Nifty 500 % above 200d SMA" />
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-zinc-800">
              {['Regime', 'Condition (Nifty 500)', 'Trading Action'].map(h => (
                <th key={h} className="text-left px-4 py-2.5 text-xs font-bold text-white uppercase tracking-widest border-b border-zinc-700">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(Object.entries(REGIME_META) as [BreadthResponse['regimeColor'], typeof REGIME_META[keyof typeof REGIME_META]][]).map(([key, meta]) => {
              const isActive = key === activeColor;
              return (
                <tr
                  key={key}
                  className={`border-b border-zinc-800/50 border-l-4 ${isActive ? `${meta.bg} ${meta.accent}` : 'border-l-transparent'}`}
                >
                  <td className={`px-4 py-3 text-sm font-semibold ${isActive ? meta.text : 'text-zinc-600'}`}>
                    {isActive && <span className="mr-1.5">▶</span>}{meta.label}
                  </td>
                  <td className={`px-4 py-3 text-sm ${isActive ? 'text-zinc-200' : 'text-zinc-600'}`}>{meta.condition}</td>
                  <td className={`px-4 py-3 text-sm ${isActive ? 'text-zinc-300' : 'text-zinc-700'}`}>{meta.action}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
```

- [ ] **Step 5: Wire all detail sections into `BreadthAnalysis` main and remove "Grid loading…" placeholder**

Replace the `<main>` content in `BreadthAnalysis`:

```tsx
{data && (
  <main className="flex-1 overflow-y-auto">
    <RegimeBanner data={data} />
    <div className="px-4 py-6 space-y-8">
      {/* Three-column comparison grid */}
      <div className="grid grid-cols-3 gap-4">
        <IndexColumn stats={data.nifty50} />
        <BreadthColumn title="NIFTY 50 STOCKS" subtitle="50 constituents" stats={data.nifty50Breadth} />
        <BreadthColumn title="NIFTY 500 STOCKS" subtitle="500 universe" stats={data.nifty500Breadth} />
      </div>

      <MAPenetrationTable n50={data.nifty50Breadth} n500={data.nifty500Breadth} />
      <RSIDistribution n50={data.nifty50Breadth} n500={data.nifty500Breadth} />
      <Extremes52W n50={data.nifty50Breadth} n500={data.nifty500Breadth} />
      <RegimeGuide activeColor={data.regimeColor} />
    </div>
  </main>
)}
```

- [ ] **Step 6: Verify full page in browser**

Open `http://localhost:3000/breadth` and scroll through the complete page:
- Header → Regime Banner → Three-column grid → MA Penetration → RSI Distribution → 52W Extremes → Regime Guide
- Hover 10+ different metric labels; confirm tooltip cards appear with formula text
- Confirm N50 Stocks column shows ~50 total, N500 shows ~450–500
- Confirm MA Penetration table row highlights green (pct ≥ 60%) or red (pct < 40%)
- Confirm RSI stacked bar segments show correct proportions with % labels inside segments >8%
- Confirm Regime Guide highlights the active row with colored left border

- [ ] **Step 7: Check TypeScript — confirm no errors in terminal**

In the dev server terminal, confirm no TypeScript errors are logged. If `rsiNeutral` is referenced anywhere it will show as "Property does not exist". Fix any remaining `rsiNeutral` → `rsiBucket40to70` references.

- [ ] **Step 8: Commit**

```bash
git add rs_dashboard/components/BreadthAnalysis.tsx
git commit -m "feat(breadth): add detail sections — MA table, RSI distribution, 52W extremes, regime guide"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| Three-universe comparison: N50 Index / N50 Stocks / N500 Stocks | Tasks 4, 5 |
| Full N50 constituent breadth suite (all BreadthStats fields) | Task 1 (API) |
| Data journalism style — zinc cards, prominent numbers, system font | Task 2 |
| Inline formula/definition tooltips on every metric | Tasks 2–6 (Tooltip on each MetricRow) |
| SMA vs EMA labeling fix | Task 1 (API labels), Tasks 4–5 (tooltip text) |
| `rsiBucket40to70` rename (was `rsiNeutral`) | Task 1 (API), Task 5 (component) |
| `nifty50BreadthPct` removed from IndexStats | Task 1 |
| Remove semi-circle gauges | Task 2 (not included in new file) |
| Regime banner with Participation Score, A/D, Net A/D from N500 | Task 3 |
| Regime guide table with active row highlight | Task 6 |
| DATA: date chip in header | Task 2 |
| MA Penetration Table (N50 + N500) | Task 6 |
| RSI Distribution stacked bars (N50 + N500) | Task 6 |
| 52W Extremes (N50 + N500) | Task 6 |
| Participation score formula in tooltip | Tasks 3, 5 |

**Placeholder scan:** No TBDs. All code blocks are complete.

**Type consistency:**
- `BreadthStats.rsiBucket40to70` — defined in Task 1, consumed in Task 5 as `stats.rsiBucket40to70`. ✓
- `BreadthResponse.nifty50Breadth` — defined in Task 1, consumed in Tasks 5, 6. ✓
- `adxInfo()` / `chopInfo()` — defined in Task 4, used only in `IndexColumn`. ✓
- `getTrendStrengthScore(stats: IndexStats)` — defined in Task 2, used in Task 4. ✓
- `REGIME_META` — defined in Task 2, used in Tasks 3, 6. ✓
