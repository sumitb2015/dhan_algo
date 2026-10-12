import { expect, test, type Page } from '@playwright/test';
import { installScalperMock, longCall, newScalperMock, openScalper, signIn, type ScalperMock } from './support';

/** Position-row display of the broker's resting bracket (Super Order) levels. Read-only: nothing here may write. */
let m: ScalperMock;
test.afterEach(() => { expect(m.blocked.map(c => `${c.method} ${c.path}`), 'an unmocked write was attempted').toEqual([]); });

const bracket = (over: Record<string, unknown> = {}) => ({
  orderId: '5001', securityId: '111', orderStatus: 'PENDING', targetPrice: 125, stopLossPrice: 90, trailingJump: 2,
  legDetails: [
    { legName: 'ENTRY_LEG', orderStatus: 'TRADED' },
    { legName: 'TARGET_LEG', orderStatus: 'PENDING' },
    { legName: 'STOP_LOSS_LEG', orderStatus: 'TRIGGER_PENDING' },
  ],
  ...over,
});

test.beforeEach(async ({ page, context }) => {
  m = newScalperMock();
  await signIn(context);
  await installScalperMock(page, m);
});

async function openWithLong(page: Page) {
  m.positions = [longCall('MARGIN')];
  await openScalper(page);
  await expect(page.getByText('NIFTY-Oct2026-24000-CE')).toBeVisible({ timeout: 20_000 });
}
const brk = (page: Page) => page.getByTitle(/^Bracket order /);

test('an open position shows its resting target, stop and trail under the symbol', async ({ page }) => {
  m.superOrders = [bracket()];
  await openWithLong(page);
  const line = brk(page);
  await expect(line).toBeVisible({ timeout: 20_000 });
  await expect(line).toContainText('BRK');
  await expect(line).toContainText('T 125.00');
  await expect(line).toContainText('SL 90.00');
  await expect(line).toContainText('trail 2');
  await expect(line).toHaveAttribute('title', /Bracket order 5001 resting at the broker\. Target 125\.00 \(24\.93 pts from LTP\), stop 90\.00/);
});

test('no live bracket: nothing is shown, and the page only reads (no writes)', async ({ page }) => {
  await openWithLong(page);
  await expect.poll(() => m.calls.some(c => c.path === '/api/super-order' && c.method === 'GET'), { timeout: 20_000 }).toBe(true);
  await expect(brk(page)).toHaveCount(0);
  expect(m.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
});

test('a filled target leaves only the stop: the target reads "-", never a stale number', async ({ page }) => {
  m.superOrders = [bracket({ legDetails: [
    { legName: 'ENTRY_LEG', orderStatus: 'TRADED' },
    { legName: 'TARGET_LEG', orderStatus: 'TRADED' },
    { legName: 'STOP_LOSS_LEG', orderStatus: 'PENDING' },
  ] })];
  await openWithLong(page);
  const line = brk(page);
  await expect(line).toContainText('T -');
  await expect(line).toContainText('SL 90.00');
});

test('a bracket on another contract does not appear on this row', async ({ page }) => {
  m.superOrders = [bracket({ securityId: '999' })];
  await openWithLong(page);
  await expect.poll(() => m.calls.some(c => c.path === '/api/super-order' && c.method === 'GET'), { timeout: 20_000 }).toBe(true);
  await expect(brk(page)).toHaveCount(0);
});

test('a flat (closed) row shows no bracket levels even if the broker still lists one', async ({ page }) => {
  m.superOrders = [bracket()];
  m.positions = [{ ...longCall('MARGIN'), netQty: 0, unrealizedProfit: 0, realizedProfit: 120 }];
  await openScalper(page);
  await expect(page.getByText('NIFTY-Oct2026-24000-CE')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await expect(brk(page)).toHaveCount(0);
});

test('when the bracket lookup starts failing the levels disappear instead of going stale', async ({ page }) => {
  test.slow();
  m.superOrders = [bracket()];
  await openWithLong(page);
  await expect(brk(page)).toBeVisible({ timeout: 20_000 });
  m.superListFails = true;
  await expect(brk(page)).toHaveCount(0, { timeout: 30_000 });       // next 6 s poll fails -> cleared
  m.superListFails = false;
  await expect(brk(page)).toBeVisible({ timeout: 30_000 });          // and returns when the read recovers
});
