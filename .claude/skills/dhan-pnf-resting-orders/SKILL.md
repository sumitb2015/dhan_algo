---
name: dhan-pnf-resting-orders
description: Use when touching order placement from the Point & Figure page (/straddle-pnf) — the B / S rail's resting LIMIT / SL-limit orders, Bracket / Cover exits, the per-chart MTM guard, the open-position entry line, or their files (lib/pnfResting.ts, pnfRestingLedger.ts, pnfRestingServer.ts, pnfBracket.ts, pnfLadderPosition.ts, pnfOrderLogic.ts, pnfBooks.ts, components/straddlePnf/usePnfResting.ts, usePnfGuard.ts, usePnfPositions.ts, app/api/straddle-pnf/{order,resting}). Real-money. Covers the two venues (broker vs page), the ledger state machine, why an unknown outcome is never resent, OCO / mode-isolation rules from the review fixes, and the test map. Read dhan-terminal-position-ownership and dhan-price-ladder first.
---

# P&F resting orders, Bracket / Cover and MTM guard

Built on 2026-10-31 (commits `a99cb45d` … `a88ecef9`) as **XY-Price-Ladder parity** for the P&F charts. Reuses the ladder's rules instead of copying them: `classifyClick` / `stopLimitPrice` (`lib/priceLadder.ts`), `cleanGuard` / `evalGuard` / `carryRuntime` (`lib/priceLadderGuard.ts`), `MtmGuardCard`. Do the same for any new rule — import, do not fork.

## Two venues, chosen by chart + mode (`usePnfResting.place`)

| | venue | who watches it | fills |
|---|---|---|---|
| REAL, **single-leg** chart (future / one option / stock) | `broker` | the broker | followed in the broker order book every 3 s |
| PAPER (any chart) | `page` | leader tab, 1 s tick | `paperStep()` against the live price |
| REAL **straddle** level | `page` | leader tab | both legs sent at **MARKET** once the combined price reaches it, at most once |

A straddle has no single resting order at a broker, so a REAL straddle "order" is a *watched level*. Tell the user it needs the tab open. Index charts have no rail (cannot be traded).

## Click rule (`planResting`)

BUY below last price / SELL above = **LIMIT**; the other side = **SL-limit** (trigger at the clicked level, limit a `DEFAULT_BUFFER_PCT = 2 %` buffer past it via `stopLimitPrice`). Snap so the exchange accepts it and the order is never worse than asked: LIMIT BUY down / SELL up; SL trigger BUY **up** / SELL **down**. The old ±20 % distance limit was removed (`c4bee998`) — an order may rest at any distance; only the side rules and tick snapping remain.

## Ledger (`debug/pnf_resting_state.json`) — pure ops in, state out

`applyRestingOp(ledger, op)` under the route's file lock, atomic write, `rev` bumped. States: `sending → working | rejected | unknown`; `working → filled | cancelled | rejected | unknown`; page venue adds `firing` (REAL level reserved *before* its MARKET legs go out, so it fires at most once). **State never moves back.** `unknown` and a `sending`/`firing` older than `STALE_PENDING_S = 60` are settled **by the user** (`resolve` as filled/cancelled) — never auto-resent. A new IST day cancels every open row from an earlier day (`rollDay`): broker DAY orders have expired and a page level must not fill on a new session.

**No cap on working orders per chart** (a `MAX_WORKING_PER_CHART = 10` refusal, "Chart 1 already has 10 working orders", was removed on request). The file keeps at most 500 rows (`trimRows`), and only *finished* rows are ever trimmed — never a working / sending / firing / unknown one. The per-order lot cap (`lotCap`: 20 lots, 10,000 shares) and the one-order-on-the-wire busy lock stay.

Invariants that came out of the review (`a99cb45d`, `37f7c6e4`):
- **Reserve, then send.** `create` (state `sending`) happens before the HTTP order; a tab that dies mid-send leaves a row, not a lost or duplicated order.
- **A throw / no clean reply = UNKNOWN, never failure** (`postOrder` returns `null`). Kotak refusals report `rejected`. Part-filled-then-cancelled books the filled lots (`fill` with `lots`).
- **Modify / cancel only act on orders the ledger owns for that chart** — the order route calls `ownedBrokerOrder(broker, targetKey, orderId)`; a foreign broker order id is refused.
- One per-chart **busy lock** shared with MARKET orders (`__pnfOrderBusy` on `globalThis`, one order per broker + chart on the wire).
- **Leader-tab only** for the 1 s tick and the order-book poll (`leaderRef`); the tick is rebuilt each render and called through a ref from one stable interval.
- A held level never fills or fires on a **stale** feed (`c.stale`) or with no price (`c.price === null`). Nothing is faked.
- Unique ids (`newOrderId` adds a random suffix — two clicks in one millisecond, or a pinned test clock, repeated the time-only id). Zerodha modify stores the snapped price; Kotak MARKET orders keep no tick.
- A REAL fill from a level is only an **estimate** (the page knows the price it fired at, not the traded one): the event carries `estimate: true` until Positions shows the fill.

## Order label and + / - lots

A placed order's tag and its orders-bar chip read **`[P ]BUY SL @ 220.50 · 1L`** (`orderText`): the same words as the hover label (`BUY SL @ 220.50`), so the price an order was placed at stays on the chart. An SL-limit names its **trigger** (the clicked level); the limit it carries once triggered is in the tooltip. A bracket exit says `SL 1L @ …` / `TGT …` as before.

`−` / `+` on a working **entry** order change its lots, **in the ladder itself**: the order's pill in the rail is `[−] 1L [+] [×]` (`RAIL_SIDE_W = 96`, widget = `[−] 1L [+] [×]`; `data-testid` `pnf-rail-lots-down` / `-up` / `pnf-rail-cancel`). The **price the order is placed at** is the row's own price in the ladder's **PRICE column**, tinted in the order's colour (`pnf-rail-order-price` on that text; an SL-limit shows its trigger, a dragged order shows where it would land); it is drawn outside the pill's group, because the pill's bounding box is the drag handle (the e2e drag test aims at its centre). The open position (`pnf-rail-pnl`, at the entry row): `LONG|SHORT nL` in its side's column, its entry price in the PRICE column, `▲ ₹pnl` in the other column (`P&L —` when a leg has no price). A bracket exit's pill is `SL 1L [×]` / `TP 1L [×]` (no ±: it is sized from the position, `exitOwn`). The pill body still drags the order to another box; the buttons act on pointer-down and stop it starting a drag. The header's order chips are gone for working orders (a chip stays only for an order that needs settling: unknown / stale `sending`); the chart's line tag keeps `BUY SL @ 220.50 · 1L` and its ×.

## Bracket / Cover (`pnfBracket.ts`, `PnfOrderStyle.tsx`)

Style Single | Bracket | Cover with target / SL / optional Trail in **points of the chart's own price** (a straddle's combined premium). The *entry that fills* arms page-held exit rows from the **fill price** (`planBracketChildren`); an unfilled Bracket / Cover places nothing, and missing/zero SL (or target for Bracket) is refused with a message (`cleanBracketSpec` — nothing guessed). Rules fixed in review:
- **Planned exits are drawn at placement**: a working Bracket / Cover entry shows where its stop-loss and target will go, dimmed with a dashed outline in the exit side's column (`pnf-rail-planned`, from `RailOrder.planned`, computed in the page with `planBracketChildren` from the entry's price / trigger) — the real exit rows are created only at the fill, so without this the ladder shows nothing between placing the entry and its fill and it looks as if no stop / target was placed. They vanish at the fill (the real exits replace them). `armChildren` no longer returns silently when the chart's contract info is missing: it warns "exits not placed … OPEN WITHOUT exits".
- Exits are judged **against their own mode + broker**: a PAPER↔REAL flip never cancels the other side's stops (`first.mode !== mode || first.broker !== broker → continue`).
- **Only a CONFIRMED fill cancels the sibling** (`spent = rows.some(state === 'filled')`); an `unknown` exit must not strip the position of its other exit.
- A trail is **never tighter than the SL** (`Math.max(trailPts, slPts)`), only moves in the profit direction (`trailedStop`), and a Trail ticked with blank points is **refused**, not dropped (`a88ecef9`).
- A rail order that **reduces** the open position carries no bracket.
- A trade-bar REAL bracket anchors to the traded price, not the click.
- REAL exits are sized with **`exitOwn: { side, units }`** — what this page opened, clamped by the broker's own row (`planOwnExit`); REAL-only (`exitOwn` in PAPER is refused); outcome `flat` resolves the row as cancelled ("nothing left to close"). This is `dhan-terminal-position-ownership`'s exit-sizing rule — never size from the Lots box.
- A position that is gone cancels the group, but only after a grace (3 s PAPER, 20 s REAL, and only once `positionsLoaded`) so a slow positions read does not cancel live stops.
- Exits are **held by the page** (no broker-side stop); say so wherever they are offered.

## MTM guard (`usePnfGuard.ts`)

Per chart, `LadderGuard` rules (target, stop, trail, Protect profit), page-held, **starts OFF every load** (levels persisted in localStorage `straddle-pnf-guard-<chart>`, the switch is not). P&L is measured from switch-on: `base` = the chart's P&L then, or captured when the **first priced position** appears if switched on flat (earlier realised P&L must never trip it). A trip cancels the chart's resting orders + bracket exits and squares it off; while still holding it retries the exit every `RETRY_EXIT_S = 6`. Changing broker or mode switches every guard off and **warns** if a tripped guard was mid-exit. It only runs while the page is open — say so.

## Position line (`pnfLadderPosition.ts`)

One position per chart; a straddle counts only while both legs are open on the **same side** (else `MIXED`, no entry premium). PAPER reads the paper ledger; REAL reads the broker book every 5 s (broker buy/sell average of the open side). `pnl` is **null, not 0**, when an open leg has no price.

## Tests to run / extend

`node --test lib/pnfResting.test.ts lib/pnfRestingLedger.test.ts lib/pnfBracket.test.ts lib/pnfOrderLogic.test.ts lib/pnfLadderPosition.test.ts lib/pnfBooks.test.ts`, and `e2e/straddle-pnf-rail.spec.ts` (`E2E_PORT=3000`, never start a second `next dev`; mocks refuse any unhandled non-GET). The e2e file is the behaviour spec: PAPER limit/SL, REAL single leg via order book, REAL straddle level fired once, unknown outcome never resent, stale-feed level does not fire, bracket arms/OCO/needs SL, MTM guard from flat, mode-flip isolation, unknown-exit sibling. `8fb32e68` regression tests were verified by **reverting the fix and watching them fail** — do that for any new invariant. Never add a REAL "valid order" case that could reach a live token.

## When changing a rule

Update the pure module + its test first; then `usePnfResting`/`usePnfGuard`; then the e2e. Record the rejected alternative in the vault (`wiki/decisions/`), e.g. why straddle REAL levels are page-held MARKET pairs rather than broker orders.
