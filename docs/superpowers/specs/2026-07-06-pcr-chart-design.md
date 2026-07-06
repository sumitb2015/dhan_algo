# PCR Chart — Options Page Premium Tab

**Date:** 2026-07-06  
**Scope:** Add an intraday PCR (Put-Call Ratio) time-series chart to the Premium tab of `/options`.

---

## Goal

Plot PE OI ÷ CE OI over the trading session for the selected strike, giving a quick visual read of how sentiment is shifting intraday. The current page shows PCR only as a single scalar tile — this chart adds the time dimension.

---

## Data

No new API routes. The existing `chartData` array (built in `OptionsCharts.tsx`) already carries `CE OI` and `PE OI` per candle row. A `PCR` field is added to the same map pass:

```ts
PCR: (row['CE OI'] ?? 0) > 0
  ? parseFloat(((row['PE OI'] ?? 0) / (row['CE OI'] ?? 0)).toFixed(3))
  : null
```

`null` is used (not `0`) when CE OI is zero so Recharts skips missing points cleanly instead of dropping the line to zero.

---

## Chart Spec

| Property | Value |
|----------|-------|
| Type | `LineChart` (Recharts) |
| Width | Full-width single card |
| Height | 280px |
| Y-axis | `[0, 'auto']`, 2 decimal places |
| X-axis | Shared `xAxisProps` (time, 10px zinc tick) |
| Line color | Emerald-400 if `pcr > 1.3`; red-400 if `pcr < 0.7`; yellow-400 otherwise |
| Reference lines | `y=0.7` "Bearish" (red-400, dashed); `y=1.3` "Bullish" (emerald-400, dashed) |
| Tooltip | Shared `ChartTooltip` |
| Legend | Hidden (single series, title is self-explanatory) |

Title: **"PCR Over Time"**  
Subtitle: `PE OI ÷ CE OI · NIFTY {expiry}`  
Strike badge: same `[fmtNum(chartStrike) + ATM label]` pattern as other charts.

Empty state: same placeholder/loading/error pattern as the OI chart — shown when `!hasOiData`.

---

## Placement

In `OptionsCharts.tsx`, inside the `{activeTab === 'premium' && <> … </>}` block:

1. After the second `grid grid-cols-1 lg:grid-cols-2` row (CE & PE Premium + OI Diff)
2. Before the "→ View IV Charts" link row

Single full-width `<div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">` card.

---

## Implementation Steps

1. Add `PCR` field to the `chartData` map in `OptionsCharts.tsx` (one line change).
2. Insert the PCR chart card after the second grid row in the premium tab JSX.
3. Derive line stroke color from the existing `pcr` scalar (already computed).

---

## Out of Scope

- No new component file
- No new API route
- PCR chart is strike-specific (same as all other Premium tab charts); no cross-strike aggregate PCR
