import { test } from 'node:test';
import assert from 'node:assert';
import { basketToGreekLegs, computeBasketGreeks } from './multiLegGreeks.ts';
import type { MultiLegBasket } from './multiLegFocus.ts';

const mk = (legs: Partial<MultiLegBasket['legs'][number]>[]): MultiLegBasket => ({
  id: 'b', underlying: 'NIFTY', expiry: '2026-10-27', broker: 'dhan', createdAt: '', updatedAt: '',
  legs: legs.map((l, i) => ({ id: `l${i}`, side: 'S', option: 'CE', strike: 23000, lots: 1, type: 'MARKET', status: 'DRAFT', ...l })) as MultiLegBasket['legs'],
});
test('draft uses lots x lotSize', () => {
  const g = basketToGreekLegs(mk([{ lots: 2 }]), 65);
  assert.equal(g[0].units, 130);
});

test('placed basket: fill qty, closed legs skipped', () => {
  const b = mk([{ status: 'OPEN', fill: { qty: 65, avgPrice: 1 } }, { status: 'CLOSED', fill: { qty: 65, avgPrice: 1 } }]);
  assert.equal(basketToGreekLegs(b, 65).length, 1);
});

const EXP = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const FAR = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);

test('short straddle: gamma negative, theta positive, IV solved from the live mark', () => {
  const b = mk([{ side: 'S', option: 'CE', expiry: EXP }, { side: 'S', option: 'PE', expiry: EXP }]);
  const g = computeBasketGreeks(basketToGreekLegs(b, 65), { spot: 23000, markOf: () => 350 });
  assert.ok(g.net.gamma < 0);
  assert.ok(g.net.theta > 0);
  assert.ok(g.net.vega < 0);
  assert.equal(g.assumed.length, 0);
  assert.ok(g.legs.every(l => l.ivSource === 'mark' && l.iv! > 0));
});

test('a leg with no live price falls back to its chain IV, then to an assumed IV, and says which', () => {
  const b = mk([{ side: 'S', expiry: EXP }, { side: 'B', expiry: FAR }]);
  const legs = basketToGreekLegs(b, 65);
  const chain = computeBasketGreeks(legs, { spot: 23000, markOf: () => undefined, chainIvOf: () => 0.14 });
  assert.ok(chain.legs.every(l => l.ivSource === 'chain'));
  assert.equal(chain.assumed.length, 0);
  const assumed = computeBasketGreeks(legs, { spot: 23000, markOf: () => undefined });
  assert.equal(assumed.assumed.length, 2);
});

test('each leg is priced at its own expiry (a longer-dated long call has more vega than the short near call it hedges)', () => {
  const b = mk([{ side: 'S', expiry: EXP }, { side: 'B', expiry: FAR }]);
  const g = computeBasketGreeks(basketToGreekLegs(b, 65), { spot: 23000, markOf: () => 300 });
  const near = g.legs.find(l => l.side === 'S')!;
  const far = g.legs.find(l => l.side === 'B')!;
  assert.ok(far.vega! > near.vega!);
});

test('the same Greeks the payoff chart header shows (one library, one number)', async () => {
  const { buildPayoffModel } = await import('./optionsPayoff.ts');
  const b = mk([{ side: 'S', option: 'CE', expiry: EXP }, { side: 'S', option: 'PE', expiry: EXP }]);
  const gl = basketToGreekLegs(b, 65);
  const now = Date.now();
  const g = computeBasketGreeks(gl, { spot: 23000, markOf: () => 350, now });
  const m = buildPayoffModel({ spot: 23000, now, legs: gl.map(l => ({ type: l.option, strike: l.strike, expiry: l.expiry, qty: l.side === 'S' ? -l.units : l.units, entryPrice: 350, mark: 350 })) })!;
  assert.ok(Math.abs(g.net.delta - m.netGreeks.delta) < 1e-9 && Math.abs(g.net.theta - m.netGreeks.theta) < 1e-9);
});

test('draft crude on Dhan applies mult', () => {
  assert.equal(basketToGreekLegs(mk([{ lots: 2 }]), 1, 100)[0].units, 200);
});
