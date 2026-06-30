'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Activity, TrendingUp, TrendingDown, RefreshCw, Play, Square,
  ChevronUp, ChevronDown, Search, Wifi, WifiOff, AlertTriangle,
} from 'lucide-react';
import { MoverResult } from '@/app/api/movers/route';
import { cn } from '@/lib/utils';
import NavBar from './NavBar';
import LiveNormalizedTab from './LiveNormalizedTab';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LiveQuote {
  ltp: number;
  open: number;
  high: number;
  low: number;
  prev_close: number;
  volume: number;
  change: number;
  change_pct: number;
}

interface BridgeStatus {
  status: 'STARTING' | 'RUNNING' | 'STOPPED' | 'ERROR';
  pid?: number;
  subscribed?: number;
  started_at?: string;
  last_update?: string;
}

interface LiveQuotesResponse {
  updated_at: string | null;
  count: number;
  quotes: Record<string, LiveQuote>;
}

interface LiveRow extends MoverResult {
  liveQuote: LiveQuote | null;
  ltp: number;
  changePct: number;
  changeAbs: number;
  liveOpen: number;
  liveHigh: number;
  liveLow: number;
  liveVolume: number;
  liveVolumeRatio: number;
}

type SortKey =
  | 'symbol' | 'ltp' | 'changePct' | 'liveOpen' | 'liveHigh' | 'liveLow'
  | 'liveVolumeRatio' | 'rsi14' | 'pctFrom52WHigh' | 'pctFrom52WLow';

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmt(n: number, d = 2) { return n.toFixed(d); }
function fmtVol(n: number) {
  if (n >= 1e7) return `${(n / 1e7).toFixed(1)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
}

// ─── Micro-components ─────────────────────────────────────────────────────────

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

function MADots({ r }: { r: LiveRow }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span title="MA20" className={cn('w-1.5 h-1.5 rounded-full', r.aboveMa20 ? 'bg-emerald-400' : 'bg-red-500')} />
      <span title="MA50" className={cn('w-1.5 h-1.5 rounded-full', r.aboveMa50 ? 'bg-emerald-400' : 'bg-red-500')} />
      <span title="MA200" className={cn('w-1.5 h-1.5 rounded-full', r.aboveMa200 ? 'bg-emerald-400' : 'bg-red-500')} />
    </span>
  );
}

function VolBadge({ ratio }: { ratio: number }) {
  if (!ratio) return <span className="text-zinc-600 tabular-nums text-[11px]">—</span>;
  return (
    <span className={cn(
      'inline-flex items-center px-1.5 py-px rounded text-[11px] font-bold tabular-nums',
      ratio >= 2 ? 'bg-violet-500/20 text-violet-300' : ratio >= 1.5 ? 'bg-blue-500/15 text-blue-400' : 'bg-zinc-800 text-zinc-400',
    )}>
      {fmt(ratio, 1)}×
    </span>
  );
}

function LiveDot({ active }: { active: boolean }) {
  return (
    <span className="relative inline-flex h-2 w-2">
      {active && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />}
      <span className={cn('relative inline-flex rounded-full h-2 w-2', active ? 'bg-emerald-500' : 'bg-zinc-600')} />
    </span>
  );
}

// ─── Table header ──────────────────────────────────────────────────────────────

function TH({
  children, sortKey, currentSort, dir, onSort, right, className,
}: {
  children: React.ReactNode;
  sortKey?: SortKey;
  currentSort: SortKey;
  dir: 'asc' | 'desc';
  onSort: (k: SortKey) => void;
  right?: boolean;
  className?: string;
}) {
  const active = sortKey === currentSort;
  return (
    <th
      className={cn(
        'py-2 px-2 text-[10px] font-medium text-zinc-500 uppercase tracking-wide whitespace-nowrap',
        right ? 'text-right' : 'text-left',
        sortKey ? 'cursor-pointer select-none hover:text-zinc-300 transition-colors' : '',
        active ? 'text-violet-400' : '',
        className,
      )}
      onClick={() => sortKey && onSort(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sortKey && active && (
          dir === 'desc'
            ? <ChevronDown className="h-3 w-3 text-violet-400" />
            : <ChevronUp className="h-3 w-3 text-violet-400" />
        )}
      </span>
    </th>
  );
}

// ─── Summary strip ─────────────────────────────────────────────────────────────

function SummaryStrip({ rows }: { rows: LiveRow[] }) {
  const live = rows.filter((r) => r.liveQuote);
  const advances = live.filter((r) => r.changePct > 0).length;
  const declines = live.filter((r) => r.changePct < 0).length;
  const unchanged = live.length - advances - declines;
  const avgChg = live.length > 0
    ? live.reduce((s, r) => s + r.changePct, 0) / live.length
    : 0;

  const topGainer = [...live].sort((a, b) => b.changePct - a.changePct)[0];
  const topLoser  = [...live].sort((a, b) => a.changePct - b.changePct)[0];

  return (
    <div className="flex flex-wrap gap-px bg-zinc-800/40 rounded-lg overflow-hidden border border-zinc-800">
      {[
        { label: 'Advances', value: advances, color: 'text-emerald-400' },
        { label: 'Declines', value: declines, color: 'text-red-400' },
        { label: 'Unchanged', value: unchanged, color: 'text-zinc-500' },
        { label: 'Avg Chg', value: `${avgChg >= 0 ? '+' : ''}${fmt(avgChg)}%`, color: avgChg >= 0 ? 'text-emerald-400' : 'text-red-400' },
        ...(topGainer ? [{ label: 'Top Gainer', value: `${topGainer.symbol} +${fmt(topGainer.changePct)}%`, color: 'text-emerald-400' }] : []),
        ...(topLoser ? [{ label: 'Top Loser', value: `${topLoser.symbol} ${fmt(topLoser.changePct)}%`, color: 'text-red-400' }] : []),
      ].map((s, i) => (
        <div key={i} className="flex flex-col items-center justify-center px-3 py-2 bg-zinc-950 flex-1 min-w-[80px]">
          <span className={cn('text-[13px] font-bold tabular-nums leading-tight', s.color)}>{s.value}</span>
          <span className="text-[9px] text-zinc-600 uppercase tracking-wide mt-0.5 whitespace-nowrap">{s.label}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export default function LiveDashboard() {
  const [baseline, setBaseline]           = useState<MoverResult[]>([]);
  const [liveQuotes, setLiveQuotes]       = useState<LiveQuotesResponse | null>(null);
  const [bridgeStatus, setBridgeStatus]   = useState<BridgeStatus>({ status: 'STOPPED' });
  const [baselineLoading, setBaselineLoading] = useState(true);
  const [sortKey, setSortKey]             = useState<SortKey>('changePct');
  const [sortDir, setSortDir]             = useState<'asc' | 'desc'>('desc');
  const [search, setSearch]               = useState('');
  const [indexType]                       = useState<'nifty50'>('nifty50');
  const [lastTick, setLastTick]           = useState<Date | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'market' | 'normalized'>('market');
  const [flashMap, setFlashMap]           = useState<Record<string, 'up' | 'down'>>({});
  const prevLtpRef                        = useRef<Record<string, number>>({});
  const pollRef                           = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load CSV baseline once ──────────────────────────────────────────────
  useEffect(() => {
    setBaselineLoading(true);
    fetch(`/api/movers?index=${indexType}`)
      .then((r) => r.json())
      .then((j) => { if (j.success) setBaseline(j.data.allMovers ?? []); })
      .catch(() => {})
      .finally(() => setBaselineLoading(false));
  }, [indexType]);

  // ── Poll live quotes + bridge status ───────────────────────────────────
  const pollLive = useCallback(async () => {
    try {
      const res  = await fetch('/api/live-equity');
      const json = await res.json();
      if (!json.success) return;

      setBridgeStatus(json.status);
      const qr: LiveQuotesResponse = json.quotes;
      setLiveQuotes(qr);
      if (qr.count > 0) setLastTick(new Date());

      // Compute flash map for changed LTPs
      const newFlash: Record<string, 'up' | 'down'> = {};
      for (const [sym, q] of Object.entries(qr.quotes)) {
        const prev = prevLtpRef.current[sym];
        if (prev !== undefined && q.ltp !== prev) {
          newFlash[sym] = q.ltp > prev ? 'up' : 'down';
        }
        prevLtpRef.current[sym] = q.ltp;
      }
      if (Object.keys(newFlash).length > 0) {
        setFlashMap(newFlash);
        setTimeout(() => setFlashMap({}), 600);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    pollLive();
    pollRef.current = setInterval(pollLive, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pollLive]);

  // ── Bridge start / stop ────────────────────────────────────────────────
  const sendAction = useCallback(async (action: 'start' | 'stop') => {
    setActionLoading(true);
    try {
      await fetch('/api/live-equity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      // Give bridge a moment then re-poll
      setTimeout(pollLive, 1000);
    } catch { /* ignore */ }
    finally { setActionLoading(false); }
  }, [pollLive]);

  // ── Merge baseline + live ─────────────────────────────────────────────
  const rows: LiveRow[] = baseline.map((b): LiveRow => {
    const q = liveQuotes?.quotes[b.symbol] ?? null;
    return {
      ...b,
      liveQuote:       q,
      ltp:             q ? q.ltp : b.latestClose,
      changePct:       q ? q.change_pct : b.priceChange1D,
      changeAbs:       q ? q.change : 0,
      liveOpen:        q ? q.open : 0,
      liveHigh:        q ? q.high : 0,
      liveLow:         q ? q.low : 0,
      liveVolume:      q ? q.volume : b.latestVolume,
      liveVolumeRatio: q && b.avgVolume20D > 0 ? q.volume / b.avgVolume20D : b.volumeRatio,
    };
  });

  // ── Filter + Sort ──────────────────────────────────────────────────────
  const filtered = rows.filter((r) =>
    !search || r.symbol.toLowerCase().includes(search.toLowerCase()) || r.sector?.toLowerCase().includes(search.toLowerCase()),
  );

  const sorted = [...filtered].sort((a, b) => {
    const va = a[sortKey] as number | string;
    const vb = b[sortKey] as number | string;
    if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb as string) : (vb as string).localeCompare(va);
    return sortDir === 'asc' ? (va as number) - (vb as number) : (vb as number) - (va as number);
  });

  const handleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir('desc'); }
  };

  const isLive    = bridgeStatus.status === 'RUNNING';
  const isStarting = bridgeStatus.status === 'STARTING';
  const staleQuotes = lastTick && (Date.now() - lastTick.getTime() > 15_000);

  // ─── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-100">

      {/* ── Header ── */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/90 backdrop-blur-md px-4 py-2 flex flex-wrap items-center gap-2.5 z-20 sticky top-0">

        <div className="flex items-center gap-2 mr-1">
          <div className="h-6 w-6 rounded-md bg-gradient-to-tr from-emerald-600 to-cyan-500 flex items-center justify-center shrink-0">
            <Activity className="h-3.5 w-3.5 text-white" />
          </div>
          <span className="text-[14px] font-bold tracking-tight text-white">Live Market</span>
        </div>

        <div className="w-px h-5 bg-zinc-800 hidden sm:block" />

        {/* Tab switcher */}
        <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 gap-0.5">
          {(['market', 'normalized'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                'px-3 py-1 rounded-md text-[11px] font-semibold transition-all capitalize',
                activeTab === tab
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300',
              )}
            >
              {tab === 'market' ? 'Market' : 'Normalized'}
            </button>
          ))}
        </div>

        {/* Nav */}
        <NavBar />

        {/* Bridge status — only on Market tab */}
        {activeTab === 'market' && (
          <div className="flex items-center gap-1.5 ml-1">
            <LiveDot active={isLive} />
            <span className={cn(
              'text-[11px] font-medium',
              isLive ? 'text-emerald-400' : isStarting ? 'text-amber-400' : 'text-zinc-500',
            )}>
              {isLive
                ? `Live · ${bridgeStatus.subscribed ?? 0} symbols`
                : isStarting ? 'Connecting…'
                : 'Offline'}
            </span>
          </div>
        )}

        {/* Start/Stop — only on Market tab */}
        {activeTab === 'market' && (
          <button
            onClick={() => sendAction(isLive || isStarting ? 'stop' : 'start')}
            disabled={actionLoading}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition-all disabled:opacity-50',
              isLive || isStarting
                ? 'border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20'
                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20',
            )}
          >
            {actionLoading
              ? <RefreshCw className="h-3 w-3 animate-spin" />
              : isLive || isStarting
                ? <Square className="h-3 w-3" />
                : <Play className="h-3 w-3" />}
            {isLive || isStarting ? 'Stop Feed' : 'Start Feed'}
          </button>
        )}

        {/* Search — only on Market tab */}
        {activeTab === 'market' && (
          <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1 ml-auto">
            <Search className="h-3 w-3 text-zinc-600 shrink-0" />
            <input
              type="text"
              placeholder="Symbol / sector…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-transparent text-[11px] text-zinc-300 placeholder-zinc-600 outline-none w-32"
            />
          </div>
        )}

        {/* Last tick — only on Market tab */}
        {activeTab === 'market' && lastTick && (
          <span className={cn('text-[10px] tabular-nums hidden md:block', staleQuotes ? 'text-amber-400' : 'text-zinc-600')}>
            {staleQuotes ? <AlertTriangle className="inline h-3 w-3 mr-0.5" /> : null}
            {lastTick.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
          </span>
        )}
      </header>

      {/* ── Content ── */}
      <main className="flex-1 w-full max-w-[1800px] mx-auto px-4 py-3 flex flex-col gap-3">

        {activeTab === 'normalized' ? (
          <LiveNormalizedTab />
        ) : (
        <>

        {/* No-feed banner */}
        {!isLive && !isStarting && (
          <div className="flex flex-wrap items-center gap-2.5 px-3 py-2.5 rounded-lg border border-zinc-700/50 bg-zinc-900/40 text-[12px]">
            <WifiOff className="h-4 w-4 text-zinc-500 shrink-0" />
            <span className="text-zinc-400">WebSocket feed is offline — prices shown are from the last available CSV data.</span>
            <button
              onClick={() => sendAction('start')}
              disabled={actionLoading}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 font-semibold transition-all disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" /> Start Live Feed
            </button>
          </div>
        )}

        {/* Starting banner */}
        {isStarting && (
          <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-amber-500/25 bg-amber-500/5 text-[12px] text-amber-300">
            <RefreshCw className="h-3.5 w-3.5 animate-spin shrink-0" />
            Connecting to WebSocket — first ticks usually arrive within 5–10 seconds…
          </div>
        )}

        {/* Summary strip */}
        {!baselineLoading && <SummaryStrip rows={rows} />}

        {/* Loading baseline */}
        {baselineLoading && (
          <div className="flex flex-col items-center justify-center p-16 rounded-lg border border-zinc-900 bg-zinc-950">
            <RefreshCw className="h-6 w-6 text-violet-500 animate-spin" />
            <span className="text-zinc-500 text-[12px] mt-3">Loading baseline data…</span>
          </div>
        )}

        {/* Live table */}
        {!baselineLoading && sorted.length > 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-900/50">
                    <TH sortKey="symbol" currentSort={sortKey} dir={sortDir} onSort={handleSort}>#  Symbol</TH>
                    <TH className="hidden sm:table-cell" currentSort={sortKey} dir={sortDir} onSort={handleSort}>Sector</TH>
                    <TH sortKey="ltp" right currentSort={sortKey} dir={sortDir} onSort={handleSort}>LTP</TH>
                    <TH sortKey="changePct" right currentSort={sortKey} dir={sortDir} onSort={handleSort}>Chg %</TH>
                    <TH sortKey="liveOpen" right currentSort={sortKey} dir={sortDir} onSort={handleSort} className="hidden lg:table-cell">Open</TH>
                    <TH sortKey="liveHigh" right currentSort={sortKey} dir={sortDir} onSort={handleSort} className="hidden lg:table-cell">High</TH>
                    <TH sortKey="liveLow" right currentSort={sortKey} dir={sortDir} onSort={handleSort} className="hidden lg:table-cell">Low</TH>
                    <TH sortKey="liveVolumeRatio" right currentSort={sortKey} dir={sortDir} onSort={handleSort} className="hidden md:table-cell">Vol ×</TH>
                    <TH sortKey="rsi14" right currentSort={sortKey} dir={sortDir} onSort={handleSort} className="hidden xl:table-cell">RSI</TH>
                    <TH sortKey="pctFrom52WHigh" right currentSort={sortKey} dir={sortDir} onSort={handleSort} className="hidden xl:table-cell">52W H%</TH>
                    <TH className="hidden 2xl:table-cell" currentSort={sortKey} dir={sortDir} onSort={handleSort}>MA</TH>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r, i) => {
                    const flash = flashMap[r.symbol];
                    const hasLive = !!r.liveQuote;
                    return (
                      <tr
                        key={r.symbol}
                        className={cn(
                          'border-b border-zinc-900/60 transition-colors duration-300',
                          flash === 'up'   ? 'bg-emerald-500/10' :
                          flash === 'down' ? 'bg-red-500/10' :
                          'hover:bg-zinc-800/20',
                        )}
                      >
                        {/* # + Symbol */}
                        <td className="py-[5px] px-2 whitespace-nowrap">
                          <span className="text-zinc-600 text-[10px] w-5 inline-block">{i + 1}</span>
                          <span className={cn('font-mono font-semibold', hasLive ? 'text-zinc-100' : 'text-zinc-400')}>
                            {r.symbol}
                          </span>
                          {hasLive && <span className="ml-1.5 inline-block w-1 h-1 rounded-full bg-emerald-500" />}
                        </td>

                        {/* Sector */}
                        <td className="py-[5px] px-2 text-zinc-500 max-w-[120px] truncate text-[11px] hidden sm:table-cell">
                          {r.sector || '—'}
                        </td>

                        {/* LTP */}
                        <td className={cn(
                          'py-[5px] px-2 text-right font-mono font-semibold tabular-nums',
                          flash === 'up' ? 'text-emerald-300' : flash === 'down' ? 'text-red-300' : 'text-zinc-200',
                        )}>
                          ₹{fmt(r.ltp)}
                        </td>

                        {/* Change % */}
                        <td className="py-[5px] px-2 text-right">
                          <PctPill v={r.changePct} />
                        </td>

                        {/* Open */}
                        <td className="py-[5px] px-2 text-right text-zinc-400 tabular-nums hidden lg:table-cell">
                          {r.liveOpen > 0 ? `₹${fmt(r.liveOpen)}` : '—'}
                        </td>

                        {/* High */}
                        <td className="py-[5px] px-2 text-right tabular-nums text-emerald-500/70 hidden lg:table-cell">
                          {r.liveHigh > 0 ? `₹${fmt(r.liveHigh)}` : '—'}
                        </td>

                        {/* Low */}
                        <td className="py-[5px] px-2 text-right tabular-nums text-red-500/70 hidden lg:table-cell">
                          {r.liveLow > 0 ? `₹${fmt(r.liveLow)}` : '—'}
                        </td>

                        {/* Volume ratio */}
                        <td className="py-[5px] px-2 text-right hidden md:table-cell">
                          <div className="flex flex-col items-end gap-0.5">
                            <VolBadge ratio={r.liveVolumeRatio} />
                            <span className="text-[10px] text-zinc-600 tabular-nums">{fmtVol(r.liveVolume)}</span>
                          </div>
                        </td>

                        {/* RSI */}
                        <td className="py-[5px] px-2 text-right hidden xl:table-cell">
                          <RSIBadge rsi={r.rsi14} />
                        </td>

                        {/* % from 52W High */}
                        <td className={cn(
                          'py-[5px] px-2 text-right tabular-nums text-[11px] font-semibold hidden xl:table-cell',
                          r.pctFrom52WHigh >= -2 ? 'text-amber-400' : 'text-zinc-500',
                        )}>
                          {r.pctFrom52WHigh >= 0 ? '▲ ATH' : `${fmt(r.pctFrom52WHigh)}%`}
                        </td>

                        {/* MA dots */}
                        <td className="py-[5px] px-2 text-right hidden 2xl:table-cell">
                          <MADots r={r} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Footer */}
            <div className="px-3 py-2 border-t border-zinc-800/60 flex items-center justify-between">
              <span className="text-[10px] text-zinc-600">
                {sorted.length} of {rows.length} stocks
                {search ? ` · filtered by "${search}"` : ''}
              </span>
              <span className="text-[10px] text-zinc-700">
                MA dots: 20D · 50D · 200D &nbsp;|&nbsp;
                {isLive ? 'WebSocket live' : 'CSV data'}
              </span>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!baselineLoading && sorted.length === 0 && (
          <div className="flex flex-col items-center justify-center p-16 rounded-lg border border-zinc-900 bg-zinc-950">
            <Search className="h-6 w-6 text-zinc-700" />
            <span className="text-zinc-500 text-[12px] mt-3">No symbols match &ldquo;{search}&rdquo;</span>
          </div>
        )}

        {/* Gainers / Losers mini strip (always visible when live) */}
        {isLive && rows.some((r) => r.liveQuote) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 mt-1">
            <MiniLeader rows={rows} title="Top Gainers" type="gain" />
            <MiniLeader rows={rows} title="Top Losers"  type="loss" />
          </div>
        )}

        </>
        )}
      </main>
    </div>
  );
}

// ─── Mini leader-board ────────────────────────────────────────────────────────

function MiniLeader({ rows, title, type }: { rows: LiveRow[]; title: string; type: 'gain' | 'loss' }) {
  const sorted = rows
    .filter((r) => r.liveQuote)
    .sort((a, b) => type === 'gain' ? b.changePct - a.changePct : a.changePct - b.changePct)
    .slice(0, 5);

  const Icon = type === 'gain' ? TrendingUp : TrendingDown;
  const color = type === 'gain' ? 'text-emerald-400' : 'text-red-400';

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/70">
        <Icon className={cn('h-3.5 w-3.5', color)} />
        <span className="text-[12px] font-semibold text-zinc-200">{title}</span>
      </div>
      <table className="w-full border-collapse">
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.symbol} className="border-b border-zinc-900/50 hover:bg-zinc-800/20 transition-colors">
              <td className="px-3 py-1.5 text-zinc-600 text-[10px] w-5">{i + 1}</td>
              <td className="px-2 py-1.5 font-mono font-semibold text-[12px] text-zinc-100">{r.symbol}</td>
              <td className="px-2 py-1.5 text-[11px] text-zinc-500 max-w-[80px] truncate hidden sm:table-cell">{r.sector || '—'}</td>
              <td className="px-2 py-1.5 text-right font-mono text-[12px] text-zinc-300 tabular-nums">₹{r.ltp.toFixed(2)}</td>
              <td className="px-3 py-1.5 text-right"><PctPill v={r.changePct} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
