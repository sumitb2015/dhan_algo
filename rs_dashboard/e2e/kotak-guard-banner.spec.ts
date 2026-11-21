import { expect, test, type Page } from '@playwright/test';
import { json, signIn } from './support';

// The global Kotak loss-limit banner (components/KotakGuardBanner.tsx, mounted in app/layout.tsx). The guards route is
// mocked in the browser, so nothing reaches Kotak or any order API; the banner is read-only and this spec sends no write.

async function mockGuards(page: Page, body: Record<string, unknown>) {
  await page.route('**/api/scalper/kotak/guards', route => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 599, body: 'blocked' });
    return json(route, { success: true, ...body });
  });
}

test.beforeEach(async ({ context }) => { await signIn(context); });

test('shows nothing while the guard is armed and healthy', async ({ page }) => {
  await mockGuards(page, { sessionValid: true, state: { pnl: { loss: 10000 }, lock: null, health: { watching: true, reason: '' } }, defaults: { enabled: true, loss: 10000 } });
  await page.goto('/us-markets');
  await page.waitForTimeout(1500);
  await expect(page.getByRole('alert').filter({ hasText: /KOTAK/ })).toHaveCount(0);
});

test('a fired loss limit shows the day lock with its reason', async ({ page }) => {
  await mockGuards(page, {
    sessionValid: true,
    state: { pnl: null, lock: { at: 1795190000000, reason: 'P&L Guard loss limit ₹10000 reached (P&L -10250)' }, health: { watching: true, reason: '' } },
    defaults: { enabled: true, loss: 10000 },
  });
  await page.goto('/us-markets');
  const banner = page.getByRole('alert').filter({ hasText: /KOTAK/ });
  await expect(banner).toContainText('KOTAK LOCKED FOR TODAY');
  await expect(banner).toContainText('loss limit ₹10000 reached');
  await expect(banner).toContainText('Exits still work');
});

test('an expired Kotak session warns that nothing is protecting, and the warning can be dismissed', async ({ page }) => {
  await mockGuards(page, { sessionValid: false, state: { pnl: { loss: 10000 }, lock: null }, defaults: { enabled: true, loss: 10000 } });
  await page.goto('/us-markets');
  const banner = page.getByRole('alert').filter({ hasText: /KOTAK/ });
  await expect(banner).toContainText('NOT PROTECTING');
  await expect(banner).toContainText('Kotak session expired');
  await page.getByRole('button', { name: 'Dismiss warning' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /KOTAK/ })).toHaveCount(0);
});

test('a dismissed warning stays dismissed after a reload the same day', async ({ page }) => {
  await mockGuards(page, { sessionValid: false, state: { pnl: { loss: 10000 }, lock: null }, defaults: { enabled: true, loss: 10000 } });
  await page.goto('/us-markets');
  await page.getByRole('button', { name: 'Dismiss warning' }).click();
  await page.reload();
  await page.waitForTimeout(1500);
  await expect(page.getByRole('alert').filter({ hasText: /KOTAK/ })).toHaveCount(0);
});

test('a watcher that stopped updating its health record is called out even though it last said "watching"', async ({ page }) => {
  await mockGuards(page, {
    sessionValid: true, defaults: { enabled: true, loss: 10000 },
    state: { pnl: { loss: 10000 }, lock: null, health: { watching: true, reason: '', at: Date.now() - 10 * 60_000 } },
  });
  await page.goto('/us-markets');
  await expect(page.getByRole('alert').filter({ hasText: /KOTAK/ })).toContainText('stopped updating');
});
