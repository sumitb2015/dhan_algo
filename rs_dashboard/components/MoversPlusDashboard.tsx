'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, TrendingUp, TrendingDown } from 'lucide-react';
import NavBar from './NavBar';
import { cn } from '@/lib/utils';
import type { PersistenceResult, MoversPlusResponse } from '@/app/api/movers-plus/route';

interface Settings { index: 'nifty50' | 'nifty500' | 'indices'; sessions: number; minAppearances: number; }
const DEFAULT: Settings = { index: 'nifty50', sessions: 10, minAppearances: 2 };

// ─── Day Squares ──────────────────────────────────────────────────────────────
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
    <div className="flex items-center gap-3 py-[5px] px-3 border-b border-zinc-900/80 hover:bg-amber-500/5 transition-colors">
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
      <div className="flex-shrink-0 w-16 text-right">
        <span className={cn('text-[12px] font-bold font-mono tabular-nums', isPos ? 'text-emerald-400' : 'text-red-400')}>
          {isPos ? '+' : ''}{cum.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────
function SidePanel({ title, count, results, type, isIndexMode }: {
  title: string; count: number; results: PersistenceResult[];
  type: 'winner' | 'loser'; isIndexMode: boolean;
}) {
  const color = type === 'winner' ? 'text-emerald-400' : 'text-red-400';
  const Icon = type === 'winner' ? TrendingUp : TrendingDown;
  return (
    <div className="flex-1 min-w-0 border border-amber-900/20 bg-[#050505] rounded-sm overflow-hidden flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border-b border-amber-900/20 shrink-0">
        <Icon className={cn('h-3 w-3', color)} />
        <span className={cn('text-[10px] font-bold uppercase tracking-widest', color)}>{title}</span>
        <span className="text-[10px] text-zinc-500 font-mono ml-auto">{count}</span>
      </div>
      {/* Column headers */}
      <div className="flex items-center gap-3 px-3 py-1 bg-zinc-800 border-b border-zinc-700/50">
        <div className="w-[88px] flex-shrink-0 text-[10px] font-bold text-white uppercase tracking-wide">
          {isIndexMode ? 'Index' : 'Symbol'}
        </div>
        <div className="flex-1 text-[10px] font-bold text-white uppercase tracking-wide">Sessions</div>
        <div className="w-12 text-right text-[10px] font-bold text-white uppercase tracking-wide">Count</div>
        <div className="w-16 text-right text-[10px] font-bold text-white uppercase tracking-wide">Σ%</div>
      </div>
      <div className="overflow-y-auto flex-1" style={{ maxHeight: 'calc(100vh - 220px)' }}>
        {results.length === 0
          ? <div className="text-zinc-600 text-[11px] font-mono px-3 py-6 text-center">No results</div>
          : results.map(r => <StockRow key={r.symbol} result={r} type={type} isIndexMode={isIndexMode} />)}
      </div>
    </div>
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

  const fetchData = useCallback(async (s: Settings, bust = false) => {
    setLoading(true); setError(null);
    try {
      const bust_param = bust ? '&bust' : '';
      const res = await fetch(`/api/movers-plus?index=${s.index}&sessions=${s.sessions}&min=${s.minAppearances}${bust_param}`);
      if (!res.ok) throw new Error(await res.text());
      setData(await res.json());
    } catch (e) { setError(e instanceof Error ? e.message : 'Unknown error'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchData(settings); }, [settings, fetchData]);

  function applySettings() {
    setSettings({ ...settings, sessions: pendingSessions, minAppearances: pendingMin });
  }

  return (
    <div className="flex flex-col min-h-screen bg-black text-zinc-100">
      {/* Header */}
      <header className="w-full border-b border-amber-900/25 bg-[#050505] px-4 py-2 flex flex-wrap items-center gap-2.5 z-20 sticky top-0 backdrop-blur-md">
        <div className="flex items-center gap-2 mr-1">
          <div className="h-6 w-6 rounded-sm bg-emerald-500 flex items-center justify-center shrink-0">
            <span className="text-black text-[11px] font-bold font-mono">M+</span>
          </div>
          <span className="text-[13px] font-bold tracking-widest text-emerald-400 uppercase font-mono">MOVERS+</span>
        </div>
        <div className="w-px h-5 bg-zinc-800 hidden sm:block" />
        <NavBar />
        {data && (
          <span className="ml-auto text-[10px] font-mono font-bold text-zinc-400 px-2 py-0.5 rounded-sm bg-zinc-900 border border-zinc-800 uppercase tracking-wide">
            DATA: {data.dataDate}
          </span>
        )}
      </header>

      <main className="flex-1 px-3 py-2 flex flex-col gap-2 mx-auto w-full">
        {/* Description */}
        <p className="text-[10px] text-zinc-600 font-mono uppercase tracking-wider">
          Persistence tracker — profitable / loss sessions over a configurable window
        </p>

        {/* Settings bar */}
        <div className="border border-amber-900/20 bg-[#050505] rounded-sm overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border-b border-amber-900/20">
            <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400">Settings</span>
          </div>
          <div className="flex flex-wrap items-end gap-5 px-4 py-3">
            {/* Index */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest">Index</span>
              <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-sm text-[11px] p-0.5 gap-0.5">
                {([{ value: 'nifty50', label: 'N50' }, { value: 'nifty500', label: 'N500' }, { value: 'indices', label: 'IDX' }] as const).map(({ value, label }) => (
                  <button key={value} onClick={() => setSettings(s => ({ ...s, index: value }))}
                    className={cn('px-2.5 py-0.5 font-bold rounded-sm transition-all font-mono',
                      settings.index === value ? 'bg-amber-500/10 text-amber-400' : 'text-zinc-500 hover:text-zinc-300')}>
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
                  onChange={e => setPendingSessions(Number(e.target.value))}
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
                <input type="range" min={1} max={Math.max(1, pendingSessions - 2)} value={pendingMin}
                  onChange={e => setPendingMin(Number(e.target.value))}
                  className="w-28 accent-amber-500 h-1" />
                <span className="text-[11px] font-bold font-mono text-zinc-300 w-4">{pendingMin}</span>
              </div>
            </div>

            <div className="flex gap-2 ml-auto">
              <button onClick={applySettings} disabled={loading}
                className="px-3 py-1 text-[11px] font-bold font-mono uppercase tracking-wide rounded-sm bg-amber-500/10 border border-amber-500/30 text-amber-300 hover:bg-amber-500/20 transition-all disabled:opacity-50">
                Apply
              </button>
              <button onClick={() => fetchData(settings, true)} disabled={loading}
                className="h-6 w-6 flex items-center justify-center rounded-sm border border-zinc-800 bg-zinc-900 text-zinc-500 hover:text-amber-400 hover:border-amber-900/40 transition-all disabled:opacity-50">
                <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
              </button>
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-sm border border-red-500/20 bg-red-950/10 p-3 text-red-400 text-[12px] font-mono">
            ERR: {error}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-16 border border-amber-900/20 bg-[#050505] rounded-sm">
            <RefreshCw className="h-4 w-4 text-amber-500 animate-spin mr-2" />
            <span className="text-zinc-500 text-[11px] font-mono uppercase tracking-widest">Computing persistence…</span>
          </div>
        )}

        {/* Content */}
        {!loading && data && (
          <>
            {data.staleCount > 0 && (
              <div className="px-3 py-2 border border-amber-500/20 bg-amber-500/5 rounded-sm text-amber-400 text-[11px] font-mono">
                {data.staleCount} {settings.index === 'indices' ? 'index(es)' : 'stock(s)'} excluded — data behind consensus date ({data.dataDate}). Run a refresh to include them.
              </div>
            )}
            <div className="flex gap-2 flex-1">
              <SidePanel title="Persistent Winners" count={data.winners.length} results={data.winners} type="winner" isIndexMode={settings.index === 'indices'} />
              <SidePanel title="Persistent Losers" count={data.losers.length} results={data.losers} type="loser" isIndexMode={settings.index === 'indices'} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
