import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn, type Call } from './support';

// Renko (/renko): the Point & Figure page with the chart swapped for bricks (lib/renko.ts). Every /api/* call is answered here;
// any non-GET this mock does not handle is refused with 599 and fails the test. Proves the bricks, the Renko settings, the
// N-brick signal and that the page reads its OWN AUTO / resting ledgers (?scope=renko), never the P&F page's.

const NOW_MIN = Math.floor(Date.now() / 60_000) * 60;
// NIFTY closes on a 10-point grid: up 3 bricks, down 3, up 3 (a 2-brick confirmation fires on the 2nd brick of each new run)
const CLOSES = [22650, 22660, 22670, 22680, 22660, 22650, 22640, 22660, 22670, 22680];

function history() {
  const start = NOW_MIN - 120 - (CLOSES.length - 1) * 60;   // the last bar is two minutes old: closed
  return CLOSES.map((c, i) => ({ t: start + i * 60, ce: c, pe: 0, straddle: c, vol: 0 }));
}

async function install(page: Page, blocked: Call[], ledgerCalls: string[]) {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    if (p === '/api/straddle-pnf' && method === 'GET') {
      return json(route, { success: true, mode: 'price', atm: 0, strikes: [1], name: 'Nifty 50', instrument: { segment: 'IDX_I', security_id: '13' }, errors: {}, dataDate: '2026-10-30', bars: { 1: history() } });
    }
    if ((p === '/api/straddle-pnf/auto' || p === '/api/straddle-pnf/resting') && method === 'GET') {
      ledgerCalls.push(`${p}${u.search}`);
      return json(route, { success: true, ledger: { rev: 0, rows: [], log: [] } });
    }
    if (p === '/api/straddle-pnf/live' && method === 'GET') return json(route, { success: true, bridge: true, hub: true, quote: null, last: null, legs: [{ quote: null, last: null }] });
    if (p === '/api/live-indices' && method === 'POST') return json(route, { success: true });
    if (method === 'GET') return json(route, { success: true });
    blocked.push({ method, path: p, search: u.search, body: null });
    return route.fulfill({ status: 599, body: 'blocked by e2e mock' });
  });
}

test.beforeEach(async ({ context }) => { await signIn(context); });

test('Renko draws bricks with a points box and N-brick confirmation, on its own ledgers', async ({ page }) => {
  const blocked: Call[] = [];
  const ledgerCalls: string[] = [];
  await install(page, blocked, ledgerCalls);
  await page.goto('/renko');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Renko');
  const panel = page.getByTestId('pnf-panel').first();
  // up 22650-80 (3), down to 22640 (3), up to 22680 (3): one "z" per brick
  await expect.poll(async () => ((await panel.getByTestId('pnf-bricks-up').getAttribute('d')) ?? '').split('z').length - 1).toBe(6);
  expect(((await panel.getByTestId('pnf-bricks-down').getAttribute('d')) ?? '').split('z').length - 1).toBe(3);
  await expect(panel.getByTestId('pnf-glyphs-x')).toHaveCount(0);
  // Settings: points only (no % / pts toggle), and Confirm instead of Reversal
  await expect(page.getByLabel('Box points')).toHaveValue('10');
  await expect(page.getByRole('group', { name: 'Box unit' })).toHaveCount(0);
  await expect(page.getByLabel('Confirm bricks')).toHaveValue('2');
  await expect(page.getByLabel('Reversal')).toHaveCount(0);
  // 2-brick confirmation: SELL on the 2nd down brick, BUY on the 2nd up brick after it
  await expect(panel.locator('[data-testid="pnf-signal"]')).toHaveCount(2);
  await expect(panel.locator('[data-testid="pnf-signal"][data-kind="RENKO_BUY"]')).toHaveCount(1);
  await expect(page.getByTestId('pnf-header-summary')).toContainText('Renko buy');
  // No P&F-only devices: no triangle buttons, no COVER tag button
  await expect(page.getByRole('button', { name: /triangles/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /COVER tag/ })).toHaveCount(0);
  // Its own ledgers
  await expect.poll(() => ledgerCalls.length).toBeGreaterThan(1);
  expect(ledgerCalls.every(c => c.endsWith('?scope=renko'))).toBe(true);
  expect(blocked).toEqual([]);
});
