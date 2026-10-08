---
name: dhan-covered-call-desk
description: Use when touching the NIFTYBEES Covered Call desk at /nifty-covered-call — rs_dashboard/components/NiftyCoveredCall/*, lib/coveredCallEngine.ts, lib/coveredCallLedgerStore.ts and app/api/nifty-covered-call/{state,order,book}. Covers the own call ledger (debug/nifty_covered_call_ledger.json), reserve-before-send and late-fill sweep, the server-side buy-back cap, ADOPT and SYNC pricing from order/trade books, the Net Δ and Net Δ-if-ATM maths, and the model-delta (chainLegGreeks) rule. Real-money endpoint. Not for the Python diagonal covered-call strategy (dhan-diagonal-call) or generic multi-leg ownership (dhan-terminal-position-ownership).
---

# Covered Call desk (NIFTYBEES holding + short NIFTY calls)

The desk holds NIFTYBEES (the long side, in units) and writes NIFTY CE against it. Everything that is a number
about the calls comes from the **desk's own ledger**, not from the broker's net position. Built 2026-10-01 → 10-08
(`bbad256a` … `7d45bf52`); the 2026-10-01 rewrite replaced the old futures + call desk, whose file
`debug/nifty_covered_call_trades.json` (lots, FUTURE rows) is left untouched. This desk uses its own file, in **units**.

## Files
- `lib/coveredCallEngine.ts` — pure rules + tests (`coveredCallEngine.test.ts`): `reconstructCallLedger`,
  `reconcileCallsDown`, `fillIncrement`, `reservedBuyUnits`, `computeBook`, `netDeltaAtSpot`, `suggestCoveredCall`,
  `summarizeCallTrades`, `callsPerformance`, `chainLegGreeks`.
- `lib/coveredCallLedgerStore.ts` — server-only store; `mutateLedger(fn)` is the ONE write lock shared by the
  state and order routes. `fn` must be synchronous: never hold the lock across a broker call.
- `app/api/nifty-covered-call/state` (read + sweep), `order` (place; the only writer of fills besides the sweep),
  `book` (ledger actions: ADOPT/SYNC). The ledger route must not accept arbitrary rows.
- UI: `NiftyCoveredCallTerminal.tsx` (1.4k lines), `TradeSheet`, `TradesPnlModal`, `DeltaPanel`,
  `CoveredCallOptionChainModal`, `HowToUse` (in-page guide; keep it in step with behaviour).

## Rules that are not obvious from the code
1. **Ownership = the ledger.** Dhan nets by security id, so a sibling surface (Scalper, Focus Tool, a strategy) can
   hold the same CE. Never size or book off the broker net; see `dhan-terminal-position-ownership` Invariant 1.
2. **Reserve before send.** Every order is written to `pending` before it is sent and swept until terminal, so a
   LIMIT that fills later is booked at *its own* average (`ea8c4993`). A fill with no average yet is retried — never
   booked at 0. `TERMINAL_ORDER_STATUSES` decides when to stop sweeping. A reservation with no order id after
   `ORPHAN_RESERVATION_MS` (60 s) is dropped.
3. **Buy-back is capped server-side** at the leg's open units minus buy-backs already in flight, under the one
   ledger lock — a second tab cannot close a leg twice and eat another strategy's short on that contract. Do not
   move this check to the browser.
4. **Reconcile clamps down only** (`reconcileCallsDown`). Units the broker stopped showing still count as short at
   an LTP estimate in total/realized until SYNC books them — the clamp must not drop P&L.
5. **SYNC prices the gap from the outside BUY trade(s)** in Dhan's trade book (exact-qty match; desk orders and
   already-used fills excluded — `deskOrderIds`, `usedTradeKeys`). No match → the user types the price; never guess
   from LTP or 0.
6. **ADOPT prices from the chosen sell order's own trades**, not the pooled `sellAvg` (a day-level average). As of
   `c367c3e0` Adopt uses the order-book fill directly and prompts only for earlier-day sells; a carried short
   needs a typed price. `4efa911d`: NIFTY CE shorts at the broker that the desk does not own auto-open the Adopt
   panel with a banner.
7. **Greeks are the model's.** `chainLegGreeks` drives `computeBook`, `suggestCoveredCall`, the write delta and the
   chain modal; book Greeks are never summed from Dhan's chain Greeks (`dd032351`). It passes bid/ask through
   `trustedMark`, so a stale last print cannot set the IV. See `dhan-position-greeks`.
8. **Net Δ if ATM** (`netDeltaAtSpot`, `7d45bf52`) reprices the *whole book* with spot moved to the strike — not
   just the new call's delta. Keep it a pure function of the book so it is testable.
9. **Header spot / VIX / % change** need the indices bridge running; the page starts it on mount (`77d38480`). A
   blank VIX is a stopped bridge, not a bad quote — see `dhan-prevclose-pct-change`.
10. Naked-call risk above 100% coverage is a stated UI warning; `beesNiftyUnits(beesQty, beesLtp, spot)` converts
    the holding to NIFTY-equivalent units. The Nifty/BEES ratio label was renamed in `c367c3e0`; don't reintroduce
    the old wording.

## Before you ship a change here
- `cd rs_dashboard && node --test lib/coveredCallEngine.test.ts` (pure logic), then a SIM/paper reading of the
  state route with an empty ledger (it must return `{trades:[], pending:[]}` shape, not 500).
- Any new order path must go through the `order` route's reserve → send → sweep sequence.
- Money-moving change? Do a 1-lot REAL check and compare the booked fill with the broker's trade book; vault
  thread: "Covered Call has never booked a real fill after the 2026-10 changes".
- Never write a private Black-Scholes here; use `lib/optionsPricing.ts`.
