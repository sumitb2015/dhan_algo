import test from 'node:test';
import assert from 'node:assert/strict';
import {
  consensusByWeek,
  nextRelease,
  seasonalBand,
  surpriseStats,
  weekEndingForRelease,
  weeklyChanges,
  withOfficialActual,
  vsAvgPct,
  type Point,
} from './crudeInventory.ts';

test('release date maps to the Friday it reports on', () => {
  assert.equal(weekEndingForRelease('2026-10-07'), '2026-10-02'); // EIA Wednesday
  assert.equal(weekEndingForRelease('2026-10-15'), '2026-10-09'); // EIA Thursday after a holiday
  assert.equal(weekEndingForRelease('2026-10-14'), '2026-10-09'); // API Tuesday (Wed holiday week)
  assert.equal(weekEndingForRelease('2026-10-06'), '2026-10-02'); // API Tuesday
});

test('weekly change skips a missing week instead of spanning it', () => {
  const pts: Point[] = [['2026-09-18', 426398], ['2026-09-25', 427320], ['2026-10-09', 415577]];
  const rows = weeklyChanges(pts);
  assert.equal(rows[0].change, null);
  assert.equal(rows[1].change, 922);
  assert.equal(rows[2].change, null);
});

test('seasonal band uses the same calendar week of prior years', () => {
  // One Friday per year near Oct 9, values 100..500, then the current year.
  const pts: Point[] = [
    ['2021-10-08', 100], ['2022-10-07', 200], ['2023-10-06', 300],
    ['2024-10-11', 400], ['2025-10-10', 500], ['2026-10-09', 450],
  ];
  const [row] = seasonalBand(pts, 1, 5);
  assert.equal(row.years, 5);
  assert.equal(row.min, 100);
  assert.equal(row.max, 500);
  assert.equal(row.avg, 300);
  assert.equal(vsAvgPct(row), 50);
});

test('seasonal band is null with fewer than 3 prior years', () => {
  const pts: Point[] = [['2024-10-11', 400], ['2025-10-10', 500], ['2026-10-09', 450]];
  const [row] = seasonalBand(pts, 1, 5);
  assert.equal(row.range, null);
  assert.equal(vsAvgPct(row), null);
});

test('consensus join, surprise and direction hit-rate', () => {
  const rows = [
    { release: '2026-09-30', time: '10:30', actual: 0.922, forecast: -0.7, previous: 2.969 },
    { release: '2026-10-07', time: '10:30', actual: -3.186, forecast: -1.9, previous: 0.922 },
    { release: '2026-10-15', time: '12:00', actual: null, forecast: 0.2, previous: -3.186 },
  ];
  const map = consensusByWeek(rows);
  const oct2 = map.get('2026-10-02')!;
  assert.ok(Math.abs(oct2.surprise! - -1.286) < 1e-9);
  assert.equal(map.get('2026-10-09')!.surprise, null);

  const s = surpriseStats([...map.values()]);
  assert.equal(s.count, 2);
  assert.equal(s.hits, 1);

  assert.equal(nextRelease(rows, '2026-10-15')?.release, '2026-10-15');
  assert.equal(nextRelease(rows, '2026-10-16'), null);
  // EIA already published week 2026-10-09: that release is no longer "next".
  assert.equal(nextRelease(rows, '2026-10-15', '2026-10-09'), null);

  const filled = withOfficialActual(map.get('2026-10-09'), -8.557)!;
  assert.equal(filled.actual, -8.557);
  assert.ok(Math.abs(filled.surprise! - -8.757) < 1e-9);
  assert.equal(withOfficialActual(oct2, -9), oct2); // an Investing actual is kept
});
