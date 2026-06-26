'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { RefreshCw, TrendingUp, TrendingDown, Download, BarChart2 } from 'lucide-react';
import { NormalizedResponse, StockSeries } from '@/app/api/normalized/route';
import { cn } from '@/lib/utils';

// ─── Config ───────────────────────────────────────────────────────────────────

const UNIVERSES = [
  { value: 'nifty50',  label: 'NIFTY 50' },
  { value: 'nifty500', label: 'NIFTY 500' },
] as const;
type Universe = typeof UNIVERSES[number]['value'];

const PERIODS = ['1M', '3M', '6M', '1Y', '2Y', '3Y', '4Y', '5Y'] as const;
type Period = typeof PERIODS[number];
type FilterMode = 'all' | 'positive' | 'negative';

// SVG viewport
const SVG_W = 1200;
const SVG_H = 620;
const M = { top: 24, right: 24, bottom: 44, left: 66 };
const CW = SVG_W - M.left - M.right;  // chart width
const CH = SVG_H - M.top  - M.bottom; // chart height

// ─── Colour helpers ───────────────────────────────────────────────────────────

function lineColor(ret: number): string {
  if (ret >= 100) return '#86efac';
  if (ret >= 50)  return '#4ade80';
  if (ret >= 20)  return '#34d399';
  if (ret >= 5)   return '#6ee7b7';
  if (ret >= 0)   return '#a7f3d0';
  if (ret >= -5)  return '#fda4af';
  if (ret >= -20) return '#f87171';
  if (ret >= -40) return '#ef4444';
  return '#dc2626';
}

function lineOpacity(ret: number, anyHovered: boolean, isHovered: boolean): number {
  if (anyHovered) return isHovered ? 1 : 0.05;
  const a = Math.abs(ret);
  return a > 40 ? 0.60 : a > 15 ? 0.48 : a > 5 ? 0.38 : 0.28;
}

function lineWidth(ret: number, isHovered: boolean): number {
  if (isHovered) return 2.5;
  return Math.abs(ret) > 40 ? 1.1 : 0.85;
}

// ─── SVG Fan Chart ────────────────────────────────────────────────────────────

interface CrosshairState {
  dateIdx: number;
  svgX: number;
  symbol: string;
  sector: string;
  valueAtDate: number;
  finalReturn: number;
  color: string;
}

interface FanChartProps {
  dates: string[];
  stocks: StockSeries[];
  leaderHovered: string | null;       // highlight from leaderboard hover
  onHoverChange: (s: string | null) => void;
}

function FanChart({ dates, stocks, leaderHovered, onHoverChange }: FanChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [crosshair, setCrosshair] = useState<CrosshairState | null>(null);

  // Which symbol is actively highlighted (chart crosshair takes priority)
  const activeSymbol = crosshair?.symbol ?? leaderHovered;

  // Y range: P3 – P97 of final returns, with padding
  const { yMin, yMax } = useMemo(() => {
    const sorted = stocks.map((s) => s.finalReturn).sort((a, b) => a - b);
    const p3  = sorted[Math.floor(sorted.length * 0.03)] ?? -20;
    const p97 = sorted[Math.floor(sorted.length * 0.97)] ?? 60;
    const pad = (p97 - p3) * 0.13;
    return { yMin: Math.min(p3 - pad, -6), yMax: Math.max(p97 + pad, 6) };
  }, [stocks]);

  const xS = (i: number) => M.left + (i / Math.max(dates.length - 1, 1)) * CW;
  const yS = (v: number) => M.top  + CH - ((Math.min(Math.max(v, yMin), yMax) - yMin) / (yMax - yMin)) * CH;
  const y0 = yS(0);

  // Pre-build path strings (expensive – only recompute when data changes)
  const paths = useMemo(() => stocks.map((s) => {
    const pts: string[] = [];
    s.values.forEach((v, i) => {
      if (v === null) return;
      pts.push(`${pts.length ? 'L' : 'M'}${xS(i).toFixed(1)},${yS(v).toFixed(1)}`);
    });
    return { symbol: s.symbol, sector: s.sector, d: pts.join(''), color: lineColor(s.finalReturn), ret: s.finalReturn };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [stocks, dates, yMin, yMax]);

  // Y-axis ticks
  const yTicks = useMemo(() => {
    const range = yMax - yMin;
    const step  = range > 250 ? 50 : range > 120 ? 25 : range > 60 ? 10 : range > 25 ? 5 : 2;
    const ticks: number[] = [];
    for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) ticks.push(v);
    return ticks;
  }, [yMin, yMax]);

  // X-axis label indices (7 evenly spaced)
  const xLabels = useMemo(() => {
    const n = dates.length;
    if (n <= 1) return [0];
    const count = Math.min(8, n);
    const step  = Math.floor((n - 1) / (count - 1));
    const idxs  = new Set<number>();
    for (let i = 0; i < n - 1; i += step) idxs.add(i);
    idxs.add(n - 1);
    return [...idxs];
  }, [dates]);

  const fmtAxisDate = (d: string) => new Date(d + 'T00:00:00Z')
    .toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  const fmtFullDate = (d: string) => new Date(d + 'T00:00:00Z')
    .toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

  // Mouse tracking
  function svgCoords(e: React.MouseEvent<SVGRectElement>): { svgX: number; svgY: number } | null {
    const el = svgRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      svgX: ((e.clientX - rect.left) / rect.width)  * SVG_W,
      svgY: ((e.clientY - rect.top)  / rect.height) * SVG_H,
    };
  }

  function handleMouseMove(e: React.MouseEvent<SVGRectElement>) {
    const coords = svgCoords(e);
    if (!coords) return;
    const { svgX, svgY } = coords;

    // Clamp to chart area
    const chartX = Math.max(0, Math.min(CW, svgX - M.left));
    const dateIdx = Math.round((chartX / CW) * (dates.length - 1));

    // Convert svgY back to return value for nearest-line detection
    const mouseRet = yMin + (1 - (svgY - M.top) / CH) * (yMax - yMin);

    // Find nearest stock at this date index by Y distance
    let nearest: StockSeries | null = null;
    let minDist = Infinity;
    for (const s of stocks) {
      const v = s.values[dateIdx];
      if (v === null) continue;
      const d = Math.abs(v - mouseRet);
      if (d < minDist) { minDist = d; nearest = s; }
    }

    if (!nearest) { setCrosshair(null); onHoverChange(null); return; }

    const val = nearest.values[dateIdx] ?? 0;
    setCrosshair({
      dateIdx,
      svgX: xS(dateIdx),
      symbol: nearest.symbol,
      sector: nearest.sector,
      valueAtDate: val,
      finalReturn: nearest.finalReturn,
      color: lineColor(nearest.finalReturn),
    });
    onHoverChange(nearest.symbol);
  }

  function handleMouseLeave() {
    setCrosshair(null);
    onHoverChange(null);
  }

  // Tooltip position: left or right of crosshair depending on available space
  const tooltipW = 195;
  const tooltipH = 86;
  const ttLeft   = crosshair ? (crosshair.svgX + 14 + tooltipW < SVG_W - M.right
    ? crosshair.svgX + 14
    : crosshair.svgX - tooltipW - 14) : 0;
  const ttTop    = crosshair ? Math.max(M.top + 4, Math.min(M.top + CH - tooltipH - 4,
    yS(crosshair.valueAtDate) - tooltipH / 2)) : 0;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      className="w-full"
      style={{ display: 'block', background: 'transparent', minHeight: 420 }}
    >
      {/* ── Grid ── */}
      {yTicks.map((v) => (
        <line key={v}
          x1={M.left} x2={M.left + CW} y1={yS(v)} y2={yS(v)}
          stroke={v === 0 ? '#71717a' : '#27272a'}
          strokeWidth={v === 0 ? 1.2 : 0.5}
          strokeDasharray={v === 0 ? undefined : '3,5'}
        />
      ))}

      {/* ── Non-highlighted paths ── */}
      {paths.map((p) => p.symbol !== activeSymbol && (
        <path key={p.symbol} d={p.d} fill="none"
          stroke={p.color}
          strokeWidth={lineWidth(p.ret, false)}
          strokeOpacity={lineOpacity(p.ret, !!activeSymbol, false)}
        />
      ))}

      {/* ── Crosshair ── */}
      {crosshair && (
        <>
          <line
            x1={crosshair.svgX} x2={crosshair.svgX}
            y1={M.top} y2={M.top + CH}
            stroke="#ffffff" strokeWidth={0.6} strokeOpacity={0.2}
            strokeDasharray="4,4"
          />
          {/* Dot on the highlighted line */}
          <circle
            cx={crosshair.svgX} cy={yS(crosshair.valueAtDate)}
            r={4} fill={crosshair.color} stroke="#18181b" strokeWidth={1.5}
          />
        </>
      )}

      {/* ── Leaderboard-hovered line (when no crosshair) ── */}
      {leaderHovered && !crosshair && (() => {
        const p = paths.find((x) => x.symbol === leaderHovered);
        return p ? (
          <path key={p.symbol + '_hl'} d={p.d} fill="none"
            stroke={p.color} strokeWidth={2.5} strokeOpacity={1} />
        ) : null;
      })()}

      {/* ── Chart-hovered line (on top) ── */}
      {crosshair && (() => {
        const p = paths.find((x) => x.symbol === crosshair.symbol);
        return p ? (
          <path key={p.symbol + '_hl'} d={p.d} fill="none"
            stroke={p.color} strokeWidth={2.5} strokeOpacity={1} />
        ) : null;
      })()}

      {/* ── Y-axis ── */}
      <line x1={M.left} x2={M.left} y1={M.top} y2={M.top + CH} stroke="#3f3f46" strokeWidth={1} />
      {yTicks.map((v) => (
        <g key={v}>
          <line x1={M.left - 4} x2={M.left} y1={yS(v)} y2={yS(v)} stroke="#52525b" strokeWidth={0.8} />
          <text x={M.left - 8} y={yS(v) + 4} textAnchor="end" fontSize={10} fill={v === 0 ? 'rgba(255,255,255,0.60)' : 'rgba(255,255,255,0.40)'}>
            {v > 0 ? '+' : ''}{v}%
          </text>
        </g>
      ))}

      {/* ── X-axis ── */}
      <line x1={M.left} x2={M.left + CW} y1={M.top + CH} y2={M.top + CH} stroke="#3f3f46" strokeWidth={1} />
      {xLabels.map((i) => (
        <g key={i}>
          <line x1={xS(i)} x2={xS(i)} y1={M.top + CH} y2={M.top + CH + 5} stroke="#52525b" strokeWidth={0.8} />
          <text x={xS(i)} y={M.top + CH + 18} textAnchor="middle" fontSize={10} fill="rgba(255,255,255,0.40)">
            {fmtAxisDate(dates[i])}
          </text>
        </g>
      ))}

      {/* ── Tooltip box ── */}
      {crosshair && (
        <g>
          <rect x={ttLeft} y={ttTop} width={tooltipW} height={tooltipH}
            rx={5} fill="#18181b" stroke="#3f3f46" strokeWidth={1}
          />
          {/* Symbol + return pill */}
          <text x={ttLeft + 11} y={ttTop + 20} fontSize={13} fontWeight="700" fill="rgba(255,255,255,0.75)"
            fontFamily="ui-monospace,monospace">
            {crosshair.symbol}
          </text>
          <rect
            x={ttLeft + tooltipW - 68} y={ttTop + 8} width={58} height={18}
            rx={3}
            fill={crosshair.finalReturn >= 0 ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)'}
          />
          <text
            x={ttLeft + tooltipW - 39} y={ttTop + 20}
            textAnchor="middle" fontSize={11} fontWeight="700"
            fill={crosshair.finalReturn >= 0 ? '#34d399' : '#f87171'}>
            {crosshair.finalReturn >= 0 ? '+' : ''}{crosshair.finalReturn.toFixed(1)}%
          </text>
          {/* Sector */}
          <text x={ttLeft + 11} y={ttTop + 36} fontSize={10} fill="rgba(255,255,255,0.40)">{crosshair.sector}</text>
          {/* Divider */}
          <line x1={ttLeft + 8} x2={ttLeft + tooltipW - 8} y1={ttTop + 44} y2={ttTop + 44}
            stroke="#27272a" strokeWidth={0.8} />
          {/* Date + value at date */}
          <text x={ttLeft + 11} y={ttTop + 58} fontSize={10} fill="rgba(255,255,255,0.55)">
            {fmtFullDate(dates[crosshair.dateIdx])}
          </text>
          <text x={ttLeft + 11} y={ttTop + 74} fontSize={11} fontWeight="600"
            fill={crosshair.valueAtDate >= 0 ? '#4ade80' : '#f87171'}>
            {crosshair.valueAtDate >= 0 ? '+' : ''}{crosshair.valueAtDate.toFixed(2)}% from start
          </text>
        </g>
      )}

      {/* ── Invisible mouse-capture overlay ── */}
      <rect
        x={M.left} y={M.top} width={CW} height={CH}
        fill="transparent"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ cursor: 'crosshair' }}
      />
    </svg>
  );
}

// ─── Leaderboard row ──────────────────────────────────────────────────────────

function LeaderRow({ rank, stock, maxAbs, isHighlighted, onHover }: {
  rank: number; stock: StockSeries; maxAbs: number;
  isHighlighted: boolean; onHover: (s: string | null) => void;
}) {
  const pos = stock.finalReturn >= 0;
  const barPct = maxAbs > 0 ? Math.min(Math.abs(stock.finalReturn) / maxAbs, 1) * 100 : 0;
  return (
    <div
      className={cn(
        'flex items-center gap-2 py-[5px] px-2 rounded transition-colors cursor-default',
        isHighlighted ? 'bg-zinc-800/60' : 'hover:bg-zinc-800/30',
      )}
      onMouseEnter={() => onHover(stock.symbol)}
      onMouseLeave={() => onHover(null)}
    >
      <span className="text-[10px] text-white/30 w-5 tabular-nums text-right shrink-0">{rank}</span>
      <span className="font-mono font-semibold text-[12px] text-white/75 w-[86px] shrink-0 truncate">{stock.symbol}</span>
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full', pos ? 'bg-emerald-500' : 'bg-red-500')}
          style={{ width: `${barPct}%` }} />
      </div>
      <span className={cn('text-[11px] font-bold tabular-nums w-14 text-right shrink-0',
        pos ? 'text-emerald-400' : 'text-red-400')}>
        {pos ? '+' : ''}{stock.finalReturn.toFixed(1)}%
      </span>
    </div>
  );
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function exportCSV(data: NormalizedResponse, filtered: StockSeries[]) {
  const lines = ['Symbol,Sector,Return%,' + data.dates.join(',')];
  for (const s of filtered)
    lines.push([s.symbol, s.sector, s.finalReturn.toFixed(2),
      ...s.values.map((v) => (v === null ? '' : v.toFixed(2)))].join(','));
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })),
    download: `normalized_${data.periodLabel}_${new Date().toISOString().slice(0, 10)}.csv`,
  });
  a.click();
}

// ─── Main page component ──────────────────────────────────────────────────────

export default function NormalizedChart() {
  const [universe,    setUniverse]    = useState<Universe>('nifty50');
  const [period,      setPeriod]      = useState<Period>('1Y');
  const [filterMode,  setFilterMode]  = useState<FilterMode>('all');
  const [data,        setData]        = useState<NormalizedResponse | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  // hovered: driven by either chart mousemove or leaderboard hover
  const [hovered, setHovered] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null); setHovered(null);
    try {
      const res  = await fetch(`/api/normalized?index=${universe}&period=${period}`);
      const json = await res.json();
      if (json.success) { setData(json.data); setLastUpdated(new Date()); }
      else setError(json.error ?? 'Unknown error');
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  }, [universe, period]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (filterMode === 'positive') return data.stocks.filter((s) => s.finalReturn >= 0);
    if (filterMode === 'negative') return data.stocks.filter((s) => s.finalReturn < 0);
    return data.stocks;
  }, [data, filterMode]);

  const stats = useMemo(() => {
    if (!data || data.stocks.length === 0) return null;
    const rets = data.stocks.map((s) => s.finalReturn);
    const pos  = rets.filter((r) => r >= 0);
    const neg  = rets.filter((r) => r < 0);
    const med  = [...rets].sort((a, b) => a - b)[Math.floor(rets.length / 2)] ?? 0;
    return {
      total: data.stocks.length,
      positive: pos.length,
      negative: neg.length,
      best:   data.stocks[0]?.finalReturn ?? 0,
      worst:  data.stocks[data.stocks.length - 1]?.finalReturn ?? 0,
      median: med,
      avgPos: pos.length ? pos.reduce((a, b) => a + b, 0) / pos.length : 0,
      avgNeg: neg.length ? neg.reduce((a, b) => a + b, 0) / neg.length : 0,
    };
  }, [data]);

  const gainers     = useMemo(() => (data?.stocks ?? []).slice(0, 15),                          [data]);
  const losers      = useMemo(() => [...(data?.stocks ?? [])].reverse().slice(0, 15),           [data]);
  const maxGain     = gainers[0]?.finalReturn ?? 1;
  const maxLoss     = Math.abs(losers[0]?.finalReturn ?? 1);
  const fmtDate     = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN',
    { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const longPeriod  = ['3Y', '4Y', '5Y'].includes(period);

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-white/75">

      {/* ── Header ── */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/90 backdrop-blur-md px-4 py-2 flex flex-wrap items-center gap-2.5 z-20 sticky top-0">
        <div className="flex items-center gap-2 mr-1">
          <div className="h-6 w-6 rounded-md bg-gradient-to-tr from-sky-600 to-indigo-500 flex items-center justify-center shrink-0">
            <BarChart2 className="h-3.5 w-3.5 text-white" />
          </div>
          <span className="text-[14px] font-bold tracking-tight text-white">Normalized Charts</span>
        </div>
        <div className="w-px h-5 bg-zinc-800 hidden sm:block" />
        <nav className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5">
          <a href="/"           className="px-2.5 py-1 font-medium text-white/45 hover:text-white/75 rounded transition-all">RS Scanner</a>
          <a href="/movers"     className="px-2.5 py-1 font-medium text-white/45 hover:text-white/75 rounded transition-all">Movers</a>
          <a href="/scanner"    className="px-2.5 py-1 font-medium text-white/45 hover:text-white/75 rounded transition-all">Tech Scanner</a>
          <span                 className="px-2.5 py-1 font-semibold rounded bg-sky-500/10 text-sky-400">Charts</span>
          <a href="/live"       className="px-2.5 py-1 font-medium text-white/45 hover:text-white/75 rounded transition-all">Live</a>
          <a href="/strategies" className="px-2.5 py-1 font-medium text-white/45 hover:text-white/75 rounded transition-all">Strategies</a>
          <a href="/portfolio"  className="px-2.5 py-1 font-medium text-white/45 hover:text-white/75 rounded transition-all">Portfolio</a>
          <a href="/reports"    className="px-2.5 py-1 font-medium text-white/45 hover:text-white/75 rounded transition-all">Reports</a>
        </nav>
        <div className="flex items-center gap-2 ml-auto">
          {lastUpdated && (
            <span className="text-[10px] text-white/30 hidden md:inline tabular-nums">
              {lastUpdated.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
            </span>
          )}
          {data && (
            <button onClick={() => exportCSV(data, filtered)}
              className="h-7 px-2.5 flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 text-white/45 hover:text-white/75 hover:bg-zinc-800 transition-all text-[11px] font-medium">
              <Download className="h-3 w-3" /> CSV
            </button>
          )}
          <button onClick={fetchData} disabled={loading}
            className="h-7 w-7 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-white/45 hover:text-white/75 hover:bg-zinc-800 transition-all disabled:opacity-50">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </header>

      <main className="flex-1 w-full max-w-[1900px] mx-auto px-4 py-3 flex flex-col gap-3">

        {/* ── Controls ── */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5">
            {UNIVERSES.map((u) => (
              <button key={u.value} onClick={() => setUniverse(u.value)}
                className={cn('px-2.5 py-1 font-semibold rounded transition-all',
                  universe === u.value ? 'bg-sky-500/10 text-sky-400' : 'text-white/45 hover:text-white/75')}>
                {u.label}
              </button>
            ))}
          </div>
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5">
            {PERIODS.map((p) => (
              <button key={p} onClick={() => setPeriod(p)}
                className={cn('px-2.5 py-1 font-semibold rounded transition-all',
                  period === p ? 'bg-sky-500/10 text-sky-400' : 'text-white/45 hover:text-white/75')}>
                {p}
              </button>
            ))}
          </div>
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5">
            {(['all', 'positive', 'negative'] as FilterMode[]).map((f) => (
              <button key={f} onClick={() => setFilterMode(f)}
                className={cn('px-2.5 py-1 font-semibold rounded transition-all',
                  filterMode === f
                    ? f === 'positive' ? 'bg-emerald-500/10 text-emerald-400'
                      : f === 'negative' ? 'bg-red-500/10 text-red-400'
                      : 'bg-sky-500/10 text-sky-400'
                    : 'text-white/45 hover:text-white/75')}>
                {f === 'all' ? 'All' : f === 'positive' ? '▲ Positive' : '▼ Negative'}
              </button>
            ))}
          </div>
          {data && (
            <span className="text-[11px] text-white/45 ml-auto tabular-nums">
              {filtered.length} stocks · {fmtDate(data.actualStart)} → {fmtDate(data.actualEnd)}
              {longPeriod && <span className="text-amber-500/80 ml-1.5">(stock data limited to ~2Y)</span>}
            </span>
          )}
        </div>

        {/* ── Stats strip ── */}
        {stats && (
          <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5">
            {[
              { label: 'Total',      value: stats.total,                                                                color: 'text-white' },
              { label: 'Positive',   value: stats.positive,                                                             color: 'text-emerald-300' },
              { label: 'Negative',   value: stats.negative,                                                             color: 'text-red-300' },
              { label: 'Median',     value: `${stats.median >= 0 ? '+' : ''}${stats.median.toFixed(1)}%`,              color: stats.median >= 0 ? 'text-emerald-300' : 'text-red-300' },
              { label: 'Avg Winner', value: `+${stats.avgPos.toFixed(1)}%`,                                            color: 'text-lime-300' },
              { label: 'Avg Loser',  value: `${stats.avgNeg.toFixed(1)}%`,                                             color: 'text-orange-300' },
              { label: 'Best',       value: `+${stats.best.toFixed(1)}%`,                                              color: 'text-emerald-300' },
              { label: 'Worst',      value: `${stats.worst.toFixed(1)}%`,                                              color: 'text-red-300' },
            ].map((s) => (
              <div key={s.label} className="flex flex-col items-center bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-2">
                <span className={cn('text-[14px] font-bold tabular-nums leading-tight', s.color)}>{s.value}</span>
                <span className="text-[9px] text-white/45 uppercase tracking-wide mt-0.5 text-center whitespace-nowrap">{s.label}</span>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-950/10 p-4 text-center text-red-400 text-[12px]">{error}</div>
        )}
        {loading && (
          <div className="flex flex-col items-center justify-center p-16 rounded-lg border border-zinc-900 bg-zinc-950">
            <RefreshCw className="h-6 w-6 text-sky-500 animate-spin" />
            <span className="text-white/45 text-[12px] mt-3">
              Loading normalized data for {universe === 'nifty50' ? 'Nifty 50' : 'Nifty 500'}…
            </span>
          </div>
        )}

        {/* ── Chart + leaderboard ── */}
        {!loading && data && filtered.length > 0 && (
          <div className="flex flex-col xl:flex-row gap-3 items-start">

            {/* Chart */}
            <div className="flex-1 min-w-0 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
              <div className="flex items-center justify-between mb-3 px-1">
                <span className="text-[13px] font-semibold text-white/75">
                  {universe === 'nifty50' ? 'NIFTY 50' : 'NIFTY 500'} — {period} Normalised Performance
                </span>
                <div className="flex items-center gap-4 text-[10px] text-white/30">
                  <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-0.5 bg-emerald-400 rounded" /> Positive</span>
                  <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-0.5 bg-red-500 rounded" /> Negative</span>
                  <span className="hidden sm:inline text-white/20">Hover chart or leaderboard to highlight</span>
                </div>
              </div>
              <FanChart
                dates={data.dates}
                stocks={filtered}
                leaderHovered={hovered}
                onHoverChange={setHovered}
              />
            </div>

            {/* Leaderboard */}
            <div className="flex flex-col gap-2 xl:w-[370px] shrink-0">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-800/70">
                  <TrendingUp className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  <span className="text-[12px] font-semibold text-white/75 flex-1">Top Gainers</span>
                  <span className="text-[10px] text-white/45 tabular-nums">{stats?.positive} positive</span>
                </div>
                <div className="py-1 px-1">
                  {gainers.filter((s) => s.finalReturn >= 0).length === 0
                    ? <p className="text-center text-[11px] text-white/30 py-4">No positive stocks</p>
                    : gainers.filter((s) => s.finalReturn >= 0).map((s, i) => (
                      <LeaderRow key={s.symbol} rank={i + 1} stock={s} maxAbs={maxGain}
                        isHighlighted={hovered === s.symbol} onHover={setHovered} />
                    ))}
                </div>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-800/70">
                  <TrendingDown className="h-3.5 w-3.5 text-red-400 shrink-0" />
                  <span className="text-[12px] font-semibold text-white/75 flex-1">Top Losers</span>
                  <span className="text-[10px] text-white/45 tabular-nums">{stats?.negative} negative</span>
                </div>
                <div className="py-1 px-1">
                  {losers.filter((s) => s.finalReturn < 0).length === 0
                    ? <p className="text-center text-[11px] text-white/30 py-4">No negative stocks</p>
                    : losers.filter((s) => s.finalReturn < 0).map((s, i) => (
                      <LeaderRow key={s.symbol} rank={i + 1} stock={s} maxAbs={maxLoss}
                        isHighlighted={hovered === s.symbol} onHover={setHovered} />
                    ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {!loading && filtered.length === 0 && !error && data && (
          <div className="flex flex-col items-center justify-center p-12 rounded-lg border border-zinc-900 bg-zinc-950">
            <BarChart2 className="h-8 w-8 text-white/20 mb-3" />
            <p className="text-white/45 text-[13px]">No stocks match the current filter</p>
          </div>
        )}
      </main>
    </div>
  );
}
