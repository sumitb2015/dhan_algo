import { test, expect } from '@playwright/test';
import { json, signIn } from './support';

// Straddle P&F: mouse drag pans and the wheel zooms, even on a chart that already fits its panel.
const ATM = 25000;
const NOW_MIN = Math.floor(Date.now() / 60_000) * 60;
const bars = [0, 5, 2, 0, 3, 7, 4].map((l, i, a) => {
  const s = 100 + l * 0.5;
  return { t: NOW_MIN - 120 - (a.length - 1 - i) * 60, ce: s / 2, pe: s / 2, straddle: s, vol: 10 };
});

test.beforeEach(async ({ context }) => { await signIn(context); });

test('drag pans and wheel zooms a chart that fits the panel', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/straddle-pnf') return json(route, { success: true, atm: ATM, strikes: [ATM - 200, ATM, ATM + 200], errors: {}, dataDate: '2026-10-23', bars: { [ATM]: bars } });
    if (p === '/api/options/expiries') return json(route, { success: true, data: ['2099-01-06', '2099-01-13'] });
    if (route.request().method() === 'GET') return json(route, { success: true });
    return route.fulfill({ status: 599, body: 'blocked' });
  });
  await page.goto('/straddle-pnf');
  const panel = page.locator(`[data-testid="pnf-panel"][data-strike="${ATM}"]`);
  const sc = panel.getByTestId('pnf-scroll');
  await expect(panel.getByTestId('pnf-grid')).toBeAttached();
  const pos = () => sc.evaluate(el => ({ l: el.scrollLeft, t: el.scrollTop, sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight }));
  const p0 = await pos();
  expect(p0.sw).toBeGreaterThan(p0.cw);
  expect(p0.sh).toBeGreaterThan(p0.ch);

  const b = (await sc.boundingBox())!;
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 80, { steps: 8 });
  await page.mouse.up();
  const p1 = await pos();
  expect(p1.l).toBeLessThan(p0.l - 50);
  expect(p1.t).not.toBe(p0.t);

  // Drag the chart to the left, away from the price axis: the newest column must be able to leave the right margin.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 300, cy, { steps: 8 });
  await page.mouse.up();
  const p2 = await pos();
  expect(p2.l).toBeGreaterThan(p0.l + 50);            // past the position where the newest column touches the axis

  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -300);
  await expect(panel.getByTestId('pnf-zoom')).not.toHaveAttribute('data-zoom', '1');
  await panel.getByRole('button', { name: 'Fit chart to panel' }).click();
  await expect(panel.getByTestId('pnf-zoom')).toHaveAttribute('data-zoom', '1');
});

test('CRUDEOILM charts the upcoming futures, not straddles', async ({ page }) => {
  const mk = (base: number) => [0, 3, 1, 4, 2].map((l, i, a) => ({ t: NOW_MIN - 120 - (a.length - 1 - i) * 60, ce: base + l * 20, pe: 0, straddle: base + l * 20, vol: 10 }));
  await page.route('**/api/**', async route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/api/straddle-pnf') {
      if (u.searchParams.get('underlying') !== 'CRUDEOILM') return json(route, { success: true, atm: ATM, strikes: [ATM - 200, ATM, ATM + 200], errors: {}, dataDate: '2026-10-23', bars: { [ATM]: bars } });
      return json(route, { success: true, mode: 'futures', atm: 0, strikes: [20261119], errors: {}, dataDate: '2026-10-23',
        expiries: { 20261119: '2026-11-19' }, bars: { 20261119: mk(9600) } });
    }
    if (u.pathname === '/api/options/expiries') return json(route, { success: true, data: ['2099-01-06'] });
    if (route.request().method() === 'GET') return json(route, { success: true });
    return route.fulfill({ status: 599, body: 'blocked' });
  });
  await page.goto('/straddle-pnf');
  await page.getByRole('button', { name: 'CRUDEOILM' }).click();
  const panels = page.getByTestId('pnf-panel');
  await expect(panels).toHaveCount(1);
  await expect(panels.nth(0)).toContainText('CRUDEOILM Nov 2026 futures');   // the nearest month
  await expect(panels.nth(0)).not.toContainText('CE ');
  await expect(page.getByLabel('Expiry')).toHaveCount(0);
  await expect(page.getByLabel('ATM', { exact: true })).toHaveCount(0);
});
