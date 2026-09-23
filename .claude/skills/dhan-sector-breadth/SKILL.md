---
name: dhan-sector-breadth
description: Use when working on sector-level breadth, sector RS ranking, sector rotation heatmaps, or Accumulation/Distribution scoring — lib/sectorBreadth.ts, lib/sectors.ts, app/api/sector-breadth/route.ts, components/SectorBreadthDashboard.tsx, components/SectorHeatmap.tsx. Covers the hardcoded sector-classification map's staleness trap, the unweighted-median RS aggregation, and eligible-count denominators. Not for index/universe-level breadth (dhan-market-breadth, a separate file/cache/computation) or the RS formula itself (dhan-rs-ranking) — sector breadth computes its own Mansfield-RS-vs-Nifty50 variant, distinct from both.
---

# Sector Breadth / Sector RS

## `getSector()`'s hardcoded map — the highest-value gotcha here

`SECTOR_MAP` (`lib/sectors.ts:49-268`) is a static `Record<string, Sector>` of roughly 500
tickers, hand-maintained. `getSector(symbol)` (`sectors.ts:270-272`) is `SECTOR_MAP[symbol] ||
'Other'` — **there is no dynamic sync** to `MW-NIFTY-500-*.csv` or any live constituent list.
A newly-listed Nifty 500 stock, a renamed/re-tickered symbol, or an index reconstitution add
silently lands in `'Other'` until a human manually edits this file. **When a sector page looks
wrong for one specific stock** (missing from its real sector, or `'Other'` looking oddly large),
check this map first before suspecting the breadth math.

## Per-symbol history requirements are index-based, not calendar-based

Unlike `dhan-equity-movers`' calendar-shift period returns, `runSectorBreadthAnalysis()`
(`lib/sectorBreadth.ts:54-234`) computes 1W/1M/3M change via **fixed index offsets** into the
closes array: `price1W = closes[n-6]`, `price1M = closes[n-23]`, `price3M = closes[n-66]` (gated
by `has3MHistory = n >= 66`) (`sectorBreadth.ts:78-84`). This is a third distinct period-return
style in the codebase (Movers = calendar-shift+snap-backward, Sector Breadth = fixed trading-day
index, RRG/Scanner = their own rolling windows — see `dhan-equity-movers`/`dhan-rs-ranking`).
Minimum history to be included in sector aggregation at all: `rows.length >= 20`
(`sectorBreadth.ts:73`).

## Mansfield RS here is a third RS variant — vs Nifty 50, not vs sector index or `lib/rs.ts`

`sectorBreadth.ts:100-114`: for each stock, builds a 50-bar RS ratio series
`(stockClose / nifty50Close) * 1000` and computes `mansfieldRS = (currRS - avg(last 20 of
series)) / avg(last 20) * 100` — i.e. how far today's RS-vs-Nifty50 deviates from its own
20-bar average, requiring at least 20 valid ratio points. This is **not** `lib/rs.ts`'s
`computeCurrentRS`/`mansfieldRS` (see `dhan-rs-ranking`) — different window, different
comparison logic, computed independently in a different file. Do not "fix" one to match the
other; they answer different questions (this one: "is this stock's relative strength vs Nifty
50 unusually stretched right now," `lib/rs.ts`'s: "how does this stock rank against its peer
universe").

## Sector-level aggregation: median, not weighted

`sortedRS[Math.floor(count/2)]` (`sectorBreadth.ts:180` area) — **sector RS is the unweighted
median** of member Mansfield RS values, same pattern for median 1W/1M/3M returns. A single
large-cap mover within a sector does not swing the sector's headline RS/return number; a broad
shift across many smaller constituents does. Don't assume sector RS tracks the sector's biggest
name.

## `pctAbove50`/`pctAbove200` denominators use only eligible members

`eligible50 = members.filter(m => m.histLen >= 50)`, `eligible200 = ... >= 200`
(`sectorBreadth.ts:152-153`); `pctAbove50`/`pctAbove200` divide by `eligible50.length`/
`eligible200.length`, **not** the sector's full member count. This deliberately avoids diluting
"% above 50/200 DMA" with recently-listed stocks that don't have 50/200 days of history yet —
but it means the sector's displayed member count and the denominator behind its %-above-MA
figures can differ, which is expected, not a bug.

## Accumulation/Distribution score — turnover-weighted, not count-weighted

`accDistScore = upVol / totalVol * 100` where `upVol`/`totalVol` accumulate `volume * price`
(rupee turnover) only for up-days vs all days (`sectorBreadth.ts:163-171`) — defaults to `50`
when `totalVol === 0` (all-zero-volume edge case, e.g. a holiday snapshot), not `0` or `NaN`.
This is the **third** independent volume-based metric in the codebase alongside Movers'
`volumeRatio` and `lib/rs.ts`'s `volSurge` — see `dhan-equity-movers` for the full list.

## Internal Thrust labeling — hardcoded threshold ladder (`sectorBreadth.ts:184-191`)

`pctAbove20 >= 70` → THRUST (further split by `pctAbove50 >= 55`); `pctAbove20 <= 25` →
OVERSOLD; else BULLISH (`pctAbove50 >= 60`) / BEARISH (`pctAbove200 <= 35`) / NORMAL. Same
"hand-picked constants, not derived" caveat as `dhan-market-breadth`'s `deriveRegime()` — treat
as tunable, not a formula bug.

## Separate cache from Market Breadth

`_sectorBreadthCache` with its own `CACHE_TTL_MS` (5 min, `sectorBreadth.ts:54-58`) is
independent of `app/api/breadth/route.ts`'s two-tier cache (`dhan-market-breadth`) — invalidating
one does not invalidate the other, despite both being "breadth" conceptually.
