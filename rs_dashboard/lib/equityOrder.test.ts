import { test } from 'node:test';
import assert from 'node:assert';
import { validateOrder, roundToTick, pendingSellQty, MAX_QTY_PER_ORDER, MAX_ORDER_VALUE } from './equityOrder.ts';

const facts = { ltp: 312.75, tick: 0.05, availableQty: 10, intradayLongQty: 0, pendingSellQty: 0 };
const base = { side: 'BUY', product: 'CNC', orderType: 'MARKET', quantity: 10 };

function err(req: object, f = facts): string {
  const v = validateOrder(req, f);
  assert.equal(v.ok, false);
  return v.ok ? '' : v.error;
}

test('roundToTick snaps to the exchange tick without float noise', () => {
  assert.equal(roundToTick(312.77, 0.05), 312.75);
  assert.equal(roundToTick(312.78, 0.05), 312.8);
  assert.equal(roundToTick(1500.04, 0.1), 1500);
});

test('valid market buy uses LTP for the notional', () => {
  const v = validateOrder(base, facts);
  assert.ok(v.ok);
  if (v.ok) { assert.equal(v.order.price, 0); assert.equal(v.order.value, 3127.5); assert.equal(v.order.amo, false); }
});

test('rejects bad enums, non-integer and non-positive quantities', () => {
  assert.match(err({ ...base, side: 'HOLD' }), /required/);
  assert.match(err({ ...base, product: 'MARGIN' }), /required/);
  assert.match(err({ ...base, orderType: 'SL' }), /required/);
  for (const q of [0, -5, 1.5, NaN, '3x', null, undefined]) assert.match(err({ ...base, quantity: q }), /positive whole number/);
});

test('server-side quantity and value ceilings', () => {
  assert.match(err({ ...base, quantity: MAX_QTY_PER_ORDER + 1 }, { ...facts, ltp: 1 }), /max allowed quantity/);
  const qty = Math.ceil(MAX_ORDER_VALUE / facts.ltp) + 1;
  assert.match(err({ ...base, quantity: qty }), /per-order limit/);
  // Limit orders are capped on their own price, not on LTP.
  assert.match(err({ ...base, orderType: 'LIMIT', price: 360, quantity: Math.floor(MAX_ORDER_VALUE / 360) + 1 }), /per-order limit/);
});

test('limit price: required, tick-rounded and kept within the band around LTP', () => {
  assert.match(err({ ...base, orderType: 'LIMIT' }), /valid price/);
  assert.match(err({ ...base, orderType: 'LIMIT', price: 0 }), /valid price/);
  assert.match(err({ ...base, orderType: 'LIMIT', price: 31.27 }), /from the live price/); // dropped a digit
  assert.match(err({ ...base, orderType: 'LIMIT', price: 3127.5 }), /from the live price/); // extra digit
  const v = validateOrder({ ...base, orderType: 'LIMIT', price: 312.77 }, facts);
  assert.ok(v.ok);
  if (v.ok) assert.equal(v.order.price, 312.75);
});

test('a SELL can only close what is owned: no short-selling, in either product', () => {
  // Nothing held at all -> every sell is refused, however it is dressed up.
  const none = { ...facts, availableQty: 0, intradayLongQty: 0 };
  for (const product of ['CNC', 'INTRADAY']) {
    for (const orderType of ['MARKET', 'LIMIT']) {
      assert.match(err({ ...base, side: 'SELL', product, orderType, price: 312.75 }, none), /nothing to sell/);
    }
  }
  // Delivery: capped by sellable holdings.
  assert.match(err({ ...base, side: 'SELL', quantity: 11 }), /at most 10/);
  assert.ok(validateOrder({ ...base, side: 'SELL', quantity: 10 }, facts).ok);
  // Holdings do not authorise an Intraday sell, and an Intraday position does not authorise a Delivery sell.
  assert.match(err({ ...base, side: 'SELL', product: 'INTRADAY' }, facts), /nothing to sell/);
  assert.match(err({ ...base, side: 'SELL', product: 'CNC' }, { ...none, intradayLongQty: 5 }), /nothing to sell/);
  // Intraday: capped by today's open long MIS position.
  const mis = { ...none, intradayLongQty: 20 };
  assert.match(err({ ...base, side: 'SELL', product: 'INTRADAY', quantity: 21 }, mis), /at most 20/);
  assert.ok(validateOrder({ ...base, side: 'SELL', product: 'INTRADAY', quantity: 20 }, mis).ok);
  // Shares already claimed by open sell orders cannot be sold again (this is what stops a double-sell turning into a short).
  assert.match(err({ ...base, side: 'SELL', quantity: 5 }, { ...facts, pendingSellQty: 10 }), /already committed/);
  assert.match(err({ ...base, side: 'SELL', quantity: 8 }, { ...facts, pendingSellQty: 4 }), /at most 6 \(10 owned, 4 already/);
  assert.ok(validateOrder({ ...base, side: 'SELL', quantity: 6 }, { ...facts, pendingSellQty: 4 }).ok);
  assert.match(err({ ...base, side: 'SELL', product: 'INTRADAY', quantity: 1 }, { ...mis, pendingSellQty: 20 }), /already committed/);
  // BUY is unaffected by holdings.
  assert.ok(validateOrder(base, none).ok);
});

test('fails closed without a live price or with a nonsense tick', () => {
  assert.match(err(base, { ...facts, ltp: 0 }), /No live price/);
  assert.match(err(base, { ...facts, tick: 5 }), /tick/);
});

test('amo flag only counts when exactly true', () => {
  const t = validateOrder({ ...base, amo: true }, facts);
  const s = validateOrder({ ...base, amo: 'true' }, facts);
  assert.ok(t.ok && s.ok);
  if (t.ok && s.ok) { assert.equal(t.order.amo, true); assert.equal(s.order.amo, false); }
});

test('pendingSellQty counts only the unfilled remainder of live SELL orders for that stock and product', () => {
  const o = (x: object) => ({ securityId: '4907', exchangeSegment: 'NSE_EQ', transactionType: 'SELL', productType: 'CNC', orderStatus: 'PENDING', quantity: 100, ...x });
  assert.equal(pendingSellQty([o({})], '4907', 'CNC'), 100);
  assert.equal(pendingSellQty([o({ orderStatus: 'PART_TRADED', filledQty: 30 })], '4907', 'CNC'), 70); // quantity - filledQty
  assert.equal(pendingSellQty([o({ orderStatus: 'PART_TRADED', remainingQuantity: 25 })], '4907', 'CNC'), 25);
  assert.equal(pendingSellQty([o({}), o({ quantity: 40, orderStatus: 'TRANSIT' })], '4907', 'CNC'), 140); // several open orders add up
  // Ignored: other stock, other product, BUY side, other segment, and finished orders.
  for (const x of [{ securityId: '1' }, { productType: 'INTRADAY' }, { transactionType: 'BUY' }, { exchangeSegment: 'BSE_EQ' },
    { orderStatus: 'TRADED' }, { orderStatus: 'REJECTED' }, { orderStatus: 'CANCELLED' }]) {
    assert.equal(pendingSellQty([o(x)], '4907', 'CNC'), 0, JSON.stringify(x));
  }
  assert.equal(pendingSellQty([], '4907', 'CNC'), 0);
});
