import { expect, test, type Page, type Route } from '@playwright/test';
import { json, signIn, type Call } from './support';

// Options Monitor (/options-monitor) sending its basket to ZERODHA, every /api/* call mocked: nothing reaches a broker
// and any unexpected write fails the test. The chain, live feed and Greeks stay Dhan's; the order ticket resolves
// Zerodha's own contracts (trading symbols) and /api/options/order carries broker 'zerodha' with NFO legs. Zerodha
// places MARKET and LIMIT only (no resting stop entries), so the ticket offers no SL types.

const EXP = '2026-10-27';
const STRIKES = [24800, 24850, 24900, 24950, 25000, 25050, 25100, 25150, 25200];
const LOT = 65;
const zSym = (k: number, o: 'CE' | 'PE') => `NIFTY26O27${k}${o}`;

let calls: Call[];
let blocked: Call[];

async function install(page: Page) {
  await page.addInitScript(() => { try { localStorage.setItem('optionsMonitor.broker', 'zerodha'); } catch { /* ignore */ } });
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    const body = method === 'GET' ? null : (req.postDataJSON() as Record<string, unknown> | null);
    calls.push({ method, path: p, search: u.search, body });

    if (p === '/api/auth/broker-status') return json(route, { dhan: true, zerodha: true, kotak: false });
    if (p === '/api/options/expiries') return json(route, { success: true, data: [EXP] });
    if (p === '/api/options/chain') {
      const oc = Object.fromEntries(STRIKES.map(k => [`${k}.000000`, {
        ce: { last_price: 80, security_id: `${k}1`, implied_volatility: 12 },
        pe: { last_price: 75, security_id: `${k}2`, implied_volatility: 13 },
      }]));
      return json(route, { success: true, data: { spot: 25010, prev_close: 24990, chain: { oc } } });
    }
    if (p === '/api/options-monitor/trades') return json(route, { success: true, legs: [] });
    if (p === '/api/scalper/zerodha/funds') return json(route, { success: true, data: { availabelBalance: 2_000_000 } });
    if (p === '/api/scalper/zerodha/lookup') {
      return json(route, { success: true, data: { lotSize: LOT, strikes: Object.fromEntries(STRIKES.map(k => [String(k), { ceSymbol: zSym(k, 'CE'), peSymbol: zSym(k, 'PE') }])) } });
    }
    if (p === '/api/scalper/zerodha/positions') return json(route, { success: true, data: [] });
    if (p === '/api/options/order' && method === 'POST') {
      const legs = (body?.legs ?? []) as { tradingSymbol?: string }[];
      return json(route, { success: true, data: legs.map((l, i) => ({ success: true, orderId: `Z${i + 1}`, tradingSymbol: l.tradingSymbol })) });
    }
    if (method === 'POST' && p === '/api/options/live') return json(route, { success: true });
    if (method !== 'GET') {
      blocked.push({ method, path: p, search: u.search, body });
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' });
    }
    return json(route, { success: false, error: 'e2e: not mocked' });
  });
}

test.beforeEach(async ({ context }) => { calls = []; blocked = []; await signIn(context); });
test.afterEach(() => { expect(blocked.map(c => `${c.method} ${c.path}`), 'an unmocked write was attempted').toEqual([]); });

test('Zerodha: the strangle goes by trading symbol on NFO, MARKET/LIMIT only, and the Dhan account is never read', async ({ page }) => {
  await install(page);
  await page.goto('/options-monitor', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /EXECUTE BASKET/ }).first().click({ timeout: 90_000 });
  // No resting stop entries on Zerodha.
  await expect(page.getByRole('button', { name: 'SL-M', exact: true })).toHaveCount(0);
  const submit = page.getByRole('button', { name: /SUBMIT BASKET ORDER/ });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await submit.click();
  await expect(page.getByText(/Dispatched Successfully/)).toBeVisible();

  const placed = calls.filter(c => c.method === 'POST' && c.path === '/api/options/order')[0].body!;
  expect(placed.broker).toBe('zerodha');
  expect((placed.legs as { tradingSymbol: string }[]).map(l => l.tradingSymbol).sort()).toEqual([zSym(24900, 'PE'), zSym(25100, 'CE')].sort());
  expect(placed.legs).toEqual(expect.arrayContaining([expect.objectContaining({ exchange: 'NFO', quantity: LOT, side: 'SELL' })]));
  expect(calls.some(c => c.path === '/api/scalper/zerodha/funds')).toBe(true);
  expect(calls.filter(c => ['/api/scalper/funds', '/api/scalper/lookup', '/api/scalper/positions', '/api/scalper/fast-order'].includes(c.path))).toEqual([]);
});
