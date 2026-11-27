import test from 'node:test';
import assert from 'node:assert/strict';
import { closedBars, closedKey, mtfSummary, mtfText, trendRead, type TrendRead } from './indexScalperTrend.ts';
import type { Bar } from './indexScalperIndicators.ts';

// 5-min bars from Thursday 2026-11-26 09:15 IST (03:45 UTC). `path(i)` = the close of bar i.
const T0 = Date.parse('2026-11-26T03:45:00Z') / 1000;
const mk = (n: number, path: (i: number) => number, wick = 6): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const c = path(i), o = i ? path(i - 1) : c;
    return { t: T0 + i * 300, o, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, c };
  });

const up = mk(70, i => 25000 + i * 8 + (i % 3 === 0 ? -3 : 0));
const down = mk(70, i => 26000 - i * 8 + (i % 3 === 0 ? 3 : 0));

test('steady uptrend: every light up, BULLISH, Strong', () => {
  const r = trendRead(up)!;
  assert.equal(r.vwap.dir, 1);
  assert.equal(r.ema.dir, 1);
  assert.equal(r.st.dir, 1);
  assert.equal(r.adx.dir, 1);
  assert.equal(r.bias, 'bull');
  assert.ok(r.adx.adx! >= 25);
  assert.equal(r.strength, 'strong');
  assert.equal(r.t, up[69].t);
  assert.equal(r.close, up[69].c);
});

test('steady downtrend: BEARISH, Strong', () => {
  const r = trendRead(down)!;
  assert.deepEqual([r.vwap.dir, r.ema.dir, r.st.dir, r.adx.dir], [-1, -1, -1, -1]);
  assert.equal(r.bias, 'bear');
  assert.equal(r.strength, 'strong');
});

test('a zig-zag range: Choppy, and the lights disagree (Mixed) somewhere along it', () => {
  // a sideways swing (±30 pts every 8 bars): ADX ~10, and the bias flips bar to bar while Choppy flags it
  const range = (n: number) => trendRead(mk(n, i => 25000 + Math.sin(i * Math.PI / 4) * 30))!;
  for (const n of [80, 81, 83]) { assert.equal(range(n).strength, 'choppy'); assert.ok(range(n).adx.adx! < 20); }
  assert.deepEqual([80, 81, 83].map(n => range(n).bias), ['bear', 'mixed', 'bull']);
  // an uptrend that just turned down: Supertrend has flipped, VWAP and EMA 9/20 still up -> Mixed (and Bearish later)
  const turn = (n: number) => trendRead(mk(n, i => (i < 50 ? 25000 + i * 10 : 25500 - (i - 49) * 25)))!;
  const t = turn(54);
  assert.deepEqual([t.vwap.dir, t.ema.dir, t.st.dir, t.bias], [1, 1, -1, 'mixed']);
  assert.equal(turn(60).bias, 'bear');
});

test('warm-up: too few bars for EMA 20 / Supertrend gives no bias, never a guess', () => {
  const r = trendRead(up.slice(0, 5))!;
  assert.equal(r.bias, null);
  assert.equal(r.ema.dir, null);
  assert.equal(r.adx.adx, null);
  assert.equal(r.strength, null);
  assert.equal(trendRead([]), null);
});

test('closedBars: the forming bar is dropped; after hours every bar is closed', () => {
  const last = up[69];
  assert.equal(closedBars(up, 5, last.t + 120).length, 69);   // 2 minutes into the last 5-min bar
  assert.equal(closedBars(up, 5, last.t + 300), up);           // the bar has ended: same array
  assert.deepEqual(closedBars([], 5, 0), []);
});

test('closedKey changes only when the closed tail changes', () => {
  assert.equal(closedKey(up), closedKey(up.slice()));
  assert.notEqual(closedKey(up), closedKey(up.slice(0, -1)));
  assert.equal(closedKey([]), '');
});

test('mtfSummary / mtfText: alignment and counts', () => {
  const r = (bias: TrendRead['bias']) => ({ bias } as TrendRead);
  const all = mtfSummary([r('bull'), r('bull'), r('bull'), r('bull')]);
  assert.equal(all.aligned, 'bull');
  assert.equal(mtfText(all), '4/4 bull ALIGNED');
  assert.equal(mtfText(mtfSummary([r('bull'), r('bull'), r('bull'), null])), '3/4 bull');
  assert.equal(mtfSummary([r('bull'), r('bull'), r('bull'), null]).aligned, null); // one frame unknown: not aligned
  assert.equal(mtfText(mtfSummary([r('bull'), r('bear'), r('bull'), r('bear')])), '2 bull · 2 bear');
  assert.equal(mtfText(mtfSummary([r('bear'), r('mixed'), r('mixed'), r('bull')])), '1 bull · 1 bear · 2 mixed');
  assert.equal(mtfText(mtfSummary([null, null])), '—');
  assert.equal(mtfSummary([r('bear'), r('bear')]).aligned, 'bear');
});
