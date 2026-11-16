import { test } from 'node:test';
import assert from 'node:assert';
import {
  zoomRows,
  wheelFactor,
  axisDragFactor,
  zoomCellW,
  anchorOffsetX,
  ROW_H_MAX,
  ROW_H_MIN,
  CELL_W_MAX,
  CELL_W_MIN,
  WHEEL_STEP,
} from './tpoChartZoom.ts';

const PAD = 18;
const priceAtY = (v: { rowH: number; topPrice: number }, y: number, rowSize: number) =>
  v.topPrice - ((y - PAD) / v.rowH) * rowSize;

test('zoomRows keeps the anchored price fixed and clamps the row height', () => {
  const base = { rowH: 10, topPrice: 25000 };
  const z = zoomRows(base, 2, 218, PAD, 5);
  assert.strictEqual(z.rowH, 20);
  assert.ok(Math.abs(priceAtY(z, 218, 5) - priceAtY(base, 218, 5)) < 1e-9);
  assert.strictEqual(zoomRows(base, 100, 218, PAD, 5).rowH, ROW_H_MAX);
  assert.strictEqual(zoomRows(base, 0.001, 218, PAD, 5).rowH, ROW_H_MIN);
});

test('wheelFactor reads deltaX when Chrome reports a shifted wheel that way', () => {
  assert.strictEqual(wheelFactor({ deltaY: -100, deltaX: 0 }), WHEEL_STEP);
  assert.strictEqual(wheelFactor({ deltaY: 100, deltaX: 0 }), 1 / WHEEL_STEP);
  // Shift + wheel in Chrome: deltaY 0, deltaX carries the notch. Reading deltaY alone zoomed
  // OUT on every notch in both directions.
  assert.strictEqual(wheelFactor({ deltaY: 0, deltaX: -100 }), WHEEL_STEP);
  assert.strictEqual(wheelFactor({ deltaY: 0, deltaX: 100 }), 1 / WHEEL_STEP);
  assert.strictEqual(wheelFactor({ deltaY: 0, deltaX: 0 }), 1);
});

test('axisDragFactor: drag up zooms in, down zooms out, no move is 1', () => {
  assert.ok(axisDragFactor(300, 200) > 1);
  assert.ok(axisDragFactor(300, 400) < 1);
  assert.strictEqual(axisDragFactor(300, 300), 1);
  // Symmetric: up 100 then back is identity (computed from the drag start, never compounded).
  assert.ok(Math.abs(axisDragFactor(300, 200) * axisDragFactor(200, 300) - 1) < 1e-12);
});

test('zoomCellW clamps to the cell-width range', () => {
  assert.strictEqual(zoomCellW(9, 2), CELL_W_MAX);
  assert.strictEqual(zoomCellW(2, 0.1), CELL_W_MIN);
  assert.strictEqual(zoomCellW(8, 1.5), 12);
});

test('anchorOffsetX keeps the same spot of the same profile under the pointer', () => {
  const gap = 34;
  const before = [{ x: 8, w: 100 }, { x: 142, w: 100 }, { x: 276, w: 100 }];
  const after = [{ x: 8, w: 200 }, { x: 242, w: 200 }, { x: 476, w: 200 }];
  // Pointer at canvas x 50 with offset 142 → content 192: profile 1, fraction 50/134.
  const off = anchorOffsetX(before, after, gap, 142, 50);
  const frac = 50 / 134;
  assert.ok(Math.abs(off + 50 - (242 + frac * 234)) < 1e-9);
  // Never scrolls before the start.
  assert.strictEqual(anchorOffsetX(before, after, gap, 0, 0), 0);
  // Past the last profile anchors on the last one.
  assert.ok(anchorOffsetX(before, after, gap, 300, 200) > 300);
});
