'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Download, Search, ChevronUp, ChevronDown, TrendingUp, BarChart2 } from 'lucide-react';
import { ScannerResult, ScannerResponse } from '@/app/api/scanner/route';
import { cn } from '@/lib/utils';

// ─── Indicator cell helpers ───────────────────────────────────────────────────

type Signal = 'strong_bull' | 'bull' | 'neutral' | 'bear' | 'strong_bear';

function sigCell(signal: Signal) {
  switch (signal) {
    case 'strong_bull': return <span title="Strong Bullish">🟢</span>;
    case 'bull':        return <span title="Bullish">✅</span>;
    case 'neutral':     return <span title="Neutral">⚠️</span>;
    case 'bear':        return <span title="Bearish">❌</span>;
    case 'strong_bear': return <span title="Strong Bearish">🔴</span>;
  }
}

function boolCell(v: boolean, strongTrue?: boolean, strongFalse?: boolean) {
  if (v && strongTrue) return sigCell('strong_bull');
  if (v) return sigCell('bull');
  if (!v && strongFalse) return sigCell('strong_bear');
  return sigCell('bear');
}

function rsiCell(rsi: number) {
  if (rsi >= 70) return sigCell('strong_bull');
  if (rsi >= 60) return sigCell('bull');
  if (rsi >= 40) return sigCell('neutral');
  if (rsi >= 30) return sigCell('bear');
  return sigCell('strong_bear');
}

function adxCell(adx: number) {
  if (adx >= 30) return sigCell('strong_bull');
  if (adx >= 25) return sigCell('bull');
  return sigCell('neutral');
}

function macdCell(r: ScannerResult) {
  if (r.macdCrossover) return sigCell('strong_bull');
  if (r.macdBullish) return sigCell('bull');
  return sigCell('bear');
}

function volCell(ratio: number) {
  if (ratio >= 2) return sigCell('strong_bull');
  if (ratio >= 1.5) return sigCell('bull');
  if (ratio >= 0.8) return sigCell('neutral');
  return sigCell('bear');
}

function rsCell(r: ScannerResult) {
  if (r.rsRising20 && r.rsAboveMA) return sigCell('strong_bull');
  if (r.rsRising20 || r.rsAboveMA) return sigCell('bull');
  return sigCell('bear');
}

// ─── Score bar ────────────────────────────────────────────────────────────────

function ScoreBar({ score, max = 15 }: { score: number; max?: number }) {
  const pct = (score / max) * 100;
  const color = pct >= 80 ? 'bg-emerald-500' : pct >= 60 ? 'bg-lime-500' : pct >= 40 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-1.5 justify-end">
      <div className="w-16 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className={cn(
        'text-[11px] font-bold tabular-nums w-8 text-right',
        pct >= 80 ? 'text-emerald-400' : pct >= 60 ? 'text-lime-400' : pct >= 40 ? 'text-amber-400' : 'text-red-400',
      )}>
        {score}/{max}
      </span>
    </div>
  );
}

// ─── Table primitives ─────────────────────────────────────────────────────────

type SortKey = keyof ScannerResult | 'none';

function TH({
  children, right, sortKey, currentSort, onSort, className,
}: {
  children?: React.ReactNode;
  right?: boolean;
  sortKey?: SortKey;
  currentSort?: { key: SortKey; dir: 'asc' | 'desc' };
  onSort?: (k: SortKey) => void;
  className?: string;
}) {
  const active = currentSort?.key === sortKey;
  return (
    <th
      className={cn(
        'py-2 px-2 text-xs font-bold text-white bg-zinc-800 whitespace-nowrap uppercase tracking-wide select-none',
        right ? 'text-right' : 'text-left',
        sortKey ? 'cursor-pointer hover:bg-zinc-700 transition-colors' : '',
        className,
      )}
      onClick={() => sortKey && onSort?.(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sortKey && active && (
          currentSort?.dir === 'asc'
            ? <ChevronUp className="h-3 w-3 text-violet-400 shrink-0" />
            : <ChevronDown className="h-3 w-3 text-violet-400 shrink-0" />
        )}
      </span>
    </th>
  );
}

function TD({ children, right, className }: { children?: React.ReactNode; right?: boolean; className?: string }) {
  return (
    <td className={cn('py-1.5 px-2 text-[12px]', right ? 'text-right' : 'text-left', className)}>
      {children}
    </td>
  );
}

function PctBadge({ v }: { v: number }) {
  return (
    <span className={cn(
      'text-[11px] font-semibold tabular-nums',
      v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-zinc-500',
    )}>
      {v > 0 ? '+' : ''}{v.toFixed(2)}%
    </span>
  );
}

// ─── Universe options ─────────────────────────────────────────────────────────

const UNIVERSES = [
  { value: 'nifty50',  label: 'NIFTY 50' },
  { value: 'nifty500', label: 'NIFTY 500' },
  { value: 'all',      label: 'All NSE Stocks' },
] as const;
type Universe = typeof UNIVERSES[number]['value'];

// ─── Score filter presets ─────────────────────────────────────────────────────

const PRESETS = [
  { label: 'All', filter: () => true },
  { label: 'Score ≥80%', filter: (r: ScannerResult) => r.scorePercent >= 80 },
  { label: 'Score ≥60%', filter: (r: ScannerResult) => r.scorePercent >= 60 },
  { label: 'Trend Aligned', filter: (r: ScannerResult) => r.aboveEma20 && r.aboveEma50 && r.aboveEma200 && r.supertrendBullish },
  { label: 'RS Strong', filter: (r: ScannerResult) => r.rsRising20 && r.rsAboveMA && r.rsScore >= 60 },
  { label: 'Momentum', filter: (r: ScannerResult) => r.rsi14 > 60 && r.macdBullish && r.adx14 > 25 },
  { label: 'Vol Spike', filter: (r: ScannerResult) => r.volumeRatio >= 1.5 },
  { label: 'NR4/NR7', filter: (r: ScannerResult) => r.isNR4 || r.isNR7 },
];

// ─── CSV export ───────────────────────────────────────────────────────────────

function exportCSV(rows: ScannerResult[]) {
  const headers = [
    'Symbol', 'Sector', 'Close', '1D%', '1W%', '1M%',
    'EMA20', 'EMA50', 'EMA200', 'ST', 'RSI', 'MACD', 'ADX', 'BB', 'Vol×', 'RS', 'RS Score',
    'Score', 'Score%',
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      r.symbol, r.sector, r.latestClose.toFixed(2),
      r.priceChange1D.toFixed(2), r.priceChange1W.toFixed(2), r.priceChange1M.toFixed(2),
      r.aboveEma20 ? 1 : 0,
      r.aboveEma50 ? 1 : 0,
      r.aboveEma200 ? 1 : 0,
      r.supertrendBullish ? 1 : 0,
      r.rsi14.toFixed(1),
      r.macdBullish ? 1 : 0,
      r.adx14.toFixed(1),
      r.bbExpanding ? 1 : 0,
      r.volumeRatio.toFixed(2),
      (r.rsRising20 && r.rsAboveMA) ? 2 : (r.rsRising20 || r.rsAboveMA) ? 1 : 0,
      r.rsScore,
      r.score,
      r.scorePercent.toFixed(1),
    ].join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `scanner_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Scanner() {
  const [universe, setUniverse] = useState<Universe>('nifty50');
  const [data, setData] = useState<ScannerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [search, setSearch] = useState('');
  const [preset, setPreset] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'score', dir: 'desc' });

  const fetchData = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/scanner?index=${universe}`);
      const json = await res.json();
      if (json.success) { setData(json.data); setLastUpdated(new Date()); }
      else setError(json.error ?? 'Unknown error');
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  }, [universe]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Sort handler
  function handleSort(key: SortKey) {
    setSort((prev) => ({ key, dir: prev.key === key && prev.dir === 'desc' ? 'asc' : 'desc' }));
  }

  // Filter + sort
  const rows: ScannerResult[] = React.useMemo(() => {
    if (!data) return [];
    let filtered = data.results;

    if (search.trim()) {
      const q = search.trim().toUpperCase();
      filtered = filtered.filter((r) => r.symbol.includes(q) || r.sector.toUpperCase().includes(q));
    }

    filtered = filtered.filter(PRESETS[preset].filter);

    if (sort.key !== 'none') {
      filtered = [...filtered].sort((a, b) => {
        const va = a[sort.key as keyof ScannerResult];
        const vb = b[sort.key as keyof ScannerResult];
        if (typeof va === 'boolean' && typeof vb === 'boolean') {
          return sort.dir === 'desc' ? (vb ? 1 : 0) - (va ? 1 : 0) : (va ? 1 : 0) - (vb ? 1 : 0);
        }
        if (typeof va === 'number' && typeof vb === 'number') {
          return sort.dir === 'desc' ? vb - va : va - vb;
        }
        return sort.dir === 'desc'
          ? String(vb).localeCompare(String(va))
          : String(va).localeCompare(String(vb));
      });
    }

    return filtered;
  }, [data, search, preset, sort]);

  // Summary counts
  const stats = data ? {
    total: data.results.length,
    aboveEma200: data.results.filter((r) => r.aboveEma200).length,
    trending: data.results.filter((r) => r.aboveEma20 && r.aboveEma50 && r.aboveEma200).length,
    supertrendBull: data.results.filter((r) => r.supertrendBullish).length,
    rsiOB: data.results.filter((r) => r.rsi14 > 70).length,
    macdBull: data.results.filter((r) => r.macdBullish).length,
    adxStrong: data.results.filter((r) => r.adx14 > 25).length,
    volSpike: data.results.filter((r) => r.volumeRatio >= 1.5).length,
    rsStrong: data.results.filter((r) => r.rsRising20 && r.rsAboveMA).length,
    highScore: data.results.filter((r) => r.scorePercent >= 60).length,
  } : null;

  const thProps = { currentSort: sort, onSort: handleSort };

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-100">

      {/* Header */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/90 backdrop-blur-md px-4 py-2 flex flex-wrap items-center gap-2.5 z-20 sticky top-0">
        <div className="flex items-center gap-2 mr-1">
          <div className="h-6 w-6 rounded-md bg-gradient-to-tr from-emerald-600 to-cyan-500 flex items-center justify-center shrink-0">
            <BarChart2 className="h-3.5 w-3.5 text-white" />
          </div>
          <span className="text-[14px] font-bold tracking-tight text-white">Tech Scanner</span>
        </div>

        <div className="w-px h-5 bg-zinc-800 hidden sm:block" />

        {/* Nav */}
        <nav className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5">
          <a href="/"           className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">RS Scanner</a>
          <a href="/movers"     className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">Movers</a>
          <span                 className="px-2.5 py-1 font-semibold rounded bg-emerald-500/10 text-emerald-400">Scanner</span>
          <a href="/normalized" className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">Charts</a>
          <a href="/live"       className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">Live</a>
          <a href="/strategies" className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">Strategies</a>
          <a href="/portfolio"  className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">Portfolio</a>
          <a href="/reports"    className="px-2.5 py-1 font-medium text-zinc-500 hover:text-zinc-300 rounded transition-all">Reports</a>
        </nav>

        {/* Universe selector */}
        <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5">
          {UNIVERSES.map((u) => (
            <button
              key={u.value}
              onClick={() => setUniverse(u.value)}
              className={cn(
                'px-2.5 py-1 font-semibold rounded transition-all',
                universe === u.value ? 'bg-emerald-500/10 text-emerald-400' : 'text-zinc-500 hover:text-zinc-300',
              )}
            >
              {u.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {lastUpdated && (
            <span className="text-[10px] text-zinc-600 hidden md:inline tabular-nums">
              {lastUpdated.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
            </span>
          )}
          {data && (
            <button
              onClick={() => exportCSV(rows)}
              className="h-7 px-2.5 flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-all text-[11px] font-medium"
            >
              <Download className="h-3 w-3" /> CSV
            </button>
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

      <main className="flex-1 w-full max-w-[1800px] mx-auto px-4 py-3 flex flex-col gap-3">

        {/* Stat strip */}
        {stats && (
          <div className="grid grid-cols-5 sm:grid-cols-10 gap-1.5">
            {[
              { label: 'Total',       value: stats.total,         color: 'text-white' },
              { label: '> EMA200',    value: stats.aboveEma200,   color: 'text-blue-300' },
              { label: 'EMA Trend',   value: stats.trending,      color: 'text-emerald-300' },
              { label: 'Supertrend',  value: stats.supertrendBull,color: 'text-teal-300' },
              { label: 'RSI > 70',    value: stats.rsiOB,         color: 'text-amber-300' },
              { label: 'MACD Bull',   value: stats.macdBull,      color: 'text-cyan-300' },
              { label: 'ADX > 25',    value: stats.adxStrong,     color: 'text-violet-300' },
              { label: 'Vol Spike',   value: stats.volSpike,      color: 'text-orange-300' },
              { label: 'RS Strong',   value: stats.rsStrong,      color: 'text-pink-300' },
              { label: 'Score ≥60%',  value: stats.highScore,     color: 'text-lime-300' },
            ].map((s) => (
              <div key={s.label} className="flex flex-col items-center bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-2">
                <span className={cn('text-[16px] font-bold tabular-nums leading-tight', s.color)}>{s.value}</span>
                <span className="text-[9px] text-zinc-500 uppercase tracking-wide mt-0.5 text-center whitespace-nowrap">{s.label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 flex-1 min-w-[160px] max-w-[280px]">
            <Search className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search symbol / sector…"
              className="bg-transparent text-[12px] text-zinc-200 placeholder:text-zinc-600 outline-none w-full"
            />
          </div>

          {/* Quick filter presets */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5 flex-wrap">
            {PRESETS.map((p, i) => (
              <button
                key={i}
                onClick={() => setPreset(i)}
                className={cn(
                  'px-2.5 py-1 font-semibold rounded transition-all',
                  preset === i ? 'bg-emerald-500/10 text-emerald-400' : 'text-zinc-500 hover:text-zinc-300',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          {rows.length > 0 && (
            <span className="text-[11px] text-zinc-500 ml-auto tabular-nums">{rows.length} stocks</span>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-950/10 p-4 text-center text-red-400 text-[12px]">
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center p-16 rounded-lg border border-zinc-900 bg-zinc-950">
            <RefreshCw className="h-6 w-6 text-emerald-500 animate-spin" />
            <span className="text-zinc-500 text-[12px] mt-3">
              Computing indicators for {universe === 'nifty50' ? 'Nifty 50' : universe === 'nifty500' ? 'Nifty 500' : 'all NSE'} stocks…
            </span>
            {universe === 'all' && (
              <span className="text-zinc-600 text-[11px] mt-1">This may take 10–20 seconds for the full universe</span>
            )}
          </div>
        )}

        {/* Legend */}
        {!loading && data && (
          <div className="flex flex-wrap items-center gap-3 px-1 text-[10px] text-zinc-600">
            <span className="font-semibold text-zinc-500 uppercase tracking-wide">Legend:</span>
            <span>🟢 Strong Bullish</span>
            <span>✅ Bullish</span>
            <span>⚠️ Neutral</span>
            <span>❌ Bearish</span>
            <span>🔴 Strong Bearish</span>
            <span className="ml-auto text-zinc-700">Data: {data.dataDate}</span>
          </div>
        )}

        {/* Table */}
        {!loading && rows.length > 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-center">
                <thead>
                  <tr>
                    <TH right className="sticky left-0 z-10 bg-zinc-800 text-left" sortKey="symbol" {...thProps}>#  Symbol</TH>
                    <TH className="hidden lg:table-cell" sortKey="sector" {...thProps}>Sector</TH>
                    <TH right sortKey="latestClose" {...thProps}>Close</TH>
                    <TH right sortKey="priceChange1D" {...thProps}>1D%</TH>
                    <TH right sortKey="priceChange1W" {...thProps}>1W%</TH>
                    <TH right sortKey="priceChange1M" {...thProps}>1M%</TH>
                    {/* EMA */}
                    <TH sortKey="aboveEma20" {...thProps}>E20</TH>
                    <TH sortKey="aboveEma50" {...thProps}>E50</TH>
                    <TH sortKey="aboveEma200" {...thProps}>E200</TH>
                    {/* Momentum */}
                    <TH sortKey="supertrendBullish" {...thProps}>ST</TH>
                    <TH sortKey="rsi14" {...thProps}>RSI</TH>
                    <TH sortKey="macdBullish" {...thProps}>MACD</TH>
                    <TH sortKey="adx14" {...thProps}>ADX</TH>
                    {/* Volatility */}
                    <TH sortKey="bbExpanding" {...thProps}>BB</TH>
                    <TH sortKey="atrExpanding" {...thProps}>ATR</TH>
                    {/* Volume */}
                    <TH sortKey="volumeRatio" {...thProps}>Vol</TH>
                    {/* RS */}
                    <TH sortKey="rsScore" {...thProps}>RS</TH>
                    <TH sortKey="rsScore" {...thProps}>RS%</TH>
                    {/* NR */}
                    <TH sortKey="isNR7" {...thProps}>NR</TH>
                    {/* Score */}
                    <TH right sortKey="scorePercent" {...thProps}>Score</TH>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr
                      key={r.symbol}
                      className="border-b border-zinc-900/60 hover:bg-zinc-800/20 transition-colors"
                    >
                      <TD className="sticky left-0 bg-zinc-950 group-hover:bg-zinc-800/20 text-left">
                        <div className="flex items-center gap-1.5">
                          <span className="text-zinc-700 text-[10px] w-5 tabular-nums">{i + 1}</span>
                          <span className="font-mono font-semibold text-zinc-100">{r.symbol}</span>
                        </div>
                      </TD>
                      <TD className="hidden lg:table-cell text-zinc-500 max-w-[100px] truncate text-left">{r.sector}</TD>
                      <TD right className="text-zinc-300 tabular-nums">₹{r.latestClose.toFixed(2)}</TD>
                      <TD right><PctBadge v={r.priceChange1D} /></TD>
                      <TD right><PctBadge v={r.priceChange1W} /></TD>
                      <TD right><PctBadge v={r.priceChange1M} /></TD>
                      {/* EMA */}
                      <TD>{boolCell(r.aboveEma20)}</TD>
                      <TD>{boolCell(r.aboveEma50)}</TD>
                      <TD>{boolCell(r.aboveEma200, r.ema50AboveEma200)}</TD>
                      {/* Momentum */}
                      <TD>{boolCell(r.supertrendBullish)}</TD>
                      <TD>
                        {rsiCell(r.rsi14)}
                        <span className="ml-1 text-[10px] text-zinc-600 tabular-nums">{r.rsi14.toFixed(0)}</span>
                      </TD>
                      <TD>{macdCell(r)}</TD>
                      <TD>
                        {adxCell(r.adx14)}
                        <span className="ml-1 text-[10px] text-zinc-600 tabular-nums">{r.adx14.toFixed(0)}</span>
                      </TD>
                      {/* Volatility */}
                      <TD>{boolCell(r.bbExpanding)}</TD>
                      <TD>{boolCell(r.atrExpanding)}</TD>
                      {/* Volume */}
                      <TD>
                        {volCell(r.volumeRatio)}
                        <span className="ml-1 text-[10px] text-zinc-600 tabular-nums">{r.volumeRatio.toFixed(1)}×</span>
                      </TD>
                      {/* RS */}
                      <TD>{rsCell(r)}</TD>
                      <TD>
                        <span className={cn(
                          'inline-flex items-center px-1.5 py-px rounded text-[10px] font-bold tabular-nums',
                          r.rsScore >= 80 ? 'bg-emerald-500/15 text-emerald-400' :
                          r.rsScore >= 60 ? 'bg-lime-500/15 text-lime-400' :
                          r.rsScore >= 40 ? 'bg-zinc-700 text-zinc-400' :
                          'bg-red-500/10 text-red-400',
                        )}>
                          {r.rsScore}
                        </span>
                      </TD>
                      {/* NR */}
                      <TD>
                        {r.isNR4 && <span className="text-[10px] font-bold text-cyan-400">NR4</span>}
                        {r.isNR7 && <span className="text-[10px] font-bold text-sky-400 ml-0.5">NR7</span>}
                        {!r.isNR4 && !r.isNR7 && <span className="text-zinc-700">—</span>}
                      </TD>
                      {/* Score */}
                      <TD right><ScoreBar score={r.score} /></TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!loading && rows.length === 0 && !error && data && (
          <div className="flex flex-col items-center justify-center p-12 rounded-lg border border-zinc-900 bg-zinc-950">
            <TrendingUp className="h-8 w-8 text-zinc-700 mb-3" />
            <p className="text-zinc-500 text-[13px]">No stocks match the current filter</p>
          </div>
        )}

      </main>
    </div>
  );
}
