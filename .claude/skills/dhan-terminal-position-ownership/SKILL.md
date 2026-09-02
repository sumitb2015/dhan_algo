---
name: dhan-terminal-position-ownership
description: Use when a dashboard terminal (like FocusTool or MultiLegFocus) has multiple rows/legs or multiple execution engines (browser tab + server-side worker) that can each hold a position on the same underlying/strike, when sizing an exit or P&L off a broker position, when locking a strike selector because "a position is open", or when implementing a strike roll/shift that closes one leg and reopens another.
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
builder — hit the reconciliation half of the same shape (`5a70b1f`,
`d922a56`, `eed3868`); see Invariant 6.
The Scalper/AdvancedScalper equivalent for pure broker-payload math (MCX
multipliers, product identity) is `dhan-broker-positions` — this skill is
about *who owns* a position, not what a payload field means.

**The rule that prevents all of them: never derive "this row/leg is mine" from
a raw broker query. Ownership lives in a ledger this component writes when it
places an order; the broker is only ever consulted to confirm or shrink that
ledger, never to originate it.**

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
after opening, because the position book lags a fresh fill.

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

### 6. Reconciliation needs a propagation grace window, and trusts broker qty downward *and* upward from its own ledger
`MultiLegFocus` reconciles each leg against the broker's position book on a poll
tick. Two more failure shapes showed up here beyond Invariant 2's "never grow the
ledger from broker state" (that rule still holds for *ownership* — never adopt a
strike this leg didn't open):
- A leg placed seconds ago can still show as flat in the broker's position book —
  order ack races the position-book write. Reconciling immediately reads that as
  "closed" and drops a live leg. Give a fresh leg a grace window (as in Invariant 2)
  before trusting an absent broker position as a real close. (`5a70b1f`)
- Once a leg is confirmed open, the artificial cap some early code applied — never
  let the ledger qty exceed what this leg's own orders opened — was wrong for
  *this leg's own* quantity: a partial fill completing, or a broker-side lot
  adjustment, is real movement in a position this leg does own, not another row's
  leg leaking in. For a leg already attributed to this row, trust the broker qty
  fully (both directions) rather than clamping it against a stale local snapshot.
  (`d922a56`, `eed3868` — sync leg lots to the broker's filled quantity on every
  reconciliation pass)

### 7. Re-read shared state after an `await`, not from a pre-await snapshot
`addLotsToLeg` / `addNewLegToBasket` merged their result into a `basket.legs`
array captured *before* an `await` (an order placement, a lookup). A concurrent
reconciliation poll (this skill's own poll tick) can write to the same basket
while the await is in flight; merging into the stale pre-await snapshot silently
reverts whatever the poller just wrote. Re-read the current ref
(`basketsRef.current`) after the await completes and merge into *that*. (`49bd98e`
— see `dhan-polling-guards` for the sibling stale-closure fix in the same commit)

## Before You Ship
- Does every lock/exit/P&L decision route through an ownership check
  (ledger + worker-hold), not a raw broker position/netQty read?
- Does reconciliation only ever shrink the ledger, never grow it from broker
  state — *except* for a leg already owned by this row, where broker qty is the
  full source of truth in both directions once past its propagation grace window?
- Does fill confirmation look up the broker position for the *order's
  target symbol*, not a cached/pinned position reference?
- Is a strike shift's reopen gated on the close having fully filled?
- If there are two execution engines, does a tab-side mutation check the
  other engine's ownership first, and does a stale-but-alive engine refuse
  to hand over?
