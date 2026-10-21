import { expect, test } from '@playwright/test';
import { signIn } from './support';
import {
  config, dhanPos, installFocusMock, kotakPos, lastSavedRow, newFocusMock, openFocusTool, orders, realRow, type FocusMock,
} from './focusToolMock';

// Per-leg INDEX LEVELS (exit, partial exit, add-to-open-leg) on Dhan and Kotak, every /api/* call mocked
// (e2e/focusToolMock.ts): the spot is moved by the test, nothing reaches a broker, an unmocked write fails the test.

type Broker = 'dhan' | 'kotak';
let m: FocusMock;

test.beforeEach(async ({ context }) => {
  m = newFocusMock();
  await signIn(context);
});
test.afterEach(() => {
  expect(m.blocked.map(c => `${c.method} ${c.path}`), 'an unmocked write was attempted').toEqual([]);
});

function open(broker: Broker, qty: number, rowPatch: Record<string, unknown>) {
  const row = realRow('ft_lv_1', broker);
  row.fill.ceQty = qty; row.fill.peQty = qty;
  m.config = config([{ ...row, entryTime: '00:01', ...rowPatch }]);
  // An entry level only watches while its index is switched on (the exit levels need no such switch).
  m.config.groups = m.config.groups.map(g => (g.underlying === 'NIFTY' ? { ...g, enabled: true } : g));
  if (broker === 'kotak') m.kotakPositions = [kotakPos('NIFTY26O1923150CE', -qty), kotakPos('NIFTY26O1923150PE', -qty)];
  else m.dhanPositions = [dhanPos('101', 'NIFTY-Oct2026-23150-CE', -qty), dhanPos('201', 'NIFTY-Oct2026-23150-PE', -qty)];
}
const orderPath = (b: Broker) => (b === 'kotak' ? '/api/scalper/kotak/order' : '/api/scalper/fast-order');
const qtyOf = (c: { body: Record<string, unknown> | null }) => Number(c.body?.quantity);
const sideOf = (c: { body: Record<string, unknown> | null }) => String(c.body?.side ?? c.body?.transactionType ?? '').toUpperCase().slice(0, 1);
const cePos = (b: Broker) => (b === 'kotak' ? m.kotakPositions : m.dhanPositions)[0] as { netQty: number };

for (const broker of ['dhan', 'kotak'] as Broker[]) {
  test.describe(broker, () => {
    test('an exit level closes the whole leg on a real cross, once, with the broker\'s own contract', async ({ page }) => {
      open(broker, 65, { ceExitLevel: { dir: 'above', level: '23200' } });
      await installFocusMock(page, m, broker);
      await openFocusTool(page, 'Exit CE leg');
      await page.waitForTimeout(6_000);                 // spot 23150 is on the safe side: the level arms
      expect(orders(m)).toEqual([]);
      m.spot = 23210;
      await expect.poll(() => orders(m).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      await page.waitForTimeout(4_000);
      expect(orders(m)).toHaveLength(1);
      const o = orders(m)[0];
      expect(o.path).toBe(orderPath(broker));
      expect(qtyOf(o)).toBe(65);
      expect(sideOf(o)).toBe('B');
      if (broker === 'kotak') expect(o.body).toMatchObject({ tradingsymbol: 'NIFTY26O1923150CE' });
    });

    test('a level already passed when watching starts waits for spot to come back before it can fire', async ({ page }) => {
      m.spot = 23210;
      open(broker, 65, { ceExitLevel: { dir: 'above', level: '23200' } });
      await installFocusMock(page, m, broker);
      await openFocusTool(page, 'Exit CE leg');
      await page.waitForTimeout(8_000);
      expect(orders(m)).toEqual([]);
    });

    test('a partial exit level reduces by its lots, keeps the rest, and jitter inside the re-arm buffer does not re-fire it', async ({ page }) => {
      open(broker, 130, { ceExitLevel: { dir: 'above', level: '23200', lots: '1' } });
      // A partial reduce settles from the book: the mock books the fill.
      m.orderReply = (_p, body) => {
        const pos = cePos(broker);
        if (pos && sideOf({ body }) === 'B') pos.netQty += qtyOf({ body });
        return { status: 200, body: { success: true, order_id: 'E2E1' } };
      };
      await installFocusMock(page, m, broker);
      await openFocusTool(page, 'Exit CE leg');
      await page.waitForTimeout(6_000);
      m.spot = 23210;
      await expect.poll(() => orders(m).length, { timeout: 30_000 }).toBe(1);
      expect(qtyOf(orders(m)[0])).toBe(65);
      // Inside the 10-pt NIFTY buffer (23190..23200) and back above: still the fired state, so no second order.
      m.spot = 23195; await page.waitForTimeout(5_000);
      m.spot = 23212; await page.waitForTimeout(6_000);
      expect(orders(m)).toHaveLength(1);
      const saved = lastSavedRow(m, 'ft_lv_1');
      if (saved) expect(Number(saved.fill?.ceQty)).toBe(65);
    });

    test('an entry level on an open leg ADDS the lots typed once; Dhan needs the margin check, Kotak is capped at the leg\'s lots', async ({ page }) => {
      open(broker, 65, { ceEntryLevel: { dir: 'above', level: '23200', lots: '3' } });
      m.margin = 100_000;                                // Dhan only: funds mock is 5,00,000
      m.orderReply = (_p, body) => {
        const pos = cePos(broker);
        if (pos && sideOf({ body }) === 'S') pos.netQty -= qtyOf({ body });
        return { status: 200, body: { success: true, order_id: 'E2E1' } };
      };
      await installFocusMock(page, m, broker);
      await openFocusTool(page, 'Exit CE leg');
      await page.waitForTimeout(6_000);
      m.spot = 23210;
      await expect.poll(() => orders(m).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      await page.waitForTimeout(4_000);
      expect(orders(m)).toHaveLength(1);                 // once a day
      expect(sideOf(orders(m)[0])).toBe('S');
      expect(qtyOf(orders(m)[0])).toBe(broker === 'dhan' ? 3 * 65 : 65);
    });
  });
}

test('dhan: an add whose margin cannot be verified is blocked — nothing is sent', async ({ page }) => {
  open('dhan', 65, { ceEntryLevel: { dir: 'above', level: '23200', lots: '1' } });
  m.margin = null;                                      // the margin route fails → fail closed
  await installFocusMock(page, m, 'dhan');
  await openFocusTool(page, 'Exit CE leg');
  await page.waitForTimeout(6_000);
  m.spot = 23210;
  await expect(page.getByText(/add blocked/i).first()).toBeVisible({ timeout: 30_000 });
  expect(orders(m)).toEqual([]);
});
