---
name: dhan-index-scalper
description: Use when touching the Index Scalper terminal (/index-scalper) outside the chart canvas itself - components/indexScalper/IndexScalperTerminal.tsx, AccountPanel.tsx, OptionChainPanel.tsx, OrderTicket.tsx, DhanScalperWidget.tsx, useIndexScalperFeed.ts, lib/indexScalperPositions.ts / indexScalperAccount.ts / indexScalperKotak.ts / indexScalperChain.ts / indexScalperInstrument.ts, app/api/index-scalper/*, or its e2e specs. A map of the terminal (instruments, SIM vs REAL, Dhan vs Kotak order paths, exits, account panel, chain snapshot, candle backfill) and the rules each fix came from. Real-money endpoint. Chart mechanics (lines, chips, drag, indicators, Quick Trade, OI profile, performance) are in dhan-trading-chart.
---

# Index Scalper terminal (`/index-scalper`)

## Overview
A TradingView-style scalping terminal for **NIFTY, CRUDEOILM and CRUDEOIL** (index/future + options), built 2026-11-24/25 in
~45 commits (`8b63453d` .. `47cbbaa6`). This skill is the terminal around the chart; the chart is
`dhan-trading-chart`. Read both before a change that crosses them (an order placed from the chart, an exit from a
chip).

Related: `dhan-trading-chart` (canvas, overlays, Quick Trade, OI profile, perf), `dhan-crudeoil-trading` (MCX units),
`dhan-broker-positions` (broker payloads), `dhan-order-tickets` (ticket rules), `dhan-alert-sound`.

## Map

| Concern | Where |
|---|---|
| Instruments (segment, tick, strike step, lot units per broker, per-order cap, order tag) | `lib/indexScalperInstrument.ts` `INSTRUMENTS` (`maxLots`, `orderSource`), `isMcx`, `mcxBarrels`, `qtyLots`, `lotUnits`, `pnlMultiplier` |
| Prices: chain, index/future ticks, feed age | `useIndexScalperFeed.ts` over the shared options bridge (`live_options_ws.py`, WS :8765) |
| Chain panel; SNAPSHOT fallback | `OptionChainPanel.tsx`; `lib/indexScalperChain.ts` over `/api/options/chain` (display only) |
| NIFTY future chart (FUT pane) | chart only, never traded from here: see `dhan-trading-chart` "NIFTY FUT pane" |
| Candle backfill | `api/index-scalper/candles/` -> `scripts/tools/index_scalper_candles.py` (cold ≈1.5-2 s, then cached); intervals 1/3/5/15/30/60: 3 resampled from Dhan's 1 m, 30 / 60 from 15 m, anchored to the session open; bars carry `v` (volume) for futures / options, never for the index |
| Orders (SIM ledger, REAL send, exits, brackets) | `IndexScalperTerminal.tsx`: `placeContract`, `sendReal`, `exitRealRow`, `readExitState`, `exitLeg`, `exitAll`, `adjustLeg` |
| Broker rows -> legs | `legsFromDhanPositions` (`lib/indexScalperPositions.ts`), `legsFromKotakPositions` (`lib/indexScalperKotak.ts`) |
| Kotak orders | `api/index-scalper/kotak-order/` -> `lib/kotakPlaceOrder.ts`; records in `debug/index_scalper_kotak_orders.json` |
| Account panel (summary, Positions, Closed, Orders, Portfolio, Funds) | `AccountPanel.tsx`; pure mappers `lib/indexScalperAccount.ts` |
| Market watch (header "Indices" / "Top 10", watch-only) | `MarketWatchWindow.tsx` + `useMarketWatch.ts` (one EventSource while a window is open; starts `/api/live-indices` / `/api/live-equity` idempotently, never stops them) over SSE `api/index-scalper/market-watch/stream/` (watches `debug/live_indices_quotes.json` + `debug/live_equity_quotes.json`, both off the Dhan WebSocket hub; no REST); rows / pull / staleness pure in `lib/indexScalperMarketWatch.ts` |
| Trade chimes (entry / exit / warn, mute `indexScalper.tradeSound`) | `lib/indexScalperChime.ts` `tradeChimeFor` diffs the position book (exit beats entry; first book after a mode / broker / instrument change is only the baseline); warn on a REAL `sendReal` not ok; REAL book changes ring in the `useTabLeader('index-scalper-sound')` tab or the tab that sent within 15 s. See `dhan-alert-sound` |
| Trailing SL (TSL) beside TP / SL, options strike chip + futures / premium chip | `components/indexScalper/TrailControl.tsx`; rules `lib/indexScalperTrail.ts` (reuses the XY ladder's `bracketStep`, `trailMode: 'distance'`); watcher + exit `fireTrail` in `IndexScalperTerminal.tsx` |
| Floating one-click widget | `DhanScalperWidget.tsx` (see `dhan-floating-scalper-window`) |
| e2e | `e2e/index-scalper{,-crude,-feed,-kotak,-layout}.spec.ts` (all broker calls mocked; non-GET unmocked = 599) |

## Rules

### SIM vs REAL
- **SIM** (paper, client ledger, never calls an order route) is the default. **REAL** is armed per page load and
  never persisted; the broker picker (`usePageBroker('indexScalper.broker')`) is locked while REAL is armed.
- The positions table and chart show **the mode's book**: SIM = paper legs, REAL = the broker's whole book for the
  underlying (polled every 3 s). After a reload the page is in SIM, so broker positions are not shown until REAL is
  re-armed.

### MCX crude: CRUDEOILM and CRUDEOIL (added 2026-11-25)
- Every crude branch is `isMcx(u)`, never `=== 'CRUDEOILM'`; barrels per lot come from `mcxBarrels(u)` (MCX_LOT_MULTIPLIER:
  10 / 100). Dhan quantity = lots, Kotak = barrels, Dhan P&L multiplier = barrels per lot (`dhan-crudeoil-trading`).
- **CRUDEOIL caps an order at 5 lots** (`INSTRUMENTS.CRUDEOIL.maxLots`, the owner's choice: 500 bbl). The server cap is
  keyed by the order tag, which cannot tell the two crudes apart, so CRUDEOIL orders carry `isxc` (Dhan
  `SOURCE_QTY_CAPS_MCX.isxc` 5 lots; Kotak `SOURCE_LOT_CAPS.isxc` 5, the Kotak route picks it from the contract, never the
  browser). `isxc` starts with `isx`, so own-order checks still match.
- **Closes are never capped:** Dhan closes (Exit, Exit All, "-", TP / SL brackets: `sendReal(..., 'close')`) carry
  `isxx`, which has no cap entry; `placeContract` skips the lot cap for `closesLeg`. Tagging closes with the opening tag
  left a 10-lot CRUDEOIL position (two 5-lot clicks, or a strategy's) impossible to exit (review 2026-11-25). A modify
  sends the cap tag only when this page changes its own order's lots; a price-only move is never capped.
- Lot counts follow the instrument's cap: Quick Trade shows / sends `min(saved, maxLots)` (saved settings untouched), the
  widget's steppers are clamped on a switch.
- **Never read one crude as the other:** `parseScalperContract` needs the exact root then "-" or a digit (the shared
  `symbolMatchesUnderlying` files CRUDEOILM under CRUDEOIL on purpose: a mini future read as full-size is 10x); Kotak
  rows by `startsWith(u)` + digit; the chart's order filter by `^ROOT(?=[\s\d-]|$)` (a "contains CRUDE" match drew a
  CRUDEOIL order on the CRUDEOILM chart).

### Opening orders
- Dhan: `/api/scalper/fast-order` with `source: 'isx'` (server cap `SOURCE_QTY_CAPS.isx` in `lib/dhanSourceCaps.ts`),
  idempotency key, an unknown outcome is reported and **never retried**.
- Kotak: the page's own route (opens `source:'isx'`, 20-lot cap in `SOURCE_LOT_CAPS`; closes uncapped); each
  placed/unknown order ID is recorded. Kotak sends no price: Kotak legs are priced from Dhan's chain.
- Orders, SIM fills and SIM closes are allowed in the **trading session**: NSE F&O 09:15-15:40 IST (close auction;
  `inOrderSession` -> `feed.marketOpen`), MCX its session. The NIFTY index itself stops at 15:30 (its candles do too).
- Market orders and SIM fills need a live tick (`ltpById`, fresh `feed_at`). A ticket is bound to the expiry it was
  picked under. MCX crude opens NRML only (`8064509f`).
- Nothing may be awaited between the click and the send (click -> fetch ≈1-2 ms).

### Exits close ANY position on the underlying (owner's decision, 2026-11-25)
- Exit (×), Exit All and the chip's "-" close what the broker shows, **whoever opened it** (this page, the mobile app,
  another terminal, a strategy). The earlier `isx`-only ownership rule (`32b5bda2`) was removed at the owner's request
  ("there should not be any restrictions"). Do not reintroduce it without asking.
- Size from a **fresh positions read** taken right before the exit (`readExitState` -> `brokerCloseOrder(netQty)`),
  per security + product, so an exit can never flip a position.
- The chip's "-" re-cuts its step from that FRESH row (`lotsToRemove(step, freshLots)`), never from the chip: sized off
  the chip, a position the mobile app reduced since was closed in full (review 2026-11-25).
- **Exit All asks first when it would close legs this page did not open** (`legsOpenedElsewhere` over `pageFilledQty`
  / `ownedQtyFromKotakOrders` from the polled order book; carried-over legs count as elsewhere) and lists them. Legs
  all opened here close at once. × on a single leg never asks.
- Exit All: shorts first, then longs (a hedge is never gone while its short is open); stops at an unknown outcome.
- Kotak keeps one guard: an order on the contract with an **unknown outcome holds its exit up to 60 s** until Kotak's
  order book shows it (`heldByUnknown`); closes above the freeze quantity go in whole-lot slices (`freezeSlices`).
- **Modify** (a working order's lots / price from the chart): `onModifyOrder` -> `PATCH /api/scalper/orders` with
  `source: 'isx'`, so the route applies the same per-order cap as placement (`dhanSourceCapError`; Kotak
  `sourceLotCapError` with the contract from `kotakDerivativeBySymbol`). The route takes an SL-M with price 0 + a trigger
  (`lib/orderModifyRules.ts`; it used to refuse price 0) and sends Kotak `SL-M` as its own price type (it was sent as
  `SL`). Only this page's own orders are edited; REAL only.
- Cancel is offered on **every** working order (panel and chart chips), but another placer's order (`OrderRowView.own`
  false: not `isx`, not a recorded Kotak ID) asks first: on the chart a strategy's stop looks like the page's own.
- A TP / SL set from this page replaces only **its own** order of that kind on the contract. If another placer's order
  of that kind works there, it is refused with a message (two stops would both close the leg; cancelling theirs
  silently left a short with no stop if the replacement was rejected).
- Trade-off to state when asked: a running strategy's leg on the same contract can now be closed from here, and the
  strategy will not know.

### Trailing stop loss (TSL, added 2026-11-25)
- **Browser-only, by the owner's choice**: no order rests at the broker. The stop follows the best price of the leg's own
  instrument (option premium / future) `pts` behind it and never loosens; when crossed, the tab that holds it sends a
  market close through the normal exit path (`readExitState` -> `exitRealRow`: fresh read, any owner, `isxx`). Closing
  the tab or the dashboard stops it; the UI says so. Distance is typed in **points only** (on the instrument's tick).
- Each tab runs its own trails. A REAL trail exit takes the Web Lock `index-scalper-exit:<securityId>`, so a second
  tab's exit re-reads the book after the first and finds it flat (no leader election: REAL is armed per tab).
- REAL trails are memory-only and end on disarm / broker switch / reload; SIM trails persist in `indexScalper.trail.v1`.
- Paused (no peak update, no exit) while prices are stale or the market is closed. A refused exit retries every 3 s,
  up to 3 times; an unknown outcome ends the trail (never resent). Independent of the TP / SL orders.

### Account panel
- Dhan-style day summary + Positions / Closed Positions / Orders (status chips) / Portfolio (Dhan
  `api/index-scalper/holdings/`, Kotak `api/equity-order/holdings?broker=kotak`, read-only) / Funds.
- Kotak display polls read the shared positions cache (`api/index-scalper/kotak-positions/`); exits read live. Kotak
  account reads are rate-limited (order book every 10 s vs Dhan 5 s); its contract reads retry every 15 s; sell
  margin is not shown on Kotak.

### Market watch windows (Top Indices / Top 10 Stocks, added 2026-11-25)
- Header buttons **Indices** / **Top 10** open draggable windows (`MarketWatchWindow.tsx`). Watch-only: no order route,
  no trade buttons; the e2e asserts `state.calls` stays empty.
- Data is WebSocket-only: `live_indices_ws.py` / `live_equity_ws.py` read the shared Dhan WebSocket hub and rewrite
  their JSON every 2 s; the SSE route `api/index-scalper/market-watch/stream/` checks both files each 1 s and pushes a
  frame only when an `updated_at` changes (plus a 15 s keepalive comment). `?want=indices,stocks` sends only the open
  windows' blocks; stocks are cut to the 10 symbols server-side. No REST quote call, no spawn in the route.
- Indices = the hub's 9 headline rows (`WATCH_INDICES`: NIFTY, BANKNIFTY, FINNIFTY, IT, AUTO, PHARMA, METAL, REALTY,
  VIX). Crude is left out on purpose: `/api/scalper/top-indices` prices it over REST.
- Top 10 = the static `NIFTY_TOP10_BY_WEIGHT` in `lib/nifty50.ts` (same list as AdvancedScalper's `TopWeightStocks`).
  It is hand-maintained and was behind `index_constituents/nifty50_weights.csv` on 2026-11-25 (ITC listed where M&M
  is now #10, Axis above Infosys); the owner chose to keep the static list. Don't switch the ranking without asking.
  The footer "weighted pull" is sum(weight x change%) / 100 over priced rows, with "n/10 priced" when some are missing.
- `useMarketWatch` opens ONE EventSource only while a window is open (closed when both are). It fires the idempotent
  `POST /api/live-indices` / `/api/live-equity {action:'start'}` once per page load per window and **never stops a
  bridge** (other pages share them).
- `live_equity_ws.py` writes a naive local `updated_at`; the route converts both timestamps to absolute ISO
  (`absIso`) so the browser's LIVE / STALE (15 s, `WATCH_STALE_MS`) never guesses a zone. Staleness comes from the
  file's own timestamp, not the bridge status, and a 1 s client clock turns a frozen feed STALE with no frame arriving.
- No genuine previous close (`prev_close <= 0`: the equity bridge zeroes Dhan's post-15:30 flip) = change shown as a
  dash, never 0.00%; unknown values sort last in both directions (`sortRows`).

### Prices and feed
- One shared options bridge per underlying/expiry, 35 strikes each side. A strike outside it has REST history but no
  live ticks; market orders on it refuse.
- On a holiday Dhan's quote API has no index price and the bridge aborts: the chain shows a flagged SNAPSHOT,
  display only; SIM fills and REAL market orders refuse.
- Measured live 2026-11-25: Dhan packet -> bridge push ≈11 ms p50, push -> browser ≈3 ms, ~25 full-chain frames/s
  (~33 KB each, ~870 KB/s per tab). Each extra open tab costs the same again.

## Verifying
- `node --test lib/indexScalper*.test.ts` and `npx tsc --noEmit -p .` from `rs_dashboard/`.
- :3000 is usually `next start` (production): source edits need `npm run build` + restart. Restarting during market
  hours also stops the server watchers (price ladder, Kotak/Zerodha guards, Gearbox square-off).
- e2e on its own dev server (:3100), see `dhan-trading-chart` "Verifying a chart change".
- Market watch: `node --test lib/indexScalperMarketWatch.test.ts`; e2e "Top indices / Top 10 stocks" in
  `e2e/index-scalper-layout.spec.ts` mocks the SSE route with a single `text/event-stream` body stamped `sessionIso()`
  (EventSource reconnects on its own) and records bridge starts in `state.bridgeStarts`, not `state.calls` (other
  tests assert `calls` is empty). Header buttons need `exact: true`: "Top indices" also matches "Close Top Indices".

## Common mistakes

| Mistake | Symptom | Fix |
|---|---|---|
| Sizing an exit from UI state | Exit flips or over-closes | fresh `loadPositions(true)` + `brokerCloseOrder` |
| Retrying an unknown order | Double position | report unknown, never resend |
| Exiting a Kotak contract with an unknown order | Exit lands before the unknown fill, flips | `heldByUnknown` 60 s hold |
| Expecting broker legs in SIM | "Mobile-app trade not shown" | REAL shows the broker book; SIM is paper only |
| Testing edits against :3000 | Old behaviour | it is a production build: rebuild or use :3100 dev |
| Stopping a market-watch bridge on window close | Live Dashboard / Advanced Scalper go dark | start only; bridges are shared |
| Showing 0.00% when prev close is unknown | A flat-looking stock after 15:30 | `changePct: null`, rendered as a dash |
