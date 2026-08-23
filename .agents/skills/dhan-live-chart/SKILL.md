---
name: dhan-live-chart
description: Use when working on a lightweight-charts canvas chart or any polled/live-updating chart series in rs_dashboard - CombinedPremiumChart, FuturesCandleChart, LightweightCandlestickChart, FootprintChart, the live-options panels - or when a chart shows a gap, a cliff, a wrong time axis, a lost zoom, or throws "Cannot update oldest data".
---

# Dhan Live Chart Series

## Overview
Four components draw to a `lightweight-charts` canvas, and the live-options panels
repoll them every 10s. Redrawing the whole series on every poll is too slow (~3,000
points across 4-7 series), so they update in place — and every incremental-update
bug since has been a variation on "the cheap path was taken when it was not safe".

**Reference implementation**: `components/CombinedPremiumChart.tsx`. Its
`sameBar` / `isTailUpdate` / `advancesFrom` trio (lines 64-106) is the canonical
guard; copy it rather than writing a new heuristic.

## When to Use
- Any change to `components/CombinedPremiumChart.tsx`, `FuturesCandleChart.tsx`,
  `LightweightCandlestickChart.tsx`, `footprint/FootprintChart.tsx`.
- Any change to the live-options panels (`StraddlePanel`, `RollingStraddlePanel`,
  `StranglePanel`, `StrategyPanel`) that touches selection state.
- Adding a new polled chart anywhere in the dashboard.
- Not for recharts/SVG charts — those are covered by `dhan-quant-terminal-page`.

## The Invariants

### 1. `update()` throws — it does not return false
`series.update()` rejects a bar whose time precedes the series' last bar
("Cannot update oldest data") **by throwing**, which surfaces as a Next.js runtime
error overlay and takes the whole page down. A payload whose tail is not a clean
forward extension is enough to do it.

Two things are required:
- Prove the tail advances monotonically from the last drawn bar before walking it —
  `advancesFrom()` scans only the tail, which is a single bar on an ordinary poll.
- Wrap the update loop in a `try { ... } catch { target.setData(next) }` anyway. A
  charting-library rejection should cost a redraw, not the page. (`b265888`)

### 2. A tail-update heuristic must compare values, not just timestamps
`isTailUpdate()` originally proved only that bar 0 and bar n-2 had matching *times*.
Changing lots on the Strategy panel refetches the same bar times with every value
rescaled — so the heuristic took the tail path, updated only the last bar, and left
the earlier bars drawn at the old scale with a vertical cliff mid-chart.

Both probe anchors must pass `sameBar()` (numeric field equality), not just a time
match. Anything else — interval/strike/expiry switch, a gap, a rescale — falls back
to a full `setData()`, so correctness never rests on the heuristic. (`2cc0ea8`)

### 3. Selection changes need a remount key, not another `fitContent()`
`fitContent()` is deliberately called once per mounted chart instance, so a 10s poll
does not reset the user's zoom and pan. But switching preset/strike/expiry/interval
reused the same panel and chart instance, so the price scale stayed stuck on whatever
loaded first — very visible switching Straddle -> Iron Condor.

Fix by keying the chart component on its selection identity so a genuine change
forces a remount and a fresh fit, while same-selection polling keeps the instance
and the zoom:
```tsx
<StraddleChart key={`${effectiveExpiry}-${effectiveStrike}-${interval_}`} ... />
<StrategyChart key={`${effectiveExpiry}-${JSON.stringify(legs)}-${interval_}`} ... />
```
(`eb834d8`)

### 4. `UTCTimestamp` is rendered with UTC getters — shift to IST first
lightweight-charts always formats `UTCTimestamp` using UTC getters, and Dhan candle
timestamps are genuine UTC epochs — so an unshifted axis reads 5.5 hours behind IST
market hours. Add `IST_OFFSET_SECONDS = 5.5 * 3600` before handing timestamps to the
chart (`FuturesCandleChart.tsx:283`), and use the same convention for VWAP day
boundaries and hover-tooltip formatting or they disagree with the axis. (`be5f15e`)

### 5. Canvas cannot read CSS variables — chrome comes from a hook
Gridlines, axis borders and tick labels flip with the theme, but a canvas can't
resolve `var()`. Read them from `lib/chartTheme.ts` via `useChartChrome()`, and add a
**separate** effect that re-applies them:
```ts
useEffect(() => {
  const chart = chartRef.current; if (!chart) return;
  chart.applyOptions({ layout: { textColor: chrome.textSecondary }, grid: {...} });
}, [chrome]);
```
Do **not** add `chrome` to the create-effect deps — that destroys and recreates the
chart on every theme flip, losing the user's zoom. `useChartChrome()` returns a
module-level constant per theme, so `[chrome]` is a stable dep.

Saturated data colours (candle up/down, series lines, markers) are *not* themed —
they read on either ground and carry meaning.

### 6. Polling hygiene
From the pass that made in-place updates viable (`204d777`):
- Memoise ISO -> epoch-seconds. The same timestamps recur across polls and across
  series; without it that is thousands of `Date` parses per poll.
- Coalesce crosshair updates through `requestAnimationFrame` — pointer moves fire far
  faster than the browser paints. Don't write `null` over `null` on off-chart moves.
- Publish legend state only when it actually differs.
- Derive `loading` from a selection key rather than toggling it inside the poll, or
  the spinner replaces the chart on every tick.

## Python Side: Feeding the Chart
- **Floor leg timestamps to the minute before merging.** Dhan's intraday API can
  return the same 1-min bar at different second offsets for different legs
  (CE=13:31:00, PE=13:31:30). An exact-match inner merge silently drops those bars,
  producing intra-session gaps. Floor in `_fetch_intraday`, before anything merges.
- **Segment boundaries are inclusive of the transition bar.** Storing
  `end = first_row_of_new_segment` and slicing with `<` leaves the transition candle
  in neither segment — a one-bar gap at every ATM roll. Store the *last* row of the
  old segment and slice with `<=`. (`4397a9f`)

## Before You Ship
- Does every `update()` path have a `setData()` fallback?
- Does the tail heuristic compare values as well as times?
- Does a selection change remount, and does a poll not?
- Does the axis read IST?
