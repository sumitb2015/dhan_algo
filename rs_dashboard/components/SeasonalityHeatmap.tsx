'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  CalendarRange, RefreshCw, Layers, BarChart2, TrendingUp, TrendingDown,
  Award, ShieldAlert, Sparkles, Calendar, ArrowUpRight, ArrowDownRight, Compass
} from 'lucide-react';
import {
  BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell
} from 'recharts';
import type { SeasonalityResponse, SeasonalityCell, MonthStat } from '@/app/api/seasonality/route';
import type { SymbolsResponse, IndexOption } from '@/app/api/symbols/route';
import { NIFTY50_SYMBOLS } from '@/lib/nifty50';
import { cn } from '@/lib/utils';
import NavBar from './NavBar';
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from './ui/combobox';

// ─── Popular Quick-Pick Symbols ─────────────────────────────────────────────
const POPULAR_SYMBOLS = [
  { label: 'Nifty 50', key: 'NIFTY50' },
  { label: 'Bank Nifty', key: 'BANKNIFTY' },
  { label: 'Nifty IT', key: 'NIFTYIT' },
  { label: 'Nifty 500', key: 'NIFTY_500' },
  { label: 'Reliance', key: 'RELIANCE' },
  { label: 'HDFC Bank', key: 'HDFCBANK' },
  { label: 'ICICI Bank', key: 'ICICIBANK' },
  { label: 'TCS', key: 'TCS' },
  { label: 'Infosys', key: 'INFY' },
  { label: 'ITC', key: 'ITC' },
];

// ─── Formatters & Helpers ───────────────────────────────────────────────────
function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return '—';
  return (v >= 0 ? '+' : '') + fmt(v, digits) + '%';
}

function fmtDate(d: string): string {
  return new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

// ─── Color & Scale Utilities ────────────────────────────────────────────────
const SCALE_CAP = 12; // % change at which the cell reaches full saturation

function getHeatmapBg(value: number | null): React.CSSProperties {
  if (value === null) return { backgroundColor: 'rgba(39, 39, 42, 0.4)' }; // zinc-800
  const alpha = Math.min(Math.abs(value) / SCALE_CAP, 1);
  const rgb = value >= 0 ? '16, 185, 129' : '239, 68, 68'; // emerald-500 / red-500
  return { backgroundColor: `rgba(${rgb}, ${(alpha * 0.82 + 0.10).toFixed(3)})` };
}

function getHeatmapTextClass(value: number | null): string {
  if (value === null) return 'text-zinc-600';
  const alpha = Math.min(Math.abs(value) / SCALE_CAP, 1);
  if (alpha > 0.45) return 'text-white font-bold';
  return value >= 0 ? 'text-emerald-300 font-bold' : 'text-red-300 font-bold';
}

function getWinRateBadgeClass(rate: number): string {
  if (rate >= 70) return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
  if (rate >= 50) return 'bg-lime-500/15 text-lime-400 border-lime-500/30';
  if (rate >= 40) return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
  return 'bg-red-500/15 text-red-400 border-red-500/30';
}

// ─── Quant-Terminal Pulse Stat Component ────────────────────────────────────
function PulseStat({
  label, value, sub, color = 'text-zinc-100', size = 'text-xl', icon: Icon, badge,
}: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; color?: string; size?: string; icon?: React.ElementType; badge?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col min-w-0">
      <div className="flex items-center justify-between gap-1 mb-1">
        <div className="flex items-center gap-1.5 text-[9px] font-bold text-zinc-500 uppercase tracking-[0.14em]">
          {Icon && <Icon className="w-3 h-3 text-zinc-400" />}
          <span>{label}</span>
        </div>
        {badge}
      </div>
      <span className={cn(size, 'font-mono font-bold tabular-nums leading-none', color)}>{value}</span>
      {sub && <span className="text-[10px] text-zinc-400 mt-1 font-medium">{sub}</span>}
    </div>
  );
}

// ─── Card Panel Wrapper ─────────────────────────────────────────────────────
function CardPanel({
  title, eyebrow, count, icon: Icon, accent = 'text-emerald-400', children,
  className, headerRight,
}: {
  title: string; eyebrow?: string; count?: number | string; icon?: React.ElementType;
  accent?: string; children: React.ReactNode; className?: string;
  headerRight?: React.ReactNode;
}) {
  return (
    <div className={cn('bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden flex flex-col', className)}>
      <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-zinc-800 bg-zinc-950/40 shrink-0">
        <div className="flex items-center gap-2.5">
          {Icon && (
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-zinc-900 border border-zinc-700/60 shrink-0">
              <Icon className={cn('h-3.5 w-3.5', accent)} />
            </div>
          )}
          <div>
            {eyebrow && (
              <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] leading-none mb-0.5">
                {eyebrow}
              </p>
            )}
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-zinc-100 tracking-tight leading-none">{title}</h3>
              {count !== undefined && (
                <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
                  {count}
                </span>
              )}
            </div>
          </div>
        </div>
        {headerRight && <div className="flex items-center gap-2">{headerRight}</div>}
      </div>

      <div className="overflow-x-auto flex-1">
        {children}
      </div>
    </div>
  );
}

// ─── Custom Recharts Tooltips ───────────────────────────────────────────────
interface MonthBarTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; payload: MonthStat }>;
  label?: string;
}

function MonthBarTooltip({ active, payload, label }: MonthBarTooltipProps) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0].payload;

  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[220px] font-mono">
      <p className="text-zinc-100 font-bold mb-2 font-sans text-sm">{label || d.month} Seasonality</p>
      <div className="flex justify-between gap-6 mb-1 text-zinc-400 font-sans">
        <span>Average Return</span>
        <span className={cn('font-bold font-mono', (d.avgReturn ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
          {fmtPct(d.avgReturn)}
        </span>
      </div>
      <div className="flex justify-between gap-6 mb-1 text-zinc-400 font-sans">
        <span>Median Return</span>
        <span className={cn('font-bold font-mono', (d.medianReturn ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
          {fmtPct(d.medianReturn)}
        </span>
      </div>
      <div className="flex justify-between gap-6 mb-1 text-zinc-400 font-sans">
        <span>Win Rate</span>
        <span className="text-zinc-100 font-bold font-mono">{d.winRate}% ({d.positiveCount}/{d.totalCount})</span>
      </div>
      <div className="pt-2 border-t border-zinc-800 flex justify-between gap-6 mb-1 text-zinc-400 font-sans">
        <span>Best Year</span>
        <span className="text-emerald-400 font-bold font-mono">
          {d.bestYear ? `${d.bestYear.year} (${fmtPct(d.bestYear.returnPct)})` : '—'}
        </span>
      </div>
      <div className="flex justify-between gap-6 text-zinc-400 font-sans">
        <span>Worst Year</span>
        <span className="text-red-400 font-bold font-mono">
          {d.worstYear ? `${d.worstYear.year} (${fmtPct(d.worstYear.returnPct)})` : '—'}
        </span>
      </div>
    </div>
  );
}

// ─── Main Seasonality Component ─────────────────────────────────────────────
export default function SeasonalityHeatmap() {
  const [symbol, setSymbol] = useState('NIFTY50');
  const [activeTab, setActiveTab] = useState<'matrix' | 'charts' | 'quarterly'>('matrix');
  const [data, setData] = useState<SeasonalityResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [indices, setIndices] = useState<IndexOption[]>([]);
  const [hoveredYear, setHoveredYear] = useState<number | null>(null);
  const [hoveredMonthIdx, setHoveredMonthIdx] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/symbols')
      .then((res) => res.json())
      .then((json: SymbolsResponse) => {
        if (json.success) setIndices(json.indices);
      })
      .catch(() => {});
  }, []);

  const indexLabelToKey = useMemo(() => new Map(indices.map((i) => [i.label, i.key])), [indices]);
  const indexKeyToLabel = useMemo(() => new Map(indices.map((i) => [i.key, i.label])), [indices]);
  const comboItems = useMemo(() => [...indices.map((i) => i.label), ...NIFTY50_SYMBOLS], [indices]);
  const displayValue = indexKeyToLabel.get(symbol) ?? symbol;

  const fetchData = useCallback(async (sym: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/seasonality?symbol=${encodeURIComponent(sym)}`);
      const json = await res.json();
      if (json.success) {
        setData(json.data);
      } else {
        setError(json.error || 'Failed to load seasonality data');
        setData(null);
      }
    } catch {
      setError('Failed to load seasonality data');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(symbol);
  }, [symbol, fetchData]);

  // ─── Analytical Insights Derived ──────────────────────────────────────────
  const bestMonth = useMemo(() => {
    if (!data || !data.monthStats.length) return null;
    return [...data.monthStats].filter(m => m.avgReturn !== null).sort((a, b) => b.avgReturn! - a.avgReturn!)[0];
  }, [data]);

  const worstMonth = useMemo(() => {
    if (!data || !data.monthStats.length) return null;
    return [...data.monthStats].filter(m => m.avgReturn !== null).sort((a, b) => a.avgReturn! - b.avgReturn!)[0];
  }, [data]);

  const currentMonthIdx = new Date().getMonth(); // 0-11
  const currentMonthStat = data?.monthStats[currentMonthIdx];

  const bestQuarter = useMemo(() => {
    if (!data || !data.quarterlyStats.length) return null;
    return [...data.quarterlyStats].sort((a, b) => b.avgReturn - a.avgReturn)[0];
  }, [data]);

  const overallWinRate = useMemo(() => {
    if (!data) return 0;
    let totalCells = 0;
    let positiveCells = 0;
    data.matrix.forEach(row => {
      row.forEach(cell => {
        if (cell.value !== null) {
          totalCells++;
          if (cell.value > 0) positiveCells++;
        }
      });
    });
    return totalCells > 0 ? +((positiveCells / totalCells) * 100).toFixed(1) : 0;
  }, [data]);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      {/* ─── Sticky Header ───────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25 shrink-0">
            <CalendarRange className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <p className="text-[9px] font-bold text-emerald-500 uppercase tracking-[0.18em] mb-0.5">
              Analytics · Historical Seasonality
            </p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">
              Seasonality Heatmap &amp; Calendar Cycles
            </h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              Monthly returns matrix, win-rate consistency, quarterly rotation &amp; seasonal compounding
            </p>
          </div>
        </div>

        <NavBar />

        {/* Global Controls */}
        <div className="flex items-center gap-2.5 flex-wrap ml-auto">
          {/* Symbol Search Combobox */}
          <div className="w-56">
            <Combobox
              items={comboItems}
              value={displayValue}
              onValueChange={(v) => v && setSymbol(indexLabelToKey.get(v) ?? v)}
            >
              <ComboboxInput
                placeholder="Search stock or index…"
                className="w-full bg-zinc-900 border border-zinc-800 text-xs font-semibold text-zinc-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500"
              />
              <ComboboxContent className="bg-zinc-950 border border-zinc-800 shadow-2xl">
                <ComboboxEmpty className="text-zinc-500 text-xs py-3 text-center">No matching symbol</ComboboxEmpty>
                <ComboboxList>
                  {(item: string) => (
                    <ComboboxItem
                      key={item}
                      value={item}
                      className="text-xs font-mono text-zinc-200 hover:bg-zinc-900 hover:text-white cursor-pointer py-1.5 px-2.5 rounded"
                    >
                      <span>{item}</span>
                      {indexLabelToKey.has(item) && (
                        <span className="ml-auto text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                          INDEX
                        </span>
                      )}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </div>

          {/* Data Date Chip */}
          {data?.dataDate && (
            <span className="text-[10px] font-mono font-bold text-amber-300 px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 uppercase tracking-wide">
              DATA: {data.dataDate}
            </span>
          )}

          {/* Manual Refresh */}
          <button
            onClick={() => fetchData(symbol)}
            disabled={loading}
            className="h-8 w-8 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-emerald-400 hover:border-emerald-500/40 transition-colors disabled:opacity-50"
            title="Refresh seasonality data"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin text-emerald-400')} />
          </button>
        </div>
      </header>

      {/* ─── Main Content Body ────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col gap-4 px-6 py-5">
        {/* Quick-Pick Popular Symbols Bar */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider shrink-0 mr-1 flex items-center gap-1">
            <Compass className="w-3 h-3" /> Quick Picks:
          </span>
          {POPULAR_SYMBOLS.map((item) => {
            const isSelected = symbol === item.key || displayValue === item.label;
            return (
              <button
                key={item.key}
                onClick={() => setSymbol(item.key)}
                className={cn(
                  'px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors shrink-0 font-mono',
                  isSelected
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                    : 'bg-zinc-900/80 text-zinc-400 border border-zinc-800 hover:text-zinc-200 hover:border-zinc-700'
                )}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {/* Error Alert */}
        {error && (
          <div className="p-4 rounded-xl border border-red-500/30 bg-red-950/20 text-red-400 text-xs font-mono">
            {error}
          </div>
        )}

        {/* Loading Spinner */}
        {loading && !data && (
          <div className="flex flex-col items-center justify-center py-28 gap-3">
            <div className="w-8 h-8 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
            <p className="text-sm text-zinc-400 font-medium">Computing historical seasonality for {displayValue}…</p>
          </div>
        )}

        {!loading && data && (
          <>
            {/* ─── Seasonality Pulse Ribbon ────────────────────────────── */}
            <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-emerald-500/[0.06] via-transparent to-lime-500/[0.04]" />

              <div className="relative grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-5">
                {/* 1. Best Performing Month */}
                <PulseStat
                  label="Best Month"
                  value={bestMonth ? `${bestMonth.month}` : '—'}
                  color="text-emerald-400"
                  sub={bestMonth ? `Avg ${fmtPct(bestMonth.avgReturn)} · ${bestMonth.winRate}% win` : undefined}
                  icon={Award}
                />

                {/* 2. Worst Performing Month */}
                <PulseStat
                  label="Worst Month"
                  value={worstMonth ? `${worstMonth.month}` : '—'}
                  color="text-red-400"
                  sub={worstMonth ? `Avg ${fmtPct(worstMonth.avgReturn)} · ${worstMonth.winRate}% win` : undefined}
                  icon={ShieldAlert}
                />

                {/* 3. Current Month Track Record */}
                <PulseStat
                  label={`Current Month (${data.months[currentMonthIdx]})`}
                  value={currentMonthStat ? fmtPct(currentMonthStat.avgReturn) : '—'}
                  color={(currentMonthStat?.avgReturn ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}
                  sub={currentMonthStat ? `${currentMonthStat.winRate}% positive (${currentMonthStat.positiveCount}/${currentMonthStat.totalCount} yrs)` : undefined}
                  icon={Calendar}
                />

                {/* 4. Best Quarter */}
                <PulseStat
                  label="Top Quarter"
                  value={bestQuarter ? `${bestQuarter.quarter}` : '—'}
                  color="text-lime-300"
                  sub={bestQuarter ? `Avg ${fmtPct(bestQuarter.avgReturn)} · ${bestQuarter.winRate}% win` : undefined}
                  icon={Sparkles}
                />

                {/* 5. Overall Month Win Rate */}
                <PulseStat
                  label="Positive Months"
                  value={`${overallWinRate}%`}
                  color={overallWinRate >= 50 ? 'text-emerald-400' : 'text-amber-400'}
                  sub="Across all historical calendar months"
                  icon={TrendingUp}
                />

                {/* 6. Dataset Depth */}
                <PulseStat
                  label="History Depth"
                  value={`${data.years.length} Years`}
                  color="text-zinc-200"
                  sub={`${data.years[data.years.length - 1]} → ${data.years[0]}`}
                  icon={Layers}
                />
              </div>
            </div>

            {/* ─── View Mode Switcher ──────────────────────────────────── */}
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2 flex-wrap">
              <div className="flex items-center bg-zinc-900 border border-zinc-800 p-1 rounded-xl gap-1">
                {[
                  { id: 'matrix', label: 'Monthly Heatmap Matrix', icon: CalendarRange },
                  { id: 'charts', label: 'Month Statistics & Consistency', icon: BarChart2 },
                  { id: 'quarterly', label: 'Quarterly Cycles & Compounding', icon: Layers },
                ].map(tab => {
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id as typeof activeTab)}
                      className={cn(
                        'flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all',
                        isActive
                          ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-sm'
                          : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
                      )}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Heatmap Legend */}
              <div className="flex items-center gap-3 text-xs text-zinc-400">
                <span className="text-[11px] font-medium text-red-400">-12%+ (Loss)</span>
                <div className="flex h-3 w-32 rounded-full overflow-hidden border border-zinc-800">
                  <div className="flex-1" style={{ background: 'linear-gradient(to right, rgba(239, 68, 68, 0.95), rgba(239, 68, 68, 0.1))' }} />
                  <div className="flex-1" style={{ background: 'linear-gradient(to right, rgba(16, 185, 129, 0.1), rgba(16, 185, 129, 0.95))' }} />
                </div>
                <span className="text-[11px] font-medium text-emerald-400">+12%+ (Gain)</span>
              </div>
            </div>

            {/* ─── TAB 1: MONTHLY HEATMAP MATRIX ───────────────────────── */}
            {activeTab === 'matrix' && (
              <CardPanel
                title={`Historical Monthly Returns Matrix — ${displayValue}`}
                eyebrow="Year-by-Year Calendar Heatmap"
                icon={CalendarRange}
                accent="text-emerald-400"
              >
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse font-mono text-xs">
                    <thead>
                      <tr>
                        <th className="py-2.5 px-3 text-xs font-bold text-white bg-zinc-800 uppercase tracking-wider text-left sticky left-0 z-20 border-b border-zinc-700 min-w-[75px]">
                          Year
                        </th>
                        {data.months.map((m, mIdx) => (
                          <th
                            key={m}
                            onMouseEnter={() => setHoveredMonthIdx(mIdx)}
                            onMouseLeave={() => setHoveredMonthIdx(null)}
                            className={cn(
                              'py-2.5 px-3 text-xs font-bold text-white uppercase tracking-wider text-center border-b border-zinc-700 min-w-[70px] transition-colors',
                              hoveredMonthIdx === mIdx ? 'bg-zinc-700' : 'bg-zinc-800'
                            )}
                          >
                            {m}
                          </th>
                        ))}
                        <th className="py-2.5 px-3 text-xs font-bold text-white bg-zinc-800 uppercase tracking-wider text-right border-b border-zinc-700 min-w-[95px]">
                          Full Year
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.years.map((year, yIdx) => {
                        const yr = data.yearReturns[yIdx];
                        const isRowHovered = hoveredYear === year;

                        return (
                          <tr
                            key={year}
                            onMouseEnter={() => setHoveredYear(year)}
                            onMouseLeave={() => setHoveredYear(null)}
                            className={cn('border-b border-zinc-900 transition-colors', isRowHovered && 'bg-zinc-800/30')}
                          >
                            {/* Year label */}
                            <td className="py-2.5 px-3 font-bold text-zinc-100 sticky left-0 z-10 bg-zinc-950 border-r border-zinc-800/60 tabular-nums">
                              {year}
                            </td>

                            {/* 12 Months cells */}
                            {data.matrix[yIdx].map((cell, mIdx) => {
                              const isColHovered = hoveredMonthIdx === mIdx;
                              const isIntersected = isRowHovered || isColHovered;

                              return (
                                <td
                                  key={mIdx}
                                  style={getHeatmapBg(cell.value)}
                                  title={cell.startDate && cell.endDate
                                    ? `${fmtDate(cell.startDate)} (₹${cell.startClose ? fmt(cell.startClose, 2) : '—'}) → ${fmtDate(cell.endDate)} (₹${cell.endClose ? fmt(cell.endClose, 2) : '—'}): ${fmtPct(cell.value)}`
                                    : undefined}
                                  onMouseEnter={() => { setHoveredYear(year); setHoveredMonthIdx(mIdx); }}
                                  className={cn(
                                    'py-2.5 px-2 text-center transition-all cursor-default relative',
                                    isIntersected && 'ring-1 ring-white/30 z-10'
                                  )}
                                >
                                  <span className={cn('text-xs tabular-nums', getHeatmapTextClass(cell.value))}>
                                    {fmtPct(cell.value, 1)}
                                  </span>
                                </td>
                              );
                            })}

                            {/* Full Year Compounded Return */}
                            <td className="py-2.5 px-3 text-right bg-zinc-950/80 border-l border-zinc-800/60 tabular-nums">
                              {yr?.returnPct !== null && yr?.returnPct !== undefined ? (
                                <span className={cn(
                                  'inline-flex items-center px-2 py-0.5 rounded text-xs font-bold font-mono',
                                  yr.returnPct >= 0
                                    ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                                    : 'bg-red-500/15 text-red-400 border border-red-500/30'
                                )}>
                                  {fmtPct(yr.returnPct, 1)}
                                </span>
                              ) : (
                                <span className="text-zinc-600">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}

                      {/* Summary Row 1: Average Return */}
                      <tr className="border-t-2 border-zinc-700 bg-zinc-900/90 font-bold">
                        <td className="py-3 px-3 text-xs text-zinc-100 uppercase tracking-wide sticky left-0 z-10 bg-zinc-900 border-r border-zinc-700">
                          Average
                        </td>
                        {data.monthAverages.map((val, mIdx) => (
                          <td
                            key={mIdx}
                            style={getHeatmapBg(val)}
                            className="py-3 px-2 text-center"
                          >
                            <span className={cn('text-xs tabular-nums font-bold', getHeatmapTextClass(val))}>
                              {fmtPct(val, 1)}
                            </span>
                          </td>
                        ))}
                        <td className="py-3 px-3 text-right bg-zinc-900 border-l border-zinc-700 text-zinc-300">
                          {(() => {
                            const avgAnnual = data.yearReturns
                              .filter(y => y.returnPct !== null)
                              .reduce((a, b) => a + b.returnPct!, 0) / (data.yearReturns.filter(y => y.returnPct !== null).length || 1);
                            return (
                              <span className={cn('font-bold', avgAnnual >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                                {fmtPct(avgAnnual, 1)}
                              </span>
                            );
                          })()}
                        </td>
                      </tr>

                      {/* Summary Row 2: Median Return */}
                      <tr className="border-t border-zinc-800 bg-zinc-950 font-bold">
                        <td className="py-2 px-3 text-xs text-zinc-400 uppercase tracking-wide sticky left-0 z-10 bg-zinc-950 border-r border-zinc-800">
                          Median
                        </td>
                        {data.monthMedians.map((val, mIdx) => (
                          <td key={mIdx} className="py-2 px-2 text-center text-zinc-300">
                            <span className={cn('text-xs tabular-nums font-bold', (val ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                              {fmtPct(val, 1)}
                            </span>
                          </td>
                        ))}
                        <td className="py-2 px-3 text-right text-zinc-400 border-l border-zinc-800">
                          —
                        </td>
                      </tr>

                      {/* Summary Row 3: Win Rate % */}
                      <tr className="border-t border-zinc-800 bg-zinc-950">
                        <td className="py-2 px-3 text-xs text-zinc-400 uppercase tracking-wide sticky left-0 z-10 bg-zinc-950 border-r border-zinc-800">
                          Win Rate
                        </td>
                        {data.monthStats.map((stat, mIdx) => (
                          <td key={mIdx} className="py-2 px-2 text-center">
                            <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold border font-mono', getWinRateBadgeClass(stat.winRate))}>
                              {stat.winRate}%
                            </span>
                          </td>
                        ))}
                        <td className="py-2 px-3 text-right border-l border-zinc-800">
                          <span className="text-zinc-400 font-bold">{overallWinRate}%</span>
                        </td>
                      </tr>

                      {/* Summary Row 4: Positive / Total Years */}
                      <tr className="border-t border-zinc-800 bg-zinc-950 text-[11px] text-zinc-500 font-mono">
                        <td className="py-2 px-3 uppercase tracking-wide sticky left-0 z-10 bg-zinc-950 border-r border-zinc-800">
                          Pos / Total
                        </td>
                        {data.monthStats.map((stat, mIdx) => (
                          <td key={mIdx} className="py-2 px-2 text-center">
                            <span className="text-emerald-400">{stat.positiveCount}</span>/<span className="text-zinc-400">{stat.totalCount}</span>
                          </td>
                        ))}
                        <td className="py-2 px-3 text-right border-l border-zinc-800 text-zinc-400">
                          {data.yearReturns.filter(y => (y.returnPct ?? 0) > 0).length}/{data.yearReturns.filter(y => y.returnPct !== null).length} yrs
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </CardPanel>
            )}

            {/* ─── TAB 2: MONTHLY CHARTS & WIN RATE CONSISTENCY ─────────── */}
            {activeTab === 'charts' && (
              <div className="flex flex-col gap-4">
                {/* 2 Top Charts */}
                <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
                  {/* Monthly Average Return Bar Chart */}
                  <CardPanel
                    title="Average Return by Calendar Month"
                    eyebrow="Historical Monthly Expectancy"
                    icon={BarChart2}
                    accent="text-emerald-400"
                  >
                    <div className="p-5">
                      <ResponsiveContainer width="100%" height={340}>
                        <BarChart
                          data={data.monthStats}
                          margin={{ top: 15, right: 15, left: -15, bottom: 5 }}
                          barCategoryGap="25%"
                        >
                          <CartesianGrid strokeDasharray="3 6" stroke="#20202399" vertical={false} />
                          <XAxis
                            dataKey="month"
                            tick={{ fontSize: 11, fill: '#a1a1aa', fontWeight: 600, fontFamily: 'var(--font-mono)' }}
                            tickLine={false}
                            axisLine={{ stroke: '#27272a' }}
                          />
                          <YAxis
                            tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500, fontFamily: 'var(--font-mono)' }}
                            tickLine={false}
                            axisLine={false}
                            tickFormatter={v => `${v}%`}
                          />
                          <Tooltip content={<MonthBarTooltip />} cursor={{ fill: '#27272a', opacity: 0.5 }} />
                          <ReferenceLine y={0} stroke="#52525b" strokeWidth={1.5} />
                          <Bar dataKey="avgReturn" name="Avg Return" radius={[3, 3, 0, 0]}>
                            {data.monthStats.map(m => (
                              <Cell
                                key={m.month}
                                fill={(m.avgReturn ?? 0) >= 0 ? '#34d399' : '#f87171'}
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardPanel>

                  {/* Monthly Win Rate % Bar Chart */}
                  <CardPanel
                    title="Historical Win Rate (% Positive Years)"
                    eyebrow="Month-by-Month Reliability"
                    icon={TrendingUp}
                    accent="text-lime-400"
                  >
                    <div className="p-5">
                      <ResponsiveContainer width="100%" height={340}>
                        <BarChart
                          data={data.monthStats}
                          margin={{ top: 15, right: 15, left: -15, bottom: 5 }}
                          barCategoryGap="25%"
                        >
                          <CartesianGrid strokeDasharray="3 6" stroke="#20202399" vertical={false} />
                          <XAxis
                            dataKey="month"
                            tick={{ fontSize: 11, fill: '#a1a1aa', fontWeight: 600, fontFamily: 'var(--font-mono)' }}
                            tickLine={false}
                            axisLine={{ stroke: '#27272a' }}
                          />
                          <YAxis
                            domain={[0, 100]}
                            tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500, fontFamily: 'var(--font-mono)' }}
                            tickLine={false}
                            axisLine={false}
                            tickFormatter={v => `${v}%`}
                          />
                          <Tooltip content={<MonthBarTooltip />} cursor={{ fill: '#27272a', opacity: 0.5 }} />
                          <ReferenceLine y={50} stroke="#facc15" strokeDasharray="4 4" strokeWidth={1.2} />
                          <Bar dataKey="winRate" name="Win Rate" radius={[3, 3, 0, 0]}>
                            {data.monthStats.map(m => (
                              <Cell
                                key={m.month}
                                fill={m.winRate >= 60 ? '#34d399' : m.winRate >= 50 ? '#a3e635' : m.winRate >= 40 ? '#facc15' : '#f87171'}
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardPanel>
                </div>

                {/* Detailed Monthly Stats Table */}
                <CardPanel
                  title="Granular Monthly Performance Breakdown"
                  eyebrow="Statistical Distribution"
                  icon={Calendar}
                  accent="text-emerald-400"
                >
                  <table className="w-full border-collapse font-mono text-xs">
                    <thead>
                      <tr className="bg-zinc-800 border-b border-zinc-700">
                        <th className="py-2.5 px-4 text-left text-xs font-bold text-white uppercase tracking-wider">Month</th>
                        <th className="py-2.5 px-3 text-right text-xs font-bold text-white uppercase tracking-wider">Avg Return</th>
                        <th className="py-2.5 px-3 text-right text-xs font-bold text-white uppercase tracking-wider">Median</th>
                        <th className="py-2.5 px-3 text-center text-xs font-bold text-white uppercase tracking-wider">Win Rate</th>
                        <th className="py-2.5 px-3 text-center text-xs font-bold text-white uppercase tracking-wider">Pos / Neg</th>
                        <th className="py-2.5 px-4 text-right text-xs font-bold text-white uppercase tracking-wider">Best Year</th>
                        <th className="py-2.5 px-4 text-right text-xs font-bold text-white uppercase tracking-wider">Worst Year</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.monthStats.map((stat, i) => (
                        <tr
                          key={stat.month}
                          className={cn('border-b border-zinc-800/60 hover:bg-zinc-800/40 transition-colors', i % 2 === 1 && 'bg-zinc-950/30')}
                        >
                          <td className="py-2.5 px-4 font-bold text-zinc-100 font-sans flex items-center gap-2">
                            <span>{stat.month}</span>
                            {stat.monthIdx === currentMonthIdx && (
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                                Current
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right font-bold">
                            <span className={(stat.avgReturn ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                              {fmtPct(stat.avgReturn)}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-right text-zinc-300 font-bold">
                            <span className={(stat.medianReturn ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                              {fmtPct(stat.medianReturn)}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-center">
                            <span className={cn('inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border', getWinRateBadgeClass(stat.winRate))}>
                              {stat.winRate}%
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-center text-zinc-300">
                            <span className="text-emerald-400 font-bold">{stat.positiveCount}</span> / <span className="text-red-400 font-bold">{stat.negativeCount}</span>
                          </td>
                          <td className="py-2.5 px-4 text-right">
                            {stat.bestYear ? (
                              <span className="text-emerald-400 font-bold">
                                {stat.bestYear.year} <span className="text-xs font-normal">({fmtPct(stat.bestYear.returnPct)})</span>
                              </span>
                            ) : '—'}
                          </td>
                          <td className="py-2.5 px-4 text-right">
                            {stat.worstYear ? (
                              <span className="text-red-400 font-bold">
                                {stat.worstYear.year} <span className="text-xs font-normal">({fmtPct(stat.worstYear.returnPct)})</span>
                              </span>
                            ) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardPanel>
              </div>
            )}

            {/* ─── TAB 3: QUARTERLY CYCLES & COMPOUNDING ────────────────── */}
            {activeTab === 'quarterly' && (
              <div className="flex flex-col gap-4">
                {/* 4 Quarterly Cards */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  {data.quarterlyStats.map(q => (
                    <div
                      key={q.quarter}
                      className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 flex flex-col justify-between"
                    >
                      <div className="flex items-center justify-between gap-2 mb-3">
                        <div>
                          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">{q.label}</span>
                          <h4 className="text-base font-bold text-zinc-100">{q.quarter} Performance</h4>
                        </div>
                        <span className={cn('px-2 py-0.5 rounded text-xs font-mono font-bold border', getWinRateBadgeClass(q.winRate))}>
                          {q.winRate}% Win
                        </span>
                      </div>

                      <div className="flex items-baseline justify-between mb-2">
                        <span className="text-xs text-zinc-400">Avg Return</span>
                        <span className={cn('text-2xl font-mono font-bold tabular-nums', q.avgReturn >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {fmtPct(q.avgReturn)}
                        </span>
                      </div>

                      <div className="pt-3 border-t border-zinc-800 flex items-center justify-between text-xs font-mono text-zinc-400">
                        <span>Positive Years</span>
                        <span className="text-zinc-200 font-bold">{q.positiveYears} / {q.totalYears}</span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Cumulative Annual Compounding Curve */}
                <CardPanel
                  title="Cumulative Seasonality Compounding Curve (Jan → Dec)"
                  eyebrow="Average Annual Progression Track"
                  icon={TrendingUp}
                  accent="text-emerald-400"
                >
                  <div className="p-5">
                    <ResponsiveContainer width="100%" height={380}>
                      <AreaChart
                        data={data.cumulativeCurve}
                        margin={{ top: 15, right: 15, left: -10, bottom: 5 }}
                      >
                        <defs>
                          <linearGradient id="seasonalityArea" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#34d399" stopOpacity={0.4} />
                            <stop offset="100%" stopColor="#059669" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 6" stroke="#20202399" vertical={false} />
                        <XAxis
                          dataKey="month"
                          tick={{ fontSize: 11, fill: '#a1a1aa', fontWeight: 600, fontFamily: 'var(--font-mono)' }}
                          tickLine={false}
                          axisLine={{ stroke: '#27272a' }}
                        />
                        <YAxis
                          tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500, fontFamily: 'var(--font-mono)' }}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={v => `${v}%`}
                        />
                        <Tooltip
                          cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }}
                          content={({ active, payload, label }) => {
                            if (!active || !payload?.length) return null;
                            const d = payload[0].payload as { month: string; cumulativePct: number; avgReturn: number; indexBase: number };
                            return (
                              <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[210px] font-mono">
                                <p className="text-zinc-100 font-bold mb-2 font-sans">{label} Seasonality</p>
                                <div className="flex justify-between gap-6 mb-1 text-zinc-400 font-sans">
                                  <span>Monthly Gain</span>
                                  <span className={cn('font-bold font-mono', d.avgReturn >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                                    {fmtPct(d.avgReturn)}
                                  </span>
                                </div>
                                <div className="flex justify-between gap-6 mb-1 text-zinc-400 font-sans">
                                  <span>Cumulative Gain</span>
                                  <span className={cn('font-bold font-mono', d.cumulativePct >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                                    {fmtPct(d.cumulativePct)}
                                  </span>
                                </div>
                                <div className="pt-2 border-t border-zinc-800 flex justify-between gap-6 text-zinc-400 font-sans">
                                  <span>Index Base (100)</span>
                                  <span className="text-zinc-200 font-bold font-mono">{d.indexBase}</span>
                                </div>
                              </div>
                            );
                          }}
                        />
                        <ReferenceLine y={0} stroke="#52525b" strokeWidth={1.5} />
                        <Area
                          type="monotone"
                          dataKey="cumulativePct"
                          name="Cumulative Return"
                          stroke="#34d399"
                          strokeWidth={2.5}
                          fill="url(#seasonalityArea)"
                          dot={{ fill: '#34d399', stroke: '#064e3b', strokeWidth: 2, r: 4 }}
                          activeDot={{ fill: '#34d399', stroke: '#ffffff', strokeWidth: 2, r: 6 }}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </CardPanel>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
