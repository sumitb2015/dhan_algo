---
name: dhan-fresh-money
description: Use when touching the Fresh Money board (/options/fresh-money) - rs_dashboard/components for it, lib/freshMoney*.ts (freshMoney, freshMoneyFiles, freshMoneyWs, freshMoneyBrokers, freshMoneyTrades, freshMoneyTradeServer, freshMoneyExits, freshMoneyExitTick, freshMoneyExitServer, freshMoneyGlobalExit/Tick), app/api/fresh-money/*, or the OI collectors that feed it (iv_snapshot_collector.py, scripts/tools/crudeoil_oi_collector.py). A map of the page, its real-money trade/exit path and the rules each fix came from. Real-money endpoint (Dhan, Kotak, Zerodha).
---

# Fresh Money board

## Overview
`/options/fresh-money`: per-strike OI board (OI change, total OI, call − put Δ OI, buildup tags; the fresh-share / normal-band / rolling-chart logic was removed 2026-11-13: too little history), for NIFTY-family indices and CRUDEOIL / CRUDEOILM option months, with
live B/S trading, a Positions | Orders panel, per-position target / SL and a global rupee target / SL. Built
2026-11-06..13 (`3d2e0fd5` .. `741459a5`). **REAL MONEY**: read `dhan-terminal-position-ownership` first (ledger owns
positions, down-only reconcile, unconfirmed-order holds) and `dhan-polling-guards`.
Design spec for target/SL: `docs/superpowers/specs/2026-11-11-fresh-money-target-sl-design.md`.

## When to Use
Any edit to the files in the description, or a symptom such as "a new position takes seconds to appear", "Kotak
positions read twice", "board price snaps back to the startup value", "OI change looks huge on the first row".

## Map (who owns what)
- `lib/freshMoney.ts` - pure engine: snapshot CSV -> board rows, buildup tags, Δ OI
  (LB/SB/SC/LU), OI change | Total OI switch. No I/O. `oiFlow()` feeds the "3m slots" tab: OI change per strike in
  fixed 3-min slots counted from the session open (09:15 NSE / 09:00 MCX; the route's `day.from`), the last 10
  completed slots (frozen) plus the running slot. A slot edge reads the latest snapshot at or before it within 1 min
  (a gap or another expiry = null, never 0); the open edge is the previous close's OI (`oi − change` of the day's first
  snapshot). Dhan's chain OI moves about once a minute and swings back and forth (vault: dhan-observed-quirks), so a
  single cell is weak evidence; runs are stronger. The bar / number beside the strike is `day`: the strike's OI change
  vs the previous close (the snapshot's own `change_OI`) as of `dayAt`, the latest completed edge with a reading, so
  each completed slot adds exactly its cell to it. A gap at that edge (a collector restart, which every dashboard
  restart causes) falls back to the newest earlier edge and the header says which (`OI Δ today @ HH:MM`); it never
  blanks the column. The grey cell at each block's outer end (`<HH:MM`) is `flowCarry`: the change from the previous
  close to the first SHOWN edge, so carry + the shown completed cells up to `dayAt` = `day` exactly (verified on the
  2026-11-13 NIFTY file: Σ of every slot from the open = `day`, 0 mismatches); it is never tinted or in `flowScale`, and
  null when any cell it spans is. Each cell's hover adds the running OI Δ today at its end. Cells are tinted by `flowTier` against ONE board-wide `flowScale` (95th percentile of |cell|, not
  the max, so an OI dip cannot wash the board out; under 10 % = grey); `flowStreak` gives the ▲n / ▼n badge (completed
  slots only, runs of 3+), amber when `streakVsDay` says it runs against the day's net (a possible turn). The `Σ shown`
  totals row (`sumFlows`, known values only) has its OWN `flowScale`: sums dwarf single strikes. On this tab the ladder
  scrolls in its own box so the slot times + totals stay `sticky` (an overflow-x box is a scroll container).
  Once the session is over (an earlier day, or past `day.to`) the route passes `endMin`: the slots end AT the close
  (11 completed, no running one, `flowSlots.closed`), so OI Dhan's chain keeps moving after the bell is never a slot or
  part of `day` (2026-11-13: slots ran to 15:42). The slot blocks are sized by CSS vars from the box width
  (`slotsThatFit`): a narrow screen drops the OLDEST slots instead of scrolling the call side off to the right.
- Slot view switch (pref `freshMoney.flowView`, 2026-11-17): Numbers (the 3 `flowTier` tints) / Heat (colour only, number
  in the hover + an `sr-only` span; noise = truly blank) / Both. Heat strength is `flowHeat`, which shares `flowRatio` and
  `FLOW_NOISE` (10 %) with `flowTier`, drawn as an inline `color-mix()` of emerald-500 / red-500 (`heatBg`): the SAME fixed
  data shades the Numbers tints use (they do not flip per theme); only the cell TEXT uses flipping tokens. An inline
  style is not matched by the white-mode `[class*="bg-emerald-500/"]` text rules in globals.css. The carry cell and an
  unknown cell always keep their text. ★ (`topBuilders`, slots tab only) marks the strike with the most OI added since
  the previous close per side; it sits at the BAR's outer end and every slots-tab bar reserves that room (`room`), so
  the marked bar is not shorter. Round strikes (`isRoundStrike`: 100s on a 50 step, 500s on a 100 step) are bold on ALL
  tabs with an inset-shadow line above (no layout shift; skipped under the header and the spot divider).
- The NSE open (2026-11-17; timing unconfirmed until a real open): the buttons need the session gate AND today's first
  snapshot (`todaysBoard`). (1) `iv_snapshot_collector.py` `prepare_for_open` resolves expiry / spot / strikes inside
  the last 45 s BEFORE 09:15 (no EOD chain call in that lead) and sleeps to the open in seconds, so the first chain read
  starts at 09:15:00 (it used to wake up to a minute late, then set up). No row is written before the open. The first
  row must be TODAY's session: a pre-open `chain_signature` is kept per index and `first_live_chain` re-reads (5.2 s
  apart: DhanHelper caches a chain 5 s, so the pre-open read is never taken in the last 9 s either) until the chain
  differs, at most 11 s, then writes with a warning. The strike window is re-centred on the opening price before that
  first write (`recentre`). `retry_pending` runs AFTER the reads (its expiry lookup shares the helper's 3 s chain slot).
  (2) The page polls board + trade state every second from 09:14:55 to 09:17 while still blocked by anything the open
  resolves (`lib/freshMoneyOpen.ts` `openBurst`; not for a logged-out broker or watch-only SENSEX), and re-reads both
  when a background tab becomes visible. The board `load` drops only replies OLDER than one shown (`applied`), never
  "all but the newest" (1 s polls would starve it). Server still re-checks every order. MCX is not covered.
- Lots / Units switch (NSE only, pref `freshMoney.oiUnits`): the route always serves lots; the page scales a VIEW of
  the rows with `scaleOiRows(rows, lot)` (`rawData` -> `data`). Display only: never scale anything an order reads.
  Dhan's web chain shows units; its "Per Lot" checkbox MULTIPLIES OI by the lot size (meant for prices), so it is no
  way to compare.
- Price switch (pref `freshMoney.showPrice`): PE / CE last price from the SHOWN snapshot (`ltp`, ~30 s cadence, never a
  new fetch) with `prevClose` from the collector's `_prev_close.json`, green / red vs it, in 54 px columns at the strike
  cell's outer ends. The strike cell's columns are an inline grid template from `StrikeLayout` (`strikeGrid`,
  `strikeColPx`), not Tailwind strings: lv x PCR x price is too many combinations.
- PCR switch (pref `freshMoney.showPcr`): `pcrOf` (put OI ÷ call OI, Dhan's definition; null when call OI is 0 or a side
  unknown) in a 40 px column beside the strike, `boardPcr` (two-sided strikes only) on the Σ row. The strike column
  width is the CSS var `--fm-k` in all four grids (`strikeColPx`), and `flowFixedPx`/`slotsThatFit` count it.
- PDH / PDL tags (NSE indices): the route adds `prevDay` from `prevDayLevelsNow` (the Price Ladder's once-a-day Dhan
  daily-candle cache, `lib/prevDayLevels.ts`) OUTSIDE `respCache` (a past day's file never changes, so a cached body
  would keep null). It is the previous day of TODAY, not of the shown file. `levelStrikes` puts each tag on the nearest
  strike; the strike column grows a 28 px tag slot (`LEVEL_PX`) only while the levels are known.
- DH / DL (today's high / low, NSE and MCX): from the board's own price bridge quote (`high` / `low` in
  `fresh_money_ws_quotes.json`, read by `usableQuote`) via `/api/fresh-money/live` (`dayHigh` / `dayLow`), null before
  today's session opens (the packet still carries the previous session's range). Solid tags; PDH / PDL tinted.
  `levelStrikes` takes `{tag, value}[]` and orders a shared strike's tags DH, DL, PDH, PDL (3-4 = a 2x2 grid).
- "OI + Δ" tab (`oiMode 'both'`): one bar per side = total OI with today's change in it, from `stackParts(oi, chg)`
  (held since the previous close dim, added today bright, cut today a dashed tail; bar length and `maxAbs` = the larger
  of today's and the previous close's OI). The number column widens to `NUM_BOTH_PX` via `--fm-num` for "1.3L +12k".
- Level entries (XY-ladder model; vault decision 2026-11-16-fresh-money-level-entries-index-levels): a per-strike MKT / LVL
  switch (page memory only — a reload is MKT). On LVL, B / S open `LevelTicket` (components/freshMoney/LevelEntry.tsx) and
  `arm` writes an `FmEntry` to `ledger.entries` (lib/freshMoneyEntries.ts): an INDEX level (MCX: the option month's
  future), limit vs stop by which side of the price it sits (`limitSide`). Its OWN 250 ms loop (`startFreshMoneyEntryLoop`
  in lib/freshMoneyExitServer.ts, heartbeat `debug/fresh_money_entry_watcher.json`; arming is refused when it is stale)
  runs `runEntryTick` and fires at MARKET through `fireEntryCore` → `resolveOrder` → `sendOne` (the click's own path; the
  board, session, contract and cap re-checked at fire time). Rules: fires on the FIRST NEW WebSocket tick at or past the
  level (`entryFires`: the quote's `changedMs` after arming — an old print never fires; 2026-11-16 the first version,
  two 2 s checks inside the exit loop, fired 3-4 s late and slipped 5 points); claimed `firing` in the lock together with
  the in-flight hold and the global-exit check (at most once); UNKNOWN / a throw never resent; one fire per contract per
  tick; armed lots count toward the cap PER DIRECTION (`armedQty` {buy, sell} worst case — an armed SELL must never
  offset a BUY); Exit all and a fired total target / SL cancel every armed level (kill switch) and the total exit
  blocks new ones; expired when the product's gate is not `open`; a `firing` entry with no outcome after 60 s = unknown.
  The ledger is read at most once a second in that loop (cache dropped after every write). Nothing rests at the broker.
  Prices for levels are WEBSOCKET ONLY (`spotQuoteNow` → `wsPrice`, and the ticket's price from `/api/fresh-money/live`,
  also `wsPrice`): no REST quote fallback, ever — no WS price = no arm / no fire.
- `lib/freshMoneyChime.ts` - pure: `tradeEvents(prev, cur)` diffs two trade-state polls into one sound (warn > exit >
  entry) plus toasts for SERVER-fired exits (target / SL / total; they had no toast before), `streakStart` rings when the
  Σ row starts or turns a 3+ run. The page plays them via `lib/alertSound.ts` (dhan-alert-sound): leader tab only
  (`useTabLeader('fresh-money')`), first poll only records, own mute key `freshMoney.sound`; a rejected / UNKNOWN order
  this tab sent warns via `useFreshMoneyTrades(onWarn)`. Sound needs a first click after every reload.
- `lib/freshMoneyFiles.ts` - ONE parse per snapshot-file change, shared by the board route and the trade route. Only
  files the board shows keep full snapshots in memory (14 days x 5 underlyings would exceed 100 MB).
- `lib/freshMoneyWs.ts` + `freshMoneyWsQuote.ts` - WebSocket prices via `scripts/tools/price_ladder_ws.py --name fresh_money`
  (same mechanism as the Price Ladder). A value being present proves nothing about its age; null = no fresh price, callers
  fall back and say which source they used.
- `lib/freshMoneyBrokers.ts` - per-broker placement. Prices are always Dhan; only orders and the broker's own books go
  to Kotak / Zerodha. Keep each broker's placed / rejected / unknown outcome.
- `lib/freshMoneyTrades.ts` (pure) / `freshMoneyTradeServer.ts` (ledger, `ltpsFor`, `sendOne`, `closePositionCore`) -
  `app/api/fresh-money/trade/route.ts` is HTTP only. Ledger `debug/fresh_money_trades.json`.
- `lib/freshMoneyExits.ts` / `freshMoneyExitTick.ts` (pure decisions) + `freshMoneyExitServer.ts` (2 s loop started from
  `instrumentation.node.ts`, idle with no levels, heartbeat `debug/fresh_money_exit_watcher.json`) - per-position
  target / SL. `freshMoneyGlobalExit.ts` / `GlobalTick.ts` - combined-P&L rupee target / SL.
- `lib/freshMoneyExitAll.ts` (pure loop) + `exitAllCore` (route action `exitAll`) - the header's **Exit all**: every
  open position this page holds (all underlyings and brokers, never broker positions it does not own), MARKET via
  `closePositionCore`, shorts first, no hedge closed after a short's cover failed; one run per server
  (`shared.exitAllBusy`); 504 when any close is UNKNOWN. Two clicks within 4 s, no ARM needed (it only reduces risk).

## Rules (each came from a fix)
1. **The watcher and the route share one close path.** Exits call `closePositionCore` - the same own-fill sizing, holds,
   in-flight-close subtraction and slicing as the x button. Never add a second close implementation (`408539e`).
2. **At most once, never resent.** Set `firing` under the ledger lock before sending; UNKNOWN / partial -> `unknown`, never
   retried; refused with nothing sent -> back to `watching` after >= 5 s. A level must breach on two consecutive checks;
   an unpriced tick resets the count.
3. **Global P&L unknown = no fire.** A missing fill, missing LTP or order in flight makes the total UNKNOWN; do not guess.
4. **Defaults are stamped when a position opens**, levels are fixed prices once priced, editing the header never moves
   existing levels; invalid defaults refuse the order.
5. **x closes only what is not already in flight** and refuses when the whole position is on its way out (a slow close was
   sent twice, `842359b`). Orders trade only a live board: no backfilled (per-candle volume) file, no new position from a
   snapshot older than 3 min.
6. **Separate Next bundles = separate module state.** The route and the watcher each had their own Kotak throttle, so
   Kotak positions were read twice per cycle (`6217eaea`, stCode 100025). Throttles/caches live on `globalThis` via
   `lib/globalOnce.ts`. Same for any new shared cache here.
7. **A new fill must show within ~1-2 s** (`9dbe809b`): young orders (<15 s) are read every 0.4-1 s, the route state cache is
   busted when a fill is written, the page re-polls at 0.6/1.3/2.2/3.5 s after any order or close. Don't slow these down.
   The read schedule (`nextAt` / `attempts`, pure `nextReadAt` in `lib/freshMoneyTrades.ts`) must follow the order's
   state (`06e70190`): `sendOne` clears it once the send outcome is written, and a `sending` order (no id yet) is re-checked
   within `SENDING_RECHECK_MS` (400 ms), never parked until it turns stale. A refresh during a Kotak send once parked it at
   send + 30 s, so the fill, P&L and chime came ~30 s after Kotak filled it. Any new code that changes an order's state
   outside `refreshOrders` must reset its schedule too. The Orders time-cell hover shows `seenAt − ts`, the fill's lag.
8. **The panel lists only the selected broker** (`741459a5`); the global Total is labelled all brokers. A position keeps the
   broker it opened on.
9. **Collectors must carry the LAST GOOD price** and never drop an underlying for the day on one failed quote (`6d57fba6`,
   `4434500d`): Dhan's quote API is ~1 req/s and shared with every bridge. Retry at startup; write STOPPED + reason if there
   is still none, because the dashboard spawns collectors detached.
10. **change_OI only when oi AND previous_oi are both known** (`b1e8cc3f`): a missing previous_oi read as 0 puts the whole OI
    on the board as today's change.
11. **An outside close gets its real price or none** (2026-11-13: a Kotak-app close blanked Booked / P&L for the day).
    The reconcile's `external` record is priced by `priceExternalCloses` from the broker's order book
    (`lib/freshMoneyExternalPrice.ts`): same contract / side / intraday product, an order id the ledger never sent, inside
    the window since the page's last own order, fills adding up to exactly the written-down quantity. Ambiguous = stays
    unknown. NSE only (Kotak's MCX quantity unit differs). Max 6 tries, 20 s apart per broker.
12. **Product (MIS / NRML) is part of the position key** (`orderKey`: `broker|handle` for MIS, `broker|handle|NRML`), and
    every broker read is per product (`netKey`; Dhan INTRADAY / MARGIN, Kotak + Zerodha MIS / NRML), so closes, the
    down-only reconcile and outside-close pricing never mix the two. NRML opens until a minute before the close (MIS:
    the 15:17 cutoff). The page NEVER squares NRML off (user's choice 2026-11-13): `nrmlWarning` from 10 min before the
    close; an NRML position open at the day roll leaves the ledger. The board shows the selected product's positions;
    the other product's are in the off-board list.
13. **A past NSE session shows the official close OI, not the last in-session reading.** Dhan revises option OI after the
    close (2026-11-13: 0-7 % lower on most NIFTY strikes; 24700 PE flipped from +3.5k to -3.1k lots). The IV snapshot
    collector's `EodOiTask` writes the previous session's `previous_oi` (`lib/eod_oi_sidecar.py`) to `<csv>_eod_oi.json`,
    one chain call per slot (pre-open wait + between polls), retried every 120 s, and ONLY once `has_rolled` says Dhan has
    moved `previous_oi` on (most strikes differ from the session's own `oi − chg`): before the roll, or on a non-trading
    day, it is still the close before, which would read as a ~0 change on every strike. The route applies it
    (`buildBoardRows(..., closeOi)`) only when `date` and `expiry` match, per STRIKE (both sides or neither — a mixed row
    fakes a Δ OI imbalance), change measured from that day's own previous-close OI. The 3m slots stay in-session. Header
    chip `fm-oi-source` says which source is shown. No side file for MCX, or when the shown file's expiry has expired.
14. MCX collectors auto-start per MCX session (holiday file shared with `lib/mcxSession`); `instrumentation.node.ts` must not
    kill them on a dashboard restart. A WAITING collector counts as alive.

## Tests
`cd rs_dashboard && node --test lib/freshMoney*.test.ts`; e2e spec with mocks (`7d008e46`) - run it on :3000 per CLAUDE.md,
never start a second `next dev`. Never add a real-order case.

## Common Mistakes
- Putting a throttle or cache in a module-level `let` shared by route and watcher (use `globalOnce`).
- Deriving exit size from the broker net instead of the ledger's own fills.
- Reading REST quotes for the board spot (the quote lane crawls after a 429) - use the WebSocket price.
- Treating a missing LTP as 0 in P&L, or a missing previous OI as 0 in change.

## Cumulative OI chart on the board (2026-11-13)
`CumulativeOiWidget` (shared with the Scalp Cockpit) reads `/api/options/iv-history?mode=cumulative`. The **series and
regime stay on a fixed strike window** (ATM locked at the day's first snapshot): `lib/optionsRegime.ts` treats the CE/PE
sums as one constant-membership series, so a window that follows spot makes D = PE-CE jump at every shift and spikes
slope / acceleration / z-scores. Only the **PCR pill** is spot-centred (`lib/cumulativeOiPcr.ts`, latest snapshot only,
shifted inward / narrowed at the recorded edge, `clipped` -> asterisk). The picker width is `maxWings`, derived from the
strikes the day's file really holds (collectors record ATM +-20 from 2026-11-16, +-10 before; the fixed set is widened,
never re-centred per poll, because Fresh Money's `_prev_close.json` sidecar covers that fixed set).
Route rules (2026-11-17, `app/api/options/iv-history/route.ts`, helpers in `lib/cumulativeOiPcr.ts`): the window comes
from `sharedRun` (the strikes every snapshot holds; if a restart ever shares NO strike with the earlier snapshots the
series starts at that restart and the reply carries `since`). Only `completeSnapshots` are summed: a half-written
snapshot or one with a blank OI inside the window is left out, never plotted as an OI drop (a blank parses to 0 in
`parseNumber`; `ceOiKnown` / `peOiKnown` carry the difference). Rows with a damaged timestamp are dropped at parse
(2026-11-13 13:01:55 had one with junk before the time). `despikeSpots` thresholds are a share of the price, not NIFTY
points. The reply's `drift` (spot vs the window centre, in strikes; `outside` once spot leaves the window) is shown as
a chip on the widget, because the series does NOT follow spot. Replies are `private, no-cache`.
