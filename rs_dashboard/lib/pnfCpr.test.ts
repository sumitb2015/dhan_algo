import test from 'node:test';
import assert from 'node:assert/strict';
import { prevSessionHlc } from './pnfCpr.ts';

// 2026-10-29 10:00 IST and 2026-10-30 10:00 IST, in epoch seconds
const t = (day: number, min: number) => Date.UTC(2026, 9, day, 4, 30 + min) / 1000;
const bar = (day: number, min: number, v: number) => ({ t: t(day, min), ce: v, pe: 0, straddle: v, vol: 1 });

test('prevSessionHlc: the last completed session before today, high / low / close of its closes', () => {
  const bars = [bar(28, 0, 90), bar(29, 0, 100), bar(29, 1, 110), bar(29, 2, 95), bar(29, 3, 105), bar(30, 0, 200)];
  assert.deepEqual(prevSessionHlc(bars, '2026-10-30'), { session: '2026-10-29', high: 110, low: 95, close: 105 });
});

test('prevSessionHlc: no earlier session, or only unpriced bars, gives null', () => {
  assert.equal(prevSessionHlc([bar(30, 0, 100)], '2026-10-30'), null);
  assert.equal(prevSessionHlc([bar(29, 0, 0)], '2026-10-30'), null);
  assert.equal(prevSessionHlc([], '2026-10-30'), null);
});
