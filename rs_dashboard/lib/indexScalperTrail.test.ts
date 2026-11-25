import test from 'node:test';
import assert from 'node:assert/strict';
import { armTrail, parseTrailPoints, retrail, stepTrail, trailStillValid, validTrails, type TrailState } from './indexScalperTrail.ts';

const long = { id: 'L', securityId: '101', netQty: 75 };
const short = { id: 'S', securityId: '102', netQty: -75 };
const arm = (leg: typeof long, ltp: number, pts: number, tick = 0.05) => armTrail(leg, ltp, pts, tick, 'SIM', 'dhan', 1) as TrailState;

test('parseTrailPoints: points only, positive, on the tick', () => {
  assert.equal(parseTrailPoints('10', 0.05).pts, 10);
  assert.equal(parseTrailPoints(' 2.5 ', 0.05).pts, 2.5);
  assert.ok(parseTrailPoints('10%', 0.05).error);
  assert.ok(parseTrailPoints('0', 0.05).error);
  assert.ok(parseTrailPoints('1e3', 0.05).error);
  assert.ok(parseTrailPoints('0.03', 0.05).error);
  assert.ok(parseTrailPoints('2.53', 0.05).error);
  assert.equal(parseTrailPoints('3', 1).pts, 3);
  assert.ok(parseTrailPoints('2.5', 1).error);
});

test('armTrail: stop behind the live price, refused without one', () => {
  const t = arm(long, 200, 10);
  assert.equal(t.sl, 190); assert.equal(t.peak, 200); assert.equal(t.isLong, true);
  assert.equal(arm(short, 200, 10).sl, 210);
  assert.equal(typeof armTrail(long, null, 10, 0.05, 'SIM', 'dhan'), 'string');
  assert.equal(typeof armTrail(long, 5, 10, 0.05, 'SIM', 'dhan'), 'string');
});

test('long: the stop follows new highs and never loosens on a pullback', () => {
  let t = arm(long, 200, 10);
  t = stepTrail(t, 215, 0.05).state;
  assert.equal(t.peak, 215); assert.equal(t.sl, 205);
  const back = stepTrail(t, 208, 0.05);
  assert.equal(back.hit, false); assert.equal(back.state.sl, 205);
  const hit = stepTrail(back.state, 204.95, 0.05);
  assert.equal(hit.hit, true);
});

test('short: the stop follows new lows and fires on a rise through it', () => {
  let t = arm(short, 200, 10);
  t = stepTrail(t, 180, 0.05).state;
  assert.equal(t.sl, 190);
  assert.equal(stepTrail(t, 189, 0.05).hit, false);
  assert.equal(stepTrail(t, 190, 0.05).hit, true);
});

test('stop is snapped away from the price on the tick', () => {
  const t = stepTrail(arm(long, 100, 3.05), 103.13, 0.05).state;
  assert.equal(t.sl, 100.05);
  const f = stepTrail(arm(short, 7500, 5, 1), 7493.4, 1).state;
  assert.equal(f.sl, 7499);
});

test('an unchanged step returns the same object', () => {
  const t = arm(long, 200, 10);
  assert.equal(stepTrail(t, 199, 0.05).state, t);
});

test('retrail: tighter moves the stop up at once, wider never loosens it', () => {
  const t = stepTrail(arm(long, 200, 10), 220, 0.05).state; // sl 210
  assert.equal(retrail(t, 5, 0.05).sl, 215);
  const w = retrail(t, 20, 0.05);
  assert.equal(w.sl, 210); assert.equal(w.pts, 20);
  assert.equal(stepTrail(w, 235, 0.05).state.sl, 215);
});

test('trailStillValid: gone, flipped, other mode or broker', () => {
  const t = arm(long, 200, 10);
  assert.equal(trailStillValid(t, long, 'SIM', 'dhan'), true);
  assert.equal(trailStillValid(t, undefined, 'SIM', 'dhan'), false);
  assert.equal(trailStillValid(t, { netQty: -75 }, 'SIM', 'dhan'), false);
  assert.equal(trailStillValid(t, long, 'REAL', 'dhan'), false);
  const r = { ...t, mode: 'REAL' as const };
  assert.equal(trailStillValid(r, long, 'REAL', 'kotak'), false);
  assert.equal(trailStillValid(r, long, 'REAL', 'dhan'), true);
});

test('validTrails drops malformed rows', () => {
  const t = arm(long, 200, 10);
  assert.deepEqual(validTrails({ L: t, X: { legId: 'X' }, Y: null }), { L: t });
  assert.deepEqual(validTrails('nope'), {});
});
