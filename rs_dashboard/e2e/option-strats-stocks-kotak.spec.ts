import { expect, test, type Page, type Route } from '@playwright/test';
import { json, signIn, type Call } from './support';

// Option Strats – Stocks (/option-strats-stocks) placing a stock-option spread on KOTAK (and still on DHAN), every
// /api/* call mocked; nothing reaches a broker and any unexpected write fails the test. The chain, expiries and spot
// stay Dhan's; Kotak supplies its own contracts and lot size.

const U = 'ADANIENT';          // the page's default underlying (NIFTY50_SYMBOLS[0])
const EXP = '2026-10-27';
const STRIKES = [2400, 2420, 2440, 2460, 2480];
const LOT = 300;
const kSym = (k: number, o: 'CE' | 'PE') => `${U}26OCT${k}${o}`;
const dId = (k: number, o: 'CE' | 'PE') => `${k}${o === 'CE' ? 1 : 2}`;

interface Mock {
  calls: Call[];
  blocked: Call[];
  /** Reply per contract for its next order: booked (default), 'reject', or 'unknown' (504, may be live). */
  next: Map<string, 'reject' | 'unknown'>;
  /** Kotak's lot size from its lookup (null = the lookup has none). */
  kotakLot: number | null;
}

async function install(page: Page, m: Mock, broker: 'dhan' | 'kotak') {
  await page.addInitScript((b: string) => { try { localStorage.setItem('optionStratsStocks.broker', b); } catch { /* ignore */ } }, broker);
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    const body = method === 'GET' ? null : (req.postDataJSON() as Record<string, unknown> | null);
    m.calls.push({ method, path: p, search: u.search, body });

    if (p === '/api/auth/broker-status') return json(route, { dhan: true, zerodha: false, kotak: true });
    if (p === '/api/options/expiries') return json(route, { success: true, data: [EXP] });
    if (p === '/api/lotsize') return json(route, { lot_size: LOT });
    if (p === '/api/options/spot') return json(route, { spot: 2441 });
    if (p === '/api/options/chain') {
      const oc = Object.fromEntries(STRIKES.map(k => [`${k}.000000`, { ce: { last_price: 40 }, pe: { last_price: 38 } }]));
      return json(route, { success: true, data: { spot: 2441, chain: { oc } } });
    }
    if (p === '/api/options/margin') return json(route, { success: false, error: 'e2e' });
    if (p === '/api/scalper/lookup') return json(route, { success: true, data: { lotSize: LOT, strikes: Object.fromEntries(STRIKES.map(k => [String(k), { ceId: dId(k, 'CE'), peId: dId(k, 'PE') }])) } });
    if (p === '/api/scalper/kotak/lookup') return json(route, { success: true, data: { lotSize: m.kotakLot, strikes: Object.fromEntries(STRIKES.map(k => [String(k), { ceSymbol: kSym(k, 'CE'), peSymbol: kSym(k, 'PE') }])) } });
    if (method === 'POST' && (p === '/api/scalper/kotak/order' || p === '/api/scalper/fast-order')) {
      const c = String(body?.tradingsymbol ?? body?.securityId);
      const mode = m.next.get(c);
      m.next.delete(c);
      if (mode === 'reject') return json(route, { success: false, error: 'e2e: RMS reject' });
      if (mode === 'unknown') return json(route, { success: false, unknown: true, error: 'e2e: no reply' }, 504);
      return json(route, { success: true, order_id: `O${m.calls.length}` });
    }
    if (method !== 'GET') {
      m.blocked.push({ method, path: p, search: u.search, body });
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' });
    }
    return json(route, { success: false, error: 'e2e: not mocked' });
  });
}

const orders = (m: Mock) => m.calls.filter(c => c.method === 'POST' && (c.path === '/api/scalper/kotak/order' || c.path === '/api/scalper/fast-order'));

/** ATM CE SELL + ATM PE BUY (the hedge, so it goes first). */
async function buildSpread(page: Page) {
  await page.goto('/option-strats-stocks', { waitUntil: 'domcontentloaded' });
  const add = page.getByRole('button', { name: /Add Leg/ });
  await expect(add).toBeEnabled({ timeout: 90_000 });
  // Add Leg picks the strike nearest spot off the chain: wait for the chain to have been read.
  await expect.poll(() => m.calls.some(c => c.path === '/api/options/chain'), { timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(500);
  await add.click();
  await add.click();
  await page.getByRole('button', { name: 'BUY', exact: true }).nth(1).click();
}
async function place(page: Page) {
  const btn = page.getByRole('button', { name: /^(Place Trade|Confirm 2 legs\?)$/ });
  await btn.click();
  await expect(btn).toHaveText('Confirm 2 legs?');
  await btn.click();
}

let m: Mock;
test.beforeEach(async ({ context }) => {
  m = { calls: [], blocked: [], next: new Map(), kotakLot: LOT };
  await signIn(context);
});
test.afterEach(() => { expect(m.blocked.map(c => `${c.method} ${c.path}`), 'an unmocked write was attempted').toEqual([]); });

test('Kotak: the spread goes to Kotak by trading symbol, hedge first, sized off Kotak\'s lot', async ({ page }) => {
  await install(page, m, 'kotak');
  await buildSpread(page);
  await place(page);
  await expect.poll(() => orders(m).length).toBe(2);
  expect(orders(m).map(o => o.path)).toEqual(['/api/scalper/kotak/order', '/api/scalper/kotak/order']);
  expect(orders(m)[0].body).toMatchObject({ tradingsymbol: kSym(2440, 'PE'), side: 'BUY', quantity: LOT, exchange: 'nse_fo', product: 'NRML' });
  expect(orders(m)[1].body).toMatchObject({ tradingsymbol: kSym(2440, 'CE'), side: 'SELL', quantity: LOT });
  // Contract handles from Kotak's lookup only — never Dhan's.
  expect(m.calls.some(c => c.path === '/api/scalper/lookup')).toBe(false);
});

test('Kotak: a SELL whose order is UNKNOWN stops the trade and reverses NOTHING (no naked short)', async ({ page }) => {
  m.next.set(kSym(2440, 'CE'), 'unknown');
  await install(page, m, 'kotak');
  await buildSpread(page);
  await place(page);
  await expect(page.getByText(/order status UNKNOWN — trade stopped, nothing reversed/).first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2_000);
  // Before the fix: a third order reversing the hedge, leaving the SELL naked if it had filled.
  expect(orders(m)).toHaveLength(2);
});

test('Kotak: a clean rejection still reverses what was placed', async ({ page }) => {
  m.next.set(kSym(2440, 'CE'), 'reject');
  await install(page, m, 'kotak');
  await buildSpread(page);
  await place(page);
  await expect.poll(() => orders(m).length).toBe(3);
  expect(orders(m)[2].body).toMatchObject({ tradingsymbol: kSym(2440, 'PE'), side: 'SELL', quantity: LOT });
});

test('Kotak: no Kotak lot size, no order (never the 1-unit display fallback)', async ({ page }) => {
  m.kotakLot = null;
  await install(page, m, 'kotak');
  await buildSpread(page);
  await place(page);
  await expect(page.getByText(/Lot size not resolved/).first()).toBeVisible();
  expect(orders(m)).toHaveLength(0);
});

test('Dhan: unchanged — security ids through fast-order', async ({ page }) => {
  await install(page, m, 'dhan');
  await buildSpread(page);
  await place(page);
  await expect.poll(() => orders(m).length).toBe(2);
  expect(orders(m)[0]).toMatchObject({ path: '/api/scalper/fast-order', body: { securityId: dId(2440, 'PE'), side: 'BUY', quantity: LOT } });
  expect(m.calls.some(c => c.path.startsWith('/api/scalper/kotak/'))).toBe(false);
});
