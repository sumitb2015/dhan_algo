---
name: dhan-equity-technical-screener
description: Use when working on trend/stage/regime screening pages — app/api/scanner/route.ts (Scanner, /scanner), lib/stageScreener.ts (Stage Screener, Minervini 8-criteria trend template, /stage-screener), lib/marketRegime.ts (Market Regime, IBD-style distribution/stalling/follow-through-day state machine, /market-regime), lib/trendConfluence.ts (Trend Confluence, multi-timeframe EMA/ADX star rating, /trend-confluence). These are FOUR separately-implemented algorithms, not variations of one shared gating function — each has its own section below. Not for RS Scanner/Leaderboard at /rs-scanner (dhan-rs-ranking, a different page despite the similar name) or RRG (dhan-rrg).
---

# Equity Technical Screener Family (Scanner / Stage Screener / Market Regime / Trend Confluence)

Four distinct pages, four distinct algorithms, no shared gating code beyond common imports
(`dataLoader`, `getSector`, `OHLCVRow`/`alignByDate` from `lib/rs.ts`). Do not assume a fix in
one applies to the others — check the specific section below.

## 1. Scanner (`app/api/scanner/route.ts`) — mirrors `lib/rs.ts`'s degraded-lookback, deliberately

`computeRS()` (`route.ts:220-250`) reimplements its own RS-ratio loop rather than calling
`lib/rs.ts`'s `computeCurrentRS`/`buildRSResult`, **but** an explicit comment (`route.ts:225-227`)
states it deliberately mirrors `effectiveLookback`'s degrade-don't-zero fallback "so the
leaderboard and scanner agree on how a stock like a fresh listing is scored." This is different
from RRG/Sector-Breadth's genuinely independent formulas — **if you fix a lookback-degradation
bug in `lib/rs.ts`, port the same fix here**, since the two are meant to stay in sync even
though they're separate code. `rsRising20` = current RS > RS value at the start of the lookback
window; `rsAboveMA` = current RS > mean of the window's own RS series — both boolean screener
gates, not scores (see `dhan-rs-ranking` for the peer-percentile score this page doesn't use).

## 2. Stage Screener (`lib/stageScreener.ts`) — the 8-criteria Minervini Trend Template

`runStageScreener()` (`stageScreener.ts:104-220+`) requires `rows.length >= 200` (line 121) —
stricter than every other equity page's minimum-history guard (Movers/Breadth use 22, RS uses
20). The 8 criteria (`stageScreener.ts:194-212`):
```
c1: price > SMA150 && price > SMA200
c2: SMA150 > SMA200
c3: SMA200 trending up over 22 trading days (sma200 > sma200_22)
c4: SMA50 > SMA150 && SMA50 > SMA200
c5: price > SMA50
c6: price >= 1.30 * low52W
c7: price >= 0.75 * high52W   (within 25% of 52W high)
c8: mansfieldRS >= 0 && rsTrendingUp (5-day-ago comparison)
```
`score = c1+c2+...+c8` (count of true criteria); the `strict8` filter tab requires all 8.
**Yet another independent Mansfield RS implementation** (`stageScreener.ts:170-193`): vs Nifty
500 benchmark specifically, 50-bar RS-ratio window compared to its own 20-bar SMA — a fifth RS
variant in the codebase (see `dhan-rs-ranking`'s table; add this as a sixth row if you're
tracking the full list). `sma200Slope22` compares today's SMA200 to the SMA200 from 22 bars
before the **current** point (not 22 bars before "now" in wall-clock terms) — re-derives a full
200-day sum at that offset (`stageScreener.ts:141-145`), an O(n) cost per stock repeated inside
an already-O(n) per-symbol loop; fine at Nifty-500 scale, worth knowing if extended to a larger
universe.

## 3. Market Regime (`lib/marketRegime.ts`) — IBD-style distribution/stalling/follow-through days

`calculateMarketRegime()` (`marketRegime.ts:100+`) is a full state machine over the Nifty
50/500 index's own daily history — not a stock screener, a single index-level regime call.
Three day-type classifiers per session (`marketRegime.ts:196-230+`):
- **Distribution day**: `changePct <= -0.20% && volume > prevVolume`.
- **Stalling/churning day**: small move (`-0.20%..0.40%`) on higher volume **closing in the
  lower 45% of the day's range** (`closeLocation < 0.45`) — a heavier-volume day that failed to
  make real progress.
- **Follow-through day (FTD)**: a rally-attempt state machine — day 1 is a new 20-day-low touch
  that closes green; the attempt is invalidated if a later day undercuts that day's low; day 4+
  with a >=1.25% gain on volume higher than both the prior day and the 50-day average confirms
  the FTD.

**Volume-repair heuristic** (`marketRegime.ts:141-156`): index feeds can have zero-volume days
(Dhan index spot gaps); these are backfilled by scaling the last genuine volume by the ratio of
today's true range to yesterday's true range (clamped `[0.5, 2.0]`), specifically to prevent a
real zero from registering as a fake "distribution day on higher volume" or an artificial 200x
volume spike. If a regime call looks wrong for a specific date, check whether that date's raw
CSV volume was zero before suspecting the day-type classifier itself.

`rows.length < 50` returns a **fabricated "CONFIRMED_UPTREND / Insufficient Data"** placeholder
response (`marketRegime.ts:107-136`) rather than an error or null — a UI reading this response
without checking `statusLabel === 'Insufficient Data'` will silently display a real-looking
bullish regime for an index/period with too little history.

## 4. Trend Confluence (`lib/trendConfluence.ts`) — multi-timeframe EMA/ADX star rating

`runTrendConfluenceAnalysis()` scores each stock 0-5 stars from five independent boolean gates
(`trendConfluence.ts:226-235`): `weeklyUptrend` (weekly EMA10>EMA40 & close>EMA10),
`dailyUptrend` (price>EMA50 & EMA50>EMA200), `shortTermMomentum` (price>EMA20 & EMA20>EMA50),
`adxStrong` (ADX14>=25), `rsBullish` (yet another Mansfield RS, this file's own copy, >=0).
`stars = count(true)`; `actionSignal` maps `5→STRONG BUY, 4→BUY, 3→NEUTRAL, 1-2→BEARISH,
0→AVOID`.

**`resampleToWeekly()`'s incomplete-current-week gotcha** (`trendConfluence.ts:60-85`): groups
daily rows by ISO week (Monday-keyed) with no filter dropping a still-in-progress week — the
most recent weekly candle can be built from as little as 1 trading day if run mid-week. The
`weeklyUptrend` gate (EMA10 vs EMA40 on this series) is therefore computed against a partial,
not-yet-final weekly close on any day other than Friday, and **will shift** once the week
completes. If a stock's weekly signal flips between two consecutive daily runs mid-week, this
is very likely why — not a data or EMA bug.

`computeADX()` returns a hardcoded fallback of `20` (a neutral-ish reading, not `0` or `NaN`)
when `n < period*2+2` (`trendConfluence.ts:90`) — insufficient history doesn't exclude the
stock, it just makes `adxStrong` default to false via the `>=25` threshold rather than crashing.
