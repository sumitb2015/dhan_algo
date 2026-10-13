import test from 'node:test';
import assert from 'node:assert/strict';
import { rollSizeWarning } from './multiLegRollSize.ts';
import type { MultiLegLeg } from './multiLegFocus.ts';

const NOW = Date.parse('2026-10-13T06:00:00Z');
const stopped = (o: Partial<MultiLegLeg> = {}) =>
  ({ id: 'x', side: 'S', option: 'CE', status: 'CLOSED', lots: 3, fill: { qty: 0, avgPrice: 259 }, closedFill: { qty: 195, exitPrice: 352 }, closedAt: NOW - 3_600_000, ...o }) as unknown as MultiLegLeg;
const draft = (lots: number, o: object = {}) => ({ side: 'S' as const, option: 'CE' as const, lots, ...o });

test('selling more lots than the stopped short warns, equal or fewer does not', () => {
  const b = { legs: [stopped()] };
  const w = rollSizeWarning(b, draft(8), 65, NOW);
  assert.equal(w?.stoppedLots, 3);
  assert.match(w!.message, /3-lot short CE/);
  assert.equal(rollSizeWarning(b, draft(3), 65, NOW), null);
  assert.equal(rollSizeWarning(b, draft(1), 65, NOW), null);
});

test('uses the largest stopped leg, and the ledger qty not the leg lots field', () => {
  const b = { legs: [stopped({ lots: 1, closedFill: { qty: 130, exitPrice: 300 } }), stopped({ closedFill: { qty: 325, exitPrice: 300 } })] };
  assert.equal(rollSizeWarning(b, draft(6), 65, NOW)?.stoppedLots, 5);
});

test('ignores buys, the other option side, other days, profitable and unpriced exits', () => {
  const ok = { legs: [stopped()] };
  assert.equal(rollSizeWarning(ok, draft(8, { side: 'B' }), 65, NOW), null);
  assert.equal(rollSizeWarning(ok, draft(8, { option: 'PE' }), 65, NOW), null);
  assert.equal(rollSizeWarning({ legs: [stopped({ closedAt: NOW - 2 * 86_400_000 })] }, draft(8), 65, NOW), null);
  assert.equal(rollSizeWarning({ legs: [stopped({ closedFill: { qty: 195, exitPrice: 200 } })] }, draft(8), 65, NOW), null);
  assert.equal(rollSizeWarning({ legs: [stopped({ closedFill: undefined })] }, draft(8), 65, NOW), null);
  assert.equal(rollSizeWarning({ legs: [stopped({ closedAt: undefined })] }, draft(8), 65, NOW), null);
  assert.equal(rollSizeWarning({ legs: [stopped({ side: 'B' })] }, draft(8), 65, NOW), null);
  assert.equal(rollSizeWarning({ legs: [stopped({ status: 'OPEN' })] }, draft(8), 65, NOW), null);
});

test('estimated exits are not proof of a loss; a qty that is not a whole number of lots falls back to leg lots', () => {
  assert.equal(rollSizeWarning({ legs: [stopped({ closedFill: { qty: 195, exitPrice: 352, estimated: true } })] }, draft(8), 65, NOW), null);
  assert.equal(rollSizeWarning({ legs: [stopped({ lots: 2, closedFill: { qty: 200, exitPrice: 352 } })] }, draft(8), 65, NOW)?.stoppedLots, 2);
});
