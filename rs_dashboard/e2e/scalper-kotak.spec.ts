import { expect, test, type Page, type Route } from '@playwright/test';
import { json, signIn, type Call } from './support';

// The Advanced Scalper on KOTAK, end to end in the browser with every broker-backed route mocked (nothing reaches
// Kotak or Dhan's order APIs: an unmocked write is refused with 599 and fails the test).
//
// The book is the 2026-10-17 shape: an on-screen NIFTY leg (priced from the chain), an off-expiry NIFTY leg, and a
// CRUDEOILM option + future on another underlying (both priced from the bridge's per-contract bucket).

const ON_SCREEN = 'NIFTY26O1923150CE';
const POSITIONS = () => [
  kotakRow(ON_SCREEN, 'nse_fo', -130, 120),
  kotakRow('NIFTY26OCT22500PE', 'nse_fo', -390, 36.75),
  kotakRow('CRUDEOILM17NOV268800PE', 'mcx_fo', -140, 286.75),
  kotakRow('CRUDEOILM19NOV26FUT', 'mcx_fo', -150, 9393),
];

/** A position as /api/scalper/kotak/* returns it (already through shapeKotakPosition: LTP unknown). */
function kotakRow(tradingSymbol: string, exchange: string, netQty: number, avg: number) {
  const q = Math.abs(netQty);
  return {
    tradingSymbol, securityId: '1', exchange, netQty, productType: 'NRML', lotSize: exchange === 'mcx_fo' ? 10 : 65,
    buyQty: netQty > 0 ? q : 0, sellQty: netQty < 0 ? q : 0,
    buyAvg: netQty > 0 ? avg : 0, sellAvg: netQty < 0 ? avg : 0,
    lastTradedPrice: 0, realizedProfit: 0, unrealizedProfit: 0,
  };
}

const SYMBOLS: Record<string, Record<string, { expiry: string; strike: number; side: 'CE' | 'PE' | 'FUT' }>> = {
  NIFTY: {
    [ON_SCREEN]: { expiry: '2026-10-19', strike: 23150, side: 'CE' },
    NIFTY26O1923150PE: { expiry: '2026-10-19', strike: 23150, side: 'PE' },
    NIFTY26OCT22500PE: { expiry: '2026-10-27', strike: 22500, side: 'PE' },
  },
  CRUDEOILM: {
    CRUDEOILM17NOV268800PE: { expiry: '2026-11-17', strike: 8800, side: 'PE' },
    CRUDEOILM19NOV26FUT: { expiry: '2026-11-19', strike: 0, side: 'FUT' },
  },
};
const STRIKES = ['23100', '23150', '23200'];

interface KotakMock {
  calls: Call[];
  blocked: Call[];
  /** Every request to a DHAN-account route, reads included — a page saved on Kotak must make none. */
  dhan: string[];
  positions: Record<string, unknown>[];
  guard: { date: string; pnl: unknown; brackets: unknown[]; watch: unknown[]; events: unknown[] };
  /** Scripted reply for the next Kotak order POSTs (default: booked). */
  orderReply?: (body: Record<string, unknown> | null) => { status: number; body: unknown };
}

/** Routes that read or act on the DHAN account (Kotak's own live under /api/scalper/kotak/). */
const DHAN_ACCOUNT_ROUTE = /^\/api\/(scalper\/(all|poll|positions|trades|funds|orders|lookup|fast-order|order)|pnl-exit|super-order(\/.*)?|exit-all)$/;

/** A request that reads or acts on the Dhan ACCOUNT. Dhan MARKET DATA is allowed (prices are Dhan-only by design):
 *  /api/options/live?broker=dhan is the Dhan quote bridge, not the account. mtm-history names its broker in the body. */
function touchesDhanAccount(p: string, q: URLSearchParams, body: Record<string, unknown> | null): boolean {
  if (DHAN_ACCOUNT_ROUTE.test(p)) return true;
  if (p === '/api/scalper/mtm-history') return String(body?.broker ?? 'dhan') === 'dhan';
  return q.get('broker') === 'dhan' && p !== '/api/options/live';
}

async function installKotakMock(page: Page, m: KotakMock): Promise<void> {
  await page.addInitScript(() => { try { localStorage.setItem('dhan_algo.selected_broker', 'kotak'); } catch { /* ignore */ } });
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    const body = method === 'GET' ? null : (req.postDataJSON() as Record<string, unknown> | null);
    const record = () => m.calls.push({ method, path: p, search: u.search, body });
    if (touchesDhanAccount(p, u.searchParams, body)) m.dhan.push(`${method} ${p}${u.search}`);

    if (p === '/api/auth/broker-status') return json(route, { dhan: true, zerodha: false, kotak: true });
    if (p === '/api/options/expiries') return json(route, { success: true, data: ['2026-10-19', '2026-10-27'] });
    if (p === '/api/options/chain') {
      const oc = Object.fromEntries(STRIKES.map(k => [`${k}.000000`, { ce: { previous_close_price: 100 }, pe: { previous_close_price: 90 } }]));
      return json(route, { success: true, data: { spot: 23150, prev_close: 23000, chain: { oc } } });
    }
    if (p === '/api/scalper/kotak/lookup') {
      const strikes = Object.fromEntries(STRIKES.map(k => [k, { ceSymbol: k === '23150' ? ON_SCREEN : `NIFTY26O19${k}CE`, peSymbol: `NIFTY26O19${k}PE` }]));
      return json(route, { success: true, data: { lotSize: 65, strikes, exchangeSegment: 'nse_fo', future: null } });
    }
    if (p === '/api/scalper/kotak/symbol-lookup') {
      return json(route, { success: true, data: SYMBOLS[u.searchParams.get('underlying') ?? ''] ?? {} });
    }
    if (p === '/api/options/live') {
      if (method === 'POST') { record(); return json(route, { success: true }); }
      const strikes = Object.fromEntries(STRIKES.map(k => [k, { strike: Number(k), ce: { ltp: k === '23150' ? 110.5 : 90 }, pe: { ltp: 80 } }]));
      return json(route, {
        success: true, status: { status: 'RUNNING' },
        quotes: {
          underlying: 'NIFTY', expiry: '2026-10-19', spot: 23150, atm: 23150, straddle_premium: 190.5,
          updated_at: new Date().toISOString(), strikes,
          contracts: { NIFTY26OCT22500PE: { ltp: 37.05 }, CRUDEOILM17NOV268800PE: { ltp: 285.15 }, CRUDEOILM19NOV26FUT: { ltp: 9388 } },
        },
      });
    }
    if (p === '/api/scalper/kotak/all' || p === '/api/scalper/kotak/poll') {
      return json(route, { success: true, positions: m.positions, orders: [], trades: [], funds: { availabelBalance: 500000 }, pnl_guard: null });
    }
    if (p === '/api/scalper/kotak/positions') return json(route, { success: true, data: m.positions });
    if (p === '/api/scalper/kotak/funds') return json(route, { success: true, data: { availabelBalance: 500000 } });
    if (p === '/api/scalper/kotak/guards') {
      if (method === 'GET') return json(route, { success: true, sessionValid: true, state: m.guard });
      record();
      if (body?.action === 'setPnl') m.guard = { ...m.guard, pnl: { profit: body.profit, loss: body.loss, products: body.products, date: m.guard.date } };
      return json(route, { success: true, id: body?.action === 'addBracket' ? 'kb_test' : undefined, state: m.guard });
    }
    if (p === '/api/scalper/kotak/order' || p === '/api/scalper/kotak/exit-all') {
      record();
      if (p.endsWith('/order') && m.orderReply) { const r = m.orderReply(body); return json(route, r.body, r.status); }
      return json(route, p.endsWith('exit-all') ? { success: true, closed: ['x'], errors: [], skipped: [] } : { success: true, order_id: 'K1' });
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

let m: KotakMock;
const orders = () => m.calls.filter(c => c.path === '/api/scalper/kotak/order');
const row = (page: Page, sym: string) => page.locator('tr', { has: page.getByText(sym, { exact: true }) });

test.afterEach(() => {
  expect(m.blocked.map(c => `${c.method} ${c.path}`), 'an unmocked write was attempted').toEqual([]);
  // The page loads straight onto Kotak: not even a read of the Dhan account (before 2026-10-17 its first render ran
  // as Dhan and called /api/scalper/all, /api/pnl-exit and broker=dhan routes on every load).
  expect(m.dhan, 'a Dhan-account route was called on a Kotak page').toEqual([]);
  // Kotak must never fall through to a Dhan order route.
  expect(m.calls.filter(c => /\/api\/(scalper\/(fast-order|order)|super-order|exit-all|pnl-exit)$/.test(c.path) && c.method !== 'GET')).toEqual([]);
});

test.beforeEach(async ({ page, context }) => {
  m = { calls: [], blocked: [], dhan: [], positions: POSITIONS(), guard: { date: '2026-10-17', pnl: null, brackets: [], watch: [], events: [] } };
  await signIn(context);
  await installKotakMock(page, m);
  await page.goto('/advanced-scalper', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'BUY CE' }).first().waitFor({ timeout: 60_000 });
  await expect(row(page, 'CRUDEOILM19NOV26FUT')).toBeVisible({ timeout: 30_000 });
});

test('every leg is priced and dated: on-screen chain, off-expiry and another underlying (option + future)', async ({ page }) => {
  const expect4 = async (sym: string, expiry: string, ltp: string, pnl: string) => {
    const r = row(page, sym);
    await expect(r).toContainText(expiry);
    await expect(r).toContainText(ltp);
    await expect(r).toContainText(pnl);
  };
  await expect4(ON_SCREEN, '2026-10-19', '110.50', '1235');            // (120 − 110.50) × 130
  await expect4('NIFTY26OCT22500PE', '2026-10-27', '37.05', '-117');    // (36.75 − 37.05) × 390
  await expect4('CRUDEOILM17NOV268800PE', '2026-11-17', '285.15', '224'); // Kotak MCX qty is barrels: ×1
  await expect4('CRUDEOILM19NOV26FUT', '2026-11-19', '9388.00', '750');

  // The page asked the running (NIFTY) bridge for every open leg, across underlyings, futures with strike 0.
  const watch = m.calls.filter(c => c.path === '/api/options/live' && c.body?.action === 'watchContracts').at(-1);
  expect(watch?.body?.underlying).toBe('NIFTY');
  expect(watch?.body?.requests).toEqual(expect.arrayContaining([
    { key: 'CRUDEOILM19NOV26FUT', underlying: 'CRUDEOILM', expiry: '2026-11-19', strike: 0, side: 'FUT' },
    { key: 'CRUDEOILM17NOV268800PE', underlying: 'CRUDEOILM', expiry: '2026-11-17', strike: 8800, side: 'PE' },
    { key: 'NIFTY26OCT22500PE', underlying: 'NIFTY', expiry: '2026-10-27', strike: 22500, side: 'PE' },
  ]));
  // The retired per-underlying path must not send a CRUDEOILM leg to the NIFTY bridge as a NIFTY option.
  expect(m.calls.filter(c => c.body?.action === 'watchExtra')).toEqual([]);
});

test('BUY CE sends a Kotak market order by trading symbol, lots × lot size, NRML on MARGIN', async ({ page }) => {
  await page.getByRole('button', { name: 'BUY CE' }).first().click();
  await expect.poll(() => orders().length).toBe(1);
  // `source: 'as'` arms the route's server-side 100-lot cap on this opening order.
  expect(orders()[0].body).toEqual({ tradingsymbol: ON_SCREEN, quantity: 65, side: 'BUY', orderType: 'MARKET', exchange: 'nse_fo', product: 'NRML', source: 'as' });
});

test('INTRADAY books MIS', async ({ page }) => {
  await page.getByRole('button', { name: 'INTRADAY', exact: true }).first().click();
  await page.getByRole('button', { name: 'SELL CE' }).first().click();
  await expect.poll(() => orders().length).toBe(1);
  expect(orders()[0].body).toMatchObject({ tradingsymbol: ON_SCREEN, side: 'SELL', product: 'MIS', exchange: 'nse_fo' });
});

test('closing a CRUDEOILM leg from the NIFTY view buys back the whole net on mcx_fo under its own product', async ({ page }) => {
  await row(page, 'CRUDEOILM17NOV268800PE').getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(() => orders().length).toBe(1);
  expect(orders()[0].body).toEqual({ tradingsymbol: 'CRUDEOILM17NOV268800PE', quantity: 140, side: 'BUY', orderType: 'MARKET', exchange: 'mcx_fo', product: 'NRML' });
});

test('50% partial close of an on-screen leg is lot-rounded', async ({ page }) => {
  await row(page, 'NIFTY26OCT22500PE').getByRole('button', { name: '50%' }).click();
  await expect.poll(() => orders().length).toBe(1);
  // 390 = 6 lots of 65; half = 3 lots.
  expect(orders()[0].body).toMatchObject({ tradingsymbol: 'NIFTY26OCT22500PE', quantity: 195, side: 'BUY', exchange: 'nse_fo', product: 'NRML' });
});

test('EXIT ALL needs a confirm click and uses the Kotak F&O exit, never the Dhan one', async ({ page }) => {
  const exitAll = page.getByRole('button', { name: /EXIT ALL Positions|Confirm EXIT ALL/ });
  await exitAll.click();
  await page.waitForTimeout(300);
  expect(m.calls.filter(c => c.path === '/api/scalper/kotak/exit-all')).toHaveLength(0);
  await exitAll.click();
  await expect.poll(() => m.calls.filter(c => c.path === '/api/scalper/kotak/exit-all').length).toBe(1);
});

test('P&L Guard registers with the server guard (setPnl), not Dhan pnl-exit', async ({ page }) => {
  const target = page.getByPlaceholder('e.g. 5000').first();
  await target.fill('3000'); await target.press('Enter');
  const sl = page.getByPlaceholder('e.g. 2000').first();
  await sl.fill('1500'); await sl.press('Enter');
  await page.getByRole('button', { name: 'Set Guard' }).first().click();
  await expect.poll(() => m.calls.filter(c => c.body?.action === 'setPnl').length).toBe(1);
  expect(m.calls.find(c => c.body?.action === 'setPnl')?.body).toMatchObject({ action: 'setPnl', profit: 3000, loss: 1500 });
});

test('soft bracket: an opening order is registered with the server BEFORE it goes out', async ({ page }) => {
  await page.getByRole('button', { name: /^BRACKET (ON|OFF)/ }).click();
  await expect(page.getByRole('button', { name: 'BRACKET ON · SERVER' })).toBeVisible();
  // No position on the 23150 PE, so BUY PE opens one.
  await page.getByRole('button', { name: 'BUY PE' }).first().click();
  await expect.poll(() => orders().length).toBe(1);
  const regAt = m.calls.findIndex(c => c.body?.action === 'addBracket');
  const orderAt = m.calls.findIndex(c => c.path === '/api/scalper/kotak/order');
  expect(regAt).toBeGreaterThanOrEqual(0);
  expect(regAt).toBeLessThan(orderAt);
  // Long entry at 80 with the default 10 / 8 points.
  expect(m.calls[regAt].body).toMatchObject({ symbol: 'NIFTY26O1923150PE', dir: 1, target: 90, sl: 72, product: 'MARGIN', qtyBefore: 0 });
  expect(orders()[0].body).toMatchObject({ tradingsymbol: 'NIFTY26O1923150PE', side: 'BUY', quantity: 65 });
});

test('soft bracket: an order that reduces an open position goes out plain, with no bracket', async ({ page }) => {
  await page.getByRole('button', { name: /^BRACKET (ON|OFF)/ }).click();
  // The on-screen CE is short 130: BUY 1 lot (65) reduces it.
  await page.getByRole('button', { name: 'BUY CE' }).first().click();
  await expect.poll(() => orders().length).toBe(1);
  expect(m.calls.filter(c => c.body?.action === 'addBracket')).toHaveLength(0);
  await expect(page.getByText(/closing, no bracket/)).toBeVisible();
});

test('Add on a Kotak future refuses instead of opening the options Add Lots modal', async ({ page }) => {
  await row(page, 'CRUDEOILM19NOV26FUT').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Could not resolve this position’s contract')).toBeVisible();
  expect(orders()).toHaveLength(0);
});

test('a close carries no source, so the server-side lot cap can never refuse it', async ({ page }) => {
  await row(page, 'NIFTY26OCT22500PE').getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(() => orders().length).toBe(1);
  expect(orders()[0].body).not.toHaveProperty('source');
});

test('a CRUDEOILM leg gets partial-close chips from the NIFTY view, sized off its own Kotak lot', async ({ page }) => {
  // -140 = 14 CRUDEOILM lots of 10; 50% = 7 lots.
  await row(page, 'CRUDEOILM17NOV268800PE').getByRole('button', { name: '50%' }).click();
  await expect.poll(() => orders().length).toBe(1);
  expect(orders()[0].body).toMatchObject({ tradingsymbol: 'CRUDEOILM17NOV268800PE', quantity: 70, side: 'BUY', exchange: 'mcx_fo', product: 'NRML' });
  expect(orders()[0].body).not.toHaveProperty('source');
});

test('the EXIT ALL tooltip says what Kotak actually does', async ({ page }) => {
  const title = await page.getByRole('button', { name: /EXIT ALL Positions/ }).getAttribute('title');
  expect(title).toContain('Kotak F&O leg on every underlying');
  expect(title).toContain('NOT cancelled');
  expect(title).not.toContain('force-stops');
});

// ── Orders whose outcome is UNKNOWN (lib/orderOutcome.ts): 504 / unknown:true, the order may be live ──
const KOTAK_UNKNOWN = { status: 504, body: { success: false, unknown: true, error: 'Order status unknown - Kotak did not confirm in time.' } };

test('soft bracket: an entry whose order is UNKNOWN keeps its server bracket (it arms if the position appears)', async ({ page }) => {
  m.orderReply = () => KOTAK_UNKNOWN;
  await page.getByRole('button', { name: /^BRACKET (ON|OFF)/ }).click();
  await page.getByRole('button', { name: 'BUY PE' }).first().click();
  await expect.poll(() => orders().length).toBe(1);
  await expect(page.getByText(/BUY PE: order status UNKNOWN/).first()).toBeVisible();
  await page.waitForTimeout(1_500);
  // Before the fix: "BUY PE failed" and removeBracket — a filled order left with no stop or target.
  expect(m.calls.filter(c => c.body?.action === 'removeBracket')).toHaveLength(0);
  await expect(page.getByText(/BUY PE failed/)).toHaveCount(0);
});

test('soft bracket: an entry the broker cleanly REJECTS still withdraws its bracket', async ({ page }) => {
  m.orderReply = () => ({ status: 200, body: { success: false, error: 'RMS: margin exceeds' } });
  await page.getByRole('button', { name: /^BRACKET (ON|OFF)/ }).click();
  await page.getByRole('button', { name: 'BUY PE' }).first().click();
  await expect.poll(() => m.calls.filter(c => c.body?.action === 'removeBracket').length).toBe(1);
  await expect(page.getByText(/BUY PE rejected/).first()).toBeVisible();
});

test('a close whose order is UNKNOWN holds a second manual close for 15 s instead of sending it', async ({ page }) => {
  m.orderReply = () => KOTAK_UNKNOWN;
  const close = row(page, 'CRUDEOILM17NOV268800PE').getByRole('button', { name: 'Close', exact: true });
  await close.click();
  await expect.poll(() => orders().length).toBe(1);
  await expect(page.getByText(/Close of CRUDEOILM17NOV268800PE: status UNKNOWN/).first()).toBeVisible();
  // Past the 2 s cooldown that was the only thing stopping a second close before.
  await page.waitForTimeout(3_000);
  await close.click();
  await expect(page.getByText(/Close of CRUDEOILM17NOV268800PE on hold/).first()).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(orders()).toHaveLength(1);
});
