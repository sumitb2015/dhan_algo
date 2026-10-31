import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutPanel, AXIS_W, MIN_CELL, MAX_CELL, PAD_TOP } from './straddlePnfLayout.ts';

const col = (low: number, high: number) => ({ low, high });
const BOX = 2;

test('few columns: the plot fills the panel, the columns are right-aligned against the axis, no horizontal scroll', () => {
  const l = layoutPanel([col(100, 110), col(104, 112)], BOX, null, 600, 440);
  assert.equal(l.plotW, 600 - AXIS_W);
  assert.equal(l.contentW, 600);
  assert.equal(l.offsetX, l.plotW - 2 * l.cell);
});

test('many columns: nothing is dropped, the content is wider than the view and starts at the first column', () => {
  const columns = Array.from({ length: 300 }, (_, i) => col(100 + (i % 7) * BOX, 120 + (i % 7) * BOX));
  const l = layoutPanel(columns, BOX, null, 600, 440);
  assert.ok(l.contentW > 600);
  assert.equal(l.plotW, 300 * l.cell);
  assert.equal(l.offsetX, 0);
});

test('the cell never shrinks below the minimum, even for a huge price range (the chart scrolls vertically instead)', () => {
  const l = layoutPanel([col(100, 100 + 400 * BOX)], BOX, null, 600, 440);
  assert.equal(l.cell, MIN_CELL);
  assert.ok(l.contentH > 440);
});

test('the cell never grows past the maximum for a tiny range', () => {
  assert.equal(layoutPanel([col(100, 102)], BOX, null, 600, 440).cell, MAX_CELL);
});

test('the y range covers every column and the live price, with room for markers', () => {
  const l = layoutPanel([col(100, 110), col(95, 105)], BOX, 130, 600, 440);
  assert.ok(l.yMin <= 95 - BOX + 1e-9);
  assert.ok(l.yMax >= 130 + 2 * BOX - 1e-9);
  assert.equal(l.rows, Math.ceil((l.yMax - l.yMin) / BOX) + 1);
});

test('the content is at least as tall as the view and at least as tall as its rows', () => {
  const l = layoutPanel([col(100, 110)], BOX, null, 600, 440);
  assert.equal(l.contentH, 440);
  const tall = layoutPanel([col(100, 100 + 100 * BOX)], BOX, null, 600, 440);
  assert.ok(tall.contentH >= PAD_TOP + tall.rows * tall.cell);
});

test('no columns still gives a usable layout', () => {
  const l = layoutPanel([], BOX, null, 600, 440);
  assert.equal(l.plotW, 600 - AXIS_W);
  assert.ok(Number.isFinite(l.cell));
});

test('a small chart grows to fill the panel: the cell is limited by the view height, not by a small fixed maximum', () => {
  const columns = Array.from({ length: 18 }, (_, i) => col(100 + (i % 3) * BOX, 108 + (i % 3) * BOX));
  const l = layoutPanel(columns, BOX, null, 1500, 560);
  assert.ok(l.cell > 14);
  assert.ok(l.cell <= MAX_CELL);
  assert.ok(PAD_TOP + l.rows * l.cell <= 560);               // all rows fit the height at the fitted size
});

test('a chart with many columns is narrowed to fit the width before it scrolls, never below the minimum', () => {
  const columns = Array.from({ length: 60 }, (_, i) => col(100 + (i % 3) * BOX, 108 + (i % 3) * BOX));
  const l = layoutPanel(columns, BOX, null, 700, 560);
  assert.ok((60 + 3) * l.cell <= 700 - AXIS_W + l.cell);     // the columns (plus a little room) fit the plot width
  assert.ok(l.cell >= MIN_CELL);
});

test('a live price outside the columns widens the range by whole boxes, so the axis stays on the cell edges', () => {
  const box = 0.5;
  const cols = [col(100.25, 102.25)];                        // cell edges: 100.25 + k * 0.5
  for (const live of [99.13, 103.9, 101.1]) {
    const l = layoutPanel(cols, box, live, 800, 500);
    const offset = ((((l.yMin - 100.25) / box) % 1) + 1) % 1;
    assert.ok(offset < 1e-6 || offset > 1 - 1e-6, `yMin ${l.yMin} is off the grid for live ${live}`);
    assert.ok(l.yMin <= live - box + 1e-9 && l.yMax >= live + 2 * box - 1e-9);
    assert.ok(Math.abs((l.yMax - l.yMin) / box - Math.round((l.yMax - l.yMin) / box)) < 1e-6);
  }
});

test('xScale changes the column pitch only: the cell, the rows and the height stay, the width follows', () => {
  const columns = [col(100, 110), col(95, 105), col(100, 112)];
  const a = layoutPanel(columns, BOX, null, 1500, 560, 1, true, 1);
  const wide = layoutPanel(columns, BOX, null, 1500, 560, 1, true, 2);
  const narrow = layoutPanel(columns, BOX, null, 1500, 560, 1, true, 0.5);
  assert.equal(a.colW, a.cell);
  assert.equal(wide.cell, a.cell);
  assert.equal(wide.contentH, a.contentH);
  assert.equal(wide.colW, a.cell * 2);
  assert.equal(narrow.colW, Math.round(a.cell * 0.5));
});
