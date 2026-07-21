import { test } from 'node:test';
import assert from 'node:assert';
import { sortLegsForPlacement, resolveOrderRequest } from './basketOrders.ts';

test('sortLegsForPlacement orders all buys before all sells, preserving relative order within each group', () => {
  const legs = [
    { side: 'S' as const, id: 1 }, { side: 'B' as const, id: 2 },
    { side: 'S' as const, id: 3 }, { side: 'B' as const, id: 4 },
  ];
  assert.deepStrictEqual(sortLegsForPlacement(legs).map(l => l.id), [2, 4, 1, 3]);
});

test('resolveOrderRequest builds a Dhan fast-order request from a CE leg', () => {
  const leg = { side: 'S' as const, option: 'CE' as const, strike: 24000, qty: 75, type: 'MARKET' as const };
  const strikeMap = { '24000': { ceId: '12345', peId: '67890' } };
  const req = resolveOrderRequest('dhan', leg, strikeMap);
  assert.deepStrictEqual(req, {
    broker: 'dhan', url: '/api/scalper/fast-order',
    body: { securityId: '12345', quantity: 75, side: 'SELL', orderType: 'MARKET' },
  });
});

test('resolveOrderRequest builds a Zerodha order request from a PE leg, snapping a limit price to the 0.05 tick', () => {
  const leg = { side: 'B' as const, option: 'PE' as const, strike: 24000, qty: 75, type: 'LIMIT' as const, price: 123.456 };
  const strikeMap = { '24000': { ceSymbol: 'NIFTY24721C24000', peSymbol: 'NIFTY24721P24000' } };
  const req = resolveOrderRequest('zerodha', leg, strikeMap);
  assert.deepStrictEqual(req, {
    broker: 'zerodha', url: '/api/scalper/zerodha/order',
    body: { tradingsymbol: 'NIFTY24721P24000', quantity: 75, side: 'BUY', orderType: 'LIMIT', price: 123.45 },
  });
});

test('resolveOrderRequest returns null when the strike has no identifier for the requested option', () => {
  const leg = { side: 'S' as const, option: 'CE' as const, strike: 24000, qty: 75, type: 'MARKET' as const };
  assert.strictEqual(resolveOrderRequest('dhan', leg, {}), null);
});

test('resolveOrderRequest returns null when the strike exists but lacks the requested option side identifier', () => {
  const leg = { side: 'S' as const, option: 'PE' as const, strike: 24000, qty: 75, type: 'MARKET' as const };
  const strikeMap = { '24000': { ceId: '12345' } }; // no peId
  assert.strictEqual(resolveOrderRequest('dhan', leg, strikeMap), null);
});
