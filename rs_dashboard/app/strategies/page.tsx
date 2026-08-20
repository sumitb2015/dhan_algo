'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Layers, RefreshCw, TrendingUp, TrendingDown, LogOut, AlertTriangle,
  ChevronDown, ChevronRight, Search, Activity, Wallet, Briefcase,
  ChevronsDownUp, ChevronsUpDown, X
} from 'lucide-react';
import StrategyCard from '@/components/StrategyCard';
import NavBar from '@/components/NavBar';
import { usePortfolio } from '@/lib/usePortfolio';
import {
  useGroupCollapse, groupByUnderlying, runningInstancesOf, sessionPnlOf, inr, signedInr,
} from '@/lib/useStrategyGroups';

type StatusFilter = 'all' | 'running' | 'stopped';

/** One /api/strategies registry entry: [key, {meta, state, instances}]. */
type RegistryEntry = [string, any];

/** Is the instance this page actually renders a card for live? */
const isPrimaryRunning = (item: any) => item?.state?.status !== 'STOPPED';

/** Module scope, not a closure inside the page: the 2s poll re-renders the page constantly,
 *  and a locally-defined component would be a fresh type each time — remounting every tile. */
function StatTile({
  icon: Icon, label, value, tone = 'neutral', sub,
}: {
  icon: React.ElementType; label: string; value: React.ReactNode;
  tone?: 'neutral' | 'up' | 'down'; sub?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-1.5">
      <Icon className={`h-4 w-4 shrink-0 ${
        tone === 'up' ? 'text-emerald-400' : tone === 'down' ? 'text-red-400' : 'text-zinc-500'
      }`} />
      <div className="flex flex-col leading-none gap-1">
        <span className="text-[9px] uppercase tracking-wider font-semibold text-zinc-400">{label}</span>
        <span className={`text-sm font-bold tabular-nums ${
          tone === 'up' ? 'text-emerald-400' : tone === 'down' ? 'text-red-400' : 'text-white'
        }`}>{value}</span>
        {sub && <span className="text-[9px] text-zinc-500 tabular-nums">{sub}</span>}
      </div>
    </div>
  );
}

export default function StrategiesPage() {
  const [strategies, setStrategies] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const { portfolio, loading: portfolioLoading, refresh: fetchPortfolio } = usePortfolio();

  const [confirmGlobalExit, setConfirmGlobalExit] = useState<boolean>(false);
  const [globalExiting, setGlobalExiting] = useState<boolean>(false);

  const [query, setQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // Groups default to open only when something inside is running, so the page opens on
  // live strategies and folds the rest away behind their index header.
  const groups = useGroupCollapse();

  // Stable reference so memoized StrategyCard rows don't re-render on every poll
  const fetchStrategies = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const res = await fetch('/api/strategies');
      const data = await res.json();
      if (data.success) {
        setStrategies(data.strategies);
        setError(null);
        setLastUpdated(Date.now());
      } else {
        setError(data.error || 'Failed to retrieve strategies state');
      }
    } catch {
      setError('Network error. Failed to communicate with local API.');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStrategies(true);
    const interval = setInterval(() => fetchStrategies(false), 2000);
    return () => clearInterval(interval);
  }, []);

  // Re-renders the "updated Xs ago" chip without touching the poll cadence.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setClockTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Counts EVERY running process, including duplicate ("+ Add run") instances launched from
  // Strategies+. This page only renders primary instances, so a duplicate has no card here —
  // but it is still live, and Global Exit (stop_all) does stop it. Counting only primaries
  // would both under-report and disable the Global Exit button while duplicates trade.
  const runningInstances = Object.values(strategies).flatMap((s: any) =>
    Object.entries(s.instances || {}).filter(([, st]: [string, any]) => st?.status !== 'STOPPED')
  );
  const runningCount = runningInstances.length;
  const runningDuplicateCount = runningInstances.filter(([instanceId]) => instanceId !== '').length;
  const strategyCount = Object.keys(strategies).length;

  // Sum of what the strategies themselves report, which is NOT the broker P&L above: it
  // covers only strategy-managed legs, and a dry-run instance contributes simulated numbers.
  const strategyPnl = runningInstances.reduce((n, [, st]: [string, any]) => n + sessionPnlOf(st), 0);

  // Search/status filtering happens before grouping so a group that filters down to
  // nothing disappears entirely rather than rendering an empty shell.
  //
  // Group badges count the PRIMARY instance only, unlike the page-wide counter above: this
  // page renders one card per strategy (the primary), so counting a Strategies+ duplicate
  // here would print "1 running" directly above a card reading STOPPED. Duplicates are
  // surfaced separately, as a "+N in Strategies+" note.
  const groupedStrategies = useMemo(() => {
    const q = query.trim().toLowerCase();
    const entries: RegistryEntry[] = Object.entries(strategies).filter(([key, item]: RegistryEntry) => {
      const running = isPrimaryRunning(item);
      if (statusFilter === 'running' && !running) return false;
      if (statusFilter === 'stopped' && running) return false;
      if (!q) return true;
      return `${item?.meta?.name ?? ''} ${key} ${item?.meta?.underlying ?? ''}`.toLowerCase().includes(q);
    });
    return groupByUnderlying<RegistryEntry>(
      entries,
      ([, item]) => item?.meta?.underlying,
      ([, item]) => (isPrimaryRunning(item) ? [item.state] : []),
    ).map(g => ({
      ...g,
      duplicateCount: g.items.reduce(
        (n, [, item]) => n + runningInstancesOf(item).length - (isPrimaryRunning(item) ? 1 : 0), 0),
    }));
  }, [strategies, query, statusFilter]);

  // Pin auto-opened groups so a group does not fold up the moment its last strategy stops.
  useEffect(() => {
    groups.ensureOpen(groupedStrategies.filter(g => g.runningCount > 0).map(g => g.underlying));
  }, [groupedStrategies, groups]);

  const visibleCount = groupedStrategies.reduce((n, g) => n + g.items.length, 0);
  const isFiltered = query.trim() !== '' || statusFilter !== 'all';

  const setAllGroups = (open: boolean) =>
    groups.setAll(groupedStrategies.map(g => g.underlying), open);

  const handleGlobalExit = async () => {
    if (!confirmGlobalExit) {
      setConfirmGlobalExit(true);
      setTimeout(() => setConfirmGlobalExit(false), 3000);
      return;
    }
    setGlobalExiting(true);
    setConfirmGlobalExit(false);
    try {
      await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop_all' }),
      });
    } finally {
      setGlobalExiting(false);
      setTimeout(() => fetchStrategies(false), 500);
    }
  };

  const pnl = portfolio?.total_pnl ?? 0;
  const pnlPositive = pnl >= 0;
  const staleSeconds = lastUpdated ? Math.floor((Date.now() - lastUpdated) / 1000) : null;

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-300">

      {/* Header */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/60 backdrop-blur-md px-4 py-2.5 flex items-center gap-4 z-20 flex-wrap">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center shadow-md shadow-emerald-500/10 shrink-0">
            <Layers className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-white leading-none">
              Dhan Algo — Strategies
            </h1>
            <p className="text-[10px] text-zinc-500 mt-0.5">Automated Options Control Center</p>
          </div>
        </div>

        <NavBar />

        <div className="flex items-center gap-2 ml-auto shrink-0">
          {/* Poll freshness — turns amber if the 2s poll has clearly stalled */}
          {staleSeconds !== null && (
            <span
              className={`hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10px] font-semibold tabular-nums ${
                staleSeconds > 10
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                  : 'border-zinc-800 bg-zinc-900/60 text-zinc-400'
              }`}
              title="Age of the last successful /api/strategies poll"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${staleSeconds > 10 ? 'bg-amber-400' : 'bg-emerald-500 animate-pulse'}`} />
              {staleSeconds <= 1 ? 'live' : `${staleSeconds}s ago`}
            </span>
          )}
          <button
            onClick={() => fetchStrategies(true)}
            className="p-1.5 border border-zinc-800 rounded-lg bg-zinc-900/40 text-zinc-500 hover:text-white hover:border-zinc-700 transition-all active:scale-95"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* Portfolio P&L + Global Exit bar */}
      <div className="w-full border-b border-zinc-900 bg-zinc-950/80 px-4 py-2 flex items-center justify-between gap-3 flex-wrap">
        {/* P&L summary */}
        <div className="flex items-center gap-2 flex-wrap">
          <StatTile
            icon={portfolioLoading && !portfolio ? RefreshCw : pnlPositive ? TrendingUp : TrendingDown}
            label="Dhan P&L"
            tone={portfolio ? (pnlPositive ? 'up' : 'down') : 'neutral'}
            value={portfolio ? signedInr(pnl, 2) : '—'}
          />

          {portfolio && portfolio.success && (
            <>
              <StatTile
                icon={portfolio.total_realized_pnl >= 0 ? TrendingUp : TrendingDown}
                label="Realized"
                tone={portfolio.total_realized_pnl >= 0 ? 'up' : 'down'}
                value={signedInr(portfolio.total_realized_pnl, 2)}
              />
              <StatTile
                icon={portfolio.total_unrealized_pnl >= 0 ? TrendingUp : TrendingDown}
                label="Unrealized"
                tone={portfolio.total_unrealized_pnl >= 0 ? 'up' : 'down'}
                value={signedInr(portfolio.total_unrealized_pnl, 2)}
              />
              <StatTile icon={Wallet} label="Margin" value={inr(portfolio.available_funds)} />
              <StatTile icon={Briefcase} label="Positions" value={portfolio.positions.length} />
            </>
          )}

          {/* Strategy-reported P&L — deliberately separate from the broker figures, since it
              only covers strategy-managed legs and includes dry-run simulations. */}
          {runningCount > 0 && (
            <StatTile
              icon={Activity}
              label="Strategy P&L"
              tone={strategyPnl >= 0 ? 'up' : 'down'}
              value={signedInr(strategyPnl)}
              sub={`across ${runningCount} run${runningCount === 1 ? '' : 's'}`}
            />
          )}

          <button
            onClick={fetchPortfolio}
            disabled={portfolioLoading}
            className="p-1 rounded text-zinc-600 hover:text-zinc-400 transition-colors disabled:opacity-40"
            title="Refresh P&L"
          >
            <RefreshCw className={`h-3 w-3 ${portfolioLoading ? 'animate-spin' : ''}`} />
          </button>

          {portfolio && !portfolio.success && (
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/30">
              <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0" />
              <span className="text-[10px] text-amber-400 font-medium">
                Token expired — run <code className="font-mono bg-amber-500/10 px-0.5 rounded">login.py</code> to re-login
              </span>
            </div>
          )}
        </div>

        {/* Global Exit */}
        <div className="flex items-center gap-2">
          {runningCount > 0 && (
            <span className="text-[10px] text-zinc-500">
              {runningCount} running
              {runningDuplicateCount > 0 && (
                <span className="text-amber-400"> (incl. {runningDuplicateCount} duplicate — see Strategies+)</span>
              )}
            </span>
          )}
          <button
            onClick={handleGlobalExit}
            disabled={globalExiting || runningCount === 0}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed ${
              confirmGlobalExit
                ? 'bg-red-600 border-red-500 text-oncolor animate-pulse'
                : globalExiting
                ? 'bg-red-900/40 border-red-800 text-red-400'
                : 'bg-red-950/60 border-red-900/60 text-red-400 hover:bg-red-900/40 hover:border-red-700 hover:text-red-300'
            }`}
            title={runningCount === 0 ? 'No strategies running' : confirmGlobalExit ? 'Click again to confirm' : 'Stop all running strategies'}
          >
            {globalExiting ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : confirmGlobalExit ? (
              <AlertTriangle className="h-3 w-3" />
            ) : (
              <LogOut className="h-3 w-3" />
            )}
            {globalExiting ? 'Stopping…' : confirmGlobalExit ? 'Confirm Exit All?' : 'Global Exit'}
          </button>
        </div>
      </div>

      {/* Filter toolbar — sticky so search/status stay reachable while scrolling groups */}
      <div className="sticky top-0 z-10 w-full border-b border-zinc-900 bg-zinc-950/95 backdrop-blur-md px-4 py-2 flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-600 pointer-events-none" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search strategies…"
            className="w-56 rounded-lg border border-zinc-800 bg-zinc-900/60 pl-8 pr-7 py-1.5 text-xs text-white placeholder-zinc-600 outline-none focus:border-zinc-600 transition-colors"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              title="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900/60 p-0.5 gap-0.5">
          {([
            { id: 'all', label: 'All', count: strategyCount },
            { id: 'running', label: 'Running', count: Object.values(strategies).filter(isPrimaryRunning).length },
            { id: 'stopped', label: 'Stopped', count: Object.values(strategies).filter(s => !isPrimaryRunning(s)).length },
          ] as const).map(({ id, label, count }) => (
            <button
              key={id}
              onClick={() => setStatusFilter(id)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold transition-all ${
                statusFilter === id
                  ? id === 'running'
                    ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/30'
                    : 'bg-zinc-700/40 text-white border border-zinc-600/40'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {label}
              <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold leading-none ${
                statusFilter === id ? 'bg-zinc-800 text-zinc-200' : 'bg-zinc-800/70 text-zinc-500'
              }`}>{count}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 ml-auto">
          <button
            onClick={() => setAllGroups(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 text-[11px] font-semibold text-zinc-400 hover:text-white hover:border-zinc-700 transition-all"
            title="Expand every index group"
          >
            <ChevronsUpDown className="h-3 w-3" />
            Expand all
          </button>
          <button
            onClick={() => setAllGroups(false)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 text-[11px] font-semibold text-zinc-400 hover:text-white hover:border-zinc-700 transition-all"
            title="Collapse every index group"
          >
            <ChevronsDownUp className="h-3 w-3" />
            Collapse all
          </button>
        </div>
      </div>

      {/* Main */}
      <main className="flex-1 w-full mx-auto px-4 py-4">
        {loading && strategyCount === 0 ? (
          <div className="flex flex-col items-center justify-center p-16 rounded-xl border border-zinc-900 bg-zinc-950/60 min-h-[260px]">
            <RefreshCw className="h-6 w-6 text-emerald-500 animate-spin" />
            <span className="text-zinc-600 text-xs mt-3">Connecting to strategy API…</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center p-12 rounded-xl border border-red-500/20 bg-red-950/10 text-center min-h-[260px]">
            <p className="text-sm font-semibold text-red-400">Connection Failed</p>
            <p className="text-xs text-zinc-600 mt-1">{error}</p>
          </div>
        ) : visibleCount === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 p-16 rounded-xl border border-zinc-900 bg-zinc-950/60 min-h-[260px]">
            <div className="h-12 w-12 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center">
              <Search className="h-5 w-5 text-zinc-700" />
            </div>
            <p className="text-sm font-semibold text-zinc-500">No strategies match this filter</p>
            {isFiltered && (
              <button
                onClick={() => { setQuery(''); setStatusFilter('all'); }}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-white hover:border-zinc-600 text-xs font-semibold transition-all"
              >
                <X className="h-3.5 w-3.5" />
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {groupedStrategies.map(({ underlying, items: entries, runningCount: groupRunning, pnl: groupPnl, duplicateCount }) => {
              const open = groups.isOpen(underlying, groupRunning > 0);
              return (
                <section
                  key={underlying}
                  className={`rounded-xl border overflow-hidden transition-colors ${
                    groupRunning > 0
                      ? 'border-emerald-900/40 bg-zinc-950/40'
                      : 'border-zinc-900 bg-zinc-950/40'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => groups.toggle(underlying, open)}
                    aria-expanded={open}
                    className="w-full flex items-center gap-2 px-3 py-2 bg-zinc-900 text-left hover:bg-zinc-800/70 transition-colors"
                  >
                    {open
                      ? <ChevronDown className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                      : <ChevronRight className="h-3.5 w-3.5 text-zinc-400 shrink-0" />}
                    <span className="text-xs font-bold text-white tracking-wide">{underlying}</span>
                    <span className="text-[10px] font-semibold text-zinc-500">
                      {entries.length} strateg{entries.length === 1 ? 'y' : 'ies'}
                    </span>
                    {groupRunning > 0 && (
                      <>
                        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-[10px] font-bold text-emerald-400">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          {groupRunning} running
                        </span>
                        <span className={`text-[10px] font-bold tabular-nums ${groupPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {signedInr(groupPnl)}
                        </span>
                      </>
                    )}
                    {/* Duplicates have no card on this page, so say where they live rather
                        than folding them into a count above a STOPPED-looking card. */}
                    {duplicateCount > 0 && (
                      <span
                        className="text-[10px] font-semibold text-amber-400"
                        title="Extra runs launched from Strategies+ — they have no card here"
                      >
                        +{duplicateCount} in Strategies+
                      </span>
                    )}
                    {/* Collapsed groups otherwise give no hint of what is inside */}
                    {!open && (
                      <span className="ml-auto text-[10px] text-zinc-500 truncate max-w-[45%] text-right">
                        {entries.map(([, item]) => item?.meta?.name).filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </button>
                  {open && (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 items-start p-3">
                      {entries.map(([key, item]) => (
                        <StrategyCard
                          key={key}
                          meta={item.meta}
                          state={item.state}
                          onRefresh={fetchStrategies}
                        />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
