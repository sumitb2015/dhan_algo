'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
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

// Fixed dark-theme palette (rs_dashboard has no light/dark theme toggle for chart chrome -
// matches LightweightCandlestickChart.tsx's constants).
const CHROME = { gridline: '#27272a', baseline: '#3f3f46', textSecondary: '#a1a1aa', textMuted: '#71717a' };
const STATUS = { good: '#34d399', critical: '#f87171' };
const CATEGORICAL = ['#38bdf8', '#fbbf24', '#a78bfa', '#f472b6', '#4ade80', '#fb923c'];

export type CombinedChartType = 'candlestick' | 'line';

function toUnixSeconds(iso: string): UTCTimestamp {
  return Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;
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
  initialHeight = 400,
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
  initialHeight?: number;
  markers?: {
    time: string;
    color: string;
    size?: number;
    position?: 'aboveBar' | 'belowBar' | 'inBar';
    shape?: 'circle' | 'square' | 'arrowUp' | 'arrowDown';
    text?: string;
  }[];
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

  const [crosshair, setCrosshair] = useState<{
    x: number; y: number; time: string; isLine: boolean; open: number; high: number; low: number; close: number;
    indicators: { label: string; color: string; value: number }[];
    extraRows: { label: string; value: string }[];
  } | null>(null);
  const [legend, setLegend] = useState<{ id: string; label: string; color: string; lastValue: number | null }[]>([]);
  const [lastPrice, setLastPrice] = useState<number | null>(null);

  const createMainSeries = useCallback(
    (type: CombinedChartType) => {
      const chartApi = chartApiRef.current;
      if (!chartApi) return;
      if (mainSeriesTypeRef.current === type && mainSeriesRef.current) return;
      if (mainSeriesRef.current) chartApi.removeSeries(mainSeriesRef.current);
      markersApiRef.current = null;
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
      height: initialHeight,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: CHROME.textSecondary,
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: CHROME.gridline, style: LineStyle.Dotted },
        horzLines: { color: CHROME.gridline, style: LineStyle.Dotted },
      },
      rightPriceScale: { borderColor: CHROME.baseline },
      leftPriceScale: { visible: !!leftAxisLine, borderColor: CHROME.baseline },
      timeScale: {
        borderColor: CHROME.baseline,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: formatIstTick,
        fixLeftEdge: true,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: CHROME.baseline, labelBackgroundColor: CHROME.textMuted },
        horzLine: { color: CHROME.baseline, labelBackgroundColor: CHROME.textMuted },
      },
      localization: { timeFormatter: (time: Time) => formatIstTick(time, TickMarkType.Time) },
    });
    chartApiRef.current = chartInstance;
    mainSeriesTypeRef.current = null;
    createMainSeries(chartTypeRef.current);

    chartInstance.subscribeCrosshairMove((param) => {
      const mainSeries = mainSeriesRef.current;
      if (!param.time || !param.point || !mainSeries) {
        setCrosshair(null);
        return;
      }
      const isLine = chartTypeRef.current === 'line';
      const point = param.seriesData.get(mainSeries) as
        | { open: number; high: number; low: number; close: number }
        | { value: number }
        | undefined;
      if (!point) {
        setCrosshair(null);
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

      setCrosshair({
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

    const resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) chartInstance.applyOptions({ width, height });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chartInstance.remove();
      chartApiRef.current = null;
      mainSeriesRef.current = null;
      mainSeriesTypeRef.current = null;
      lineSeriesRef.current = new Map();
      leftAxisSeriesRef.current = null;
      markersApiRef.current = null;
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
    chartApi.applyOptions({ leftPriceScale: { visible: !!leftAxisLine, borderColor: CHROME.baseline } });
  }, [leftAxisLine]);

  function drawChart() {
    const chartApi = chartApiRef.current;
    const mainSeries = mainSeriesRef.current;
    if (!chartApi || !mainSeries) return;

    if (chartTypeRef.current === 'candlestick') {
      (mainSeries as ISeriesApi<'Candlestick'>).setData(
        candles.map((c) => ({ time: toUnixSeconds(c.time), open: c.open, high: c.high, low: c.low, close: c.close }))
      );
    } else {
      (mainSeries as ISeriesApi<'Line'>).setData(candles.map((c) => ({ time: toUnixSeconds(c.time), value: c.close })));
    }

    isoTimeByUnixRef.current = new Map(candles.map((c) => [toUnixSeconds(c.time), c.time]));

    if (!markersApiRef.current) {
      markersApiRef.current = createSeriesMarkers(mainSeries, []);
    }
    markersApiRef.current.setMarkers(
      (markersRef.current ?? []).map((m) => ({
        time: toUnixSeconds(m.time),
        position: m.position ?? ('inBar' as const),
        shape: m.shape ?? ('circle' as const),
        color: m.color,
        size: m.size ?? 1,
        text: m.text,
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
      leftAxisSeriesRef.current.setData(leftAxisLine.values.map((p) => ({ time: toUnixSeconds(p.time), value: p.value })));
    } else if (leftAxisSeriesRef.current) {
      chartApi.removeSeries(leftAxisSeriesRef.current);
      leftAxisSeriesRef.current = null;
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
      }
      series.setData(ind.series.map((p) => ({ time: toUnixSeconds(p.time), value: p.value })));
    }

    setLegend(indicators.map((ind) => ({ id: ind.id, label: ind.label, color: colorFor(ind.group), lastValue: ind.last_value })));
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
