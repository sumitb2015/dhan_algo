'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  TrendingUp, TrendingDown, Activity, BarChart2, ArrowUpCircle, Layers,
  RefreshCw, ChevronUp, ChevronDown, Zap, AlertTriangle, CheckCircle,
  Filter, Minimize2,
} from 'lucide-react';
import { MoverResult, MoversResponse } from '@/app/api/movers/route';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

// ─── Formatters ───────────────────────────────────────────────────────────────
function fmt(n: number, digits = 2) { return n.toFixed(digits); }
function fmtCr(n: number) {
  if (n >= 1e7) return `${(n / 1e7).toFixed(1)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
}

// ─── Micro display components ─────────────────────────────────────────────────
function PctBadge({ v }: { v: number }) {
  return (
    <span className={cn(
      'text-[11px] font-semibold tabular-nums',
      v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-zinc-500',
    )}>
      {v > 0 ? '+' : ''}{fmt(v)}%
    </span>
  );
}

function PctPill({ v }: { v: number }) {
  return (
    <span className={cn(
      'inline-flex items-center px-1.5 py-px rounded text-[11px] font-semibold tabular-nums',
      v > 0 ? 'bg-emerald-500/10 text-emerald-400' : v < 0 ? 'bg-red-500/10 text-red-400' : 'bg-zinc-800 text-zinc-500',
    )}>
      {v > 0 ? '+' : ''}{fmt(v)}%
    </span>
  );
}

function RSIBadge({ rsi }: { rsi: number }) {
  return (
    <span className={cn(
      'inline-flex items-center px-1.5 py-px rounded text-[11px] font-bold tabular-nums',
      rsi >= 70 ? 'bg-red-500/15 text-red-400' : rsi >= 50 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-zinc-800 text-zinc-500',
    )}>
      {fmt(rsi, 0)}
    </span>
  );
}

function MADot({ above }: { above: boolean }) {
  return <span className={cn('inline-block w-1.5 h-1.5 rounded-full', above ? 'bg-emerald-400' : 'bg-red-500')} />;
}

// ─── Table primitives ─────────────────────────────────────────────────────────
function TH({ children, right, className }: { children?: React.ReactNode; right?: boolean; className?: string }) {
  return (
    <th className={cn(
      'py-1.5 px-2 text-[10px] font-medium text-zinc-500 uppercase tracking-wide',
      right ? 'text-right' : 'text-left', className,
    )}>
      {children}
    </th>
  );
}
function TD({ children, right, className }: { children?: React.ReactNode; right?: boolean; className?: string }) {
  return (
    <td className={cn('py-[4px] px-2 text-[12px]', right ? 'text-right' : 'text-left', className)}>
      {children}
    </td>
  );
}
function TR({ children }: { children: React.ReactNode }) {
  return <tr className="border-b border-zinc-900/60 hover:bg-zinc-800/20 transition-colors">{children}</tr>;
}

// ─── Tables ───────────────────────────────────────────────────────────────────
function GainerLoserTable({ rows }: { rows: MoverResult[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-zinc-800">
            <TH>#</TH><TH>Symbol</TH><TH className="hidden sm:table-cell">Sector</TH>
            <TH right>Close</TH><TH right>1D</TH><TH right className="hidden md:table-cell">1W</TH><TH right className="hidden lg:table-cell">1M</TH>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <TR key={r.symbol}>
              <TD className="text-zinc-600 w-5">{i + 1}</TD>
              <TD className="font-mono font-semibold text-zinc-100">{r.symbol}</TD>
              <TD className="text-zinc-500 hidden sm:table-cell max-w-[110px] truncate">{r.sector || '—'}</TD>
              <TD right className="text-zinc-300 tabular-nums">₹{fmt(r.latestClose)}</TD>
              <TD right><PctPill v={r.priceChange1D} /></TD>
              <TD right className="hidden md:table-cell"><PctBadge v={r.priceChange1W} /></TD>
              <TD right className="hidden lg:table-cell"><PctBadge v={r.priceChange1M} /></TD>
            </TR>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HighLowTable({ rows, type }: { rows: MoverResult[]; type: 'high' | 'low' }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-zinc-800">
            <TH>#</TH><TH>Symbol</TH><TH className="hidden sm:table-cell">Sector</TH>
            <TH right>Close</TH><TH right>{type === 'high' ? '52W High' : '52W Low'}</TH>
            <TH right className="hidden md:table-cell">{type === 'high' ? '% from High' : '% above Low'}</TH>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <TR key={r.symbol}>
              <TD className="text-zinc-600 w-5">{i + 1}</TD>
              <TD className="font-mono font-semibold text-zinc-100">{r.symbol}</TD>
              <TD className="text-zinc-500 hidden sm:table-cell max-w-[110px] truncate">{r.sector || '—'}</TD>
              <TD right className="text-zinc-300 tabular-nums">₹{fmt(r.latestClose)}</TD>
              <TD right className="text-zinc-400 tabular-nums">₹{fmt(type === 'high' ? r.high52W : r.low52W)}</TD>
              <TD right className={cn(
                'hidden md:table-cell font-semibold tabular-nums',
                type === 'high' ? (r.pctFrom52WHigh >= 0 ? 'text-emerald-400' : 'text-zinc-400') : 'text-amber-400',
              )}>
                {type === 'high'
                  ? (r.pctFrom52WHigh >= 0 ? 'AT HIGH' : `${fmt(r.pctFrom52WHigh)}%`)
                  : `+${fmt(r.pctFrom52WLow)}%`}
              </TD>
            </TR>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VolumeTable({ rows }: { rows: MoverResult[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-zinc-800">
            <TH>#</TH><TH>Symbol</TH><TH className="hidden sm:table-cell">Sector</TH>
            <TH right>Close</TH><TH right>Vol ×</TH>
            <TH right className="hidden md:table-cell">Today</TH>
            <TH right className="hidden lg:table-cell">20D Avg</TH>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <TR key={r.symbol}>
              <TD className="text-zinc-600 w-5">{i + 1}</TD>
              <TD className="font-mono font-semibold text-zinc-100">{r.symbol}</TD>
              <TD className="text-zinc-500 hidden sm:table-cell max-w-[110px] truncate">{r.sector || '—'}</TD>
              <TD right className="text-zinc-300 tabular-nums">₹{fmt(r.latestClose)}</TD>
              <TD right>
                <span className={cn(
                  'inline-flex items-center px-1.5 py-px rounded text-[11px] font-bold tabular-nums',
                  r.volumeRatio >= 2 ? 'bg-violet-500/20 text-violet-300' : r.volumeRatio >= 1.5 ? 'bg-blue-500/15 text-blue-400' : 'bg-zinc-800 text-zinc-400',
                )}>
                  {fmt(r.volumeRatio, 1)}×
                </span>
              </TD>
              <TD right className="text-zinc-400 tabular-nums hidden md:table-cell">{fmtCr(r.latestVolume)}</TD>
              <TD right className="text-zinc-600 tabular-nums hidden lg:table-cell">{fmtCr(Math.round(r.avgVolume20D))}</TD>
            </TR>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MoverTable({ rows }: { rows: MoverResult[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-zinc-800">
            <TH>#</TH><TH>Symbol</TH><TH className="hidden sm:table-cell">Sector</TH>
            <TH right>Close</TH><TH right>1D</TH><TH right className="hidden md:table-cell">1W</TH>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <TR key={r.symbol}>
              <TD className="text-zinc-600 w-5">{i + 1}</TD>
              <TD className="font-mono font-semibold text-zinc-100">{r.symbol}</TD>
              <TD className="text-zinc-500 hidden sm:table-cell max-w-[110px] truncate">{r.sector || '—'}</TD>
              <TD right className="text-zinc-300 tabular-nums">₹{fmt(r.latestClose)}</TD>
              <TD right><PctPill v={r.priceChange1D} /></TD>
              <TD right className="hidden md:table-cell"><PctBadge v={r.priceChange1W} /></TD>
            </TR>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MATable({ rows }: { rows: MoverResult[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-zinc-800">
            <TH>#</TH><TH>Symbol</TH><TH className="hidden sm:table-cell">Sector</TH>
            <TH right>Close</TH>
            <TH right className="hidden md:table-cell">20D</TH>
            <TH right className="hidden md:table-cell">50D</TH>
            <TH right className="hidden lg:table-cell">200D</TH>
            <TH right className="hidden lg:table-cell">RSI</TH>
            <TH right className="hidden xl:table-cell">1M</TH>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <TR key={r.symbol}>
              <TD className="text-zinc-600 w-5">{i + 1}</TD>
              <TD className="font-mono font-semibold text-zinc-100">{r.symbol}</TD>
              <TD className="text-zinc-500 hidden sm:table-cell max-w-[110px] truncate">{r.sector || '—'}</TD>
              <TD right className="font-semibold text-zinc-200 tabular-nums">₹{fmt(r.latestClose)}</TD>
              <TD right className="hidden md:table-cell">
                <span className="inline-flex items-center gap-1.5 justify-end">
                  <span className="text-zinc-500 tabular-nums text-[11px]">₹{fmt(r.ma20)}</span>
                  <MADot above={r.aboveMa20} />
                </span>
              </TD>
              <TD right className="hidden md:table-cell">
                <span className="inline-flex items-center gap-1.5 justify-end">
                  <span className="text-zinc-500 tabular-nums text-[11px]">₹{fmt(r.ma50)}</span>
                  <MADot above={r.aboveMa50} />
                </span>
              </TD>
              <TD right className="hidden lg:table-cell">
                <span className="inline-flex items-center gap-1.5 justify-end">
                  <span className="text-zinc-500 tabular-nums text-[11px]">₹{fmt(r.ma200)}</span>
                  <MADot above={r.aboveMa200} />
                </span>
              </TD>
              <TD right className="hidden lg:table-cell"><RSIBadge rsi={r.rsi14} /></TD>
              <TD right className="hidden xl:table-cell"><PctBadge v={r.priceChange1M} /></TD>
            </TR>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NRTable({ rows, n }: { rows: MoverResult[]; n: 4 | 7 }) {
  return (
    <div className="overflow-x-auto">
      <p className="text-[10px] text-zinc-600 mb-2 px-2">
        NR{n}: today&apos;s range is strictly narrower than each of the previous {n - 1} sessions — volatility contraction often precedes a breakout.
      </p>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-zinc-800">
            <TH>#</TH><TH>Symbol</TH><TH className="hidden sm:table-cell">Sector</TH>
            <TH right>Close</TH><TH right>Range</TH>
            <TH right className="hidden md:table-cell">Max {n}D</TH>
            <TH right className="hidden md:table-cell">Range %</TH>
            <TH right className="hidden lg:table-cell">RSI</TH>
            <TH right className="hidden xl:table-cell">1D</TH>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const maxRange = (n === 4 ? r.maxRange4D : r.maxRange7D) ?? 0;
            const rangePct = maxRange > 0 ? ((r.nr7Range ?? 0) / maxRange) * 100 : 0;
            return (
              <TR key={r.symbol}>
                <TD className="text-zinc-600 w-5">{i + 1}</TD>
                <TD className="font-mono font-semibold text-zinc-100">{r.symbol}</TD>
                <TD className="text-zinc-500 hidden sm:table-cell max-w-[110px] truncate">{r.sector || '—'}</TD>
                <TD right className="text-zinc-300 tabular-nums">₹{fmt(r.latestClose)}</TD>
                <TD right className="text-cyan-400 font-bold tabular-nums">₹{fmt(r.nr7Range ?? 0)}</TD>
                <TD right className="text-zinc-500 tabular-nums hidden md:table-cell">₹{fmt(maxRange)}</TD>
                <TD right className="hidden md:table-cell">
                  <span className={cn(
                    'inline-flex items-center px-1.5 py-px rounded text-[11px] font-bold tabular-nums',
                    rangePct < 30 ? 'bg-cyan-500/20 text-cyan-300' : rangePct < 60 ? 'bg-sky-500/15 text-sky-400' : 'bg-zinc-800 text-zinc-400',
                  )}>
                    {fmt(rangePct, 0)}%
                  </span>
                </TD>
                <TD right className="hidden lg:table-cell"><RSIBadge rsi={r.rsi14} /></TD>
                <TD right className="hidden xl:table-cell"><PctPill v={r.priceChange1D} /></TD>
              </TR>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Duration filter ──────────────────────────────────────────────────────────
type DurationKey = '1W' | '1M' | '3M' | '5M' | '1Y';
const DURATION_LABELS: Record<DurationKey, string> = { '1W': '1W', '1M': '1M', '3M': '3M', '5M': '5M', '1Y': '1Y' };
const DURATION_FIELD: Record<DurationKey, keyof MoverResult> = {
  '1W': 'priceChange1W', '1M': 'priceChange1M',
  '3M': 'priceChange3M', '5M': 'priceChange5M', '1Y': 'priceChange1Y',
};

function CustomFilterCard({ allMovers }: { allMovers: MoverResult[] }) {
  const [direction, setDirection] = useState<'rise' | 'fall'>('rise');
  const [pct, setPct] = useState(5);
  const [duration, setDuration] = useState<DurationKey>('1W');

  const field = DURATION_FIELD[duration];
  const filtered = allMovers
    .filter((m) => { const v = m[field] as number; return direction === 'rise' ? v >= pct : v <= -pct; })
    .sort((a, b) => { const va = a[field] as number, vb = b[field] as number; return direction === 'rise' ? vb - va : va - vb; });

  return (
    <Card className="border-zinc-800 bg-zinc-950 py-0 gap-0 ring-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800/70">
        <Filter className="h-3.5 w-3.5 text-fuchsia-400 shrink-0" />
        <span className="text-[13px] font-semibold text-zinc-200 flex-1">Custom Filter</span>
        <span className="text-[11px] text-zinc-500 tabular-nums">{filtered.length} stocks</span>
      </div>
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-zinc-900/70">
        <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-md text-[11px] p-0.5 gap-0.5">
          {(['rise', 'fall'] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDirection(d)}
              className={cn(
                'px-2.5 py-1 font-semibold rounded transition-all',
                direction === d
                  ? d === 'rise' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
                  : 'text-zinc-500 hover:text-zinc-300',
              )}
            >
              {d === 'rise' ? '↑ Rise' : '↓ Fall'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-md px-2.5 py-1">
          <span className="text-[11px] text-zinc-500">≥</span>
          <input
            type="number" min={0.1} max={100} step={0.5} value={pct}
            onChange={(e) => setPct(Math.max(0.1, parseFloat(e.target.value) || 5))}
            className="w-10 bg-transparent text-[11px] font-bold text-zinc-200 text-right outline-none"
          />
          <span className="text-[11px] text-zinc-500">%</span>
        </div>
        <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-md text-[11px] p-0.5 gap-0.5">
          {(Object.keys(DURATION_LABELS) as DurationKey[]).map((d) => (
            <button
              key={d}
              onClick={() => setDuration(d)}
              className={cn(
                'px-2.5 py-1 font-semibold rounded transition-all',
                duration === d ? 'bg-violet-500/10 text-violet-400' : 'text-zinc-500 hover:text-zinc-300',
              )}
            >
              {d}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-zinc-600 ml-auto hidden sm:block">
          {direction === 'rise' ? '+' : '-'}{pct}% or more in {DURATION_LABELS[duration]}
        </span>
      </div>
      {/* Results */}
      <div className="px-4 pt-1 pb-3">
        {filtered.length === 0 ? (
          <p className="text-center text-[12px] text-zinc-600 py-5">No stocks match the current filter</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-zinc-800">
                  <TH>#</TH><TH>Symbol</TH><TH className="hidden sm:table-cell">Sector</TH>
                  <TH right>Close</TH><TH right>1D</TH><TH right>{duration} %</TH>
                  <TH right className="hidden md:table-cell">RSI</TH>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <TR key={r.symbol}>
                    <TD className="text-zinc-600 w-5">{i + 1}</TD>
                    <TD className="font-mono font-semibold text-zinc-100">{r.symbol}</TD>
                    <TD className="text-zinc-500 hidden sm:table-cell max-w-[110px] truncate">{r.sector || '—'}</TD>
                    <TD right className="text-zinc-300 tabular-nums">₹{fmt(r.latestClose)}</TD>
                    <TD right><PctPill v={r.priceChange1D} /></TD>
                    <TD right><PctPill v={r[field] as number} /></TD>
                    <TD right className="hidden md:table-cell"><RSIBadge rsi={r.rsi14} /></TD>
                  </TR>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── Collapsible section card ─────────────────────────────────────────────────
function Section({ icon, title, color, count, children }: {
  icon: React.ReactNode; title: string; color: string; count: number; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="border-zinc-800 bg-zinc-950 py-0 gap-0 ring-0 overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-zinc-800/20 transition-colors text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={color}>{icon}</span>
        <span className="text-[13px] font-semibold text-zinc-200 flex-1 tracking-wide">{title}</span>
        <span className="text-[11px] text-zinc-500 tabular-nums mr-2">{count}</span>
        {open
          ? <ChevronUp className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
          : <ChevronDown className="h-3.5 w-3.5 text-zinc-600 shrink-0" />}
      </button>
      {open && (
        <>
          <div className="h-px bg-zinc-800/70 mx-0" />
          <div className="px-4 pt-2 pb-3">{children}</div>
        </>
      )}
    </Card>
  );
}

// ─── Stat strip ───────────────────────────────────────────────────────────────
function StatStrip({ stats }: { stats: { label: string; value: number; color: string }[] }) {
  return (
    <Card className="border-zinc-800 bg-zinc-950 py-0 gap-0 ring-0">
      <div className="flex flex-wrap items-stretch divide-x divide-zinc-800/70">
        {stats.map((s, i) => (
          <div key={i} className="flex flex-col items-center px-3 py-2 min-w-[72px] flex-1">
            <span className={cn('text-[18px] font-bold tabular-nums leading-tight', s.color)}>{s.value}</span>
            <span className="text-[9px] text-zinc-600 uppercase tracking-wide mt-0.5 text-center whitespace-nowrap">{s.label}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function MarketMovers() {
  const [indexType, setIndexType] = useState<'nifty50' | 'nifty500'>('nifty50');
  const [data, setData] = useState<MoversResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [quoteFetching, setQuoteFetching] = useState(false);
  const [quoteStatus, setQuoteStatus] = useState<'idle' | 'fetching' | 'done' | 'error'>('idle');
  const quotePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/movers?index=${indexType}`);
      const json = await res.json();
      if (json.success) { setData(json.data); setLastUpdated(new Date()); }
      else setError(json.error ?? 'Unknown error');
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  }, [indexType]);

  useEffect(() => { fetchData(); }, [fetchData]);

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
      if (!res.ok) { setQuoteStatus('error'); setQuoteFetching(false); return; }
      if (quotePollRef.current) clearInterval(quotePollRef.current);
      quotePollRef.current = setInterval(async () => {
        try {
          const sj = await (await fetch('/api/refresh')).json();
          const done = sj.status?.done || (!sj.running && sj.status?.phase === 'done');
          if (sj.status?.error) {
            setQuoteStatus('error'); setQuoteFetching(false); clearInterval(quotePollRef.current!);
          } else if (done) {
            setQuoteStatus('done'); setQuoteFetching(false); clearInterval(quotePollRef.current!);
            setTimeout(() => fetchData(false), 500);
          }
        } catch { /* ignore */ }
      }, 1500);
    } catch { setQuoteStatus('error'); setQuoteFetching(false); }
  }, [quoteFetching, fetchData]);

  useEffect(() => () => { if (quotePollRef.current) clearInterval(quotePollRef.current); }, []);

  const stats = data ? [
    { label: 'Gainers',    value: data.gainers.length,     color: 'text-emerald-400' },
    { label: 'Losers',     value: data.losers.length,      color: 'text-red-400' },
    { label: '52W High',   value: data.high52W.length,     color: 'text-amber-400' },
    { label: '52W Low',    value: data.low52W.length,      color: 'text-orange-400' },
    { label: 'Rising 5D',  value: data.rising5D.length,    color: 'text-sky-400' },
    { label: 'Falling 5D', value: data.falling5D.length,   color: 'text-rose-400' },
    { label: '+5% 1W',     value: data.bigGainers1W.length, color: 'text-teal-400' },
    { label: '-5% 1W',     value: data.bigLosers1W.length,  color: 'text-pink-400' },
    { label: 'All MAs ↑',  value: data.aboveAllMAs.length,  color: 'text-violet-400' },
    { label: 'NR4',        value: data.nr4.length,          color: 'text-sky-300' },
    { label: 'NR7',        value: data.nr7.length,          color: 'text-cyan-400' },
  ] : null;

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-100">
      {/* Header */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/90 backdrop-blur-md px-4 py-2 flex flex-wrap items-center gap-2.5 z-20 sticky top-0">
        <div className="flex items-center gap-2 mr-1">
          <div className="h-6 w-6 rounded-md bg-gradient-to-tr from-violet-600 to-blue-500 flex items-center justify-center shrink-0">
            <Activity className="h-3.5 w-3.5 text-white" />
          </div>
          <span className="text-[14px] font-bold tracking-tight text-white">Market Movers</span>
        </div>

        <div className="w-px h-5 bg-zinc-800 hidden sm:block" />

        {/* Nav */}
        <nav className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5">
          <a href="/" className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">RS Scanner</a>
          <span className="px-2.5 py-1 font-semibold rounded bg-violet-500/10 text-violet-400">Movers</span>
          <a href="/scanner" className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">Scanner</a>
          <a href="/live" className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">Live</a>
          <a href="/strategies" className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">Strategies</a>
          <a href="/portfolio" className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">Portfolio</a>
          <a href="/reports" className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">Reports</a>
        </nav>

        {/* Index toggle */}
        <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5">
          {(['nifty50', 'nifty500'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setIndexType(t)}
              className={cn(
                'px-2.5 py-1 font-semibold rounded transition-all',
                indexType === t ? 'bg-violet-500/10 text-violet-400' : 'text-zinc-500 hover:text-zinc-300',
              )}
            >
              {t === 'nifty50' ? 'Nifty 50' : 'Nifty 500'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {lastUpdated && (
            <span className="text-[10px] text-zinc-600 hidden md:inline tabular-nums">
              {lastUpdated.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
            </span>
          )}
          <button
            onClick={() => fetchData()}
            disabled={loading}
            className="h-7 w-7 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-all disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 w-full max-w-[1600px] mx-auto px-4 py-3 flex flex-col gap-2.5">

        {/* Banners */}
        {data && (() => {
          const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
          const isStale = data.dataDate < todayIST;
          const hasLive = data.liveQuotesMeta?.date === todayIST;

          if (!isStale) {
            return hasLive ? (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 text-[11px] text-emerald-400">
                <CheckCircle className="h-3 w-3 shrink-0" />
                <span>Live quotes active for {todayIST} — last fetched {new Date(data.liveQuotesMeta!.updatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</span>
                <button onClick={fetchLiveQuotes} disabled={quoteFetching} className="ml-auto flex items-center gap-1 hover:text-emerald-300 disabled:opacity-50">
                  <RefreshCw className={cn('h-3 w-3', quoteFetching && 'animate-spin')} /> Refresh
                </button>
              </div>
            ) : null;
          }

          return (
            <div className="flex flex-wrap items-center gap-2.5 px-3 py-2 rounded-lg border border-amber-500/25 bg-amber-500/5 text-[11px]">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
              <span className="text-amber-300 font-semibold">Data as of {data.dataDate || '—'}</span>
              <span className="text-zinc-500">Today&apos;s EOD CSV not available yet — fetch live quotes for intraday snapshot.</span>
              {quoteStatus === 'done' && <span className="flex items-center gap-1 text-emerald-400"><CheckCircle className="h-3 w-3" /> Fetched</span>}
              {quoteStatus === 'error' && <span className="text-red-400">Fetch failed — check Dhan auth</span>}
              <button
                onClick={fetchLiveQuotes} disabled={quoteFetching}
                className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 font-semibold transition-all disabled:opacity-50"
              >
                <Zap className={cn('h-3 w-3', quoteFetching && 'animate-pulse')} />
                {quoteFetching ? 'Fetching…' : 'Fetch Live Quotes'}
              </button>
            </div>
          );
        })()}

        {/* Stat strip */}
        {stats && <StatStrip stats={stats} />}

        {/* Error */}
        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-950/10 p-4 text-center text-red-400 text-[12px]">
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center p-16 rounded-lg border border-zinc-900 bg-zinc-950">
            <RefreshCw className="h-6 w-6 text-violet-500 animate-spin" />
            <span className="text-zinc-500 text-[12px] mt-3">Computing market movers…</span>
          </div>
        )}

        {/* Sections grid */}
        {!loading && data && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-2.5">
            <Section icon={<TrendingUp className="h-3.5 w-3.5" />} title="Top 10 Gainers" color="text-emerald-400" count={data.gainers.length}>
              <GainerLoserTable rows={data.gainers} />
            </Section>
            <Section icon={<TrendingDown className="h-3.5 w-3.5" />} title="Top 10 Losers" color="text-red-400" count={data.losers.length}>
              <GainerLoserTable rows={data.losers} />
            </Section>
            <Section icon={<ArrowUpCircle className="h-3.5 w-3.5" />} title="Near 52-Week High (within 2%)" color="text-amber-400" count={data.high52W.length}>
              <HighLowTable rows={data.high52W} type="high" />
            </Section>
            <Section icon={<ArrowUpCircle className="h-3.5 w-3.5 rotate-180" />} title="Near 52-Week Low (within 5%)" color="text-orange-400" count={data.low52W.length}>
              <HighLowTable rows={data.low52W} type="low" />
            </Section>
            <Section icon={<BarChart2 className="h-3.5 w-3.5" />} title="Highest Volume vs 20D Avg" color="text-violet-400" count={data.highVolume.length}>
              <VolumeTable rows={data.highVolume} />
            </Section>
            <Section icon={<TrendingUp className="h-3.5 w-3.5" />} title="Rising All 5 Consecutive Days" color="text-sky-400" count={data.rising5D.length}>
              <MoverTable rows={data.rising5D.slice(0, 20)} />
            </Section>
            <Section icon={<TrendingDown className="h-3.5 w-3.5" />} title="Falling All 5 Consecutive Days" color="text-rose-400" count={data.falling5D.length}>
              <MoverTable rows={data.falling5D.slice(0, 20)} />
            </Section>
            <Section icon={<TrendingUp className="h-3.5 w-3.5" />} title="Gained >5% This Week" color="text-teal-400" count={data.bigGainers1W.length}>
              <GainerLoserTable rows={data.bigGainers1W} />
            </Section>
            <Section icon={<TrendingDown className="h-3.5 w-3.5" />} title="Dropped >5% This Week" color="text-pink-400" count={data.bigLosers1W.length}>
              <GainerLoserTable rows={data.bigLosers1W} />
            </Section>
            <div className="xl:col-span-2">
              <Section icon={<Layers className="h-3.5 w-3.5" />} title="Above 20D + 50D + 200D MA  &  RSI > 50" color="text-teal-400" count={data.aboveAllMAs.length}>
                <MATable rows={data.aboveAllMAs} />
              </Section>
            </div>
            <div className="xl:col-span-2">
              <Section icon={<Activity className="h-3.5 w-3.5" />} title="Above 200D MA" color="text-blue-400" count={data.aboveMa200.length}>
                <MATable rows={data.aboveMa200} />
              </Section>
            </div>
            <div className="xl:col-span-2">
              <Section icon={<Minimize2 className="h-3.5 w-3.5" />} title="NR4 — Narrow Range 4 Setups" color="text-sky-400" count={data.nr4.length}>
                <NRTable rows={data.nr4} n={4} />
              </Section>
            </div>
            <div className="xl:col-span-2">
              <Section icon={<Minimize2 className="h-3.5 w-3.5" />} title="NR7 — Narrow Range 7 Setups" color="text-cyan-400" count={data.nr7.length}>
                <NRTable rows={data.nr7} n={7} />
              </Section>
            </div>
            <div className="xl:col-span-2">
              <CustomFilterCard allMovers={data.allMovers} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
