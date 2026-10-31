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
