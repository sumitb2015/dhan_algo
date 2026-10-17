import { expect, test } from '@playwright/test';
import { signIn } from './support';
import { config, installFocusMock, kotakPos, lastSavedRow, newFocusMock, openFocusTool, orders, realRow, type FocusMock } from './focusToolMock';

// The Focus Tool's broker ownership (lib/focusToolBroker.ts), every /api/* call mocked (e2e/focusToolMock.ts).
//
// The broker selector is one localStorage setting shared by every dashboard page. Before 2026-10-17 a REAL row opened
// on Kotak, reloaded after another page had picked Dhan, ran on Dhan: its next exit read the leg flat in Dhan's book
// and dropped it from the ledger, leaving the Kotak short unwatched.

const savedQty = (m: FocusMock, id: string) => {
  const r = lastSavedRow(m, id);
  return r ? { ce: Number(r.fill?.ceQty ?? 0), pe: Number(r.fill?.peQty ?? 0) } : null;
};
const brokerSelect = (page: import('@playwright/test').Page) =>
  page.locator('select').filter({ has: page.locator('option', { hasText: 'Kotak' }) }).first();

let m: FocusMock;

test.beforeEach(async ({ context }) => {
  m = newFocusMock();
  await signIn(context);
});

test.afterEach(() => {
  expect(m.blocked.map(c => `${c.method} ${c.path}`), 'an unmocked write was attempted').toEqual([]);
});

test('a page saved on Dhan follows the broker its open REAL row is on, without changing the saved choice', async ({ page }) => {
  m.config = config([realRow('ft_kotak_1', 'kotak')]);
  m.kotakPositions = [kotakPos('NIFTY26O1923150CE', -65), kotakPos('NIFTY26O1923150PE', -65)];
  await installFocusMock(page, m, 'dhan');
  await openFocusTool(page, 'Exit CE leg');

  await expect(brokerSelect(page)).toHaveValue('kotak');
  await expect(brokerSelect(page)).toBeDisabled();
  // The dashboard-wide choice is untouched: other pages still open on Dhan.
  expect(await page.evaluate(() => localStorage.getItem('dhan_algo.selected_broker'))).toBe('dhan');
  // The page now reads the Kotak book the row's legs are in.
  await expect.poll(() => m.calls.some(c => c.path === '/api/scalper/kotak/poll')).toBe(true);
  expect(orders(m)).toEqual([]);
  expect(savedQty(m, 'ft_kotak_1') ?? { ce: 65, pe: 65 }).toEqual({ ce: 65, pe: 65 });
});

test('after following Kotak, Exit closes the leg on Kotak with the Kotak contract — never through Dhan', async ({ page }) => {
  m.config = config([realRow('ft_kotak_1', 'kotak')]);
  m.kotakPositions = [kotakPos('NIFTY26O1923150CE', -65), kotakPos('NIFTY26O1923150PE', -65)];
  await installFocusMock(page, m, 'dhan');
  await openFocusTool(page, 'Exit CE leg');
  await expect(brokerSelect(page)).toHaveValue('kotak');

  await page.getByRole('button', { name: 'Exit CE leg' }).first().click();
  await expect.poll(() => orders(m).length).toBe(1);
  expect(orders(m)[0].path).toBe('/api/scalper/kotak/order');
  expect(orders(m)[0].body).toMatchObject({ tradingsymbol: 'NIFTY26O1923150CE', side: 'BUY', quantity: 65, exchange: 'nse_fo' });
  expect(m.calls.filter(c => c.path === '/api/scalper/fast-order')).toEqual([]);
});

test('rows split across brokers: the selector unlocks and the other broker’s row refuses every order', async ({ page }) => {
  m.config = config([realRow('ft_kotak_1', 'kotak'), realRow('ft_dhan_1', 'dhan')]);
  await installFocusMock(page, m, 'dhan');
  await openFocusTool(page, 'Exit CE leg');

  await expect(brokerSelect(page)).toHaveValue('dhan');
  await expect(brokerSelect(page)).toBeEnabled();
  // The Kotak row's leg buttons are disabled and say why; the Dhan row's are live.
  const exits = page.getByRole('button', { name: 'Exit CE leg' });
  await expect(exits).toHaveCount(2);
  const titles = await exits.evaluateAll(els => els.map(e => ({ title: e.getAttribute('title') ?? '', disabled: (e as HTMLButtonElement).disabled })));
  expect(titles.filter(t => t.disabled && /position is on Kotak/.test(t.title))).toHaveLength(1);
  expect(orders(m)).toEqual([]);
});

test('an unreadable Kotak book ("not connected") is not read as flat: Exit keeps the leg and sends nothing', async ({ page }) => {
  m.config = config([realRow('ft_kotak_1', 'kotak')]);
  m.kotakPositionsError = 'Kotak not connected — run kotak_autologin.py';
  await installFocusMock(page, m, 'kotak');
  await openFocusTool(page, 'Exit CE leg');

  await page.getByRole('button', { name: 'Exit CE leg' }).first().click();
  await expect(page.getByText(/position book not readable yet/).first()).toBeVisible();
  await expect(page.getByText(/closed outside the tool/)).toHaveCount(0);
  expect(orders(m)).toEqual([]);
  // The ledger still holds both legs (before the fix the CE leg was saved as 0 — "already flat at the broker").
  const q = savedQty(m, 'ft_kotak_1');
  if (q) expect(q).toEqual({ ce: 65, pe: 65 });
});
