import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHeldOp, emptyHeld, heldFor, parseHeld, pendingText, type HeldLedger, type HeldOp } from './pnfIndexHeld.ts';

const CE = { kind: 'options' as const, symbol: 'NIFTY', name: 'NIFTY', expiry: '2026-11-11', strike: 24100, side: 'CE' as const };
const PE = { ...CE, side: 'PE' as const, strike: 24000 };
const IK = 'index|NIFTY||||';
const base = { id: 'h1', chart: 1 as const, indexKey: IK, broker: 'dhan' as const, dir: 'bull' as const, traded: CE, action: 'BUY' as const, product: 'INTRADAY' as const, ids: 'NSE_FNO:40001' };

const ok = (led: HeldLedger, op: HeldOp) => {
  const r = applyHeldOp(led, op);
  assert.ok(r.ok, r.ok ? '' : r.error);
  return r.ledger;
};
const err = (led: HeldLedger, op: HeldOp) => {
  const r = applyHeldOp(led, op);
  assert.ok(!r.ok);
  return r.error;
};
const row = (led: HeldLedger) => heldFor(led, 1, 'dhan', IK);
/** An entry of 130 units, confirmed. */
const opened = () => ok(ok(emptyHeld(), { op: 'enter', row: base, units: 130, now: 100 }), { op: 'confirm', id: 'h1', now: 101 });

test('enter reserves the entry as pending before the order goes out; confirm books it as the chart\'s own units', () => {
  const led = ok(emptyHeld(), { op: 'enter', row: base, units: 130, now: 100 });
  assert.deepEqual([row(led)?.state, row(led)?.units, row(led)?.pending], ['sending', 0, 130]);
  assert.equal(pendingText(row(led)!), 'the entry');
  const o = opened();
  assert.deepEqual([row(o)?.state, row(o)?.units, row(o)?.pending], ['open', 130, 0]);
});

test('every add, reduce and close is reserved too: a second order is refused while one is in flight', () => {
  let led = ok(opened(), { op: 'begin', id: 'h1', delta: 65, now: 102 });
  assert.equal(pendingText(row(led)!), 'an add');
  assert.match(err(led, { op: 'begin', id: 'h1', delta: -65, now: 103 }), /still being sent/);
  led = ok(led, { op: 'confirm', id: 'h1', now: 103 });
  assert.equal(row(led)?.units, 195);
  led = ok(led, { op: 'begin', id: 'h1', delta: -65, now: 104 });
  assert.equal(pendingText(row(led)!), 'a reduce');
  led = ok(led, { op: 'confirm', id: 'h1', now: 105 });
  assert.equal(row(led)?.units, 130);
  led = ok(led, { op: 'begin', id: 'h1', delta: -130, now: 106 });
  assert.equal(pendingText(row(led)!), 'the close');
  assert.equal(row(ok(led, { op: 'confirm', id: 'h1', now: 107 })), null, 'own units at 0: the row is gone');
});

test('a reduce can never exceed the chart\'s own units (the broker net may include another page\'s lots)', () => {
  assert.match(err(opened(), { op: 'begin', id: 'h1', delta: -195, now: 102 }), /holds 130/);
});

test('void undoes only the pending order: a refused entry leaves nothing, a refused add keeps the held units', () => {
  assert.equal(ok(ok(emptyHeld(), { op: 'enter', row: base, units: 130, now: 1 }), { op: 'void', id: 'h1', now: 2 }).rows.length, 0);
  const led = ok(ok(opened(), { op: 'begin', id: 'h1', delta: 65, now: 102 }), { op: 'void', id: 'h1', now: 103 });
  assert.deepEqual([row(led)?.state, row(led)?.units, row(led)?.pending], ['open', 130, 0]);
});

test('an unclear order is unknown, blocks the chart, and is settled by the user: done books it, none drops it', () => {
  const led = ok(ok(opened(), { op: 'begin', id: 'h1', delta: 65, now: 102 }), { op: 'unknown', id: 'h1', note: 'timeout', now: 103 });
  assert.match(err(led, { op: 'begin', id: 'h1', delta: 65, now: 104 }), /UNKNOWN - settle it/);
  assert.match(err(led, { op: 'clear', id: 'h1', now: 104 }), /settle it first/);
  assert.equal(row(ok(led, { op: 'resolve', id: 'h1', as: 'done', now: 105 }))?.units, 195);
  assert.equal(row(ok(led, { op: 'resolve', id: 'h1', as: 'none', now: 105 }))?.units, 130);
  // an unknown entry settled as "nothing opened" leaves no row
  const e = ok(ok(emptyHeld(), { op: 'enter', row: base, units: 130, now: 1 }), { op: 'unknown', id: 'h1', now: 2 });
  assert.equal(ok(e, { op: 'resolve', id: 'h1', as: 'none', now: 3 }).rows.length, 0);
  assert.match(err(opened(), { op: 'resolve', id: 'h1', as: 'done', now: 3 }), /Nothing to settle/);
});

test('state never moves back: an idle row cannot be confirmed, voided or marked unknown', () => {
  const led = opened();
  assert.match(err(led, { op: 'confirm', id: 'h1', now: 102 }), /Cannot confirm/);
  assert.match(err(led, { op: 'void', id: 'h1', now: 102 }), /Cannot void/);
  assert.match(err(led, { op: 'unknown', id: 'h1', now: 102 }), /Cannot mark/);
});

test('one held option per chart + broker + index: the same leg (another tab) adds, another leg or product is refused', () => {
  const led = opened();
  const add = applyHeldOp(led, { op: 'enter', row: { ...base, id: 'h2' }, units: 65, now: 102 });
  assert.ok(add.ok && add.row?.id === 'h1' && add.row.pending === 65 && add.row.state === 'sending', 'reserved as an add on the existing row');
  assert.match(err(led, { op: 'enter', row: { ...base, id: 'h3', dir: 'bear', traded: PE }, units: 65, now: 102 }), /close it first/);
  assert.match(err(led, { op: 'enter', row: { ...base, id: 'h3', product: 'MARGIN' }, units: 65, now: 102 }), /holds it as MIS/);
  assert.equal(ok(led, { op: 'enter', row: { ...base, id: 'h4', chart: 2 }, units: 65, now: 102 }).rows.length, 2);
  assert.equal(ok(led, { op: 'enter', row: { ...base, id: 'h5', broker: 'kotak' }, units: 65, now: 102 }).rows.length, 2);
});

test('enter refuses a contract of another underlying, a straddle, a bad price id or a bad quantity', () => {
  const e = (row: object, units = 65) => err(emptyHeld(), { op: 'enter', row: { ...base, ...row } as typeof base, units, now: 1 });
  assert.match(e({ traded: { ...CE, symbol: 'BANKNIFTY' } }), /Invalid/);
  assert.match(e({ traded: { ...CE, side: 'STRADDLE' } }), /Invalid/);
  assert.match(e({ ids: 'NSE_EQ:1' }), /Invalid/);
  assert.match(e({ indexKey: 'futures|NIFTY|2026-11-24||' }), /Invalid/);
  assert.match(e({}, 0), /Invalid quantity/);
  assert.match(e({}, 1.5), /Invalid quantity/);
});

test('clear drops an idle row (the broker shows it flat)', () => {
  assert.equal(ok(opened(), { op: 'clear', id: 'h1', now: 200 }).rows.length, 0);
});

test('parseHeld drops rows that do not parse or whose state and quantities disagree', () => {
  const good = { ...base, units: 130, pending: 0, state: 'open', t: 5 };
  const led = parseHeld({ rev: 4, rows: [good, { ...good, id: 'bad', broker: 'x' }, { ...good, id: 'b2', pending: 65 }, { ...good, id: 'b3', state: 'sending' }, null] });
  assert.equal(led.rev, 4);
  assert.deepEqual(led.rows.map(r => r.id), ['h1']);
  assert.deepEqual(parseHeld('junk'), emptyHeld());
});
