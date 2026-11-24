'use client';

// The /index-scalper chart: lightweight-charts candles + any number of indicators (overlay or own pane), drawing tools,
// and open option positions drawn at the index level they belong to, each with qty / avg / live P&L and an Exit button.
// Market data only; every order goes through the parent's callbacks.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart, CandlestickSeries, LineSeries, HistogramSeries, ColorType, CrosshairMode, LineStyle, PriceScaleMode,
  type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp, type SeriesType, type MouseEventParams, type Time,
  type AutoscaleInfo,
} from 'lightweight-charts';
import { Eye, EyeOff, Settings2, X, Plus, ArrowDown, ArrowUp, ArrowUpDown, Bell, FileText, Minus } from 'lucide-react';
import { useChartChrome } from '@/lib/chartTheme';
import { computeIndicator, indicatorLabel, tailUnchanged, type Bar, type IndicatorInstance, pointColor, flipsAtLast, type OutSeries } from '@/lib/indexScalperIndicators';
import { bracketKind, fmtRupees, legAnchor, legPnl, type ScalperLeg } from '@/lib/indexScalperPositions';
import type { OrderRowView } from '@/lib/indexScalperAccount';
import { displayLotUnits, qtyUnits, type Underlying } from '@/lib/indexScalperInstrument';
import { readPref, savePref } from '@/lib/localPref';
import { cn } from '@/lib/utils';

export type DrawTool = 'cursor' | 'hline' | 'trend' | 'ruler';

const IST_SHIFT = 19800;
const UP = '#10b981';
const DOWN = '#ef4444';
const DRAW_KEY = 'indexScalper.drawings.v1';

interface TrendRec { t1: number; p1: number; t2: number; p2: number }
interface Drawings { h: number[]; t: TrendRec[] }

function loadDrawings(): Drawings {
  try {
    const raw = readPref(DRAW_KEY);
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
  pctScale: boolean;
  autoScale: boolean;
  legs: ScalperLeg[];
  /** Index level each leg was opened at from this page (security id -> spot). */
  entrySpots: Record<string, number>;
  onExitLeg: (leg: ScalperLeg) => void;
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
const inrWhole = (n: number) => Math.round(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });

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
    bars, indicators, tool, onToolDone, clearToken, logScale, pctScale, autoScale, legs, entrySpots,
    onExitLeg, exitingId, onToggleIndicator, onRemoveIndicator, onEditIndicator, symbolLabel, focus,
    contractName, lots: lotsProp = 1, openOrders = [], onCancelOrder, onPlaceLimitOrder, onOpenTicket, onAlert,
    simBrackets = {}, onSetBracket, onCancelBracket, onReversePosition, underlying = 'NIFTY', feedLotSize, orderQtyMult = 1,
  } = props;
  const chrome = useChromeStable();
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const indSeriesRef = useRef<ISeriesApi<SeriesType>[]>([]);
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
  const [hoverScale, setHoverScale] = useState<{ y: number; price: number } | null>(null);
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
    chartRef.current = chart;
    candleRef.current = candles;

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
        savePref(DRAW_KEY, JSON.stringify(drawingsRef.current));
        paintDrawings();
        toolDone();
        return;
      }
      const pend = pendingRef.current;
      if (!pend) { pendingRef.current = { time, price }; setRuler(t === 'ruler' ? 'Click the second point' : null); return; }
      pendingRef.current = null;
      if (t === 'trend') {
        drawingsRef.current.t.push({ t1: pend.time, p1: pend.price, t2: time, p2: price });
        savePref(DRAW_KEY, JSON.stringify(drawingsRef.current));
        paintDrawings();
      } else {
        const diff = price - pend.price;
        const pct = pend.price ? (diff / pend.price) * 100 : 0;
        const bs = barsRef.current.filter(b => b.t + IST_SHIFT >= Math.min(pend.time, time) && b.t + IST_SHIFT <= Math.max(pend.time, time)).length;
        setRuler(`${diff >= 0 ? '+' : ''}${diff.toFixed(2)} pts (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%) · ${bs} bars`);
      }
      toolDone();
    });

    drawingsRef.current = loadDrawings();
    paintDrawings();

    return () => {
      chart.remove();
      chartRef.current = null; candleRef.current = null;
      indSeriesRef.current = []; legLines.clear();
      for (const [, l] of bracketLinesRef.current) { try { candles.removePriceLine(l); } catch { /* gone */ } }
      bracketLinesRef.current.clear();
      if (dragPriceLineRef.current) {
        try { candles.removePriceLine(dragPriceLineRef.current); } catch { /* gone */ }
        dragPriceLineRef.current = null;
      }
      drawLinesRef.current = []; drawSeriesRef.current = [];
      sigRef.current = ''; prevRef.current = null;
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
    savePref(DRAW_KEY, JSON.stringify(drawingsRef.current));
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
    const sig = JSON.stringify([chrome.baseline, indicators.filter(i => i.visible).map(i => [i.id, i.kind, i.params, i.color])]);
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

    if (tail) {
      try {
        candles.update({ time: toTime(lastBar.t), open: lastBar.o, high: lastBar.h, low: lastBar.l, close: lastBar.c });
        let k = 0;
        for (const { out } of outputs) {
          for (const s of out.series) {
            const api = indSeriesRef.current[k++];
            if (!api) continue;
            if (recolor && s.colors && s.style === 'line') { api.setData(seriesData(s, bars) as never); continue; }
            const v = s.values[s.values.length - 1];
            if (v === null) continue;
            const color = pointColor(s, s.values.length - 1);
            api.update((color ? { time: toTime(lastBar.t), value: v, color } : { time: toTime(lastBar.t), value: v }) as never);
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
      for (let i = chart.panes().length - 1; i > 0; i--) { try { chart.removePane(i); } catch { /* gone */ } }
      let pane = 0;
      for (const { out } of outputs) {
        const paneIdx = out.pane === 'sub' ? ++pane : 0;
        for (const s of out.series) {
          let api: ISeriesApi<SeriesType>;
          if (s.style === 'histogram') {
            api = chart.addSeries(HistogramSeries, { color: s.color, priceLineVisible: false, lastValueVisible: false, title: '' }, paneIdx);
          } else {
            const thick = s.colors ? 3 : 2;
            api = chart.addSeries(LineSeries, {
              // Every indicator line shows its name + last value on the price scale (Supertrend too: the label takes the
              // colour of its last point, so it reads green / red with the trend).
              color: s.color, lineWidth: (paneIdx === 0 ? thick : 1) as 1 | 2 | 3, priceLineVisible: false, lastValueVisible: true, title: s.axisLabel,
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

  // ── position lines ────────────────────────────────────────────────
  const placed = useMemo(() => legs.map(leg => ({ leg, anchor: legAnchor(leg, entrySpots[leg.securityId]), pnl: legPnl(leg) })), [legs, entrySpots]);

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
        const sName = (p.leg.symbol || '').toUpperCase();
        const oName = (ord.symbol || '').toUpperCase();
        const isCrudeMatch = underlying === 'CRUDEOILM' && (
          p.leg.type === 'FUT' || oName.includes('CRUDE') || sName.includes('CRUDE')
        );
        const isNiftyMatch = underlying === 'NIFTY' && (
          (p.leg.type === 'FUT' && (oName.includes('FUT') || oName.includes('NIFTY'))) ||
          (p.leg.strike > 0 && oName.includes(String(p.leg.strike)))
        );
        const matchesLeg = isCrudeMatch || isNiftyMatch || (sName && (oName.includes(sName) || sName.includes(oName)));
        if (!matchesLeg) continue;

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
  }, [placed, simBrackets, tentativeBrackets, openOrders, underlying]);

  // Autoscale levels: positions, TP / SL and working orders (the drag line is left out so the scale does not chase the
  // mouse). Changing them re-fits the price scale.
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
    chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
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
  const tickSize = underlying === 'CRUDEOILM' ? 1.0 : 0.05;

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

  useEffect(() => {
    const candles = candleRef.current;
    if (!candles) return;
    const lines = orderLinesRef.current;
    const seen = new Set<string>();
    for (const ord of regularOrders) {
      const p = ord.price ?? ord.trigger;
      if (!p) continue;
      seen.add(ord.id);
      const matchedPos = placed.find(pos => {
        const sName = (pos.leg.symbol || '').toUpperCase();
        const oName = (ord.symbol || '').toUpperCase();
        return (underlying === 'CRUDEOILM' && (oName.includes('CRUDE') || sName.includes('CRUDE'))) ||
          (underlying === 'NIFTY' && (oName.includes('NIFTY') || sName.includes('NIFTY')));
      });
      let color = ord.side === 'BUY' ? '#0ea5e9' : '#f43f5e';
      let title = `${ord.qty ?? ''} ${ord.side} ${ord.orderType}`;
      if (matchedPos && matchedPos.anchor.level > 0 && ord.side === (matchedPos.leg.netQty > 0 ? 'SELL' : 'BUY')) {
        const isLong = matchedPos.leg.netQty > 0;
        if (bracketKind(ord.orderType || '', p, matchedPos.anchor.level, isLong) === 'TP') {
          color = '#10b981'; // Green for TP
          title = 'TP';
        } else {
          color = '#ef4444'; // Red for SL
          title = 'SL';
        }
      }
      const opts = { price: p, color, lineWidth: 1 as const, lineStyle: LineStyle.Solid, axisLabelVisible: true, title };
      const ex = lines.get(ord.id);
      if (ex) ex.applyOptions(opts); else lines.set(ord.id, candles.createPriceLine(opts));
    }
    for (const [id, l] of lines) if (!seen.has(id)) { try { candles.removePriceLine(l); } catch { /* gone */ } lines.delete(id); }
  }, [regularOrders, placed, underlying]);

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
          const tick = underlying === 'CRUDEOILM' ? 1 : 0.05;
          const snapped = Math.round(rawPrice / tick) * tick;
          setHoverScale({ y, price: Number(snapped.toFixed(2)) });
          return;
        }
      }
      if (!menu) setHoverScale(null);
    };
    const onLeave = () => {
      if (!menu) setHoverScale(null);
    };
    box.addEventListener('mousemove', onMove);
    box.addEventListener('mouseleave', onLeave);
    return () => {
      box.removeEventListener('mousemove', onMove);
      box.removeEventListener('mouseleave', onLeave);
    };
  }, [menu, underlying]);

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
        savePref(DRAW_KEY, JSON.stringify(drawingsRef.current));
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
              savePref(DRAW_KEY, JSON.stringify(drawingsRef.current));
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

      {/* working order chips on chart */}
      {regularOrders.map(ord => {
        const p = ord.price ?? ord.trigger;
        if (!p) return null;
        const top = chipTops[`ord_${ord.id}`];
        if (top === undefined) return null;
        const isBuy = ord.side === 'BUY';

        const matchedPos = placed.find(pos => pos.anchor.level > 0 && ord.side === (pos.leg.netQty > 0 ? 'SELL' : 'BUY'))
          ?? placed.find(pos => {
            const sName = (pos.leg.symbol || '').toUpperCase();
            const oName = (ord.symbol || '').toUpperCase();
            return (underlying === 'CRUDEOILM' && (oName.includes('CRUDE') || sName.includes('CRUDE') || pos.leg.type === 'FUT')) ||
              (underlying === 'NIFTY' && (oName.includes('NIFTY') || sName.includes('NIFTY') || pos.leg.type === 'FUT'));
          })
          ?? placed[0];

        if (matchedPos && matchedPos.anchor.level > 0) {
          const isLong = matchedPos.leg.netQty > 0;
          // Order qty is in the broker's own unit (Dhan MCX: lots; Kotak / NSE: units): orderQtyMult converts it.
          const lotSize = displayLotUnits(underlying, feedLotSize);
          const totalUnits = ord.qty ? qtyUnits(ord.qty, orderQtyMult) : lotSize;
          const lots = Math.max(1, Math.round(totalUnits / lotSize));
          const ptDiff = isLong ? (p - matchedPos.anchor.level) : (matchedPos.anchor.level - p);
          const pct = (ptDiff / matchedPos.anchor.level) * 100;
          const pnl = ptDiff * totalUnits;
          const kind = bracketKind(ord.orderType || '', p, matchedPos.anchor.level, isLong);
          const isTp = kind === 'TP';

          return (
            <div
              key={ord.id}
              data-testid="order-chip"
              style={{ top: top - 11 }}
              className="absolute right-[84px] z-[55] flex items-center shadow-lg font-mono text-[11px]"
            >
              <div
                title={`Click and drag to move ${kind} to a new price`}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  startDrag(kind, matchedPos.leg, matchedPos.anchor.level, isLong, lots, totalUnits, p);
                }}
                className={cn('h-[22px] px-2 rounded-l flex items-center font-bold select-none border cursor-grab active:cursor-grabbing hover:brightness-110 transition-colors',
                  isTp ? 'bg-emerald-950/90 border-emerald-500/80 text-emerald-400' : 'bg-rose-950/90 border-rose-500/80 text-rose-400')}
              >
                {isTp ? 'TP' : 'SL'} {pnl >= 0 ? '+' : ''}{inrWhole(pnl)} ({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)
              </div>
              <div
                title={`Click and drag to move ${kind} to a new price`}
                onMouseDown={(e) => {
                  if ((e.target as HTMLElement).tagName.toLowerCase() === 'button') return;
                  e.stopPropagation();
                  e.preventDefault();
                  startDrag(kind, matchedPos.leg, matchedPos.anchor.level, isLong, lots, totalUnits, p);
                }}
                className={cn('h-[22px] px-2 rounded-r flex items-center gap-1.5 bg-zinc-900 border border-l-0 text-zinc-200 cursor-grab active:cursor-grabbing select-none hover:brightness-110 transition-colors',
                  isTp ? 'border-emerald-500/60' : 'border-rose-500/60')}
              >
                <span>{lots} {isLong ? 'Sell' : 'Buy'} {isTp ? 'Limit' : 'Stop Market'}</span>
                {ord.cancellable && (
                  <button
                    type="button"
                    aria-label={`Cancel order ${ord.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCancelOrder?.(ord.id);
                    }}
                    className="h-[16px] w-[16px] rounded flex items-center justify-center text-zinc-400 hover:text-white hover:bg-rose-600 transition-colors cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          );
        }

        return (
          <div key={ord.id} data-testid="order-chip" style={{ top: top - 11 }}
            className={cn('absolute right-[84px] z-[55] flex items-center gap-1.5 pl-2 pr-1 h-[22px] rounded border text-[11px] font-mono bg-zinc-900 shadow',
              isBuy ? 'border-sky-500/60' : 'border-rose-500/60')}>
            <span className={cn('font-bold', isBuy ? 'text-sky-400' : 'text-rose-400')}>{ord.side}</span>
            <span className="text-zinc-200">{ord.qty}</span>
            <span className="text-zinc-400">{ord.orderType}</span>
            <span className="text-zinc-300 font-semibold">@ {fmt(p)}</span>
            {ord.cancellable && (
              <button type="button" aria-label={`Cancel order ${ord.id}`} onClick={() => onCancelOrder?.(ord.id)}
                className="ml-1 h-[18px] px-1 rounded bg-zinc-800 hover:bg-rose-600 text-zinc-400 hover:text-white text-[10px] font-bold transition-colors">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
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

        const curSpot = (last?.c && last.c > 0) ? last.c : p.anchor.level;
        const curPtDiff = isLong ? (curSpot - p.anchor.level) : (p.anchor.level - curSpot);
        const curPct = p.anchor.level > 0 ? (curPtDiff / p.anchor.level) * 100 : 0;
        const curPnl = p.pnl !== null ? p.pnl : (curPtDiff * totalUnits);
        const pnlCls = curPnl >= 0 ? 'text-emerald-400' : 'text-rose-400';

        const b = activeBrackets[p.leg.id];

        return (
          <div
            key={p.leg.id}
            data-testid="position-chip"
            style={{ top: top - 11 }}
            className="absolute right-[84px] z-[55] flex items-center gap-1.5 px-1.5 h-[24px] rounded border border-sky-500/70 bg-zinc-900 shadow-md font-mono text-[11px]"
          >
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

            {/* Lots quantity */}
            <span className="h-[18px] px-1.5 flex items-center rounded bg-zinc-800/80 text-zinc-200 border border-zinc-700 text-[10px] font-semibold">
              {lots}
            </span>

            {/* Live P&L INR (+0.00%) */}
            <span className={cn('h-[18px] px-1 flex items-center text-[10px] font-semibold', pnlCls)}>
              {curPnl >= 0 ? '+' : ''}{inrWhole(curPnl)} INR ({curPct >= 0 ? '+' : ''}{curPct.toFixed(2)}%)
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
