import test from 'node:test';
import assert from 'node:assert/strict';
import { minToHm, resampleBars, resampleFast } from './bars.ts';
import type { Bar } from './types.ts';

function session(day: string, seed: number): Bar[] {
  const out: Bar[] = [];
  let px = 100 + seed;
  for (let m = 9 * 60 + 15; m <= 15 * 60 + 29; m++) {
    px += Math.sin(m * (seed + 1)) * 2;
    out.push({ t: `${day} ${minToHm(m)}:00`, o: px, h: px + 1, l: px - 1, c: px + 0.5, v: m % 7 });
  }
  return out;
}

test('resampleFast matches resampleBars for every prefix (incremental path) and every timeframe', () => {
  const bars = [...session('2026-10-13', 1), ...session('2026-10-14', 2)];
  for (const tf of [1, 3, 5, 15]) {
    for (const n of [1, 2, 7, 100, 376, 377, 500, bars.length]) {
      assert.deepEqual(resampleFast(bars.slice(0, n), tf), resampleBars(bars.slice(0, n), tf), `tf ${tf} n ${n}`);
    }
  }
});

test('resampleFast: earlier results are not mutated by later calls', () => {
  const bars = session('2026-10-14', 3);
  const a = resampleFast(bars.slice(0, 12), 5);
  const snapshot = JSON.stringify(a);
  resampleFast(bars.slice(0, 14), 5);
  assert.equal(JSON.stringify(a), snapshot);
});

test('resampleFast: a different array of equal-looking bars recomputes', () => {
  const bars = session('2026-10-14', 4);
  resampleFast(bars.slice(0, 20), 5);
  const changed = bars.map((b) => ({ ...b, c: b.c + 1 }));
  assert.deepEqual(resampleFast(changed.slice(0, 20), 5), resampleBars(changed.slice(0, 20), 5));
});
