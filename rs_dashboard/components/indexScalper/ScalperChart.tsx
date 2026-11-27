'use client';

// The /index-scalper chart: lightweight-charts candles + any number of indicators (overlay or own pane), drawing tools,
// and open option positions drawn at the index level they belong to, each with qty / avg / live P&L and an Exit button.
// Market data only; every order goes through the parent's callbacks.

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  createChart, createSeriesMarkers, CandlestickSeries, LineSeries, HistogramSeries, ColorType, CrosshairMode, LineStyle, PriceScaleMode,
  type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp, type SeriesType, type MouseEventParams, type Time,
  type ISeriesMarkersPluginApi,
  type AutoscaleInfo,
} from 'lightweight-charts';
import { ChevronDown, ChevronRight, Eye, EyeOff, Settings2, X, Plus, ArrowDown, ArrowUp, ArrowUpDown, Bell, FileText, Minus } from 'lucide-react';
import { useChartChrome } from '@/lib/chartTheme';
import { computeIndicator, indicatorLabel, tailUnchanged, volumeMa, type Bar, type IndicatorInstance, pointColor, flipsAtLast, type OutSeries } from '@/lib/indexScalperIndicators';
import { bracketKind, fmtRupees, legAnchor, legPnl, orderLevel, type ScalperLeg } from '@/lib/indexScalperPositions';
import type { OrderRowView } from '@/lib/indexScalperAccount';
import { INSTRUMENTS, displayLotUnits, isMcx, qtyUnits, type Underlying } from '@/lib/indexScalperInstrument';
import { readPref, savePref } from '@/lib/localPref';
import { cn } from '@/lib/utils';
import { fmtOI, fmtOIChange, oiBars, oiBarsBelowChips, placeOiLabels, type OiMode, type OiProfile } from '@/lib/indexScalperOiProfile';
import { legPremiumPnl, premiumBracketsFor } from '@/lib/indexScalperPremiumBrackets';
import PremiumBracketControls from './PremiumBracketControls';
import TrailControl from './TrailControl';
import type { TrailState } from '@/lib/indexScalperTrail';
import OrderEditPopover, { type OrderEditDraft } from './OrderEditPopover';
import { isEditable } from '@/lib/indexScalperOrderEdit';

const LEGEND_OPEN_KEY = 'indexScalper.legendOpen.v1';

export type DrawTool = 'cursor' | 'hline' | 'trend' | 'ruler';

const IST_SHIFT = 19800;
/** Volume bar colours: the candle colours, translucent (data colours, not chrome). */
const VOL_UP = '#22c55e66';
const VOL_DOWN = '#ef444466';
/** Volume MA line (TradingView's default blue). */
const VOL_MA = '#3b82f6';
const UP = '#10b981';
const DOWN = '#ef4444';
/** How long a dragged / typed TP / SL level shows before the order book confirms it (then it is dropped). */
const TENTATIVE_TTL_MS = 15_000;
/** Drawings of the underlying chart; an option chart stores its own under `${DRAW_KEY}:<securityId>` (drawKey prop). */
export const DRAW_KEY = 'indexScalper.drawings.v1';

/** The chart's geometry for overlays drawn outside it (Quick Trade strike chips): read on their own timer, so live
 *  prices on those overlays never re-render the chart. Coordinates are relative to the chart's box. */
export interface ChartViewport {
  priceToY: (price: number) => number | null;
  /** Width of the plot (left of the price axis) and height of the main pane (above any oscillator pane). */
  plotWidth: () => number;
  plotHeight: () => number;
}

interface TrendRec { t1: number; p1: number; t2: number; p2: number }
interface Drawings { h: number[]; t: TrendRec[] }

function loadDrawings(key: string): Drawings {
  try {
    const raw = readPref(key);
    if (!raw) return { h: [], t: [] };
    const j = JSON.parse(raw) as Partial<Drawings>;
    return {
      h: Array.isArray(j.h) ? j.h.filter(n => Number.isFinite(n)) : [],
      t: Array.isArray(j.t) ? j.t.filter(x => x && [x.t1, x.p1, x.t2, x.p2].every(Number.isFinite)) : [],
    };
  } catch { return { h: [], t: [] }; }
}

interface Props {
  bars: Bar[];
  indicators: IndicatorInstance[];
  tool: DrawTool;
  onToolDone: () => void;
  clearToken: number;
  logScale: boolean;
  /** Background grid lines (a viewer setting, on by default). */
  showGrid?: boolean;
  /** Volume histogram along the bottom of the price pane (a viewer setting, on by default). Drawn only when the bars
   *  carry volume (a future, an option): the NIFTY index has none. */
  showVolume?: boolean;
  /** Volume MA length drawn over the volume bars (0 = none). */
  volumeMaLen?: number;
  pctScale: boolean;
  autoScale: boolean;
  legs: ScalperLeg[];
  /** Index level each leg was opened at from this page (security id -> spot). */
  entrySpots: Record<string, number>;
  onExitLeg: (leg: ScalperLeg) => void;
  /** Quick Trade: "+" adds one lot in the leg's direction, "-" takes one lot off (absent = no +/- on the chip). */
  onAdjustLeg?: (leg: ScalperLeg, delta: 1 | -1) => void;
  /** Lots the chip's + adds / - takes off (Quick Trade setting); only labels here, the terminal sizes the order. */
  adjustLots?: number;
  exitingId: string | null;
  onToggleIndicator: (id: string) => void;
  onRemoveIndicator: (id: string) => void;
  onEditIndicator: (id: string) => void;
  symbolLabel: string;
  /** Visible-range request: show the last N seconds of data. */
  /** Range-button request: show the last `seconds`; a new `seq` re-applies it even for the same range. */
  focus: { seconds: number; seq: number } | null;
  contractName?: string;
  lots?: number;
  openOrders?: OrderRowView[];
  onCancelOrder?: (orderId: string) => void;
  /** Edit one of this page's working orders: `level` = where its line was dragged / typed, `lots` = new size. Resolves
   *  true when the broker accepted the modify. */
  onModifyOrder?: (req: { orderId: string; level?: number; lots?: number }) => Promise<boolean>;
  /** false = a chart-only pane (the NIFTY future): no price-axis "+" order menu. */
  ordersEnabled?: boolean;
  onPlaceLimitOrder?: (req: { side: 'BUY' | 'SELL'; price: number; lots: number; orderType?: 'LIMIT' | 'STOP_LOSS' }) => void;
  onOpenTicket?: (req: { price: number; lots: number; orderType: 'LIMIT' }) => void;
  onAlert?: (symbol: string, price: number) => void;
  /** Price Alerts on this chart's instrument, drawn as bell lines; their chip drags them to a new level (onMoveAlert, on release). */
  alertLines?: AlertLine[];
  /** Resolves true once the alert is saved at the new level (the chart shows that level until then, then the store's). */
  onMoveAlert?: (id: string, price: number) => Promise<boolean>;
  simBrackets?: Record<string, { tp?: number; sl?: number }>;
  onSetBracket?: (req: { leg: ScalperLeg; kind: 'TP' | 'SL'; price: number }) => void;
  onCancelBracket?: (req: { legId: string; kind: 'TP' | 'SL'; orderId?: string }) => void;
  onReversePosition?: (leg: ScalperLeg) => void;
  /** Trailing stops by leg id (browser-only, run by the tab that holds them) and their controls. */
  trails?: Record<string, TrailState>;
  onSetTrail?: (leg: ScalperLeg, pts: number, tick: number) => void;
  onCancelTrail?: (legId: string) => void;
  underlying?: Underlying;
  feedLotSize?: number | null;
  /** Contract units per order-book quantity unit: Dhan MCX orders count lots (10), everything else units (1). */
  orderQtyMult?: number;
  /** This chart plots an option's premium: legs are drawn at their average premium and TP / SL are premium levels.
   *  On the underlying chart (false) only FUT legs get TP / SL: an option's TP / SL belongs on its own premium chart. */
  premium?: boolean;
  /** Price tick of what is plotted (snaps the "+" menu and drags). Default: the underlying's (crude future 1, else 0.05). */
  tickSize?: number;
  /** localStorage key for this chart's drawings, read at mount (remount the chart, via `key`, to switch it). */
  drawKey?: string;
  /** What is plotted (instrument | contract | interval). When it changes, the view is fitted once its bars land: price
   *  axis back on auto-scale, time axis on the chosen range (1D / 1W ... button) or, with none chosen, all the bars. */
  viewKey?: string;
  /** Each change (the header's Reset scale button) puts the price axis back on auto-scale and the time axis on the
   *  chosen range, or all the bars: the same view a fresh instrument gets. 0 / unchanged = nothing. */
  resetSeq?: number;
  /** Call / Put open interest per strike, drawn as horizontal bars at each strike's level (underlying chart only; null
   *  hides it). Display only. */
  oiProfile?: OiProfile | null;
  /** Bars show the total OI, or today's change in OI (added = filled, shed = outlined). */
  oiMode?: OiMode;
  /** Filled with this chart's geometry once it exists (null after it is removed). */
  viewportRef?: MutableRefObject<ChartViewport | null>;
  /** Quick Trade: option legs are drawn on their strike line (else at the spot they were opened at). */
  strikeAnchor?: boolean;
  /** Quick Trade: working orders of the OPTION legs on this chart (by security id), for their premium TP / SL badges. */
  premiumOrders?: OrderRowView[];
}

interface Hover { o: number; h: number; l: number; c: number; t: number }

const fmt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function toTime(t: number): UTCTimestamp { return (t + IST_SHIFT) as UTCTimestamp; }

/** Default view (no 1D / 1W ... range picked): the last RECENT_BARS candles with RECENT_GAP bars of space after the live
 *  one for the position / TP / SL chips and the OI profile. fitContent() squeezed 3-5 days of history onto the screen. */
const RECENT_BARS = 60;
const RECENT_GAP = 55;
function frameRecent(ts: { setVisibleLogicalRange: (r: { from: number; to: number }) => void }, n: number): void {
  const last = n - 1;
  // A short history (a fresh option chart early in the day) starts at its first bar with a proportional gap, instead of
  // leaving its few candles in a thin strip between empty space on both sides.
  if (n < RECENT_BARS) ts.setVisibleLogicalRange({ from: -0.5, to: last + Math.max(6, Math.round(n * RECENT_GAP / RECENT_BARS)) });
  else ts.setVisibleLogicalRange({ from: last - RECENT_BARS, to: last + RECENT_GAP });
}

function istLabel(shifted: number): string {
  const d = new Date(shifted * 1000);
  return d.toLocaleString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Split a coloured line into one series per colour, blank where the colour differs, so a flip leaves a gap instead of a diagonal. */
/** Whole rupees with Indian grouping ("+9,120", "-2,640"), as the TP / SL / position chips show them. */
// `|| 0` turns a rounded -0 into 0: a flat leg read "+-0 INR".
const inrWhole = (n: number) => (Math.round(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

/** One indicator series as chart points: whitespace for a null, a per-point colour where the line has one. */
function seriesData(s: OutSeries, bars: Bar[]) {
  return s.values.map((v, i) => {
    if (v === null || !Number.isFinite(v)) return { time: toTime(bars[i].t) };
    const color = pointColor(s, i);
    return color ? { time: toTime(bars[i].t), value: v, color } : { time: toTime(bars[i].t), value: v };
  });
}

export interface AlertLine { id: string; price: number; title: string; paused: boolean }
const NO_ALERT_LINES: AlertLine[] = [];
const ALERT_COLOR = '#f59e0b';

function ScalperChart(props: Props) {
  const {
    bars, indicators, tool, onToolDone, clearToken, logScale, pctScale, autoScale, showGrid = true, showVolume = true, volumeMaLen = 20, legs, entrySpots,
    onExitLeg, onAdjustLeg, adjustLots = 1, exitingId, onToggleIndicator, onRemoveIndicator, onEditIndicator, symbolLabel, focus,
    contractName, lots: lotsProp = 1, openOrders = [], onCancelOrder, onModifyOrder, ordersEnabled = true, onPlaceLimitOrder, onOpenTicket, onAlert, alertLines = NO_ALERT_LINES, onMoveAlert,
    simBrackets = {}, onSetBracket, onCancelBracket, onReversePosition, trails, onSetTrail, onCancelTrail, underlying = 'NIFTY', feedLotSize, orderQtyMult = 1,
    premium = false, tickSize: tickProp, drawKey: drawKeyProp = DRAW_KEY, viewKey, resetSeq = 0, oiProfile = null, oiMode = 'total', viewportRef, strikeAnchor = false, premiumOrders,
  } = props;
  const drawKeyRef = useRef(drawKeyProp);
  const tickSize = tickProp ?? (isMcx(underlying) ? 1.0 : 0.05);
  const canBracket = useCallback((leg: ScalperLeg) => premium || leg.type === 'FUT', [premium]);
  const chrome = useChromeStable();
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const indSeriesRef = useRef<ISeriesApi<SeriesType>[]>([]);
  /** Last value sent per flat day-level series (index into indSeriesRef): a change repaints the whole series. */
  const flatLastRef = useRef(new Map<number, number | null>());
  const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const volMaRef = useRef<ISeriesApi<'Line'> | null>(null);
  const volPrevRef = useRef<{ n: number; first: number; lastT: number } | null>(null);
  // Markers (EMA-cross circles) per indicator series index, and what each last drew, so a tick re-sends them only when
  // a cross appears / disappears on the forming bar.
  const markerApisRef = useRef<Map<number, ISeriesMarkersPluginApi<Time>>>(new Map());
  const markerSigRef = useRef<Map<number, string>>(new Map());
  const sigRef = useRef('');
  // What the last pass drew: length, first bar time, and the last two bars (to spot a refresh that rewrote history).
  const prevRef = useRef<{ n: number; first: number; tail: Bar[]; flip: boolean } | null>(null);
  const legLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const orderLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const bracketLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const dragPriceLineRef = useRef<IPriceLine | null>(null);
  /** Prices the autoscale must include: open positions, TP / SL and working orders (set below, read by the series). */
  const scaleLevelsRef = useRef<number[]>([]);
  const drawLinesRef = useRef<IPriceLine[]>([]);
  const drawSeriesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const toolRef = useRef<DrawTool>(tool);
  const pendingRef = useRef<{ time: number; price: number } | null>(null);
  const drawingsRef = useRef<Drawings>({ h: [], t: [] });
  const barsRef = useRef<Bar[]>(bars);
  const [hover, setHover] = useState<Hover | null>(null);
  const [ruler, setRuler] = useState<string | null>(null);
  const [chipTops, setChipTops] = useState<Record<string, number>>({});
  // A working order being dragged to a new price (chip or line), and the order whose edit popover is open.
  const [ordDrag, setOrdDrag] = useState<{ id: string; price: number; startPrice: number; side: string } | null>(null);
  const [ordEdit, setOrdEdit] = useState<OrderEditDraft | null>(null);
  // A working order selected by a click on its line or chip: its line thickens and a round grip appears on it; only then
  // does a drag move it (a stray click on the plot can no longer start one, and a near miss no longer pans the chart).
  const [ordActive, setOrdActive] = useState<string | null>(null);
  const ordDragLineRef = useRef<IPriceLine | null>(null);
  // The dragged-to price lives in a ref: the drag effect may re-run mid-drag, and a local would reset to the start, so
  // a release then sent nothing ("sometimes it does not drag").
  const ordDragPriceRef = useRef(0);
  // Price Alert lines (one price line each) and the alert being dragged by its chip (price kept in a ref, like ordDrag).
  const alertLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const [alertDrag, setAlertDrag] = useState<{ id: string; startPrice: number } | null>(null);
  const alertDragPriceRef = useRef(0);
  // A level just dropped, shown while its save is in flight (the alert still carries its old price until the store
  // updates), so the line does not jump back to the old level for a round trip. Cleared when the save settles.
  const [alertPending, setAlertPending] = useState<Record<string, { price: number; from: number }>>({});
  const alertShown = useCallback((a: AlertLine) => {
    const p = alertPending[a.id];
    return p && p.from === a.price ? p.price : a.price;
  }, [alertPending]);
  const [hoverScale, setHoverScale] = useState<{ y: number; price: number } | null>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ y: number; price: number } | null>(null);
  // A level just dragged / typed, shown until the order book has the order (the book wins once it does). It expires after
  // TENTATIVE_TTL_MS: an order the broker rejected (accepted, then RMS-rejected) never reaches the book, and a stop line
  // kept on screen for it looked like a working stop (2026-11-26). The terminal reports the rejection itself.
  const [tentativeBrackets, setTentativeBrackets] = useState<Record<string, Partial<Record<'tp' | 'sl', { price: number; at: number }>>>>({});
  /** Set (price) or drop (null) one tentative level of a leg. */
  const setTentative = useCallback((legId: string, kind: 'TP' | 'SL', price: number | null) => {
    const k = kind === 'TP' ? 'tp' : 'sl';
    setTentativeBrackets(prev => {
      if (price === null && prev[legId]?.[k] === undefined) return prev;
      const next = { ...prev, [legId]: { ...prev[legId] } };
      if (price === null) delete next[legId][k]; else next[legId][k] = { price, at: Date.now() };
      return next;
    });
  }, []);
  // Drop expired tentative levels (one timer, at the earliest expiry).
  useEffect(() => {
    let first = Infinity;
    for (const v of Object.values(tentativeBrackets)) for (const t of [v.tp, v.sl]) if (t) first = Math.min(first, t.at + TENTATIVE_TTL_MS);
    if (first === Infinity) return;
    const id = window.setTimeout(() => {
      const now = Date.now();
      setTentativeBrackets(prev => {
        const next: typeof prev = {};
        for (const [leg, v] of Object.entries(prev)) {
          const keep: (typeof prev)[string] = {};
          if (v.tp && now - v.tp.at < TENTATIVE_TTL_MS) keep.tp = v.tp;
          if (v.sl && now - v.sl.at < TENTATIVE_TTL_MS) keep.sl = v.sl;
          if (keep.tp || keep.sl) next[leg] = keep;
        }
        return next;
      });
    }, Math.max(0, first - Date.now()) + 50);
    return () => window.clearTimeout(id);
  }, [tentativeBrackets]);
  const [dragState, setDragState] = useState<{
    kind: 'TP' | 'SL';
    leg: ScalperLeg;
    anchorLevel: number;
    isLong: boolean;
    lots: number;
    totalUnits: number;
    currentPrice: number;
    y: number;
  } | null>(null);

  const cName = contractName ?? symbolLabel.split(' · ')[0];

  // paintDrawings runs from chart click handlers created once, so it reads the theme through a ref.
  const chromeRef = useRef(chrome);
  useEffect(() => { toolRef.current = tool; barsRef.current = bars; chromeRef.current = chrome; });

  const last = bars[bars.length - 1];
  const shown: Hover | null = hover ?? (last ? { o: last.o, h: last.h, l: last.l, c: last.c, t: last.t + IST_SHIFT } : null);

  // ── chart lifecycle ────────────────────────────────────────────────
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const legLines = legLinesRef.current;
    const chart = createChart(box, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: chrome.textSecondary, fontSize: 11 },
      grid: { vertLines: { color: chrome.gridline }, horzLines: { color: chrome.gridline } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: chrome.baseline, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: chrome.baseline, timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 6 },
      autoSize: true,
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
      // The axis label carries the symbol name next to the last price, as on Dhan's chart.
      priceLineVisible: true, lastValueVisible: true, title: symbolLabel.split(' · ')[0],
      // Keep the position, TP / SL and working-order lines inside the price scale (as TradingView does), so a target
      // or stop above / below the candles stays visible and draggable instead of sitting off-screen.
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const base = original();
        const extra = scaleLevelsRef.current;
        if (!base || !base.priceRange || extra.length === 0) return base;
        return { ...base, priceRange: {
          minValue: Math.min(base.priceRange.minValue, ...extra),
          maxValue: Math.max(base.priceRange.maxValue, ...extra),
        } };
      },
    });
    // Volume: its own hidden scale on the price pane, in the bottom 20 % (TradingView's layout).
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false }, 0);
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    volSeriesRef.current = vol;
    // Volume MA: a thin line on the same scale as the bars.
    volMaRef.current = chart.addSeries(LineSeries, { priceScaleId: 'vol', color: VOL_MA, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, 0);
    chartRef.current = chart;
    candleRef.current = candles;
    const orderLines = orderLinesRef.current;
    const markerApis = markerApisRef.current;
    const markerSigs = markerSigRef.current;

    chart.subscribeCrosshairMove((p: MouseEventParams<Time>) => {
      const d = p.seriesData.get(candles) as { open: number; high: number; low: number; close: number } | undefined;
      if (!p.time || !d) { setHover(null); return; }
      setHover({ o: d.open, h: d.high, l: d.low, c: d.close, t: Number(p.time) });
    });

    chart.subscribeClick((p: MouseEventParams<Time>) => {
      const t = toolRef.current;
      if (t === 'cursor' || !p.point || p.time === undefined) return;
      const price = candles.coordinateToPrice(p.point.y);
      if (price === null) return;
      const time = Number(p.time);
      if (t === 'hline') {
        drawingsRef.current.h.push(price);
        savePref(drawKeyRef.current, JSON.stringify(drawingsRef.current));
        paintDrawings();
        toolDone();
        return;
      }
      const pend = pendingRef.current;
      if (!pend) { pendingRef.current = { time, price }; setRuler(t === 'ruler' ? 'Click the second point' : null); return; }
      pendingRef.current = null;
      if (t === 'trend') {
        drawingsRef.current.t.push({ t1: pend.time, p1: pend.price, t2: time, p2: price });
        savePref(drawKeyRef.current, JSON.stringify(drawingsRef.current));
        paintDrawings();
      } else {
        const diff = price - pend.price;
        const pct = pend.price ? (diff / pend.price) * 100 : 0;
        const bs = barsRef.current.filter(b => b.t + IST_SHIFT >= Math.min(pend.time, time) && b.t + IST_SHIFT <= Math.max(pend.time, time)).length;
        setRuler(`${diff >= 0 ? '+' : ''}${diff.toFixed(2)} pts (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%) · ${bs} bars`);
      }
      toolDone();
    });

    drawingsRef.current = loadDrawings(drawKeyRef.current);
    paintDrawings();

    if (viewportRef) {
      viewportRef.current = {
        priceToY: (price: number) => { const y = candles.priceToCoordinate(price); return y === null ? null : Number(y); },
        plotWidth: () => (boxRef.current?.clientWidth ?? 0) - (chart.priceScale('right').width() || 65),
        plotHeight: () => chart.panes()[0]?.getHeight() ?? boxRef.current?.clientHeight ?? 0,
      };
    }

    return () => {
      if (viewportRef) viewportRef.current = null;
      chart.remove();
      chartRef.current = null; candleRef.current = null; volSeriesRef.current = null; volMaRef.current = null; volPrevRef.current = null;
      indSeriesRef.current = []; flatLastRef.current.clear(); legLines.clear();
      markerApis.clear(); markerSigs.clear();
      for (const [, l] of bracketLinesRef.current) { try { candles.removePriceLine(l); } catch { /* gone */ } }
      bracketLinesRef.current.clear();
      if (dragPriceLineRef.current) {
        try { candles.removePriceLine(dragPriceLineRef.current); } catch { /* gone */ }
        dragPriceLineRef.current = null;
      }
      drawLinesRef.current = []; drawSeriesRef.current = [];
      sigRef.current = ''; prevRef.current = null;
      // The order lines belong to this chart: forget them, or a re-created chart keeps "updating" the dead ones and never
      // draws its own (no line under a working order's chip).
      orderLines.clear();
      ordDragLineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toolDone = useCallback(() => onToolDone(), [onToolDone]);

  function paintDrawings() {
    const chart = chartRef.current;
    const candles = candleRef.current;
    if (!chart || !candles) return;
    for (const l of drawLinesRef.current) { try { candles.removePriceLine(l); } catch { /* gone */ } }
    for (const s of drawSeriesRef.current) { try { chart.removeSeries(s); } catch { /* gone */ } }
    drawLinesRef.current = []; drawSeriesRef.current = [];
    const d = drawingsRef.current;
    for (const price of d.h) {
      drawLinesRef.current.push(candles.createPriceLine({ price, color: chromeRef.current.textMuted, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '' }));
    }
    for (const t of d.t) {
      const s = chart.addSeries(LineSeries, { color: chromeRef.current.drawing, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const pts = t.t1 <= t.t2
        ? [{ time: t.t1 as UTCTimestamp, value: t.p1 }, { time: t.t2 as UTCTimestamp, value: t.p2 }]
        : [{ time: t.t2 as UTCTimestamp, value: t.p2 }, { time: t.t1 as UTCTimestamp, value: t.p1 }];
      if (pts[0].time !== pts[1].time) s.setData(pts);
      drawSeriesRef.current.push(s);
    }
  }

  // Clear all drawings when the parent bumps clearToken.
  const clearSeen = useRef(clearToken);
  useEffect(() => {
    if (clearSeen.current === clearToken) return;
    clearSeen.current = clearToken;
    drawingsRef.current = { h: [], t: [] };
    savePref(drawKeyRef.current, JSON.stringify(drawingsRef.current));
    pendingRef.current = null;
    setRuler(null);
    paintDrawings();
  }, [clearToken]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { pendingRef.current = null; if (tool === 'cursor') setRuler(null); }, [tool]);

  // ── theme ──────────────────────────────────────────────────────────
  useEffect(() => {
    chartRef.current?.applyOptions({
      layout: { textColor: chrome.textSecondary },
      grid: { vertLines: { color: chrome.gridline }, horzLines: { color: chrome.gridline } },
      rightPriceScale: { borderColor: chrome.baseline },
      timeScale: { borderColor: chrome.baseline },
    });
    paintDrawings();
  }, [chrome]);

  // Volume bars: drawn when the setting is on and the bars carry volume. The candles then keep out of the bottom 20 %
  // (where the bars sit), as on TradingView. A tick updates only the forming bar; anything else re-sends them all.
  const volOn = showVolume && bars.some(b => (b.v ?? 0) > 0);
  useEffect(() => {
    const vol = volSeriesRef.current;
    const chart = chartRef.current;
    if (!vol || !chart) return;
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: volOn ? 0.22 : 0.08 } });
    const ma = volMaRef.current;
    if (!volOn || bars.length === 0) { vol.setData([]); ma?.setData([]); volPrevRef.current = null; return; }
    const point = (b: Bar) => ({ time: toTime(b.t), value: b.v ?? 0, color: b.c >= b.o ? VOL_UP : VOL_DOWN });
    const maVals = volumeMa(bars, volumeMaLen);
    const maData = () => bars.map((b, i) => (maVals[i] === null ? { time: toTime(b.t) } : { time: toTime(b.t), value: maVals[i] as number }));
    const prev = volPrevRef.current;
    const last = bars[bars.length - 1];
    try {
      const sameTail = !!prev && prev.first === bars[0].t
        && ((bars.length === prev.n && last.t === prev.lastT) || (bars.length === prev.n + 1 && bars[bars.length - 2].t === prev.lastT));
      if (sameTail) {
        vol.update(point(last));
        const m = maVals[maVals.length - 1];
        if (m !== null) ma?.update({ time: toTime(last.t), value: m });
      } else {
        vol.setData(bars.map(point));
        ma?.setData(volumeMaLen >= 1 ? maData() : []);
      }
    } catch { vol.setData(bars.map(point)); ma?.setData(volumeMaLen >= 1 ? maData() : []); }
    volPrevRef.current = { n: bars.length, first: bars[0].t, lastT: last.t };
  }, [bars, volOn, volumeMaLen]);

  // Grid on / off (viewer setting): only the lines' visibility, their colour stays the theme's.
  useEffect(() => {
    chartRef.current?.applyOptions({ grid: { vertLines: { visible: showGrid }, horzLines: { visible: showGrid } } });
  }, [showGrid]);

  useEffect(() => {
    chartRef.current?.applyOptions({
      rightPriceScale: { mode: pctScale ? PriceScaleMode.Percentage : logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal, autoScale },
    });
  }, [logScale, pctScale, autoScale]);

  // ── data + indicators ──────────────────────────────────────────────
  const outputs = useMemo(
    () => indicators.filter(i => i.visible).map(ind => ({ ind, out: computeIndicator(bars, ind) })),
    [bars, indicators],
  );

  useEffect(() => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    if (!chart || !candles || bars.length === 0) return;

    // The guide-line colour is in the signature so a theme flip rebuilds the oscillator guides.
    const sig = JSON.stringify([chrome.baseline, indicators.filter(i => i.visible).map(i => [i.id, i.kind, i.params, i.color, i.width ?? null])]);
    const prev = prevRef.current;
    // Fast path only when nothing but the forming bar moved: the bars before it must be exactly what was drawn. A candle
    // refresh that corrected an earlier tick-built bar (missed high/low) falls through to a full setData, which also
    // recomputes every indicator value.
    const flip = outputs.some(({ out }) => out.series.some(flipsAtLast));
    const tail = !!prev && sig === sigRef.current && prev.first === bars[0].t
      && (bars.length === prev.n || bars.length === prev.n + 1)
      && tailUnchanged(prev.tail, prev.n, bars);
    // A direction-coloured line (Supertrend) paints the point BEFORE a flip transparent, so that point's colour changes
    // only when the forming bar's flip state changes, or a new bar opens already flipped. Only then is that one series
    // re-sent; candles and every other series still take the cheap update. (Re-sending everything while the forming
    // bar stayed flipped redrew all 13k bars on every tick for the rest of the bar.)
    const recolor = !!prev && (bars.length === prev.n ? flip !== prev.flip : flip);
    const lastBar = bars[bars.length - 1];
    // Cross circles for series index `idx`: sent only when the list changed (a cross on the forming bar comes and goes
    // with the price, as on TradingView, until the bar closes).
    const syncMarkers = (idx: number, s: OutSeries, api: ISeriesApi<SeriesType>) => {
      if (!s.markers) return;
      const sigM = s.markers.map(m => `${bars[m.i]?.t}:${m.up ? 1 : 0}:${m.price.toFixed(2)}`).join(',');
      if (markerSigRef.current.get(idx) === sigM) return;
      markerSigRef.current.set(idx, sigM);
      let plugin = markerApisRef.current.get(idx);
      if (!plugin) { plugin = createSeriesMarkers(api, []); markerApisRef.current.set(idx, plugin); }
      plugin.setMarkers(s.markers.filter(m => bars[m.i]).map(m => ({
        time: toTime(bars[m.i].t), position: 'atPriceMiddle' as const, price: m.price, shape: 'circle' as const, color: m.color, size: 1,
      })));
    };

    if (tail) {
      try {
        candles.update({ time: toTime(lastBar.t), open: lastBar.o, high: lastBar.h, low: lastBar.l, close: lastBar.c });
        let k = 0;
        for (const { out } of outputs) {
          for (const s of out.series) {
            const api = indSeriesRef.current[k++];
            if (!api) continue;
            if (recolor && (s.colors || s.breaks) && s.style === 'line') { api.setData(seriesData(s, bars) as never); continue; }
            const v = s.values[s.values.length - 1];
            // A flat day level (DH / DL) that moved: today's whole line moves with it, so re-send just this series.
            if (s.flat && flatLastRef.current.get(k - 1) !== v) { api.setData(seriesData(s, bars) as never); flatLastRef.current.set(k - 1, v); continue; }
            if (v === null) continue;
            const color = pointColor(s, s.values.length - 1);
            api.update((color ? { time: toTime(lastBar.t), value: v, color } : { time: toTime(lastBar.t), value: v }) as never);
            syncMarkers(k - 1, s, api);
          }
        }
      } catch { /* "Cannot update oldest data": next full pass repairs it */ prevRef.current = null; }
      prevRef.current = { n: bars.length, first: bars[0].t, tail: bars.slice(-2), flip };
      return;
    }

    candles.setData(bars.map(b => ({ time: toTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));

    if (sig !== sigRef.current) {
      for (const s of indSeriesRef.current) { try { chart.removeSeries(s); } catch { /* gone */ } }
      indSeriesRef.current = [];
      flatLastRef.current.clear();
      // their marker plugins went with the series
      markerApisRef.current.clear();
      markerSigRef.current.clear();
      for (let i = chart.panes().length - 1; i > 0; i--) { try { chart.removePane(i); } catch { /* gone */ } }
      let pane = 0;
      for (const { out } of outputs) {
        const paneIdx = out.pane === 'sub' ? ++pane : 0;
        for (const s of out.series) {
          let api: ISeriesApi<SeriesType>;
          if (s.style === 'histogram') {
            api = chart.addSeries(HistogramSeries, { color: s.color, priceLineVisible: false, lastValueVisible: false, title: '' }, paneIdx);
          } else {
            // Price pane: the series' width (a user setting, or its own default), else 2 (3 for a coloured Supertrend).
            // Own pane (oscillators): the user's width if set, else 1.
            const thick = s.lineWidth ?? (paneIdx === 0 ? (s.colors ? 3 : 2) : 1);
            // Daily levels (CPR, Pivot S1-S4 / R1-R4, Day H/L: the series with day `breaks`) stay out of the price
            // autoscale: R4 / S4 sit hundreds of points away and squashed the candles into a flat line after every
            // reload / Reset scale. The candles (plus positions, TP / SL and orders) frame the axis; a far level is
            // still drawn and reached by scrolling the axis.
            const noScale = s.shadow || (paneIdx === 0 && !!s.breaks);
            api = chart.addSeries(LineSeries, {
              // Every indicator line shows its name + last value on the price scale (Supertrend too: the label takes the
              // colour of its last point, so it reads green / red with the trend).
              // A shadow line (Day High / Low) is a faint wide copy under its level: no label of its own.
              color: s.color, lineWidth: thick as 1 | 2 | 3 | 4, priceLineVisible: false, lastValueVisible: !s.shadow, title: s.shadow ? '' : s.axisLabel,
              crosshairMarkerVisible: false, ...(noScale ? { autoscaleInfoProvider: () => null } : {}),
            }, paneIdx);
            for (const g of s.guides ?? []) api.createPriceLine({ price: g, color: chrome.baseline, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '' });
          }
          indSeriesRef.current.push(api);
        }
      }
      try {
        const panes = chart.panes();
        panes[0]?.setStretchFactor(pane > 0 ? 3 : 1);
        for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1);
      } catch { /* sizing is cosmetic */ }
      sigRef.current = sig;
    }

    let k = 0;
    for (const { out } of outputs) {
      for (const s of out.series) {
        const api = indSeriesRef.current[k++];
        if (!api) continue;
        api.setData(seriesData(s, bars) as never);
        if (s.flat) flatLastRef.current.set(k - 1, s.values[s.values.length - 1]);
        syncMarkers(k - 1, s, api);
      }
    }
    prevRef.current = { n: bars.length, first: bars[0].t, tail: bars.slice(-2), flip };
  }, [bars, outputs, indicators, chrome]);

  // Visible range request (1D / 1W / ... buttons). Applied on every click (`seq`), and again when a different history
  // lands (its first bar moves: a longer range or another interval loaded), so 2M / 1M are framed on their own bars
  // rather than on the shorter history that was on screen when the button was pressed. Ticks never re-apply it.
  const firstT = bars.length ? bars[0].t : null;
  useEffect(() => {
    const chart = chartRef.current;
    const b = barsRef.current;
    if (!chart || focus === null || b.length === 0) return;
    const end = b[b.length - 1].t + IST_SHIFT;
    try { chart.timeScale().setVisibleRange({ from: (end - focus.seconds) as UTCTimestamp, to: (end + 20 * 60) as UTCTimestamp }); } catch { /* range outside data */ }
  }, [focus, firstT]);

  // Fit the view to a newly chosen instrument / strike / timeframe, once its bars are drawn (declared after the data
  // effect, so setData has run). Ticks never re-fit: only a new viewKey does.
  const fittedRef = useRef<string | undefined>(undefined);
  const hasBars = bars.length > 0;
  useEffect(() => {
    const chart = chartRef.current;
    const b = barsRef.current;
    if (!chart || !hasBars || b.length === 0 || fittedRef.current === viewKey) return;
    fittedRef.current = viewKey;
    // A price axis dragged by hand turns lightweight-charts' auto-scale off: turn it back on for the new instrument.
    chart.priceScale('right').applyOptions({ autoScale: true });
    const ts = chart.timeScale();
    try {
      if (focus) {
        const end = b[b.length - 1].t + IST_SHIFT;
        ts.setVisibleRange({ from: (end - focus.seconds) as UTCTimestamp, to: (end + 20 * 60) as UTCTimestamp });
      } else {
        frameRecent(ts, b.length);
      }
    } catch { ts.fitContent(); }
  }, [viewKey, hasBars, focus]);

  // Reset scale (header button): auto-scale the price axis (undoing a hand drag / zoom) and re-frame the time axis.
  const resetView = useCallback(() => {
    const chart = chartRef.current;
    const b = barsRef.current;
    if (!chart) return;
    chart.priceScale('right').applyOptions({ autoScale: true });
    if (b.length === 0) return;
    const ts = chart.timeScale();
    try {
      if (focus) {
        const end = b[b.length - 1].t + IST_SHIFT;
        ts.setVisibleRange({ from: (end - focus.seconds) as UTCTimestamp, to: (end + 20 * 60) as UTCTimestamp });
      } else {
        frameRecent(ts, b.length);
      }
    } catch { ts.fitContent(); }
  }, [focus]);
  const resetDoneRef = useRef(resetSeq);
  useEffect(() => {
    if (resetDoneRef.current === resetSeq) return;
    // Consumed even when there is no chart yet (a pane still mounting starts auto-scaled anyway): otherwise a pending
    // click would fire later on an unrelated range change and undo a zoom made since.
    resetDoneRef.current = resetSeq;
    resetView();
  }, [resetSeq, resetView]);

  // Zoom buttons (bottom of the chart, as on the other charts): scale the visible bar range, keeping its RIGHT edge
  // where it is, so the live candle stays in view while zooming (a centred zoom pushes it off the right side).
  // The control strip notes the visible range after each click (data-from / data-to, in bars): no React state, so a pan
  // or a tick never re-renders the chart for it; the e2e reads it.
  const zoomBarRef = useRef<HTMLDivElement>(null);
  const noteRange = useCallback(() => {
    // fitContent / setVisibleLogicalRange land on the chart's next frame: read after it.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const r = chartRef.current?.timeScale().getVisibleLogicalRange();
      const el = zoomBarRef.current;
      if (!r || !el) return;
      el.dataset.from = r.from.toFixed(2);
      el.dataset.to = r.to.toFixed(2);
      el.dataset.seq = String(Number(el.dataset.seq ?? 0) + 1);
    }));
  }, []);
  const zoomBy = useCallback((factor: number) => {
    const ts = chartRef.current?.timeScale();
    const r = ts?.getVisibleLogicalRange();
    if (!ts || !r) return;
    const width = r.to - r.from;
    const next = Math.min(Math.max(width * factor, 10), 5000); // at least 10 bars on screen, at most 5,000
    // The empty space right of the live candle scales with the window, so the live candle keeps its place on screen.
    // Keeping the right edge fixed zoomed into that space: after a reset (55 bars of gap) three Zoom in showed no candle.
    const last = barsRef.current.length - 1;
    const gap = r.to > last ? (r.to - last) * (next / width) : 0;
    const to = r.to > last ? last + gap : r.to;
    ts.setVisibleLogicalRange({ from: to - next, to });
    noteRange();
  }, [noteRange]);

  // ── position lines ────────────────────────────────────────────────
  const placed = useMemo(() => legs.map(leg => ({ leg, anchor: legAnchor(leg, entrySpots[leg.securityId], { premium, atStrike: strikeAnchor }), pnl: legPnl(leg) })), [legs, entrySpots, premium, strikeAnchor]);
  // The OI canvas reads where the position chips sit (its 150 ms repaint moves a covered strike's bars below its chip).
  const placedRef = useRef(placed);
  const chipTopsRef = useRef(chipTops);
  useEffect(() => { placedRef.current = placed; chipTopsRef.current = chipTops; }, [placed, chipTops]);

  useEffect(() => {
    const candles = candleRef.current;
    if (!candles) return;
    const lines = legLinesRef.current;
    const seen = new Set<string>();
    for (const p of placed) {
      seen.add(p.leg.id);
      // Entry line in crisp sky blue matching the reference screenshot
      const color = '#0284c7';
      const opts = { price: p.anchor.level, color, lineWidth: 1 as const, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: `${p.leg.type} ${p.leg.strike || ''}`.trim() };
      const ex = lines.get(p.leg.id);
      if (ex) ex.applyOptions(opts); else lines.set(p.leg.id, candles.createPriceLine(opts));
    }
    for (const [id, l] of lines) if (!seen.has(id)) { try { candles.removePriceLine(l); } catch { /* gone */ } lines.delete(id); }
  }, [placed]);

  // ── active brackets (TP & SL) resolution ────────────────────────────
  const activeBrackets = useMemo(() => {
    const res: Record<string, {
      tp?: { price: number; orderId?: string; isSim: boolean };
      sl?: { price: number; orderId?: string; isSim: boolean };
    }> = {};

    for (const p of placed) {
      const legId = p.leg.id;
      // No TP / SL for this leg on this chart (an option leg on the underlying chart): its levels are premiums.
      if (!canBracket(p.leg)) { res[legId] = {}; continue; }
      const simB = simBrackets?.[legId];
      const tent = tentativeBrackets?.[legId];
      let tp: { price: number; orderId?: string; isSim: boolean } | undefined;
      let sl: { price: number; orderId?: string; isSim: boolean } | undefined;

      if (simB?.tp && simB.tp > 0) tp = { price: simB.tp, isSim: true };
      if (simB?.sl && simB.sl > 0) sl = { price: simB.sl, isSim: true };

      const isLong = p.leg.netQty > 0;
      const oppSide = isLong ? 'SELL' : 'BUY';

      for (const ord of openOrders) {
        if (ord.side !== oppSide) continue;
        // Only a closing order on THIS leg's contract is its TP / SL (matched by security id, never by symbol text):
        // a name match made an entry order beside a position read as its bracket, and dragging it re-placed the entry
        // as an exit sized to the position.
        if (!ord.securityId || ord.securityId !== p.leg.securityId) continue;

        const ot = (ord.orderType || '').toUpperCase();
        const ordPrice = orderLevel(ord) ?? 0; // a stop's trigger, not its stop-limit's limit
        if (ordPrice <= 0) continue;

        if (!(p.anchor.level > 0)) continue;
        // The order type decides (a stop order is the stop loss, a limit the target), as on Dhan's chart.
        const kind = bracketKind(ot, ordPrice, p.anchor.level, isLong);
        if (!tp && kind === 'TP') {
          tp = { price: ordPrice, orderId: ord.id, isSim: false };
        } else if (!sl && kind === 'SL') {
          sl = { price: ordPrice, orderId: ord.id, isSim: false };
        }
      }

      // Tentative (just released / typed) levels only fill in until the order book shows the order: the book wins, so a
      // level replaced or cancelled elsewhere is not kept on screen at its old price.
      if (!tp && tent?.tp && tent.tp.price > 0) tp = { price: tent.tp.price, isSim: false };
      if (!sl && tent?.sl && tent.sl.price > 0) sl = { price: tent.sl.price, isSim: false };

      res[legId] = { tp, sl };
    }
    return res;
  }, [placed, simBrackets, tentativeBrackets, openOrders, canBracket]);

  // Autoscale levels: positions, TP / SL and working orders (the drag line is left out so the scale does not chase the
  // mouse). Changing them re-fits the price scale, but only while it is still auto-scaling: a price axis the user has
  // dragged / zoomed (lightweight-charts then turns its autoScale off) keeps its scale when a trade adds or moves a level.
  // Forcing autoScale back on here reset the user's zoom on every new trade.
  useEffect(() => {
    const lv: number[] = [];
    for (const p of placed) {
      if (p.anchor.level > 0) lv.push(p.anchor.level);
      const b = activeBrackets[p.leg.id];
      if (b?.tp) lv.push(b.tp.price);
      if (b?.sl) lv.push(b.sl.price);
    }
    for (const o of openOrders) { const px = orderLevel(o); if (px !== null) lv.push(px); }
    const key = lv.join(',');
    if (key === scaleLevelsRef.current.join(',')) return;
    scaleLevelsRef.current = lv;
    const scale = chartRef.current?.priceScale('right');
    if (scale?.options().autoScale) scale.applyOptions({ autoScale: true });
  }, [placed, activeBrackets, openOrders]);

  // The last-price label names the instrument on screen: it follows an underlying switch (it was set once at mount).
  useEffect(() => { candleRef.current?.applyOptions({ title: cName }); }, [cName]);

  // ── bracket lines (TP in emerald, SL in rose) ──────────────────────
  useEffect(() => {
    const candles = candleRef.current;
    if (!candles) return;
    const lines = bracketLinesRef.current;
    const seen = new Set<string>();

    for (const p of placed) {
      // The trailing stop is on this pane's axis only where TP / SL are (a FUT leg, an option on its own premium chart).
      const tr = trails?.[p.leg.id];
      if (tr && canBracket(p.leg)) {
        const key = `tsl_${p.leg.id}`;
        seen.add(key);
        const opts = { price: tr.sl, color: '#f59e0b', lineWidth: 1 as const, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'TSL' };
        const ex = lines.get(key);
        if (ex) ex.applyOptions(opts); else lines.set(key, candles.createPriceLine(opts));
      }
      const b = activeBrackets[p.leg.id];
      if (!b) continue;
      if (b.tp) {
        const key = `tp_${p.leg.id}`;
        seen.add(key);
        const opts = { price: b.tp.price, color: '#10b981', lineWidth: 1 as const, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'TP' };
        const ex = lines.get(key);
        if (ex) ex.applyOptions(opts); else lines.set(key, candles.createPriceLine(opts));
      }
      if (b.sl) {
        const key = `sl_${p.leg.id}`;
        seen.add(key);
        const opts = { price: b.sl.price, color: '#ef4444', lineWidth: 1 as const, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'SL' };
        const ex = lines.get(key);
        if (ex) ex.applyOptions(opts); else lines.set(key, candles.createPriceLine(opts));
      }
    }

    for (const [key, l] of lines) {
      if (!seen.has(key)) {
        try { candles.removePriceLine(l); } catch { /* gone */ }
        lines.delete(key);
      }
    }
  }, [placed, activeBrackets, trails, canBracket]);

  // ── dragging logic for TP & SL ──────────────────────────────────────
  const startDrag = useCallback((
    kind: 'TP' | 'SL',
    leg: ScalperLeg,
    anchorLevel: number,
    isLong: boolean,
    lots: number,
    totalUnits: number,
    initialPrice?: number
  ) => {
    const candles = candleRef.current;
    if (!candles) return;
    const startPx = initialPrice ?? (
      kind === 'TP'
        ? (isLong ? anchorLevel * 1.01 : anchorLevel * 0.99)
        : (isLong ? anchorLevel * 0.99 : anchorLevel * 1.01)
    );
    const snapped = Math.round(startPx / tickSize) * tickSize;
    const px = Number(snapped.toFixed(2));
    const y = candles.priceToCoordinate(px) ?? 200;
    setDragState({
      kind,
      leg,
      anchorLevel,
      isLong,
      lots,
      totalUnits,
      currentPrice: px,
      y: Number(y),
    });
  }, [tickSize]);

  useEffect(() => {
    if (!dragState) {
      if (dragPriceLineRef.current && candleRef.current) {
        try { candleRef.current.removePriceLine(dragPriceLineRef.current); } catch { /* gone */ }
        dragPriceLineRef.current = null;
      }
      return;
    }

    const box = boxRef.current;
    const candles = candleRef.current;
    if (!box || !candles) return;

    const color = dragState.kind === 'TP' ? '#10b981' : '#ef4444';
    if (!dragPriceLineRef.current) {
      dragPriceLineRef.current = candles.createPriceLine({
        price: dragState.currentPrice,
        color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: dragState.kind,
      });
    } else {
      dragPriceLineRef.current.applyOptions({
        price: dragState.currentPrice,
        color,
        title: dragState.kind,
      });
    }

    const onMouseMove = (e: MouseEvent) => {
      const rect = box.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const rawPrice = candles.coordinateToPrice(y);
      if (rawPrice !== null && rawPrice > 0) {
        const snapped = Math.round(rawPrice / tickSize) * tickSize;
        const finalPx = Number(snapped.toFixed(2));
        setDragState(prev => prev ? { ...prev, currentPrice: finalPx, y } : null);
        dragPriceLineRef.current?.applyOptions({ price: finalPx });
      }
    };

    const onMouseUp = () => {
      const finalPrice = dragState.currentPrice;
      const leg = dragState.leg;
      const kind = dragState.kind;
      setDragState(null);
      if (finalPrice > 0) {
        setTentative(leg.id, kind, finalPrice);
        onSetBracket?.({ leg, kind, price: finalPrice });
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [dragState, onSetBracket, tickSize, setTentative]);

  // ── open order lines (excluding matched brackets) ───────────────────
  const bracketOrderIds = useMemo(() => {
    const s = new Set<string>();
    for (const b of Object.values(activeBrackets)) {
      if (b.tp?.orderId) s.add(b.tp.orderId);
      if (b.sl?.orderId) s.add(b.sl.orderId);
    }
    return s;
  }, [activeBrackets]);

  const regularOrders = useMemo(() => {
    return openOrders.filter(o => !bracketOrderIds.has(o.id));
  }, [openOrders, bracketOrderIds]);

  // Dragging a working order: a dashed preview line follows the mouse (snapped to this chart's tick); on release at a new
  // price the order is modified through the terminal (checked against the live price there). Esc cancels the drag.
  useEffect(() => {
    const candles = candleRef.current;
    const box = boxRef.current;
    if (!ordDrag || !candles || !box) {
      if (ordDragLineRef.current && candleRef.current) {
        try { candleRef.current.removePriceLine(ordDragLineRef.current); } catch { /* gone */ }
        ordDragLineRef.current = null;
      }
      return;
    }
    const color = ordDrag.side === 'BUY' ? '#0ea5e9' : '#f43f5e';
    if (!ordDragLineRef.current) {
      ordDragLineRef.current = candles.createPriceLine({ price: ordDragPriceRef.current, color, lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Move' });
    }
    const onMove = (e: MouseEvent) => {
      const raw = candles.coordinateToPrice(e.clientY - box.getBoundingClientRect().top);
      if (raw === null || !(raw > 0)) return;
      const price = Number((Math.round(raw / tickSize) * tickSize).toFixed(2));
      ordDragPriceRef.current = price;
      ordDragLineRef.current?.applyOptions({ price });
    };
    const finish = (send: boolean) => {
      const { id, startPrice } = ordDrag;
      const price = ordDragPriceRef.current;
      setOrdDrag(null);
      if (send && Math.abs(price - startPrice) > 1e-9) void onModifyOrder?.({ orderId: id, level: price });
    };
    const onUp = () => finish(true);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(false); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [ordDrag, onModifyOrder, tickSize]);

  // A selected order is deselected by a click anywhere but on its own line, grip or chip, by Esc, or when it leaves the
  // book (filled / cancelled).
  // (derived: an order that left the book is simply no longer selected)
  const activeOrd = ordActive !== null && regularOrders.some(o => o.id === ordActive) ? ordActive : null;
  useEffect(() => {
    if (!activeOrd) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.(`[data-order-id="${activeOrd}"]`)) return;
      setOrdActive(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOrdActive(null); };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey); };
  }, [activeOrd]);

  useEffect(() => {
    const candles = candleRef.current;
    if (!candles) return;
    const lines = orderLinesRef.current;
    const seen = new Set<string>();
    for (const ord of regularOrders) {
      const p = orderLevel(ord);
      if (!p) continue;
      seen.add(ord.id);
      const color = ord.side === 'BUY' ? '#0ea5e9' : '#f43f5e';
      const title = `${ord.qty ?? ''} ${ord.side} ${ord.orderType}`;
      const opts = { price: p, color, lineWidth: (ord.id === activeOrd ? 2 : 1) as 1 | 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title };
      const ex = lines.get(ord.id);
      if (ex) ex.applyOptions(opts); else lines.set(ord.id, candles.createPriceLine(opts));
    }
    for (const [id, l] of lines) if (!seen.has(id)) { try { candles.removePriceLine(l); } catch { /* gone */ } lines.delete(id); }
  }, [regularOrders, activeOrd]);

  // ── Price Alert lines: amber dashed (paused: grey dotted), repainted only when the alert set changes ──
  useEffect(() => {
    const candles = candleRef.current;
    if (!candles) return;
    const lines = alertLinesRef.current;
    const seen = new Set<string>();
    for (const a of alertLines) {
      seen.add(a.id);
      if (alertDrag?.id === a.id) continue;          // the drag owns this line's price until release
      const opts = {
        price: alertShown(a), color: a.paused ? chrome.textMuted : ALERT_COLOR, lineWidth: 1 as const,
        lineStyle: a.paused ? LineStyle.Dotted : LineStyle.Dashed, axisLabelVisible: true, title: `🔔 ${a.title}${a.paused ? ' (paused)' : ''}`,
      };
      const ex = lines.get(a.id);
      if (ex) ex.applyOptions(opts); else lines.set(a.id, candles.createPriceLine(opts));
    }
    for (const [id, l] of lines) if (!seen.has(id)) { try { candles.removePriceLine(l); } catch { /* gone */ } lines.delete(id); }
  }, [alertLines, alertDrag, alertShown, chrome.textMuted]);

  // Dragging an alert by its chip: the line follows the mouse (snapped to the tick); release saves the new level, Esc reverts.
  useEffect(() => {
    const candles = candleRef.current;
    const box = boxRef.current;
    if (!alertDrag || !candles || !box) return;
    const line = alertLinesRef.current.get(alertDrag.id);
    const onMove = (e: MouseEvent) => {
      const raw = candles.coordinateToPrice(e.clientY - box.getBoundingClientRect().top);
      if (raw === null || !(raw > 0)) return;
      const price = Number((Math.round(raw / tickSize) * tickSize).toFixed(2));
      alertDragPriceRef.current = price;
      line?.applyOptions({ price });
    };
    const finish = (send: boolean) => {
      const price = alertDragPriceRef.current;
      const { id, startPrice } = alertDrag;
      setAlertDrag(null);
      if (send && onMoveAlert && Math.abs(price - startPrice) > 1e-9) {
        setAlertPending(prev => ({ ...prev, [id]: { price, from: startPrice } }));
        const settle = () => setAlertPending(prev => { const next = { ...prev }; delete next[id]; return next; });
        onMoveAlert(id, price).then(settle, settle);
      } else {
        line?.applyOptions({ price: startPrice });
      }
    };
    const onUp = () => finish(true);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(false); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [alertDrag, onMoveAlert, tickSize]);

  // Chip y-positions follow the price scale (zoom / pan / autoscale move it with no event), so re-read them on a short timer.
  useEffect(() => {
    const candles = candleRef.current;
    if (!candles) return;
    const tick = () => {
      const raw: { id: string; y: number }[] = [];
      for (const p of placed) {
        const y = candles.priceToCoordinate(p.anchor.level);
        if (y !== null) raw.push({ id: p.leg.id, y: Number(y) });

        const b = activeBrackets[p.leg.id];
        if (b?.tp) {
          const tpY = candles.priceToCoordinate(b.tp.price);
          if (tpY !== null) raw.push({ id: `tp_${p.leg.id}`, y: Number(tpY) });
        }
        if (b?.sl) {
          const slY = candles.priceToCoordinate(b.sl.price);
          if (slY !== null) raw.push({ id: `sl_${p.leg.id}`, y: Number(slY) });
        }
      }
      for (const ord of regularOrders) {
        const p = orderLevel(ord);
        if (p) {
          const y = candles.priceToCoordinate(p);
          if (y !== null) raw.push({ id: `ord_${ord.id}`, y: Number(y) });
        }
      }
      // Ties (a CE and a PE on the same strike line) break by id: the broker's row order can change between polls, and
      // following it made the two chips swap places under the mouse.
      raw.sort((a, b) => a.y - b.y || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const out: Record<string, number> = {};
      let floor = -Infinity;
      for (const r of raw) { const y = Math.max(r.y, floor + 26); out[r.id] = y; floor = y; }
      // The order lines' own y (not pushed apart like the chips): where a line can be grabbed and dragged.
      for (const ord of regularOrders) {
        const p = orderLevel(ord);
        const y = p ? candles.priceToCoordinate(p) : null;
        if (y !== null) out[`oline_${ord.id}`] = Number(y);
      }
      // Alert chips sit on their own line (left edge), not pushed apart; a dragged one follows the drag.
      for (const a of alertLines) {
        const y = candles.priceToCoordinate(alertDrag?.id === a.id ? alertDragPriceRef.current : alertShown(a));
        if (y !== null) out[`alert_${a.id}`] = Number(y);
      }
      setChipTops(prev => {
        const ks = Object.keys(out);
        if (ks.length === Object.keys(prev).length && ks.every(k => Math.abs((prev[k] ?? -9) - out[k]) < 0.5)) return prev;
        return out;
      });
    };
    tick();
    const t = setInterval(tick, 150);
    return () => clearInterval(t);
  }, [placed, activeBrackets, regularOrders, alertLines, alertDrag, alertShown]);

  // ── OI profile: Call / Put OI bars at each strike's level ─────────────
  // Drawn on one canvas over the plot, behind the chips, ignoring the mouse. Zoom / pan / autoscale fire no event, so it
  // is re-checked every 150 ms (like the chips) and repainted only when the geometry or the OI changed: ticks are free.
  const oiCanvasRef = useRef<HTMLCanvasElement>(null);
  const oiSigRef = useRef('');
  useEffect(() => {
    oiSigRef.current = '';
    const paint = () => {
      const cvs = oiCanvasRef.current, box = boxRef.current, chart = chartRef.current, candles = candleRef.current;
      if (!cvs || !box || !chart || !candles) return;
      const W = box.clientWidth, H = box.clientHeight;
      const axisW = chart.priceScale('right').width() || 65;
      // The main pane only: an oscillator pane below it has its own price scale.
      const plotH = chart.panes()[0]?.getHeight() ?? H;
      const right = W - axisW;
      // A strike with a position chip on it gets its bars just below the chip: drawn on the line, the chip hid them.
      const chipBands = placedRef.current.flatMap(p => {
        const top = chipTopsRef.current[p.leg.id];
        return top === undefined ? [] : [{ top: top - 11, bottom: top + 13 }];
      });
      const raw = oiProfile ? oiBars(oiProfile, p => candles.priceToCoordinate(p), right, plotH, Math.min(260, right * 0.3), oiMode) : [];
      const bars = oiBarsBelowChips(raw, chipBands);
      const sig = `${W}x${H}|${oiMode}|${chromeRef.current.textSecondary}|` + bars.map(b => `${b.side}${b.strike}:${b.y.toFixed(1)}:${b.w.toFixed(1)}:${b.h.toFixed(1)}`).join(',');
      if (sig === oiSigRef.current) return;
      oiSigRef.current = sig;
      const dpr = window.devicePixelRatio || 1;
      if (cvs.width !== Math.round(W * dpr) || cvs.height !== Math.round(H * dpr)) {
        cvs.width = Math.round(W * dpr); cvs.height = Math.round(H * dpr);
      }
      const ctx = cvs.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      // Labels by priority without overlap (largest Call / Put first, then by OI): zoomed out, the strikes are a few px
      // apart and every bar's label used to pile onto its neighbours.
      const text = (b: (typeof bars)[number]) => (oiMode === 'change' ? fmtOIChange(b.oi) : fmtOI(b.oi).replace(' ', ''));
      const labelled = placeOiLabels(bars, b => ctx.measureText(text(b)).width);
      bars.forEach((b, i) => {
        // Data colours (CLAUDE.md theming exception): Calls rose, Puts emerald; the largest of each stronger.
        const rgb = b.side === 'CE' ? '244,63,94' : '16,185,129';
        if (b.neg) {
          // OI shed today: an outline of the same length, so it reads as "taken off", not as fresh writing.
          ctx.strokeStyle = `rgba(${rgb},0.85)`;
          ctx.lineWidth = 1;
          ctx.strokeRect(b.x + 0.5, b.y + 0.5, Math.max(0, b.w - 1), Math.max(0, b.h - 1));
        } else {
          ctx.fillStyle = `rgba(${rgb},${b.max ? 0.7 : 0.32})`;
          ctx.fillRect(b.x, b.y, b.w, b.h);
        }
        if (labelled.has(i)) {
          ctx.fillStyle = chromeRef.current.textSecondary;
          ctx.fillText(text(b), b.x - 3, b.y + b.h / 2);
        }
      });
    };
    paint();
    const t = setInterval(paint, 150);
    return () => clearInterval(t);
  }, [oiProfile, oiMode, chrome]);

  // ── price scale hover '+' button ────────────────────────────────────
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onMove = (e: MouseEvent) => {
      if (!ordersEnabled) return; // chart-only pane: no "+" order menu
      const rect = box.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const scaleWidth = chartRef.current?.priceScale('right')?.width() || 65;
      if (x >= rect.width - scaleWidth - 55 && y >= 15 && y <= rect.height - 30) {
        const candles = candleRef.current;
        if (!candles) return;
        const rawPrice = candles.coordinateToPrice(y);
        if (rawPrice !== null && rawPrice > 0) {
          // The instrument's own tick (CRUDEOILM future Rs 1, NSE index options Rs 0.05): an off-tick price would be
          // rejected by the exchange (the screenshot that found this offered 7,505.17 on crude).
          const snapped = Math.round(rawPrice / tickSize) * tickSize;
          setHoverScale({ y, price: Number(snapped.toFixed(2)) });
          return;
        }
      }
      if (!menu) setHoverScale(null);
    };
    // The "+" is drawn over the chart but is not inside `box`: moving onto it fires `mouseleave` here. Hiding it then
    // put the pointer back on the chart, which showed it again: it flickered on every move and could not be clicked.
    const onLeave = (e: MouseEvent) => {
      const to = e.relatedTarget as Node | null;
      if (to && plusRef.current?.contains(to)) return;
      if (!menu) setHoverScale(null);
    };
    box.addEventListener('mousemove', onMove);
    box.addEventListener('mouseleave', onLeave);
    return () => {
      box.removeEventListener('mousemove', onMove);
      box.removeEventListener('mouseleave', onLeave);
    };
  }, [menu, tickSize, ordersEnabled]);

  // ── context menu events & keyboard shortcuts ────────────────────────
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-testid="chart-scale-menu"]')) return;
      setMenu(null);
      setHoverScale(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(null);
        setHoverScale(null);
        return;
      }
      if (e.shiftKey && (e.key === 'S' || e.key === 's')) {
        e.preventDefault();
        const p = menu.price;
        const cur = last?.c ?? p;
        onPlaceLimitOrder?.({ side: 'SELL', price: p, lots: lotsProp, orderType: p < cur ? 'STOP_LOSS' : 'LIMIT' });
        setMenu(null); setHoverScale(null);
        return;
      }
      if (e.shiftKey && (e.key === 'B' || e.key === 'b')) {
        e.preventDefault();
        const p = menu.price;
        const cur = last?.c ?? p;
        onPlaceLimitOrder?.({ side: 'BUY', price: p, lots: lotsProp, orderType: p > cur ? 'STOP_LOSS' : 'LIMIT' });
        setMenu(null); setHoverScale(null);
        return;
      }
      if (e.shiftKey && (e.key === 'T' || e.key === 't')) {
        e.preventDefault();
        onOpenTicket?.({ price: menu.price, lots: lotsProp, orderType: 'LIMIT' });
        setMenu(null); setHoverScale(null);
        return;
      }
      if (e.altKey && (e.key === 'H' || e.key === 'h')) {
        e.preventDefault();
        drawingsRef.current.h.push(menu.price);
        savePref(drawKeyRef.current, JSON.stringify(drawingsRef.current));
        paintDrawings();
        setMenu(null); setHoverScale(null);
        return;
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu, lotsProp, last, onPlaceLimitOrder, onOpenTicket]);

  // Indicator legend: a collapsed dropdown by default (it covered the candles); open state remembered per viewer.
  const [legendOpen, setLegendOpen] = useState(false);
  useEffect(() => { if (readPref(LEGEND_OPEN_KEY) === '1') setLegendOpen(true); }, []);
  const toggleLegend = useCallback(() => {
    setLegendOpen(o => { savePref(LEGEND_OPEN_KEY, o ? '0' : '1'); return !o; });
  }, []);

  const zoomBtn = 'flex items-center justify-center w-6 h-6 rounded-full text-xs bg-zinc-900 border border-zinc-700 text-zinc-100 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60';
  return (
    <div className="relative w-full h-full min-h-0">
      <div ref={boxRef} className={cn('absolute inset-0', tool !== 'cursor' && 'cursor-crosshair')} />
      {/* Zoom out / reset / zoom in, above the time axis (same controls as the other charts) */}
      <div ref={zoomBarRef} data-testid="chart-zoom" className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1">
        <button type="button" onClick={() => zoomBy(1 / 0.7)} title="Zoom out" aria-label="Zoom out" className={zoomBtn}>−</button>
        <button type="button" onClick={() => { resetView(); noteRange(); }} title="Reset zoom: auto-scale the price axis and show the latest bars" aria-label="Reset zoom" className={zoomBtn}>↺</button>
        <button type="button" onClick={() => zoomBy(0.7)} title="Zoom in" aria-label="Zoom in" className={zoomBtn}>+</button>
      </div>
      {oiProfile && <canvas ref={oiCanvasRef} data-testid="oi-profile" aria-hidden className="absolute inset-0 w-full h-full pointer-events-none z-[1]" />}

      {/* OHLC + indicator legend */}
      <div className="absolute left-3 top-2 z-10 flex flex-col gap-1 pointer-events-none max-w-[70%]">
        <div className="flex items-center gap-2 text-[11px] font-mono tabular-nums">
          <span className="text-zinc-200 font-bold">{symbolLabel}</span>
          {shown && (
            <>
              <span className="text-zinc-500">O</span><span className={shown.c >= shown.o ? 'text-emerald-400' : 'text-rose-400'}>{fmt(shown.o)}</span>
              <span className="text-zinc-500">H</span><span className={shown.c >= shown.o ? 'text-emerald-400' : 'text-rose-400'}>{fmt(shown.h)}</span>
              <span className="text-zinc-500">L</span><span className={shown.c >= shown.o ? 'text-emerald-400' : 'text-rose-400'}>{fmt(shown.l)}</span>
              <span className="text-zinc-500">C</span><span className={shown.c >= shown.o ? 'text-emerald-400' : 'text-rose-400'}>{fmt(shown.c)}</span>
              <span className="text-zinc-500">{istLabel(shown.t)}</span>
            </>
          )}
        </div>
        {indicators.length > 0 && (
          <button type="button" data-testid="indicator-list-toggle" aria-expanded={legendOpen}
            aria-label={legendOpen ? 'Collapse indicator list' : 'Expand indicator list'}
            title={legendOpen ? 'Collapse indicator list' : 'Expand indicator list'}
            onClick={toggleLegend}
            className="pointer-events-auto flex items-center gap-1.5 w-fit px-1.5 py-0.5 rounded border border-zinc-700 bg-zinc-900/80 text-[11px] font-mono text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60">
            {legendOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <span className="flex items-center gap-0.5">
              {indicators.map(ind => (
                <span key={ind.id} className={cn('inline-block w-1.5 h-1.5 rounded-full', !ind.visible && 'opacity-30')} style={{ backgroundColor: ind.color }} />
              ))}
            </span>
            <span className="tabular-nums">{indicators.filter(i => i.visible).length}/{indicators.length}</span>
          </button>
        )}
        {legendOpen && indicators.length > 0 && (
        <div data-testid="indicator-list" className="pointer-events-auto flex flex-col gap-0.5 w-fit px-1.5 py-1 rounded border border-zinc-700 bg-zinc-900/90 shadow-lg">
        {indicators.map(ind => (
          <div key={ind.id} className="pointer-events-auto flex items-center gap-1 text-[11px] font-mono group w-fit">
            <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: ind.color }} />
            <span className={ind.visible ? 'text-zinc-300' : 'text-zinc-600 line-through'}>{indicatorLabel(ind)}</span>
            <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              <button type="button" aria-label={ind.visible ? 'Hide indicator' : 'Show indicator'} onClick={() => onToggleIndicator(ind.id)}
                className="p-0.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60">
                {ind.visible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
              </button>
              <button type="button" aria-label="Indicator settings" onClick={() => onEditIndicator(ind.id)}
                className="p-0.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60">
                <Settings2 className="w-3 h-3" />
              </button>
              <button type="button" aria-label="Remove indicator" onClick={() => onRemoveIndicator(ind.id)}
                className="p-0.5 rounded text-zinc-400 hover:text-rose-400 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60">
                <X className="w-3 h-3" />
              </button>
            </span>
          </div>
        ))}
        </div>
        )}
      </div>

      {ruler && (
        <div className="absolute left-1/2 -translate-x-1/2 top-2 z-20 px-2 py-1 rounded bg-sky-600 text-oncolor text-[11px] font-mono font-bold">{ruler}</div>
      )}

      {/* '+' button on price scale edge */}
      {hoverScale && (
        <button
          ref={plusRef}
          // Leaving the "+" back onto the chart: the chart's mousemove takes over. Anywhere else: hide it (not while its
          // menu is open).
          onMouseLeave={(e) => {
            const to = e.relatedTarget as Node | null;
            if (to instanceof Node && boxRef.current?.contains(to)) return;
            if (!menu) setHoverScale(null);
          }}
          type="button"
          aria-label={`Order options at ${hoverScale.price}`}
          title={`Order options at ${hoverScale.price}`}
          onClick={(e) => {
            e.stopPropagation();
            setMenu(prev => prev && prev.price === hoverScale.price ? null : { y: hoverScale.y, price: hoverScale.price });
          }}
          style={{
            top: hoverScale.y - 10,
            right: (chartRef.current?.priceScale('right')?.width() || 65) - 10,
          }}
          className={cn(
            'absolute z-40 w-5 h-5 rounded-full bg-zinc-950 text-white border border-zinc-500 shadow-lg flex items-center justify-center cursor-pointer transition-transform hover:scale-125 focus:outline-none',
            menu && menu.price === hoverScale.price ? 'ring-2 ring-sky-400 scale-110 bg-zinc-800' : 'hover:bg-zinc-800'
          )}
        >
          <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
        </button>
      )}

      {/* Context Menu popup matching reference image */}
      {menu && (
        <div
          data-testid="chart-scale-menu"
          style={{
            top: Math.max(8, Math.min(menu.y - 45, (boxRef.current?.clientHeight ?? 500) - 230)),
            right: (chartRef.current?.priceScale('right')?.width() || 65) + 14,
          }}
          className="absolute z-50 w-[360px] rounded-xl border border-zinc-700/90 bg-zinc-900/95 shadow-2xl p-1.5 text-xs select-none backdrop-blur-md"
        >
          {/* Add alert */}
          <button
            type="button"
            onClick={() => {
              onAlert?.(cName, menu.price);
              setMenu(null);
              setHoverScale(null);
            }}
            className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg hover:bg-zinc-800 text-left transition-colors text-zinc-200"
          >
            <span className="flex items-center gap-2.5 min-w-0">
              <Bell className="w-4 h-4 text-zinc-400 shrink-0" />
              <span className="truncate">Add alert on <span className="font-semibold text-white">{cName}</span> at <span className="font-semibold text-white">{fmt(menu.price)}</span></span>
            </span>
          </button>

          {/* Sell limit */}
          <button
            type="button"
            onClick={() => {
              const cur = last?.c ?? menu.price;
              onPlaceLimitOrder?.({
                side: 'SELL',
                price: menu.price,
                lots: lotsProp,
                orderType: menu.price < cur ? 'STOP_LOSS' : 'LIMIT',
              });
              setMenu(null);
              setHoverScale(null);
            }}
            className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg hover:bg-zinc-800 text-left transition-colors text-zinc-200 group"
          >
            <span className="flex items-center gap-2.5 min-w-0">
              <ArrowDown className="w-4 h-4 text-rose-400 shrink-0" />
              <span className="truncate">
                Sell <span className="font-semibold text-white">{lotsProp}</span> {cName} @ <span className="font-semibold text-white">{fmt(menu.price)}</span> limit
              </span>
            </span>
            <span className="text-[10px] text-zinc-500 font-mono shrink-0 ml-2">Shift+S</span>
          </button>

          {/* Buy limit */}
          <button
            type="button"
            onClick={() => {
              const cur = last?.c ?? menu.price;
              onPlaceLimitOrder?.({
                side: 'BUY',
                price: menu.price,
                lots: lotsProp,
                orderType: menu.price > cur ? 'STOP_LOSS' : 'LIMIT',
              });
              setMenu(null);
              setHoverScale(null);
            }}
            className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg hover:bg-zinc-800 text-left transition-colors text-zinc-200 group"
          >
            <span className="flex items-center gap-2.5 min-w-0">
              <ArrowUp className="w-4 h-4 text-sky-400 shrink-0" />
              <span className="truncate">
                Buy <span className="font-semibold text-white">{lotsProp}</span> {cName} @ <span className="font-semibold text-white">{fmt(menu.price)}</span> limit
              </span>
            </span>
            <span className="text-[10px] text-zinc-500 font-mono shrink-0 ml-2">Shift+B</span>
          </button>

          {/* Add order... */}
          <button
            type="button"
            onClick={() => {
              onOpenTicket?.({
                price: menu.price,
                lots: lotsProp,
                orderType: 'LIMIT',
              });
              setMenu(null);
              setHoverScale(null);
            }}
            className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg hover:bg-zinc-800 text-left transition-colors text-zinc-200 group"
          >
            <span className="flex items-center gap-2.5 min-w-0">
              <FileText className="w-4 h-4 text-zinc-400 shrink-0" />
              <span className="truncate">Add order on <span className="font-semibold text-white">{cName}</span> at <span className="font-semibold text-white">{fmt(menu.price)}</span>…</span>
            </span>
            <span className="text-[10px] text-zinc-500 font-mono shrink-0 ml-2">Shift+T</span>
          </button>

          <div className="border-t border-zinc-800 my-1" />

          {/* Draw horizontal line */}
          <button
            type="button"
            onClick={() => {
              drawingsRef.current.h.push(menu.price);
              savePref(drawKeyRef.current, JSON.stringify(drawingsRef.current));
              paintDrawings();
              setMenu(null);
              setHoverScale(null);
            }}
            className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg hover:bg-zinc-800 text-left transition-colors text-zinc-200 group"
          >
            <span className="flex items-center gap-2.5 min-w-0">
              <Minus className="w-4 h-4 text-zinc-400 shrink-0" />
              <span className="truncate">Draw horizontal line at <span className="font-semibold text-white">{fmt(menu.price)}</span></span>
            </span>
            <span className="text-[10px] text-zinc-500 font-mono shrink-0 ml-2">Alt+H</span>
          </button>
        </div>
      )}

      {/* Price Alert chips: bell + level at the left edge of each alert line; press and drag to move the alert */}
      {alertLines.map(a => {
        const top = chipTops[`alert_${a.id}`];
        if (top === undefined) return null;
        const dragging = alertDrag?.id === a.id;
        return (
          <div key={`alert_${a.id}`} data-testid="alert-chip" data-alert-id={a.id} style={{ top: top - 10 }}
            title={onMoveAlert ? 'Price alert — drag to move it to a new level (Esc cancels)' : 'Price alert'}
            onMouseDown={e => {
              if (!onMoveAlert) return;
              e.stopPropagation(); e.preventDefault();
              alertDragPriceRef.current = alertShown(a);
              setAlertDrag({ id: a.id, startPrice: a.price });
            }}
            className={cn('absolute left-2 z-[55] flex items-center gap-1 px-1.5 h-[20px] rounded border text-[11px] font-mono bg-zinc-900 shadow select-none',
              a.paused ? 'border-zinc-600 text-zinc-400' : 'border-amber-500/60 text-amber-400',
              onMoveAlert && (dragging ? 'cursor-grabbing ring-1 ring-amber-400' : 'cursor-ns-resize'))}>
            <Bell className="w-3 h-3" />
            <span className="font-semibold">{fmt(dragging ? alertDragPriceRef.current : alertShown(a))}</span>
          </div>
        );
      })}

      {/* working order chips on chart: this page's own Limit / SL / SL-M orders can be dragged to a new price (chip or
          line) and have their lots edited; another placer's order is shown with its x only */}
      {regularOrders.map(ord => {
        const p = orderLevel(ord);
        if (!p) return null;
        const top = chipTops[`ord_${ord.id}`];
        if (top === undefined) return null;
        const isBuy = ord.side === 'BUY';
        const canEdit = !!onModifyOrder && isEditable(ord);
        // Order qty is in the broker's own unit (Dhan MCX: lots; Kotak / NSE: units): orderQtyMult converts it.
        const lotSize = displayLotUnits(underlying, feedLotSize);
        const ordLots = ord.qty ? Math.max(1, Math.round(qtyUnits(ord.qty, orderQtyMult) / lotSize)) : null;
        const lineY = chipTops[`oline_${ord.id}`];
        const active = activeOrd === ord.id;
        const startDragNow = (e: React.MouseEvent) => {
          e.stopPropagation();
          e.preventDefault();
          setOrdEdit(null);
          ordDragPriceRef.current = p;
          setOrdDrag({ id: ord.id, price: p, startPrice: p, side: ord.side });
        };
        // First click selects the order (grip shown); on a selected order a press starts the drag.
        const onLineDown = (e: React.MouseEvent) => {
          if (!canEdit || (e.target as HTMLElement).closest('button')) return;
          if (!active) { e.stopPropagation(); e.preventDefault(); setOrdActive(ord.id); return; }
          startDragNow(e);
        };
        return (
          <Fragment key={ord.id}>
            {canEdit && lineY !== undefined && (
              <div data-testid="order-line-handle" data-order-id={ord.id} aria-hidden
                title={active ? 'Drag to move the order to a new price (Esc or a click elsewhere deselects)' : 'Click to select this order, then drag it to a new price'}
                onMouseDown={onLineDown} style={{ top: lineY - 6 }}
                className={cn('absolute left-0 right-[64px] h-3 z-[50]', active ? 'cursor-ns-resize' : 'cursor-pointer')} />
            )}
            {canEdit && active && lineY !== undefined && (
              <div data-testid="order-line-grip" data-order-id={ord.id} role="button" aria-label={`Drag order ${ord.id}`} tabIndex={-1}
                onMouseDown={startDragNow} style={{ top: lineY - 7, left: '50%' }}
                className={cn('absolute z-[56] -ml-[7px] w-[14px] h-[14px] rounded-full border-2 bg-zinc-950 cursor-grab active:cursor-grabbing shadow',
                  isBuy ? 'border-sky-400' : 'border-rose-400')} />
            )}
            <div data-testid="order-chip" data-order-id={ord.id} style={{ top: top - 11 }} onMouseDown={onLineDown}
              title={canEdit ? (active ? 'Drag to move the order to a new price; click its lots to edit' : 'Click to select, then drag to a new price; click its lots to edit') : 'Placed elsewhere: it can be cancelled (after a confirmation), not edited here'}
              className={cn('absolute right-[84px] z-[55] flex items-center gap-1.5 pl-2 pr-1 h-[22px] rounded border text-[11px] font-mono bg-zinc-900 shadow select-none',
                isBuy ? 'border-sky-500/60' : 'border-rose-500/60', canEdit && (active ? 'cursor-grab active:cursor-grabbing ring-1 ring-sky-400' : 'cursor-pointer'))}>
              <span className={cn('font-bold', isBuy ? 'text-sky-400' : 'text-rose-400')}>{ord.side}</span>
              {canEdit ? (
                <button type="button" aria-label={`Edit order ${ord.id}`} aria-expanded={ordEdit?.id === ord.id}
                  onClick={e => { e.stopPropagation(); setOrdEdit(ordEdit?.id === ord.id ? null : { id: ord.id, lots: ordLots ?? 1, price: p.toFixed(2) }); }}
                  className="h-[16px] px-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700">{ordLots ?? ord.qty} lot{ordLots === 1 ? '' : 's'}</button>
              ) : <span className="text-zinc-200">{ord.qty}</span>}
              <span className="text-zinc-400">{ord.orderType}</span>
              <span className="text-zinc-300 font-semibold">@ {fmt(p)}</span>
              {ord.cancellable && (
                <button type="button" aria-label={`Cancel order ${ord.id}`} onClick={e => { e.stopPropagation(); onCancelOrder?.(ord.id); }}
                  className="ml-1 h-[18px] px-1 rounded bg-zinc-800 hover:bg-rose-600 text-zinc-400 hover:text-white text-[10px] font-bold transition-colors">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            {ordEdit?.id === ord.id && (
              <OrderEditPopover top={top + 14} ord={ord} draft={ordEdit} onDraft={setOrdEdit} maxLots={INSTRUMENTS[underlying].maxLots}
                onClose={() => setOrdEdit(null)}
                onSave={async (lots, level) => {
                  const req = { orderId: ord.id, ...(lots !== ordLots ? { lots } : {}), ...(level !== null ? { level } : {}) };
                  if (req.lots === undefined && req.level === undefined) { setOrdEdit(null); return; } // nothing changed: nothing sent
                  if (await onModifyOrder!(req)) setOrdEdit(null);
                }} />
            )}
          </Fragment>
        );
      })}

      {/* Target (TP) and Stop Loss (SL) chips matching reference */}
      {placed.map(p => {
        const b = activeBrackets[p.leg.id];
        if (!b) return null;
        const isLong = p.leg.netQty > 0;
        // netQty is in the broker's own unit (Dhan MCX: lots; Kotak / SIM / NSE: units): leg.mult converts it.
        const lotSize = displayLotUnits(underlying, feedLotSize);
        const totalUnits = qtyUnits(p.leg.netQty, p.leg.mult ?? 1);
        const lots = Math.max(1, Math.round(totalUnits / lotSize));

        const tpTop = b.tp ? chipTops[`tp_${p.leg.id}`] : undefined;
        const slTop = b.sl ? chipTops[`sl_${p.leg.id}`] : undefined;

        const tpPtDiff = b.tp ? (isLong ? (b.tp.price - p.anchor.level) : (p.anchor.level - b.tp.price)) : 0;
        const tpPct = b.tp && p.anchor.level > 0 ? (tpPtDiff / p.anchor.level) * 100 : 0;
        const tpPnl = tpPtDiff * totalUnits;

        const slPtDiff = b.sl ? (isLong ? (b.sl.price - p.anchor.level) : (p.anchor.level - b.sl.price)) : 0;
        const slPct = b.sl && p.anchor.level > 0 ? (slPtDiff / p.anchor.level) * 100 : 0;
        const slPnl = slPtDiff * totalUnits;

        return (
          <div key={`brackets_${p.leg.id}`}>
            {/* Target Profit (TP) Chip */}
            {b.tp && tpTop !== undefined && (
              <div
                data-testid="tp-chip"
                style={{ top: tpTop - 11 }}
                className="absolute right-[84px] z-[56] flex items-center shadow-lg font-mono text-[11px]"
              >
                <div
                  title="Drag to adjust Target Profit"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    startDrag('TP', p.leg, p.anchor.level, isLong, lots, totalUnits, b.tp!.price);
                  }}
                  className="h-[22px] px-2 rounded-l flex items-center bg-emerald-950/90 border border-emerald-500/80 text-emerald-400 font-bold cursor-grab active:cursor-grabbing select-none"
                >
                  TP {tpPnl >= 0 ? '+' : ''}{inrWhole(tpPnl)} ({tpPct >= 0 ? '+' : ''}{tpPct.toFixed(2)}%)
                </div>
                <div
                  title="Click and drag to move Target Profit to a new price"
                  onMouseDown={(e) => {
                    if ((e.target as HTMLElement).tagName.toLowerCase() === 'button') return;
                    e.stopPropagation();
                    e.preventDefault();
                    startDrag('TP', p.leg, p.anchor.level, isLong, lots, totalUnits, b.tp!.price);
                  }}
                  className="h-[22px] px-2 rounded-r flex items-center gap-1.5 bg-zinc-900 border border-emerald-500/60 border-l-0 text-zinc-200 cursor-grab active:cursor-grabbing select-none hover:brightness-110 transition-colors"
                >
                  <span>{lots} {isLong ? 'Sell' : 'Buy'} Limit</span>
                  <button
                    type="button"
                    title="Cancel Target"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTentative(p.leg.id, 'TP', null);
                      onCancelBracket?.({ legId: p.leg.id, kind: 'TP', orderId: b.tp!.orderId });
                    }}
                    className="h-[16px] w-[16px] rounded flex items-center justify-center text-zinc-400 hover:text-white hover:bg-rose-600 transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )}

            {/* Stop Loss (SL) Chip */}
            {b.sl && slTop !== undefined && (
              <div
                data-testid="sl-chip"
                style={{ top: slTop - 11 }}
                className="absolute right-[84px] z-[56] flex items-center shadow-lg font-mono text-[11px]"
              >
                <div
                  title="Drag to adjust Stop Loss"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    startDrag('SL', p.leg, p.anchor.level, isLong, lots, totalUnits, b.sl!.price);
                  }}
                  className="h-[22px] px-2 rounded-l flex items-center bg-rose-950/90 border border-rose-500/80 text-rose-400 font-bold cursor-grab active:cursor-grabbing select-none"
                >
                  SL {slPnl >= 0 ? '+' : ''}{inrWhole(slPnl)} ({slPct >= 0 ? '+' : ''}{slPct.toFixed(2)}%)
                </div>
                <div
                  title="Click and drag to move Stop Loss to a new price"
                  onMouseDown={(e) => {
                    if ((e.target as HTMLElement).tagName.toLowerCase() === 'button') return;
                    e.stopPropagation();
                    e.preventDefault();
                    startDrag('SL', p.leg, p.anchor.level, isLong, lots, totalUnits, b.sl!.price);
                  }}
                  className="h-[22px] px-2 rounded-r flex items-center gap-1.5 bg-zinc-900 border border-rose-500/60 border-l-0 text-zinc-200 cursor-grab active:cursor-grabbing select-none hover:brightness-110 transition-colors"
                >
                  {/* An option's stop is sent as a stop-limit (brokers refuse SL-M on options); a future's as SL-M. */}
                  <span>{lots} {isLong ? 'Sell' : 'Buy'} {p.leg.type === 'FUT' ? 'Stop Market' : 'Stop Limit'}</span>
                  <button
                    type="button"
                    title="Cancel Stop Loss"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTentative(p.leg.id, 'SL', null);
                      onCancelBracket?.({ legId: p.leg.id, kind: 'SL', orderId: b.sl!.orderId });
                    }}
                    className="h-[16px] w-[16px] rounded flex items-center justify-center text-zinc-400 hover:text-white hover:bg-rose-600 transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Floating Ghost Chip while Dragging */}
      {dragState && (() => {
        const dragPtDiff = dragState.isLong
          ? (dragState.currentPrice - dragState.anchorLevel)
          : (dragState.anchorLevel - dragState.currentPrice);
        const dragPct = dragState.anchorLevel > 0 ? (dragPtDiff / dragState.anchorLevel) * 100 : 0;
        const dragPnl = dragPtDiff * dragState.totalUnits;
        return (
          <div
            data-testid="drag-ghost-chip"
            style={{ top: dragState.y - 11 }}
            className="absolute right-[84px] z-[60] flex items-center shadow-2xl font-mono text-[11px] pointer-events-none"
          >
            {dragState.kind === 'TP' ? (
              <>
                <div className="h-[22px] px-2 rounded-l flex items-center bg-emerald-950/95 border border-emerald-400 text-emerald-300 font-bold">
                  TP {dragPnl >= 0 ? '+' : ''}{inrWhole(dragPnl)} ({dragPct >= 0 ? '+' : ''}{dragPct.toFixed(2)}%)
                </div>
                <div className="h-[22px] px-2 rounded-r flex items-center bg-zinc-900 border border-emerald-500/80 border-l-0 text-zinc-100">
                  {dragState.lots} {dragState.isLong ? 'Sell' : 'Buy'} Limit
                </div>
              </>
            ) : (
              <>
                <div className="h-[22px] px-2 rounded-l flex items-center bg-rose-950/95 border border-rose-400 text-rose-300 font-bold">
                  SL {dragPnl >= 0 ? '+' : ''}{inrWhole(dragPnl)} ({dragPct >= 0 ? '+' : ''}{dragPct.toFixed(2)}%)
                </div>
                <div className="h-[22px] px-2 rounded-r flex items-center bg-zinc-900 border border-rose-500/80 border-l-0 text-zinc-100">
                  {dragState.lots} {dragState.isLong ? 'Sell' : 'Buy'} {dragState.leg.type === 'FUT' ? 'Stop Market' : 'Stop Limit'}
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* Position chips: one per open option/fut leg, at entry level with controls */}
      {placed.map(p => {
        const top = chipTops[p.leg.id];
        if (top === undefined) return null;
        const isLong = p.leg.netQty > 0;
        // netQty is in the broker's own unit (Dhan MCX: lots; Kotak / SIM / NSE: units): leg.mult converts it.
        const lotSize = displayLotUnits(underlying, feedLotSize);
        const totalUnits = qtyUnits(p.leg.netQty, p.leg.mult ?? 1);
        const lots = Math.max(1, Math.round(totalUnits / lotSize));

        // An option on the underlying chart is priced by its PREMIUM: the chart's points are index points, so neither its
        // % nor a fallback from them means anything (it showed index points x units when the live premium was missing).
        // FUT legs and an option on its own premium chart: the chart's last price is the instrument's own.
        const optOnIndex = p.leg.type !== 'FUT' && !premium;
        let curPnl: number | null, curPct: number | null;
        if (optOnIndex) {
          const pp = legPremiumPnl(p.leg);
          curPnl = pp?.pnl ?? null; curPct = pp?.pct ?? null;
        } else {
          const curSpot = (last?.c && last.c > 0) ? last.c : p.anchor.level;
          const curPtDiff = isLong ? (curSpot - p.anchor.level) : (p.anchor.level - curSpot);
          curPct = p.anchor.level > 0 ? (curPtDiff / p.anchor.level) * 100 : 0;
          curPnl = p.pnl !== null ? p.pnl : (curPtDiff * totalUnits);
        }
        const pnlCls = curPnl === null ? 'text-zinc-400' : curPnl >= 0 ? 'text-emerald-400' : 'text-rose-400';

        const b = activeBrackets[p.leg.id];

        return (
          <div
            key={p.leg.id}
            data-testid="position-chip"
            data-side={isLong ? 'long' : 'short'}
            style={{ top: top - 11 }}
            className="absolute right-[84px] z-[55] flex items-center gap-1.5 px-1.5 h-[24px] rounded border border-sky-500/70 bg-zinc-900 shadow-md font-mono text-[11px]"
          >
            {p.leg.type !== 'FUT' && (premium || (strikeAnchor && optOnIndex)) ? (
              // An option leg gets the same chip on its own premium chart as on the index chart (Quick Trade): leg label,
              // typed TP / SL (a premium or % of entry), TSL. On the premium chart its levels are also drawn as
              // draggable lines, so the badges read the same brackets the lines do (activeBrackets).
              <PremiumBracketControls leg={p.leg} units={totalUnits} tick={INSTRUMENTS[underlying].optTick}
                brackets={premium
                  ? { tp: b?.tp ? { price: b.tp.price, orderId: b.tp.orderId, sim: b.tp.isSim } : undefined,
                      sl: b?.sl ? { price: b.sl.price, orderId: b.sl.orderId, sim: b.sl.isSim } : undefined }
                  : premiumBracketsFor(p.leg, premiumOrders ?? [], simBrackets?.[p.leg.id])}
                onSet={(kind, price) => {
                  // On the premium chart a dragged level is held as tentative and shown ahead of the order book, so a
                  // typed level must replace it (else the badge and line kept the old dragged price).
                  if (premium) setTentative(p.leg.id, kind, price);
                  onSetBracket?.({ leg: p.leg, kind, price });
                }}
                onCancel={(kind, orderId) => {
                  if (premium) setTentative(p.leg.id, kind, null);
                  onCancelBracket?.({ legId: p.leg.id, kind, orderId });
                }}
                trail={trails?.[p.leg.id]}
                onSetTrail={onSetTrail ? pts => onSetTrail(p.leg, pts, INSTRUMENTS[underlying].optTick) : undefined}
                onCancelTrail={onCancelTrail ? () => onCancelTrail(p.leg.id) : undefined}
                onDragStart={premium ? kind => startDrag(kind, p.leg, p.anchor.level, isLong, lots, totalUnits, kind === 'TP' ? b?.tp?.price : b?.sl?.price) : undefined} />
            ) : canBracket(p.leg) ? (<>
            {/* TP draggable button */}
            <button
              type="button"
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                startDrag('TP', p.leg, p.anchor.level, isLong, lots, totalUnits, b?.tp?.price);
              }}
              className="h-[18px] px-1.5 rounded bg-zinc-800 hover:bg-emerald-600/30 text-emerald-400 border border-emerald-500/50 text-[10px] font-bold cursor-grab active:cursor-grabbing transition-colors"
            >
              TP
            </button>

            {/* SL draggable button */}
            <button
              type="button"
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                startDrag('SL', p.leg, p.anchor.level, isLong, lots, totalUnits, b?.sl?.price);
              }}
              className="h-[18px] px-1.5 rounded bg-zinc-800 hover:bg-rose-600/30 text-rose-400 border border-rose-500/50 text-[10px] font-bold cursor-grab active:cursor-grabbing transition-colors"
            >
              SL
            </button>
            {onSetTrail && onCancelTrail && (
              <TrailControl leg={p.leg} units={totalUnits} tick={p.leg.type === 'FUT' ? INSTRUMENTS[underlying].futTick : INSTRUMENTS[underlying].optTick}
                trail={trails?.[p.leg.id]}
                onSet={pts => onSetTrail(p.leg, pts, p.leg.type === 'FUT' ? INSTRUMENTS[underlying].futTick : INSTRUMENTS[underlying].optTick)}
                onCancel={() => onCancelTrail(p.leg.id)} />
            )}
            </>) : (
              <span className="text-[10px] text-zinc-500">
                <span className={isLong ? 'text-emerald-400' : 'text-rose-400'}>{isLong ? 'B' : 'S'}</span> {p.leg.type} {p.leg.strike}
              </span>
            )}

            {/* Reverse position button */}
            <button
              type="button"
              aria-label={`Reverse ${p.leg.type}${p.leg.type === 'FUT' ? '' : ` ${p.leg.strike}`}`}
              onClick={(e) => {
                e.stopPropagation();
                onReversePosition?.(p.leg);
              }}
              className="h-[18px] w-[18px] flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-zinc-700 transition-colors"
            >
              <ArrowUpDown className="w-2.5 h-2.5" />
            </button>

            {/* Lots quantity; Quick Trade adds - / + around it on an option leg */}
            {onAdjustLeg && p.leg.type !== 'FUT' && (
              <button type="button" aria-label={`Fewer lots ${p.leg.type} ${p.leg.strike}`} disabled={lots <= 1 || exitingId !== null}
                onClick={e => { e.stopPropagation(); onAdjustLeg(p.leg, -1); }}
                className="h-[18px] min-w-[18px] px-0.5 flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-[12px] font-bold leading-none disabled:opacity-35 disabled:cursor-not-allowed">−{adjustLots > 1 ? adjustLots : ''}</button>
            )}
            <span data-testid="position-lots" aria-label={`${isLong ? 'Long' : 'Short'} ${lots} lot${lots === 1 ? '' : 's'} (${Math.abs(totalUnits)} units)`} className="h-[18px] px-1.5 min-w-[26px] flex items-center justify-center tabular-nums rounded bg-zinc-800/80 text-zinc-200 border border-zinc-700 text-[10px] font-semibold">
              {lots}
            </span>
            {onAdjustLeg && p.leg.type !== 'FUT' && (
              <button type="button" aria-label={`More lots ${p.leg.type} ${p.leg.strike}`} disabled={exitingId !== null}
                onClick={e => { e.stopPropagation(); onAdjustLeg(p.leg, 1); }}
                className="h-[18px] min-w-[18px] px-0.5 flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-[12px] font-bold leading-none disabled:opacity-35 disabled:cursor-not-allowed">+{adjustLots > 1 ? adjustLots : ''}</button>
            )}

            {/* Live P&L INR (+0.00%) */}
            {/* Fixed width, right-aligned, equal-width digits: the chip is pinned at its right edge, so a P&L that changed
                length on every tick slid the - / + buttons sideways under the mouse. 24 characters fit "-1,23,456 INR (-123.45%)"; only a larger figure grows it. */}
            <span className={cn('h-[18px] px-1 min-w-[calc(24ch+8px)] flex items-center justify-end tabular-nums whitespace-nowrap text-[10px] font-semibold', pnlCls)}>
              {curPnl === null
                ? <span>— INR</span>
                : <>{curPnl >= 0 ? '+' : ''}{inrWhole(curPnl)} INR ({(curPct ?? 0) >= 0 ? '+' : ''}{(curPct ?? 0).toFixed(2)}%)</>}
            </span>

            {p.leg.sim && (
              <span className="text-[9px] font-bold text-amber-300 px-1 rounded bg-amber-500/10 border border-amber-500/20">
                SIM
              </span>
            )}

            {/* Exit button */}
            <button
              type="button"
              aria-label={`Exit ${p.leg.type} ${p.leg.strike || ''}`}
              disabled={exitingId === p.leg.id}
              onClick={(e) => {
                e.stopPropagation();
                onExitLeg(p.leg);
              }}
              className="h-[18px] w-[18px] flex items-center justify-center rounded bg-zinc-800 hover:bg-rose-600 text-zinc-400 hover:text-white border border-zinc-700 text-[10px] transition-colors disabled:opacity-50"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function useChromeStable() { return useChartChrome(); }

/** Memoised: the page re-renders on every feed push (20-40 a second); the chart only needs to when its own props change
 *  (bars, legs, orders, brackets). Every prop the page passes is a state value, a memo or a stable callback. */
export default memo(ScalperChart);
