---
name: dhan-prevclose-pct-change
description: Use when computing a "previous close" or "% change vs previous close" for any index, stock, or futures contract — the Top Indices strip, the scalper header spot ticker, the Market Movers page, the Scanner, or any new panel showing a live % move. Covers why Dhan is the only allowed source, the close-flip trap around the 15:30 bell, showing a meaningful move before the 09:15 open, and the CSV+live-quote-patch variant of the same problem in lib/dataLoader.ts. Read before touching app/api/scalper/top-indices/route.ts, app/api/scalper/nifty-prev-close/route.ts, lib/dataLoader.ts's live-quote patch functions, or writing a new route with the same shape.
---

# Dhan Prev-Close & % Change Computation

## Overview
Every "vs yesterday" percentage in this dashboard (headline index strip, scalper
header ticker, movers page) reduces to the same two problems, and both have already
caused real bugs: (1) Dhan's own OHLC feed is ambiguous about what `close` means
depending on time of day, and (2) before the market opens there is no "today" to
diff against, so a naive computation reports a confident, useless 0.00% — or worse,
after a second broker's session dies, a blank "PREV N/A" for every single row on the
panel (both reproduced and fixed 2026-09-09 in `top-indices/route.ts`).

## When to Use
- Any change to `app/api/scalper/top-indices/route.ts` or
  `app/api/scalper/nifty-prev-close/route.ts`.
- Adding a new headline row (another sector index, another futures contract) to
  either of the above.
- Building a new panel that shows a live LTP + % change for an index, stock, or
  futures contract vs its previous close.
- Any change to `lib/dataLoader.ts`'s live-quote-patch functions
  (`parseAndPatchStockRows`, `readNifty50Index`, `readNifty500Index`,
  `readNifty500IndexSync`, `readIndexCSV`) or a new function with the same shape —
  see Rule 4, a second, independently-discovered instance of the same class of bug.
- Debugging a % change that reads exactly `0.00%` for every row at once, or a
  "PREV N/A" / blank change indicator across an entire panel — on the Movers or
  Scanner pages this also shows up as a corrupted 52-week low (reads `0`) or every
  symbol falsely flagged NR4/NR7, since the same degenerate row feeds those too.

## Rule 1: Dhan is the only market-data source — never Zerodha/Kite, even as a fallback
This dashboard's calculations must come from Dhan alone. `top-indices/route.ts` used
to run Kite as its *primary* source (with Dhan as fallback) specifically to work
around the two Dhan quirks in Rule 2 below — an explicit user instruction on
2026-09-09 rejected that design outright: fix the Dhan-side logic, don't reach for a
second broker's session to paper over it. `nifty-prev-close/route.ts` had the same
shape (Dhan → Kite → CSV) and was cut down to Dhan → CSV the same day.

This does **not** apply to a broker reporting on *its own* account (Zerodha's own
funds/positions/orders in the scalper terminals or the multi-broker capital sheet) —
that's unavoidable and fine. It applies specifically to using one broker's feed as
market-data input for a number that could instead come from Dhan.

## Rule 2: Two Dhan OHLC quirks, and how to handle them without a second broker

**Quirk A — `ohlc.close` flips at the 15:30 bell.** Before the close bell, `close`
holds yesterday's close (correct). The instant the bell rings, it flips to hold
*today's* just-completed close — which is what you want as "yesterday's close"
tomorrow morning, but if you're still reading it as "today's prevClose" late the same
evening, `close` now equals the last traded price and every row reports a false
`0.00%`.

The fix is `rejectFlippedClose()` (`top-indices/route.ts`) / `isGenuinePrevClose()`
(`nifty-prev-close/route.ts`): trust `close` **unconditionally any time before
15:30 IST today** — a flip can only happen at the bell itself, so nothing before it
can be a flip artifact, full stop. Only from 15:30 onward does `close === lastPrice`
become suspect, and even then a genuine value captured earlier in the session is
cached per IST date (`prevCloseCache`) and preferred over a fresh (possibly flipped)
read, so a same-day flip can't overwrite a correct number with a blank one.

**The bug this replaced**: an earlier version of this guard rejected `close` whenever
it equaled the live LTP, with no time check at all. Pre-market (before 09:15), LTP
genuinely still equals yesterday's close because nothing has traded yet — that's the
*expected* state, not a flip — but the guard couldn't tell the difference and zeroed
out `prevClose` for every row the moment Dhan alone was serving the panel (i.e. the
instant Kite went down). **Don't reintroduce an equality-only check** — always gate
it on time-of-day.

**Quirk B — Dhan answers `BSE_IDX` with HTTP 200 and an empty data object.** It
cannot serve SENSEX at all for this account. There is no code fix for this one:
SENSEX is simply not in `top-indices/route.ts`'s row list (crude oil takes its slot).
`nifty-prev-close/route.ts` handles SENSEX via `IDX_I` + security id 51 instead of
`BSE_IDX` + 51 — verified 2026-08-16 that only that combination returns data.

## Rule 3: Before 09:15 IST, there is no "today" — show the last completed session's move instead

A live LTP-vs-close comparison is mathematically correct pre-market (both sides
genuinely equal, nothing has traded) but useless: `0.00%` on every single row, with
no way to distinguish "market is closed" from "a real flat day." What a trader
actually wants to see before the open is **how yesterday's full session performed
against the trading day before it** (Friday vs Thursday across a weekend, or across
a holiday).

`fromDhanPrevSessionChange()` in `top-indices/route.ts` implements this:

1. Below `MARKET_OPEN_IST_MIN` (09:15 IST), call Dhan's daily-candle endpoint
   (`POST /v2/charts/historical`, `instrument: 'INDEX'` for indices / `'FUTCOM'` for
   MCX rows) with a **12-calendar-day lookback**, not a hardcoded number of prior
   business days.
2. Take the **last two rows** whose IST session date is strictly before today.
3. `pct = (lastRow.close - secondLastRow.close) / secondLastRow.close * 100`.

**Why this needs no holiday calendar at all**: Dhan's daily-candle endpoint only
ever returns rows for days the exchange actually traded. A weekend or a holiday in
the lookback window just means a bigger date gap between the last two rows returned
— there is no gap-filled row to accidentally treat as a trading day, so "last two
rows" is automatically "last two genuine trading sessions" with zero date-math of
your own. **Do not** reach for `lib/dhan_helper.py`'s `NSE_HOLIDAYS` set or
reimplement a trading-day walk-back for this — it's unnecessary here and Dhan's data
already encodes the calendar for you. (A hardcoded holiday list is still the right
tool in the one place this repo already uses one server-side —
`app/api/refresh/route.ts`'s `getLastTradingDay()` — because that route needs to name
a *specific* completed trading day up front to look for in a CSV, not "the last two
rows an API happened to return".)

**Caching**: the answer to "how did yesterday vs the day before compare" cannot
change again until tomorrow, so it's computed once per IST date
(`prevDayChangeCache`) and reused for the rest of the pre-market window — this panel
gets polled every few seconds, and re-running a historical-candle fetch per row on
every poll would both be wasted work and risk Dhan's option/candle rate limits. A
small stagger (`HISTORICAL_STAGGER_MS`) between the handful of per-row requests
avoids bursting them all in the same instant on the one occasion per day they run.

## Rule 4: The same bug, a different shape — `lib/dataLoader.ts`'s CSV + live-quote patch

Movers and Scanner don't call Dhan's REST endpoints directly like Rule 3's routes
do — they read a daily-bar CSV and patch a "today" row onto it from
`debug/today_quotes.json` (written by `scripts/downloader/fetch_today_quotes.py`).
Pre-market, that live-quote file is exactly as unreliable as raw Dhan OHLC, just in
CSV-row shape instead of `{ltp, close}` shape, and it caused the identical symptom:
`priceChange1D` at a flat `0.00%` for every stock on Movers (found and fixed
2026-09-09), plus two knock-on corruptions from the SAME injected row: 52-week-low
reading `0` (`Math.min` picked up the fake row's `low`) and every symbol falsely
flagged NR4/NR7 (a 0-range "day" is always the narrowest). Scanner reads the exact
same `readStockCSVAsync`/index-reader functions, so it inherited the same bug and
the same fix with **no changes needed in `app/api/scanner/route.ts` itself** — the
fix lives entirely in the shared data layer.

Two different degenerate shapes show up, matching the two fallbacks
`fetch_today_quotes.py` takes when it can't get a real intraday range from Dhan
pre-market (see that script's own `_is_genuine_ohlc`, which `isGenuineQuoteRow()` in
`dataLoader.ts` mirrors exactly — **use that shared helper, don't write a narrower
one-off check**, one earlier pass at this fix in `parseAndPatchStockRows` only
checked `open/high/low > 0` and would have missed the second shape below entirely):

- **Stocks**: Dhan's per-equity OHLC batch endpoint reports `open=high=low=0` with
  only `close` populated (mirroring yesterday's close).
- **Indices** (`_NIFTY50_INDEX` / `_NIFTY500_INDEX` pseudo-symbols): the script's own
  `_ltp_to_ohlcv` fallback sets `open === high === low === close` with `volume: 0` —
  all four fields non-zero, so a naive `open>0 && high>0 && low>0` check wrongly
  calls this "genuine."

The fix at each of the five patch sites in `dataLoader.ts` is the same shape as
Rule 3, adapted to "don't inject a row" rather than "don't trust a REST field":
- `parseAndPatchStockRows` (stocks): when the live quote isn't genuine and the CSV
  has no row for today yet, **inject nothing** — leave `rows` ending at the last real
  session, so `pctChg1D`/52W-hi-lo/NR4/NR7 all naturally compare that session against
  the one before it (Rule 3's pattern, no extra code needed at the call site). When
  the CSV *already* has a stale-close row for today, still refresh `close`/`volume`
  from the live LTP but leave `high`/`low` untouched.
- `readNifty50Index` / `readNifty500Index` / `readNifty500IndexSync` / `readIndexCSV`
  (index benchmarks used for RS-vs-index calculations): these already had a
  carry-forward-last-close fallback for when no live quote exists at all — the only
  bug was that a *present but degenerate* quote skipped straight past that fallback.
  Gating the existing `if (liveIdx)` on `isGenuineQuoteRow(liveIdx)` too was the
  entire fix; the already-correct carry-forward branch does the rest.

## Before You Ship
- Does a new "vs previous close" panel source its data from Dhan only (Rule 1)?
- Does any new close/flip guard gate on **time-of-day**, not on `close === ltp`
  equality alone (Rule 2)?
- Does a pre-market code path use "last two rows Dhan actually returned" rather
  than counting back N calendar days or reimplementing a holiday list (Rule 3)?
- Is the pre-market answer cached per IST date so a panel polled every few seconds
  doesn't re-fetch historical candles on every tick?
- If the new code reads through `lib/dataLoader.ts`'s CSV + live-quote-patch path
  rather than calling Dhan directly, does it (or the shared patch function it calls)
  use `isGenuineQuoteRow()` rather than a narrower ad hoc check (Rule 4)?
