'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useChartChrome } from '@/lib/chartTheme';
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  LineSeries,
  ColorType,
  LineStyle,
  CrosshairMode,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ChartCandle, ChartIndicatorSeries } from '@/lib/optionsChartTypes';

const IST_TIME_ZONE = 'Asia/Kolkata';

// The chart is sized by a ResizeObserver on the first frame; this is only the pre-measure height.
const INITIAL_HEIGHT = 400;

// Gridline / axis / tick colours live in lib/chartTheme.ts because they flip with the
// theme. STATUS and CATEGORICAL stay here: they're saturated data colours that read on
// either ground, so they aren't themed.
const STATUS = { good: '#34d399', critical: '#f87171' };
const CATEGORICAL = ['#38bdf8', '#fbbf24', '#a78bfa', '#f472b6', '#4ade80', '#fb923c'];

export type CombinedChartType = 'candlestick' | 'line';

const MAIN_KEY = '__main';
const LEFT_AXIS_KEY = '__left';

type CrosshairState = {
  x: number; y: number; time: string; isLine: boolean; open: number; high: number; low: number; close: number;
  indicators: { label: string; color: string; value: number }[];
  extraRows: { label: string; value: string }[];
};

/** ISO -> epoch-seconds, memoised. The same ~750 timestamps recur on every 10s poll and across
 * every series in the payload, so parsing them once per distinct string turns thousands of
 * `new Date()` calls per poll into a handful. Bounded so a long session can't grow it without
 * limit (a full trading day at 1m across a few symbols is well under the cap). */
const UNIX_CACHE_LIMIT = 20_000;
const unixByIso = new Map<string, UTCTimestamp>();

function toUnixSeconds(iso: string): UTCTimestamp {
  const cached = unixByIso.get(iso);
  if (cached !== undefined) return cached;
  const value = Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;
  if (unixByIso.size >= UNIX_CACHE_LIMIT) unixByIso.clear();
  unixByIso.set(iso, value);
  return value;
}

type TimedPoint = { time: UTCTimestamp };

/** Every numeric field of two bars matches. Bars carry only `time` plus numbers (OHLC, or
 * `value`), so comparing the numeric keys compares the whole bar. */
function sameBar(a: TimedPoint, b: TimedPoint): boolean {
  const av = a as unknown as Record<string, number>;
  const bv = b as unknown as Record<string, number>;
  for (const key of Object.keys(av)) {
    if (typeof av[key] === 'number' && av[key] !== bv[key]) return false;
  }
  return true;
}

/** True when `next` is `prev` with only its trailing bars changed/appended - the steady-state
 * shape of an intraday poll, where all that moved is the still-forming last candle. Probes the
 * first bar and the second-to-last bar rather than the whole array; any mismatch just falls back
 * to a full setData(), so correctness never rests on the heuristic.
 *
 * The probes compare values, not just timestamps: a lots change (Strategy panel, which
 * deliberately doesn't remount on it) rescales every bar in place while the times stay
 * identical, and a time-only probe would leave the whole prefix drawn at the old scale. */
function isTailUpdate(prev: TimedPoint[] | undefined, next: TimedPoint[]): prev is TimedPoint[] {
  return (
    !!prev &&
    prev.length > 1 &&
    next.length >= prev.length &&
    prev[0].time === next[0].time &&
    prev[prev.length - 2].time === next[prev.length - 2].time &&
    sameBar(prev[0], next[0]) &&
    sameBar(prev[prev.length - 2], next[prev.length - 2]) &&
    advancesFrom(prev[prev.length - 1].time, next, prev.length - 1)
  );
}

/** Every bar from `start` onward is at or after the bar before it, starting from `lastDrawn`.
 * update() rejects a bar older than the series' last one ("Cannot update oldest data") and
 * throws rather than returning false, so the tail has to be proven monotonic before it is
 * walked - two probe points can't do that on their own. Only the tail is scanned, which is a
 * single bar on an ordinary poll. */
function advancesFrom(lastDrawn: UTCTimestamp, next: TimedPoint[], start: number): boolean {
  let previous = lastDrawn;
  for (let i = start; i < next.length; i++) {
    if (next[i].time < previous) return false;
    previous = next[i].time;
  }
  return true;
}

function formatIstTick(time: Time, tickMarkType: TickMarkType): string {
  const date = new Date((time as number) * 1000);
  switch (tickMarkType) {
    case TickMarkType.Year:
      return new Intl.DateTimeFormat('en-IN', { year: 'numeric', timeZone: IST_TIME_ZONE }).format(date);
    case TickMarkType.Month:
      return new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: IST_TIME_ZONE }).format(date);
    case TickMarkType.DayOfMonth:
      return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: IST_TIME_ZONE }).format(date);
    default:
      return new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: IST_TIME_ZONE }).format(date);
  }
}

function lineStyleFor(type: string, id: string): LineStyle {
  if (type === 'bbands') return id.endsWith('_mid') ? LineStyle.Solid : LineStyle.Dashed;
  if (type === 'vwap') return LineStyle.Dotted;
  return LineStyle.Solid;
}

/** Shared renderer behind StraddleChart/StrangleChart/RollingStraddleChart/StrategyChart - all
 * combine a set of options legs into one synthetic OHLC series server-side and only differ in
 * how they label the legend, so the chart drawing lives here once. Ported from
 * dhanHQ_skills/dashboard/frontend/src/components/CombinedPremiumChart.tsx, with the
 * theme-aware color system swapped for this dashboard's fixed dark palette. */
export function CombinedPremiumChart({
  candles,
  indicators,
  legendLabel,
  seriesTitle = legendLabel,
  chartType,
  markers,
  extraTooltipRows,
  valueLabel = 'Value',
  colorScheme,
  leftAxisLine,
}: {
  candles: ChartCandle[];
  indicators: ChartIndicatorSeries[];
  legendLabel: string;
  seriesTitle?: string;
  chartType: CombinedChartType;
  markers?: { time: string; color: string; size?: number }[];
  extraTooltipRows?: (time: string) => { label: string; value: string }[];
  valueLabel?: string;
  colorScheme?: {
    lineColor?: string;
    lineWidth?: 1 | 2 | 3 | 4;
    upColor?: string;
    downColor?: string;
    indicatorColors?: Record<string, string>;
  };
  leftAxisLine?: {
    label: string;
    color: string;
    values: { time: string; value: number }[];
  };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<IChartApi | null>(null);
  const mainSeriesRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | null>(null);
  const mainSeriesTypeRef = useRef<CombinedChartType | null>(null);
  const lineSeriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const leftAxisSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const markersApiRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const hasFitRef = useRef(false);
  const groupOrderRef = useRef<string[]>([]);
  const chartTypeRef = useRef(chartType);
  chartTypeRef.current = chartType;
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const extraTooltipRowsRef = useRef(extraTooltipRows);
  extraTooltipRowsRef.current = extraTooltipRows;
  const colorSchemeRef = useRef(colorScheme);
  colorSchemeRef.current = colorScheme;
  const isoTimeByUnixRef = useRef<Map<number, string>>(new Map());
  // Last array pushed into each series, keyed MAIN_KEY / LEFT_AXIS_KEY / indicator id - lets a
  // poll that only extended the tail skip a whole-series setData().
  const drawnRef = useRef<Map<string, TimedPoint[]>>(new Map());
  const legendKeyRef = useRef('');
  const crosshairFrameRef = useRef<number | null>(null);
  const pendingCrosshairRef = useRef<CrosshairState | null>(null);

  const [crosshair, setCrosshair] = useState<CrosshairState | null>(null);
  const [legend, setLegend] = useState<{ id: string; label: string; color: string; lastValue: number | null }[]>([]);
  const [lastPrice, setLastPrice] = useState<number | null>(null);

  const chrome = useChartChrome();

  const createMainSeries = useCallback(
    (type: CombinedChartType) => {
      const chartApi = chartApiRef.current;
      if (!chartApi) return;
      if (mainSeriesTypeRef.current === type && mainSeriesRef.current) return;
      if (mainSeriesRef.current) chartApi.removeSeries(mainSeriesRef.current);
      markersApiRef.current = null;
      // The old series (and its cached data) is gone - the replacement must take a full setData().
      drawnRef.current.delete(MAIN_KEY);
      mainSeriesRef.current =
        type === 'candlestick'
          ? chartApi.addSeries(CandlestickSeries, {
              upColor: colorSchemeRef.current?.upColor ?? STATUS.good,
              downColor: colorSchemeRef.current?.downColor ?? STATUS.critical,
              borderUpColor: colorSchemeRef.current?.upColor ?? STATUS.good,
              borderDownColor: colorSchemeRef.current?.downColor ?? STATUS.critical,
              wickUpColor: colorSchemeRef.current?.upColor ?? STATUS.good,
              wickDownColor: colorSchemeRef.current?.downColor ?? STATUS.critical,
            })
          : chartApi.addSeries(LineSeries, {
              color: colorSchemeRef.current?.lineColor ?? STATUS.good,
              lineWidth: colorSchemeRef.current?.lineWidth ?? 2,
              title: seriesTitle,
              lastValueVisible: true,
              priceLineVisible: true,
            });
      mainSeriesTypeRef.current = type;
    },
    [seriesTitle]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chartInstance = createChart(container, {
      height: INITIAL_HEIGHT,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: chrome.textSecondary,
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: chrome.gridline, style: LineStyle.Dotted },
        horzLines: { color: chrome.gridline, style: LineStyle.Dotted },
      },
      rightPriceScale: { borderColor: chrome.baseline },
      leftPriceScale: { visible: !!leftAxisLine, borderColor: chrome.baseline },
      timeScale: {
        borderColor: chrome.baseline,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: formatIstTick,
        fixLeftEdge: true,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: chrome.baseline, labelBackgroundColor: chrome.textMuted },
        horzLine: { color: chrome.baseline, labelBackgroundColor: chrome.textMuted },
      },
      localization: { timeFormatter: (time: Time) => formatIstTick(time, TickMarkType.Time) },
    });
    chartApiRef.current = chartInstance;
    mainSeriesTypeRef.current = null;
    createMainSeries(chartTypeRef.current);

    // Pointer moves fire far faster than the browser paints, so the computed payload is parked in
    // a ref and flushed once per animation frame - one React commit per frame instead of one per
    // mouse event (which, with two panels mounted, was the main source of tooltip stutter).
    const flushCrosshair = (next: CrosshairState | null) => {
      pendingCrosshairRef.current = next;
      if (crosshairFrameRef.current !== null) return;
      crosshairFrameRef.current = requestAnimationFrame(() => {
        crosshairFrameRef.current = null;
        const value = pendingCrosshairRef.current;
        // Off-chart moves repeat `null` endlessly; only write when it's a real transition.
        setCrosshair((prev) => (prev === null && value === null ? prev : value));
      });
    };

    chartInstance.subscribeCrosshairMove((param) => {
      const mainSeries = mainSeriesRef.current;
      if (!param.time || !param.point || !mainSeries) {
        flushCrosshair(null);
        return;
      }
      const isLine = chartTypeRef.current === 'line';
      const point = param.seriesData.get(mainSeries) as
        | { open: number; high: number; low: number; close: number }
        | { value: number }
        | undefined;
      if (!point) {
        flushCrosshair(null);
        return;
      }
      const ohlc = isLine
        ? { open: (point as { value: number }).value, high: (point as { value: number }).value, low: (point as { value: number }).value, close: (point as { value: number }).value }
        : (point as { open: number; high: number; low: number; close: number });

      const indicatorValues: { label: string; color: string; value: number }[] = [];
      for (const [id, series] of lineSeriesRef.current) {
        const p = param.seriesData.get(series) as { value: number } | undefined;
        if (p === undefined) continue;
        indicatorValues.push({ label: (series.options().title as string) ?? id, color: series.options().color as string, value: p.value });
      }
      const isoTime = isoTimeByUnixRef.current.get(param.time as number);
      const extraRows = isoTime ? (extraTooltipRowsRef.current?.(isoTime) ?? []) : [];

      flushCrosshair({
        x: param.point.x,
        y: param.point.y,
        time: new Date((param.time as number) * 1000).toLocaleString('en-IN', {
          day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: IST_TIME_ZONE,
        }),
        isLine,
        open: ohlc.open, high: ohlc.high, low: ohlc.low, close: ohlc.close,
        indicators: indicatorValues,
        extraRows,
      });
    });

    hasFitRef.current = false;
    groupOrderRef.current = [];
    drawnRef.current = new Map();
    legendKeyRef.current = '';

    const resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) chartInstance.applyOptions({ width, height });
    });
    resizeObserver.observe(container);

    return () => {
      if (crosshairFrameRef.current !== null) cancelAnimationFrame(crosshairFrameRef.current);
      crosshairFrameRef.current = null;
      pendingCrosshairRef.current = null;
      resizeObserver.disconnect();
      chartInstance.remove();
      chartApiRef.current = null;
      mainSeriesRef.current = null;
      mainSeriesTypeRef.current = null;
      lineSeriesRef.current = new Map();
      leftAxisSeriesRef.current = null;
      markersApiRef.current = null;
      drawnRef.current = new Map();
      isoTimeByUnixRef.current = new Map();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!chartApiRef.current) return;
    createMainSeries(chartType);
    drawChart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartType]);

  useEffect(() => {
    const chartApi = chartApiRef.current;
    if (!chartApi) return;
    chartApi.applyOptions({ leftPriceScale: { visible: !!leftAxisLine, borderColor: chrome.baseline } });
  }, [leftAxisLine, chrome]);

  // Re-apply canvas chrome whenever the theme flips.
  useEffect(() => {
    const chartApi = chartApiRef.current;
    if (!chartApi) return;
    chartApi.applyOptions({
      layout: { textColor: chrome.textSecondary },
      grid: { vertLines: { color: chrome.gridline, style: LineStyle.Dotted }, horzLines: { color: chrome.gridline, style: LineStyle.Dotted } },
      rightPriceScale: { borderColor: chrome.baseline },
      timeScale: { borderColor: chrome.baseline },
      crosshair: {
        vertLine: { color: chrome.baseline, labelBackgroundColor: chrome.textMuted },
        horzLine: { color: chrome.baseline, labelBackgroundColor: chrome.textMuted },
      },
    });
  }, [chrome]);

  /** Pushes `next` into `series`, using per-bar update() when the array only grew at the tail
   * (the ordinary 10s poll) and a full setData() otherwise (interval/strike/expiry switch, or a
   * gap). Keeps the drawn copy so the next call can make the same comparison. */
  function applySeriesData<T extends TimedPoint>(series: ISeriesApi<never>, key: string, next: T[]) {
    const prev = drawnRef.current.get(key);
    const target = series as unknown as { setData: (d: T[]) => void; update: (d: T) => void };
    if (isTailUpdate(prev, next)) {
      // Everything before the last drawn bar is already on the chart and cannot have changed.
      try {
        for (let i = prev.length - 1; i < next.length; i++) target.update(next[i]);
      } catch {
        // Belt-and-braces: update() throws on anything it won't accept, which would surface as
        // a runtime error overlay and take the whole page down. A full redraw always works.
        target.setData(next);
      }
    } else {
      target.setData(next);
    }
    drawnRef.current.set(key, next);
  }

  function drawChart() {
    const chartApi = chartApiRef.current;
    const mainSeries = mainSeriesRef.current;
    if (!chartApi || !mainSeries) return;

    const mainData: TimedPoint[] =
      chartTypeRef.current === 'candlestick'
        ? candles.map((c) => ({ time: toUnixSeconds(c.time), open: c.open, high: c.high, low: c.low, close: c.close }))
        : candles.map((c) => ({ time: toUnixSeconds(c.time), value: c.close }));
    const prevMain = drawnRef.current.get(MAIN_KEY);
    const mainWasTailUpdate = isTailUpdate(prevMain, mainData);
    const firstNewBar = mainWasTailUpdate ? prevMain!.length - 1 : 0;
    applySeriesData(mainSeries as ISeriesApi<never>, MAIN_KEY, mainData);

    // On a tail update the prefix is unchanged, so only the redrawn bars need a lookup entry.
    if (!mainWasTailUpdate) isoTimeByUnixRef.current = new Map();
    for (let i = firstNewBar; i < candles.length; i++) {
      isoTimeByUnixRef.current.set(toUnixSeconds(candles[i].time), candles[i].time);
    }

    if (!markersApiRef.current) {
      markersApiRef.current = createSeriesMarkers(mainSeries, []);
    }
    markersApiRef.current.setMarkers(
      (markersRef.current ?? []).map((m) => ({
        time: toUnixSeconds(m.time),
        position: 'inBar' as const,
        shape: 'circle' as const,
        color: m.color,
        size: m.size ?? 1,
      }))
    );

    if (leftAxisLine) {
      if (!leftAxisSeriesRef.current) {
        leftAxisSeriesRef.current = chartApi.addSeries(LineSeries, {
          priceScaleId: 'left',
          color: leftAxisLine.color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: leftAxisLine.label,
          lastValueVisible: true,
          priceLineVisible: false,
        });
      } else {
        leftAxisSeriesRef.current.applyOptions({ color: leftAxisLine.color, title: leftAxisLine.label });
      }
      applySeriesData(
        leftAxisSeriesRef.current as ISeriesApi<never>,
        LEFT_AXIS_KEY,
        leftAxisLine.values.map((p) => ({ time: toUnixSeconds(p.time), value: p.value }))
      );
    } else if (leftAxisSeriesRef.current) {
      chartApi.removeSeries(leftAxisSeriesRef.current);
      leftAxisSeriesRef.current = null;
      drawnRef.current.delete(LEFT_AXIS_KEY);
    }

    const colorFor = (group: string) => {
      const override = colorSchemeRef.current?.indicatorColors?.[group];
      if (override) return override;
      if (!groupOrderRef.current.includes(group)) groupOrderRef.current.push(group);
      return CATEGORICAL[groupOrderRef.current.indexOf(group) % CATEGORICAL.length];
    };

    const seenIds = new Set(indicators.map((ind) => ind.id));
    for (const [id, series] of lineSeriesRef.current) {
      if (!seenIds.has(id)) {
        chartApi.removeSeries(series);
        lineSeriesRef.current.delete(id);
        drawnRef.current.delete(id);
      }
    }
    for (const ind of indicators) {
      let series = lineSeriesRef.current.get(ind.id);
      if (!series) {
        series = chartApi.addSeries(LineSeries, {
          color: colorFor(ind.group),
          lineWidth: 1,
          lineStyle: lineStyleFor(ind.type, ind.id),
          title: ind.label,
          lastValueVisible: false,
          priceLineVisible: false,
        });
        lineSeriesRef.current.set(ind.id, series);
        drawnRef.current.delete(ind.id);
      }
      applySeriesData(
        series as ISeriesApi<never>,
        ind.id,
        ind.series.map((p) => ({ time: toUnixSeconds(p.time), value: p.value }))
      );
    }

    // The legend re-renders the whole component, so only publish it when it actually differs -
    // otherwise every poll committed an identical array.
    const nextLegend = indicators.map((ind) => ({ id: ind.id, label: ind.label, color: colorFor(ind.group), lastValue: ind.last_value }));
    const nextLegendKey = nextLegend.map((l) => `${l.id}|${l.label}|${l.color}|${l.lastValue}`).join(';');
    if (nextLegendKey !== legendKeyRef.current) {
      legendKeyRef.current = nextLegendKey;
      setLegend(nextLegend);
    }
    const last = candles[candles.length - 1];
    setLastPrice(last ? last.close : null);

    if (candles.length && !hasFitRef.current) {
      chartApi.timeScale().fitContent();
      hasFitRef.current = true;
    }
  }

  function resetView() {
    chartApiRef.current?.timeScale().fitContent();
  }

  useEffect(() => {
    drawChart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, indicators, markers, leftAxisLine]);

  return (
    <div className="flex flex-col gap-2 h-full min-h-0">
      <div className="flex flex-wrap items-center gap-4 text-xs flex-shrink-0 text-zinc-300">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5" style={{ background: colorScheme?.lineColor ?? STATUS.good }} />
          {legendLabel}
        </span>
        {lastPrice !== null && <span className="tabular-nums font-semibold text-zinc-100">{lastPrice.toFixed(2)}</span>}
        {legend.map((item) => (
          <span key={item.id} className="flex items-center gap-1.5 tabular-nums">
            <span className="inline-block w-3 h-0.5" style={{ background: item.color }} />
            <span>{item.label}</span>
            {item.lastValue !== null && <span className="text-zinc-500">{item.lastValue.toFixed(2)}</span>}
          </span>
        ))}
      </div>
      <div className="relative flex-1 min-h-0">
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        {crosshair && (
          <div
            className="absolute pointer-events-none rounded px-2.5 py-1.5 text-xs tabular-nums shadow-lg z-10 bg-zinc-900 border border-zinc-700 text-zinc-100"
            style={{
              left: Math.min(crosshair.x + 12, (containerRef.current?.clientWidth ?? 0) - 190),
              top: 8,
              minWidth: 170,
            }}
          >
            <div className="text-zinc-500 mb-1">{crosshair.time}</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
              {crosshair.isLine ? (
                <>
                  <span className="text-zinc-500">{valueLabel}</span>
                  <span>{crosshair.close.toFixed(2)}</span>
                </>
              ) : (
                <>
                  <span className="text-zinc-500">O</span>
                  <span>{crosshair.open.toFixed(2)}</span>
                  <span className="text-zinc-500">H</span>
                  <span>{crosshair.high.toFixed(2)}</span>
                  <span className="text-zinc-500">L</span>
                  <span>{crosshair.low.toFixed(2)}</span>
                  <span className="text-zinc-500">C</span>
                  <span>{crosshair.close.toFixed(2)}</span>
                </>
              )}
              {crosshair.extraRows.map((row, i) => (
                <Fragment key={i}>
                  <span className="text-zinc-500">{row.label}</span>
                  <span>{row.value}</span>
                </Fragment>
              ))}
              {crosshair.indicators.map((ind, i) => (
                <Fragment key={i}>
                  <span style={{ color: ind.color }}>{ind.label}</span>
                  <span>{ind.value.toFixed(2)}</span>
                </Fragment>
              ))}
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={resetView}
          title="Reset zoom/pan to the default view"
          className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex items-center justify-center w-6 h-6 rounded-full text-xs z-10 bg-zinc-900 border border-zinc-700 text-zinc-100"
        >
          ↺
        </button>
      </div>
    </div>
  );
}
