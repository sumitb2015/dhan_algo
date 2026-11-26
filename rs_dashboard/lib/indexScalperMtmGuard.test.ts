import test from 'node:test';
import assert from 'node:assert/strict';
import { MTM_GUARD_DEFAULTS, mtmGuardTrip, parseRupees, readMtmGuard } from './indexScalperMtmGuard.ts';

const g = { on: true, target: 8000, stop: 8000 };

test('defaults: on, target 8000, stop 8000; saved values kept, bad ones replaced', () => {
  assert.deepEqual(readMtmGuard(null), { on: true, target: 8000, stop: 8000 });
  assert.deepEqual(MTM_GUARD_DEFAULTS, { on: true, target: 8000, stop: 8000 });
  assert.deepEqual(readMtmGuard('{"on":false,"target":5000,"stop":0}'), { on: false, target: 5000, stop: 0 });
  assert.deepEqual(readMtmGuard('{"on":"yes","target":-1,"stop":1.5}'), { on: true, target: 8000, stop: 8000 });
  assert.deepEqual(readMtmGuard('not json'), { on: true, target: 8000, stop: 8000 });
});

test('typed rupees: whole numbers only (commas / ₹ allowed), never a half-typed or scientific value', () => {
  assert.equal(parseRupees('8000'), 8000);
  assert.equal(parseRupees('₹ 8,000'), 8000);
  assert.equal(parseRupees('0'), 0);
  assert.equal(parseRupees(''), null);
  assert.equal(parseRupees('8e3'), null);
  assert.equal(parseRupees('-500'), null);
  assert.equal(parseRupees('80.5'), null);
  assert.equal(parseRupees('99999999'), null);
});

test('trips at the target / stop, inclusive', () => {
  assert.deepEqual(mtmGuardTrip(g, 8000, 0, 1), { kind: 'target', pnl: 8000, level: 8000 });
  assert.deepEqual(mtmGuardTrip(g, -8000, 0, 2), { kind: 'stop', pnl: -8000, level: 8000 });
  assert.equal(mtmGuardTrip(g, 7999, 0, 1), null);
  assert.equal(mtmGuardTrip(g, -7999, 0, 1), null);
});

test('never trips: off, unread book, partial total, no open position; 0 disables that side', () => {
  assert.equal(mtmGuardTrip({ ...g, on: false }, 9000, 0, 1), null);
  assert.equal(mtmGuardTrip(g, null, 0, 1), null);
  assert.equal(mtmGuardTrip(g, -9000, 1, 1), null);
  assert.equal(mtmGuardTrip(g, -9000, 0, 0), null);
  assert.equal(mtmGuardTrip({ ...g, target: 0 }, 50_000, 0, 1), null);
  assert.equal(mtmGuardTrip({ ...g, stop: 0 }, -50_000, 0, 1), null);
});
