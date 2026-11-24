import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFill, closeOrder, legAnchor, legPnl, legsFromDhanPositions, orderUnits, parseNiftyOption, totalPnl, type ScalperLeg,
} from './indexScalperPositions.ts';
import { applyTick, computeIndicator, newIndicator, sessionVwap, bollinger, clampParam, type Bar } from './indexScalperIndicators.ts';

const leg = (o: Partial<ScalperLeg> = {}): ScalperLeg => ({
  id: '1', securityId: '1', symbol: 'NIFTY-Dec2026-25350-PE', strike: 25350, type: 'PE', netQty: 65, avg: 100, ltp: 110, sim: true, ...o,
});

test('long P&L is (ltp-avg)*qty, short is inverted, unknown LTP is null not zero', () => {
  assert.equal(legPnl(leg()), 650);
  assert.equal(legPnl(leg({ netQty: -65 })), -650);
  assert.equal(legPnl(leg({ ltp: null })), null);
  assert.equal(totalPnl([leg({ ltp: null })]), null);
  assert.equal(totalPnl([leg(), leg({ ltp: null }), leg({ netQty: -65 })]), 0);
});

test('anchor uses entry spot when known, else the strike', () => {
  assert.deepEqual(legAnchor(leg(), 25360.5), { level: 25360.5, kind: 'entry' });
  assert.deepEqual(legAnchor(leg(), undefined), { level: 25350, kind: 'strike' });
  assert.deepEqual(legAnchor(leg(), 0), { level: 25350, kind: 'strike' });
});

test('order sizing refuses unknown lot size, bad lots and over-cap', () => {
  assert.deepEqual(orderUnits(2, 65), { ok: true, units: 130 });
  assert.equal(orderUnits(1, null).ok, false);
  assert.equal(orderUnits(0, 65).ok, false);
  assert.equal(orderUnits(1.5, 65).ok, false);
  assert.equal(orderUnits(21, 65).ok, false);
});

test('close order sizes off the live quantity and never flips a reduced position', () => {
  assert.deepEqual(closeOrder(leg({ netQty: 130 }), 65), { side: 'SELL', units: 65 });
  assert.deepEqual(closeOrder(leg({ netQty: -65 }), -65), { side: 'BUY', units: 65 });
  assert.equal(closeOrder(leg({ netQty: 65 }), 0), null);
  assert.equal(closeOrder(leg({ netQty: 65 }), -65), null);
});

test('applyFill blends adds, keeps avg on reduce, resets on flip and flat', () => {
  assert.deepEqual(applyFill(0, 0, 'BUY', 65, 100), { netQty: 65, avg: 100 });
  assert.deepEqual(applyFill(65, 100, 'BUY', 65, 120), { netQty: 130, avg: 110 });
  assert.deepEqual(applyFill(130, 110, 'SELL', 65, 150), { netQty: 65, avg: 110 });
  assert.deepEqual(applyFill(65, 110, 'SELL', 65, 150), { netQty: 0, avg: 0 });
  assert.deepEqual(applyFill(65, 110, 'SELL', 130, 150), { netQty: -65, avg: 150 });
});

test('only NIFTY options are parsed', () => {
  assert.deepEqual(parseNiftyOption('NIFTY-Dec2026-25350-PE'), { strike: 25350, type: 'PE' });
  assert.equal(parseNiftyOption('BANKNIFTY-Dec2026-55000-CE'), null);
  assert.equal(parseNiftyOption('NIFTY-Dec2026-FUT'), null);
});

test('Dhan rows become legs: short uses sellAvg, flat and other symbols dropped', () => {
  const rows = [
    { tradingSymbol: 'NIFTY-Dec2026-25350-PE', securityId: '111', netQty: -65, sellAvg: 230, buyAvg: 0 },
    { tradingSymbol: 'NIFTY-Dec2026-25400-CE', securityId: '222', netQty: 0, buyAvg: 10 },
    { tradingSymbol: 'BANKNIFTY-Dec2026-55000-CE', securityId: '333', netQty: 30, buyAvg: 10 },
  ];
  const legs = legsFromDhanPositions(rows, new Map([['111', 200]]));
  assert.equal(legs.length, 1);
  assert.equal(legs[0].avg, 230);
  assert.equal(legs[0].ltp, 200);
  assert.equal(legPnl(legs[0]), 1950);
});

const bar = (t: number, c: number): Bar => ({ t, o: c, h: c + 1, l: c - 1, c });

test('VWAP resets at the IST day change', () => {
  const day1 = 1_790_000_000;
  const day2 = day1 + 86400;
  const v = sessionVwap([bar(day1, 100), bar(day1 + 300, 102), bar(day2, 200)]);
  assert.equal(v[0], 100);
  assert.equal(v[1], 101);
  assert.equal(v[2], 200);
});

test('indicators return one value per bar; warm-up is null', () => {
  const bars = Array.from({ length: 60 }, (_, i) => bar(1_790_000_000 + i * 300, 100 + Math.sin(i / 4) * 5 + i * 0.1));
  for (const kind of ['ema', 'sma', 'vwap', 'supertrend', 'bbands', 'rsi', 'macd', 'adx'] as const) {
    const out = computeIndicator(bars, newIndicator(kind, kind));
    for (const s of out.series) assert.equal(s.values.length, bars.length, `${kind}/${s.key}`);
  }
  const ema = computeIndicator(bars, { ...newIndicator('ema', 'e'), params: { period: 20 } }).series[0].values;
  assert.equal(ema[18], null);
  assert.notEqual(ema[19], null);
  const bb = bollinger(bars.map(b => b.c), 20, 2);
  assert.ok((bb.up[30] as number) > (bb.mid[30] as number));
});

test('param clamp keeps free-typed values in range', () => {
  assert.equal(clampParam('ema', 'period', 0), 1);
  assert.equal(clampParam('ema', 'period', 9999), 500);
  assert.equal(clampParam('ema', 'period', NaN), 20);
});

test('applyTick updates the forming bar, rolls a new one in-session, and never invents after-hours bars', () => {
  // 2026-11-24 10:00:00 IST = 04:30:00 UTC
  const t0 = Date.UTC(2026, 10, 24, 4, 30, 0) / 1000;
  const bars: Bar[] = [{ t: t0, o: 100, h: 101, l: 99, c: 100 }];
  const up = applyTick(bars, 102, 5, t0 + 60);
  assert.deepEqual(up[0], { t: t0, o: 100, h: 102, l: 99, c: 102 });
  assert.equal(applyTick(bars, 100, 5, t0 + 60), bars);
  const rolled = applyTick(bars, 103, 5, t0 + 301);
  assert.equal(rolled.length, 2);
  assert.equal(rolled[1].t, t0 + 300);
  // 18:00 IST: after the close
  const after = Date.UTC(2026, 10, 24, 12, 30, 0) / 1000;
  assert.equal(applyTick(bars, 105, 5, after), bars);
  assert.equal(applyTick(bars, 0, 5, t0 + 60), bars);
});
