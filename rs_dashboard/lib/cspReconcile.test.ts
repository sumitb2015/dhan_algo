import { test } from 'node:test';
import assert from 'node:assert';
import { reconcileCspRows, type CspBrokerRow } from './cspReconcile.ts';
import type { TrackedCsp } from './cspTracked.ts';

const row = (id: string, over: Partial<TrackedCsp> = {}): TrackedCsp => ({
  id, symbol: 'SBIN', strike: 760, expiry: '2026-10-27', qty: 750, lotSize: 750, entrySpot: 800,
  entryDate: '2026-10-01', avgPrice: 8.5, orderId: `o-${id}`, securityId: '9001', exchangeSegment: 'NSE_FNO',
  productType: 'MARGIN', status: 'OPEN', createdAt: 't', updatedAt: 't', ...over,
});
const brk = (id: string, over: Partial<CspBrokerRow> = {}): CspBrokerRow =>
  ({ id, found: true, netQty: -750, avgPrice: 9.1, productType: 'MARGIN', ...over });

test('never raises a row to the pooled broker qty, and keeps its own average', () => {
  const rows = [row('a')];
  const { changes } = reconcileCspRows(rows, [brk('a', { netQty: -1500, avgPrice: 10 })], 'now');
  assert.strictEqual(rows[0].qty, 750);
  assert.strictEqual(rows[0].avgPrice, 8.5);
  assert.ok(changes.some(c => c.includes('750 more than tracked rows')));
});

test('a lone row comes down to what the broker still holds', () => {
  const rows = [row('a')];
  reconcileCspRows(rows, [brk('a', { netQty: -375 })], 'now');
  assert.strictEqual(rows[0].qty, 375);
  assert.strictEqual(rows[0].reconcileNote, undefined);
});

test('two rows on one contract, broker holds less: flagged, not guessed', () => {
  const rows = [row('a'), row('b')];
  reconcileCspRows(rows, [brk('a', { netQty: -750 }), brk('b', { netQty: -750 })], 'now');
  assert.deepStrictEqual(rows.map(r => r.qty), [750, 750]);
  assert.ok(rows.every(r => r.reconcileNote?.includes('2 rows track 1500')));
});

test('an unconfirmed row settles from its own order, not the position', () => {
  const rows = [row('a', { avgPrice: 0, needsReconcile: true })];
  reconcileCspRows(rows, [brk('a', { netQty: -1500, avgPrice: 12, order: { status: 'TRADED', filledQty: 750, avgPrice: 8.75 } })], 'now');
  assert.strictEqual(rows[0].qty, 750);
  assert.strictEqual(rows[0].avgPrice, 8.75);
  assert.strictEqual(rows[0].needsReconcile, undefined);
});

test('a part-filled unconfirmed order brings qty down to what filled', () => {
  const rows = [row('a', { avgPrice: 0, needsReconcile: true })];
  reconcileCspRows(rows, [brk('a', { netQty: -375, order: { status: 'CANCELLED', filledQty: 375, avgPrice: 8.6 } })], 'now');
  assert.strictEqual(rows[0].qty, 375);
  assert.strictEqual(rows[0].avgPrice, 8.6);
});

test('a dead order with nothing filled is flagged for deletion, not deleted', () => {
  const rows = [row('a', { avgPrice: 0, needsReconcile: true })];
  reconcileCspRows(rows, [brk('a', { found: false, netQty: 0, order: { status: 'REJECTED', filledQty: 0, avgPrice: 0 } })], 'now');
  assert.strictEqual(rows.length, 1);
  assert.match(rows[0].reconcileNote ?? '', /REJECTED with nothing filled/);
});

test('the broker average prices a row with none only when it is the sole holder', () => {
  const sole = [row('a', { avgPrice: 0, needsReconcile: true, orderId: undefined })];
  reconcileCspRows(sole, [brk('a')], 'now');
  assert.strictEqual(sole[0].avgPrice, 9.1);
  assert.strictEqual(sole[0].needsReconcile, undefined);

  const shared = [row('a', { avgPrice: 0, needsReconcile: true, orderId: undefined })];
  reconcileCspRows(shared, [brk('a', { netQty: -1500 })], 'now');
  assert.strictEqual(shared[0].avgPrice, 0);
  assert.strictEqual(shared[0].needsReconcile, true);
  assert.match(shared[0].reconcileNote ?? '', /No entry price yet/);
});

test('broker flat: flagged, never auto-closed', () => {
  const rows = [row('a')];
  reconcileCspRows(rows, [brk('a', { found: false, netQty: 0 })], 'now');
  assert.strictEqual(rows[0].status, 'OPEN');
  assert.match(rows[0].reconcileNote ?? '', /no open short/);
});

test('a part-filled order still working is not settled, and its contract is left alone', () => {
  const rows = [row('a', { qty: 2250, avgPrice: 0, needsReconcile: true })];
  reconcileCspRows(rows, [brk('a', { netQty: -750, order: { status: 'PART_TRADED', filledQty: 750, avgPrice: 8.5 } })], 'now');
  assert.strictEqual(rows[0].qty, 2250);
  assert.strictEqual(rows[0].needsReconcile, true);
  assert.match(rows[0].reconcileNote ?? '', /still PART_TRADED \(750 of 2250 filled\)/);
  // Once it completes, the next reconcile settles it.
  reconcileCspRows(rows, [brk('a', { netQty: -2250, order: { status: 'TRADED', filledQty: 2250, avgPrice: 8.6 } })], 'now');
  assert.strictEqual(rows[0].qty, 2250);
  assert.strictEqual(rows[0].avgPrice, 8.6);
  assert.strictEqual(rows[0].needsReconcile, undefined);
  assert.strictEqual(rows[0].reconcileNote, undefined);
});
