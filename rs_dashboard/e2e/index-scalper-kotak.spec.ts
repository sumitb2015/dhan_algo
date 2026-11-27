import { test, expect, type Page, type Route } from '@playwright/test';
import { json, sessionCookieValue, signIn } from './support';
import { installSessionClock, sessionIso, sessionNow } from './isxClock';

// /index-scalper on Kotak, every /api/* call mocked in the browser: no session, no order can reach a broker (any
// non-GET the mock does not handle is refused with 599 and fails the test). Prices stay Dhan's live feed (market data);
// the ACCOUNT is Kotak, and a Kotak page must never read or trade Dhan's account.

const SPOT = 25350;
const DHAN_IDS: Record<string, [string, string]> = { '25300': ['301', '401'], '25350': ['302', '402'], '25400': ['303', '403'] };
const KSYM = (k: string, t: 'CE' | 'PE') => `NIFTY26120${k}${t}`;
const DHAN_ACCOUNT = ['/api/scalper/funds', '/api/scalper/positions', '/api/scalper/orders', '/api/scalper/fast-order', '/api/index-scalper/holdings', '/api/options/margin'];

interface Call { path: string; method: string; body: Record<string, unknown> | null }
interface KState {
  calls: Call[]; blocked: Call[];
  positions: Record<string, unknown>[];
  book: Record<string, unknown>[];
  records: Record<string, unknown>[];
  reply?: 'placed' | 'unknown';
  freezeQty?: number;
  /** symbol-lookup fails this many times before answering (retry test) */
  symbolFails?: number;
  /** extra Kotak contracts in the symbol lookup (another expiry) */
  extraSyms?: Record<string, unknown>;
}

function candles() {
  const start = Date.UTC(2026, 10, 20, 3, 45, 0) / 1000;
  return Array.from({ length: 75 }, (_, i) => {
    const base = SPOT - 40 + Math.sin(i / 6) * 40;
    return { t: start + i * 300, o: base, h: base + 12, l: base - 12, c: base + (i % 2 ? 6 : -6) };
  });
}

async function mock(page: Page, s: KState) {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    const body = method === 'GET' ? null : (req.postDataJSON() as Record<string, unknown> | null);
    s.calls.push({ path: p, method, body });

    if (p === '/api/index-scalper/candles') return json(route, { success: true, candles: candles(), interval: '5' });
    if (p === '/api/options/expiries') return json(route, { success: true, data: ['2026-12-01'] });
    if (p === '/api/scalper/lookup') { // Dhan's contract ids: market data for the live feed, not an account read
      return json(route, { success: true, data: { lotSize: 65, strikes: Object.fromEntries(Object.entries(DHAN_IDS).map(([k, [ce, pe]]) => [k, { ceId: ce, peId: pe }])) } });
    }
    if (p === '/api/options/live') {
      if (method === 'POST') return json(route, { success: true });
      const strikes = Object.fromEntries(Object.keys(DHAN_IDS).map(k => [k, { strike: Number(k), ce: { ltp: 210.5, oi: 1, oi_chg_pct: 1, change_pct: 1, buildup: '' }, pe: { ltp: 229.95, oi: 1, oi_chg_pct: 1, change_pct: 1, buildup: '' } }]));
      return json(route, { success: true, status: { status: 'RUNNING' }, quotes: { underlying: 'NIFTY', expiry: '2026-12-01', spot: SPOT, atm: SPOT, updated_at: sessionIso(), strikes } });
    }
    if (p === '/api/index-scalper/tick') return json(route, { success: true, tick: 0.05 });
    if (p === '/api/scalper/kotak/lookup') {
      return json(route, { success: true, data: { lotSize: 65, exchangeSegment: 'nse_fo', ...(s.freezeQty ? { freezeQty: s.freezeQty } : {}), strikes: Object.fromEntries(Object.keys(DHAN_IDS).map(k => [k, { ceSymbol: KSYM(k, 'CE'), peSymbol: KSYM(k, 'PE') }])) } });
    }
    if (p === '/api/scalper/kotak/symbol-lookup') {
      if ((s.symbolFails ?? 0) > 0) { s.symbolFails = (s.symbolFails ?? 0) - 1; return json(route, { success: false, error: 'Kotak instrument cache is being rebuilt' }, 500); }
      const map: Record<string, unknown> = {};
      for (const k of Object.keys(DHAN_IDS)) for (const t of ['CE', 'PE'] as const) map[KSYM(k, t)] = { underlying: 'NIFTY', expiry: '2026-12-01', strike: Number(k), side: t };
      Object.assign(map, s.extraSyms ?? {});
      // each Kotak contract's own lot (symbol-lookup carries it): NIFTY is 65 on every expiry
      for (const v of Object.values(map) as Record<string, unknown>[]) if (v && v.lotSize === undefined) v.lotSize = 65;
      return json(route, { success: true, data: map });
    }
    if (p === '/api/scalper/kotak/funds') return json(route, { success: true, data: { availabelBalance: 500000, availableBalance: 500000, utilizedAmount: 1200 } });
    // live read (exit sizing) and the cached display read return the same book here
    if (p === '/api/scalper/kotak/positions' || p === '/api/index-scalper/kotak-positions') return json(route, { success: true, data: s.positions });
    if (p === '/api/scalper/kotak/orders' && method === 'GET') return json(route, { success: true, data: s.book });
    if (p === '/api/scalper/kotak/orders' && method === 'DELETE') return json(route, { success: true });
    if (p === '/api/equity-order/holdings') return json(route, { success: true, data: {} });
    if (p === '/api/index-scalper/kotak-order') {
      if (method === 'GET') return json(route, { success: true, day: '2026-11-25', records: s.records });
      if (s.reply === 'unknown') {
        s.records.push({ unknown: true, symbol: body?.tradingSymbol, side: body?.side, qty: body?.quantity, at: sessionNow() });
        return json(route, { success: false, unknown: true, error: 'Order status unknown' }, 504);
      }
      const id = `KNEW${s.records.length + 1}`;
      s.records.push({ orderId: id, symbol: body?.tradingSymbol, side: body?.side, product: body?.product === 'MARGIN' ? 'NRML' : 'MIS', at: sessionNow() });
      return json(route, { success: true, order_id: id });
    }
    if (DHAN_ACCOUNT.includes(p)) return json(route, { success: true, data: [] }); // recorded in calls: asserted absent
    if (method !== 'GET') {
      s.blocked.push({ path: p, method, body });
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' });
    }
    return json(route, { success: false, error: 'e2e: unmocked GET' }, 404);
  });
}

/** IST wall-clock "25-Nov-2026 10:20:05" for an epoch, as Kotak's order book writes it. */
function kotakTime(ms: number): string {
  const d = new Date(ms + 19_800_000);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getUTCDate())}-${mon}-${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}
const dhanAccountCalls = (s: KState) => s.calls.filter(c => DHAN_ACCOUNT.includes(c.path));
const kotakOrderPosts = (s: KState) => s.calls.filter(c => c.path === '/api/index-scalper/kotak-order' && c.method === 'POST');

async function openOnKotak(page: Page, context: import('@playwright/test').BrowserContext, s: KState) {
  await installSessionClock(page);
  await page.addInitScript(() => { try { localStorage.setItem('indexScalper.broker', 'kotak'); } catch { /* ignore */ } });
  await signIn(context);
  await mock(page, s);
  await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel('Broker for new orders')).toHaveValue('kotak');
}
async function armReal(page: Page) {
  await page.getByRole('button', { name: 'REAL', exact: true }).click();
  await page.getByRole('button', { name: 'Arm REAL on Kotak' }).click();
}

test.describe('Index Scalper on Kotak', () => {
  test('a Kotak page reads only Kotak\'s account, locks the broker while REAL, and orders by Kotak symbol', async ({ page, context }) => {
    const s: KState = { calls: [], blocked: [], positions: [], book: [], records: [] };
    await openOnKotak(page, context, s);
    const panel = page.getByTestId('account-panel');
    await expect(panel).toContainText('KOTAK');
    await expect(panel).toContainText('5,00,000.00', { timeout: 15_000 });

    await armReal(page);
    await expect(panel).toContainText('REAL · Kotak');
    await expect(page.getByLabel('Broker for new orders')).toBeDisabled();

    await page.getByRole('button', { name: 'Option chain' }).click();
    await page.getByRole('button', { name: 'Trade 25350 PE' }).click();
    await page.getByTestId('order-ticket').getByRole('button', { name: /^Buy / }).click();
    await expect.poll(() => kotakOrderPosts(s).length, { timeout: 15_000 }).toBe(1);
    expect(kotakOrderPosts(s)[0].body).toMatchObject({ tradingSymbol: KSYM('25350', 'PE'), quantity: 65, side: 'BUY', orderType: 'MARKET', product: 'INTRADAY', intent: 'open' });
    expect(String(kotakOrderPosts(s)[0].body?.idempotencyKey ?? '').length).toBeGreaterThanOrEqual(8);

    expect(dhanAccountCalls(s)).toEqual([]);
    expect(s.blocked).toEqual([]);
  });

  test('Exit closes the whole Kotak row, including a share opened elsewhere (strategy / mobile app)', async ({ page, context }) => {
    const sym = KSYM('25350', 'PE');
    const s: KState = {
      calls: [], blocked: [], records: [{ orderId: 'K1', symbol: sym, side: 'SELL', product: 'MIS', at: 0 }],
      // 715 short at Kotak: 65 from this page's order K1, 650 from a strategy's order S1. Exit closes all 715.
      positions: [{ tradingSymbol: sym, securityId: '99887', netQty: -715, buyQty: 0, sellQty: 715, buyAvg: 0, sellAvg: 240, productType: 'MIS', realizedProfit: 0, lastTradedPrice: 0, unrealizedProfit: 0 }],
      book: [
        { orderId: 'K1', tradingSymbol: sym, transactionType: 'SELL', quantity: 65, orderStatus: 'COMPLETE', filledQty: 65, productType: 'MIS', createTime: '25-Nov-2026 10:20:00' },
        { orderId: 'S1', tradingSymbol: sym, transactionType: 'SELL', quantity: 650, orderStatus: 'COMPLETE', filledQty: 650, productType: 'MIS', createTime: '25-Nov-2026 09:30:00' },
      ],
    };
    await openOnKotak(page, context, s);
    await armReal(page);
    const panel = page.getByTestId('account-panel');
    const row = panel.getByTestId('panel-position-row');
    await expect(row).toContainText('NIFTY 01 DEC 25350 PUT', { timeout: 15_000 });
    await expect(row).toContainText('-715');
    await expect(row).toContainText('229.95'); // priced off Dhan's live feed through the contract

    // the Orders tab offers Cancel on nothing here (K1 is filled; S1 is not this page's)
    await panel.getByRole('tab', { name: 'Orders' }).click();
    await expect(panel.getByTestId('panel-order-row')).toHaveCount(2);
    await expect(panel.getByRole('button', { name: /^Cancel order/ })).toHaveCount(0);

    await panel.getByRole('tab', { name: /^Positions/ }).click();
    await row.getByRole('button', { name: /^Exit / }).click();
    await expect.poll(() => kotakOrderPosts(s).length, { timeout: 15_000 }).toBe(1);
    expect(kotakOrderPosts(s)[0].body).toMatchObject({ tradingSymbol: sym, quantity: 715, side: 'BUY', orderType: 'MARKET', product: 'INTRADAY', intent: 'close' });
    expect(dhanAccountCalls(s)).toEqual([]);
    expect(s.blocked).toEqual([]);
  });

  test('an unknown Kotak outcome holds the next exit on that contract', async ({ page, context }) => {
    const sym = KSYM('25350', 'PE');
    const s: KState = {
      calls: [], blocked: [],
      records: [{ orderId: 'K1', symbol: sym, side: 'SELL', product: 'MIS', at: 0 }],
      positions: [{ tradingSymbol: sym, securityId: '99887', netQty: -65, buyQty: 0, sellQty: 65, buyAvg: 0, sellAvg: 240, productType: 'MIS', realizedProfit: 0 }],
      book: [{ orderId: 'K1', tradingSymbol: sym, transactionType: 'SELL', quantity: 65, orderStatus: 'COMPLETE', filledQty: 65, productType: 'MIS' }],
    };
    await openOnKotak(page, context, s);
    s.records.push({ unknown: true, symbol: sym, side: 'SELL', qty: 65, at: sessionNow() }); // an add that may still fill
    await armReal(page);
    const row = page.getByTestId('account-panel').getByTestId('panel-position-row');
    await expect(row).toContainText('NIFTY 01 DEC 25350 PUT', { timeout: 15_000 });
    await row.getByRole('button', { name: /^Exit / }).click();
    await expect(page.getByRole('status').filter({ hasText: 'unknown outcome' })).toBeVisible({ timeout: 15_000 });
    expect(kotakOrderPosts(s)).toEqual([]);
    expect(s.blocked).toEqual([]);
  });

  test('Reverse on Kotak trades the position\'s own contract (another expiry), close then open, never the one on screen', async ({ page, context }) => {
    const sym = 'NIFTY26122925350CE'; // the 29-Dec contract; the screen shows 01-Dec (KSYM's would be NIFTY2612025350CE)
    const s: KState = {
      calls: [], blocked: [], records: [], book: [],
      extraSyms: { [sym]: { underlying: 'NIFTY', expiry: '2026-12-29', strike: 25350, side: 'CE' } },
      positions: [{ tradingSymbol: sym, securityId: '77001', netQty: 65, buyQty: 65, sellQty: 0, buyAvg: 300, sellAvg: 0, productType: 'MIS', realizedProfit: 0, lastTradedPrice: 0, unrealizedProfit: 0 }],
    };
    await openOnKotak(page, context, s);
    await armReal(page);
    const chip = page.getByTestId('chart-pane-0').getByTestId('position-chip');
    await expect(chip).toHaveCount(1, { timeout: 15_000 });
    await chip.getByRole('button', { name: 'Reverse CE 25350' }).click();
    await page.getByRole('alertdialog', { name: 'Reverse position' }).getByRole('button', { name: 'Reverse to short' }).click();
    await expect.poll(() => kotakOrderPosts(s).length, { timeout: 15_000 }).toBe(2);
    expect(kotakOrderPosts(s)[0].body).toMatchObject({ tradingSymbol: sym, quantity: 65, side: 'SELL', orderType: 'MARKET', intent: 'close' });
    expect(kotakOrderPosts(s)[1].body).toMatchObject({ tradingSymbol: sym, quantity: 65, side: 'SELL', orderType: 'MARKET', intent: 'open' });
    expect(dhanAccountCalls(s)).toEqual([]);
    expect(s.blocked).toEqual([]);
  });

  test('a Dhan page never touches Kotak', async ({ page, context }) => {
    const s: KState = { calls: [], blocked: [], positions: [], book: [], records: [] };
    await installSessionClock(page);
    await signIn(context);
    await mock(page, s);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel('Broker for new orders')).toHaveValue('dhan');
    await page.waitForTimeout(1500);
    // (the dashboard-wide NavBar's Kotak guard banner polls /api/scalper/kotak/guards on every page: not this page's)
    expect(s.calls.filter(c => (c.path.startsWith('/api/scalper/kotak/') && c.path !== '/api/scalper/kotak/guards') || c.path === '/api/index-scalper/kotak-order')).toEqual([]);
  });

  test('Exit All on Kotak covers the short before selling the long, each only for this page\'s own fills', async ({ page, context }) => {
    const pe = KSYM('25350', 'PE'), ce = KSYM('25400', 'CE');
    const s: KState = {
      calls: [], blocked: [],
      records: [{ orderId: 'K1', symbol: pe, side: 'SELL', product: 'MIS', at: 0 }, { orderId: 'K2', symbol: ce, side: 'BUY', product: 'MIS', at: 0 }],
      positions: [
        { tradingSymbol: ce, netQty: 65, buyQty: 65, sellQty: 0, buyAvg: 150, sellAvg: 0, productType: 'MIS', realizedProfit: 0 },
        { tradingSymbol: pe, netQty: -65, buyQty: 0, sellQty: 65, buyAvg: 0, sellAvg: 240, productType: 'MIS', realizedProfit: 0 },
      ],
      book: [
        { orderId: 'K1', tradingSymbol: pe, transactionType: 'SELL', quantity: 65, orderStatus: 'COMPLETE', filledQty: 65, productType: 'MIS' },
        { orderId: 'K2', tradingSymbol: ce, transactionType: 'BUY', quantity: 65, orderStatus: 'COMPLETE', filledQty: 65, productType: 'MIS' },
      ],
    };
    await openOnKotak(page, context, s);
    await armReal(page);
    await expect(page.getByTestId('account-panel').getByTestId('panel-position-row')).toHaveCount(2, { timeout: 15_000 });
    await page.getByRole('button', { name: 'Exit All' }).click();
    await expect.poll(() => kotakOrderPosts(s).length, { timeout: 15_000 }).toBe(2);
    expect(kotakOrderPosts(s).map(c => [c.body?.tradingSymbol, c.body?.side, c.body?.quantity, c.body?.intent])).toEqual([[pe, 'BUY', 65, 'close'], [ce, 'SELL', 65, 'close']]);
    expect(dhanAccountCalls(s)).toEqual([]);
    expect(s.blocked).toEqual([]);
  });

  test('Cancel on any working Kotak order (this page\'s or not) goes to Kotak\'s cancel', async ({ page, context }) => {
    const sym = KSYM('25350', 'PE');
    const s: KState = {
      calls: [], blocked: [], positions: [],
      records: [{ orderId: 'K3', symbol: sym, side: 'SELL', product: 'MIS', at: 0 }],
      book: [
        { orderId: 'K3', tradingSymbol: sym, transactionType: 'SELL', quantity: 65, price: 260, orderType: 'LIMIT', orderStatus: 'OPEN', filledQty: 0, productType: 'MIS', createTime: '25-Nov-2026 10:00:00' },
        { orderId: 'S9', tradingSymbol: sym, transactionType: 'SELL', quantity: 65, price: 270, orderType: 'LIMIT', orderStatus: 'OPEN', filledQty: 0, productType: 'MIS', createTime: '25-Nov-2026 10:01:00' },
      ],
    };
    await openOnKotak(page, context, s);
    const panel = page.getByTestId('account-panel');
    await panel.getByRole('tab', { name: 'Orders' }).click();
    await expect(panel.getByRole('button', { name: 'Cancel order K3' })).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByRole('button', { name: 'Cancel order S9' })).toHaveCount(1); // not this page's: cancellable too
    await panel.getByRole('button', { name: 'Cancel order K3' }).click();
    await expect.poll(() => s.calls.filter(c => c.path === '/api/scalper/kotak/orders' && c.method === 'DELETE').map(c => c.body?.orderId)).toEqual(['K3']);
    expect(dhanAccountCalls(s)).toEqual([]);
  });

  test('a close above the exchange freeze quantity is sent in whole-lot slices under it', async ({ page, context }) => {
    const sym = KSYM('25350', 'PE');
    const s: KState = {
      calls: [], blocked: [], freezeQty: 130,
      records: [{ orderId: 'K1', symbol: sym, side: 'SELL', product: 'MIS', at: 0 }],
      positions: [{ tradingSymbol: sym, netQty: -195, buyQty: 0, sellQty: 195, buyAvg: 0, sellAvg: 240, productType: 'MIS', realizedProfit: 0 }],
      book: [{ orderId: 'K1', tradingSymbol: sym, transactionType: 'SELL', quantity: 195, orderStatus: 'COMPLETE', filledQty: 195, productType: 'MIS' }],
    };
    await openOnKotak(page, context, s);
    await armReal(page);
    const row = page.getByTestId('account-panel').getByTestId('panel-position-row');
    await row.getByRole('button', { name: /^Exit / }).click({ timeout: 15_000 });
    await expect.poll(() => kotakOrderPosts(s).map(c => c.body?.quantity), { timeout: 15_000 }).toEqual([130, 65]);
  });

  test('an unknown outcome that shows up filled in the book is this page\'s again: Exit closes it', async ({ page, context }) => {
    const sym = KSYM('25350', 'PE');
    const s: KState = { calls: [], blocked: [], records: [], positions: [], book: [] };
    await openOnKotak(page, context, s);
    const at = sessionNow();
    s.records.push({ unknown: true, symbol: sym, side: 'SELL', qty: 65, at });
    s.book.push({ orderId: 'K7', tradingSymbol: sym, transactionType: 'SELL', quantity: 65, orderStatus: 'COMPLETE', filledQty: 65, productType: 'MIS', createTime: kotakTime(at + 2_000) });
    s.positions.push({ tradingSymbol: sym, netQty: -65, buyQty: 0, sellQty: 65, buyAvg: 0, sellAvg: 240, productType: 'MIS', realizedProfit: 0 });
    await armReal(page);
    const row = page.getByTestId('account-panel').getByTestId('panel-position-row');
    await row.getByRole('button', { name: /^Exit / }).click({ timeout: 15_000 });
    await expect.poll(() => kotakOrderPosts(s).length, { timeout: 15_000 }).toBe(1);
    expect(kotakOrderPosts(s)[0].body).toMatchObject({ tradingSymbol: sym, side: 'BUY', quantity: 65, intent: 'close' });
  });

  test('a failed Kotak contract load is retried: the page says so, then trades once it loads', async ({ page, context }) => {
    test.setTimeout(90_000);
    const s: KState = { calls: [], blocked: [], positions: [], book: [], records: [], symbolFails: 1 };
    await openOnKotak(page, context, s);
    await expect(page.getByTestId('kotak-error')).toContainText('being rebuilt', { timeout: 10_000 });
    await expect(page.getByTestId('kotak-error')).toHaveCount(0, { timeout: 30_000 }); // the 15 s retry succeeded
    await armReal(page);
    await page.getByRole('button', { name: 'Option chain' }).click();
    await page.getByRole('button', { name: 'Trade 25350 CE' }).click();
    await page.getByTestId('order-ticket').getByRole('button', { name: /^Buy / }).click();
    await expect.poll(() => kotakOrderPosts(s).length, { timeout: 15_000 }).toBe(1);
  });
});

test.describe('Index Scalper Kotak order route refuses bad orders before reaching Kotak', () => {
  // Only requests refused before any contract lookup or Kotak call, or with a symbol that does not exist. Never add a
  // valid-order case here: with a live Kotak session it would trade.
  const headers = () => ({ Cookie: `dhan_session=${sessionCookieValue()}`, 'Content-Type': 'application/json' });
  const BASE = { tradingSymbol: 'NIFTY00000000000CE', quantity: 65, side: 'BUY', orderType: 'MARKET', product: 'INTRADAY', intent: 'open' };

  test('unauthenticated requests are refused', async ({ request }) => {
    const res = await request.post('/api/index-scalper/kotak-order', { data: { ...BASE, idempotencyKey: 'isxkote2e01' }, headers: { 'Content-Type': 'application/json' } });
    expect(res.status()).toBe(401);
  });

  for (const [name, patch, message] of [
    ['no idempotency key', { idempotencyKey: undefined }, /idempotencyKey/],
    ['a non-NIFTY contract', { tradingSymbol: 'BANKNIFTY26120550000CE' }, /NIFTY, SENSEX, CRUDEOILM or CRUDEOIL contract/],
    ['an unknown product', { product: 'CO' }, /Unsupported product/],
    ['no open/close intent', { intent: 'maybe' }, /intent/],
    ['a contract not in the Kotak cache', {}, /not in the Kotak instrument cache/],
    // SENSEX is an accepted underlying now; an unlisted SENSEX symbol is still refused before Kotak is called.
    ['a SENSEX contract not in the Kotak cache', { tradingSymbol: 'SENSEX00000000000CE', quantity: 20 }, /not in the Kotak instrument cache/],
  ] as [string, Record<string, unknown>, RegExp][]) {
    test(`refuses ${name}`, async ({ request }) => {
      const data: Record<string, unknown> = { ...BASE, idempotencyKey: `isxk${Math.random().toString(36).slice(2, 12)}`, ...patch };
      if (patch.idempotencyKey === undefined && 'idempotencyKey' in patch) delete data.idempotencyKey;
      const res = await request.post('/api/index-scalper/kotak-order', { headers: headers(), data });
      const body = await res.json() as { success: boolean; error?: string; unknown?: boolean };
      expect(res.status()).toBe(400);
      expect(body.success).toBe(false);
      expect(body.unknown).toBeUndefined();
      expect(body.error).toMatch(message);
    });
  }
});
