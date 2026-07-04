# Expiry Analysis Page — Design Spec

**Date:** 2026-07-04  
**Status:** Approved

---

## Context

The Dhan Algo dashboard lacks a dedicated view for analyzing how Nifty moves behave across weekly options expiry cycles. Traders using straddle/strangle strategies need to know which historical expiry weeks produced extreme moves (outliers) versus normal decay, and what the historical probability of a given return range is. This page answers that by plotting every weekly OC return (Wednesday open → Tuesday close) as a scatter chart, with a user-controlled probability boundary to identify outliers.

---

## What We're Building

A new **Expiry Analysis** page under the **Market Health** nav group, showing:

- A scatter plot of Nifty weekly OC returns (one dot per expiry week)
- User-adjustable probability boundary slider (symmetric two-tailed percentile)
- Dots color-coded: gray = within boundary, green = upside outlier, red = downside outlier
- Summary stats: total expiries, total outliers, upside/downside counts
- Outlier table sorted by absolute return magnitude

Scope: weekly only (Wed open → Tue close), Nifty 50, OC return. Monthly and H-L modes are out of scope for this spec.

---

## Architecture

### New Files

| File | Purpose |
|------|---------|
| `app/expiry-analysis/page.tsx` | Thin App Router page, renders `<ExpiryAnalysis />` |
| `components/ExpiryAnalysis.tsx` | Full `'use client'` component — data fetch, chart, table |
| `app/api/expiry-analysis/route.ts` | GET endpoint: CSV → weekly buckets → JSON |

### Modified Files

| File | Change |
|------|--------|
| `components/NavBar.tsx` | Add `{ href: '/expiry-analysis', label: 'Expiry Analysis', desc: '...' }` under Market Health |

### Data Flow

```
CSV (NIFTY_50_Daily_5Y.csv)
  ↓ readNifty50Index()          [server, cached 5 min]
  ↓ bucket into Wed→Tue weeks   [server]
  ↓ GET /api/expiry-analysis?startDate=&endDate=
  ↓ { weeks: WeeklyBucket[] }   [JSON to client]
  ↓ classify() on slider change  [client, instant]
  ↓ Recharts ScatterChart        [render]
```

---

## API Route

**Endpoint:** `GET /api/expiry-analysis`

**Query params:**
- `startDate` — ISO date string, default 5 years ago
- `endDate` — ISO date string, default today

**Logic:**
1. Call `readNifty50Index()` from `lib/dataLoader.ts` (existing, cached)
2. Filter rows to `[startDate, endDate]`
3. Walk rows in chronological order; open a bucket when weekday = Wednesday (getDay() === 3), close it when weekday = Tuesday (getDay() === 2)
4. Discard incomplete buckets (holiday gap caused Wed or Tue to be missing)
5. Return `returnPct = (tueClose − wedOpen) / wedOpen * 100`

**Response shape:**
```ts
{
  weeks: {
    wedDate: string    // "2021-02-03"
    tueDate: string    // "2021-02-09"
    wedOpen: number
    tueClose: number
    returnPct: number  // rounded to 2 decimal places
  }[]
  dataStart: string    // earliest date in CSV
  dataEnd: string      // latest date in CSV
}
```

No boundary classification server-side — that stays client-side so the slider doesn't need a network round-trip.

---

## Client Component (`ExpiryAnalysis.tsx`)

### State
- `weeks: WeeklyBucket[]` — raw API response
- `startDate`, `endDate` — controlled date inputs (strings)
- `probability: number` — slider value, 0.70–0.99, default 0.95
- `loading`, `error` — fetch status

### Derived (useMemo)
- `filtered` — `weeks` sliced to `[startDate, endDate]`
- `boundaries: { lower, upper }` — percentile classification
- `classified` — each bucket tagged `'within' | 'upside' | 'downside'`
- `withinData`, `upsideData`, `downsideData` — three Recharts-ready arrays
- `outliers` — `classified.filter(w => w.status !== 'within')` sorted by `|returnPct|` desc
- `tueTimestamp` — computed as `new Date(w.tueDate).getTime()` per bucket; used as numeric X-axis key for `ScatterChart` time scale

### Boundary Classification
```ts
function classify(returnPcts: number[], probability: number) {
  const sorted = [...returnPcts].sort((a, b) => a - b)
  const tail = (1 - probability) / 2
  const lower = sorted[Math.floor(tail * sorted.length)]
  const upper = sorted[Math.floor((1 - tail) * sorted.length) - 1]
  return { lower, upper }
}
```

---

## UI Layout

### Sticky Header (z-30)
- Left: `TrendingUp` icon + "Expiry Analysis" title + "Weekly OC Return Distribution" subtitle
- Center: `<NavBar />`
- Right: `DATA: YYYY-MM-DD` chip (latest tueDate in data)

### Controls Bar (card below header)
Single horizontal row:
- Start date `<input type="date">` + End date `<input type="date">` — defaults: 5Y ago to today
- Probability boundary slider (70–99, step 1) with live label: `"95% → lower: -3.72% / upper: +3.52%"`

### Main Chart Card
- Title: "Outliers Distribution (Survivability Scatter Plot)"
- `ResponsiveContainer` height 420px
- Recharts `ScatterChart` with three `<Scatter>` series:
  - Within boundary: `fill="#52525b"` (zinc-600), r=3, opacity 0.7
  - Upside outlier: `fill="#34d399"` (emerald-400), r=5
  - Downside outlier: `fill="#f87171"` (red-400), r=5
- `ReferenceLine y={upper}` — dashed `#34d399`, label at left edge
- `ReferenceLine y={lower}` — dashed `#f87171`, label at left edge
- X-axis: `dataKey="tueTimestamp"` (epoch ms), `type="number"`, `domain="auto"`, `tickFormatter` → year label, `scale="time"`
- Y-axis: `domain` auto-padded 10%, tick format `{v}%`
- `CartesianGrid` — `stroke="#27272a"` horizontal only
- Custom `<Tooltip>` — shows Wed date, Tue date (expiry), return %, status badge
- Legend: Within / Upside Outlier / Downside Outlier

### Stats Row (4 tiles)
```
Total Expiries    Total Outliers     Downside Outliers   Upside Outliers
     253          14 (5.5%)               7                   7
  text-white     text-amber-400        text-red-400       text-emerald-400
```

### Outlier Table
Columns: `Expiry Start (Wed)` · `Expiry End (Tue)` · `Return %` · `Status`
- Sorted by `|returnPct|` descending
- Return % cell: red text for negative, green text for positive
- Status badge: `bg-red-500/10 text-red-400 border-red-500/30` / `bg-emerald-500/10 text-emerald-400 border-emerald-500/30`
- Table header: `text-xs font-bold text-white bg-zinc-800` (per CLAUDE.md convention)

---

## Styling Conventions

Follows existing dashboard patterns from CLAUDE.md:
- No `text-color/opacity` modifiers on text — use solid zinc steps
- Table headers: `text-xs font-bold text-white bg-zinc-800`
- Data date chip in sticky header on all data pages
- Dark theme always (hardcoded `dark` class on `<html>`)
- Recharts: `isAnimationActive={false}`, no per-point dots on line charts

---

## Verification

1. Run `npm run dev` in `rs_dashboard/`
2. Navigate to `http://localhost:3000/expiry-analysis`
3. Verify scatter chart loads with ~250 dots
4. Move slider to 80% — confirm ~40 dots (20%) turn red/green
5. Move slider to 99% — confirm only the most extreme 1% are colored outliers
6. Change date range start to 3 years ago — chart should update with fewer dots
7. Check outlier table rows match colored dots in chart
8. Verify "Market Health" nav dropdown includes the new link
9. Confirm DATA chip shows the latest Tuesday date in the dataset
