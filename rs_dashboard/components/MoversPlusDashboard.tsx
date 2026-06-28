'use client';
import { useState, useEffect, useCallback } from 'react';
import NavBar from './NavBar';
import type { PersistenceResult, MoversPlusResponse } from '@/app/api/movers-plus/route';

// ─── Settings ──────────────────────────────────────────────────────────────────
interface Settings {
  index: 'nifty50' | 'nifty500' | 'indices';
  sessions: number;
  minAppearances: number;
}

const DEFAULT_SETTINGS: Settings = {
  index: 'nifty50',
  sessions: 10,
  minAppearances: 2,
};

// ─── Day Squares ───────────────────────────────────────────────────────────────
function DaySquares({ days }: { days: PersistenceResult['days'] }) {
  return (
    <div className="flex gap-0.5 flex-wrap">
      {days.map((d, i) => {
        const isFlat = d.pctChange === 0;
        const color = isFlat
          ? 'bg-zinc-500'
          : d.isUp
          ? 'bg-emerald-500'
          : 'bg-red-500';
        return (
          <div
            key={i}
            title={`${d.date}: ${d.pctChange > 0 ? '+' : ''}${d.pctChange.toFixed(2)}%`}
            className={`w-4 h-4 rounded-sm flex-shrink-0 ${color}`}
          />
        );
      })}
    </div>
  );
}

// ─── Stock Row ─────────────────────────────────────────────────────────────────
function StockRow({
  result,
  type,
  isIndexMode,
}: {
  result: PersistenceResult;
  type: 'winner' | 'loser';
  isIndexMode: boolean;
}) {
  const count = type === 'winner' ? result.upCount : result.downCount;
  const total = result.days.length; // actual computed days, not just the requested sessions
  const cum = result.cumulative;
  const isPos = cum >= 0;

  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-zinc-800/60 transition-colors border border-transparent hover:border-zinc-700/50">
      {/* Symbol + sector/label */}
      <div className="w-24 flex-shrink-0">
        <div className="text-sm font-bold text-white">
          {isIndexMode ? result.sector : result.symbol}
        </div>
        {!isIndexMode && (
          <div className="text-[10px] text-zinc-400 truncate">{result.sector}</div>
        )}
      </div>

      {/* Day squares */}
      <div className="flex-1 min-w-0">
        <DaySquares days={result.days} />
      </div>

      {/* Count badge — numerator matches squares, denominator = actual days shown */}
      <div className="flex-shrink-0 w-14 text-right">
        <span
          className={`text-xs font-bold ${
            type === 'winner' ? 'text-emerald-400' : 'text-red-400'
          }`}
        >
          {count}/{total}
        </span>
      </div>

      {/* Cumulative */}
      <div className="flex-shrink-0 w-20 text-right">
        <span
          className={`text-sm font-bold ${isPos ? 'text-emerald-400' : 'text-red-400'}`}
        >
          {isPos ? '+' : ''}
          {cum.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────────
function Panel({
  title,
  count,
  results,
  type,
  accent,
  isIndexMode,
}: {
  title: string;
  count: number;
  results: PersistenceResult[];
  type: 'winner' | 'loser';
  accent: string;
  isIndexMode: boolean;
}) {
  return (
    <div className="flex-1 min-w-0">
      {/* Panel header */}
      <div className={`flex items-center gap-2 mb-3 pb-2 border-b ${accent}`}>
        <span className={`text-xs font-bold tracking-widest uppercase ${type === 'winner' ? 'text-emerald-400' : 'text-red-400'}`}>
          {title} — {count} {isIndexMode ? 'Index(es)' : 'Ticker(s)'}
        </span>
      </div>

      {/* Column headers */}
      <div className="flex items-center gap-3 px-3 mb-1">
        <div className="w-24 flex-shrink-0 text-xs font-bold text-white">
          {isIndexMode ? 'Index' : 'Symbol'}
        </div>
        <div className="flex-1 text-xs font-bold text-white">Sessions</div>
        <div className="w-14 text-right text-xs font-bold text-white">Count</div>
        <div className="w-20 text-right text-xs font-bold text-white">Σ%</div>
      </div>

      {/* Rows */}
      <div className="space-y-0.5 max-h-[70vh] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-zinc-700">
        {results.length === 0 ? (
          <div className="text-zinc-500 text-sm px-3 py-4">No results</div>
        ) : (
          results.map((r) => (
            <StockRow key={r.symbol} result={r} type={type} isIndexMode={isIndexMode} />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Main Dashboard ────────────────────────────────────────────────────────────
export default function MoversPlusDashboard() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [data, setData] = useState<MoversPlusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingSessions, setPendingSessions] = useState(DEFAULT_SETTINGS.sessions);
  const [pendingMin, setPendingMin] = useState(DEFAULT_SETTINGS.minAppearances);

  const fetchData = useCallback(async (s: Settings) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/movers-plus?index=${s.index}&sessions=${s.sessions}&min=${s.minAppearances}`,
      );
      if (!res.ok) throw new Error(await res.text());
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(settings);
  }, [settings, fetchData]);

  function applySettings() {
    const next: Settings = {
      ...settings,
      sessions: pendingSessions,
      minAppearances: pendingMin,
    };
    setSettings(next);
  }

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      {/* Header */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/90 backdrop-blur-md px-4 py-2 flex flex-wrap items-center gap-2.5 z-20 sticky top-0">
        <div className="flex items-center gap-2 mr-1">
          <div className="h-6 w-6 rounded-md bg-gradient-to-tr from-emerald-600 to-teal-500 flex items-center justify-center shrink-0">
            <span className="text-white text-[11px] font-bold">M+</span>
          </div>
          <span className="text-[14px] font-bold tracking-tight text-white">Movers+</span>
        </div>
        <div className="w-px h-5 bg-zinc-800 hidden sm:block" />
        <NavBar />
        {data && (
          <span className="ml-auto text-[11px] text-zinc-500">Data as of {data.dataDate}</span>
        )}
      </header>

      <div className="p-4">
      <p className="text-xs text-zinc-400 mb-5">
        Mover Persistence — tracks profitable / loss sessions over a configurable window
      </p>

      {/* Settings bar */}
      <div className="flex flex-wrap items-end gap-4 mb-6 p-3 bg-zinc-900 border border-zinc-800 rounded-xl">
        {/* Index toggle */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-bold text-white">Index</span>
          <div className="flex gap-1">
            {(
              [
                { value: 'nifty50',  label: 'Nifty 50'  },
                { value: 'nifty500', label: 'Nifty 500' },
                { value: 'indices',  label: 'Indices'   },
              ] as const
            ).map(({ value, label }) => (
              <button
                key={value}
                onClick={() => setSettings((s) => ({ ...s, index: value }))}
                className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all ${
                  settings.index === value
                    ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400'
                    : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:text-white hover:border-zinc-600'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Sessions */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-bold text-white">
            Sessions (last{' '}
            <span className="text-emerald-400">{pendingSessions}</span> trading days)
          </span>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={3}
              max={60}
              value={pendingSessions}
              onChange={(e) => setPendingSessions(Number(e.target.value))}
              className="w-32 accent-emerald-500"
            />
            <span className="text-sm font-bold text-white w-6">{pendingSessions}</span>
          </div>
        </div>

        {/* Min appearances */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-bold text-white">
            Min appearances to qualify
          </span>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={1}
              max={Math.max(1, pendingSessions - 2)}
              value={pendingMin}
              onChange={(e) => setPendingMin(Number(e.target.value))}
              className="w-32 accent-emerald-500"
            />
            <span className="text-sm font-bold text-white w-4">{pendingMin}</span>
          </div>
        </div>

        {/* Apply */}
        <button
          onClick={applySettings}
          disabled={loading}
          className="px-4 py-2 text-xs font-bold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg transition-all"
        >
          {loading ? 'Loading…' : 'Apply'}
        </button>

        {/* Refresh */}
        <button
          onClick={() => fetchData(settings)}
          disabled={loading}
          className="px-4 py-2 text-xs font-bold bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 border border-zinc-700 rounded-lg transition-all"
        >
          ↻ Refresh
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 bg-red-900/30 border border-red-700/50 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="text-zinc-400 text-sm animate-pulse">Computing persistence…</div>
        </div>
      )}

      {/* Main content */}
      {!loading && data && (
        <>
          {data.staleCount > 0 && (
            <div className="mb-4 px-3 py-2 bg-amber-900/20 border border-amber-700/30 rounded-lg text-amber-400 text-xs">
              {data.staleCount} {settings.index === 'indices' ? 'index(es)' : `stock${data.staleCount > 1 ? 's' : ''}`} excluded — their latest data
              is behind the consensus date ({data.dataDate}) and would have misaligned squares.
              Run a data refresh to include them.
            </div>
          )}
          <div className="flex gap-6">
            <Panel
              title="Persistent Winners"
              count={data.winners.length}
              results={data.winners}
              type="winner"
              accent="border-emerald-700/40"
              isIndexMode={settings.index === 'indices'}
            />
            <div className="w-px bg-zinc-800 flex-shrink-0" />
            <Panel
              title="Persistent Losers"
              count={data.losers.length}
              results={data.losers}
              type="loser"
              accent="border-red-700/40"
              isIndexMode={settings.index === 'indices'}
            />
          </div>
        </>
      )}
      </div>
    </div>
  );
}
