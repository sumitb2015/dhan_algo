import { expect, test, type Page, type Route } from '@playwright/test';
import { json, signIn, type Call } from './support';

// Options Monitor (/options-monitor) sending its basket to KOTAK (and still DHAN), every /api/* call mocked; nothing
// reaches a broker and any unexpected write fails the test. The chain, live feed and Greeks stay Dhan's; the order
// ticket resolves Kotak's own contracts. On load the page builds a short strangle at ATM ± 2 strikes from the chain.

const EXP = '2026-10-27';
const STRIKES = [24800, 24850, 24900, 24950, 25000, 25050, 25100, 25150, 25200];
const LOT = 65;
const kSym = (k: number, o: 'CE' | 'PE') => `NIFTY26O27${k}${o}`;
const dId = (k: number, o: 'CE' | 'PE') => `${k}${o === 'CE' ? 1 : 2}`;

interface Mock {
  calls: Call[];
  blocked: Call[];
  /** Per-contract reply for /api/options/order legs: placed (default), 'reject' or 'unknown'. */
  next: Map<string, 'reject' | 'unknown'>;
  /** contract -> { net qty, product } per broker: placed orders move it, positions read it. */
  book: Record<'dhan' | 'kotak', Map<string, { net: number; product: string }>>;
  /** The persisted page trades (app/api/options-monitor/trades), by leg id — survives a reload within a test. */
  stored: Map<string, Record<string, unknown>>;
}

async function install(page: Page, m: Mock, broker: 'dhan' | 'kotak') {
  await page.addInitScript((b: string) => { try { localStorage.setItem('optionsMonitor.broker', b); } catch { /* ignore */ } }, broker);
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    const body = method === 'GET' ? null : (req.postDataJSON() as Record<string, unknown> | null);
    m.calls.push({ method, path: p, search: u.search, body });

    if (p === '/api/auth/broker-status') return json(route, { dhan: true, zerodha: false, kotak: true });
    if (p === '/api/options/expiries') return json(route, { success: true, data: [EXP] });
    if (p === '/api/options/chain') {
      const oc = Object.fromEntries(STRIKES.map(k => [`${k}.000000`, {
        ce: { last_price: 80, security_id: dId(k, 'CE'), implied_volatility: 12 },
        pe: { last_price: 75, security_id: dId(k, 'PE'), implied_volatility: 13 },
      }]));
      return json(route, { success: true, data: { spot: 25010, prev_close: 24990, chain: { oc } } });
    }
    if (p === '/api/options-monitor/trades') {
      if (method === 'POST') {
        for (const l of (body?.legs ?? []) as Record<string, unknown>[]) m.stored.set(String(l.id), l);
        for (const r of (body?.removed ?? []) as { id: string }[]) m.stored.delete(r.id);
      }
      return json(route, { success: true, legs: [...m.stored.values()] });
    }
    if (p === '/api/scalper/funds') return json(route, { success: true, data: { availabelBalance: 1_000_000 } });
    if (p === '/api/scalper/kotak/funds') return json(route, { success: true, data: { availabelBalance: 2_500_000 } });
    if (p === '/api/scalper/lookup') return json(route, { success: true, data: { lotSize: LOT, strikes: Object.fromEntries(STRIKES.map(k => [String(k), { ceId: dId(k, 'CE'), peId: dId(k, 'PE') }])) } });
    if (p === '/api/scalper/kotak/lookup') return json(route, { success: true, data: { lotSize: LOT, strikes: Object.fromEntries(STRIKES.map(k => [String(k), { ceSymbol: kSym(k, 'CE'), peSymbol: kSym(k, 'PE') }])) } });
    if (p === '/api/scalper/positions' || p === '/api/scalper/kotak/positions') {
      const bk = p.includes('/kotak/') ? 'kotak' : 'dhan';
      const data = [...m.book[bk].entries()].filter(([, v]) => v.net !== 0).map(([c, v]) => (bk === 'kotak'
        ? { tradingSymbol: c, securityId: '777', exchange: 'nse_fo', productType: v.product === 'MARGIN' ? 'NRML' : 'MIS', netQty: v.net }
        : { securityId: c, exchangeSegment: 'NSE_FNO', productType: v.product, netQty: v.net }));
      return json(route, { success: true, data });
    }
    if (p === '/api/options/order' && method === 'POST') {
      const bk = (body?.broker as string | undefined) ?? 'dhan';
      const legs = (body?.legs ?? []) as { securityId?: string; tradingSymbol?: string; quantity: number; side: 'BUY' | 'SELL' }[];
      const product = body?.mode === 'positional' ? 'MARGIN' : 'INTRADAY';
      const data = legs.map((l, i) => {
        const c = String(bk === 'kotak' ? l.tradingSymbol : l.securityId);
        const echo = bk === 'kotak' ? { tradingSymbol: c } : { securityId: c };
        const mode = m.next.get(c);
        m.next.delete(c);
        if (mode === 'reject') return { success: false, error: 'e2e: RMS reject', ...echo };
        if (mode === 'unknown') return { success: false, unknown: true, error: 'e2e: no reply', ...echo };
        const book = m.book[bk as 'dhan' | 'kotak'];
        book.set(c, { net: (book.get(c)?.net ?? 0) + (l.side === 'BUY' ? l.quantity : -l.quantity), product });
        return { success: true, orderId: `M${i + 1}`, ...echo };
      });
      const failed = data.filter(d => !d.success);
      return json(route, failed.length
        ? { success: false, ...(failed.some(f => (f as { unknown?: boolean }).unknown) ? { unknown: true } : {}), error: 'e2e partial', data }
        : { success: true, data });
    }
    if (method === 'POST' && p === '/api/options/live') return json(route, { success: true });
    if (method !== 'GET') {
      m.blocked.push({ method, path: p, search: u.search, body });
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' });
    }
    return json(route, { success: false, error: 'e2e: not mocked' });
  });
}

const orderPosts = (m: Mock) => m.calls.filter(c => c.method === 'POST' && c.path === '/api/options/order');
const lockedLegs = (page: Page) => page.locator('[title^="Trade Entered: Strike locked"]');

async function executeBasket(page: Page) {
  await page.goto('/options-monitor', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /EXECUTE BASKET/ }).first().click({ timeout: 90_000 });
  const submit = page.getByRole('button', { name: /SUBMIT BASKET ORDER/ });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await submit.click();
}

let m: Mock;
test.beforeEach(async ({ context }) => {
  m = { calls: [], blocked: [], next: new Map(), book: { dhan: new Map(), kotak: new Map() }, stored: new Map() };
  await signIn(context);
});
test.afterEach(() => { expect(m.blocked.map(c => `${c.method} ${c.path}`), 'an unmocked write was attempted').toEqual([]); });

test('Kotak: the strangle goes to Kotak by trading symbol; margin is Kotak\'s; the Dhan account is never read', async ({ page }) => {
  await install(page, m, 'kotak');
  await executeBasket(page);
  await expect(page.getByText(/Dispatched Successfully/)).toBeVisible();
  const placed = orderPosts(m)[0].body!;
  expect(placed.broker).toBe('kotak');
  expect((placed.legs as { tradingSymbol: string }[]).map(l => l.tradingSymbol).sort()).toEqual([kSym(24900, 'PE'), kSym(25100, 'CE')].sort());
  expect(placed.legs).toEqual(expect.arrayContaining([expect.objectContaining({ exchange: 'nse_fo', quantity: LOT, side: 'SELL' })]));
  // Funds, contracts and the product lock all came from Kotak; Dhan was used for market data only.
  expect(m.calls.some(c => c.path === '/api/scalper/kotak/funds')).toBe(true);
  expect(m.calls.filter(c => ['/api/scalper/funds', '/api/scalper/lookup', '/api/scalper/positions', '/api/scalper/fast-order'].includes(c.path))).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(lockedLegs(page)).toHaveCount(2);
});

test('Kotak: only the leg that went out is marked entered; the UNKNOWN one is not', async ({ page }) => {
  m.next.set(kSym(24900, 'PE'), 'unknown');
  await install(page, m, 'kotak');
  await executeBasket(page);
  await expect(page.getByText(/Status UNKNOWN \(may be live, not retried\): SELL 24900 PE/)).toBeVisible();
  await page.keyboard.press('Escape');
  // Before: every leg was marked entered on any success.
  await expect(lockedLegs(page)).toHaveCount(1);
  await expect(lockedLegs(page)).toContainText('25100');
});

test('Dhan: unchanged — security ids, Dhan funds', async ({ page }) => {
  await install(page, m, 'dhan');
  await executeBasket(page);
  await expect(page.getByText(/Dispatched Successfully/)).toBeVisible();
  const placed = orderPosts(m)[0].body!;
  expect(placed.broker).toBe('dhan');
  expect((placed.legs as { securityId: string }[]).map(l => l.securityId).sort()).toEqual([dId(24900, 'PE'), dId(25100, 'CE')].sort());
  expect(m.calls.some(c => c.path.startsWith('/api/scalper/kotak/'))).toBe(false);
});

// ── Exit a placed leg ──
const exitBtn = (page: Page, strike: number, type: 'CE' | 'PE') => page.getByRole('button', { name: `Exit SELL ${strike} ${type}` });
async function placeAndClose(page: Page) {
  await executeBasket(page);
  await expect(page.getByText(/Dispatched Successfully/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lockedLegs(page)).toHaveCount(2);
}

test('Kotak: Exit closes what this page placed, on Kotak, by trading symbol, on the leg\'s own product', async ({ page }) => {
  await install(page, m, 'kotak');
  await placeAndClose(page);
  const picker = page.getByRole('combobox', { name: 'Broker for new orders' });
  await expect(picker).toBeDisabled();   // a placed leg is open on Kotak
  const btn = exitBtn(page, 25100, 'CE');
  await btn.click();
  await expect(btn).toHaveText('Confirm exit?');
  expect(orderPosts(m)).toHaveLength(1);   // the first click only arms it
  await btn.click();
  await expect.poll(() => orderPosts(m).length).toBe(2);
  const exit = orderPosts(m)[1].body!;
  expect(exit.broker).toBe('kotak');
  expect(exit.legs).toEqual([{ tradingSymbol: kSym(25100, 'CE'), exchange: 'nse_fo', quantity: LOT, side: 'BUY', orderType: 'MARKET' }]);
  expect(exit.mode).toBe(orderPosts(m)[0].body!.mode);   // the same product it was opened under
  await expect(lockedLegs(page)).toHaveCount(1);
  expect(m.book.kotak.get(kSym(25100, 'CE'))?.net).toBe(0);
  expect(m.calls.some(c => c.path === '/api/scalper/positions' || c.path === '/api/scalper/fast-order')).toBe(false);
});

test('Kotak: an Exit whose order is UNKNOWN holds the next one on that leg', async ({ page }) => {
  await install(page, m, 'kotak');
  await placeAndClose(page);
  m.next.set(kSym(25100, 'CE'), 'unknown');
  const btn = exitBtn(page, 25100, 'CE');
  await btn.click(); await btn.click();
  await expect(page.getByText(/exit status UNKNOWN/).first()).toBeVisible({ timeout: 20_000 });
  await expect(btn).toHaveText('Exit');
  await btn.click(); await btn.click();
  await expect(page.getByText(/previous exit's status is UNKNOWN/).first()).toBeVisible();
  expect(orderPosts(m)).toHaveLength(2);
  await expect(lockedLegs(page)).toHaveCount(2);   // still tracked as open
});

test('Exit never sends against the opposite side of the book', async ({ page }) => {
  await install(page, m, 'kotak');
  await placeAndClose(page);
  m.book.kotak.set(kSym(25100, 'CE'), { net: 65, product: m.book.kotak.get(kSym(25100, 'CE'))!.product });   // flipped outside
  const btn = exitBtn(page, 25100, 'CE');
  await btn.click(); await btn.click();
  await expect(page.getByText(/shows the OPPOSITE side open/).first()).toBeVisible({ timeout: 20_000 });
  expect(orderPosts(m)).toHaveLength(1);
});

test('Dhan: Exit goes to Dhan by security id', async ({ page }) => {
  await install(page, m, 'dhan');
  await placeAndClose(page);
  const btn = exitBtn(page, 24900, 'PE');
  await btn.click(); await btn.click();
  await expect.poll(() => orderPosts(m).length).toBe(2);
  expect(orderPosts(m)[1].body).toMatchObject({ broker: 'dhan', legs: [{ securityId: dId(24900, 'PE'), exchangeSegment: 'NSE_FNO', quantity: LOT, side: 'BUY' }] });
  expect(m.calls.some(c => c.path.startsWith('/api/scalper/kotak/'))).toBe(false);
});

test('Kotak: a placed leg survives a reload — restored with its Exit, which still closes it on Kotak', async ({ page }) => {
  await install(page, m, 'kotak');
  await placeAndClose(page);
  await expect.poll(() => m.stored.size).toBe(2);   // both placed legs saved with their order record
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/Restored 2 leg\(s\) placed from this page/).first()).toBeVisible({ timeout: 60_000 });
  await expect(lockedLegs(page)).toHaveCount(2);
  // The restored strategy replaces the preset: no extra model legs were added.
  await expect(page.getByRole('button', { name: /^Exit SELL/ })).toHaveCount(2);
  const btn = exitBtn(page, 24900, 'PE');
  await btn.click(); await btn.click();
  await expect.poll(() => orderPosts(m).length).toBe(2);
  expect(orderPosts(m)[1].body).toMatchObject({ broker: 'kotak', legs: [{ tradingSymbol: kSym(24900, 'PE'), side: 'BUY', quantity: LOT }] });
  // Fully exited: dropped from the store.
  await expect.poll(() => [...m.stored.keys()].length).toBe(1);
});
