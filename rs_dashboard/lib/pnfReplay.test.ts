import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_BOOK, REPLAY_SPEEDS, barsUpTo, countUpTo, cursorBefore, firstAvailableT, nextStepT, openLots, practiceAutoArm, practiceAutoStep,
  practiceCancel, practiceCross, practiceFill, practiceFlatten, practicePlace, practicePnl, randomStartT, speedMs, type PracticeQuote,
} from './pnfReplay.ts';
import { buildConfirmedModel } from './straddlePnfModel.ts';
import type { Bar } from './straddlePnf.ts';

const T0 = Date.UTC(2026, 9, 26, 3, 45) / 1000;                     // Mon 26 Oct 2026 09:15 IST
const day = (d: number, m: number) => T0 + d * 86_400 + m * 60;
const mk = (ts: number[], p = 100): Bar[] => ts.map((t, i) => ({ t, ce: p + i, pe: 0, straddle: p + i, vol: 1 }));

test('speeds are TradingView\'s: 10 updates a second down to one per 10 seconds', () => {
  assert.deepEqual(REPLAY_SPEEDS.map(s => s.id), ['10x', '7x', '5x', '3x', '1x', '0.5x', '0.3x', '0.2x', '0.1x']);
  assert.equal(speedMs('10x'), 100);
  assert.equal(speedMs('0.1x'), 10_000);
});

test('countUpTo / barsUpTo: the bars at or before the cursor, as the same objects', () => {
  const bars = mk([day(0, 0), day(0, 1), day(0, 2), day(0, 3)]);
  assert.equal(countUpTo(bars, day(0, 1)), 2);
  assert.equal(countUpTo(bars, day(0, 0) - 1), 0);
  assert.equal(countUpTo(bars, day(9, 0)), 4);
  assert.equal(barsUpTo(bars, day(0, 2))[2], bars[2]);
});

test('a step is one chart bar: 1 minute, the rest of a 15-minute bucket, a whole day; null at the end', () => {
  const bars = mk([...Array.from({ length: 375 }, (_, m) => day(0, m)), ...Array.from({ length: 375 }, (_, m) => day(1, m))]);
  assert.equal(nextStepT(bars, day(0, 10), 1, 930), day(0, 11));
  assert.equal(nextStepT(bars, day(0, 14), 15, 930), day(0, 29));         // 09:30-09:44 bucket ends at 09:44
  assert.equal(nextStepT(bars, day(0, 20), 15, 930), day(0, 29));         // mid-bucket: completes the 09:30 bucket
  assert.equal(nextStepT(bars, day(0, 0) - 60, 1440, 930), day(0, 374));  // the whole first day
  assert.equal(nextStepT(bars, day(0, 374), 1440, 930), day(1, 374));
  assert.equal(nextStepT(bars, day(1, 374), 1, 930), null);
});

test('a CAS stock day ends at 15:14: the last 30-minute step stops there', () => {
  const bars = mk(Array.from({ length: 360 }, (_, m) => day(0, m)));    // 09:15-15:14
  assert.equal(nextStepT(bars, day(0, 344), 30, 15 * 60 + 15), day(0, 359));
});

test('start points: just before the chosen bar, first available (the first real minute), random never in the last session', () => {
  const daily = mk([day(-3, 374), day(-2, 374)]);                          // daily-prefix bars stamped 15:29
  const minutes = mk([day(0, 0), day(0, 1), day(1, 0), day(1, 1)]);
  const bars = [...daily, ...minutes];
  assert.equal(cursorBefore(bars, day(0, 1)), day(0, 0));
  assert.equal(firstAvailableT(bars, day(0, 0)), day(0, 0));
  assert.equal(firstAvailableT(bars, null), day(-3, 374));
  for (const r of [0, 0.3, 0.99]) {
    const t = randomStartT(bars, () => r, day(0, 0))!;
    assert.ok(t >= day(0, 0) && t < day(1, 0), `random ${r} -> ${t}`);
  }
});

const quote = (price: number, t = day(0, 5), key = 'F'): PracticeQuote => ({ chart: 1, targetKey: key, t, price, legPrices: [price], unitsPerLot: [65] });

test('practice market fills, flatten and P&L at the replayed price', () => {
  let b = practiceFill(EMPTY_BOOK, quote(100), 'BUY', 2, 'manual');
  assert.equal(openLots(b, 'F'), 2);
  assert.equal(practicePnl(b, { F: { legPrices: [101], unitsPerLot: [65] } }), 130);   // 1 point x 2 lots x 65
  b = practiceFlatten(b, quote(103));
  assert.equal(openLots(b, 'F'), 0);
  assert.equal(practicePnl(b, {}), 390);                                               // booked: 3 x 2 x 65
  assert.deepEqual(b.trades.map(t => [t.side, t.lots, t.price, t.reason]), [['BUY', 2, 100, 'manual'], ['SELL', 2, 103, 'flatten']]);
});

test('practice rail orders: a LIMIT fills at its level when the price reaches it, a stop at the price; cancel removes one', () => {
  let b = practicePlace(EMPTY_BOOK, 1, 'F', 'BUY', 98, 1, 100);       // BUY below -> limit
  b = practicePlace(b, 1, 'F', 'SELL', 105, 1, 100);                    // SELL above -> limit
  b = practicePlace(b, 1, 'F', 'BUY', 104, 1, 100);                     // BUY above -> stop
  assert.deepEqual(b.orders.map(o => o.kind), ['limit', 'limit', 'stop']);
  b = practiceCross(b, quote(99));
  assert.equal(b.trades.length, 0);
  b = practiceCross(b, quote(97.5));
  assert.deepEqual(b.trades.map(t => [t.side, t.price]), [['BUY', 98]]);
  b = practiceCross(b, quote(104.3));
  assert.deepEqual(b.trades.map(t => [t.side, t.price]), [['BUY', 98], ['BUY', 104.3]]);
  b = practiceCancel(b, b.orders[0].id);
  assert.equal(b.orders.length, 0);
  assert.equal(openLots(b, 'F'), 2);
});

test('practice AUTO trades a replayed Renko 2-brick SELL at the brick close and exits on the first up brick', () => {
  const t = (m: number) => day(4, 75 + m);                                // Fri 30 Oct 10:30 + m
  const closes = [100, 100.3, 100.3, 100.3, 99.95, 100.25];
  const bars: Bar[] = closes.map((p, i) => ({ t: t(i), ce: p, pe: 0, straddle: p, vol: 1 }));
  const opts = { chart: 'renko' as const, boxMode: 'pts' as const, boxPts: 0.1, reversal: 2, volume: false };
  let b = practiceAutoArm(EMPTY_BOOK, 1, true, t(3), 1);
  for (let k = 4; k <= 5; k++) {
    const shown = bars.slice(0, k + 1);
    b = practiceAutoStep(b, { ...quote(closes[k], t(k)), t: t(k) }, buildConfirmedModel(shown, 'sma', opts), 'NSE');
  }
  assert.deepEqual(b.trades.map(x => [x.side, +x.price.toFixed(2), x.reason]), [['SELL', 100, 'auto'], ['BUY', 100.2, 'auto']]);
  assert.equal(b.auto[1].position, null);
  assert.equal(Math.round(practicePnl(b, {})), -13);                    // (100.0 - 100.2) x 65
});
