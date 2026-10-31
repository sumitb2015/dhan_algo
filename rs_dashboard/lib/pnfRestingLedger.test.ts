import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_RESTING, STALE_PENDING_S, applyRestingOp, needsResolve, rollDay, trimRows, type RestingLedger, type RestingOp,
} from './pnfRestingLedger.ts';

const fut = { kind: 'futures', symbol: 'NIFTY', name: 'NIFTY', expiry: '2026-11-24' } as const;
const row = (over: Record<string, unknown> = {}) => ({
  id: 'o1', day: '2026-10-30', chart: 1 as const, target: fut, broker: 'dhan', mode: 'PAPER' as const, venue: 'page' as const,
  side: 'BUY' as const, kind: 'limit' as const, level: 100, price: 100, lots: 1, product: 'INTRADAY', unitsPerPoint: 65, t: 1000, ...over,
});
function run(l: RestingLedger, op: RestingOp): RestingLedger {
  const r = applyRestingOp(l, op);
  assert.ok(r.ok, r.ok ? '' : r.error);
  return r.ledger;
}
const refused = (l: RestingLedger, op: RestingOp) => assert.ok(!applyRestingOp(l, op).ok, JSON.stringify(op));

test('PAPER: created working, fills from working, cannot fill twice', () => {
  let l = run(EMPTY_RESTING, { op: 'create', row: row() });
  assert.equal(l.rows[0].state, 'working');
  l = run(l, { op: 'fill', id: 'o1', price: 99.95, t: 2000 });
  assert.equal(l.rows[0].fillPrice, 99.95);
  refused(l, { op: 'fill', id: 'o1', price: 99, t: 3000 });
  refused(l, { op: 'cancel', id: 'o1', t: 3000 });
});

test('REAL broker order: reserved as sending, then working with its broker id; a rejection or unknown never becomes working', () => {
  const l = run(EMPTY_RESTING, { op: 'create', row: row({ mode: 'REAL', venue: 'broker' }) });
  assert.equal(l.rows[0].state, 'sending');
  refused(l, { op: 'fill', id: 'o1', price: 100, t: 2 });                 // nothing is at the broker yet
  const placed = run(l, { op: 'placed', id: 'o1', brokerOrderId: 'B1' });
  assert.equal(placed.rows[0].state, 'working');
  assert.equal(placed.rows[0].brokerOrderId, 'B1');
  assert.equal(run(l, { op: 'reject', id: 'o1', note: 'margin' }).rows[0].state, 'rejected');
  const unk = run(l, { op: 'markUnknown', id: 'o1', note: 'no reply' });
  refused(unk, { op: 'placed', id: 'o1', brokerOrderId: 'B1' });
  assert.equal(run(unk, { op: 'resolve', id: 'o1', as: 'cancelled', t: 5 }).rows[0].state, 'cancelled');
});

test('REAL page level (straddle): fires once before its MARKET orders, fills only after firing', () => {
  let l = run(EMPTY_RESTING, { op: 'create', row: row({ mode: 'REAL', venue: 'page' }) });
  refused(l, { op: 'fill', id: 'o1', price: 100, t: 2 });                 // must be reserved first
  l = run(l, { op: 'fire', id: 'o1', t: 2 });
  refused(l, { op: 'fire', id: 'o1', t: 3 });                             // never twice
  refused(l, { op: 'cancel', id: 'o1', t: 3 });                           // on the wire: cannot cancel
  assert.equal(run(l, { op: 'fill', id: 'o1', price: 100.2, t: 3 }).rows[0].state, 'filled');
});

test('modify keeps a working order working; a stop needs its trigger; trigger is a page-only flag', () => {
  let l = run(EMPTY_RESTING, { op: 'create', row: row({ kind: 'stop', trigger: 102, price: 104.05, level: 102 }) });
  refused(l, { op: 'modify', id: 'o1', level: 103, price: 105 });
  l = run(l, { op: 'modify', id: 'o1', level: 103, price: 105.1, trigger: 103 });
  assert.equal(l.rows[0].trigger, 103);
  l = run(l, { op: 'trigger', id: 'o1' });
  assert.equal(l.rows[0].triggered, true);
});

test('validation and the per-chart cap', () => {
  refused(EMPTY_RESTING, { op: 'create', row: row({ target: { kind: 'index', symbol: 'NIFTY', name: 'Nifty 50' } }) });
  refused(EMPTY_RESTING, { op: 'create', row: row({ mode: 'PAPER', venue: 'broker' }) });
  refused(EMPTY_RESTING, { op: 'create', row: row({ kind: 'stop' }) });          // no trigger
  refused(EMPTY_RESTING, { op: 'create', row: row({ lots: 0 }) });
});

test('there is no limit on working orders per chart; a full file drops only finished rows, never a working one', () => {
  let l = EMPTY_RESTING;
  for (let i = 0; i < 40; i++) l = run(l, { op: 'create', row: row({ id: `o${i}`, level: 100 + i, price: 100 + i }) });
  assert.equal(l.rows.filter(r => r.state === 'working').length, 40);
  // 520 rows, the oldest 30 finished: trimming to 500 removes exactly the 20 oldest finished rows and keeps every working one
  const rows = Array.from({ length: 520 }, (_, i) => ({ ...(row({ id: `r${i}` }) as object), state: i < 30 ? 'cancelled' : 'working' })) as unknown as Parameters<typeof trimRows>[0];
  const kept = trimRows(rows);
  assert.equal(kept.length, 500);
  assert.equal(kept.filter(r => r.state === 'working').length, 490);
  assert.equal(kept[0].id, 'r20');
});

test('equity is sized in shares: more than 20 is fine there, not on a future', () => {
  const eq = { kind: 'equity', symbol: 'RELIANCE', name: 'RELIANCE' } as const;
  assert.ok(applyRestingOp(EMPTY_RESTING, { op: 'create', row: row({ target: eq, lots: 150 }) }).ok);
  refused(EMPTY_RESTING, { op: 'create', row: row({ target: eq, lots: 501 }) });
  refused(EMPTY_RESTING, { op: 'create', row: row({ lots: 21 }) });
});

test('rollDay closes every open order from an earlier day and leaves today and closed rows alone', () => {
  let l = run(EMPTY_RESTING, { op: 'create', row: row({ id: 'old', day: '2026-10-29' }) });
  l = run(l, { op: 'create', row: row({ id: 'oldReal', day: '2026-10-29', mode: 'REAL', venue: 'broker' }) });
  l = run(l, { op: 'create', row: row({ id: 'oldDone', day: '2026-10-29' }) });
  l = run(l, { op: 'cancel', id: 'oldDone', t: 1 });
  l = run(l, { op: 'create', row: row({ id: 'today' }) });
  const rolled = rollDay(l, '2026-10-30');
  const st = Object.fromEntries(rolled.rows.map(r => [r.id, r.state]));
  assert.deepEqual(st, { old: 'cancelled', oldReal: 'cancelled', oldDone: 'cancelled', today: 'working' });
  assert.match(rolled.rows[0].note ?? '', /expired/);
  assert.equal(rolled.rev, l.rev + 1);
  assert.equal(rollDay(rolled, '2026-10-30'), rolled, 'nothing to roll: the same ledger');
});

test('needsResolve: unknown always; a sending / firing reservation only once it is stale', () => {
  const l = run(EMPTY_RESTING, { op: 'create', row: row({ mode: 'REAL', venue: 'broker', t: 1000 }) });
  assert.equal(needsResolve(l.rows[0], 1000 + 5), false, 'still on the wire');
  assert.equal(needsResolve(l.rows[0], 1000 + STALE_PENDING_S + 1), true);
  assert.equal(needsResolve(run(l, { op: 'markUnknown', id: 'o1', note: 'x' }).rows[0], 1001), true);
  assert.equal(needsResolve(run(l, { op: 'placed', id: 'o1', brokerOrderId: 'B' }).rows[0], 99999), false, 'working is cancelled, not resolved');
});

test('a broker order cancelled after a part fill books the filled lots (and their rupees per point), not nothing', () => {
  let l = run(EMPTY_RESTING, { op: 'create', row: row({ mode: 'REAL', venue: 'broker', lots: 10, unitsPerPoint: 650, legUnits: [650] }) });
  l = run(l, { op: 'placed', id: 'o1', brokerOrderId: 'B1' });
  const f = run(l, { op: 'fill', id: 'o1', price: 99.5, t: 9, lots: 4 }).rows[0];
  assert.equal(f.state, 'filled');
  assert.equal(f.lots, 4);
  assert.equal(f.unitsPerPoint, 260);
  assert.deepEqual(f.legUnits, [260]);
  // a lots value that is not a smaller whole number leaves the order whole
  assert.equal(run(l, { op: 'fill', id: 'o1', price: 99.5, t: 9, lots: 10 }).rows[0].lots, 10);
  assert.equal(run(l, { op: 'fill', id: 'o1', price: 99.5, t: 9, lots: 2.5 }).rows[0].lots, 10);
});

test('lots: a working entry order is resized with its paper value scaled; a bracket exit, a filled order, 0 and an over-cap size are refused', () => {
  let l = run(EMPTY_RESTING, { op: 'create', row: row({ unitsPerPoint: 65, legUnits: [65, 130] }) });
  l = run(l, { op: 'lots', id: 'o1', lots: 3 });
  assert.equal(l.rows[0].lots, 3);
  assert.equal(l.rows[0].unitsPerPoint, 195);
  assert.deepEqual(l.rows[0].legUnits, [195, 390]);
  refused(l, { op: 'lots', id: 'o1', lots: 0 });
  refused(l, { op: 'lots', id: 'o1', lots: 21 });                       // futures cap is 20 lots
  refused(l, { op: 'lots', id: 'o1', lots: 1.5 });
  const exit = run(EMPTY_RESTING, { op: 'create', row: row({ id: 'x1', group: 'g1', role: 'sl' }) });
  refused(exit, { op: 'lots', id: 'x1', lots: 2 });
  const filled = run(run(EMPTY_RESTING, { op: 'create', row: row() }), { op: 'fill', id: 'o1', price: 99, t: 2000 });
  refused(filled, { op: 'lots', id: 'o1', lots: 2 });
});
