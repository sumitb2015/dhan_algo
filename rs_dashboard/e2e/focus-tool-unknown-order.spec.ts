import { expect, test, type Page } from '@playwright/test';
import { signIn } from './support';
import {
  config, dhanPos, events, flatRealRow, installFocusMock, kotakPos, lastSavedRow, newFocusMock, openFocusTool, orders, realRow,
  type FocusMock, type OrderReply,
} from './focusToolMock';

// An order whose outcome is UNKNOWN (lib/focusToolOrderOutcome.ts) may be live at the broker. Before 2026-10-17 the
// Focus Tool reported it as "rejected": an entry then retried the leg (a doubled short the row only half owned) and,
// when every leg was unknown, cleared its one-entry latch and re-sold on every later tick. Every /api/* call is mocked
// (e2e/focusToolMock.ts); the order routes answer what each test scripts.

const KOTAK_UNKNOWN: OrderReply = { status: 504, body: { success: false, unknown: true, error: 'Order status unknown - Kotak did not confirm in time.' } };
// Dhan's route answers 504 too; before this change it carried no `unknown` flag, so the status alone must be enough.
const DHAN_UNKNOWN: OrderReply = { status: 504, body: { success: false, error: 'Order status unknown — Dhan did not confirm in time.' } };
const booked = (id: string): OrderReply => ({ status: 200, body: { success: true, order_id: id } });

/** Kotak book: the order's contract moves by its quantity (a fill), so the page's fill check confirms it. */
function kotakFills(m: FocusMock, body: Record<string, unknown> | null) {
  const sym = String(body?.tradingsymbol);
  const qty = Number(body?.quantity) * (body?.side === 'SELL' ? -1 : 1);
  const cur = m.kotakPositions.find(p => p.tradingSymbol === sym);
  if (cur) cur.netQty = Number(cur.netQty) + qty;
  else m.kotakPositions.push(kotakPos(sym, qty));
}

const legOf = (body: Record<string, unknown> | null) => String(body?.tradingsymbol ?? body?.securityId ?? '').endsWith('CE') || String(body?.securityId) === '101' ? 'CE' : 'PE';

async function enterNow(page: Page) {
  page.on('dialog', d => void d.accept());   // "Enter NIFTY now with REAL money?"
  await page.getByRole('button', { name: /Enter now/ }).first().click();
}

/** No further order for `ms`: the scheduler ticks every second, so a retry loop would show up well inside this. */
async function noMoreOrdersFor(page: Page, m: FocusMock, ms: number) {
  const n = orders(m).length;
  await page.waitForTimeout(ms);
  expect(orders(m).length, 'an order was sent after an unknown outcome').toBe(n);
}

let m: FocusMock;

test.beforeEach(async ({ context }) => {
  m = newFocusMock();
  await signIn(context);
});

test.afterEach(() => {
  expect(m.blocked.map(c => `${c.method} ${c.path}`), 'an unmocked write was attempted').toEqual([]);
});

test('Kotak: the first leg comes back UNKNOWN — the second is not sent, nothing is retried, the row is paused', async ({ page }) => {
  m.config = config([flatRealRow('ft_u1')]);
  m.orderReply = () => KOTAK_UNKNOWN;
  await installFocusMock(page, m, 'kotak', 'pro');
  await openFocusTool(page, 'Enter now');

  await enterNow(page);
  await expect.poll(() => orders(m).length).toBe(1);
  expect(orders(m)[0].body).toMatchObject({ tradingsymbol: 'NIFTY26O1923150CE', side: 'SELL' });
  await expect(page.getByRole('alert').filter({ hasText: 'status UNKNOWN' })).toBeVisible();
  await expect(page.getByText(/order rejected/)).toHaveCount(0);
  await expect.poll(() => events(m, 'order_unknown').length).toBe(1);
  expect(events(m, 'order_unknown')[0]).toMatchObject({ leg: 'CE', orderKind: 'open', side: 'SELL', qty: 65, broker: 'kotak' });
  await noMoreOrdersFor(page, m, 6_000);
  // Persisted, so a reload keeps the row paused.
  await expect.poll(() => !!lastSavedRow(m, 'ft_u1')?.orderUnknown).toBe(true);
});

test('Kotak: CE fills, PE comes back UNKNOWN — PE is never retried and the row says it may be one-sided', async ({ page }) => {
  m.config = config([flatRealRow('ft_u2')]);
  m.orderReply = (_p, body, mm) => {
    if (legOf(body) === 'CE') { kotakFills(mm, body); return booked('K-CE'); }
    return KOTAK_UNKNOWN;
  };
  await installFocusMock(page, m, 'kotak', 'pro');
  await openFocusTool(page, 'Enter now');

  await enterNow(page);
  await expect.poll(() => orders(m).length).toBe(2);
  await expect(page.getByText(/POSSIBLY NAKED PE/).first()).toBeVisible();
  await noMoreOrdersFor(page, m, 6_000);
  expect(orders(m).map(o => legOf(o.body))).toEqual(['CE', 'PE']);
  await expect(page.getByRole('alert').filter({ hasText: 'status UNKNOWN' })).toBeVisible();
});

test('Dhan: a 504 with no unknown flag is held the same way', async ({ page }) => {
  m.config = config([flatRealRow('ft_u3')]);
  m.orderReply = () => DHAN_UNKNOWN;
  await installFocusMock(page, m, 'dhan', 'pro');
  await openFocusTool(page, 'Enter now');

  await enterNow(page);
  await expect.poll(() => orders(m).length).toBe(1);
  expect(orders(m)[0].path).toBe('/api/scalper/fast-order');
  await expect(page.getByRole('alert').filter({ hasText: 'status UNKNOWN' })).toBeVisible();
  await noMoreOrdersFor(page, m, 6_000);
});

test('an UNKNOWN first entry that did fill is picked up from the book and tracked by the row', async ({ page }) => {
  m.config = config([flatRealRow('ft_u4')]);
  m.orderReply = (_p, body, mm) => {
    // It went through at the broker, but the reply was lost: the position shows up a moment later.
    setTimeout(() => kotakFills(mm, body), 2_000);
    return KOTAK_UNKNOWN;
  };
  await installFocusMock(page, m, 'kotak', 'pro');
  await openFocusTool(page, 'Enter now');

  await enterNow(page);
  await expect.poll(() => orders(m).length).toBe(1);
  // Before the fix the hold record was discarded at once (the row had no ledger yet) and this short went unwatched.
  await expect(page.getByText(/sell confirmed late/).first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => Number(lastSavedRow(m, 'ft_u4')?.fill?.ceQty ?? 0)).toBe(65);
  await noMoreOrdersFor(page, m, 3_000);
});

test('an UNKNOWN close holds further closes on that leg and keeps the leg in the ledger', async ({ page }) => {
  m.config = config([realRow('ft_u5', 'kotak')]);
  m.kotakPositions = [kotakPos('NIFTY26O1923150CE', -65), kotakPos('NIFTY26O1923150PE', -65)];
  m.orderReply = () => KOTAK_UNKNOWN;
  await installFocusMock(page, m, 'kotak');
  await openFocusTool(page, 'Exit CE leg');

  const exitCe = page.getByRole('button', { name: 'Exit CE leg' }).first();
  await exitCe.click();
  await expect.poll(() => orders(m).length).toBe(1);
  await expect.poll(() => events(m, 'order_unknown').map(e => e.kind)).toEqual(['order_unknown']);
  expect(events(m, 'order_unknown')[0]).toMatchObject({ leg: 'CE', orderKind: 'close', side: 'BUY', qty: 65, broker: 'kotak' });
  // A second Exit while the first close may still land: refused, never resent (the "on hold" note is throttled to one
  // per 5 s per leg, so click past that).
  await page.waitForTimeout(6_000);
  await exitCe.click();
  await expect(page.getByText(/close on hold/).first()).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(orders(m)).toHaveLength(1);
  const saved = lastSavedRow(m, 'ft_u5');
  if (saved) expect(Number(saved.fill?.ceQty)).toBe(65);
  // A close never pauses the row's opens: there is no banner for it.
  await expect(page.getByRole('alert').filter({ hasText: 'status UNKNOWN' })).toHaveCount(0);
});

test('"Checked — resume" clears the pause (and is the only thing besides re-arming that does)', async ({ page }) => {
  m.config = config([{ ...flatRealRow('ft_u6'), orderUnknown: { at: new Date().toISOString(), leg: 'CE', kind: 'open', detail: 'e2e' } }]);
  m.dhanPositions = [dhanPos('101', 'NIFTY-Oct2026-23150-CE', 0)];
  await installFocusMock(page, m, 'kotak', 'pro');
  await openFocusTool(page, 'Enter now');

  const banner = page.getByRole('alert').filter({ hasText: 'status UNKNOWN' });
  await expect(banner).toBeVisible();
  await page.getByRole('button', { name: /Clear the unknown-order hold/ }).click();
  await expect(banner).toHaveCount(0);
  await expect.poll(() => lastSavedRow(m, 'ft_u6') !== null && !lastSavedRow(m, 'ft_u6')?.orderUnknown).toBe(true);
  expect(orders(m)).toEqual([]);
});
