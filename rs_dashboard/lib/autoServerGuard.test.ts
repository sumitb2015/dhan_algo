import test from 'node:test';
import assert from 'node:assert/strict';
import { chartPrice, guards, runtimeKey, stepRow, QUOTE_MAX_AGE_MS, type ServerGuardCfg } from './autoServerGuard.ts';
import type { AutoRow } from './pnfAutoLedger.ts';

const NOW = 1_000_000_000_000;
const row = (over: Partial<AutoRow> = {}): AutoRow => ({
  id: 'r1', day: '2026-11-03', chart: 1, target: { kind: 'futures', symbol: 'CRUDEOILM', name: 'CRUDEOILM', expiry: '2026-11-19' }, targetKey: 'k', mode: 'REAL', broker: 'dhan',
  side: 'SELL', lots: 5, unitsPerPoint: 50, legs: [], entryT: NOW / 1000, entryBarT: 1, entryPrice: 9000, state: 'open', ...over,
} as AutoRow);
const cfg = (over: Partial<ServerGuardCfg> = {}): ServerGuardCfg => ({ on: true, broker: 'dhan', mode: 'REAL', levels: {}, boxPts: 5, updatedMs: NOW - 5000, ...over });

test('a row is guarded only by an ON config of the same broker and mode, while it is open and REAL', () => {
  assert.equal(guards(cfg({ levels: { stop: 100 } }), row()), true);
  assert.equal(guards(cfg({ on: false }), row()), false);
  assert.equal(guards(cfg({ broker: 'kotak' }), row()), false);
  assert.equal(guards(cfg({ mode: 'PAPER' }), row()), false);
  assert.equal(guards(cfg(), row({ mode: 'PAPER' })), false);
  assert.equal(guards(cfg(), row({ state: 'exiting' })), false);
  assert.equal(guards(undefined, row()), false);
});

test('MTM is measured from the row\'s own entry price: a short loses when the price rises', () => {
  const r = stepRow(row(), cfg({ levels: { stop: 1000 } }), 9010, {});
  assert.equal(r.mtm, -500);                       // 10 pts x 50
  assert.equal(r.reason, null);
  assert.match(stepRow(row(), cfg({ levels: { stop: 1000 } }), 9020, {}).reason ?? '', /stop-loss/);   // -1000
});

test('box levels fold into rupees at box x rupees per point (5 pts x 50 = Rs 250 a box); the lower of box and rupee wins', () => {
  const c = cfg({ levels: { stopBoxes: 2, targetBoxes: 10 } });
  assert.equal(stepRow(row(), c, 9009, {}).reason, null);                                       // -450: under 2 boxes (Rs 500)
  assert.equal(stepRow(row(), c, 9010, {}).reason, 'MTM stop-loss ₹500 hit (2 boxes)');          // -500
  assert.match(stepRow(row(), c, 8950, {}).reason ?? '', /target/);                             // +2500 = 10 boxes
  assert.equal(stepRow(row(), cfg({ levels: { stopBoxes: 2 }, boxPts: null }), 9100, {}).reason, null, 'no box size: box levels cannot be read');
});

test('peak and a locked profit floor survive between readings (the runtime is handed back)', () => {
  const c = cfg({ levels: { lockAt: 500, lockKeep: 100 } });
  const a = stepRow(row(), c, 8990, {});                       // +500: lock engaged at 100
  assert.equal(a.reason, null);
  assert.deepEqual([a.runtime.peak, a.runtime.floor], [500, 100]);
  const b = stepRow(row(), c, 8998, a.runtime);                 // +100: back to the locked floor
  assert.match(b.reason ?? '', /Profit protected/);
});

test('chartPrice needs every leg to have ticked; a straddle is the sum of its legs', () => {
  const book = { 'NSE_FNO:1': { ltp: 100, changed_ms: NOW - 1000 }, 'NSE_FNO:2': { ltp: 80, changed_ms: NOW - 1000 }, 'NSE_FNO:3': { ltp: 50, changed_ms: null }, 'NSE_FNO:4': { ltp: 0, changed_ms: NOW - 1000 } };
  assert.equal(chartPrice([['NSE_FNO', '1'], ['NSE_FNO', '2']], book, NOW), 180);
  assert.equal(chartPrice([['NSE_FNO', '1'], ['NSE_FNO', '3']], book, NOW), null, 'a price that has not ticked is the hub replay');
  assert.equal(chartPrice([['NSE_FNO', '4']], book, NOW), null);
  assert.equal(chartPrice([['NSE_FNO', '9']], book, NOW), null);
  assert.equal(chartPrice([['NSE_FNO', '1']], undefined, NOW), null);
  assert.equal(chartPrice([['NSE_FNO', '1']], book, NOW + QUOTE_MAX_AGE_MS + 5000), null, 'a leg that has not ticked for 10 minutes is not a price');
});

test('a guard switched on AFTER the entry measures from the P&L the row had then; one on before it measures from the entry', () => {
  const late = cfg({ levels: { stop: 1000 }, updatedMs: NOW + 60_000 });          // switched on a minute after the entry
  const first = stepRow(row(), late, 9060, {});                                    // already -3000 from entry
  assert.equal(first.reason, null, 'no instant exit on a loss that was there before the guard');
  assert.equal(first.runtime.base, -3000);
  assert.equal(first.mtm, 0);
  assert.match(stepRow(row(), late, 9080, first.runtime).reason ?? '', /stop-loss/);   // a further -1000
  const early = stepRow(row(), cfg({ levels: { stop: 1000 }, updatedMs: NOW - 60_000 }), 9020, {});
  assert.equal(early.runtime.base, 0);
  assert.match(early.reason ?? '', /stop-loss/);                                   // -1000 from the entry
});

test('box levels with no box size are reported as unreadable (the watcher says so instead of silently not guarding)', () => {
  assert.equal(stepRow(row(), cfg({ levels: { stopBoxes: 2 }, boxPts: null }), 9100, {}).boxesUnreadable, true);
  assert.equal(stepRow(row(), cfg({ levels: { stopBoxes: 2 } }), 9100, {}).boxesUnreadable, false);
  assert.equal(stepRow(row(), cfg({ levels: { stop: 100 }, boxPts: null }), 9100, {}).boxesUnreadable, false);
});

test('runtime keys are scoped to a chart so switching it off drops only its own', () => {
  assert.equal(runtimeKey('renko', 1, 'r9'), 'renko:1:r9');
});
