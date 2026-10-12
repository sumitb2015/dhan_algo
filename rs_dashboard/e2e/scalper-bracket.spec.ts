import { expect, test } from '@playwright/test';
import { installScalperMock, longCall, newScalperMock, openScalper, signIn, writes, type ScalperMock } from './support';

let m: ScalperMock;
test.afterEach(() => { expect(m.blocked.map(c => `${c.method} ${c.path}`), 'an unmocked write was attempted').toEqual([]); });

test.beforeEach(async ({ page, context }) => {
  m = newScalperMock();
  await signIn(context);
  await installScalperMock(page, m);
  await openScalper(page);
});

const toggle = (page: import('@playwright/test').Page) => page.getByRole('button', { name: /^BRACKET (ON|OFF)$/ });
const buyCe = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'BUY CE' });
const sellCe = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'SELL CE' });

test('bracket control: OFF by default, inputs only while ON', async ({ page }) => {
  await expect(toggle(page)).toHaveText('BRACKET OFF');
  await expect(page.getByText('TGT pts')).toHaveCount(0);
  await toggle(page).click();
  await expect(toggle(page)).toHaveText('BRACKET ON');
  await expect(page.getByText('TGT pts')).toBeVisible();
  await expect(page.getByText('SL pts').first()).toBeVisible();
  await expect(page.getByText('TRAIL pts')).toBeVisible();
});

test('BUY CE with the bracket on goes to /api/super-order with tick-rounded levels', async ({ page }) => {
  await toggle(page).click();
  await buyCe(page).click();
  await expect.poll(() => writes(m).length).toBe(1);
  const [call] = writes(m);
  expect(call.path).toBe('/api/super-order');
  expect(call.body).toMatchObject({
    securityId: '111', exchangeSegment: 'NSE_FNO', side: 'BUY', productType: 'MARGIN', orderType: 'MARKET',
    quantity: 75, refPrice: 100.05, targetPrice: 110.05, stopLossPrice: 92.05, trailingJump: 0,
  });
  expect(String(call.body?.idempotencyKey).length).toBeGreaterThanOrEqual(8);
  await expect(page.getByText(/bracket tgt 110.05/)).toBeVisible();
});

test('with the bracket off the same click is a plain fast-order', async ({ page }) => {
  await buyCe(page).click();
  await expect.poll(() => writes(m).length).toBe(1);
  expect(writes(m)[0].path).toBe('/api/scalper/fast-order');
});

// Regression: OptionPanel is memoised and ignores its on* props. With a constant price the panel
// never re-rendered, so onBuy kept a stale placeOrder and the toggle was silently ignored.
test('toggling the bracket takes effect even when no price tick re-renders the panel', async ({ page }) => {
  await buyCe(page).click();                       // plain first, so a stale closure would stick
  await expect.poll(() => writes(m).length).toBe(1);
  await toggle(page).click();
  await buyCe(page).click();
  await expect.poll(() => writes(m).length).toBe(2);
  expect(writes(m)[1].path).toBe('/api/super-order');
});

test('SELL against a same-product long is a plain close, no bracket', async ({ page }) => {
  await toggle(page).click();
  m.positions = [longCall('MARGIN')];
  await expect(page.getByText('NIFTY-Oct2026-24000-CE')).toBeVisible({ timeout: 20_000 });
  await sellCe(page).click();
  await expect.poll(() => writes(m).length).toBe(1);
  expect(writes(m)[0].path).toBe('/api/scalper/fast-order');
  await expect(page.getByText(/closing, no bracket/)).toBeVisible();
});

test('SELL while the long sits under ANOTHER product opens a bracketed short', async ({ page }) => {
  await toggle(page).click();
  m.positions = [longCall('INTRADAY')];             // ticket product is MARGIN
  await expect(page.getByText('NIFTY-Oct2026-24000-CE')).toBeVisible({ timeout: 20_000 });
  await sellCe(page).click();
  await expect.poll(() => writes(m).length).toBe(1);
  const [call] = writes(m);
  expect(call.path).toBe('/api/super-order');
  expect(call.body).toMatchObject({ side: 'SELL', targetPrice: 90.05, stopLossPrice: 108.05 });
});

test('a trail at or above the stop distance is refused client-side', async ({ page }) => {
  await toggle(page).click();
  const trail = page.getByText('TRAIL pts').locator('xpath=following::input[1]');
  await trail.fill('9');
  await trail.press('Enter');
  await buyCe(page).click();
  await expect(page.getByText(/trailingJump/)).toBeVisible();
  expect(writes(m)).toHaveLength(0);
});

test('a MARKET bracket refuses stale quotes', async ({ page }) => {
  test.slow();                                       // the 15 s staleness window has to elapse
  await toggle(page).click();
  m.quotesFresh = false;
  await page.waitForTimeout(17_000);
  await buyCe(page).click();
  await expect(page.getByText(/Live quotes are stale/)).toBeVisible();
  expect(writes(m)).toHaveLength(0);
});
