import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelsFor, breached, validateExitSpec, fmtExitSpec } from './freshMoneyExits.ts';

test('long levels in % and points', () => {
  assert.deepEqual(levelsFor(100, 'long', { value: 30, unit: 'pct' }, { value: 20, unit: 'pct' }), { targetPx: 130, slPx: 80 });
  assert.deepEqual(levelsFor(100, 'long', { value: 25, unit: 'pts' }, { value: 15, unit: 'pts' }), { targetPx: 125, slPx: 85 });
});

test('short levels mirror; a 100% short SL is premium doubling', () => {
  assert.deepEqual(levelsFor(100, 'short', { value: 30, unit: 'pct' }, { value: 100, unit: 'pct' }), { targetPx: 70, slPx: 200 });
});

test('a level at or below zero is off', () => {
  assert.equal(levelsFor(100, 'long', null, { value: 100, unit: 'pct' }).slPx, null);
  assert.equal(levelsFor(100, 'long', null, { value: 120, unit: 'pts' }).slPx, null);
  assert.equal(levelsFor(100, 'short', { value: 150, unit: 'pts' }, null).targetPx, null);
});

test('prices are rounded to 2 dp', () => {
  assert.equal(levelsFor(101.35, 'long', { value: 33, unit: 'pct' }, null).targetPx, 134.8);
});

test('breach directions; SL wins a tie', () => {
  const L = { targetPx: 130, slPx: 80 };
  assert.equal(breached(130, 'long', L), 'target');
  assert.equal(breached(80, 'long', L), 'sl');
  assert.equal(breached(100, 'long', L), null);
  const S = { targetPx: 70, slPx: 200 };
  assert.equal(breached(70, 'short', S), 'target');
  assert.equal(breached(200, 'short', S), 'sl');
  assert.equal(breached(100, 'short', S), null);
  assert.equal(breached(100, 'long', { targetPx: 90, slPx: 110 }), 'sl');
  assert.equal(breached(100, 'long', { targetPx: null, slPx: null }), null);
});

test('validation bounds', () => {
  assert.equal(validateExitSpec(null), null);
  assert.equal(validateExitSpec(undefined), null);
  assert.equal(validateExitSpec({ value: null, unit: 'pct' }), null);
  assert.deepEqual(validateExitSpec({ value: 30, unit: 'pct' }), { value: 30, unit: 'pct' });
  assert.deepEqual(validateExitSpec({ value: 1000, unit: 'pct' }), { value: 1000, unit: 'pct' });
  assert.deepEqual(validateExitSpec({ value: 100000, unit: 'pts' }), { value: 100000, unit: 'pts' });
  for (const bad of [{ value: 0, unit: 'pct' }, { value: -5, unit: 'pts' }, { value: 'abc', unit: 'pct' },
    { value: 1001, unit: 'pct' }, { value: 1e9, unit: 'pts' }, { value: 5, unit: 'rupees' }, { value: Infinity, unit: 'pct' }, 'x']) {
    const r = validateExitSpec(bad);
    assert.ok(r !== null && 'error' in r, JSON.stringify(bad));
  }
});

test('format', () => {
  assert.equal(fmtExitSpec({ value: 30, unit: 'pct' }), '30%');
  assert.equal(fmtExitSpec({ value: 20, unit: 'pts' }), '20 pts');
  assert.equal(fmtExitSpec(null), 'off');
});
