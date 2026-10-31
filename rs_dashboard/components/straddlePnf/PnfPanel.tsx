'use client';

import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { unconfirmedBoxes, type Overlay, type PanelModel } from '@/lib/straddlePnfModel';
import type { PnfExecutionMarker } from '@/lib/straddlePnf';
import { MapPin, MapPinOff, Minus, Plus, RotateCcw } from 'lucide-react';
import { layoutPanel, AXIS_W, PAD_TOP } from '@/lib/straddlePnfLayout';
import { MIN_BOX_PTS_PCT } from '@/lib/straddlePnfSettings';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// One straddle P&F chart: X (green) / O (red) glyphs on a visible box grid, VWAP or SMA line, a bar at the level every double
// top / double bottom broke, date dividers where a new session starts and a tag at the live price. Every column is drawn: the
// chart scrolls (it opens on the newest column) and the price axis stays pinned to the right edge while you pan.

const MIN_HEIGHT = 420;

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
};

/** A resting order drawn on the chart (its line, its tag, and its handle in the rail). */
export type RailOrder = {
  id: string; side: 'BUY' | 'SELL'; kind: 'limit' | 'stop'; level: number; price: number; trigger?: number; lots: number;
  /** working: draggable / cancellable. Anything else (sending, firing, unknown) is drawn but locked. */
  state: string; mode: 'PAPER' | 'REAL';
  /** Its outcome is unknown (or its send never finished): a ? on the tag lets the user settle it (onCancel asks first). */
  resolvable?: boolean;
};
export type PnfRail = {
  orders: RailOrder[];
  /** A click on a box row: the box price. */
  onPlace: (side: 'BUY' | 'SELL', level: number) => void;
  onModify: (id: string, level: number) => void;
  onCancel: (id: string) => void;
};

/** Width of the buy / sell rail (two columns, buy left and sell right) between the chart and its price axis. */
export const RAIL_W = 76;

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

const fmt = (n: number, digits = 2) => n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (n: number) => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(2)}`;
const hhmm = (t: number) => new Date((t + 5.5 * 3600) * 1000).toISOString().slice(11, 16);
const sessionOfT = (t: number) => new Date((t + 5.5 * 3600) * 1000).toISOString().slice(0, 10);
const shortDate = (iso: string) => sessionLabel(iso).slice(4);

type RailDrag = { id: string; level: number; start: number } | null;

/**
 * The buy / sell rail: a Buy and a Sell cell on every box row over the whole chart height (the padding above and below the data
 * too, on the chart's own box grid, so an order can rest beyond where the price has been), plus a handle per resting order.
 * Cells act on pointer-down (the chart's drag-to-pan captures the pointer, which would swallow a click). A handle is dragged
 * to another box (commit on release); the drag lives in a ref because pointer events arrive before React re-renders.
 */
function RailSvg({ rail, box, cell, yMax, yMin, padY, contentH, yOf, liveValue, axisDigits, onDrag }: {
  rail: PnfRail; box: number; cell: number; yMax: number; yMin: number; padY: number; contentH: number;
  yOf: (p: number) => number; liveValue: number | null; axisDigits: number; onDrag: (d: RailDrag) => void;
}) {
  const dragRef = useRef<RailDrag>(null);
  const [drag, setDragState] = useState<RailDrag>(null);
  const setDrag = (d: RailDrag) => { dragRef.current = d; setDragState(d); onDrag(d); };
  const priceAtY = (y: number) => yMax - ((y - padY - PAD_TOP) / cell) * box;
  const iLo = Math.floor((priceAtY(contentH) - yMin) / box);
  const iHi = Math.ceil((priceAtY(0) - yMin) / box) - 1;
  const levelAt = (y: number) => yMin + (Math.max(iLo, Math.min(iHi, Math.floor((priceAtY(y) - yMin) / box))) + 0.5) * box;
  const kindAt = (side: 'BUY' | 'SELL', p: number) => (liveValue === null ? '' : (side === 'BUY') === (p < liveValue) ? 'LIMIT' : 'SL-limit');
  const [hot, setHot] = useState<{ side: 'BUY' | 'SELL'; p: number } | null>(null);
  const COL = RAIL_W / 2;
  const colX = (side: 'BUY' | 'SELL') => (side === 'BUY' ? 0 : COL);
  return (
    <svg data-testid="pnf-rail" width={RAIL_W} height={contentH} className="block shrink-0 sticky bg-zinc-900 border-l border-zinc-700" style={{ right: AXIS_W }}
         onPointerLeave={() => setHot(null)}>
      {/* two tinted columns over the whole height (buy | sell), so the rail reads as a rail wherever the chart is scrolled to */}
      <rect x={0} y={0} width={COL} height={contentH} className="fill-emerald-500/10" pointerEvents="none" />
      <rect x={COL} y={0} width={COL} height={contentH} className="fill-red-500/10" pointerEvents="none" />
      <line x1={COL} x2={COL} y1={0} y2={contentH} className="stroke-zinc-700" pointerEvents="none" />
      {Array.from({ length: Math.max(0, iHi - iLo + 1) }, (_, n) => {
        const p = yMin + (iLo + n + 0.5) * box;
        if (!(p > 0)) return null;
        const y = yOf(p);
        return (
          <g key={n}>
            <line x1={0} x2={RAIL_W} y1={y + cell / 2} y2={y + cell / 2} className="stroke-zinc-800" pointerEvents="none" />
            {(['BUY', 'SELL'] as const).map(side => (
              <rect key={side} data-testid="pnf-rail-cell" data-side={side} data-level={p}
                    x={colX(side)} y={y - cell / 2} width={COL} height={Math.max(1, cell)}
                    className="cursor-pointer fill-transparent"
                    onPointerEnter={() => setHot({ side, p })}
                    onPointerDown={e => { e.stopPropagation(); if (e.button === 0) rail.onPlace(side, p); }}>
                <title>{`${side} ${kindAt(side, p)} at ${fmt(p, axisDigits)}`}</title>
              </rect>
            ))}
          </g>
        );
      })}
      {/* the row under the pointer: what a click there places, and at which price */}
      {hot && !drag && (() => {
        const y = yOf(hot.p);
        const buy = hot.side === 'BUY';
        const kind = kindAt(hot.side, hot.p);
        const h = Math.max(cell, 16);
        return (
          <g pointerEvents="none" data-testid="pnf-rail-hover">
            <rect x={colX(hot.side) + 1} y={y - h / 2} width={COL - 2} height={h} rx={3} className={buy ? 'fill-emerald-500/60 stroke-emerald-300' : 'fill-red-500/60 stroke-red-300'} strokeWidth={1} />
            <text x={colX(hot.side) + COL / 2} y={y + 3.5} textAnchor="middle" className="fill-oncolor" fontSize={10} fontWeight={800}>{kind === 'LIMIT' ? 'LMT' : kind === 'SL-limit' ? 'SL' : '+'}</text>
          </g>
        );
      })()}
      {rail.orders.map(o => {
        const y = yOf(drag?.id === o.id ? drag.level : o.level);
        const buy = o.side === 'BUY';
        const movable = o.state === 'working';
        return (
          <g key={o.id} data-testid="pnf-rail-order" data-id={o.id} className={movable ? 'cursor-ns-resize' : 'cursor-not-allowed'}
             onPointerDown={e => {
               e.stopPropagation();
               if (!movable || e.button !== 0) return;
               (e.currentTarget as Element).setPointerCapture(e.pointerId);
               setDrag({ id: o.id, level: o.level, start: o.level });
             }}
             onPointerMove={e => {
               const d = dragRef.current;
               const svg = (e.currentTarget as SVGGElement).ownerSVGElement;
               if (d?.id !== o.id || !svg) return;
               const next = levelAt(e.clientY - svg.getBoundingClientRect().top);
               if (Math.abs(next - d.level) > box / 4) setDrag({ ...d, level: next });
             }}
             onPointerUp={() => {
               const d = dragRef.current;
               if (d?.id !== o.id) return;
               setDrag(null);
               if (Math.abs(d.level - d.start) > box / 4) rail.onModify(o.id, d.level);
             }}
             onPointerCancel={() => setDrag(null)}>
            <rect x={colX(o.side) + 1.5} y={y - 9} width={COL - 3} height={18} rx={4}
                  className={`${buy ? 'fill-emerald-500 stroke-emerald-200' : 'fill-red-500 stroke-red-200'}`} strokeWidth={1} opacity={movable ? 1 : 0.5} />
            {movable && [-3, 0, 3].map(dy => <line key={dy} x1={colX(o.side) + 6} x2={colX(o.side) + 10} y1={y + dy} y2={y + dy} className="stroke-oncolor" strokeWidth={1} opacity={0.7} />)}
            <text x={colX(o.side) + COL / 2 + (movable ? 4 : 0)} y={y + 3.5} textAnchor="middle" className="fill-oncolor" fontSize={10} fontWeight={800} pointerEvents="none">{`${o.lots}L`}</text>
            <title>{`${o.side} ${o.kind === 'limit' ? 'LIMIT' : 'SL-limit'} ${o.lots}L at ${fmt(o.level, 2)}${movable ? ' — drag to move' : ` (${o.state})`}`}</title>
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

export default function PnfPanel({ title, strike, model, live, stale, flash, error, loading, fill, legs = true, resetTick = 0, headerSlot = null, scrip, feedPrevClose = null, sessionTag = null, interval = 1, boxPct = 0.5, reversal = 3, tradeMarkers, showHeader = false, active = false, onActivate, autoSlot = null, markersShown = true, onToggleMarkers, rail }: PnfPanelProps) {
  const [wrapRef, width, HEIGHT] = useSize();
  const { columns, box, signals, exits } = model;
  const liveValue = live ? live.ce + live.pe : null;
  // An index has no volume: its "VWAP" is a plain cumulative average, and says so.
  // The line actually drawn: an instrument without traded volume (an index) always gets the box SMA, whatever was asked.
  const kind = model.overlayKind;
  const overlayLabel = kind === 'vwap' ? 'VWAP' : `SMA ${model.smaPeriod}`;
  const overlayNow = model.overlayNow;
  // The SMA averages P&F boxes: say so when there are not enough of them yet, rather than show no line and no reason.
  const totalBoxes = columns.reduce((n, c) => n + c.boxes, 0);
  const smaWaiting = kind === 'sma' && overlayNow === null && columns.length > 0;
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
  // Laid out with the unconfirmed boxes too (the live columns are the confirmed ones plus what the forming bar adds), so a
  // new unconfirmed column gets its own cell instead of sliding under the pinned axis.
  const liveCols = model.liveColumns.length >= columns.length ? model.liveColumns : columns;
  // The rail takes its width from the chart, so the newest column still sits next to the axis.
  const viewW = rail ? Math.max(120, width - RAIL_W) : width;
  const L = layoutPanel(liveCols, box, liveValue, viewW, HEIGHT, zoom, true);
  const { cell, yMin, yMax, plotW, contentW, contentH, offsetX, padY, padR } = L;
  const yOf = (p: number) => padY + PAD_TOP + ((yMax - p) / box) * cell;
  const xOf = (j: number) => offsetX + j * cell;
  const vis = columns;
  const first = 0;
  const s = cell * 0.36;                       // glyph half-size
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
  const stickRef = useRef(true);
  // The scroll position where the newest column sits against the axis (the empty room right of it is only for dragging).
  const stickLeft = (el: HTMLElement) => Math.max(0, el.scrollWidth - el.clientWidth - padR);
  // Until the user zooms or drags, the vertical position follows the layout (it changes when the panel is measured and as the range grows).
  const touchedRef = useRef(false);
  const centeredFor = useRef<number | null>(null);
  const lastY = liveValue ?? (liveCols.length ? (liveCols[liveCols.length - 1].low + liveCols[liveCols.length - 1].high) / 2 : null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || liveCols.length === 0) return;
    if (stickRef.current) el.scrollLeft = stickLeft(el);
    setViewRight(Math.round(el.scrollLeft + el.clientWidth - AXIS_W - (rail ? RAIL_W : 0)));
    if (centeredFor.current !== strike) { touchedRef.current = false; centeredFor.current = strike; }
    if (!touchedRef.current && lastY !== null && box > 0) {
      el.scrollTop = topFor(el);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveCols.length, contentW, contentH, strike]);

  // TradingView-style controls (same as the options charts): wheel zooms around the cursor, drag pans freely, double-click or the
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
    const L2 = layoutPanel(liveCols, box, liveValue, viewW, HEIGHT, next, true);
    const j = (el.scrollLeft + x - offsetX) / cell;
    const u = (el.scrollTop + y - padY - PAD_TOP) / cell;
    pendingRef.current = { left: L2.offsetX + j * L2.cell - x, top: L2.padY + PAD_TOP + u * L2.cell - y };
    stickRef.current = false;
    touchedRef.current = true;
    setZoom(next);
  };
  const resetView = () => { touchedRef.current = false; pendingRef.current = 'reset'; stickRef.current = false; setZoom(1); setScrollTick(n => n + 1); };
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
  }, [zoom, scrollTick]);
  const seenReset = useRef(resetTick);
  useEffect(() => {
    if (seenReset.current === resetTick) return;   // mount (and StrictMode's second mount) is not a reset request
    seenReset.current = resetTick;
    resetView();
  }, [resetTick]);
  const zoomRef = useRef(zoomBy);
  useLayoutEffect(() => { zoomRef.current = zoomBy; });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomRef.current(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
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
  const [railDrag, setRailDrag] = useState<{ id: string; level: number; start: number } | null>(null);

  const trackHover = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const vx = e.clientX - r.left;
    setHover({ x: vx + el.scrollLeft, y: e.clientY - r.top + el.scrollTop, overAxis: vx > el.clientWidth - AXIS_W - (rail ? RAIL_W : 0) });
  };
  const rowTop = padY + PAD_TOP;
  const cross = (() => {
    if (!hover || dragging || box <= 0 || !liveCols.length) return null;
    const row = Math.floor((hover.y - rowTop) / cell);
    if (row < 0 || row >= L.rows) return null;
    const price = yMax - (row + 0.5) * box;                      // yMax is a cell edge: this is the row's box price
    const j = Math.floor((hover.x - offsetX) / cell);
    const col = !hover.overAxis && j >= 0 && j < columns.length ? j : null;
    return { price, y: yOf(price), col, x: col !== null ? xOf(col) + cell / 2 : hover.overAxis ? null : hover.x };
  })();
  const markAt = new Map(model.sessionMarks.map(m => [`${m.col}:${m.k}`, m.session]));
  // Glyph geometry as path strings, rebuilt only when the chart or its layout changes (not on a crosshair move).
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const xGlyph = (cx: number, cy: number) => `M${r1(cx - s)} ${r1(cy - s)}L${r1(cx + s)} ${r1(cy + s)}M${r1(cx + s)} ${r1(cy - s)}L${r1(cx - s)} ${r1(cy + s)}`;
  const oGlyph = (cx: number, cy: number) => `M${r1(cx - s)} ${r1(cy)}a${r1(s)} ${r1(s)} 0 1 0 ${r1(2 * s)} 0a${r1(s)} ${r1(s)} 0 1 0 ${r1(-2 * s)} 0`;
  const glyphs = useMemo(() => {
    let x = '', o = '';
    const marks: { col: number; k: number; cx: number; cy: number; dir: 'X' | 'O'; session: string }[] = [];
    columns.forEach((c, j) => {
      const cx = xOf(j) + cell / 2;
      for (let k = 0; k < c.boxes; k++) {
        const cy = yOf(c.low + (k + 0.5) * box);
        const session = markAt.get(`${j}:${k}`);
        if (session) marks.push({ col: j, k, cx, cy, dir: c.dir, session });
        else if (c.dir === 'X') x += xGlyph(cx, cy);
        else o += oGlyph(cx, cy);
      }
    });
    return { x, o, marks };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, model.sessionMarks, box, cell, offsetX, yMax, padY, s]);
  const unconfirmed = unconfirmedBoxes(columns, liveCols, box);
  const unconfirmedPaths = useMemo(() => {
    let x = '', o = '', n = 0;
    for (const { col, ks } of unconfirmed) {
      const lc = liveCols[col];
      for (const k of ks) {
        n++;
        if (lc.dir === 'X') x += xGlyph(xOf(col) + cell / 2, yOf(lc.low + (k + 0.5) * box));
        else o += oGlyph(xOf(col) + cell / 2, yOf(lc.low + (k + 0.5) * box));
      }
    }
    return { x, o, n };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveCols, columns, box, cell, offsetX, yMax, padY, s]);

  const lastEntryId = [...signals].reverse().find(g => g.kind === 'DOUBLE_BOTTOM_SELL' && g.belowVwap)?.id;
  const ring = flash === 'buy' ? 'ring-2 ring-emerald-400' : flash === 'sell' ? 'ring-2 ring-red-400' : '';

  const overlayPts = vis
    .map((c, j) => ({ v: model.overlay[first + j], x: xOf(j) + cell / 2 }))
    .filter(p => p.v !== null)
    .map(p => `${p.x},${yOf(p.v as number)}`)
    .join(' ');

  const tickEvery = Math.max(1, Math.round(((yMax - yMin) / box) / 9));
  // Axis labels name the box centres (the price each row of X / O stands for). Whole rupees once a box is 10 or more: the
  // paise are noise at that size and a six-figure price still fits the axis.
  const axisDigits = box >= 10 ? 0 : 2;
  const liveDigits = liveValue !== null && liveValue >= 100_000 ? 0 : 2;

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
            <span data-testid="pnf-overlay-legend" className="shrink-0">
              <span className={`font-bold ${kind === 'vwap' ? 'text-amber-400' : 'text-sky-400'}`}>{overlayLabel}</span>
              {overlayNow !== null && <span className="font-semibold text-zinc-100">{` ${fmt(overlayNow)}`}</span>}
              {smaWaiting && <span className="text-zinc-500">{` needs ${model.smaPeriod} boxes (${totalBoxes} so far)`}</span>}
            </span>
            <span data-testid="pnf-box-info" className="flex items-center gap-3 min-w-0 text-zinc-400 truncate" title={box > 0 ? boxTitle : undefined}>
              {box > 0 ? (
                <>
                  <span className="shrink-0">Box <span className="font-semibold text-zinc-100">{box.toFixed(2)}</span>{' '}
                    <span className={model.boxClamped ? 'text-amber-400' : 'text-zinc-500'}>({boxNote})</span></span>
                  <span className="shrink-0"><span className="font-semibold text-zinc-100">{reversal}-box</span> rev</span>
                  <span className="shrink-0"><span className="font-semibold text-zinc-100">{columns.length}</span> cols</span>
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
                    lastSignal.kind === 'DOUBLE_BOTTOM_SELL'
                      ? 'text-red-400 border-red-500/30 bg-red-500/10'
                      : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'}`}>
              {lastSignal.kind === 'DOUBLE_BOTTOM_SELL' ? '▼ DB sell' : '▲ DT buy'} {hhmm(lastSignal.t)}
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
        <span data-testid="pnf-overlay-legend" className={`min-w-0 truncate ${kind === 'vwap' ? 'text-amber-300' : 'text-sky-300'}`}>
          {overlayLabel}{overlayNow !== null ? ` ${fmt(overlayNow)}` : smaWaiting ? ` needs ${model.smaPeriod}` : ''}
        </span>
        <span data-testid="pnf-box-info" className="text-zinc-500 truncate min-w-0 flex-1" title={box > 0 ? boxTitle : undefined}>
          {box > 0 ? `Box ${box.toFixed(2)} (${boxNote}) · ${reversal}-box · ${columns.length} cols` : 'Box —'}
        </span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {lastSignal && (
            <span data-testid="pnf-last-signal"
                  className={`font-bold px-1.5 py-0.5 rounded border ${
                    lastSignal.kind === 'DOUBLE_BOTTOM_SELL'
                      ? 'text-red-400 border-red-500/30 bg-red-500/10'
                      : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'}`}>
              {lastSignal.kind === 'DOUBLE_BOTTOM_SELL' ? '▼ DB' : '▲ DT'} {hhmm(lastSignal.t)}
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
            {overlayLabel}{overlayNow !== null ? ` ${fmt(overlayNow)}` : smaWaiting ? ` needs ${model.smaPeriod} boxes (${totalBoxes} so far)` : ''}
          </span>
        </p>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p data-testid="pnf-box-info" className="text-[10px] font-mono text-zinc-500 truncate">
            {box > 0 ? `Box ${box.toFixed(2)} (${boxNote}) · ${reversal}-box · ${columns.length} cols${sessionsInfo}` : 'Box —'}
          </p>
          {lastSignal && (
            <span data-testid="pnf-last-signal"
                  className={`shrink-0 text-[10px] font-bold font-mono px-1.5 py-0.5 rounded border ${
                    lastSignal.kind === 'DOUBLE_BOTTOM_SELL'
                      ? 'text-red-400 border-red-500/30 bg-red-500/10'
                      : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'}`}>
              {lastSignal.kind === 'DOUBLE_BOTTOM_SELL' ? '▼ DB sell' : '▲ DT buy'} {hhmm(lastSignal.t)}
            </span>
          )}
        </div>
      </div>
      )}

      <div className={`relative ${fill ? 'flex-1 min-h-0 flex flex-col' : ''}`}>
      <div
        ref={wrapRef}
        data-testid="pnf-scroll"
        role="region"
        aria-label={`${title} chart, scrollable`}
        tabIndex={0}
        onPointerDown={e => {
          if (e.button !== 0) return;
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
          if (dragRef.current) { const el = e.currentTarget; stickRef.current = el.scrollLeft >= stickLeft(el) - 30; }
          dragRef.current = null; setDragging(false); trackHover(e);
        }}
        onPointerCancel={() => { dragRef.current = null; setDragging(false); }}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={resetView}
        onScroll={e => { const el = e.currentTarget; const v = Math.round(el.scrollLeft + el.clientWidth - AXIS_W - (rail ? RAIL_W : 0)); setViewRight(prev => (prev === v ? prev : v)); }}
        className={`relative overflow-auto select-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${dragging ? 'cursor-grabbing' : 'cursor-crosshair'} ${fill ? 'flex-1 min-h-0' : ''}`}
        style={fill ? { minHeight: 200 } : { height: 'calc(100vh - 215px)', minHeight: MIN_HEIGHT }}
      >
        {error ? (
          <p className="p-3 text-xs text-red-400">{error}</p>
        ) : loading ? (
          <p className="p-3 text-xs text-zinc-400">Loading…</p>
        ) : liveCols.length === 0 ? (
          <p className="p-3 text-xs text-zinc-400">{`Building chart — the first column needs a ${model.boxMode === 'pts' ? 'one-box' : `${boxPct}%`} move${interval > 1 ? ` on closed ${interval}-minute bars` : ''}.`}</p>
        ) : (
          <div className="flex" style={{ width: contentW + (rail ? RAIL_W : 0), height: contentH }}>
            <svg width={plotW} height={contentH} className="block shrink-0" role="img" aria-label={`${title} point and figure chart`}>
              <defs>
                <pattern id={gridId} x={offsetX} y={gridY} width={cell} height={cell} patternUnits="userSpaceOnUse">
                  <path d={`M${cell} 0V${cell}M0 ${cell}H${cell}`} fill="none" strokeWidth={1} className="stroke-zinc-800" />
                </pattern>
              </defs>
              <rect data-testid="pnf-grid" x={0} y={0} width={plotW} height={contentH} fill={`url(#${gridId})`} />

              {/* session dividers; a date is written only where it has room, so narrow sessions never print over each other */}
              {(() => {
                let lastLabelX = -Infinity;
                return vis.map((c, j) => {
                  const prev = columns[first + j - 1];
                  if (prev && prev.session === c.session) return null;   // the first column opens the first session, which is labelled too
                  const x = xOf(j);
                  const label = x - lastLabelX >= 64;
                  if (label) lastLabelX = x;
                  return (
                    <g key={`d${j}`}>
                      <line x1={x} x2={x} y1={padY + PAD_TOP - 6} y2={contentH} className="stroke-zinc-600" strokeDasharray="2 3" />
                      {label && <text x={x + 3} y={padY + PAD_TOP - 9} className="fill-zinc-400 font-mono" fontSize={10}>{sessionLabel(c.session)}</text>}
                    </g>
                  );
                });
              })()}

              {/* X / O glyphs: every X in one path and every O in another (a chart can hold tens of thousands of boxes; one element
                  each made every crosshair move and live tick re-render them all). The first box each session drew shows the day of
                  the month instead (the classic P&F month marker, by day). */}
              <path data-testid="pnf-glyphs-x" d={glyphs.x} className="stroke-emerald-400" strokeWidth={stroke} strokeLinecap="round" fill="none" />
              <path data-testid="pnf-glyphs-o" d={glyphs.o} className="stroke-red-400" strokeWidth={stroke} fill="none" />
              {glyphs.marks.map(m => (
                <text key={`${m.col}-${m.k}`} data-testid="pnf-session-mark" x={m.cx} y={m.cy} textAnchor="middle" dominantBaseline="central"
                      className={`${m.dir === 'X' ? 'fill-emerald-400' : 'fill-red-400'} font-mono font-bold`}
                      fontSize={Math.max(7, Math.min(16, cell * 0.55))}>
                  <title>{`${sessionLabel(m.session)}: first box of the session`}</title>
                  {Number(m.session.slice(8, 10))}
                </text>
              ))}
              {/* the newest confirmed column's cells: a hook for tests and nothing else */}
              {columns.length > 0 && (
                <rect data-testid="pnf-newest" x={xOf(columns.length - 1)} y={yOf(columns[columns.length - 1].high)} width={cell}
                      height={(columns[columns.length - 1].boxes) * cell} fill="none" pointerEvents="none" />
              )}

              {/* Unconfirmed boxes: what the bar still forming would add if it closed now, dimmed. They move with the price and can
                  disappear; signals, the SMA and the date marks never use them. */}
              {unconfirmedPaths.n > 0 && (
                <g data-testid="pnf-unconfirmed" data-count={unconfirmedPaths.n} opacity={0.35}>
                  <path d={unconfirmedPaths.x} className="stroke-emerald-400" strokeWidth={stroke} strokeLinecap="round" fill="none" />
                  <path d={unconfirmedPaths.o} className="stroke-red-400" strokeWidth={stroke} fill="none" />
                </g>
              )}

              {/* VWAP / SMA: one continuous line across the loaded sessions */}
              {overlayPts && (
                <polyline points={overlayPts} fill="none" strokeWidth={1.8}
                          className={kind === 'vwap' ? 'stroke-amber-300' : 'stroke-sky-400'} />
              )}

              {/* short cover cue (the short-side rule): first bar of a green X column trading above VWAP */}
              {exits.length > 0 && (
                <text data-testid="pnf-exit" x={xOf(exits[exits.length - 1].col) + cell / 2} y={yOf(columns[exits[exits.length - 1].col].high) - 4}
                      textAnchor="middle" className="fill-emerald-400 font-mono font-bold" fontSize={9}>COVER</text>
              )}

              {/* double top buy / double bottom sell: a horizontal support/resistance line across from the previous swing extreme
                  to the breaking column */}
              {signals.map(g => {
                const sell = g.kind === 'DOUBLE_BOTTOM_SELL';
                const entry = sell && g.belowVwap;
                const levelPrice = sell ? columns[g.col - 2].low : columns[g.col - 2].high;
                const y = yOf(levelPrice);
                const x1 = xOf(g.col - 2);
                const x2 = xOf(g.col) + cell + 6;
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
                      const found = model.columnTimes.findIndex(ct => m.t >= ct.start && m.t <= ct.end);
                      if (found !== -1) colIdx = found;
                      else if (m.t > model.columnTimes[model.columnTimes.length - 1].end) colIdx = liveCols.length - 1;
                      else colIdx = 0;
                    } else {
                      colIdx = Math.max(0, liveCols.length - 1);
                    }
                  }

                  const boxK = box > 0 ? Math.round((m.price - model.anchor) / box) : 0;
                  const boxPrice = model.anchor + boxK * box;
                  const key = `${colIdx}:${boxK}`;
                  if (!groups.has(key)) groups.set(key, []);
                  groups.get(key)!.push({ marker: m, colIdx, boxPrice, idx });
                });

                return Array.from(groups.values()).flatMap(group => {
                  const total = group.length;
                  const r = Math.max(5.5, Math.min(10, cell * 0.4));
                  const fontSize = Math.max(7, Math.min(11, r * 1.1));

                  return group.map(({ marker: m, colIdx, boxPrice, idx }, groupIdx) => {
                    const baseCx = xOf(colIdx) + cell / 2;
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

              {/* resting orders: a line across the chart at the level, and a tag by the newest columns (× cancels) */}
              {rail && rail.orders.map(o => {
                const level = railDrag?.id === o.id ? railDrag.level : o.level;
                const y = yOf(level);
                const buy = o.side === 'BUY';
                const text = `${o.mode === 'PAPER' ? 'P ' : ''}${o.side} ${o.kind === 'limit' ? 'LMT' : 'SL'} ${o.lots}L ${o.kind === 'stop' && o.trigger !== undefined ? `${fmt(o.trigger, 2)}→` : ''}${fmt(railDrag?.id === o.id ? level : o.price, 2)}${o.state === 'working' ? '' : ` ${o.state.toUpperCase()}`}`;
                const w = text.length * 6 + 22;
                const x = Math.max(4, Math.min(plotW, viewRight ?? plotW) - w - 6);
                const live = o.state === 'working';
                return (
                  <g key={o.id} data-testid="pnf-order-line" data-side={o.side} data-kind={o.kind} data-state={o.state}>
                    <line x1={0} x2={plotW} y1={y} y2={y} strokeWidth={1} strokeDasharray={o.mode === 'PAPER' ? '2 3' : '6 3'}
                          className={buy ? 'stroke-emerald-400' : 'stroke-red-400'} />
                    <rect x={x} y={y - 8} width={w} height={16} rx={3} className={buy ? 'fill-emerald-600' : 'fill-red-600'} opacity={live ? 1 : 0.55} />
                    <text x={x + 5} y={y + 3.5} className="fill-oncolor font-mono" fontSize={10} fontWeight={700}>{text}</text>
                    {(live || o.resolvable) && (
                      <g data-testid={live ? 'pnf-order-cancel' : 'pnf-order-resolve'} role="button"
                         aria-label={`${live ? 'Cancel' : 'Settle (outcome unknown)'} ${o.side} ${o.kind === 'limit' ? 'limit' : 'SL-limit'} at ${fmt(o.level, 2)}`}
                         className="cursor-pointer" onPointerDown={e => { e.stopPropagation(); rail.onCancel(o.id); }}>
                        <rect x={x + w - 15} y={y - 6} width={12} height={12} rx={2} className="fill-oncolor-dark/30" />
                        <text x={x + w - (live ? 12 : 13)} y={y + 3.5} className="fill-oncolor" fontSize={10} fontWeight={700}>{live ? '×' : '?'}</text>
                      </g>
                    )}
                  </g>
                );
              })}

              {/* live price line */}
              {liveValue !== null && (
                <line x1={0} x2={plotW} y1={yOf(liveValue)} y2={yOf(liveValue)} className="stroke-zinc-400" strokeDasharray="3 3" />
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
              <RailSvg rail={rail} box={box} cell={cell} yMax={yMax} yMin={yMin} padY={padY} contentH={contentH} yOf={yOf}
                       liveValue={liveValue} axisDigits={axisDigits} onDrag={setRailDrag} />
            )}

            {/* price axis: sticky, so it stays at the panel's right edge while the chart is panned */}
            <svg width={AXIS_W} height={contentH} className="block shrink-0 sticky right-0 bg-zinc-900" aria-hidden="true">
              <g data-testid="pnf-axis">
                {Array.from({ length: Math.round((yMax - yMin) / box) }, (_, i) => i)
                  .filter(i => i % tickEvery === 0)
                  .filter(i => liveValue === null || Math.abs(yOf(yMin + (i + 0.5) * box) - yOf(liveValue)) > 14)
                  .map(i => {
                    const p = yMin + (i + 0.5) * box;   // yMin is a cell edge, so this is a box centre
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
        )}
      </div>
      {cross && cross.col !== null && (() => {
        const c = columns[cross.col];
        const t = model.columnTimes[cross.col];
        return (
          <div data-testid="pnf-crosshair-readout"
               className="pointer-events-none absolute top-1.5 left-2 z-10 flex items-center gap-2 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] font-mono text-zinc-300">
            <span className={`font-bold ${c.dir === 'X' ? 'text-emerald-400' : 'text-red-400'}`}>{c.dir === 'X' ? 'X up' : 'O down'}</span>
            <span>{c.boxes} box{c.boxes === 1 ? '' : 'es'}</span>
            <span className="text-zinc-100">{fmt(c.low + box / 2, axisDigits)} – {fmt(c.high - box / 2, axisDigits)}</span>
            <span className="text-zinc-400">{sessionLabel(sessionOfT(t.start))} {hhmm(t.start)} → {sessionOfT(t.end) !== sessionOfT(t.start) ? `${sessionLabel(sessionOfT(t.end))} ` : ''}{hhmm(t.end)}</span>
          </div>
        );
      })()}
      <div data-testid="pnf-zoom" data-zoom={zoom} className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex items-center gap-1 z-10">
        <ZoomButton label="Zoom out" onClick={() => zoomBy(0.7)}><Minus className="w-3 h-3" aria-hidden="true" /></ZoomButton>
        <ZoomButton label="Fit chart to panel" onClick={() => resetView()}><RotateCcw className="w-3 h-3" aria-hidden="true" /></ZoomButton>
        <ZoomButton label="Zoom in" onClick={() => zoomBy(1 / 0.7)}><Plus className="w-3 h-3" aria-hidden="true" /></ZoomButton>
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
