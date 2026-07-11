'use client';

import React, { useEffect, useRef } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type LineData,
} from 'lightweight-charts';
import type { CandleRow } from '@/app/api/equity-candles/route';

interface Props {
  candles: CandleRow[];
  /** Number of trailing bars to fit into view initially, or null for all bars. */
  initialBars: number | null;
  /** Bump to force the visible range to reset to `initialBars` (e.g. on period-button click). */
  viewToken: number;
}

function toUTCTimestamp(dateStr: string): UTCTimestamp {
  return (Date.parse(`${dateStr}T00:00:00Z`) / 1000) as UTCTimestamp;
}

/** Simple moving average of closes; only emits points once `period` closes are available. */
function computeSMA(candles: CandleRow[], period: number): LineData[] {
  const out: LineData[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) {
      out.push({ time: toUTCTimestamp(candles[i].date), value: sum / period });
    }
  }
  return out;
}

export default function LightweightCandlestickChart({ candles, initialBars, viewToken }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const sma20SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const sma200SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  // Create the chart once on mount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#a1a1aa',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#27272a' },
        horzLines: { color: '#27272a' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#3f3f46' },
      timeScale: {
        borderColor: '#3f3f46',
        timeVisible: false,
        rightOffset: 4,
      },
      autoSize: true,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#34d399',
      downColor: '#f87171',
      borderUpColor: '#34d399',
      borderDownColor: '#f87171',
      wickUpColor: '#34d399',
      wickDownColor: '#f87171',
    });
    series.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.28 } });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      color: '#52525b',
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });

    const sma20Series = chart.addSeries(LineSeries, {
      color: '#fbbf24',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    const sma200Series = chart.addSeries(LineSeries, {
      color: '#818cf8',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    chartRef.current = chart;
    seriesRef.current = series;
    volumeSeriesRef.current = volumeSeries;
    sma20SeriesRef.current = sma20Series;
    sma200SeriesRef.current = sma200Series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeSeriesRef.current = null;
      sma20SeriesRef.current = null;
      sma200SeriesRef.current = null;
    };
  }, []);

  // Push data whenever candles change.
  useEffect(() => {
    if (!seriesRef.current || !volumeSeriesRef.current || !sma20SeriesRef.current || !sma200SeriesRef.current) return;
    seriesRef.current.setData(
      candles.map((c) => ({
        time: toUTCTimestamp(c.date),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );
    volumeSeriesRef.current.setData(
      candles.map((c) => ({
        time: toUTCTimestamp(c.date),
        value: c.volume,
        color: c.close >= c.open ? 'rgba(52, 211, 153, 0.5)' : 'rgba(248, 113, 113, 0.5)',
      }))
    );
    sma20SeriesRef.current.setData(computeSMA(candles, 20));
    sma200SeriesRef.current.setData(computeSMA(candles, 200));
  }, [candles]);

  // Reset the visible range whenever the period button forces a new viewToken.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || candles.length === 0) return;
    if (initialBars === null || initialBars >= candles.length) {
      chart.timeScale().fitContent();
    } else {
      chart.timeScale().setVisibleLogicalRange({
        from: candles.length - initialBars,
        to: candles.length - 1,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewToken, candles.length]);

  return (
    <div className="relative w-full h-full">
      <div className="absolute top-1 left-2 z-10 flex items-center gap-3 text-[10px] font-semibold pointer-events-none">
        <span className="flex items-center gap-1 text-amber-400">
          <span className="w-2.5 h-0.5 bg-amber-400 inline-block" /> SMA 20
        </span>
        <span className="flex items-center gap-1 text-indigo-400">
          <span className="w-2.5 h-0.5 bg-indigo-400 inline-block" /> SMA 200
        </span>
      </div>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
