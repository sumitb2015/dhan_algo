import test from 'node:test';
import assert from 'node:assert/strict';
import { chartOwnPosition } from './pnfChartPosition.ts';
import type { AutoRow } from './pnfAutoLedger.ts';
import type { LadderPosition } from './pnfLadderPosition.ts';

const TK = 'futures|CRUDEOILM|2026-11-19||';
const row = (over: Partial<AutoRow>): AutoRow => ({
  id: 'r', day: '2026-11-17', chart: 1, target: { kind: 'futures', symbol: 'CRUDEOILM', name: 'CRUDEOILM', expiry: '2026-11-19' }, targetKey: TK,
  mode: 'REAL', broker: 'kotak', side: 'BUY', lots: 3, unitsPerPoint: 30, legs: [{ label: 'CRUDEOILM FUT', key: 'X', units: 30 }],
  entryT: 1, entryBarT: 1, entryPrice: 8026, state: 'open', ...over,
} as AutoRow);
const long = (lots: number, avg: number | null = 8031.5, pnl: number | null = 1530): LadderPosition => ({ side: 'LONG', lots, avg, pnl });
const at = (chart: 1 | 2, rows: AutoRow[], contract: LadderPosition | null, extra: Partial<Parameters<typeof chartOwnPosition>[0]> = {}) =>
  chartOwnPosition({ chart, tk: TK, mode: 'REAL', broker: 'kotak', rows, contract, price: 8048, ...extra });

test('two AUTOs on one contract: each chart shows only its own row, never the broker total (3L + 3L = 6L)', () => {
  const rows = [row({ id: 'a', chart: 1, entryPrice: 8026 }), row({ id: 'b', chart: 2, entryPrice: 8041 })];
  assert.deepEqual(at(1, rows, long(6)), { side: 'LONG', lots: 3, avg: 8026, entryPnl: 0, pnl: (8048 - 8026) * 30 });
  assert.deepEqual(at(2, rows, long(6)), { side: 'LONG', lots: 3, avg: 8041, entryPnl: 0, pnl: (8048 - 8041) * 30 });
});

test("the other chart's AUTO position is not shown on a chart without one", () => {
  assert.equal(at(2, [row({ chart: 1 })], long(3)), null);
});

test('lots beyond every AUTO row are hand lots: shown on a chart without AUTO, average and P&L unknown', () => {
  assert.deepEqual(at(2, [row({ chart: 1 })], long(5)), { side: 'LONG', lots: 2, avg: null, pnl: null });
});

test('no AUTO row on the contract: the contract position as it is (hand trades on both charts)', () => {
  assert.deepEqual(at(2, [], long(4)), long(4));
  assert.deepEqual(at(2, [row({ chart: 1, targetKey: 'other' })], long(4)), long(4));       // AUTO on another contract
  assert.deepEqual(at(2, [row({ chart: 1, broker: 'dhan' })], long(4)), long(4));          // AUTO on another broker's account
  assert.deepEqual(at(2, [row({ chart: 1, state: 'closed' })], long(4)), long(4));         // a closed row
});

test('a book that lags an AUTO fill never reads as hand lots or as the other side', () => {
  assert.equal(at(2, [row({ chart: 1 })], null), null);
  assert.equal(at(2, [row({ chart: 1, lots: 3 })], long(2)), null);
  assert.equal(at(1, [row({ chart: 1, state: 'entering' })], long(3)), null);              // own entry not confirmed yet
});

test('a pending pyramid add is AUTO lots, not hand lots', () => {
  const r = row({ chart: 1, state: 'adding', adds: [{ id: 'x', t: 1, barT: 1, lots: 1, units: [30], unitsPerPoint: 30, price: 8040, status: 'pending' }] });
  assert.equal(at(2, [r], long(4)), null);
  assert.equal(at(1, [r], long(4))?.lots, 3);                                              // its own confirmed lots
});

test('an exiting row is still the chart own position; no price = P&L unknown', () => {
  assert.equal(at(1, [row({ chart: 1, state: 'exiting' })], long(3))?.lots, 3);
  assert.equal(at(1, [row({ chart: 1 })], long(3), { price: null })?.pnl, null);
});

test('a short row: SHORT side and P&L the right way round', () => {
  const p = at(1, [row({ chart: 1, side: 'SELL', entryPrice: 8060 })], { side: 'SHORT', lots: 3, avg: 8060, pnl: 0 });
  assert.deepEqual(p, { side: 'SHORT', lots: 3, avg: 8060, entryPnl: 0, pnl: (8060 - 8048) * 30 });
});

test('PAPER: AUTO rows are not in the paper book, so the book is all hand lots', () => {
  const rows = [row({ chart: 1, mode: 'PAPER' })];
  assert.deepEqual(at(2, rows, long(2), { mode: 'PAPER' }), long(2));
  assert.equal(at(1, rows, null, { mode: 'PAPER' })?.lots, 3);
});
