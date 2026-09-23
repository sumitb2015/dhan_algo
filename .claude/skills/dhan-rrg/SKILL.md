---
name: dhan-rrg
description: Use when working on the Relative Rotation Graph — app/api/rrg/route.ts's JdK RS-Ratio/RS-Momentum computation (three selectable methods) and components/RRGDashboard.tsx's quadrant classification, tail/playhead scrubbing, and weekly downsampling. Not for the RS-ratio math this borrows date-alignment from (dhan-rs-ranking, a different formula family entirely) — this skill's headline is that RRG deliberately does NOT reuse lib/rs.ts's Mansfield RS; only alignByDate() is shared.
---

# RRG (Relative Rotation Graph)

## Only `alignByDate` is shared with `lib/rs.ts` — the RS math itself is fully independent

`app/api/rrg/route.ts` imports `alignByDate` from `lib/rs.ts` (line 11) and nothing else RS-
related. `computeJdK()` (`route.ts:75-183`) implements the classic Julius de Kempenaer
RS-Ratio/RS-Momentum indicator from scratch — this is **not** `lib/rs.ts`'s Mansfield-style
`computeCurrentRS`. See `dhan-rs-ranking`'s "four RS formulas" table before assuming these
should ever produce comparable numbers; they're different indicator families (Mansfield RS vs
JdK RRG) serving different visualizations.

## Three selectable methods, one default — `method` query param (`route.ts:216`, default `'RATIO'`)

1. **`RATIO`** (default) — the "Dhan Broker / Optuma" formula per the inline comment
   (`route.ts:86-92`): `rsRaw = 100*(stockClose/indexClose)`, `RS-Ratio (trend) =
   100*(EMA(rsRaw,10)/EMA(rsRaw,17))`, `RS-Momentum = 100 + 10*(trend[t] - trend[t-2])`. This
   is the formula RRGDashboard actually requests by default — treat it as the primary path to
   verify when a number looks wrong.
2. **`EMA`** (`route.ts:120-135`) — exponential mean/variance z-score of `rsRaw` itself
   (welford-style running variance, not a fixed window), then a **second** z-score pass over
   the resulting series' rate-of-change (`rsRocArr`, `route.ts:137-141,152-165`) to produce
   momentum. Two chained standardizations, not one.
3. **`SMA`** (`route.ts:129-134,166-172`) — same two-stage idea (ratio z-score, then
   rate-of-change z-score) but with fixed rolling windows (`rollingMean`/`rollingStd`,
   `route.ts:53-67`) instead of exponential smoothing; `rollingStd` uses `windowSize-1` as
   divisor (sample std, not population).

All three center both `rsRatio` and `rsMomentum` on **100** (not 0) — the quadrant boundary in
`RRGDashboard.tsx` is exactly `rsRatio >= 100` / `rsMomentum >= 100` (lines 220-222, 235-236,
980-981), so any change to a method's centering constant breaks the quadrant split silently
rather than throwing.

`EMA` and `SMA` methods discard a warm-up prefix before their `startIdx` differently
(`route.ts:150` for EMA: `max(periodSize+10, windowSize)`; SMA-branch: `periodSize +
2*windowSize - 2`) — don't assume the two methods' output arrays start at the same index for
the same input length.

## Quadrant classification (`RRGDashboard.tsx:219-222`)

```
rsRatio>=100 && rsMomentum>=100 → 'leading'   (ACCEL, emerald)
rsRatio>=100 && rsMomentum<100  → 'weakening' (DECEL, amber)
rsRatio<100  && rsMomentum>=100 → 'improving' (RECOV, purple)
rsRatio<100  && rsMomentum<100  → 'lagging'   (UNDER, red)
```
This exact four-way split is duplicated at three separate points in the component (the main
classifier, the stats aggregator, and the tooltip badge — `RRGDashboard.tsx:220-222, 235-236,
980-981) — if you change the boundary or labels, grep for all three occurrences, the same
lesson `dhan-position-greeks` documents for its own duplicated-bug pattern.

## Tail/playhead scrubbing is index-based, not date-based

`playhead` and `tailCount` state (`RRGDashboard.tsx:59,75`) slice each symbol's `history` array
by index (`Math.max(0, playhead - tailCount + 1)`, lines 149,184,827-828) to show a moving
"comet tail" of recent quadrant positions. Because different symbols can have different-length
`history` arrays (shorter for recent listings), a shared `playhead` index does not necessarily
point at the same calendar date across all symbols — check `slicedSymbols`' date alignment
before assuming the whole chart represents one instant in time.
