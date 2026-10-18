# TODO

## Dhan Conditional Trigger as a broker-side index backstop for open option legs

Status: researched 2026-10-18, not built. Real-money feature — nothing below is implemented.

### Why
Focus Tool, Triple Straddle, Multi-Leg Focus and the scalpers evaluate stops only in the open
browser tab / dashboard server. If the machine, tab or network dies, an open short leg has no
stop. A Dhan Conditional Trigger lives at Dhan and fires with nothing of ours running. It is a
**disaster backstop** (index level), not a replacement for the per-leg SL / target / trail rules.

### What was verified (2026-10-17/18)
- Docs (dhanhq.co/docs/v2/conditional-trigger + annexure): "Conditional Triggers are currently
  supported only for Equities and Indices"; `condition.exchangeSegment` is `NSE_EQ | BSE_EQ | IDX_I`.
- **Live probe**: a trigger whose `orders[]` is an `NSE_FNO` option BUY LIMIT (1 lot) was
  ACCEPTED and stored as sent (alert status `ACTIVE`), then cancelled cleanly. Probe script lived in
  the session scratchpad (`ct_probe.py`); recreate it from `lib/dhan_helper.py::place_conditional_trigger`.
  So: condition = index/equity, **order = F&O is accepted at creation**.
- Annexure enums:
  - `comparisonType`: `TECHNICAL_WITH_VALUE`, `TECHNICAL_WITH_INDICATOR`, `TECHNICAL_WITH_CLOSE`,
    **`PRICE_WITH_VALUE`** (market price vs fixed value; needs only `operator` + `comparingValue`).
  - `operator`: `CROSSING_UP`, `CROSSING_DOWN`, `CROSSING_ANY_SIDE`, `GREATER_THAN`, `LESS_THAN`,
    `GREATER_THAN_EQUAL`, `LESS_THAN_EQUAL`, `EQUAL`, `NOT_EQUAL`.
  - status: `ACTIVE`, `TRIGGERED`, `EXPIRED`, `CANCELLED`.
  - `timeFrame` (create page): `DATE`, `ONE_MIN`, `FIVE_MIN`, `FIFTEEN_MIN`, `DAY`.
  - order fields: `productType` CNC/INTRADAY/MARGIN/MTF; `orderType` LIMIT/MARKET/STOP_LOSS/STOP_LOSS_MARKET;
    `validity` DAY/IOC; `price`/`triggerPrice`/`discQuantity` are strings.
- Postbacks are available if a webhook URL is set when the token is generated.
- My earlier probe used `TECHNICAL_WITH_VALUE` + `SMA_5`, which compares the **average**, not the price —
  the backstop needs `PRICE_WITH_VALUE`.

### NOT verified — resolve these before any real use
1. `PRICE_WITH_VALUE` payload shape: does it need `indicatorName`/`timeFrame`? (docs say only operator +
   comparingValue; the create table marks timeframe required.) Probe with a far-away level, cancel at once.
2. **Fire-time behaviour**: does a fired trigger really place the F&O order (margin, freeze qty, market
   hours, MARKET vs LIMIT for exits)? Test once in market hours with a tiny far-OTM position, or a level
   that is about to cross. Check what status/postback appears if the order is rejected.
3. Evaluation frequency/latency for `PRICE_WITH_VALUE` (the docs give none), rate limits, max triggers
   per account, max `expDate`.
4. Whether `BUY`-to-close on an option SHORT with `productType` MARGIN/INTRADAY matches the leg's product
   (a mismatched product opens a new position instead of closing).
5. The 2 triggers already on the account (found 2026-10-18) are not from this work — review/cancel in the
   Dhan app.

### Design sketch (once 1-4 are settled)
- Pure module `rs_dashboard/lib/conditionalBackstop.ts` (+ `.test.ts`): builds the create/modify payload from a
  leg set + index level + direction (short straddle: one trigger up, one down; levels from entry spot ± a
  configured % or from the existing spot-breach rule). Exit orders are BUY of the SHORT legs only, MARKET if
  allowed else a marketable LIMIT; shorts exit first, hedges never in the trigger (see
  `dhan-terminal-position-ownership` Invariants 6/9/10).
- Server route `app/api/conditional-backstop/` (arm / disarm / list), real-money, reuse
  `lib/dhanToken.ts` + `dhanOrderLaneFile.ts`; qty = the row's OWN ledger qty, never the raw broker net
  (`resolve_exit_qty` rule). Hard caps like `scalper/fast-order`.
- Lifecycle ties to the leg ledger: **create on entry, cancel + recreate on strike roll / re-entry /
  partial exit / manual exit / Exit All, cancel on flat**. Persist `alertId`s in the row's ledger so a reload
  cannot orphan a live trigger. A trigger left behind after the legs close would OPEN a new position —
  this is the main danger; add a reconcile that cancels triggers whose legs no longer exist.
- UI: per-row "Backstop" chip in Focus Tool first (level, armed state, alertId, status poll), SIM rows never
  create one; REAL requires the existing LIVE REAL MONEY arm. Poll status with `dhan-polling-guards` rules.
- Copy trade: a fired trigger's fills reach Dhan's order WebSocket, so the copy-trade bridge will mirror
  them to children (and the exit clamp will size them). Decide explicitly whether that is wanted.
- Out of scope: stops on an option's own premium, P&L exits (use `/pnl-exit`), MCX, anything needing a
  condition on a derivative (unsupported by Dhan).

### Tests to add
- Payload builder unit tests (levels, direction, legs, product mapping, caps).
- Ledger-lifecycle tests: roll / re-entry / exit-all cancel and recreate; orphan-trigger reconcile.
- e2e: Playwright mock must refuse any non-GET it doesn't handle (existing rule); never add a "valid
  trigger" case against a live token.

### Decision gate
If item 2 (fire-time) fails or evaluation latency is unacceptable (tens of seconds), drop this and rely on
Super Order brackets (`/api/super-order`) for broker-side stops instead.
