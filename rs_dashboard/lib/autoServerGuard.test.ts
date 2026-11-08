import test from 'node:test';
import assert from 'node:assert/strict';
import { chartPrice, guards, ownHeldQty, runtimeKey, stepRow, stopHit, QUOTE_MAX_AGE_MS, type ServerGuardCfg } from './autoServerGuard.ts';
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

test('ownHeldQty: what the broker still shows of a row (0 = closed outside AUTO), capped at the row\'s own units; unknown keys cannot be told', () => {
  const r = row({ side: 'BUY', legs: [{ label: 'CRUDEOILM NOV FUT', key: 'CRUDEOILM19NOV26FUT', units: 20 }] });
  const mis = (net: number) => [{ key: 'CRUDEOILM19NOV26FUT', product: 'MIS', net }];
  assert.equal(ownHeldQty(r, mis(0), 'kotak'), 0, 'the broker is flat: the position was closed by hand / a square-off');
  assert.equal(ownHeldQty(r, [], 'kotak'), 0, 'no row at all is flat too');
  assert.equal(ownHeldQty(r, mis(20), 'kotak'), 20);
  assert.equal(ownHeldQty(r, mis(50), 'kotak'), 20, 'a bigger net (a manual lot on top) is capped at the row\'s own 20');
  assert.equal(ownHeldQty(r, mis(-20), 'kotak'), 0, 'a net in the other direction is not this row\'s');
  assert.equal(ownHeldQty(r, [{ key: 'CRUDEOILM19NOV26FUT', product: 'NRML', net: 20 }], 'kotak'), 0, 'another product is not this row\'s');
  assert.equal(ownHeldQty(row({ legs: [{ label: 'x', key: null, units: 20 }] }), mis(20), 'kotak'), null);
  assert.equal(ownHeldQty(row({ legs: [] }), mis(20), 'kotak'), null);
});

test('a pyramid add at the market price leaves the guard\'s MTM unchanged (average entry x total size)', async () => {
  const { withTranches, baseOf } = await import('./pnfAutoLedger.ts');
  const r0 = row({ lots: 1, unitsPerPoint: 10, legs: [{ label: 'F', key: '1', units: 10 }] });
  const before = stepRow(r0, cfg(), 8990, {}).mtm;                              // short from 9000, now 8990: +100
  const r1 = withTranches(r0, baseOf(r0), [{ id: 'a1', t: 1, barT: 1, lots: 1, units: [10], unitsPerPoint: 10, price: 8990, status: 'done' }]);
  assert.equal(before, 100);
  assert.ok(Math.abs(stepRow(r1, cfg(), 8990, {}).mtm - before) < 1e-6);
  assert.ok(Math.abs(stepRow(r1, cfg(), 8980, {}).mtm - 300) < 1e-6);         // 20 x 10 + 10 x 10
});

test('a row with a pyramid add on the wire or unresolved is still guarded (its confirmed lots are held)', () => {
  assert.equal(guards(cfg(), row({ state: 'adding' })), true);
  assert.equal(guards(cfg(), row({ state: 'unknownAdd' })), true);
});

test('stopHit: the row\'s own stop against the live price, a long at or below it, a short at or above it; none without a stop or a price', () => {
  assert.equal(stopHit(row({ side: 'BUY', stop: 100 }), 100), true);
  assert.equal(stopHit(row({ side: 'BUY', stop: 100 }), 100.5), false);
  assert.equal(stopHit(row({ side: 'SELL', stop: 100 }), 100), true);
  assert.equal(stopHit(row({ side: 'SELL', stop: 100 }), 99.5), false);
  assert.equal(stopHit(row({ side: 'BUY' }), 1), false);
  assert.equal(stopHit(row({ side: 'BUY', stop: 100 }), null), false);
});

test('an index chart\'s option row is guarded on the OPTION premium vs its entry premium; box levels are never applied to it', () => {
  // NIFTY index chart, bearish leg = BUY PE: 1 lot of 75 bought at 120. The mark passed is the PE premium, not the index.
  const ix = row({
    target: { kind: 'index', symbol: 'NIFTY', name: 'NIFTY' } as AutoRow['target'], side: 'SELL', lots: 1, unitsPerPoint: 75, entryPrice: 24000,
    traded: { target: { kind: 'options', symbol: 'NIFTY', name: 'NIFTY', expiry: '2026-11-10', strike: 24000, side: 'PE' } as AutoRow['target'], targetKey: 'pe', action: 'BUY', ids: 'NSE_FNO:1', entryPremium: 120 },
  });
  assert.equal(stepRow(ix, cfg({ levels: { stop: 1500 } }), 101, {}).reason, null);                    // -1425
  assert.match(stepRow(ix, cfg({ levels: { stop: 1500 } }), 100, {}).reason ?? '', /stop-loss/);       // -1500
  assert.match(stepRow(ix, cfg({ levels: { target: 750 } }), 130, {}).reason ?? '', /target/);         // +750
  const boxes = stepRow(ix, cfg({ levels: { stopBoxes: 1 }, boxPts: 5 }), 60, {});                     // -4500, a box level only
  assert.equal(boxes.reason, null, 'an index box is not a box of the option');
  assert.equal(boxes.boxesUnreadable, true, 'said, not silently enforced on the wrong unit');
});

test('a Log % chart guard counts its boxes as log steps from the row entry, the same as the page (fixed per trade, not per brick)', () => {
  // a SELL at 9,000, 1 % log grid, Rs 50 a point: 2 boxes of loss = 9,000 x (1.01^2 - 1) = 180.9 pts = Rs 9,045
  const c = cfg({ levels: { stopBoxes: 2 }, boxLogR: 1.01 });
  const lossPts = 9000 * (1.01 ** 2 - 1);
  assert.equal(stepRow(row(), c, 9000 + lossPts - 1, {}).reason, null);
  assert.match(stepRow(row(), c, 9000 + lossPts + 0.01, {}).reason ?? '', /\(2 boxes\)/);
  // the linear box (boxPts 5) is not used when the chart is Log %
  assert.equal(stepRow(row(), c, 9010, {}).reason, null);
});
