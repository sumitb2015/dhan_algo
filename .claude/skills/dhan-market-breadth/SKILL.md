---
name: dhan-market-breadth
description: Use when working on index/universe-level market breadth — advance/decline, % above SMA20/50/200, participation score, regime labeling, 52W high/low proximity, or the EOD vs intraday breadth pipelines — app/api/breadth/route.ts, app/api/breadth-intraday/route.ts, scripts/tools/breadth_intraday_snapshot.py, breadth_intraday_backfill.py, components/BreadthAnalysis.tsx, components/IntradayBreadth.tsx, app/api/dashboard/breadth/route.ts. Not for sector-level breadth (dhan-sector-breadth, a separate file/computation) or the RS math this borrows dates from (dhan-rs-ranking).
---

# Market Breadth (Index/Universe-Level)

## Four independent breadth universes — not one blended number

`computeBreadthStats(symbols)` (`app/api/breadth/route.ts:299-406`) is run **separately** for
NIFTY50_SYMBOLS, SENSEX_SYMBOLS, BANKNIFTY_SYMBOLS, and the full Nifty 500 list — four distinct
`BreadthStats` objects, each with its own advance/decline count, %-above-MA figures, and
`participationScore`. `computeIndexStats()` (`route.ts:223-266`) separately computes only the
**index-level** technicals (EMA20/50/200, ADX, Choppiness) for Nifty 50 itself — that's a fifth,
unrelated object describing the index's own trend state, not its constituents' breadth. Don't
conflate "Nifty 50 index is trending up" with "Nifty 50 constituent breadth is bullish" — they
can and do diverge.

## Minimum-history guard — same class of gotcha as Movers, separate implementation

`if (rows.length < 22) return;` (`route.ts:311`) inside the per-symbol loop — a stock with fewer
than 22 rows is skipped entirely and **not counted** in `totalScanned`, advancing, declining, or
any MA-above bucket. This mirrors `dhan-equity-movers`' `computeMover()` guard but is a fully
separate code path; a fix to one does not touch the other.

## `participationScore` — a fixed, hand-picked weighted composite (`route.ts:370-373`)

```
participationScore = round(aboveEma200Pct*0.4 + aboveEma50Pct*0.3 + aboveEma20Pct*0.2 + <adv/dec-derived>*0.1)
```
These weights (40/30/20/10) are hardcoded constants, not derived from any statistical fit —
treat them as a tunable product decision, not a formula to "correct."

## `deriveRegime()` — a hardcoded 5-tier threshold ladder on ONE input (`route.ts:408-414`)

Regime label is driven entirely by `nifty500Breadth.aboveEma200Pct` against fixed thresholds:
`>=60` Bull Market, `>=50` Cautious Bull, `>=45` Caution/Chop, `>=40` Transition, else (implicitly)
a bearish label. It ignores the other three universes' breadth and every other metric on the
page — the headline regime label is single-input by design, not a composite score.

## 52-week high/low proximity is a 0.5% band, not a strict new-high flag

`new52WHigh`/`new52WLow` counters (`route.ts:338-345`) use `pctFromHigh >= -0.5` /
`pctFromLow <= 0.5` — i.e. "within 0.5% of the 52-week extreme," not "made a literal new
52-week high today." A stock that touched its 52W high three days ago and hasn't moved since
still counts.

## Two-tier cache: in-memory (5 min) + daily file cache (`route.ts:10-42`)

`breadthCache` is a 5-minute in-memory TTL cache; `DAILY_CACHE_FILE` at
`debug/breadth_daily_cache.json` is a **separate, longer-lived** cache keyed on
`todayIST()` (IST calendar date via `toLocaleDateString('en-CA', {timeZone:'Asia/Kolkata'})`) —
it survives server restarts and only invalidates at IST midnight. The **first** breadth request
of each day recomputes fully across ~500 CSVs regardless of the in-memory cache's state, because
the daily file cache is checked/written independently. `clearBreadthCache()` clears both layers;
any code that mutates the underlying CSVs mid-day (a manual data refresh) must call it or stale
breadth will persist until midnight IST. See `dhan-polling-guards` for the general cache-
invalidation discipline this pattern needs to follow.

## Intraday breadth is a separate pipeline, not a derivative of the EOD route

`app/api/breadth-intraday/route.ts` spawns `scripts/tools/breadth_intraday_snapshot.py` /
`breadth_intraday_backfill.py` via `lib/pyExec.ts` — a fully independent Python computation path
over live/intraday data, distinct from the TypeScript EOD `computeBreadthStats()` above. Do not
assume the two reconcile automatically (different data source, different sampling, different
process). `app/api/dashboard/breadth/route.ts` (the landing-page breadth tile) is a third
consumer — check which of the two underlying computations it actually reads before assuming a
fix to one propagates to the dashboard tile.
