import test from 'node:test';
import assert from 'node:assert/strict';
import { bracketsOnChart, legOnChart, nearestStrike, orderOnChart, resolveSource, sourceLabel } from './indexScalperChartSource.ts';
import type { ScalperLeg } from './indexScalperPositions.ts';

const ids = new Map([
  [25500, { ceId: '101', peId: '201' }],
  [25550, { ceId: '102', peId: '202' }],
  [25600, { ceId: '103', peId: '203' }],
]);
const kotak = new Map([[25550, { ceSymbol: 'NIFTY2612025550CE', peSymbol: 'NIFTY2612025550PE' }]]);
const leg = (o: Partial<ScalperLeg> = {}): ScalperLeg => ({
  id: '102', securityId: '102', product: '', symbol: 'NIFTY-Dec2026-25550-CE', strike: 25550, type: 'CE', netQty: 65, avg: 120, ltp: 125, sim: true, ...o,
});

test('nearest strike to spot; null without spot (never a guess) or without strikes', () => {
  assert.equal(nearestStrike([25500, 25550, 25600], 25561), 25550);
  assert.equal(nearestStrike([25500, 25550, 25600], null), null);
  assert.equal(nearestStrike([25500, 25550, 25600], 0), null);
  assert.equal(nearestStrike([], 25561), null);
});

test('resolve: listed strike keeps its ids, a missing strike falls back to ATM, ticks per instrument', () => {
  const r = resolveSource({ kind: 'option', type: 'PE', strike: 25600 }, 'NIFTY', ids, 25550, kotak);
  assert.deepEqual(r, { kind: 'option', type: 'PE', strike: 25600, dhanId: '203', kotakSymbol: null, tick: 0.05 });
  const atm = resolveSource({ kind: 'option', type: 'CE', strike: 24000 }, 'NIFTY', ids, 25540, kotak);
  assert.equal(atm.strike, 25550);
  assert.equal(atm.dhanId, '102');
  assert.equal(atm.kotakSymbol, 'NIFTY2612025550CE');
  // ATM requested (strike 0) before any spot: unresolved, no contract (the pane waits rather than pinning a guess)
  const early = resolveSource({ kind: 'option', type: 'CE', strike: 0 }, 'NIFTY', ids, null);
  assert.equal(early.strike, null);
  assert.equal(early.dhanId, null);
  assert.equal(resolveSource({ kind: 'option', type: 'CE', strike: 6100 }, 'CRUDEOILM', new Map(), 6100).tick, 0.1);
  assert.equal(resolveSource({ kind: 'option', type: 'CE', strike: 6100 }, 'CRUDEOILM', new Map(), 6100).dhanId, null);
  assert.equal(resolveSource({ kind: 'underlying' }, 'CRUDEOILM', ids, 6100).tick, 1);
});

test('legs: underlying pane shows all, option pane only its contract (Dhan id, SIM id or Kotak symbol)', () => {
  const und = resolveSource({ kind: 'underlying' }, 'NIFTY', ids, 25550);
  const ce = resolveSource({ kind: 'option', type: 'CE', strike: 25550 }, 'NIFTY', ids, 25550, kotak);
  assert.equal(legOnChart(leg(), und), true);
  assert.equal(legOnChart(leg(), ce), true);
  assert.equal(legOnChart(leg({ securityId: '202', type: 'PE' }), ce), false);
  assert.equal(legOnChart(leg({ securityId: 'NIFTY2612025550CE', sim: false }), ce), true);
  assert.equal(legOnChart(leg({ type: 'FUT', securityId: '999' }), ce), false);
});

test('TP / SL: option legs only on their premium chart, futures only on the underlying', () => {
  const und = resolveSource({ kind: 'underlying' }, 'NIFTY', ids, 25550);
  const ce = resolveSource({ kind: 'option', type: 'CE', strike: 25550 }, 'NIFTY', ids, 25550);
  assert.equal(bracketsOnChart(leg(), und), false);
  assert.equal(bracketsOnChart(leg(), ce), true);
  assert.equal(bracketsOnChart(leg({ type: 'FUT', securityId: '9' }), und), true);
  assert.equal(bracketsOnChart(leg({ type: 'FUT', securityId: '9' }), ce), false);
});

test('orders: option orders on their own chart only, non-option orders on the underlying', () => {
  const und = resolveSource({ kind: 'underlying' }, 'NIFTY', ids, 25550);
  const ce = resolveSource({ kind: 'option', type: 'CE', strike: 25550 }, 'NIFTY', ids, 25550, kotak);
  assert.equal(orderOnChart({ securityId: '102', isOption: true }, ce), true);
  assert.equal(orderOnChart({ securityId: 'NIFTY2612025550CE', isOption: true }, ce), true);
  assert.equal(orderOnChart({ securityId: '103', isOption: true }, ce), false);
  assert.equal(orderOnChart({ securityId: '', isOption: true }, ce), false);
  assert.equal(orderOnChart({ securityId: '102', isOption: true }, und), false);
  assert.equal(orderOnChart({ securityId: '9', isOption: false }, und), true);
});

test('labels', () => {
  assert.equal(sourceLabel('NIFTY', resolveSource({ kind: 'underlying' }, 'NIFTY', ids, 1)), 'NIFTY IDX');
  assert.equal(sourceLabel('NIFTY', resolveSource({ kind: 'option', type: 'PE', strike: 25500 }, 'NIFTY', ids, 1)), 'NIFTY 25500 PE');
});

test('NIFTY FUT pane: resolves to the future (its Dhan id, futures tick), chart only: no legs, brackets or orders', () => {
  const r = resolveSource({ kind: 'future' }, 'NIFTY', new Map(), 25900, null, '62329');
  assert.deepEqual([r.kind, r.dhanId, r.tick], ['future', '62329', 0.05]);
  assert.equal(sourceLabel('NIFTY', r), 'NIFTY FUT');
  const leg = { id: 'a', securityId: '62329', product: 'INTRADAY', symbol: 'NIFTY-Dec2026-FUT', strike: 0, type: 'FUT' as const, netQty: 75, avg: 1, ltp: 1, sim: false };
  assert.equal(legOnChart(leg, r), false);
  assert.equal(bracketsOnChart(leg, r), false);
  assert.equal(orderOnChart({ securityId: '62329', isOption: false }, r), false);
  // without the lookup's id yet: no contract (the pane waits), never the index
  assert.equal(resolveSource({ kind: 'future' }, 'NIFTY', new Map(), 25900).dhanId, null);
  // CRUDEOILM: its underlying pane already is the future, so a saved 'future' source shows that
  assert.equal(resolveSource({ kind: 'future' }, 'CRUDEOILM', new Map(), 7500).kind, 'underlying');
});
