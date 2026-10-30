// Geometry of one Straddle P&F panel. Pure so the sizing rules (no dropped columns, minimum glyph size, axis pinned right)
// are tested instead of living inside the SVG component.

/** Fits a 10px mono label up to "1,25,000" (labels drop decimals once a box is 10 or more) and a "25,935.00" live tag. */
export const AXIS_W = 66;
export const PAD_TOP = 22;
export const MIN_CELL = 8;
/** 28 left a 13-column chart filling an eighth of a wide panel; zoom still goes to ZOOM_MAX_CELL. */
export const MAX_CELL = 40;
/** Columns of breathing room (left of the oldest, right of the newest) the width fit leaves, so a fitted chart is not jammed against the edges. */
const FIT_COLUMN_SLACK = 3;
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
  /** Empty scroll room between the newest column and the price axis, so the chart can be dragged left of the axis. */
  padR: number;
};

/**
 * All columns are laid out (the panel scrolls; nothing is clipped). The cell size is the largest square that fits BOTH the full price
 * range and every column in the view, bounded to [MIN_CELL, MAX_CELL]: a range or history too big for MIN_CELL makes the chart scroll
 * rather than shrink the glyphs to dots, and a small chart grows to fill the panel instead of sitting in a corner.
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
  // The range is built from the columns' cell edges and widened only by WHOLE boxes for the live price, so yMin stays on a cell
  // edge and the axis labels (yMin + (i + 0.5) * box, the box centres) stay level with the rows.
  let yMin = 0, yMax = 0;
  const hasRange = box > 0 && (columns.length > 0 || liveValue !== null);
  if (hasRange) {
    yMin = columns.length ? Math.min(...columns.map(c => c.low)) - box : (liveValue as number) - box;
    yMax = columns.length ? Math.max(...columns.map(c => c.high)) + 2 * box : (liveValue as number) + 2 * box;
    if (liveValue !== null && liveValue - box < yMin) yMin -= Math.ceil((yMin - (liveValue - box)) / box - 1e-6) * box;
    if (liveValue !== null && liveValue + 2 * box > yMax) yMax += Math.ceil((liveValue + 2 * box - yMax) / box - 1e-6) * box;
  }
  const rows = hasRange ? Math.ceil((yMax - yMin) / box - 1e-6) + 1 : 1;
  const fitH = Math.floor((viewH - PAD_TOP) / rows);
  const fitCellW = columns.length ? Math.floor((viewW - AXIS_W) / (columns.length + FIT_COLUMN_SLACK)) : MAX_CELL;
  const fitted = Math.max(MIN_CELL, Math.min(MAX_CELL, fitH, fitCellW));
  const cell = zoom === 1 ? fitted : Math.max(ZOOM_MIN_CELL, Math.min(ZOOM_MAX_CELL, Math.round(fitted * zoom)));

  const minPlotW = Math.max(cell, viewW - AXIS_W);
  const colsW = columns.length * cell;
  const padY = slack ? Math.round(viewH / 2) : 0;
  const padX = slack ? Math.round(viewW / 2) : 0;
  const fitW = Math.max(minPlotW, colsW);
  return {
    cell, yMin, yMax, rows,
    plotW: fitW + padX + padX,
    contentW: fitW + padX + padX + AXIS_W,
    contentH: Math.max(viewH, PAD_TOP + rows * cell + 8) + 2 * padY,
    offsetX: Math.max(0, fitW - colsW) + padX,
    padY,
    padR: padX,
  };
}
