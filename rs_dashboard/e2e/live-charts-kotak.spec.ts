import { expect, test, type Page, type Route } from '@playwright/test';
import { json, signIn, type Call } from './support';

// Live Options Charts (/options/live-charts) trading on KOTAK and on DHAN: the order modal and the trading desk, in the
// browser with every /api/* call mocked against a small stateful book. Nothing reaches a broker; any write the mock
// does not expect is refused with 599 and fails the test. Prices / charts stay Dhan's by design.

const EXP = '2026-10-27';
const STRIKES = [24900, 24950, 25000, 25050, 25100];
const LOT = 65;
const kSym = (k: number, o: 'CE' | 'PE') => `NIFTY26O27${k}${o}`;
const dId = (k: number, o: 'CE' | 'PE') => `${k}${o === 'CE' ? 1 : 2}`;

type Bk = 'dhan' | 'kotak';
interface Mock {
  bk: Bk;
  calls: Call[];
  blocked: Call[];
  /** contract -> signed net qty, per broker. */
  book: Record<Bk, Map<string, number>>;
  /** Per-leg reply for the next /api/options/order legs: 'ok' (fills), 'reject', 'unknown' (no fill). */
  next: Map<string, 'ok' | 'reject' | 'unknown'>;
  ordersSeq: number;
}

function rows(m: Mock, bk: Bk) {
  return [...m.book[bk].entries()].filter(([, q]) => q !== 0).map(([c, q]) => (bk === 'kotak'
    ? { tradingSymbol: c, securityId: '777', exchange: 'nse_fo', productType: 'MIS', netQty: q, buyQty: q > 0 ? q : 0, sellQty: q < 0 ? -q : 0, buyAvg: q > 0 ? 100 : 0, sellAvg: q < 0 ? 100 : 0, lastTradedPrice: 0, realizedProfit: 0, unrealizedProfit: 0 }
    : { securityId: c, tradingSymbol: `NIFTY-Oct2026-${c.slice(0, 5)}-${c.endsWith('1') ? 'CE' : 'PE'}`, exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', netQty: q, buyAvg: q > 0 ? 100 : 0, sellAvg: q < 0 ? 100 : 0, costPrice: 100, unrealizedProfit: 0, realizedProfit: 0, drvExpiryDate: EXP, drvOptionType: c.endsWith('1') ? 'CALL' : 'PUT', drvStrikePrice: Number(c.slice(0, 5)) }));
}

async function install(page: Page, m: Mock) {
  await page.addInitScript((b: string) => { try { localStorage.setItem('liveCharts.broker', b); } catch { /* ignore */ } }, m.bk);
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    const body = method === 'GET' ? null : (req.postDataJSON() as Record<string, unknown> | null);
    m.calls.push({ method, path: p, search: u.search, body });

    if (p === '/api/auth/broker-status') return json(route, { dhan: true, zerodha: false, kotak: true });
    if (p === '/api/options/live-charts') {
      const kind = u.searchParams.get('kind');
      if (kind === 'expiries') return json(route, { success: true, data: { expiries: [EXP] } });
      if (kind === 'strikes') return json(route, { success: true, data: { spot: 25010, strikes: STRIKES.map(k => ({ strike: k, is_atm: k === 25000 })) } });
      return json(route, { success: false, error: 'e2e: no chart data' });
    }
    if (p === '/api/scalper/lookup') return json(route, { success: true, data: { lotSize: LOT, strikes: Object.fromEntries(STRIKES.map(k => [String(k), { ceId: dId(k, 'CE'), peId: dId(k, 'PE') }])) } });
    if (p === '/api/scalper/kotak/lookup') return json(route, { success: true, data: { lotSize: LOT, strikes: Object.fromEntries(STRIKES.map(k => [String(k), { ceSymbol: kSym(k, 'CE'), peSymbol: kSym(k, 'PE') }])) } });
    if (p === '/api/scalper/kotak/symbol-lookup') return json(route, { success: true, data: Object.fromEntries(STRIKES.flatMap(k => (['CE', 'PE'] as const).map(o => [kSym(k, o), { expiry: EXP, strike: k, side: o }]))) });
    if (p === '/api/options/chain') {
      const oc = Object.fromEntries(STRIKES.map(k => [`${k}.000000`, { ce: { last_price: 90 }, pe: { last_price: 95 } }]));
      return json(route, { success: true, data: { spot: 25010, chain: { oc } } });
    }
    if (p === '/api/scalper/positions') return json(route, { success: true, data: rows(m, 'dhan') });
    if (p === '/api/scalper/kotak/positions') return json(route, { success: true, data: rows(m, 'kotak') });
    if (['/api/scalper/orders', '/api/scalper/kotak/orders', '/api/scalper/trades', '/api/scalper/kotak/trades'].includes(p) && method === 'GET') return json(route, { success: true, data: [] });
    if (p === '/api/options/order' && method === 'POST') {
      const bk = (body?.broker as Bk | undefined) ?? 'dhan';
      const legs = (body?.legs ?? []) as { securityId?: string; tradingSymbol?: string; quantity: number; side: 'BUY' | 'SELL' }[];
      const data = legs.map(l => {
        const c = String(bk === 'kotak' ? l.tradingSymbol : l.securityId);
        const mode = m.next.get(c) ?? 'ok';
        m.next.delete(c);
        const echo = bk === 'kotak' ? { tradingSymbol: c } : { securityId: c };
        if (mode === 'reject') return { success: false, error: 'e2e: RMS reject', ...echo };
        if (mode === 'unknown') return { success: false, unknown: true, error: 'e2e: no reply', ...echo };
        m.book[bk].set(c, (m.book[bk].get(c) ?? 0) + (l.side === 'BUY' ? l.quantity : -l.quantity));
        return { success: true, orderId: `E${++m.ordersSeq}`, ...echo };
      });
      const failed = data.filter(d => !d.success);
      return json(route, failed.length
        ? { success: false, ...(failed.some(f => (f as { unknown?: boolean }).unknown) ? { unknown: true } : {}), error: 'e2e partial', data }
        : { success: true, data });
    }
    if (method === 'POST' && ['/api/live-indices', '/api/options/live'].includes(p)) return json(route, { success: true });
    if (method !== 'GET') {
      m.blocked.push({ method, path: p, search: u.search, body });
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' });
    }
    return json(route, { success: false, error: 'e2e: not mocked' });
  });
}

const orderPosts = (m: Mock) => m.calls.filter(c => c.method === 'POST' && c.path === '/api/options/order');
const newMock = (bk: Bk): Mock => ({ bk, calls: [], blocked: [], book: { dhan: new Map(), kotak: new Map() }, next: new Map(), ordersSeq: 0 });

async function openAndTrade(page: Page) {
  await page.goto('/options/live-charts', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Trade/ }).first().click({ timeout: 90_000 });
  const submit = page.getByRole('button', { name: /SUBMIT BASKET ORDER/ });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  return submit;
}

let m: Mock;
test.beforeEach(async ({ context }) => { await signIn(context); });
test.afterEach(() => { expect(m.blocked.map(c => `${c.method} ${c.path}`), 'an unmocked write was attempted').toEqual([]); });

test('Kotak: the straddle goes to Kotak by trading symbol, lands on the desk, and the desk exits it on Kotak', async ({ page }) => {
  m = newMock('kotak');
  await install(page, m);
  const submit = await openAndTrade(page);
  await expect(page.getByText(kSym(25000, 'CE')).first()).toBeVisible();
  await submit.click();
  await expect(page.getByText(/Dispatched Successfully/)).toBeVisible();

  const placed = orderPosts(m)[0].body!;
  expect(placed.broker).toBe('kotak');
  expect(placed.mode).toBe('intraday');
  expect(placed.legs).toEqual([
    { tradingSymbol: kSym(25000, 'CE'), exchange: 'nse_fo', quantity: LOT, side: 'SELL', orderType: 'MARKET' },
    { tradingSymbol: kSym(25000, 'PE'), exchange: 'nse_fo', quantity: LOT, side: 'SELL', orderType: 'MARKET' },
  ]);
  // Never the Dhan account: no Dhan lookup / positions read for the order, no Dhan order route.
  expect(m.calls.filter(c => c.path === '/api/scalper/lookup' || c.path === '/api/scalper/fast-order')).toEqual([]);

  await page.keyboard.press('Escape');
  // The desk reads Kotak and prices the legs from Dhan's chain (Kotak sends no price): an estimate, not ₹0.
  await expect(page.getByText(/est\./).first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Exit', exact: true }).first().click();
  await expect.poll(() => orderPosts(m).length).toBe(2);
  expect(orderPosts(m)[1].body).toMatchObject({ broker: 'kotak', legs: [{ tradingSymbol: kSym(25000, 'CE'), side: 'BUY', quantity: LOT, exchange: 'nse_fo' }] });
  expect(m.calls.some(c => c.path === '/api/scalper/positions')).toBe(false);
});

test('Kotak: a leg whose order is UNKNOWN is never shown as placed; the leg that went out is still on the desk', async ({ page }) => {
  m = newMock('kotak');
  m.next.set(kSym(25000, 'PE'), 'unknown');
  await install(page, m);
  const submit = await openAndTrade(page);
  await submit.click();
  await expect(page.getByText(/Status UNKNOWN \(may be live, not retried\): SELL 25000 PE/)).toBeVisible();
  await expect(page.getByText(/Placed \(now on the desk\): SELL 25000 CE/)).toBeVisible();
  await expect(page.getByText(/Dispatched Successfully/)).toHaveCount(0);
  // Not re-sendable from the same ticket.
  await expect(submit).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Exit', exact: true })).toHaveCount(1, { timeout: 20_000 });
  expect(orderPosts(m)).toHaveLength(1);
});

test('Kotak: an exit whose order is UNKNOWN holds the next exit on that leg', async ({ page }) => {
  m = newMock('kotak');
  await install(page, m);
  const submit = await openAndTrade(page);
  await submit.click();
  await expect(page.getByText(/Dispatched Successfully/)).toBeVisible();
  await page.keyboard.press('Escape');
  m.next.set(kSym(25000, 'CE'), 'unknown');
  const exit = page.getByRole('button', { name: 'Exit', exact: true }).first();
  await exit.click();
  await expect(page.getByText(/exit status UNKNOWN/)).toBeVisible({ timeout: 20_000 });
  await exit.click();
  await expect(page.getByText(/previous exit's status is UNKNOWN/)).toBeVisible();
  expect(orderPosts(m)).toHaveLength(2);
});

test('Dhan: unchanged — security ids, Dhan lookups, broker dhan', async ({ page }) => {
  m = newMock('dhan');
  await install(page, m);
  const submit = await openAndTrade(page);
  await submit.click();
  await expect(page.getByText(/Dispatched Successfully/)).toBeVisible();
  const placed = orderPosts(m)[0].body!;
  expect(placed.broker).toBe('dhan');
  expect(placed.legs).toEqual([
    { securityId: dId(25000, 'CE'), exchangeSegment: 'NSE_FNO', quantity: LOT, side: 'SELL', orderType: 'MARKET' },
    { securityId: dId(25000, 'PE'), exchangeSegment: 'NSE_FNO', quantity: LOT, side: 'SELL', orderType: 'MARKET' },
  ]);
  expect(m.calls.some(c => c.path.startsWith('/api/scalper/kotak/'))).toBe(false);
});
