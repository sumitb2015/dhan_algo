'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Target, ChevronLeft, ChevronRight, RefreshCw, Pencil, Check, X,
  ChevronDown, ChevronUp, Trophy, Skull, Flame, Zap, ArrowUp,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { cn } from '@/lib/utils';
import { useTradeSync } from '@/lib/useTradeSync';
import NavBar from './NavBar';

// ─── Types ──────────────────────────────────────────────────────────────────

interface DailyPnlPoint {
  date: string;
  grossPnl: number;
  charges: number;
  statutoryCharges: number;
  netPnl: number;
  tradeCount: number;
}

interface TradeLogRow {
  date: string;
  time: string;
  segment: 'EQUITY' | 'FNO' | 'COMMODITY';
  symbol: string;
  securityId: string;
  transactionType: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  charges: number;
  statutoryCharges: number;
  productType: string;
  optionType: 'CE' | 'PE' | null;
  strikePrice: number | null;
  expiryDate: string | null;
}

interface SegmentTotals {
  realizedPnl: number;
  charges: number;
  statutoryCharges: number;
  netRealizedPnl: number;
  openPositionsUnrealized: number;
  openPositionsCount: number;
  tradeCount: number;
  symbolCount: number;
}

interface TradeHistoryResponse {
  success: boolean;
  available: boolean;
  syncRunning?: boolean;
  fromDate?: string;
  toDate?: string;
  marketTradingDates?: string[];
  dailyPnl?: DailyPnlPoint[];
  dailyPnlBySegment?: Record<string, DailyPnlPoint[]>;
  trades?: TradeLogRow[];
  segments?: Record<string, SegmentTotals>;
}

type Segment = 'ALL' | 'TRADING' | 'EQUITY' | 'FNO' | 'COMMODITY';

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: 'ALL', label: 'ALL' },
  { key: 'TRADING', label: 'TRADING' },
  { key: 'EQUITY', label: 'EQUITY' },
  { key: 'FNO', label: 'FNO' },
  { key: 'COMMODITY', label: 'COMMODITY' },
];

const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

// ─── Date helpers (UTC-based to avoid local-timezone day shifts) ──────────────

function toUTCDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUTCDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysUTC(dateStr: string, days: number): string {
  const d = toUTCDate(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUTCDate(d);
}

function dayOfWeekUTC(dateStr: string): number {
  return toUTCDate(dateStr).getUTCDay(); // 0=Sun..6=Sat
}

function mondayOfWeek(dateStr: string): string {
  const dow = dayOfWeekUTC(dateStr);
  const offset = dow === 0 ? 6 : dow - 1;
  return addDaysUTC(dateStr, -offset);
}

function todayIstDateString(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function fmtShort(dateStr: string): string {
  return toUTCDate(dateStr).toLocaleDateString('en-IN', { month: 'short', day: '2-digit', timeZone: 'UTC' });
}

function fmtDateLong(dateStr: string): string {
  return toUTCDate(dateStr).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function fmtINR(n: number, compact = false): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (compact) {
    if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)}Cr`;
    if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)}L`;
    if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}K`;
  }
  return `${sign}₹${abs.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function PnlText({ v, compact }: { v: number; compact?: boolean }) {
  return (
    <span className={cn('tabular-nums font-bold', v >= 0 ? 'text-emerald-400' : 'text-red-400')}>
      {v >= 0 ? '+' : ''}{fmtINR(v, compact)}
    </span>
  );
}

// Merge two per-date P&L series (e.g. FNO + COMMODITY) into one, summing overlapping dates.
function mergeDailyPnl(...series: DailyPnlPoint[][]): DailyPnlPoint[] {
  const byDate = new Map<string, DailyPnlPoint>();
  for (const pts of series) {
    for (const pt of pts) {
      const existing = byDate.get(pt.date);
      if (existing) {
        existing.grossPnl += pt.grossPnl;
        existing.charges += pt.charges;
        existing.statutoryCharges += pt.statutoryCharges;
        existing.netPnl += pt.netPnl;
        existing.tradeCount += pt.tradeCount;
      } else {
        byDate.set(pt.date, { ...pt });
      }
    }
  }
  return Array.from(byDate.values())
    .map(pt => ({ ...pt, grossPnl: round2(pt.grossPnl), charges: round2(pt.charges), statutoryCharges: round2(pt.statutoryCharges), netPnl: round2(pt.netPnl) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Presentation helpers ────────────────────────────────────────────────────

function PulseStat({ label, value, sub, color = 'text-white', size = 'text-lg' }: {
  label: string; value: string; sub?: string; color?: string; size?: string;
}) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.14em] mb-0.5">{label}</span>
      <span className={`${size} font-mono font-bold tabular-nums leading-none ${color}`}>{value}</span>
      {sub && <span className="text-[10px] text-zinc-500 mt-1 font-medium">{sub}</span>}
    </div>
  );
}

function Divider() {
  return <div className="w-px bg-zinc-800 self-stretch" />;
}

interface ChartPoint { date: string; day: string; netPnl: number; cumulative: number }

function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: ChartPoint }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[180px] font-mono">
      <p className="text-zinc-400 mb-2 font-semibold">{fmtDateLong(p.date)}</p>
      <div className="flex justify-between gap-8 mb-1">
        <span className="text-zinc-500">Day P&amp;L</span>
        <PnlText v={p.netPnl} />
      </div>
      <div className="flex justify-between gap-8 pt-2 border-t border-zinc-800">
        <span className="text-zinc-500">Cumulative</span>
        <PnlText v={p.cumulative} />
      </div>
    </div>
  );
}

const GREEN = '#34d399';
const RED = '#fb7185';

function useZeroSplit(values: number[], target: number) {
  return useMemo(() => {
    const dataMin = Math.min(0, ...values);
    const dataMax = Math.max(0, ...values);
    const dataSpan = dataMax - dataMin || 1;
    // Only stretch the axis to fit the target if it's within a reasonable multiple of the
    // actual data range — a target far beyond typical weekly P&L would otherwise flatten the
    // real cumulative line into an unreadable sliver near the bottom of the chart.
    const targetOnChart = target > 0 && target <= dataMax + dataSpan * 2.5;
    const rawMin = dataMin;
    const rawMax = targetOnChart ? Math.max(dataMax, target) : dataMax;
    const span = rawMax - rawMin || 1;
    const pad = span * 0.12;
    const domainMin = rawMin - pad;
    const domainMax = rawMax + pad;
    const zeroOffsetPct = Math.min(100, Math.max(0, (domainMax / (domainMax - domainMin)) * 100));
    const targetOffChart = target > 0 && !targetOnChart;
    return { domainMin, domainMax, zeroOffsetPct, targetOffChart };
  }, [values, target]);
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function WeeklyTargetDashboard() {
  const [data, setData] = useState<TradeHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [segment, setSegment] = useState<Segment>('ALL');
  const [weekOffset, setWeekOffset] = useState(0);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);

  const [targetInput, setTargetInput] = useState('');
  const [editingTarget, setEditingTarget] = useState(false);
  const [weeklyTarget, setWeeklyTarget] = useState(0);
  const [savingTarget, setSavingTarget] = useState(false);
  const [targetSaveError, setTargetSaveError] = useState<string | null>(null);

  const fetchData = useCallback(() => {
    fetch('/api/portfolio-trades')
      .then(r => r.json())
      .then(resp => setData(resp))
      .catch(() => setData({ success: false, available: false }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    fetch('/api/portfolio-weekly-target')
      .then(r => r.json())
      .then(d => setWeeklyTarget(Number.isFinite(d?.weeklyTarget) ? d.weeklyTarget : 0))
      .catch(() => setWeeklyTarget(0));
  }, []);

  const { syncing, syncError, startSync } = useTradeSync(fetchData);

  const saveTarget = useCallback(async () => {
    const v = Number(targetInput);
    if (!Number.isFinite(v) || v < 0) return;
    setSavingTarget(true);
    setTargetSaveError(null);
    try {
      const res = await fetch('/api/portfolio-weekly-target', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weeklyTarget: v }),
      });
      const resp = await res.json();
      if (resp.success) {
        setWeeklyTarget(v);
        setEditingTarget(false);
      } else {
        setTargetSaveError(resp.error ?? 'Failed to save target');
      }
    } catch {
      setTargetSaveError('Network error — target not saved');
    } finally {
      setSavingTarget(false);
    }
  }, [targetInput]);

  const todayStr = useMemo(() => todayIstDateString(), []);

  const dailyPnl = useMemo(() => {
    if (segment === 'TRADING') {
      return mergeDailyPnl(data?.dailyPnlBySegment?.FNO ?? [], data?.dailyPnlBySegment?.COMMODITY ?? []);
    }
    if (segment === 'ALL') return data?.dailyPnl ?? [];
    return data?.dailyPnlBySegment?.[segment] ?? [];
  }, [data, segment]);

  const byDate = useMemo(() => new Map(dailyPnl.map(d => [d.date, d])), [dailyPnl]);

  // NSE holiday calendar (only covers fromDate..toDate, i.e. up to today) — used to tell
  // "market was closed" apart from "market was open, nothing traded" in the week table.
  const marketDatesSet = useMemo(() => new Set(data?.marketTradingDates ?? []), [data]);

  const tradesByDate = useMemo(() => {
    const m = new Map<string, TradeLogRow[]>();
    for (const t of data?.trades ?? []) {
      const arr = m.get(t.date);
      if (arr) arr.push(t); else m.set(t.date, [t]);
    }
    return m;
  }, [data]);

  // ─── Selected week bounds + clamping ───────────────────────────────────────

  const fromDate = data?.fromDate;
  const currentMonday = useMemo(() => mondayOfWeek(todayStr), [todayStr]);
  const minMonday = useMemo(
    () => (fromDate ? mondayOfWeek(fromDate) : currentMonday),
    [fromDate, currentMonday],
  );
  const minWeekOffset = useMemo(() => {
    const diffDays = (toUTCDate(currentMonday).getTime() - toUTCDate(minMonday).getTime()) / 86400000;
    return -Math.floor(diffDays / 7);
  }, [currentMonday, minMonday]);

  // Clamp here (derived, not stored) rather than in an effect — avoids an extra render pass
  // once `minWeekOffset` becomes known after data loads.
  const clampedWeekOffset = Math.min(0, Math.max(minWeekOffset, weekOffset));

  const weekStart = useMemo(() => addDaysUTC(currentMonday, clampedWeekOffset * 7), [currentMonday, clampedWeekOffset]);
  const weekDates = useMemo(() => Array.from({ length: 5 }, (_, i) => addDaysUTC(weekStart, i)), [weekStart]);
  const weekEnd = weekDates[4];
  const isCurrentWeek = clampedWeekOffset === 0;

  const weekLabel = useMemo(() => {
    const sameMonth = weekStart.slice(0, 7) === weekEnd.slice(0, 7);
    const endLabel = sameMonth ? weekEnd.slice(8, 10) : fmtShort(weekEnd);
    const year = weekEnd.slice(0, 4);
    return `${fmtShort(weekStart)} – ${endLabel}, ${year}`;
  }, [weekStart, weekEnd]);

  // ─── Weekly rows (zero-filled for days with no synced data) ───────────────

  const weekRows = useMemo(() => {
    let cumulative = 0;
    return weekDates.map((date, i) => {
      const pt = byDate.get(date);
      const grossPnl = pt?.grossPnl ?? 0;
      const netPnl = pt?.netPnl ?? 0;
      const charges = pt?.charges ?? 0;
      const tradeCount = pt?.tradeCount ?? 0;
      cumulative = round2(cumulative + netPnl);
      // A day is a known holiday only if it's already happened (calendar data doesn't extend
      // into the future) and the NSE calendar confirms the market was shut, not just untraded.
      const isHoliday = tradeCount === 0 && date <= todayStr && marketDatesSet.size > 0 && !marketDatesSet.has(date);
      return { date, day: DOW_LABELS[i], grossPnl, netPnl, charges, tradeCount, cumulative, isHoliday };
    });
  }, [weekDates, byDate, todayStr, marketDatesSet]);

  const holidaysThisWeek = weekRows.filter(r => r.isHoliday).length;

  const netWeekTotal = weekRows.length ? weekRows[weekRows.length - 1].cumulative : 0;
  const grossWeekTotal = round2(weekRows.reduce((s, r) => s + r.grossPnl, 0));
  const chargesWeekTotal = round2(weekRows.reduce((s, r) => s + r.charges, 0));
  const tradesWeekTotal = weekRows.reduce((s, r) => s + r.tradeCount, 0);
  const daysTraded = weekRows.filter(r => r.tradeCount > 0).length;
  const winDays = weekRows.filter(r => r.tradeCount > 0 && r.netPnl > 0).length;
  const winRate = daysTraded > 0 ? (winDays / daysTraded) * 100 : 0;

  const remaining = round2(weeklyTarget - netWeekTotal);
  const progressPct = weeklyTarget > 0 ? Math.max(0, (netWeekTotal / weeklyTarget) * 100) : 0;
  const targetHit = weeklyTarget > 0 && netWeekTotal >= weeklyTarget;

  const tradingDaysLeft = useMemo(() => {
    if (!isCurrentWeek) return 0;
    return weekDates.filter(d => d > todayStr).length;
  }, [isCurrentWeek, weekDates, todayStr]);

  const avgDailyNeeded = isCurrentWeek && remaining > 0 && tradingDaysLeft > 0 ? remaining / tradingDaysLeft : null;

  // The current week is only "in progress" through Friday — once today has passed the week's
  // last day (i.e. it's the weekend), treat it the same as a past, fully-closed week for display.
  const weekInProgress = isCurrentWeek && todayStr <= weekEnd;

  let bestDay: typeof weekRows[number] | null = null;
  let worstDay: typeof weekRows[number] | null = null;
  for (const r of weekRows) {
    if (r.tradeCount === 0) continue;
    if (!bestDay || r.netPnl > bestDay.netPnl) bestDay = r;
    if (!worstDay || r.netPnl < worstDay.netPnl) worstDay = r;
  }

  const chargesPctOfGross = grossWeekTotal !== 0 ? (chargesWeekTotal / Math.abs(grossWeekTotal)) * 100 : 0;

  // Unrealized P&L on currently-open positions, scoped to the same segment filter — this is a
  // live, present-moment figure (not attributable to any specific week), so it's only shown
  // alongside the current week and kept clearly separate from the realized weekly target math.
  const unrealizedTotal = useMemo(() => {
    const segs = data?.segments;
    if (!segs) return 0;
    if (segment === 'TRADING') return round2((segs.FNO?.openPositionsUnrealized ?? 0) + (segs.COMMODITY?.openPositionsUnrealized ?? 0));
    if (segment === 'ALL') return round2(Object.values(segs).reduce((s, v) => s + (v.openPositionsUnrealized ?? 0), 0));
    return round2(segs[segment]?.openPositionsUnrealized ?? 0);
  }, [data, segment]);

  const segmentSplit = useMemo(() => {
    const segs: { key: 'EQUITY' | 'FNO' | 'COMMODITY'; label: string }[] = [
      { key: 'EQUITY', label: 'Equity' },
      { key: 'FNO', label: 'F&O' },
      { key: 'COMMODITY', label: 'Commodity' },
    ];
    return segs.map(s => {
      const series = data?.dailyPnlBySegment?.[s.key] ?? [];
      const map = new Map(series.map(p => [p.date, p]));
      const netPnl = round2(weekDates.reduce((sum, d) => sum + (map.get(d)?.netPnl ?? 0), 0));
      const tradeCount = weekDates.reduce((sum, d) => sum + (map.get(d)?.tradeCount ?? 0), 0);
      return { ...s, netPnl, tradeCount };
    });
  }, [data, weekDates]);

  // ─── Weekly target streak (completed weeks only, same Mon-Fri grouping as the tracker) ────

  const completedWeeks = useMemo(() => {
    if (!fromDate) return [];
    const weeks: { start: string; end: string; netPnl: number }[] = [];
    let cursor = mondayOfWeek(fromDate);
    while (cursor < currentMonday) {
      let netPnl = 0;
      for (let i = 0; i < 5; i++) netPnl += byDate.get(addDaysUTC(cursor, i))?.netPnl ?? 0;
      weeks.push({ start: cursor, end: addDaysUTC(cursor, 4), netPnl: round2(netPnl) });
      cursor = addDaysUTC(cursor, 7);
    }
    return weeks;
  }, [fromDate, currentMonday, byDate]);

  const targetStreak = useMemo(() => {
    if (weeklyTarget <= 0 || completedWeeks.length === 0) return null;
    const withHit = completedWeeks.map(w => ({ ...w, hit: w.netPnl >= weeklyTarget }));
    const hitCount = withHit.filter(w => w.hit).length;
    let currentStreak = 0;
    for (let i = withHit.length - 1; i >= 0; i--) {
      if (withHit[i].hit) currentStreak++; else break;
    }
    let bestStreak = 0, run = 0;
    for (const w of withHit) { if (w.hit) { run++; bestStreak = Math.max(bestStreak, run); } else run = 0; }
    return { totalWeeks: withHit.length, hitCount, currentStreak, bestStreak, recent: withHit.slice(-10) };
  }, [completedWeeks, weeklyTarget]);

  const chartData = useMemo<ChartPoint[]>(
    () => weekRows.map(r => ({ date: r.date, day: r.day, netPnl: r.netPnl, cumulative: r.cumulative })),
    [weekRows],
  );
  const { domainMin, domainMax, zeroOffsetPct, targetOffChart } = useZeroSplit(chartData.map(p => p.cumulative), weeklyTarget);
  const fadeAbove = Math.max(0, zeroOffsetPct - 15);
  const fadeBelow = Math.min(100, zeroOffsetPct + 15);

  // Separate, tighter domain for the day-wise bar chart — individual day swings are much
  // smaller than the cumulative total, so sharing the cumulative chart's domain would flatten it.
  const barDomain = useMemo<[number, number]>(() => {
    const values = chartData.map(p => p.netPnl);
    const rawMin = Math.min(0, ...values);
    const rawMax = Math.max(0, ...values);
    const pad = (rawMax - rawMin || 1) * 0.15;
    return [rawMin - pad, rawMax + pad];
  }, [chartData]);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-20 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/25 shrink-0">
            <Target className="w-4 h-4 text-amber-400" />
          </div>
          <div>
            <p className="text-[9px] font-bold text-amber-500 uppercase tracking-[0.18em] mb-0.5">Portfolio · Weekly</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Weekly Target Tracker</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">Progress toward your recurring weekly profit goal</p>
          </div>
        </div>
        <NavBar />
        <div className="flex items-center gap-2 flex-wrap">
          {data?.toDate && (
            <span className="font-mono text-[10px] bg-zinc-900 text-zinc-400 px-2 py-1 rounded-lg border border-zinc-800">
              DATA: {data.toDate}
            </span>
          )}
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            {SEGMENTS.map(s => (
              <button
                key={s.key}
                onClick={() => setSegment(s.key)}
                aria-pressed={segment === s.key}
                className={cn(
                  'px-2 py-1 text-[10px] font-bold rounded-md transition-all',
                  segment === s.key ? 'bg-amber-500/15 text-amber-400 border border-amber-500/25' : 'text-zinc-500 hover:text-zinc-300 border border-transparent',
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-lg px-1 py-1">
            <button
              onClick={() => setWeekOffset(o => Math.max(minWeekOffset, o - 1))}
              disabled={clampedWeekOffset <= minWeekOffset}
              aria-label="Previous week"
              title="Previous week"
              className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-[11px] font-mono font-semibold text-zinc-200 px-2 min-w-[150px] text-center">{weekLabel}</span>
            <button
              onClick={() => setWeekOffset(o => Math.min(0, o + 1))}
              disabled={clampedWeekOffset >= 0}
              aria-label="Next week"
              title="Next week"
              className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <button
            onClick={startSync}
            disabled={syncing || !data?.available}
            title="Fetch new days' trades and update totals"
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
        </div>
      </div>

      <div className="w-full border-b border-zinc-900 bg-zinc-950/40 px-6 py-1.5 flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-zinc-600 uppercase tracking-wide">Related</span>
        <Link href="/portfolio" className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-amber-300 hover:border-amber-500/30 transition-all">Portfolio</Link>
        <Link href="/portfolio/diary" className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-amber-300 hover:border-amber-500/30 transition-all">Trader&apos;s Diary</Link>
        <Link href="/portfolio/trades" className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-amber-300 hover:border-amber-500/30 transition-all">Trade P&amp;L</Link>
      </div>

      {syncError && (
        <div className="mx-6 mt-3 px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">{syncError}</div>
      )}
      {targetSaveError && (
        <div className="mx-6 mt-3 px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">{targetSaveError}</div>
      )}

      <div className="flex-1 flex flex-col gap-4 px-6 py-5">
        {loading ? (
          <div className="flex flex-col items-center justify-center p-16 rounded-2xl border border-zinc-800 bg-zinc-900/60 min-h-[300px] gap-3">
            <RefreshCw className="h-6 w-6 text-amber-500 animate-spin" />
            <span className="text-zinc-600 text-xs">Loading weekly data…</span>
          </div>
        ) : !data?.available ? (
          <div className="flex flex-col items-center justify-center p-12 rounded-2xl border border-zinc-800 bg-zinc-900/60 min-h-[260px] gap-3">
            <Target className="h-8 w-8 text-zinc-700" />
            <p className="text-sm font-semibold text-zinc-300">No trade data yet</p>
            <p className="text-xs text-zinc-600 max-w-md text-center">Run a sync from the Trader&apos;s Diary or Reports page first.</p>
          </div>
        ) : (
          <>
            {/* Target bar */}
            <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
              <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <Target className="w-4 h-4 text-amber-400" />
                  <span className="text-xs font-bold text-zinc-300 uppercase tracking-wide">Weekly Target</span>
                  {editingTarget ? (
                    <div className="flex items-center gap-1.5 ml-2">
                      <input
                        autoFocus
                        type="number"
                        min={0}
                        value={targetInput}
                        onChange={e => setTargetInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveTarget(); if (e.key === 'Escape') setEditingTarget(false); }}
                        aria-label="Weekly target amount in rupees"
                        className="w-32 bg-zinc-950 border border-zinc-700 rounded-md px-2 py-1 text-xs font-mono text-white outline-none focus:border-amber-500/60"
                      />
                      <button onClick={saveTarget} disabled={savingTarget} aria-label="Save target" title="Save target" className="p-1 rounded-md bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25">
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => setEditingTarget(false)} aria-label="Cancel editing target" title="Cancel" className="p-1 rounded-md bg-zinc-800 text-zinc-400 hover:text-white">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setTargetInput(String(weeklyTarget)); setEditingTarget(true); }}
                      aria-label={`Edit weekly target, currently ${fmtINR(weeklyTarget)}`}
                      title="Edit weekly target"
                      className="flex items-center gap-1.5 ml-2 text-xs font-mono font-bold text-amber-300 hover:text-amber-200"
                    >
                      {fmtINR(weeklyTarget)}
                      <Pencil className="w-3 h-3 text-zinc-500" />
                    </button>
                  )}
                </div>
                <span className={cn('text-xs font-mono font-bold', targetHit ? 'text-emerald-400' : netWeekTotal < 0 ? 'text-red-400' : 'text-zinc-300')}>
                  {progressPct.toFixed(0)}% of target
                </span>
              </div>
              <div className="h-3 w-full rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className={cn('h-full rounded-full transition-all', targetHit ? 'bg-emerald-400' : netWeekTotal < 0 ? 'bg-red-400/70' : 'bg-amber-400')}
                  style={{ width: `${Math.min(100, Math.max(0, progressPct))}%` }}
                />
              </div>
              <div className="flex items-center justify-between mt-2 text-[10px] text-zinc-500 font-mono">
                <span>Net so far: <PnlText v={netWeekTotal} compact /></span>
                <span>{remaining > 0 ? `Remaining: ${fmtINR(remaining, true)}` : `Surplus: +${fmtINR(-remaining, true)}`}</span>
              </div>
            </div>

            {/* Stat ribbon */}
            <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60">
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-amber-500/[0.06] via-transparent to-emerald-500/[0.04]" />
              <div className="relative flex items-center gap-5 px-5 py-4 flex-wrap">
                <PulseStat label="Week Net P&L" value={fmtINR(netWeekTotal, true)} color={netWeekTotal >= 0 ? 'text-emerald-400' : 'text-red-400'} />
                <Divider />
                <PulseStat label="Target" value={fmtINR(weeklyTarget, true)} />
                <Divider />
                <PulseStat
                  label={remaining > 0 ? 'Remaining' : 'Surplus'}
                  value={fmtINR(Math.abs(remaining), true)}
                  color={remaining > 0 ? 'text-zinc-300' : 'text-emerald-400'}
                />
                <Divider />
                <PulseStat
                  label="Days Traded"
                  value={`${daysTraded}/5`}
                  sub={[
                    weekInProgress ? `${tradingDaysLeft} left` : 'week closed',
                    holidaysThisWeek > 0 ? `${holidaysThisWeek} holiday${holidaysThisWeek > 1 ? 's' : ''}` : null,
                  ].filter(Boolean).join(' · ')}
                />
                <Divider />
                <PulseStat label="Charges" value={fmtINR(chargesWeekTotal, true)} color="text-purple-400" sub={`${chargesPctOfGross.toFixed(1)}% of gross`} />
                <Divider />
                <PulseStat label="Trades" value={String(tradesWeekTotal)} />
                {isCurrentWeek && unrealizedTotal !== 0 && (
                  <>
                    <Divider />
                    <PulseStat
                      label="Open Positions"
                      value={fmtINR(unrealizedTotal, true)}
                      color={unrealizedTotal >= 0 ? 'text-emerald-400' : 'text-red-400'}
                      sub="unrealized, not counted toward target"
                    />
                  </>
                )}
                {avgDailyNeeded !== null && (
                  <>
                    <Divider />
                    <PulseStat label="Needed / Day Left" value={fmtINR(avgDailyNeeded, true)} color="text-amber-300" />
                  </>
                )}
              </div>
            </div>

            {/* Cumulative + day-wise charts */}
            <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
                <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                  <div>
                    <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] mb-1">This Week</p>
                    <p className="text-sm font-bold text-white tracking-tight">Cumulative Net P&amp;L vs Target</p>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] font-semibold">
                    {targetOffChart ? (
                      <span className="flex items-center gap-1.5 text-amber-500/80" title="Target is far above this week's typical range, so the axis isn't stretched to fit it">
                        <ArrowUp className="w-3 h-3" /> Target {fmtINR(weeklyTarget, true)} · {fmtINR(remaining, true)} away (off-chart)
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-zinc-400"><span className="w-2.5 h-0.5 bg-amber-400 inline-block" /> Target</span>
                    )}
                    <span className="flex items-center gap-1.5 text-zinc-400"><span className="w-2.5 h-0.5 bg-zinc-600 inline-block" /> Breakeven</span>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                    <defs>
                      <linearGradient id="wtFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={GREEN} stopOpacity={0.35} />
                        <stop offset={`${fadeAbove}%`} stopColor={GREEN} stopOpacity={0.04} />
                        <stop offset={`${zeroOffsetPct}%`} stopColor={GREEN} stopOpacity={0} />
                        <stop offset={`${zeroOffsetPct}%`} stopColor={RED} stopOpacity={0} />
                        <stop offset={`${fadeBelow}%`} stopColor={RED} stopOpacity={0.04} />
                        <stop offset="100%" stopColor={RED} stopOpacity={0.35} />
                      </linearGradient>
                      <linearGradient id="wtStroke" x1="0" y1="0" x2="0" y2="1">
                        <stop offset={`${zeroOffsetPct}%`} stopColor={GREEN} />
                        <stop offset={`${zeroOffsetPct}%`} stopColor={RED} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 6" stroke="#20202399" vertical={false} />
                    <XAxis
                      dataKey="day"
                      tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                      axisLine={{ stroke: '#3f3f46' }}
                      tickLine={false}
                    />
                    <YAxis
                      domain={[domainMin, domainMax]}
                      tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                      axisLine={false}
                      tickLine={false}
                      width={64}
                      tickFormatter={(v: number) => fmtINR(v, true)}
                    />
                    <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }} />
                    <ReferenceLine y={0} stroke="#52525b" strokeDasharray="3 3" />
                    {weeklyTarget > 0 && !targetOffChart && (
                      <ReferenceLine y={weeklyTarget} stroke="#f59e0b" strokeDasharray="6 3" label={{ value: 'Target', position: 'insideTopRight', fill: '#f59e0b', fontSize: 10, fontWeight: 700 }} />
                    )}
                    <Area
                      type="monotone"
                      dataKey="cumulative"
                      name="Cumulative"
                      stroke="url(#wtStroke)"
                      strokeWidth={2}
                      fill="url(#wtFill)"
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
                <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                  <div>
                    <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] mb-1">This Week</p>
                    <p className="text-sm font-bold text-white tracking-tight">Day-wise Net P&amp;L</p>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] font-semibold">
                    <span className="flex items-center gap-1.5 text-zinc-400"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-400 inline-block" /> Profit</span>
                    <span className="flex items-center gap-1.5 text-zinc-400"><span className="w-2.5 h-2.5 rounded-sm bg-rose-400 inline-block" /> Loss</span>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 6" stroke="#20202399" vertical={false} />
                    <XAxis
                      dataKey="day"
                      tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                      axisLine={{ stroke: '#3f3f46' }}
                      tickLine={false}
                    />
                    <YAxis
                      domain={barDomain}
                      tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                      axisLine={false}
                      tickLine={false}
                      width={64}
                      tickFormatter={(v: number) => fmtINR(v, true)}
                    />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: '#27272a', opacity: 0.5 }} />
                    <ReferenceLine y={0} stroke="#52525b" strokeDasharray="3 3" />
                    <Bar dataKey="netPnl" name="Net P&L" radius={[4, 4, 4, 4]} isAnimationActive={false}>
                      {chartData.map(p => (
                        <Cell key={p.date} fill={p.netPnl >= 0 ? GREEN : RED} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Daily table */}
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
              <div className="px-5 py-4">
                <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] mb-1">Daily Breakdown</p>
                <p className="text-sm font-bold text-white tracking-tight">P&amp;L Table — {weekLabel}</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-zinc-800">
                    <tr>
                      <th className="text-xs font-bold text-white px-3 py-2 w-6" />
                      <th className="text-xs font-bold text-white px-3 py-2">Day</th>
                      <th className="text-xs font-bold text-white px-3 py-2">Date</th>
                      <th className="text-xs font-bold text-white px-3 py-2 text-right">Trades</th>
                      <th className="text-xs font-bold text-white px-3 py-2 text-right">Gross P&amp;L</th>
                      <th className="text-xs font-bold text-white px-3 py-2 text-right">Charges</th>
                      <th className="text-xs font-bold text-white px-3 py-2 text-right">Net P&amp;L</th>
                      <th className="text-xs font-bold text-white px-3 py-2 text-right">Cumulative</th>
                      <th className="text-xs font-bold text-white px-3 py-2 text-right">% of Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weekRows.map(row => {
                      const fills = tradesByDate.get(row.date) ?? [];
                      const isExpanded = expandedDate === row.date;
                      const isToday = row.date === todayStr;
                      const pctOfTarget = weeklyTarget > 0 ? (row.cumulative / weeklyTarget) * 100 : 0;
                      return (
                        <React.Fragment key={row.date}>
                          <tr
                            className={cn('border-t border-zinc-800/80 hover:bg-zinc-800/30 transition-colors', isToday && 'bg-amber-500/[0.04]')}
                          >
                            <td className="px-3 py-2">
                              {fills.length > 0 && (
                                <button
                                  onClick={() => setExpandedDate(isExpanded ? null : row.date)}
                                  aria-label={isExpanded ? `Collapse fills for ${row.date}` : `Show fills for ${row.date}`}
                                  aria-expanded={isExpanded}
                                  title={isExpanded ? 'Collapse fills' : 'Show fills'}
                                  className="text-zinc-500 hover:text-white"
                                >
                                  {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                                </button>
                              )}
                            </td>
                            <td className="px-3 py-2 text-[12px] font-semibold text-zinc-300">
                              {row.day}{isToday && <span className="ml-1.5 text-[9px] font-bold text-amber-400 uppercase">Today</span>}
                            </td>
                            <td className="px-3 py-2 text-[12px] text-zinc-400 font-mono">{row.date}</td>
                            {row.isHoliday ? (
                              <td colSpan={4} className="px-3 py-2 text-[11px] text-zinc-600 italic text-center">Market Holiday</td>
                            ) : (
                              <>
                                <td className="px-3 py-2 text-[12px] text-right text-zinc-300 tabular-nums">{row.tradeCount || '—'}</td>
                                <td className="px-3 py-2 text-[12px] text-right">{row.tradeCount ? <PnlText v={row.grossPnl} compact /> : <span className="text-zinc-600">—</span>}</td>
                                <td className="px-3 py-2 text-[12px] text-right text-zinc-400 tabular-nums">{row.tradeCount ? fmtINR(row.charges, true) : '—'}</td>
                                <td className="px-3 py-2 text-[12px] text-right">{row.tradeCount ? <PnlText v={row.netPnl} compact /> : <span className="text-zinc-600">—</span>}</td>
                              </>
                            )}
                            <td className="px-3 py-2 text-[12px] text-right"><PnlText v={row.cumulative} compact /></td>
                            <td className="px-3 py-2 text-[12px] text-right text-zinc-400 tabular-nums">{weeklyTarget > 0 ? `${pctOfTarget.toFixed(0)}%` : '—'}</td>
                          </tr>
                          {isExpanded && fills.length > 0 && (
                            <tr className="bg-zinc-950/60 border-t border-zinc-800/60">
                              <td colSpan={9} className="px-4 py-3">
                                <table className="w-full text-left">
                                  <thead className="bg-zinc-800">
                                    <tr>
                                      <th className="text-xs font-bold text-white px-2 py-1">Time</th>
                                      <th className="text-xs font-bold text-white px-2 py-1">Segment</th>
                                      <th className="text-xs font-bold text-white px-2 py-1">Symbol</th>
                                      <th className="text-xs font-bold text-white px-2 py-1">Side</th>
                                      <th className="text-xs font-bold text-white px-2 py-1 text-right">Qty</th>
                                      <th className="text-xs font-bold text-white px-2 py-1 text-right">Price</th>
                                      <th className="text-xs font-bold text-white px-2 py-1 text-right">Charges</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {fills.map((f, i) => (
                                      <tr key={i} className="border-t border-zinc-800/40">
                                        <td className="px-2 py-1 text-[11px] text-zinc-400 font-mono">{f.time?.slice(11, 19) ?? f.time}</td>
                                        <td className="px-2 py-1 text-[11px] text-zinc-400">{f.segment}</td>
                                        <td className="px-2 py-1 text-[11px] text-zinc-200 font-medium">{f.symbol}</td>
                                        <td className={cn('px-2 py-1 text-[11px] font-bold', f.transactionType === 'BUY' ? 'text-emerald-400' : 'text-red-400')}>{f.transactionType}</td>
                                        <td className="px-2 py-1 text-[11px] text-right text-zinc-300 tabular-nums">{f.quantity}</td>
                                        <td className="px-2 py-1 text-[11px] text-right text-zinc-300 tabular-nums">{fmtINR(f.price)}</td>
                                        <td className="px-2 py-1 text-[11px] text-right text-zinc-400 tabular-nums">{fmtINR(f.charges)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-zinc-700 bg-zinc-900">
                      <td className="px-3 py-2" />
                      <td colSpan={2} className="px-3 py-2 text-[12px] font-bold text-zinc-200">Week Total</td>
                      <td className="px-3 py-2 text-[12px] text-right font-bold text-zinc-200 tabular-nums">{tradesWeekTotal}</td>
                      <td className="px-3 py-2 text-[12px] text-right"><PnlText v={grossWeekTotal} compact /></td>
                      <td className="px-3 py-2 text-[12px] text-right font-bold text-zinc-300 tabular-nums">{fmtINR(chargesWeekTotal, true)}</td>
                      <td className="px-3 py-2 text-[12px] text-right"><PnlText v={netWeekTotal} compact /></td>
                      <td className="px-3 py-2 text-[12px] text-right"><PnlText v={netWeekTotal} compact /></td>
                      <td className="px-3 py-2 text-[12px] text-right font-bold text-zinc-300 tabular-nums">{weeklyTarget > 0 ? `${progressPct.toFixed(0)}%` : '—'}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Detailed summary */}
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
                <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] mb-3">Segment Split</p>
                <div className="flex flex-col gap-2.5">
                  {segmentSplit.map(s => (
                    <div key={s.key} className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-zinc-400">{s.label}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-zinc-600 tabular-nums">{s.tradeCount} trades</span>
                        <PnlText v={s.netPnl} compact />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
                <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] mb-3">Best / Worst Day</p>
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-zinc-400 flex items-center gap-1.5"><Trophy className="w-3 h-3 text-emerald-400" /> Best</span>
                    {bestDay ? <PnlText v={bestDay.netPnl} compact /> : <span className="text-[11px] text-zinc-600">—</span>}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-zinc-400 flex items-center gap-1.5"><Skull className="w-3 h-3 text-red-400" /> Worst</span>
                    {worstDay ? <PnlText v={worstDay.netPnl} compact /> : <span className="text-[11px] text-zinc-600">—</span>}
                  </div>
                  <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
                    <span className="text-[11px] font-semibold text-zinc-400 flex items-center gap-1.5"><Flame className="w-3 h-3 text-amber-400" /> Win Rate</span>
                    <span className="text-[11px] font-mono font-bold text-zinc-200">{winRate.toFixed(0)}%</span>
                  </div>
                </div>
              </div>

              <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
                <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] mb-3">Charges</p>
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-zinc-400">Total Charges</span>
                    <span className="text-[11px] font-mono font-bold text-purple-400">{fmtINR(chargesWeekTotal, true)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-zinc-400">% of Gross P&amp;L</span>
                    <span className="text-[11px] font-mono font-bold text-zinc-200">{chargesPctOfGross.toFixed(1)}%</span>
                  </div>
                  <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
                    <span className="text-[11px] font-semibold text-zinc-400">Gross → Net</span>
                    <span className="text-[11px] font-mono text-zinc-500">{fmtINR(grossWeekTotal, true)} → {fmtINR(netWeekTotal, true)}</span>
                  </div>
                </div>
              </div>

              <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
                <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] mb-3">Target Streak</p>
                {!targetStreak ? (
                  <p className="text-[11px] text-zinc-600">
                    {weeklyTarget <= 0 ? 'Set a target to track your streak.' : 'No completed weeks yet.'}
                  </p>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-zinc-400 flex items-center gap-1.5"><Zap className="w-3 h-3 text-amber-400" /> Current Streak</span>
                      <span className="text-[11px] font-mono font-bold text-zinc-200">{targetStreak.currentStreak} week{targetStreak.currentStreak === 1 ? '' : 's'}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-zinc-400">Best Streak</span>
                      <span className="text-[11px] font-mono font-bold text-zinc-200">{targetStreak.bestStreak} week{targetStreak.bestStreak === 1 ? '' : 's'}</span>
                    </div>
                    <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
                      <span className="text-[11px] font-semibold text-zinc-400">Hit Rate</span>
                      <span className="text-[11px] font-mono font-bold text-zinc-200">{targetStreak.hitCount}/{targetStreak.totalWeeks} weeks</span>
                    </div>
                    <div className="flex items-center gap-1 pt-1">
                      {targetStreak.recent.map(w => (
                        <div
                          key={w.start}
                          title={`${fmtShort(w.start)} – ${fmtShort(w.end)}: ${fmtINR(w.netPnl, true)}${w.hit ? ' (target hit)' : ''}`}
                          className={cn('w-4 h-4 rounded-sm', w.hit ? 'bg-emerald-500' : 'bg-zinc-700')}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
