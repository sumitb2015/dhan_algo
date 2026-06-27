'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Search, RefreshCw, Activity, TrendingUp, TrendingDown, X, BarChart2,
  ArrowUpRight, ArrowDownRight, Info,
} from 'lucide-react';
import type {
  DistributionResponse, DistributionStats, HistogramBin, NormalPoint, SymbolListItem,
} from '@/app/api/distribution/route';
import { cn } from '@/lib/utils';

// ─── Constants ────────────────────────────────────────────────────────────────

const PERIODS = [
  { value: '1M', label: '1M' },
  { value: '3M', label: '3M' },
  { value: '6M', label: '6M' },
  { value: '1Y', label: '1Y' },
  { value: '2Y', label: '2Y' },
  { value: '5Y', label: '5Y' },
] as const;
type Period = typeof PERIODS[number]['value'];

// ─── SVG chart dimensions ─────────────────────────────────────────────────────

const SVG_W = 1000;
const SVG_H = 320;
const M = { top: 30, right: 28, bottom: 46, left: 72 };
const CW = SVG_W - M.left - M.right;
const CH = SVG_H - M.top - M.bottom;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtPct(n: number, d = 3, sign = true): string {
  return (sign && n >= 0 ? '+' : '') + n.toFixed(d) + '%';
}

function fmtDate(d: string): string {
  return new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

// ─── SVG Distribution Chart ───────────────────────────────────────────────────

interface SVGChartProps {
  stats: DistributionStats;
  histogram: HistogramBin[];
  normalCurve: NormalPoint[];
}

function DistributionSVGChart({ stats, histogram, normalCurve }: SVGChartProps) {
  const [tooltip, setTooltip] = useState<{
    x: number; y: number;
    bin: HistogramBin;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // ─── Scale bounds ───────────────────────────────────────────────────────────
  const xMin = Math.min(stats.minVal - 0.4, stats.sd3Low - 0.3);
  const xMax = Math.max(stats.maxVal + 0.4, stats.sd3High + 0.3);

  const maxDensity = Math.max(
    ...histogram.map((h) => h.density),
    ...normalCurve.map((p) => p.y),
  );
  const yMax = maxDensity * 1.18;

  // ─── Scale functions ────────────────────────────────────────────────────────
  const xS = (x: number) => M.left + ((x - xMin) / (xMax - xMin)) * CW;
  const yS = (y: number) => M.top + CH - (y / yMax) * CH;
  const y0 = yS(0);

  // ─── Histogram bar pixel width ──────────────────────────────────────────────
  const binWidthPx = useMemo(() => {
    if (histogram.length < 2) return 4;
    return Math.max(1, xS(histogram[1].binCenter) - xS(histogram[0].binCenter) - 0.8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histogram, xMin, xMax]);

  // ─── Normal curve SVG path ──────────────────────────────────────────────────
  const curvePath = useMemo(
    () =>
      normalCurve
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${xS(p.x).toFixed(1)},${yS(p.y).toFixed(1)}`)
        .join(''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [normalCurve, xMin, xMax, yMax],
  );

  // ─── Band fill path ─────────────────────────────────────────────────────────
  function bandPath(low: number, high: number): string {
    const inBand = normalCurve.filter((p) => p.x >= low && p.x <= high);
    if (!inBand.length) return '';
    return [
      `M${xS(low).toFixed(1)},${y0.toFixed(1)}`,
      ...inBand.map((p) => `L${xS(p.x).toFixed(1)},${yS(p.y).toFixed(1)}`),
      `L${xS(high).toFixed(1)},${y0.toFixed(1)}Z`,
    ].join('');
  }

  // ─── Grid lines ─────────────────────────────────────────────────────────────
  const yTickCount = 5;
  const yTicks = Array.from({ length: yTickCount + 1 }, (_, i) => (yMax * i) / yTickCount);

  // ─── X axis ticks ───────────────────────────────────────────────────────────
  const xRange = xMax - xMin;
  const tickStep = xRange > 25 ? 5 : xRange > 12 ? 2 : xRange > 6 ? 1 : 0.5;
  const xTicks: number[] = [];
  {
    let t = Math.ceil(xMin / tickStep) * tickStep;
    while (t <= xMax + 0.0001) {
      xTicks.push(parseFloat(t.toFixed(5)));
      t = parseFloat((t + tickStep).toFixed(5));
    }
  }

  // ─── Tooltip mouse handler ──────────────────────────────────────────────────
  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * SVG_W;
    const dataX = xMin + ((svgX - M.left) / CW) * (xMax - xMin);
    if (svgX < M.left || svgX > M.left + CW) { setTooltip(null); return; }
    const bin = histogram.find((b) => dataX >= b.binLeft && dataX < b.binRight) ?? null;
    if (bin) {
      setTooltip({ x: xS(bin.binCenter), y: yS(bin.density) - 8, bin });
    } else {
      setTooltip(null);
    }
  }

  return (
    <div className="relative w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        className="w-full h-auto select-none"
        style={{ display: 'block', fontFamily: 'ui-monospace, "Geist Mono", monospace' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTooltip(null)}
      >
        {/* Chart background */}
        <rect x={M.left} y={M.top} width={CW} height={CH} fill="#09090b" rx={2} />

        {/* Horizontal grid */}
        {yTicks.slice(1).map((y, i) => (
          <line key={i}
            x1={M.left} y1={yS(y)} x2={M.left + CW} y2={yS(y)}
            stroke="#27272a" strokeWidth={0.8} strokeDasharray="3 3"
          />
        ))}

        {/* Y axis labels — zinc-400 (#a1a1aa) */}
        {yTicks.map((y, i) => (
          <text key={i}
            x={M.left - 8} y={yS(y) + 3.5}
            textAnchor="end" fontSize={9.5} fill="#a1a1aa"
          >
            {y.toFixed(y < 0.01 ? 4 : 3)}
          </text>
        ))}

        {/* 3SD region — subtle outer shading */}
        <path d={bandPath(stats.sd3Low, stats.sd3High)} fill="#a855f7" fillOpacity={0.05} />

        {/* 2SD band */}
        <path d={bandPath(stats.sd2Low, stats.sd2High)} fill="#f97316" fillOpacity={0.09} />

        {/* 1SD band */}
        <path d={bandPath(stats.sd1Low, stats.sd1High)} fill="#22c55e" fillOpacity={0.17} />

        {/* Histogram bars */}
        {histogram.map((bin, i) => {
          const bx = xS(bin.binCenter) - binWidthPx / 2;
          const by = yS(bin.density);
          const bh = Math.max(0, y0 - by);
          const isHovered = tooltip?.bin === bin;
          return (
            <rect
              key={i}
              x={bx} y={by} width={binWidthPx} height={bh}
              fill={isHovered ? '#60a5fa' : '#3b82f6'}
              fillOpacity={isHovered ? 0.75 : 0.48}
              stroke="#1d4ed8"
              strokeWidth={0.35}
            />
          );
        })}

        {/* Normal distribution curve */}
        <path d={curvePath} fill="none" stroke="#ef4444" strokeWidth={2.5} strokeLinejoin="round" />

        {/* ±3σ vertical markers (faint) */}
        {[stats.sd3Low, stats.sd3High].map((x, i) => (
          <line key={i}
            x1={xS(x)} y1={M.top} x2={xS(x)} y2={y0}
            stroke="#a855f7" strokeWidth={1} strokeDasharray="2 3" opacity={0.5}
          />
        ))}

        {/* ±2σ vertical markers */}
        {[stats.sd2Low, stats.sd2High].map((x, i) => (
          <line key={i}
            x1={xS(x)} y1={M.top} x2={xS(x)} y2={y0}
            stroke="#fb923c" strokeWidth={1.3} strokeDasharray="4 2"
          />
        ))}

        {/* ±1σ vertical markers */}
        {[stats.sd1Low, stats.sd1High].map((x, i) => (
          <line key={i}
            x1={xS(x)} y1={M.top} x2={xS(x)} y2={y0}
            stroke="#4ade80" strokeWidth={1.3} strokeDasharray="4 2"
          />
        ))}

        {/* Mean vertical marker */}
        <line
          x1={xS(stats.mean)} y1={M.top} x2={xS(stats.mean)} y2={y0}
          stroke="#93c5fd" strokeWidth={2} strokeDasharray="6 3"
        />

        {/* σ labels at top */}
        <text x={xS(stats.mean)} y={M.top - 8} textAnchor="middle" fontSize={11} fill="#93c5fd" fontWeight="bold">μ</text>
        {[
          { x: stats.sd1Low, label: '−1σ', color: '#4ade80' },
          { x: stats.sd1High, label: '+1σ', color: '#4ade80' },
          { x: stats.sd2Low, label: '−2σ', color: '#fb923c' },
          { x: stats.sd2High, label: '+2σ', color: '#fb923c' },
          { x: stats.sd3Low, label: '−3σ', color: '#c084fc' },
          { x: stats.sd3High, label: '+3σ', color: '#c084fc' },
        ].map(({ x, label, color }) => {
          const px = xS(x);
          if (px < M.left + 16 || px > M.left + CW - 16) return null;
          return (
            <text key={label} x={px} y={M.top - 8} textAnchor="middle" fontSize={9} fill={color}>
              {label}
            </text>
          );
        })}

        {/* Outer chart border */}
        <rect x={M.left} y={M.top} width={CW} height={CH} fill="none" stroke="#3f3f46" strokeWidth={0.8} rx={2} />

        {/* X axis baseline */}
        <line x1={M.left} y1={y0} x2={M.left + CW} y2={y0} stroke="#71717a" strokeWidth={1} />

        {/* X axis ticks + labels — zinc-300 (#d4d4d8) */}
        {xTicks.map((t) => {
          const px = xS(t);
          if (px < M.left + 2 || px > M.left + CW - 2) return null;
          return (
            <g key={t}>
              <line x1={px} y1={y0} x2={px} y2={y0 + 4} stroke="#71717a" strokeWidth={1} />
              <text x={px} y={y0 + 17} textAnchor="middle" fontSize={9.5} fill="#d4d4d8">
                {t >= 0 ? '+' : ''}{t.toFixed(1)}%
              </text>
            </g>
          );
        })}

        {/* Y axis label — zinc-300 */}
        <text
          x={16} y={M.top + CH / 2} textAnchor="middle" fontSize={10} fill="#d4d4d8"
          transform={`rotate(-90 16 ${M.top + CH / 2})`}
        >
          Probability Density
        </text>

        {/* X axis label — zinc-300 */}
        <text x={M.left + CW / 2} y={SVG_H - 6} textAnchor="middle" fontSize={10} fill="#d4d4d8">
          Daily Return (%)
        </text>

        {/* Legend box */}
        <g transform={`translate(${M.left + CW - 252}, ${M.top + 8})`}>
          <rect x={0} y={0} width={242} height={84} fill="#18181b" rx={5} stroke="#3f3f46" strokeWidth={0.8} opacity={0.95} />
          <rect x={10} y={12} width={14} height={8} fill="#3b82f6" fillOpacity={0.55} stroke="#1d4ed8" strokeWidth={0.5} />
          <text x={30} y={20} fontSize={9.5} fill="#e4e4e7">Actual Daily Returns (histogram)</text>
          <line x1={10} y1={33} x2={24} y2={33} stroke="#ef4444" strokeWidth={2.5} />
          <text x={30} y={37} fontSize={9.5} fill="#e4e4e7">
            {'Fitted Normal (μ='}
            <tspan fill="#93c5fd">{stats.mean.toFixed(3)}%</tspan>
            {', σ='}
            <tspan fill="#93c5fd">{stats.std.toFixed(3)}%</tspan>
            {')'}
          </text>
          <rect x={10} y={46} width={14} height={8} fill="#22c55e" fillOpacity={0.35} />
          <text x={30} y={54} fontSize={9.5} fill="#e4e4e7">
            1σ Band — <tspan fill="#4ade80">{stats.within1SD.toFixed(1)}%</tspan> of days (theory 68.3%)
          </text>
          <rect x={10} y={63} width={14} height={8} fill="#f97316" fillOpacity={0.25} />
          <text x={30} y={71} fontSize={9.5} fill="#e4e4e7">
            2σ Band — <tspan fill="#fb923c">{stats.within2SD.toFixed(1)}%</tspan> of days (theory 95.5%)
          </text>
        </g>

        {/* Tooltip */}
        {tooltip && (
          <g transform={`translate(${Math.min(tooltip.x, M.left + CW - 130)}, ${Math.max(tooltip.y, M.top + 8)})`}>
            <rect x={-64} y={-28} width={128} height={50} fill="#18181b" rx={4} stroke="#52525b" strokeWidth={0.8} opacity={0.96} />
            <text x={0} y={-12} textAnchor="middle" fontSize={10} fill="#d4d4d8">
              {fmtPct(tooltip.bin.binLeft, 2)} to {fmtPct(tooltip.bin.binRight, 2, false)}
            </text>
            <text x={0} y={3} textAnchor="middle" fontSize={11} fill="#ffffff" fontWeight="bold">
              {tooltip.bin.count} days
            </text>
            <text x={0} y={17} textAnchor="middle" fontSize={9.5} fill="#a1a1aa">
              density {tooltip.bin.density.toFixed(4)}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({
  label, value, sub, color = 'text-white',
}: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="flex flex-col bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-3 min-w-0">
      <span className="text-[10px] text-white/70 uppercase tracking-wider font-medium mb-1">{label}</span>
      <span className={cn('text-[15px] font-bold tabular-nums leading-tight', color)}>{value}</span>
      {sub && <span className="text-[10px] text-white/65 mt-0.5">{sub}</span>}
    </div>
  );
}

// ─── SD Coverage Bar ─────────────────────────────────────────────────────────

function CoverageBar({
  label, actual, theory, color,
}: { label: string; actual: number; theory: number; color: string }) {
  const diff = actual - theory;
  return (
    <div className="flex flex-col gap-1 bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-white/70 uppercase tracking-wider font-medium">{label}</span>
        <span className={cn('text-[11px] font-bold tabular-nums', color)}>{actual.toFixed(2)}%</span>
      </div>
      <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', color.replace('text-', 'bg-'))}
          style={{ width: `${Math.min(actual, 100)}%` }}
        />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[9px] text-white/60">Theory: {theory}%</span>
        <span className={cn('text-[9px] tabular-nums font-medium', diff >= 0 ? 'text-emerald-400' : 'text-red-400')}>
          {diff >= 0 ? '+' : ''}{diff.toFixed(2)}%
        </span>
      </div>
    </div>
  );
}

// ─── Outlier Table ────────────────────────────────────────────────────────────

function OutlierTable({
  title, rows, positive,
}: {
  title: string;
  rows: { date: string; change: number; close: number }[];
  positive: boolean;
}) {
  return (
    <div className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden">
      <div className={cn(
        'px-4 py-2.5 border-b border-zinc-800 flex items-center gap-2',
        positive ? 'bg-emerald-950/20' : 'bg-red-950/20',
      )}>
        {positive
          ? <ArrowUpRight className="h-4 w-4 text-emerald-400 shrink-0" />
          : <ArrowDownRight className="h-4 w-4 text-red-400 shrink-0" />
        }
        <span className="text-[12px] font-bold text-white">{title}</span>
      </div>
      <table className="w-full">
        <thead>
          <tr className="bg-zinc-900">
            <th className="px-4 py-2 text-xs font-bold text-white text-left whitespace-nowrap bg-zinc-800">#</th>
            <th className="px-4 py-2 text-xs font-bold text-white text-left whitespace-nowrap bg-zinc-800">Date</th>
            <th className="px-4 py-2 text-xs font-bold text-white text-right whitespace-nowrap bg-zinc-800">Close</th>
            <th className="px-4 py-2 text-xs font-bold text-white text-right whitespace-nowrap bg-zinc-800">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.date} className="border-b border-zinc-900/60 hover:bg-zinc-800/20 transition-colors">
              <td className="px-4 py-2 text-[11px] text-white/60 tabular-nums">{i + 1}</td>
              <td className="px-4 py-2 text-[12px] text-white/90">{fmtDate(r.date)}</td>
              <td className="px-4 py-2 text-[12px] text-white/80 text-right tabular-nums">
                {r.close.toFixed(2)}
              </td>
              <td className={cn(
                'px-4 py-2 text-[12px] font-bold text-right tabular-nums',
                positive ? 'text-emerald-400' : 'text-red-400',
              )}>
                {fmtPct(r.change, 2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Symbol Sidebar ───────────────────────────────────────────────────────────

interface SidebarProps {
  symbols: SymbolListItem[];
  selected: string;
  onSelect: (s: string) => void;
}

function SymbolSidebar({ symbols, selected, onSelect }: SidebarProps) {
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    if (!q) return symbols;
    return symbols.filter((s) => s.value.includes(q) || s.label.toUpperCase().includes(q));
  }, [symbols, search]);

  return (
    <div className="flex flex-col h-full bg-zinc-950 border-r border-zinc-800">
      {/* Search */}
      <div className="px-3 py-2.5 border-b border-zinc-800">
        <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 text-white/60 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search symbol…"
            className="bg-transparent text-[12px] text-white placeholder:text-white/50 outline-none w-full"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-white/60 hover:text-white/90">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Symbol list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-4 py-6 text-center text-[12px] text-white/60">No symbols found</div>
        )}
        {filtered.map((s, idx) => {
          const prev = filtered[idx - 1];
          const showDivider = !prev?.isIndex && !s.isIndex && prev?.isIndex !== s.isIndex;
          return (
            <React.Fragment key={s.value}>
              {s.isIndex && idx > 0 && <div className="h-px bg-zinc-800 mx-3 my-1" />}
              {showDivider && <div className="h-px bg-zinc-800 mx-3 my-1" />}
              <button
                onClick={() => onSelect(s.value)}
                className={cn(
                  'w-full text-left px-3 py-2 flex items-center gap-2 transition-colors text-[12px]',
                  selected === s.value
                    ? 'bg-violet-500/10 text-violet-300 font-semibold border-l-2 border-violet-500'
                    : 'text-white/80 hover:bg-zinc-800/50 hover:text-white border-l-2 border-transparent',
                )}
              >
                {s.isIndex && (
                  <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide bg-amber-500/15 text-amber-400 px-1.5 py-0.5 rounded">
                    IDX
                  </span>
                )}
                <span className="font-mono truncate">{s.value}</span>
              </button>
            </React.Fragment>
          );
        })}
      </div>

      <div className="px-3 py-2 border-t border-zinc-800 text-[10px] text-white/55 text-center">
        {filtered.length} of {symbols.length} symbols
      </div>
    </div>
  );
}

// ─── Kurtosis / Skewness interpretation ──────────────────────────────────────

function interpretKurtosis(k: number): { label: string; color: string; desc: string } {
  if (k > 2) return { label: 'Very Fat Tails', color: 'text-red-400', desc: 'Extreme moves much more frequent than normal' };
  if (k > 0.5) return { label: 'Fat Tails', color: 'text-orange-400', desc: 'More frequent tail events than normal distribution' };
  if (k > -0.5) return { label: 'Near Normal', color: 'text-green-400', desc: 'Tail thickness close to normal distribution' };
  return { label: 'Thin Tails', color: 'text-blue-400', desc: 'Fewer extreme moves than normal' };
}

function interpretSkewness(s: number): { label: string; color: string } {
  if (s < -0.3) return { label: 'Left Skewed (−)', color: 'text-red-400' };
  if (s > 0.3) return { label: 'Right Skewed (+)', color: 'text-emerald-400' };
  return { label: 'Near Symmetric', color: 'text-white/90' };
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DistributionChart() {
  const [symbols, setSymbols] = useState<SymbolListItem[]>([]);
  const [selected, setSelected] = useState('NIFTY50');
  const [period, setPeriod] = useState<Period>('1Y');
  const [data, setData] = useState<DistributionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  // ─── Load symbol list ─────────────────────────────────────────────────────
  useEffect(() => {
    setListLoading(true);
    fetch('/api/distribution?list=true')
      .then((r) => r.json())
      .then((j) => {
        if (j.success) setSymbols(j.symbols ?? []);
      })
      .catch(console.error)
      .finally(() => setListLoading(false));
  }, []);

  // ─── Fetch distribution data ──────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/distribution?symbol=${selected}&period=${period}`);
      const json = await res.json();
      if (json.success) {
        setData(json.data);
        setLastFetched(new Date());
      } else {
        setError(json.error ?? 'Unknown error');
        setData(null);
      }
    } catch {
      setError('Network error');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [selected, period]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const stats = data?.stats;
  const kInterp = stats ? interpretKurtosis(stats.kurtosis) : null;
  const sInterp = stats ? interpretSkewness(stats.skewness) : null;

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-white">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/90 backdrop-blur-md px-4 py-2 flex flex-wrap items-center gap-2.5 z-20 sticky top-0">
        <div className="flex items-center gap-2 mr-1">
          <div className="h-6 w-6 rounded-md bg-gradient-to-tr from-violet-600 to-pink-500 flex items-center justify-center shrink-0">
            <Activity className="h-3.5 w-3.5 text-white" />
          </div>
          <span className="text-[14px] font-bold tracking-tight text-white">Distribution Analysis</span>
        </div>

        <div className="w-px h-5 bg-zinc-800 hidden sm:block" />

        {/* Nav */}
        <nav className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5">
          <a href="/"             className="px-2.5 py-1 font-medium text-white/75 hover:text-white rounded transition-all">RS Scanner</a>
          <a href="/movers"       className="px-2.5 py-1 font-medium text-white/75 hover:text-white rounded transition-all">Movers</a>
          <a href="/scanner"      className="px-2.5 py-1 font-medium text-white/75 hover:text-white rounded transition-all">Scanner</a>
          <a href="/normalized"   className="px-2.5 py-1 font-medium text-white/75 hover:text-white rounded transition-all">Charts</a>
          <span                   className="px-2.5 py-1 font-semibold rounded bg-violet-500/10 text-violet-400">Distribution</span>
          <a href="/live"         className="px-2.5 py-1 font-medium text-white/75 hover:text-white rounded transition-all">Live</a>
          <a href="/strategies"   className="px-2.5 py-1 font-medium text-white/75 hover:text-white rounded transition-all">Strategies</a>
          <a href="/portfolio"    className="px-2.5 py-1 font-medium text-white/75 hover:text-white rounded transition-all">Portfolio</a>
          <a href="/reports"      className="px-2.5 py-1 font-medium text-white/75 hover:text-white rounded transition-all">Reports</a>
          <a href="/performance"  className="px-2.5 py-1 font-medium text-white/75 hover:text-white rounded transition-all">Performance</a>
        </nav>

        {/* Period selector */}
        <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5 ml-auto">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={cn(
                'px-2.5 py-1 font-semibold rounded transition-all',
                period === p.value
                  ? 'bg-violet-500/15 text-violet-300'
                  : 'text-white/75 hover:text-white',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        {lastFetched && (
          <span className="text-[10px] text-white/60 hidden md:inline tabular-nums">
            {lastFetched.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
          </span>
        )}

        <button
          onClick={fetchData}
          disabled={loading}
          className="h-7 w-7 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-white/75 hover:text-white hover:bg-zinc-800 transition-all disabled:opacity-40"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </header>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">

        {/* ── Symbol Sidebar ──────────────────────────────────────────────── */}
        <aside className="w-44 lg:w-52 shrink-0 flex flex-col" style={{ height: 'calc(100vh - 45px)', position: 'sticky', top: 45 }}>
          {listLoading
            ? (
              <div className="flex flex-col items-center justify-center flex-1 gap-2">
                <RefreshCw className="h-4 w-4 text-violet-500 animate-spin" />
                <span className="text-[11px] text-white/60">Loading symbols…</span>
              </div>
            )
            : (
              <SymbolSidebar
                symbols={symbols}
                selected={selected}
                onSelect={(s) => setSelected(s)}
              />
            )
          }
        </aside>

        {/* ── Main Content ────────────────────────────────────────────────── */}
        <main className="flex-1 min-w-0 overflow-y-auto px-4 py-4 flex flex-col gap-4">

          {/* Symbol header bar */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <div>
                <h1 className="text-[18px] font-bold text-white leading-tight">
                  {data?.label ?? selected}
                </h1>
                {data && (
                  <p className="text-[11px] text-white/70 mt-0.5">
                    {fmtDate(data.startDate)} – {fmtDate(data.endDate)}
                    {' · '}
                    <span className="text-white/80">{data.daysAvailable} trading days</span>
                    {data.daysAvailable < data.daysRequested && (
                      <span className="ml-1.5 text-amber-400">
                        (max available for {period})
                      </span>
                    )}
                  </p>
                )}
              </div>
            </div>

            {data && stats && (
              <div className="flex items-center gap-2 text-[11px]">
                <span className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-white/75">
                  μ = <span className="text-white font-mono">{fmtPct(stats.mean, 4)}</span>
                </span>
                <span className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-white/75">
                  σ = <span className="text-white font-mono">{stats.std.toFixed(4)}%</span>
                </span>
                <span className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-white/75">
                  n = <span className="text-white font-mono">{stats.n}</span>
                </span>
              </div>
            )}
          </div>

          {/* Error state */}
          {error && (
            <div className="rounded-lg border border-red-500/20 bg-red-950/10 p-6 text-center text-red-400 text-[13px] flex items-center justify-center gap-2">
              <Info className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {/* Loading state */}
          {loading && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 flex flex-col items-center justify-center py-24 gap-3">
              <RefreshCw className="h-7 w-7 text-violet-500 animate-spin" />
              <span className="text-white/70 text-[13px]">Computing distribution for {selected}…</span>
            </div>
          )}

          {/* Chart + Stats */}
          {!loading && data && stats && (
            <>
              {/* ── Distribution Chart ──────────────────────────────────── */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 lg:p-4">
                <DistributionSVGChart
                  stats={stats}
                  histogram={data.histogram}
                  normalCurve={data.normalCurve}
                />
              </div>

              {/* ── Key Metrics Row ─────────────────────────────────────── */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                <StatCard
                  label="Mean Daily Return"
                  value={fmtPct(stats.mean, 4)}
                  sub="Center of distribution"
                  color={stats.mean >= 0 ? 'text-emerald-400' : 'text-red-400'}
                />
                <StatCard
                  label="Std Dev (1σ)"
                  value={stats.std.toFixed(4) + '%'}
                  sub="Daily volatility measure"
                  color="text-white"
                />
                <StatCard
                  label="Skewness"
                  value={stats.skewness.toFixed(4)}
                  sub={sInterp?.label}
                  color={sInterp?.color}
                />
                <StatCard
                  label="Excess Kurtosis"
                  value={stats.kurtosis.toFixed(4)}
                  sub={kInterp?.label}
                  color={kInterp?.color}
                />
                <StatCard
                  label="Best Day"
                  value={fmtPct(stats.maxVal, 2)}
                  sub={fmtDate(stats.maxDate)}
                  color="text-emerald-400"
                />
                <StatCard
                  label="Worst Day"
                  value={fmtPct(stats.minVal, 2)}
                  sub={fmtDate(stats.minDate)}
                  color="text-red-400"
                />
              </div>

              {/* ── SD Coverage Bars ────────────────────────────────────── */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <CoverageBar
                  label="Within 1σ  (±1 Std Dev)"
                  actual={stats.within1SD}
                  theory={68.27}
                  color="text-emerald-400"
                />
                <CoverageBar
                  label="Within 2σ  (±2 Std Dev)"
                  actual={stats.within2SD}
                  theory={95.45}
                  color="text-orange-400"
                />
                <CoverageBar
                  label="Within 3σ  (±3 Std Dev)"
                  actual={stats.within3SD}
                  theory={99.73}
                  color="text-violet-400"
                />
              </div>

              {/* ── Interpretation panel ─────────────────────────────────── */}
              {kInterp && sInterp && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 flex flex-wrap gap-4 text-[12px]">
                  <div className="flex items-start gap-2 flex-1 min-w-[200px]">
                    <Info className="h-3.5 w-3.5 text-white/60 mt-0.5 shrink-0" />
                    <div>
                      <span className="text-white/70">Tail risk: </span>
                      <span className={cn('font-semibold', kInterp.color)}>{kInterp.label}</span>
                      <span className="text-white/65"> — {kInterp.desc}</span>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 flex-1 min-w-[200px]">
                    <Info className="h-3.5 w-3.5 text-white/60 mt-0.5 shrink-0" />
                    <div>
                      <span className="text-white/70">Outside 2σ: </span>
                      <span className={cn('font-semibold', (100 - stats.within2SD) > 4.55 ? 'text-orange-400' : 'text-green-400')}>
                        {(100 - stats.within2SD).toFixed(2)}% of days
                      </span>
                      <span className="text-white/65"> (theory: 4.55%) — options writers note</span>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 flex-1 min-w-[200px]">
                    <Info className="h-3.5 w-3.5 text-white/60 mt-0.5 shrink-0" />
                    <div>
                      <span className="text-white/70">Asymmetry: </span>
                      <span className={cn('font-semibold', sInterp.color)}>{sInterp.label}</span>
                      <span className="text-white/65"> (skew {fmtPct(stats.skewness * 100, 0)})</span>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Outlier Tables ──────────────────────────────────────── */}
              <div className="flex gap-3 flex-wrap lg:flex-nowrap">
                <OutlierTable
                  title="Top 5 Biggest Single-Day Gains"
                  rows={data.topGains}
                  positive
                />
                <OutlierTable
                  title="Top 5 Biggest Single-Day Losses"
                  rows={data.topLosses}
                  positive={false}
                />
              </div>
            </>
          )}

          {/* Empty state when no data and not loading */}
          {!loading && !data && !error && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 flex flex-col items-center justify-center py-24 gap-3">
              <BarChart2 className="h-8 w-8 text-white/50" />
              <p className="text-white/70 text-[13px]">Select a symbol to view its return distribution</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
