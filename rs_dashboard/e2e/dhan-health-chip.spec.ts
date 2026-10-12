import { expect, test, type Page } from '@playwright/test';
import { json, signIn } from './support';

type Level = 'ok' | 'warn' | 'bad' | 'unknown';
const check = (id: string, level: Level, label: string, detail: string) => ({ id, level, label, detail });
const body = (level: Level, checks: ReturnType<typeof check>[]) => ({ success: true, level, checks, publicIp: '203.0.113.9', checkedAt: new Date().toISOString() });

const OK = body('ok', [
  check('token', 'ok', 'Token OK', 'Valid until 13/10/2026 05:30 IST.'),
  check('killswitch', 'ok', 'Kill switch off', 'Trading enabled.'),
  check('ip', 'ok', 'IP whitelisted', '203.0.113.9 matches the registered primary IP.'),
]);
const BAD = body('bad', [
  check('token', 'ok', 'Token OK', 'ok'),
  check('killswitch', 'bad', 'Kill switch ON', 'Trading is disabled for the day.'),
  check('ip', 'bad', 'IP mismatch', 'This machine is 203.0.113.9; registered 198.51.100.1. Orders will fail with DH-905.'),
]);
const WARN = body('warn', [check('token', 'warn', 'Token 42m left', 'Expires 05:30 IST.')]);

async function load(page: Page, respond: () => { status: number; payload: unknown }) {
  // Registered first = lowest priority: every OTHER /api call from the dashboard home page is answered locally,
  // so these tests spawn no Python and call no broker even on a machine with a live token.
  await page.route('**/api/**', route => route.request().method() === 'GET' ? json(route, { success: false, error: 'e2e' }, 503) : route.fulfill({ status: 599, body: 'blocked by e2e' }));
  await page.route('**/api/dhan-health', route => { const r = respond(); return json(route, r.payload, r.status); });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const chip = page.getByRole('button', { name: /Dhan account health/ });
  await chip.waitFor({ timeout: 60_000 });
  return chip;
}

test.beforeEach(async ({ context }) => { await signIn(context); });

test('healthy account: DHAN OK, popover lists the three checks and the machine IP', async ({ page }) => {
  const chip = await load(page, () => ({ status: 200, payload: OK }));
  await expect(chip).toContainText('DHAN OK');
  await chip.click();
  for (const label of ['Token OK', 'Kill switch off', 'IP whitelisted']) await expect(page.getByText(label)).toBeVisible();
  await expect(page.getByText('This machine: 203.0.113.9')).toBeVisible();
});

test('a bad account headlines the first problem and explains the IP mismatch', async ({ page }) => {
  const chip = await load(page, () => ({ status: 200, payload: BAD }));
  await expect(chip).toContainText('KILL SWITCH ON');
  await chip.click();
  await expect(page.getByText(/DH-905/)).toBeVisible();
});

test('a warning headlines the warning', async ({ page }) => {
  const chip = await load(page, () => ({ status: 200, payload: WARN }));
  await expect(chip).toContainText('TOKEN 42M LEFT');
});

test('an endpoint failure reads DHAN ? and never a false OK', async ({ page }) => {
  const chip = await load(page, () => ({ status: 502, payload: { success: false, error: 'boom' } }));
  await expect(chip).toContainText('DHAN ?');
  await chip.click();
  await expect(page.getByText(/Health check failed/)).toBeVisible();
});

test('the popover closes on Escape and on an outside click', async ({ page }) => {
  const chip = await load(page, () => ({ status: 200, payload: OK }));
  await chip.click();
  await expect(page.getByText('IP whitelisted')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('IP whitelisted')).toHaveCount(0);
  await chip.click();
  await expect(page.getByText('IP whitelisted')).toBeVisible();
  await page.mouse.click(5, 600);
  await expect(page.getByText('IP whitelisted')).toHaveCount(0);
});
