import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFill, legAnchor, legPnl, legsFromDhanPositions, orderUnits, ownedCloseOrder, ownedQtyFromOrders, parseNiftyOption, pnlSummary, totalPnl,
  type ScalperLeg,
} from './indexScalperPositions.ts';
import { applyTick, computeIndicator, flipsAtLast, mergeHistory, pointColor, newIndicator, sessionVwap, bollinger, clampParam, tailUnchanged, type Bar } from './indexScalperIndicators.ts';
import { emaSmaSeeded, supertrendSeries } from './indicators.ts';

const leg = (o: Partial<ScalperLeg> = {}): ScalperLeg => ({
  id: '1', securityId: '1', product: '', symbol: 'NIFTY-Dec2026-25350-PE', strike: 25350, type: 'PE', netQty: 65, avg: 100, ltp: 110, sim: true, ...o,
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

test('partial P&L counts the legs it leaves out', () => {
  assert.deepEqual(pnlSummary([leg(), leg({ ltp: null })]), { pnl: 650, unpriced: 1 });
  assert.deepEqual(pnlSummary([leg({ ltp: null })]), { pnl: null, unpriced: 1 });
  assert.deepEqual(pnlSummary([]), { pnl: null, unpriced: 0 });
});

test('ownership is only what isx-tagged orders filled, per security + product, net of its own exits', () => {
  const orders = [
    { correlationId: 'isxabc1', securityId: '111', productType: 'INTRADAY', transactionType: 'SELL', filledQty: 65 },
    { correlationId: 'isxabc2', securityId: '111', productType: 'INTRADAY', transactionType: 'SELL', filledQty: 65 },
    { correlationId: 'isxabc3', securityId: '111', productType: 'INTRADAY', transactionType: 'BUY', filledQty: 65 },
    { correlationId: 'isxabc4', securityId: '111', productType: 'MARGIN', transactionType: 'SELL', filledQty: 0 }, // unfilled
    { correlationId: 'mlfxyz', securityId: '111', productType: 'INTRADAY', transactionType: 'SELL', filledQty: 650 }, // another terminal
    { correlationId: '', securityId: '222', productType: 'INTRADAY', transactionType: 'BUY', filledQty: 75 }, // strategy / manual
  ];
  const own = ownedQtyFromOrders(orders);
  assert.equal(own.get('111|INTRADAY'), -65);
  assert.equal(own.has('111|MARGIN'), false);
  assert.equal(own.has('222|INTRADAY'), false);
});

test('owned close is clamped by both the broker row and what this page owns, never flips, never touches others', () => {
  assert.deepEqual(ownedCloseOrder(-715, -65), { side: 'BUY', units: 65 }); // a strategy holds the other 650
  assert.deepEqual(ownedCloseOrder(-65, -130), { side: 'BUY', units: 65 }); // broker already reduced it
  assert.deepEqual(ownedCloseOrder(130, 130), { side: 'SELL', units: 130 });
  assert.equal(ownedCloseOrder(-65, 0), null); // not ours
  assert.equal(ownedCloseOrder(65, -65), null); // opposite direction: not ours to close
  assert.equal(ownedCloseOrder(0, 65), null);
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

test('one leg per security + product row; verbatim duplicate rows collapse so nothing is closed twice', () => {
  const r = { tradingSymbol: 'NIFTY-Dec2026-25350-PE', securityId: '111', exchangeSegment: 'NSE_FNO', positionType: 'SHORT', sellAvg: 230 };
  const legs = legsFromDhanPositions([
    { ...r, productType: 'INTRADAY', netQty: -75 },
    { ...r, productType: 'INTRADAY', netQty: -75 }, // Dhan's duplicate of the same row
    { ...r, productType: 'MARGIN', netQty: -75 },
  ], new Map());
  assert.deepEqual(legs.map(l => [l.id, l.product, l.netQty]), [['111|INTRADAY', 'INTRADAY', -75], ['111|MARGIN', 'MARGIN', -75]]);
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

test('chart fast path only when every bar but the forming one is as drawn', () => {
  const a = bar(1000, 100), b = bar(1300, 101), c = bar(1600, 102);
  const drawn = [a, b];
  assert.equal(tailUnchanged(drawn, 2, [a, { ...b, c: 105, h: 106 }]), true); // forming bar moved
  assert.equal(tailUnchanged(drawn, 2, [a, b, c]), true); // new bar after an unchanged one
  assert.equal(tailUnchanged(drawn, 2, [{ ...a, h: 120 }, b]), false); // refresh corrected the closed bar
  assert.equal(tailUnchanged(drawn, 2, [a, { ...b, h: 120 }, c]), false); // refresh corrected the old forming bar, then rolled
  assert.equal(tailUnchanged(drawn, 2, [a, c]), false); // last bar replaced by a different time
  assert.equal(tailUnchanged([a], 1, [{ ...a, c: 99 }]), true);
  assert.equal(tailUnchanged([], 0, [a]), false);
});

test('EMA and Supertrend are the TradingView definitions (SMA-seeded EMA, Pine supertrend)', () => {
  // A session ending in a frozen closing stretch, like NIFTY's 15:15-15:28 every day.
  const bars: Bar[] = [];
  for (let i = 0; i < 80; i++) { const c = 25000 + Math.sin(i / 5) * 40 + i; bars.push({ t: 1_790_000_000 + i * 300, o: c - 3, h: c + 8, l: c - 8, c }); }
  const last = bars[bars.length - 1].c;
  for (let i = 0; i < 15; i++) bars.push({ t: bars[bars.length - 1].t + 300, o: last, h: last, l: last, c: last });
  const closes = bars.map(b => b.c);
  assert.deepEqual(computeIndicator(bars, newIndicator('ema', 'e')).series[0].values, emaSmaSeeded(closes, 20));
  const pine = supertrendSeries(bars.map(b => ({ high: b.h, low: b.l, close: b.c })), 10, 3, { pine: true });
  assert.deepEqual(computeIndicator(bars, newIndicator('supertrend', 's')).series[0].values, pine.map(x => x.line));
});

test('history merge keeps tick-built bars newer than the history and the ticks\' range on the forming bar', () => {
  const t0 = 1_790_000_000;
  const hist: Bar[] = [{ t: t0, o: 100, h: 104, l: 98, c: 101 }, { t: t0 + 300, o: 101, h: 102, l: 100, c: 101.5 }];
  const live: Bar[] = [{ t: t0, o: 100, h: 103, l: 99, c: 101 }, { t: t0 + 300, o: 101, h: 106, l: 97, c: 105 }];
  // the second bar is still forming at t0+400: ticks saw 106 / 97, REST's snapshot of it is older
  assert.deepEqual(mergeHistory(hist, live, 5, t0 + 400)[1], { t: t0 + 300, o: 101, h: 106, l: 97, c: 105 });
  assert.deepEqual(mergeHistory(hist, live, 5, t0 + 400)[0], hist[0]); // closed bars: history wins
  // once that bar has closed, the history's version is the truth
  assert.deepEqual(mergeHistory(hist, live, 5, t0 + 700)[1], hist[1]);
  // a bar the ticks opened after the history ends is kept
  const more = [...live, { t: t0 + 600, o: 105, h: 107, l: 104, c: 106 }];
  assert.equal(mergeHistory(hist, more, 5, t0 + 650).length, 3);
  assert.equal(mergeHistory([], live, 5, t0), live);
});

test('ticks accumulate: a closed bar keeps its range and the forming bar keeps every tick high / low', () => {
  const t0 = Date.UTC(2026, 10, 25, 4, 30, 0) / 1000; // 10:00 IST
  let bars: Bar[] = [{ t: t0, o: 100, h: 100, l: 100, c: 100 }];
  bars = applyTick(bars, 104, 5, t0 + 30);
  bars = applyTick(bars, 97, 5, t0 + 60);
  bars = applyTick(bars, 101, 5, t0 + 90);
  bars = applyTick(bars, 102, 5, t0 + 310); // rolls
  bars = applyTick(bars, 103, 5, t0 + 620); // rolls again
  assert.deepEqual(bars.map(b => b.t), [t0, t0 + 300, t0 + 600]);
  assert.deepEqual(bars[0], { t: t0, o: 100, h: 104, l: 97, c: 101 });
});

test('Supertrend is one series coloured per point, with a gap at each flip (no line drawn across the other trend)', () => {
  const G = '#22c55e', R = '#ef4444';
  const s = { key: 'v', label: 'ST', axisLabel: 'Supertrend', color: G, style: 'line' as const, values: [1, 2, 3, 9, 8, 7, 3], colors: [G, G, G, R, R, R, G] };
  // the segment from point i is drawn in point i's colour: the bar before each flip is transparent
  assert.deepEqual(s.values.map((_, i) => pointColor(s, i)), [G, G, 'transparent', R, R, 'transparent', G]);
  assert.equal(flipsAtLast(s), true);
  assert.equal(flipsAtLast({ ...s, colors: [G, G, G, R, R, R, R] }), false);
  // histograms keep their own per-bar colour; plain lines have none
  assert.equal(pointColor({ ...s, style: 'histogram' }, 2), G);
  assert.equal(pointColor({ ...s, colors: undefined }, 2), undefined);
});

test('every indicator series names itself on the price scale', () => {
  const bars = Array.from({ length: 60 }, (_, i) => ({ t: 1_790_000_000 + i * 300, o: 100, h: 101 + i % 3, l: 99 - i % 2, c: 100 + Math.sin(i) }));
  const names = (k: Parameters<typeof newIndicator>[0]) => computeIndicator(bars, newIndicator(k, k)).series.map(s => s.axisLabel);
  assert.deepEqual(names('ema'), ['EMA(20)']);
  assert.deepEqual(names('supertrend'), ['Supertrend']);
  assert.deepEqual(names('bbands'), ['BB upper', 'BB basis', 'BB lower']);
  assert.deepEqual(names('macd'), ['Hist', 'MACD', 'Signal']);
});
