'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { RefreshCw, TrendingUp, TrendingDown, Download, BarChart2 } from 'lucide-react';
import { NormalizedResponse, StockSeries } from '@/app/api/normalized/route';
import { cn } from '@/lib/utils';

// ─── Constants ────────────────────────────────────────────────────────────────

const UNIVERSES = [
  { value: 'nifty50',  label: 'NIFTY 50' },
  { value: 'nifty500', label: 'NIFTY 500' },
] as const;
type Universe = typeof UNIVERSES[number]['value'];

const PERIODS = ['1M', '3M', '6M', '1Y', '2Y', '3Y', '4Y', '5Y'] as const;
type Period = typeof PERIODS[number];

type FilterMode = 'all' | 'positive' | 'negative';

// SVG chart dimensions
const SVG_W = 1000;
const SVG_H = 420;
const MARGIN = { top: 20, right: 20, bottom: 38, left: 58 };
const CHART_W = SVG_W - MARGIN.left - MARGIN.right;
const CHART_H = SVG_H - MARGIN.top - MARGIN.bottom;

// ─── Color helpers ────────────────────────────────────────────────────────────

function stockColor(ret: number): string {
  if (ret >= 50)  return '#4ade80'; // bright green
  if (ret >= 20)  return '#34d399'; // emerald
  if (ret >= 5)   return '#6ee7b7'; // teal
  if (ret >= 0)   return '#a7f3d0'; // pale green
  if (ret >= -10) return '#fca5a5'; // pale red
  if (ret >= -25) return '#f87171'; // red
  return '#ef4444';                  // deep red
}

function stockOpacity(ret: number, hovered: string | null, symbol: string): number {
  if (hovered) return hovered === symbol ? 1 : 0.06;
  // base opacity — larger moves slightly more visible
  const abs = Math.abs(ret);
  return abs > 30 ? 0.55 : abs > 10 ? 0.45 : 0.35;
}

// ─── SVG chart ────────────────────────────────────────────────────────────────

interface ChartProps {
  dates: string[];
  stocks: StockSeries[];
  hovered: string | null;
}

function FanChart({ dates, stocks, hovered }: ChartProps) {
  // Compute Y range from P3 / P97 of all final returns to ignore extreme outliers
  const allReturns = stocks.map((s) => s.finalReturn).sort((a, b) => a - b);
  const p3  = allReturns[Math.floor(allReturns.length * 0.03)] ?? -30;
  const p97 = allReturns[Math.floor(allReturns.length * 0.97)] ?? 100;
  const yPad = (p97 - p3) * 0.12;
  const yMin = Math.min(p3 - yPad, -5);
  const yMax = Math.max(p97 + yPad, 5);

  const xScale = (i: number) => MARGIN.left + (i / Math.max(dates.length - 1, 1)) * CHART_W;
  const yScale = (v: number) => {
    const clamped = Math.min(Math.max(v, yMin), yMax);
    return MARGIN.top + CHART_H - ((clamped - yMin) / (yMax - yMin)) * CHART_H;
  };

  const y0 = yScale(0);

  // Build SVG paths (memoised separately for perf)
  const paths = useMemo(() => {
    return stocks.map((s) => {
      const pts: string[] = [];
      s.values.forEach((v, i) => {
        if (v === null) return;
        const x = xScale(i);
        const y = yScale(v);
        pts.push(pts.length === 0 ? `M${x.toFixed(1)},${y.toFixed(1)}` : `L${x.toFixed(1)},${y.toFixed(1)}`);
      });
      return { symbol: s.symbol, d: pts.join(''), color: stockColor(s.finalReturn), finalReturn: s.finalReturn };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stocks, dates]);

  // Y-axis tick values
  const yTicks = useMemo(() => {
    const range = yMax - yMin;
    const step = range > 200 ? 50 : range > 100 ? 20 : range > 40 ? 10 : 5;
    const ticks: number[] = [];
    for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) ticks.push(v);
    return ticks;
  }, [yMin, yMax]);

  // X-axis tick indices (6–8 labels)
  const xTickIndices = useMemo(() => {
    const n = dates.length;
    if (n <= 1) return [0];
    const count = Math.min(7, n);
    const step = Math.floor((n - 1) / (count - 1));
    const idxs: number[] = [];
    for (let i = 0; i < n - 1; i += step) idxs.push(i);
    idxs.push(n - 1);
    return [...new Set(idxs)];
  }, [dates]);

  const fmtDate = (d: string) => {
    const dt = new Date(d + 'T00:00:00Z');
    return dt.toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  };

  return (
    <svg
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      className="w-full h-auto"
      style={{ display: 'block', background: 'transparent' }}
    >
      {/* Grid lines */}
      {yTicks.map((v) => (
        <line
          key={v}
          x1={MARGIN.left} x2={MARGIN.left + CHART_W}
          y1={yScale(v)} y2={yScale(v)}
          stroke={v === 0 ? '#52525b' : '#27272a'}
          strokeWidth={v === 0 ? 1.5 : 0.5}
          strokeDasharray={v === 0 ? undefined : '3,4'}
        />
      ))}

      {/* Stock paths — render dimmed first, then highlighted on top */}
      <g>
        {paths.map((p) => hovered !== p.symbol && (
          <path
            key={p.symbol}
            d={p.d}
            fill="none"
            stroke={p.color}
            strokeWidth={0.8}
            strokeOpacity={stockOpacity(p.finalReturn, hovered, p.symbol)}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {/* Highlighted stock on top */}
        {hovered && (() => {
          const hp = paths.find((p) => p.symbol === hovered);
          return hp ? (
            <path
              key={hp.symbol + '_h'}
              d={hp.d}
              fill="none"
              stroke={hp.color}
              strokeWidth={2.5}
              strokeOpacity={1}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null;
        })()}
      </g>

      {/* Zero reference line label */}
      <text x={MARGIN.left - 6} y={y0 + 4} textAnchor="end" fontSize={9} fill="#71717a">0%</text>

      {/* Y-axis ticks and labels */}
      {yTicks.filter((v) => v !== 0).map((v) => (
        <g key={v}>
          <line x1={MARGIN.left - 3} x2={MARGIN.left} y1={yScale(v)} y2={yScale(v)} stroke="#52525b" strokeWidth={0.8} />
          <text x={MARGIN.left - 6} y={yScale(v) + 4} textAnchor="end" fontSize={9} fill="#71717a">
            {v > 0 ? '+' : ''}{v}%
          </text>
        </g>
      ))}

      {/* Y-axis line */}
      <line x1={MARGIN.left} x2={MARGIN.left} y1={MARGIN.top} y2={MARGIN.top + CHART_H} stroke="#3f3f46" strokeWidth={1} />

      {/* X-axis ticks and labels */}
      {xTickIndices.map((i) => (
        <g key={i}>
          <line
            x1={xScale(i)} x2={xScale(i)}
            y1={MARGIN.top + CHART_H} y2={MARGIN.top + CHART_H + 4}
            stroke="#52525b" strokeWidth={0.8}
          />
          <text x={xScale(i)} y={MARGIN.top + CHART_H + 16} textAnchor="middle" fontSize={9} fill="#71717a">
            {fmtDate(dates[i])}
          </text>
        </g>
      ))}

      {/* X-axis line */}
      <line
        x1={MARGIN.left} x2={MARGIN.left + CHART_W}
        y1={MARGIN.top + CHART_H} y2={MARGIN.top + CHART_H}
        stroke="#3f3f46" strokeWidth={1}
      />

      {/* Chart border */}
      <rect
        x={MARGIN.left} y={MARGIN.top}
        width={CHART_W} height={CHART_H}
        fill="none" stroke="#27272a" strokeWidth={0.5}
      />
    </svg>
  );
}

// ─── Leaderboard row ─────────────────────────────────────────────────────────

function LeaderRow({
  rank, stock, maxAbs, onHover,
}: {
  rank: number;
  stock: StockSeries;
  maxAbs: number;
  onHover: (s: string | null) => void;
}) {
  const positive = stock.finalReturn >= 0;
  const barPct = maxAbs > 0 ? Math.min(Math.abs(stock.finalReturn) / maxAbs, 1) * 100 : 0;
  return (
    <div
      className="flex items-center gap-2 py-1 px-2 rounded hover:bg-zinc-800/40 cursor-default transition-colors"
      onMouseEnter={() => onHover(stock.symbol)}
      onMouseLeave={() => onHover(null)}
    >
      <span className="text-[10px] text-zinc-600 w-5 tabular-nums text-right shrink-0">{rank}</span>
      <span className="font-mono font-semibold text-[12px] text-zinc-100 w-[88px] shrink-0 truncate">{stock.symbol}</span>
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full', positive ? 'bg-emerald-500' : 'bg-red-500')}
          style={{ width: `${barPct}%` }}
        />
      </div>
      <span className={cn(
        'text-[11px] font-bold tabular-nums w-16 text-right shrink-0',
        positive ? 'text-emerald-400' : 'text-red-400',
      )}>
        {positive ? '+' : ''}{stock.finalReturn.toFixed(1)}%
      </span>
    </div>
  );
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function exportCSV(data: NormalizedResponse, filtered: StockSeries[]) {
  const lines = ['Symbol,Sector,Return%,' + data.dates.join(',')];
  for (const s of filtered) {
    lines.push([
      s.symbol, s.sector, s.finalReturn.toFixed(2),
      ...s.values.map((v) => (v === null ? '' : v.toFixed(2))),
    ].join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `normalized_${data.periodLabel}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function NormalizedChart() {
  const [universe, setUniverse] = useState<Universe>('nifty50');
  const [period, setPeriod] = useState<Period>('1Y');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [data, setData] = useState<NormalizedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setHovered(null);
    try {
      const res = await fetch(`/api/normalized?index=${universe}&period=${period}`);
      const json = await res.json();
      if (json.success) { setData(json.data); setLastUpdated(new Date()); }
      else setError(json.error ?? 'Unknown error');
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  }, [universe, period]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Filter stocks
  const filtered = useMemo(() => {
    if (!data) return [];
    if (filterMode === 'positive') return data.stocks.filter((s) => s.finalReturn >= 0);
    if (filterMode === 'negative') return data.stocks.filter((s) => s.finalReturn < 0);
    return data.stocks;
  }, [data, filterMode]);

  // Stats
  const stats = useMemo(() => {
    if (!data || data.stocks.length === 0) return null;
    const rets = data.stocks.map((s) => s.finalReturn);
    const pos = rets.filter((r) => r >= 0);
    const neg = rets.filter((r) => r < 0);
    const sorted = [...rets].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    return {
      total: data.stocks.length,
      positive: pos.length,
      negative: neg.length,
      best: data.stocks[0]?.finalReturn ?? 0,
      bestSymbol: data.stocks[0]?.symbol ?? '',
      worst: data.stocks[data.stocks.length - 1]?.finalReturn ?? 0,
      worstSymbol: data.stocks[data.stocks.length - 1]?.symbol ?? '',
      median,
      avgPos: pos.length > 0 ? pos.reduce((a, b) => a + b, 0) / pos.length : 0,
      avgNeg: neg.length > 0 ? neg.reduce((a, b) => a + b, 0) / neg.length : 0,
    };
  }, [data]);

  // Leaderboard top/bottom 15
  const gainers = useMemo(() => (data?.stocks ?? []).slice(0, 15), [data]);
  const losers  = useMemo(() => [...(data?.stocks ?? [])].reverse().slice(0, 15), [data]);
  const maxAbsGainer = gainers[0]?.finalReturn ?? 1;
  const maxAbsLoser  = Math.abs(losers[0]?.finalReturn ?? 1);

  const fmtDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-100">

      {/* Header */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/90 backdrop-blur-md px-4 py-2 flex flex-wrap items-center gap-2.5 z-20 sticky top-0">
        <div className="flex items-center gap-2 mr-1">
          <div className="h-6 w-6 rounded-md bg-gradient-to-tr from-sky-600 to-indigo-500 flex items-center justify-center shrink-0">
            <BarChart2 className="h-3.5 w-3.5 text-white" />
          </div>
          <span className="text-[14px] font-bold tracking-tight text-white">Normalized Charts</span>
        </div>

        <div className="w-px h-5 bg-zinc-800 hidden sm:block" />

        {/* Nav */}
        <nav className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5">
          <a href="/"           className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">RS Scanner</a>
          <a href="/movers"     className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">Movers</a>
          <a href="/scanner"    className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">Tech Scanner</a>
          <span                 className="px-2.5 py-1 font-semibold rounded bg-sky-500/10 text-sky-400">Charts</span>
          <a href="/live"       className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">Live</a>
          <a href="/strategies" className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">Strategies</a>
          <a href="/portfolio"  className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">Portfolio</a>
          <a href="/reports"    className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">Reports</a>
        </nav>

        <div className="flex items-center gap-2 ml-auto">
          {lastUpdated && (
            <span className="text-[10px] text-zinc-600 hidden md:inline tabular-nums">
              {lastUpdated.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
            </span>
          )}
          {data && (
            <button
              onClick={() => exportCSV(data, filtered)}
              className="h-7 px-2.5 flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-all text-[11px] font-medium"
            >
              <Download className="h-3 w-3" /> CSV
            </button>
          )}
          <button
            onClick={fetchData}
            disabled={loading}
            className="h-7 w-7 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-all disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </header>

      <main className="flex-1 w-full max-w-[1800px] mx-auto px-4 py-3 flex flex-col gap-3">

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Universe */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5">
            {UNIVERSES.map((u) => (
              <button
                key={u.value}
                onClick={() => setUniverse(u.value)}
                className={cn(
                  'px-2.5 py-1 font-semibold rounded transition-all',
                  universe === u.value ? 'bg-sky-500/10 text-sky-400' : 'text-zinc-500 hover:text-zinc-300',
                )}
              >
                {u.label}
              </button>
            ))}
          </div>

          {/* Period */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5">
            {PERIODS.map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={cn(
                  'px-2.5 py-1 font-semibold rounded transition-all',
                  period === p ? 'bg-sky-500/10 text-sky-400' : 'text-zinc-500 hover:text-zinc-300',
                )}
              >
                {p}
              </button>
            ))}
          </div>

          {/* Filter */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5">
            {(['all', 'positive', 'negative'] as FilterMode[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilterMode(f)}
                className={cn(
                  'px-2.5 py-1 font-semibold rounded capitalize transition-all',
                  filterMode === f
                    ? f === 'positive' ? 'bg-emerald-500/10 text-emerald-400'
                      : f === 'negative' ? 'bg-red-500/10 text-red-400'
                      : 'bg-sky-500/10 text-sky-400'
                    : 'text-zinc-500 hover:text-zinc-300',
                )}
              >
                {f === 'all' ? 'All' : f === 'positive' ? '▲ Positive' : '▼ Negative'}
              </button>
            ))}
          </div>

          {data && (
            <span className="text-[11px] text-zinc-500 ml-auto tabular-nums">
              {filtered.length} stocks · {fmtDate(data.actualStart)} → {fmtDate(data.actualEnd)}
              {parseInt(period) > 2 || period === '3Y' || period === '4Y' || period === '5Y'
                ? <span className="text-amber-500 ml-1">(data limited to ~2Y for stocks)</span>
                : null}
            </span>
          )}
        </div>

        {/* Stats strip */}
        {stats && (
          <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5">
            {[
              { label: 'Total',      value: stats.total,                         color: 'text-white' },
              { label: 'Positive',   value: stats.positive,                      color: 'text-emerald-300' },
              { label: 'Negative',   value: stats.negative,                      color: 'text-red-300' },
              { label: 'Median',     value: `${stats.median >= 0 ? '+' : ''}${stats.median.toFixed(1)}%`, color: stats.median >= 0 ? 'text-emerald-300' : 'text-red-300' },
              { label: 'Avg Winner', value: `+${stats.avgPos.toFixed(1)}%`,      color: 'text-lime-300' },
              { label: 'Avg Loser',  value: `${stats.avgNeg.toFixed(1)}%`,       color: 'text-orange-300' },
              { label: 'Best',       value: `+${stats.best.toFixed(1)}%`,        color: 'text-emerald-300' },
              { label: 'Worst',      value: `${stats.worst.toFixed(1)}%`,        color: 'text-red-300' },
            ].map((s) => (
              <div key={s.label} className="flex flex-col items-center bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-2">
                <span className={cn('text-[14px] font-bold tabular-nums leading-tight', s.color)}>{s.value}</span>
                <span className="text-[9px] text-zinc-500 uppercase tracking-wide mt-0.5 text-center whitespace-nowrap">{s.label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-950/10 p-4 text-center text-red-400 text-[12px]">{error}</div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center p-16 rounded-lg border border-zinc-900 bg-zinc-950">
            <RefreshCw className="h-6 w-6 text-sky-500 animate-spin" />
            <span className="text-zinc-500 text-[12px] mt-3">Loading normalized data for {universe === 'nifty50' ? 'Nifty 50' : 'Nifty 500'}…</span>
          </div>
        )}

        {/* Main content: chart + leaderboard */}
        {!loading && data && filtered.length > 0 && (
          <div className="flex flex-col xl:flex-row gap-3">

            {/* Chart panel */}
            <div className="flex-1 min-w-0 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
              <div className="flex items-center justify-between mb-2 px-1">
                <span className="text-[12px] font-semibold text-zinc-300">
                  {universe === 'nifty50' ? 'NIFTY 50' : 'NIFTY 500'} — {period} Normalized Performance
                </span>
                <div className="flex items-center gap-3 text-[10px] text-zinc-600">
                  <span className="flex items-center gap-1"><span className="inline-block w-6 h-0.5 bg-emerald-500" /> Positive</span>
                  <span className="flex items-center gap-1"><span className="inline-block w-6 h-0.5 bg-red-500" /> Negative</span>
                  <span className="flex items-center gap-1 text-zinc-700">Hover leaderboard to highlight</span>
                </div>
              </div>
              <FanChart dates={data.dates} stocks={filtered} hovered={hovered} />
              {hovered && (() => {
                const s = data.stocks.find((x) => x.symbol === hovered);
                return s ? (
                  <div className="mt-1 px-1 text-[11px] text-zinc-400 tabular-nums">
                    <span className="font-mono font-bold text-zinc-200">{s.symbol}</span>
                    <span className="mx-1.5 text-zinc-700">·</span>
                    {s.sector}
                    <span className="mx-1.5 text-zinc-700">·</span>
                    <span className={s.finalReturn >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {s.finalReturn >= 0 ? '+' : ''}{s.finalReturn.toFixed(2)}%
                    </span>
                    <span className="mx-1.5 text-zinc-700">over {period}</span>
                  </div>
                ) : null;
              })()}
            </div>

            {/* Leaderboard panel */}
            <div className="flex flex-col gap-2 xl:w-[420px] shrink-0">
              {/* Top gainers */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/70">
                  <TrendingUp className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  <span className="text-[12px] font-semibold text-zinc-200 flex-1">Top Gainers</span>
                  <span className="text-[10px] text-zinc-600 tabular-nums">{stats?.positive} positive</span>
                </div>
                <div className="py-1">
                  {gainers.filter((s) => s.finalReturn >= 0).map((s, i) => (
                    <LeaderRow key={s.symbol} rank={i + 1} stock={s} maxAbs={maxAbsGainer} onHover={setHovered} />
                  ))}
                  {gainers.filter((s) => s.finalReturn >= 0).length === 0 && (
                    <p className="text-center text-[11px] text-zinc-600 py-4">No positive stocks in this period</p>
                  )}
                </div>
              </div>

              {/* Top losers */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/70">
                  <TrendingDown className="h-3.5 w-3.5 text-red-400 shrink-0" />
                  <span className="text-[12px] font-semibold text-zinc-200 flex-1">Top Losers</span>
                  <span className="text-[10px] text-zinc-600 tabular-nums">{stats?.negative} negative</span>
                </div>
                <div className="py-1">
                  {losers.filter((s) => s.finalReturn < 0).map((s, i) => (
                    <LeaderRow key={s.symbol} rank={i + 1} stock={s} maxAbs={maxAbsLoser} onHover={setHovered} />
                  ))}
                  {losers.filter((s) => s.finalReturn < 0).length === 0 && (
                    <p className="text-center text-[11px] text-zinc-600 py-4">No negative stocks in this period</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {!loading && filtered.length === 0 && !error && data && (
          <div className="flex flex-col items-center justify-center p-12 rounded-lg border border-zinc-900 bg-zinc-950">
            <BarChart2 className="h-8 w-8 text-zinc-700 mb-3" />
            <p className="text-zinc-500 text-[13px]">No stocks match the current filter</p>
          </div>
        )}

      </main>
    </div>
  );
}
