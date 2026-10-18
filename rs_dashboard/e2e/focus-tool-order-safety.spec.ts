import { expect, test } from '@playwright/test';
import { json, signIn } from './support';
import {
  config, dhanPos, events, flatRealRow, installFocusMock, lastSavedRow, newFocusMock, openFocusTool, orders, realRow,
  type FocusMock,
} from './focusToolMock';

// Order-safety fixes from the 2026-10-18 Focus Tool review. Every /api/* call is mocked (e2e/focusToolMock.ts): no
// order reaches a broker. Dhan contract ids at 23150: CE 101, PE 201.

const CE = '101';
const PE = '201';
const sym = (id: string) => (id === CE ? 'NIFTY-Oct2026-23150-CE' : 'NIFTY-Oct2026-23150-PE');

/** Dhan book: the order's contract moves by its quantity (a fill). */
function dhanFills(m: FocusMock, body: Record<string, unknown> | null) {
  const id = String(body?.securityId);
  const qty = Number(body?.quantity) * (body?.side === 'SELL' ? -1 : 1);
  const cur = m.dhanPositions.find(p => p.securityId === id);
  if (cur) cur.netQty = Number(cur.netQty) + qty;
  else m.dhanPositions.push(dhanPos(id, sym(id), qty));
}

let m: FocusMock;

test.beforeEach(async ({ context }) => {
  m = newFocusMock();
  await signIn(context);
});

test.afterEach(() => {
  expect(m.blocked.map(c => `${c.method} ${c.path}`), 'an unmocked write was attempted').toEqual([]);
});

test('PRODUCT is locked while a row holds a position', async ({ page }) => {
  m.config = config([realRow('ft_p1', 'dhan')]);
  m.dhanPositions = [dhanPos(CE, sym(CE), -65), dhanPos(PE, sym(PE), -65)];
  await installFocusMock(page, m, 'dhan');
  await openFocusTool(page, 'Exit CE leg');
  const product = page.getByRole('combobox', { name: 'NIFTY product' });
  await expect(product).toBeDisabled();
  await expect(product).toHaveAttribute('title', /hold a position/);
});

test('a leg the broker ACCEPTED and then rejected leaves a persistent NAKED banner', async ({ page }) => {
  m.config = config([flatRealRow('ft_n1')]);
  m.orderReply = (_p, body, mm) => {
    if (String(body?.securityId) === CE) { dhanFills(mm, body); return { status: 200, body: { success: true, order_id: 'D-CE' } }; }
    return { status: 200, body: { success: true, order_id: 'D-PE' } };   // booked … and never fills
  };
  m.orderStatus = id => id === 'D-PE'
    ? { orderId: id, orderStatus: 'REJECTED', quantity: 65, filledQty: 0, averageTradedPrice: 0, reason: 'RMS: margin shortfall' }
    : { orderId: id, orderStatus: 'TRADED', quantity: 65, filledQty: 65, averageTradedPrice: 100, reason: '' };
  await installFocusMock(page, m, 'dhan', 'pro');
  await openFocusTool(page, 'Enter now');
  page.on('dialog', d => void d.accept());
  await page.getByRole('button', { name: /Enter now/ }).first().click();

  await expect.poll(() => orders(m).length).toBe(2);
  const banner = page.getByRole('alert').filter({ hasText: 'NAKED / LOPSIDED' });
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(banner).toContainText('PE missing');
  await expect.poll(() => events(m, 'naked_leg').length).toBe(1);
  // It stays (a toast lasted 4 s) until dismissed.
  await page.waitForTimeout(5_000);
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: /Dismiss/ }).click();
  await expect(banner).toHaveCount(0);
});

test('an exit above the freeze limit goes out in slices that each fit under it', async ({ page }) => {
  // 60 lots of NIFTY (3900) against a freeze of 3511: one order would be refused by the exchange.
  const row = realRow('ft_s1', 'dhan');
  row.fill.ceQty = 3900;
  m.config = config([row]);
  m.freezeQty = 3511;
  m.dhanPositions = [dhanPos(CE, sym(CE), -3900), dhanPos(PE, sym(PE), -65)];
  m.orderReply = (_p, body, mm) => { dhanFills(mm, body); return { status: 200, body: { success: true, order_id: `D${orders(mm).length}` } }; };
  await installFocusMock(page, m, 'dhan');
  await openFocusTool(page, 'Exit CE leg');

  await page.getByRole('button', { name: 'Exit CE leg' }).first().click();
  await expect.poll(() => orders(m).length).toBe(2);
  expect(orders(m).map(o => o.body?.quantity)).toEqual([3510, 390]);
  expect(orders(m).every(o => o.body?.side === 'BUY' && o.body?.securityId === CE && o.body?.source === 'fts')).toBe(true);
  await expect.poll(() => Number(lastSavedRow(m, 'ft_s1')?.fill?.ceQty ?? -1)).toBe(0);
});

test('a close is refused when the broker shows the contract LONG while the row holds a short', async ({ page }) => {
  m.config = config([realRow('ft_d1', 'dhan')]);
  m.dhanPositions = [dhanPos(CE, sym(CE), 65), dhanPos(PE, sym(PE), -65)];
  await installFocusMock(page, m, 'dhan');
  await openFocusTool(page, 'Exit CE leg');

  await page.getByRole('button', { name: 'Exit CE leg' }).first().click();
  await expect(page.getByText(/shows the contract LONG/).first()).toBeVisible();
  await expect.poll(() => events(m, 'close_refused_direction').length).toBe(1);
  expect(orders(m)).toEqual([]);
});

test('header EXIT ALL keeps a row whose book still shows quantity, and retires one that is flat', async ({ page }) => {
  // The exit route answers "placed" but the legs stay in the book (rejected after the ACK): the row must stay watched.
  m.config = config([realRow('ft_e1', 'dhan')]);
  m.dhanPositions = [dhanPos(CE, sym(CE), -65), dhanPos(PE, sym(PE), -65)];
  await installFocusMock(page, m, 'dhan');
  await page.route('**/api/exit-all', r => json(r, { broker_exit: true, killed: [], trigger_fallback: [] }));
  await openFocusTool(page, 'Exit CE leg');

  const exitAll = page.getByRole('button', { name: /EXIT ALL Positions/ });
  await exitAll.click();
  await page.getByRole('button', { name: /Confirm EXIT ALL/ }).click();
  await expect(page.getByText(/not confirmed flat/).first()).toBeVisible({ timeout: 20_000 });
  const kept = lastSavedRow(m, 'ft_e1');
  expect(kept?.fill?.ceQty).toBe(65);
  expect(kept?.fill?.peQty).toBe(65);

  // Now the book goes flat: a second EXIT ALL retires the row.
  m.dhanPositions = [dhanPos(CE, sym(CE), 0), dhanPos(PE, sym(PE), 0)];
  await page.getByRole('button', { name: /EXIT ALL Positions/ }).click();
  await page.getByRole('button', { name: /Confirm EXIT ALL/ }).click();
  await expect.poll(() => lastSavedRow(m, 'ft_e1')?.fill ?? null, { timeout: 20_000 }).toBeNull();
});

test('a sliced exit whose second slice is rejected keeps the rest of the leg in the ledger', async ({ page }) => {
  const row = realRow('ft_s2', 'dhan');
  row.fill.ceQty = 3900;
  m.config = config([row]);
  m.freezeQty = 3511;
  m.dhanPositions = [dhanPos(CE, sym(CE), -3900), dhanPos(PE, sym(PE), -65)];
  m.orderReply = (_p, body, mm) => {
    if (orders(mm).length === 1) { dhanFills(mm, body); return { status: 200, body: { success: true, order_id: 'D1' } }; }
    return { status: 200, body: { success: false, error: 'RMS: rejected' } };
  };
  await installFocusMock(page, m, 'dhan');
  await openFocusTool(page, 'Exit CE leg');

  await page.getByRole('button', { name: 'Exit CE leg' }).first().click();
  await expect.poll(() => orders(m).length).toBe(2);
  await expect(page.getByText(/3510 of 3900 sent/).first()).toBeVisible();
  // 3510 closed, 390 still open and still tracked (not wiped as a full exit).
  await expect.poll(() => Number(lastSavedRow(m, 'ft_s2')?.fill?.ceQty ?? -1)).toBe(390);
  await page.waitForTimeout(3_000);
  expect(orders(m).length, 'the rejected remainder is not resent by itself').toBe(2);
});
