import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPnf, detectSignals, vwap, sma, exitTags, sessionOf, type Bar } from './straddlePnf.ts';

const BASE_T = Date.UTC(2026, 9, 23, 3, 45) / 1000; // 2026-10-23 09:15 IST
const A = 100;
const BOX = A * 0.005;

/** One bar per level: level 0 is the anchor price itself, others sit 0.3 of a box inside their level. */
function priceAt(level: number): number {
  const frac = level > 0 ? 0.3 : level < 0 ? -0.3 : 0;
  return A + (level + frac) * BOX;
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
  assert.ok(Math.abs(columns[0].low - (A + 1 * BOX)) < 1e-9);
  assert.ok(Math.abs(columns[0].high - (A + 6 * BOX)) < 1e-9);
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
