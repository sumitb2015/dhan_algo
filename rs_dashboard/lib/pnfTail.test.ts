import test from 'node:test';
import assert from 'node:assert/strict';
import { tailSessions, mergeTail } from './pnfTail.ts';
import type { Bar } from './straddlePnf.ts';

const D = (day: number, min: number) => Date.UTC(2026, 9, day, 3, 45) / 1000 + min * 60;
const bar = (t: number, c = 100): Bar => ({ t, ce: c, pe: 0, straddle: c, vol: 1 });

test('tailSessions keeps the last n days that have bars, and everything when there are fewer', () => {
  const bars = [bar(D(26, 0)), bar(D(26, 1)), bar(D(27, 0)), bar(D(28, 0)), bar(D(28, 1)), bar(D(29, 0))];
  assert.deepEqual(tailSessions(bars, 2).map(b => b.t), [D(28, 0), D(28, 1), D(29, 0)]);
  assert.equal(tailSessions(bars, 9).length, 6);
  assert.deepEqual(tailSessions([], 3), []);
});

test('mergeTail replaces everything from the tail\'s first bar on and keeps the older bars as they were', () => {
  const prev = [bar(D(26, 0), 1), bar(D(27, 0), 2), bar(D(28, 0), 3), bar(D(28, 1), 4)];
  const tail = [bar(D(28, 0), 30), bar(D(28, 1), 40), bar(D(28, 2), 50)];
  assert.deepEqual(mergeTail(prev, tail).map(b => b.straddle), [1, 2, 30, 40, 50]);
  assert.equal(mergeTail(prev, []), prev);
});

import { mergeBarsMap } from './pnfTail.ts';

test('mergeBarsMap: each series of the tail is laid over the same series; a series only in the tail is taken as is', () => {
  const b = (t: number, c: number) => ({ t, ce: 0, pe: 0, straddle: c } as unknown as Parameters<typeof mergeTail>[0][number]);
  const prev = { '0': [b(100, 1), b(200, 2), b(300, 3)] };
  const out = mergeBarsMap(prev, { '0': [b(300, 33), b(400, 4)], '1': [b(10, 9)] });
  assert.deepEqual(out['0'].map(x => [x.t, x.straddle]), [[100, 1], [200, 2], [300, 33], [400, 4]]);
  assert.deepEqual(out['1'].map(x => x.t), [10]);
  assert.deepEqual(mergeBarsMap(prev, {})['0'].length, 3);
});
