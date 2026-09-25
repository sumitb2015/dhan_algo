import { test } from 'node:test';
import assert from 'node:assert';
import { resolveShiftTarget, clampShiftSteps } from './strikeShift.ts';

const S = [24000, 24050, 24100, 24150, 24200];

test('one step matches the legacy neighbour behaviour', () => {
  assert.deepStrictEqual(resolveShiftTarget(S, 24100, 'UP', 1, 50), { targetIdx: 3, moved: 1 });
  assert.deepStrictEqual(resolveShiftTarget(S, 24100, 'DOWN', 1, 50), { targetIdx: 1, moved: 1 });
});

test('multi-step moves N listed strikes', () => {
  assert.deepStrictEqual(resolveShiftTarget(S, 24000, 'UP', 3, 50), { targetIdx: 3, moved: 3 });
  assert.deepStrictEqual(resolveShiftTarget(S, 24200, 'DOWN', 2, 50), { targetIdx: 2, moved: 2 });
});

test('clamps at the chain edge and reports steps actually moved', () => {
  assert.deepStrictEqual(resolveShiftTarget(S, 24150, 'UP', 5, 50), { targetIdx: 4, moved: 1 });
  assert.strictEqual(resolveShiftTarget(S, 24200, 'UP', 2, 50), null);
  assert.strictEqual(resolveShiftTarget(S, 24000, 'DOWN', 1, 50), null);
});

test('strike missing from list uses exact fallback lookup', () => {
  assert.deepStrictEqual(resolveShiftTarget(S, 24075, 'UP', 1, 50), null);
  assert.deepStrictEqual(resolveShiftTarget(S, 23950, 'UP', 2, 50), { targetIdx: 1, moved: 2 });
});

test('clampShiftSteps sanitises input', () => {
  assert.strictEqual(clampShiftSteps(0), 1);
  assert.strictEqual(clampShiftSteps(NaN), 1);
  assert.strictEqual(clampShiftSteps(2.9), 2);
  assert.strictEqual(clampShiftSteps(99), 10);
});
