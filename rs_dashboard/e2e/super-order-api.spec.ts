import { expect, test } from '@playwright/test';
import { sessionCookieValue } from './support';

/**
 * /api/super-order is a REAL-MONEY route. These tests only send requests that are rejected by
 * validation BEFORE any Dhan call (400s) and the auth gate (401). Never add a "valid order" case
 * here: on a machine with a live token it would place a real bracket.
 */
const headers = () => ({ Cookie: `dhan_session=${sessionCookieValue()}`, 'Content-Type': 'application/json' });
const BASE = { securityId: '111', exchangeSegment: 'NSE_FNO', side: 'BUY', productType: 'MARGIN', orderType: 'LIMIT', quantity: 75, price: 100, targetPrice: 110, stopLossPrice: 90, idempotencyKey: 'abcdefgh12' };

async function post(request: import('@playwright/test').APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post('/api/super-order', { headers: headers(), data });
  return { status: res.status(), body: await res.json() as { success: boolean; error?: string } };
}

test('unauthenticated requests are refused', async ({ request }) => {
  const res = await request.post('/api/super-order', { data: {}, headers: { 'Content-Type': 'application/json' } });
  expect(res.status()).toBe(401);
});

test('an idempotency key is required', async ({ request }) => {
  const { idempotencyKey: _omit, ...noKey } = BASE;
  void _omit;
  const r = await post(request, noKey);
  expect(r.status).toBe(400);
  expect(r.body.error).toMatch(/idempotencyKey/);
});

for (const [name, patch, message] of [
  ['cash equity is not allowed', { exchangeSegment: 'NSE_EQ' }, /Unsupported exchangeSegment/],
  ['an unknown product', { productType: 'CO' }, /Unsupported productType/],
  ['a BUY stop above the entry', { stopLossPrice: 105 }, /BUY needs/],
  ['a SELL with BUY-side levels', { side: 'SELL' }, /SELL needs/],
  ['a quantity over the cap', { quantity: 9999 }, /cap/],
  ['a fractional quantity', { quantity: 7.5 }, /quantity/i],
  ['a LIMIT without a price', { price: 0 }, /price/i],
  ['a MARKET entry with no reference price', { orderType: 'MARKET', price: undefined }, /refPrice/],
  ['a trail as large as the stop distance', { trailingJump: 10 }, /trailingJump/],
] as [string, Record<string, unknown>, RegExp][]) {
  test(`rejects ${name}`, async ({ request }) => {
    const r = await post(request, { ...BASE, ...patch });
    expect(r.status).toBe(400);
    expect(r.body.success).toBe(false);
    expect(r.body.error).toMatch(message);
  });
}

test('modify and cancel validate their inputs before sending anything', async ({ request }) => {
  const put = async (data: Record<string, unknown>) => (await request.put('/api/super-order', { headers: headers(), data })).status();
  expect(await put({ orderId: '5', legName: 'NOPE' })).toBe(400);
  expect(await put({ orderId: '5', legName: 'ENTRY_LEG', price: 101 })).toBe(400);          // needs orderType
  expect(await put({ orderId: '5', legName: 'TARGET_LEG', stopLossPrice: 95 })).toBe(400);  // wrong leg field
  const del = await request.delete('/api/super-order?orderId=5&leg=BAD', { headers: headers() });
  expect(del.status()).toBe(400);
});
