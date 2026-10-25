import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPnf, detectSignals, vwap, sma, exitTags, sessionOf, type Bar } from './straddlePnf.ts';

const BASE_T = Date.UTC(2026, 9, 23, 3, 45) / 1000; // 2026-10-23 09:15 IST
const A = 100;
const BOX = A * 0.005;

/** One bar per box label; label 0 is the anchor price itself. */
function priceAt(level: number): number {
  return A + level * BOX; // exactly on a box label: an X (floor) and an O (ceil) both land on `level`
}
function barsFromLevels(levels: number[]): Bar[] {
  return levels.map((l, i) => {
    const s = priceAt(l);
    return { t: BASE_T + i * 60, ce: s / 2, pe: s / 2, straddle: s, vol: 1 };
  });
}
// X[1..5] -> O[0..4] -> X[1..7] (breaks the first X top) -> O[-1..6] (breaks the first O bottom)
const PATH = [0, 5, 2, 0, 3, 7, 4, -1];

test('box is 0.5% of the first straddle price', () => {
  const { box } = buildPnf(barsFromLevels([0, 1]));
  assert.ok(Math.abs(box - BOX) < 1e-9);
});

test('a one-box rise from the anchor prints a single X', () => {
  const { columns } = buildPnf(barsFromLevels([0, 1]));
  assert.equal(columns.length, 1);
  assert.equal(columns[0].dir, 'X');
  assert.equal(columns[0].boxes, 1);
});

test('a 2-box pullback does not reverse an X column, a 3-box pullback does', () => {
  assert.equal(buildPnf(barsFromLevels([0, 5, 3])).columns.length, 1);
  const { columns } = buildPnf(barsFromLevels([0, 5, 2]));
  assert.equal(columns.length, 2);
  assert.equal(columns[1].dir, 'O');
  assert.equal(columns[1].boxes, 3); // starts one box below the X top
});

test('builds the X/O/X/O column list for the reference path', () => {
  const { columns } = buildPnf(barsFromLevels(PATH));
  assert.deepEqual(columns.map(c => [c.dir, c.boxes, c.startBar, c.endBar]), [
    ['X', 5, 1, 1], ['O', 5, 2, 3], ['X', 7, 4, 5], ['O', 8, 6, 7],
  ]);
  // glyph cells are centred on their label: boxes 1..5 span [A + 0.5 box, A + 5.5 box]
  assert.ok(Math.abs(columns[0].low - (A + 0.5 * BOX)) < 1e-9);
  assert.ok(Math.abs(columns[0].high - (A + 5.5 * BOX)) < 1e-9);
  assert.equal(columns[0].session, '2026-10-23');
});

test('reference path yields one double top buy and one double bottom sell', () => {
  const bars = barsFromLevels(PATH);
  const { columns } = buildPnf(bars);
  const below = bars.map(() => A + 100); // VWAP far above price
  const sigs = detectSignals(columns, bars, below);
  assert.deepEqual(sigs.map(s => [s.id, s.kind, s.col, s.bar]), [
    ['DOUBLE_TOP_BUY:2', 'DOUBLE_TOP_BUY', 2, 5],
    ['DOUBLE_BOTTOM_SELL:3', 'DOUBLE_BOTTOM_SELL', 3, 7],
  ]);
  assert.equal(sigs[1].belowVwap, true);
  assert.equal(sigs[1].t, bars[7].t);
  assert.ok(Math.abs(sigs[1].price - bars[7].straddle) < 1e-9);
});

test('belowVwap is false when price is above VWAP, and null VWAP is not below', () => {
  const bars = barsFromLevels(PATH);
  const { columns } = buildPnf(bars);
  const above = detectSignals(columns, bars, bars.map(() => 1));
  assert.equal(above[1].belowVwap, false);
  const none = detectSignals(columns, bars, bars.map(() => null));
  assert.equal(none[1].belowVwap, false);
});

test('signal ids of already-closed columns are stable when more bars arrive', () => {
  const bars = barsFromLevels(PATH);
  const shortIds = detectSignals(buildPnf(bars).columns, bars, bars.map(() => null)).map(s => s.id);
  const longer = barsFromLevels([...PATH, -2, -3]);
  const longIds = detectSignals(buildPnf(longer).columns, longer, longer.map(() => null)).map(s => s.id);
  assert.deepEqual(longIds, shortIds);
});

test('exitTags marks the first bar of each green X column that trades above VWAP', () => {
  const bars = barsFromLevels(PATH);
  const { columns } = buildPnf(bars);
  const tags = exitTags(columns, bars, bars.map(() => priceAt(1)));
  assert.deepEqual(tags, [{ col: 0, bar: 1 }, { col: 2, bar: 4 }]);
});

test('vwap is cumulative volume-weighted and falls back to the cumulative mean without volume', () => {
  const mk = (straddle: number, vol: number): Bar => ({ t: 0, ce: 0, pe: 0, straddle, vol });
  assert.deepEqual(vwap([mk(100, 10), mk(110, 30)]), [100, 107.5]);
  assert.deepEqual(vwap([mk(100, 0), mk(110, 0)]), [100, 105]);
});

test('sma(10) is null for the first nine values', () => {
  const out = sma([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 10);
  assert.deepEqual(out.slice(0, 9), Array(9).fill(null));
  assert.equal(out[9], 5.5);
  assert.equal(out[10], 6.5);
});

test('bars with a zero straddle are skipped: no column and no NaN box', () => {
  const zero: Bar = { t: BASE_T, ce: 0, pe: 0, straddle: 0, vol: 0 };
  const empty = buildPnf([zero, { ...zero, t: BASE_T + 60 }]);
  assert.equal(empty.columns.length, 0);
  assert.ok(Number.isFinite(empty.box));
  const bars = barsFromLevels([0, 2]);
  const mixed = buildPnf([bars[0], { ...zero, t: BASE_T + 30 }, bars[1]]);
  assert.equal(mixed.columns.length, 1);
  assert.equal(mixed.columns[0].boxes, 2);
});

test('a single bar jumping five boxes fills five boxes in one column', () => {
  const { columns } = buildPnf(barsFromLevels([0, 5]));
  assert.equal(columns.length, 1);
  assert.equal(columns[0].boxes, 5);
});

test('sessionOf returns the IST calendar date', () => {
  assert.equal(sessionOf(BASE_T), '2026-10-23');
  assert.equal(sessionOf(Date.UTC(2026, 9, 23, 23, 0) / 1000), '2026-10-24'); // 04:30 IST next day
});

// A column must sit on the box its price belongs to: at its last bar an X column's price is in [label, label+1 box) of its top
// box and an O column's price is in (label-1 box, label] of its bottom box; cells are centred on the label, so the end edge is
// within half a box of the price either way.
function assertColumnsMatchPrices(bars: Bar[]) {
  const { box, columns } = buildPnf(bars);
  const eps = 1e-6;
  columns.forEach((c, i) => {
    const p = bars[c.endBar].straddle;
    if (c.dir === 'X') {
      const top = c.high - 0.5 * box; // label of the top box
      assert.ok(p >= top - eps && p < top + box + eps, `X col ${i}: price ${p} not in [${top}, ${top + box})`);
    } else {
      const bottom = c.low + 0.5 * box; // label of the bottom box
      assert.ok(p > bottom - box - eps && p <= bottom + eps, `O col ${i}: price ${p} not in (${bottom - box}, ${bottom}]`);
    }
    if (i > 0) assert.notEqual(c.dir, columns[i - 1].dir);
  });
}

test('columns match their prices on a decaying series that crosses and stays below the anchor', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const bars: Bar[] = [];
  let p = A;
  for (let i = 0; i < 600; i++) {
    p = Math.max(1, p + (rnd() - 0.56) * BOX * 2.2);
    const s = i === 0 ? A : p;
    bars.push({ t: BASE_T + i * 60, ce: s / 2, pe: s / 2, straddle: s, vol: 1 });
  }
  assertColumnsMatchPrices(bars);
});

const at = (...prices: number[]): Bar[] => prices.map((s, i) => ({ t: BASE_T + i * 60, ce: s / 2, pe: s / 2, straddle: s, vol: 1 }));

test('a fall through the anchor and a rebound back over it keeps the grid continuous', () => {
  const bars = at(A, A - 3.5 * BOX, A + 2.5 * BOX);
  const { columns } = buildPnf(bars);
  assert.deepEqual(columns.map(c => [c.dir, c.boxes]), [['O', 3], ['X', 5]]); // boxes -1..-3, then -2..2
  assertColumnsMatchPrices(bars);
});

test('3-box reversal is measured from the top box label: peak 110.00, box 0.5', () => {
  const top = 110; // box label 20 above the anchor 100
  assert.equal(buildPnf(at(100, top, 108.95)).columns.length, 1); // only 2.1 boxes down: no reversal
  assert.equal(buildPnf(at(100, top, 108.6)).columns.length, 1);
  const rev = buildPnf(at(100, top, 108.5)).columns;               // exactly 3 boxes down
  assert.deepEqual(rev.map(c => c.dir), ['X', 'O']);
  assert.equal(rev[1].boxes, 3);                                   // O fills labels 19.5, 19, 18.5... i.e. one box under the top down to the close
});

test('3-box reversal below the anchor: trough 90.00, box 0.5', () => {
  const bars = (last: number) => at(100, 90, last);
  assert.equal(buildPnf(bars(91.05)).columns.length, 1);           // 2.1 boxes up: no reversal
  const rev = buildPnf(bars(91.5)).columns;                        // exactly 3 boxes up
  assert.deepEqual(rev.map(c => c.dir), ['O', 'X']);
});

test('buildPnf exposes the anchor price the box is a percentage of', () => {
  const r = buildPnf(at(200, 201));
  assert.equal(r.anchor, 200);
  assert.equal(r.box, 1);
});
