# Scalper Broker Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a broker selector (Dhan / Zerodha) to the Scalper and Advanced Scalper terminals so order entry, position close, Exit All, and the positions/orders/trades/funds panel all route to whichever broker is selected — only showing brokers with a currently valid session.

**Architecture:** Dhan's existing direct-REST fast paths (`/api/scalper/*`) are left untouched. A parallel set of Zerodha routes under `/api/scalper/zerodha/*` calls the official Kite Connect REST API directly from Node (no Python spawn), reshaping responses into the exact field names the existing UI tables already expect. A new `useBrokerSelector` hook + `brokerRoute()` helper let each existing fetch call site pick the right URL with a one-line change.

**Tech Stack:** Next.js 16 (App Router) API routes, TypeScript, Kite Connect REST API (`https://api.kite.trade`), Python 3 (`kiteconnect` package, already used by `lib/zerodha/`), Node.js built-in `node:test` for unit tests (Node v24 — no new devDependency needed).

## Global Constraints

- Dhan code paths (`/api/scalper/fast-order`, `/api/scalper/all`, `/api/scalper/poll`, `/api/scalper/funds`, `/api/scalper/positions`, `/api/exit-all`) must not be modified — only added alongside.
- Zerodha routes must not require the Historical Data API permission — only `orders`, `positions`, `margins`, `instruments` (already confirmed working under the current Kite Connect subscription).
- `rs_dashboard/package.json` has no test runner installed (confirmed: no jest/vitest/tsx in `devDependencies`). Node v24 runs `.ts` test files natively via `node --test file.test.ts` (verified working in this session) — use this for pure-function unit tests. Do not install a new test framework. API routes, the Python script, and UI wiring have no existing automated-test convention in this codebase (0 of ~48 existing routes have tests) — verify those manually via `curl`/browser per this plan's steps, matching the project's established convention (per `CLAUDE.md`: "For UI or frontend changes ... start the dev server and use the feature in a browser").
- Credentials: Zerodha API key lives in `.env.zerodha` (`ZERODHA_API_KEY`), session token in `zerodha_access_token.json` at the project root (both already present and working as of this session).
- Zerodha instrument/order fields use `tradingsymbol` (string), not Dhan's numeric `securityId` — every new Zerodha route must reshape Kite's snake_case response fields into the UI's existing camelCase field names (see Task 4 for the exact mapping).

---

### Task 1: Zerodha credentials/REST client + broker-status route

**Files:**
- Create: `rs_dashboard/lib/zerodhaToken.ts`
- Create: `rs_dashboard/lib/zerodhaToken.test.ts`
- Create: `rs_dashboard/app/api/auth/broker-status/route.ts`

**Interfaces:**
- Produces: `isTokenExpired(expiryTime: string | undefined): boolean`, `isZerodhaTokenValid(): boolean`, `getZerodhaCredentials(): { apiKey: string; accessToken: string }`, `kiteGet(apiPath: string, timeoutMs?: number): Promise<unknown>`, `kitePost(apiPath: string, params: Record<string, string | number>, timeoutMs?: number): Promise<unknown>` — all from `rs_dashboard/lib/zerodhaToken.ts`. All later tasks import from here for any Zerodha REST call.

- [ ] **Step 1: Write the failing test for the pure expiry-check helper**

Create `rs_dashboard/lib/zerodhaToken.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { isTokenExpired } from './zerodhaToken';

test('isTokenExpired: undefined expiry is treated as expired', () => {
  assert.strictEqual(isTokenExpired(undefined), true);
});

test('isTokenExpired: future date is not expired', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.strictEqual(isTokenExpired(future), false);
});

test('isTokenExpired: past date is expired', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.strictEqual(isTokenExpired(past), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rs_dashboard && node --test lib/zerodhaToken.test.ts`
Expected: FAIL — `zerodhaToken.ts` does not exist yet (`Cannot find module './zerodhaToken'`).

- [ ] **Step 3: Write `rs_dashboard/lib/zerodhaToken.ts`**

```ts
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const TOKEN_FILE = path.join(PROJECT_ROOT, 'zerodha_access_token.json');
const ENV_FILE = path.join(PROJECT_ROOT, '.env.zerodha');
const KITE_BASE = 'https://api.kite.trade';

interface ZerodhaTokenCache { apiKey: string; accessToken: string; ts: number }
let cache: ZerodhaTokenCache | null = null;
const TOKEN_TTL = 5 * 60 * 1000;

/** True if the given ISO expiry timestamp is missing or in the past. */
export function isTokenExpired(expiryTime: string | undefined): boolean {
  if (!expiryTime) return true;
  return new Date(expiryTime) < new Date();
}

/** True if zerodha_access_token.json holds a non-expired access token. */
export function isZerodhaTokenValid(): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as {
      accessToken?: string;
      expiryTime?: string;
    };
    if (!data.accessToken) return false;
    return !isTokenExpired(data.expiryTime);
  } catch {
    return false;
  }
}

function readApiKey(): string {
  if (!fs.existsSync(ENV_FILE)) return '';
  const content = fs.readFileSync(ENV_FILE, 'utf8');
  const match = content.match(/^ZERODHA_API_KEY\s*=\s*"?([^"\r\n]+)"?/m);
  return match ? match[1].trim() : '';
}

/**
 * Cached Zerodha credentials for direct REST calls from Node (no Python spawn).
 * Reads the api key from .env.zerodha and the access token from zerodha_access_token.json.
 */
export function getZerodhaCredentials(): { apiKey: string; accessToken: string } {
  if (cache && Date.now() - cache.ts < TOKEN_TTL) {
    return { apiKey: cache.apiKey, accessToken: cache.accessToken };
  }
  const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as { accessToken: string };
  const apiKey = readApiKey();
  cache = { apiKey, accessToken: raw.accessToken, ts: Date.now() };
  return { apiKey: cache.apiKey, accessToken: cache.accessToken };
}

function authHeaders(): Record<string, string> {
  const { apiKey, accessToken } = getZerodhaCredentials();
  return {
    Authorization: `token ${apiKey}:${accessToken}`,
    'X-Kite-Version': '3',
  };
}

/** Authenticated GET against the Kite Connect REST API. Returns the `data` payload. Throws on non-2xx. */
export async function kiteGet(apiPath: string, timeoutMs = 10_000): Promise<unknown> {
  const res = await fetch(`${KITE_BASE}${apiPath}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok || json.status === 'error') {
    throw new Error(String(json.message ?? `HTTP ${res.status}`));
  }
  return json.data;
}

/** Authenticated form-encoded POST against the Kite Connect REST API. Returns the `data` payload. Throws on non-2xx. */
export async function kitePost(
  apiPath: string,
  params: Record<string, string | number>,
  timeoutMs = 10_000,
): Promise<unknown> {
  const formBody = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  );
  const res = await fetch(`${KITE_BASE}${apiPath}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok || json.status === 'error') {
    throw new Error(String(json.message ?? `HTTP ${res.status}`));
  }
  return json.data;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd rs_dashboard && node --test lib/zerodhaToken.test.ts`
Expected: `pass 3`, `fail 0`.

- [ ] **Step 5: Create the broker-status route**

Create `rs_dashboard/app/api/auth/broker-status/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { isDhanTokenValid } from '@/lib/session';
import { isZerodhaTokenValid } from '@/lib/zerodhaToken';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    dhan: isDhanTokenValid(),
    zerodha: isZerodhaTokenValid(),
  });
}
```

- [ ] **Step 6: Manual verification**

Run: `cd rs_dashboard && npm run dev` (in one terminal), then in another:
`curl http://localhost:3000/api/auth/broker-status`
Expected: `{"dhan":true,"zerodha":true}` (both currently authenticated per this session's verification).

- [ ] **Step 7: Commit**

```bash
git add rs_dashboard/lib/zerodhaToken.ts rs_dashboard/lib/zerodhaToken.test.ts rs_dashboard/app/api/auth/broker-status/route.ts
git commit -m "feat: add Zerodha REST client and broker-status endpoint"
```

---

### Task 2: Zerodha instrument cache script

**Files:**
- Create: `scripts/tools/zerodha_instruments_cache.py`

**Interfaces:**
- Produces: `debug/zerodha_nifty_instruments.json` — a JSON array of `{tradingsymbol: string, instrument_token: number, strike: number, expiry: "YYYY-MM-DD", instrument_type: "CE"|"PE", lot_size: number}`. Task 3's lookup route reads this file.
- Consumes: `lib.zerodha.authentication.restore_kite_session()` (existing, from `lib/zerodha/authentication.py`).

- [ ] **Step 1: Write the script**

Create `scripts/tools/zerodha_instruments_cache.py`:

```python
"""
Fetches and caches Zerodha NFO NIFTY option instruments for the scalper's
strike -> tradingsymbol lookup (Zerodha has no numeric securityId like Dhan).

Usage:
    venv\\Scripts\\python.exe scripts/tools/zerodha_instruments_cache.py

Writes debug/zerodha_nifty_instruments.json. Prints a single JSON status
line to stdout; logs go to stderr.
"""
import sys
import os
import json

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from lib.zerodha import authentication, config

OUTPUT_FILE = os.path.join(ROOT, 'debug', 'zerodha_nifty_instruments.json')


def main():
    kite, access_token = authentication.restore_kite_session()
    if kite is None:
        print(json.dumps({'success': False, 'error': 'No Zerodha session — run zerodha_autologin.py first'}))
        sys.exit(0)
    config.kite = kite

    try:
        instruments = kite.instruments('NFO')
    except Exception as e:
        print(json.dumps({'success': False, 'error': f'instruments() failed: {e}'}))
        sys.exit(0)

    rows = []
    for inst in instruments:
        if inst.get('name') != 'NIFTY':
            continue
        if inst.get('instrument_type') not in ('CE', 'PE'):
            continue
        expiry = inst.get('expiry')
        rows.append({
            'tradingsymbol': inst['tradingsymbol'],
            'instrument_token': inst['instrument_token'],
            'strike': float(inst['strike']),
            'expiry': expiry.strftime('%Y-%m-%d') if hasattr(expiry, 'strftime') else str(expiry),
            'instrument_type': inst['instrument_type'],
            'lot_size': int(inst['lot_size']),
        })

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(rows, f)

    print(json.dumps({'success': True, 'count': len(rows)}))


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Run it and verify the output**

Run: `venv\Scripts\python.exe scripts/tools/zerodha_instruments_cache.py`
Expected stdout: `{"success": true, "count": <N>}` with `N > 0` (there are always some NIFTY option contracts listed on NFO).

Then verify the file:
Run: `venv\Scripts\python.exe -c "import json; d = json.load(open('debug/zerodha_nifty_instruments.json')); print(len(d)); print(d[0])"`
Expected: prints the count again and one sample row with keys `tradingsymbol`, `instrument_token`, `strike`, `expiry`, `instrument_type`, `lot_size`.

- [ ] **Step 3: Commit**

```bash
git add scripts/tools/zerodha_instruments_cache.py
git commit -m "feat: add Zerodha NIFTY-options instrument cache script"
```

---

### Task 3: Zerodha strike lookup route

**Files:**
- Create: `rs_dashboard/app/api/scalper/zerodha/lookup/route.ts`

**Interfaces:**
- Consumes: `PROJECT_ROOT`, `runPythonJson`, `dedupe` from `rs_dashboard/lib/pyExec.ts` (existing).
- Produces: `GET /api/scalper/zerodha/lookup?expiry=YYYY-MM-DD` → `{ success: boolean, data?: { lotSize: number, strikes: Record<string, { ceSymbol?: string, peSymbol?: string }> }, error?: string }`. Consumed by Task 9/10's strike-lookup effect and Task 5's order route (indirectly, via the UI passing the resolved tradingsymbol).

- [ ] **Step 1: Write the route**

Create `rs_dashboard/app/api/scalper/zerodha/lookup/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const CACHE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'zerodha_instruments_cache.py');
const CACHE_FILE = path.join(PROJECT_ROOT, 'debug', 'zerodha_nifty_instruments.json');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface CachedInstrument {
  tradingsymbol: string;
  instrument_token: number;
  strike: number;
  expiry: string;
  instrument_type: 'CE' | 'PE';
  lot_size: number;
}

async function ensureCache(): Promise<CachedInstrument[]> {
  const stale = !fs.existsSync(CACHE_FILE) ||
    Date.now() - fs.statSync(CACHE_FILE).mtimeMs > CACHE_MAX_AGE_MS;

  if (stale) {
    await dedupe('zerodha-instruments-cache', () =>
      runPythonJson<{ success: boolean; error?: string }>(CACHE_SCRIPT, [], 60_000));
  }
  return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as CachedInstrument[];
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const expiry = searchParams.get('expiry') ?? '';

  if (!expiry) {
    return NextResponse.json({ success: false, error: 'expiry required' }, { status: 400 });
  }

  try {
    const all = await ensureCache();
    const rows = all.filter(r => r.expiry === expiry);
    if (!rows.length) {
      return NextResponse.json({ success: false, error: `No Zerodha options found for NIFTY ${expiry}` });
    }

    const strikes: Record<string, { ceSymbol?: string; peSymbol?: string }> = {};
    let lotSize = 75;
    for (const r of rows) {
      lotSize = r.lot_size || lotSize;
      const key = String(Math.round(r.strike));
      if (!strikes[key]) strikes[key] = {};
      if (r.instrument_type === 'CE') strikes[key].ceSymbol = r.tradingsymbol;
      else strikes[key].peSymbol = r.tradingsymbol;
    }

    return NextResponse.json({ success: true, data: { lotSize, strikes } });
  } catch (err) {
    console.error('[scalper/zerodha/lookup] error:', err);
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Manual verification**

First find a valid expiry: `curl "http://localhost:3000/api/options/expiries?underlying=NIFTY"` (existing route) and take the first date, e.g. `2026-07-31`.

Run: `curl "http://localhost:3000/api/scalper/zerodha/lookup?expiry=2026-07-31"`
Expected (first call, cache cold): a short delay (~2-5s while the Python script runs), then `{"success":true,"data":{"lotSize":75,"strikes":{"23900":{"ceSymbol":"NIFTY26JUL23900CE","peSymbol":"NIFTY26JUL23900PE"}, ...}}}`.

Run the same curl again immediately.
Expected: near-instant response (cache file now fresh, no Python spawn).

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/app/api/scalper/zerodha/lookup/route.ts
git commit -m "feat: add Zerodha strike lookup route with cache regeneration"
```

---

### Task 4: Zerodha response-shaping helpers

**Files:**
- Create: `rs_dashboard/lib/zerodhaShape.ts`
- Create: `rs_dashboard/lib/zerodhaShape.test.ts`

**Interfaces:**
- Produces: `shapeZerodhaPosition`, `shapeZerodhaOrder`, `shapeZerodhaTrade` (all `(raw: Record<string, any>) => object`, reshaping Kite's snake_case fields to the UI's existing camelCase field names). Consumed by Task 6's routes.

- [ ] **Step 1: Write the failing tests**

Create `rs_dashboard/lib/zerodhaShape.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { shapeZerodhaPosition, shapeZerodhaOrder, shapeZerodhaTrade } from './zerodhaShape';

test('shapeZerodhaPosition maps Kite fields to the UI position shape', () => {
  const raw = {
    tradingsymbol: 'NIFTY26JUL23900PE',
    instrument_token: 12345,
    quantity: -75,
    buy_quantity: 0,
    sell_quantity: 75,
    buy_price: 0,
    sell_price: 120.5,
    last_price: 110,
    realised: 0,
    unrealised: 787.5,
    product: 'MIS',
  };
  assert.deepStrictEqual(shapeZerodhaPosition(raw), {
    tradingSymbol: 'NIFTY26JUL23900PE',
    securityId: '12345',
    netQty: -75,
    buyQty: 0,
    sellQty: 75,
    buyAvg: 0,
    sellAvg: 120.5,
    lastTradedPrice: 110,
    realizedProfit: 0,
    unrealizedProfit: 787.5,
    productType: 'MIS',
  });
});

test('shapeZerodhaOrder maps Kite fields to the UI order shape', () => {
  const raw = {
    tradingsymbol: 'NIFTY26JUL23900PE',
    status: 'COMPLETE',
    transaction_type: 'SELL',
    quantity: 75,
    price: 0,
    order_type: 'MARKET',
    order_timestamp: '2026-07-19 15:30:00',
  };
  assert.deepStrictEqual(shapeZerodhaOrder(raw), {
    tradingSymbol: 'NIFTY26JUL23900PE',
    orderStatus: 'COMPLETE',
    transactionType: 'SELL',
    quantity: 75,
    price: 0,
    orderType: 'MARKET',
    createTime: '2026-07-19 15:30:00',
  });
});

test('shapeZerodhaTrade maps Kite fields to the UI trade shape', () => {
  const raw = {
    tradingsymbol: 'NIFTY26JUL23900PE',
    transaction_type: 'SELL',
    quantity: 75,
    average_price: 120.5,
    fill_timestamp: '2026-07-19 15:30:01',
  };
  assert.deepStrictEqual(shapeZerodhaTrade(raw), {
    tradingSymbol: 'NIFTY26JUL23900PE',
    transactionType: 'SELL',
    tradedQuantity: 75,
    tradedPrice: 120.5,
    createTime: '2026-07-19 15:30:01',
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd rs_dashboard && node --test lib/zerodhaShape.test.ts`
Expected: FAIL — `Cannot find module './zerodhaShape'`.

- [ ] **Step 3: Write `rs_dashboard/lib/zerodhaShape.ts`**

```ts
export interface ScalperPosition {
  tradingSymbol: string;
  securityId: string;
  netQty: number;
  buyQty: number;
  sellQty: number;
  buyAvg: number;
  sellAvg: number;
  lastTradedPrice: number;
  realizedProfit: number;
  unrealizedProfit: number;
  productType: string;
}

export interface ScalperOrder {
  tradingSymbol: string;
  orderStatus: string;
  transactionType: string;
  quantity: number;
  price: number;
  orderType: string;
  createTime: string;
}

export interface ScalperTrade {
  tradingSymbol: string;
  transactionType: string;
  tradedQuantity: number;
  tradedPrice: number;
  createTime: string;
}

export function shapeZerodhaPosition(p: Record<string, any>): ScalperPosition {
  return {
    tradingSymbol: String(p.tradingsymbol ?? ''),
    securityId: String(p.instrument_token ?? ''),
    netQty: Number(p.quantity) || 0,
    buyQty: Number(p.buy_quantity) || 0,
    sellQty: Number(p.sell_quantity) || 0,
    buyAvg: Number(p.buy_price) || 0,
    sellAvg: Number(p.sell_price) || 0,
    lastTradedPrice: Number(p.last_price) || 0,
    realizedProfit: Number(p.realised) || 0,
    unrealizedProfit: Number(p.unrealised) || 0,
    productType: String(p.product ?? ''),
  };
}

export function shapeZerodhaOrder(o: Record<string, any>): ScalperOrder {
  return {
    tradingSymbol: String(o.tradingsymbol ?? ''),
    orderStatus: String(o.status ?? ''),
    transactionType: String(o.transaction_type ?? ''),
    quantity: Number(o.quantity) || 0,
    price: Number(o.price) || 0,
    orderType: String(o.order_type ?? ''),
    createTime: String(o.order_timestamp ?? ''),
  };
}

export function shapeZerodhaTrade(t: Record<string, any>): ScalperTrade {
  return {
    tradingSymbol: String(t.tradingsymbol ?? ''),
    transactionType: String(t.transaction_type ?? ''),
    tradedQuantity: Number(t.quantity) || 0,
    tradedPrice: Number(t.average_price) || 0,
    createTime: String(t.fill_timestamp ?? ''),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd rs_dashboard && node --test lib/zerodhaShape.test.ts`
Expected: `pass 3`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add rs_dashboard/lib/zerodhaShape.ts rs_dashboard/lib/zerodhaShape.test.ts
git commit -m "feat: add Zerodha-to-scalper response shaping helpers"
```

---

### Task 5: Zerodha order placement route

**Files:**
- Create: `rs_dashboard/app/api/scalper/zerodha/order/route.ts`

**Interfaces:**
- Consumes: `kitePost` from `rs_dashboard/lib/zerodhaToken.ts` (Task 1).
- Produces: `POST /api/scalper/zerodha/order` body `{ tradingsymbol: string, quantity: number, side: 'BUY'|'SELL', orderType?: 'MARKET'|'LIMIT', price?: number }` → `{ success: boolean, order_id?: string, error?: string }`. Consumed by Task 9/10's `placeOrder`.

- [ ] **Step 1: Write the route**

Create `rs_dashboard/app/api/scalper/zerodha/order/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { kitePost } from '@/lib/zerodhaToken';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ready: true });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json() as {
    tradingsymbol: string;
    quantity: number;
    side: string;
    orderType?: string;
    price?: number;
  };

  const { tradingsymbol, quantity, side, orderType = 'MARKET', price = 0 } = body;

  if (!tradingsymbol || !quantity || !side) {
    return NextResponse.json({ success: false, error: 'Missing required fields: tradingsymbol, quantity, side' }, { status: 400 });
  }

  const qtyNum = Number(quantity);
  if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
    return NextResponse.json({ success: false, error: `Invalid quantity: ${quantity} (must be a positive integer)` }, { status: 400 });
  }

  const sideUpper = String(side).toUpperCase();
  if (sideUpper !== 'BUY' && sideUpper !== 'SELL') {
    return NextResponse.json({ success: false, error: `Invalid side: ${side} (must be BUY or SELL)` }, { status: 400 });
  }

  const isLimitOrder = String(orderType).toUpperCase() === 'LIMIT';
  if (isLimitOrder && !(Number(price) > 0)) {
    return NextResponse.json({ success: false, error: `Invalid price for LIMIT order: ${price}` }, { status: 400 });
  }

  try {
    const params: Record<string, string | number> = {
      tradingsymbol,
      exchange: 'NFO',
      transaction_type: sideUpper,
      order_type: isLimitOrder ? 'LIMIT' : 'MARKET',
      quantity: qtyNum,
      product: 'MIS',
      validity: 'DAY',
    };
    if (isLimitOrder) params.price = Number(price);

    const data = await kitePost('/orders/regular', params) as { order_id: string };
    return NextResponse.json({ success: true, order_id: data.order_id });
  } catch (err) {
    console.error('[scalper/zerodha/order] error:', err);
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) });
  }
}
```

- [ ] **Step 2: Manual verification (validation errors — safe, no live order)**

Run: `curl -X POST http://localhost:3000/api/scalper/zerodha/order -H "Content-Type: application/json" -d "{}"`
Expected: `{"success":false,"error":"Missing required fields: tradingsymbol, quantity, side"}`

Run: `curl -X POST http://localhost:3000/api/scalper/zerodha/order -H "Content-Type: application/json" -d "{\"tradingsymbol\":\"NIFTY26JUL23900PE\",\"quantity\":75,\"side\":\"BUY\",\"orderType\":\"LIMIT\"}"`
Expected: `{"success":false,"error":"Invalid price for LIMIT order: 0"}`

- [ ] **Step 3: Manual verification (live order — only during market hours, with explicit user go-ahead)**

Run (1 lot, MARKET, using a real near-month tradingsymbol from Task 3's lookup output):
`curl -X POST http://localhost:3000/api/scalper/zerodha/order -H "Content-Type: application/json" -d "{\"tradingsymbol\":\"<REAL_SYMBOL>\",\"quantity\":75,\"side\":\"BUY\",\"orderType\":\"MARKET\"}"`
Expected: `{"success":true,"order_id":"..."}`, and the order appears in Zerodha's own Kite app. **Do not run this step without the user's explicit go-ahead — it places a real order.**

- [ ] **Step 4: Commit**

```bash
git add rs_dashboard/app/api/scalper/zerodha/order/route.ts
git commit -m "feat: add Zerodha order placement route"
```

---

### Task 6: Zerodha positions/orders/trades/funds routes

**Files:**
- Create: `rs_dashboard/app/api/scalper/zerodha/all/route.ts`
- Create: `rs_dashboard/app/api/scalper/zerodha/poll/route.ts`
- Create: `rs_dashboard/app/api/scalper/zerodha/positions/route.ts`
- Create: `rs_dashboard/app/api/scalper/zerodha/funds/route.ts`

**Interfaces:**
- Consumes: `kiteGet` (Task 1), `shapeZerodhaPosition`/`shapeZerodhaOrder`/`shapeZerodhaTrade` (Task 4).
- Produces: same response contracts as their Dhan counterparts (`{success, positions, orders, trades, funds?, pnl_guard?}` for `all`; `{success, positions, orders, trades}` for `poll`; `{success, data}` for `positions`/`funds`). Consumed by Task 9/10.

- [ ] **Step 1: Create `rs_dashboard/app/api/scalper/zerodha/all/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { kiteGet } from '@/lib/zerodhaToken';
import { shapeZerodhaPosition, shapeZerodhaOrder, shapeZerodhaTrade } from '@/lib/zerodhaShape';

export async function GET(): Promise<NextResponse> {
  try {
    const [positions, orders, trades, margins] = await Promise.all([
      kiteGet('/portfolio/positions').catch(() => ({ net: [] })) as Promise<{ net: any[] }>,
      kiteGet('/orders').catch(() => []) as Promise<any[]>,
      kiteGet('/trades').catch(() => []) as Promise<any[]>,
      kiteGet('/user/margins').catch(() => ({})) as Promise<Record<string, any>>,
    ]);

    return NextResponse.json({
      success: true,
      positions: (positions.net ?? []).map(shapeZerodhaPosition),
      orders: (Array.isArray(orders) ? orders : []).map(shapeZerodhaOrder),
      trades: (Array.isArray(trades) ? trades : []).map(shapeZerodhaTrade),
      funds: { availabelBalance: margins?.equity?.net ?? 0 },
      pnl_guard: null,
    });
  } catch (err) {
    console.error('[scalper/zerodha/all] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch tab data', detail: String((err as Error).message) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Create `rs_dashboard/app/api/scalper/zerodha/poll/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { kiteGet } from '@/lib/zerodhaToken';
import { shapeZerodhaPosition, shapeZerodhaOrder, shapeZerodhaTrade } from '@/lib/zerodhaShape';

export async function GET(): Promise<NextResponse> {
  try {
    const [positions, orders, trades] = await Promise.all([
      kiteGet('/portfolio/positions').catch(() => ({ net: [] })) as Promise<{ net: any[] }>,
      kiteGet('/orders').catch(() => []) as Promise<any[]>,
      kiteGet('/trades').catch(() => []) as Promise<any[]>,
    ]);

    return NextResponse.json({
      success: true,
      positions: (positions.net ?? []).map(shapeZerodhaPosition),
      orders: (Array.isArray(orders) ? orders : []).map(shapeZerodhaOrder),
      trades: (Array.isArray(trades) ? trades : []).map(shapeZerodhaTrade),
    });
  } catch (err) {
    console.error('[scalper/zerodha/poll] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to poll data', detail: String((err as Error).message) }, { status: 500 });
  }
}
```

- [ ] **Step 3: Create `rs_dashboard/app/api/scalper/zerodha/positions/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { kiteGet } from '@/lib/zerodhaToken';
import { shapeZerodhaPosition } from '@/lib/zerodhaShape';

export async function GET(): Promise<NextResponse> {
  try {
    const positions = await kiteGet('/portfolio/positions') as { net: any[] };
    return NextResponse.json({ success: true, data: (positions.net ?? []).map(shapeZerodhaPosition) });
  } catch (err) {
    console.error('[scalper/zerodha/positions] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch positions', detail: String((err as Error).message) }, { status: 500 });
  }
}
```

- [ ] **Step 4: Create `rs_dashboard/app/api/scalper/zerodha/funds/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { kiteGet } from '@/lib/zerodhaToken';

export async function GET(): Promise<NextResponse> {
  try {
    const margins = await kiteGet('/user/margins') as Record<string, any>;
    return NextResponse.json({ success: true, data: { availabelBalance: margins?.equity?.net ?? 0 } });
  } catch (err) {
    console.error('[scalper/zerodha/funds] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch funds', detail: String((err as Error).message) }, { status: 500 });
  }
}
```

- [ ] **Step 5: Manual verification**

Run each and check shape:
- `curl http://localhost:3000/api/scalper/zerodha/all` → `{"success":true,"positions":[...],"orders":[...],"trades":[...],"funds":{"availabelBalance":<number>},"pnl_guard":null}` — each position object has exactly the keys `tradingSymbol, securityId, netQty, buyQty, sellQty, buyAvg, sellAvg, lastTradedPrice, realizedProfit, unrealizedProfit, productType`.
- `curl http://localhost:3000/api/scalper/zerodha/poll` → same positions/orders/trades shape, no `funds`/`pnl_guard` keys.
- `curl http://localhost:3000/api/scalper/zerodha/positions` → `{"success":true,"data":[...]}`.
- `curl http://localhost:3000/api/scalper/zerodha/funds` → `{"success":true,"data":{"availabelBalance":<number>}}` matching the value seen from `kite.margins()` during this session's verification (`equity.net`).

- [ ] **Step 6: Commit**

```bash
git add rs_dashboard/app/api/scalper/zerodha/all/route.ts rs_dashboard/app/api/scalper/zerodha/poll/route.ts rs_dashboard/app/api/scalper/zerodha/positions/route.ts rs_dashboard/app/api/scalper/zerodha/funds/route.ts
git commit -m "feat: add Zerodha positions/orders/trades/funds routes"
```

---

### Task 7: Zerodha Exit All route

**Files:**
- Create: `rs_dashboard/app/api/scalper/zerodha/exit-all/route.ts`

**Interfaces:**
- Consumes: `kiteGet`, `kitePost` (Task 1).
- Produces: `POST /api/scalper/zerodha/exit-all` → `{ success: boolean, closed: string[], errors: string[] }`. Consumed by Task 9/10's `handleExitAll`.

- [ ] **Step 1: Write the route**

Create `rs_dashboard/app/api/scalper/zerodha/exit-all/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { kiteGet, kitePost } from '@/lib/zerodhaToken';

export async function POST(): Promise<NextResponse> {
  const closed: string[] = [];
  const errors: string[] = [];

  try {
    const positions = await kiteGet('/portfolio/positions') as { net: any[] };
    const open = (positions.net ?? []).filter(p => Number(p.quantity) !== 0);

    for (const pos of open) {
      const qty = Math.abs(Number(pos.quantity));
      const side = Number(pos.quantity) > 0 ? 'SELL' : 'BUY';
      try {
        await kitePost('/orders/regular', {
          tradingsymbol: pos.tradingsymbol,
          exchange: pos.exchange ?? 'NFO',
          transaction_type: side,
          order_type: 'MARKET',
          quantity: qty,
          product: pos.product ?? 'MIS',
          validity: 'DAY',
        });
        closed.push(pos.tradingsymbol);
      } catch (err) {
        errors.push(`${pos.tradingsymbol}: ${String((err as Error).message ?? err)}`);
      }
    }

    return NextResponse.json({ success: errors.length === 0, closed, errors });
  } catch (err) {
    console.error('[scalper/zerodha/exit-all] error:', err);
    return NextResponse.json({ success: false, closed, errors: [String((err as Error).message ?? err)] }, { status: 500 });
  }
}
```

- [ ] **Step 2: Manual verification**

With no open Zerodha positions:
Run: `curl -X POST http://localhost:3000/api/scalper/zerodha/exit-all`
Expected: `{"success":true,"closed":[],"errors":[]}`

With an open Zerodha position (place one via Task 5's live-order step first, only with explicit user go-ahead, during market hours):
Run the same curl.
Expected: `{"success":true,"closed":["<tradingsymbol>"],"errors":[]}`, and the position shows flat in Zerodha's Kite app afterward.

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/app/api/scalper/zerodha/exit-all/route.ts
git commit -m "feat: add Zerodha Exit All route"
```

---

### Task 8: `useBrokerSelector` hook

**Files:**
- Create: `rs_dashboard/hooks/useBrokerSelector.ts`
- Create: `rs_dashboard/hooks/brokerRoute.test.ts`

**Interfaces:**
- Produces: `type Broker = 'dhan' | 'zerodha'`, `brokerRoute(broker: Broker, dhanPath: string, zerodhaPath: string): string`, `useBrokerSelector(): { broker: Broker, setBroker: (b: Broker) => void, authenticatedBrokers: Broker[] }`. Consumed by Task 9 and Task 10.

- [ ] **Step 1: Write the failing test for the pure routing helper**

Create `rs_dashboard/hooks/brokerRoute.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { brokerRoute } from './useBrokerSelector';

test('brokerRoute picks the Dhan path by default', () => {
  assert.strictEqual(brokerRoute('dhan', '/api/scalper/all', '/api/scalper/zerodha/all'), '/api/scalper/all');
});

test('brokerRoute picks the Zerodha path when selected', () => {
  assert.strictEqual(brokerRoute('zerodha', '/api/scalper/all', '/api/scalper/zerodha/all'), '/api/scalper/zerodha/all');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rs_dashboard && node --test hooks/brokerRoute.test.ts`
Expected: FAIL — `Cannot find module './useBrokerSelector'`.

- [ ] **Step 3: Write `rs_dashboard/hooks/useBrokerSelector.ts`**

```ts
'use client';

import { useState, useEffect } from 'react';

export type Broker = 'dhan' | 'zerodha';

/** Picks the Dhan or Zerodha URL for the currently selected broker. */
export function brokerRoute(broker: Broker, dhanPath: string, zerodhaPath: string): string {
  return broker === 'zerodha' ? zerodhaPath : dhanPath;
}

/**
 * Tracks the selected broker (always defaults to 'dhan' on mount, no
 * persistence) and which brokers currently have a valid session, fetched
 * once from /api/auth/broker-status.
 */
export function useBrokerSelector() {
  const [broker, setBroker] = useState<Broker>('dhan');
  const [authenticatedBrokers, setAuthenticatedBrokers] = useState<Broker[]>(['dhan']);

  useEffect(() => {
    fetch('/api/auth/broker-status')
      .then(r => r.json())
      .then((j: { dhan: boolean; zerodha: boolean }) => {
        const brokers: Broker[] = [];
        if (j.dhan) brokers.push('dhan');
        if (j.zerodha) brokers.push('zerodha');
        setAuthenticatedBrokers(brokers.length ? brokers : ['dhan']);
      })
      .catch(() => {});
  }, []);

  return { broker, setBroker, authenticatedBrokers };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd rs_dashboard && node --test hooks/brokerRoute.test.ts`
Expected: `pass 2`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add rs_dashboard/hooks/useBrokerSelector.ts rs_dashboard/hooks/brokerRoute.test.ts
git commit -m "feat: add useBrokerSelector hook for scalper broker switching"
```

---

### Task 9: Wire broker selector into `Scalper.tsx`

**Files:**
- Modify: `rs_dashboard/components/Scalper.tsx`

**Interfaces:**
- Consumes: `useBrokerSelector`, `brokerRoute`, `type Broker` from `rs_dashboard/hooks/useBrokerSelector.ts` (Task 8).

- [ ] **Step 1: Add the import**

Find the top of `rs_dashboard/components/Scalper.tsx` (existing imports block) and add:

```ts
import { useBrokerSelector, brokerRoute } from '@/hooks/useBrokerSelector';
```

- [ ] **Step 2: Broaden `strikeMap`'s type and add broker state**

At line 90, replace:

```ts
  const [strikeMap, setStrikeMap]   = useState<Record<string, { ceId?: string; peId?: string }>>({});
```

with:

```ts
  const [strikeMap, setStrikeMap]   = useState<Record<string, { ceId?: string; peId?: string; ceSymbol?: string; peSymbol?: string }>>({});
  const { broker, setBroker, authenticatedBrokers } = useBrokerSelector();
```

- [ ] **Step 3: Branch the strike-lookup effect**

At lines 331-345, replace:

```ts
    // Lookup security IDs for all strikes of this expiry — enables fast-order path.
    // Capture the expiry this request was made for: if the user switches expiries again
    // before this resolves, an out-of-order response must not overwrite strikeMap with
    // stale security IDs from a different contract (Dhan rejects those as DH-905).
    const requestedExpiry = expiry;
    fetch(`/api/scalper/lookup?underlying=NIFTY&expiry=${expiry}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { lotSize: number; strikes: Record<string, { ceId?: string; peId?: string }> } }) => {
        if (requestedExpiry !== expiryRef.current) return;
        if (j.success && j.data) {
          setStrikeMap(j.data.strikes);
          setLotSize(j.data.lotSize);
        }
      })
      .catch(() => {});
```

with:

```ts
    // Lookup security IDs (Dhan) / tradingsymbols (Zerodha) for all strikes of
    // this expiry — enables the fast-order path. Capture the expiry this
    // request was made for: if the user switches expiries again before this
    // resolves, an out-of-order response must not overwrite strikeMap with
    // stale data from a different contract (Dhan rejects those as DH-905).
    const requestedExpiry = expiry;
    const lookupUrl = brokerRoute(
      broker,
      `/api/scalper/lookup?underlying=NIFTY&expiry=${expiry}`,
      `/api/scalper/zerodha/lookup?expiry=${expiry}`,
    );
    fetch(lookupUrl)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { lotSize: number; strikes: Record<string, { ceId?: string; peId?: string; ceSymbol?: string; peSymbol?: string }> } }) => {
        if (requestedExpiry !== expiryRef.current) return;
        if (j.success && j.data) {
          setStrikeMap(j.data.strikes);
          setLotSize(j.data.lotSize);
        }
      })
      .catch(() => {});
```

- [ ] **Step 4: Branch `placeOrder`**

At lines 451-478, replace:

```ts
    try {
      // Fast path: direct Dhan REST call (no Python spawn, no CSV load)
      const secId = strikeMap[String(strike)]?.[option === 'CE' ? 'ceId' : 'peId'];
      let res: Response;
      if (secId) {
        res = await fetch('/api/scalper/fast-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            securityId: secId,
            quantity: lots * lotSize,
            side,
            orderType: orderMode,
            ...(orderMode === 'LIMIT' ? { price: Number(limitPrice) } : {}),
          }),
        });
      } else {
        // Fallback: Python path (strikeMap not yet loaded)
        const body: Record<string, unknown> = {
          underlying: 'NIFTY', expiry, strike, option, side, lots, type: orderMode,
        };
        if (orderMode === 'LIMIT') body.price = Number(limitPrice);
        res = await fetch('/api/scalper/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
```

with:

```ts
    try {
      const entry = strikeMap[String(strike)];
      let res: Response;
      if (broker === 'zerodha') {
        const symbol = entry?.[option === 'CE' ? 'ceSymbol' : 'peSymbol'];
        if (!symbol) {
          addToast('error', `${side} ${option} failed`, 'Zerodha strike data still loading');
          return;
        }
        res = await fetch('/api/scalper/zerodha/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tradingsymbol: symbol,
            quantity: lots * lotSize,
            side,
            orderType: orderMode,
            ...(orderMode === 'LIMIT' ? { price: Number(limitPrice) } : {}),
          }),
        });
      } else {
        // Fast path: direct Dhan REST call (no Python spawn, no CSV load)
        const secId = entry?.[option === 'CE' ? 'ceId' : 'peId'];
        if (secId) {
          res = await fetch('/api/scalper/fast-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              securityId: secId,
              quantity: lots * lotSize,
              side,
              orderType: orderMode,
              ...(orderMode === 'LIMIT' ? { price: Number(limitPrice) } : {}),
            }),
          });
        } else {
          // Fallback: Python path (strikeMap not yet loaded)
          const body: Record<string, unknown> = {
            underlying: 'NIFTY', expiry, strike, option, side, lots, type: orderMode,
          };
          if (orderMode === 'LIMIT') body.price = Number(limitPrice);
          res = await fetch('/api/scalper/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        }
      }
```

Also update the dependency array at line 493 from:

```ts
  }, [ceStrike, peStrike, ceLimitPrice, peLimitPrice, expiry, lots, lotSize, strikeMap, orderMode, addToast, fetchTabData]);
```

to:

```ts
  }, [ceStrike, peStrike, ceLimitPrice, peLimitPrice, expiry, lots, lotSize, strikeMap, orderMode, broker, addToast, fetchTabData]);
```

- [ ] **Step 5: Branch `closePosition`'s live-position fetch and close call**

At lines 512-545, replace:

```ts
    try {
      // Fetch live positions to get the current open quantity (avoids acting on stale data)
      let liveNetQty = 0;
      let liveSecId = fallbackSecId;
      try {
        const posRes = await fetch('/api/scalper/positions');
        const posJson = await posRes.json() as { success: boolean; data?: Record<string, unknown>[] };
        if (posJson.success && posJson.data) {
          const match = posJson.data.find(p => String(p.tradingSymbol) === sym);
          if (match) {
            liveNetQty = Number(match.netQty);
            liveSecId = String(match.securityId ?? match.security_id ?? fallbackSecId);
          }
        }
      } catch {
        // Fall back to the quantity from the position object passed in
        liveNetQty = Number(pos.netQty);
      }

      if (liveNetQty === 0) {
        addToast('success', `${sym} already flat`, `(${reason})`);
        setPosGuards(prev => { const next = { ...prev }; delete next[sym]; return next; });
        fetchTabData();
        return;
      }

      const side = liveNetQty > 0 ? 'SELL' : 'BUY';
      const qty = Math.abs(liveNetQty);

      const res = await fetch('/api/scalper/fast-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ securityId: liveSecId, quantity: qty, side, orderType: 'MARKET' }),
      });
```

with:

```ts
    try {
      // Fetch live positions to get the current open quantity (avoids acting on stale data)
      let liveNetQty = 0;
      let liveSecId = fallbackSecId;
      try {
        const posUrl = brokerRoute(broker, '/api/scalper/positions', '/api/scalper/zerodha/positions');
        const posRes = await fetch(posUrl);
        const posJson = await posRes.json() as { success: boolean; data?: Record<string, unknown>[] };
        if (posJson.success && posJson.data) {
          const match = posJson.data.find(p => String(p.tradingSymbol) === sym);
          if (match) {
            liveNetQty = Number(match.netQty);
            liveSecId = String(match.securityId ?? match.security_id ?? fallbackSecId);
          }
        }
      } catch {
        // Fall back to the quantity from the position object passed in
        liveNetQty = Number(pos.netQty);
      }

      if (liveNetQty === 0) {
        addToast('success', `${sym} already flat`, `(${reason})`);
        setPosGuards(prev => { const next = { ...prev }; delete next[sym]; return next; });
        fetchTabData();
        return;
      }

      const side = liveNetQty > 0 ? 'SELL' : 'BUY';
      const qty = Math.abs(liveNetQty);

      const orderUrl = brokerRoute(broker, '/api/scalper/fast-order', '/api/scalper/zerodha/order');
      const res = await fetch(orderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          broker === 'zerodha'
            ? { tradingsymbol: sym, quantity: qty, side, orderType: 'MARKET' }
            : { securityId: liveSecId, quantity: qty, side, orderType: 'MARKET' },
        ),
      });
```

- [ ] **Step 6: Branch `handleExitAll`**

At lines 594-605, replace:

```ts
    try {
      const res = await fetch('/api/exit-all', { method: 'POST' });
      const data = await res.json();
      if (data.broker_exit) {
        const killed = data.killed?.length ?? 0;
        const fallback = data.trigger_fallback?.length ?? 0;
        const detail = killed > 0 ? ` ${killed} strategy process${killed === 1 ? '' : 'es'} terminated.` : '';
        const fb = fallback > 0 ? ` ${fallback} sent graceful shutdown.` : '';
        addToast('success', `All positions liquidated at broker.${detail}${fb}`);
      } else {
        addToast('error', data.error || 'Broker exit failed — check Dhan account manually.');
      }
```

with:

```ts
    try {
      if (broker === 'zerodha') {
        const res = await fetch('/api/scalper/zerodha/exit-all', { method: 'POST' });
        const data = await res.json() as { success: boolean; closed: string[]; errors: string[] };
        if (data.success) {
          addToast('success', `All Zerodha positions liquidated.${data.closed.length ? ` (${data.closed.join(', ')})` : ''}`);
        } else {
          addToast('error', 'Zerodha exit failed', data.errors.join('; ') || 'Unknown error');
        }
      } else {
        const res = await fetch('/api/exit-all', { method: 'POST' });
        const data = await res.json();
        if (data.broker_exit) {
          const killed = data.killed?.length ?? 0;
          const fallback = data.trigger_fallback?.length ?? 0;
          const detail = killed > 0 ? ` ${killed} strategy process${killed === 1 ? '' : 'es'} terminated.` : '';
          const fb = fallback > 0 ? ` ${fallback} sent graceful shutdown.` : '';
          addToast('success', `All positions liquidated at broker.${detail}${fb}`);
        } else {
          addToast('error', data.error || 'Broker exit failed — check Dhan account manually.');
        }
      }
```

Update the dependency array at the end of `handleExitAll` from `[confirmExitAll, addToast, fetchTabData]` to `[confirmExitAll, broker, addToast, fetchTabData]`.

- [ ] **Step 7: Branch `fetchTabData`, `pollTabData`, `pollFunds`**

At lines 370-407, replace all three functions:

```ts
  const fetchTabData = useCallback(() => {
    setTabLoading(true);
    fetch('/api/scalper/all')
      .then(r => r.json())
      .then((j: { success: boolean; positions?: Record<string, unknown>[]; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[]; funds?: Record<string, any>; pnl_guard?: any }) => {
        if (j.success) {
          setPositionsData(j.positions ?? []);
          setOrdersData(j.orders ?? []);
          setTradesData(j.trades ?? []);
          setFundsData(j.funds ?? null);
          setPnlGuardStatus(j.pnl_guard ?? null);
        }
      })
      .catch(() => {})
      .finally(() => setTabLoading(false));
  }, []);

  const pollTabData = useCallback(() => {
    fetch('/api/scalper/poll')
      .then(r => r.json())
      .then((j: { success: boolean; positions?: Record<string, unknown>[]; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[] }) => {
        if (j.success) {
          setPositionsData(j.positions ?? []);
          setOrdersData(j.orders ?? []);
          setTradesData(j.trades ?? []);
        }
      })
      .catch(() => {});
  }, []);

  const pollFunds = useCallback(() => {
    fetch('/api/scalper/funds')
      .then(r => r.json())
      .then((j: { success: boolean; data?: Record<string, any> }) => {
        if (j.success) setFundsData(j.data ?? null);
      })
      .catch(() => {});
  }, []);
```

with:

```ts
  const fetchTabData = useCallback(() => {
    setTabLoading(true);
    fetch(brokerRoute(broker, '/api/scalper/all', '/api/scalper/zerodha/all'))
      .then(r => r.json())
      .then((j: { success: boolean; positions?: Record<string, unknown>[]; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[]; funds?: Record<string, any>; pnl_guard?: any }) => {
        if (j.success) {
          setPositionsData(j.positions ?? []);
          setOrdersData(j.orders ?? []);
          setTradesData(j.trades ?? []);
          setFundsData(j.funds ?? null);
          setPnlGuardStatus(j.pnl_guard ?? null);
        }
      })
      .catch(() => {})
      .finally(() => setTabLoading(false));
  }, [broker]);

  const pollTabData = useCallback(() => {
    fetch(brokerRoute(broker, '/api/scalper/poll', '/api/scalper/zerodha/poll'))
      .then(r => r.json())
      .then((j: { success: boolean; positions?: Record<string, unknown>[]; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[] }) => {
        if (j.success) {
          setPositionsData(j.positions ?? []);
          setOrdersData(j.orders ?? []);
          setTradesData(j.trades ?? []);
        }
      })
      .catch(() => {});
  }, [broker]);

  const pollFunds = useCallback(() => {
    fetch(brokerRoute(broker, '/api/scalper/funds', '/api/scalper/zerodha/funds'))
      .then(r => r.json())
      .then((j: { success: boolean; data?: Record<string, any> }) => {
        if (j.success) setFundsData(j.data ?? null);
      })
      .catch(() => {});
  }, [broker]);
```

- [ ] **Step 8: Clear stale data when the broker changes**

Immediately after the `useEffect` that syncs `positionsRef.current = enrichedPositions` (around line 421), add a new effect:

```ts
  // Clear stale data immediately on broker switch so a Dhan position is
  // never displayed or acted on as if it belonged to Zerodha (or vice versa).
  useEffect(() => {
    setPositionsData([]);
    setOrdersData([]);
    setTradesData([]);
    setFundsData(null);
    setStrikeMap({});
  }, [broker]);
```

- [ ] **Step 9: Render the broker dropdown**

At line 1030 (immediately before the `{/* Exit ALL Positions (broker-level nuclear) */}` comment), insert:

```tsx
                {/* Broker selector — only shown when more than one broker is authenticated */}
                {authenticatedBrokers.length > 1 && (
                  <select
                    value={broker}
                    onChange={e => setBroker(e.target.value as 'dhan' | 'zerodha')}
                    className="px-2 py-1.5 rounded-lg text-xs font-bold bg-zinc-900 border border-zinc-700 text-zinc-300"
                  >
                    {authenticatedBrokers.includes('dhan') && <option value="dhan">Dhan</option>}
                    {authenticatedBrokers.includes('zerodha') && <option value="zerodha">Zerodha</option>}
                  </select>
                )}

```

- [ ] **Step 10: Manual verification**

Run: `cd rs_dashboard && npm run dev`, open `http://localhost:3000/scalper` in a browser.
Expected: with both brokers authenticated, a "Dhan"/"Zerodha" dropdown appears next to the Exit All button, defaulting to "Dhan". Positions/orders/trades/funds panel loads (Dhan data, unchanged from before this change). Switching to "Zerodha" clears the panel then repopulates with Zerodha's positions/orders/trades/funds (likely empty if no open Zerodha positions). Placing a Dhan order still works exactly as before (regression check).

- [ ] **Step 11: Commit**

```bash
git add rs_dashboard/components/Scalper.tsx
git commit -m "feat: wire broker selector into Scalper terminal"
```

---

### Task 10: Wire broker selector into `AdvancedScalper.tsx`

**Files:**
- Modify: `rs_dashboard/components/AdvancedScalper.tsx`

**Interfaces:**
- Consumes: same as Task 9 (`useBrokerSelector`, `brokerRoute` from Task 8).

This mirrors Task 9 exactly, applied to `AdvancedScalper.tsx`'s equivalent (per-box) call sites.

- [ ] **Step 1: Add the import**

Add to the imports block at the top of `rs_dashboard/components/AdvancedScalper.tsx`:

```ts
import { useBrokerSelector, brokerRoute } from '@/hooks/useBrokerSelector';
```

- [ ] **Step 2: Broaden `strikeMap`'s type and add broker state**

At line 41, replace:

```ts
  const [strikeMap, setStrikeMap]   = useState<Record<string, { ceId?: string; peId?: string }>>({});
```

with:

```ts
  const [strikeMap, setStrikeMap]   = useState<Record<string, { ceId?: string; peId?: string; ceSymbol?: string; peSymbol?: string }>>({});
  const { broker, setBroker, authenticatedBrokers } = useBrokerSelector();
```

- [ ] **Step 3: Branch the strike-lookup effect**

Find the strike-lookup effect at line 268 (`fetch(\`/api/scalper/lookup?underlying=NIFTY&expiry=${expiry}\`)`) — apply the identical replacement described in Task 9 Step 3 (same surrounding code, same fix).

- [ ] **Step 4: Branch `placeOrder`**

At lines 412-437, replace:

```ts
    try {
      const secId = strikeMap[String(box.strike)]?.[box.side === 'CE' ? 'ceId' : 'peId'];
      let res: Response;
      if (secId) {
        res = await fetch('/api/scalper/fast-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            securityId: secId,
            quantity: box.lots * lotSize,
            side,
            orderType: orderMode,
            ...(orderMode === 'LIMIT' ? { price: Number(box.limitPrice) } : {}),
          }),
        });
      } else {
        const body: Record<string, unknown> = {
          underlying: 'NIFTY', expiry, strike: box.strike, option: box.side, side, lots: box.lots, type: orderMode,
        };
        if (orderMode === 'LIMIT') body.price = Number(box.limitPrice);
        res = await fetch('/api/scalper/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
```

with:

```ts
    try {
      const entry = strikeMap[String(box.strike)];
      let res: Response;
      if (broker === 'zerodha') {
        const symbol = entry?.[box.side === 'CE' ? 'ceSymbol' : 'peSymbol'];
        if (!symbol) {
          addToast('error', `${side} ${box.side} failed`, 'Zerodha strike data still loading');
          return;
        }
        res = await fetch('/api/scalper/zerodha/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tradingsymbol: symbol,
            quantity: box.lots * lotSize,
            side,
            orderType: orderMode,
            ...(orderMode === 'LIMIT' ? { price: Number(box.limitPrice) } : {}),
          }),
        });
      } else {
        const secId = entry?.[box.side === 'CE' ? 'ceId' : 'peId'];
        if (secId) {
          res = await fetch('/api/scalper/fast-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              securityId: secId,
              quantity: box.lots * lotSize,
              side,
              orderType: orderMode,
              ...(orderMode === 'LIMIT' ? { price: Number(box.limitPrice) } : {}),
            }),
          });
        } else {
          const body: Record<string, unknown> = {
            underlying: 'NIFTY', expiry, strike: box.strike, option: box.side, side, lots: box.lots, type: orderMode,
          };
          if (orderMode === 'LIMIT') body.price = Number(box.limitPrice);
          res = await fetch('/api/scalper/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        }
      }
```

Update `placeOrder`'s dependency array to include `broker` (same pattern as Task 9 Step 4).

- [ ] **Step 5: Branch `closePosition`**

At lines 471-502, apply the identical replacement described in Task 9 Step 5 (same surrounding code — `/api/scalper/positions` fetch and `/api/scalper/fast-order` close call).

- [ ] **Step 6: Branch `handleExitAll`**

At lines 552-562 (`fetch('/api/exit-all', ...)` block inside `handleExitAll`), apply the identical replacement described in Task 9 Step 6. Update the dependency array from `[confirmExitAll, addToast, fetchTabData]` to `[confirmExitAll, broker, addToast, fetchTabData]`.

- [ ] **Step 7: Branch `fetchTabData`/`pollTabData`**

Find the two fetch functions at lines 302 (`fetch('/api/scalper/all')`) and 318 (`fetch('/api/scalper/poll')`) — apply the identical `brokerRoute(...)` replacement described in Task 9 Step 7 for `fetchTabData` and `pollTabData` (note: `AdvancedScalper.tsx` has no separate `pollFunds` — funds come from `fetchTabData`'s `/api/scalper/all` response only, so there is no third function to change here).

- [ ] **Step 8: Clear stale data on broker switch**

Add the same `useEffect` described in Task 9 Step 8, placed anywhere after `strikeMap`'s declaration.

- [ ] **Step 9: Render the broker dropdown**

At line 955 (immediately before the `{/* Exit ALL Positions (broker-level nuclear) */}` comment), insert the identical dropdown JSX from Task 9 Step 9.

- [ ] **Step 10: Manual verification**

Open `http://localhost:3000/advanced-scalper` in a browser. Same checks as Task 9 Step 10, applied to the Advanced Scalper's box-based UI (place a box order, switch broker, confirm panel clears/repopulates, switch back to Dhan and confirm no regression).

- [ ] **Step 11: Commit**

```bash
git add rs_dashboard/components/AdvancedScalper.tsx
git commit -m "feat: wire broker selector into Advanced Scalper terminal"
```

---

## Self-Review Notes

- **Spec coverage:** broker-status endpoint (Task 1), Zerodha REST client (Task 1), instrument lookup (Tasks 2-3), order entry (Task 5), positions/orders/trades/funds panel (Task 6), Exit All (Task 7), UI wiring + stale-data-clear-on-switch + default-to-Dhan dropdown (Tasks 9-10) — every spec section maps to a task.
- **Placeholder scan:** no TBDs; all code blocks are complete and runnable as written.
- **Type consistency:** `Broker` type, `brokerRoute()` signature, `ScalperPosition`/`ScalperOrder`/`ScalperTrade` field names, and the `{ceId?, peId?, ceSymbol?, peSymbol?}` strikeMap shape are used identically across Tasks 1, 4, 8, 9, and 10.
