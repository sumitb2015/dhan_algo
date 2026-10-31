import test from 'node:test';
import assert from 'node:assert/strict';
import { timeAxisLabels, crosshairStamp } from './straddlePnfTimeAxis.ts';

const T = (m: number, d: number, hh = 10, mm = 0) => Date.UTC(2026, m - 1, d, hh, mm) / 1000 - 5.5 * 3600;   // IST wall clock

test('one label per new day, the month name on the first label of each month, day numbers after', () => {
  const times = [T(9, 1), T(9, 1, 11), T(9, 2), T(9, 3), T(10, 1), T(10, 1, 12), T(10, 2)];
  const xs = times.map((_, i) => i * 50);
  assert.deepEqual(timeAxisLabels(times, xs, 40).map(l => l.text), ['Sep', '2', '3', 'Oct', '2']);
  assert.deepEqual(timeAxisLabels(times, xs, 40).map(l => l.major), [true, false, false, true, false]);
});

test('labels keep their minimum gap; a skipped day does not move the month name onto a later label twice', () => {
  const times = [T(9, 1), T(9, 2), T(9, 3), T(9, 4), T(9, 5)];
  const xs = [0, 10, 20, 60, 70];
  assert.deepEqual(timeAxisLabels(times, xs, 44).map(l => [l.text, l.x]), [['Sep', 0], ['4', 60]]);
});

test('a long chart is labelled by month (the year on January), a very long one by year', () => {
  const months = Array.from({ length: 30 }, (_, i) => T(1 + (i % 12), 5) + Math.floor(i / 12) * 366 * 86_400);
  const xs = months.map((_, i) => i * 60);
  const m = timeAxisLabels(months, xs, 44);
  assert.ok(m.some(l => l.major && /^20\d\d$/.test(l.text)));
  assert.ok(m.some(l => !l.major && l.text === 'Mar'));
  const years = Array.from({ length: 9 }, (_, i) => T(6, 1) + i * 366 * 86_400);
  assert.deepEqual(timeAxisLabels(years, years.map((_, i) => i * 60), 44).map(l => l.text), ['2026', '2027', '2028', '2029', '2030', '2031', '2032', '2033', '2034']);
});

test('an empty chart has no labels; the crosshair chip reads like TradingView (day, month, year, IST time)', () => {
  assert.deepEqual(timeAxisLabels([], []), []);
  assert.equal(crosshairStamp(T(10, 15, 11, 18)), "15 Oct '26  11:18");
  assert.equal(crosshairStamp(T(10, 15, 11, 18), false), "15 Oct '26");
});
