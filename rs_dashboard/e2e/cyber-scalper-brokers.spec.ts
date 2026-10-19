import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { json, signIn } from './support';

// Cyber Scalper futures on Kotak and Zerodha (CRUDEOILM). Every /api call is answered in the browser, so nothing reaches
// a broker; any non-GET this file does not handle is refused (599) and fails the test. Proves: the broker is offered,
// the expiry switcher resolves THAT broker's contract for the month shown, the order goes to that broker's own route
// with its own symbol / exchange / quantity, the P&L of an open position is right, and FLATTEN hits that broker's exit-all.

const FEED = JSON.parse(readFileSync(`${process.cwd()}/e2e/fixtures/cyber-feed-crudeoilm.json`, 'utf8')) as Record<string, any>;

const MONTH = { '2026-10-19': 'OCT', '2026-11-19': 'NOV', '2026-12-18': 'DEC' } as const;
const CASES = [
  { broker: 'zerodha', label: 'Zerodha', sym: (m: string) => `CRUDEOILM26${m}FUT`, exchange: 'MCX', qty: 1, posExchange: 'MCX', posQty: 1 },
  { broker: 'kotak', label: 'Kotak', sym: (m: string) => `CRUDEOILM19${m}26FUT`, exchange: 'mcx_fo', qty: 10, posExchange: 'mcx_fo', posQty: 10 },
] as const;

async function install(page: Page, c: (typeof CASES)[number]) {
  const sent: { path: string; body: Record<string, unknown> | null }[] = [];
  const blocked: string[] = [];
  const lookups: string[] = [];
  const NOV = c.sym('NOV');
  await page.addInitScript((b) => { try { localStorage.setItem('dhan_algo.selected_broker', b); } catch { /* ignore */ } }, c.broker);

  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();
    if (p === '/api/auth/broker-status') return json(route, { dhan: true, zerodha: true, kotak: true });
    if (p === '/api/cyber-scalper/feed') {
      const fe = url.searchParams.get('futureExpiry') ?? FEED.future.expiry;
      const month = MONTH[fe as keyof typeof MONTH] ?? 'OCT';
      return json(route, { ...FEED, future: { ...FEED.future, expiry: fe, display_name: `CRUDEOILM ${month} FUT`, ltp: month === 'NOV' ? 9340 : 9580 } });
    }
    if (p === `/api/scalper/${c.broker}/lookup`) {
      lookups.push(url.search);
      const fe = url.searchParams.get('futureExpiry') ?? '2026-10-19';
      const month = MONTH[fe as keyof typeof MONTH];
      const future = month ? { trading_symbol: c.sym(month), expiry: fe, lot_size: c.qty, exchange_segment: c.exchange } : null;
      return json(route, { success: true, data: { lotSize: c.qty, strikes: {}, future } });
    }
    if (p === `/api/scalper/${c.broker}/poll`) {
      const pos = { tradingSymbol: NOV, securityId: '1', exchange: c.posExchange, exchangeSegment: c.posExchange, netQty: c.posQty, buyQty: c.posQty, sellQty: 0,
        buyAvg: 9340, sellAvg: 0, lastTradedPrice: 9350, realizedProfit: 0, unrealizedProfit: 100, productType: 'NRML' };
      return json(route, { success: true, positions: [pos], positionsError: null, orders: [], trades: [] });
    }
    if (p === `/api/scalper/${c.broker}/funds`) return json(route, { success: true, data: { availabelBalance: 250000 } });
    if (p === `/api/scalper/${c.broker}/orders` && method === 'GET') return json(route, { success: true, data: [] });
    if (p === `/api/scalper/${c.broker}/order` && method === 'POST') { sent.push({ path: p, body: req.postDataJSON() }); return json(route, { success: true, order_id: 'E2E-1' }); }
    if (p === `/api/scalper/${c.broker}/exit-all` && method === 'POST') { sent.push({ path: p, body: null }); return json(route, { success: true, closed: [NOV], errors: [] }); }
    if (method === 'GET') return json(route, { success: false, error: 'e2e' }, 503);
    blocked.push(`${method} ${p}`);
    return route.fulfill({ status: 599, body: 'blocked by e2e' });
  });
  return { sent, blocked, lookups };
}

test.beforeEach(async ({ context }) => { await signIn(context); });

for (const c of CASES) {
  test(`${c.label}: CRUDEOILM futures — the NOV contract is resolved, ordered and flattened on ${c.label} only`, async ({ page }) => {
    const seen = await install(page, c);
    page.on('dialog', (d) => { void d.accept(); });
    await page.goto('/cyber-scalper', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('button', { name: c.label, exact: true })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'CRUDEOILM', exact: true }).click();
    await expect(page.getByText(c.sym('OCT')).first()).toBeVisible({ timeout: 60_000 });

    await page.getByRole('button', { name: 'NOV', exact: true }).click();
    await expect(page.getByText(`${c.sym('NOV')} · Exp 2026-11-19`)).toBeVisible({ timeout: 60_000 });
    // The lookup asked for the month on screen, never the nearest.
    expect(seen.lookups.some((s) => s.includes('futureExpiry=2026-11-19'))).toBe(true);

    // An open position: its P&L is right (10 points x 1 lot x 10 barrels = 100 on either broker's quantity unit).
    // Zerodha: 10 points x 1 lot x 10 barrels. Kotak: 10 points x 10 barrels x 1. Reading the header MTM.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('MTM+₹100', { timeout: 30_000 });

    await page.getByRole('button', { name: /LONG FUTURE/ }).click();
    await expect.poll(() => seen.sent.filter((s) => s.path.endsWith('/order')).length, { timeout: 30_000 }).toBe(1);
    expect(seen.sent[0].body).toMatchObject({ tradingsymbol: c.sym('NOV'), side: 'BUY', quantity: c.qty, exchange: c.exchange, product: 'NRML' });

    await page.getByRole('button', { name: /FLATTEN/ }).first().click();   // the pad's and the positions panel's
    await expect.poll(() => seen.sent.some((s) => s.path === `/api/scalper/${c.broker}/exit-all`), { timeout: 30_000 }).toBe(true);
    expect(seen.blocked).toEqual([]);   // in particular: no /api/exit-all (Dhan's sweep) and no other broker's order route
  });
}

// ── Kotak option position pricing ─────────────────────────────────────────────────────────────────────────────
// Kotak's positions carry NO price (lib/kotakShape.ts), so the terminal must price an open option from somewhere real.
// It used to fall back to the index SPOT for any option on the selected underlying, which marked a 100-rupee call at
// ~24,500 and let the target/SL guard "hit" at once.
async function installKotakOption(page: Page, ltpFromServer: number) {
  const sent: string[] = [];
  const blocked: string[] = [];
  await page.addInitScript(() => { try { localStorage.setItem('dhan_algo.selected_broker', 'kotak'); } catch { /* ignore */ } });
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();
    if (p === '/api/auth/broker-status') return json(route, { dhan: true, kotak: true });
    if (p === '/api/cyber-scalper/feed') return json(route, { ...FEED, symbol: 'NIFTY', spot: 24500, options: null, future: null });
    if (p === '/api/scalper/kotak/poll') {
      sent.push(url.search);
      const pos = { tradingSymbol: 'NIFTY26OCT24600CE', securityId: '1', exchange: 'nse_fo', exchangeSegment: 'nse_fo', netQty: 65, buyQty: 65, sellQty: 0,
        buyAvg: 100, sellAvg: 0, lastTradedPrice: url.searchParams.get('ltp') === '1' ? ltpFromServer : 0, realizedProfit: 0, unrealizedProfit: 0, productType: 'MIS' };
      return json(route, { success: true, positions: [pos], positionsError: null, orders: [], trades: [] });
    }
    if (p === '/api/scalper/kotak/funds') return json(route, { success: true, data: { availabelBalance: 250000 } });
    if (p === '/api/scalper/kotak/orders' && method === 'GET') return json(route, { success: true, data: [] });
    if (method === 'GET') return json(route, { success: false, error: 'e2e' }, 503);
    blocked.push(`${method} ${p}`);                      // an auto-exit from a phantom price would POST an order here
    return route.fulfill({ status: 599, body: 'blocked by e2e' });
  });
  return { sent, blocked };
}

test('Kotak: an open option is priced from the server join, never from the index spot', async ({ page }) => {
  const seen = await installKotakOption(page, 105);
  await page.goto('/cyber-scalper', { waitUntil: 'domcontentloaded' });
  // (105 - 100) x 65 = 325
  await expect(page.getByRole('heading', { level: 1 })).toContainText('MTM+₹325', { timeout: 60_000 });
  expect(seen.sent.some((s) => s.includes('ltp=1'))).toBe(true);
  expect(seen.blocked).toEqual([]);
});

test('Kotak: an option with no price shows no P&L instead of marking it at the index spot', async ({ page }) => {
  const seen = await installKotakOption(page, 0);
  await page.goto('/cyber-scalper', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('MTM', { timeout: 60_000 });
  await page.waitForTimeout(3000);
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText('₹1,5');   // 24500 - 100 would be ~₹15.9 lakh
  await expect(page.getByRole('heading', { level: 1 })).toContainText('MTM+₹0');
  expect(seen.blocked).toEqual([]);
});

// ── A failed position read is "unknown", not "flat" ─────────────────────────────────────────────────────────────
test('Zerodha: a poll whose position read failed keeps the open position on screen (guards and FLATTEN stay)', async ({ page }) => {
  const c = CASES[0];
  let polls = 0;
  await page.addInitScript(() => { try { localStorage.setItem('dhan_algo.selected_broker', 'zerodha'); } catch { /* ignore */ } });
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === '/api/auth/broker-status') return json(route, { dhan: true, zerodha: true });
    if (p === '/api/cyber-scalper/feed') return json(route, FEED);
    if (p === '/api/scalper/zerodha/poll') {
      polls++;
      const pos = { tradingSymbol: c.sym('NOV'), securityId: '1', exchange: 'MCX', exchangeSegment: 'MCX', netQty: 1, buyQty: 1, sellQty: 0,
        buyAvg: 9340, sellAvg: 0, lastTradedPrice: 9350, realizedProfit: 0, unrealizedProfit: 100, productType: 'NRML' };
      return polls <= 2
        ? json(route, { success: true, positions: [pos], positionsError: null, orders: [], trades: [] })
        : json(route, { success: true, positions: [], positionsError: 'Kite session expired', orders: [], trades: [] });
    }
    if (p === '/api/scalper/zerodha/funds') return json(route, { success: true, data: { availabelBalance: 1 } });
    if (req.method() === 'GET') return json(route, { success: false, error: 'e2e' }, 503);
    return route.fulfill({ status: 599, body: 'blocked by e2e' });
  });
  await page.goto('/cyber-scalper', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('MTM+₹100', { timeout: 60_000 });
  await expect.poll(() => polls, { timeout: 30_000 }).toBeGreaterThan(4);        // several failing polls have gone by
  await expect(page.getByRole('heading', { level: 1 })).toContainText('MTM+₹100');
  await expect(page.getByRole('button', { name: /FLATTEN/ }).first()).toBeVisible();
});

// ── Dhan flow: order outcomes, flatten result, guard retry ─────────────────────────────────────────────────────
async function installDhan(page: Page, opts: { orderReplies: (n: number, body: Record<string, unknown>) => { status: number; body: unknown }; positions?: Record<string, unknown>[] }) {
  const orders: Record<string, unknown>[] = [];
  const hits: string[] = [];
  const blocked: string[] = [];
  await page.addInitScript(() => { try { localStorage.setItem('dhan_algo.selected_broker', 'dhan'); } catch { /* ignore */ } });
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const method = req.method();
    if (p === '/api/auth/broker-status') return json(route, { dhan: true });
    if (p === '/api/cyber-scalper/feed') return json(route, FEED);
    if (p === '/api/scalper/poll') return json(route, { success: true, positions: opts.positions ?? [], positionsError: null, orders: [], trades: [] });
    if (p === '/api/scalper/funds') return json(route, { success: true, data: { availabelBalance: 250000 } });
    if (p === '/api/scalper/orders' && method === 'GET') return json(route, { success: true, data: [] });
    if (p === '/api/scalper/fast-order' && method === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>;
      orders.push(body);
      const r = opts.orderReplies(orders.length, body);
      return json(route, r.body, r.status);
    }
    if (p === '/api/exit-all' && method === 'POST') { hits.push(p); return json(route, { success: true, broker_exit: true, killed: [], trigger_fallback: [] }); }
    if (method === 'GET') return json(route, { success: false, error: 'e2e' }, 503);
    blocked.push(`${method} ${p}`);
    return route.fulfill({ status: 599, body: 'blocked by e2e' });
  });
  return { orders, hits, blocked };
}

const DHAN_POS = { tradingSymbol: 'CRUDEOILM', securityId: '573423', exchangeSegment: 'MCX_COMM', netQty: 1, buyQty: 1, sellQty: 0, buyAvg: 9340, sellAvg: 0,
  costPrice: 9340, realizedProfit: 0, unrealizedProfit: 60, productType: 'MARGIN' };   // Dhan reports MCX P&L in lots, without the x10

test('Dhan: an order with an UNKNOWN outcome is reported as unknown and blocks a blind retry', async ({ page }) => {
  const seen = await installDhan(page, { orderReplies: () => ({ status: 504, body: { success: false, unknown: true, error: 'No clean reply from Dhan' } }) });
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });
  await page.goto('/cyber-scalper', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'CRUDEOILM', exact: true }).click();
  await expect(page.getByRole('button', { name: /LONG FUTURE/ })).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: /LONG FUTURE/ }).click();
  await expect.poll(() => seen.orders.length, { timeout: 30_000 }).toBe(1);
  expect(seen.orders[0]).toMatchObject({ securityId: expect.any(String), side: 'BUY', quantity: 1, exchangeSegment: 'MCX_COMM', idempotencyKey: expect.stringMatching(/^cs-/) });
  await expect.poll(() => dialogs.some((m) => /UNKNOWN/.test(m)), { timeout: 15_000 }).toBe(true);   // not "Order Failed"
  expect(dialogs.some((m) => /Order Failed/.test(m))).toBe(false);

  await page.getByRole('button', { name: /LONG FUTURE/ }).click();                                    // the held retry
  await page.waitForTimeout(1500);
  expect(seen.orders).toHaveLength(1);
  expect(seen.blocked).toEqual([]);
});

test('Dhan: FLATTEN reports success from the exit-all reply (it has `success`, not `ok`)', async ({ page }) => {
  const seen = await installDhan(page, { orderReplies: () => ({ status: 200, body: { success: true, order_id: '1' } }), positions: [DHAN_POS] });
  page.on('dialog', (d) => { void d.accept(); });
  await page.goto('/cyber-scalper', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'CRUDEOILM', exact: true }).click();
  await page.getByRole('button', { name: /FLATTEN/ }).first().click({ timeout: 60_000 });
  await expect.poll(() => seen.hits.length, { timeout: 30_000 }).toBe(1);
  await expect(page.getByText('ALL F&O POSITIONS FLATTENED CLEANLY')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Emergency exit warning/)).toHaveCount(0);
});

test('Dhan: a target/stop exit that was refused is retried, not left disarmed', async ({ page }) => {
  // Open long CRUDEOILM at 9340, price 9400 (derived from Dhan's lot-based P&L x10): a 30-point target is already hit.
  const seen = await installDhan(page, {
    orderReplies: (n) => (n === 1 ? { status: 400, body: { success: false, error: 'RMS: refused' } } : { status: 200, body: { success: true, order_id: `ok-${n}` } }),
    positions: [DHAN_POS],
  });
  page.on('dialog', (d) => { void d.accept(); });
  await page.goto('/cyber-scalper', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'CRUDEOILM', exact: true }).click();
  // Arm a target on the open row through the positions table.
  await page.getByRole('button', { name: 'ALL BROKER' }).first().click({ timeout: 60_000 });   // the row was not placed from this terminal
  const target = page.getByPlaceholder('TP Price').first();
  await target.fill('9370');
  await target.blur();
  await expect.poll(() => seen.orders.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(() => seen.orders.length, { timeout: 40_000 }).toBeGreaterThanOrEqual(2);       // the refused exit is sent again
  expect(seen.orders[1]).toMatchObject({ side: 'SELL', quantity: 1, securityId: '573423' });
  expect(seen.blocked).toEqual([]);
});
