'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  TrendingUp, TrendingDown, Activity, RefreshCw, Zap, AlertTriangle, CheckCircle,
  Filter, Search, Layers, BarChart2, Crosshair, ArrowUpRight, ArrowDownRight,
  Flame, ShieldCheck, Sparkles, ChevronRight
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, Cell
} from 'recharts';
import { MoverResult, MoversResponse } from '@/app/api/movers/route';
import { cn } from '@/lib/utils';
import NavBar from './NavBar';

// ─── Formatters & Helpers ───────────────────────────────────────────────────
function fmt(n: number, digits = 2): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtPrice(n: number): string {
  return `₹${fmt(n, 2)}`;
}

function fmtCountdown(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ─── Generic Sort Hook ───────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function useSort<T extends Record<string, any>>(
  items: T[],
  defaultKey: keyof T,
  defaultDir: 'asc' | 'desc' = 'desc',
) {
  const [sort, setSort] = useState<{ key: keyof T; dir: 'asc' | 'desc' }>({
    key: defaultKey,
    dir: defaultDir,
  });

  const toggle = useCallback((k: keyof T) => {
    setSort(s => s.key === k
      ? { key: k, dir: s.dir === 'desc' ? 'asc' : 'desc' }
      : { key: k, dir: 'desc' });
  }, []);

  const sorted = useMemo(() => [...items].sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key];
    let cmp = 0;
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else if (typeof av === 'boolean' && typeof bv === 'boolean') cmp = Number(av) - Number(bv);
    else cmp = String(av ?? '').localeCompare(String(bv ?? ''));
    return sort.dir === 'asc' ? cmp : -cmp;
  }), [items, sort]);

  const colDir = (k: keyof T): 'asc' | 'desc' | undefined => sort.key === k ? sort.dir : undefined;
  return { sorted, toggle, colDir };
}

// ─── Micro Display Badges & Sparkline ────────────────────────────────────────
function PctCell({ v, bold }: { v: number; bold?: boolean }) {
  return (
    <span className={cn('font-mono tabular-nums', bold ? 'font-bold' : 'font-medium',
      v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-zinc-500')}>
      {v > 0 ? '+' : ''}{fmt(v, 2)}%
    </span>
  );
}

function PctPill({ v }: { v: number }) {
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold tabular-nums font-mono',
      v > 0 ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/25' :
      v < 0 ? 'bg-red-500/10 text-red-400 border border-red-500/25' :
      'bg-zinc-800 text-zinc-400 border border-zinc-700')}>
      {v > 0 ? '+' : ''}{fmt(v, 2)}%
    </span>
  );
}

function RSIBadge({ rsi }: { rsi: number }) {
  return (
    <span
      title={`Wilder RSI 14: ${fmt(rsi, 1)}`}
      className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums font-mono',
        rsi >= 70 ? 'bg-red-500/15 text-red-400 border border-red-500/30' :
        rsi >= 60 ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30' :
        rsi >= 40 ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' :
        'bg-zinc-800 text-zinc-400 border border-zinc-700')}>
      {fmt(rsi, 0)}
    </span>
  );
}

function MADots({ a20, a50, a200 }: { a20: boolean; a50: boolean; a200: boolean }) {
  return (
    <span className="inline-flex items-center gap-1" title={`MAs (20D / 50D / 200D): ${a20 ? 'Above' : 'Below'} 20D, ${a50 ? 'Above' : 'Below'} 50D, ${a200 ? 'Above' : 'Below'} 200D`}>
      <span className={cn('w-2 h-2 rounded-full transition-colors', a20 ? 'bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.6)]' : 'bg-red-500/80')} />
      <span className={cn('w-2 h-2 rounded-full transition-colors', a50 ? 'bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.6)]' : 'bg-red-500/80')} />
      <span className={cn('w-2 h-2 rounded-full transition-colors', a200 ? 'bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.6)]' : 'bg-red-500/80')} />
    </span>
  );
}

function VolBadge({ ratio }: { ratio: number }) {
  return (
    <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums font-mono',
      ratio >= 3 ? 'bg-purple-500/20 text-purple-300 border border-purple-500/35' :
      ratio >= 2 ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' :
      ratio >= 1.5 ? 'bg-blue-500/15 text-blue-300 border border-blue-500/25' :
      'bg-zinc-800/80 text-zinc-400 border border-zinc-700')}>
      {fmt(ratio, 1)}×
    </span>
  );
}

function MiniSparkline({ r }: { r: MoverResult }) {
  const vals = [r.priceChange1Y, r.priceChange3M, r.priceChange1M, r.priceChange1W, r.priceChange1D];
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const W = 42, H = 16;
  const pts = vals.map((v, i) => `${(i / 4) * W},${H - ((v - min) / range) * (H - 3) - 1.5}`).join(' ');
  const lastY = H - ((r.priceChange1D - min) / range) * (H - 3) - 1.5;
  const color = r.priceChange1D >= 0 ? '#34d399' : '#f87171';

  return (
    <svg width={W} height={H} className="inline-block flex-shrink-0 overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" opacity="0.9" />
      <circle cx={W} cy={lastY} r="2" fill={color} />
    </svg>
  );
}

// ─── Table Primitives (Strict dark theme styling with solid headers) ────────
function TH({
  children, right, className, sortDir, onSort, title,
}: {
  children?: React.ReactNode; right?: boolean; className?: string;
  sortDir?: 'asc' | 'desc'; onSort?: () => void; title?: string;
}) {
  return (
    <th
      title={title}
      className={cn(
        'py-2 px-3 text-xs font-bold text-white bg-zinc-800 uppercase tracking-wide whitespace-nowrap sticky top-0 z-10 select-none border-b border-zinc-700',
        right ? 'text-right' : 'text-left',
        onSort && 'cursor-pointer hover:bg-zinc-700 transition-colors',
        className
      )}
      onClick={onSort}
    >
      {onSort ? (
        <span className={cn('inline-flex items-center gap-1', right && 'justify-end w-full')}>
          {children}
          <span className="text-[10px] text-zinc-400 font-mono">
            {sortDir === 'asc' ? '▲' : sortDir === 'desc' ? '▼' : <span className="opacity-30">⇅</span>}
          </span>
        </span>
      ) : children}
    </th>
  );
}

function TD({ children, right, className }: { children?: React.ReactNode; right?: boolean; className?: string }) {
  return (
    <td className={cn('py-2 px-3 text-xs font-mono', right ? 'text-right' : 'text-left', className)}>
      {children}
    </td>
  );
}

function TR({ children, highlight, className }: { children: React.ReactNode; highlight?: boolean; className?: string }) {
  return (
    <tr className={cn('border-b border-zinc-800/60 hover:bg-zinc-800/40 transition-colors', highlight && 'bg-emerald-500/[0.04]', className)}>
      {children}
    </tr>
  );
}

// ─── Terminal Panel (dhan-bloomberg-dashboard-page formula) ─────────────────
// The title and the header's hairline rule are always amber — the terminal's
// own identity color, and the one constant that makes every panel on the page
// read as one instrument. `accent` only tints the small icon glyph, which is
// free to carry a per-panel meaning (Gainers vs Losers, Bull vs Bear volume)
// the way MarketDashboard's simpler, non-paired panels never needed to.
function CardPanel({
  title, eyebrow, count, icon: Icon, accent = 'text-amber-400', children,
  className, maxHeight, headerRight,
}: {
  title: string; eyebrow?: string; count?: number | string; icon?: React.ElementType;
  accent?: string; children: React.ReactNode; className?: string; maxHeight?: string;
  headerRight?: React.ReactNode;
}) {
  return (
    <div className={cn('bg-zinc-900/70 border border-zinc-800 rounded-xl shadow-sm overflow-hidden flex flex-col', className)}>
      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 border-b border-amber-500/25 bg-zinc-950/60 shrink-0">
        <div className="flex items-center gap-2.5">
          {/* Chip stays neutral so per-panel accent icons (Gainers vs Losers,
              Bull vs Bear volume) read clearly — the amber hairline below is
              this page's one constant chrome motif, not the chip color. */}
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
              <h3 className="text-[11px] font-bold uppercase tracking-[0.16em] text-amber-400 leading-none">{title}</h3>
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

      <div className={cn('overflow-x-auto flex-1', maxHeight && 'overflow-y-auto')} style={maxHeight ? { maxHeight } : undefined}>
        {children}
      </div>
    </div>
  );
}

// ─── Pulse Stat Box ─────────────────────────────────────────────────────────
function PulseStat({
  label, value, sub, color = 'text-zinc-100', size = 'text-xl', icon: Icon,
}: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; color?: string; size?: string; icon?: React.ElementType;
}) {
  return (
    <div className="flex flex-col min-w-0">
      <div className="flex items-center gap-1 text-[9px] font-bold text-zinc-500 uppercase tracking-[0.14em] mb-1">
        {Icon && <Icon className="w-3 h-3 text-zinc-400" />}
        <span>{label}</span>
      </div>
      <span className={cn(size, 'font-mono font-bold tabular-nums leading-none', color)}>{value}</span>
      {sub && <span className="text-[10px] text-zinc-400 mt-1 font-medium">{sub}</span>}
    </div>
  );
}

// ─── Custom Recharts Tooltip ────────────────────────────────────────────────
interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color?: string; payload: Record<string, unknown> }>;
  label?: string;
}

function SectorChartTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0];
  const d = p.payload as {
    sector: string; count: number; gainers: number; losers: number;
    avg1D: number; avg1W: number; avg1M: number; above200D: number; avgRSI: number;
  };

  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[210px] font-mono">
      <p className="text-zinc-100 font-bold mb-2 font-sans text-sm">{label || d.sector}</p>
      <div className="flex justify-between gap-6 mb-1 text-zinc-400 font-sans">
        <span>Stocks count</span>
        <span className="text-zinc-200 font-bold font-mono">{d.count}</span>
      </div>
      <div className="flex justify-between gap-6 mb-1">
        <span className="text-zinc-400 font-sans">Avg 1D Return</span>
        <span className={cn('font-bold font-mono', d.avg1D >= 0 ? 'text-emerald-400' : 'text-red-400')}>
          {d.avg1D >= 0 ? '+' : ''}{fmt(d.avg1D, 2)}%
        </span>
      </div>
      <div className="flex justify-between gap-6 mb-1">
        <span className="text-zinc-400 font-sans">Avg 1W Return</span>
        <span className={cn('font-bold font-mono', d.avg1W >= 0 ? 'text-emerald-400' : 'text-red-400')}>
          {d.avg1W >= 0 ? '+' : ''}{fmt(d.avg1W, 2)}%
        </span>
      </div>
      <div className="flex justify-between gap-6 mb-2">
        <span className="text-zinc-400 font-sans">Avg 1M Return</span>
        <span className={cn('font-bold font-mono', d.avg1M >= 0 ? 'text-emerald-400' : 'text-red-400')}>
          {d.avg1M >= 0 ? '+' : ''}{fmt(d.avg1M, 2)}%
        </span>
      </div>
      <div className="pt-2 border-t border-zinc-800 flex justify-between gap-6 mb-1">
        <span className="text-zinc-400 font-sans">Adv / Dec</span>
        <span className="font-mono">
          <span className="text-emerald-400">{d.gainers}</span> / <span className="text-red-400">{d.losers}</span>
        </span>
      </div>
      <div className="flex justify-between gap-6 mb-1">
        <span className="text-zinc-400 font-sans">&gt; 200D SMA</span>
        <span className="text-zinc-200 font-bold font-mono">{d.above200D}/{d.count} ({Math.round((d.above200D / d.count) * 100)}%)</span>
      </div>
      <div className="flex justify-between gap-6">
        <span className="text-zinc-400 font-sans">Avg RSI</span>
        <span className="text-zinc-200 font-bold font-mono">{fmt(d.avgRSI, 1)}</span>
      </div>
    </div>
  );
}

// ─── Sector Analytics Helper ─────────────────────────────────────────────────
interface SectorStat {
  sector: string; count: number; gainers: number; losers: number;
  avg1D: number; avg1W: number; avg1M: number; above200D: number; avgRSI: number;
}

function computeSectorStats(movers: MoverResult[]): SectorStat[] {
  const map = new Map<string, MoverResult[]>();
  for (const m of movers) {
    const s = m.sector || 'Other';
    if (!map.has(s)) map.set(s, []);
    map.get(s)!.push(m);
  }
  return Array.from(map.entries()).map(([sector, items]) => {
    const avg = (fn: (m: MoverResult) => number) => items.reduce((a, m) => a + fn(m), 0) / items.length;
    return {
      sector,
      count: items.length,
      gainers: items.filter(m => m.priceChange1D > 0).length,
      losers: items.filter(m => m.priceChange1D < 0).length,
      avg1D: avg(m => m.priceChange1D),
      avg1W: avg(m => m.priceChange1W),
      avg1M: avg(m => m.priceChange1M),
      above200D: items.filter(m => m.aboveMa200).length,
      avgRSI: avg(m => m.rsi14),
    };
  });
}

// ─── Market Breadth Calculator ──────────────────────────────────────────────
interface BreadthSummary {
  total: number; advances: number; declines: number; unchanged: number;
  above20D: number; above50D: number; above200D: number;
  rsiOverbought: number; rsiNeutral: number; rsiOversold: number;
  highVolCount: number;
}

function computeBreadth(movers: MoverResult[]): BreadthSummary {
  const n = movers.length;
  return {
    total: n,
    advances: movers.filter(m => m.priceChange1D > 0).length,
    declines: movers.filter(m => m.priceChange1D < 0).length,
    unchanged: movers.filter(m => m.priceChange1D === 0).length,
    above20D: movers.filter(m => m.aboveMa20).length,
    above50D: movers.filter(m => m.aboveMa50).length,
    above200D: movers.filter(m => m.aboveMa200).length,
    rsiOverbought: movers.filter(m => m.rsi14 >= 70).length,
    rsiNeutral: movers.filter(m => m.rsi14 >= 40 && m.rsi14 < 70).length,
    rsiOversold: movers.filter(m => m.rsi14 < 40).length,
    highVolCount: movers.filter(m => m.volumeRatio >= 1.5).length,
  };
}

// ─── Setup Star Scoring for NR Breakouts ─────────────────────────────────────
function nrScore(r: MoverResult): number {
  let s = 0;
  if (r.isNR7) s++;
  if (r.rsi14 >= 40 && r.rsi14 <= 65) s++;
  if (r.aboveMa200) s++;
  return s;
}

// ─── Sub-Table: Gainers / Losers Leaderboard ─────────────────────────────────
function MoversRankTable({
  rows, defaultKey = 'priceChange1D',
}: {
  rows: MoverResult[]; defaultKey?: keyof MoverResult;
}) {
  const { sorted, toggle, colDir } = useSort(rows, defaultKey, 'desc');

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <TH>#</TH>
          <TH onSort={() => toggle('symbol')} sortDir={colDir('symbol')}>Symbol</TH>
          <TH onSort={() => toggle('sector')} sortDir={colDir('sector')}>Sector</TH>
          <TH right onSort={() => toggle('latestClose')} sortDir={colDir('latestClose')}>LTP</TH>
          <TH right onSort={() => toggle('priceChange1D')} sortDir={colDir('priceChange1D')}>1D%</TH>
          <TH right onSort={() => toggle('priceChange1W')} sortDir={colDir('priceChange1W')}>1W%</TH>
          <TH right onSort={() => toggle('priceChange1M')} sortDir={colDir('priceChange1M')}>1M%</TH>
          <TH right onSort={() => toggle('volumeRatio')} sortDir={colDir('volumeRatio')}>Vol Ratio</TH>
          <TH right onSort={() => toggle('rsi14')} sortDir={colDir('rsi14')}>RSI</TH>
          <TH right>MAs</TH>
          <TH right>Trend</TH>
        </tr>
      </thead>
      <tbody>
        {sorted.length === 0 ? (
          <tr><td colSpan={11} className="text-center text-zinc-500 text-xs py-8 font-mono">No stocks available</td></tr>
        ) : (
          (sorted as MoverResult[]).map((r, i) => (
            <TR key={r.symbol}>
              <TD className="text-zinc-500 w-6">{i + 1}</TD>
              <TD className="font-bold text-zinc-100">{r.symbol}</TD>
              <TD className="text-zinc-400 max-w-[120px] truncate text-[11px]">{r.sector || '—'}</TD>
              <TD right className="text-zinc-200 font-bold">{fmtPrice(r.latestClose)}</TD>
              <TD right><PctPill v={r.priceChange1D} /></TD>
              <TD right><PctCell v={r.priceChange1W} /></TD>
              <TD right><PctCell v={r.priceChange1M} /></TD>
              <TD right><VolBadge ratio={r.volumeRatio} /></TD>
              <TD right><RSIBadge rsi={r.rsi14} /></TD>
              <TD right><MADots a20={r.aboveMa20} a50={r.aboveMa50} a200={r.aboveMa200} /></TD>
              <TD right><MiniSparkline r={r} /></TD>
            </TR>
          ))
        )}
      </tbody>
    </table>
  );
}

// ─── Sub-Table: Volume Surge Leaders ─────────────────────────────────────────
function VolumeSurgeTable({
  rows, dir,
}: {
  rows: MoverResult[]; dir: 'bull' | 'bear';
}) {
  const filtered = useMemo(() => {
    return rows.filter(r => dir === 'bull' ? r.priceChange1D > 0 : r.priceChange1D < 0);
  }, [rows, dir]);

  const { sorted, toggle, colDir } = useSort(filtered, 'volumeRatio', 'desc');

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <TH>#</TH>
          <TH onSort={() => toggle('symbol')} sortDir={colDir('symbol')}>Symbol</TH>
          <TH onSort={() => toggle('sector')} sortDir={colDir('sector')}>Sector</TH>
          <TH right onSort={() => toggle('latestClose')} sortDir={colDir('latestClose')}>LTP</TH>
          <TH right onSort={() => toggle('volumeRatio')} sortDir={colDir('volumeRatio')}>Vol Multiplier</TH>
          <TH right onSort={() => toggle('priceChange1D')} sortDir={colDir('priceChange1D')}>1D Change</TH>
          <TH right onSort={() => toggle('priceChange1W')} sortDir={colDir('priceChange1W')}>1W%</TH>
          <TH right onSort={() => toggle('rsi14')} sortDir={colDir('rsi14')}>RSI</TH>
          <TH right>MAs</TH>
        </tr>
      </thead>
      <tbody>
        {sorted.length === 0 ? (
          <tr><td colSpan={9} className="text-center text-zinc-500 text-xs py-8 font-mono">No volume surge candidates</td></tr>
        ) : (
          (sorted as MoverResult[]).slice(0, 15).map((r, i) => (
            <TR key={r.symbol}>
              <TD className="text-zinc-500 w-6">{i + 1}</TD>
              <TD className="font-bold text-zinc-100">{r.symbol}</TD>
              <TD className="text-zinc-400 max-w-[120px] truncate text-[11px]">{r.sector || '—'}</TD>
              <TD right className="text-zinc-200">{fmtPrice(r.latestClose)}</TD>
              <TD right><VolBadge ratio={r.volumeRatio} /></TD>
              <TD right><PctPill v={r.priceChange1D} /></TD>
              <TD right><PctCell v={r.priceChange1W} /></TD>
              <TD right><RSIBadge rsi={r.rsi14} /></TD>
              <TD right><MADots a20={r.aboveMa20} a50={r.aboveMa50} a200={r.aboveMa200} /></TD>
            </TR>
          ))
        )}
      </tbody>
    </table>
  );
}

// ─── Sub-Table: NR4 / NR7 Breakout Setups ────────────────────────────────────
function NRBreakoutTable({ nr4, nr7 }: { nr4: MoverResult[]; nr7: MoverResult[] }) {
  const combined = useMemo(() => {
    const seen = new Set<string>();
    const all: (MoverResult & { isNR7real: boolean })[] = [];
    for (const r of nr7) { seen.add(r.symbol); all.push({ ...r, isNR7real: true }); }
    for (const r of nr4) { if (!seen.has(r.symbol)) all.push({ ...r, isNR7real: false }); }
    return all;
  }, [nr4, nr7]);

  const { sorted, toggle, colDir } = useSort(combined, 'rsi14', 'asc');

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <TH>#</TH>
          <TH onSort={() => toggle('symbol')} sortDir={colDir('symbol')}>Symbol</TH>
          <TH onSort={() => toggle('sector')} sortDir={colDir('sector')}>Sector</TH>
          <TH right onSort={() => toggle('latestClose')} sortDir={colDir('latestClose')}>LTP</TH>
          <TH right>Setup Quality</TH>
          <TH right>Pattern</TH>
          <TH right>Compression</TH>
          <TH right onSort={() => toggle('rsi14')} sortDir={colDir('rsi14')}>RSI (14)</TH>
          <TH right>MA Alignment</TH>
          <TH right onSort={() => toggle('priceChange1D')} sortDir={colDir('priceChange1D')}>1D%</TH>
        </tr>
      </thead>
      <tbody>
        {sorted.length === 0 ? (
          <tr><td colSpan={10} className="text-center text-zinc-500 text-xs py-8 font-mono">No NR compression patterns today</td></tr>
        ) : (
          (sorted as (MoverResult & { isNR7real: boolean })[]).map((r, i) => {
            const maxR = r.isNR7real ? r.maxRange7D : r.maxRange4D;
            const rangePct = maxR > 0 ? (r.nr7Range / maxR) * 100 : 0;
            const score = nrScore(r);

            return (
              <TR key={r.symbol} highlight={score === 3}>
                <TD className="text-zinc-500 w-6">{i + 1}</TD>
                <TD className="font-bold text-zinc-100">{r.symbol}</TD>
                <TD className="text-zinc-400 max-w-[120px] truncate text-[11px]">{r.sector || '—'}</TD>
                <TD right className="text-zinc-200">{fmtPrice(r.latestClose)}</TD>
                <TD right>
                  {/* 3=hot uses the full chrome accent, 2=lukewarm gets a
                      distinct neutral rather than a second un-tokenized amber
                      step (dhan-bloomberg-dashboard-page: text accents cap at
                      -400) — zinc-300 reads as "worth a look", not "graded". */}
                  <span className={cn('text-xs font-bold font-mono',
                    score === 3 ? 'text-amber-400' : score === 2 ? 'text-zinc-300' : 'text-zinc-600')}>
                    {'★'.repeat(score) + '☆'.repeat(3 - score)}
                  </span>
                </TD>
                <TD right>
                  <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded font-mono border',
                    r.isNR7real ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' : 'bg-sky-500/15 text-sky-300 border-sky-500/30')}>
                    {r.isNR7real ? 'NR7' : 'NR4'}
                  </span>
                </TD>
                <TD right>
                  <div className="inline-flex items-center gap-1.5 justify-end">
                    <div className="w-12 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                      <div
                        className={cn('h-full rounded-full', rangePct < 40 ? 'bg-cyan-400' : rangePct < 70 ? 'bg-sky-400' : 'bg-zinc-600')}
                        style={{ width: `${Math.min(100, rangePct)}%` }}
                      />
                    </div>
                    <span className="font-mono text-[11px] text-zinc-300 w-8 text-right">{fmt(rangePct, 0)}%</span>
                  </div>
                </TD>
                <TD right><RSIBadge rsi={r.rsi14} /></TD>
                <TD right><MADots a20={r.aboveMa20} a50={r.aboveMa50} a200={r.aboveMa200} /></TD>
                <TD right><PctCell v={r.priceChange1D} /></TD>
              </TR>
            );
          })
        )}
      </tbody>
    </table>
  );
}

// ─── Sub-Table: 52-Week High / Low Radar ────────────────────────────────────
function HighLowRadarTable({ rows, type }: { rows: MoverResult[]; type: 'high' | 'low' }) {
  const defaultKey = type === 'high' ? 'pctFrom52WHigh' : 'pctFrom52WLow';
  const { sorted, toggle, colDir } = useSort(rows, defaultKey, type === 'high' ? 'desc' : 'asc');

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <TH>#</TH>
          <TH onSort={() => toggle('symbol')} sortDir={colDir('symbol')}>Symbol</TH>
          <TH onSort={() => toggle('sector')} sortDir={colDir('sector')}>Sector</TH>
          <TH right onSort={() => toggle('latestClose')} sortDir={colDir('latestClose')}>LTP</TH>
          <TH right>{type === 'high' ? '52W High' : '52W Low'}</TH>
          <TH right onSort={() => toggle(defaultKey)} sortDir={colDir(defaultKey)}>
            {type === 'high' ? 'Gap to High' : 'Above Low'}
          </TH>
          <TH right onSort={() => toggle('priceChange1D')} sortDir={colDir('priceChange1D')}>1D%</TH>
          <TH right onSort={() => toggle('rsi14')} sortDir={colDir('rsi14')}>RSI</TH>
          <TH right>MAs</TH>
        </tr>
      </thead>
      <tbody>
        {sorted.length === 0 ? (
          <tr><td colSpan={9} className="text-center text-zinc-500 text-xs py-8 font-mono">No stocks near extreme</td></tr>
        ) : (
          (sorted as MoverResult[]).map((r, i) => (
            <TR key={r.symbol}>
              <TD className="text-zinc-500 w-6">{i + 1}</TD>
              <TD className="font-bold text-zinc-100">{r.symbol}</TD>
              <TD className="text-zinc-400 max-w-[120px] truncate text-[11px]">{r.sector || '—'}</TD>
              <TD right className="text-zinc-200">{fmtPrice(r.latestClose)}</TD>
              <TD right className="text-zinc-400">{fmtPrice(type === 'high' ? r.high52W : r.low52W)}</TD>
              <TD right className="font-bold font-mono">
                {type === 'high' ? (
                  r.pctFrom52WHigh >= 0 ? (
                    <span className="text-amber-400 font-bold">AT HIGH</span>
                  ) : (
                    <span className={r.pctFrom52WHigh >= -1 ? 'text-amber-300' : 'text-zinc-300'}>
                      {fmt(r.pctFrom52WHigh, 2)}%
                    </span>
                  )
                ) : (
                  <span className="text-orange-400 font-bold">+{fmt(r.pctFrom52WLow, 2)}%</span>
                )}
              </TD>
              <TD right><PctCell v={r.priceChange1D} /></TD>
              <TD right><RSIBadge rsi={r.rsi14} /></TD>
              <TD right><MADots a20={r.aboveMa20} a50={r.aboveMa50} a200={r.aboveMa200} /></TD>
            </TR>
          ))
        )}
      </tbody>
    </table>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────
export default function MarketMovers() {
  const [indexType, setIndexType] = useState<'nifty50' | 'nifty500'>('nifty50');
  const [activeTab, setActiveTab] = useState<'movers' | 'sectors' | 'setups' | 'screener'>('movers');
  const [data, setData] = useState<MoversResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [quoteFetching, setQuoteFetching] = useState(false);
  const [quoteStatus, setQuoteStatus] = useState<'idle' | 'fetching' | 'done' | 'error'>('idle');
  const [autoIn, setAutoIn] = useState(300);
  const [searchTerm, setSearchTerm] = useState('');
  const [sectorMetric, setSectorMetric] = useState<'1D' | '1W' | '1M'>('1D');

  // Screener custom filters
  const [screenerDirection, setScreenerDirection] = useState<'rise' | 'fall'>('rise');
  const [screenerPct, setScreenerPct] = useState(3);
  const [screenerDuration, setScreenerDuration] = useState<'1D' | '1W' | '1M' | '3M' | '5M' | '1Y'>('1W');
  const [screenerSector, setScreenerSector] = useState<string>('ALL');
  const [screenerRsiFilter, setScreenerRsiFilter] = useState<'ALL' | 'OB' | 'NEUTRAL' | 'OS'>('ALL');
  const [screenerMaFilter, setScreenerMaFilter] = useState<'ALL' | 'ABOVE_200' | 'ABOVE_ALL'>('ALL');

  const quotePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchDataRef = useRef<(showLoading?: boolean, bust?: boolean) => Promise<void>>(async () => {});

  const fetchData = useCallback(async (showLoading = true, bust = false) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const url = bust ? `/api/movers?index=${indexType}&bust` : `/api/movers?index=${indexType}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.success) {
        setData(json.data);
        setLastUpdated(new Date());
      } else {
        setError(json.error ?? 'Unknown error loading movers');
      }
    } catch {
      setError('Network error while retrieving market movers');
    } finally {
      setLoading(false);
    }
  }, [indexType]);

  useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
  useEffect(() => { fetchData(); }, [fetchData]);

  // Auto-refresh countdown (5m loop)
  useEffect(() => {
    if (!data) return;
    if (autoRef.current) clearInterval(autoRef.current);
    setAutoIn(300);
    autoRef.current = setInterval(() => {
      setAutoIn(c => {
        if (c <= 1) {
          fetchDataRef.current(false);
          return 300;
        }
        return c - 1;
      });
    }, 1000);
    return () => { if (autoRef.current) clearInterval(autoRef.current); };
  }, [data]);

  const fetchLiveQuotes = useCallback(async () => {
    if (quoteFetching) return;
    setQuoteFetching(true);
    setQuoteStatus('fetching');
    try {
      const res = await fetch('/api/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'quotes' }),
      });
      if (!res.ok) {
        setQuoteStatus('error');
        setQuoteFetching(false);
        return;
      }
      if (quotePollRef.current) clearInterval(quotePollRef.current);
      quotePollRef.current = setInterval(async () => {
        try {
          const sj = await (await fetch('/api/refresh')).json();
          const done = sj.status?.done || (!sj.running && sj.status?.phase === 'done');
          if (sj.status?.error) {
            setQuoteStatus('error');
            setQuoteFetching(false);
            clearInterval(quotePollRef.current!);
          } else if (done) {
            setQuoteStatus('done');
            setQuoteFetching(false);
            clearInterval(quotePollRef.current!);
            setTimeout(() => fetchData(false, true), 500);
          }
        } catch { /* ignore */ }
      }, 1500);
    } catch {
      setQuoteStatus('error');
      setQuoteFetching(false);
    }
  }, [quoteFetching, fetchData]);

  useEffect(() => () => {
    if (quotePollRef.current) clearInterval(quotePollRef.current);
    if (autoRef.current) clearInterval(autoRef.current);
  }, []);

  // ─── Analytics computations ───────────────────────────────────────────────
  const breadth = useMemo(() => data ? computeBreadth(data.allMovers) : null, [data]);
  const sectorStats = useMemo(() => data ? computeSectorStats(data.allMovers) : [], [data]);

  const sortedSectorStats = useMemo(() => {
    return [...sectorStats].sort((a, b) => {
      if (sectorMetric === '1D') return b.avg1D - a.avg1D;
      if (sectorMetric === '1W') return b.avg1W - a.avg1W;
      return b.avg1M - a.avg1M;
    });
  }, [sectorStats, sectorMetric]);

  const momentumLeaders = useMemo(() => {
    if (!data) return [];
    return data.allMovers
      .filter(m => m.priceChange1W > 3 && m.priceChange1M > 5 && m.priceChange3M > 10)
      .sort((a, b) => (b.priceChange1W + b.priceChange1M + b.priceChange3M) - (a.priceChange1W + a.priceChange1M + a.priceChange3M));
  }, [data]);

  const pullbackSetups = useMemo(() => {
    if (!data) return [];
    return data.allMovers
      .filter(m => m.aboveMa200 && (!m.aboveMa20 || !m.aboveMa50) && m.rsi14 < 60)
      .sort((a, b) => b.pctFrom52WHigh - a.pctFrom52WHigh);
  }, [data]);

  const distinctSectors = useMemo(() => {
    if (!data) return [];
    const set = new Set<string>();
    data.allMovers.forEach(m => { if (m.sector) set.add(m.sector); });
    return Array.from(set).sort();
  }, [data]);

  // Screener filtered list
  const screenerResults = useMemo(() => {
    if (!data) return [];
    const durationKeyMap: Record<string, keyof MoverResult> = {
      '1D': 'priceChange1D',
      '1W': 'priceChange1W',
      '1M': 'priceChange1M',
      '3M': 'priceChange3M',
      '5M': 'priceChange5M',
      '1Y': 'priceChange1Y',
    };
    const key = durationKeyMap[screenerDuration];

    return data.allMovers.filter(m => {
      // Search term
      if (searchTerm) {
        const q = searchTerm.toLowerCase();
        const matchesSymbol = m.symbol.toLowerCase().includes(q);
        const matchesSector = (m.sector || '').toLowerCase().includes(q);
        if (!matchesSymbol && !matchesSector) return false;
      }

      // Sector filter
      if (screenerSector !== 'ALL' && m.sector !== screenerSector) return false;

      // Direction and threshold
      const val = (m[key] as number) ?? 0;
      if (screenerDirection === 'rise' && val < screenerPct) return false;
      if (screenerDirection === 'fall' && val > -screenerPct) return false;

      // RSI filter
      if (screenerRsiFilter === 'OB' && m.rsi14 < 70) return false;
      if (screenerRsiFilter === 'NEUTRAL' && (m.rsi14 < 40 || m.rsi14 > 60)) return false;
      if (screenerRsiFilter === 'OS' && m.rsi14 >= 40) return false;

      // MA filter
      if (screenerMaFilter === 'ABOVE_200' && !m.aboveMa200) return false;
      if (screenerMaFilter === 'ABOVE_ALL' && (!m.aboveMa20 || !m.aboveMa50 || !m.aboveMa200)) return false;

      return true;
    }).sort((a, b) => {
      const va = (a[key] as number) ?? 0;
      const vb = (b[key] as number) ?? 0;
      return screenerDirection === 'rise' ? vb - va : va - vb;
    });
  }, [data, searchTerm, screenerSector, screenerDuration, screenerDirection, screenerPct, screenerRsiFilter, screenerMaFilter]);

  // Screener table sort
  const { sorted: sortedScreenerList, toggle: toggleScreenerSort, colDir: screenerColDir } = useSort(
    screenerResults,
    'priceChange1D',
    'desc'
  );

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      {/* ─── Sticky Header ───────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/25 shrink-0">
            <TrendingUp className="w-4 h-4 text-amber-400" />
          </div>
          <div>
            <p className="text-[9px] font-bold text-amber-400 uppercase tracking-[0.18em] mb-0.5">
              Analytics · Cross-Sectional Momentum
            </p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">
              Market Movers Intelligence
            </h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              Cross-sectional price momentum, volume expansion, compression setups &amp; sector rotation
            </p>
          </div>
        </div>

        <NavBar />

        {/* Global Controls */}
        <div className="flex items-center gap-2.5 flex-wrap ml-auto">
          {/* Index Selector */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            {(['nifty50', 'nifty500'] as const).map(t => (
              <button
                key={t}
                onClick={() => setIndexType(t)}
                className={cn(
                  'px-3 py-1 text-xs font-mono font-bold rounded-md transition-colors uppercase tracking-wider',
                  indexType === t
                    ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                    : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
                )}
              >
                {t === 'nifty50' ? 'Nifty 50' : 'Nifty 500'}
              </button>
            ))}
          </div>

          {/* Data Date Chip */}
          {data?.dataDate && (
            <span className="text-[10px] font-mono font-bold text-amber-300 px-2.5 py-1 rounded-md bg-zinc-900 border border-zinc-800 uppercase tracking-wide">
              DATA: {data.dataDate}
            </span>
          )}

          {/* Auto Refresh Countdown */}
          {data && !loading && (
            <span className="text-[10px] text-zinc-500 font-mono tabular-nums px-2 py-1 rounded bg-zinc-900/60 border border-zinc-800/80">
              AUTO: {fmtCountdown(autoIn)}
            </span>
          )}

          {/* Manual Refresh */}
          <button
            onClick={() => fetchData(true, true)}
            disabled={loading}
            className="h-7 w-7 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-amber-400 hover:border-amber-500/40 transition-colors disabled:opacity-50"
            title="Force refresh data"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin text-amber-400')} />
          </button>
        </div>
      </header>

      {/* ─── Main Content Container ──────────────────────────────────────── */}
      <main className="flex-1 flex flex-col gap-4 px-6 py-5">
        {/* Intraday Freshness Banner */}
        {data && (() => {
          const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
          const isStale = data.dataDate < todayIST;
          const hasLive = data.liveQuotesMeta?.date === todayIST;

          if (!isStale && hasLive) {
            return (
              <div className="flex items-center gap-2.5 px-4 py-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 text-xs text-emerald-400 font-mono">
                <CheckCircle className="h-4 w-4 shrink-0 text-emerald-400" />
                <span>
                  LIVE INTRADAY SNAPSHOT — {todayIST} (Updated {new Date(data.liveQuotesMeta!.updatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST)
                </span>
                <button
                  onClick={fetchLiveQuotes}
                  disabled={quoteFetching}
                  className="ml-auto flex items-center gap-1.5 px-2.5 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 font-bold uppercase tracking-wider text-[10px] text-emerald-300 transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={cn('h-3 w-3', quoteFetching && 'animate-spin')} />
                  {quoteFetching ? 'Syncing...' : 'Sync Live'}
                </button>
              </div>
            );
          }

          if (isStale) {
            return (
              <div className="flex flex-wrap items-center gap-3 px-4 py-2 rounded-xl border border-amber-500/30 bg-amber-500/10 text-xs font-mono">
                <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
                <span className="text-amber-300 font-bold uppercase tracking-wide">
                  EOD Consensus: {data.dataDate || '—'}
                </span>
                <span className="text-zinc-400">
                  Today&apos;s closing candle is pending EOD batch. You can fetch live intraday broker quotes.
                </span>
                {quoteStatus === 'done' && (
                  <span className="flex items-center gap-1 text-emerald-400 font-bold">
                    <CheckCircle className="h-3.5 w-3.5" /> Fetched
                  </span>
                )}
                {quoteStatus === 'error' && (
                  <span className="text-red-400 font-bold">Fetch failed (Verify broker login)</span>
                )}
                <button
                  onClick={fetchLiveQuotes}
                  disabled={quoteFetching}
                  className="ml-auto flex items-center gap-1.5 px-3 py-1 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 font-bold uppercase tracking-wider text-[11px] transition-colors disabled:opacity-50"
                >
                  <Zap className={cn('h-3.5 w-3.5', quoteFetching && 'animate-pulse text-amber-400')} />
                  {quoteFetching ? 'Fetching Live Quotes...' : 'Fetch Live Quotes'}
                </button>
              </div>
            );
          }
          return null;
        })()}

        {/* Error Alert */}
        {error && (
          <div className="p-4 rounded-xl border border-red-500/30 bg-red-950/20 text-red-400 text-xs font-mono">
            {error}
          </div>
        )}

        {/* Loading State */}
        {loading && !data && (
          <div className="flex flex-col items-center justify-center py-28 gap-3">
            <div className="w-8 h-8 border-2 border-zinc-700 border-t-amber-400 rounded-full animate-spin" />
            <p className="text-sm text-zinc-400 font-medium">Computing market movers across {indexType.toUpperCase()}…</p>
          </div>
        )}

        {!loading && data && breadth && (
          <>
            {/* ─── Market Pulse Ribbon ─────────────────────────────────── */}
            <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-emerald-500/[0.05] via-transparent to-blue-500/[0.05]" />

              <div className="relative grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-5">
                {/* 1. Advance / Decline */}
                <PulseStat
                  label="Advance / Decline"
                  value={
                    <span className="flex items-center gap-1.5">
                      <span className="text-emerald-400">{breadth.advances}</span>
                      <span className="text-zinc-600">/</span>
                      <span className="text-red-400">{breadth.declines}</span>
                    </span>
                  }
                  sub={
                    <span>
                      Ratio: <strong className={breadth.declines > 0 && breadth.advances / breadth.declines >= 1 ? 'text-emerald-400' : 'text-red-400'}>
                        {breadth.declines > 0 ? (breadth.advances / breadth.declines).toFixed(2) : '∞'}x
                      </strong> ({breadth.total} total)
                    </span>
                  }
                  icon={Activity}
                />

                {/* 2. MA Penetration */}
                <PulseStat
                  label="> 200D SMA"
                  value={`${Math.round((breadth.above200D / breadth.total) * 100)}%`}
                  color={breadth.above200D / breadth.total >= 0.5 ? 'text-emerald-400' : 'text-amber-400'}
                  sub={`20D: ${Math.round((breadth.above20D / breadth.total) * 100)}% · 50D: ${Math.round((breadth.above50D / breadth.total) * 100)}%`}
                  icon={ShieldCheck}
                />

                {/* 3. Volume Expansion */}
                <PulseStat
                  label="Volume Surge (≥1.5x)"
                  value={breadth.highVolCount}
                  color={breadth.highVolCount > 10 ? 'text-purple-300' : 'text-zinc-200'}
                  sub={`${data.highVolume.filter(v => v.priceChange1D > 0).length} Bull / ${data.highVolume.filter(v => v.priceChange1D < 0).length} Bear`}
                  icon={Flame}
                />

                {/* 4. NR Volatility Squeeze */}
                <PulseStat
                  label="NR Squeeze Setups"
                  value={data.nr4.length + data.nr7.length}
                  color="text-cyan-300"
                  sub={`${data.nr7.length} NR7 (7D tight) · ${data.nr4.length} NR4`}
                  icon={Sparkles}
                />

                {/* 5. 52W Extremes */}
                <PulseStat
                  label="52W Extremes"
                  value={
                    <span className="flex items-center gap-1.5">
                      <span className="text-amber-400">{data.high52W.length}</span>
                      <span className="text-zinc-600">/</span>
                      <span className="text-orange-400">{data.low52W.length}</span>
                    </span>
                  }
                  sub="Near High (≤2%) / Near Low (≤5%)"
                  icon={Crosshair}
                />

                {/* 6. Consecutive Streaks */}
                <PulseStat
                  label="5-Day Streaks"
                  value={
                    <span className="flex items-center gap-1.5">
                      <span className="text-sky-400">{data.rising5D.length}▲</span>
                      <span className="text-zinc-600">/</span>
                      <span className="text-rose-400">{data.falling5D.length}▼</span>
                    </span>
                  }
                  sub="Rising 5D / Falling 5D"
                  icon={BarChart2}
                />
              </div>
            </div>

            {/* ─── View Mode Switcher ──────────────────────────────────── */}
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2 flex-wrap">
              <div className="flex items-center bg-zinc-900 border border-zinc-800 p-1 rounded-xl gap-1">
                {[
                  { id: 'movers', label: 'Movers & Volume Breakouts', icon: TrendingUp },
                  { id: 'sectors', label: 'Sector Performance', icon: Layers },
                  { id: 'setups', label: 'Technical Setups & Radar', icon: Crosshair },
                  { id: 'screener', label: 'Multi-Factor Matrix', icon: Filter },
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
                          ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30 shadow-sm'
                          : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
                      )}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Quick Search */}
              <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-xl">
                <Search className="w-3.5 h-3.5 text-zinc-400" />
                <input
                  type="text"
                  placeholder="Filter symbol or sector…"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  className="bg-transparent text-xs text-zinc-100 placeholder:text-zinc-500 outline-none w-44 font-mono"
                />
                {searchTerm && (
                  <button onClick={() => setSearchTerm('')} className="text-zinc-500 hover:text-zinc-300 text-xs font-bold">
                    ✕
                  </button>
                )}
              </div>
            </div>

            {/* ─── TAB 1: MOVERS & VOLUME BREAKOUTS ────────────────────── */}
            {activeTab === 'movers' && (
              <div className="flex flex-col gap-4">
                {/* Top Gainers & Losers */}
                <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
                  <CardPanel
                    title="Top Gainers (1D Velocity)"
                    eyebrow="Momentum Acceleration"
                    count={data.gainers.length}
                    icon={ArrowUpRight}
                    accent="text-emerald-400"
                    maxHeight="420px"
                  >
                    <MoversRankTable rows={data.gainers} defaultKey="priceChange1D" />
                  </CardPanel>

                  <CardPanel
                    title="Top Losers (1D Distribution)"
                    eyebrow="Downside Velocity"
                    count={data.losers.length}
                    icon={ArrowDownRight}
                    accent="text-red-400"
                    maxHeight="420px"
                  >
                    <MoversRankTable rows={data.losers} defaultKey="priceChange1D" />
                  </CardPanel>
                </div>

                {/* Volume Surge Tables */}
                <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
                  <CardPanel
                    title="Bullish Volume Expansion"
                    eyebrow="Heavy Accumulation"
                    count={data.highVolume.filter(r => r.priceChange1D > 0).length}
                    icon={Flame}
                    accent="text-purple-400"
                    maxHeight="400px"
                  >
                    <VolumeSurgeTable rows={data.highVolume} dir="bull" />
                  </CardPanel>

                  <CardPanel
                    title="Bearish Volume Distribution"
                    eyebrow="Heavy Liquidation"
                    count={data.highVolume.filter(r => r.priceChange1D < 0).length}
                    icon={Flame}
                    accent="text-rose-400"
                    maxHeight="400px"
                  >
                    <VolumeSurgeTable rows={data.highVolume} dir="bear" />
                  </CardPanel>
                </div>
              </div>
            )}

            {/* ─── TAB 2: SECTOR PERFORMANCE ───────────────────────────── */}
            {activeTab === 'sectors' && (
              <div className="flex flex-col gap-4">
                {/* Sector Performance Bar Chart */}
                <CardPanel
                  title="Sector Rotation & Performance"
                  eyebrow="Relative Strength Across Industries"
                  icon={Layers}
                  accent="text-amber-400"
                  headerRight={
                    <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
                      {(['1D', '1W', '1M'] as const).map(m => (
                        <button
                          key={m}
                          onClick={() => setSectorMetric(m)}
                          className={cn(
                            'px-2.5 py-1 text-xs font-mono font-bold rounded transition-colors',
                            sectorMetric === m
                              ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                              : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
                          )}
                        >
                          {m} Return
                        </button>
                      ))}
                    </div>
                  }
                >
                  <div className="p-5">
                    <ResponsiveContainer width="100%" height={380}>
                      <BarChart
                        data={sortedSectorStats}
                        margin={{ top: 10, right: 15, left: -10, bottom: 40 }}
                        barCategoryGap="22%"
                      >
                        <CartesianGrid strokeDasharray="3 6" stroke="#20202399" vertical={false} />
                        <XAxis
                          dataKey="sector"
                          tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 600, fontFamily: 'var(--font-mono)' }}
                          tickLine={false}
                          axisLine={{ stroke: '#27272a' }}
                          angle={-25}
                          textAnchor="end"
                          interval={0}
                        />
                        <YAxis
                          tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500, fontFamily: 'var(--font-mono)' }}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={v => `${v}%`}
                        />
                        <Tooltip content={<SectorChartTooltip />} cursor={{ fill: '#27272a', opacity: 0.5 }} />
                        <ReferenceLine y={0} stroke="#52525b" strokeWidth={1.5} />
                        <Bar
                          dataKey={sectorMetric === '1D' ? 'avg1D' : sectorMetric === '1W' ? 'avg1W' : 'avg1M'}
                          name={`${sectorMetric} Return`}
                          radius={[3, 3, 0, 0]}
                        >
                          {sortedSectorStats.map(s => {
                            const val = sectorMetric === '1D' ? s.avg1D : sectorMetric === '1W' ? s.avg1W : s.avg1M;
                            return (
                              <Cell
                                key={s.sector}
                                fill={val >= 0 ? '#34d399' : '#f87171'}
                              />
                            );
                          })}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardPanel>

                {/* Comprehensive Sector Table */}
                <CardPanel
                  title="Sector Health & Participation Matrix"
                  eyebrow="Market Breadth By Industry"
                  count={sectorStats.length}
                  icon={BarChart2}
                  accent="text-amber-400"
                >
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <TH>Sector</TH>
                        <TH right>Constituents</TH>
                        <TH right>Avg 1D%</TH>
                        <TH right>Avg 1W%</TH>
                        <TH right>Avg 1M%</TH>
                        <TH right>Adv / Dec</TH>
                        <TH right>&gt; 200D SMA</TH>
                        <TH right>Avg RSI</TH>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedSectorStats.map(s => (
                        <TR key={s.sector}>
                          <TD className="font-bold text-zinc-100">{s.sector}</TD>
                          <TD right className="text-zinc-400">{s.count}</TD>
                          <TD right><PctPill v={s.avg1D} /></TD>
                          <TD right><PctCell v={s.avg1W} /></TD>
                          <TD right><PctCell v={s.avg1M} /></TD>
                          <TD right>
                            <span className="font-mono text-xs">
                              <span className="text-emerald-400 font-bold">{s.gainers}</span>
                              <span className="text-zinc-600"> / </span>
                              <span className="text-red-400 font-bold">{s.losers}</span>
                            </span>
                          </TD>
                          <TD right className="text-zinc-300">
                            {s.above200D}/{s.count} <span className="text-zinc-500">({Math.round((s.above200D / s.count) * 100)}%)</span>
                          </TD>
                          <TD right><RSIBadge rsi={s.avgRSI} /></TD>
                        </TR>
                      ))}
                    </tbody>
                  </table>
                </CardPanel>
              </div>
            )}

            {/* ─── TAB 3: TECHNICAL SETUPS & RADAR ──────────────────────── */}
            {activeTab === 'setups' && (
              <div className="flex flex-col gap-4">
                {/* NR4 & NR7 Volatility Compression */}
                <CardPanel
                  title="Narrow Range (NR4 / NR7) Breakout Setups"
                  eyebrow="Volatility Squeeze & Compression"
                  count={data.nr4.length + data.nr7.length}
                  icon={Sparkles}
                  accent="text-cyan-400"
                  maxHeight="360px"
                  headerRight={
                    <span className="text-[10px] text-zinc-400 font-mono">
                      ★★★ = NR7 + RSI in neutral zone (40-65) + Above 200D SMA
                    </span>
                  }
                >
                  <NRBreakoutTable nr4={data.nr4} nr7={data.nr7} />
                </CardPanel>

                {/* 52-Week High & Low Radar */}
                <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
                  <CardPanel
                    title="Near 52-Week High (Within 2%)"
                    eyebrow="Blue Sky / Breakout Territory"
                    count={data.high52W.length}
                    icon={ArrowUpRight}
                    accent="text-amber-400"
                    maxHeight="360px"
                  >
                    <HighLowRadarTable rows={data.high52W} type="high" />
                  </CardPanel>

                  <CardPanel
                    title="Near 52-Week Low (Within 5%)"
                    eyebrow="Support / Deep Value Reversal"
                    count={data.low52W.length}
                    icon={ArrowDownRight}
                    accent="text-orange-400"
                    maxHeight="360px"
                  >
                    <HighLowRadarTable rows={data.low52W} type="low" />
                  </CardPanel>
                </div>

                {/* Moving Average Alignment & Pullbacks */}
                <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
                  <CardPanel
                    title="Stage 2 Uptrend (Above 20D + 50D + 200D MA & RSI > 50)"
                    eyebrow="Full Bull Alignment"
                    count={data.aboveAllMAs.length}
                    icon={ShieldCheck}
                    accent="text-emerald-400"
                    maxHeight="360px"
                  >
                    <MoversRankTable rows={data.aboveAllMAs} defaultKey="priceChange1M" />
                  </CardPanel>

                  <CardPanel
                    title="Pullback in Uptrend (Above 200D, Dipping Below 20D/50D)"
                    eyebrow="High-Probability Dip Buying"
                    count={pullbackSetups.length}
                    icon={Crosshair}
                    accent="text-yellow-400"
                    maxHeight="360px"
                  >
                    <MoversRankTable rows={pullbackSetups} defaultKey="pctFrom52WHigh" />
                  </CardPanel>
                </div>

                {/* Consecutive Multi-Day Streaks */}
                <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
                  <CardPanel
                    title="Rising 5 Consecutive Sessions"
                    eyebrow="Persistent Buying Streak"
                    count={data.rising5D.length}
                    icon={TrendingUp}
                    accent="text-sky-400"
                    maxHeight="340px"
                  >
                    <MoversRankTable rows={data.rising5D} defaultKey="priceChange1W" />
                  </CardPanel>

                  <CardPanel
                    title="Falling 5 Consecutive Sessions"
                    eyebrow="Persistent Selling Streak"
                    count={data.falling5D.length}
                    icon={TrendingDown}
                    accent="text-rose-400"
                    maxHeight="340px"
                  >
                    <MoversRankTable rows={data.falling5D} defaultKey="priceChange1W" />
                  </CardPanel>
                </div>
              </div>
            )}

            {/* ─── TAB 4: MULTI-FACTOR SCREENER & MATRIX ────────────────── */}
            {activeTab === 'screener' && (
              <div className="flex flex-col gap-4">
                {/* Filter Control Bar */}
                <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2">
                      <Filter className="w-4 h-4 text-amber-400" />
                      <h4 className="text-xs font-bold text-zinc-100 uppercase tracking-wider">Multi-Factor Screening Criteria</h4>
                    </div>
                    <span className="text-xs font-mono text-zinc-400">
                      Matches: <strong className="text-amber-400">{screenerResults.length}</strong> / {data.allMovers.length} stocks
                    </span>
                  </div>

                  <div className="flex items-center gap-3 flex-wrap pt-2 border-t border-zinc-800">
                    {/* Direction */}
                    <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
                      <button
                        onClick={() => setScreenerDirection('rise')}
                        className={cn(
                          'px-2.5 py-1 text-xs font-mono font-bold rounded transition-colors',
                          screenerDirection === 'rise'
                            ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                            : 'text-zinc-500 hover:text-zinc-300'
                        )}
                      >
                        ▲ RISING
                      </button>
                      <button
                        onClick={() => setScreenerDirection('fall')}
                        className={cn(
                          'px-2.5 py-1 text-xs font-mono font-bold rounded transition-colors',
                          screenerDirection === 'fall'
                            ? 'bg-red-500/15 text-red-400 border border-red-500/30'
                            : 'text-zinc-500 hover:text-zinc-300'
                        )}
                      >
                        ▼ FALLING
                      </button>
                    </div>

                    {/* Percentage Threshold */}
                    <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 px-3 py-1 rounded-lg">
                      <span className="text-xs text-zinc-500 font-mono">&ge;</span>
                      <input
                        type="number"
                        min={0.1}
                        max={100}
                        step={0.5}
                        value={screenerPct}
                        onChange={e => setScreenerPct(Math.max(0.1, parseFloat(e.target.value) || 0))}
                        className="w-12 bg-transparent text-xs font-bold font-mono text-zinc-100 text-right outline-none"
                      />
                      <span className="text-xs text-zinc-400 font-mono">%</span>
                    </div>

                    {/* Timeframe */}
                    <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
                      {(['1D', '1W', '1M', '3M', '5M', '1Y'] as const).map(tf => (
                        <button
                          key={tf}
                          onClick={() => setScreenerDuration(tf)}
                          className={cn(
                            'px-2.5 py-1 text-xs font-mono font-bold rounded transition-colors',
                            screenerDuration === tf
                              ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                              : 'text-zinc-500 hover:text-zinc-300'
                          )}
                        >
                          {tf}
                        </button>
                      ))}
                    </div>

                    {/* Sector Dropdown */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Sector</span>
                      <select
                        value={screenerSector}
                        onChange={e => setScreenerSector(e.target.value)}
                        className="bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs rounded-lg px-2.5 py-1 focus:outline-none focus:border-amber-400"
                      >
                        <option value="ALL">All Sectors</option>
                        {distinctSectors.map(s => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </div>

                    {/* RSI Filter */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">RSI</span>
                      <select
                        value={screenerRsiFilter}
                        onChange={e => setScreenerRsiFilter(e.target.value as typeof screenerRsiFilter)}
                        className="bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs rounded-lg px-2.5 py-1 focus:outline-none focus:border-amber-400"
                      >
                        <option value="ALL">All RSI</option>
                        <option value="OB">&gt; 70 Overbought</option>
                        <option value="NEUTRAL">40 - 60 Neutral</option>
                        <option value="OS">&lt; 40 Oversold</option>
                      </select>
                    </div>

                    {/* MA Filter */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">MAs</span>
                      <select
                        value={screenerMaFilter}
                        onChange={e => setScreenerMaFilter(e.target.value as typeof screenerMaFilter)}
                        className="bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs rounded-lg px-2.5 py-1 focus:outline-none focus:border-amber-400"
                      >
                        <option value="ALL">All MA States</option>
                        <option value="ABOVE_200">&gt; 200D SMA</option>
                        <option value="ABOVE_ALL">&gt; 20D + 50D + 200D SMA</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* Screener Results Full Table */}
                <CardPanel
                  title="Multi-Timeframe Screener Matrix"
                  eyebrow="Custom Cross-Sectional Filter"
                  count={screenerResults.length}
                  icon={Filter}
                  accent="text-amber-400"
                  maxHeight="580px"
                >
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <TH>#</TH>
                        <TH onSort={() => toggleScreenerSort('symbol')} sortDir={screenerColDir('symbol')}>Symbol</TH>
                        <TH onSort={() => toggleScreenerSort('sector')} sortDir={screenerColDir('sector')}>Sector</TH>
                        <TH right onSort={() => toggleScreenerSort('latestClose')} sortDir={screenerColDir('latestClose')}>LTP</TH>
                        <TH right onSort={() => toggleScreenerSort('priceChange1D')} sortDir={screenerColDir('priceChange1D')}>1D%</TH>
                        <TH right onSort={() => toggleScreenerSort('priceChange1W')} sortDir={screenerColDir('priceChange1W')}>1W%</TH>
                        <TH right onSort={() => toggleScreenerSort('priceChange1M')} sortDir={screenerColDir('priceChange1M')}>1M%</TH>
                        <TH right onSort={() => toggleScreenerSort('priceChange3M')} sortDir={screenerColDir('priceChange3M')}>3M%</TH>
                        <TH right onSort={() => toggleScreenerSort('priceChange1Y')} sortDir={screenerColDir('priceChange1Y')}>1Y%</TH>
                        <TH right onSort={() => toggleScreenerSort('volumeRatio')} sortDir={screenerColDir('volumeRatio')}>Vol Ratio</TH>
                        <TH right onSort={() => toggleScreenerSort('rsi14')} sortDir={screenerColDir('rsi14')}>RSI</TH>
                        <TH right>MAs</TH>
                        <TH right>Trend</TH>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedScreenerList.length === 0 ? (
                        <tr><td colSpan={13} className="text-center text-zinc-500 text-xs py-12 font-mono">No stocks match the selected criteria</td></tr>
                      ) : (
                        (sortedScreenerList as MoverResult[]).map((r, i) => (
                          <TR key={r.symbol}>
                            <TD className="text-zinc-500 w-6">{i + 1}</TD>
                            <TD className="font-bold text-zinc-100">{r.symbol}</TD>
                            <TD className="text-zinc-400 max-w-[120px] truncate text-[11px]">{r.sector || '—'}</TD>
                            <TD right className="text-zinc-200">{fmtPrice(r.latestClose)}</TD>
                            <TD right><PctPill v={r.priceChange1D} /></TD>
                            <TD right><PctCell v={r.priceChange1W} /></TD>
                            <TD right><PctCell v={r.priceChange1M} /></TD>
                            <TD right><PctCell v={r.priceChange3M} /></TD>
                            <TD right><PctCell v={r.priceChange1Y} /></TD>
                            <TD right><VolBadge ratio={r.volumeRatio} /></TD>
                            <TD right><RSIBadge rsi={r.rsi14} /></TD>
                            <TD right><MADots a20={r.aboveMa20} a50={r.aboveMa50} a200={r.aboveMa200} /></TD>
                            <TD right><MiniSparkline r={r} /></TD>
                          </TR>
                        ))
                      )}
                    </tbody>
                  </table>
                </CardPanel>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
