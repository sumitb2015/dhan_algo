# Crude Oil Positions/Orders/Trades Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only section below the crude oil option chain on `/options/crudeoil` showing live crude oil / crude oil mini positions, order book, and trade book, filtered from the account's full Dhan data.

**Architecture:** A new Python script (`get_crudeoil_trades_data.py`) calls existing `DhanHelper` methods (`get_positions`, `get_order_list`, `get_trade_book`), filters to `tradingSymbol` containing `"CRUDEOIL"`, and prints one JSON line. A new Next.js API route spawns that script (same `execFile` pattern as `portfolio-holdings/route.ts`). The `CrudeOilOptions.tsx` component polls that route every 15s (independent of the chain's own poll) and renders three tables.

**Tech Stack:** Python 3 (`lib/dhan_helper.py`, `login.py`), Next.js App Router API routes (`execFile` + `child_process`), React/TypeScript client component (existing Tailwind dark-theme conventions).

## Global Constraints

- Filter rule: a row belongs in this section iff `str(tradingSymbol).upper()` contains `"CRUDEOIL"` (covers both `CRUDEOIL` and `CRUDEOILM` since mini symbols are prefixed `CRUDEOILM`).
- Section is **read-only** — no exit/cancel action buttons.
- Poll interval: reuse the existing `POLL_MS = 15_000` constant in `CrudeOilOptions.tsx`; the new poll loop must be a separate `useEffect`/`setInterval` so a slow/failed trades fetch never blocks or delays the option chain's own poll.
- Trades-fetch errors must render inline within the new section only — never write into the page-level `error` state used by the option chain banner.
- Each of the three SDK calls (`get_positions`, `get_order_list`, `get_trade_book`) must be wrapped in its own `try/except` in the Python script so one failing call doesn't blank the whole response (mirrors `get_holdings_data.py`).
- No automated test suite exists for this class of thin data-dump script/route (confirmed: `get_holdings_data.py` / `portfolio-holdings/route.ts` have none) — verification is manual execution + inspection, consistent with existing project convention.

---

### Task 1: Python data script — `scripts/tools/get_crudeoil_trades_data.py`

**Files:**
- Create: `scripts/tools/get_crudeoil_trades_data.py`

**Interfaces:**
- Consumes: `login.get_dhan_client()`, `lib.dhan_helper.DhanHelper` — specifically `helper.get_positions() -> pd.DataFrame`, `helper.get_order_list() -> List[Dict]`, `helper.get_trade_book() -> List[Dict]` (all already implemented in `lib/dhan_helper.py`, no changes needed there).
- Produces: stdout JSON line `{"success": true, "positions": [...], "orders": [...], "trades": [...]}` or `{"success": false, "error": "..."}`. This is what Task 2's API route parses.

- [ ] **Step 1: Write the script**

```python
"""
Outputs a JSON snapshot of crude oil / crude oil mini (MCX) positions,
order book, and trade book for the CrudeOilOptions dashboard section.
Called by the Next.js /api/crudeoil-trades route.
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper


def is_crude(symbol: str) -> bool:
    return "CRUDEOIL" in str(symbol).upper()


def main():
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"success": False, "error": "Failed to authenticate with Dhan"}))
        sys.exit(1)

    helper = DhanHelper(dhan)

    # --- Positions ---
    positions_list = []
    try:
        df_positions = helper.get_positions()
        if not df_positions.empty:
            for _, row in df_positions.iterrows():
                symbol = str(row.get('tradingSymbol', ''))
                if not is_crude(symbol):
                    continue
                ltp = float(row.get('lastPrice', 0) or row.get('lastTradedPrice', 0) or 0)
                positions_list.append({
                    "symbol": symbol,
                    "positionType": str(row.get('positionType', '')),
                    "netQty": int(row.get('netQty', 0) or 0),
                    "buyAvg": float(row.get('buyAvg', 0) or 0),
                    "sellAvg": float(row.get('sellAvg', 0) or 0),
                    "lastPrice": ltp,
                    "realizedProfit": float(row.get('realizedProfit', 0) or 0),
                    "unrealizedProfit": float(row.get('unrealizedProfit', 0) or 0),
                })
    except Exception:
        pass

    # --- Order Book ---
    orders_list = []
    try:
        for o in helper.get_order_list():
            symbol = str(o.get('tradingSymbol', ''))
            if not is_crude(symbol):
                continue
            orders_list.append({
                "orderId": str(o.get('orderId', '')),
                "symbol": symbol,
                "exchange": str(o.get('exchangeSegment', '')),
                "orderType": str(o.get('orderType', '')),
                "transactionType": str(o.get('transactionType', '')),
                "productType": str(o.get('productType', '')),
                "quantity": int(o.get('quantity', 0) or 0),
                "filledQty": int(o.get('filledQty', 0) or 0),
                "price": float(o.get('price', 0) or 0),
                "triggerPrice": float(o.get('triggerPrice', 0) or 0),
                "tradedPrice": float(o.get('tradedPrice', 0) or 0),
                "status": str(o.get('orderStatus', '')),
                "validity": str(o.get('validity', '')),
                "createTime": str(o.get('createTime', '')),
                "updateTime": str(o.get('updateTime', '')),
            })
    except Exception:
        pass

    # --- Trade Book ---
    trades_list = []
    try:
        for t in helper.get_trade_book():
            symbol = str(t.get('tradingSymbol', ''))
            if not is_crude(symbol):
                continue
            trades_list.append({
                "orderId": str(t.get('orderId', '')),
                "symbol": symbol,
                "exchange": str(t.get('exchangeSegment', '')),
                "transactionType": str(t.get('transactionType', '')),
                "productType": str(t.get('productType', '')),
                "tradedQuantity": int(t.get('tradedQuantity', 0) or 0),
                "tradedPrice": float(t.get('tradedPrice', 0) or 0),
                "tradeId": str(t.get('exchangeTradeId', '') or t.get('tradeId', '')),
                "createTime": str(t.get('createTime', '')),
                "exchangeTime": str(t.get('exchangeTime', '')),
            })
    except Exception:
        pass

    print(json.dumps({
        "success": True,
        "positions": positions_list,
        "orders": orders_list,
        "trades": trades_list,
    }))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run it directly to verify output shape**

Run: `venv\Scripts\python.exe scripts/tools/get_crudeoil_trades_data.py`
Expected: A single line of valid JSON on stdout with keys `success`, `positions`, `orders`, `trades`. If the access token is stale, run `venv\Scripts\python.exe login.py` first (per `CLAUDE.md`). If there is no crude oil activity in the account right now, `positions`/`orders`/`trades` should be empty arrays (not an error) — confirm `success: true` with empty arrays rather than a crash.

- [ ] **Step 3: Commit**

```bash
git add scripts/tools/get_crudeoil_trades_data.py
git commit -m "feat(crudeoil): add script to fetch filtered crude oil positions/orders/trades"
```

---

### Task 2: API route — `rs_dashboard/app/api/crudeoil-trades/route.ts`

**Files:**
- Create: `rs_dashboard/app/api/crudeoil-trades/route.ts`

**Interfaces:**
- Consumes: `scripts/tools/get_crudeoil_trades_data.py` (Task 1) via `execFile`, following the exact pattern of `rs_dashboard/app/api/portfolio-holdings/route.ts`.
- Produces: `GET /api/crudeoil-trades` → JSON body `{ success: boolean, positions: [...], orders: [...], trades: [...] }` (success path) or `{ success: false, error: string, detail?: string }` (failure path). This is what Task 3's frontend fetch call consumes.

- [ ] **Step 1: Write the route**

```ts
import { NextResponse } from 'next/server';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PYTHON_EXE = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'get_crudeoil_trades_data.py');

export async function GET() {
  try {
    const { stdout } = await execFileAsync(PYTHON_EXE, [SCRIPT], {
      cwd: PROJECT_ROOT,
      timeout: 25000,
      windowsHide: true,
    });

    const lines = stdout.trim().split('\n').filter(Boolean);
    const jsonLine = lines[lines.length - 1];
    const data = JSON.parse(jsonLine);

    return NextResponse.json(data);
  } catch (err: any) {
    if (err.stdout) {
      try {
        const lines = String(err.stdout).trim().split('\n').filter(Boolean);
        const data = JSON.parse(lines[lines.length - 1]);
        return NextResponse.json(data);
      } catch {}
    }
    console.error('Crude oil trades API error:', err.message, err.stderr ?? '');
    return NextResponse.json(
      { success: false, error: 'Failed to fetch crude oil trades data', detail: String(err.message) },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Start the dev server and curl the route**

Run: `cd rs_dashboard && npm run dev` (leave running), then in another terminal: `curl http://localhost:3000/api/crudeoil-trades`
Expected: JSON response with `success: true` and `positions`/`orders`/`trades` arrays (same shape verified in Task 1 Step 2).

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/app/api/crudeoil-trades/route.ts
git commit -m "feat(crudeoil): add /api/crudeoil-trades route"
```

---

### Task 3: Frontend section — `rs_dashboard/components/CrudeOilOptions.tsx`

**Files:**
- Modify: `rs_dashboard/components/CrudeOilOptions.tsx`

**Interfaces:**
- Consumes: `GET /api/crudeoil-trades` (Task 2) → `{ success: boolean, positions: CrudePosition[], orders: CrudeOrder[], trades: CrudeTrade[], error?: string }`.
- Produces: nothing consumed elsewhere — this is the final UI.

- [ ] **Step 1: Add response types near the top type block (after `ProcessedRow`, around line 31)**

```ts
interface CrudePosition {
  symbol: string;
  positionType: string;
  netQty: number;
  buyAvg: number;
  sellAvg: number;
  lastPrice: number;
  realizedProfit: number;
  unrealizedProfit: number;
}

interface CrudeOrder {
  orderId: string;
  symbol: string;
  exchange: string;
  orderType: string;
  transactionType: string;
  productType: string;
  quantity: number;
  filledQty: number;
  price: number;
  triggerPrice: number;
  tradedPrice: number;
  status: string;
  validity: string;
  createTime: string;
  updateTime: string;
}

interface CrudeTrade {
  orderId: string;
  symbol: string;
  exchange: string;
  transactionType: string;
  productType: string;
  tradedQuantity: number;
  tradedPrice: number;
  tradeId: string;
  createTime: string;
  exchangeTime: string;
}
```

- [ ] **Step 2: Add an order-status color helper next to `pctColor`/`pctSign` (around line 71)**

```ts
function statusColor(status: string): string {
  const s = status.toUpperCase();
  if (s.includes('TRADED') || s.includes('EXECUTED') || s.includes('COMPLETE')) return 'text-emerald-400';
  if (s.includes('REJECT') || s.includes('CANCEL')) return 'text-red-400';
  if (s.includes('PENDING') || s.includes('OPEN') || s.includes('TRANSIT')) return 'text-amber-400';
  return 'text-zinc-400';
}
```

- [ ] **Step 3: Add state for the new section, inside the component body (after the existing `ordering` state, around line 159)**

```ts
  const [crudePositions, setCrudePositions] = useState<CrudePosition[]>([]);
  const [crudeOrders, setCrudeOrders]       = useState<CrudeOrder[]>([]);
  const [crudeTrades, setCrudeTrades]       = useState<CrudeTrade[]>([]);
  const [tradesError, setTradesError]       = useState<string | null>(null);
  const [tradesLoading, setTradesLoading]   = useState(true);
  const tradesIntervalRef = useRef<NodeJS.Timeout | null>(null);
```

- [ ] **Step 4: Add the fetch + independent poll loop (place after the existing chain-polling `useEffect`, i.e. after the block ending at line 352)**

```ts
  // Fetch crude oil positions/orders/trades (independent poll loop)
  const fetchCrudeTrades = useCallback(async () => {
    try {
      const res = await fetch('/api/crudeoil-trades');
      const json = await res.json() as {
        success: boolean;
        positions?: CrudePosition[];
        orders?: CrudeOrder[];
        trades?: CrudeTrade[];
        error?: string;
      };
      if (json.success) {
        setCrudePositions(json.positions ?? []);
        setCrudeOrders(json.orders ?? []);
        setCrudeTrades(json.trades ?? []);
        setTradesError(null);
      } else {
        setTradesError(json.error ?? 'Failed to load crude oil trades data');
      }
    } catch (err) {
      setTradesError(String(err));
    } finally {
      setTradesLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchCrudeTrades();
    tradesIntervalRef.current = setInterval(fetchCrudeTrades, POLL_MS);
    return () => { if (tradesIntervalRef.current) clearInterval(tradesIntervalRef.current); };
  }, [fetchCrudeTrades]);
```

- [ ] **Step 5: Render the new section — insert immediately after the option chain table's closing `</div>` and before `</main>` (currently lines 672–674)**

```tsx
        {/* Crude Oil Positions / Orders / Trades */}
        <div className="space-y-4">
          <h2 className="text-sm font-bold text-zinc-300 uppercase tracking-wider">Crude Oil Activity</h2>

          {tradesError && (
            <div className="flex items-center gap-2 text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-sm">
              <AlertCircle className="h-5 w-5 shrink-0" />
              <span>{tradesError}</span>
            </div>
          )}

          {/* Positions */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className={thCls}>Symbol</th>
                  <th className={thCls}>Type</th>
                  <th className={thCls}>Net Qty</th>
                  <th className={thCls}>Buy Avg</th>
                  <th className={thCls}>Sell Avg</th>
                  <th className={thCls}>LTP</th>
                  <th className={thCls}>Realized</th>
                  <th className={thCls}>Unrealized</th>
                </tr>
              </thead>
              <tbody>
                {tradesLoading ? (
                  <tr><td colSpan={8} className="px-4 py-4 text-center text-zinc-500">Loading…</td></tr>
                ) : crudePositions.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-4 text-center text-zinc-500">No open positions</td></tr>
                ) : (
                  crudePositions.map((p, i) => (
                    <tr key={`${p.symbol}-${i}`} className="border-t border-zinc-800">
                      <td className="px-3 py-2 text-zinc-200 font-semibold">{p.symbol}</td>
                      <td className="px-3 py-2 text-zinc-400">{p.positionType}</td>
                      <td className="px-3 py-2 tabular-nums text-zinc-200">{p.netQty}</td>
                      <td className="px-3 py-2 tabular-nums text-zinc-400">{fmtLTP(p.buyAvg)}</td>
                      <td className="px-3 py-2 tabular-nums text-zinc-400">{fmtLTP(p.sellAvg)}</td>
                      <td className="px-3 py-2 tabular-nums text-zinc-200">{fmtLTP(p.lastPrice)}</td>
                      <td className={`px-3 py-2 tabular-nums font-semibold ${pctColor(p.realizedProfit)}`}>{fmtLTP(p.realizedProfit)}</td>
                      <td className={`px-3 py-2 tabular-nums font-semibold ${pctColor(p.unrealizedProfit)}`}>{fmtLTP(p.unrealizedProfit)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Orders */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className={thCls}>Order ID</th>
                  <th className={thCls}>Symbol</th>
                  <th className={thCls}>Side</th>
                  <th className={thCls}>Product</th>
                  <th className={thCls}>Qty</th>
                  <th className={thCls}>Filled</th>
                  <th className={thCls}>Price</th>
                  <th className={thCls}>Status</th>
                  <th className={thCls}>Time</th>
                </tr>
              </thead>
              <tbody>
                {tradesLoading ? (
                  <tr><td colSpan={9} className="px-4 py-4 text-center text-zinc-500">Loading…</td></tr>
                ) : crudeOrders.length === 0 ? (
                  <tr><td colSpan={9} className="px-4 py-4 text-center text-zinc-500">No orders today</td></tr>
                ) : (
                  crudeOrders.map((o) => (
                    <tr key={o.orderId} className="border-t border-zinc-800">
                      <td className="px-3 py-2 text-zinc-400">{o.orderId}</td>
                      <td className="px-3 py-2 text-zinc-200 font-semibold">{o.symbol}</td>
                      <td className={`px-3 py-2 font-bold ${o.transactionType === 'SELL' ? 'text-red-400' : 'text-emerald-400'}`}>{o.transactionType}</td>
                      <td className="px-3 py-2 text-zinc-400">{o.productType}</td>
                      <td className="px-3 py-2 tabular-nums text-zinc-200">{o.quantity}</td>
                      <td className="px-3 py-2 tabular-nums text-zinc-400">{o.filledQty}</td>
                      <td className="px-3 py-2 tabular-nums text-zinc-200">{fmtLTP(o.price)}</td>
                      <td className={`px-3 py-2 font-semibold ${statusColor(o.status)}`}>{o.status}</td>
                      <td className="px-3 py-2 text-zinc-500">{o.updateTime || o.createTime}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Trades */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className={thCls}>Order ID</th>
                  <th className={thCls}>Symbol</th>
                  <th className={thCls}>Side</th>
                  <th className={thCls}>Qty</th>
                  <th className={thCls}>Price</th>
                  <th className={thCls}>Exchange Time</th>
                </tr>
              </thead>
              <tbody>
                {tradesLoading ? (
                  <tr><td colSpan={6} className="px-4 py-4 text-center text-zinc-500">Loading…</td></tr>
                ) : crudeTrades.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-4 text-center text-zinc-500">No trades today</td></tr>
                ) : (
                  crudeTrades.map((t, i) => (
                    <tr key={`${t.orderId}-${i}`} className="border-t border-zinc-800">
                      <td className="px-3 py-2 text-zinc-400">{t.orderId}</td>
                      <td className="px-3 py-2 text-zinc-200 font-semibold">{t.symbol}</td>
                      <td className={`px-3 py-2 font-bold ${t.transactionType === 'SELL' ? 'text-red-400' : 'text-emerald-400'}`}>{t.transactionType}</td>
                      <td className="px-3 py-2 tabular-nums text-zinc-200">{t.tradedQuantity}</td>
                      <td className="px-3 py-2 tabular-nums text-zinc-200">{fmtLTP(t.tradedPrice)}</td>
                      <td className="px-3 py-2 text-zinc-500">{t.exchangeTime}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
```

- [ ] **Step 6: Type-check**

Run: `cd rs_dashboard && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Manual browser verification**

Run: `cd rs_dashboard && npm run dev`, open `http://localhost:3000/options/crudeoil`.
Expected: the new "Crude Oil Activity" section renders below the option chain with the three tables. With no current crude oil activity, all three show their empty-state row. Confirm no action buttons appear in the new tables, and that the option chain above continues to update on its own poll cycle independent of this section.

- [ ] **Step 8: Commit**

```bash
git add rs_dashboard/components/CrudeOilOptions.tsx
git commit -m "feat(crudeoil): add positions/orders/trades section to crude oil options page"
```

---

## Plan Verification Checklist

- [ ] Spec's filter rule (`tradingSymbol` contains `"CRUDEOIL"`, covering both full-size and mini) is implemented in Task 1.
- [ ] Spec's "read-only, no action buttons" requirement is satisfied — Task 3 renders no buttons in the new tables.
- [ ] Spec's "independent poll, isolated errors" requirement is satisfied — Task 3 uses a separate `useEffect`/`setInterval` and a dedicated `tradesError` state, never touching the page-level `error` state.
- [ ] Spec's empty-state requirement is satisfied for all three tables in Task 3 Step 5.
- [ ] Field mappings in Task 1 match `get_holdings_data.py`'s existing conventions verbatim (per spec).
