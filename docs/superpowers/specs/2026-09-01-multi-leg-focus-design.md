# Multi-Leg Focus Terminal — Design Spec

**Date:** 2026-09-01
**Status:** Approved

## Problem / Goal

`FocusTool` (`components/FocusTool.tsx`) is a live position-monitoring terminal for
straddles/strangles, but its `FocusRow` data model (`lib/focusToolRows.ts`) is hardcoded
to exactly two legs (`ceQty`/`peQty`) — there is no way to add a third or fourth leg for
strategies like iron condors, jade lizards, or ratio backspreads. `Baskets`
(`components/Baskets.tsx`) already supports arbitrary N-leg presets (`lib/basketStrategies.ts`)
and multi-broker order placement (`lib/basketOrders.ts`), but is place-once: it fires the
basket's orders and stops, with no ongoing position/P&L view on the page.

Add a new page that supports N legs via dropdown-based leg selection and preset strategies
(reusing Baskets' template/order infrastructure), styled to match FocusTool's visual shell,
with a live (browser-polled) P&L view after placement — but without FocusTool's
highest-complexity machinery (server worker, automated SL/target, atomic strike-roll).

## Scope

- **In scope**: a new page with category-tabbed preset strategies (reusing
  `STRATEGY_CATEGORIES`/`StrategyCardGrid`), a free-form N-leg editor (dropdowns for
  side/option, strike picker, lots), multi-broker order placement (reusing
  `basketOrders.ts`), and a post-placement live P&L view per leg + basket total, with
  manual per-leg and whole-basket exit. Basket state persists across page refresh via a
  JSON file, mirroring `focus-tool/rows/route.ts`'s pattern.
- **Out of scope**: automated SL/target triggers, a server-side worker process,
  shutdown-trigger wiring, atomic strike-roll/shift, saved/custom user presets (built-in
  templates only), and any change to `FocusTool.tsx` or `Baskets.tsx` themselves.

## Architecture

New page, new component, built around a new N-leg data model — not a fork of
`FocusTool.tsx`. Reuses `Baskets`' preset and order-placement lib code unchanged, and
reuses the broker-position-matching helpers (`positionProduct()`/`findLivePosition()`)
already used by Scalper/FocusTool for the live-monitor poll.

### Page & navigation
- `rs_dashboard/app/multi-leg-focus/page.tsx` — thin wrapper, same pattern as
  `app/focus-tool/page.tsx`, rendering `<MultiLegFocus />`.
- `rs_dashboard/components/MultiLegFocus.tsx` — the page component; renders `<NavBar />`
  itself.
- Add `{ href: '/multi-leg-focus', label: 'Multi-Leg Focus', desc: '...' }` to the
  "Derivatives" group in `NavBar.tsx`, alongside `/focus-tool` and `/baskets`.
- Visual shell (sticky header, dark-glass panels, control strip, table typography) matches
  `FocusTool.tsx`'s existing patterns — same zinc/token usage per `CLAUDE.md`'s theming
  rules, no new colors.

### Data model
New `lib/multiLegFocus.ts`:
```ts
export interface MultiLegLeg {
  id: string;
  side: 'B' | 'S';
  option: 'CE' | 'PE';
  strike: number;
  lots: number;
  type: 'MARKET' | 'LIMIT';
  price?: number;                 // manual override, empty = live LTP
  fill?: { qty: number; avgPrice: number };  // this basket's own fill ledger for this leg
  status: 'DRAFT' | 'PLACING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'FAILED';
}

export interface MultiLegBasket {
  id: string;
  underlying: string;
  expiry: string;
  broker: Broker;
  presetKey?: string;             // which STRATEGY_CATEGORIES template seeded this, if any
  legs: MultiLegLeg[];
  createdAt: string;
  updatedAt: string;
}
```
`fill` is this basket's own ledger, populated from order-ack response and reconciled
downward against the broker's live position for that leg's exact symbol/product — same
ownership principle as `FocusRowFill` (never size an exit off raw broker net quantity),
scoped per-basket since there is no second execution engine (no worker) to race against
within this page.

### Preset → legs flow
- Reuse `lib/basketStrategies.ts`'s `STRATEGY_CATEGORIES` and
  `components/basket/StrategyCardGrid.tsx` unchanged for category chips + preset cards.
- Selecting a template resolves each `TemplateLeg.offset` to a real strike against the
  current ATM (`nearestStrike`, same resolution `Baskets.tsx` already performs) and
  produces the initial `MultiLegLeg[]` for a new draft basket.
- Leg editor (new `components/MultiLegLegRow.tsx`, one row per leg): Side dropdown (B/S),
  Option dropdown (CE/PE), Strike dropdown (populated from the loaded option chain's
  strikes), Lots stepper, Order Type dropdown (MARKET/LIMIT) + price input when LIMIT.
  "Add Leg" appends a blank ATM leg; each leg has its own remove button. No hard leg-count
  cap; UI degrades gracefully past ~8 legs (horizontal scroll on the leg table, same as
  wide tables elsewhere in the dashboard).
- A ratio spread (e.g. 1x2 backspread) is expressed as two legs with different `lots` —
  no separate "ratio" concept needed, matching how `basketStrategies.ts` already encodes
  `Ratio Spreads` templates.

### Order placement
- Reuse `lib/basketOrders.ts`'s `sortLegsForPlacement` (BUY legs first) and
  `resolveOrderRequest` (broker-branching: Dhan by `securityId` via `/api/scalper/fast-order`,
  Zerodha/Kotak by trading symbol via `/api/scalper/<broker>/order`) unchanged.
- Sequential placement with the same stop-on-first-failure + best-effort auto-reverse of
  already-placed legs that `Baskets.tsx` already implements (`reverseReq`/auto-flatten
  block) — ported as-is, not reimplemented.
- On each leg's successful order ack, set that leg's `fill = { qty, avgPrice: ackPrice }`
  and `status: 'OPEN'`; a failed/unconfirmed leg is left `'FAILED'` and surfaced via toast,
  matching Baskets' existing messaging ("check Orders/Positions manually").

### Live monitoring (browser-only, no worker)
- After a basket has at least one `'OPEN'` leg, poll broker positions on the same interval
  cadence FocusTool uses today, matched per leg by `(symbol, product)` via the existing
  `positionProduct()`/`findLivePosition()` helpers (`lib/positionProduct.ts`) — reused, not
  reimplemented, per the `dhan-broker-positions` invariant.
- Display per-leg LTP, P&L, and a basket-total P&L tile. Reconcile each leg's `fill.qty`
  strictly downward against the matched broker position (never upward) — same rule as
  `FocusRowFill`, adapted per-leg.
- "Exit Leg" button places a single reduce order for that leg (product resolved from the
  matched broker position via `closeOrderProduct()`, not defaulted to intraday).
- "Exit Basket" button closes every open leg, BUY-first sort reused from
  `sortLegsForPlacement` (i.e. exit SELL legs — which are risk-reducing buys — before
  BUY legs, mirroring the entry ordering's margin-friendly intent).
- No automated SL/target evaluation, no shutdown-trigger file, no server-side worker, no
  atomic strike-roll — a basket that needs a strike changed is closed and re-opened
  manually as a new basket.

### Persistence
- New `debug/multi_leg_baskets.json`: `{ baskets: MultiLegBasket[] }`.
- New `app/api/multi-leg-focus/baskets/route.ts` — GET (read all), POST (upsert one
  basket, full-basket or single-leg patch), DELETE (remove one basket) — mirroring
  `app/api/focus-tool/rows/route.ts`'s last-write-wins pattern (single-user local tool,
  same rationale: rejecting a save on optimistic-concurrency grounds discards a real user
  action more often than it prevents a real collision).
- On page mount, GET restores any open baskets so a refresh doesn't lose track of legs
  already placed; polling resumes for any basket with an `'OPEN'` leg.

## Error handling / edge cases

- Strikes/chain not yet loaded when applying a template or adding a leg: toast error,
  no-op (matches Baskets).
- LIMIT leg with no resolvable price: block placement with a toast identifying the leg
  (matches Baskets).
- A leg's order comes back ambiguous/timeout: treat as `'FAILED'`, halt remaining legs in
  that basket, auto-reverse already-placed legs best-effort, surface a toast — ported
  from Baskets' existing behavior verbatim.
- Broker token expired mid-session: the relevant lookup/order/position call fails and
  surfaces as a toast, no special-case handling (matches every other broker-aware page).
- Exit called on a leg whose broker position can't be matched (already closed elsewhere,
  or never actually filled despite an `'OPEN'` local status): block the exit with a toast
  rather than sending a reduce order with guessed quantity — never fall back to the local
  ledger's `fill.qty` for the exit size once the broker match has failed.
- Two different baskets independently resolving to the same strike (e.g. two iron condors
  sharing a wing) is a real but pre-existing risk class Baskets already carries — this
  page inherits it, not a regression. Each basket's own ledger governs its own exits
  regardless of what the broker's net position at that strike shows.

## Testing

- Manual, Dhan authenticated at minimum: apply each preset category (including a
  3-leg Lizard and a 4-leg Iron Condor/Butterfly) and confirm legs populate at the
  expected ATM-relative strikes; add/remove legs freely on a draft basket before placing.
- Place a basket, confirm each leg's status moves to `'OPEN'` with a matched broker
  position and correct P&L; refresh the page and confirm the basket and its live P&L
  reappear.
- Exit a single leg, confirm only that leg closes and the basket's remaining legs and
  their P&L are unaffected; then Exit Basket and confirm all remaining legs close in the
  SELL-first order.
- Deliberately fail one leg (e.g. invalid LIMIT price) mid-placement and confirm the
  already-placed legs are auto-reversed and the basket is left in a clearly-surfaced
  failed state, not partially open with no indication.
- Repeat the placement + monitor + exit flow on Zerodha and Kotak to confirm the
  broker-branching in `resolveOrderRequest`/position-matching holds for non-Dhan brokers.
