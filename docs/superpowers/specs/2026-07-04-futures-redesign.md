# Futures Page Redesign

**Date:** 2026-07-04  
**Scope:** `rs_dashboard/components/FuturesDashboard.tsx`, `rs_dashboard/components/OIBuildupDashboard.tsx`, `rs_dashboard/app/api/futures/route.ts`

---

## Goal

Replace the current tab-split futures page (Index Futures tab + OI Buildup tab) with a single, unified scrollable dashboard that is visually richer, more professional, and contains all the same data in a more useful layout. Also fix the Open Interest display ambiguity (unlabeled units).

---

## Layout — Top to Bottom

### 1. Sticky Header

- Left: Activity icon + "Futures Monitor" title + `DATA: YYYY-MM-DD` chip
- Centre: `NavBar`
- Right: Download Data button + Reload (RefreshCw) button
- **Remove** the `Index Futures / OI Buildup` tab selector — it is no longer needed

### 2. Summary Strip

Two side-by-side compact summary cards (one per instrument), immediately below the header.

Each card contains:
- Instrument name (NIFTY / BANKNIFTY) — large, bold
- Near-contract price
- Basis chip (coloured: emerald if positive, red if negative, zinc if null)
- OI direction badge: `▲ Building` (emerald) if near-contract `oiChange > 0`, `▼ Unwinding` (red) if < 0, `— Neutral` (zinc) if 0 or no data
- DTE chip: red ≤ 5d, amber ≤ 15d, zinc otherwise

Cards sit in a `flex gap-4` row; each is `flex-1 min-w-[280px]`.

### 3. Instrument Sections (NIFTY, then BANKNIFTY)

Each instrument gets its own titled section with a gradient accent border on the left. Two sub-components:

#### 3a. Contract Comparison Table

A full-width `<table>` with one row per contract (Near / Mid / Far). Columns:

| # | Column | Notes |
|---|--------|-------|
| 1 | Contract | `fmtLabel` — e.g. "Jul 24" + DTE chip inline |
| 2 | Price | Bold, tabular-nums |
| 3 | Open | |
| 4 | High | Emerald text |
| 5 | Low | Red text |
| 6 | Volume | `fmtLakh` |
| 7 | OI (contracts) | `fmtLakh` — header explicitly says "(contracts)" to remove ambiguity |
| 8 | OI Δ | `fmtChange`, coloured green/red |
| 9 | Basis | `fmtBasis`, coloured; blank (`—`) for BANKNIFTY |
| 10 | CoC% | Annualised cost of carry — see formula below; blank for BANKNIFTY |
| 11 | DTE | Coloured days |

**CoC% formula:**
```
coc = (basis / spotClose) * (365 / daysToExpiry) * 100
```
- Positive CoC = contango (futures above spot)
- Negative CoC = backwardation
- Formatted as `+0.82%` with emerald/red colour
- Shown as `—` when `basis` is null (BANKNIFTY) or `daysToExpiry <= 0`

The API route (`/api/futures`) must expose `spotClose` or `coc` per contract. Simplest approach: compute `coc` in the API and add it to `ContractStats`.

#### 3b. OI Trend Chart

An SVG line chart (height 160px, full width) replacing the current tiny sparkline.

- Up to 3 lines: Near (sky-400), Mid (violet-400), Far (amber-400)
- Y-axis: 4–5 tick labels in lakh contracts format (`fmtLakh`)
- X-axis: date ticks at month boundaries (show month abbreviation)
- Legend: coloured dots with contract label, positioned top-right inside chart
- If a contract has no OI data, omit its line and show a `no data` note in the legend
- Chart area has a subtle gradient fill under each line (opacity 0.08)

Data comes from `sparkline` arrays already in the API response — no new data fetching needed.

#### 3c. Cost of Carry Callout

A single text line below the chart:
```
Near-month CoC: +0.82% p.a. (contango)   |   Mid-month: +1.14% p.a.
```
Shown only when `basis !== null`. Omitted for BANKNIFTY.

### 4. OI Buildup Section

Full-width section with heading "Stock Futures — OI Buildup" and `DATA: date` chip.

The existing 2×2 quadrant grid (`OIBuildupDashboard`) is retained unchanged in functionality. Visual polish only:
- Section heading matches the instrument section style
- Cards use consistent border/background with the rest of the page

---

## OI Display Fix

**Problem:** The column currently labelled `OI` displays values formatted with `fmtLakh` (e.g. `12.3L`), which looks like ₹12.3 lakh (a monetary value). OI is actually stored and displayed in **contracts** (number of open futures contracts). This creates confusion.

**Fix:**
1. Column header: change `OI` → `OI (contracts)` in both `FuturesDashboard` (contract table) and `OIBuildupDashboard` (quadrant tables).
2. No change to the formatter — `fmtLakh` is fine; the header label carries the unit context.
3. OI Δ column: similarly label as `OI Δ (contracts)` or keep short as `OI Δ` with a subtitle row or tooltip.

**OI change computation** (`latestOI - prevOI` from daily rows) is logically correct. No code change needed there.

---

## Files to Change

| File | Change |
|------|--------|
| `rs_dashboard/app/api/futures/route.ts` | Add `coc: number \| null` field to `ContractStats`; compute in `buildContracts` |
| `rs_dashboard/components/FuturesDashboard.tsx` | Full rewrite: remove tabs, add summary strip, replace `ContractCard` with contract table + OI chart per instrument |
| `rs_dashboard/components/OIBuildupDashboard.tsx` | Column header fix (`OI` → `OI (contracts)`); minor visual polish |

---

## Data Contracts

### Updated `ContractStats` (route.ts)

```ts
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
  coc: number | null;          // NEW: annualised cost of carry %
  sparkline: { time: string; oi: number }[];
}
```

### CoC computation in `buildContracts`

```ts
const coc =
  useSpot && spotClose && spotClose > 0 && daysToExpiry > 0
    ? ((latestClose - spotClose) / spotClose) * (365 / daysToExpiry) * 100
    : null;
```

---

## Visual / Style Notes

- All section headings: `text-sm font-bold text-zinc-100` with a `border-l-2 border-sky-500 pl-3`
- Table header row: `bg-zinc-800 text-xs font-bold text-white` (per CLAUDE.md convention)
- No `text-white/70` or opacity on text — use solid zinc scale (per CLAUDE.md)
- Chart fills: `fill` with opacity via `fillOpacity` SVG attribute, not Tailwind opacity modifiers
- Instrument section divider: `border-t border-zinc-800 pt-6 mt-6`
- OI Buildup section: `border-t border-zinc-800 pt-6 mt-6`

---

## Out of Scope

- Live/real-time data (WebSocket tick streaming for futures prices)
- Adding new data sources beyond what the existing CSV files provide
- Mobile-specific layout (responsive flex-wrap is sufficient)
