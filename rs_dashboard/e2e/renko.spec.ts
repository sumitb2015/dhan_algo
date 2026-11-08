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
    if (p === '/api/straddle-pnf/server-guard') return json(route, { success: true, guards: {} });   // the page syncs its MTM guard to the server watcher
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
  // Settings: a points box by default (the % / pts toggle is there too), and Confirm instead of Reversal
  await expect(page.getByLabel('Box points')).toHaveValue('10');
  await expect(page.getByRole('group', { name: 'Box unit' }).getByRole('button', { name: 'pts' })).toHaveAttribute('aria-pressed', 'true');
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

test('Log % box: the log% unit draws percentage-compounding bricks, and switching back to points restores the same chart', async ({ page }) => {
  const blocked: Call[] = [];
  await install(page, blocked, []);
  await page.goto('/renko');
  const panel = page.getByTestId('pnf-panel').first();
  const count = async (id: string) => ((await panel.getByTestId(id).getAttribute('d')) ?? '').split('z').length - 1;
  await expect.poll(() => count('pnf-bricks-up')).toBe(6);
  const unit = page.getByRole('group', { name: 'Box unit' });
  await unit.getByRole('button', { name: 'log%' }).click();
  await expect(unit.getByRole('button', { name: 'log%' })).toHaveAttribute('aria-pressed', 'true');
  const input = page.getByLabel('Box log %');
  await expect(input).toHaveValue('0.1');
  await input.fill('0.05');
  await input.press('Enter');
  // 22,640-22,680 is about 0.18 %: a handful of 0.05 % bricks (about 11.3 points each), not the 10-point chart's 9
  await expect(page.getByTestId('pnf-box-info').first()).toContainText(/Log 0\.05%.*brick now/);
  await expect.poll(async () => (await count('pnf-bricks-up')) + (await count('pnf-bricks-down'))).toBeGreaterThan(0);
  expect((await count('pnf-bricks-up')) + (await count('pnf-bricks-down'))).toBeLessThan(9);
  // back to points: the Traditional chart is exactly as before
  await unit.getByRole('button', { name: 'pts' }).click();
  await expect.poll(() => count('pnf-bricks-up')).toBe(6);
  expect(await count('pnf-bricks-down')).toBe(3);
  expect(blocked).toEqual([]);
});

test('the Supertrend is drawn on the bricks, its period / multiplier apply on Enter, and the eye hides it', async ({ page }) => {
  const blocked: Call[] = [];
  await install(page, blocked, []);
  await page.goto('/renko');
  const panel = page.getByTestId('pnf-panel').first();
  await expect.poll(async () => ((await panel.getByTestId('pnf-bricks-up').getAttribute('d')) ?? '').length).toBeGreaterThan(0);
  // 9 bricks: the default ATR 10 has no value yet, and the legend says why
  await expect(panel.getByTestId('pnf-supertrend-legend').first()).toContainText('ST 10,3 needs 11 bricks');
  await expect(panel.getByTestId('pnf-supertrend-up')).toHaveCount(0);
  const period = page.getByRole('textbox', { name: 'Supertrend period' });
  await period.fill('3');
  await period.press('Enter');
  const mult = page.getByRole('textbox', { name: 'Supertrend multiplier' });
  await mult.fill('1');
  await mult.press('Enter');
  await expect(panel.getByTestId('pnf-supertrend-legend').first()).toContainText('ST 3,1');
  // the last run is up: the line ends below the bricks, in green
  await expect(panel.getByTestId('pnf-supertrend-legend').first()).toContainText('▲');
  await expect(panel.getByTestId('pnf-supertrend-up')).toHaveCount(1);
  await page.getByRole('button', { name: 'Hide the Supertrend' }).click();
  await expect(panel.getByTestId('pnf-supertrend-up')).toHaveCount(0);
  await expect(panel.getByTestId('pnf-supertrend-legend')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show the Supertrend' }).click();
  await expect(panel.getByTestId('pnf-supertrend-up')).toHaveCount(1);
  expect(blocked).toEqual([]);
});

test('pivot high / low lines sit on the swing extremes, the strength cycles, and the PV button hides them', async ({ page }) => {
  const blocked: Call[] = [];
  await install(page, blocked, []);
  await page.goto('/renko');
  const panel = page.getByTestId('pnf-panel').first();
  // up to 22680, down to 22640, up again: the top and the bottom hold (the last up brick only reaches 22680, not past it)
  await expect(panel.locator('[data-testid="pnf-pivot"][data-kind="H"][data-broken="0"]')).toHaveCount(1);
  await expect(panel.locator('[data-testid="pnf-pivot"][data-kind="L"][data-broken="0"]')).toHaveCount(1);
  await expect(panel.getByTestId('pnf-pivot').first()).toContainText(/P[HL] 22,6[48]0/);
  await page.getByRole('button', { name: /Pivots need a 2-brick swing/ }).first().click();
  await expect(page.getByRole('button', { name: /Pivots need a 3-brick swing/ }).first()).toBeVisible();
  await expect(panel.getByTestId('pnf-pivot')).toHaveCount(2);   // both runs are 3 bricks long
  await page.getByRole('button', { name: 'Hide pivot high / low lines' }).first().click();
  await expect(panel.getByTestId('pnf-pivot')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show pivot high / low lines' }).first().click();
  await expect(panel.getByTestId('pnf-pivot')).toHaveCount(2);
  expect(blocked).toEqual([]);
});

test('dragging the price axis zooms vertically only: the bricks grow taller, the columns keep their width', async ({ page }) => {
  const blocked: Call[] = [];
  await install(page, blocked, []);
  await page.goto('/renko');
  const panel = page.getByTestId('pnf-panel').first();
  const newest = panel.getByTestId('pnf-newest');
  await expect(newest).toHaveCount(1);
  const size = async () => ({ w: Number(await newest.getAttribute('width')), h: Number(await newest.getAttribute('height')) });
  const before = await size();
  const axis = panel.getByTestId('pnf-axis-drag');
  const box = (await axis.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height, 600) / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 60, { steps: 6 });    // up: zoom in
  await page.mouse.up();
  await expect.poll(async () => (await size()).h).toBeGreaterThan(before.h);
  expect((await size()).w).toBe(before.w);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 150, { steps: 10 });  // down: zoom out past the start
  await page.mouse.up();
  await expect.poll(async () => (await size()).h).toBeLessThan(before.h);
  expect((await size()).w).toBe(before.w);
  expect(blocked).toEqual([]);
});

test('the order Style bar sits in the trade bar row, never over the charts', async ({ page }) => {
  const blocked: Call[] = [];
  await install(page, blocked, []);
  await page.goto('/renko');
  const style = page.getByTestId('pnf-style-bar');
  await expect(style).toHaveCount(1);
  await expect(page.getByTestId('pnf-trade-bar').getByTestId('pnf-style-bar')).toHaveCount(1);
  const s = (await style.boundingBox())!;
  for (const panel of await page.getByTestId('pnf-panel').all()) {
    const p = (await panel.boundingBox())!;
    expect(s.y + s.height).toBeLessThanOrEqual(p.y);   // wholly above every chart card
  }
  expect(blocked).toEqual([]);
});
