# Row actions and order safety

Table of contents: Shift (roll) · Placement · Exit · Add lots and add leg · Locking and state · Rate limits · Guard checklist

## Shift (roll) N strikes
Advanced Scalper rolls one position (`resolveShiftTarget` in `lib/strikeShift.ts`, refuse-on-clamp, collision confirm).
Multi-leg Focus rolls one leg or a group (`planLegShifts`, `shiftLegs` in `MultiLegFocus.tsx`).

Semantics: close the old leg (stays in the basket as CLOSED, so realized P&L and history are kept), then open a new leg at
`strike +/- N` **listed** strikes, same side/option/expiry, lots taken from what actually closed, inheriting `sl/slType/tp/tpType/trail`
(reset `bestPrice`). UP = higher strike for both CE and PE. Steps stepper is per strategy (1-10, UI state only).
Controls: one grouped bar `SHIFT - n strikes +` then `CE`, `PE`, `All` groups with down/up buttons (a group is hidden when it
equals `All`), plus per-leg chevrons on OPEN legs.

Order of `shiftLegs` (each step exists because a real failure mode does):
1. Basket exists, broker logged in, no other placement in flight (shared lock), selected legs are OPEN **and** all have a ledger qty (a group moves fully or not at all).
2. `planLegShifts`: all-or-nothing, uses each leg's own expiry chain filtered by the far-expiry rule; refuse on chain-edge clamp.
3. Refuse landing on a contract this strategy already holds on the **opposite** side (Dhan nets by security id: it would offset, not open).
4. One combined confirm: sibling-basket collision (`findSiblingLegCollisions`) and same-basket same-side merge.
5. Take the lock, then check bid/ask of the NEW strikes (before anything closes).
6. Close: shorts concurrently, then longs; longs skipped if any short did not close. Any failure aborts before reopening and names what closed.
7. Verify the position book came down (up to 3 reads, 500 ms apart: flat, or netQty below the leg's own qty). If unverifiable (shared contract) ask before reopening.
8. Reopen: buys concurrently, then sells; if a hedge fails to reopen, shorts stay closed. Size = closed units floored to whole lots, report remainder. `addNewLegCore` with `skipCollisionCheck` and `skipSpreadCheck` (both already done).
9. Release the lock in `finally`.

## Placement (`placeBasket`)
Two phases, legs inside a phase concurrent: all BUY legs, then all SELL legs (2 round trips instead of N). Before any order:
far-strike rule, margin verified for the **current** legs (`marginCompRef` vs `basketCompKey`), fresh funds (poll reading reused
if < 5 s old), estimate margin needs a confirm, spread check (started early, applied after margin passes). Between phases, re-read
funds only when tight (`available - premiumPaid < 1.2 x required`) and unwind hedges on shortfall. A failed leg ends the run:
unattempted legs return to DRAFT (never left PLACING), placed MARKET legs are auto-reversed passing verified contract identifiers
(`securityId` and `tradingsymbol` captured on acknowledgement), LIMIT legs are surfaced for manual cancel. Each leg's placement
wrapper never throws, so `Promise.all` cannot reject early and skip the rollback.

## Exit
`exitOneLeg` fetches live positions, matches the leg by security id (fallback resolved id), clamps qty to `min(ledger qty, broker |netQty|)`,
books the close under the position's own product with non-Dhan symbol fallbacks (`match.row.tradingSymbol`), returns `{ closed, qty }`
(qty = units sent, 0 when already flat). `exitBasket`: shorts (buy-to-close) concurrently first, then longs, and **never sell a hedge while a short is still open**.
**Manual Single-Leg Hedge Guard**: exiting an individual BUY hedge while short legs remain open prompts an explicit confirmation warning about unhedged naked short risk.
Capture `closedFill` on every close path (manual, already-flat, rollback) or realized P&L reads as 0.

## Add lots, add leg, and strategy scaling
`addNewLegCore(basketId, params, opts?)` returns boolean. A leg identical to an OPEN one (same side/option/strike/expiry) merges into it with a
weighted average, because Dhan nets them into one row. The append/merge is a functional `patchLegs` write. Add Lots on an existing leg is not
subject to the far-strike rule; Add Leg (a new open) is. Both pass the leg's stored `orderRef.securityId` and `symbol` to prevent resolution
failures on off-expiry or unlisted strikes.
**Strategy Scaling (`scaleStrategy`)**: Scales all open legs by +1x (or +Nx) using the leg's base ratio via a 2-phase placement (all BUY hedges
first, then all SELL legs) with sibling collision checks and post-await ref reads. Single-ticket draft multiplier allows scaling the entire combo
from 1x to 50x before placement.

## Locking and state
- Take the placement lock **synchronously, before the first await** (wrapper around the inner function, released in `finally`). A lock set after a funds read or a confirm dialog lets a double-click place twice.
- Use `patchLegs(basketId, legs => ...)` (functional, reads React's latest state) for every async write to a basket's legs. `updateBasket`'s updater is deferred when another update is queued, so `basketsRef.current` can be stale for the next synchronous read and a snapshot write silently reverts or drops another leg.
- Return results from async actions (`{closed, qty}`, boolean) instead of re-reading state to see whether they worked.
- Coalesce funds polls per broker and ignore replies for a broker that is no longer selected.

## Rate limits
Numbers are our own headroom choices; Dhan's public docs give no numeric limits (see `dhan-api-errors`), so treat them as tunable:
order limiter 8/s in `app/api/scalper/fast-order/route.ts` (sliding window in the Node process; strategies and the copy-trade bridge send orders too, so it cannot see them),
one retry after ~1.1 s on HTTP 429 only (rejected before booking, safe), none on timeouts (those reconcile by `correlationId`);
quote lane `lib/dhanQuotePacer.ts` ~1.1 s gap, doubles on 429 up to 20 s, relaxes on success, max 1 running + 1 waiting (else rejected as busy), state on `globalThis`.
Other routes still call `/marketfeed/ohlc` directly and share the bucket; moving them onto the lane is open work.

## Guard checklist for any new row action
- [ ] Sized off the leg's ledger qty, clamped by the broker, never raw broker net qty.
- [ ] Lock taken before the first await; released in `finally`.
- [ ] Refuses (does not warn) when it would net against an opposite leg.
- [ ] Confirms on sibling-basket collision.
- [ ] Checks happen **before** anything closes; nothing can refuse after a close.
- [ ] Buys before sells on the way in, shorts before longs on the way out; hedge never sold under an open short.
- [ ] Aborts leave a flat or defined-risk state and say exactly what was and was not done.
- [ ] Async writes use `patchLegs`; results are returned, not re-read.
- [ ] Far-expiry strike rule and spread check applied to every path that opens.
- [ ] Buttons for conflicting actions are disabled while it runs.
