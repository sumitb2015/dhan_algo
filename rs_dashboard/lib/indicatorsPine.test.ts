import test from 'node:test';
import assert from 'node:assert/strict';
import { stochRsiArray, supertrendSeries } from './indicators.ts';

// A deterministic wandering series with flat stretches.
function series(n: number) {
  let x = 7800, seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  return Array.from({ length: n }, (_, i) => {
    if (i % 97 < 6) return { high: Math.round(x), low: Math.round(x), close: Math.round(x) };
    x += (rnd() - 0.5) * 8;
    const c = Math.round(x);
    return { high: c + Math.round(rnd() * 5), low: c - Math.round(rnd() * 5), close: c };
  });
}
const checksum = (st: { line: number | null; dir: number | null }[]) => st.reduce((s, x, i) => s + (x.line ?? 0) * ((i % 13) + 1) + (x.dir ?? 0) * i, 0);

test('supertrend default path is unchanged by the pine mode (checksum pinned from the committed implementation)', () => {
  const st = supertrendSeries(series(2000), 10, 2);
  assert.equal(st[9].line, null);
  assert.notEqual(st[10].line, null);                  // default: first value on bar `period`
  // computed with git HEAD's lib/indicators.ts (before the pine mode existed) on 2026-11-19
  assert.equal(Math.round(checksum(st) * 1e6) / 1e6, 107793591.925464);
});

test('pine supertrend: first value on bar period-1, starting DOWN, ATR seeded from TR[0..n-1]', () => {
  const rows = [{ high: 10, low: 8, close: 9 }, { high: 11, low: 9, close: 10 }, { high: 12, low: 10, close: 11 }];
  const st = supertrendSeries(rows, 3, 1, { pine: true });
  assert.equal(st[1].line, null);
  // TR = [2, 2, 2] -> ATR 2 on bar 2; hl2 = 11; a DOWN start shows the upper band, 11 + 1 x 2
  assert.deepEqual(st[2], { line: 13, dir: -1 });
});

test('pine supertrend: a close between CROSSED bands flips up -> down, as TradingView does (the default path stays up)', () => {
  // Shape of CRUDEOILM 2026-09-08 11:04: a long flat stretch shrinks ATR, then a dip bar ratchets the upper band below the held lower one.
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => ({ high: 71 + i, low: 69 + i, close: 70 + i })),
    ...Array.from({ length: 40 }, () => ({ high: 100, low: 100, close: 100 })),
    { high: 100, low: 90, close: 99 },
  ];
  const p = supertrendSeries(rows, 10, 2, { pine: true }), d = supertrendSeries(rows, 10, 2);
  const n = rows.length - 1;
  assert.equal(p[n - 1].dir, 1);
  assert.ok(p[n].line! < 99 && 99 < p[n - 1].line!);   // upper < close < held lower: crossed
  assert.equal(p[n].dir, -1);
  assert.equal(d[n].dir, 1);
});

test('stoch RSI: a flat RSI window is null (Pine x / 0 = na), and so are K / D over it', () => {
  const closes = [...Array.from({ length: 20 }, (_, i) => 100 + (i % 3)), ...Array.from({ length: 30 }, () => 119)];
  const s = stochRsiArray(closes, 3, 3, 1, 1);
  assert.equal(s.k[49], null);                         // RSI(3) is constant through the flat tail
  assert.equal(s.d[49], null);
  assert.notEqual(s.k[18], null);                      // the choppy part has values
});
