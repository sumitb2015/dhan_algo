import { expect, test, type Page } from '@playwright/test';
import { installScalperMock, LIVE_BRACKET, longCall, newScalperMock, openScalper, signIn, writes, type ScalperMock } from './support';

let m: ScalperMock;
test.afterEach(() => { expect(m.blocked.map(c => `${c.method} ${c.path}`), 'an unmocked write was attempted').toEqual([]); });

test.beforeEach(async ({ page, context }) => {
  m = newScalperMock();
  await signIn(context);
  await installScalperMock(page, m);
  await openScalper(page);
});

async function withOpenLong(page: Page) {
  m.positions = [longCall('MARGIN')];
  await expect(page.getByText('NIFTY-Oct2026-24000-CE')).toBeVisible({ timeout: 20_000 });
}
const closeRow = (page: Page) => page.getByRole('button', { name: 'Close', exact: true });

test('closing a position cancels its resting target and stop - after the close, never the entry leg', async ({ page }) => {
  m.superOrders = [LIVE_BRACKET];
  await withOpenLong(page);
  await closeRow(page).click();

  await expect(page.getByText(/bracket cancelled/)).toBeVisible();
  // The page also reads GET /api/super-order in the background to show bracket levels on the row, so reads can
  // precede the close. What must hold: the close goes out, THEN the cancel lookup, THEN the deletes.
  const order = m.calls.map(c => (c.path === '/api/super-order' ? `super-${c.method}` : c.path));
  const closeAt = order.indexOf('/api/scalper/fast-order');
  expect(closeAt).toBeGreaterThanOrEqual(0);
  expect(m.calls[closeAt].body).toMatchObject({ securityId: '111', side: 'SELL', quantity: 75, productType: 'MARGIN' });
  const deletes = m.calls.filter(c => c.method === 'DELETE').map(c => c.search);
  expect(deletes.sort()).toEqual(['?orderId=5001&leg=STOP_LOSS_LEG', '?orderId=5001&leg=TARGET_LEG']);
  const lookupAfterClose = order.indexOf('super-GET', closeAt);
  expect(lookupAfterClose).toBeGreaterThan(closeAt);
  expect(order.indexOf('super-DELETE')).toBeGreaterThan(lookupAfterClose);   // no leg is deleted before the close and the lookup
});

test('no live bracket: the close is silent about brackets and deletes nothing', async ({ page }) => {
  await withOpenLong(page);
  await closeRow(page).click();
  await expect.poll(() => m.calls.some(c => c.path === '/api/super-order' && c.method === 'GET')).toBe(true);
  await page.waitForTimeout(500);
  expect(m.calls.filter(c => c.method === 'DELETE')).toHaveLength(0);
  await expect(page.getByText(/bracket (cancelled|leg)|could not check/i)).toHaveCount(0);
});

test('a rejected cancel is loud', async ({ page }) => {
  m.superOrders = [LIVE_BRACKET];
  m.superDeleteFails = true;
  await withOpenLong(page);
  await closeRow(page).click();
  await expect(page.getByText(/NOT cancelled/)).toBeVisible();
});

test('a failed bracket lookup is quiet until this tab has placed a bracket, then loud', async ({ page }) => {
  test.slow();
  m.superListFails = true;
  await withOpenLong(page);
  await closeRow(page).click();
  await expect.poll(() => m.calls.some(c => c.path === '/api/super-order' && c.method === 'GET')).toBe(true);
  await page.waitForTimeout(500);
  await expect(page.getByText(/could not check for a live bracket/)).toHaveCount(0);

  // Now place a bracket from this tab, then close again with the lookup still failing.
  m.positions = [];
  await expect(page.getByText('NIFTY-Oct2026-24000-CE')).toHaveCount(0, { timeout: 20_000 });
  await page.getByRole('button', { name: /^BRACKET (ON|OFF)$/ }).click();
  await page.getByRole('button', { name: 'BUY CE' }).click();
  await expect.poll(() => writes(m).some(c => c.path === '/api/super-order' && c.method === 'POST')).toBe(true);
  m.positions = [longCall('MARGIN')];
  await expect(page.getByText('NIFTY-Oct2026-24000-CE')).toBeVisible({ timeout: 20_000 });
  await closeRow(page).click();
  await expect(page.getByText(/could not check for a live bracket/)).toBeVisible();
});
