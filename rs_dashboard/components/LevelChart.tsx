'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useChartChrome } from '@/lib/chartTheme';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { LevelCandle, LevelBucket, LevelChartIndicators, PrevDayLevels } from '@/app/api/level-chart/route';

export interface OverlayVisibility { vwap: boolean; supertrend: boolean; ema: boolean; pdc: boolean }

export interface IndicatorLabels { emaFast: number; emaSlow: number; stLength: number; stMultiplier: number }

export type LevelsMode = 'actual' | 'forecast';

interface Props {
  candles: LevelCandle[];
  levelBuckets: LevelBucket[];
  label: string;
  indicators?: LevelChartIndicators;
  prevDayLevels?: PrevDayLevels | null;
  visible: OverlayVisibility;
  indicatorLabels: IndicatorLabels;
  levelsMode: LevelsMode;
}

// Saturated data colours — fixed per the theming convention documented in CLAUDE.md: chrome
// flips with the theme, data colours don't.
const UP = '#34d399';
const DOWN = '#f87171';
const ZONE_GREEN = 'rgba(74, 222, 128, 0.22)';
const ZONE_GREEN_LIVE = 'rgba(74, 222, 128, 0.34)';
const ZONE_RED = 'rgba(248, 113, 113, 0.22)';
const ZONE_RED_LIVE = 'rgba(248, 113, 113, 0.34)';
const HL_LINE = 'rgba(228, 228, 231, 0.45)';
const MID_LINE = 'rgba(251, 191, 36, 0.85)';
const BUCKET_DIVIDER = 'rgba(161, 161, 170, 0.25)';
const LIVE_BADGE_BG = 'rgba(52, 211, 153, 0.9)';
const LIVE_BADGE_TEXT = 'rgba(9, 20, 15, 0.95)';

const VWAP_COLOR = '#38bdf8';
const EMA20_COLOR = '#a78bfa';
const EMA50_COLOR = '#f472b6';
const ST_UP_COLOR = '#34d399';
const ST_DOWN_COLOR = '#f87171';
const PDC_COLOR = '#a1a1aa';

type OverlayKey = 'vwap' | 'ema20' | 'ema50';

const IST_TIME_ZONE = 'Asia/Kolkata';

function toUTCTimestamp(iso: string): UTCTimestamp {
  return Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;
}

/** lightweight-charts formats tick/crosshair labels in the browser's local timezone by
 * default — in a server/CI/UTC-timezone browser that renders 03:45 for what the backend
 * stamped as 09:15 IST. Force IST explicitly, same as CombinedPremiumChart.tsx's formatIstTick. */
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

function formatIstClock(unix: number): string {
  return new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: IST_TIME_ZONE }).format(new Date(unix * 1000));
}

type TimedPoint = { time: UTCTimestamp; open: number; high: number; low: number; close: number };

/** Ported from CombinedPremiumChart.tsx's sameBar/isTailUpdate/advancesFrom trio: series.update()
 * throws on an out-of-order bar ("Cannot update oldest data"), so a poll that only extended the
 * tail (the ordinary steady state) uses update() per new bar; anything else — interval switch,
 * a gap, a rescale — falls back to a full setData(). Probes compare values, not just timestamps,
 * so an in-place rescale with identical bar times is still caught. */
function sameBar(a: TimedPoint, b: TimedPoint): boolean {
  return a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;
}

function advancesFrom(lastDrawn: UTCTimestamp, next: TimedPoint[], start: number): boolean {
  let previous = lastDrawn;
  for (let i = start; i < next.length; i++) {
    if (next[i].time < previous) return false;
    previous = next[i].time;
  }
  return true;
}

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

function findBucketAt(buckets: LevelBucket[], unix: number): LevelBucket | undefined {
  return buckets.find((b) => unix >= toUTCTimestamp(b.start) && unix < toUTCTimestamp(b.end));
}

/** Actual mode draws each bucket's own H/50/L (unchanged). Forecast mode re-pairs bucket i's
 * time window with bucket (i-1)'s values — a rolling projection of the last completed period's
 * levels onto the one now forming. The source bucket is always already closed by the time the
 * target exists, so every forecast zone gets the "closed" (fixed-value) treatment. */
function deriveLevelBuckets(buckets: LevelBucket[], mode: LevelsMode): LevelBucket[] {
  if (mode === 'actual') return buckets;
  return buckets.slice(1).map((b, i) => ({
    start: b.start, end: b.end, closed: true,
    high: buckets[i].high, low: buckets[i].low, mid: buckets[i].mid,
  }));
}

type CrosshairState = {
  x: number; y: number; time: string; open: number; high: number; low: number; close: number;
  bucket?: LevelBucket;
};

export default function LevelChart({ candles, levelBuckets, label, indicators, prevDayLevels, visible, indicatorLabels, levelsMode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const drawnRef = useRef<TimedPoint[] | undefined>(undefined);
  const hasFitRef = useRef(false);
  const overlaySeriesRef = useRef<Partial<Record<OverlayKey, ISeriesApi<'Line'>>>>({});
  const supertrendSeriesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const pdcLinesRef = useRef<IPriceLine[]>([]);
  // Redraws the zone overlay without depending on React state — invoked on pan/zoom/resize as
  // well as new data, same pattern as FootprintChart.tsx's drawRef.
  const drawZonesRef = useRef<() => void>(() => {});
  // Holds the mode-derived buckets (see deriveLevelBuckets) — both the zone-drawing effect and
  // the crosshair tooltip read this, so the tooltip always matches what's actually drawn.
  const levelBucketsRef = useRef<LevelBucket[]>(levelBuckets);
  levelBucketsRef.current = deriveLevelBuckets(levelBuckets, levelsMode);
  const crosshairFrameRef = useRef<number | null>(null);
  const pendingCrosshairRef = useRef<CrosshairState | null>(null);

  const [crosshair, setCrosshair] = useState<CrosshairState | null>(null);

  const chrome = useChartChrome();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: chrome.textSecondary,
        fontFamily: 'ui-monospace, monospace',
        fontSize: 11,
      },
      grid: { vertLines: { color: chrome.gridline }, horzLines: { color: chrome.gridline } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: chrome.baseline, labelBackgroundColor: chrome.textMuted },
        horzLine: { color: chrome.baseline, labelBackgroundColor: chrome.textMuted },
      },
      rightPriceScale: { borderColor: chrome.baseline, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: chrome.baseline, timeVisible: true, secondsVisible: false, tickMarkFormatter: formatIstTick, rightOffset: 6 },
      localization: { timeFormatter: (time: Time) => formatIstTick(time, TickMarkType.Time) },
      autoSize: true,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });

    chartRef.current = chart;
    seriesRef.current = series;
    drawnRef.current = undefined;
    hasFitRef.current = false;
    overlaySeriesRef.current = {};
    supertrendSeriesRef.current = [];
    pdcLinesRef.current = [];

    const redraw = () => drawZonesRef.current();
    chart.timeScale().subscribeVisibleTimeRangeChange(redraw);
    const observer = new ResizeObserver(redraw);
    observer.observe(container);

    const flushCrosshair = (next: CrosshairState | null) => {
      pendingCrosshairRef.current = next;
      if (crosshairFrameRef.current !== null) return;
      crosshairFrameRef.current = requestAnimationFrame(() => {
        crosshairFrameRef.current = null;
        setCrosshair(pendingCrosshairRef.current);
      });
    };

    chart.subscribeCrosshairMove((param) => {
      const s = seriesRef.current;
      if (!param.time || !param.point || !s) { flushCrosshair(null); return; }
      const point = param.seriesData.get(s) as { open: number; high: number; low: number; close: number } | undefined;
      if (!point) { flushCrosshair(null); return; }
      flushCrosshair({
        x: param.point.x, y: param.point.y,
        time: formatIstClock(param.time as number),
        open: point.open, high: point.high, low: point.low, close: point.close,
        bucket: findBucketAt(levelBucketsRef.current, param.time as number),
      });
    });

    return () => {
      if (crosshairFrameRef.current !== null) cancelAnimationFrame(crosshairFrameRef.current);
      observer.disconnect();
      chart.timeScale().unsubscribeVisibleTimeRangeChange(redraw);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      overlaySeriesRef.current = {};
      supertrendSeriesRef.current = [];
      pdcLinesRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-apply chrome when the theme flips (canvas can't read CSS vars).
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({
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

  // Candles.
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;

    const next: TimedPoint[] = candles.map((c) => ({
      time: toUTCTimestamp(c.time), open: c.open, high: c.high, low: c.low, close: c.close,
    }));

    if (isTailUpdate(drawnRef.current, next)) {
      try {
        for (let i = drawnRef.current!.length - 1; i < next.length; i++) series.update(next[i]);
      } catch {
        series.setData(next);
      }
    } else {
      series.setData(next);
    }
    drawnRef.current = next;

    if (next.length && !hasFitRef.current) {
      chart.timeScale().fitContent();
      hasFitRef.current = true;
    }
    drawZonesRef.current();
  }, [candles]);

  // Trend overlays: VWAP / EMA20 / EMA50, each an independently toggleable LineSeries created
  // on first toggle-on and removed on toggle-off (add/remove pattern from
  // CombinedPremiumChart.tsx's indicator-series management). No tail-update guard here, unlike
  // the candle series — these are small arrays rebuilt from a small array on each poll, not
  // perf-sensitive enough to justify the extra guard code. Supertrend is handled separately
  // below — it can't reuse a single persistent series (see that effect's comment).
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // No `title` set: lightweight-charts renders a persistent axis chip for a series' title even
    // with lastValueVisible:false, which stacked illegibly against the PDH/PDC/PDL price-line
    // labels whenever values converged. Overlay identity lives in the legend row below instead —
    // PDH/PDC/PDL keep their axis labels since showing their value on the axis is their purpose.
    const specs: { key: OverlayKey; on: boolean; data: { time: string; value: number }[] | undefined; color: string; style?: LineStyle }[] = [
      { key: 'vwap', on: visible.vwap, data: indicators?.vwap, color: VWAP_COLOR, style: LineStyle.Dotted },
      { key: 'ema20', on: visible.ema, data: indicators?.ema20, color: EMA20_COLOR },
      { key: 'ema50', on: visible.ema, data: indicators?.ema50, color: EMA50_COLOR },
    ];

    for (const spec of specs) {
      const existing = overlaySeriesRef.current[spec.key];
      if (!spec.on) {
        if (existing) {
          chart.removeSeries(existing);
          delete overlaySeriesRef.current[spec.key];
        }
        continue;
      }
      let series = existing;
      if (!series) {
        series = chart.addSeries(LineSeries, {
          color: spec.color,
          lineWidth: 2,
          lineStyle: spec.style ?? LineStyle.Solid,
          lastValueVisible: false,
          priceLineVisible: false,
        });
        overlaySeriesRef.current[spec.key] = series;
      }
      series.setData((spec.data ?? []).map((p) => ({ time: toUTCTimestamp(p.time), value: p.value })));
    }
  }, [indicators, visible.vwap, visible.ema]);

  // Supertrend: one LineSeries per contiguous same-direction run, fully torn down and rebuilt
  // on every update, rather than two persistent up/down series.
  //
  // lightweight-charts' LineSeries does NOT actually break the line at a "whitespace"
  // (value-omitted) data point despite that being its documented purpose for reserving empty
  // time slots — confirmed by direct reproduction against lightweight-charts 5.2.0: a series
  // with real values at index 0 and 25 and whitespace at every index in between rendered as one
  // straight diagonal connecting them, not two isolated points. A single up/down pair sharing a
  // time axis with "gaps" therefore drew a spurious diagonal through every trend flip. Genuinely
  // separate series can't be bridged this way, since the renderer only ever connects points
  // within the same series — that's the actual fix, not the null/whitespace encoding.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const series of supertrendSeriesRef.current) chart.removeSeries(series);
    supertrendSeriesRef.current = [];
    if (!visible.supertrend || !indicators?.supertrend?.length) return;

    let run: { time: UTCTimestamp; value: number }[] = [];
    let runDirection: 1 | -1 | null = null;
    const flush = () => {
      if (run.length === 0) return;
      const series = chart.addSeries(LineSeries, {
        color: runDirection === 1 ? ST_UP_COLOR : ST_DOWN_COLOR,
        lineWidth: 2,
        lastValueVisible: false,
        priceLineVisible: false,
      });
      series.setData(run);
      supertrendSeriesRef.current.push(series);
    };

    for (const p of indicators.supertrend) {
      if (p.direction !== runDirection) {
        flush();
        run = [];
        runDirection = p.direction;
      }
      run.push({ time: toUTCTimestamp(p.time), value: p.value });
    }
    flush();
  }, [indicators, visible.supertrend]);

  // Previous Day High/Low/Close reference lines — same createPriceLine() rail pattern as
  // FootprintChart.tsx's POC/VAH/VAL lines.
  //
  // createPriceLine() does NOT participate in the price scale's autoscale — it only draws at
  // whatever y-coordinate its price maps to under the range the candles alone produce. On a day
  // that gaps or trends away from the prior session (e.g. crude oil dropping from a PDH near
  // 8386 down through a today's-range ceiling of ~8255), PDH/PDC land above the visible viewport
  // and silently render off-screen — confirmed 2026-08-24 on CRUDEOIL, where only PDL (inside
  // today's range) showed while PDH/PDC (above it) did not. Widen the series' own autoscale
  // range to include the rail prices whenever they're outside it, same technique as the
  // autoscaleInfoProvider doc example.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const line of pdcLinesRef.current) series.removePriceLine(line);
    pdcLinesRef.current = [];

    const rails: { price: number; title: string }[] = prevDayLevels
      ? [
          { price: prevDayLevels.high, title: 'PDH' },
          { price: prevDayLevels.close, title: 'PDC' },
          { price: prevDayLevels.low, title: 'PDL' },
        ]
      : [];
    const finiteRails = rails.filter((r) => Number.isFinite(r.price));

    if (visible.pdc) {
      for (const rail of finiteRails) {
        pdcLinesRef.current.push(
          series.createPriceLine({
            price: rail.price, color: PDC_COLOR, lineWidth: 1, lineStyle: LineStyle.Dashed,
            axisLabelVisible: true, title: rail.title,
          }),
        );
      }
    }

    series.applyOptions({
      autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } | null } | null) => {
        const res = original();
        if (!visible.pdc || !res?.priceRange || finiteRails.length === 0) return res;
        const prices = finiteRails.map((r) => r.price);
        return {
          ...res,
          priceRange: {
            minValue: Math.min(res.priceRange.minValue, ...prices),
            maxValue: Math.max(res.priceRange.maxValue, ...prices),
          },
        };
      },
    });
  }, [prevDayLevels, visible.pdc]);

  // High/50%/Low zone overlay, drawn on a canvas sibling to the chart — lightweight-charts has
  // no native filled horizontal-zone series (same technique as FootprintChart.tsx). The
  // still-forming bucket gets a brighter fill + dashed border + "LIVE" tag so it reads as
  // "still updating" rather than a finished record, and a divider marks each bucket boundary.
  useEffect(() => {
    drawZonesRef.current = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      const chart = chartRef.current;
      const series = seriesRef.current;
      if (!canvas || !container || !chart || !series) return;

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

      const timeScale = chart.timeScale();
      for (const bucket of levelBucketsRef.current) {
        const xStartRaw = timeScale.timeToCoordinate(toUTCTimestamp(bucket.start));
        const xEndRaw = timeScale.timeToCoordinate(toUTCTimestamp(bucket.end));
        const yHigh = series.priceToCoordinate(bucket.high);
        const yMid = series.priceToCoordinate(bucket.mid);
        const yLow = series.priceToCoordinate(bucket.low);
        if (yHigh === null || yMid === null || yLow === null) continue;
        // Both edges off-screen on the same side — nothing of this bucket is visible.
        if ((xStartRaw !== null && xStartRaw > cssW) || (xEndRaw !== null && xEndRaw < 0)) continue;

        const xStart = Math.max(xStartRaw ?? 0, 0);
        const xEnd = Math.min(xEndRaw ?? cssW, cssW);
        if (xEnd <= xStart) continue;
        const w = xEnd - xStart;

        ctx.fillStyle = bucket.closed ? ZONE_GREEN : ZONE_GREEN_LIVE;
        ctx.fillRect(xStart, yHigh, w, yMid - yHigh);
        ctx.fillStyle = bucket.closed ? ZONE_RED : ZONE_RED_LIVE;
        ctx.fillRect(xStart, yMid, w, yLow - yMid);

        ctx.strokeStyle = HL_LINE;
        ctx.lineWidth = 1;
        ctx.setLineDash(bucket.closed ? [] : [4, 3]);
        for (const y of [yHigh, yLow]) {
          ctx.beginPath();
          ctx.moveTo(xStart, y + 0.5);
          ctx.lineTo(xEnd, y + 0.5);
          ctx.stroke();
        }
        ctx.strokeStyle = MID_LINE;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(xStart, yMid + 0.5);
        ctx.lineTo(xEnd, yMid + 0.5);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.setLineDash([]);

        // Thin outer border for definition against the candle background — dashed in Forecast
        // mode as a chart-level cue for which mode is active, independent of the header toggle.
        // chrome.baseline (not the fixed ZONE_BORDER constant) so it stays visible in light
        // theme, where a light-mode-invisible fixed grey would disappear against the page.
        ctx.strokeStyle = chrome.baseline;
        ctx.setLineDash(levelsMode === 'forecast' ? [3, 3] : []);
        ctx.strokeRect(xStart + 0.5, yHigh + 0.5, Math.max(w - 1, 0), yLow - yHigh - 1);
        ctx.setLineDash([]);

        // Bucket-boundary divider, so adjacent buckets read as distinct periods even when
        // their fills land on the same side of 50%.
        if (xStartRaw !== null && xStartRaw >= 0 && xStartRaw <= cssW) {
          ctx.strokeStyle = BUCKET_DIVIDER;
          ctx.beginPath();
          ctx.moveTo(xStartRaw + 0.5, yHigh);
          ctx.lineTo(xStartRaw + 0.5, yLow);
          ctx.stroke();
        }

        // High/Mid/Low value labels, right-aligned within the zone — only on buckets wide
        // enough to hold them legibly (same width gate the LIVE badge uses).
        if (w > 34) {
          ctx.font = '600 9px ui-monospace, monospace';
          ctx.fillStyle = chrome.textSecondary;
          ctx.textAlign = 'right';
          const labelX = xEnd - 4;
          ctx.textBaseline = 'bottom';
          ctx.fillText(bucket.high.toFixed(2), labelX, yHigh - 2);
          ctx.textBaseline = 'middle';
          ctx.fillText(bucket.mid.toFixed(2), labelX, yMid - 6);
          ctx.textBaseline = 'top';
          ctx.fillText(bucket.low.toFixed(2), labelX, yLow + 2);
          ctx.textAlign = 'left';
        }

        if (!bucket.closed && w > 34) {
          const badgeText = 'LIVE';
          ctx.font = '700 9px ui-monospace, monospace';
          const badgeW = ctx.measureText(badgeText).width + 8;
          const badgeH = 13;
          const badgeX = xStart + 4;
          const badgeY = yHigh - badgeH - 3;
          ctx.fillStyle = LIVE_BADGE_BG;
          const r = 3;
          ctx.beginPath();
          ctx.moveTo(badgeX + r, badgeY);
          ctx.arcTo(badgeX + badgeW, badgeY, badgeX + badgeW, badgeY + badgeH, r);
          ctx.arcTo(badgeX + badgeW, badgeY + badgeH, badgeX, badgeY + badgeH, r);
          ctx.arcTo(badgeX, badgeY + badgeH, badgeX, badgeY, r);
          ctx.arcTo(badgeX, badgeY, badgeX + badgeW, badgeY, r);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = LIVE_BADGE_TEXT;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + badgeH / 2 + 0.5);
          ctx.textAlign = 'left';
        }
      }
    };
    drawZonesRef.current();
  }, [levelBuckets, levelsMode, chrome]);

  const last = candles[candles.length - 1];
  const first = candles[0];
  const dayChangePct = first && last ? ((last.close - first.open) / first.open) * 100 : null;

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />
      <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" />

      <div className="absolute top-2 left-3 z-10 flex flex-col gap-1 pointer-events-none">
        <div className="flex items-center gap-2.5 text-xs">
          <span className="font-bold text-zinc-100 tracking-tight">{label}</span>
          {last && (
            <span className="font-mono tabular-nums font-semibold text-zinc-100">{last.close.toFixed(2)}</span>
          )}
          {dayChangePct !== null && (
            <span className={`font-mono tabular-nums text-[11px] font-semibold ${dayChangePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {dayChangePct >= 0 ? '+' : ''}{dayChangePct.toFixed(2)}%
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[9px] font-semibold uppercase tracking-wide text-zinc-500">
          <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm" style={{ background: ZONE_GREEN_LIVE }} />above 50%</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm" style={{ background: ZONE_RED_LIVE }} />below 50%</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-0.5" style={{ background: MID_LINE }} />50%</span>
          {levelsMode === 'forecast' && (
            <span className="flex items-center gap-1 text-sky-400">
              <span className="inline-block w-2.5 h-0.5 border-t border-dashed" style={{ borderColor: 'currentcolor' }} />
              forecast
            </span>
          )}
          {visible.vwap && (
            <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-0.5" style={{ background: VWAP_COLOR }} />VWAP</span>
          )}
          {visible.ema && (
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-0.5" style={{ background: EMA20_COLOR }} />EMA{indicatorLabels.emaFast}
              <span className="inline-block w-2.5 h-0.5 ml-1" style={{ background: EMA50_COLOR }} />EMA{indicatorLabels.emaSlow}
            </span>
          )}
          {visible.supertrend && (
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-0.5" style={{ background: ST_UP_COLOR }} />
              ST({indicatorLabels.stLength},{indicatorLabels.stMultiplier})
            </span>
          )}
        </div>
      </div>

      {crosshair && (
        <div
          className="absolute pointer-events-none rounded-lg px-2.5 py-1.5 text-[11px] tabular-nums shadow-lg z-10 bg-zinc-900/95 border border-zinc-700 text-zinc-100"
          style={{ left: Math.min(crosshair.x + 12, (containerRef.current?.clientWidth ?? 0) - 175), top: 8, minWidth: 160 }}
        >
          <div className="text-zinc-500 mb-1 font-mono">{crosshair.time} IST</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono">
            <span className="text-zinc-500">O</span><span>{crosshair.open.toFixed(2)}</span>
            <span className="text-zinc-500">H</span><span>{crosshair.high.toFixed(2)}</span>
            <span className="text-zinc-500">L</span><span>{crosshair.low.toFixed(2)}</span>
            <span className="text-zinc-500">C</span><span>{crosshair.close.toFixed(2)}</span>
          </div>
          {crosshair.bucket && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono mt-1.5 pt-1.5 border-t border-zinc-800">
              <span className="text-zinc-500">Hi</span><span>{crosshair.bucket.high.toFixed(2)}</span>
              <span className="text-amber-400/90">Mid</span><span className="text-amber-300">{crosshair.bucket.mid.toFixed(2)}</span>
              <span className="text-zinc-500">Lo</span><span>{crosshair.bucket.low.toFixed(2)}</span>
              <span className="text-zinc-500">Bucket</span>
              <span className={crosshair.bucket.closed ? 'text-zinc-400' : 'text-emerald-400'}>{crosshair.bucket.closed ? 'closed' : 'live'}</span>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => chartRef.current?.timeScale().fitContent()}
        title="Reset zoom/pan to the default view"
        className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center justify-center w-6 h-6 rounded-full text-xs z-10 bg-zinc-900 border border-zinc-700 text-zinc-100 hover:border-zinc-500"
      >
        ↺
      </button>
    </div>
  );
}
