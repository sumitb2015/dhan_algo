import { expect, test, type Page } from '@playwright/test';
import { installScalperMock, longCall, newScalperMock, openScalper, signIn, type ScalperMock } from './support';

let m: ScalperMock;
test.afterEach(() => { expect(m.blocked.map(c => `${c.method} ${c.path}`), 'an unmocked write was attempted').toEqual([]); });
test.beforeEach(async ({ page, context }) => {
  m = newScalperMock();
  await signIn(context);
  await installScalperMock(page, m);
  await openScalper(page);
});

const toggle = (page: Page) => page.getByRole('button', { name: /^BRACKET (ON|OFF)$/ });
const shiftUp = (page: Page) => page.getByRole('button', { name: 'Shift CE strike up 1' });
const orders = () => m.calls.filter(c => c.method === 'POST' && (c.path === '/api/super-order' || c.path === '/api/scalper/fast-order'));

async function armedWithLong(page: Page) {
  await toggle(page).click();
  m.positions = [longCall('MARGIN')];
  await expect(page.getByText('NIFTY-Oct2026-24000-CE')).toBeVisible({ timeout: 20_000 });
}

test('rolling a bracketed leg closes it, then reopens the new strike WITH a bracket', async ({ page }) => {
  await armedWithLong(page);
  await shiftUp(page).click();
  await expect.poll(() => orders().length, { timeout: 30_000 }).toBe(2);
  const [close, reopen] = orders();
  expect(close.path).toBe('/api/scalper/fast-order');
  expect(close.body).toMatchObject({ securityId: '111', side: 'SELL', quantity: 75 });
  expect(reopen.path).toBe('/api/super-order');
  // 24050 CE trades at 80 in the mock: BUY, target +10, stop -8, same product and size as the leg that was closed.
  expect(reopen.body).toMatchObject({ securityId: '112', side: 'BUY', productType: 'MARGIN', quantity: 75, targetPrice: 90, stopLossPrice: 72 });
  await expect(page.getByText(/Shift complete: 24050 CE/)).toBeVisible();
  await expect(page.getByText(/bracket tgt 90 \/ SL 72/)).toBeVisible();
});

test('without the bracket the roll reopens plain, exactly as before', async ({ page }) => {
  m.positions = [longCall('MARGIN')];
  await expect(page.getByText('NIFTY-Oct2026-24000-CE')).toBeVisible({ timeout: 20_000 });
  await shiftUp(page).click();
  await expect.poll(() => orders().length, { timeout: 30_000 }).toBe(2);
  expect(orders().map(c => c.path)).toEqual(['/api/scalper/fast-order', '/api/scalper/fast-order']);
});

test('a cleanly rejected bracket reopens the leg plain, loudly - the roll is never left half-done', async ({ page }) => {
  m.superPost = 'reject';
  await armedWithLong(page);
  await shiftUp(page).click();
  await expect.poll(() => orders().length, { timeout: 30_000 }).toBe(3);
  expect(orders().map(c => c.path)).toEqual(['/api/scalper/fast-order', '/api/super-order', '/api/scalper/fast-order']);
  expect(orders()[2].body).toMatchObject({ securityId: '112', side: 'BUY', quantity: 75 });
  await expect(page.getByText(/Bracket rejected - reopening WITHOUT it/)).toBeVisible();
});

test('a 504 on the bracket is "status unknown": NO plain retry (it could double the leg)', async ({ page }) => {
  m.superPost = 'timeout';
  await armedWithLong(page);
  await shiftUp(page).click();
  await expect.poll(() => orders().length, { timeout: 30_000 }).toBe(2);
  await page.waitForTimeout(1500);
  expect(orders().map(c => c.path)).toEqual(['/api/scalper/fast-order', '/api/super-order']);
});

test('stale quotes: the roll still happens, plain, with a loud warning', async ({ page }) => {
  test.slow();
  await armedWithLong(page);
  m.quotesFresh = false;
  await page.waitForTimeout(17_000);
  await shiftUp(page).click();
  await expect.poll(() => orders().length, { timeout: 30_000 }).toBe(2);
  expect(orders().map(c => c.path)).toEqual(['/api/scalper/fast-order', '/api/scalper/fast-order']);
  await expect(page.getByText(/Rolled leg reopens WITHOUT a bracket/)).toBeVisible();
});
