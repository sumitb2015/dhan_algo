'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ComposedChart,
  Area,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import type { StrikeHistoryPoint } from '@/app/api/options/strike-history/route';

export type TimelineOption = '1D' | '5D' | '10D' | 'ALL';
export type IntervalOption = '1m' | '5m' | '15m' | '1h';
export type ChartStyle = 'area' | 'candles';
export type StrikeSelectionMode = 'fixed' | 'relative';

export interface ContextMeta {
  currentSpot: number;
  openSpot: number;
  spotChange: number;
  spotChangePct: number;
  specificStrike: number;
  initialStrike: number;
  minStrike: number;
  maxStrike: number;
  distinctStrikes: number[];
  openPrice: number;
  lastPrice: number;
  minPrice: number;
  maxPrice: number;
  decay: number;
  decayPct: number;
  tradingDays: string[];
}

export interface HoverContext {
  datetime: string;
  date: string;
  time: string;
  spot: number;
  strike: number;
  open: number;
  high: number;
  low: number;
  close: number;
  oi: number;
  volume: number;
  iv: number;
  decayFromOpen: number;
  decayFromOpenPct: number;
}

interface Props {
  expiry: string;
  strikeMode: StrikeSelectionMode;
  fixedStrike?: number | null;
  strikeRelative?: string;
  optionType: 'CE' | 'PE';
  onContextMetaChange?: (meta: ContextMeta) => void;
  onHoverContextChange?: (hover: HoverContext | null) => void;
}

interface AggregatedRow extends StrikeHistoryPoint {
  idx: number;
  date: string;
  time: string;
  candleRange: [number, number];
  openInitial: number;
  intervalLabel: string;
  optionType: 'CE' | 'PE';
}

interface DayBoundary {
  idx: number;
  date: string;
  dte: number;
}

interface DaySummary {
  date: string;
  dte: number;
  spotOpen: number;
  spotClose: number;
  spotChange: number;
  strike: number;
  open: number;
  high: number;
  low: number;
  close: number;
  decayDay: number;
  decayDayPct: number;
  cumDecayPct: number;
  volume: number;
  oi: number;
  iv: number;
}

function fmtPrice(n: number): string {
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtOi(n: number): string {
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString('en-IN');
}

function PulseStat({
  label,
  value,
  sub,
  color = 'text-white',
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.14em] mb-0.5">{label}</span>
      <span className={`text-xl font-mono font-bold tabular-nums leading-none ${color}`}>{value}</span>
      {sub && <span className="text-[10px] text-zinc-400 mt-1 font-medium">{sub}</span>}
    </div>
  );
}

interface CandlestickBarProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: AggregatedRow;
}

const CandlestickBar = (props: CandlestickBarProps) => {
  const { x = 0, y = 0, width = 0, height = 0, payload } = props;
  if (!payload || payload.open == null || payload.close == null || !height) return null;
  const range = (payload.high ?? 0) - (payload.low ?? 0);
  const wickX = x + width / 2;
  const isUp = payload.close >= payload.open;
  const color = isUp ? '#10b981' : '#ef4444';

  if (range <= 0.001) {
    return <line x1={x} y1={y} x2={x + width} y2={y} stroke={color} strokeWidth={1.5} />;
  }

  const topVal = Math.max(payload.open, payload.close);
  const botVal = Math.min(payload.open, payload.close);
  const bodyY = y + ((payload.high - topVal) / range) * height;
  const bodyHeight = Math.max(2, ((topVal - botVal) / range) * height);
  const candleWidth = Math.max(2, Math.min(width - 2, 10));
  const candleX = x + (width - candleWidth) / 2;

  return (
    <g>
      <line x1={wickX} y1={y} x2={wickX} y2={y + height} stroke={color} strokeWidth={1.2} />
      <rect
        x={candleX}
        y={bodyY}
        width={candleWidth}
        height={bodyHeight}
        fill={color}
        stroke={color}
        strokeWidth={0.5}
      />
    </g>
  );
};

interface TooltipPayloadItem {
  payload: AggregatedRow;
}

interface StrikeHistoryTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadItem[];
}

const StrikeHistoryTooltip = ({ active, payload }: StrikeHistoryTooltipProps) => {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const decayFromOpen = row.openInitial ? row.close - row.openInitial : 0;
  const decayPct = row.openInitial ? (decayFromOpen / row.openInitial) * 100 : 0;
  const distSpot = row.strike - row.spot;
  const isCall = row.optionType === 'CE';
  const isOTM = isCall ? distSpot > 0 : distSpot < 0;
  const distAbs = Math.abs(distSpot);

  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[220px] font-mono">
      <div className="flex items-center justify-between gap-4 mb-2 pb-1.5 border-b border-zinc-800">
        <span className="text-zinc-200 font-bold font-sans">
          {row.date} {row.time}
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 font-semibold">
          {row.intervalLabel}
        </span>
      </div>

      <div className="flex justify-between gap-8 mb-1">
        <span className="text-zinc-400 font-sans">Close / LTP</span>
        <span className="text-white font-bold tabular-nums">{fmtPrice(row.close)}</span>
      </div>
      <div className="flex justify-between gap-8 mb-1">
        <span className="text-zinc-400 font-sans">O / H / L</span>
        <span className="text-zinc-300 tabular-nums text-[11px]">
          {fmtPrice(row.open)} · {fmtPrice(row.high)} · {fmtPrice(row.low)}
        </span>
      </div>

      <div className="pt-2 border-t border-zinc-800 flex justify-between gap-8 mb-1">
        <span className="text-cyan-400 font-semibold font-sans">NIFTY Spot</span>
        <span className="text-white font-bold tabular-nums">
          {row.spot
            ? `₹${row.spot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : '—'}
        </span>
      </div>
      <div className="flex justify-between gap-8 mb-1">
        <span className="text-zinc-400 font-sans">Strike</span>
        <span className="text-zinc-200 font-bold tabular-nums">
          {row.strike.toLocaleString('en-IN')} {row.optionType}
          <span className={`ml-1.5 text-[10px] font-medium ${isOTM ? 'text-amber-400' : 'text-purple-400'}`}>
            ({distAbs < 25 ? 'ATM' : `${Math.round(distAbs)} ${isOTM ? 'OTM' : 'ITM'}`})
          </span>
        </span>
      </div>
      <div className="flex justify-between gap-8 mb-2">
        <span className="text-zinc-400 font-sans">Decay vs Entry</span>
        <span className={`font-bold tabular-nums ${decayFromOpen <= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {decayFromOpen >= 0 ? '+' : ''}
          {fmtPrice(decayFromOpen)} ({decayPct.toFixed(1)}%)
        </span>
      </div>

      <div className="pt-2 border-t border-zinc-800 flex justify-between gap-8 mb-1">
        <span className="text-amber-400 font-semibold font-sans">Open Interest</span>
        <span className="text-white font-bold tabular-nums">{fmtOi(row.oi)}</span>
      </div>
      <div className="flex justify-between gap-8 mb-1">
        <span className="text-zinc-400 font-sans">Volume</span>
        <span className="text-zinc-200 font-bold tabular-nums">{fmtOi(row.volume)}</span>
      </div>
      <div className="flex justify-between gap-8">
        <span className="text-cyan-400 font-semibold font-sans">IV</span>
        <span className="text-white font-bold tabular-nums">{row.iv ? `${row.iv.toFixed(2)}%` : '—'}</span>
      </div>
    </div>
  );
};

export default function StrikeHistoryTab({
  expiry,
  strikeMode,
  fixedStrike,
  strikeRelative = 'ATM',
  optionType,
  onContextMetaChange,
  onHoverContextChange,
}: Props) {
  const [points, setPoints] = useState<StrikeHistoryPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Interactive Controls
  const [timeline, setTimeline] = useState<TimelineOption>('ALL');
  const [interval, setInterval] = useState<IntervalOption>('5m');
  const [chartStyle, setChartStyle] = useState<ChartStyle>('area');
  const [showSpotOverlay, setShowSpotOverlay] = useState(true);
  const [showBaseline, setShowBaseline] = useState(true);
  const [showDailyTable, setShowDailyTable] = useState(true);

  // Active point for top ticker inspection
  const [hoveredRow, setHoveredRow] = useState<AggregatedRow | null>(null);

  // Fetch 1-min raw data whenever parameters change
  useEffect(() => {
    if (!expiry || !optionType) return;
    if (strikeMode === 'fixed' && (!fixedStrike || fixedStrike <= 0)) return;
    if (strikeMode === 'relative' && !strikeRelative) return;

    const controller = new AbortController();

    queueMicrotask(() => {
      setLoading(true);
      setError('');
    });

    const url =
      strikeMode === 'fixed'
        ? `/api/options/strike-history?expiry=${expiry}&strike=${fixedStrike}&optionType=${optionType}`
        : `/api/options/strike-history?expiry=${expiry}&strikeRelative=${encodeURIComponent((strikeRelative ?? '').trim())}&optionType=${optionType}`;

    fetch(url, {
      signal: controller.signal,
    })
      .then(r => r.json())
      .then(j => {
        if (j.success && j.points) {
          setPoints(j.points);
        } else {
          setError(j.error ?? 'Failed to load strike history');
          setPoints([]);
        }
      })
      .catch(e => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(String(e));
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [expiry, strikeMode, fixedStrike, strikeRelative, optionType]);

  // 1. Filter raw points by selected timeline (1D, 5D, 10D, ALL)
  const timelinePoints = useMemo(() => {
    if (!points.length) return [];
    const allDates = Array.from(new Set(points.map(p => p.datetime.slice(0, 10)))).sort();
    let selectedDates = allDates;
    if (timeline === '1D') selectedDates = allDates.slice(-1);
    else if (timeline === '5D') selectedDates = allDates.slice(-5);
    else if (timeline === '10D') selectedDates = allDates.slice(-10);

    const dateSet = new Set(selectedDates);
    return points.filter(p => dateSet.has(p.datetime.slice(0, 10)));
  }, [points, timeline]);

  // 2. Resample timeline points into interval buckets (1m, 5m, 15m, 1h)
  const { rows, dayBoundaries, daySummaries } = useMemo(() => {
    if (!timelinePoints.length) return { rows: [], dayBoundaries: [], daySummaries: [] };

    const initialEntryOpen = timelinePoints[0].open;
    const allTradingDates = Array.from(new Set(timelinePoints.map(p => p.datetime.slice(0, 10)))).sort();

    let aggregated: AggregatedRow[] = [];

    if (interval === '1m') {
      aggregated = timelinePoints.map((p, idx) => ({
        ...p,
        idx,
        date: p.datetime.slice(0, 10),
        time: p.datetime.slice(11, 16),
        candleRange: [p.low, p.high],
        openInitial: initialEntryOpen,
        intervalLabel: '1m',
        optionType,
      }));
    } else {
      const intervalMinutes = interval === '5m' ? 5 : interval === '15m' ? 15 : 60;
      const groups: Record<string, StrikeHistoryPoint[]> = {};

      for (const p of timelinePoints) {
        const date = p.datetime.slice(0, 10);
        const time = p.datetime.slice(11, 16);
        const [hh, mm] = time.split(':').map(Number);
        const minutes = hh * 60 + mm;
        const marketOpen = 9 * 60 + 15;
        const offset = Math.max(0, minutes - marketOpen);
        const bucketIdx = Math.floor(offset / intervalMinutes);
        const bucketStartMin = marketOpen + bucketIdx * intervalMinutes;
        const bH = Math.floor(bucketStartMin / 60)
          .toString()
          .padStart(2, '0');
        const bM = (bucketStartMin % 60).toString().padStart(2, '0');
        const key = `${date} ${bH}:${bM}`;

        if (!groups[key]) groups[key] = [];
        groups[key].push(p);
      }

      const sortedKeys = Object.keys(groups).sort();
      aggregated = sortedKeys.map((key, idx) => {
        const pts = groups[key];
        const first = pts[0];
        const last = pts[pts.length - 1];
        const highs = pts.map(p => p.high);
        const lows = pts.map(p => p.low);
        const sumVol = pts.reduce((acc, p) => acc + (p.volume || 0), 0);
        const validIvs = pts.filter(p => p.iv > 0).map(p => p.iv);
        const avgIv = validIvs.length ? validIvs.reduce((a, b) => a + b, 0) / validIvs.length : last.iv || 0;

        const maxH = Math.max(...highs);
        const minL = Math.min(...lows);

        return {
          idx,
          datetime: `${key}:00`,
          date: key.slice(0, 10),
          time: key.slice(11, 16),
          open: first.open,
          high: maxH,
          low: minL,
          close: last.close,
          strike: last.strike,
          spot: last.spot,
          oi: last.oi,
          volume: sumVol,
          iv: Number(avgIv.toFixed(2)),
          candleRange: [minL, maxH],
          openInitial: initialEntryOpen,
          intervalLabel: interval,
          optionType,
        };
      });
    }

    // Day boundaries calculation
    const boundaries: DayBoundary[] = [];
    let lastDate = '';
    for (const row of aggregated) {
      if (row.date !== lastDate) {
        const dte = allTradingDates.length - 1 - allTradingDates.indexOf(row.date);
        boundaries.push({ idx: row.idx, date: row.date, dte });
        lastDate = row.date;
      }
    }

    // Daily decay summaries for breakdown table
    const summaries: DaySummary[] = allTradingDates.map((date, dayIdx) => {
      const dayPts = timelinePoints.filter(p => p.datetime.slice(0, 10) === date);
      const first = dayPts[0];
      const last = dayPts[dayPts.length - 1];
      const highs = dayPts.map(p => p.high);
      const lows = dayPts.map(p => p.low);
      const vol = dayPts.reduce((acc, p) => acc + (p.volume || 0), 0);
      const dte = allTradingDates.length - 1 - dayIdx;
      const decayDay = last.close - first.open;
      const decayDayPct = first.open ? (decayDay / first.open) * 100 : 0;
      const cumDecayPct = initialEntryOpen ? ((last.close - initialEntryOpen) / initialEntryOpen) * 100 : 0;

      return {
        date,
        dte,
        spotOpen: first.spot,
        spotClose: last.spot,
        spotChange: last.spot - first.spot,
        strike: last.strike,
        open: first.open,
        high: Math.max(...highs),
        low: Math.min(...lows),
        close: last.close,
        decayDay,
        decayDayPct,
        cumDecayPct,
        volume: vol,
        oi: last.oi,
        iv: last.iv,
      };
    });

    return { rows: aggregated, dayBoundaries: boundaries, daySummaries: summaries };
  }, [timelinePoints, interval, optionType]);

  // Overall metadata for context
  const contextMeta = useMemo<ContextMeta | null>(() => {
    if (!rows.length) return null;
    const first = rows[0];
    const last = rows[rows.length - 1];
    const prices = rows.map(r => r.close);
    const strikes = rows.map(r => r.strike).filter(Boolean);
    const allDates = Array.from(new Set(rows.map(r => r.date))).sort();

    const openSpot = first.spot || 0;
    const currentSpot = last.spot || 0;
    const spotChange = currentSpot - openSpot;
    const spotChangePct = openSpot ? (spotChange / openSpot) * 100 : 0;

    const openPrice = first.open;
    const lastPrice = last.close;
    const decay = lastPrice - openPrice;
    const decayPct = openPrice ? (decay / openPrice) * 100 : 0;

    return {
      currentSpot,
      openSpot,
      spotChange: Number(spotChange.toFixed(2)),
      spotChangePct: Number(spotChangePct.toFixed(2)),
      specificStrike: last.strike,
      initialStrike: first.strike,
      minStrike: strikes.length ? Math.min(...strikes) : 0,
      maxStrike: strikes.length ? Math.max(...strikes) : 0,
      distinctStrikes: Array.from(new Set(strikes)).sort((a, b) => a - b),
      openPrice,
      lastPrice,
      minPrice: Math.min(...prices),
      maxPrice: Math.max(...prices),
      decay: Number(decay.toFixed(2)),
      decayPct: Number(decayPct.toFixed(2)),
      tradingDays: allDates,
    };
  }, [rows]);

  // Send metadata up to page header
  useEffect(() => {
    if (contextMeta && onContextMetaChange) {
      onContextMetaChange(contextMeta);
    }
  }, [contextMeta, onContextMetaChange]);

  // Handle Chart Hover
  type ChartMouseMoveHandler = NonNullable<React.ComponentProps<typeof ComposedChart>['onMouseMove']>;

  const handleMouseMove: ChartMouseMoveHandler = useCallback(
    nextState => {
      if (nextState && nextState.isTooltipActive) {
        const rawIdx = nextState.activeIndex ?? nextState.activeTooltipIndex;
        const idx = typeof rawIdx === 'number' ? rawIdx : typeof rawIdx === 'string' ? parseInt(rawIdx, 10) : -1;
        const row = rows[idx];
        if (row) {
          setHoveredRow(row);
          if (onHoverContextChange) {
            const decayFromOpen = row.openInitial ? row.close - row.openInitial : 0;
            const decayFromOpenPct = row.openInitial ? (decayFromOpen / row.openInitial) * 100 : 0;
            onHoverContextChange({
              datetime: row.datetime,
              date: row.date,
              time: row.time,
              spot: row.spot,
              strike: row.strike,
              open: row.open,
              high: row.high,
              low: row.low,
              close: row.close,
              oi: row.oi,
              volume: row.volume,
              iv: row.iv,
              decayFromOpen,
              decayFromOpenPct,
            });
          }
        }
      }
    },
    [rows, onHoverContextChange]
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredRow(null);
    if (onHoverContextChange) onHoverContextChange(null);
  }, [onHoverContextChange]);

  // Derived styling and KPIs
  const accent =
    optionType === 'CE'
      ? { line: '#60a5fa', fillFrom: '#60a5fa', text: 'text-blue-400' }
      : { line: '#f87171', fillFrom: '#f87171', text: 'text-red-400' };

  const firstRow = rows[0];
  const lastRow = rows[rows.length - 1];
  const activeSpot = hoveredRow ? hoveredRow.spot : lastRow?.spot ?? 0;
  const activeStrike = hoveredRow ? hoveredRow.strike : lastRow?.strike ?? 0;

  const totalDecayVal = contextMeta?.decay ?? 0;
  const totalDecayPct = contextMeta?.decayPct ?? 0;
  const daysCount = dayBoundaries.length || 1;
  const velocityDay = totalDecayVal / daysCount;
  const velocityHr = totalDecayVal / (daysCount * 6.25);

  const peakOi = rows.length ? Math.max(...rows.map(r => r.oi || 0)) : 0;
  const totalVolume = rows.reduce((acc, r) => acc + (r.volume || 0), 0);

  const distSpot = activeStrike - activeSpot;
  const isCall = optionType === 'CE';
  const isOTM = isCall ? distSpot > 0 : distSpot < 0;
  const distAbs = Math.abs(distSpot);
  const moneynessBadge = distAbs < 25 ? 'ATM' : `${Math.round(distAbs)} pts ${isOTM ? 'OTM' : 'ITM'}`;

  const gridProps = { strokeDasharray: '3 6', stroke: '#20202399', vertical: false as const };
  const xAxisProps = {
    dataKey: 'idx' as const,
    tickFormatter: (idx: number) => {
      const r = rows[idx];
      if (!r) return '';
      return timeline === '1D' ? r.time : `${r.date.slice(5)} ${r.time}`;
    },
    tick: { fontSize: 10, fill: '#a1a1aa', fontWeight: 500 as const, fontFamily: 'var(--font-mono)' },
    tickLine: false,
    axisLine: { stroke: '#27272a' },
    interval: 'preserveStartEnd' as const,
    minTickGap: 50,
  };

  if (loading && !rows.length) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <div className="w-6 h-6 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
        <p className="text-sm text-zinc-400 font-medium">Loading strike decay history…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">
        {error}
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="flex items-center justify-center py-24 text-zinc-500 text-sm">
        No data for this expiry / strike / option type combination.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── Top Control & View Bar ───────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 flex-wrap bg-zinc-900/40 border border-zinc-800/80 px-4 py-2.5 rounded-xl">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Timeline Filter */}
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            <span className="text-[9px] text-zinc-500 uppercase tracking-widest px-2 font-bold font-mono">
              Range
            </span>
            {(['1D', '5D', '10D', 'ALL'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTimeline(t)}
                className={`px-2.5 py-1 text-[11px] font-mono font-bold rounded-md transition-colors ${
                  timeline === t
                    ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="w-px h-5 bg-zinc-800" />

          {/* Interval Filter */}
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            <span className="text-[9px] text-zinc-500 uppercase tracking-widest px-2 font-bold font-mono">
              Interval
            </span>
            {(['1m', '5m', '15m', '1h'] as const).map(i => (
              <button
                key={i}
                onClick={() => setInterval(i)}
                className={`px-2.5 py-1 text-[11px] font-mono font-bold rounded-md transition-colors ${
                  interval === i
                    ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30 shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
                }`}
              >
                {i}
              </button>
            ))}
          </div>
        </div>

        {/* Display Toggles */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Chart Style Toggle */}
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            <button
              onClick={() => setChartStyle('area')}
              className={`px-2.5 py-1 text-[11px] font-mono font-bold rounded-md transition-colors ${
                chartStyle === 'area'
                  ? 'bg-zinc-800 text-white border border-zinc-700'
                  : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
              }`}
            >
              Area
            </button>
            <button
              onClick={() => setChartStyle('candles')}
              className={`px-2.5 py-1 text-[11px] font-mono font-bold rounded-md transition-colors ${
                chartStyle === 'candles'
                  ? 'bg-zinc-800 text-white border border-zinc-700'
                  : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
              }`}
            >
              Candles
            </button>
          </div>

          {/* Spot Overlay Toggle */}
          <button
            onClick={() => setShowSpotOverlay(v => !v)}
            className={`px-2.5 py-1 text-[11px] font-mono font-bold rounded-lg border transition-colors flex items-center gap-1.5 ${
              showSpotOverlay
                ? 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30'
                : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${showSpotOverlay ? 'bg-cyan-400' : 'bg-zinc-600'}`} />
            Spot Line
          </button>

          {/* Baseline Toggle */}
          <button
            onClick={() => setShowBaseline(v => !v)}
            className={`px-2.5 py-1 text-[11px] font-mono font-bold rounded-lg border transition-colors ${
              showBaseline
                ? 'bg-zinc-800 text-zinc-300 border-zinc-700'
                : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300'
            }`}
          >
            Baseline
          </button>

          {/* Table Toggle */}
          <button
            onClick={() => setShowDailyTable(v => !v)}
            className={`px-2.5 py-1 text-[11px] font-mono font-bold rounded-lg border transition-colors ${
              showDailyTable
                ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300'
            }`}
          >
            Daily Table
          </button>
        </div>
      </div>

      {/* ── KPI Stat Banner ─────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-emerald-500/[0.05] via-transparent to-blue-500/[0.04]" />
        <div className="relative flex items-stretch gap-6 px-5 py-4 flex-wrap">
          {/* Specific Strike */}
          <PulseStat
            label={strikeMode === 'fixed' ? 'Fixed Strike' : 'Rolling Strike'}
            value={`${activeStrike.toLocaleString('en-IN')} ${optionType}`}
            sub={
              strikeMode === 'fixed'
                ? `Constant strike · ${moneynessBadge}`
                : `${strikeRelative} · ${moneynessBadge}`
            }
            color={accent.text}
          />

          <div className="w-px bg-zinc-800 self-stretch" />

          {/* Underlying Spot */}
          <PulseStat
            label="NIFTY Spot"
            value={`₹${activeSpot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            sub={
              hoveredRow
                ? `@ ${hoveredRow.time}`
                : `${contextMeta?.spotChange && contextMeta.spotChange >= 0 ? '+' : ''}${contextMeta?.spotChange ?? 0} (${contextMeta?.spotChangePct ?? 0}%)`
            }
            color="text-cyan-400"
          />

          <div className="w-px bg-zinc-800 self-stretch" />

          {/* Total Decay */}
          <PulseStat
            label="Decay Captured"
            value={`${totalDecayVal <= 0 ? '' : '+'}${fmtPrice(totalDecayVal)}`}
            sub={`${totalDecayPct.toFixed(2)}% (${fmtPrice(firstRow ? firstRow.open : 0)} → ${fmtPrice(lastRow ? lastRow.close : 0)})`}
            color={totalDecayVal <= 0 ? 'text-emerald-400' : 'text-red-400'}
          />

          <div className="w-px bg-zinc-800 self-stretch" />

          {/* Theta Velocity */}
          <PulseStat
            label="Theta Velocity"
            value={`${velocityDay <= 0 ? '' : '+'}${fmtPrice(velocityDay)} / day`}
            sub={`${fmtPrice(velocityHr)} / hr avg theta loss`}
          />

          <div className="w-px bg-zinc-800 self-stretch" />

          {/* Premium Range */}
          <PulseStat
            label="Premium Range"
            value={`${fmtPrice(contextMeta?.minPrice ?? 0)} – ${fmtPrice(contextMeta?.maxPrice ?? 0)}`}
            sub={`Range across ${daysCount} trading days`}
          />

          <div className="ml-auto flex items-center gap-5 flex-wrap">
            <PulseStat label="Peak OI" value={fmtOi(peakOi)} sub={`${fmtOi(totalVolume)} Vol`} color="text-amber-400" />
            <PulseStat label="Bars" value={`${rows.length.toLocaleString('en-IN')} (${interval})`} sub={`${daysCount} Days`} />
          </div>
        </div>
      </div>

      {/* ── Active Inspection Banner ─────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-950/70 border border-zinc-800/80 rounded-xl text-xs font-mono">
        {hoveredRow ? (
          <div className="flex items-center gap-4 flex-wrap text-zinc-300">
            <span className="text-emerald-400 font-bold font-sans flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              {hoveredRow.date} {hoveredRow.time}
            </span>
            <span>
              Spot: <strong className="text-cyan-400">₹{hoveredRow.spot.toLocaleString('en-IN')}</strong>
            </span>
            <span>
              Strike: <strong className="text-white">{hoveredRow.strike.toLocaleString('en-IN')} {optionType}</strong>
            </span>
            <span>
              O: <strong className="text-zinc-200">{fmtPrice(hoveredRow.open)}</strong> H:{' '}
              <strong className="text-zinc-200">{fmtPrice(hoveredRow.high)}</strong> L:{' '}
              <strong className="text-zinc-200">{fmtPrice(hoveredRow.low)}</strong> C:{' '}
              <strong className="text-emerald-400">{fmtPrice(hoveredRow.close)}</strong>
            </span>
            <span>
              Decay:{' '}
              <strong className={hoveredRow.close <= hoveredRow.openInitial ? 'text-emerald-400' : 'text-red-400'}>
                {hoveredRow.openInitial
                  ? `${(((hoveredRow.close - hoveredRow.openInitial) / hoveredRow.openInitial) * 100).toFixed(1)}%`
                  : '—'}
              </strong>
            </span>
            <span>
              OI: <strong className="text-amber-400">{fmtOi(hoveredRow.oi)}</strong>
            </span>
            {hoveredRow.iv > 0 && (
              <span>
                IV: <strong className="text-cyan-400">{hoveredRow.iv.toFixed(1)}%</strong>
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between w-full text-zinc-500 font-sans text-[11px]">
            <span>
              {strikeMode === 'fixed'
                ? `Tracking constant fixed strike ${activeStrike.toLocaleString('en-IN')} ${optionType} across entire expiry.`
                : `Tracking rolling ${strikeRelative} offset as spot moves across expiry.`}
            </span>
            <span className="font-mono text-zinc-400">
              {daysCount} Days · {rows.length} {interval} Bars · Expiry: {expiry}
            </span>
          </div>
        )}
      </div>

      {/* ── Main Chart Card ─────────────────────────────────────── */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] mb-1">
              Decay Curve ·{' '}
              {strikeMode === 'fixed'
                ? `${activeStrike.toLocaleString('en-IN')} (Fixed Strike)`
                : `${strikeRelative} (Rolling Offset)`}{' '}
              {optionType}
            </p>
            <p className="text-sm font-bold text-white tracking-tight">
              {activeStrike.toLocaleString('en-IN')} {optionType} — Option Price &amp; Underlying Spot
            </p>
            <p className="text-[10px] text-zinc-500 mt-0.5">
              {interval} bars · {timeline} timeframe · {expiry} expiry · {daysCount} trading days
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono">
            <span className="flex items-center gap-1.5 text-zinc-400">
              <span className={`w-2.5 h-2.5 rounded-sm ${optionType === 'CE' ? 'bg-blue-400' : 'bg-red-400'}`} />
              Option Close
            </span>
            {showSpotOverlay && (
              <span className="flex items-center gap-1.5 text-cyan-400">
                <span className="w-3 h-0.5 border-t-2 border-dashed border-cyan-400" />
                NIFTY Spot
              </span>
            )}
            {showBaseline && (
              <span className="flex items-center gap-1.5 text-zinc-500">
                <span className="w-3 h-0.5 border-t border-dashed border-zinc-500" />
                Entry Baseline (₹{firstRow?.open.toFixed(2)})
              </span>
            )}
          </div>
        </div>

        <ResponsiveContainer width="100%" height={380}>
          <ComposedChart
            data={rows}
            margin={{ top: 12, right: showSpotOverlay ? 60 : 16, left: 0, bottom: 0 }}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          >
            <defs>
              <linearGradient id="strikeHistoryFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent.fillFrom} stopOpacity={0.35} />
                <stop offset="100%" stopColor={accent.fillFrom} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid {...gridProps} />
            <XAxis {...xAxisProps} />
            {/* Left Y-Axis: Option Premium */}
            <YAxis
              yAxisId="price"
              tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500, fontFamily: 'var(--font-mono)' }}
              tickLine={false}
              axisLine={false}
              width={54}
              domain={['auto', 'auto']}
              tickFormatter={v => `₹${v}`}
            />
            {/* Right Y-Axis: Spot Price */}
            {showSpotOverlay && (
              <YAxis
                yAxisId="spot"
                orientation="right"
                domain={['dataMin - 40', 'dataMax + 40']}
                tick={{ fontSize: 10, fill: '#06b6d4', fontWeight: 500, fontFamily: 'var(--font-mono)' }}
                tickLine={false}
                axisLine={false}
                width={58}
                tickFormatter={v => Math.round(v).toLocaleString('en-IN')}
              />
            )}

            <Tooltip content={<StrikeHistoryTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }} />

            {/* Entry Baseline */}
            {showBaseline && firstRow && (
              <ReferenceLine
                yAxisId="price"
                y={firstRow.open}
                stroke="#71717a"
                strokeDasharray="4 4"
                strokeWidth={1}
                label={{
                  value: `Entry: ₹${firstRow.open.toFixed(2)}`,
                  position: 'right',
                  fill: '#a1a1aa',
                  fontSize: 10,
                  fontWeight: 600,
                }}
              />
            )}

            {/* Day Boundary Markers */}
            {dayBoundaries.slice(1).map(b => (
              <ReferenceLine
                key={b.idx}
                yAxisId="price"
                x={b.idx}
                stroke="#3f3f46"
                strokeDasharray="2 4"
                strokeWidth={1}
                label={{
                  value: `${b.date.slice(5)} (${b.dte} DTE)`,
                  position: 'top',
                  fill: '#71717a',
                  fontSize: 9,
                  fontWeight: 600,
                }}
              />
            ))}

            {/* Option Price Chart: Area or Candlesticks */}
            {chartStyle === 'area' ? (
              <Area
                yAxisId="price"
                type="monotone"
                dataKey="close"
                name="Close"
                stroke={accent.line}
                strokeWidth={2}
                fill="url(#strikeHistoryFill)"
                dot={false}
                activeDot={{ r: 4, fill: accent.line, stroke: '#09090b', strokeWidth: 2 }}
                isAnimationActive={false}
              />
            ) : (
              <Bar
                yAxisId="price"
                dataKey="candleRange"
                shape={<CandlestickBar />}
                isAnimationActive={false}
              />
            )}

            {/* Underlying Spot Overlay */}
            {showSpotOverlay && (
              <Line
                yAxisId="spot"
                type="monotone"
                dataKey="spot"
                name="NIFTY Spot"
                stroke="#06b6d4"
                strokeWidth={1.5}
                strokeDasharray="3 3"
                dot={false}
                activeDot={{ r: 3, fill: '#06b6d4', stroke: '#09090b', strokeWidth: 1.5 }}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* ── Secondary Panel: Volume, OI & IV ────────────────────── */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4">
        <div className="flex items-center justify-between mb-2 px-1">
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">
              Market Activity &amp; Volatility
            </span>
          </div>
          <div className="flex items-center gap-5 text-xs font-mono">
            <span className="flex items-center gap-1.5 text-zinc-400">
              <span className="w-2.5 h-2.5 rounded-sm bg-zinc-600" />
              Volume
            </span>
            <span className="flex items-center gap-1.5 text-amber-400">
              <span className="w-2.5 h-0.5 bg-amber-400" />
              Open Interest (OI)
            </span>
            <span className="flex items-center gap-1.5 text-cyan-400">
              <span className="w-2.5 h-0.5 bg-cyan-400" />
              Implied Volatility (IV %)
            </span>
          </div>
        </div>

        <ResponsiveContainer width="100%" height={120}>
          <ComposedChart
            data={rows}
            margin={{ top: 4, right: 40, left: 0, bottom: 0 }}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          >
            <CartesianGrid {...gridProps} />
            <XAxis {...xAxisProps} hide />
            <YAxis
              yAxisId="vol"
              tick={{ fontSize: 9, fill: '#71717a', fontFamily: 'var(--font-mono)' }}
              tickLine={false}
              axisLine={false}
              width={48}
              tickFormatter={v => fmtOi(v)}
            />
            <YAxis
              yAxisId="iv"
              orientation="right"
              domain={[0, 'auto']}
              tick={{ fontSize: 9, fill: '#06b6d4', fontFamily: 'var(--font-mono)' }}
              tickLine={false}
              axisLine={false}
              width={38}
              tickFormatter={v => `${v}%`}
            />
            <Bar yAxisId="vol" dataKey="volume" fill="#3f3f46" opacity={0.6} isAnimationActive={false} />
            <Line
              yAxisId="vol"
              type="monotone"
              dataKey="oi"
              stroke="#f59e0b"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              yAxisId="iv"
              type="monotone"
              dataKey="iv"
              stroke="#06b6d4"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* ── Daily Decay Breakdown Table ─────────────────────────── */}
      {showDailyTable && daySummaries.length > 0 && (
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 overflow-hidden">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em]">Theta Profile</p>
              <h3 className="text-xs font-bold text-white tracking-tight">Daily Decay &amp; Progression Breakdown</h3>
            </div>
            <span className="text-[10px] font-mono text-zinc-400 bg-zinc-800/80 px-2 py-0.5 rounded">
              {daySummaries.length} Trading Days
            </span>
          </div>

          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-800 text-xs font-bold text-white">
                <tr>
                  <th className="px-3 py-2.5">Date</th>
                  <th className="px-3 py-2.5">DTE</th>
                  <th className="px-3 py-2.5">NIFTY Spot (Close)</th>
                  <th className="px-3 py-2.5">Strike</th>
                  <th className="px-3 py-2.5 text-right">Day Open</th>
                  <th className="px-3 py-2.5 text-right">Day High</th>
                  <th className="px-3 py-2.5 text-right">Day Low</th>
                  <th className="px-3 py-2.5 text-right">Day Close</th>
                  <th className="px-3 py-2.5 text-right">Day Decay (₹)</th>
                  <th className="px-3 py-2.5 text-right">Day Decay (%)</th>
                  <th className="px-3 py-2.5 text-right">Total Decay (%)</th>
                  <th className="px-3 py-2.5 text-right">Volume</th>
                  <th className="px-3 py-2.5 text-right">OI</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 font-mono text-[11px] tabular-nums">
                {daySummaries.map(s => (
                  <tr key={s.date} className="hover:bg-zinc-800/40 transition-colors">
                    <td className="px-3 py-2 font-bold text-zinc-200">{s.date}</td>
                    <td className="px-3 py-2 text-zinc-400">{s.dte} DTE</td>
                    <td className="px-3 py-2 text-cyan-400">
                      ₹{s.spotClose.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      <span
                        className={`ml-1.5 text-[10px] ${s.spotChange >= 0 ? 'text-emerald-400' : 'text-red-400'}`}
                      >
                        ({s.spotChange >= 0 ? '+' : ''}
                        {s.spotChange.toFixed(1)})
                      </span>
                    </td>
                    <td className="px-3 py-2 font-bold text-white">
                      {s.strike.toLocaleString('en-IN')} {optionType}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-300">{fmtPrice(s.open)}</td>
                    <td className="px-3 py-2 text-right text-zinc-300">{fmtPrice(s.high)}</td>
                    <td className="px-3 py-2 text-right text-zinc-300">{fmtPrice(s.low)}</td>
                    <td className="px-3 py-2 text-right font-bold text-white">{fmtPrice(s.close)}</td>
                    <td
                      className={`px-3 py-2 text-right font-bold ${
                        s.decayDay <= 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {s.decayDay >= 0 ? '+' : ''}
                      {fmtPrice(s.decayDay)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-bold ${
                        s.decayDayPct <= 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {s.decayDayPct.toFixed(1)}%
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-bold ${
                        s.cumDecayPct <= 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {s.cumDecayPct.toFixed(1)}%
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-400">{fmtOi(s.volume)}</td>
                    <td className="px-3 py-2 text-right text-amber-400">{fmtOi(s.oi)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
