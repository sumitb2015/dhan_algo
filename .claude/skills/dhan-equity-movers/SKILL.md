---
name: dhan-equity-movers
description: Use when working on gainers/losers, multi-period % change (1W/1M/3M/6M/1Y), 52W high/low, volume-ratio spikes, NR4/NR7, or multi-day up/down persistence streaks — app/api/movers/route.ts, app/api/movers-plus/route.ts, components/MarketMovers.tsx, components/MoversPlusDashboard.tsx. Covers the calendar-shift-then-snap-backward period-return algorithm and the newly-listed/stale-symbol exclusion guards. Not for the 1-day close/prev-close mechanics specifically — that's dhan-prevclose-pct-change, which this skill cross-links rather than duplicates.
---

# Equity Movers / Gainers-Losers / Multi-Period % Change

## Multi-period % change: calendar-shift-then-snap-backward, not a trading-day index offset

`pctChgByDate(rows, targetDate)` (`app/api/movers/route.ts:112-118`) finds the latest close and
compares it against `findCloseOnOrBefore(rows, targetDate)`. The target date itself comes from
`shiftDate(latest.date, days|months|years)` (`route.ts:104-110`) — plain calendar-day/month/year
subtraction, no holiday calendar. `findCloseOnOrBefore` (`route.ts:97-102`) then scans the sorted
rows array **backward from the second-to-last row** for the first row whose `date <= targetDate`
— i.e. it snaps to the nearest earlier trading day when the shifted calendar date itself wasn't
one (weekend/holiday). This is why the pipeline needs no holiday calendar and handles gaps for
free — don't "fix" this into an index-based `rows[rows.length - N]` lookback, that would drift
wrong every time a holiday falls inside the window.

Period offsets used (`route.ts:18-20`, `211-216`): 1W = `shiftDate(date, 7)`, 1M = `shiftDate(date,
29)`, 3M = `shiftDate(date, 91)`, the field named `priceChange5M` (UI-labeled **6M**, not 5M —
don't be misled by the field name) = `shiftDate(date, 152)`, 1Y = `shiftDate(date, 364)`. These
are calendar-day counts chosen to approximate ~65/~108/~252 trading bars, per the inline
comments — they are not trading-day-exact and don't need to be, since the snap-backward step
absorbs the slack.

## 1-day % change is a separate function — cross-link, don't duplicate

`pctChg1D` (`route.ts:120-145`) is the same Dhan settlement-price-carry-forward workaround
documented in full by `dhan-prevclose-pct-change` (close→open→high/low-midpoint fallback chain
when `curr.close === prev.close`). Read that skill for the mechanics and the 2026-09-09
live-quote-patch incident; this skill only notes that Movers is one of that skill's two named
consumers (the other is Scanner) and moves on.

## `computeMover()`'s minimum-history guard (`route.ts:147-235`)

`if (rows.length < 22) return null` — any symbol with under 22 trading days of history is
excluded from **every** Movers list (gainers, losers, 52W, volume, NR4/NR7), silently, with no
separate "insufficient history" bucket. This is deliberately stricter than `lib/rs.ts`'s
`effectiveLookback()` (see `dhan-rs-ranking`), which degrades a short-lookback RS calculation
rather than excluding the stock outright — the two features made opposite design choices for
the same "not enough history" problem; don't assume they should behave the same way.

52-week high/low (`route.ts:157-161`) uses `rows.slice(-252)` — an **index-based** lookback
(last 252 rows), unlike the calendar-based period-return functions above. A stock with fewer
than 252 rows just uses however many it has; this degrades gracefully rather than needing its
own guard.

## Volume-ratio spike detection — the movers-side volume-spike metric

`volumeRatio = latestVolume / avgVolume20D` (`route.ts:167-169`), average window fixed at the
last 20 rows. The `highVolume` bucket is the top 10 symbols by `volumeRatio` descending, gated
only by `avgVolume20D > 0` (`route.ts:272-276`) — **there is no minimum turnover/liquidity
floor**, so a thinly traded stock whose 20D average volume happens to be near zero can produce
an inflated, non-actionable ratio at the top of the list. If you tighten this, add a floor on
`avgVolume20D` or `latestVolume * latestClose` (turnover), not just non-zero.

This is one of **three independent volume-spike metrics** in the codebase, each serving a
different page — `lib/rs.ts`'s `volSurge` (RS Scanner) and Sector Breadth's turnover-weighted
Accumulation/Distribution score (`dhan-sector-breadth`) are the other two. They use different
windows and different purposes; don't assume a fix to one applies to the others.

## NR4/NR7 (`route.ts:192-200`)

Today's high-low range must be strictly smaller than each of the preceding 6 days (NR7) or 3
days (NR4) — `ranges7.slice(0, 6).every(r => nr7Range < r)`. Both require the full window length
(`ranges7.length === 7`, `ranges4.length === 4`) before flagging, so a stock with under 7 rows
never gets an NR7 flag even if its actual range would qualify.

## Movers+ (`app/api/movers-plus/route.ts`) — a different lookback style entirely

Movers+ computes multi-day up/down **persistence streaks**, and deliberately uses a
**trading-day index slice**, not the calendar-shift approach above: `rows.slice(-(sessions + 1))`
(`movers-plus/route.ts:39-45` area) takes the last N+1 rows directly. The cumulative return over
that window is **compounded**, `(last.close / first.close - 1) * 100`, never summed daily
percentages — an inline comment (`movers-plus/route.ts:64-66`) explicitly warns that summing
daily % is "only an approximation and can be materially misleading" for a multi-day move; if you
add a new streak-return stat here, compound it the same way.

**Consensus-latest-date staleness filter** (`movers-plus/route.ts:119-128`): a symbol whose
`latestDate` lags behind the max `latestDate` seen across the whole universe is excluded and
counted in `staleCount` — this catches suspended/delisted symbols whose CSV stopped updating, so
their last real trading day isn't compared against other symbols' more recent sessions as if it
were the same day.

## Shared data layer

Both routes are 100% downstream of `lib/dataLoader.ts` (`readStockCSVAsync`,
`readNifty500List`, `getTodayQuotesMeta`, `clearCache`) — no separate CSV-reading logic exists
here. Any live-quote-patch bug (pre-market `0.00%`, corrupted 52W-low, false NR4/NR7) is a
`dataLoader.ts` bug, not a Movers-route bug — see `dhan-prevclose-pct-change` Rule 4 for the
canonical incident (2026-09-09) and its fix in `isGenuineQuoteRow()`.
