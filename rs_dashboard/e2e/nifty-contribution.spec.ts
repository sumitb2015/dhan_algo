import { test, expect, type Page } from '@playwright/test';
import { json, signIn, type Call } from './support';

// Nifty Contribution (/nifty-contribution): tiles, bar chart, sortable table, stale and reconciliation banners.
// Every /api/* call is answered here; any non-GET this mock does not handle is refused with 599 and fails the test.
// The page places no orders. Its only POSTs start/stop the two shared quote bridges, which are stubbed.

const row = (symbol: string, name: string, points: number, changePct: number, weightPct: number, ltp: number) =>
  ({ symbol, name, points, changePct, weightPct, ltp, prevClose: ltp / (1 + changePct / 100) });

const ROWS = [
  row('LT', 'Larsen', 45.46, 1.2, 4.38, 3700),
  row('SBIN', 'SBI', 7.54, 0.8, 3.81, 960),
  row('AXISBANK', 'Axis Bank', -2.14, -0.2, 3.37, 1280),
  row('HDFCBANK', 'HDFC Bank', -23.82, -1.1, 10.03, 690),
  row('INFY', 'Infosys', -40.39, -3.1, 3.79, 1150),
];

const result = (over: Record<string, unknown> = {}) => ({
  rows: ROWS,
  pullers: ROWS.filter(r => r.points > 0),
  draggers: ROWS.filter(r => r.points < 0).sort((a, b) => a.points - b.points),
  net: -13.35, positiveSum: 53, negativeSum: -66.35,
  residual: 1.4, residualFlag: false, missing: [],
  effectiveContributors: 2.9, concentration: 'narrow',
  ...over,
});

const feed = (state: string, ageMs = 1000) => ({ state, updatedAt: Date.now() - ageMs, ageMs });

const payload = (over: Record<string, unknown> = {}, res: Record<string, unknown> = {}) => ({
  success: true, serverTime: Date.now(), weightsAsOf: '2026-10-26',
  feeds: { stocks: feed('live'), indices: feed('live') },
  nifty: { ltp: 22573.9, prevClose: 22749.75, change: -175.85, changePct: -0.77 },
  result: result(res),
  ...over,
});

async function open(page: Page, body: unknown, blocked: Call[] = []) {
  await signIn(page.context());
  await page.route('**/api/**', route => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.pathname === '/api/nifty-contribution') return json(route, body);
    if (req.method() === 'POST' && (u.pathname === '/api/daily-market' || u.pathname === '/api/live-indices')) return json(route, { success: true });
    if (req.method() !== 'GET') {
      blocked.push({ method: req.method(), path: u.pathname, search: u.search, body: null });
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false}' });
    }
    return route.continue();
  });
  await page.goto('/nifty-contribution', { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Nifty Contribution' }).waitFor({ timeout: 60_000 });
}

test('shows the headline tiles and every stock, biggest puller first', async ({ page }) => {
  await open(page, payload());
  await expect(page.getByText('-13.35 pts')).toBeVisible();
  await expect(page.getByText('Pullers (2)')).toBeVisible();
  await expect(page.getByText('Draggers (3)')).toBeVisible();
  await expect(page.getByText('Narrow')).toBeVisible();
  const first = page.locator('tbody tr').first();
  await expect(first).toContainText('LT');
  await expect(first).toContainText('+45.46');
  await expect(page.locator('tbody tr')).toHaveCount(5);
  await expect(page.getByText('DATA:')).toBeVisible();
});

test('the Cumulative tab draws the waterfall closing on a NET bar, and By stock brings the toggle back', async ({ page }) => {
  await open(page, payload());
  await expect(page.getByRole('group', { name: 'How many stocks to chart' })).toBeVisible();
  await page.getByRole('tab', { name: 'Cumulative' }).click();
  await expect(page.getByRole('tab', { name: 'Cumulative' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('svg text', { hasText: /^NET$/ })).toBeVisible();
  await expect(page.locator('svg text', { hasText: /^LT$/ }).first()).toBeVisible();
  await expect(page.getByText(/running total climbs to \+53\.00 then falls to the net -13\.35/)).toBeVisible();
  await expect(page.getByRole('group', { name: 'How many stocks to chart' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'By stock' }).click();
  await expect(page.getByRole('group', { name: 'How many stocks to chart' })).toBeVisible();
});

test('sorting by weight reorders the table', async ({ page }) => {
  await open(page, payload());
  await page.locator('th', { hasText: 'Weight' }).click();
  await expect(page.locator('tbody tr').first()).toContainText('HDFCBANK');
});

test('a stopped feed shows the not-live banner and a start button', async ({ page }) => {
  await open(page, payload({ feeds: { stocks: feed('stopped', 600_000), indices: feed('live') } }));
  await expect(page.getByText(/Not fully live/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start stocks feed' })).toBeVisible();
});

test('a stale weight seed raises the reconciliation banner', async ({ page }) => {
  await open(page, payload({}, { residual: -40, residualFlag: true }));
  await expect(page.getByText(/predates an index rebalance/)).toBeVisible();
});

test('a stale stock feed does not blame the weights', async ({ page }) => {
  await open(page, payload({ feeds: { stocks: feed('stale', 600_000), indices: feed('live') } }, { residual: -40, residualFlag: true }));
  await expect(page.getByText(/Not fully live/)).toBeVisible();
  await expect(page.getByText(/predates an index rebalance/)).toHaveCount(0);
});

test('stocks with no price are listed, not counted as zero', async ({ page }) => {
  await open(page, payload({}, { missing: ['TRENT', 'BEL'] }));
  await expect(page.getByText(/No usable price yet for 2 stocks: TRENT, BEL/)).toBeVisible();
});

test('starting a feed only posts to the bridge route', async ({ page }) => {
  const blocked: Call[] = [];
  await open(page, payload({ feeds: { stocks: feed('stopped', 600_000), indices: feed('live') } }), blocked);
  await page.getByRole('button', { name: 'Start stocks feed' }).click();
  await page.waitForTimeout(500);
  expect(blocked).toEqual([]);
});
