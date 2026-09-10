'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { AlertTriangle, Layers, RefreshCw, SlidersHorizontal, TrendingDown, TrendingUp } from 'lucide-react';
import NavBar from './NavBar';
import { cn } from '@/lib/utils';
import type { PersistenceResult, MoversPlusResponse } from '@/app/api/movers-plus/route';

// Restyled to the dhan-bloomberg-dashboard-page formula: amber is this page's
// chrome accent (panel titles, header hairlines, selected-filter state);
// emerald/red stay reserved for the winner/loser direction the page tracks.

interface Settings { index: 'nifty50' | 'nifty500' | 'indices'; sessions: number; minAppearances: number; }
const DEFAULT: Settings = { index: 'nifty50', sessions: 10, minAppearances: 2 };

// ─── Terminal Panel (dhan-bloomberg-dashboard-page formula) ─────────────────
function TerminalPanel({
  title, icon: Icon, accent = 'text-amber-400', meta, children, className = '',
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  accent?: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/70 shadow-sm overflow-hidden', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-amber-500/25 bg-zinc-950/60 px-3 py-2 shrink-0">
        <span className={cn('flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em]', accent)}>
          <Icon className="h-3.5 w-3.5" />
          {title}
        </span>
        {meta ? <span className="font-mono text-[10px] text-zinc-500">{meta}</span> : null}
      </header>
      <div className="flex-1 min-h-0">{children}</div>
    </section>
  );
}

// ─── Day Squares ──────────────────────────────────────────────────────────────
// A calendar-style up/down heatmap — solid emerald/red squares are the
// CLAUDE.md "saturated data colour" exception (a literal per-day outcome,
// not chrome), so they stay unconditional rather than tokenized text steps.
function DaySquares({ days }: { days: PersistenceResult['days'] }) {
  return (
    <div className="flex gap-[2px] flex-wrap">
      {days.map((d, i) => (
        <div
          key={i}
          title={`${d.date}: ${d.pctChange > 0 ? '+' : ''}${d.pctChange.toFixed(2)}%`}
          className={cn('w-3.5 h-3.5 rounded-sm flex-shrink-0',
            d.pctChange === 0 ? 'bg-zinc-600' : d.isUp ? 'bg-emerald-500' : 'bg-red-500')}
        />
      ))}
    </div>
  );
}

// ─── Stock Row ────────────────────────────────────────────────────────────────
function StockRow({ result, type, isIndexMode }: { result: PersistenceResult; type: 'winner' | 'loser'; isIndexMode: boolean }) {
  const count = type === 'winner' ? result.upCount : result.downCount;
  const total = result.days.length;
  const cum = result.cumulative;
  const isPos = cum >= 0;
  return (
    <div className="flex items-center gap-3 py-[5px] px-3 border-b border-zinc-800/60 hover:bg-zinc-800/40 transition-colors">
      <div className="w-[88px] flex-shrink-0">
        <div className="text-[12px] font-bold text-zinc-100 font-mono">
          {isIndexMode ? result.sector : result.symbol}
        </div>
        {!isIndexMode && (
          <div className="text-[10px] text-zinc-400 truncate">{result.sector}</div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <DaySquares days={result.days} />
      </div>
      <div className="flex-shrink-0 w-12 text-right">
        <span className={cn('text-[11px] font-bold font-mono tabular-nums',
          type === 'winner' ? 'text-emerald-400' : 'text-red-400')}>
          {count}/{total}
        </span>
      </div>
      <div className="flex-shrink-0 w-20 text-right">
        <span className="text-[12px] font-bold font-mono tabular-nums text-zinc-200">
          ₹{result.latestClose.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      </div>
      <div className="flex-shrink-0 w-20 text-right">
        <span className={cn('text-[12px] font-bold font-mono tabular-nums', isPos ? 'text-emerald-400' : 'text-red-400')}>
          {isPos ? '+' : ''}{cum.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

// ─── Side Panel (Winners / Losers) ───────────────────────────────────────────
// A paired panel like MarketMovers' Gainers/Losers — the icon and title keep
// their directional color (winner=emerald, loser=red) inside the shared
// amber-hairline TerminalPanel shell, exactly as the skill's "paired panels
// get semantic icon colors" convention describes.
function SidePanel({ title, count, results, type, isIndexMode }: {
  title: string; count: number; results: PersistenceResult[];
  type: 'winner' | 'loser'; isIndexMode: boolean;
}) {
  const color = type === 'winner' ? 'text-emerald-400' : 'text-red-400';
  const Icon = type === 'winner' ? TrendingUp : TrendingDown;
  return (
    <TerminalPanel title={title} icon={Icon} accent={color} meta={count} className="flex-1 min-w-0">
      {/* Column headers */}
      <div className="flex items-center gap-3 px-3 py-1.5 bg-zinc-800 border-b border-zinc-700/50">
        <div className="w-[88px] flex-shrink-0 text-xs font-bold text-white uppercase tracking-wide">
          {isIndexMode ? 'Index' : 'Symbol'}
        </div>
        <div className="flex-1 text-xs font-bold text-white uppercase tracking-wide">Sessions</div>
        <div className="w-12 text-right text-xs font-bold text-white uppercase tracking-wide">Count</div>
        <div className="w-20 text-right text-xs font-bold text-white uppercase tracking-wide">LTP</div>
        <div title="Compounded return across the selected session window" className="w-20 text-right text-xs font-bold text-white uppercase tracking-wide">Return %</div>
      </div>
      <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 260px)' }}>
        {results.length === 0
          ? <div className="text-zinc-600 text-[11px] font-mono px-3 py-6 text-center">No results</div>
          : results.map(r => <StockRow key={r.symbol} result={r} type={type} isIndexMode={isIndexMode} />)}
      </div>
    </TerminalPanel>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function MoversPlusDashboard() {
  const [settings, setSettings] = useState<Settings>(DEFAULT);
  const [data, setData] = useState<MoversPlusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingSessions, setPendingSessions] = useState(DEFAULT.sessions);
  const [pendingMin, setPendingMin] = useState(DEFAULT.minAppearances);
  const requestId = useRef(0);

  const fetchData = useCallback(async (s: Settings, bust = false) => {
    const id = ++requestId.current;
    setLoading(true); setError(null);
    try {
      const bust_param = bust ? '&bust' : '';
      const res = await fetch(`/api/movers-plus?index=${s.index}&sessions=${s.sessions}&min=${s.minAppearances}${bust_param}`);
      if (!res.ok) throw new Error(await res.text());
      const nextData = await res.json();
      if (id === requestId.current) setData(nextData);
    } catch (e) {
      if (id === requestId.current) setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(settings); }, [settings, fetchData]);

  function applySettings() {
    const sessions = Math.min(60, Math.max(3, pendingSessions));
    const minAppearances = Math.min(sessions, Math.max(1, pendingMin));
    setPendingSessions(sessions);
    setPendingMin(minAppearances);
    setSettings({ ...settings, sessions, minAppearances });
  }

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      {/* ─── Sticky Header ───────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/25 shrink-0">
            <Layers className="w-4 h-4 text-amber-400" />
          </div>
          <div>
            <p className="text-[9px] font-bold text-amber-400 uppercase tracking-[0.18em] mb-0.5">
              Analytics · Persistence Tracker
            </p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">
              Movers+ Persistence Tracker
            </h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              Positive / negative price-return sessions over a configurable window
            </p>
          </div>
        </div>

        <NavBar />

        <span className="ml-auto text-[10px] font-mono font-bold text-amber-300 px-2.5 py-1 rounded-md bg-zinc-900 border border-zinc-800 uppercase tracking-wide">
          DATA: {data?.dataDate ?? '—'}
        </span>
      </header>

      {/* ─── Main Content ─────────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col gap-4 px-6 py-5">
        {/* Settings Panel */}
        <TerminalPanel title="Screen Settings" icon={SlidersHorizontal}>
          <div className="flex flex-wrap items-end gap-5 px-4 py-3">
            {/* Index */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest">Index</span>
              <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg text-xs p-0.5 gap-0.5">
                {([{ value: 'nifty50', label: 'N50' }, { value: 'nifty500', label: 'N500' }, { value: 'indices', label: 'IDX' }] as const).map(({ value, label }) => (
                  <button key={value} onClick={() => setSettings(s => ({ ...s, index: value }))}
                    className={cn('px-2.5 py-1 font-bold rounded-md transition-colors font-mono',
                      settings.index === value
                        ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                        : 'text-zinc-500 hover:text-zinc-300 border border-transparent')}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Sessions */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest">
                Sessions — <span className="text-amber-400 font-mono">{pendingSessions}D</span>
              </span>
              <div className="flex items-center gap-2">
                <input type="range" min={3} max={60} value={pendingSessions}
                  onChange={e => {
                    const sessions = Number(e.target.value);
                    setPendingSessions(sessions);
                    setPendingMin(min => Math.min(min, sessions));
                  }}
                  className="w-28 accent-amber-500 h-1" />
                <span className="text-[11px] font-bold font-mono text-zinc-300 w-5">{pendingSessions}</span>
              </div>
            </div>

            {/* Min appearances */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest">
                Min appearances — <span className="text-amber-400 font-mono">{pendingMin}</span>
              </span>
              <div className="flex items-center gap-2">
                <input type="range" min={1} max={pendingSessions} value={pendingMin}
                  onChange={e => setPendingMin(Number(e.target.value))}
                  className="w-28 accent-amber-500 h-1" />
                <span className="text-[11px] font-bold font-mono text-zinc-300 w-4">{pendingMin}</span>
              </div>
            </div>

            <div className="flex gap-2 ml-auto">
              <button onClick={applySettings} disabled={loading}
                className="px-3 py-1 text-[11px] font-bold font-mono uppercase tracking-wide rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400 hover:bg-amber-500/25 transition-colors disabled:opacity-50">
                Apply
              </button>
              <button onClick={() => fetchData(settings, true)} disabled={loading}
                className="h-7 w-7 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-amber-400 hover:border-amber-500/40 transition-colors disabled:opacity-50"
                title="Force refresh data">
                <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin text-amber-400')} />
              </button>
            </div>
          </div>
        </TerminalPanel>

        {/* Error */}
        {error && (
          <div className="p-4 rounded-xl border border-red-500/30 bg-red-950/20 text-red-400 text-xs font-mono">
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-16 rounded-xl border border-zinc-800 bg-zinc-900/70">
            <RefreshCw className="h-4 w-4 text-amber-400 animate-spin mr-2" />
            <span className="text-zinc-500 text-xs font-mono uppercase tracking-widest">Computing persistence…</span>
          </div>
        )}

        {/* Content */}
        {!loading && data && (
          <>
            {data.staleCount > 0 && (
              <div className="flex items-center gap-2.5 px-4 py-2 rounded-xl border border-amber-500/30 bg-amber-500/10 text-xs font-mono">
                <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
                <span className="text-amber-300">
                  {data.staleCount} {settings.index === 'indices' ? 'index(es)' : 'stock(s)'} excluded — data behind consensus date ({data.dataDate}). Run a refresh to include them.
                </span>
              </div>
            )}
            <div className="flex flex-col lg:flex-row gap-4 flex-1">
              <SidePanel title="Persistent Winners" count={data.winners.length} results={data.winners} type="winner" isIndexMode={settings.index === 'indices'} />
              <SidePanel title="Persistent Losers" count={data.losers.length} results={data.losers} type="loser" isIndexMode={settings.index === 'indices'} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
