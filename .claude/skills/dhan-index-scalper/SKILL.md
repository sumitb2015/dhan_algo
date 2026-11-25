---
name: dhan-index-scalper
description: Use when touching the Index Scalper terminal (/index-scalper) outside the chart canvas itself - components/indexScalper/IndexScalperTerminal.tsx, AccountPanel.tsx, OptionChainPanel.tsx, OrderTicket.tsx, DhanScalperWidget.tsx, useIndexScalperFeed.ts, lib/indexScalperPositions.ts / indexScalperAccount.ts / indexScalperKotak.ts / indexScalperChain.ts / indexScalperInstrument.ts, app/api/index-scalper/*, or its e2e specs. A map of the terminal (instruments, SIM vs REAL, Dhan vs Kotak order paths, exits, account panel, chain snapshot, candle backfill) and the rules each fix came from. Real-money endpoint. Chart mechanics (lines, chips, drag, indicators, Quick Trade, OI profile, performance) are in dhan-trading-chart.
---

# Index Scalper terminal (`/index-scalper`)

## Overview
A TradingView-style scalping terminal for **NIFTY and CRUDEOILM** (index/future + options), built 2026-11-24/25 in
~45 commits (`8b63453d` .. `47cbbaa6`). This skill is the terminal around the chart; the chart is
`dhan-trading-chart`. Read both before a change that crosses them (an order placed from the chart, an exit from a
chip).

Related: `dhan-trading-chart` (canvas, overlays, Quick Trade, OI profile, perf), `dhan-crudeoil-trading` (MCX units),
`dhan-broker-positions` (broker payloads), `dhan-order-tickets` (ticket rules), `dhan-alert-sound`.

## Map

| Concern | Where |
|---|---|
| Instruments (segment, tick, strike step, lot units per broker) | `lib/indexScalperInstrument.ts` `INSTRUMENTS`, `qtyLots`, `lotUnits`, `pnlMultiplier` |
| Prices: chain, index/future ticks, feed age | `useIndexScalperFeed.ts` over the shared options bridge (`live_options_ws.py`, WS :8765) |
| Chain panel; SNAPSHOT fallback | `OptionChainPanel.tsx`; `lib/indexScalperChain.ts` over `/api/options/chain` (display only) |
| Candle backfill | `api/index-scalper/candles/` -> `scripts/tools/index_scalper_candles.py` (cold ≈1.5-2 s, then cached); intervals 1/3/5/15/30/60: 3 resampled from Dhan's 1 m, 30 / 60 from 15 m, anchored to the session open; bars carry `v` (volume) for futures / options, never for the index |
| Orders (SIM ledger, REAL send, exits, brackets) | `IndexScalperTerminal.tsx`: `placeContract`, `sendReal`, `exitRealRow`, `readExitState`, `exitLeg`, `exitAll`, `adjustLeg` |
| Broker rows -> legs | `legsFromDhanPositions` (`lib/indexScalperPositions.ts`), `legsFromKotakPositions` (`lib/indexScalperKotak.ts`) |
| Kotak orders | `api/index-scalper/kotak-order/` -> `lib/kotakPlaceOrder.ts`; records in `debug/index_scalper_kotak_orders.json` |
| Account panel (summary, Positions, Closed, Orders, Portfolio, Funds) | `AccountPanel.tsx`; pure mappers `lib/indexScalperAccount.ts` |
| Floating one-click widget | `DhanScalperWidget.tsx` (see `dhan-floating-scalper-window`) |
| e2e | `e2e/index-scalper{,-crude,-feed,-kotak,-layout}.spec.ts` (all broker calls mocked; non-GET unmocked = 599) |

## Rules

### SIM vs REAL
- **SIM** (paper, client ledger, never calls an order route) is the default. **REAL** is armed per page load and
  never persisted; the broker picker (`usePageBroker('indexScalper.broker')`) is locked while REAL is armed.
- The positions table and chart show **the mode's book**: SIM = paper legs, REAL = the broker's whole book for the
  underlying (polled every 3 s). After a reload the page is in SIM, so broker positions are not shown until REAL is
  re-armed.

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

### Account panel
- Dhan-style day summary + Positions / Closed Positions / Orders (status chips) / Portfolio (Dhan
  `api/index-scalper/holdings/`, Kotak `api/equity-order/holdings?broker=kotak`, read-only) / Funds.
- Kotak display polls read the shared positions cache (`api/index-scalper/kotak-positions/`); exits read live. Kotak
  account reads are rate-limited (order book every 10 s vs Dhan 5 s); its contract reads retry every 15 s; sell
  margin is not shown on Kotak.

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

## Common mistakes

| Mistake | Symptom | Fix |
|---|---|---|
| Sizing an exit from UI state | Exit flips or over-closes | fresh `loadPositions(true)` + `brokerCloseOrder` |
| Retrying an unknown order | Double position | report unknown, never resend |
| Exiting a Kotak contract with an unknown order | Exit lands before the unknown fill, flips | `heldByUnknown` 60 s hold |
| Expecting broker legs in SIM | "Mobile-app trade not shown" | REAL shows the broker book; SIM is paper only |
| Testing edits against :3000 | Old behaviour | it is a production build: rebuild or use :3100 dev |
