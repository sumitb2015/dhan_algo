'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Activity, RefreshCw, Zap, AlertTriangle, CheckCircle, Filter, Terminal } from 'lucide-react';
import { MoverResult, MoversResponse } from '@/app/api/movers/route';
import { cn } from '@/lib/utils';
import NavBar from './NavBar';

// ─── Formatters ───────────────────────────────────────────────────────────────
function fmt(n: number, digits = 2) { return n.toFixed(digits); }
function fmtCountdown(s: number) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

// ─── Sort hook ────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function useSort<T extends Record<string, any>>(
  items: T[],
  defaultKey: keyof T,
  defaultDir: 'asc' | 'desc' = 'desc',
) {
  const [sort, setSort] = useState<{ key: keyof T; dir: 'asc' | 'desc' }>({ key: defaultKey, dir: defaultDir });
  const toggle = useCallback((k: keyof T) => {
    setSort(s => s.key === k ? { key: k, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key: k, dir: 'desc' });
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

// ─── Micro display components ─────────────────────────────────────────────────
function PctCell({ v, bold }: { v: number; bold?: boolean }) {
  return (
    <span className={cn('font-mono tabular-nums', bold ? 'font-bold' : 'font-medium',
      v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-zinc-500')}>
      {v > 0 ? '+' : ''}{fmt(v)}%
    </span>
  );
}

function PctPill({ v }: { v: number }) {
  return (
    <span className={cn('inline-flex items-center px-1.5 py-px rounded-sm text-[11px] font-bold tabular-nums font-mono',
      v > 0 ? 'bg-emerald-500/10 text-emerald-400' : v < 0 ? 'bg-red-500/10 text-red-400' : 'bg-zinc-800 text-zinc-500')}>
      {v > 0 ? '+' : ''}{fmt(v)}%
    </span>
  );
}

function RSIBadge({ rsi }: { rsi: number }) {
  return (
    <span className={cn('inline-flex items-center px-1.5 py-px rounded-sm text-[11px] font-bold tabular-nums font-mono',
      rsi >= 70 ? 'bg-red-500/10 text-red-400' : rsi >= 50 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-zinc-800 text-zinc-500')}>
      {fmt(rsi, 0)}
    </span>
  );
}

function MADots({ a20, a50, a200 }: { a20: boolean; a50: boolean; a200: boolean }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className={cn('w-1.5 h-1.5 rounded-full', a20 ? 'bg-emerald-400' : 'bg-red-500')} title="20D" />
      <span className={cn('w-1.5 h-1.5 rounded-full', a50 ? 'bg-emerald-400' : 'bg-red-500')} title="50D" />
      <span className={cn('w-1.5 h-1.5 rounded-full', a200 ? 'bg-emerald-400' : 'bg-red-500')} title="200D" />
    </span>
  );
}

function VolBadge({ ratio }: { ratio: number }) {
  return (
    <span className={cn('inline-flex items-center px-1.5 py-px rounded-sm text-[11px] font-bold tabular-nums font-mono',
      ratio >= 3 ? 'bg-violet-500/15 text-violet-300' : ratio >= 2 ? 'bg-violet-500/10 text-violet-400' : ratio >= 1.5 ? 'bg-blue-500/10 text-blue-400' : 'bg-zinc-800 text-zinc-500')}>
      {fmt(ratio, 1)}×
    </span>
  );
}

// ─── Mini Sparkline (1Y→3M→1M→1W→1D momentum shape) ─────────────────────────
function MiniSparkline({ r }: { r: MoverResult }) {
  const vals = [r.priceChange1Y, r.priceChange3M, r.priceChange1M, r.priceChange1W, r.priceChange1D];
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const W = 36, H = 14;
  const pts = vals.map((v, i) => `${(i / 4) * W},${H - ((v - min) / range) * (H - 2) - 1}`).join(' ');
  const lastY = H - ((r.priceChange1D - min) / range) * (H - 2) - 1;
  const color = r.priceChange1D >= 0 ? '#34d399' : '#f87171';
  return (
    <svg width={W} height={H} className="inline-block flex-shrink-0 overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" opacity="0.85" />
      <circle cx={W} cy={lastY} r="1.8" fill={color} />
    </svg>
  );
}

// ─── Table primitives ─────────────────────────────────────────────────────────
function TH({ children, right, className, sortDir, onSort }: {
  children?: React.ReactNode; right?: boolean; className?: string;
  sortDir?: 'asc' | 'desc'; onSort?: () => void;
}) {
  return (
    <th
      className={cn('py-1.5 px-2 text-xs font-bold text-white bg-zinc-800 uppercase tracking-wide whitespace-nowrap sticky top-0 z-10',
        right ? 'text-right' : 'text-left',
        onSort && 'cursor-pointer select-none hover:bg-zinc-700 transition-colors', className)}
      onClick={onSort}
    >
      {onSort ? (
        <span className={cn('inline-flex items-center gap-0.5', right && 'justify-end w-full')}>
          {children}
          <span className="text-[9px] text-zinc-400 ml-0.5">
            {sortDir === 'asc' ? '▲' : sortDir === 'desc' ? '▼' : <span className="opacity-30">⇅</span>}
          </span>
        </span>
      ) : children}
    </th>
  );
}

function TD({ children, right, className }: { children?: React.ReactNode; right?: boolean; className?: string }) {
  return <td className={cn('py-[3px] px-2 text-[12px] font-mono', right ? 'text-right' : 'text-left', className)}>{children}</td>;
}

function TR({ children, highlight }: { children: React.ReactNode; highlight?: boolean }) {
  return (
    <tr className={cn('border-b border-zinc-900/80 hover:bg-amber-500/5 transition-colors', highlight && 'bg-amber-500/5')}>
      {children}
    </tr>
  );
}

// ─── Panel wrapper ────────────────────────────────────────────────────────────
function Panel({ label, count, color, accent, children, className, maxHeight }: {
  label: string; count?: number; color?: string; accent?: string;
  children: React.ReactNode; className?: string; maxHeight?: string;
}) {
  return (
    <div className={cn('border border-amber-900/20 bg-[#050505] rounded-sm overflow-hidden flex flex-col', className)}>
      <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border-b border-amber-900/20 shrink-0">
        <span className={cn('text-[10px] font-bold uppercase tracking-widest', color ?? 'text-amber-400')}>{label}</span>
        {count !== undefined && (
          <span className={cn('text-[10px] tabular-nums font-mono ml-auto', accent ?? 'text-zinc-500')}>{count}</span>
        )}
      </div>
      <div className={cn('overflow-x-auto flex-1', maxHeight && 'overflow-y-auto')} style={maxHeight ? { maxHeight } : undefined}>
        {children}
      </div>
    </div>
  );
}

// ─── Tables ───────────────────────────────────────────────────────────────────
function GainerLoserTable({ rows }: { rows: MoverResult[] }) {
  const { sorted, toggle, colDir } = useSort(rows, 'priceChange1D', 'desc');
  return (
    <table className="w-full border-collapse">
      <thead><tr>
        <TH>#</TH>
        <TH onSort={() => toggle('symbol')} sortDir={colDir('symbol')}>Symbol</TH>
        <TH onSort={() => toggle('sector')} sortDir={colDir('sector')}>Sector</TH>
        <TH right onSort={() => toggle('latestClose')} sortDir={colDir('latestClose')}>Close</TH>
        <TH right onSort={() => toggle('priceChange1D')} sortDir={colDir('priceChange1D')}>1D%</TH>
        <TH right onSort={() => toggle('priceChange1W')} sortDir={colDir('priceChange1W')}>1W%</TH>
        <TH right onSort={() => toggle('priceChange1M')} sortDir={colDir('priceChange1M')}>1M%</TH>
        <TH right onSort={() => toggle('rsi14')} sortDir={colDir('rsi14')}>RSI</TH>
        <TH right>MAs</TH>
        <TH right>Trend</TH>
      </tr></thead>
      <tbody>
        {(sorted as MoverResult[]).map((r, i) => (
          <TR key={r.symbol}>
            <TD className="text-zinc-500 w-5">{i + 1}</TD>
            <TD className="font-bold text-zinc-100">{r.symbol}</TD>
            <TD className="text-zinc-400 max-w-[90px] truncate text-[11px]">{r.sector || '—'}</TD>
            <TD right className="text-zinc-200">₹{fmt(r.latestClose)}</TD>
            <TD right><PctPill v={r.priceChange1D} /></TD>
            <TD right><PctCell v={r.priceChange1W} /></TD>
            <TD right><PctCell v={r.priceChange1M} /></TD>
            <TD right><RSIBadge rsi={r.rsi14} /></TD>
            <TD right><MADots a20={r.aboveMa20} a50={r.aboveMa50} a200={r.aboveMa200} /></TD>
            <TD right><MiniSparkline r={r} /></TD>
          </TR>
        ))}
      </tbody>
    </table>
  );
}

function HighLowTable({ rows, type }: { rows: MoverResult[]; type: 'high' | 'low' }) {
  const defaultKey = type === 'high' ? 'pctFrom52WHigh' : 'pctFrom52WLow';
  const { sorted, toggle, colDir } = useSort(rows, defaultKey, type === 'high' ? 'desc' : 'asc');
  return (
    <table className="w-full border-collapse">
      <thead><tr>
        <TH>#</TH>
        <TH onSort={() => toggle('symbol')} sortDir={colDir('symbol')}>Symbol</TH>
        <TH onSort={() => toggle('sector')} sortDir={colDir('sector')}>Sector</TH>
        <TH right onSort={() => toggle('latestClose')} sortDir={colDir('latestClose')}>Close</TH>
        <TH right>{type === 'high' ? '52W High' : '52W Low'}</TH>
        <TH right onSort={() => toggle(defaultKey)} sortDir={colDir(defaultKey)}>
          {type === 'high' ? '% from High' : '% above Low'}
        </TH>
        <TH right onSort={() => toggle('priceChange1D')} sortDir={colDir('priceChange1D')}>1D%</TH>
        <TH right>MAs</TH>
      </tr></thead>
      <tbody>
        {(sorted as MoverResult[]).map((r, i) => (
          <TR key={r.symbol}>
            <TD className="text-zinc-500 w-5">{i + 1}</TD>
            <TD className="font-bold text-zinc-100">{r.symbol}</TD>
            <TD className="text-zinc-400 max-w-[90px] truncate text-[11px]">{r.sector || '—'}</TD>
            <TD right className="text-zinc-200">₹{fmt(r.latestClose)}</TD>
            <TD right className="text-zinc-400">₹{fmt(type === 'high' ? r.high52W : r.low52W)}</TD>
            <TD right className={cn('font-bold', type === 'high' ? (r.pctFrom52WHigh >= -0.5 ? 'text-amber-400' : 'text-zinc-400') : 'text-amber-400')}>
              {type === 'high' ? (r.pctFrom52WHigh >= 0 ? 'AT HIGH' : `${fmt(r.pctFrom52WHigh)}%`) : `+${fmt(r.pctFrom52WLow)}%`}
            </TD>
            <TD right><PctCell v={r.priceChange1D} /></TD>
            <TD right><MADots a20={r.aboveMa20} a50={r.aboveMa50} a200={r.aboveMa200} /></TD>
          </TR>
        ))}
      </tbody>
    </table>
  );
}

function VolumeDirectionTable({ rows, dir }: { rows: MoverResult[]; dir: 'bull' | 'bear' }) {
  const base = rows.filter(r => dir === 'bull' ? r.priceChange1D > 0 : r.priceChange1D < 0);
  const { sorted, toggle, colDir } = useSort(base, 'volumeRatio', 'desc');
  return (
    <table className="w-full border-collapse">
      <thead><tr>
        <TH>#</TH>
        <TH onSort={() => toggle('symbol')} sortDir={colDir('symbol')}>Symbol</TH>
        <TH right onSort={() => toggle('latestClose')} sortDir={colDir('latestClose')}>Close</TH>
        <TH right onSort={() => toggle('volumeRatio')} sortDir={colDir('volumeRatio')}>Vol×</TH>
        <TH right onSort={() => toggle('priceChange1D')} sortDir={colDir('priceChange1D')}>1D%</TH>
        <TH right onSort={() => toggle('rsi14')} sortDir={colDir('rsi14')}>RSI</TH>
      </tr></thead>
      <tbody>
        {(sorted as MoverResult[]).slice(0, 8).map((r, i) => (
          <TR key={r.symbol}>
            <TD className="text-zinc-500 w-5">{i + 1}</TD>
            <TD className="font-bold text-zinc-100">{r.symbol}</TD>
            <TD right className="text-zinc-200">₹{fmt(r.latestClose)}</TD>
            <TD right><VolBadge ratio={r.volumeRatio} /></TD>
            <TD right><PctPill v={r.priceChange1D} /></TD>
            <TD right><RSIBadge rsi={r.rsi14} /></TD>
          </TR>
        ))}
        {base.length === 0 && <tr><td colSpan={6} className="text-center text-zinc-600 text-[11px] py-4">No data</td></tr>}
      </tbody>
    </table>
  );
}

function MoverTable({ rows }: { rows: MoverResult[] }) {
  const { sorted, toggle, colDir } = useSort(rows, 'priceChange1D', 'desc');
  return (
    <table className="w-full border-collapse">
      <thead><tr>
        <TH>#</TH>
        <TH onSort={() => toggle('symbol')} sortDir={colDir('symbol')}>Symbol</TH>
        <TH onSort={() => toggle('sector')} sortDir={colDir('sector')}>Sector</TH>
        <TH right onSort={() => toggle('latestClose')} sortDir={colDir('latestClose')}>Close</TH>
        <TH right onSort={() => toggle('priceChange1D')} sortDir={colDir('priceChange1D')}>1D%</TH>
        <TH right onSort={() => toggle('priceChange1W')} sortDir={colDir('priceChange1W')}>1W%</TH>
        <TH right onSort={() => toggle('priceChange3M')} sortDir={colDir('priceChange3M')}>3M%</TH>
        <TH right onSort={() => toggle('rsi14')} sortDir={colDir('rsi14')}>RSI</TH>
        <TH right>Trend</TH>
      </tr></thead>
      <tbody>
        {(sorted as MoverResult[]).map((r, i) => (
          <TR key={r.symbol}>
            <TD className="text-zinc-500 w-5">{i + 1}</TD>
            <TD className="font-bold text-zinc-100">{r.symbol}</TD>
            <TD className="text-zinc-400 max-w-[90px] truncate text-[11px]">{r.sector || '—'}</TD>
            <TD right className="text-zinc-200">₹{fmt(r.latestClose)}</TD>
            <TD right><PctPill v={r.priceChange1D} /></TD>
            <TD right><PctCell v={r.priceChange1W} /></TD>
            <TD right><PctCell v={r.priceChange3M} /></TD>
            <TD right><RSIBadge rsi={r.rsi14} /></TD>
            <TD right><MiniSparkline r={r} /></TD>
          </TR>
        ))}
      </tbody>
    </table>
  );
}

function MomentumMatrix({ rows }: { rows: MoverResult[] }) {
  const { sorted, toggle, colDir } = useSort(rows, 'priceChange1M', 'desc');
  return (
    <table className="w-full border-collapse">
      <thead><tr>
        <TH>#</TH>
        <TH onSort={() => toggle('symbol')} sortDir={colDir('symbol')}>Symbol</TH>
        <TH onSort={() => toggle('sector')} sortDir={colDir('sector')}>Sector</TH>
        <TH right onSort={() => toggle('latestClose')} sortDir={colDir('latestClose')}>Close</TH>
        <TH right onSort={() => toggle('priceChange1W')} sortDir={colDir('priceChange1W')}>1W%</TH>
        <TH right onSort={() => toggle('priceChange1M')} sortDir={colDir('priceChange1M')}>1M%</TH>
        <TH right onSort={() => toggle('priceChange3M')} sortDir={colDir('priceChange3M')}>3M%</TH>
        <TH right onSort={() => toggle('priceChange1Y')} sortDir={colDir('priceChange1Y')}>1Y%</TH>
        <TH right onSort={() => toggle('rsi14')} sortDir={colDir('rsi14')}>RSI</TH>
        <TH right>MAs</TH>
      </tr></thead>
      <tbody>
        {sorted.length === 0
          ? <tr><td colSpan={10} className="text-center text-zinc-600 text-[11px] py-6">No stocks meet criteria</td></tr>
          : (sorted as MoverResult[]).map((r, i) => (
            <TR key={r.symbol}>
              <TD className="text-zinc-500 w-5">{i + 1}</TD>
              <TD className="font-bold text-zinc-100">{r.symbol}</TD>
              <TD className="text-zinc-400 max-w-[90px] truncate text-[11px]">{r.sector || '—'}</TD>
              <TD right className="text-zinc-200">₹{fmt(r.latestClose)}</TD>
              <TD right><PctCell v={r.priceChange1W} bold /></TD>
              <TD right><PctCell v={r.priceChange1M} bold /></TD>
              <TD right><PctCell v={r.priceChange3M} bold /></TD>
              <TD right><PctCell v={r.priceChange1Y} /></TD>
              <TD right><RSIBadge rsi={r.rsi14} /></TD>
              <TD right><MADots a20={r.aboveMa20} a50={r.aboveMa50} a200={r.aboveMa200} /></TD>
            </TR>
          ))}
      </tbody>
    </table>
  );
}

function MATable({ rows }: { rows: MoverResult[] }) {
  const { sorted, toggle, colDir } = useSort(rows, 'rsi14', 'desc');
  return (
    <table className="w-full border-collapse">
      <thead><tr>
        <TH>#</TH>
        <TH onSort={() => toggle('symbol')} sortDir={colDir('symbol')}>Symbol</TH>
        <TH onSort={() => toggle('sector')} sortDir={colDir('sector')}>Sector</TH>
        <TH right onSort={() => toggle('latestClose')} sortDir={colDir('latestClose')}>Close</TH>
        <TH right onSort={() => toggle('ma20')} sortDir={colDir('ma20')}>20D MA</TH>
        <TH right onSort={() => toggle('ma50')} sortDir={colDir('ma50')}>50D MA</TH>
        <TH right onSort={() => toggle('ma200')} sortDir={colDir('ma200')}>200D MA</TH>
        <TH right onSort={() => toggle('rsi14')} sortDir={colDir('rsi14')}>RSI</TH>
        <TH right onSort={() => toggle('priceChange1M')} sortDir={colDir('priceChange1M')}>1M%</TH>
        <TH right onSort={() => toggle('priceChange3M')} sortDir={colDir('priceChange3M')}>3M%</TH>
      </tr></thead>
      <tbody>
        {(sorted as MoverResult[]).map((r, i) => (
          <TR key={r.symbol}>
            <TD className="text-zinc-500 w-5">{i + 1}</TD>
            <TD className="font-bold text-zinc-100">{r.symbol}</TD>
            <TD className="text-zinc-400 max-w-[90px] truncate text-[11px]">{r.sector || '—'}</TD>
            <TD right className="font-bold text-zinc-200">₹{fmt(r.latestClose)}</TD>
            <TD right><span className="inline-flex items-center gap-1 justify-end">
              <span className="text-zinc-400 text-[11px]">₹{fmt(r.ma20)}</span>
              <span className={cn('w-1.5 h-1.5 rounded-full', r.aboveMa20 ? 'bg-emerald-400' : 'bg-red-500')} />
            </span></TD>
            <TD right><span className="inline-flex items-center gap-1 justify-end">
              <span className="text-zinc-400 text-[11px]">₹{fmt(r.ma50)}</span>
              <span className={cn('w-1.5 h-1.5 rounded-full', r.aboveMa50 ? 'bg-emerald-400' : 'bg-red-500')} />
            </span></TD>
            <TD right><span className="inline-flex items-center gap-1 justify-end">
              <span className="text-zinc-400 text-[11px]">₹{fmt(r.ma200)}</span>
              <span className={cn('w-1.5 h-1.5 rounded-full', r.aboveMa200 ? 'bg-emerald-400' : 'bg-red-500')} />
            </span></TD>
            <TD right><RSIBadge rsi={r.rsi14} /></TD>
            <TD right><PctCell v={r.priceChange1M} /></TD>
            <TD right><PctCell v={r.priceChange3M} /></TD>
          </TR>
        ))}
      </tbody>
    </table>
  );
}

function nrScore(r: MoverResult): number {
  let s = 0;
  if (r.isNR7) s++;
  if (r.rsi14 >= 40 && r.rsi14 <= 65) s++;
  if (r.aboveMa200) s++;
  return s;
}

function SetupBadge({ score }: { score: number }) {
  return (
    <span className={cn('text-[11px] font-bold',
      score === 3 ? 'text-amber-400' : score === 2 ? 'text-amber-600' : 'text-zinc-600')}>
      {'★'.repeat(score) + '☆'.repeat(3 - score)}
    </span>
  );
}

function NRSetupTable({ nr4, nr7 }: { nr4: MoverResult[]; nr7: MoverResult[] }) {
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
      <thead><tr>
        <TH>#</TH>
        <TH onSort={() => toggle('symbol')} sortDir={colDir('symbol')}>Symbol</TH>
        <TH onSort={() => toggle('sector')} sortDir={colDir('sector')}>Sector</TH>
        <TH right onSort={() => toggle('latestClose')} sortDir={colDir('latestClose')}>Close</TH>
        <TH right>Setup</TH>
        <TH right>Type</TH>
        <TH right>Range%</TH>
        <TH right onSort={() => toggle('rsi14')} sortDir={colDir('rsi14')}>RSI</TH>
        <TH right>MAs</TH>
        <TH right onSort={() => toggle('priceChange1D')} sortDir={colDir('priceChange1D')}>1D%</TH>
      </tr></thead>
      <tbody>
        {(sorted as (MoverResult & { isNR7real: boolean })[]).map((r, i) => {
          const maxR = r.isNR7real ? r.maxRange7D : r.maxRange4D;
          const rangePct = maxR > 0 ? (r.nr7Range / maxR) * 100 : 0;
          const score = nrScore(r);
          return (
            <TR key={r.symbol} highlight={score === 3}>
              <TD className="text-zinc-500 w-5">{i + 1}</TD>
              <TD className="font-bold text-zinc-100">{r.symbol}</TD>
              <TD className="text-zinc-400 max-w-[90px] truncate text-[11px]">{r.sector || '—'}</TD>
              <TD right className="text-zinc-200">₹{fmt(r.latestClose)}</TD>
              <TD right><SetupBadge score={score} /></TD>
              <TD right>
                <span className={cn('text-[10px] font-bold px-1 py-px rounded-sm',
                  r.isNR7real ? 'bg-cyan-500/10 text-cyan-300' : 'bg-sky-500/10 text-sky-400')}>
                  {r.isNR7real ? 'NR7' : 'NR4'}
                </span>
              </TD>
              <TD right>
                <span className={cn('text-[11px] font-mono',
                  rangePct < 30 ? 'text-cyan-400' : rangePct < 60 ? 'text-sky-400' : 'text-zinc-500')}>
                  {fmt(rangePct, 0)}%
                </span>
              </TD>
              <TD right><RSIBadge rsi={r.rsi14} /></TD>
              <TD right><MADots a20={r.aboveMa20} a50={r.aboveMa50} a200={r.aboveMa200} /></TD>
              <TD right><PctCell v={r.priceChange1D} /></TD>
            </TR>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Pullback in Uptrend ──────────────────────────────────────────────────────
function PullbackTable({ rows }: { rows: MoverResult[] }) {
  const { sorted, toggle, colDir } = useSort(rows, 'pctFrom52WHigh', 'desc');
  return (
    <table className="w-full border-collapse">
      <thead><tr>
        <TH>#</TH>
        <TH onSort={() => toggle('symbol')} sortDir={colDir('symbol')}>Symbol</TH>
        <TH onSort={() => toggle('sector')} sortDir={colDir('sector')}>Sector</TH>
        <TH right onSort={() => toggle('latestClose')} sortDir={colDir('latestClose')}>Close</TH>
        <TH right onSort={() => toggle('pctFrom52WHigh')} sortDir={colDir('pctFrom52WHigh')}>From High</TH>
        <TH right onSort={() => toggle('rsi14')} sortDir={colDir('rsi14')}>RSI</TH>
        <TH right onSort={() => toggle('priceChange1D')} sortDir={colDir('priceChange1D')}>1D%</TH>
        <TH right onSort={() => toggle('priceChange1W')} sortDir={colDir('priceChange1W')}>1W%</TH>
        <TH right onSort={() => toggle('priceChange1M')} sortDir={colDir('priceChange1M')}>1M%</TH>
        <TH right>MAs</TH>
      </tr></thead>
      <tbody>
        {sorted.length === 0
          ? <tr><td colSpan={10} className="text-center text-zinc-600 text-[11px] py-6">No pullback setups — all uptrend stocks currently extended</td></tr>
          : (sorted as MoverResult[]).map((r, i) => (
            <TR key={r.symbol}>
              <TD className="text-zinc-500 w-5">{i + 1}</TD>
              <TD className="font-bold text-zinc-100">{r.symbol}</TD>
              <TD className="text-zinc-400 max-w-[90px] truncate text-[11px]">{r.sector || '—'}</TD>
              <TD right className="text-zinc-200">₹{fmt(r.latestClose)}</TD>
              <TD right><span className="font-mono text-[11px] text-amber-400">
                {r.pctFrom52WHigh >= 0 ? 'AT HIGH' : `${fmt(r.pctFrom52WHigh)}%`}
              </span></TD>
              <TD right><RSIBadge rsi={r.rsi14} /></TD>
              <TD right><PctCell v={r.priceChange1D} /></TD>
              <TD right><PctCell v={r.priceChange1W} /></TD>
              <TD right><PctCell v={r.priceChange1M} /></TD>
              <TD right><MADots a20={r.aboveMa20} a50={r.aboveMa50} a200={r.aboveMa200} /></TD>
            </TR>
          ))}
      </tbody>
    </table>
  );
}

// ─── Sector Performance ───────────────────────────────────────────────────────
interface SectorStat {
  sector: string; count: number; gainers: number; losers: number;
  avg1D: number; avg1W: number; avg1M: number; above200D: number; avgRSI: number;
}

function computeSectorStats(movers: MoverResult[]): SectorStat[] {
  const map = new Map<string, MoverResult[]>();
  for (const m of movers) {
    const s = m.sector || 'Unknown';
    if (!map.has(s)) map.set(s, []);
    map.get(s)!.push(m);
  }
  return Array.from(map.entries()).map(([sector, items]) => {
    const avg = (fn: (m: MoverResult) => number) => items.reduce((a, m) => a + fn(m), 0) / items.length;
    return {
      sector, count: items.length,
      gainers: items.filter(m => m.priceChange1D > 0).length,
      losers: items.filter(m => m.priceChange1D < 0).length,
      avg1D: avg(m => m.priceChange1D), avg1W: avg(m => m.priceChange1W),
      avg1M: avg(m => m.priceChange1M),
      above200D: items.filter(m => m.aboveMa200).length,
      avgRSI: avg(m => m.rsi14),
    };
  });
}

function SectorTable({ movers }: { movers: MoverResult[] }) {
  const base = useMemo(() => computeSectorStats(movers), [movers]);
  const { sorted, toggle, colDir } = useSort(base, 'avg1D', 'desc');
  return (
    <table className="w-full border-collapse">
      <thead><tr>
        <TH onSort={() => toggle('sector')} sortDir={colDir('sector')}>Sector</TH>
        <TH right onSort={() => toggle('count')} sortDir={colDir('count')}>#</TH>
        <TH right onSort={() => toggle('avg1D')} sortDir={colDir('avg1D')}>Avg 1D%</TH>
        <TH right onSort={() => toggle('avg1W')} sortDir={colDir('avg1W')}>Avg 1W%</TH>
        <TH right onSort={() => toggle('avg1M')} sortDir={colDir('avg1M')}>Avg 1M%</TH>
        <TH right onSort={() => toggle('gainers')} sortDir={colDir('gainers')}>G / L</TH>
        <TH right onSort={() => toggle('above200D')} sortDir={colDir('above200D')}>Above 200D</TH>
        <TH right onSort={() => toggle('avgRSI')} sortDir={colDir('avgRSI')}>Avg RSI</TH>
      </tr></thead>
      <tbody>
        {(sorted as SectorStat[]).map((s) => (
          <TR key={s.sector}>
            <TD className="font-bold text-zinc-200 max-w-[160px] truncate">{s.sector}</TD>
            <TD right className="text-zinc-400">{s.count}</TD>
            <TD right>
              <span className={cn('font-mono font-bold tabular-nums',
                s.avg1D > 1 ? 'text-emerald-400' : s.avg1D > 0 ? 'text-emerald-600' : s.avg1D < -1 ? 'text-red-400' : 'text-red-600')}>
                {s.avg1D > 0 ? '+' : ''}{fmt(s.avg1D)}%
              </span>
            </TD>
            <TD right><PctCell v={s.avg1W} /></TD>
            <TD right><PctCell v={s.avg1M} /></TD>
            <TD right><span className="font-mono text-[11px]">
              <span className="text-emerald-500">{s.gainers}</span>
              <span className="text-zinc-600"> / </span>
              <span className="text-red-500">{s.losers}</span>
            </span></TD>
            <TD right><span className="font-mono text-[11px] text-zinc-400">
              {s.above200D}/{s.count} <span className="text-zinc-600">({Math.round(s.above200D / s.count * 100)}%)</span>
            </span></TD>
            <TD right><RSIBadge rsi={s.avgRSI} /></TD>
          </TR>
        ))}
      </tbody>
    </table>
  );
}

// ─── Market Breadth Strip ─────────────────────────────────────────────────────
interface BreadthData {
  total: number; advances: number; declines: number; unchanged: number;
  above20D: number; above50D: number; above200D: number;
  rsiOverbought: number; rsiNeutral: number; rsiOversold: number;
}

function computeBreadth(movers: MoverResult[]): BreadthData {
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
    rsiNeutral: movers.filter(m => m.rsi14 >= 50 && m.rsi14 < 70).length,
    rsiOversold: movers.filter(m => m.rsi14 < 50).length,
  };
}

function BreadthStrip({ breadth, data }: { breadth: BreadthData; data: MoversResponse }) {
  const n = breadth.total || 1;
  const adRatio = breadth.declines > 0 ? (breadth.advances / breadth.declines).toFixed(2) : '∞';
  const groups = [
    { label: 'ADVANCE / DECLINE', items: [
      { label: 'ADV', value: breadth.advances, color: 'text-emerald-400' },
      { label: 'DEC', value: breadth.declines, color: 'text-red-400' },
      { label: 'UNC', value: breadth.unchanged, color: 'text-zinc-500' },
      { label: 'A/D', value: adRatio, color: Number(adRatio) > 1 ? 'text-emerald-400' : 'text-red-400' },
    ]},
    { label: 'MA BREADTH', items: [
      { label: '20D↑', value: `${breadth.above20D} (${Math.round(breadth.above20D / n * 100)}%)`, color: 'text-zinc-300' },
      { label: '50D↑', value: `${breadth.above50D} (${Math.round(breadth.above50D / n * 100)}%)`, color: 'text-zinc-300' },
      { label: '200D↑', value: `${breadth.above200D} (${Math.round(breadth.above200D / n * 100)}%)`, color: 'text-zinc-300' },
    ]},
    { label: 'RSI ZONES', items: [
      { label: 'OB≥70', value: breadth.rsiOverbought, color: 'text-red-400' },
      { label: '50-70', value: breadth.rsiNeutral, color: 'text-emerald-400' },
      { label: 'OS<50', value: breadth.rsiOversold, color: 'text-zinc-500' },
    ]},
    { label: 'SETUPS', items: [
      { label: 'RISE5D', value: data.rising5D.length, color: 'text-sky-400' },
      { label: 'FALL5D', value: data.falling5D.length, color: 'text-rose-400' },
      { label: 'NR4', value: data.nr4.length, color: 'text-cyan-400' },
      { label: 'NR7', value: data.nr7.length, color: 'text-cyan-300' },
      { label: '52W↑', value: data.high52W.length, color: 'text-amber-400' },
      { label: '52W↓', value: data.low52W.length, color: 'text-orange-400' },
    ]},
  ];
  return (
    <div className="border border-amber-900/20 bg-[#050505] rounded-sm overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1 bg-zinc-900 border-b border-amber-900/20">
        <Activity className="h-3 w-3 text-amber-400" />
        <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400">Market Breadth</span>
        <span className="text-[10px] text-zinc-500 font-mono ml-1">({breadth.total} stocks)</span>
      </div>
      <div className="flex flex-wrap divide-x divide-zinc-800/60">
        {groups.map(g => (
          <div key={g.label} className="flex flex-col px-4 py-2 gap-1 min-w-fit">
            <span className="text-[9px] font-bold text-white/90 uppercase tracking-widest mb-0.5">{g.label}</span>
            <div className="flex gap-4 flex-wrap">
              {g.items.map(item => (
                <div key={item.label} className="flex flex-col items-center min-w-[36px]">
                  <span className={cn('text-[15px] font-bold tabular-nums font-mono leading-tight', item.color)}>{item.value}</span>
                  <span className="text-[9px] text-zinc-300 uppercase tracking-wide mt-0.5 whitespace-nowrap">{item.label}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Custom Filter ────────────────────────────────────────────────────────────
type DurationKey = '1W' | '1M' | '3M' | '5M' | '1Y';
const DURATION_FIELD: Record<DurationKey, keyof MoverResult> = {
  '1W': 'priceChange1W', '1M': 'priceChange1M',
  '3M': 'priceChange3M', '5M': 'priceChange5M', '1Y': 'priceChange1Y',
};

function CustomFilterPanel({ allMovers }: { allMovers: MoverResult[] }) {
  const [direction, setDirection] = useState<'rise' | 'fall'>('rise');
  const [pct, setPct] = useState(5);
  const [duration, setDuration] = useState<DurationKey>('1W');
  const field = DURATION_FIELD[duration];
  const filtered = useMemo(() => allMovers
    .filter(m => { const v = m[field] as number; return direction === 'rise' ? v >= pct : v <= -pct; })
    .sort((a, b) => { const va = a[field] as number, vb = b[field] as number; return direction === 'rise' ? vb - va : va - vb; }),
    [allMovers, field, direction, pct]);
  return (
    <div className="border border-amber-900/20 bg-[#050505] rounded-sm overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 bg-zinc-900 border-b border-amber-900/20">
        <Filter className="h-3 w-3 text-amber-400" />
        <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400">Custom Filter</span>
        <span className="text-[10px] text-zinc-500 font-mono ml-auto">{filtered.length} stocks</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-zinc-900/70">
        <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-sm text-[11px] p-0.5 gap-0.5">
          {(['rise', 'fall'] as const).map(d => (
            <button key={d} onClick={() => setDirection(d)}
              className={cn('px-2.5 py-0.5 font-bold rounded-sm transition-all font-mono',
                direction === d ? d === 'rise' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400' : 'text-zinc-500 hover:text-zinc-300')}>
              {d === 'rise' ? '↑ RISE' : '↓ FALL'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-sm px-2 py-0.5">
          <span className="text-[11px] text-zinc-500">≥</span>
          <input type="number" min={0.1} max={100} step={0.5} value={pct}
            onChange={e => setPct(Math.max(0.1, parseFloat(e.target.value) || 5))}
            className="w-10 bg-transparent text-[11px] font-bold text-zinc-200 text-right outline-none font-mono" />
          <span className="text-[11px] text-zinc-500">%</span>
        </div>
        <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-sm text-[11px] p-0.5 gap-0.5">
          {(Object.keys(DURATION_FIELD) as DurationKey[]).map(d => (
            <button key={d} onClick={() => setDuration(d)}
              className={cn('px-2.5 py-0.5 font-bold rounded-sm transition-all font-mono',
                duration === d ? 'bg-amber-500/10 text-amber-400' : 'text-zinc-500 hover:text-zinc-300')}>
              {d}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto overflow-y-auto" style={{ maxHeight: '320px' }}>
        {filtered.length === 0
          ? <p className="text-center text-[12px] text-zinc-600 py-6">No stocks match the current filter</p>
          : <table className="w-full border-collapse">
              <thead><tr>
                <TH>#</TH><TH>Symbol</TH><TH>Sector</TH>
                <TH right>Close</TH><TH right>1D%</TH><TH right>{duration}%</TH>
                <TH right>RSI</TH><TH right>MAs</TH><TH right>Trend</TH>
              </tr></thead>
              <tbody>
                {filtered.map((r, i) => (
                  <TR key={r.symbol}>
                    <TD className="text-zinc-500 w-5">{i + 1}</TD>
                    <TD className="font-bold text-zinc-100">{r.symbol}</TD>
                    <TD className="text-zinc-400 max-w-[90px] truncate text-[11px]">{r.sector || '—'}</TD>
                    <TD right className="text-zinc-200">₹{fmt(r.latestClose)}</TD>
                    <TD right><PctPill v={r.priceChange1D} /></TD>
                    <TD right><PctCell v={r[field] as number} bold /></TD>
                    <TD right><RSIBadge rsi={r.rsi14} /></TD>
                    <TD right><MADots a20={r.aboveMa20} a50={r.aboveMa50} a200={r.aboveMa200} /></TD>
                    <TD right><MiniSparkline r={r} /></TD>
                  </TR>
                ))}
              </tbody>
            </table>}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function MarketMovers() {
  const [indexType, setIndexType] = useState<'nifty50' | 'nifty500'>('nifty50');
  const [data, setData] = useState<MoversResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [quoteFetching, setQuoteFetching] = useState(false);
  const [quoteStatus, setQuoteStatus] = useState<'idle' | 'fetching' | 'done' | 'error'>('idle');
  const [autoIn, setAutoIn] = useState(300);
  const quotePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchDataRef = useRef<(showLoading?: boolean) => Promise<void>>(async () => {});

  const fetchData = useCallback(async (showLoading = true, bust = false) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const url = bust ? `/api/movers?index=${indexType}&bust` : `/api/movers?index=${indexType}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.success) { setData(json.data); setLastUpdated(new Date()); }
      else setError(json.error ?? 'Unknown error');
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  }, [indexType]);

  // Keep ref in sync so auto-refresh timer can call latest version
  useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Auto-refresh: reset 5-min countdown whenever data arrives
  useEffect(() => {
    if (!data) return;
    if (autoRef.current) clearInterval(autoRef.current);
    setAutoIn(300);
    autoRef.current = setInterval(() => {
      setAutoIn(c => {
        if (c <= 1) { fetchDataRef.current(false); return 300; }
        return c - 1;
      });
    }, 1000);
    return () => { if (autoRef.current) clearInterval(autoRef.current); };
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchLiveQuotes = useCallback(async () => {
    if (quoteFetching) return;
    setQuoteFetching(true); setQuoteStatus('fetching');
    try {
      const res = await fetch('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'quotes' }) });
      if (!res.ok) { setQuoteStatus('error'); setQuoteFetching(false); return; }
      if (quotePollRef.current) clearInterval(quotePollRef.current);
      quotePollRef.current = setInterval(async () => {
        try {
          const sj = await (await fetch('/api/refresh')).json();
          const done = sj.status?.done || (!sj.running && sj.status?.phase === 'done');
          if (sj.status?.error) { setQuoteStatus('error'); setQuoteFetching(false); clearInterval(quotePollRef.current!); }
          else if (done) { setQuoteStatus('done'); setQuoteFetching(false); clearInterval(quotePollRef.current!); setTimeout(() => fetchData(false, true), 500); }
        } catch { /* ignore */ }
      }, 1500);
    } catch { setQuoteStatus('error'); setQuoteFetching(false); }
  }, [quoteFetching, fetchData]);

  useEffect(() => () => {
    if (quotePollRef.current) clearInterval(quotePollRef.current);
    if (autoRef.current) clearInterval(autoRef.current);
  }, []);

  const breadth = useMemo(() => data ? computeBreadth(data.allMovers) : null, [data]);
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

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-100">
      <header className="w-full border-b border-amber-900/25 bg-[#050505] px-4 py-2 flex flex-wrap items-center gap-2.5 z-20 sticky top-0 backdrop-blur-md">
        <div className="flex items-center gap-2 mr-1">
          <div className="h-6 w-6 rounded-sm bg-amber-500 flex items-center justify-center shrink-0">
            <Terminal className="h-3.5 w-3.5 text-black" />
          </div>
          <span className="text-[13px] font-bold tracking-widest text-amber-400 uppercase font-mono">MARKET MOVERS</span>
        </div>
        <div className="w-px h-5 bg-zinc-800 hidden sm:block" />
        <NavBar />
        <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-sm text-[11px] gap-0.5">
          {(['nifty50', 'nifty500'] as const).map(t => (
            <button key={t} onClick={() => setIndexType(t)}
              className={cn('px-2.5 py-0.5 font-bold rounded-sm transition-all font-mono uppercase tracking-wide',
                indexType === t ? 'bg-amber-500/10 text-amber-400' : 'text-zinc-500 hover:text-zinc-300')}>
              {t === 'nifty50' ? 'N50' : 'N500'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 ml-auto">
          {data?.dataDate && (
            <span className="text-[10px] font-mono font-bold text-zinc-400 hidden md:inline px-2 py-0.5 rounded-sm bg-zinc-900 border border-zinc-800 uppercase tracking-wide">
              DATA: {data.dataDate}
            </span>
          )}
          {data && !loading && (
            <span className="text-[10px] text-zinc-600 tabular-nums font-mono hidden md:inline">
              AUTO {fmtCountdown(autoIn)}
            </span>
          )}
          {lastUpdated && (
            <span className="text-[10px] text-zinc-600 hidden md:inline tabular-nums font-mono">
              {lastUpdated.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
            </span>
          )}
          <button onClick={() => fetchData()} disabled={loading}
            className="h-6 w-6 flex items-center justify-center rounded-sm border border-zinc-800 bg-zinc-900 text-zinc-500 hover:text-amber-400 hover:border-amber-900/40 transition-all disabled:opacity-50">
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          </button>
        </div>
      </header>

      <main className="flex-1 w-full mx-auto px-3 py-2 flex flex-col gap-2">
        {data && (() => {
          const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
          const isStale = data.dataDate < todayIST;
          const hasLive = data.liveQuotesMeta?.date === todayIST;
          if (!isStale && hasLive) return (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-sm border border-emerald-500/20 bg-emerald-500/5 text-[11px] text-emerald-400 font-mono">
              <CheckCircle className="h-3 w-3 shrink-0" />
              <span>LIVE — {todayIST} — fetched {new Date(data.liveQuotesMeta!.updatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</span>
              <button onClick={fetchLiveQuotes} disabled={quoteFetching} className="ml-auto flex items-center gap-1 hover:text-emerald-300 disabled:opacity-50 uppercase tracking-wide text-[10px]">
                <RefreshCw className={cn('h-3 w-3', quoteFetching && 'animate-spin')} /> Refresh
              </button>
            </div>
          );
          if (isStale) return (
            <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 rounded-sm border border-amber-500/25 bg-amber-500/5 text-[11px] font-mono">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
              <span className="text-amber-300 font-bold uppercase tracking-wide">DATA: {data.dataDate || '—'}</span>
              <span className="text-zinc-500">EOD CSV not available yet — fetch live intraday snapshot.</span>
              {quoteStatus === 'done' && <span className="flex items-center gap-1 text-emerald-400"><CheckCircle className="h-3 w-3" /> Fetched</span>}
              {quoteStatus === 'error' && <span className="text-red-400">Fetch failed — check Dhan auth</span>}
              <button onClick={fetchLiveQuotes} disabled={quoteFetching}
                className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-sm bg-amber-500/10 border border-amber-500/30 text-amber-300 hover:bg-amber-500/20 font-bold transition-all disabled:opacity-50 uppercase tracking-wide text-[10px]">
                <Zap className={cn('h-3 w-3', quoteFetching && 'animate-pulse')} />
                {quoteFetching ? 'Fetching…' : 'Fetch Live Quotes'}
              </button>
            </div>
          );
          return null;
        })()}

        {error && <div className="rounded-sm border border-red-500/20 bg-red-950/10 p-4 text-center text-red-400 text-[12px] font-mono">ERR: {error}</div>}

        {loading && (
          <div className="flex flex-col items-center justify-center p-16 border border-amber-900/20 bg-[#050505]">
            <RefreshCw className="h-5 w-5 text-amber-500 animate-spin" />
            <span className="text-zinc-500 text-[11px] mt-3 font-mono uppercase tracking-widest">Computing market movers…</span>
          </div>
        )}

        {!loading && data && breadth && (
          <>
            <BreadthStrip breadth={breadth} data={data} />

            <Panel label="Sector Performance" color="text-amber-400" maxHeight="280px">
              <SectorTable movers={data.allMovers} />
            </Panel>

            <div className="grid grid-cols-1 xl:grid-cols-4 gap-2">
              <Panel label="Top Gainers" count={data.gainers.length} color="text-emerald-400" accent="text-emerald-600" maxHeight="260px">
                <GainerLoserTable rows={data.gainers} />
              </Panel>
              <Panel label="Top Losers" count={data.losers.length} color="text-red-400" accent="text-red-600" maxHeight="260px">
                <GainerLoserTable rows={data.losers} />
              </Panel>
              <Panel label="Bull Volume" color="text-violet-400" accent="text-violet-600" maxHeight="260px">
                <VolumeDirectionTable rows={data.highVolume} dir="bull" />
              </Panel>
              <Panel label="Bear Volume" color="text-rose-400" accent="text-rose-600" maxHeight="260px">
                <VolumeDirectionTable rows={data.highVolume} dir="bear" />
              </Panel>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-2">
              <Panel label="Near 52W High  (within 2%)" count={data.high52W.length} color="text-amber-400" maxHeight="240px">
                <HighLowTable rows={data.high52W} type="high" />
              </Panel>
              <Panel label="Near 52W Low  (within 5%)" count={data.low52W.length} color="text-orange-400" maxHeight="240px">
                <HighLowTable rows={data.low52W} type="low" />
              </Panel>
              <Panel label="Momentum Leaders  (1W>3% + 1M>5% + 3M>10%)" count={momentumLeaders.length} color="text-sky-400" maxHeight="240px">
                <MomentumMatrix rows={momentumLeaders.slice(0, 12)} />
              </Panel>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
              <Panel label="Rising 5 Consecutive Days" count={data.rising5D.length} color="text-sky-400" maxHeight="240px">
                <MoverTable rows={data.rising5D.slice(0, 20)} />
              </Panel>
              <Panel label="Falling 5 Consecutive Days" count={data.falling5D.length} color="text-rose-400" maxHeight="240px">
                <MoverTable rows={data.falling5D.slice(0, 20)} />
              </Panel>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
              <Panel label="Above 20D + 50D + 200D MA  &  RSI > 50" count={data.aboveAllMAs.length} color="text-teal-400" maxHeight="300px">
                <MATable rows={data.aboveAllMAs} />
              </Panel>
              <Panel label="Pullback in Uptrend  (above 200D, below 20D/50D, RSI < 60)" count={pullbackSetups.length} color="text-yellow-400" maxHeight="300px">
                <PullbackTable rows={pullbackSetups} />
              </Panel>
            </div>

            <Panel label="NR Breakout Setups  (NR4 + NR7 combined, ★★★ = NR7 + RSI 40-65 + Above 200D)" count={data.nr4.length + data.nr7.length} color="text-cyan-400" maxHeight="300px">
              <NRSetupTable nr4={data.nr4} nr7={data.nr7} />
            </Panel>

            <CustomFilterPanel allMovers={data.allMovers} />
          </>
        )}
      </main>
    </div>
  );
}
