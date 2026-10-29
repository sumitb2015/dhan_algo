// Geometry of one Straddle P&F panel. Pure so the sizing rules (no dropped columns, minimum glyph size, axis pinned right)
// are tested instead of living inside the SVG component.

export const AXIS_W = 58;
export const PAD_TOP = 22;
export const MIN_CELL = 8;
export const MAX_CELL = 14;
export const ZOOM_MIN_CELL = 3;
export const ZOOM_MAX_CELL = 48;

export type PanelLayout = {
  cell: number;
  yMin: number;
  yMax: number;
  rows: number;
  /** Width of the plot area (columns), excluding the axis. */
  plotW: number;
  /** Width / height of the scrollable content (the axis is the last AXIS_W pixels of the width). */
  contentW: number;
  contentH: number;
  /** Left padding that right-aligns the columns against the axis when they do not fill the view. */
  offsetX: number;
  /** Empty scroll room above/below the price rows, so the chart can be dragged off-centre even when it fits the view. */
  padY: number;
};

/**
 * All columns are laid out (the panel scrolls; nothing is clipped). The cell size follows the full price range, bounded to
 * [MIN_CELL, MAX_CELL]: a wider range than fits makes the chart scroll vertically rather than shrink the glyphs to dots.
 */
export function layoutPanel(
  columns: { low: number; high: number }[],
  box: number,
  liveValue: number | null,
  viewW: number,
  viewH: number,
  /** User zoom multiplier on the fitted cell size (1 = fitted). Lifts the MIN/MAX clamp within [ZOOM_MIN_CELL, ZOOM_MAX_CELL]. */
  zoom = 1,
  /** Add half a view of empty scroll room on every side so mouse-drag can move a chart that already fits. Off = fit-to-view, no scroll. */
  slack = false,
): PanelLayout {
  const lows = columns.map(c => c.low);
  const highs = columns.map(c => c.high);
  if (liveValue !== null) { lows.push(liveValue); highs.push(liveValue); }
  const hasRange = box > 0 && lows.length > 0;
  const yMin = hasRange ? Math.min(...lows) - box : 0;
  const yMax = hasRange ? Math.max(...highs) + 2 * box : 0;
  const rows = hasRange ? Math.ceil((yMax - yMin) / box) + 1 : 1;
  const fitted = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor((viewH - PAD_TOP) / rows)));
  const cell = zoom === 1 ? fitted : Math.max(ZOOM_MIN_CELL, Math.min(ZOOM_MAX_CELL, Math.round(fitted * zoom)));

  const minPlotW = Math.max(cell, viewW - AXIS_W);
  const colsW = columns.length * cell;
  const padY = slack ? Math.round(viewH / 2) : 0;
  const padX = slack ? Math.round(viewW / 2) : 0;
  const fitW = Math.max(minPlotW, colsW);
  return {
    cell, yMin, yMax, rows,
    plotW: fitW + padX,
    contentW: fitW + padX + AXIS_W,
    contentH: Math.max(viewH, PAD_TOP + rows * cell + 8) + 2 * padY,
    offsetX: Math.max(0, fitW - colsW) + padX,
    padY,
  };
}
