import test from 'node:test';
import assert from 'node:assert/strict';
import { stochRsiArray } from './indicators.ts';
import {
  closedBars, consensus, decideOrb, defaultSpec, evaluate, nextBlock, positionPnl, readIndicator, sanitizeSpec, type DecideInput, type OrbBar,
} from './signalOrb.ts';

const series = (closes: number[], t0 = 1_700_000_000 - (1_700_000_000 % 300)): OrbBar[] => closes.map((c, i) => ({ t: t0 + i * 60, close: c }));
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
  const t = stochRsiArray(up, 14, 14, 3, 3);
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

test('positionPnl: points x barrels x lots', () => {
  assert.equal(positionPnl('LONG', 6000, 6010, 1, 10), 100);
  assert.equal(positionPnl('SHORT', 6000, 6010, 2, 10), -200);
});
