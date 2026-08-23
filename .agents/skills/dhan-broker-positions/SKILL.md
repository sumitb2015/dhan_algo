---
name: dhan-broker-positions
description: Use when working on the Scalper / Advanced Scalper order tickets, reading a broker positions or trade-book payload, computing position P&L or CE/PE values, sizing an exit, or placing a close/square-off order. Covers Dhan, Zerodha and Kotak. Read before touching Scalper.tsx, AdvancedScalper.tsx, positionLegs.ts, or any /api/scalper, /api/exit-all or quiktrade route.
---

# Dhan Broker Positions & P&L

## Overview
The two scalper terminals and the analytics pages are the only surfaces in this repo
that place real orders and report real money. They are also the most-churned files in
the tree (32 commits across `Scalper.tsx` + `AdvancedScalper.tsx`), and nearly every
fix was the same shape: a broker payload does not mean what its field name says, and
the component hand-rolled the math instead of using the shared helper.

**The rule that prevents most of these: do not compute position identity, lot
multipliers, or close-order product inline. Every one of them already has a helper.**

## When to Use
- Any change to `components/Scalper.tsx`, `components/AdvancedScalper.tsx`, or the
  positions/payoff/analytics surfaces built on `lib/positionLegs.ts`.
- Adding a broker, or extending an existing one to a new segment (MCX, BSE F&O).
- Any route under `app/api/scalper/`, `app/api/exit-all/`, `app/api/options/quiktrade/`.
- Reviewing a P&L number that "looks off by a round factor" — that is almost always
  the MCX multiplier below.

## Use These, Don't Reimplement

| Concern | Helper |
|---|---|
| Lot/contract multiplier, broker P&L rescale | `lib/positionPnl.ts` - `contractMultiplier()`, `scaleBrokerPnl()`, `MCX_LOT_MULTIPLIER` |
| Position identity, live match, close product | `lib/positionProduct.ts` - `positionProduct()`, `positionKey()`, `findLivePosition()`, `closeOrderProduct()` |
| Positions to option legs for payoff/greeks | `lib/positionLegs.ts` |
| Broker payload normalisation | `lib/kotakShape.ts`, `lib/zerodhaShape.ts` |
| Real (not order-quantity) lot size | `lib/lotSize.ts` - `resolveLotSize()` |
| Per-broker endpoint routing | `hooks/useBrokerSelector.ts` - `scalperRoute()`, `brokerRoute()` |
| Partial square-off quantities | `lib/partialQty.ts` |

`brokerRoute()` takes a **map**, never a positional pair — a positional call once
silently routed a third broker to Dhan's endpoint, i.e. traded the wrong account.

## The Invariants

### 1. MCX quantity is in lots — and so is MCX P&L
Dhan reports MCX position quantity in lots rather than underlying units (unlike
NSE/BSE F&O), and it omits the barrels-per-lot multiplier from `unrealizedProfit`
too. A short CRUDEOIL option at 175.55 marked at 173.50 came back as a P&L of
`2.05` on a ~200-rupee move.

Apply `scaleBrokerPnl()` as the row **enters** the pipeline — specifically ahead of
any LTP back-calculation from `unrealizedProfit`, which otherwise lands the LTP a
hundredth of the way back from entry. It is a no-op for non-MCX rows, so apply it
unconditionally. Everything downstream (row/total P&L, CE/PE values, MTM chart,
P&L Guard rupee thresholds) then inherits the fix. (`f68d8bc`, `bfc8e2a`)

Same trap on the analytics side: any rupee figure built from `qtyLots` — premium,
exposure, margin sizing, greeks — needs `contractMultiplier()`. And the *fetched*
lot size is the order-quantity lot size; override it with the real one for margin
sizing and "Lot N" display.

### 2. Position identity is `(symbol, product)`, not symbol
A broker books per symbol **and** product. The same strike held as both INTRADAY and
MARGIN is two rows; matching on trading symbol alone resolved to whichever was listed
first, so one book got closed twice and the other never.

Worse, a close order that omits the product defaults to intraday at the order route —
so closing a MARGIN/NRML leg does not reduce it, it opens a **fresh intraday position
on the other side**, doubling exposure and margin at the exact moment the user asked
to cut risk. Use `positionKey()` for identity, `findLivePosition()` to match, and
`closeOrderProduct()` to pick the product to send. (`0f86cc9`)

### 3. Kotak positions carry no LTP — never fall back to the strike
Kotak's positions payload has only the `cf*`/`fl*` quantity+amount legs, `stkPrc`,
`lotSz` and `expDt`. `stkPrc` is the **strike**: falling back to it marked a Rs 4.40
option at 24300 and reported lakhs of phantom P&L — and that field feeds the
target/SL and P&L guards, so it was not cosmetic.

Resolve LTP only from real `ltp`/`lastPrice` keys, leave it `0` when unknown, and
join live quotes onto the row by `trdSym` off the shared Dhan feed (an option LTP is
exchange-set, not broker-set). (`c6ffb22`)

Related Kotak quirks live in `lib/kotak/` on the Python side: auth failures and empty
books arrive as 200 OK (`stCode 5203`), net quantity must be computed from the four
`cf*`/`fl*` legs, strikes are x100 scaled in the scrip master, and MCX `qt` is
absolute (100 per CRUDEOIL lot) where Dhan's is in lots — a 100x difference.

### 4. Never derive realized as total-minus-unrealized
That folds the entire open leg into realized whenever LTP is unknown. Realized is the
matched round-tripped quantity only. (`c6ffb22`)

### 5. Net long against short per side, and only over F&O rows
CE/PE Val summed gross `abs(qty * ltp)` regardless of direction, so a long hedge leg
inflated its side instead of offsetting the shorts on it. The CE/PE symbol-suffix
fallback also ran on non-F&O rows, classifying RELIANCE as a PE leg. Gate side
detection on segment, not on the symbol suffix. (`7188f64`)

### 6. Scope bulk exits
`/api/exit-all` defaults to an unconditional `DELETE /v2/positions`, which liquidates
equity holdings alongside F&O. The terminals must send `scope:'fno'`, which closes
only NSE_FNO/BSE_FNO positions and cancels only F&O orders via per-position REST
calls. Only the strategies-plus portfolio page keeps the full nuclear exit. (`31d907e`)

## Python Side
The same class of bug exists for strategies: Dhan nets every position by security ID,
so two strategy instances short of the same strike share ONE broker position. Sizing
an exit off `helper.get_net_quantity()` lets whichever exits first flatten the other's
leg. Use `lib/strategy_risk.py`'s `resolve_exit_qty(helper, security_id, own_qty, side)`.

## Before You Ship
- Did any new rupee figure skip `scaleBrokerPnl()` / `contractMultiplier()`?
- Does every close/exit order carry a product resolved from the position?
- Is the change broker-agnostic? Dhan is the only broker with a numeric `securityId`;
  everything else joins by trading symbol, so branch on `broker !== 'dhan'` rather
  than on a specific broker name.
- `lib/positionProduct.test.ts`, `positionLegs.test.ts`, `partialQty.test.ts` and
  `brokerRoute.test.ts` exist — run `npm test` in `rs_dashboard/`.
