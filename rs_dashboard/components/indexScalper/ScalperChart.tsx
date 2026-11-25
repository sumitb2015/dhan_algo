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
import { Eye, EyeOff, Settings2, X, Plus, ArrowDown, ArrowUp, ArrowUpDown, Bell, FileText, Minus } from 'lucide-react';
import { useChartChrome } from '@/lib/chartTheme';
import { computeIndicator, indicatorLabel, tailUnchanged, volumeMa, type Bar, type IndicatorInstance, pointColor, flipsAtLast, type OutSeries } from '@/lib/indexScalperIndicators';
import { bracketKind, fmtRupees, legAnchor, legPnl, type ScalperLeg } from '@/lib/indexScalperPositions';
import type { OrderRowView } from '@/lib/indexScalperAccount';
import { INSTRUMENTS, displayLotUnits, qtyUnits, type Underlying } from '@/lib/indexScalperInstrument';
import { readPref, savePref } from '@/lib/localPref';
import { cn } from '@/lib/utils';
import { fmtOI, fmtOIChange, oiBars, placeOiLabels, type OiMode, type OiProfile } from '@/lib/indexScalperOiProfile';
import { legPremiumPnl, premiumBracketsFor } from '@/lib/indexScalperPremiumBrackets';
import PremiumBracketControls from './PremiumBracketControls';
import OrderEditPopover, { type OrderEditDraft } from './OrderEditPopover';
import { isEditable } from '@/lib/indexScalperOrderEdit';
import { MAX_LOTS } from '@/lib/indexScalperPositions';

export type DrawTool = 'cursor' | 'hline' | 'trend' | 'ruler';

const IST_SHIFT = 19800;
/** Volume bar colours: the candle colours, translucent (data colours, not chrome). */
const VOL_UP = '#22c55e66';
const VOL_DOWN = '#ef444466';
/** Volume MA line (TradingView's default blue). */
const VOL_MA = '#3b82f6';
const UP = '#10b981';
const DOWN = '#ef4444';
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
  onPlaceLimitOrder?: (req: { side: 'BUY' | 'SELL'; price: number; lots: number; orderType?: 'LIMIT' | 'STOP_LOSS' }) => void;
  onOpenTicket?: (req: { price: number; lots: number; orderType: 'LIMIT' }) => void;
  onAlert?: (symbol: string, price: number) => void;
  simBrackets?: Record<string, { tp?: number; sl?: number }>;
  onSetBracket?: (req: { leg: ScalperLeg; kind: 'TP' | 'SL'; price: number }) => void;
  onCancelBracket?: (req: { legId: string; kind: 'TP' | 'SL'; orderId?: string }) => void;
  onReversePosition?: (leg: ScalperLeg) => void;
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

function ScalperChart(props: Props) {
  const {
    bars, indicators, tool, onToolDone, clearToken, logScale, pctScale, autoScale, showGrid = true, showVolume = true, volumeMaLen = 20, legs, entrySpots,
    onExitLeg, onAdjustLeg, adjustLots = 1, exitingId, onToggleIndicator, onRemoveIndicator, onEditIndicator, symbolLabel, focus,
    contractName, lots: lotsProp = 1, openOrders = [], onCancelOrder, onModifyOrder, onPlaceLimitOrder, onOpenTicket, onAlert,
    simBrackets = {}, onSetBracket, onCancelBracket, onReversePosition, underlying = 'NIFTY', feedLotSize, orderQtyMult = 1,
    premium = false, tickSize: tickProp, drawKey: drawKeyProp = DRAW_KEY, viewKey, resetSeq = 0, oiProfile = null, oiMode = 'total', viewportRef, strikeAnchor = false, premiumOrders,
  } = props;
  const drawKeyRef = useRef(drawKeyProp);
  const tickSize = tickProp ?? (underlying === 'CRUDEOILM' ? 1.0 : 0.05);
  const canBracket = useCallback((leg: ScalperLeg) => premium || leg.type === 'FUT', [premium]);
  const chrome = useChromeStable();
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const indSeriesRef = useRef<ISeriesApi<SeriesType>[]>([]);
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
  const [hoverScale, setHoverScale] = useState<{ y: number; price: number } | null>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ y: number; price: number } | null>(null);
  const [tentativeBrackets, setTentativeBrackets] = useState<Record<string, { tp?: number; sl?: number }>>({});
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
      indSeriesRef.current = []; legLines.clear();
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
            api = chart.addSeries(LineSeries, {
              // Every indicator line shows its name + last value on the price scale (Supertrend too: the label takes the
              // colour of its last point, so it reads green / red with the trend).
              color: s.color, lineWidth: thick as 1 | 2 | 3 | 4, priceLineVisible: false, lastValueVisible: true, title: s.axisLabel,
              crosshairMarkerVisible: false,
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
        ts.fitContent();
      }
    } catch { ts.fitContent(); }
  }, [viewKey, hasBars, focus]);

  // Reset scale (header button): auto-scale the price axis (undoing a hand drag / zoom) and re-frame the time axis.
  const resetDoneRef = useRef(resetSeq);
  useEffect(() => {
    const chart = chartRef.current;
    const b = barsRef.current;
    if (resetDoneRef.current === resetSeq) return;
    // Consumed even when there is no chart yet (a pane still mounting starts auto-scaled anyway): otherwise a pending
    // click would fire later on an unrelated range change and undo a zoom made since.
    resetDoneRef.current = resetSeq;
    if (!chart) return;
    chart.priceScale('right').applyOptions({ autoScale: true });
    if (b.length === 0) return;
    const ts = chart.timeScale();
    try {
      if (focus) {
        const end = b[b.length - 1].t + IST_SHIFT;
        ts.setVisibleRange({ from: (end - focus.seconds) as UTCTimestamp, to: (end + 20 * 60) as UTCTimestamp });
      } else {
        ts.fitContent();
      }
    } catch { ts.fitContent(); }
  }, [resetSeq, focus]);

  // ── position lines ────────────────────────────────────────────────
  const placed = useMemo(() => legs.map(leg => ({ leg, anchor: legAnchor(leg, entrySpots[leg.securityId], { premium, atStrike: strikeAnchor }), pnl: legPnl(leg) })), [legs, entrySpots, premium, strikeAnchor]);

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

      // Tentative / optimistic drag release values
      if (!tp && tent?.tp && tent.tp > 0) tp = { price: tent.tp, isSim: false };
      if (!sl && tent?.sl && tent.sl > 0) sl = { price: tent.sl, isSim: false };

      const isLong = p.leg.netQty > 0;
      const oppSide = isLong ? 'SELL' : 'BUY';

      for (const ord of openOrders) {
        if (ord.side !== oppSide) continue;
        // Only a closing order on THIS leg's contract is its TP / SL (matched by security id, never by symbol text):
        // a name match made an entry order beside a position read as its bracket, and dragging it re-placed the entry
        // as an exit sized to the position.
        if (!ord.securityId || ord.securityId !== p.leg.securityId) continue;

        const ot = (ord.orderType || '').toUpperCase();
        const ordPrice = ord.price ?? ord.trigger ?? 0;
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
    for (const o of openOrders) { const px = o.price ?? o.trigger; if (px && px > 0) lv.push(px); }
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
  }, [placed, activeBrackets]);

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
        setTentativeBrackets(prev => ({
          ...prev,
          [leg.id]: {
            ...prev[leg.id],
            [kind === 'TP' ? 'tp' : 'sl']: finalPrice,
          },
        }));
        onSetBracket?.({ leg, kind, price: finalPrice });
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [dragState, onSetBracket, tickSize]);

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
      const p = ord.price ?? ord.trigger;
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
        const p = ord.price ?? ord.trigger;
        if (p) {
          const y = candles.priceToCoordinate(p);
          if (y !== null) raw.push({ id: `ord_${ord.id}`, y: Number(y) });
        }
      }
      raw.sort((a, b) => a.y - b.y);
      const out: Record<string, number> = {};
      let floor = -Infinity;
      for (const r of raw) { const y = Math.max(r.y, floor + 26); out[r.id] = y; floor = y; }
      // The order lines' own y (not pushed apart like the chips): where a line can be grabbed and dragged.
      for (const ord of regularOrders) {
        const p = ord.price ?? ord.trigger;
        const y = p ? candles.priceToCoordinate(p) : null;
        if (y !== null) out[`oline_${ord.id}`] = Number(y);
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
  }, [placed, activeBrackets, regularOrders]);

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
      const bars = oiProfile ? oiBars(oiProfile, p => candles.priceToCoordinate(p), right, plotH, Math.min(260, right * 0.3), oiMode) : [];
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
  }, [menu, tickSize]);

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

  return (
    <div className="relative w-full h-full min-h-0">
      <div ref={boxRef} className={cn('absolute inset-0', tool !== 'cursor' && 'cursor-crosshair')} />
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

      {/* working order chips on chart: this page's own Limit / SL / SL-M orders can be dragged to a new price (chip or
          line) and have their lots edited; another placer's order is shown with its x only */}
      {regularOrders.map(ord => {
        const p = ord.price ?? ord.trigger;
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
                  onClick={e => { e.stopPropagation(); setOrdEdit(ordEdit?.id === ord.id ? null : { id: ord.id, lots: ordLots ?? 1, price: (ord.rawType === 'STOP_LOSS_MARKET' ? ord.trigger ?? p : ord.price ?? p).toFixed(2) }); }}
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
              <OrderEditPopover top={top + 14} ord={ord} draft={ordEdit} onDraft={setOrdEdit} maxLots={MAX_LOTS}
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
                      setTentativeBrackets(prev => {
                        if (!prev[p.leg.id]) return prev;
                        const next = { ...prev, [p.leg.id]: { ...prev[p.leg.id] } };
                        delete next[p.leg.id].tp;
                        return next;
                      });
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
                  <span>{lots} {isLong ? 'Sell' : 'Buy'} Stop Market</span>
                  <button
                    type="button"
                    title="Cancel Stop Loss"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTentativeBrackets(prev => {
                        if (!prev[p.leg.id]) return prev;
                        const next = { ...prev, [p.leg.id]: { ...prev[p.leg.id] } };
                        delete next[p.leg.id].sl;
                        return next;
                      });
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
                  {dragState.lots} {dragState.isLong ? 'Sell' : 'Buy'} Stop Market
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
            {canBracket(p.leg) ? (<>
            {/* TP draggable button */}
            <button
              type="button"
              title="Drag to set/adjust Target Profit"
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
              title="Drag to set/adjust Stop Loss"
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                startDrag('SL', p.leg, p.anchor.level, isLong, lots, totalUnits, b?.sl?.price);
              }}
              className="h-[18px] px-1.5 rounded bg-zinc-800 hover:bg-rose-600/30 text-rose-400 border border-rose-500/50 text-[10px] font-bold cursor-grab active:cursor-grabbing transition-colors"
            >
              SL
            </button>
            </>) : strikeAnchor && optOnIndex ? (
              <PremiumBracketControls leg={p.leg} units={totalUnits} tick={INSTRUMENTS[underlying].optTick}
                brackets={premiumBracketsFor(p.leg, premiumOrders ?? [], simBrackets?.[p.leg.id])}
                onSet={(kind, price) => onSetBracket?.({ leg: p.leg, kind, price })}
                onCancel={(kind, orderId) => onCancelBracket?.({ legId: p.leg.id, kind, orderId })} />
            ) : (
              <span title="Set TP / SL on this option's own chart: its levels are premiums" className="text-[10px] text-zinc-500">
                <span className={isLong ? 'text-emerald-400' : 'text-rose-400'}>{isLong ? 'B' : 'S'}</span> {p.leg.type} {p.leg.strike}
              </span>
            )}

            {/* Reverse position button */}
            <button
              type="button"
              title="Reverse position (close current and open opposite)"
              onClick={(e) => {
                e.stopPropagation();
                onReversePosition?.(p.leg);
              }}
              className="h-[18px] w-[18px] flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-zinc-700 transition-colors"
            >
              <ArrowUpDown className="w-2.5 h-2.5" />
            </button>

            {/* Lots quantity; Quick Trade adds - / + around it on an option leg */}
            {onAdjustLeg && optOnIndex && (
              <button type="button" aria-label={`Fewer lots ${p.leg.type} ${p.leg.strike}`} disabled={lots <= 1 || exitingId !== null}
                title={lots <= 1 ? 'One lot left: use Exit (x) to close the leg' : `Take ${Math.min(adjustLots, lots - 1)} lot${Math.min(adjustLots, lots - 1) === 1 ? '' : 's'} off (${isLong ? 'sell' : 'buy'} at market; one lot always stays, Exit closes the leg)`}
                onClick={e => { e.stopPropagation(); onAdjustLeg(p.leg, -1); }}
                className="h-[18px] w-[18px] flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-[12px] font-bold leading-none disabled:opacity-35 disabled:cursor-not-allowed">−</button>
            )}
            <span data-testid="position-lots" title={`${isLong ? 'Long' : 'Short'} ${lots} lot${lots === 1 ? '' : 's'} (${Math.abs(totalUnits)} units)`} className="h-[18px] px-1.5 flex items-center rounded bg-zinc-800/80 text-zinc-200 border border-zinc-700 text-[10px] font-semibold">
              {lots}
            </span>
            {onAdjustLeg && optOnIndex && (
              <button type="button" aria-label={`More lots ${p.leg.type} ${p.leg.strike}`} disabled={exitingId !== null}
                title={`Add ${adjustLots} lot${adjustLots === 1 ? '' : 's'} (${isLong ? 'buy' : 'sell'} ${adjustLots} lot${adjustLots === 1 ? '' : 's'} ${p.leg.type} ${p.leg.strike} at market)`}
                onClick={e => { e.stopPropagation(); onAdjustLeg(p.leg, 1); }}
                className="h-[18px] w-[18px] flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-[12px] font-bold leading-none disabled:opacity-35 disabled:cursor-not-allowed">+</button>
            )}

            {/* Live P&L INR (+0.00%) */}
            <span className={cn('h-[18px] px-1 flex items-center text-[10px] font-semibold', pnlCls)}>
              {curPnl === null
                ? <span title="No live premium for this option">— INR</span>
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
              title={`Exit ${p.leg.type} ${p.leg.strike || ''}`}
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
