'use client';

import { intervalLabel } from '@/lib/straddlePnfInterval';
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { unconfirmedBoxes, type Overlay, type PanelModel } from '@/lib/straddlePnfModel';
import { isSellSignal, type PnfExecutionMarker } from '@/lib/straddlePnf';
import { AlignLeft, AlignRight, Eye, EyeOff, MapPin, MapPinOff, Minus, Plus, RotateCcw, ChevronsLeftRight, ChevronsRightLeft } from 'lucide-react';
import { layoutTags } from '@/lib/pnfTagLayout';
import { timeAxisLabels, crosshairStamp } from '@/lib/straddlePnfTimeAxis';
import { layoutPanel, AXIS_W, PAD_TOP, XSCALE_MIN, XSCALE_MAX } from '@/lib/straddlePnfLayout';
import { MIN_BOX_PTS_PCT } from '@/lib/straddlePnfSettings';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// One straddle P&F chart: X (green) / O (red) glyphs on a visible box grid, VWAP or SMA line, a bar at the level every double
// top / double bottom broke, date dividers where a new session starts and a tag at the live price. Every column is drawn: the
// chart scrolls (it opens on the newest column) and the price axis stays pinned to the right edge while you pan.

const MIN_HEIGHT = 420;
/** Columns are drawn in windows of this many (see `w0` / `w1` in the panel). */
const WINDOW_CHUNK = 256;

export type PnfPanelProps = {
  title: string;
  strike: number;
  model: PanelModel;
  /** Live straddle price (open minute), or null before the first tick. */
  live: { ce: number; pe: number } | null;
  /** The overlay the page asked for; the panel draws and labels `model.overlayKind` (an index or a no-volume series gets the SMA). */
  overlay: Overlay;
  stale: boolean;
  /** Set for a few seconds after a signal fires on this chart. */
  flash: 'buy' | 'sell' | null;
  error?: string;
  loading?: boolean;
  /** Minutes per chart bar and box size in %: only used to describe the chart in the header (defaults 1 and 0.5). */
  interval?: number;
  boxPct?: number;
  reversal?: number;
  /** Fill the height of the parent (a flex/grid cell) instead of the live page's fixed viewport-based height. */
  fill?: boolean;
  /** False for a futures chart: there are no CE / PE legs to show. */
  legs?: boolean;
  /** Bump to reset zoom and centre the chart on its newest column and latest price (the header's Re-center button). */
  resetTick?: number;
  /** When set, the title/price/summary strip is drawn there (the page's top header) in one compact row, and not above the chart. */
  headerSlot?: HTMLElement | null;
  /** The instrument's name for the header strip (the strip is shown without a card header, so the price needs a scrip beside it). */
  scrip?: string;
  /**
   * Previous close from the live feed, passed only while it can be trusted (before the bell, price from today): the change's
   * base when set; otherwise the last close of the previous session in the loaded history.
   */
  feedPrevClose?: number | null;
  /** Set when the live price is a feed value outside the trading session ("Pre-open" / "Post-close"), not a chart bar. */
  sessionTag?: string | null;
  /** False hides the VWAP / SMA line and its legend; the signals and exit cues still use it. */
  overlayShown?: boolean;
  /** True draws the Supertrend line and its legend (Renko only: `model.supertrend` is empty on P&F). Display only. */
  supertrendShown?: boolean;
  /** True draws the COVER tag (a short-side cue: first bar of an X column above VWAP). Off by default; nothing trades on it. */
  coverShown?: boolean;
  /** False (stocks: a column spans days) = no dashed vertical line at each session start and no date strip along the top. */
  sessionLines?: boolean;
  /** False = no dashed vertical line at each session start, but the date strip along the top stays (an index: its dates are useful, the lines are clutter). */
  sessionDividers?: boolean;
  /** True draws a TradingView-style time axis along the bottom (days under their columns) and a date chip on the crosshair; for an index. */
  timeAxis?: boolean;
  /** Executed trades on this chart to mark on the boxes. */
  tradeMarkers?: PnfExecutionMarker[];
  /** Render the card header inside the panel even when headerSlot is provided. */
  showHeader?: boolean;
  /** Two charts: this is the chart the header controls and the trade bar act on (drawn with a highlight ring). */
  active?: boolean;
  /** Two charts: a press anywhere on this chart makes it the active one. */
  onActivate?: () => void;
  /** This chart's AUTO controls: in the card header (two charts) or a slim bar above the chart (one chart). */
  autoSlot?: React.ReactNode;
  /** False = the B / S trade markers are hidden (the trades themselves are untouched). */
  markersShown?: boolean;
  /** Shows a hide / show-markers button beside the zoom buttons. */
  onToggleMarkers?: () => void;
  /** The ladder-style B / S rail beside the price axis (absent: no rail, e.g. an index chart). */
  rail?: PnfRail;
  /** Nested-column triangles of this chart (lib/pnfTriangle.ts), whether they are drawn, and the fewest columns that count. */
  triangles?: PnfTriangle[];
  triShown?: boolean;
  triMin?: number;
  onToggleTri?: () => void;
  onCycleTriMin?: () => void;
  /** Bar Replay is picking its start: a line follows the pointer and a click hands back that column's start time (no pan). */
  replayPick?: (t: number) => void;
  /** Bar Replay's start: a dashed line before the first column it revealed. */
  replayStartT?: number | null;
};

import type { PnfTriangle } from '@/lib/pnfTriangle';
import type { LadderPosition } from '@/lib/pnfLadderPosition';

/** A resting order drawn on the chart (its line, its tag, and its handle in the rail). */
export type RailOrder = {
  id: string; side: 'BUY' | 'SELL'; kind: 'limit' | 'stop'; level: number; price: number; trigger?: number; lots: number;
  /** working: draggable / cancellable. Anything else (sending, firing, unknown) is drawn but locked. */
  state: string; mode: 'PAPER' | 'REAL';
  /** Its outcome is unknown (or its send never finished): a ? on the tag lets the user settle it (onCancel asks first). */
  resolvable?: boolean;
  /** A bracket exit (stop-loss / target) or the entry that carries a bracket / cover. */
  role?: 'sl' | 'target';
  trailPts?: number;
  bracket?: 'Bracket' | 'Cover';
  /** A working Bracket / Cover entry: where its stop-loss and target will be placed once it fills (drawn dimmed in the ladder). */
  planned?: { role: 'sl' | 'target'; level: number }[];
};
export type PnfRail = {
  orders: RailOrder[];
  /** The chart's open position: its entry line, and its live P&L chip on the rail (like the XY ladder's entry row). */
  position?: LadderPosition | null;
  /** A click on a box row: the box price. */
  onPlace: (side: 'BUY' | 'SELL', level: number) => void;
  onModify: (id: string, level: number) => void;
  onCancel: (id: string) => void;
  /** + / - on a working entry order's tag: change its lots by `delta`. */
  onLots?: (id: string, delta: number) => void;
  /** + / − on the open position's chip: one lot more (+) or less (−) at market. Shown only while the rail is armed. */
  onPositionLots?: (dir: 1 | -1) => void;
  /** A planned stop-loss / target of a working Bracket / Cover entry was dragged to another box in the ladder. */
  onPlannedMove?: (id: string, role: 'sl' | 'target', level: number) => void;
  /** The rail takes clicks (always in PAPER; in REAL only once unlocked). */
  armed?: boolean;
  onToggleArm?: () => void;
  /** REAL mode: the lock toggle is shown (PAPER needs none). */
  lockable?: boolean;
  /** REAL: moving / cancelling a broker order asks first unless Instant is on. */
  instant?: boolean;
  onToggleInstant?: () => void;
  /** Show the order and position lines (Kite's price lines) / which edge their tags sit on. */
  linesShown?: boolean;
  onToggleLines?: () => void;
  alignLeft?: boolean;
  onToggleAlign?: () => void;
  /** Cancels every working order on this chart. */
  onCancelAll?: () => void;
};

/** Width of the buy / sell rail (two columns, buy left and sell right) between the chart and its price axis. */
/** The ladder beside the price axis: BUY | PRICE | SELL, like the XY ladder (the widgets need the room). */
export const RAIL_SIDE_W = 96;
export const RAIL_PRICE_W = 60;
export const RAIL_W = RAIL_SIDE_W * 2 + RAIL_PRICE_W;

function useSize(): [React.RefObject<HTMLDivElement | null>, number, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 480, h: MIN_HEIGHT });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) =>
      setSize({ w: Math.max(200, Math.floor(e.contentRect.width)), h: Math.max(MIN_HEIGHT, Math.floor(e.contentRect.height)) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size.w, size.h];
}

// One formatter per digit count: toLocaleString builds a new Intl formatter on every call, and the axis formats hundreds of labels a frame.
const FMT: Record<number, Intl.NumberFormat> = {};
const fmt = (n: number, digits = 2) => (FMT[digits] ??= new Intl.NumberFormat('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })).format(n);
const signed = (n: number) => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(2)}`;
/** The column tooltip's end: date with year, and the time only when it means something (a daily close sits at 15:29). */
const dateYear = (iso: string) => `${sessionLabel(iso)} ${iso.slice(0, 4)}`;
const timeIfAny = (t: number) => { const h = hhmm(t); return h === '15:29' ? '' : ` ${h}`; };
const hhmm = (t: number) => new Date((t + 5.5 * 3600) * 1000).toISOString().slice(11, 16);
const sessionOfT = (t: number) => new Date((t + 5.5 * 3600) * 1000).toISOString().slice(0, 10);
const shortDate = (iso: string) => sessionLabel(iso).slice(4);

/** The newest-signal pill's text: P&F double top / bottom, or a Renko N-brick confirmation. */
const signalPill = (kind: string, long: boolean) => {
  const sell = isSellSignal(kind);
  if (kind.startsWith('TWOBACK')) return sell ? '▼ Two-back sell' : '▲ Two-back buy';
  if (kind.startsWith('RENKO')) return sell ? '▼ Renko sell' : '▲ Renko buy';
  return sell ? (long ? '▼ DB sell' : '▼ DB') : (long ? '▲ DT buy' : '▲ DT');
};

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-950';

/** One line naming a resting order: a bracket exit says SL / TGT and its level, an entry that carries a bracket says so. */
function orderText(o: RailOrder, level?: number): string {
  const p = o.mode === 'PAPER' ? 'P ' : '';
  const st = o.state === 'working' ? '' : ` ${o.state.toUpperCase()}`;
  if (o.role) return `${p}${o.role === 'sl' ? 'SL' : 'TGT'}${o.trailPts ? ' trail' : ''} ${o.lots}L @ ${fmt(level ?? (o.role === 'sl' ? o.trigger ?? o.level : o.level), 2)}${st}`;
  // "BUY SL @ 220.50 · 1L": the same words as the hover label, so the price an order was placed at stays on the chart. An SL-limit
  // names its trigger (the level that was clicked); the limit it carries once triggered is in the tooltip.
  const at = o.kind === 'stop' ? o.trigger ?? o.level : o.price;
  return `${p}${o.side} ${o.kind === 'limit' ? 'LMT' : 'SL'} @ ${fmt(level ?? at, 2)} · ${o.lots}L${o.bracket ? (o.bracket === 'Cover' ? ' +CVR' : ' +BKT') : ''}${st}`;
}

type RailDrag = { id: string; level: number; start: number } | null;

const rupees = (n: number) => `${n >= 0 ? '+' : '−'}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;

/**
 * The buy / sell ladder beside the price axis, laid out like the XY ladder: BUY | PRICE | SELL on every box row over the whole chart
 * height (the padding above and below the data too, on the chart's own box grid, so an order can rest beyond where the price has
 * been). A click in the BUY or SELL column places an order at that row's price; the PRICE column names every row (every Nth when the
 * rows are small), marks the live price, and shows the price a resting order sits at and the open position's entry.
 *  - a resting order is a widget in its own side's column: `LMT|SL  [-] 1L [+]  [x]`; the body drags it to another box and the
 *    buttons change its lots / cancel it. Its row price is tinted in the PRICE column: that is the price it was placed at.
 *  - the open position: a blue band across the entry row, `LONG 1L` in its side's column, the entry price in the PRICE column and
 *    the live P&L in the other column.
 * Cells act on pointer-down (the chart's drag-to-pan captures the pointer, which would swallow a click). A handle is dragged
 * to another box (commit on release); the drag lives in a ref because pointer events arrive before React re-renders.
 */
function RailSvg({ rail, renko = false, box, cell, yMax, yMin, padY, contentH, yOf, liveValue, axisDigits, onDrag, onHot, visTop = 0, visBottom = contentH }: {
  rail: PnfRail;
  /** Renko: a row is a brick EDGE (a multiple of the box), where a brick completes. P&F: a row is a box label (the cell centre). */
  renko?: boolean;
  box: number; cell: number; yMax: number; yMin: number; padY: number; contentH: number;
  /** The content y range worth drawing rows for (the view plus a margin); a long price history has thousands of rows. */
  visTop?: number; visBottom?: number;
  yOf: (p: number) => number; liveValue: number | null; axisDigits: number; onDrag: (d: RailDrag) => void;
  onHot: (h: { side: 'BUY' | 'SELL'; p: number; kind: string } | null) => void;
}) {
  const armed = rail.armed !== false;
  const dragRef = useRef<RailDrag>(null);
  const [drag, setDragState] = useState<RailDrag>(null);
  const setDrag = (d: RailDrag) => { dragRef.current = d; setDragState(d); onDrag(d); };
  const priceAtY = (y: number) => yMax - ((y - padY - PAD_TOP) / cell) * box;
  const iLo = Math.floor((priceAtY(contentH) - yMin) / box);
  const iHi = Math.ceil((priceAtY(0) - yMin) / box) - 1;
  // A P&F box fills when the price reaches its label, the centre of its cell; a Renko brick only once the price reaches the next
  // multiple of the box, so on Renko every row (and every order placed from it) sits on a brick edge, as the price axis does.
  const half = renko ? 0 : 0.5;
  const rowOf = (p: number) => (renko ? Math.round((p - yMin) / box) : Math.floor((p - yMin) / box));
  // Renko rows are snapped onto the box grid itself (yMin is on it once a brick exists; before that it follows the live price).
  const rowPrice = (idx: number) => (renko ? Math.round((yMin + idx * box) / box) * box : yMin + (idx + half) * box);
  const levelAt = (y: number) => rowPrice(Math.max(iLo, Math.min(iHi, rowOf(priceAtY(y)))));
  const rLo = Math.max(iLo, Math.floor((priceAtY(Math.min(contentH, visBottom)) - yMin) / box));
  const rHi = Math.min(iHi, Math.ceil((priceAtY(Math.max(0, visTop)) - yMin) / box));
  const kindAt = (side: 'BUY' | 'SELL', p: number) => (liveValue === null ? '' : (side === 'BUY') === (p < liveValue) ? 'LIMIT' : 'SL-limit');
  const [hot, setHotState] = useState<{ side: 'BUY' | 'SELL'; p: number } | null>(null);
  const setHot = (h: { side: 'BUY' | 'SELL'; p: number } | null) => { setHotState(h); onHot(h && armed ? { ...h, kind: kindAt(h.side, h.p) } : null); };
  const colX = (side: 'BUY' | 'SELL') => (side === 'BUY' ? 0 : RAIL_SIDE_W + RAIL_PRICE_W);
  const PX = RAIL_SIDE_W;                                    // the PRICE column's left edge
  const rowsPerLabel = Math.max(1, Math.ceil(11 / Math.max(1, cell)));    // a price label needs ~11 px: every Nth row when rows are smaller
  // the box row the live price is in, and the rows that carry something worth naming (an order, the entry)
  const liveRow = liveValue !== null && box > 0 ? rowPrice(rowOf(liveValue)) : null;
  const pos = rail.position && rail.position.avg !== null ? rail.position : null;
  const entryRow = pos && pos.avg !== null && box > 0 ? rowPrice(rowOf(pos.avg)) : null;
  const orderRows = new Map<string, RailOrder>();
  for (const o of rail.orders) orderRows.set((drag?.id === o.id ? drag.level : o.level).toFixed(6), o);
  const tone = (side: 'BUY' | 'SELL') => (side === 'BUY' ? 'fill-emerald-500 stroke-emerald-200' : 'fill-red-500 stroke-red-200');
  // Dragging a pill (a resting order, or a planned stop / target) to another box: the level follows the pointer, the commit is on release.
  // The drag lives in a ref because pointer events arrive before React re-renders; near the chart's top / bottom edge it scrolls.
  const dragHandlers = (id: string, level: number, commit: (level: number) => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      setDrag({ id, level, start: level });
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = dragRef.current;
      const svg = (e.currentTarget as SVGGElement).ownerSVGElement;
      if (d?.id !== id || !svg) return;
      const sc = svg.parentElement?.parentElement;
      if (sc) { const r = sc.getBoundingClientRect(); if (e.clientY < r.top + 28) sc.scrollTop -= 14; else if (e.clientY > r.bottom - 28) sc.scrollTop += 14; }
      const next = levelAt(e.clientY - svg.getBoundingClientRect().top);
      if (Math.abs(next - d.level) > box / 4) setDrag({ ...d, level: next });
    },
    onPointerUp: () => {
      const d = dragRef.current;
      if (d?.id !== id) return;
      setDrag(null);
      if (Math.abs(d.level - d.start) > box / 4) commit(d.level);
    },
    onPointerCancel: () => setDrag(null),
  });
  return (
    <svg data-testid="pnf-rail" width={RAIL_W} height={contentH} className="block shrink-0 sticky bg-zinc-900 border-l border-zinc-700" style={{ right: AXIS_W }}
         onPointerLeave={() => setHot(null)} opacity={armed ? 1 : 0.55}>
      {/* three columns over the whole height: BUY tinted green, PRICE neutral, SELL tinted red */}
      <rect x={0} y={0} width={RAIL_SIDE_W} height={contentH} className="fill-emerald-500/10" pointerEvents="none" />
      <rect x={colX('SELL')} y={0} width={RAIL_SIDE_W} height={contentH} className="fill-red-500/10" pointerEvents="none" />
      <line x1={PX} x2={PX} y1={0} y2={contentH} className="stroke-zinc-700" pointerEvents="none" />
      <line x1={PX + RAIL_PRICE_W} x2={PX + RAIL_PRICE_W} y1={0} y2={contentH} className="stroke-zinc-700" pointerEvents="none" />
      {Array.from({ length: Math.max(0, rHi - rLo + 1) }, (_, n) => {
        const idx = rLo + n;
        const p = rowPrice(idx);
        if (!(p > 0)) return null;
        const y = yOf(p);
        const isLive = liveRow !== null && Math.abs(p - liveRow) < box / 4;
        const isEntry = entryRow !== null && Math.abs(p - entryRow) < box / 4;
        const ord = orderRows.get(p.toFixed(6)) ?? [...orderRows.entries()].find(([k]) => Math.abs(Number(k) - p) < box / 4)?.[1];
        const showPrice = isLive || isEntry || !!ord || ((idx % rowsPerLabel) + rowsPerLabel) % rowsPerLabel === 0;
        const label = isLive && liveValue !== null ? fmt(liveValue, axisDigits) : fmt(p, axisDigits);
        return (
          <g key={n}>
            <line x1={0} x2={RAIL_W} y1={y + cell / 2} y2={y + cell / 2} className="stroke-zinc-800" pointerEvents="none" />
            {isEntry && <rect x={0} y={y - cell / 2} width={RAIL_W} height={cell} className="fill-blue-500/25" pointerEvents="none" />}
            {isLive && <rect x={PX} y={y - cell / 2} width={RAIL_PRICE_W} height={cell} className="fill-amber-500/30" pointerEvents="none" />}
            {ord && <rect x={PX + 1} y={y - Math.max(cell, 14) / 2} width={RAIL_PRICE_W - 2} height={Math.max(cell, 14)} rx={3} className={ord.role === 'target' || (!ord.role && ord.side === 'BUY') ? 'fill-emerald-600/70' : 'fill-red-600/70'} pointerEvents="none" />}
            {showPrice && (
              <text x={PX + RAIL_PRICE_W / 2} y={y + 3.5} textAnchor="middle" pointerEvents="none" {...(ord ? { 'data-testid': 'pnf-rail-order-price', 'data-id': ord.id } : {})}
                    className={`font-mono ${ord ? 'fill-oncolor' : isLive ? 'fill-amber-300' : isEntry ? 'fill-blue-300' : 'fill-zinc-400'}`}
                    fontSize={10} fontWeight={ord || isLive || isEntry ? 800 : 500}>{label}</text>
            )}
            {isLive && <circle cx={PX + 5} cy={y} r={2.5} className="fill-emerald-400" pointerEvents="none" />}
            {(['BUY', 'SELL'] as const).map(side => (
              <rect key={side} data-testid="pnf-rail-cell" data-side={side} data-level={p}
                    x={colX(side)} y={y - cell / 2} width={RAIL_SIDE_W} height={Math.max(1, cell)}
                    className={armed ? 'cursor-pointer fill-transparent' : 'cursor-not-allowed fill-transparent'}
                    role="button" aria-label={`${side === 'BUY' ? 'Buy' : 'Sell'} ${kindAt(side, p) || 'order'} at ${fmt(p, axisDigits)}${armed ? '' : ' (rail locked)'}`} aria-disabled={!armed}
                    onPointerEnter={() => setHot({ side, p })}
                    onPointerDown={e => { e.stopPropagation(); if (e.button === 0 && armed) rail.onPlace(side, p); }}>
                <title>{`${side} ${kindAt(side, p)} at ${fmt(p, axisDigits)}`}</title>
              </rect>
            ))}
          </g>
        );
      })}
      {/* the row under the pointer: what a click there places, in the column that will place it */}
      {armed && hot && !drag && (() => {
        const y = yOf(hot.p);
        const buy = hot.side === 'BUY';
        const kind = kindAt(hot.side, hot.p);
        const h = Math.max(cell, 16);
        return (
          <g pointerEvents="none" data-testid="pnf-rail-hover">
            <rect x={colX(hot.side) + 1} y={y - h / 2} width={RAIL_SIDE_W - 2} height={h} rx={3} className={buy ? 'fill-emerald-500/60 stroke-emerald-300' : 'fill-red-500/60 stroke-red-300'} strokeWidth={1} />
            <text x={colX(hot.side) + RAIL_SIDE_W / 2} y={y + 3.5} textAnchor="middle" className="fill-oncolor" fontSize={10} fontWeight={800}>{kind === 'LIMIT' ? `${buy ? 'BUY' : 'SELL'} LMT` : kind === 'SL-limit' ? `${buy ? 'BUY' : 'SELL'} SL` : '+'}</text>
          </g>
        );
      })()}
      {!armed && (
        <g pointerEvents="none" data-testid="pnf-rail-locked">
          <rect x={RAIL_W / 2 - 40} y={4} width={80} height={18} rx={4} className="fill-zinc-800 stroke-zinc-500" strokeWidth={1} />
          <text x={RAIL_W / 2} y={16} textAnchor="middle" className="fill-zinc-200" fontSize={10} fontWeight={800}>LOCKED</text>
        </g>
      )}
      {/* the open position: `[−] LONG 1L [+]` in its side's column (the entry price is in the PRICE column; the live P&L is on the
          chart's position tag and in this chip's tooltip, so the other column stays free for orders) */}
      {pos && entryRow !== null && (() => {
        const y = yOf(entryRow);
        if (y < 0 || y > contentH) return null;
        const long = pos.side === 'LONG';
        const sideCol = long ? 'BUY' : 'SELL';
        const hh = Math.max(cell, 16);
        const adjust = armed && pos.side !== 'MIXED' && !!rail.onPositionLots;
        const x0 = colX(sideCol) + 2;
        const W = RAIL_SIDE_W - 4;
        const posBtn = (id: string, bx: number, glyph: string, label2: string, dir: 1 | -1) => (
          <g key={id} data-testid={id} role="button" aria-label={label2} className="cursor-pointer"
             onPointerDown={e => { e.stopPropagation(); if (e.button === 0) rail.onPositionLots!(dir); }}>
            <rect x={bx} y={y - 7} width={14} height={14} rx={3} className="fill-oncolor-dark/30" />
            <text x={bx + 7} y={y + 3.5} textAnchor="middle" className="fill-oncolor" fontSize={11} fontWeight={800} pointerEvents="none">{glyph}</text>
            <title>{label2}</title>
          </g>
        );
        return (
          <g data-testid="pnf-rail-pnl">
            <g pointerEvents="none">
              <rect x={x0} y={y - hh / 2} width={W} height={hh} rx={3} className={long ? 'fill-emerald-700 stroke-emerald-300' : 'fill-red-700 stroke-red-300'} strokeWidth={1} />
              <text x={x0 + W / 2} y={y + 3.5} textAnchor="middle" className="fill-oncolor font-mono" fontSize={10} fontWeight={800}>{`${long ? 'LONG' : 'SHORT'} ${pos.lots}L`}</text>
              <title>{`${long ? 'LONG' : 'SHORT'} ${pos.lots}L @ ${fmt(pos.avg as number, axisDigits)}${pos.pnl === null ? '' : ` · P&L ${rupees(pos.pnl)}`}`}</title>
            </g>
            {/* `[−] SHORT 1L [+]`: one lot less / more at market, only while the rail takes clicks */}
            {adjust && posBtn('pnf-rail-pos-down', x0 + 3, '−', `Remove a lot: ${long ? 'SELL' : 'BUY'} 1 lot at market`, -1)}
            {adjust && posBtn('pnf-rail-pos-up', x0 + W - 17, '+', `Add a lot: ${long ? 'BUY' : 'SELL'} 1 lot at market`, 1)}
          </g>
        );
      })()}
      {rail.orders.map(o => {
        const y = yOf(drag?.id === o.id ? drag.level : o.level);
        const movable = o.state === 'working';
        const x0 = colX(o.side) + 2;
        const W = RAIL_SIDE_W - 4;
        const stepper = movable && !o.role && !!rail.onLots;
        const kindWord = o.kind === 'limit' ? 'limit' : 'SL-limit';
        const word = o.role === 'target' ? 'TGT' : o.role === 'sl' ? (o.trailPts ? 'TRL' : 'SL') : o.kind === 'limit' ? 'LMT' : 'SL';
        // - / + / x act on pointer-down and stop it from starting a drag of the order
        const btn = (id: string, bx: number, glyph: string, label2: string, act: () => void) => (
          <g key={id} data-testid={id} role="button" aria-label={label2} className="cursor-pointer"
             onPointerDown={e => { e.stopPropagation(); if (e.button === 0) act(); }}>
            <rect x={bx} y={y - 7} width={12} height={14} rx={3} className="fill-oncolor-dark/30" />
            <text x={bx + 6} y={y + 3.5} textAnchor="middle" className="fill-oncolor" fontSize={11} fontWeight={800} pointerEvents="none">{glyph}</text>
          </g>
        );
        return (
          <g key={o.id} data-testid="pnf-rail-order" data-id={o.id} className={movable ? 'cursor-ns-resize' : 'cursor-not-allowed'}
             {...(movable ? dragHandlers(o.id, o.level, lv => rail.onModify(o.id, lv)) : { onPointerDown: (e: React.PointerEvent) => e.stopPropagation() })}>
            <rect x={x0} y={y - 9} width={W} height={18} rx={o.kind === 'stop' ? 9 : 4} className={o.role === 'target' ? 'fill-emerald-600 stroke-emerald-200' : o.role === 'sl' ? 'fill-red-600 stroke-red-200' : tone(o.side)} strokeWidth={1} opacity={movable ? 1 : 0.5} />
            {/* an entry order is `[-] 1L [+] [x]` (the chart's tag and the PRICE column say LMT / SL and the price); a bracket exit has no - / +,
                so it keeps its word: `SL 1L [x]` / `TGT 1L [x]` */}
            {stepper && btn('pnf-rail-lots-down', x0 + 9, '−', `Remove a lot: ${o.side} ${kindWord} at ${fmt(o.level, 2)}`, () => rail.onLots!(o.id, -1))}
            <text x={stepper ? x0 + 36 : x0 + (W - 14) / 2} y={y + 3.5} textAnchor="middle" className="fill-oncolor" fontSize={10} fontWeight={800} pointerEvents="none">{o.role ? `${word} ${o.lots}L` : `${o.lots}L`}</text>
            {stepper && btn('pnf-rail-lots-up', x0 + 51, '+', `Add a lot: ${o.side} ${kindWord} at ${fmt(o.level, 2)}`, () => rail.onLots!(o.id, 1))}
            {movable && btn('pnf-rail-cancel', x0 + (stepper ? 71 : W - 14), '×', `Cancel ${o.side} ${kindWord} at ${fmt(o.level, 2)}`, () => rail.onCancel(o.id))}
            <title>{`${o.side} ${kindWord} ${o.lots}L at ${fmt(o.kind === 'stop' ? o.trigger ?? o.level : o.price, axisDigits)}${movable ? ' — drag to move' : ` (${o.state})`}`}</title>
          </g>
        );
      })}
      {/* the exits a working Bracket / Cover entry will place when it fills: dashed, in the exit side's column, drag to another box to
          change the entry's stop / target distance. The price is in the PRICE column like any other level. */}
      {rail.orders.flatMap(o => (o.planned ?? []).map(k => ({ o, k }))).map(({ o, k }) => {
        const exitSide = o.side === 'BUY' ? 'SELL' : 'BUY';
        const pid = `plan:${o.id}:${k.role}`;
        const dragging = drag?.id === pid;
        const level = dragging ? drag.level : k.level;
        const y = yOf(level);
        if (y < 0 || y > contentH) return null;
        const x0 = colX(exitSide) + 2;
        const sl = k.role === 'sl';
        const movable = o.state === 'working' && !!rail.onPlannedMove;
        return (
          <g key={pid} data-testid="pnf-rail-planned" data-role={k.role} data-level={level} data-entry={o.id} role="button" aria-label={`Planned ${sl ? 'stop-loss' : 'target'} at ${fmt(level, axisDigits)}`} className={movable ? 'cursor-ns-resize' : ''}
             {...(movable ? dragHandlers(pid, k.level, lv => rail.onPlannedMove!(o.id, k.role, lv)) : {})}>
            <rect x={PX + 1} y={y - Math.max(cell, 14) / 2} width={RAIL_PRICE_W - 2} height={Math.max(cell, 14)} rx={3} className={sl ? 'fill-red-500/25' : 'fill-emerald-500/25'} pointerEvents="none" />
            <text x={PX + RAIL_PRICE_W / 2} y={y + 3.5} textAnchor="middle" className={`font-mono ${sl ? 'fill-red-400' : 'fill-emerald-400'}`} fontSize={10} fontWeight={800} pointerEvents="none">{fmt(level, axisDigits)}</text>
            <rect x={x0} y={y - 9} width={RAIL_SIDE_W - 4} height={18} rx={4} className={sl ? 'fill-red-500/15 stroke-red-500' : 'fill-emerald-500/15 stroke-emerald-500'} strokeWidth={1.25} strokeDasharray="3 2" />
            <text x={x0 + (RAIL_SIDE_W - 4) / 2} y={y + 3.5} textAnchor="middle" className={`font-mono ${sl ? 'fill-red-400' : 'fill-emerald-400'}`} fontSize={10.5} fontWeight={800} pointerEvents="none">{sl ? 'SL' : 'TGT'}</text>
            <title>{`Planned ${sl ? 'stop-loss' : 'target'} at ${fmt(level, axisDigits)}${movable ? ' — drag to change it' : ''}`}</title>
          </g>
        );
      })}
    </svg>
  );
}

function ZoomButton({ label, onClick, children, pressed }: { label: string; onClick: () => void; children: React.ReactNode; pressed?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        onClick={onClick}
        render={<button type="button" aria-label={label} aria-pressed={pressed}
                        className="flex items-center justify-center w-6 h-6 rounded-full bg-zinc-900 border border-zinc-700 text-zinc-100 hover:bg-zinc-800" />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label === 'Fit chart to panel' ? 'Fit chart to panel (or double-click the chart)' : label}</TooltipContent>
    </Tooltip>
  );
}

function sessionLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${wd} ${String(d.getUTCDate()).padStart(2, '0')} ${mo}`;
}

export default function PnfPanel({ title, strike, model, live, stale, flash, error, loading, fill, legs = true, resetTick = 0, headerSlot = null, scrip, feedPrevClose = null, sessionTag = null, overlayShown = true, supertrendShown = false, coverShown = false, sessionLines = true, sessionDividers = true, timeAxis = false, interval = 1, boxPct = 0.5, reversal = 3, tradeMarkers, showHeader = false, active = false, onActivate, autoSlot = null, markersShown = true, onToggleMarkers, rail, triangles = [], triShown = true, triMin = 3, onToggleTri, onCycleTriMin, replayPick, replayStartT = null }: PnfPanelProps) {
  const [wrapRef, width, HEIGHT] = useSize();
  const { columns, box, signals, exits } = model;
  // Renko: every column is one filled brick on real price edges (lib/renko.ts); `reversal` holds the N-brick confirmation.
  const renko = model.chart === 'renko';
  const unitWord = renko ? 'bricks' : 'boxes';
  const ruleText = renko ? `confirm ${reversal}` : `${reversal}-box`;
  const liveValue = live ? live.ce + live.pe : null;
  // An index has no volume: its "VWAP" is a plain cumulative average, and says so.
  // The line actually drawn: an instrument without traded volume (an index) always gets the box SMA, whatever was asked.
  const kind = model.overlayKind;
  const overlayLabel = kind === 'vwap' ? 'VWAP' : `SMA ${model.smaPeriod}`;
  const overlayNow = model.overlayNow;
  // The SMA averages P&F boxes: say so when there are not enough of them yet, rather than show no line and no reason.
  const totalBoxes = useMemo(() => columns.reduce((n, c) => n + c.boxes, 0), [columns]);
  const smaWaiting = kind === 'sma' && overlayNow === null && columns.length > 0;
  // Supertrend (Renko): its value and direction at the newest confirmed brick, for the legend.
  const stShown = supertrendShown && model.supertrend.length > 0;
  const stNow = stShown ? model.supertrend[model.supertrend.length - 1] : null;
  const stLabel = `ST ${model.stPeriod},${model.stMult}`;
  const stLegend = stShown && (
    <span data-testid="pnf-supertrend-legend" className="shrink-0" title={`Supertrend: ATR ${model.stPeriod} bricks × ${model.stMult}`}>
      <span className={`font-bold ${stNow?.dir === -1 ? 'text-red-400' : 'text-emerald-400'}`}>{stLabel}</span>
      {stNow?.line != null
        ? <span className="font-semibold text-zinc-100">{` ${fmt(stNow.line)} ${stNow.dir === 1 ? '▲' : '▼'}`}</span>
        : <span className="text-zinc-500">{` needs ${model.stPeriod + 1} bricks`}</span>}
    </span>
  );
  // Change is measured from the previous close: the feed's (official) while trusted, else the history's, then the session open.
  const prevClose = feedPrevClose ?? model.prevClose;
  const changeBase = prevClose ?? model.sessionOpen;
  const changeLabel = prevClose ? 'vs prev close' : 'vs open';
  const change = liveValue !== null && changeBase ? liveValue - changeBase : null;
  const changePct = change !== null && changeBase ? (change / changeBase) * 100 : null;
  const lastSignal = signals.length ? signals[signals.length - 1] : null;
  // How the box was set: a % of the first price, or price points (raised to the 0.05% floor when the points were too small).
  const boxNote = model.boxMode === 'pts' ? (model.boxClamped ? `points, raised to ${MIN_BOX_PTS_PCT}% of price` : 'points') : `${boxPct}% of ${fmt(model.anchor)}`;
  const boxTitle = model.boxMode === 'pts'
    ? `Box ${box.toFixed(2)} points${model.boxClamped ? ' (the points set were below ${MIN_BOX_PTS_PCT}% of the price, so the box was raised to that floor)' : ''}; rows sit on multiples of the box`
    : `Box ${box.toFixed(2)} = ${boxPct}% of the first price ${fmt(model.anchor)}`;
  const sessionsInfo = model.sessions.length
    ? ` · ${model.sessions.length} sessions (${shortDate(model.sessions[0])} – ${shortDate(model.sessions[model.sessions.length - 1])})` : '';

  const [zoom, setZoom] = useState(1);
  const [xScale, setXScale] = useState(1);
  // Laid out with the unconfirmed boxes too (the live columns are the confirmed ones plus what the forming bar adds), so a
  // new unconfirmed column gets its own cell instead of sliding under the pinned axis.
  const liveCols = model.liveColumns.length >= columns.length ? model.liveColumns : columns;
  // The rail takes its width from the chart, so the newest column still sits next to the axis.
  const viewW = rail ? Math.max(120, width - RAIL_W) : width;
  // Memoised: it scans every column for the price range, and the crosshair re-renders this panel on each mouse move.
  const L = useMemo(() => layoutPanel(liveCols, box, liveValue, viewW, HEIGHT, zoom, true, xScale), [liveCols, box, liveValue, viewW, HEIGHT, zoom, xScale]);
  const { cell, colW, yMin, yMax, plotW, contentW, contentH, offsetX, padY, padR } = L;
  const yOf = (p: number) => padY + PAD_TOP + ((yMax - p) / box) * cell;
  const xOf = (j: number) => offsetX + j * colW;
  const vis = columns;
  const first = 0;
  // Glyph half-size: tall by the box height, wide by the column pitch, so a horizontal stretch fills the gap between columns
  // (O becomes an ellipse, X a wider cross) instead of leaving space - as in TradingView's P&F.
  const sy = cell * 0.36;
  const sx = Math.max(1, colW * 0.36);
  const stroke = Math.max(1.2, Math.min(2.4, cell * 0.075)); // keeps X / O legible when zoomed, not heavy when small
  const gridId = `pnf-grid-${strike}`;
  const gridY = liveCols.length ? ((yOf(liveCols[0].low) % cell) + cell) % cell : 0; // a cell edge, so grid lines run along the box edges

  // Open on the newest column, centred on the latest price; keep following the newest column unless the user has panned away.
  const scrollRef = wrapRef;
  // Vertical start: when the whole price range fits the view, centre that block; otherwise centre the latest price.
  const topFor = (el: HTMLElement) => {
    const dataH = PAD_TOP + (L.rows) * cell;
    if (dataH <= el.clientHeight) return Math.max(0, padY - (el.clientHeight - dataH) / 2);
    return Math.max(0, yOf(lastY as number) - el.clientHeight / 2);
  };
  // The scroller's visible plot edge in content coordinates: the order tags sit there, not at the content's far end (blank padding).
  const [viewRight, setViewRight] = useState<number | null>(null);
  const [viewLeft, setViewLeft] = useState(0);
  const [viewTop, setViewTop] = useState<number | null>(null);
  const stickRef = useRef(true);
  // The empty room (in columns) the user dragged open right of the newest column: following keeps it, so new bricks
  // do not slide back under the rail and the position tags.
  const gapRef = useRef(0);
  // The scroll position where the newest column sits against the axis (the empty room right of it is only for dragging).
  const stickLeft = (el: HTMLElement) => Math.max(0, el.scrollWidth - el.clientWidth - padR);
  const followLeft = (el: HTMLElement) => Math.min(el.scrollWidth - el.clientWidth, stickLeft(el) + gapRef.current * colW);
  // Until the user zooms or drags, the vertical position follows the layout (it changes when the panel is measured and as the range grows).
  const touchedRef = useRef(false);
  const centeredFor = useRef<number | null>(null);
  const lastY = liveValue ?? (liveCols.length ? (liveCols[liveCols.length - 1].low + liveCols[liveCols.length - 1].high) / 2 : null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || liveCols.length === 0) return;
    if (stickRef.current) el.scrollLeft = followLeft(el);
    setViewRight(Math.round(el.scrollLeft + el.clientWidth - AXIS_W - (rail ? RAIL_W : 0)));
    setViewLeft(Math.round(el.scrollLeft));
    setViewTop(Math.round(el.scrollTop));
    if (centeredFor.current !== strike) { touchedRef.current = false; centeredFor.current = strike; }
    if (!touchedRef.current && lastY !== null && box > 0) {
      el.scrollTop = topFor(el);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveCols.length, contentW, contentH, strike]);

  // TradingView-style controls (same as the options charts): wheel zooms around the cursor, dragging the price axis zooms, drag pans freely, double-click or the
  // round-arrow button fits the chart back to the newest column, and − / + zoom around the view centre. No scrollbars.
  const pendingRef = useRef<{ left: number; top: number } | 'reset' | null>(null);
  const [scrollTick, setScrollTick] = useState(0);
  const zoomBy = (factor: number, ax?: number, ay?: number) => {
    const el = wrapRef.current;
    const next = Math.min(6, Math.max(0.3, +(zoom * factor).toFixed(3)));
    if (!el || next === zoom) return;
    const x = ax ?? el.clientWidth / 2;
    const y = ay ?? el.clientHeight / 2;
    // The column and price under the anchor stay under it: read them off the current layout, place them on the next one.
    const L2 = layoutPanel(liveCols, box, liveValue, viewW, HEIGHT, next, true, xScale);
    const j = (el.scrollLeft + x - offsetX) / colW;
    const u = (el.scrollTop + y - padY - PAD_TOP) / cell;
    pendingRef.current = { left: L2.offsetX + j * L2.colW - x, top: L2.padY + PAD_TOP + u * L2.cell - y };
    stickRef.current = false;
    touchedRef.current = true;
    setZoom(next);
  };
  // Vertical-only zoom (the price axis drag): the boxes grow / shrink in height while the column pitch stays, so xScale takes up
  // the change in cell size. The price under the view centre stays put; the horizontal scroll does not move.
  const yZoomBy = (factor: number) => {
    const el = wrapRef.current;
    const next = Math.min(6, Math.max(0.3, +(zoom * factor).toFixed(3)));
    if (!el || next === zoom) return;
    const y = el.clientHeight / 2;
    const L2 = layoutPanel(liveCols, box, liveValue, viewW, HEIGHT, next, true, xScale);
    const nextXScale = colW / L2.cell;   // layoutPanel rounds cell x xScale back to exactly colW
    const u = (el.scrollTop + y - padY - PAD_TOP) / cell;
    pendingRef.current = { left: el.scrollLeft, top: L2.padY + PAD_TOP + u * L2.cell - y };
    stickRef.current = false;
    touchedRef.current = true;
    setZoom(next);
    setXScale(nextXScale);
  };
  // Horizontal-only zoom: the columns move apart / together, the box height and the glyph size stay. The column under the anchor stays put.
  const xZoomBy = (factor: number, ax?: number) => {
    const el = wrapRef.current;
    // A vertical zoom can leave xScale outside the range: it may still step back towards it, never further out.
    const next = Math.min(Math.max(XSCALE_MAX, xScale), Math.max(Math.min(XSCALE_MIN, xScale), xScale * factor));
    if (!el || next === xScale) return;
    const x = ax ?? el.clientWidth / 2;
    const L2 = layoutPanel(liveCols, box, liveValue, viewW, HEIGHT, zoom, true, next);
    const j = (el.scrollLeft + x - offsetX) / colW;
    pendingRef.current = { left: L2.offsetX + j * L2.colW - x, top: el.scrollTop };
    stickRef.current = false;
    touchedRef.current = true;
    setXScale(next);
  };
  const resetView = () => { touchedRef.current = false; pendingRef.current = 'reset'; stickRef.current = false; gapRef.current = 0; setZoom(1); setXScale(1); setScrollTick(n => n + 1); };
  useLayoutEffect(() => {
    const el = wrapRef.current;
    const pending = pendingRef.current;
    if (!el || !pending) return;
    pendingRef.current = null;
    if (pending === 'reset') {
      // Centre the newest column (the plot is the view minus the pinned axis) and the latest price.
      el.scrollLeft = Math.max(0, xOf(liveCols.length - 0.5) - (el.clientWidth - AXIS_W) / 2);
      if (lastY !== null && box > 0) el.scrollTop = topFor(el);
    } else {
      el.scrollLeft = pending.left;
      el.scrollTop = pending.top;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, xScale, scrollTick]);
  const seenReset = useRef(resetTick);
  useEffect(() => {
    if (seenReset.current === resetTick) return;   // mount (and StrictMode's second mount) is not a reset request
    seenReset.current = resetTick;
    resetView();
  }, [resetTick]);
  const zoomRef = useRef(zoomBy);
  const xZoomRef = useRef(xZoomBy);
  const yZoomRef = useRef(yZoomBy);
  useLayoutEffect(() => { zoomRef.current = zoomBy; xZoomRef.current = xZoomBy; yZoomRef.current = yZoomBy; });
  // Press on the price axis and drag: up stretches the boxes taller, down squeezes them (about the view centre), like a charting
  // package's price scale. Vertical only: the columns keep their width.
  const zoomNowRef = useRef(zoom);
  useLayoutEffect(() => { zoomNowRef.current = zoom; });
  const axisDragRef = useRef<{ y: number; z: number } | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // Shift + wheel stretches / squeezes the columns only (browsers may report the shifted wheel as deltaX); the plain wheel zooms both ways.
      const d = e.deltaY || e.deltaX;
      if (e.shiftKey) xZoomRef.current(d < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left);
      else zoomRef.current(d < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [wrapRef]);
  const dragRef = useRef<{ x: number; y: number; l: number; t: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Crosshair: the pointer in content coordinates, snapped to the column (vertical) and to the box row (horizontal) under it.
  // P&F prices are discrete, so the price tag names the box the pointer is in, not a price between two boxes.
  const [hover, setHover] = useState<{ x: number; y: number; overAxis: boolean } | null>(null);
  // A rail order being dragged to another box: its preview level (committed on release).
  const [railHot, setRailHot] = useState<{ side: 'BUY' | 'SELL'; p: number; kind: string } | null>(null);
  const [railDrag, setRailDrag] = useState<{ id: string; level: number; start: number } | null>(null);

  const trackHover = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const vx = e.clientX - r.left;
    setHover({ x: vx + el.scrollLeft, y: e.clientY - r.top + el.scrollTop, overAxis: vx > el.clientWidth - AXIS_W - (rail ? RAIL_W : 0) });
  };
  const rowTop = padY + PAD_TOP;
  const TIME_AXIS_H = 24;
  const axisLabels = useMemo(
    // Renko gets TradingView's 1-minute Renko axis (days with times between them) whatever span the history covers.
    () => (timeAxis ? timeAxisLabels(model.columnTimes.map(t => t.start), model.columnTimes.map((_, j) => offsetX + j * colW + colW / 2), 44, renko ? 'intraday' : undefined) : []),
    [timeAxis, model.columnTimes, offsetX, colW, renko],
  );
  // Tags at the chart's right edge (resting orders, planned exits, the open position): tags whose levels are within a row or two of each
  // other are spread apart (and re-centred on their levels) so no two print over each other. The level lines stay at the true price.
  const railTagY = (() => {
    if (!rail || rail.linesShown === false) return new Map<string, number>();
    const items: { key: string; y: number }[] = [];
    for (const o of rail.orders) {
      items.push({ key: `o:${o.id}`, y: yOf(railDrag?.id === o.id ? railDrag.level : o.level) });
      for (const k of o.planned ?? []) items.push({ key: `p:${o.id}:${k.role}`, y: yOf(railDrag?.id === `plan:${o.id}:${k.role}` ? railDrag.level : k.level) });
    }
    if (rail.position && rail.position.avg !== null) items.push({ key: 'pos', y: yOf(rail.position.avg) });
    return layoutTags(items, 18);
  })();
  const cross = (() => {
    if (!hover || dragging || box <= 0 || !liveCols.length) return null;
    const row = Math.floor((hover.y - rowTop) / cell);
    if (row < 0 || row >= L.rows) return null;
    const price = yMax - (row + 0.5) * box;                      // yMax is a cell edge: this is the row's box price
    const j = Math.floor((hover.x - offsetX) / colW);
    const col = !hover.overAxis && j >= 0 && j < columns.length ? j : null;
    return { price, y: yOf(price), col, x: col !== null ? xOf(col) + colW / 2 : hover.overAxis ? null : hover.x };
  })();
  // Glyph geometry as path strings, rebuilt only when the chart or its layout changes (not on a crosshair move).
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const xGlyph = (cx: number, cy: number) => `M${r1(cx - sx)} ${r1(cy - sy)}L${r1(cx + sx)} ${r1(cy + sy)}M${r1(cx + sx)} ${r1(cy - sy)}L${r1(cx - sx)} ${r1(cy + sy)}`;
  const oGlyph = (cx: number, cy: number) => `M${r1(cx - sx)} ${r1(cy)}a${r1(sx)} ${r1(sy)} 0 1 0 ${r1(2 * sx)} 0a${r1(sx)} ${r1(sy)} 0 1 0 ${r1(-2 * sx)} 0`;
  // A Renko brick: a filled rectangle across the full column pitch and box height (adjacent bricks touch, as in TradingView).
  const brick = (j: number, top: number) => `M${r1(xOf(j))} ${r1(yOf(top))}h${r1(colW)}v${r1(cell)}h${r1(-colW)}z`;
  // Only the columns near the view are drawn: the visible ones plus one view width either side, in WINDOW_CHUNK steps so the
  // paths are rebuilt when the view crosses a chunk, not on every scroll pixel. A Renko chart over years holds 50k-100k+ bricks;
  // drawing every one made each crosshair move and pan repaint the whole history.
  const viewPx = Math.max(1, width);
  const leftPx = viewRight === null ? Math.max(0, contentW - 2 * viewPx) : viewLeft;   // before the first scroll: the newest columns
  const w0 = Math.max(0, Math.floor(Math.floor((leftPx - viewPx - offsetX) / colW) / WINDOW_CHUNK) * WINDOW_CHUNK);
  const w1 = Math.min(liveCols.length, (Math.floor(Math.max(0, Math.ceil((leftPx + 2 * viewPx - offsetX) / colW)) / WINDOW_CHUNK) + 1) * WINDOW_CHUNK);
  const inWindow = (j: number) => j >= w0 && j < w1;
  const glyphs = useMemo(() => {
    let x = '', o = '';
    const end = Math.min(w1, columns.length);
    if (renko) {
      for (let j = w0; j < end; j++) { const c = columns[j]; if (c.dir === 'X') x += brick(j, c.high); else o += brick(j, c.high); }
      return { x, o };
    }
    for (let j = w0; j < end; j++) {
      const c = columns[j];
      const cx = xOf(j) + colW / 2;
      for (let k = 0; k < c.boxes; k++) {
        const cy = yOf(c.low + (k + 0.5) * box);
        if (c.dir === 'X') x += xGlyph(cx, cy);
        else o += oGlyph(cx, cy);
      }
    }
    return { x, o };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renko, columns, box, cell, colW, offsetX, yMax, padY, sx, sy, w0, w1]);
  const unconfirmed = unconfirmedBoxes(columns, liveCols, box);
  const unconfirmedPaths = useMemo(() => {
    let x = '', o = '', n = 0;
    for (const { col, ks } of unconfirmed) {
      const lc = liveCols[col];
      for (const k of ks) {
        n++;
        if (renko) { const top = lc.low + (k + 1) * box; if (lc.dir === 'X') x += brick(col, top); else o += brick(col, top); continue; }
        if (lc.dir === 'X') x += xGlyph(xOf(col) + colW / 2, yOf(lc.low + (k + 0.5) * box));
        else o += oGlyph(xOf(col) + colW / 2, yOf(lc.low + (k + 0.5) * box));
      }
    }
    return { x, o, n };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renko, liveCols, columns, box, cell, colW, offsetX, yMax, padY, sx, sy]);

  const lastEntryId = useMemo(() => { for (let i = signals.length - 1; i >= 0; i--) if (signals[i].kind === 'DOUBLE_BOTTOM_SELL' && signals[i].belowVwap) return signals[i].id; return undefined; }, [signals]);
  const ring = flash === 'buy' ? 'ring-2 ring-emerald-400' : flash === 'sell' ? 'ring-2 ring-red-400' : '';

  const overlayPts = !overlayShown ? '' : vis.slice(w0, w1)
    .map((c, k) => ({ v: model.overlay[first + w0 + k], x: xOf(w0 + k) + colW / 2 }))
    .filter(p => p.v !== null)
    .map(p => `${p.x},${yOf(p.v as number)}`)
    .join(' ');

  // Supertrend: one path per direction through the brick centres; a flip starts a new segment on the other side, like TradingView.
  const stPaths = useMemo(() => {
    if (!supertrendShown || !model.supertrend.length) return { up: '', down: '' };
    let up = '', down = '';
    const st = model.supertrend;
    for (let j = Math.max(0, w0); j < Math.min(w1, st.length); j++) {
      const cur = st[j];
      if (cur.line === null || cur.dir === null) continue;
      const prev = j > 0 ? st[j - 1] : null;
      const cont = !!prev && prev.line !== null && prev.dir === cur.dir && j > w0;
      const seg = `${cont ? 'L' : 'M'}${offsetX + j * colW + colW / 2},${padY + PAD_TOP + ((yMax - cur.line) / box) * cell}`;
      if (cur.dir === 1) up += seg; else down += seg;
    }
    return { up, down };
  }, [supertrendShown, model.supertrend, w0, w1, offsetX, colW, padY, yMax, box, cell]);

  // Renko: a label every ~40 px on a round multiple of the box (22,640 / 22,680 ...) like TradingView; its history spans years, so
  // nine labels over the whole range would put them a thousand points apart. P&F: about nine labels over the range.
  const minRows = Math.max(1, Math.ceil(40 / Math.max(1, cell)));
  const renkoStep = [1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000].find(n => n >= minRows) ?? minRows;
  const tickEvery = renko ? renkoStep : Math.max(1, Math.round(((yMax - yMin) / box) / 9));
  // Rows worth labelling: the view plus one view height above and below (all rows until the first scroll is known). A Renko chart
  // over years spans thousands of rows; labelling all of them on every crosshair move cost ~1 s a frame.
  const visTop = viewTop === null ? 0 : viewTop - HEIGHT;
  const visBottom = viewTop === null ? contentH : viewTop + 2 * HEIGHT;
  const rowAtY = (y: number) => (yMax - ((y - padY - PAD_TOP) / cell) * box - yMin) / box;   // row index (from yMin) at content y
  const axisRows = Math.round((yMax - yMin) / box);
  const axisFrom = Math.max(0, Math.floor(rowAtY(Math.min(contentH, visBottom))) - 1);
  const axisTo = Math.min(axisRows, Math.ceil(rowAtY(Math.max(0, visTop))) + 1);
  // Axis labels name the box centres (the price each row of X / O stands for). Whole rupees once a box is 10 or more: the
  // paise are noise at that size and a six-figure price still fits the axis.
  const axisDigits = box >= 10 ? 0 : 2;
  const liveDigits = liveValue !== null && liveValue >= 100_000 ? 0 : 2;

  // Everything drawn from the chart's data (glyphs / bricks, unconfirmed boxes, the overlay, signals, triangles, trade markers),
  // built once per data / layout / window change. The crosshair is state in this component, so without this every mouse move
  // re-created all of it (~1 s a frame on a long Renko chart in dev mode).
  const chartLayer = useMemo(() => (
    <>
      {/* X / O glyphs: every X in one path and every O in another (a chart can hold tens of thousands of boxes; one element
          each made every crosshair move and live tick re-render them all). The session dividers mark the days, so no day numbers. */}
      {renko ? (
        <>
          {/* Renko bricks: up bricks in one path, down bricks in another; a hairline border only once a brick is wide enough */}
          <path data-testid="pnf-bricks-up" d={glyphs.x} className="fill-teal-500 stroke-teal-700" strokeWidth={colW >= 4 ? 0.6 : 0} />
          <path data-testid="pnf-bricks-down" d={glyphs.o} className="fill-red-500 stroke-red-700" strokeWidth={colW >= 4 ? 0.6 : 0} />
        </>
      ) : (
        <>
          <path data-testid="pnf-glyphs-x" d={glyphs.x} className="stroke-emerald-400" strokeWidth={stroke} strokeLinecap="round" fill="none" />
          <path data-testid="pnf-glyphs-o" d={glyphs.o} className="stroke-red-400" strokeWidth={stroke} fill="none" />
        </>
      )}
      {/* the newest confirmed column's cells: a hook for tests and nothing else */}
      {columns.length > 0 && (
        <rect data-testid="pnf-newest" x={xOf(columns.length - 1)} y={yOf(columns[columns.length - 1].high)} width={colW}
              height={(columns[columns.length - 1].boxes) * cell} fill="none" pointerEvents="none" />
      )}

      {/* Unconfirmed boxes: what the bar still forming would add if it closed now, dimmed. They move with the price and can
          disappear; signals, the SMA and the date marks never use them. */}
      {unconfirmedPaths.n > 0 && (
        <g data-testid="pnf-unconfirmed" data-count={unconfirmedPaths.n} opacity={0.35}>
          {renko ? (
            <>
              <path d={unconfirmedPaths.x} className="fill-teal-500" />
              <path d={unconfirmedPaths.o} className="fill-red-500" />
            </>
          ) : (
            <>
              <path d={unconfirmedPaths.x} className="stroke-emerald-400" strokeWidth={stroke} strokeLinecap="round" fill="none" />
              <path d={unconfirmedPaths.o} className="stroke-red-400" strokeWidth={stroke} fill="none" />
            </>
          )}
        </g>
      )}

      {/* VWAP / SMA: one continuous line across the loaded sessions */}
      {overlayPts && (
        <polyline points={overlayPts} fill="none" strokeWidth={1.8}
                  className={kind === 'vwap' ? 'stroke-amber-300' : 'stroke-sky-400'} />
      )}

      {/* Supertrend (Renko): green below the bricks in an up trend, red above them in a down trend */}
      {stPaths.up && <path data-testid="pnf-supertrend-up" d={stPaths.up} fill="none" strokeWidth={1.6} className="stroke-emerald-500" />}
      {stPaths.down && <path data-testid="pnf-supertrend-down" d={stPaths.down} fill="none" strokeWidth={1.6} className="stroke-red-500" />}

      {/* short cover cue (the short-side rule): first bar of a green X column trading above VWAP */}
      {coverShown && exits.length > 0 && (
        <text data-testid="pnf-exit" x={xOf(exits[exits.length - 1].col) + colW / 2} y={yOf(columns[exits[exits.length - 1].col].high) - 4}
              textAnchor="middle" className="fill-emerald-400 font-mono font-bold" fontSize={9}>COVER</text>
      )}

      {/* triangles: the converging lines, a tag, and the two trigger levels (buy above / sell below); after a breakout the
          entry, stop and vertical-count target of the pattern's trade */}
      {triShown && triangles.slice(-8).map(t => {
        const first = columns[t.startCol];
        if (!first) return null;
        let lastX = -1, lastO = -1;
        for (let i = t.startCol; i <= t.endCol; i++) { if (columns[i].dir === 'X') lastX = i; else lastO = i; }
        if (lastX < 0 || lastO < 0) return null;
        const tone = t.state === 'up' ? 'emerald' : t.state === 'down' ? 'red' : t.state === 'forming' ? 'amber' : 'zinc';
        const stroke = tone === 'emerald' ? 'stroke-emerald-400' : tone === 'red' ? 'stroke-red-400' : tone === 'amber' ? 'stroke-amber-400' : 'stroke-zinc-400';
        const fillTxt = tone === 'emerald' ? 'fill-emerald-400' : tone === 'red' ? 'fill-red-400' : tone === 'amber' ? 'fill-amber-400' : 'fill-zinc-400';
        const xStart = xOf(t.startCol) + colW / 2;
        const xLevels = xOf(t.endCol) + colW / 2;
        const xEnd = Math.min(plotW, xOf(t.breakout ? t.breakout.col : t.endCol + 1) + colW * 6);
        const b = t.breakout;
        const lvl = (price: number, label: string, cls: string, dash: string) => {
          const y = yOf(price);
          return (
            <g key={label}>
              <line x1={xLevels} x2={xEnd} y1={y} y2={y} strokeWidth={1.25} strokeDasharray={dash} className={cls} />
              <text x={xEnd - 4} y={y - 3} textAnchor="end" className={`${fillTxt} font-mono`} fontSize={10} fontWeight={700}>{`${label} ${fmt(price, axisDigits)}`}</text>
            </g>
          );
        };
        return (
          <g key={`tri${t.startCol}`} data-testid="pnf-triangle" data-state={t.state} data-cols={t.nCols} pointerEvents="none">
            <line x1={xStart} x2={xOf(lastX) + colW / 2} y1={yOf(first.high)} y2={yOf(columns[lastX].high)} strokeWidth={1.5} strokeDasharray="1 4" strokeLinecap="round" className={stroke} />
            <line x1={xStart} x2={xOf(lastO) + colW / 2} y1={yOf(first.low)} y2={yOf(columns[lastO].low)} strokeWidth={1.5} strokeDasharray="1 4" strokeLinecap="round" className={stroke} />
            <text x={xStart} y={yOf(first.high) - 6} className={`${fillTxt} font-mono`} fontSize={10} fontWeight={700}>{`△${t.nCols}${t.state === 'forming' ? ' forming' : ''}`}</text>
            {!b ? (
              <>
                {lvl(t.buyAbove, 'Buy above', 'stroke-emerald-400', '5 3')}
                {lvl(t.sellBelow, 'Sell below', 'stroke-red-400', '5 3')}
              </>
            ) : (
              <>
                {lvl(b.entry, `${b.side === 'UP' ? '▲' : '▼'} Entry`, stroke, '')}
                {lvl(b.stop, 'Stop', 'stroke-red-400', '5 3')}
                {lvl(b.target, `Target · RR 1:${b.rr.toFixed(1)}`, 'stroke-emerald-400', '1 4')}
              </>
            )}
          </g>
        );
      })}

      {/* double top buy / double bottom sell: a horizontal support/resistance line across from the previous swing extreme
          to the breaking column */}
      {renko && signals.filter(g => inWindow(g.col)).map(g => {
        // Renko N-brick confirmation: an arrow just past the confirming brick's close (below a SELL, above a BUY)
        const sell = isSellSignal(g.kind);
        const cx = xOf(g.col) + colW / 2;
        const y = sell ? yOf(columns[g.col].low) + 3 : yOf(columns[g.col].high) - 3;
        const d = sell ? `M${cx} ${y + 7}l-4 -7h8z` : `M${cx} ${y - 7}l-4 7h8z`;
        return (
          <path key={g.id} data-testid="pnf-signal" data-kind={g.kind} data-col={g.col} d={d}
                className={sell ? 'fill-red-400' : 'fill-teal-300'} pointerEvents="none" />
        );
      })}
      {!renko && signals.filter(g => inWindow(g.col)).map(g => {
        const sell = g.kind === 'DOUBLE_BOTTOM_SELL';
        const entry = sell && g.belowVwap;
        const levelPrice = sell ? columns[g.col - 2].low : columns[g.col - 2].high;
        const y = yOf(levelPrice);
        const x1 = xOf(g.col - 2);
        const x2 = xOf(g.col) + colW + 6;
        // The short-entry tag sits under the level where columns col-2 and col-1 meet: col-2's lowest O is ON the level and
        // col-1 (an X column) starts a box above it, so below the line there is empty grid. Under the breaking column it
        // would cover that column's Os.
        const tagX = xOf(g.col - 1);
        const strokeCls = sell ? 'stroke-red-400' : 'stroke-emerald-400';
        return (
          <g key={g.id} data-testid="pnf-signal" data-kind={g.kind} data-col={g.col} data-entry={entry ? '1' : '0'}>
            {/* The horizontal support/resistance level line */}
            <line x1={x1} x2={x2} y1={y} y2={y} strokeWidth={entry ? 2.5 : 1.8} strokeDasharray={entry ? undefined : '4 2'}
                  className={strokeCls} strokeLinecap="round" />
            {g.id === lastEntryId && (
              <g>
                <rect x={tagX - 18} y={y + 4} width={36} height={13} rx={2} className="fill-red-500/20 stroke-red-500/40" />
                <text x={tagX} y={y + 14} textAnchor="middle" className="fill-red-400 font-mono font-bold" fontSize={9}>SHORT</text>
              </g>
            )}
          </g>
        );
      })}

      {/* trade execution markers on the box */}
      {markersShown && tradeMarkers && tradeMarkers.length > 0 && (() => {
        const groups = new Map<string, Array<{ marker: PnfExecutionMarker; colIdx: number; boxPrice: number; idx: number }>>();

        tradeMarkers.forEach((m, idx) => {
          let colIdx = m.col;
          if (colIdx === undefined || colIdx < 0 || colIdx >= liveCols.length) {
            if (model.columnTimes && model.columnTimes.length > 0) {
              let found = model.columnTimes.findIndex(ct => m.t >= ct.start && m.t <= ct.end);
              // One bar can print several Renko bricks: the marker goes on the one of them that holds its price.
              for (let j = found; found !== -1 && j < liveCols.length && model.columnTimes[j] && m.t >= model.columnTimes[j].start && m.t <= model.columnTimes[j].end; j++) {
                if (m.price >= liveCols[j].low - 1e-9 && m.price <= liveCols[j].high + 1e-9) { found = j; break; }
              }
              if (found !== -1) colIdx = found;
              else if (m.t > model.columnTimes[model.columnTimes.length - 1].end) colIdx = liveCols.length - 1;
              else colIdx = 0;
            } else {
              colIdx = Math.max(0, liveCols.length - 1);
            }
          }

          // P&F rows are centred on anchor + k * box; a Renko brick spans [k, k + 1) boxes, so its marker sits at the brick's middle
          const boxK = box > 0 ? (renko ? Math.floor((m.price - model.anchor) / box) : Math.round((m.price - model.anchor) / box)) : 0;
          const boxPrice = model.anchor + (renko ? boxK + 0.5 : boxK) * box;
          const key = `${colIdx}:${boxK}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push({ marker: m, colIdx, boxPrice, idx });
        });

        return Array.from(groups.values()).flatMap(group => {
          const total = group.length;
          const r = Math.max(5.5, Math.min(10, cell * 0.4));
          const fontSize = Math.max(7, Math.min(11, r * 1.1));

          return group.map(({ marker: m, colIdx, boxPrice, idx }, groupIdx) => {
            const baseCx = xOf(colIdx) + colW / 2;
            const shift = total > 1 ? (groupIdx - (total - 1) / 2) * (r * 1.5) : 0;
            const cx = baseCx + shift;
            const cy = yOf(boxPrice);
            const isBuy = m.action === 'BUY';

            return (
              <g
                key={m.id || `marker-${idx}`}
                data-testid="pnf-trade-marker"
                data-action={m.action}
                data-price={m.price}
                data-col={colIdx}
                className="select-none pointer-events-auto"
              >
                {/* Directional pip pointer */}
                {isBuy ? (
                  <polygon
                    points={`${cx},${cy - r - 4} ${cx - 3.5},${cy - r} ${cx + 3.5},${cy - r}`}
                    className="fill-emerald-400 stroke-zinc-950"
                    strokeWidth={1}
                  />
                ) : (
                  <polygon
                    points={`${cx},${cy + r + 4} ${cx - 3.5},${cy + r} ${cx + 3.5},${cy + r}`}
                    className="fill-red-400 stroke-zinc-950"
                    strokeWidth={1}
                  />
                )}

                {/* Badge circle */}
                <circle
                  cx={cx}
                  cy={cy}
                  r={r}
                  className={isBuy ? 'fill-emerald-500 stroke-zinc-950' : 'fill-red-500 stroke-zinc-950'}
                  strokeWidth={1.5}
                />

                {/* Action initial */}
                <text
                  x={cx}
                  y={cy + 0.5}
                  textAnchor="middle"
                  dominantBaseline="central"
                  className={isBuy ? 'fill-zinc-950 font-mono font-black' : 'fill-white font-mono font-black'}
                  fontSize={fontSize}
                >
                  {isBuy ? 'B' : 'S'}
                </text>

                <title>{`${m.action} ${m.lots} lot${m.lots > 1 ? 's' : ''} @ ${m.estimate ? '~' : ''}${m.price.toFixed(2)} [${m.mode}]${m.estimate ? ' (live price at the click; traded price not reported yet)' : ''}`}</title>
              </g>
            );
          });
        });
      })()}
    </>
  // xOf / yOf / inWindow are rebuilt every render from the layout values listed here
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [renko, glyphs, colW, columns, cell, offsetX, yMax, padY, box, unconfirmedPaths, overlayPts, stPaths, kind, coverShown, exits, triShown, triangles, plotW, axisDigits, signals, w0, w1, lastEntryId, markersShown, tradeMarkers, model, liveCols, stroke]);

  return (
    <section
      data-testid="pnf-panel"
      data-strike={strike}
      data-active={onActivate ? active : undefined}
      onPointerDownCapture={onActivate && !active ? onActivate : undefined}
      className={`min-w-0 rounded-lg border bg-zinc-900 flex flex-col ${active && onActivate ? 'border-amber-500/60' : 'border-zinc-800'} ${fill ? 'h-full min-h-0' : ''} ${ring}`}
    >
      {headerSlot ? createPortal(
        <div className="flex items-center gap-3 min-w-0" aria-label={`${title} summary`}>
          {/* price block: scrip, live price, change pill */}
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="flex flex-col leading-none">
              <span data-testid="pnf-scrip" className="text-[13px] font-bold tracking-tight text-white">{scrip ?? title}</span>
              {sessionTag
                ? <span data-testid="pnf-session-tag" className="mt-1 text-[10px] font-bold uppercase tracking-wider text-sky-300">{sessionTag}</span>
                : stale && <span className="mt-1 text-[10px] font-bold uppercase tracking-wider text-amber-300">Stale</span>}
            </div>
            <span className="text-xl font-bold font-mono tabular-nums text-white leading-none">{liveValue !== null ? fmt(liveValue) : '—'}</span>
            {change !== null && changePct !== null && (
              <span data-testid="pnf-vs-open" className="flex items-center gap-1.5">
                <span className={`px-1.5 py-0.5 rounded border text-xs font-bold font-mono tabular-nums ${change >= 0
                  ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-red-400 border-red-500/30 bg-red-500/10'}`}>
                  {signed(change)} ({signed(changePct)}%)
                </span>
                <span className="text-[11px] font-medium text-zinc-400">{changeLabel}</span>
              </span>
            )}
          </div>
          <span className="w-px h-6 bg-zinc-700 shrink-0" />
          {/* chart facts: muted label, bright value */}
          <div className="flex items-center gap-3 min-w-0 text-xs font-mono tabular-nums">
            {legs && (
              <span className="shrink-0 text-zinc-400">
                CE <span className="font-semibold text-zinc-100">{live ? fmt(live.ce) : '—'}</span>{' '}
                PE <span className="font-semibold text-zinc-100">{live ? fmt(live.pe) : '—'}</span>
              </span>
            )}
            {overlayShown && (
              <span data-testid="pnf-overlay-legend" className="shrink-0">
                <span className={`font-bold ${kind === 'vwap' ? 'text-amber-400' : 'text-sky-400'}`}>{overlayLabel}</span>
                {overlayNow !== null && <span className="font-semibold text-zinc-100">{` ${fmt(overlayNow)}`}</span>}
                {smaWaiting && <span className="text-zinc-500">{` needs ${model.smaPeriod} ${unitWord} (${totalBoxes} so far)`}</span>}
              </span>
            )}
            {stLegend}
            <span data-testid="pnf-box-info" className="flex items-center gap-3 min-w-0 text-zinc-400 truncate" title={box > 0 ? boxTitle : undefined}>
              {box > 0 ? (
                <>
                  <span className="shrink-0">Box <span className="font-semibold text-zinc-100">{box.toFixed(2)}</span>{' '}
                    <span className={model.boxClamped ? 'text-amber-400' : 'text-zinc-500'}>({boxNote})</span></span>
                  <span className="shrink-0"><span className="font-semibold text-zinc-100">{ruleText}</span>{renko ? '' : ' rev'}</span>
                  <span className="shrink-0"><span className="font-semibold text-zinc-100">{columns.length}</span> {renko ? 'bricks' : 'cols'}</span>
                  {model.sessions.length > 0 && (
                    <span className="truncate"><span className="font-semibold text-zinc-100">{model.sessions.length}</span> sessions{' '}
                      <span className="text-zinc-500">({shortDate(model.sessions[0])} – {shortDate(model.sessions[model.sessions.length - 1])})</span></span>
                  )}
                </>
              ) : 'Box —'}
            </span>
          </div>
          {lastSignal && (
            <span data-testid="pnf-last-signal"
                  className={`shrink-0 text-[11px] font-bold font-mono px-2 py-0.5 rounded border ${
                    isSellSignal(lastSignal.kind)
                      ? 'text-red-400 border-red-500/30 bg-red-500/10'
                      : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'}`}>
              {signalPill(lastSignal.kind, true)} {hhmm(lastSignal.t)}
            </span>
          )}
        </div>,
        headerSlot,
      ) : null}

      {showHeader && (
      // Two charts side by side: one line per card (the page header already carries the scrip, legs and session facts).
      <div className="px-3 py-1 border-b border-zinc-800 flex items-center gap-2 min-w-0 overflow-hidden text-[10px] font-mono">
        {/* The instrument name keeps its room; the VWAP / box detail is what truncates first. */}
        <h2 className="text-xs font-bold text-zinc-100 truncate shrink-0 max-w-[34%] font-sans" title={title}>{title}</h2>
        {autoSlot}
        {overlayShown && (
          <span data-testid="pnf-overlay-legend" className={`min-w-0 truncate ${kind === 'vwap' ? 'text-amber-300' : 'text-sky-300'}`}>
            {overlayLabel}{overlayNow !== null ? ` ${fmt(overlayNow)}` : smaWaiting ? ` needs ${model.smaPeriod}` : ''}
          </span>
        )}
        {stLegend}
        <span data-testid="pnf-box-info" className="text-zinc-500 truncate min-w-0 flex-1" title={box > 0 ? boxTitle : undefined}>
          {box > 0 ? `Box ${box.toFixed(2)} (${boxNote}) · ${ruleText} · ${columns.length} ${renko ? 'bricks' : 'cols'}` : 'Box —'}
        </span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {lastSignal && (
            <span data-testid="pnf-last-signal"
                  className={`font-bold px-1.5 py-0.5 rounded border ${
                    isSellSignal(lastSignal.kind)
                      ? 'text-red-400 border-red-500/30 bg-red-500/10'
                      : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'}`}>
              {signalPill(lastSignal.kind, false)} {hhmm(lastSignal.t)}
            </span>
          )}
          {sessionTag
            ? <span data-testid="pnf-session-tag" className="font-bold uppercase tracking-wider text-sky-300">{sessionTag}</span>
            : stale && <span className="font-bold uppercase tracking-wider text-amber-300">Stale</span>}
          <span className="text-sm font-bold text-white">{liveValue !== null ? fmt(liveValue) : '—'}</span>
          {change !== null && changePct !== null && (
            <span data-testid="pnf-vs-open" className={change >= 0 ? 'text-emerald-400' : 'text-red-400'}>{signed(changePct)}%</span>
          )}
        </span>
      </div>
      )}

      {autoSlot && headerSlot && !showHeader && (
        <div className="px-3 py-1 border-b border-zinc-800 flex items-center gap-2 min-w-0 text-[10px]">{autoSlot}</div>
      )}

      {!headerSlot && !showHeader && (
      <div className="px-3 pt-2 pb-1 border-b border-zinc-800">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-xs font-bold text-zinc-100 truncate">{title}</h2>
          <div className="flex items-center gap-2">
            {sessionTag
              ? <span data-testid="pnf-session-tag" className="text-[10px] font-bold uppercase tracking-wider text-sky-300">{sessionTag}</span>
              : stale && <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300">Stale</span>}
            <div className="flex flex-col items-end">
              <span className="text-lg font-bold font-mono text-white leading-none">{liveValue !== null ? fmt(liveValue) : '—'}</span>
              {change !== null && changePct !== null && (
                <span data-testid="pnf-vs-open" className={`mt-0.5 text-[10px] font-mono ${change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {signed(change)} ({signed(changePct)}%) {changeLabel}
                </span>
              )}
            </div>
          </div>
        </div>
        <p className="text-[10px] font-mono text-zinc-400 mt-1 truncate">
          {legs && <>CE {live ? fmt(live.ce) : '—'} · PE {live ? fmt(live.pe) : '—'} ·{' '}</>}
          <span data-testid="pnf-overlay-legend" className={kind === 'vwap' ? 'text-amber-300' : 'text-sky-300'}>
            {overlayLabel}{overlayNow !== null ? ` ${fmt(overlayNow)}` : smaWaiting ? ` needs ${model.smaPeriod} ${unitWord} (${totalBoxes} so far)` : ''}
          </span>
          {stLegend && <> · {stLegend}</>}
        </p>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p data-testid="pnf-box-info" className="text-[10px] font-mono text-zinc-500 truncate">
            {box > 0 ? `Box ${box.toFixed(2)} (${boxNote}) · ${ruleText} · ${columns.length} ${renko ? 'bricks' : 'cols'}${sessionsInfo}` : 'Box —'}
          </p>
          {lastSignal && (
            <span data-testid="pnf-last-signal"
                  className={`shrink-0 text-[10px] font-bold font-mono px-1.5 py-0.5 rounded border ${
                    isSellSignal(lastSignal.kind)
                      ? 'text-red-400 border-red-500/30 bg-red-500/10'
                      : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'}`}>
              {signalPill(lastSignal.kind, true)} {hhmm(lastSignal.t)}
            </span>
          )}
        </div>
      </div>
      )}

      <div className={`relative ${fill ? 'flex-1 min-h-0 flex flex-col' : ''}`}>
      {rail && (rail.lockable || rail.orders.some(o => o.state !== 'working') || rail.orders.filter(o => o.state === 'working').length > 1) && (
        <div data-testid="pnf-orders-bar" className="absolute top-1 left-2 z-10 flex flex-wrap items-center gap-1 max-w-[70%] font-sans">
          {rail.lockable && (
            <button type="button" onClick={rail.onToggleArm} aria-pressed={rail.armed !== false} data-testid="pnf-rail-lock"
                    aria-label={rail.armed !== false ? 'Lock the chart rail' : 'Unlock the chart rail to place orders'}
                    title={rail.armed !== false ? 'Rail unlocked: clicks place REAL orders. Click to lock.' : 'Rail locked: clicks do nothing. Click to unlock for REAL orders.'}
                    className={`h-6 px-2 rounded border text-[11px] font-bold ${FOCUS_RING} ${rail.armed !== false ? 'border-red-500/60 bg-red-600 text-oncolor' : 'border-zinc-600 bg-zinc-800 text-zinc-200'}`}>
              {rail.armed !== false ? 'UNLOCKED' : 'LOCKED'}
            </button>
          )}
          {rail.lockable && rail.onToggleInstant && (
            <button type="button" onClick={rail.onToggleInstant} aria-pressed={!!rail.instant} data-testid="pnf-rail-instant"
                    title="Instant: moving or cancelling a REAL order skips the confirm question. Off by default."
                    className={`h-6 px-2 rounded border text-[11px] font-bold ${FOCUS_RING} ${rail.instant ? 'border-amber-500/60 bg-amber-500/20 text-amber-400' : 'border-zinc-600 bg-zinc-800 text-zinc-200'}`}>
              Instant {rail.instant ? 'ON' : 'OFF'}
            </button>
          )}
          {/* working orders are in the ladder itself (their pill has the size, - / + and x); a chip stays only for an order that needs settling */}
          {rail.orders.filter(o => o.state !== 'working').map(o => (
            <span key={o.id} data-testid="pnf-orders-chip"
                  className={`inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded border text-[11px] font-mono font-bold bg-zinc-900 ${o.side === 'BUY' ? 'border-emerald-500/50 text-emerald-400' : 'border-red-500/50 text-red-400'}`}>
              {orderText(o)}
              {(o.state === 'working' || o.resolvable) && (
                <button type="button" onClick={() => rail.onCancel(o.id)} aria-label={`${o.state === 'working' ? 'Cancel' : 'Settle'} ${o.side} ${o.kind === 'limit' ? 'limit' : 'SL-limit'} at ${fmt(o.level, 2)}`}
                        className={`w-5 h-5 rounded text-zinc-300 hover:bg-zinc-700 ${FOCUS_RING}`}>×</button>
              )}
            </span>
          ))}
          {rail.orders.filter(o => o.state === 'working').length > 1 && rail.onCancelAll && (
            <button type="button" onClick={rail.onCancelAll} data-testid="pnf-cancel-all" title="Cancel every working order on this chart (Shift+C)"
                    className={`h-6 px-2 rounded border border-zinc-600 bg-zinc-800 text-[11px] font-bold text-zinc-200 hover:bg-zinc-700 ${FOCUS_RING}`}>Cancel all</button>
          )}
        </div>
      )}
      <div
        ref={wrapRef}
        data-testid="pnf-scroll"
        role="region"
        aria-label={`${title} chart, scrollable`}
        tabIndex={0}
        onKeyDown={e => { if (rail?.onCancelAll && e.shiftKey && e.key.toLowerCase() === 'c' && rail.orders.some(o => o.state === 'working')) { e.preventDefault(); rail.onCancelAll(); } }}
        onPointerDown={e => {
          if (e.button !== 0) return;
          // Bar Replay: the click picks the start bar instead of panning
          if (replayPick) {
            const col = cross?.col;
            if (col !== null && col !== undefined && model.columnTimes[col]) { e.preventDefault(); replayPick(model.columnTimes[col].start); }
            return;
          }
          touchedRef.current = true;
          const el = e.currentTarget;
          dragRef.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
          el.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={e => {
          const d = dragRef.current;
          if (!d) { trackHover(e); return; }
          e.currentTarget.scrollLeft = d.l - (e.clientX - d.x);
          e.currentTarget.scrollTop = d.t - (e.clientY - d.y);
        }}
        onPointerUp={e => {
          // Whether the chart keeps following the newest column is decided by the user's drag only. A scroll event cannot decide it:
          // the browser also scrolls on its own when the panel is resized (a window opening clamps scrollLeft), which used to
          // unstick a chart nobody had touched and leave it opened on the oldest column.
          if (dragRef.current) {
            const el = e.currentTarget;
            const sl = stickLeft(el);
            stickRef.current = el.scrollLeft >= sl - 30;
            gapRef.current = stickRef.current ? Math.max(0, el.scrollLeft - sl) / colW : 0;
          }
          dragRef.current = null; setDragging(false); trackHover(e);
        }}
        onPointerCancel={() => { dragRef.current = null; setDragging(false); }}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={resetView}
        onScroll={e => { const el = e.currentTarget; const v = Math.round(el.scrollLeft + el.clientWidth - AXIS_W - (rail ? RAIL_W : 0)); setViewRight(prev => (prev === v ? prev : v)); setViewLeft(Math.round(el.scrollLeft)); setViewTop(Math.round(el.scrollTop)); }}
        className={`relative overflow-auto select-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${dragging ? 'cursor-grabbing' : 'cursor-crosshair'} ${fill ? 'flex-1 min-h-0' : ''}`}
        style={fill ? { minHeight: 200 } : { height: 'calc(100vh - 215px)', minHeight: MIN_HEIGHT }}
      >
        {error ? (
          <p className="p-3 text-xs text-red-400">{error}</p>
        ) : loading ? (
          <p className="p-3 text-xs text-zinc-400">Loading…</p>
        ) : liveCols.length === 0 ? (
          <p className="p-3 text-xs text-zinc-400">{`Building chart — the first ${renko ? 'brick' : 'column'} needs a ${model.boxMode === 'pts' ? 'one-box' : `${boxPct}%`} move${interval > 1 ? ` on closed ${intervalLabel(interval)} bars` : ''}.`}</p>
        ) : (
          <>
          {/* The session names stay at the top of the view while the chart scrolls down (sticky, zero height so the chart does not move). */}
          {sessionLines && <div className="sticky top-0 z-20 h-0 pointer-events-none" style={{ width: plotW }} aria-hidden="true" data-testid="pnf-session-strip">
            <svg width={plotW} height={18} className="block">
              {(() => {
                let lastLabelX = -Infinity;
                return vis.map((c, j) => {
                  const prev = columns[first + j - 1];
                  if (prev && prev.session === c.session) return null;
                  const x = xOf(j);
                  if (x - lastLabelX < 64) return null;
                  lastLabelX = x;
                  const text = sessionLabel(c.session);
                  return (
                    <g key={`s${j}`}>
                      <rect x={x + 1} y={2} width={text.length * 6 + 8} height={14} rx={3} className="fill-zinc-900" opacity={0.9} />
                      <text x={x + 5} y={12.5} className="fill-zinc-300 font-mono" fontSize={10}>{text}</text>
                    </g>
                  );
                });
              })()}
            </svg>
          </div>}
          <div className="flex" style={{ width: contentW + (rail ? RAIL_W : 0), height: contentH }}>
            <svg width={plotW} height={contentH} className="block shrink-0" role="img" aria-label={`${title} ${renko ? 'Renko' : 'point and figure'} chart`}>
              <defs>
                <pattern id={gridId} x={offsetX} y={gridY} width={colW} height={cell} patternUnits="userSpaceOnUse">
                  <path d={`M${colW} 0V${cell}M0 ${cell}H${colW}`} fill="none" strokeWidth={1} className="stroke-zinc-800" />
                </pattern>
              </defs>
              <rect data-testid="pnf-grid" x={0} y={0} width={plotW} height={contentH} fill={`url(#${gridId})`} />

              {/* session dividers; a date is written only where it has room, so narrow sessions never print over each other */}
              {sessionLines && sessionDividers && (() => {
                return vis.slice(w0, w1).map((c, k) => {
                  const j = w0 + k;
                  const prev = columns[first + j - 1];
                  if (prev && prev.session === c.session) return null;   // the first column opens the first session, which is labelled too
                  const x = xOf(j);
                  return (
                    <g key={`d${j}`}>
                      <line x1={x} x2={x} y1={padY + PAD_TOP - 6} y2={contentH} className="stroke-zinc-600" strokeDasharray="2 3" />
                    </g>
                  );
                });
              })()}

              {chartLayer}

              {/* what a click on the rail row under the pointer would place: the side, the kind and the price */}
              {rail && railHot && !railDrag && (() => {
                const y = yOf(railHot.p);
                const text = `${railHot.side} ${railHot.kind === 'LIMIT' ? 'LMT' : railHot.kind === 'SL-limit' ? 'SL' : ''} @ ${fmt(railHot.p, axisDigits)}`;
                const w = text.length * 6.6 + 12;
                const x = Math.max(4, Math.min(plotW, viewRight ?? plotW) - w - 6);
                return (
                  <g data-testid="pnf-rail-hover-label" pointerEvents="none">
                    <line x1={0} x2={plotW} y1={y} y2={y} strokeWidth={1} strokeDasharray="2 4" className={railHot.side === 'BUY' ? 'stroke-emerald-400' : 'stroke-red-400'} />
                    <rect x={x} y={y - 9} width={w} height={18} rx={3} className={railHot.side === 'BUY' ? 'fill-emerald-600' : 'fill-red-600'} />
                    <text x={x + 6} y={y + 4} className="fill-oncolor font-mono" fontSize={11} fontWeight={700}>{text}</text>
                  </g>
                );
              })()}

              {/* the open position: an entry line across the chart with its side, size, entry premium and live P&L */}
              {rail?.linesShown !== false && rail?.position && rail.position.avg !== null && (() => {
                const pos = rail.position;
                const lineY = yOf(pos.avg as number);
                const y = railTagY.get('pos') ?? lineY;
                const text = `${pos.side} ${pos.lots}L @ ${fmt(pos.avg as number, 2)}${pos.pnl === null ? '' : ` · ${rupees(pos.pnl)}`}`;
                const w = text.length * 6.2 + 12;
                const x = rail.alignLeft ? Math.max(4, viewLeft + 6) : Math.max(4, Math.min(plotW, viewRight ?? plotW) - w - 6);
                const up = pos.pnl !== null && pos.pnl >= 0;
                return (
                  <g data-testid="pnf-position-line" data-side={pos.side} pointerEvents="none">
                    <line x1={0} x2={plotW} y1={lineY} y2={lineY} strokeWidth={1.25} strokeDasharray="1 3" strokeLinecap="round" className={pos.pnl === null ? 'stroke-zinc-400' : up ? 'stroke-emerald-300' : 'stroke-red-300'} />
                    <rect x={x} y={y - 8} width={w} height={16} rx={3} className={pos.pnl === null ? 'fill-zinc-700' : up ? 'fill-emerald-700' : 'fill-red-700'} />
                    <text x={x + 6} y={y + 3.5} className="fill-oncolor font-mono" fontSize={10} fontWeight={700}>{text}</text>
                  </g>
                );
              })()}

              {/* resting orders: a line across the chart at the level, and a tag by the newest columns (× cancels). An exit is green (target) or
                  red (stop-loss) whichever side it sells on; tags that would overlap are spread apart (railTagY), the line stays at the level. */}
              {rail && rail.linesShown !== false && rail.orders.map(o => {
                const level = railDrag?.id === o.id ? railDrag.level : o.level;
                const y = yOf(level);
                const ty = railTagY.get(`o:${o.id}`) ?? y;
                const buy = o.side === 'BUY';
                const text = orderText(o, railDrag?.id === o.id ? level : undefined);
                const w = text.length * 6 + 22;
                const x = rail.alignLeft ? Math.max(4, viewLeft + 6) : Math.max(4, Math.min(plotW, viewRight ?? plotW) - w - 6);
                const live = o.state === 'working';
                const tgt = o.role === 'target', sl = o.role === 'sl';
                const lineCls = tgt ? 'stroke-emerald-400' : sl ? 'stroke-red-400' : buy ? 'stroke-emerald-400' : 'stroke-red-400';
                const fillCls = tgt ? 'fill-emerald-700' : sl ? 'fill-red-600' : buy ? 'fill-emerald-600' : 'fill-red-600';
                return (
                  <g key={o.id} data-testid="pnf-order-line" data-side={o.side} data-kind={o.kind} data-state={o.state} data-role={o.role ?? ''}>
                    <line x1={0} x2={plotW} y1={y} y2={y} strokeWidth={1} strokeDasharray={o.mode === 'PAPER' ? '2 3' : '6 3'} className={lineCls} />
                    {Math.abs(ty - y) > 1 && <line x1={x} x2={x - 10} y1={ty} y2={y} strokeWidth={1} className={lineCls} />}
                    <rect x={x} y={ty - 8} width={w} height={16} rx={3} className={fillCls} opacity={live ? 1 : 0.55} />
                    <text x={x + 5} y={ty + 3.5} className="fill-oncolor font-mono" fontSize={10} fontWeight={700}>{text}</text>
                    {(live || o.resolvable) && (
                      <g data-testid={live ? 'pnf-order-cancel' : 'pnf-order-resolve'} role="button"
                         aria-label={`${live ? 'Cancel' : 'Settle (outcome unknown)'} ${o.side} ${o.kind === 'limit' ? 'limit' : 'SL-limit'} at ${fmt(o.level, 2)}`}
                         className="cursor-pointer" onPointerDown={e => { e.stopPropagation(); rail.onCancel(o.id); }}>
                        <rect x={x + w - 15} y={ty - 6} width={12} height={12} rx={2} className="fill-oncolor-dark/30" />
                        <text x={x + w - (live ? 12 : 13)} y={ty + 3.5} className="fill-oncolor" fontSize={10} fontWeight={700}>{live ? '×' : '?'}</text>
                      </g>
                    )}
                    {/* the exits this entry will place at its fill: dotted, dim, with their own tag */}
                    {(o.planned ?? []).map(k => {
                      const lv = railDrag?.id === `plan:${o.id}:${k.role}` ? railDrag.level : k.level;
                      const py = yOf(lv);
                      const pty = railTagY.get(`p:${o.id}:${k.role}`) ?? py;
                      const ptxt = `${k.role === 'sl' ? 'SL' : 'TGT'} @ ${fmt(lv, 2)} · planned`;
                      const pw = ptxt.length * 6 + 12;
                      const px = rail.alignLeft ? Math.max(4, viewLeft + 6) : Math.max(4, Math.min(plotW, viewRight ?? plotW) - pw - 6);
                      const pc = k.role === 'sl' ? 'red' : 'emerald';
                      return (
                        <g key={k.role} data-testid="pnf-planned-line" data-role={k.role}>
                          <line x1={0} x2={plotW} y1={py} y2={py} strokeWidth={1} strokeDasharray="1 4" opacity={0.75} className={pc === 'red' ? 'stroke-red-500' : 'stroke-emerald-500'} />
                          {Math.abs(pty - py) > 1 && <line x1={px} x2={px - 10} y1={pty} y2={py} strokeWidth={1} className={pc === 'red' ? 'stroke-red-500' : 'stroke-emerald-500'} />}
                          {/* an opaque page-coloured plate under the tint, so the grid does not run through the text */}
                          <rect x={px} y={pty - 8} width={pw} height={16} rx={3} className="fill-zinc-900" />
                          <rect x={px} y={pty - 8} width={pw} height={16} rx={3} className={pc === 'red' ? 'fill-red-500/15 stroke-red-500' : 'fill-emerald-500/15 stroke-emerald-500'} strokeWidth={1.25} strokeDasharray="3 2" />
                          <text x={px + 6} y={pty + 3.5} className={`font-mono ${pc === 'red' ? 'fill-red-400' : 'fill-emerald-400'}`} fontSize={10} fontWeight={800}>{ptxt}</text>
                        </g>
                      );
                    })}
                  </g>
                );
              })}

              {/* live price line */}
              {liveValue !== null && (
                <line x1={0} x2={plotW} y1={yOf(liveValue)} y2={yOf(liveValue)} className="stroke-zinc-400" strokeDasharray="3 3" />
              )}

              {/* Bar Replay: where it started (before the first column it revealed), and while picking a start, the line under the pointer
                  with everything to its right shaded (what the replay will reveal) */}
              {replayStartT !== null && (() => {
                // before the first column the replay revealed; until it reveals one, just after the newest column
                const k = model.columnTimes.findIndex(ct => ct.start > replayStartT);
                const j = k < 0 ? model.columnTimes.length : k;
                return <line data-testid="pnf-replay-start" x1={xOf(j)} x2={xOf(j)} y1={0} y2={contentH} className="stroke-sky-400" strokeWidth={1.5} strokeDasharray="6 4" pointerEvents="none" />;
              })()}
              {replayPick && cross && cross.x !== null && cross.col !== null && (
                <g data-testid="pnf-replay-pick-line" pointerEvents="none">
                  <rect x={xOf(cross.col)} y={0} width={Math.max(0, plotW - xOf(cross.col))} height={contentH} className="fill-sky-500/10" />
                  <line x1={xOf(cross.col)} x2={xOf(cross.col)} y1={0} y2={contentH} className="stroke-sky-400" strokeWidth={2} />
                  <g transform={`translate(${xOf(cross.col) - 9}, ${(viewTop ?? 0) + 8})`}>
                    <rect width={18} height={18} rx={3} className="fill-sky-500" />
                    <text x={9} y={13} textAnchor="middle" fontSize={12} className="fill-oncolor" aria-hidden="true">✂</text>
                  </g>
                </g>
              )}

              {/* crosshair */}
              {cross && (
                <g data-testid="pnf-crosshair" pointerEvents="none">
                  <line x1={0} x2={plotW} y1={cross.y} y2={cross.y} className="stroke-zinc-500" strokeWidth={1} strokeDasharray="4 3" />
                  {cross.x !== null && (
                    <line x1={cross.x} x2={cross.x} y1={0} y2={contentH} className="stroke-zinc-500" strokeWidth={1} strokeDasharray="4 3" />
                  )}
                </g>
              )}
            </svg>

            {/* the B / S rail (the ladder's columns): click a box row to rest an order there; drag an order's handle to move it */}
            {rail && (
              <RailSvg rail={rail} renko={renko} box={box} cell={cell} yMax={yMax} yMin={yMin} padY={padY} contentH={contentH} yOf={yOf}
                       liveValue={liveValue} axisDigits={axisDigits} onDrag={setRailDrag} onHot={setRailHot} visTop={visTop} visBottom={visBottom} />
            )}

            {/* price axis: sticky, so it stays at the panel's right edge while the chart is panned */}
            <svg width={AXIS_W} height={contentH} className="block shrink-0 sticky right-0 bg-zinc-900 cursor-ns-resize" data-testid="pnf-axis-drag"
                 onPointerDown={e => {
                   if (e.button !== 0) return;
                   e.stopPropagation();                      // not a chart pan
                   touchedRef.current = true;
                   axisDragRef.current = { y: e.clientY, z: zoomNowRef.current };
                   e.currentTarget.setPointerCapture(e.pointerId);
                 }}
                 onPointerMove={e => {
                   const d = axisDragRef.current;
                   if (!d) return;
                   e.stopPropagation();
                   yZoomRef.current(Math.exp((d.y - e.clientY) * 0.01) * d.z / zoomNowRef.current);
                 }}
                 onPointerUp={() => { axisDragRef.current = null; }}
                 onPointerCancel={() => { axisDragRef.current = null; }}>
              <g data-testid="pnf-axis">
                {Array.from({ length: Math.max(0, axisTo - axisFrom) }, (_, k) => axisFrom + k)
                  .filter(i => (renko ? Math.round((yMin + i * box) / box) : i) % tickEvery === 0)
                  .filter(i => liveValue === null || Math.abs(yOf(yMin + (i + (renko ? 0 : 0.5)) * box) - yOf(liveValue)) > 14)
                  .map(i => {
                    // yMin is a cell edge: P&F names the box centre, Renko the brick edge (its grid is on multiples of the box)
                    const p = yMin + (i + (renko ? 0 : 0.5)) * box;
                    return <text key={`t${i}`} x={6} y={yOf(p) + 3.5} className="fill-zinc-400 font-mono" fontSize={10}>{fmt(p, axisDigits)}</text>;
                  })}
              </g>
              {/* live price tag: the brightest-text / page-ground token pair, so it flips with the theme and is never mistaken for
                  the amber VWAP line */}
              {liveValue !== null && (
                <g>
                  <rect x={2} y={yOf(liveValue) - 8} width={AXIS_W - 4} height={16} rx={2} className="fill-zinc-100" />
                  <text x={6} y={yOf(liveValue) + 3.5} className="fill-black font-mono" fontSize={10} fontWeight={700}>{fmt(liveValue, liveDigits)}</text>
                </g>
              )}
              {cross && (
                <g data-testid="pnf-crosshair-price">
                  <rect x={2} y={cross.y - 8} width={AXIS_W - 4} height={16} rx={2} className="fill-zinc-700" />
                  <text x={6} y={cross.y + 3.5} className="fill-zinc-100 font-mono" fontSize={10} fontWeight={700}>{fmt(cross.price, axisDigits)}</text>
                </g>
              )}
            </svg>
          </div>
          {/* TradingView-style time axis: stays at the bottom of the view while the chart scrolls; days under their columns, and the
              crosshair's date and time as a chip. */}
          {timeAxis && (
            <div className="sticky bottom-0 h-0 z-20 pointer-events-none" style={{ width: plotW }} aria-hidden="true" data-testid="pnf-time-axis">
              <svg width={plotW} height={TIME_AXIS_H} className="block" style={{ transform: `translateY(-${TIME_AXIS_H}px)` }}>
                <rect x={0} y={0} width={plotW} height={TIME_AXIS_H} className="fill-zinc-900" />
                <line x1={0} x2={plotW} y1={0.5} y2={0.5} className="stroke-zinc-700" strokeWidth={1} />
                {axisLabels.filter(l => l.x >= xOf(w0) && l.x <= xOf(w1)).map((l, i) => (
                  <text key={i} x={l.x} y={15} textAnchor="middle" fontSize={10} fontWeight={l.major ? 800 : 500}
                        className={`font-mono ${l.major ? 'fill-zinc-200' : 'fill-zinc-400'}`}>{l.text}</text>
                ))}
                {cross && cross.col !== null && cross.x !== null && model.columnTimes[cross.col] && (() => {
                  const text = crosshairStamp(model.columnTimes[cross.col].start, interval < 1440);
                  const w = text.length * 6.2 + 14;
                  const x = Math.max(0, Math.min(plotW - w, cross.x - w / 2));
                  return (
                    <g data-testid="pnf-crosshair-time">
                      <rect x={x} y={2} width={w} height={TIME_AXIS_H - 4} rx={3} className="fill-zinc-700" />
                      <text x={x + w / 2} y={15.5} textAnchor="middle" fontSize={10} fontWeight={700} className="fill-zinc-100 font-mono">{text}</text>
                    </g>
                  );
                })()}
              </svg>
            </div>
          )}
          </>
        )}
      </div>
      {cross && cross.col !== null && (() => {
        const c = columns[cross.col];
        const t = model.columnTimes[cross.col];
        return (
          <div data-testid="pnf-crosshair-readout"
               className="pointer-events-none absolute top-1.5 left-2 z-10 flex items-center gap-2 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] font-mono text-zinc-300">
            {renko ? (
              <>
                <span className={`font-bold ${c.dir === 'X' ? 'text-teal-400' : 'text-red-400'}`}>{c.dir === 'X' ? 'Brick up' : 'Brick down'}</span>
                <span className="text-zinc-100">O {fmt(c.dir === 'X' ? c.low : c.high, axisDigits)} → C {fmt(c.dir === 'X' ? c.high : c.low, axisDigits)}</span>
              </>
            ) : (
              <>
                <span className={`font-bold ${c.dir === 'X' ? 'text-emerald-400' : 'text-red-400'}`}>{c.dir === 'X' ? 'X up' : 'O down'}</span>
                <span>{c.boxes} box{c.boxes === 1 ? '' : 'es'}</span>
                <span className="text-zinc-100">{fmt(c.low + box / 2, axisDigits)} – {fmt(c.high - box / 2, axisDigits)}</span>
              </>
            )}
            <span className="text-zinc-400">{dateYear(sessionOfT(t.start))}{timeIfAny(t.start)}{t.end === t.start && !timeIfAny(t.end) ? '' : <> → {sessionOfT(t.end) !== sessionOfT(t.start) ? dateYear(sessionOfT(t.end)) : ''}{timeIfAny(t.end)}</>}</span>
          </div>
        );
      })()}
      <div data-testid="pnf-zoom" data-zoom={zoom} className={`absolute ${timeAxis ? 'bottom-8' : 'bottom-1.5'} left-1/2 -translate-x-1/2 flex items-center gap-1 z-10`}>
        <ZoomButton label="Zoom out" onClick={() => zoomBy(0.7)}><Minus className="w-3 h-3" aria-hidden="true" /></ZoomButton>
        <ZoomButton label="Fit chart to panel" onClick={() => resetView()}><RotateCcw className="w-3 h-3" aria-hidden="true" /></ZoomButton>
        <ZoomButton label="Zoom in" onClick={() => zoomBy(1 / 0.7)}><Plus className="w-3 h-3" aria-hidden="true" /></ZoomButton>
        <ZoomButton label="Squeeze columns (horizontal zoom out, Shift + wheel)" onClick={() => xZoomBy(0.7)}><ChevronsRightLeft className="w-3 h-3" aria-hidden="true" /></ZoomButton>
        <ZoomButton label="Stretch columns (horizontal zoom in, Shift + wheel)" onClick={() => xZoomBy(1 / 0.7)}><ChevronsLeftRight className="w-3 h-3" aria-hidden="true" /></ZoomButton>
        {onToggleTri && (
          <ZoomButton label={triShown ? 'Hide triangles' : 'Show triangles'} onClick={onToggleTri} pressed={!triShown}>
            <span className="text-[10px] font-bold leading-none px-0.5" aria-hidden="true">{triShown ? '△' : '▽'}</span>
          </ZoomButton>
        )}
        {onCycleTriMin && triShown && (
          <ZoomButton label={`Triangles need at least ${triMin} columns (click for ${triMin >= 6 ? 3 : triMin + 1})`} onClick={onCycleTriMin}>
            <span className="text-[10px] font-bold leading-none px-0.5" aria-hidden="true">{`△${triMin}`}</span>
          </ZoomButton>
        )}
        {rail?.onToggleLines && (
          <ZoomButton label={rail.linesShown !== false ? 'Hide order and position lines' : 'Show order and position lines'} onClick={rail.onToggleLines} pressed={rail.linesShown === false}>
            {rail.linesShown !== false ? <EyeOff className="w-3 h-3" aria-hidden="true" /> : <Eye className="w-3 h-3" aria-hidden="true" />}
          </ZoomButton>
        )}
        {rail?.onToggleAlign && rail.linesShown !== false && (
          <ZoomButton label={rail.alignLeft ? 'Align order tags to the right' : 'Align order tags to the left'} onClick={rail.onToggleAlign} pressed={!!rail.alignLeft}>
            {rail.alignLeft ? <AlignRight className="w-3 h-3" aria-hidden="true" /> : <AlignLeft className="w-3 h-3" aria-hidden="true" />}
          </ZoomButton>
        )}
        {onToggleMarkers && (tradeMarkers?.length || !markersShown) ? (
          <ZoomButton label={markersShown ? 'Hide buy / sell markers' : 'Show buy / sell markers'} onClick={onToggleMarkers} pressed={!markersShown}>
            {markersShown ? <MapPinOff className="w-3 h-3" aria-hidden="true" /> : <MapPin className="w-3 h-3" aria-hidden="true" />}
          </ZoomButton>
        ) : null}
      </div>
      </div>
    </section>
  );
}
