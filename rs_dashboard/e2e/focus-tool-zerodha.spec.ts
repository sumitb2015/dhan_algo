import { expect, test } from '@playwright/test';
import { signIn } from './support';
import { config, flatRealRow, installFocusMock, newFocusMock, openFocusTool, orders, realRow, type FocusMock } from './focusToolMock';

// Zerodha on the Focus Tool, every /api/* call mocked (e2e/focusToolMock.ts): the same order safety Dhan and Kotak
// have. Opens carry the 'fts' per-source lot cap, closes carry none (a close must never be refused for its size), and
// fills / traded prices are read from the order itself (/api/scalper/orders?orderId=&broker=zerodha).

const zerodhaPos = (sym: string, netQty: number) => ({
  tradingSymbol: sym, securityId: '1', exchange: 'NFO', netQty, productType: 'NRML',
  buyQty: netQty > 0 ? netQty : 0, sellQty: netQty < 0 ? -netQty : 0, buyAvg: 0, sellAvg: 100,
  lastTradedPrice: 0, realizedProfit: 0, unrealizedProfit: 0,
});

let m: FocusMock;

test.beforeEach(async ({ context }) => {
  m = newFocusMock();
  await signIn(context);
});

test.afterEach(() => {
  expect(m.blocked.map(c => `${c.method} ${c.path}`), 'an unmocked write was attempted').toEqual([]);
});

test('Zerodha: an entry sends its opens with the fts source and confirms each fill from the order', async ({ page }) => {
  m.config = config([flatRealRow('ft_z1')]);
  m.orderReply = (_p, body, mm) => {
    const sym = String(body?.tradingsymbol);
    mm.zerodhaPositions.push(zerodhaPos(sym, -Number(body?.quantity)));   // the fill shows in the book
    return { status: 200, body: { success: true, order_id: `Z-${sym.endsWith('CE') ? 'CE' : 'PE'}` } };
  };
  m.orderStatus = id => ({ orderId: id, orderStatus: 'TRADED', quantity: 65, filledQty: 65, averageTradedPrice: 101.5, reason: '' });
  await installFocusMock(page, m, 'zerodha', 'pro');
  await openFocusTool(page, 'Enter now');

  page.on('dialog', d => void d.accept());
  await page.getByRole('button', { name: /Enter now/ }).first().click();
  await expect.poll(() => orders(m).length).toBe(2);
  for (const o of orders(m)) {
    expect(o.path).toBe('/api/scalper/zerodha/order');
    expect(o.body).toMatchObject({ side: 'SELL', exchange: 'NFO', source: 'fts', quantity: 65 });
  }
  // The traded price is read from the Zerodha order book, not Dhan's.
  await expect.poll(() => m.calls.some(c => c.path === '/api/scalper/orders' && c.search.includes('broker=zerodha'))).toBe(true);
  expect(m.calls.some(c => c.path === '/api/scalper/orders' && c.search.includes('broker=dhan'))).toBe(false);
});

test('Zerodha: a leg exit sends no source, so the lot cap can never refuse a close', async ({ page }) => {
  m.config = config([realRow('ft_z2', 'zerodha')]);
  m.zerodhaPositions = [zerodhaPos('NIFTY26O1923150CE', -65), zerodhaPos('NIFTY26O1923150PE', -65)];
  m.orderReply = (_p, body, mm) => {
    const cur = mm.zerodhaPositions.find(p => p.tradingSymbol === body?.tradingsymbol);
    if (cur) cur.netQty = Number(cur.netQty) + Number(body?.quantity);
    return { status: 200, body: { success: true, order_id: 'Z-CLOSE' } };
  };
  m.orderStatus = id => ({ orderId: id, orderStatus: 'TRADED', quantity: 65, filledQty: 65, averageTradedPrice: 80, reason: '' });
  await installFocusMock(page, m, 'zerodha');
  await openFocusTool(page, 'Exit CE leg');

  page.on('dialog', d => void d.accept());
  await page.getByRole('button', { name: 'Exit CE leg' }).first().click();
  await expect.poll(() => orders(m).length).toBe(1);
  expect(orders(m)[0].path).toBe('/api/scalper/zerodha/order');
  expect(orders(m)[0].body).toMatchObject({ tradingsymbol: 'NIFTY26O1923150CE', side: 'BUY', quantity: 65 });
  expect(orders(m)[0].body).not.toHaveProperty('source');
});
