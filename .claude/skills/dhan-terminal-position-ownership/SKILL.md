---
name: dhan-terminal-position-ownership
description: Use when a dashboard terminal (like FocusTool, MultiLegFocus or Triple Straddle) has multiple rows/legs or multiple execution engines (browser tab + server-side worker) that can each hold a position on the same underlying/strike, when sizing an exit or P&L off a broker position, when locking a strike selector because "a position is open", or when implementing a strike roll/shift that closes one leg and reopens another, or an automatic re-entry after a leg stop/target.
---

# Terminal Position Ownership & Strike Rolls

## Overview
Dhan nets positions by security ID — it has no concept of "row" or "which
strategy instance". Any UI that lets multiple independently-configured
things (rows in a table, a browser tab vs. a server worker) resolve onto the
same strike is one broker position away from one of them stomping the
other. `FocusTool.tsx` hit this same bug shape seven times across ~10
commits (`36144ad`, `2afbf1f`, `9e5b527`, `af5d9ea`, `13b0fef`, `8a44d49`).
`MultiLegFocus.tsx` / `lib/multiLegFocus.ts` — the N-leg options basket
builder — hit the reconciliation half of the same shape (`5a70b1f`, `eed3868`,
`d922a56` → reverted by `af96a1f`/`8f86f20`); see Invariant 6.
The Scalper/AdvancedScalper equivalent for pure broker-payload math (MCX
multipliers, product identity) is `dhan-broker-positions` — this skill is
about *who owns* a position, not what a payload field means.

**The rule that prevents all of them: never derive "this row/leg is mine" from
a raw broker query. Ownership lives in a ledger this component writes when it
places an order; the broker is only ever consulted to confirm or shrink that
ledger, never to originate it.**

`FocusTool.tsx`'s server-side worker (`scripts/tools/focus_tool_rows_worker.py`)
stopped being spawned as a live process in `31fadcf` (2026-09-25) — the route
that launched it (`app/api/focus-tool/worker/route.ts`) was gutted to a stub,
in favor of single-engine, in-tab execution. The script file itself was NOT
deleted; it's still tracked and still imported by `tests/test_focus_tool_parity.py`
and three sibling test modules as the Python-side reference for a cross-language
parity suite against `lib/focusToolRules.ts` — it just never runs live anymore.
That refactor also silently dropped the worker's own
propagation grace window (Invariant 2/6) from the *live* path, restored in `1ea9d3d`/`f8e9665` as
`nextOpenedTs`/`isGhostDropProtected` in `lib/focusToolRules.ts`, with the
per-leg open timestamp now persisted in `FocusRowFill.{ce,pe}OpenedTs` on disk
instead of a worker heartbeat. Invariant 5 (tab vs. server worker) is now
historical for FocusTool specifically — no current surface in this repo runs
two independent execution engines against the same ledger — but keep it: it's
the shape to recognize immediately if a background watcher is ever
reintroduced here or added to another terminal, and the "grace window survives
a stale post-fill poll" half of it (Invariant 2) is very much still live,
just backed by a JSON file instead of a worker.

## When to Use
- Any surface with multiple rows/instances that can independently resolve to
  the same underlying strike (a straddle/strangle terminal, a multi-leg
  builder with more than one active row).
- Any surface with two execution paths that can both place real orders for
  the same config (a browser-tab scheduler + a server-side worker process).
- Implementing or reviewing: strike lock/unlock logic, a "shift/roll strike"
  action, exit sizing, P&L aggregation, or fill confirmation after placing an
  order.

## The Invariants

### 1. Ownership is the fill ledger, not broker net position
A coincidental broker position at the strike a row resolves to (another
row, another strategy, a leftover manual trade) is not this row's position.
Locking a strike selector, sizing an exit, or attributing P&L off raw
`getPosition()`/net-quantity treats someone else's leg as this row's own —
freezing a draft row's selector, or having one row's exit flatten another's
book. Ownership is `row.fill.{ce,pe}Qty` (what this row's own orders
actually opened), plus — if a server worker exists — its own heartbeat/hold
state for legs *it* opened. A leg with no ledger entry and no worker-hold is
not owned, full stop, even if the broker shows an open position at that
exact symbol.

Ownership is **per leg**, and so is everything derived from it — the strike
pin, the strike-selector lock, the open badge, partial-exit chips, Exit All.
A row-level "is anything open" check leaks a closed leg's state into every one
of those (Invariant 11).

```ts
// lib/focusToolRules.ts — rowOwnsLeg()
function rowOwnsLeg(row, leg, workerHold) {
  const qty = leg === 'CE' ? row.fill?.ceQty : row.fill?.peQty;
  if ((qty ?? 0) > 0) return true;
  if (!workerHold?.open) return false;
  return (leg === 'CE' ? workerHold.ceStrike : workerHold.peStrike) != null;
}
```

### 2. The ledger is reconciled against the broker, strictly downward
The fill ledger is the sizing authority for every exit — but it moves on
order *acknowledgement*, not fill, so it drifts: an exit accepted and never
filled would zero it while the position is still live; a leg closed
elsewhere drifts it the other way. Reconcile every tick by writing ledger
quantities DOWN to what the broker's position book actually shows. Never up
— a broker quantity *larger* than the ledger belongs to something else
(another row, a manual trade), and adopting it would let this component
close a position it never opened. A failed positions call reads as unknown
and leaves the ledger alone; a leg is exempt from reconciliation for ~20s
after opening, because the position book lags a fresh fill — Kotak/Zerodha
in particular have no fill-confirmation socket, so a poll can still read a
just-filled leg as flat. In `FocusTool.tsx` this is `GHOST_DROP_GRACE_MS`
(20s) / `isGhostDropProtected()` in `lib/focusToolRules.ts`, gated on
`FocusRowFill.{ce,pe}OpenedTs` — stamped by `nextOpenedTs()` on the
flat→held transition and persisted to `debug/focus_tool_rows.json`, so the
window survives a tab reload, not just an in-memory ref. This exact
protection was silently dropped when the worker was removed (`31fadcf`) and
had to be restored (`1ea9d3d`, extracted+tested in `f8e9665`) — it's easy to
lose by accident in any refactor that touches the fill-ledger update path.

The same refactor also introduced the "exit accepted, never filled, ledger
zeroed" failure this section warns about: `applyFill` dropped the whole leg
(`-pageOwn`) on ANY Exit All that didn't confirm in full, even with 0 filled
— leaving a live short no stop watched. Fixed in `50f4bca`: an unconfirmed
close drops only what filled. See Invariant 11 for how the remainder is then
retried safely.

### 3. Confirm every fill against the target symbol, not a cached position
`ackId = await placeOrder(...)` means the broker *accepted* the order, not
that it filled — and if the code that resolves "did it fill" reads a cached
position object (e.g. `live.cePosition`), that object is usually pinned to
the row's *current config strike*, not the strike the order actually
targeted. A strike-shift reopen ordering a *new* strike but confirming
against the *old* strike's cached position will report itself unfilled
forever, even once the real market order goes through — the ledger sticks
at zero while other state (the displayed strike) has already moved on.
Resolve the fill baseline by looking up the broker's live position for the
exact symbol/strike the order targeted, never off a stale pinned reference.

### 4. Strike rolls are atomic: full close before reopen
A shift is close-old-then-open-new. A partial close (ragged fill, sub-lot
remainder) must not silently reopen the shortfall at the new strike — that
orphans quantity and drops the realized P&L banked from the close. Require
the close side to fully fill (down to the shared-strike floor across every
row/engine holding that symbol) before placing the reopen order; bank
closed-slice P&L off the fill ledger as it happens, not assumed on order ack.

### 5. A tab must not touch a leg a server worker owns
When a browser tab and a server-side worker are both live execution paths,
the worker's positions are invisible to the tab except through its own
heartbeat/state file — the tab shifting or closing a leg the worker tracks
means the worker's next reconciliation pass sees the position vanish with no
matching "adopted new strike," and silently drops it from tracking instead
of following the roll. Gate any tab-initiated mutation (shift, manual close)
on `!workerHold?.open` for that leg first. Symmetrically, a worker that's
STALE (heartbeat stopped, PID still alive) must stand down rather than hand
control to the tab — that process can still trade, so a handover is exactly
the double-driving the STALE check exists to catch; silence in that state
must read as "danger," not "safe to take over."

### 6. Reconciliation needs a propagation grace window, and clamps DOWN ONLY — this policy flip-flopped once, don't flip it back

> **Changed 2026-10-07 for Multi-Leg Focus (user decision): one strike per group, broker sync both ways.**
> The clamp-down-only rule below existed because two baskets could hold the same contract and Dhan nets
> them into one broker row. MultiLegFocus now refuses that outright (`refuseSharedStrike`: place, add lots,
> add leg, scale and shift onto a strike open in another group are blocked, not confirmed), so a
> contract's broker qty belongs to its one leg. `lib/multiLegBrokerSync.ts` then: grows that leg to the
> broker qty (`growLegToBroker`, only when it is the contract's only live leg), and turns a broker option
> position no leg holds into an ungrouped trade (`outsidePositionBaskets`). The Untracked/Over warnings,
> Claim and Reduce are gone. Both rules stand down while this tool's own orders may still land (PLACING /
> CLOSING, `pendingOrders`, fill grace, any order action or regroup in flight), so its own fill is never
> counted twice. Known trade-off: a position opened on the same contract by another surface (Scalper,
> Focus Tool, Triple Straddle, a Python strategy) is adopted here too, and a stop set here can close it.
> Shrinking is unchanged (clamp + `brokerClampSlice`). The history below still applies to any surface
> that lets two rows share a contract.
>
> **Futures legs (same day):** `MultiLegLeg.option` is `'CE' | 'PE' | 'FUT'` (FUT: strike 0, adopted from the
> broker only). Payoff prices a FUT leg as a synthetic call minus put at strike = entry
> (`futuresAsSyntheticPayoffLegs`), Greeks give it delta 1, its live price is inverted from Dhan's own row
> (`ltpFromBrokerRow`: costPrice + unrealizedProfit / netQty — Dhan leaves the row's `multiplier` OUT of
> unrealizedProfit for MCX, so dividing by it put a CRUDEOILM future at 8590 while it traded at 8721). Exit works (it sizes off the
> broker row); place / add lots / shift / scale refuse FUT legs (`isOptionLeg`), and the option-chain views
> (P&L table, Position Map, Strategy Chart) skip them.
`MultiLegFocus` reconciles each leg against the broker's position book on a poll
tick (`reconcileLegWithBroker` in `lib/multiLegFocus.ts`).
- A leg placed seconds ago can still show as flat in the broker's position book —
  order ack races the position-book write. Reconciling immediately reads that as
  "closed" and drops a live leg. Give a fresh leg a grace window (as in Invariant 2)
  before trusting an absent broker position as a real close. (`5a70b1f`)
  That window was later lost from `reconcileLegWithBroker` entirely, and it bit on
  *growth*, not just placement: "+ADD 5 lots" on a 1-lot leg set the ledger to 6 lots,
  the next poll still read the broker's pre-order 65, clamped down to 1 lot, and
  clamp-down-only meant it never came back (2026-09-29). Now `MultiLegLeg.filledAt`
  is stamped on every ledger-growing path (place, add lots, add/merge leg, scale) and
  `reconcileLegWithBroker` refuses any shrink/close inside `LEG_FILL_GRACE_MS` (20s).
  Any new path that grows a leg's `fill.qty` MUST stamp `filledAt` too. A gap that
  already slipped through is recoverable only by the user-confirmed "Claim" action
  (`claimableLegQty`: broker qty minus every other tracked leg on that contract) —
  never automatically.
- **Per-leg clamping cannot see siblings over-tracking one pooled row.** Each leg is
  clamped against the pooled broker qty on its own, so legs of 390 + 130 on a 390
  position both pass (2026-09-29: 130 of 23400 CE bought back from outside the tool;
  tracked 520, broker 390, no warning, and exiting the stale 130 would later have
  clamped the sibling's 390 down to 260). `legQtyWarningsFor` checks the SUM per
  contract: 'under' → Claim / Import, 'over' → Reduce (`recordOutsideReduction`, no
  order; a partial cut splits off a CLOSED slice so its realized P&L survives), and a
  manual exit on an 'over' leg asks first. Which leg absorbs a gap is always the
  user's call. Groups in flux (PLACING/CLOSING, fill grace, pendingOrders, mixed sides)
  are skipped.
- **Importing outside trades** (`findUntrackedPositions` → ImportPositionsModal) offers
  only broker qty no live leg tracks (matched by securityId / symbol, same as
  `findLegPosition`), and adopts a contract only after verifying the row's parsed
  strike/expiry against that broker's own lookup (`ensureLookup`) — a symbol parse
  is a hint, not truth. Import re-reads the broker before writing.
- **Ledger qty is clamped DOWN to broker qty, never inflated up — this is the
  same rule as Invariant 2, and it was briefly reverted for this leg's *own*
  quantity, which caused a real incident.** `d922a56` argued that once a leg is
  confirmed open, its own partial fills/lot adjustments are real movement, not
  another row's leg leaking in, and switched to trusting broker qty fully in
  *both* directions. That reasoning was wrong: Dhan nets by security ID across
  *every* basket, so a leg's "own" broker row can silently include a sibling
  basket's contribution the moment they share a strike — this is exactly what
  happened in production ("24700 CE was already in a previous strangle, my new
  one just merged into it"). `af96a1f` reverted to clamp-down-only: qty is
  `Math.min(ownQty, brokerQty)` where `ownQty` is the leg's own last-known fill
  (or `ownQtyHint` — e.g. lots × lot size — on first reconciliation, before any
  fill is recorded), never the broker's pooled total. A leg already `CLOSED` is
  also left untouched rather than resurrected just because the broker still
  shows a live (possibly sibling-owned) position. `8f86f20` added a rate-limited
  warning (once per occurrence, not every poll tick) when a leg's tracked qty is
  clamped below broker qty, since that gap can be a legitimate manual top-up the
  app has no way to auto-attribute now that positions can be shared — surface it
  rather than silently doing nothing. **Do not reintroduce `d922a56`'s upward
  trust for this leg's own quantity** — the dashboard reconciler has no
  Python-side `resolve_exit_qty` safety net behind it; the clamp *is* the safety
  net. (`d922a56` → `af96a1f`, `8f86f20`)

### 7. Re-read shared state after an `await`, not from a pre-await snapshot
`addLotsToLeg` / `addNewLegToBasket` merged their result into a `basket.legs`
array captured *before* an `await` (an order placement, a lookup). A concurrent
reconciliation poll (this skill's own poll tick) can write to the same basket
while the await is in flight; merging into the stale pre-await snapshot silently
reverts whatever the poller just wrote. Re-read the current ref
(`basketsRef.current`) after the await completes and merge into *that*. (`49bd98e`
— see `dhan-polling-guards` for the sibling stale-closure fix in the same commit)

### 8. Changing the basket/page's own expiry (or underlying) does not silently move to its legs
Each leg stores its own `expiry`, copied from the basket/page at creation. A control that lets
the user switch the basket/page's expiry (or underlying) after legs already exist changes only
that top-level value — the legs' own stored `expiry` doesn't follow unless the change handler
explicitly moves them. Left unhandled, anything derived from "legs differ from the basket's
expiry" reads the mismatch as a different strategy shape than what's actually open — a strangle
whose legs got left behind renders as a calendar spread (mixed-expiry badges, a calendar payoff)
once the basket's expiry moves on without them. Same bug, same root cause, on a different page:
Options Monitor's legs table kept showing the *previous* expiry's legs and prices after the
top-bar expiry control was switched.

The fix is state-dependent per leg, not a blanket move:
- **DRAFT** (not yet entered) legs on the front/near expiry move to the new expiry — nothing was
  placed yet, so there's nothing to reconcile against.
- **Entered/live** legs on the *previous* active expiry get re-anchored (expiry, security id,
  price, IV re-resolved) when the new expiry's chain loads, so they keep pricing correctly.
- **Executed** legs, and legs the user deliberately parked on another expiry (e.g. a calendar's
  far leg), are left alone — re-anchoring those would be the actual bug this invariant prevents
  in the other direction.
- **Never reprice a leg from a chain or tick stream keyed only by strike** unless the leg's own
  `expiry` matches that stream's expiry — a same-strike leg on a different expiry has a different
  price, and silently repricing it from the wrong expiry's chain reintroduces the exact
  mixed-expiry confusion this invariant exists to prevent.
(`ac7981f`, `9ac9443`, `6ef9265`, `4792b48` — MultiLegFocus's `updateBasket`/`addNewLegToBasket`
and Options Monitor's expiry-switch re-anchoring, 2026-09-21.)

### 9. Concurrent leg placement: gate first, lock synchronously, never sell a hedge under an open short
`MultiLegFocus.placeBasket` fires legs concurrently in two phases (all BUY, then all SELL) —
2 round trips instead of N. That removes the chance to react between legs, so:
- **Fail closed on margin.** Block unless required margin was computed for the *current*
  composition (`marginCompRef` vs `basketCompKey`) and funds are known. Funds reuse the poll
  reading if <5s old, else read live. An `estimate` margin needs an explicit confirm.
- **Take the placement lock before any `await`** (`placeBasket` wrapper around
  `placeBasketInner`). A lock set after the funds read/confirm dialogs lets a double-click place
  the strategy twice.
- **Recheck funds between phases only when tight** (`available - premiumPaid < 1.2 x required`)
  so the common case pays no extra round trip; on shortfall skip the sells and roll back the
  hedges. The 1.2 factor is untuned, and whether `basketMargin` already includes buy premium is
  unverified — a wrong assumption unwinds fundable strategies.
- **Aborts release unattempted legs to DRAFT** (from the run's local `working`, before
  `rollbackPlacedLegs`), never leave them PLACING; each leg's placement never throws, so
  `Promise.all` can't reject early and skip the rollback.
- **Rollback auto-reversals pass verified contract identifiers.** Capture `securityId` and
  `tradingsymbol` upon placement acknowledgement into `placedLegs` and feed them directly into
  `resolveOrderRequest` during rollback, ensuring reverse MARKET orders do not fail if the
  chain/strikeMap is reloading or missing.
- **Exits go shorts first, then longs, and longs are skipped if any short is not CLOSED.**
- **Manual single-leg exits enforce hedge protection.** Squaring off an individual BUY hedge
  while short legs remain open prompts an explicit confirmation dialog warning the user that
  exiting the hedge leaves open short leg(s) naked and spikes margin requirements.
- **Order resolution prioritizes existing contract identifiers.** Scaling (`scaleStrategy`)
  or adding lots (`addNewLotsToLeg`) to an existing leg passes `leg.orderRef.securityId` and
  `leg.orderRef.symbol` so resolution does not fail if `strikeMap` is still loading or if an
  off-expiry leg has shifted.

### 10. A basket trades on its own broker; ACKs are not outcomes (MultiLegFocus, 2026-09-29)
- **Route every basket action through `executionBroker(basket, selected)`** (= `basket.broker`,
  the row badge). Until 2026-09-29 exit/add-lots/add-leg/scale/shift/rollback/margin all used the
  toolbar's selected broker, so switching the selector sent a Dhan strategy's exit to Kotak —
  where a same-strike Kotak position would be found and closed (wrong account). `lookupCache` is
  keyed `broker|underlying:expiry` (`lkKey`) for the same reason: Dhan entries hold security ids,
  Zerodha/Kotak hold symbols, and MCX lot sizes differ 100x. `legBrokerMismatch` refuses legs
  whose `orderRef` shape can't belong to the basket's broker (legacy data from before the fix).
- **Every order that changes a leg's ledger records a `pendingOrders` entry** (`withPendingOrder`);
  the poll settles it against the order book via `applyOrderOutcomes`. A rejected/cancelled
  grow order comes back off `fill.qty` (a never-opened leg becomes FAILED); a rejected exit
  REOPENS the leg — exits mark CLOSED on ACK and reconciliation never resurrects CLOSED, so
  without this a rejected exit leaves a live position untracked. Cancelled with no filled-qty
  field is reported, never guessed.
- **An ACK-time price is a placeholder.** Exits record LTP (or the ENTRY price when no LTP is
  loaded — a ₹0 close) on ACK; grows record response price/LTP. Pass that price to
  `withPendingOrder(…, price)` so `applyOrderOutcomes` can swap in the order book's traded
  average on fill (`settleFillPrice`). Before this (2026-09-29) five closed legs kept guessed exits
  and the page read -7,809 vs the broker's -27,908. Every CLOSED transition also stamps
  `closedAt`, which splits the header's Today P&L (broker MTM scope: live legs + closed today,
  `legCountsToday`) from the lifetime Total.
- **Dhan: an order counts as placed only once confirmed** (`confirmDhanOrder` →
  `GET /api/scalper/orders?orderId=`, `classifyDhanOrder`, ~6s). Dhan ACKs as TRANSIT and can
  reject later, so `placeBasket`'s SELL phase, `scaleStrategy`'s SELL phase and a shift's SELL
  reopen all wait for the hedge's TRADED; an abort auto-reverses only CONFIRMED legs. Unconfirmed
  after the deadline = stop, keep tracked via `pendingOrders`, never auto-reverse.
- **`exitBasket` confirms shorts came down at the broker** (`maxAfter` from `exitOneLeg`) before
  selling hedges; unconfirmed → ask, default keep hedges.
- **Auto-exits retry**: SL/TP/strategy triggers are timestamped (15s), not one-shot sets — a
  failed exit used to disarm the stop for the rest of the session.
- Risk-watcher writes (`bestPrice`) go through `patchLegs` (functional), never `updateBasket`
  with the render's `basket.legs` — that could revert a fill recorded by an in-flight order.

### 11. Per-leg pins, unconfirmed orders, and auto re-entry (FocusTool, 2026-09-30)
Lessons from adding leg-stop follow-ups (SL→OTM roll, SL→Cost, AlgoTest-style
re-entry on SL/target) to `FocusTool.tsx` (`b04d0ce`, `66a8fe1`, `50f4bca`,
`baa644f`). Pure rules live in `lib/focusToolRules.ts`
(`legPinnedStrike`, `evaluateReentry`, `reentryWindowClosed`,
`pendingReentryLevel`, `legTargetReason`, `costStopReason`, `legOwnEntry`).

- **Pin strikes per leg, only while that leg is owned** (`legPinnedStrike`).
  A row-wide pin ("any leg open → pin both") kept a stopped-out CE on its dead
  strike (22750) while the PE stayed open: the CE selector couldn't follow ATM
  and `+` would have sold the stale strike.
- **Per-leg pins make "unowned leg" dangerous everywhere it used to be
  harmless.** Before, a closed leg sat on its old strike, where the broker was
  flat. Now it re-resolves to the live ATM, where another row or a manual trade
  may hold a position. Every consumer of `live.cePosition`/`pePosition` must
  gate on `rowOwnsLeg`: Exit All (manual AND auto — `placeLeg`'s no-ledger
  fallback closes whatever the broker shows, unclamped), the 25/50/75% chips
  (size off `legOwnContracts`, not `netQty`), the open badge, and the VWAP
  series (`vwapSeriesFor` narrows a half-closed BOTH row to the leg it holds).
- **An ACK is not a fill, and a missed confirmation window is not a
  rejection.** Every order whose fill check comes back short is recorded as an
  `UnconfirmedOrder` (close or open) and settled against broker truth — Dhan by
  the order's own status (`/api/scalper/orders?orderId=`, 60s cap), Kotak/
  Zerodha by a fresh book read with a 15s hold — by a 1s sweep.
  - Close: while it is unsettled, no further close is sent on that leg, and
    auto exits skip it. A retry sizes off a FRESH book, never the 2s poll —
    resending against a stale book is how a short is closed twice and ends
    up long.
  - Open: a late fill of THAT order is credited to the ledger, clamped to its
    own size. This is the one sanctioned upward ledger move — it is this
    component's own order, identified by order id/size, not broker qty
    adopted from elsewhere (Invariant 6 still holds for everything else).
  - A late-confirmed close does NOT run that stop's follow-ups (re-entry,
    SL→Cost) — no automatic trades on a delayed path. Say so in the toast.
- **Concurrency: lock per row, but not across the two legs of one row.** Two
  legs are independent contracts; making a PE stop wait behind the CE's
  close + re-entry (≈10s) was a real gap. `legExitsInFlightRef` refcounts leg
  exits so they run together, the busy lock is released by the LAST one, and
  only the last one may retire the row. A leg exit that did not actually start
  (held, busy) must not suppress the row's pair/level rules that tick.
- **Re-entry must respect every exit that could immediately undo it.** Before
  an immediate re-sell: no pending whole-row exit (`rowExitWantedRef`, set
  when a whole-row exit is blocked by the busy lock), ledger still present
  (not re-armed/retired), leg is in the row's Side (a leftover leg keeps its
  stop but is never re-sold), window open (exit time, 15:17, No-re-entry-after,
  index started), cap not used. Count the attempt BEFORE the order so a
  rejecting broker cannot loop.
- **Waiting re-entries (cost / momentum) sit in a flat row, and flat rows are
  invisible to every exit rule** — `openRows` filters them out. So the
  waiting path must re-check what those rules would have: account budget and
  Book Exit cancel them explicitly (`cancelPendingWhere`), and the row's own
  H↑/L↓ and Book Exit levels are checked before firing (`pendingLevelBreach`).
  A waiting re-entry keeps the row alive — never retire it on a flat ledger
  while one exists. Fire at most one per row per scheduler tick
  (`runRowAction`'s busy check reads render state, so two in one pass run
  concurrently).
- **Entry price is the row's own stamp, not the broker average.** After a
  same-strike re-entry, a broker average that is day-level (Dhan `sellAvg` is
  believed to be — unconfirmed, see the vault) blends in the closed trade:
  SL ×1.2 on a 120 re-sell after a 100 trade fired at 132, not 144. Leg SL ×,
  its displayed level, leg target, SL→Cost and the pair SL × entry all use
  `legOwnEntry` (stamp first, broker avg only as fallback). A leg re-opened
  from flat with no price gets NO entry, never the previous position's. A
  `strikeOverride` open stamps the quote of the strike actually sold.
- **`adjustFillQty` must spread the old fill** (`...f`) — rebuilding the
  object field by field silently dropped every ledger field added later
  (roll counters, cost-stop flags, pending re-entries).
- **A stamped entry value carries its basis (delta).** `ceDeltaEntry`/`peDeltaEntry` are |delta| × 100 at open, the base of a Delta SL / target / trail. When the source of that number changes (Dhan's chain delta -> the model delta, 2026-10-05), legs already open keep the old basis:
  `ceDeltaModel`/`peDeltaModel` mark a model-basis entry, and `legDeltaBasis(fill, leg)` picks the matching LIVE delta (`RowLive.ceDelta` model vs `ceDeltaDhan`). A new stamped field that is later compared with a live value needs the same
  marker, never a silent re-baseline of persisted state. Adds to a running leg keep the leg's existing basis.

### 12. A terminal with a SIM mode keeps its own ledger file (Triple Straddle, 2026-10-06)

`/options/triple-straddle` places CE+PE straddle pairs and tracks them in `debug/triple_straddle_state.json`
(`app/api/triple-straddle/state/route.ts`, pure rules in `lib/tripleStraddle.ts`, orders in `lib/tripleStraddleClient.ts`,
state hook `components/triplestraddle/useTripleStraddle.ts`). Rules that are not obvious from the code:

- **Not `multi_leg_baskets.json`.** Multi-Leg Focus reconciles every basket in that file against the broker, so a paper
  (SIM) leg stored there reads as "flat at the broker" and is wiped. A surface with paper positions needs its own store.
- **SIM is the default and REAL is armed per page load, never persisted.** SIM never calls an order route (the browser
  network log is the check). Each position carries its `mode`, so a REAL position from an earlier session is still
  managed (a stop only reduces risk) while new REAL entries need the arm again.
- **Checkpoint before the order.** A REAL entry saves a record with both legs `unconfirmed` BEFORE any order is sent
  (`onIntent`); if that save fails, no order goes out. Otherwise a closed tab between the POST and the save leaves live legs
  the ledger never knew about.
- **Unconfirmed is a state with a way out.** `unconfirmed` (entry accepted, fill unproven) and `pendingExit` (closing
  order accepted, fill unproven) are never auto-resolved and never re-sent over. `exitStraddle` looks at the pending
  order first and sends a new close only if it died. The bar offers "It is open - track it" / "Nothing open - discard"
  after the user has checked Orders; without that a leg could block its slot forever.
- **An absent broker row is "unknown", not "flat"** (`brokerCapacity`). Match security id AND product. Right after entry
  (inside `TS_FILL_GRACE_MS`) the book lags, so send own qty; later, with no matching row, do not send an order that could
  open the opposite side. A positions call that FAILED outright fails open: an exit only reduces risk.
- **Reverse only what is confirmed filled, and confirm the reverse** (an accepted reversal can still be rejected).
- **Stale prices pause stops** (`TS_PRICE_STALE_MS`): a frozen quote must not fire or suppress a stop, and new orders are
  refused on an old quote. Time must tick on its own clock, a dead feed produces no state updates.
- **One ordered write queue** for every ledger save. A peak (trailing) update that races an exit can otherwise land last
  and resurrect a closed leg. The peak writer re-reads the position inside the queue.
- **One engine per browser:** the stop/target watcher runs only in the `useTabLeader('triple-straddle')` tab.
- **Trailing rules** (`trailSl`, `lock`, `lockTrail`, in % of entry premium, ported from Focus Tool's overall trail): the
  profit peak is persisted, tracked only for armed, fully confirmed positions, and `by > every` is invalid (it would put
  the floor above the profit that set it, an instant exit).

### 13. A resting stop-entry order is not a leg (Multi-Leg Focus SL-L / SL-M, 2026-10-08)

`ca20e7c7`. Add New Leg can send a Dhan `STOP_LOSS` / `STOP_LOSS_MARKET` entry instead of an immediate one. Until the
trigger prints there is no position, so there is no leg:

- **Track it beside the legs.** The order lives in `basket.waitingEntries` (`WaitingEntry`: order id, security id,
  trigger, optional limit, `at`), never as a PLACING leg. Reconcile, regroup, P&L, Greeks and payoff never see it.
- **Open a leg only from the order book.** `settleWaitingEntry` returns wait / open (traded qty and average) /
  dead (rejected, cancelled) / expired (earlier IST day). With no order book this tick (fetch failed) nothing
  settles — never guess a fill from a position row.
- **Settling is idempotent by order id.** Another tab or a store reread may already have turned the order into a leg;
  check `fill.orderId` / `orderIds` before opening one.
- **A fill on a contract another group already tracks is not added** (Dhan nets by security id; adding it twice
  double-counts). Toast the user to move it manually — consistent with one strike per group (Invariant 6).
- **A row holding a waiting entry is not finished** (`isFullyClosed` is false) and cannot be deleted; Exit All
  cancels the stop first. Stop-limit price must sit on the correct side of the trigger (BUY ≥, SELL ≤) —
  `fast-order` rejects it otherwise.

## Before You Ship
- Does every lock/exit/P&L decision route through an ownership check
  (ledger + worker-hold), not a raw broker position/netQty read?
- Does reconciliation only ever shrink the ledger, never grow it from broker
  state — including for a leg already owned by this row? (Broker qty is never
  trusted upward, even for "its own" leg — see Invariant 6's `d922a56` history.)
- Does fill confirmation look up the broker position for the *order's
  target symbol*, not a cached/pinned position reference?
- Is a strike shift's reopen gated on the close having fully filled?
- Does manual single-leg exit warn when closing a BUY hedge while short legs remain open?
- Does every order/exit/lookup for a basket use `executionBroker(basket, …)`, and does every
  ledger-changing order record a `pendingOrders` entry?
- Do rollback auto-reversals and scaling orders pass confirmed `securityId` and `tradingsymbol` identifiers?
- If there are two execution engines, does a tab-side mutation check the
  other engine's ownership first, and does a stale-but-alive engine refuse
  to hand over?
- If this surface lets the user change the basket/page's expiry or underlying after legs
  exist, does the change handler explicitly decide each leg's fate (move DRAFT, re-anchor
  live, leave executed/deliberately-parked alone) instead of leaving it implicit?
- Are strike pins, locks, badges, partial-exit chips and Exit All gated **per leg** on
  ownership — never "the row holds something" and never raw `live.*Position`?
- Does an order whose fill check came back short stay tracked (close: remainder kept and
  resends held until settled; open: late fill credited, clamped to that order) instead of
  being treated as filled or as rejected?
- Does any automatic re-entry check pending whole-row exits, the window, the cap (counted
  before the order), the row's Side, and — for waiting re-entries in a flat row — the
  account budget, Book Exit and spot levels that flat rows never see?
- If the surface has a SIM mode, is its ledger in its own file, and does a REAL entry checkpoint before the first order?
- Do stop/target/cost levels use the row's own stamped entry, not a broker average that
  may blend in an earlier trade on the same contract?

---

## Scaling a Placed Strategy ("Scale +N") — Preview Equals Execution

*Added 2026-10-04 (commit `de7d10d`).* Scale adds N more copies of an already-placed Multi-Leg Focus strategy:
every OPEN leg grows by `baseRatio × N` lots, as **real market orders**. The flow is
`ScaleStrategyModal` (preview) → `MultiLegFocus.scaleStrategy` (execute). Rules that keep it safe:

- **One planner for both sides.** `planScale(basket, delta)` in `lib/multiLegFocus.ts` computes lots
  now / adding / after per leg, `maxDelta` (50× multiplier cap) and `inStep`. The dialog previews it and
  `scaleStrategy` executes it; never re-derive lots in either place or they will disagree.
- **Refuse a plan the user did not see.** The dialog passes `scalePlanSignature(plan)` to the handler; the
  handler recomputes it and aborts on mismatch (a leg stopped out or lots were edited while the dialog was open).
- **Margin fails closed, twice.** The dialog blocks confirm on unverified margin, unreadable funds, insufficient
  funds or the 50× cap (its estimate is current margin × lots added ÷ total lots). The handler then re-checks
  margin live with the same rule as placement; the dialog is a preview, the handler is the authority.
- **Synchronous re-entrancy guard.** `scalingRef` (a `Set` of basket ids) is checked and filled before any
  `await`; `scalingMap` state alone is too late — a double click gets two scales through. Also refuse while the
  row is placing or exiting.
- **Only bump the `multiplier` badge when legs are `inStep`** (`lots === ratio × multiplier` for every open leg).
  An uneven basket still scales but leaves the badge alone and says so in the toast.
- **Partial failure reports exactly which legs filled and which failed**, per leg, and keeps the ledger to the
  filled ones — shorts exit/enter before hedges per Invariant 6/9; do not "retry the whole scale".
- **A leg with no valid ratio (`addLots < 1`) blocks the scale** — add lots to that leg directly.
- Shared helpers instead of copies: `basketLabel()` (row name: the live-leg structure, e.g. a strangle plus wings
  reads as an iron condor, else saved name, else preset key; multi-expiry baskets skip classification) and
  `crudeQtyMultiplier()`.
