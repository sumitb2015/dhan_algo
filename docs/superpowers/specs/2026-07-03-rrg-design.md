# RRG (Relative Rotation Graph) — Design Spec

**Date:** 2026-07-03  
**Status:** Approved

---

## Context

The dashboard already tracks sector index performance (29 indices, 27 CSVs under `Historical Data/Indices/`) and computes RS ratios in `lib/rs.ts`. Users want a Relative Rotation Graph — a 2D scatter chart plotting JdK RS-Ratio (x) vs JdK RS-Momentum (y) with animated tails showing how each symbol rotates through the four quadrants (Leading / Weakening / Lagging / Improving) relative to Nifty 50.

---

## Universes & Benchmark

- **Sector Indices** (default): 27 indices from `KNOWN_INDICES` in `lib/dataLoader.ts`, loaded via `readIndexCSV()`
- **Nifty 50 Stocks**: 50 symbols from `NIFTY50_SYMBOLS` in `lib/nifty50.ts`, loaded via `readStockCSV()`
- **Benchmark**: Nifty 50 (fixed), loaded via `readNifty50Index()`

---

## Math (JdK RS-Ratio / RS-Momentum)

Fixed parameters — not user-configurable:
- Smoothing window **n = 10**
- Momentum lookback **m = 1** (1-period ROC of RS-Ratio)
- Scaling factor **k = 1** (z-score normalization already controls spread)

### Per symbol, per date t:

```
RS_raw(t)     = close_symbol(t) / close_benchmark(t) × 100

RS_Ratio(t)   = 100 + (RS_raw(t) − SMA(RS_raw, 10)(t)) / STDEV(RS_raw, 10)(t)
                   [x-axis; >100 = outperforming]

RS_Momentum(t) = 100 + (RS_Ratio(t) − RS_Ratio(t−1)) / STDEV(RS_Ratio, 10)(t)
                   [y-axis; >100 = momentum rising]
```

Minimum required history before first valid point: ~20 prices (10 for RS_Ratio's SMA/STDEV + 10 more for RS_Momentum's STDEV of RS_Ratio series).

### Weekly timeframe

Downsample daily closes to last trading day of each calendar week before running the formulas above.

---

## API Route

**File:** `rs_dashboard/app/api/rrg/route.ts`

### Query params

| Param | Values | Default |
|---|---|---|
| `universe` | `indices` \| `nifty50` | `indices` |
| `timeframe` | `daily` \| `weekly` | `daily` |
| `lookback` | integer (number of output periods to return) | `252` |

### Response

```ts
interface RRGResponse {
  universe: 'indices' | 'nifty50'
  timeframe: 'daily' | 'weekly'
  dataDate: string          // most recent date across all symbols
  symbols: RRGSeries[]
}

interface RRGSeries {
  symbol: string
  label: string             // human-readable name
  color: string             // stable hex color, pre-assigned per symbol
  history: RRGPoint[]       // chronological, length ≤ lookback
}

interface RRGPoint {
  date: string              // 'YYYY-MM-DD'
  rsRatio: number           // x-axis
  rsMomentum: number        // y-axis
}
```

### Caching

5-minute in-memory cache keyed by `${universe}-${timeframe}`, same pattern as `normCache` in `app/api/normalized/route.ts`.

### Color assignment

Pre-assign 27 stable colors for indices (reuse the sector color map from `lib/sectors.ts` where available; fill gaps with a fixed palette). For Nifty 50 stocks, cycle through the same palette deterministically by sorted symbol name.

---

## Chart Rendering

**File:** `rs_dashboard/components/RRGDashboard.tsx` (client component)

**Approach:** Custom SVG — same pattern as `NormalizedChart.tsx`. No Recharts (can't natively do trail polylines + quadrant fills).

### SVG layout (600 × 600 logical units, `viewBox`)

- 4 quadrant background fills (semi-transparent):
  - Top-right: `rgba(34,197,94,0.10)` — **LEADING**
  - Bottom-right: `rgba(234,179,8,0.10)` — **WEAKENING**
  - Bottom-left: `rgba(239,68,68,0.10)` — **LAGGING**
  - Top-left: `rgba(6,182,212,0.10)` — **IMPROVING**
- Axes at x=100, y=100 (center lines, not origin)
- Quadrant labels at corners (LEADING / WEAKENING / LAGGING / IMPROVING)
- Axis titles: "JdK RS-Ratio →" and "↑ JdK RS-Momentum"

### Per-symbol rendering

```
visible_tail = history.slice(playhead − tailCount + 1, playhead + 1)
```

- `<polyline>` connecting tail points, stroke opacity fades from 0.2 (oldest) to 1.0 (newest)
- Filled `<circle>` (r=5) at the head (latest point)
- Small arrowhead at head showing direction from penultimate → head
- `<text>` label near the head dot (hidden when symbols are crowded — toggle via checkbox)

### Coordinate mapping

```
xS(rsRatio)   → maps [97, 103] to [margin, width − margin]
yS(rsMomentum) → maps [103, 97] to [margin, height − margin]   (y-axis inverted)
```

Auto-scales to actual data bounds with 10% padding if values exceed the [97,103] default range.

---

## Controls

```
[Indices | Nifty 50]   [Daily | Weekly]   Tail: [___5___] periods
              [⏮ Reset]  [▶ Play / ⏸ Pause]  Speed: [● Slow ○ Normal ○ Fast]
```

- Universe toggle → refetches data
- Timeframe toggle → refetches data
- Tail count: `<input type="number">` min=1 max=30, default=5
- Reset: sets `playhead` to `history.length − 1` (latest), stops playback
- Play/Pause: toggles `isPlaying`
- Speed: 600ms / 300ms / 100ms per step

**Playback state (React `useState`):**

| State | Type | Initial |
|---|---|---|
| `playhead` | number | `history.length − 1` |
| `isPlaying` | boolean | `false` |
| `speed` | `'slow'\|'normal'\|'fast'` | `'normal'` |
| `tailCount` | number | `5` |
| `activeSymbols` | `Set<string>` | all |
| `universe` | `'indices'\|'nifty50'` | `'indices'` |
| `timeframe` | `'daily'\|'weekly'` | `'daily'` |

`useEffect` with `setInterval` increments playhead while `isPlaying`; clears on pause or end.

---

## Symbol Selector (Left Panel)

Matches screenshot's left panel:

- **Indices universe**: checkboxes for all 27 indices, grouped by category. "Select All / None" toggle.
- **Nifty 50 universe**: checkboxes for 50 stocks with a search/filter input.
- Each row shows: colored indicator square, symbol name, current price, % change (from latest `history` point's rsRatio minus 100, expressed as rank context).

---

## Page & Navigation

**New page:** `rs_dashboard/app/rrg/page.tsx` — thin RSC, renders `<RRGDashboard />`.

**Navigation:** Add `{ href: '/rrg', label: 'RRG' }` to the nav items array (locate exact file during implementation — likely `components/Sidebar.tsx` or `components/Nav.tsx`).

**Sticky header chip:** `DATA: YYYY-MM-DD` per CLAUDE.md convention.

---

## Files to Create / Modify

| Action | File |
|---|---|
| **Create** | `rs_dashboard/app/rrg/page.tsx` |
| **Create** | `rs_dashboard/app/api/rrg/route.ts` |
| **Create** | `rs_dashboard/components/RRGDashboard.tsx` |
| **Modify** | Nav/Sidebar component — add `/rrg` entry |

No changes to `lib/rs.ts` or `lib/dataLoader.ts` — reuse as-is.

---

## Verification

1. `npm run dev` in `rs_dashboard/`, navigate to `http://localhost:3000/rrg`
2. Default view: sector indices, daily, tail=5, playhead at latest date — dots visible in correct quadrants
3. Toggle to "Nifty 50" — chart repopulates with 50 stocks
4. Toggle "Weekly" — fewer, smoother data points
5. Press Play — chart animates forward through history, dots move and tails trail
6. Uncheck a symbol — it disappears from chart immediately
7. Verify quadrant colors and axis centering at (100, 100)
8. Verify DATA date chip in header reflects actual CSV data date
