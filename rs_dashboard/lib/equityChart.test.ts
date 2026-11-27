import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EQUITY_INDICATOR_KINDS, barsForPeriod, defaultEquityIndicators, legendAt, parseSavedIndicators, resample, toBars, week52,
  type CandleRow,
} from './equityChart.ts';

const R = (date: string, o: number, h: number, l: number, c: number, v = 100): CandleRow => ({ date, open: o, high: h, low: l, close: c, volume: v });

test('monthly resample: first open, max high, min low, last close, summed volume, dated by the 1st', () => {
  const m = resample([R('2026-10-30', 10, 12, 9, 11), R('2026-11-02', 11, 15, 10, 14), R('2026-11-27', 14, 14, 8, 9, 50)], 'M');
  assert.deepEqual(m, [R('2026-10-01', 10, 12, 9, 11), R('2026-11-01', 11, 15, 8, 9, 150)]);
});

test('weekly resample groups Monday-Sunday and dates the bar by its Monday', () => {
  const w = resample([R('2026-11-20', 1, 2, 1, 2), R('2026-11-23', 2, 3, 1, 3), R('2026-11-27', 3, 5, 2, 4)], 'W');
  assert.equal(w.length, 2);
  assert.deepEqual(w[1], R('2026-11-23', 2, 5, 1, 4, 200));
});

test('resample does not mutate the daily rows', () => {
  const rows = [R('2026-11-02', 1, 2, 1, 2), R('2026-11-03', 2, 9, 1, 3)];
  resample(rows, 'M');
  assert.equal(rows[0].high, 2);
});

test('toBars: volume only when the series has any (index CSVs carry 0)', () => {
  assert.equal(toBars([R('2026-11-02', 1, 2, 1, 2, 0)])[0].v, undefined);
  assert.equal(toBars([R('2026-11-02', 1, 2, 1, 2, 0), R('2026-11-03', 1, 2, 1, 2, 7)])[0].v, 0);
  assert.equal(toBars([R('2026-11-02', 1, 2, 1, 2)])[0].t, Date.UTC(2026, 10, 2) / 1000);
});

test('period buttons in trading days become bars per timeframe', () => {
  assert.equal(barsForPeriod(252, 'D'), 252);
  assert.equal(barsForPeriod(252, 'W'), 51);
  assert.equal(barsForPeriod(22, 'M'), 6); // never fewer than 6 bars
  assert.equal(barsForPeriod(null, 'W'), null);
});

test('intraday-only indicators are not offered', () => {
  for (const k of ['vwap', 'cpr', 'pivots', 'daylevels'] as const) assert.ok(!EQUITY_INDICATOR_KINDS.includes(k));
  assert.ok(EQUITY_INDICATOR_KINDS.includes('supertrend'));
});

test('saved indicators: defaults on bad input, unknown kinds dropped, old Supertrend default migrated', () => {
  assert.deepEqual(parseSavedIndicators(null), defaultEquityIndicators());
  assert.deepEqual(parseSavedIndicators('{oops'), defaultEquityIndicators());
  const saved = [
    { id: 'a', kind: 'vwap', params: {}, color: '#fff', visible: true },
    { id: 'b', kind: 'supertrend', params: { period: 10, mult: 3 }, color: '#fff', visible: true },
    { id: 'c', kind: 'rsi' },
  ];
  const out = parseSavedIndicators(JSON.stringify(saved));
  assert.deepEqual(out.map(i => i.id), ['b']);
  assert.equal(out[0].params.mult, 2);
  assert.deepEqual(parseSavedIndicators('[]'), []); // the user removed everything: keep it that way
});

test('legend change is against the previous close', () => {
  const bars = toBars([R('2026-11-02', 1, 2, 1, 100), R('2026-11-03', 100, 112, 99, 110)]);
  assert.deepEqual(legendAt(bars, 1), { o: 100, h: 112, l: 99, c: 110, v: 100, chg: 10, chgPct: 10 });
  assert.equal(legendAt(bars, 0)?.chg, null);
  assert.equal(legendAt(bars, 5), null);
});

test('52-week high / low covers the last 365 days only', () => {
  const s = week52([R('2025-11-01', 1, 999, 1, 1), R('2026-01-05', 1, 50, 20, 30), R('2026-11-27', 1, 40, 10, 30)]);
  assert.deepEqual(s, { high: 50, low: 10, highDate: '2026-01-05', lowDate: '2026-11-27' });
  assert.equal(week52([]), null);
});
