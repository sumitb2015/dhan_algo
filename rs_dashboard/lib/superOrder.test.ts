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
  assert.strictEqual(buildPlacePayload({ ...mkt, refPrice: 100 }, 'c1').price, 0);
  assert.ok(!('refPrice' in buildPlacePayload({ ...mkt, refPrice: 100 }, 'c1')));
});

test('quantity, product, segment and security id are enforced', () => {
  assert.match(validateSuperOrder({ ...buy, quantity: 0 })!, /quantity/i);
  assert.match(validateSuperOrder({ ...buy, quantity: 7.5 })!, /quantity/i);
  assert.match(validateSuperOrder({ ...buy, quantity: 99999 })!, /cap/);
  assert.match(validateSuperOrder({ ...buy, productType: 'CO' })!, /productType/);
  assert.match(validateSuperOrder({ ...buy, exchangeSegment: 'IDX_I' })!, /exchangeSegment/);
  assert.match(validateSuperOrder({ ...buy, securityId: 'NIFTY' })!, /securityId/);
});

test('trailing jump must be smaller than the stop distance', () => {
  assert.strictEqual(validateSuperOrder({ ...buy, trailingJump: 5 }), null);
  assert.match(validateSuperOrder({ ...buy, trailingJump: 10 })!, /trailingJump/);
  assert.match(validateSuperOrder({ ...buy, trailingJump: -1 })!, /trailingJump/);
});

test('each leg only accepts its own fields on modify', () => {
  assert.strictEqual(validateModify({ legName: 'TARGET_LEG', targetPrice: 125 }), null);
  assert.match(validateModify({ legName: 'TARGET_LEG', stopLossPrice: 95 })!, /cannot change/);
  assert.strictEqual(validateModify({ legName: 'STOP_LOSS_LEG', stopLossPrice: 95, trailingJump: 0 }), null);
  assert.match(validateModify({ legName: 'STOP_LOSS_LEG' })!, /Nothing/);
});
