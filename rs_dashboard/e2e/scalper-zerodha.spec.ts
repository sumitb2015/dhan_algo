import { expect, test, type Page, type Route } from '@playwright/test';
import { json, signIn, type Call } from './support';

// The Advanced Scalper on ZERODHA, end to end in the browser with every broker-backed route mocked (nothing reaches
// Kite or Dhan's order APIs: an unmocked write is refused with 599 and fails the test). Zerodha twin of
// scalper-kotak.spec.ts: parity of pricing (Dhan only, never Kite's last_price), order shape, server-held guards,
// unknown-outcome handling and Add Lots on another expiry.

const ON_SCREEN = 'NIFTY26O1923150CE';
const OFF_EXPIRY = 'NIFTY26O2722500PE';
const KITE_LAST_PRICE = 999;   // a Kite last_price that must never reach the screen

function kiteRow(tradingSymbol: string, netQty: number, avg: number) {
  const q = Math.abs(netQty);
  return {
    tradingSymbol, securityId: '1', exchange: 'NFO', netQty, productType: 'NRML',
    buyQty: netQty > 0 ? q : 0, sellQty: netQty < 0 ? q : 0,
    buyAvg: netQty > 0 ? avg : 0, sellAvg: netQty < 0 ? avg : 0,
    lastTradedPrice: KITE_LAST_PRICE, realizedProfit: 0, unrealizedProfit: 0,
  };
}

const SYMBOLS: Record<string, { expiry: string; strike: number; side: 'CE' | 'PE' }> = {
  [ON_SCREEN]: { expiry: '2026-10-19', strike: 23150, side: 'CE' },
  NIFTY26O1923150PE: { expiry: '2026-10-19', strike: 23150, side: 'PE' },
  [OFF_EXPIRY]: { expiry: '2026-10-27', strike: 22500, side: 'PE' },
};
const STRIKES = ['22500', '23100', '23150', '23200'];

interface ZerodhaMock {
  calls: Call[];
  blocked: Call[];
  dhan: string[];
  positions: Record<string, unknown>[];
  guard: { date: string; pnl: unknown; brackets: unknown[]; watch: unknown[]; events: unknown[] };
  orderReply?: (body: Record<string, unknown> | null) => { status: number; body: unknown };
}

const DHAN_ACCOUNT_ROUTE = /^\/api\/(scalper\/(all|poll|positions|trades|funds|orders|lookup|fast-order|order)|pnl-exit|super-order(\/.*)?|exit-all)$/;
function touchesDhanAccount(p: string, q: URLSearchParams, body: Record<string, unknown> | null): boolean {
  if (DHAN_ACCOUNT_ROUTE.test(p)) return true;
  if (p === '/api/scalper/mtm-history') return String(body?.broker ?? 'dhan') === 'dhan';
  return q.get('broker') === 'dhan' && p !== '/api/options/live';
}

async function installMock(page: Page, m: ZerodhaMock): Promise<void> {
  await page.addInitScript(() => { try { localStorage.setItem('dhan_algo.selected_broker', 'zerodha'); } catch { /* ignore */ } });
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    const body = method === 'GET' ? null : (req.postDataJSON() as Record<string, unknown> | null);
    const record = () => m.calls.push({ method, path: p, search: u.search, body });
    if (touchesDhanAccount(p, u.searchParams, body)) m.dhan.push(`${method} ${p}${u.search}`);

    if (p === '/api/auth/broker-status') return json(route, { dhan: true, zerodha: true, kotak: false });
    if (p === '/api/options/expiries') return json(route, { success: true, data: ['2026-10-19', '2026-10-27'] });
    if (p === '/api/options/chain') {
      const oc = Object.fromEntries(STRIKES.map(k => [`${k}.000000`, { ce: { previous_close_price: 100 }, pe: { previous_close_price: 90 } }]));
      return json(route, { success: true, data: { spot: 23150, prev_close: 23000, chain: { oc } } });
    }
    if (p === '/api/scalper/zerodha/lookup') {
      const strikes = Object.fromEntries(STRIKES.map(k => [k, { ceSymbol: k === '23150' ? ON_SCREEN : `NIFTY26O19${k}CE`, peSymbol: `NIFTY26O19${k}PE` }]));
      return json(route, { success: true, data: { lotSize: 65, strikes } });
    }
    if (p === '/api/scalper/zerodha/symbol-lookup') {
      return json(route, { success: true, data: u.searchParams.get('underlying') === 'NIFTY' ? SYMBOLS : {} });
    }
    if (p === '/api/options/live') {
      if (method === 'POST') { record(); return json(route, { success: true }); }
      const strikes = Object.fromEntries(STRIKES.map(k => [k, { strike: Number(k), ce: { ltp: k === '23150' ? 110.5 : 90 }, pe: { ltp: 80 } }]));
      return json(route, {
        success: true, status: { status: 'RUNNING' },
        quotes: {
          underlying: 'NIFTY', expiry: '2026-10-19', spot: 23150, atm: 23150, straddle_premium: 190.5,
          updated_at: new Date().toISOString(), strikes, contracts: { [OFF_EXPIRY]: { ltp: 37.05 } },
        },
      });
    }
    if (p === '/api/scalper/zerodha/all' || p === '/api/scalper/zerodha/poll') {
      return json(route, { success: true, positions: m.positions, orders: [], trades: [], funds: { availabelBalance: 500000 }, pnl_guard: null });
    }
    if (p === '/api/scalper/zerodha/positions') return json(route, { success: true, data: m.positions });
    if (p === '/api/scalper/zerodha/funds') return json(route, { success: true, data: { availabelBalance: 500000 } });
    if (p === '/api/scalper/zerodha/guards') {
      if (method === 'GET') return json(route, { success: true, sessionValid: true, state: m.guard });
      record();
      if (body?.action === 'setPnl') m.guard = { ...m.guard, pnl: { profit: body.profit, loss: body.loss, products: body.products, date: m.guard.date } };
      return json(route, { success: true, id: body?.action === 'addBracket' ? 'zb_test' : undefined, state: m.guard });
    }
    if (p === '/api/scalper/zerodha/order' || p === '/api/scalper/zerodha/exit-all') {
      record();
      if (p.endsWith('/order') && m.orderReply) { const r = m.orderReply(body); return json(route, r.body, r.status); }
      return json(route, p.endsWith('exit-all') ? { success: true, closed: ['x'], errors: [], skipped: [] } : { success: true, order_id: 'Z1' });
    }
    if (p === '/api/scalper/mtm-history') return json(route, { success: false, error: 'e2e' });
    if (p === '/api/pnl-exit' && method === 'GET') return json(route, { success: false, error: 'e2e' }, 500);
    if (method === 'POST' && (p === '/api/live-indices' || p === '/api/live-equity')) return json(route, { success: true });

    if (method !== 'GET') {
      m.blocked.push({ method, path: p, search: u.search, body });
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' });
    }
    return route.continue();
  });
}

let m: ZerodhaMock;
const orders = () => m.calls.filter(c => c.path === '/api/scalper/zerodha/order');
const row = (page: Page, sym: string) => page.locator('tr', { has: page.getByText(sym, { exact: true }) });

test.afterEach(() => {
  expect(m.blocked.map(c => `${c.method} ${c.path}`), 'an unmocked write was attempted').toEqual([]);
  expect(m.dhan, 'a Dhan-account route was called on a Zerodha page').toEqual([]);
  expect(m.calls.filter(c => /\/api\/(scalper\/(fast-order|order)|super-order|exit-all|pnl-exit)$/.test(c.path) && c.method !== 'GET')).toEqual([]);
});

test.beforeEach(async ({ page, context }) => {
  m = {
    calls: [], blocked: [], dhan: [], positions: [kiteRow(ON_SCREEN, -130, 120), kiteRow(OFF_EXPIRY, -390, 36.75)],
    guard: { date: '2026-10-19', pnl: null, brackets: [], watch: [], events: [] },
  };
  await signIn(context);
  await installMock(page, m);
  await page.goto('/advanced-scalper', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'BUY CE' }).first().waitFor({ timeout: 60_000 });
  await expect(row(page, OFF_EXPIRY)).toBeVisible({ timeout: 30_000 });
});

test('legs are priced from Dhan and dated from the instrument cache, never from Kite\'s last_price', async ({ page }) => {
  const on = row(page, ON_SCREEN);
  await expect(on).toContainText('110.50');
  await expect(on).toContainText('1235');                 // (120 − 110.50) × 130
  const off = row(page, OFF_EXPIRY);
  await expect(off).toContainText('2026-10-27');
  await expect(off).toContainText('37.05');
  await expect(off).toContainText('-117');                // (36.75 − 37.05) × 390
  await expect(page.getByText(String(KITE_LAST_PRICE), { exact: false })).toHaveCount(0);
  const watch = m.calls.filter(c => c.path === '/api/options/live' && c.body?.action === 'watchContracts').at(-1);
  expect(watch?.body?.requests).toEqual(expect.arrayContaining([
    { key: OFF_EXPIRY, underlying: 'NIFTY', expiry: '2026-10-27', strike: 22500, side: 'PE' },
  ]));
});

test('BUY CE sends a Zerodha market order by trading symbol on NFO, NRML on MARGIN, capped by source', async ({ page }) => {
  await page.getByRole('button', { name: 'BUY CE' }).first().click();
  await expect.poll(() => orders().length).toBe(1);
  expect(orders()[0].body).toEqual({ tradingsymbol: ON_SCREEN, quantity: 65, side: 'BUY', orderType: 'MARKET', exchange: 'NFO', product: 'NRML', source: 'as' });
});

test('a close carries no source, so the server-side lot cap can never refuse it', async ({ page }) => {
  await row(page, OFF_EXPIRY).getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(() => orders().length).toBe(1);
  expect(orders()[0].body).toMatchObject({ tradingsymbol: OFF_EXPIRY, quantity: 390, side: 'BUY', exchange: 'NFO', product: 'NRML' });
  expect(orders()[0].body).not.toHaveProperty('source');
});

test('EXIT ALL needs a confirm click and uses the Zerodha F&O exit', async ({ page }) => {
  const exitAll = page.getByRole('button', { name: /EXIT ALL Positions|Confirm EXIT ALL/ });
  await exitAll.click();
  await page.waitForTimeout(300);
  expect(m.calls.filter(c => c.path === '/api/scalper/zerodha/exit-all')).toHaveLength(0);
  await exitAll.click();
  await expect.poll(() => m.calls.filter(c => c.path === '/api/scalper/zerodha/exit-all').length).toBe(1);
});

test('P&L Guard is available and registers with the Zerodha server guard, not Dhan pnl-exit', async ({ page }) => {
  await expect(page.getByText('DHAN ONLY')).toHaveCount(0);
  const target = page.getByPlaceholder('e.g. 5000').first();
  await target.fill('3000'); await target.press('Enter');
  const sl = page.getByPlaceholder('e.g. 2000').first();
  await sl.fill('1500'); await sl.press('Enter');
  await page.getByRole('button', { name: 'Set Guard' }).first().click();
  await expect.poll(() => m.calls.filter(c => c.body?.action === 'setPnl').length).toBe(1);
  expect(m.calls.find(c => c.body?.action === 'setPnl')?.body).toMatchObject({ action: 'setPnl', profit: 3000, loss: 1500 });
});

test('bracket: an opening order is registered with the server BEFORE it goes out', async ({ page }) => {
  await page.getByRole('button', { name: /^BRACKET (ON|OFF)/ }).click();
  await expect(page.getByRole('button', { name: 'BRACKET ON · SERVER' })).toBeVisible();
  await page.getByRole('button', { name: 'BUY PE' }).first().click();
  await expect.poll(() => orders().length).toBe(1);
  const regAt = m.calls.findIndex(c => c.body?.action === 'addBracket');
  const orderAt = m.calls.findIndex(c => c.path === '/api/scalper/zerodha/order');
  expect(regAt).toBeGreaterThanOrEqual(0);
  expect(regAt).toBeLessThan(orderAt);
  expect(m.calls[regAt].body).toMatchObject({ symbol: 'NIFTY26O1923150PE', dir: 1, target: 90, sl: 72, product: 'MARGIN', qtyBefore: 0 });
});

test('bracket: an entry whose order is UNKNOWN keeps its server bracket', async ({ page }) => {
  m.orderReply = () => ({ status: 504, body: { success: false, unknown: true, error: 'Order status unknown - Zerodha did not confirm in time.' } });
  await page.getByRole('button', { name: /^BRACKET (ON|OFF)/ }).click();
  await page.getByRole('button', { name: 'BUY PE' }).first().click();
  await expect.poll(() => orders().length).toBe(1);
  await expect(page.getByText(/BUY PE: order status UNKNOWN/).first()).toBeVisible();
  await page.waitForTimeout(1_500);
  expect(m.calls.filter(c => c.body?.action === 'removeBracket')).toHaveLength(0);
});

test('bracket: an entry the broker cleanly REJECTS withdraws its bracket', async ({ page }) => {
  m.orderReply = () => ({ status: 200, body: { success: false, error: 'Insufficient funds' } });
  await page.getByRole('button', { name: /^BRACKET (ON|OFF)/ }).click();
  await page.getByRole('button', { name: 'BUY PE' }).first().click();
  await expect.poll(() => m.calls.filter(c => c.body?.action === 'removeBracket').length).toBe(1);
});

test('Add on a leg of another expiry opens the Add Lots modal on that expiry instead of refusing', async ({ page }) => {
  await row(page, OFF_EXPIRY).getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(/Expiry 2026-10-27/)).toBeVisible();
  await expect(page.getByText('Could not resolve this position’s contract')).toHaveCount(0);
  expect(orders()).toHaveLength(0);
});
