'use client';

import React, { useEffect, useRef } from 'react';
import { useChartChrome } from '@/lib/chartTheme';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Bar, ProfileRow, ValueArea } from '@/lib/volumeProfile';

interface Props {
  bars: Bar[];
  /** Chart-side profile rows, ascending by price. */
  rows: ProfileRow[];
  chart: ValueArea;
  window: ValueArea;
  /** Bars in the trailing window, shaded on the chart to match the KPI strip. */
  windowBars: number;
}

/**
 * Intraday stamps are IST-naive. Parsing them as UTC makes lightweight-charts render the
 * exact wall-clock time they carry; letting `new Date` localise them would shift the
 * session by the machine's UTC offset (09:15 rendered as 06:25 in an earlier bug).
 */
function toUTCTimestamp(t: string): UTCTimestamp {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(t);
  if (!m) return 0 as UTCTimestamp;
  const [, y, mo, d, hh, mm, ss] = m;
  return (Date.UTC(+y, +mo - 1, +d, +hh, +mm, +(ss ?? 0)) / 1000) as UTCTimestamp;
}

export default function FootprintChart({ bars, rows, chart, window: win, windowBars }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  // Redraw reads the latest profile without tearing down the chart, so the overlay stays
  // in sync when only the price scale moves (pan/zoom) and no prop changed.
  const drawRef = useRef<() => void>(() => {});

  const chrome = useChartChrome();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const c = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: chrome.textSecondary,
        fontSize: 11,
      },
      grid: { vertLines: { color: chrome.gridline }, horzLines: { color: chrome.gridline } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: chrome.baseline, scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderColor: chrome.baseline, timeVisible: true, secondsVisible: false, rightOffset: 12 },
      autoSize: true,
    });

    const series = c.addSeries(CandlestickSeries, {
      upColor: '#34d399',
      downColor: '#f87171',
      borderUpColor: '#34d399',
      borderDownColor: '#f87171',
      wickUpColor: '#34d399',
      wickDownColor: '#f87171',
    });
    series.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.26 } });

    const volume = c.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      color: '#52525b',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chartRef.current = c;
    seriesRef.current = series;
    volumeRef.current = volume;

    const redraw = () => drawRef.current();
    c.timeScale().subscribeVisibleLogicalRangeChange(redraw);
    const observer = new ResizeObserver(redraw);
    observer.observe(container);

    return () => {
      observer.disconnect();
      c.timeScale().unsubscribeVisibleLogicalRangeChange(redraw);
      c.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
      priceLinesRef.current = [];
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-apply chrome when the theme flips (canvas can't read CSS vars).
  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    c.applyOptions({
      layout: { textColor: chrome.textSecondary },
      grid: { vertLines: { color: chrome.gridline }, horzLines: { color: chrome.gridline } },
      rightPriceScale: { borderColor: chrome.baseline },
      timeScale: { borderColor: chrome.baseline },
    });
  }, [chrome]);

  // Candles + volume.
  useEffect(() => {
    const series = seriesRef.current;
    const volume = volumeRef.current;
    if (!series || !volume) return;

    series.setData(
      bars.map((b) => ({ time: toUTCTimestamp(b.t), open: b.o, high: b.h, low: b.l, close: b.c })),
    );
    volume.setData(
      bars.map((b) => ({
        time: toUTCTimestamp(b.t),
        value: b.v,
        color: b.c >= b.o ? 'rgba(52, 211, 153, 0.45)' : 'rgba(248, 113, 113, 0.45)',
      })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [bars]);

  // POC / VAH / VAL rails.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = [];

    const levels: { price: number; color: string; title: string; style: LineStyle }[] = [
      { price: chart.poc, color: '#38bdf8', title: 'C-POC', style: LineStyle.Solid },
      { price: chart.vah, color: '#a78bfa', title: 'C-VAH', style: LineStyle.Dashed },
      { price: chart.val, color: '#a78bfa', title: 'C-VAL', style: LineStyle.Dashed },
      { price: win.poc, color: '#fbbf24', title: 'W-POC', style: LineStyle.Dotted },
    ];
    for (const l of levels) {
      if (!Number.isFinite(l.price) || l.price <= 0) continue;
      priceLinesRef.current.push(
        series.createPriceLine({
          price: l.price,
          color: l.color,
          lineWidth: 1,
          lineStyle: l.style,
          axisLabelVisible: true,
          title: l.title,
        }),
      );
    }
  }, [chart.poc, chart.vah, chart.val, win.poc]);

  // Profile overlay. Drawn on a canvas rather than as a series because lightweight-charts
  // has no horizontal-histogram series type; the price axis is shared by reading
  // priceToCoordinate off the candle series on every repaint.
  useEffect(() => {
    drawRef.current = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      const c = chartRef.current;
      const series = seriesRef.current;
      if (!canvas || !container || !c || !series) return;

      const cssW = container.clientWidth;
      const cssH = container.clientHeight;
      if (cssW === 0 || cssH === 0) return;

      const dpr = globalThis.devicePixelRatio || 1;
      if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
      }
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      if (rows.length === 0) return;

      const axisW = c.priceScale('right').width();
      const plotRight = cssW - axisW;
      const maxWidth = Math.max(60, Math.min(plotRight * 0.32, 260));

      // Scale to the 99th-percentile bin, not the largest one. A single closing-auction
      // print can carry several percent of a week's volume at one price (NSE stamps one
      // at 15:29 with zero range); scaling to it renders every other bin as a hairline.
      // Bins above the reference simply clip at full width.
      const sorted = rows.map((r) => r.total).sort((a, b) => a - b);
      const maxVol = sorted[Math.min(Math.floor(sorted.length * 0.99), sorted.length - 1)] || 0;
      if (maxVol <= 0) return;

      // Row thickness comes from the price gap between adjacent rows, so the profile
      // stays contiguous at any zoom level instead of leaving gaps or overlapping.
      const spacing = rows.length > 1 ? Math.abs(rows[1].price - rows[0].price) : 0;

      for (const row of rows) {
        const yMid = series.priceToCoordinate(row.price);
        const yEdge = spacing > 0 ? series.priceToCoordinate(row.price + spacing) : null;
        if (yMid === null) continue;
        const thickness = yEdge !== null ? Math.max(Math.abs(yMid - yEdge), 1) : 2;
        const y = yMid - thickness / 2;
        if (y + thickness < 0 || y > cssH) continue;

        const w = Math.min(row.total / maxVol, 1) * maxWidth;
        const buyW = row.total > 0 ? (row.buy / row.total) * w : 0;
        const inValue = row.price >= chart.val && row.price <= chart.vah;

        ctx.globalAlpha = inValue ? 0.55 : 0.28;
        ctx.fillStyle = '#f87171';
        ctx.fillRect(plotRight - w, y, w - buyW, Math.max(thickness - 0.5, 0.5));
        ctx.fillStyle = '#34d399';
        ctx.fillRect(plotRight - buyW, y, buyW, Math.max(thickness - 0.5, 0.5));
      }

      // POC bar, drawn opaque so it reads as the profile's spine.
      const pocRow = rows.reduce((a, b) => (b.total > a.total ? b : a), rows[0]);
      const yPoc = series.priceToCoordinate(pocRow.price);
      if (yPoc !== null) {
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = '#38bdf8';
        const w = Math.min(pocRow.total / maxVol, 1) * maxWidth;
        ctx.fillRect(plotRight - w, yPoc - 1, w, 2);
      }
      ctx.globalAlpha = 1;
    };
    drawRef.current();
  }, [rows, chart.val, chart.vah]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />
      <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" />
      <div className="absolute top-1 left-2 z-10 flex items-center gap-3 text-[10px] font-semibold pointer-events-none">
        <span className="text-sky-400">C-POC</span>
        <span className="text-violet-400">C-VAH / C-VAL</span>
        <span className="text-amber-400">W-POC</span>
        <span className="text-zinc-500">profile shaded inside value area · window {windowBars} bars</span>
      </div>
    </div>
  );
}
