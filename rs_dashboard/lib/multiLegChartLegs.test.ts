import test from 'node:test';
import assert from 'node:assert/strict';
import { chartLegsFor, chartHasMixedExpiry } from './multiLegChartLegs.ts';
import type { MultiLegLeg } from './multiLegFocus.ts';

const leg = (o: Partial<MultiLegLeg> = {}) =>
  ({ id: 'x', side: 'S', option: 'CE', strike: 25000, status: 'OPEN', lots: 1, ...o }) as unknown as MultiLegLeg;

test('sell leg becomes a SELL chart leg', () => {
  assert.deepEqual(chartLegsFor([leg()]), [{ option_type: 'CE', action: 'SELL', strike: 25000, lots: 1 }]);
});

test('CLOSED, FAILED, zero-lot and futures legs are skipped', () => {
  const legs = [leg({ status: 'CLOSED' }), leg({ status: 'FAILED' }), leg({ lots: 0 }), leg({ option: 'FUT', strike: 0 })];
  assert.deepEqual(chartLegsFor(legs), []);
});

test('same-side legs on one contract add up', () => {
  const r = chartLegsFor([leg({ lots: 2 }), leg({ lots: 3 })]);
  assert.deepEqual(r, [{ option_type: 'CE', action: 'SELL', strike: 25000, lots: 5 }]);
});

test('BUY and SELL on one contract are netted, not sent as two legs', () => {
  const r = chartLegsFor([leg({ side: 'S', lots: 5 }), leg({ side: 'B', lots: 2 })]);
  assert.deepEqual(r, [{ option_type: 'CE', action: 'SELL', strike: 25000, lots: 3 }]);
  const flipped = chartLegsFor([leg({ side: 'S', lots: 2 }), leg({ side: 'B', lots: 5 })]);
  assert.deepEqual(flipped, [{ option_type: 'CE', action: 'BUY', strike: 25000, lots: 3 }]);
});

test('a fully offset contract drops out', () => {
  assert.deepEqual(chartLegsFor([leg({ side: 'S', lots: 2 }), leg({ side: 'B', lots: 2 })]), []);
});

test('CE and PE on one strike stay separate', () => {
  const r = chartLegsFor([leg(), leg({ option: 'PE' })]);
  assert.equal(r.length, 2);
});

test('an OPEN leg is sized from the filled qty when it divides by the lot size', () => {
  const r = chartLegsFor([leg({ lots: 5, fill: { qty: 130, avgPrice: 100 } })], 65);
  assert.equal(r[0].lots, 2);
});

test('falls back to ordered lots when qty does not divide, no lot size, or not OPEN', () => {
  assert.equal(chartLegsFor([leg({ lots: 5, fill: { qty: 100, avgPrice: 1 } })], 65)[0].lots, 5);
  assert.equal(chartLegsFor([leg({ lots: 5, fill: { qty: 130, avgPrice: 1 } })])[0].lots, 5);
  assert.equal(chartLegsFor([leg({ lots: 5, status: 'PLACING', fill: { qty: 130, avgPrice: 1 } })], 65)[0].lots, 5);
});

test('large lot counts pass through unchanged', () => {
  assert.equal(chartLegsFor([leg({ lots: 40 })])[0].lots, 40);
});

test('mixed expiry only counts legs the chart would plot', () => {
  const far = '2026-11-27';
  assert.equal(chartHasMixedExpiry([leg(), leg({ expiry: far })], '2026-10-27'), true);
  assert.equal(chartHasMixedExpiry([leg(), leg({ expiry: far, status: 'FAILED' })], '2026-10-27'), false);
  assert.equal(chartHasMixedExpiry([leg(), leg({ expiry: far, status: 'CLOSED' })], '2026-10-27'), false);
  assert.equal(chartHasMixedExpiry([leg({ expiry: '2026-10-27' }), leg()], '2026-10-27'), false);
});
