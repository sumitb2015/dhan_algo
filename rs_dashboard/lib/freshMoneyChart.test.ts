import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartDomain, findGaps, buildChartPoints, latestReading } from './freshMoneyChart.ts';
import type { SeriesPoint, BandPoint } from './freshMoney.ts';

const MCX = { from: 540, to: 1435 };
const s = (m: number, puts: number | null, calls: number | null): SeriesPoint => ({ m, puts, calls });

test('the axis starts at the hour of the first reading, not the session open', () => {
  assert.deepEqual(chartDomain([s(17 * 60 + 5, 0.1, 0.2)], MCX), [17 * 60, 1435]);
  assert.deepEqual(chartDomain([], MCX), [540, 1435]);
  // late in the day: keep at least 3 h visible
  assert.deepEqual(chartDomain([s(23 * 60, 0.1, 0.1)], MCX), [1435 - 180, 1435]);
  // never before the session
  assert.deepEqual(chartDomain([s(560, 0.1, 0.1)], { from: 555, to: 930 }), [555, 930]);
});

test('collector gaps over 3 min are found; ordinary 1-min spacing is not a gap', () => {
  const series = [s(1022, 0.1, 0.1), s(1023, 0.1, 0.1), s(1042, 0.2, 0.2), s(1043, 0.2, 0.2), s(1046, 0.1, 0.1)];
  assert.deepEqual(findGaps(series), [[1023, 1042]]);
});

test('the lead fill goes to the higher side only', () => {
  const pts = buildChartPoints([s(600, 0.3, 0.1), s(601, 0.1, 0.25), s(602, 0.2, null)], [], [600, 602]);
  assert.deepEqual(pts[0].putLead, [10, 30]);
  assert.equal(pts[0].callLead, null);
  assert.deepEqual(pts[1].callLead, [10, 25]);
  assert.equal(pts[2].putLead, null);
});

test('reading: leader, trend over 10 min, and versus normal when a band exists', () => {
  const series = [s(1040, 0.25, 0.27), s(1050, 0.09, 0.18)];
  const r = latestReading(series, [])!;
  assert.equal(r.leader, 'calls');
  assert.equal(r.puts!.trend, 'falling');
  assert.equal(r.calls!.trend, 'falling');
  assert.match(r.text, /^Calls lead: 18% of call volume/);
  assert.match(r.text, /Puts falling, Calls falling over the last 10 min\./);
  const band: BandPoint[] = [{ m: 1050, putLo: 0.05, putHi: 0.12, callLo: 0.05, callHi: 0.12 }];
  const r2 = latestReading(series, band)!;
  assert.equal(r2.calls!.vsNormal, 'above');
  assert.equal(r2.puts!.vsNormal, 'normal');
  assert.match(r2.text, /Calls above normal for this time of day\./);
});

test('reading: even sides, no history, one side only, nothing', () => {
  assert.equal(latestReading([s(600, 0.10, 0.11)], [])!.leader, 'even');
  assert.equal(latestReading([s(600, 0.10, 0.11)], [])!.puts!.trend, null);
  assert.equal(latestReading([s(600, null, 0.2)], [])!.leader, null);
  assert.equal(latestReading([], []), null);
});
