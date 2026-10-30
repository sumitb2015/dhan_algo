import { test, expect, type Page } from '@playwright/test';
import { json, signIn } from './support';

// Point & Figure (/straddle-pnf): chart controls (drag pan, wheel zoom, Re-center), the CRUDEOILM future and the index / stock search.
const KEY = 25000;
const NOW_MIN = Math.floor(Date.now() / 60_000) * 60;
const series = (base: number, step = 0.5) => [0, 5, 2, 0, 3, 7, 4].map((l, i, a) => {
  const s = base + l * step;
  return { t: NOW_MIN - 120 - (a.length - 1 - i) * 60, ce: s, pe: 0, straddle: s, vol: 10 };
});

test.beforeEach(async ({ context }) => { await signIn(context); });

/** Answers every /api call; `seen` collects the history queries so a test can check what the page asked for. */
async function mockApi(page: Page, seen: string[] = []) {
  await page.route('**/api/**', async route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/api/straddle-pnf/search') {
      const q = (u.searchParams.get('q') ?? '').toUpperCase();
      return json(route, { success: true, results: q.startsWith('REL') ? [{ kind: 'equity', symbol: 'RELIANCE', name: 'RELIANCE INDUSTRIES LIMITED' }] : [{ kind: 'index', symbol: 'NIFTY', name: 'Nifty 50' }] });
    }
    if (u.pathname === '/api/straddle-pnf') {
      seen.push(u.search);
      if (u.searchParams.get('underlying') === 'CRUDEOILM') {
        return json(route, { success: true, mode: 'futures', atm: 0, strikes: [20261119], errors: {}, dataDate: '2026-10-23', expiries: { 20261119: '2026-11-19' }, bars: { 20261119: series(9600, 20) } });
      }
      if (u.searchParams.get('symbol') === 'RELIANCE') {
        return json(route, { success: true, mode: 'price', atm: 0, strikes: [0], name: 'RELIANCE INDUSTRIES LIMITED', errors: {}, dataDate: '2026-10-23', bars: { 0: series(1200, 2) } });
      }
      return json(route, { success: true, mode: 'price', atm: 0, strikes: [KEY], name: 'Nifty 50', errors: {}, dataDate: '2026-10-23', bars: { [KEY]: series(100) } });
    }
    if (route.request().method() === 'GET') return json(route, { success: true });
    return route.fulfill({ status: 599, body: 'blocked' });
  });
}

test('drag pans and wheel zooms a chart that fits the panel', async ({ page }) => {
  await mockApi(page);
  await page.goto('/straddle-pnf');
  const panel = page.locator(`[data-testid="pnf-panel"][data-strike="${KEY}"]`);
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

test('the CRUDEOILM button charts the nearest future', async ({ page }) => {
  const seen: string[] = [];
  await mockApi(page, seen);
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);   // hydrated: a click before that is lost
  await page.getByRole('button', { name: 'CRUDEOILM' }).click();
  await expect(page.getByTestId('pnf-panel')).toHaveCount(1);
  await expect(page.getByText('CRUDEOILM Nov 2026').first()).toBeVisible();     // the contract month, in the page subtitle
  await expect(page.getByTestId('pnf-header-summary')).not.toContainText('CE ');
  await expect(page.getByLabel('Expiry')).toHaveCount(0);
  expect(seen.some(s => s.includes('underlying=CRUDEOILM'))).toBe(true);
});

test('Re-center resets zoom and puts the newest column in the middle of the chart', async ({ page }) => {
  await mockApi(page);
  await page.goto('/straddle-pnf');
  const panel = page.locator(`[data-testid="pnf-panel"][data-strike="${KEY}"]`);
  const sc = panel.getByTestId('pnf-scroll');
  await expect(panel.getByTestId('pnf-grid')).toBeAttached();
  const b = (await sc.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, -300);                                           // zoom in…
  await expect(panel.getByTestId('pnf-zoom')).not.toHaveAttribute('data-zoom', '1');
  await page.mouse.down(); await page.mouse.move(b.x + 100, b.y + 100, { steps: 6 }); await page.mouse.up();   // …and pan away
  await page.getByRole('button', { name: 'Re-center' }).click();
  await expect(panel.getByTestId('pnf-zoom')).toHaveAttribute('data-zoom', '1');
  // the newest glyph now sits near the horizontal middle of the plot (the view minus the pinned axis)
  await expect.poll(async () => {
    const g = (await panel.getByRole('img', { name: /point and figure chart/ }).locator('path, circle').last().boundingBox())!;
    return Math.abs(g.x + g.width / 2 - (b.x + (b.width - 66) / 2));   // 66 = AXIS_W
  }).toBeLessThan(30);
});

test('the search box charts a stock by its plain price, and NIFTY goes back to the index', async ({ page }) => {
  const seen: string[] = [];
  await mockApi(page, seen);
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await page.getByRole('combobox', { name: 'Search index or stock' }).fill('rel');
  await page.getByRole('option', { name: /RELIANCE/ }).click();
  await expect(page.getByText('RELIANCE INDUSTRIES LIMITED').first()).toBeVisible();
  await expect(page.getByTestId('pnf-panel')).toHaveCount(1);
  expect(seen.some(s => s.includes('mode=price') && s.includes('kind=equity') && s.includes('symbol=RELIANCE'))).toBe(true);
  await page.reload();                                                         // the pick is remembered
  await expect(page.getByText('RELIANCE INDUSTRIES LIMITED').first()).toBeVisible();
  await page.getByRole('button', { name: 'NIFTY', exact: true }).click();
  await expect(page.getByText('Nifty 50').first()).toBeVisible();
});
