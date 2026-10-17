import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleUnknownLeg, unknownOrderHeld, UNKNOWN_ORDER_HOLD_MS, type MultiLegBasket, type MultiLegLeg } from './multiLegFocus.ts';
import { basketHasBrokerWork, ordersSettling } from './multiLegBrokerSync.ts';

// A Multi-Leg Focus leg whose opening order came back UNKNOWN (MultiLegLeg.unknownOrder): FAILED, held, and adopted
// from the broker's book if it did fill.

const T0 = 1_792_000_000_000;
const held = (side: 'B' | 'S' = 'S', extra: Partial<MultiLegLeg> = {}): MultiLegLeg => ({
  id: 'l1', side, option: 'CE', strike: 23150, expiry: '2026-10-19', lots: 2, type: 'MARKET', status: 'FAILED',
  orderRef: { securityId: '101' }, unknownOrder: { at: T0, qty: 130, error: 'Order status unknown' }, sl: 30, slType: 'pts',
  ...extra,
});
const row = (netQty: number, extra: Record<string, unknown> = {}) => ({ kind: 'match' as const, row: { securityId: '101', netQty, sellAvg: 101.5, buyAvg: 0, ...extra } });

test('an unknown SELL that filled is adopted OPEN at the broker qty and side average, stops kept', () => {
  const r = settleUnknownLeg(held('S'), row(-130), 65, 0, T0 + 5_000);
  assert.equal(r.outcome, 'adopted');
  assert.equal(r.leg.status, 'OPEN');
  assert.deepEqual(r.leg.fill, { qty: 130, avgPrice: 101.5 });
  assert.equal(r.leg.lots, 2);
  assert.equal(r.leg.unknownOrder, undefined);
  assert.equal(r.leg.filledAt, T0 + 5_000, 'fill grace starts now, so a lagging book cannot clamp it straight back');
  assert.equal(r.leg.sl, 30, 'the stop carried onto the held leg survives adoption');
});

test('adoption never takes more than was ordered, and never the other side of the book', () => {
  assert.deepEqual(settleUnknownLeg(held('S'), row(-195), 65, 0, T0 + 1).leg.fill, { qty: 130, avgPrice: 101.5 });
  assert.equal(settleUnknownLeg(held('S'), row(65), 65, 0, T0 + 1).outcome, 'wait', 'a LONG on the contract is not this short');
  const buy = settleUnknownLeg(held('B'), row(65, { buyAvg: 40.25 }), 65, 0, T0 + 1);
  assert.equal(buy.outcome, 'adopted');
  assert.deepEqual(buy.leg.fill, { qty: 65, avgPrice: 40.25 });
});

test('a contract another live leg already holds is not adopted (one leg per contract)', () => {
  assert.equal(settleUnknownLeg(held('S'), row(-130), 65, 1, T0 + 1).outcome, 'wait');
});

test('nothing at the broker: waits out the hold, then drops it and stays FAILED', () => {
  assert.equal(settleUnknownLeg(held(), { kind: 'not_found' }, 65, 0, T0 + 30_000).outcome, 'wait');
  const r = settleUnknownLeg(held(), { kind: 'not_found' }, 65, 0, T0 + UNKNOWN_ORDER_HOLD_MS + 1);
  assert.equal(r.outcome, 'expired');
  assert.equal(r.leg.status, 'FAILED');
  assert.equal(r.leg.unknownOrder, undefined);
  assert.equal(settleUnknownLeg({ ...held(), unknownOrder: undefined }, row(-130), 65, 0, T0).outcome, 'none');
});

test('while held, broker sync waits (no ungrouped duplicate) and the broker is still polled', () => {
  const basket = { id: 'b1', broker: 'dhan', legs: [held()] } as unknown as MultiLegBasket;
  assert.equal(unknownOrderHeld(held(), T0 + 10_000), true);
  assert.equal(ordersSettling([basket], T0 + 10_000), true);
  assert.equal(ordersSettling([basket], T0 + UNKNOWN_ORDER_HOLD_MS + 1), false);
  assert.equal(basketHasBrokerWork(basket, '2026-10-17'), true, 'a FAILED leg alone would not be polled without this');
});
