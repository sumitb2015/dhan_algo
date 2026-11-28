import test from 'node:test';
import assert from 'node:assert/strict';
import { autoFitView, layoutPanel, AXIS_W } from './straddlePnfLayout.ts';

// A long Renko history (box 10): 2,000 bricks zigzagging (12 up, 9 down) from 20,000, so the whole range is far taller than what is in view.
const cols: { low: number; high: number }[] = [];
let p = 20000;
for (let i = 0; i < 2000; i++) { const up = i % 21 < 12; const low = up ? p : p - 10; cols.push({ low, high: low + 10 }); p += up ? 10 : -10; }

test('the bricks across the view fill the plot height, the column pitch stays the fitted one', () => {
  const viewW = 1400, viewH = 600, plotH = 576;
  const fit = autoFitView(cols, 10, p, viewW, viewH, plotH)!;
  const base = layoutPanel(cols, 10, p, viewW, viewH, 1, true, 1);
  const L = layoutPanel(cols, 10, p, viewW, viewH, fit.zoom, true, fit.xScale);
  assert.equal(L.colW, base.colW, 'columns keep their width');
  const n = Math.floor((viewW - AXIS_W) / base.colW);
  const vis = cols.slice(-n);
  const lo = Math.min(...vis.map(c => c.low)), hi = Math.max(...vis.map(c => c.high));
  const usedH = ((hi - lo) / 10 + 4) * L.cell;
  assert.ok(usedH <= plotH - 22, `fits: ${usedH}`);
  assert.ok(usedH >= (plotH - 22) * 0.85, `fills most of the height: ${usedH}`);
  assert.ok(L.cell > base.cell, 'taller boxes than the whole-history fit');
  assert.equal(fit.topPrice, hi + 20);
});

test('the live price beyond the bricks is kept in view; nothing to fit gives null', () => {
  const fit = autoFitView(cols, 10, p - 500, 1400, 600, 576)!;
  assert.ok(fit.topPrice > p - 500);
  assert.equal(autoFitView([], 10, 100, 1400, 600, 576), null);
  assert.equal(autoFitView(cols, 0, 100, 1400, 600, 576), null);
});

test('a flat stretch is clamped to the largest box, never divided by zero', () => {
  const flat = Array.from({ length: 50 }, () => ({ low: 100, high: 110 }));
  const fit = autoFitView(flat, 10, 105, 1400, 600, 576)!;
  const L = layoutPanel(flat, 10, 105, 1400, 600, fit.zoom, true, fit.xScale);
  assert.ok(L.cell <= 48);
});

test('the visible width, not the layout width, decides how many columns are fitted', () => {
  const narrow = autoFitView(cols, 10, p, 480, 600, 576)!;
  const wide = autoFitView(cols, 10, p, 480, 600, 576, 1400)!;
  assert.ok(wide.topPrice >= narrow.topPrice, 'more columns can only widen the range');
  const Ln = layoutPanel(cols, 10, p, 480, 600, narrow.zoom, true, narrow.xScale), Lw = layoutPanel(cols, 10, p, 480, 600, wide.zoom, true, wide.xScale);
  assert.equal(Ln.colW, Lw.colW, 'the pitch is the layout one either way');
});
