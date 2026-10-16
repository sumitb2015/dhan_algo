---
name: dhan-fill-price-pnl
description: Use whenever a dashboard terminal books or displays its OWN P&L for positions it opened — Focus Tool, Multi-Leg Focus, Triple Straddle, the scalpers, Covered Call — and the number has to match the broker. Covers the P&L basis vs stop-reference split, re-pricing an order's estimate to Dhan's averageTradedPrice, pricing a late or partial slice from a cumulative average, correcting P&L for qty closed before the traded price arrived, tying a correction to the position it belongs to, what Zerodha / Kotak / SIM rows do instead, and the fallbacks when the price never arrives. Read before touching bookedPnl, ceEntry / ceFillEntry, rebase*OnTradedPrice, mtmForQty callers, closedSliceBooked, or any "row P&L doesn't match Dhan" report — even if the user only says "the profit shown is wrong".
---

# P&L at actual fill prices

**What went wrong (2026-10-16, Focus Tool, commit `85666488`).** A NIFTY straddle row showed about ₹7,400 while Dhan
booked +₹6,660 for the same two cycles.
- The row stamped each sell's entry at the **LTP just before the order** (an estimate) and corrected only the **exit** to
  Dhan's traded price. Booked P&L was `(estimate entry − traded exit) × qty`: half guess, half fact.
- One target exit was off by about ₹740.

A P&L number is only trustworthy when **both sides are the broker's fills**.

## The rule: two prices per leg, never one

| Field (Focus Tool) | What it is | Who reads it |
|---|---|---|
| `ceEntry` / `peEntry` | **Stop reference**: the LTP at the order, or the traded price when the row's `refPrice` is `'traded'` (AlgoTest "Tgt/SL Ref Price") | SL ×, targets, trail, SL→Cost, Pair %. `legOwnEntry()` |
| `ceFillEntry` / `peFillEntry` | **P&L basis**: the qty-weighted actual average fill of THIS row's open qty | booked P&L, live MTM, the leg % chip. `legFillEntry()` |

They differ on purpose. A user who chose LTP as the stop reference must not have stops move because the fill came back
1.5 points better. P&L must follow the fill whatever the stop reference is. **Never reuse the stop reference as the
P&L basis**, and never let the broker's own `sellAvg` / `buyAvg` be the basis for a row's booked P&L: it is pooled
across every trade on that contract today (earlier cycles, other rows, manual trades). See `dhan-broker-positions` and
`dhan-terminal-position-ownership`.

## How the basis is kept (pure helpers in `rs_dashboard/lib/focusToolPnl.ts`)

1. **On every add, blend from the estimate:** `blendFillBasis(prevBasis, prevQty, estimate, addQty)`.
   - **Unknown stays unknown:** a held leg with no basis returns `null`, never a blend toward 0. A 0 basis looks
     like a phantom loss of the whole premium and can trip a rupee SL or the account stop.
   - **An add with no estimate** keeps the old basis until its traded price arrives.
2. **Re-price to the traded price with ONE order read per order:** `rebaseOpenOnTradedPrice`.
   - That read corrects both the basis and, when the row uses it, the stop reference. Two parallel polls double the
     Dhan order-status calls and invite 429s.
3. **Price the slice, not the order:** `sliceTradedPrice(cumAtp, cumQty, prior)`.
   - Dhan's `averageTradedPrice` is the **cumulative** average of everything filled so far. A late slice of a part-filled
     order is worth `(cumAtp·cumQty − priorAtp·priorQty) / sliceQty`.
   - Remember per `orderId:open|close` what was already applied (`tradedSliceRef`).
4. **Apply the correction to the position the add belonged to:** `fillRebasePatch`.
   - The basis moves by `c = (traded − assumed) × filled / heldAfterAdd`, where `assumed` is the price the add was
     blended at (its estimate, or the old basis when it had none).
   - **Qty closed before the price arrived** was booked at the old basis, so add `c × (heldAfterAdd − heldNow)` to
     `bookedPnl`. Legs here are always short, so a higher basis means more profit.
   - **If the leg went flat and re-opened meanwhile** (identity = the leg's `openedTs` when the fill landed), only
     the old position's booked P&L is corrected; the new basis is never touched.
5. **Close side:** book at the LTP snapshot against the basis, then `rebaseBookedOnTradedPrice` moves `bookedPnl` by
   `closeRebaseDelta(estimate, slice traded price, qty)`.
   - The late-fill sweep (`reconcileUnconfirmedOrder`) does the same for a slice that confirmed after the window.
   - A late **open** also re-bases the stop reference when the row uses traded prices (`rec.rebaseStop`).
6. **Back off 1 / 2 / 4 / 8 s.** A price that never arrives (rate limit, order still in transit, reload) **drops the
   basis to unknown** for that position, so readers fall back. Keeping an estimate as if it were a fill is the bug this
   skill exists to prevent.

## Brokers and modes

- **Dhan:** per-order `averageTradedPrice` via `/api/scalper/orders?orderId=` → the full scheme above.
- **Zerodha / Kotak:** no traded-price read is wired here, so **do not track a basis**: `ceFillEntry` stays unset.
  - Live MTM uses the broker's own average, which is exact for a sole owner.
  - Booked uses the stop reference (the old behaviour).
  - An uncorrected estimate would be worse than either.
- **SIM:** the paper fill is at LTP, so the estimate IS the fill. Track the basis, and book SIM closes against the
  **same** basis the live mark uses (`ceFillEntry ?? ceEntry`), or the row's P&L jumps at close.
- **Legacy rows** (opened before the field existed): readers fall back. Live uses the broker average; booked uses
  `legOwnEntry`. A small jump at close is possible and expected; new positions don't have it.

## Checklist for any new order path or terminal

- [ ] Stamp the estimate with `blendFillBasis` in the same ledger write that changes the qty. Clear it when the leg goes
  flat (same pattern as `ceTrailSteps`).
- [ ] After a broker-confirmed open, call the one-read rebase with `heldAfterAdd`, `assumed` and the position identity,
  all captured **before** the write.
- [ ] Every booked close reads `legFillEntry`, never `ceEntry` alone and never the pooled broker average.
- [ ] Late or partial fills go through slice pricing, for opens and closes alike.
- [ ] Non-Dhan brokers: don't invent a basis.
- [ ] Charges (brokerage, STT, stamp) are NOT in any of this. Say so when comparing against a contract note.

## Diagnosing "row P&L ≠ Dhan"

1. **Rebuild the truth from the order book** (read-only `dhan.get_order_list()`): per window, Σ(sell − buy) ×
   `averageTradedPrice` × `filledQty`. Compare cycle by cycle against the row's events in
   `debug/focus_tool_events.jsonl` (`auto_exit_row` carries the MTM at trigger time).
2. **Typical gaps:**
   - trigger-time MTM vs actual fills (slippage on a market or limit buy-back);
   - orders the row never placed (check every order's `correlationId` — Focus Tool orders are `fts…`);
   - a pooled broker average on a strike traded in an earlier cycle;
   - charges.
3. **Positions vs fills:** Dhan's position book `realizedProfit` / `unrealizedProfit` is the broker's own view. Compare
   the **realized** figure with the row's booked P&L only after excluding trades the row didn't place.

## Tests

`lib/focusToolPnl.test.ts` (`blendFillBasis`, `sliceTradedPrice`, `fillRebasePatch`, `pnlPctOfPremium`) and
`lib/focusToolSimulatedLegs.test.ts` ("P&L basis…") for `legFillEntry` vs `legOwnEntry`. Add a case to the pure
helpers for every new race; the component wiring has no unit tests, so keep the maths in `lib/`.
