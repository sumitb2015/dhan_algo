import { test } from 'node:test';
import assert from 'node:assert';
import { resolveShiftTarget, clampShiftSteps, planLegShifts } from './strikeShift.ts';

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

test('planLegShifts moves every leg the same number of listed strikes', () => {
  const plan = planLegShifts(
    [{ id: 'a', strike: 24000 }, { id: 'b', strike: 24100 }], () => S, 'UP', 2, 50);
  assert.deepStrictEqual(plan, { ok: true, moves: [
    { legId: 'a', from: 24000, to: 24100 }, { legId: 'b', from: 24100, to: 24200 }] });
});

test('planLegShifts refuses the whole plan when any leg would clamp', () => {
  const plan = planLegShifts(
    [{ id: 'a', strike: 24000 }, { id: 'b', strike: 24150 }], () => S, 'UP', 2, 50);
  assert.strictEqual(plan.ok, false);
});

test('planLegShifts refuses when a leg has no chain loaded or nothing to shift', () => {
  assert.strictEqual(planLegShifts([{ id: 'a', strike: 24000 }], () => [], 'UP', 1, 50).ok, false);
  assert.strictEqual(planLegShifts([], () => S, 'UP', 1, 50).ok, false);
  assert.strictEqual(planLegShifts([{ id: 'a', strike: 24200 }], () => S, 'UP', 1, 50).ok, false);
});

test('planLegShifts uses each leg\'s own expiry chain', () => {
  const far = [24000, 24100, 24200, 24300];
  const plan = planLegShifts(
    [{ id: 'f', strike: 24100, expiry: 'far' }, { id: 'n', strike: 24100 }],
    e => (e === 'far' ? far : S), 'UP', 1, 50);
  assert.deepStrictEqual(plan, { ok: true, moves: [
    { legId: 'f', from: 24100, to: 24200 }, { legId: 'n', from: 24100, to: 24150 }] });
});
