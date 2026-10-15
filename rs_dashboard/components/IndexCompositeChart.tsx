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

/** One colour per overlay index (25 in the feed). Saturated categorical colours, not themed. */
export const OVERLAY_PALETTE = [
  '#f472b6', '#fbbf24', '#a78bfa', '#4ade80', '#fb923c', '#22d3ee', '#e879f9', '#facc15',
  '#60a5fa', '#f87171', '#2dd4bf', '#c084fc', '#a3e635', '#fda4af', '#93c5fd', '#fcd34d',
  '#86efac', '#d8b4fe', '#fdba74', '#67e8f9', '#bef264', '#f9a8d4', '#818cf8', '#5eead4', '#fca5a5',
];

export interface OverlaySeries { symbol: string; label: string; color: string; data: CompositePoint[] }

type Bar = CompositeCandle | CompositePoint;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySeries = ISeriesApi<any>;

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

/** Draw `next` on `series`, extending the tail in place when that is provably safe. */
function applyData(series: AnySeries, prev: Bar[], next: Bar[]) {
  const data = next.map(b => ({ ...b, time: b.time as UTCTimestamp }));
  if (isTailUpdate(prev, next)) {
    try {
      for (let i = prev.length - 1; i < data.length; i++) series.update(data[i]);
      return;
    } catch { /* fall through to a full redraw */ }
  }
  series.setData(data);
}

/**
 * Times are IST wall-clock seconds stored as UTCTimestamp (see lib/indexComposite.ts), so the
 * chart's default UTC formatting already reads IST — no tickMarkFormatter shift.
 *
 * The parent keys this component on mode/timeframe/weights, so a selection change remounts
 * (fresh fitContent) and a live tick only extends the tails, keeping the user's zoom.
 * Overlays share the composite's price scale: in `equal` mode every index is S × P/B.
 */
export default function IndexCompositeChart({
  data,
  kind,
  overlays = [],
  highlight = null,
}: {
  data: Bar[];
  kind: 'line' | 'candles';
  overlays?: OverlaySeries[];
  highlight?: string | null;
}) {
  const chrome = useChartChrome();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<AnySeries | null>(null);
  const mainDrawnRef = useRef<Bar[]>([]);
  const overlayRef = useRef(new Map<string, { series: AnySeries; drawn: Bar[]; color: string }>());
  const fittedRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const overlayMap = overlayRef.current;
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
      mainRef.current = null;
      mainDrawnRef.current = [];
      overlayMap.clear();
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

  // Overlays first, so the composite (added after) draws on top of them.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const map = overlayRef.current;
    const wanted = new Set(overlays.map(o => o.symbol));
    for (const [symbol, entry] of map) {
      if (!wanted.has(symbol)) { chart.removeSeries(entry.series); map.delete(symbol); }
    }
    for (const o of overlays) {
      let entry = map.get(o.symbol);
      if (!entry) {
        entry = {
          series: chart.addSeries(LineSeries, {
            color: o.color, lineWidth: 1, title: '', lastValueVisible: false, priceLineVisible: false,
            crosshairMarkerVisible: false,
          }),
          drawn: [],
          color: o.color,
        };
        map.set(o.symbol, entry);
      }
      applyData(entry.series, entry.drawn, o.data);
      entry.drawn = o.data;
    }

    if (!mainRef.current) {
      mainRef.current = kind === 'candles'
        ? chart.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false })
        : chart.addSeries(LineSeries, { color: LINE, lineWidth: 3, priceLineVisible: true, title: 'Composite' });
    }
    applyData(mainRef.current, mainDrawnRef.current, data);
    mainDrawnRef.current = data;

    if (!fittedRef.current && data.length > 0) {
      chart.timeScale().fitContent();
      fittedRef.current = true;
    }
  }, [data, overlays, kind]);

  // Hovering a table row: thicken that index, fade the rest.
  useEffect(() => {
    for (const [symbol, entry] of overlayRef.current) {
      const on = highlight === symbol;
      entry.series.applyOptions({
        lineWidth: on ? 3 : 1,
        color: highlight && !on ? `${entry.color}33` : entry.color,
        lastValueVisible: on,
      });
    }
  }, [highlight, overlays]);

  return <div ref={containerRef} className="w-full h-full min-h-[420px]" />;
}
