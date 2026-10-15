'use client';

import { useEffect, useRef } from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  ColorType,
  LineStyle,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useChartChrome } from '@/lib/chartTheme';
import type { CompositeCandle, CompositePoint } from '@/lib/indexComposite';

// Saturated data colours: not themed, they read on either ground.
const UP = '#34d399';
const DOWN = '#f87171';
const LINE = '#38bdf8';

type Bar = CompositeCandle | CompositePoint;

function sameBar(a: Bar, b: Bar): boolean {
  const av = a as unknown as Record<string, number>;
  const bv = b as unknown as Record<string, number>;
  for (const key of Object.keys(av)) if (av[key] !== bv[key]) return false;
  return true;
}

/** `next` is `prev` with only the tail changed/appended, and that tail moves forward in time
 * (update() throws "Cannot update oldest data" otherwise). Same guard as CombinedPremiumChart. */
function isTailUpdate(prev: Bar[], next: Bar[]): boolean {
  if (prev.length < 2 || next.length < prev.length) return false;
  if (!sameBar(prev[0], next[0]) || !sameBar(prev[prev.length - 2], next[prev.length - 2])) return false;
  let last = prev[prev.length - 1].time;
  for (let i = prev.length - 1; i < next.length; i++) {
    if (next[i].time < last) return false;
    last = next[i].time;
  }
  return true;
}

/**
 * Times are IST wall-clock seconds stored as UTCTimestamp (see lib/indexComposite.ts), so the
 * chart's default UTC formatting already reads IST — no tickMarkFormatter shift.
 *
 * The parent keys this component on mode/timeframe/weights, so a selection change remounts
 * (fresh fitContent) and a live tick only extends the tail, keeping the user's zoom.
 */
export default function IndexCompositeChart({ data, kind }: { data: Bar[]; kind: 'line' | 'candles' }) {
  const chrome = useChartChrome();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | ISeriesApi<'Candlestick'> | null>(null);
  const drawnRef = useRef<Bar[]>([]);
  const fittedRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      height: container.clientHeight || 480,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: chrome.textSecondary,
        fontFamily: 'ui-monospace, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: chrome.gridline, style: LineStyle.Dotted },
        horzLines: { color: chrome.gridline, style: LineStyle.Dotted },
      },
      rightPriceScale: { borderColor: chrome.baseline, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: chrome.baseline, timeVisible: true, secondsVisible: kind === 'line', fixLeftEdge: true },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: chrome.baseline, labelBackgroundColor: chrome.textMuted },
        horzLine: { color: chrome.baseline, labelBackgroundColor: chrome.textMuted },
      },
    });
    seriesRef.current = kind === 'candles'
      ? chart.addSeries(CandlestickSeries, {
          upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false,
        })
      : chart.addSeries(LineSeries, { color: LINE, lineWidth: 2, priceLineVisible: true });
    chartRef.current = chart;

    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) chart.applyOptions({ width, height });
    });
    ro.observe(container);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      drawnRef.current = [];
      fittedRef.current = false;
    };
    // chrome is re-applied by its own effect below; adding it here would recreate the chart (and lose zoom) on a theme flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  useEffect(() => {
    chartRef.current?.applyOptions({
      layout: { textColor: chrome.textSecondary },
      grid: { vertLines: { color: chrome.gridline }, horzLines: { color: chrome.gridline } },
      rightPriceScale: { borderColor: chrome.baseline },
      timeScale: { borderColor: chrome.baseline },
      crosshair: {
        vertLine: { color: chrome.baseline, labelBackgroundColor: chrome.textMuted },
        horzLine: { color: chrome.baseline, labelBackgroundColor: chrome.textMuted },
      },
    });
  }, [chrome]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const next = data.map(b => ({ ...b, time: b.time as UTCTimestamp }));
    const prev = drawnRef.current;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const target = series as ISeriesApi<any>;
    if (isTailUpdate(prev, next)) {
      try {
        for (let i = prev.length - 1; i < next.length; i++) target.update(next[i]);
      } catch {
        target.setData(next);
      }
    } else {
      target.setData(next);
    }
    drawnRef.current = next;
    if (!fittedRef.current && next.length > 0) {
      chartRef.current?.timeScale().fitContent();
      fittedRef.current = true;
    }
  }, [data, kind]);

  return <div ref={containerRef} className="w-full h-full min-h-[420px]" />;
}
