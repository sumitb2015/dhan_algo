import { test } from 'node:test';
import assert from 'node:assert';
import { basketToGreekLegs, computeBasketGreeks } from './multiLegGreeks.ts';
import type { MultiLegBasket } from './multiLegFocus.ts';

const mk = (legs: Partial<MultiLegBasket['legs'][number]>[]): MultiLegBasket => ({
  id: 'b', underlying: 'NIFTY', expiry: '2026-10-27', broker: 'dhan', createdAt: '', updatedAt: '',
  legs: legs.map((l, i) => ({ id: `l${i}`, side: 'S', option: 'CE', strike: 23000, lots: 1, type: 'MARKET', status: 'DRAFT', ...l })) as MultiLegBasket['legs'],
});
const oc = {
  '23000': { ce: { greeks: { delta: 0.5, gamma: 0.002, theta: -10, vega: 12 }, implied_volatility: 13 }, pe: { greeks: { delta: -0.5, gamma: 0.002, theta: -10, vega: 12 }, implied_volatility: 14 } },
} as never;

test('draft uses lots x lotSize', () => {
  const g = basketToGreekLegs(mk([{ lots: 2 }]), 65);
  assert.equal(g[0].units, 130);
});

test('placed basket: fill qty, closed legs skipped', () => {
  const b = mk([{ status: 'OPEN', fill: { qty: 65, avgPrice: 1 } }, { status: 'CLOSED', fill: { qty: 65, avgPrice: 1 } }]);
  assert.equal(basketToGreekLegs(b, 65).length, 1);
});

test('short straddle: delta ~0, gamma negative, theta positive', () => {
  const b = mk([{ side: 'S', option: 'CE' }, { side: 'S', option: 'PE' }]);
  const { net } = computeBasketGreeks(basketToGreekLegs(b, 1), { '2026-10-27': oc });
  assert.equal(net.delta, 0);
  assert.ok(net.gamma < 0);
  assert.ok(net.theta > 0);
});

test('far leg uses its own expiry chain; missing chain reported', () => {
  const b = mk([{ side: 'S' }, { side: 'B', expiry: '2026-11-03' }]);
  const { missing } = computeBasketGreeks(basketToGreekLegs(b, 1), { '2026-10-27': oc });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].expiry, '2026-11-03');
});

test('draft crude on Dhan applies mult', () => {
  assert.equal(basketToGreekLegs(mk([{ lots: 2 }]), 1, 100)[0].units, 200);
});
