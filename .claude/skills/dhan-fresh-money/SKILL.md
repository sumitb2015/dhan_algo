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
  blanks the column. Cells are tinted by `flowTier` against ONE board-wide `flowScale` (95th percentile of |cell|, not
  the max, so an OI dip cannot wash the board out; under 10 % = grey); `flowStreak` gives the ▲n / ▼n badge (completed
  slots only, runs of 3+), amber when `streakVsDay` says it runs against the day's net (a possible turn). The `Σ shown`
  totals row (`sumFlows`, known values only) has its OWN `flowScale`: sums dwarf single strikes. On this tab the ladder
  scrolls in its own box so the slot times + totals stay `sticky` (an overflow-x box is a scroll container).
  Once the session is over (an earlier day, or past `day.to`) the route passes `endMin`: the slots end AT the close
  (11 completed, no running one, `flowSlots.closed`), so OI Dhan's chain keeps moving after the bell is never a slot or
  part of `day` (2026-11-13: slots ran to 15:42). The slot blocks are sized by CSS vars from the box width
  (`slotsThatFit`): a narrow screen drops the OLDEST slots instead of scrolling the call side off to the right.
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
13. MCX collectors auto-start per MCX session (holiday file shared with `lib/mcxSession`); `instrumentation.node.ts` must not
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
