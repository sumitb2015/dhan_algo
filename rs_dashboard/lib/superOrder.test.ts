import { test } from 'node:test';
import assert from 'node:assert';
import { buildPlacePayload, validateModify, validateSuperOrder, type SuperOrderInput } from './superOrder.ts';

const buy: SuperOrderInput = {
  securityId: '12345', exchangeSegment: 'NSE_FNO', side: 'BUY', productType: 'INTRADAY',
  orderType: 'LIMIT', quantity: 75, price: 100, targetPrice: 120, stopLossPrice: 90,
};

test('a well-formed BUY and SELL bracket pass', () => {
  assert.strictEqual(validateSuperOrder(buy), null);
  assert.strictEqual(validateSuperOrder({ ...buy, side: 'SELL', targetPrice: 80, stopLossPrice: 110 }), null);
});

test('target/stop on the wrong side of entry are rejected', () => {
  assert.match(validateSuperOrder({ ...buy, stopLossPrice: 105 })!, /BUY needs/);
  assert.match(validateSuperOrder({ ...buy, side: 'SELL' })!, /SELL needs/);
});

test('MARKET entry validates against refPrice and needs one', () => {
  const mkt = { ...buy, orderType: 'MARKET', price: undefined };
  assert.match(validateSuperOrder(mkt)!, /refPrice/);
  assert.strictEqual(validateSuperOrder({ ...mkt, refPrice: 100 }), null);
  assert.strictEqual(buildPlacePayload({ ...mkt, refPrice: 100 }, 'c1').price, 100);   // never 0: Dhan's SDK refuses it
  assert.ok(!('refPrice' in buildPlacePayload({ ...mkt, refPrice: 100 }, 'c1')));
});

test('quantity, product, segment and security id are enforced', () => {
  assert.match(validateSuperOrder({ ...buy, quantity: 0 })!, /quantity/i);
  assert.match(validateSuperOrder({ ...buy, quantity: 7.5 })!, /quantity/i);
  assert.match(validateSuperOrder({ ...buy, quantity: 99999 })!, /cap/);
  assert.match(validateSuperOrder({ ...buy, productType: 'CO' })!, /productType/);
  assert.match(validateSuperOrder({ ...buy, exchangeSegment: 'IDX_I' })!, /exchangeSegment/);
  assert.match(validateSuperOrder({ ...buy, exchangeSegment: 'NSE_EQ' })!, /exchangeSegment/);   // equity bypasses equity-order's caps
  assert.match(validateSuperOrder({ ...buy, securityId: 'NIFTY' })!, /securityId/);
});

test('trailing jump must be smaller than the stop distance', () => {
  assert.strictEqual(validateSuperOrder({ ...buy, trailingJump: 5 }), null);
  assert.match(validateSuperOrder({ ...buy, trailingJump: 10 })!, /trailingJump/);
  assert.match(validateSuperOrder({ ...buy, trailingJump: -1 })!, /trailingJump/);
});

test('each leg only accepts its own fields on modify', () => {
  assert.strictEqual(validateModify({ legName: 'TARGET_LEG', targetPrice: 125 }), null);
  assert.match(validateModify({ legName: 'ENTRY_LEG', price: 101 })!, /orderType/);
  assert.strictEqual(validateModify({ legName: 'ENTRY_LEG', orderType: 'LIMIT', price: 101 }), null);
  assert.match(validateModify({ legName: 'TARGET_LEG', stopLossPrice: 95 })!, /cannot change/);
  assert.strictEqual(validateModify({ legName: 'STOP_LOSS_LEG', stopLossPrice: 95, trailingJump: 0 }), null);
  assert.match(validateModify({ legName: 'STOP_LOSS_LEG' })!, /Nothing/);
});

import { hasUnmatchableActive, legsToCancel, resolveBracket } from './superOrder.ts';

const tk = { securityId: '12345', exchangeSegment: 'NSE_FNO', productType: 'MARGIN', quantity: 75, targetPts: 10, slPts: 8, trailPts: 0 };

test('resolveBracket: BUY and SELL levels around the LTP, tick-rounded', () => {
  const b = resolveBracket({ ...tk, side: 'BUY', orderType: 'MARKET', ltp: 100.07 });
  assert.ok(b.ok);
  assert.deepStrictEqual([b.order.refPrice, b.order.targetPrice, b.order.stopLossPrice], [100.05, 110.05, 92.05]);
  const s = resolveBracket({ ...tk, side: 'SELL', orderType: 'LIMIT', limitPrice: 100, ltp: 90 });
  assert.ok(s.ok);
  assert.deepStrictEqual([s.order.price, s.order.targetPrice, s.order.stopLossPrice], [100, 90, 108]);
});

test('resolveBracket: refuses without a price, with a stop through zero, or a trail >= stop distance', () => {
  assert.ok(!resolveBracket({ ...tk, side: 'BUY', orderType: 'MARKET', ltp: 0 }).ok);
  assert.ok(!resolveBracket({ ...tk, side: 'BUY', orderType: 'MARKET', ltp: 5, slPts: 8 }).ok);
  assert.ok(!resolveBracket({ ...tk, side: 'BUY', orderType: 'MARKET', ltp: 100, trailPts: 8 }).ok);
  assert.ok(!resolveBracket({ ...tk, side: 'BUY', orderType: 'LIMIT', ltp: 100 }).ok);
});

test('legsToCancel: live exit legs and an unfilled entry; terminal legs and other securities ignored', () => {
  const rows = [
    { orderId: '1', securityId: '12345', legDetails: [
      { legName: 'ENTRY_LEG', orderStatus: 'TRADED' },
      { legName: 'TARGET_LEG', orderStatus: 'PENDING' },
      { legName: 'STOP_LOSS_LEG', orderStatus: 'TRIGGER_PENDING' } ] },
    { orderId: '2', securityId: '12345', legDetails: [
      { legName: 'ENTRY_LEG', orderStatus: 'PENDING' },
      { legName: 'TARGET_LEG', orderStatus: 'CANCELLED' } ] },
    { orderId: '3', securityId: '999', legDetails: [{ legName: 'TARGET_LEG', orderStatus: 'PENDING' }] },
    { orderId: '4', securityId: '12345', orderStatus: 'PENDING' },
  ];
  assert.deepStrictEqual(legsToCancel(rows, '12345'), [
    { orderId: '1', leg: 'TARGET_LEG' }, { orderId: '1', leg: 'STOP_LOSS_LEG' },
    { orderId: '2', leg: 'ENTRY_LEG' }, { orderId: '4', leg: 'ENTRY_LEG' },
  ]);
});

test('hasUnmatchableActive flags a live row without a securityId, ignores finished ones', () => {
  assert.ok(hasUnmatchableActive([{ orderId: '9', orderStatus: 'PENDING' }]));
  assert.ok(!hasUnmatchableActive([{ orderId: '9', orderStatus: 'TRADED' }, { orderId: '8', securityId: '1', orderStatus: 'PENDING' }]));
});
