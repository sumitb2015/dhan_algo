import { test } from 'node:test';
import assert from 'node:assert';
import { snapToTick, exitLimitTick } from './multiLegExitOrder.ts';

test('snapToTick rounds to the grid without float noise', () => {
  assert.strictEqual(snapToTick(100.17, 0.05), 100.15);
  assert.strictEqual(snapToTick(100.18, 0.05), 100.2);
  assert.strictEqual(snapToTick(5432.4, 1), 5432);
  assert.strictEqual(snapToTick(12.34, 0.5), 12.5);
});

test('snapToTick returns 0 for an unusable price or tick', () => {
  assert.strictEqual(snapToTick(0, 0.05), 0);
  assert.strictEqual(snapToTick(-3, 0.05), 0);
  assert.strictEqual(snapToTick(10, 0), 0);
  assert.strictEqual(snapToTick(NaN, 0.05), 0);
});

test('a price below half a tick snaps to 0 (the caller then refuses)', () => {
  assert.strictEqual(snapToTick(0.02, 0.05), 0);
});

test('exitLimitTick prefers the master tick, defaults NSE/BSE to 0.05, refuses unknown MCX', () => {
  assert.strictEqual(exitLimitTick({ masterTick: 1, isMcx: true }), 1);
  assert.strictEqual(exitLimitTick({ masterTick: null, isMcx: false }), 0.05);
  assert.strictEqual(exitLimitTick({ masterTick: null, isMcx: true }), null);
});
