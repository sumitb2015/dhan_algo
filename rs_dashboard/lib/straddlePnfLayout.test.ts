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
