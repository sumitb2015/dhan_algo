# Puts-Calls OI Difference Chart — Design Spec

**Date:** 2026-07-04  
**Status:** Approved

---

## Context

The options dashboard already shows CE OI and PE OI as separate area charts in the Premium tab and as bar charts in the OI tab. Traders want a single derived signal — `PE OI − CE OI` — plotted over intraday time to quickly read directional pressure: positive (green) means put writers dominate → bullish; negative (red) means call writers dominate → bearish. This is a new tab so it does not displace any existing chart.

---

## What We're Building

A new **"PC Diff"** tab in the options dashboard (`/options`) that renders a single intraday area/line chart of `PE OI − CE OI` per candle, with color encoding: green above zero, red below zero.

---

## Architecture

### New files

| File | Purpose |
|------|---------|
| `rs_dashboard/components/OptionsPCDiffTab.tsx` | Self-contained tab component; receives candle data + live state props from parent |

### Modified files

| File | Change |
|------|--------|
| `rs_dashboard/components/OptionsCharts.tsx` | Add `'pcdiff'` to `Tab` union type; add "PC Diff" button to the tab bar; render `<OptionsPCDiffTab>` when active |

---

## Data Flow

No new API routes. The existing `/api/options/candles` endpoint already returns `CE OI` and `PE OI` per `CandleRow`. `OptionsCharts.tsx` fetches candles once and passes the array down; `OptionsPCDiffTab` computes `diff = (row['PE OI'] ?? 0) - (row['CE OI'] ?? 0)` inline.

Live mode: same polling loop that drives the Premium tab refreshes candle data; `OptionsPCDiffTab` simply re-renders when the prop updates.

---

## Component Design: `OptionsPCDiffTab`

**Props:**
```ts
interface Props {
  candles: CandleRow[]      // from OptionsCharts parent state
  interval: '1m' | '5m'    // passed through for display only
  isLive: boolean           // shows "LIVE" badge if true
}
```

**Stat tiles (3):**
- `CE OI` — last candle's CE OI value
- `PE OI` — last candle's PE OI value
- `PC Diff` — last candle's `PE OI − CE OI`; green text if positive, red if negative

**Chart:**
- Recharts `ComposedChart` with time on X-axis, diff value on Y-axis
- Two `Area` series sharing the same data — one clipped to `[0, ∞)` filled green (`#22c55e`), one clipped to `(-∞, 0]` filled red (`#ef4444`) — same pattern as the Net GEX Timeline in `OptionsIntelligenceTab.tsx`
- `ReferenceLine y={0}` dashed white
- `Tooltip` showing time + diff value formatted with `+`/`−` sign
- Axis labels and grid lines consistent with other tabs (zinc-700 grid, zinc-400 tick text)

---

## Verification

1. Start the dashboard: `cd rs_dashboard && npm run dev`
2. Navigate to `/options`
3. Confirm "PC Diff" tab appears in the tab bar
4. Select an expiry and wait for candle data to load (or use live mode)
5. Verify chart renders with green area above zero, red area below zero
6. Verify stat tiles show CE OI, PE OI, and current diff with correct sign color
7. Toggle 1m/5m interval — chart should re-render with new candle data
8. Toggle live mode — chart should poll and update

---

## Out of Scope

- No new API route — candle data already includes OI columns
- No per-strike breakdown — uses aggregate candle OI for the selected ATM strike
- No persistence of user preference for this tab
