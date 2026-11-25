import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFill, tickError, legAnchor, legPnl, legsFromDhanPositions, orderUnits, brokerCloseOrder, parseNiftyOption, pnlSummary, totalPnl,
  type ScalperLeg,
} from './indexScalperPositions.ts';
import { applyTick, computeIndicator, flipsAtLast, mergeHistory, migrateIndicatorsV1, pointColor, newIndicator, sessionVwap, bollinger, clampParam, tailUnchanged, type Bar } from './indexScalperIndicators.ts';
import { emaSmaSeeded, supertrendSeries } from './indicators.ts';
import { readFileSync } from 'node:fs';

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

test('Quick Trade: an option leg sits on its strike line even with an entry spot; a future keeps its average', () => {
  assert.deepEqual(legAnchor(leg(), 25360.5, { atStrike: true }), { level: 25350, kind: 'strike' });
  assert.deepEqual(legAnchor(leg({ type: 'FUT', strike: 0, avg: 6110 }), undefined, { atStrike: true }), { level: 6110, kind: 'avg' });
});

test('on its own premium chart an option leg is anchored at its average premium', () => {
  assert.deepEqual(legAnchor(leg(), 25360.5, { premium: true }), { level: 100, kind: 'avg' });
  // No average yet: falls back as on the underlying chart (the chip is then hidden by the level>0 / axis rules).
  assert.deepEqual(legAnchor(leg({ avg: 0 }), undefined, { premium: true }), { level: 25350, kind: 'strike' });
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

test('close order takes the whole broker row whoever opened it, opposite side, never flips', () => {
  assert.deepEqual(brokerCloseOrder(-715), { side: 'BUY', units: 715 }); // includes quantity opened elsewhere (mobile app)
  assert.deepEqual(brokerCloseOrder(130), { side: 'SELL', units: 130 });
  assert.equal(brokerCloseOrder(0), null);
  assert.equal(brokerCloseOrder(Number.NaN), null);
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
  // 2026-11-25 10:00:00 IST = 04:30:00 UTC (regular NSE trading day)
  const t0 = Date.UTC(2026, 10, 25, 4, 30, 0) / 1000;
  const bars: Bar[] = [{ t: t0, o: 100, h: 101, l: 99, c: 100 }];
  const up = applyTick(bars, 102, 5, t0 + 60);
  assert.deepEqual(up[0], { t: t0, o: 100, h: 102, l: 99, c: 102 });
  assert.equal(applyTick(bars, 100, 5, t0 + 60), bars);
  const rolled = applyTick(bars, 103, 5, t0 + 301);
  assert.equal(rolled.length, 2);
  assert.equal(rolled[1].t, t0 + 300);
  // 18:00 IST: after the close for NIFTY, but in-session for CRUDEOILM (MCX)
  const after = Date.UTC(2026, 10, 25, 12, 30, 0) / 1000;
  assert.equal(applyTick(bars, 105, 5, after), bars); // NIFTY: closed at 18:00 IST
  assert.notEqual(applyTick(bars, 105, 5, after, 'CRUDEOILM'), bars); // CRUDEOILM: open at 18:00 IST
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
  const pine = supertrendSeries(bars.map(b => ({ high: b.h, low: b.l, close: b.c })), 10, 2, { pine: true });
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

test('default EMA(20) and Supertrend reproduce Dhan\'s own chart on the same Dhan candles', () => {
  // Values read off Dhan's chart for NIFTY 5-min, last bar 23 Nov 2026 15:25.
  const fx = JSON.parse(readFileSync(new URL('./indexScalper.dhanParity.json', import.meta.url), 'utf8')) as
    { dhan_chart_2026_11_23_1525: { supertrend: number; ema20: number }; candles: Bar[] };
  const last = (k: Parameters<typeof newIndicator>[0]) => {
    const v = computeIndicator(fx.candles, newIndicator(k, k)).series[0].values;
    return v[v.length - 1] as number;
  };
  assert.equal(last('ema').toFixed(2), fx.dhan_chart_2026_11_23_1525.ema20.toFixed(2));
  assert.equal(last('supertrend').toFixed(2), fx.dhan_chart_2026_11_23_1525.supertrend.toFixed(2));
});

test('saved Supertrend still on the old (10, 3) default moves to (10, 2); a user\'s own setting is kept', () => {
  const st = (period: number, mult: number) => ({ ...newIndicator('supertrend', 's'), params: { period, mult } });
  assert.deepEqual(migrateIndicatorsV1([st(10, 3)])[0].params, { period: 10, mult: 2 });
  assert.deepEqual(migrateIndicatorsV1([st(7, 3)])[0].params, { period: 7, mult: 3 });
  assert.deepEqual(migrateIndicatorsV1([st(10, 2.5)])[0].params, { period: 10, mult: 2.5 });
  const ema = newIndicator('ema', 'e');
  assert.deepEqual(migrateIndicatorsV1([ema])[0], ema);
});

test('Dhan Scalper: ATM strikes with offsets, no strike without a price, expiry labels, buy premium', async () => {
  const { computeAtmStrikes, formatDhanExpiry, formatManageScripExpiry, getStrikeOffsetLabel, calcOptionBuyReq } = await import('./dhanScalperMath.ts');

  // spot 25380: PUT at the strike below, CALL at the strike above; on a round strike both are the spot
  assert.deepEqual(computeAtmStrikes(25380, 50), { peStrike: 25350, ceStrike: 25400 });
  assert.deepEqual(computeAtmStrikes(25400, 50), { peStrike: 25400, ceStrike: 25400 });
  // Manage Scrips offsets are in strike steps and follow the spot
  assert.deepEqual(computeAtmStrikes(25380, 50, -1, 2), { peStrike: 25300, ceStrike: 25500 });
  // no price, no strike (never a guessed 25000)
  assert.equal(computeAtmStrikes(null), null);
  assert.equal(computeAtmStrikes(0), null);

  assert.equal(formatDhanExpiry('2026-12-01'), '01 DEC');
  assert.equal(formatDhanExpiry('2026-11-28'), '28 NOV');
  assert.equal(formatManageScripExpiry('2026-12-01'), '1 DEC 2026');

  assert.equal(getStrikeOffsetLabel(25350, 25350), 'ATM');
  assert.equal(getStrikeOffsetLabel(25400, 25350), 'ATM+1');
  assert.equal(getStrikeOffsetLabel(25450, 25350), 'ATM+2');
  assert.equal(getStrikeOffsetLabel(25300, 25350), 'ATM-1');

  // 65 units @ 244.95 = 15,921.75; unknown price or lot size is null, not 0
  assert.equal(calcOptionBuyReq(244.95, 1, 65)?.toFixed(2), '15921.75');
  assert.equal(calcOptionBuyReq(229.95, 1, 65)?.toFixed(2), '14946.75');
  assert.equal(calcOptionBuyReq(null, 1, 65), null);
  assert.equal(calcOptionBuyReq(244.95, 1, null), null);
});

test('limit / trigger prices must sit on the Rs 0.05 tick; the error names the two nearest valid prices', () => {
  assert.equal(tickError('Price', 180), null);
  assert.equal(tickError('Price', 180.05), null);
  assert.equal(tickError('Price', 0.05), null);
  assert.equal(tickError('Price', 229.95), null); // float noise: 229.95 * 100 = 22994.999...
  assert.equal(tickError('Price', 180.03), 'Price 180.03 is not a multiple of ₹0.05: use 180.00 or 180.05');
  assert.equal(tickError('Trigger', 99.99), 'Trigger 99.99 is not a multiple of ₹0.05: use 99.95 or 100.00');
  assert.equal(tickError('Price', 12.345), 'Price 12.345 is not a multiple of ₹0.05: use 12.30 or 12.35');
});

test('futures legs: CRUDEOILM only, and never the full-size CRUDEOIL or a NIFTY future', async () => {
  const { parseScalperContract } = await import('./indexScalperPositions.ts');
  assert.deepEqual(parseScalperContract('CRUDEOILM-19Dec2026-FUT', 'CRUDEOILM'), { strike: 0, type: 'FUT' });
  assert.equal(parseScalperContract('CRUDEOIL-19Dec2026-FUT', 'CRUDEOILM'), null);
  assert.equal(parseScalperContract('NIFTY-Dec2026-FUT', 'NIFTY'), null);
  assert.equal(parseScalperContract('NIFTYNXT50-Dec2026-FUT', 'NIFTY'), null);
  assert.deepEqual(parseScalperContract('CRUDEOILM-17Dec2026-6100-CE', 'CRUDEOILM'), { strike: 6100, type: 'CE' });
  // A NIFTY future held by a strategy is not one of this page's legs.
  const legs = legsFromDhanPositions([
    { tradingSymbol: 'NIFTY-Dec2026-FUT', securityId: '1', netQty: 65, buyAvg: 26000, productType: 'MARGIN' },
  ], new Map());
  assert.equal(legs.length, 0);
});

test('a future is drawn at its average (the chart is that future); TP / SL follow the order type', async () => {
  const { legAnchor: anchor, bracketKind } = await import('./indexScalperPositions.ts');
  const fut = { id: 'f', securityId: '9001', product: 'INTRADAY', symbol: 'CRUDEOILM-18Dec2026-FUT', strike: 0, type: 'FUT' as const, netQty: 6, avg: 6110, ltp: 6120, sim: false, mult: 10 };
  assert.deepEqual(anchor(fut, undefined), { level: 6110, kind: 'avg' });
  assert.deepEqual(anchor(fut, 6000), { level: 6110, kind: 'avg' }); // not the spot at entry: the chart is the future
  // A stop below a long is the SL, a limit above it the TP; the type wins even on the "wrong" side of the entry.
  assert.equal(bracketKind('SL-M', 6095, 6110, true), 'SL');
  assert.equal(bracketKind('Limit', 6140, 6110, true), 'TP');
  assert.equal(bracketKind('SL', 6125, 6110, true), 'SL');
  assert.equal(bracketKind('STOP_LOSS_MARKET', 6130, 6110, false), 'SL');
  assert.equal(bracketKind('', 6090, 6110, false), 'TP'); // unknown type: side of the entry decides
});

test('legsKey: unchanged legs give the same key (the page keeps the array and the chart skips a render)', async () => {
  const { legsKey } = await import('./indexScalperPositions.ts');
  const leg = { id: 'a', securityId: '1', product: 'INTRADAY', symbol: 'X', strike: 0, type: 'FUT' as const, netQty: 6, avg: 6110, ltp: 6120, sim: false, mult: 10 };
  assert.equal(legsKey([leg]), legsKey([{ ...leg }]));
  assert.notEqual(legsKey([leg]), legsKey([{ ...leg, ltp: 6121 }])); // a price move is a change (P&L chip)
  assert.notEqual(legsKey([leg]), legsKey([{ ...leg, netQty: 5 }]));
});

test('CPR and pivots: TradingView Traditional levels from the previous IST day, broken at the day change', async () => {
  const { pivotLevels, prevDayHlc, dayBreaks } = await import('./indexScalperIndicators.ts');
  const lv = pivotLevels(25500, 25300, 25450);
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
  near(lv.p, 25416.666666666668); near(lv.bc, 25400); near(lv.tc, 25433.333333333336);
  near(lv.r1, 25533.333333333336); near(lv.s1, 25333.333333333336);
  near(lv.r2, 25616.666666666668); near(lv.s2, 25216.666666666668);
  near(lv.r3, 25733.333333333336); near(lv.s3, 25133.333333333336);
  near(lv.r4, 25850); near(lv.s4, 25050);
  // TC is always the upper of the two (a close below the midpoint puts 2P - BC under BC).
  const low = pivotLevels(100, 80, 82);
  assert.ok(low.tc >= low.bc);

  // Two sessions with a weekend between: Monday's levels come from Friday's H / L / C (its last close).
  const ist = (iso: string) => Date.parse(`${iso}+05:30`) / 1000;
  const bars = [
    { t: ist('2026-11-20T09:15:00'), o: 10, h: 12, l: 9, c: 11 },
    { t: ist('2026-11-20T15:25:00'), o: 11, h: 15, l: 10, c: 14 },
    { t: ist('2026-11-23T09:15:00'), o: 14, h: 16, l: 13, c: 15 },
    { t: ist('2026-11-23T09:20:00'), o: 15, h: 17, l: 14, c: 16 },
  ];
  const hlc = prevDayHlc(bars);
  assert.equal(hlc[0], null); assert.equal(hlc[1], null); // first day of the history: no previous day
  assert.deepEqual(hlc[2], { h: 15, l: 9, c: 14 });
  assert.deepEqual(hlc[3], { h: 15, l: 9, c: 14 });
  assert.deepEqual(dayBreaks(bars), [false, true, false, false]);

  const pv = computeIndicator(bars, { ...newIndicator('pivots', 'p'), params: { levels: 2 } });
  assert.deepEqual(pv.series.map(s => s.axisLabel), ['P', 'R1', 'S1', 'R2', 'S2']);
  assert.equal(pv.series[0].values[3], (15 + 9 + 14) / 3);
  // The last point of Friday is transparent (no slanted jump to Monday's level); the new day's first bar needs that
  // point recoloured, so it counts as a flip at the last bar.
  assert.equal(pointColor(pv.series[0], 1), 'transparent');
  assert.equal(flipsAtLast({ ...pv.series[0], values: pv.series[0].values.slice(0, 3), breaks: dayBreaks(bars.slice(0, 3)) }), true);
  assert.equal(flipsAtLast(pv.series[0]), false);
  const cpr = computeIndicator(bars, newIndicator('cpr', 'c'));
  assert.deepEqual(cpr.series.map(s => s.axisLabel), ['TC', 'P', 'BC']);
});
