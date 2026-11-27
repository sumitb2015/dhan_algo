import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCandleColorRule, trendStates } from './indexScalperCandleColor.ts';
import type { Bar } from './indexScalperIndicators.ts';

const bar = (i: number, c: number): Bar => ({ t: i * 60, o: c, h: c, l: c, c });

test('off returns null', () => {
  assert.equal(trendStates([bar(0, 1)], 'off'), null);
});

test('warm-up bars (no EMA 20 yet) are null', () => {
  const bars = Array.from({ length: 25 }, (_, i) => bar(i, 100 + i));
  const s = trendStates(bars, 'ema9_20')!;
  assert.equal(s.length, 25);
  for (let i = 0; i < 19; i++) assert.equal(s[i], null);
  assert.notEqual(s[19], null);
});

test('rising closes above both EMAs = bull, falling below both = bear', () => {
  const up = Array.from({ length: 40 }, (_, i) => bar(i, 100 + i));
  assert.equal(trendStates(up, 'ema9_20')!.at(-1), 'bull');
  const down = Array.from({ length: 40 }, (_, i) => bar(i, 200 - i));
  assert.equal(trendStates(down, 'ema9_20')!.at(-1), 'bear');
});

test('close between EMA 9 and EMA 20 = neutral', () => {
  // Long rise then a sharp drop: close falls under the fast EMA 9 but stays above the slower EMA 20.
  const bars = Array.from({ length: 40 }, (_, i) => bar(i, 100 + i));
  bars.push(bar(40, 133));
  const s = trendStates(bars, 'ema9_20')!;
  assert.equal(s.at(-1), 'neutral');
});

test('unknown saved value falls back to off', () => {
  assert.equal(parseCandleColorRule('nope'), 'off');
  assert.equal(parseCandleColorRule(null), 'off');
  assert.equal(parseCandleColorRule('ema9_20'), 'ema9_20');
});
