import { test } from 'node:test';
import assert from 'node:assert';
import {
  resolveTemplateLegs, reconcileLegFillDown, legPnl, basketTotalPnl, sortLegsForExit, findLegPosition,
  type MultiLegLeg,
} from './multiLegFocus.ts';
import type { StrategyTemplate } from './basketStrategies.ts';

test('resolveTemplateLegs resolves offsets to nearest listed strikes and seeds DRAFT status', () => {
  const template: StrategyTemplate = {
    key: 'short-strangle', name: 'Short Strangle',
    legs: [{ side: 'S', option: 'CE', offset: 4, ratio: 1 }, { side: 'S', option: 'PE', offset: -4, ratio: 2 }],
  };
  const strikes = [23600, 23800, 24000, 24200, 24400];
  const legs = resolveTemplateLegs(template, 24000, strikes, 200);
  assert.strictEqual(legs.length, 2);
  assert.strictEqual(legs[0].strike, 24400);
  assert.strictEqual(legs[0].option, 'CE');
  assert.strictEqual(legs[0].lots, 1);
  assert.strictEqual(legs[1].strike, 23600);
  assert.strictEqual(legs[1].lots, 2);
  assert.ok(legs.every(l => l.status === 'DRAFT' && l.type === 'MARKET' && !l.fill));
  assert.notStrictEqual(legs[0].id, legs[1].id);
});

test('reconcileLegFillDown shrinks a leg\'s fill qty to a smaller broker quantity', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 120 } };
  const out = reconcileLegFillDown(leg, 50);
  assert.strictEqual(out.fill?.qty, 50);
  assert.strictEqual(out.status, 'OPEN');
});

test('reconcileLegFillDown never grows a leg\'s fill qty upward from a larger broker quantity', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 120 } };
  const out = reconcileLegFillDown(leg, 150);
  assert.strictEqual(out.fill?.qty, 75);
});

test('reconcileLegFillDown leaves the leg alone when the broker quantity is unknown (null)', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 120 } };
  const out = reconcileLegFillDown(leg, null);
  assert.strictEqual(out.fill?.qty, 75);
});

test('reconcileLegFillDown marks the leg CLOSED once the broker quantity reaches zero', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 120 } };
  const out = reconcileLegFillDown(leg, 0);
  assert.strictEqual(out.fill?.qty, 0);
  assert.strictEqual(out.status, 'CLOSED');
});

test('legPnl: a filled SELL leg profits as LTP falls below the entry average', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 120 } };
  assert.strictEqual(legPnl(leg, 100), 1500); // (120-100) * 75
});

test('legPnl: a filled BUY leg profits as LTP rises above the entry average', () => {
  const leg: MultiLegLeg = { id: '1', side: 'B', option: 'PE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 80 } };
  assert.strictEqual(legPnl(leg, 100), 1500); // (100-80) * 75
});

test('legPnl returns 0 for a leg with no fill yet', () => {
  const leg: MultiLegLeg = { id: '1', side: 'B', option: 'PE', strike: 24000, lots: 1, type: 'MARKET', status: 'DRAFT' };
  assert.strictEqual(legPnl(leg, 100), 0);
});

test('basketTotalPnl sums legPnl across every leg using the caller-supplied LTP lookup', () => {
  const legs: MultiLegLeg[] = [
    { id: '1', side: 'S', option: 'CE', strike: 24400, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 40 } },
    { id: '2', side: 'S', option: 'PE', strike: 23600, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 35 } },
  ];
  const ltpFor = (l: MultiLegLeg) => (l.option === 'CE' ? 30 : 50);
  // CE: (40-30)*75=750, PE: (35-50)*75=-1125
  assert.strictEqual(basketTotalPnl(legs, ltpFor), 750 + -1125);
});

test('sortLegsForExit orders all SELL legs before all BUY legs, preserving relative order within each group', () => {
  const legs = [
    { side: 'B' as const, id: 1 }, { side: 'S' as const, id: 2 },
    { side: 'B' as const, id: 3 }, { side: 'S' as const, id: 4 },
  ];
  assert.deepStrictEqual(sortLegsForExit(legs).map(l => l.id), [2, 4, 1, 3]);
});

test('findLegPosition matches a Dhan leg by securityId, ignoring symbol', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', orderRef: { securityId: '999' } };
  const rows = [{ securityId: '999', tradingSymbol: 'NIFTY24721C24000', productType: 'MARGIN', netQty: -75 }];
  const match = findLegPosition('dhan', leg, rows);
  assert.strictEqual(match.kind, 'match');
});

test('findLegPosition matches a non-Dhan leg by symbol and product', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', orderRef: { symbol: 'NIFTY24721C24000' } };
  const rows = [{ tradingSymbol: 'NIFTY24721C24000', product: 'MIS', netQty: -75 }];
  const match = findLegPosition('zerodha', leg, rows);
  assert.strictEqual(match.kind, 'match');
});

test('findLegPosition reports flat for a leg with no orderRef yet', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'DRAFT' };
  assert.deepStrictEqual(findLegPosition('dhan', leg, []), { kind: 'flat' });
});
