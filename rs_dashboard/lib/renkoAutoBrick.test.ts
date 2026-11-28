import test from 'node:test';
import assert from 'node:assert/strict';
import {
  indexBaselineBlock,
  sessionHoursForMarket,
  sessionCandles,
  finishedCandles,
  niceRound,
  trueRanges,
  wilderAtr,
  calculateDailyAtr,
  calculateAutoBlockSize,
  snapToTick,
} from './renkoAutoBrick.ts';
import type { Bar } from './straddlePnf.ts';

// 2026-11-02 09:15 IST (a Monday) as unix seconds; day d adds d × 86400
const DAY0 = Date.UTC(2026, 10, 2, 3, 45) / 1000;

/**
 * `ranges[d]` = [low, high, close] of day d's 09:15-15:15 candle as 360 one-minute bars, then (stub = true) a 15:15-15:30 stub of
 * 15 bars flat at the close, as an NSE 6H chart draws it.
 */
function days(ranges: [number, number, number][], stub = false): Bar[] {
  const out: Bar[] = [];
  ranges.forEach(([lo, hi, close], d) => {
    for (let m = 0; m < 360; m++) out.push({ t: DAY0 + d * 86_400 + m * 60, ce: 0, pe: 0, straddle: close, vol: 1, h: hi, l: lo });
    if (stub) for (let m = 360; m < 375; m++) out.push({ t: DAY0 + d * 86_400 + m * 60, ce: 0, pe: 0, straddle: close, vol: 1, h: close, l: close });
  });
  return out;
}
const flat = (n: number, range: number, base = 24_000): [number, number, number][] =>
  Array.from({ length: n }, () => [base, base + range, base + range / 2]);

test('the video example: a 6H Renko box of 100 → 8.33 for 30 minutes, 16.66 for 1 hour (snapped to 0.05)', () => {
  const bars = days(flat(6, 100));
  const r30 = calculateAutoBlockSize({ symbol: 'NIFTY', kind: 'index', bars, market: 'NSE', targetMinutes: 30 });
  assert.equal(r30.source, 'atr');
  assert.equal(r30.dailyAtr, 100);
  assert.equal(r30.source === 'atr' && r30.renkoBox, 100);
  assert.equal(r30.blocks, 12);
  assert.equal(r30.boxPts, 8.35);
  const r60 = calculateAutoBlockSize({ symbol: 'NIFTY', kind: 'index', bars, market: 'NSE', targetMinutes: 60 });
  assert.equal(r60.blocks, 6);
  assert.equal(r60.boxPts, 16.65);
});

test('niceRound: the Renko [ATR] box readings from tradingcharts.co, 6H chart, 2026-11-28', () => {
  assert.equal(niceRound(180.8), 200);   // NIFTY
  assert.equal(niceRound(171.12), 150);  // CRUDEOILM DEC FUT
  assert.equal(niceRound(561.53), 600);  // BANKNIFTY
  assert.equal(niceRound(255.08), 250);  // FINNIFTY
  assert.equal(niceRound(96.93), 100);   // MIDCPNIFTY
  assert.equal(niceRound(13.2), 15);
  assert.equal(niceRound(0), 0);
});

test('an NSE day is two 6H candles, 09:15-15:15 and the 15:15-15:30 stub, and the stub pulls the ATR down', () => {
  const bars = days(flat(6, 400, 25_000), true);
  const c = sessionCandles(bars, 'NSE', 360);
  assert.equal(c.length, 12);
  assert.deepEqual(c.slice(0, 2).map(x => [x.id, x.high - x.low]), [['2026-11-02#0', 400], ['2026-11-02#1', 0]]);
  // TR alternates 400 (the day) and |close - prior close| = 0 for the stub: about half of a whole-day ATR, as on the real chart
  const r = calculateAutoBlockSize({ symbol: 'NIFTY', kind: 'index', bars, market: 'NSE' });
  assert.equal(r.source, 'atr');
  assert.ok(r.dailyAtr !== null && r.dailyAtr > 100 && r.dailyAtr < 300, `ATR ${r.dailyAtr}`);
});

test('MCX: a 14H candle from 09:00, 28 half-hours, on the 1-point crude tick', () => {
  const bars = days(flat(6, 150, 7_500));
  const r = calculateAutoBlockSize({ symbol: 'CRUDEOILM', kind: 'futures', bars, market: 'MCX' });
  assert.equal(r.blocks, 28);
  assert.equal(r.boxPts, 5); // box 150 / 28 = 5.36
});

test('wilderAtr: TradingView ta.atr — SMA seed of the first `period`, then RMA', () => {
  assert.equal(wilderAtr([1, 2, 3, 4], 5), null);
  assert.equal(wilderAtr([100, 100, 100, 100, 100], 5), 100);
  // seed 100, then (100×4 + 200)/5 = 120, then (120×4 + 200)/5 = 136
  assert.equal(wilderAtr([100, 100, 100, 100, 100, 200, 200], 5), 136);
});

test('trueRanges: a gap counts against the previous close; the first session is its high - low', () => {
  const trs = trueRanges([
    { high: 110, low: 100, close: 105 },
    { high: 130, low: 120, close: 125 }, // gap up: |130 - 105| = 25 > 10
    { high: 128, low: 118, close: 120 },
  ]);
  assert.deepEqual(trs, [10, 25, 10]);
});

test('sessionCandles reads only the last N candles', () => {
  const s = sessionCandles(days(flat(10, 100)), 'NSE', 360, 3);
  assert.equal(s.length, 3);
  assert.equal(s[2].id, '2026-11-11#0');
});

test('a candle still forming is left out; a finished one is kept', () => {
  const c = sessionCandles(days(flat(6, 100), true), 'NSE', 360);
  const lastDay = DAY0 + 5 * 86_400;
  assert.equal(finishedCandles(c, lastDay + 6 * 3600 + 5 * 60).length, 11);  // 15:20 IST: the stub is forming
  assert.equal(finishedCandles(c, lastDay + 6 * 3600 + 20 * 60).length, 12); // 15:35 IST: closed
  assert.equal(finishedCandles(c, lastDay + 86_400).length, 12);             // next day
});

test('a quiet morning does not shrink the brick: the forming candle is ignored', () => {
  const ranges = flat(6, 100);
  ranges.push([24_000, 24_010, 24_005]); // day 6, 10 points so far
  const bars = days(ranges);
  const morning = DAY0 + 6 * 86_400 + 45 * 60;
  const r = calculateAutoBlockSize({ symbol: 'NIFTY', kind: 'index', bars, market: 'NSE', nowSec: morning });
  assert.equal(r.source, 'atr');
  assert.equal(r.dailyAtr, 100);
  assert.equal(r.lastSession, '2026-11-07#0');
});

test('calculateDailyAtr needs 5 finished candles', () => {
  assert.equal(calculateDailyAtr(days(flat(4, 100))), null);
  const r = calculateDailyAtr(days(flat(5, 100)));
  assert.equal(r?.atr, 100);
  assert.equal(r?.candlesCount, 5);
});

test('fallback: measured baseline for an index / future, nothing for an option', () => {
  const nifty = calculateAutoBlockSize({ symbol: 'NIFTY', kind: 'index', bars: days(flat(2, 100)) });
  assert.equal(nifty.source, 'baseline');
  assert.equal(nifty.boxPts, 16.65);
  const crude = calculateAutoBlockSize({ symbol: 'CRUDEOILM', kind: 'futures', market: 'MCX' });
  assert.equal(crude.source, 'baseline');
  assert.equal(crude.boxPts, 5);
  const opt = calculateAutoBlockSize({ symbol: 'NIFTY', kind: 'options', bars: days(flat(2, 30, 120)) });
  assert.equal(opt.source, 'none');
  assert.equal(opt.boxPts, null);
  assert.equal(calculateAutoBlockSize({ symbol: 'SENSEX', kind: 'index' }).source, 'none');
});

test('indexBaselineBlock: exact symbol or the longest matching root', () => {
  assert.equal(indexBaselineBlock('nifty'), 16.65);
  assert.equal(indexBaselineBlock('BANKNIFTY'), 50);
  assert.equal(indexBaselineBlock('CRUDEOILM26DEC'), 5);
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
