import test from 'node:test';
import assert from 'node:assert/strict';
import { stochRsiArray } from './indicators.ts';
import {
  replay, closedBars, consensus, decideOrb, defaultSpec, evaluate, nextBlock, positionPnl, readIndicator, rowPnl, sanitizeSpec, type DecideInput, type OrbBar,
} from './signalOrb.ts';

const series = (closes: number[], t0 = 1_700_000_000 - (1_700_000_000 % 300)): OrbBar[] => closes.map((c, i) => ({ t: t0 + i * 60, close: c, high: c + 1, low: c - 1, vol: 100 }));
const up = Array.from({ length: 60 }, (_, i) => 100 + i);
const down = Array.from({ length: 60 }, (_, i) => 200 - i);

test('consensus: all must agree; none or any zero is neutral', () => {
  assert.equal(consensus([]), 'NEUTRAL');
  assert.equal(consensus([1, 1, 1]), 'BULL');
  assert.equal(consensus([-1, -1]), 'BEAR');
  assert.equal(consensus([1, -1]), 'NEUTRAL');
  assert.equal(consensus([1, 0]), 'NEUTRAL');
});

test('EMA and Supertrend vote with a steady trend', () => {
  const specs = [defaultSpec('ema', 'e'), defaultSpec('supertrend', 's'), defaultSpec('emaCross', 'x')];
  assert.equal(evaluate(specs, series(up)).signal, 'BULL');
  assert.equal(evaluate(specs, series(down)).signal, 'BEAR');
});

test('an indicator that is still warming up votes 0', () => {
  const r = readIndicator(defaultSpec('ema', 'e'), series([1, 2, 3]));
  assert.equal(r.vote, 0);
  assert.equal(evaluate([defaultSpec('ema', 'e')], series([1, 2, 3])).signal, 'NEUTRAL');
});

test('RSI uses its neutral band', () => {
  assert.equal(readIndicator(defaultSpec('rsi', 'r'), series(up)).vote, 1);
  assert.equal(readIndicator(defaultSpec('rsi', 'r'), series(down)).vote, -1);
  const flatish = Array.from({ length: 60 }, (_, i) => 100 + (i % 2));
  assert.equal(readIndicator(defaultSpec('rsi', 'r'), series(flatish)).vote, 0);
});

test('stochRsiArray: hand-checked small case and warm-up nulls', () => {
  // RSI(2) over these closes, stoch over 2 RSI values, K = SMA1, D = SMA1: values follow directly from the RSI ordering
  const closes = [10, 11, 12, 11, 13, 12, 14];
  const s = stochRsiArray(closes, 2, 2, 1, 1);
  assert.equal(s.k[0], null);
  assert.equal(s.k[2], null);                     // first RSI at 2, stoch needs two RSIs
  const ks = s.k.slice(3) as number[];
  for (const k of ks) assert.ok(k === 0 || k === 100, `k=${k}`);
  // RSI(2) falls at index 3 (a down close) and rises at index 4: stoch 0 then 100
  assert.equal(s.k[3], 0);
  assert.equal(s.k[4], 100);
  assert.deepEqual(s.d, s.k);                      // D = SMA1(K)
  // a choppy series (a steady rise keeps RSI flat at 100, which Pine leaves na)
  const chop = Array.from({ length: 60 }, (_, i) => 100 + (i % 5) * (i % 2 ? 1 : -1) + i * 0.1);
  const t = stochRsiArray(chop, 14, 14, 3, 3);
  assert.equal(t.d[14 + 13 + 2 + 2 - 1], null);    // one bar before the first D
  assert.notEqual(t.d[14 + 13 + 2 + 2], null);
});

test('closedBars drops the forming bucket and resamples to 5 minutes', () => {
  const t0 = 1_700_000_100 - (1_700_000_100 % 300);
  const m = Array.from({ length: 12 }, (_, i) => ({ t: t0 + i * 60, straddle: 100 + i }));
  const now = t0 + 12 * 60 + 5;                  // minute 12 forming; minutes 10-11 are in the 3rd 5m bucket, still forming
  const one = closedBars(m, 1, now);
  assert.equal(one.length, 12);
  const five = closedBars(m, 5, now);
  assert.equal(five.length, 2);
  assert.equal(five[0].close, 104);
  assert.equal(five[1].close, 109);
  assert.equal(closedBars(m, 1, t0 + 11 * 60 + 30).length, 11);   // the 11th minute is still forming
});

const base: DecideInput = {
  signal: 'BULL', barT: 1000, watermarkT: 0, position: null, price: 100, minute: 12 * 60,
  times: { entryStart: '09:15', entryEnd: '22:45', eodExit: '23:00' }, stopPts: 30, blockedSide: null,
};

test('decideOrb: flat enters, same side holds, opposite reverses, gray holds', () => {
  assert.deepEqual(decideOrb(base).action, 'enter');
  assert.equal(decideOrb({ ...base, position: { side: 'LONG', entry: 100 } }).action, 'none');
  const r = decideOrb({ ...base, signal: 'BEAR', position: { side: 'LONG', entry: 100 } });
  assert.equal(r.action, 'reverse');
  assert.equal(r.action === 'reverse' && r.side, 'SHORT');
  assert.equal(decideOrb({ ...base, signal: 'NEUTRAL', position: { side: 'SHORT', entry: 100 } }).action, 'none');
});

test('decideOrb: one bar acts once', () => {
  assert.equal(decideOrb({ ...base, watermarkT: 1000 }).action, 'none');
  assert.equal(decideOrb({ ...base, watermarkT: 1000, signal: 'BEAR', position: { side: 'LONG', entry: 100 } }).action, 'none');
});

test('decideOrb: stop and cutoff exit even on an old bar; no quote skips the stop', () => {
  const pos = { side: 'LONG' as const, entry: 100 };
  const s = decideOrb({ ...base, watermarkT: 1000, position: pos, price: 69 });
  assert.equal(s.action === 'exit' && s.kind, 'stop');
  assert.equal(decideOrb({ ...base, watermarkT: 1000, position: pos, price: null }).action, 'none');
  const e = decideOrb({ ...base, watermarkT: 1000, position: pos, price: null, minute: 23 * 60 });
  assert.equal(e.action === 'exit' && e.kind, 'eod');
  const short = decideOrb({ ...base, position: { side: 'SHORT', entry: 100 }, signal: 'BEAR', price: 131 });
  assert.equal(short.action, 'exit');
});

test('decideOrb: entry window and stop-out block', () => {
  assert.equal(decideOrb({ ...base, minute: 9 * 60 }).action, 'none');
  assert.equal(decideOrb({ ...base, minute: 22 * 60 + 45 }).action, 'none');
  assert.equal(decideOrb({ ...base, blockedSide: 'LONG' }).action, 'none');
  assert.equal(decideOrb({ ...base, blockedSide: 'LONG', signal: 'BEAR' }).action, 'enter');
  assert.equal(nextBlock('LONG', 'BULL'), 'LONG');
  assert.equal(nextBlock('LONG', 'NEUTRAL'), null);
});

test('sanitizeSpec bounds and rejects', () => {
  assert.equal(sanitizeSpec({ id: 'bad id!', kind: 'ema', period: 9 }), null);
  assert.equal(sanitizeSpec({ id: 'a', kind: 'macd' }), null);
  assert.deepEqual(sanitizeSpec({ id: 'a', kind: 'ema', period: 9999 }), { id: 'a', kind: 'ema', period: 9 });
  assert.deepEqual(sanitizeSpec({ id: 'x', kind: 'emaCross', fast: 30, slow: 10 }), defaultSpec('emaCross', 'x'));
});

test('VWAP: price above the session VWAP votes bull, below bear; it resets each IST day; no volume = no vote', () => {
  const vw = defaultSpec('vwap', 'v');
  assert.deepEqual(sanitizeSpec({ id: 'v', kind: 'vwap', junk: 1 }), vw);
  assert.equal(readIndicator(vw, series(up)).vote, 1);
  assert.equal(readIndicator(vw, series(down)).vote, -1);
  // hlc3 x volume: two bars (hlc3 100 x 1, 110 x 3) -> 107.5
  const t0 = Date.UTC(2026, 10, 18, 4, 0) / 1000;
  const two: OrbBar[] = [{ t: t0, close: 100, high: 100, low: 100, vol: 1 }, { t: t0 + 60, close: 110, high: 110, low: 110, vol: 3 }];
  const r = readIndicator(vw, two);
  assert.equal(r.value, '107.50');
  assert.equal(r.vote, 1);
  // next IST day: the sums restart, so one bar at 90 is its own VWAP (no vote), not below yesterday's 107.5
  const next = [...two, { t: t0 + 86_400, close: 90, high: 90, low: 90, vol: 5 }];
  const n = readIndicator(vw, next);
  assert.equal(n.value, '90.00');
  assert.equal(n.vote, 0);
  // a session with no volume at all has no VWAP
  const flat = series(up).map(b => ({ ...b, vol: 0 }));
  const z = readIndicator(vw, flat);
  assert.equal(z.vote, 0);
  assert.equal(z.value, 'no volume');
});

test('closedBars sums the 1-minute volume into each bucket', () => {
  const t0 = 1_700_000_100 - (1_700_000_100 % 300);
  const m = [0, 1, 2, 3, 4].map(i => ({ t: t0 + i * 60, straddle: 100 + i, vol: 10 }));
  const out = closedBars(m, 5, t0 + 600);
  assert.equal(out.length, 1);
  assert.equal(out[0].vol, 50);
  assert.equal(closedBars([{ t: t0, straddle: 100 }], 1, t0 + 60)[0].vol, 0);
});

test('rowPnl: futures by side; a sold option gains as the premium falls, whatever the signal side', () => {
  const fut = { kind: 'futures' };
  const opt = { kind: 'options' };
  assert.equal(rowPnl({ side: 'SHORT', entry: 6000, lots: 1, unitsPerLot: 100, target: fut }, 5990), 1000);
  assert.equal(rowPnl({ side: 'LONG', entry: 50, lots: 2, unitsPerLot: 100, target: opt }, 40), 2000);
  assert.equal(rowPnl({ side: 'SHORT', entry: 50, lots: 1, unitsPerLot: 10, target: opt }, 60), -100);
});

test('positionPnl: points x barrels x lots', () => {
  assert.equal(positionPnl('LONG', 6000, 6010, 1, 10), 100);
  assert.equal(positionPnl('SHORT', 6000, 6010, 2, 10), -200);
});

test('closedBars carries the true range through resampling; a bad or missing range falls back to the close', () => {
  const t0 = 1_700_000_100 - (1_700_000_100 % 300);
  const m = [
    { t: t0, straddle: 100, h: 104, l: 99 },
    { t: t0 + 60, straddle: 102, h: 103, l: 95 },
    { t: t0 + 120, straddle: 101 },                 // no range
    { t: t0 + 180, straddle: 103, h: 102, l: 101 }, // close outside its range: not trusted
    { t: t0 + 240, straddle: 100, h: 100, l: 100 },
  ];
  const [b] = closedBars(m, 5, t0 + 300);
  assert.deepEqual(b, { t: t0, close: 100, high: 104, low: 95, vol: 0 });
  const one = closedBars(m, 1, t0 + 300);
  assert.equal(one[2].high, 101);
  assert.equal(one[3].high, 103);
  assert.equal(one[3].low, 103);
});

test('evaluate reports when the current colour began', () => {
  const spec = [defaultSpec('ema', 'e')];
  const ev = evaluate(spec, series([...down.slice(0, 30), ...up.slice(0, 30).map(x => x + 100)]));
  assert.equal(ev.signal, 'BULL');
  assert.ok(ev.sinceT !== null);
});

test('replay: a steady trend enters once and books the move; a reversal counts two orders', () => {
  // 09:30 IST on one day, 1-minute bars
  const t0 = Date.UTC(2026, 10, 18, 4, 0) / 1000;
  const bars = [...up, ...down].map((c, i) => ({ t: t0 + i * 60, close: c, high: c + 0.5, low: c - 0.5, vol: 10 }));
  const r = replay([defaultSpec('ema', 'e')], bars, { times: { entryStart: '09:15', entryEnd: '22:45', eodExit: '23:00' }, stopPts: 0, lots: 1, unitsPerLot: 10 });
  assert.ok(r);
  assert.equal(r!.sessions, 1);
  assert.equal(r!.ordersPerDay, 3);             // enter long, then reverse to short (close + open)
  assert.ok(r!.days[0].points > 0);
  assert.equal(r!.rupeesPerDay, r!.pointsPerDay * 10);
  assert.equal(replay([], bars, { times: { entryStart: '09:15', entryEnd: '22:45', eodExit: '23:00' }, stopPts: 0, lots: 1, unitsPerLot: 10 }), null);
});

test('closedBars: hourly bars start on the IST hour (09:00, 10:00 ...), as TradingView draws MCX', () => {
  const t0 = Date.UTC(2026, 10, 19, 3, 30) / 1000;          // 09:00 IST
  const m = Array.from({ length: 130 }, (_, i) => ({ t: t0 + i * 60, straddle: 100 + i, h: 101 + i, l: 99 + i }));
  const h = closedBars(m, 60, t0 + 130 * 60);
  assert.equal(h.length, 2);
  assert.equal(h[0].t, t0);                                   // 09:00-09:59
  assert.equal(h[1].t, t0 + 3600);                            // 10:00-10:59
  assert.deepEqual([h[0].high, h[0].low, h[0].close], [160, 99, 159]);
  assert.equal(closedBars(m, 15, t0 + 130 * 60)[0].t, t0);    // 15m on the same grid
});
