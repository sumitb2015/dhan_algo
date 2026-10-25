---
name: dhan-price-ladder
description: Use when touching the Price Ladder (/price-ladder) — rs_dashboard/components/priceLadder/*, lib/priceLadder*.ts (priceLadder, priceLadderServer, priceLadderPair*, priceLadderGuard, priceLadderCutoff, priceLadderClose, priceLadderView), app/api/price-ladder/* (state, stream, settings, close-position), scripts/tools/price_ladder_ws.py, docs/PRICE_LADDER_GUIDE.md. A map of the terminal (XY / Plain / Pair ladders, server watcher, MTM guard, positions-window close) and the rules each review fix came from — lot cap re-checked inside the ledger lock, a throwing send, Dhan 5xx = unknown, server-derived close quantity, WebSocket-only prices. Real-money endpoint, Dhan + Kotak + Zerodha; read dhan-terminal-position-ownership (Invariants 2, 6, 14) first.
---

# Price Ladder — anatomy and rules

OptionX-style click-to-trade terminal for NIFTY / BANKNIFTY / SENSEX options and CRUDEOILM (Dhan, Kotak, Zerodha). User guide:
`docs/PRICE_LADDER_GUIDE.md` (keep it current when behaviour changes). SIM (paper) is the default; REAL needs the daily
LIVE · REAL MONEY arm (`liveArmedOn`). **Exits never need the arm** (the MTM guard and the positions-window close rely on it).

## Map
| Concern | File |
|---|---|
| Pure rules: click verdict, bracket/trail, settle, exit sizing, `planTick`, `rollDay`, sessions | `lib/priceLadder.ts` |
| Server watcher (1 s tick), ledger IO, broker IO, prices, reconcile, `placeFor` | `lib/priceLadderServer.ts` |
| Actions (arm, market, add, lots, exit, modify, trail, guard, cancel, resolve, clear) | `app/api/price-ladder/state/route.ts` |
| Page view builder (shared by GET poll and SSE) + `resolveContract` | `lib/priceLadderView.ts`, `app/api/price-ladder/stream/route.ts` |
| Pair mode (straddle/strangle on combined premium) | `lib/priceLadderPair.ts`, `priceLadderPairActions.ts` |
| MTM guard (one per ladder + broker + mode) | `lib/priceLadderGuard.ts`, `components/priceLadder/MtmGuardCard.tsx` |
| NSE / MCX cutoffs | `lib/priceLadderCutoff.ts`, `priceLadderSettings.ts` |
| Positions-window close | `lib/priceLadderClose.ts`, `app/api/price-ladder/close-position/route.ts` |
| WebSocket prices | `scripts/tools/price_ladder_ws.py` (+ `live_indices_ws.py`, options bridges' files) |
| UI | `components/priceLadder/PriceLadder.tsx`, `LadderGrid.tsx`, shared `multiLegFocus/OrdersTradesModal.tsx` |

Ledger: `debug/price_ladder_state.json`, written only through `updateLadderState` (O_EXCL lock + atomic rename, `rev` bumped
per write; the page drops a view older than the one on screen). It is re-read on every tick and request, never cached.

## Rules (each came from a review or a bug)
1. **Three-step write for every order.** Mark the slice (`placing` / `exiting`) under the lock BEFORE sending, send outside the
   lock, record the outcome under the lock (`commit` / `commitIf`, applied only if the slice is still in the state the job
   started from). A crash or second process can never send the same order twice; an orphaned mark becomes UNKNOWN after 30 s.
2. **Re-check every cap inside the lock.** The 20-lot cap (`lotsOnContract`) is read in the route for a fast refusal, then
   re-checked in the `updateLadderState` callback that appends the slice (XY arm, plain arm, Market, +1). A check made
   before the `await`s (contract resolve, prices, funds) lets two fast clicks both pass. New opening path = new in-lock check.
3. **A send that throws is an outcome, not an exception.** `safePlace` + `outcomeOnThrow(open, err)` (`priceLadder.ts`): a
   thrown ENTRY is UNKNOWN (may be live, never resent); a thrown EXIT is `rejected` and retried in 15 s (it is sized against
   the broker book each time, so a retry cannot add exposure). Never call `placeFor` bare in a job.
4. **Dhan reply without an order id and HTTP >= 500 is ambiguous.** `placeDhanOrder` reconciles by correlationId
   (`isAmbiguousReply`, `dhanOrderReconcile.ts`), else UNKNOWN. Only a 4xx is a clean refusal. (Invariant 14 of
   `dhan-terminal-position-ownership` already covered a non-JSON 5xx and timeouts.)
5. **UNKNOWN slices are skipped by the watcher** — including their bracket. The user resolves them (`resolve` action). So
   anything that turns a slice UNKNOWN also removes its SL protection: do it only when an order may genuinely be live.
6. **Exit sizing is `exitQtyFor(own, side, book, inGrace)`:** broker read failed -> own; inside `FILL_GRACE_MS` -> own; no row ->
   0 ("closed outside the ladder"); else min(own, what the broker still shows in that direction). `reconcileDown` only clamps
   DOWN, outside the grace, comparing the ledger's whole ownership of a book row (slices AND pair legs) with the broker.
7. **Prices are WebSocket-only.** Never a REST quote (shares Dhan's 1/s lane; 31 s replies after a 429). A spot's age is when it
   last CHANGED (`SPOT_STILL_MS` 15 s, futures axis 60 s), a value first seen is not fresh until it moves, and a stale price
   pauses levels / SIM fills rather than falling back. An option LTP needs a settled subscription.
8. **XY brackets run in the dashboard process on index points** — there is no broker-side stop. Closing the server stops them
   (the guard and `planTick` live in the same process). Say so in any change that touches availability.
9. **Positions-window close: the browser names the position, the server sizes it.** `/api/price-ladder/close-position` takes
   `{broker, key (securityId on Dhan, trading symbol otherwise), product, pct 25|50|75|100}`, re-reads the broker book
   (`brokerPositionRows`, never cached), derives side and quantity (`planClose`: opposite side, whole lots rounded down,
   100 = |net| verbatim), and one `CloseGuard` entry per position blocks a double click (in flight + 8 s cooldown while the
   book lags). Refused: Kotak/Zerodha MCX (units unconfirmed), non-F&O rows, a Zerodha order above the freeze quantity, and any
   contract the ladder itself is already exiting for real (`ladderExitInFlight`: a second exit sized off the same lagging book
   would flip the position). A Dhan partial re-reads the book after its lot-size lookup (a Python call that takes seconds).
   Never accept side / qty / security id for the order from the browser.
10. **MCX units differ per broker** (`mcxUnitError`, `resolveContract`): Dhan and Zerodha take lots (lotSize 1, `mult` 10), Kotak
    takes barrels (lotSize 10). CRUDEOILM trades only the 100-point strikes (`isTradedStrike`).
11. **Two ladders share one ledger.** Slices carry `pane` (untagged = 1); the guard is per pane + broker + mode. Bulk actions
    (`exit` / `cancelAll` by securityId) are NOT pane-scoped — pass `ids` from the page.
12. **Nothing leaves the ledger unsaved.** `updateLadderState` archives what a write is about to drop
    (`lib/priceLadderArchive.ts`: the whole old ledger at a day roll, the removed rows on Clear) into
    `debug/price_ladder_archive_<date>.json`, merged by id, BEFORE the ledger is rewritten; an archive error is logged and
    shown as an event, never thrown (the watcher must keep running). Any new way of removing a slice or pair must go through
    `updateLadderState`. `rollDay` keeps MTM guard LEVELS but restores every guard OFF with no runtime state (a stale
    exit-everything rule must not switch itself on over a new day); armed levels and the REAL arm lapse with the day.
13. **Basket mode (SIM and REAL).** `lib/priceLadderBasket.ts` (pure: axis, orientation, planner, partial shares) +
    `priceLadderBasketActions.ts` (`action:'basket'`), records in `state.baskets[]`. The axis is the net premium magnitude A; `side` is the
    CASH direction (SELL receives, BUY pays) and each leg stores the side it actually trades, so `pairBias`, `classifyClick`, `entryStep`,
    `openExitStep` apply unchanged. The 2-leg Pair engine is NOT reused (it is hard-wired to `{ce, pe}` with one side / qty): copy its
    patterns, reuse its leg-level helpers. Every new place that handles `pairs` (guard, archive, rollDay, cap, strip, cutoff, clear)
    needs its `baskets` twin. REAL (`runBasketJob` in `priceLadderServer.ts`, pure rules in `priceLadderBasket.ts`): hedges (BUY legs)
    go together and must ALL fill in full before any SELL leg is sent (`basketEntryVerdict` advance / open / unwind / unknown), a failed
    hedge sends no short, a failed short unwinds shorts first, exits cover shorts before hedges (`exitLegs`), an UNKNOWN leg stops and
    reverses nothing (resolve per leg), the reconcile cuts legs down only (`cutBasketLeg` -> BROKEN). Capped at `MAX_REAL_BASKET_LOTS`
    (5) and funds-checked fail closed (`realBasketBlocked`) until it has run live (`dhan-terminal-position-ownership` Inv 4, 9, 10, 14).
14. **`settings` lives in two places** (the settings file and `state.settings`; the state's wins, shallow). Change a cutoff only
    through `setCutoffsFromBody`.

## Tests
- `node --test lib/priceLadder*.test.ts` (unit; ~150).
- `E2E_PORT=3000 PW_CHROMIUM_PATH=/usr/bin/google-chrome npx playwright test e2e/price-ladder.spec.ts` when the dashboard is
  on :3000 (see CLAUDE.md: never let Playwright start a second `next dev`). The spec fakes `/api/price-ladder/state` in the
  browser, refuses the SSE stream and any unmocked non-GET (599); it cannot place an order. The close-position cases mock
  `/api/price-ladder/close-position` too.
- A live check in Chrome may open the Positions window and read it, but never click Close on a real position (a confirm dialog
  also freezes the browser tool); test the send path with the mocked e2e.

## Unconfirmed
Sensex session close 15:40; CRUDEOILM fills and position units on Zerodha / Kotak; Dhan 5xx-with-body behaviour (the fix is
defensive). Mark anything new here with the date and how to confirm.
