import { expect, test, type Route } from '@playwright/test';
import { json, signIn } from './support';

// Multi-Leg Focus "Risk rules" panel (basket.guards): an older save migrates to separate loss and margin rules, rules are
// added from one button row, and a switch refuses to turn on when the rule is incomplete. Nothing here can place an order:
// order routes answer 400 and any unhandled non-GET is refused (599).

const NOW = Date.now();
const leg = (id: string, option: 'CE' | 'PE', strike: number) => ({
  id, side: 'S', option, strike, expiry: '2099-12-31', ratio: 1, lots: 1, type: 'MARKET', status: 'OPEN',
  fill: { qty: 65, avgPrice: 18 }, filledAt: NOW, price: 18,
});

const BASKET = {
  id: 'b1', name: 'Short Strangle', underlying: 'NIFTY', expiry: '2099-12-31', broker: 'dhan', presetKey: 'short-strangle',
  multiplier: 1, legs: [{ ...leg('l1', 'CE', 23600), sl: 50, slType: 'pct' }, leg('l2', 'PE', 21500)],
  // Older shape: margin shared the loss rule's switch, and the P&L scope was editable.
  guards: {
    spotTriggers: [{ id: 't1', level: 24800, dir: 'above', action: 'EXIT_CE', armed: false }],
    alarm: { armed: false, maxLoss: 20000, lossScope: 'total', marginWarnPct: 85 },
  },
  createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), rev: 1,
};

test.beforeEach(async ({ context }) => { await signIn(context); });

test('risk rules: legacy alarm splits into loss + margin rules; incomplete rules refuse to switch on (no order is sent)', async ({ page }) => {
  const orders: string[] = [];
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === '/api/multi-leg-focus/baskets') return json(route, req.method() === 'GET' ? { success: true, data: [BASKET] } : { success: true });
    if (p === '/api/scalper/fast-order' || p === '/api/scalper/orders') { orders.push(p); return json(route, { success: false, error: 'e2e' }, 400); }
    if (req.method() === 'GET') return json(route, { success: false, error: 'e2e' }, 503);
    return route.fulfill({ status: 599, body: 'blocked by e2e' });
  });
  await page.goto('/multi-leg-focus', { waitUntil: 'domcontentloaded' });
  const expand = page.getByRole('button', { name: 'Expand strategy', exact: true }).first();
  await expect(expand).toBeVisible({ timeout: 60_000 });
  await expand.click();
  const toggle = page.getByRole('button', { name: /Risk rules/ }).first();
  await toggle.click();

  // Migrated: three rules, the margin level moved to its own rule.
  await expect(page.getByText('If spot goes')).toBeVisible();
  await expect(page.getByText("If today's loss reaches ₹")).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Margin used percent' })).toHaveValue('85');
  await expect(page.getByRole('button', { name: '+ Max loss' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '+ Margin use' })).toBeDisabled();

  // No live spot in the test: the spot rule will not switch on, and says why under its row.
  await page.getByRole('switch', { name: 'Spot rule: off' }).click();
  await expect(page.getByText('No live spot price yet.')).toBeVisible();

  // A new Greek rule with no limits refuses too.
  await page.getByRole('button', { name: '+ Greek limit' }).click();
  await page.getByRole('switch', { name: 'Greek rule: off' }).click();
  await expect(page.getByText('Enter a lower limit, an upper limit, or both.')).toBeVisible();

  // The margin rule has a level: it switches on and the header counts it.
  await page.getByRole('switch', { name: 'Margin rule: off' }).click();
  await expect(page.getByRole('switch', { name: 'Margin rule: on' })).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).toContainText('1 ON');

  // Editing a rule turns it off.
  const pct = page.getByRole('textbox', { name: 'Margin used percent' });
  await pct.fill('90');
  await pct.press('Enter');
  await expect(page.getByRole('switch', { name: 'Margin rule: off' })).toBeVisible();

  // A leg rule names its leg and refuses to switch on without a level.
  await page.getByRole('button', { name: '+ Leg rule' }).click();
  await expect(page.getByRole('combobox', { name: 'Rule leg' })).toHaveValue('l1');
  await page.getByRole('switch', { name: 'Leg rule: off' }).click();
  await expect(page.getByText('Enter a level above 0.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Watch', exact: true }).selectOption('loss');
  await expect(page.getByRole('textbox', { name: 'Leg max loss in rupees' })).toBeVisible();

  // The leg's SL can be set to alert only.
  await page.getByRole('button', { name: 'At stop: close the leg. Switch to alert only' }).click();
  await expect(page.getByRole('button', { name: 'At stop: alert only. Switch to close the leg' })).toBeVisible();

  if (process.env.E2E_SHOT_DIR) {
    await page.locator('ul:has(> li [role="switch"])').first().locator('..').screenshot({ path: `${process.env.E2E_SHOT_DIR}/risk-rules.png` });
    await page.locator('tr:has(button[aria-label^="At stop"])').first().screenshot({ path: `${process.env.E2E_SHOT_DIR}/leg-row.png` });
  }
  expect(orders).toEqual([]);
});
