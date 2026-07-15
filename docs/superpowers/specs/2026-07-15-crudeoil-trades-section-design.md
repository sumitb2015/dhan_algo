# Crude Oil Positions / Orders / Trades Section — Design Spec

**Date:** 2026-07-15
**Feature:** `/options/crudeoil` page — new read-only section below the option chain showing live crude oil / crude oil mini positions, order book, and trade book, filtered from Dhan's account-wide data.

---

## Context

The crude oil options chain page (`CrudeOilOptions.tsx`) lets a user place CE/PE orders, but has no visibility into what's actually happened as a result — open positions, today's orders, or today's fills — without switching to the `/portfolio` page (which shows the whole account, not just crude oil). This adds a dedicated, filtered view directly below the chain.

---

## Scope

Two new files + one modified file:

| File | Change |
|---|---|
| `scripts/tools/get_crudeoil_trades_data.py` | New Python script |
| `rs_dashboard/app/api/crudeoil-trades/route.ts` | New API route |
| `rs_dashboard/components/CrudeOilOptions.tsx` | New section appended after the option chain table |

---

## Python Script — `scripts/tools/get_crudeoil_trades_data.py`

Modeled on the existing `scripts/tools/get_holdings_data.py` pattern (`get_dhan_client()` → `DhanHelper(dhan)` → call SDK methods → filter → print one JSON line to stdout).

### Logic

1. `dhan = get_dhan_client(); helper = DhanHelper(dhan)`
2. `df_positions = helper.get_positions()`, `orders = helper.get_order_list()`, `trades = helper.get_trade_book()`
3. Filter each to rows where `tradingSymbol` (uppercased) contains `"CRUDEOIL"` — this naturally covers both `CRUDEOIL` (full-size) and `CRUDEOILM` (mini) since mini symbols are prefixed `CRUDEOILM`.
4. Map fields into the same flat shape `get_holdings_data.py` already uses for `positions_list`/`orders_list`/`trades_list` (symbol, exchange, qty, price, status, timestamps, etc.) — reuse those field mappings verbatim rather than inventing a new shape.
5. Print `{"success": true, "positions": [...], "orders": [...], "trades": [...]}` as the final stdout line. On auth failure, print `{"success": false, "error": "..."}`.

Wrap each of the three SDK calls in its own `try/except` (matching `get_holdings_data.py`'s per-section error isolation) so one failing call doesn't blank the whole response.

---

## API Route — `rs_dashboard/app/api/crudeoil-trades/route.ts`

Same shape as `portfolio-holdings/route.ts`:

```ts
const PYTHON_EXE = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'get_crudeoil_trades_data.py');

export async function GET() {
  // execFile(PYTHON_EXE, [SCRIPT], { cwd: PROJECT_ROOT, timeout: 25000, windowsHide: true })
  // parse last stdout line as JSON, return NextResponse.json(data)
  // same err.stdout fallback + 500 error path as portfolio-holdings/route.ts
}
```

---

## Frontend — `CrudeOilOptions.tsx`

### New section placement

Inserted inside `<main>`, immediately after the option chain table's closing `</div>` (currently line ~672), before `</main>`.

### State & polling

```ts
positions: CrudePosition[]
orders: CrudeOrder[]
trades: CrudeTrade[]
tradesError: string | null
tradesLoading: boolean
```

- Separate `useEffect` + `setInterval(POLL_MS)` (reuses the existing `POLL_MS = 15_000` constant) — fetches `/api/crudeoil-trades` independently of the chain's own poll loop, so a slow/failed trades fetch never blocks or delays chain rendering.
- Errors from this fetch set `tradesError` and render inline within the new section only — they must NOT populate the page-level `error` state/banner used by the option chain.

### Layout

Three stacked tables, matching the page's existing dark theme (`bg-zinc-900 border border-zinc-800 rounded-xl`, `thCls` header style):

```
┌─ Positions ────────────────────────────────────────────────────┐
│ Symbol │ Type │ Net Qty │ Buy Avg │ Sell Avg │ LTP │ Realized │ Unrealized │
└────────────────────────────────────────────────────────────────┘
┌─ Orders (today) ───────────────────────────────────────────────┐
│ Order ID │ Symbol │ Side │ Product │ Qty │ Filled │ Price │ Status │ Time │
└────────────────────────────────────────────────────────────────┘
┌─ Trades (today) ───────────────────────────────────────────────┐
│ Order ID │ Symbol │ Side │ Qty │ Price │ Exchange Time            │
└────────────────────────────────────────────────────────────────┘
```

- Each table shows an empty-state row ("No open positions" / "No orders today" / "No trades today") when its array is empty — the section must never collapse to nothing.
- Orders table: color the `status` cell (e.g. emerald for `TRADED`/`EXECUTED`, red for `REJECTED`/`CANCELLED`, amber for `PENDING`/`OPEN` — match whatever status strings Dhan actually returns, verified during implementation).
- Positions table: color `realizedProfit`/`unrealizedProfit` green/red by sign, same convention as `PortfolioDashboard.tsx`.
- **Read-only** — no action buttons (no exit/cancel), per user decision.

---

## Verification

1. Start the dashboard, open `/options/crudeoil`.
2. Confirm the new section renders below the chain with correct empty states when there's no crude oil activity.
3. With an open crude oil position or a recent crude oil order/trade, confirm it appears correctly and that non-crude-oil account activity (e.g. Nifty option positions) is excluded.
4. Confirm the new section's 15s poll runs independently — simulate a slow/erroring `/api/crudeoil-trades` response and confirm the option chain above continues to update normally.
5. Confirm no action buttons are present in the new tables.
