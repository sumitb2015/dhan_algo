import test from 'node:test';
import assert from 'node:assert/strict';
import {
  indexBaselineBlock,
  sessionHoursForMarket,
  sessionsFromBars,
  finishedSessions,
  trueRanges,
  wilderAtr,
  calculateDailyAtr,
  calculateAutoBlockSize,
  snapToTick,
} from './renkoAutoBrick.ts';
import type { Bar } from './straddlePnf.ts';

// 2026-11-02 09:15 IST (a Monday) as unix seconds; day d adds d × 86400
const DAY0 = Date.UTC(2026, 10, 2, 3, 45) / 1000;

/** `ranges[d]` = [low, high, close] of day d, as 60 one-minute bars from 09:15 IST. */
function days(ranges: [number, number, number][]): Bar[] {
  const out: Bar[] = [];
  ranges.forEach(([lo, hi, close], d) => {
    for (let m = 0; m < 60; m++) out.push({ t: DAY0 + d * 86_400 + m * 60, ce: 0, pe: 0, straddle: close, vol: 1, h: hi, l: lo });
  });
  return out;
}
const flat = (n: number, range: number, base = 24_000): [number, number, number][] =>
  Array.from({ length: n }, () => [base, base + range, base + range / 2]);

test('the video example: NIFTY ATR 100 over 6 h → 8.33 for 30 minutes, 16.66 for 1 hour (snapped to 0.05)', () => {
  const bars = days(flat(6, 100));
  const r30 = calculateAutoBlockSize({ symbol: 'NIFTY', kind: 'index', bars, market: 'NSE', targetMinutes: 30 });
  assert.equal(r30.source, 'atr');
  assert.equal(r30.dailyAtr, 100);
  assert.equal(r30.blocks, 12);
  assert.equal(r30.boxPts, 8.35);
  const r60 = calculateAutoBlockSize({ symbol: 'NIFTY', kind: 'index', bars, market: 'NSE', targetMinutes: 60 });
  assert.equal(r60.blocks, 6);
  assert.equal(r60.boxPts, 16.65);
});

test('MCX: a 14-hour session is 28 half-hours, on the 1-point crude tick', () => {
  const r = calculateAutoBlockSize({ symbol: 'CRUDEOILM', kind: 'futures', bars: days(flat(6, 300, 7_500)), market: 'MCX' });
  assert.equal(r.blocks, 28);
  assert.equal(r.boxPts, 11); // 300 / 28 = 10.71
});

test('wilderAtr: TradingView ta.atr — SMA seed of the first `period`, then RMA', () => {
  assert.equal(wilderAtr([1, 2, 3, 4], 5), null);
  assert.equal(wilderAtr([100, 100, 100, 100, 100], 5), 100);
  // seed 100, then (100×4 + 200)/5 = 120, then (120×4 + 200)/5 = 136
  assert.equal(wilderAtr([100, 100, 100, 100, 100, 200, 200], 5), 136);
});

test('trueRanges: a gap counts against the previous close; the first session is its high - low', () => {
  const trs = trueRanges([
    { id: 'a', high: 110, low: 100, close: 105 },
    { id: 'b', high: 130, low: 120, close: 125 }, // gap up: |130 - 105| = 25 > 10
    { id: 'c', high: 128, low: 118, close: 120 },
  ]);
  assert.deepEqual(trs, [10, 25, 10]);
});

test('sessionsFromBars reads only the last N sessions', () => {
  const bars = days(flat(10, 100));
  const s = sessionsFromBars(bars, 3);
  assert.equal(s.length, 3);
  assert.equal(s[2].id, '2026-11-11');
});

test('the session still trading is left out; a closed one is kept', () => {
  const bars = days(flat(6, 100));
  const s = sessionsFromBars(bars);
  const lastDay = DAY0 + 5 * 86_400;
  assert.equal(finishedSessions(s, 'NSE', lastDay + 30 * 60).length, 5);        // 09:45 IST that day: still trading
  assert.equal(finishedSessions(s, 'NSE', lastDay + 6 * 3600 + 30 * 60).length, 6); // 15:45 IST: closed
  assert.equal(finishedSessions(s, 'NSE', lastDay + 86_400).length, 6);           // next day
});

test('a quiet morning does not shrink the brick: today\'s partial range is ignored', () => {
  const ranges = flat(6, 100);
  ranges.push([24_000, 24_010, 24_005]); // day 6, 10 points so far
  const bars = days(ranges);
  const morning = DAY0 + 6 * 86_400 + 45 * 60;
  const r = calculateAutoBlockSize({ symbol: 'NIFTY', kind: 'index', bars, market: 'NSE', nowSec: morning });
  assert.equal(r.source, 'atr');
  assert.equal(r.dailyAtr, 100);
  assert.equal(r.lastSession, '2026-11-07');
});

test('calculateDailyAtr needs 5 finished sessions', () => {
  assert.equal(calculateDailyAtr(days(flat(4, 100))), null);
  const r = calculateDailyAtr(days(flat(5, 100)));
  assert.equal(r?.atr, 100);
  assert.equal(r?.sessionsCount, 5);
});

test('fallback: measured baseline for an index / future, nothing for an option', () => {
  const nifty = calculateAutoBlockSize({ symbol: 'NIFTY', kind: 'index', bars: days(flat(2, 100)) });
  assert.equal(nifty.source, 'baseline');
  assert.equal(nifty.boxPts, 32.05);
  const crude = calculateAutoBlockSize({ symbol: 'CRUDEOILM', kind: 'futures', market: 'MCX' });
  assert.equal(crude.source, 'baseline');
  assert.equal(crude.boxPts, 11);
  const opt = calculateAutoBlockSize({ symbol: 'NIFTY', kind: 'options', bars: days(flat(2, 30, 120)) });
  assert.equal(opt.source, 'none');
  assert.equal(opt.boxPts, null);
  assert.equal(calculateAutoBlockSize({ symbol: 'SENSEX', kind: 'index' }).source, 'none');
});

test('indexBaselineBlock: exact symbol or the longest matching root', () => {
  assert.equal(indexBaselineBlock('nifty'), 32.05);
  assert.equal(indexBaselineBlock('BANKNIFTY'), 104.5);
  assert.equal(indexBaselineBlock('CRUDEOILM26DEC'), 11);
  assert.equal(indexBaselineBlock('UNKNOWN_STOCK'), null);
});

test('sessionHoursForMarket: NSE 6, MCX 14, crypto 24', () => {
  assert.equal(sessionHoursForMarket('NSE', 'NIFTY'), 6);
  assert.equal(sessionHoursForMarket('NSE_FNO', 'NIFTY'), 6);
  assert.equal(sessionHoursForMarket('MCX', 'CRUDEOILM'), 14);
  assert.equal(sessionHoursForMarket('NSE', 'CRUDEOILM'), 14);
  assert.equal(sessionHoursForMarket('CRYPTO', 'BTCUSDT'), 24);
});

test('snapToTick', () => {
  assert.equal(snapToTick(8.333, 0.05), 8.35);
  assert.equal(snapToTick(16.32, 1.0), 16.0);
});
