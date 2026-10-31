import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPnf, detectSignals, type Bar } from './straddlePnf.ts';
import { detectTriangles, newTriangleBreakouts } from './pnfTriangle.ts';

const BASE_T = Date.UTC(2026, 9, 23, 3, 45) / 1000;
const A = 100;
const BOX = A * 0.005;
const priceAt = (l: number) => A + l * BOX;
const barsFromLevels = (levels: number[]): Bar[] => levels.map((l, i) => ({ t: BASE_T + i * 60, ce: priceAt(l) / 2, pe: priceAt(l) / 2, straddle: priceAt(l), vol: 1 }));
/** Columns, signals and the box for a path of box labels (the same fixtures as straddlePnf.test.ts). */
function chart(levels: number[]) {
  const bars = barsFromLevels(levels);
  const { columns, box } = buildPnf(bars);
  const signals = detectSignals(columns, bars, bars.map(() => 0));
  return { columns, signals, box, bars };
}
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !~ ${b}`);

// X[1..10] -> O[3..9] -> X[4..9] -> O[5..8] -> X[..10]: four nested columns, then a column that breaks above the last X top (label 9)
const BULL = [0, 10, 3, 9, 5, 10];
// the mirror image
const BEAR = [0, -10, -3, -9, -5, -10];

test('a 4-column triangle that breaks up: entry at the DTB trigger, stop at the DBS trigger, vertical-count target', () => {
  const { columns, signals, box } = chart(BULL);
  assert.equal(columns.length, 5);
  const tris = detectTriangles(columns, signals, box, 3, 3);
  assert.equal(tris.length, 1);
  const t = tris[0];
  assert.deepEqual([t.startCol, t.endCol, t.nCols, t.state], [0, 3, 4, 'up']);
  near(t.buyAbove, priceAt(10));                         // one box above the last X top (label 9)
  near(t.sellBelow, priceAt(4));                         // one box below the last O bottom (label 5)
  assert.ok(t.breakout);
  assert.equal(t.breakout.side, 'UP');
  assert.equal(t.breakout.col, 4);
  near(t.breakout.entry, t.buyAbove);
  near(t.breakout.stop, t.sellBelow);
  // breakout column: an X starts one box above the last O bottom (label 6) and had drawn 6..10 = 5 boxes when it broke:
  // vertical count = 5 boxes x reversal 3 = 15 boxes from its bottom glyph -> label 21
  near(t.breakout.target, priceAt(6 + 5 * 3));
  near(t.breakout.rr, (21 - 10) / (10 - 4));
});

test('the mirrored path is a bearish breakdown', () => {
  const { columns, signals, box } = chart(BEAR);
  const [t] = detectTriangles(columns, signals, box, 3, 3);
  assert.equal(t.state, 'down');
  assert.equal(t.breakout?.side, 'DOWN');
  assert.ok(t.breakout && t.breakout.target < t.breakout.entry && t.breakout.stop > t.breakout.entry);
});

test('minimum columns: a 4-column triangle is ignored when 5 are required', () => {
  const { columns, signals, box } = chart(BULL);
  assert.equal(detectTriangles(columns, signals, box, 3, 4).length, 1);
  assert.equal(detectTriangles(columns, signals, box, 3, 5).length, 0);
});

test('a triangle that reaches the last confirmed column is still forming and has no breakout yet', () => {
  const { columns, signals, box } = chart([0, 10, 3, 9, 5]);
  const [t] = detectTriangles(columns, signals, box, 3, 3);
  assert.equal(t.state, 'forming');
  assert.equal(t.breakout, undefined);
  assert.equal(t.nCols, 4);
});

test('a column that pokes outside its parent ends the run; two nested columns are not a triangle', () => {
  // X[1..10] -> O[3..9] -> X[4..11]: the third column tops the first, so only two columns nest
  const { columns, signals, box } = chart([0, 10, 3, 11]);
  assert.equal(detectTriangles(columns, signals, box, 3, 3).length, 0);
});

test('a triangle whose next column does not break the previous same-side extreme ends without a breakout', () => {
  // ... O[5..8] then X up to label 9 only (equal to the last X top, not above it): no DOUBLE_TOP_BUY
  const { columns, signals, box } = chart([0, 10, 3, 9, 5, 9]);
  const [t] = detectTriangles(columns, signals, box, 3, 3);
  assert.equal(t.state, 'ended');
  assert.equal(t.breakout, undefined);
});

test('newTriangleBreakouts: only breakouts after the watermark, once', () => {
  const { columns, signals, box, bars } = chart(BULL);
  const tris = detectTriangles(columns, signals, box, 3, 3);
  const t = tris[0].breakout!.t;
  assert.equal(newTriangleBreakouts(tris, t - 1).length, 1);
  assert.equal(newTriangleBreakouts(tris, t).length, 0);
  assert.equal(newTriangleBreakouts(tris, bars[bars.length - 1].t).length, 0);
});

test('triangles never touch the signals (AUTO reads them)', () => {
  const { columns, signals, box } = chart(BULL);
  const before = JSON.stringify(signals);
  detectTriangles(columns, signals, box, 3, 3);
  assert.equal(JSON.stringify(signals), before);
});
