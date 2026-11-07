import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaperTrades, labelOfTargetKey } from './pnfPaperBook.ts';
import type { AutoRow } from './pnfAutoLedger.ts';
import type { PnfExecutionMarker } from './straddlePnf.ts';

const DAY = '2026-11-03';
const at = (hh: number, mm: number, ss = 0) => (Date.UTC(2026, 10, 3, hh, mm, ss) - 5.5 * 3600_000) / 1000;
const fut = { kind: 'futures', symbol: 'CRUDEOILM', name: 'CRUDEOILM', expiry: '2026-11-19' } as const;
const KEY = 'futures|CRUDEOILM|2026-11-19||';
const mk = (id: string, t: number, action: 'BUY' | 'SELL', mode: 'PAPER' | 'REAL' = 'PAPER'): PnfExecutionMarker => ({ id, t, action, price: 9200, lots: 1, mode, estimate: false });
const row = (over: Partial<AutoRow>): AutoRow => ({
  id: 'r1', day: DAY, chart: 1, target: fut, targetKey: KEY, mode: 'PAPER', broker: 'dhan', side: 'SELL', lots: 2, unitsPerPoint: 20, legs: [],
  entryT: at(18, 57, 1), entryBarT: at(18, 56), entryPrice: 9210, state: 'open', ...over,
} as AutoRow);

test('labelOfTargetKey turns a stored marker key back into the chart label', () => {
  assert.equal(labelOfTargetKey(KEY), 'CRUDEOILM FUT 19 Nov 26');
  assert.equal(labelOfTargetKey('options|NIFTY|2026-11-24|23000|CE'), 'NIFTY 23000 CE 24 Nov 26');
});

test('trade-bar paper fills of every instrument are listed, REAL and other-day markers are not', () => {
  const rows = buildPaperTrades({
    [KEY]: [mk('a', at(10, 0), 'SELL'), mk('b', at(11, 0), 'BUY'), mk('c', at(12, 0), 'BUY', 'REAL'), mk('old', at(10, 0) - 86400, 'BUY')],
    'equity|RELIANCE||': [mk('d', at(9, 30), 'BUY')],
  }, [], DAY);
  assert.deepEqual(rows.map(r => r.id), [`m:${KEY}:b`, `m:${KEY}:a`, 'm:equity|RELIANCE||:d']);   // newest first
  assert.ok(rows.every(r => r.source === 'Trade bar'));
  assert.equal(rows[2].instrument, 'RELIANCE');
});

test('an index chart\'s arrow for a mapped option trade is not a paper trade; the option\'s own marker is', () => {
  const rows = buildPaperTrades({
    'index|NIFTY||||': [{ ...mk('ix', at(10, 0), 'BUY'), price: 25010, axis: true }],
    'options|NIFTY|2026-11-11|25000|PE': [{ ...mk('op', at(10, 0), 'SELL'), price: 90 }],
  }, [], DAY);
  assert.deepEqual(rows.map(r => [r.instrument, r.side, r.price]), [['NIFTY 25000 PE 11 Nov 26', 'SELL', 90]]);
});

test('an AUTO paper row gives an entry at its decision time and an exit at the exit time, with the reason and P&L', () => {
  const open = buildPaperTrades({}, [row({})], DAY);
  assert.deepEqual(open.map(r => [r.side, r.price, r.note]), [['SELL', 9210, 'C1 entry']]);
  const closed = buildPaperTrades({}, [row({ state: 'closed', exitT: at(19, 0), exitPrice: 9156, reason: 'mtm guard', pnl: 1080 })], DAY);
  assert.deepEqual(closed.map(r => [r.side, r.price]), [['BUY', 9156], ['SELL', 9210]]);
  assert.equal(closed[0].note, 'C1 exit (mtm guard) · +₹1,080');
  assert.ok(closed.every(r => r.source === 'AUTO' && r.lots === 2 && r.instrument === 'CRUDEOILM FUT 19 Nov 26'));
});

test('REAL AUTO rows, a refused entry, an entry still in flight and a user-resolved row add no exit', () => {
  assert.equal(buildPaperTrades({}, [row({ mode: 'REAL' })], DAY).length, 0);
  assert.equal(buildPaperTrades({}, [row({ state: 'closed', exitT: at(19, 0), exitPrice: 1, reason: 'refused' })], DAY).length, 0);
  assert.equal(buildPaperTrades({}, [row({ state: 'entering' })], DAY).length, 0);
  const resolved = buildPaperTrades({}, [row({ state: 'closed', exitT: at(19, 0), exitPrice: 9210, reason: 'resolved', pnl: 0 })], DAY);
  assert.deepEqual(resolved.map(r => r.note), ['C1 entry']);
});
