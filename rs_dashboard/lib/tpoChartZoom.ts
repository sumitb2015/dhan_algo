/**
 * Zoom maths for the Market Profile TPO chart (components/marketProfile/TpoChart.tsx), kept
 * pure so it is unit-tested. It follows the P&F chart's zoom model (dhan-pnf-chart-panel):
 *
 *   wheel / − + buttons          → uniform zoom: row height AND cell width
 *   Shift + wheel / squeeze-stretch → horizontal only: cell width (the profile's TPO pitch)
 *   drag on the price axis       → vertical only: row height (drag up = zoom in)
 *
 * Every zoom keeps the point under the pointer (or the anchor) fixed on screen.
 */

export const ROW_H_MIN = 1.5;
export const ROW_H_MAX = 30;
export const CELL_W_MIN = 1;
export const CELL_W_MAX = 18;
/** One button press: the same 0.7 step the P&F panel's ZoomButtons use. */
export const BUTTON_STEP = 0.7;
/** One wheel notch. */
export const WHEEL_STEP = 1.12;
/** Price-axis drag: zoom factor per pixel dragged, as exp(px × this). */
export const AXIS_DRAG_RATE = 0.01;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface VerticalView {
  /** Pixel height of one price row. */
  rowH: number;
  /** Price at the plot's top edge (y = padTop). */
  topPrice: number;
}

/**
 * Scale the row height by `factor` (clamped), keeping the price at canvas y `anchorY` fixed.
 * `rowH` is set absolutely from `base`, so a drag that recomputes from its start value never
 * compounds against a stale height.
 */
export function zoomRows(base: VerticalView, factor: number, anchorY: number, padTop: number, rowSize: number): VerticalView {
  const priceAt = base.topPrice - ((anchorY - padTop) / base.rowH) * rowSize;
  const rowH = clamp(base.rowH * factor, ROW_H_MIN, ROW_H_MAX);
  return { rowH, topPrice: priceAt + ((anchorY - padTop) / rowH) * rowSize };
}

/** Wheel notch → zoom factor. Chrome reports a SHIFTED wheel as deltaX, so read both. */
export function wheelFactor(e: { deltaY: number; deltaX: number }): number {
  const d = e.deltaY || e.deltaX;
  if (d === 0) return 1;
  return d < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
}

/** Price-axis drag: dragging UP (smaller clientY) zooms in. */
export function axisDragFactor(startY: number, y: number): number {
  return Math.exp((startY - y) * AXIS_DRAG_RATE);
}

/** Cell width after a horizontal zoom, clamped. */
export function zoomCellW(cellW: number, factor: number): number {
  return clamp(cellW * factor, CELL_W_MIN, CELL_W_MAX);
}

export interface Slot {
  /** Content-space left edge of a profile. */
  x: number;
  /** Its width (the gap after it is passed separately). */
  w: number;
}

/**
 * New horizontal scroll after the profile layout changed width, so the content under canvas
 * x `anchorX` stays under it. Profiles have fixed gutters and gaps, so the layout does not
 * scale linearly with the cell width; anchor on the profile slot (profile + its gap) under
 * the pointer and the fraction across it instead.
 */
export function anchorOffsetX(before: Slot[], after: Slot[], gap: number, offsetX: number, anchorX: number): number {
  if (before.length === 0 || before.length !== after.length) return Math.max(0, offsetX);
  const content = anchorX + offsetX;
  // Left of the first profile (its fixed margin) nothing moves with the cell width.
  if (content < before[0].x) return Math.max(0, offsetX);
  let i = before.findIndex((s) => content < s.x + s.w + gap);
  if (i < 0) i = before.length - 1;
  const b = before[i];
  const frac = clamp((content - b.x) / (b.w + gap), 0, 1);
  const a = after[i];
  return Math.max(0, a.x + frac * (a.w + gap) - anchorX);
}
