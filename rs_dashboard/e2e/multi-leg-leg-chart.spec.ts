import { expect, test, type Route } from '@playwright/test';
import { json, signIn } from './support';

// Multi-Leg Focus: the per-leg "Chart" button opens that one contract's own premium chart (1 lot).
// Every /api call is answered here; a non-GET that is not handled is refused (599) and fails the test.
// Order routes are never mocked, so nothing can be placed.

const NOW = Date.now();
const istToday = () => new Date(NOW + 5.5 * 3600_000).toISOString().slice(0, 10);

const leg = (id: string, option: 'CE' | 'PE', strike: number) => ({
  id, side: 'S', option, strike, expiry: '2099-12-31', ratio: 1, lots: 6, type: 'MARKET', status: 'OPEN',
  fill: { qty: 390, avgPrice: 18 }, filledAt: NOW, price: 18,
});

const BASKET = {
  id: 'b1', name: 'Short Strangle', underlying: 'NIFTY', expiry: '2099-12-31', broker: 'dhan', presetKey: 'short-strangle',
  multiplier: 1, legs: [leg('l1', 'CE', 23600), leg('l2', 'PE', 21500)], createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), rev: 1,
};

function candles() {
  return Array.from({ length: 40 }, (_, i) => {
    const mins = 9 * 60 + 15 + i;
    const c = 20 - i * 0.1;
    return { time: `${istToday()}T${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00+05:30`, open: c, high: c + 0.3, low: c - 0.3, close: c, volume: 100 };
  });
}

test.beforeEach(async ({ context }) => { await signIn(context); });

test('per-leg Chart button plots only that contract at 1 lot, with its own side', async ({ page }) => {
  const chartLegs: unknown[] = [];
  const blocked: string[] = [];
  let orders = 0;

  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    if (p === '/api/multi-leg-focus/baskets') return json(route, method === 'GET' ? { success: true, data: [BASKET] } : { success: true });
    if (p === '/api/options/live-charts') {
      if (u.searchParams.get('kind') === 'strategy') chartLegs.push(JSON.parse(u.searchParams.get('legs') ?? '[]'));
      return json(route, { success: true, data: {
        expiry: '2099-12-31', legs: JSON.parse(u.searchParams.get('legs') ?? '[]'), spot: 22700, interval: u.searchParams.get('interval') ?? '1',
        net_credit: true, pdc: 19, spot_series: [], candles: candles(), indicators: [], coverage_note: 'e2e',
      } });
    }
    if (p === '/api/options/expiries') return json(route, { success: true, data: ['2099-12-31'] });
    if (p === '/api/scalper/fast-order' || p === '/api/scalper/orders') { orders++; return json(route, { success: false, error: 'e2e: orders disabled' }, 400); }
    if (method === 'GET') return json(route, { success: false, error: 'e2e' }, 503);
    if (p === '/api/multi-leg-focus/margin' && method === 'POST') return json(route, { success: false, error: 'e2e' }, 503);   // read-only margin estimate
    if (p === '/api/options/live' && method === 'POST') return json(route, { success: true });
    blocked.push(`${method} ${p}`);
    return route.fulfill({ status: 599, body: 'blocked by e2e' });
  });

  await page.goto('/multi-leg-focus', { waitUntil: 'domcontentloaded' });
  const row = page.getByRole('button', { name: /Strategy Chart/ });
  await expect(row).toBeVisible({ timeout: 60_000 });

  // Expand the strategy to reach its leg table.
  await page.getByRole('button', { name: /expand|collapse/i }).first().click().catch(() => {});
  const ceChart = page.getByRole('button', { name: 'Chart 23600 CE premium' });
  if (!(await ceChart.isVisible().catch(() => false))) await page.locator('button:has(svg.lucide-chevron-down)').first().click();
  await expect(ceChart).toBeVisible();
  await expect(page.getByRole('button', { name: 'Chart 21500 PE premium' })).toBeVisible();

  await ceChart.click();
  await expect(page.getByText('23600 CE SELL — Strategy chart')).toBeVisible();
  await expect.poll(() => chartLegs.length).toBeGreaterThan(0);
  expect(chartLegs[0]).toEqual([{ option_type: 'CE', action: 'SELL', strike: 23600, lots: 1 }]);

  expect(orders).toBe(0);
  expect(blocked).toEqual([]);
});
