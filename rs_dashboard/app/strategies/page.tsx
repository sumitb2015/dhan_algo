'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Bot, RefreshCw, AlertTriangle, Power, ChevronDown, ChevronRight, Search,
  ChevronsDownUp, ChevronsUpDown, X,
} from 'lucide-react';
import DeskFigure, { deskTone } from '@/components/DeskFigure';
import StrategyCard from '@/components/StrategyCard';
import NavBar from '@/components/NavBar';
import BrokerSelector from '@/components/BrokerSelector';
import { usePortfolio } from '@/lib/usePortfolio';
import { useBrokerSelector } from '@/hooks/useBrokerSelector';
import {
  useGroupCollapse, groupByUnderlying, runningInstancesOf, sessionPnlOf, inr, signedInr,
} from '@/lib/useStrategyGroups';
import { findCollisions } from '@/lib/strategyCollisions';

type StatusFilter = 'all' | 'running' | 'stopped';

/** One /api/strategies registry entry: [key, {meta, state, instances}]. */
type RegistryEntry = [string, any];

/** Is the instance this page actually renders a card for live? */
const isPrimaryRunning = (item: any) => item?.state?.status !== 'STOPPED';

export default function StrategiesPage() {
  const { broker, setBroker, authenticatedBrokers } = useBrokerSelector();
  const [strategies, setStrategies] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const { portfolio, loading: portfolioLoading, refresh: fetchPortfolio } = usePortfolio();

  const [confirmGlobalExit, setConfirmGlobalExit] = useState<boolean>(false);
  const [globalExiting, setGlobalExiting] = useState<boolean>(false);

  const [query, setQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // Read-only collision awareness (2026-07-30 incident follow-up): two running
  // instances sharing the exact same strike/expiry/CE-PE at the broker. Never
  // blocks anything — Dhan nets by security ID regardless of what this banner
  // says — it only surfaces what's already true so it can be noticed sooner.
  const collisions = useMemo(() => findCollisions(strategies), [strategies]);
  const [dismissedCollisionKeys, setDismissedCollisionKeys] = useState<Set<string>>(new Set());
  const collisionKeyOf = (c: (typeof collisions)[number]) => `${c.underlying}|${c.expiry}|${c.strike}|${c.optType}`;
  const visibleCollisions = collisions.filter((c) => !dismissedCollisionKeys.has(collisionKeyOf(c)));

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
  const staleSeconds = lastUpdated ? Math.floor((Date.now() - lastUpdated) / 1000) : null;

  const searchRef = useRef<HTMLInputElement>(null);
  // "/" jumps to search, the way every terminal does — ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || t?.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ok = portfolio?.success;
  const stale = staleSeconds !== null && staleSeconds > 10;

  return (
    <div className="flex flex-col flex-1 w-full bg-zinc-950 min-h-screen text-zinc-300">

      {/* Header */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <Bot className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Algo Desk</h1>
            <p className="text-[11px] text-zinc-500 font-medium mt-1">Start, watch and stop every strategy from one place</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <BrokerSelector broker={broker} setBroker={setBroker} authenticatedBrokers={authenticatedBrokers} />
          {staleSeconds !== null && (
            <span
              className={`hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs font-semibold tabular-nums ${
                stale ? 'border-amber-500/30 bg-amber-500/10 text-amber-400' : 'border-zinc-800 text-zinc-400'
              }`}
              title="Age of the last successful /api/strategies poll"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${stale ? 'bg-amber-400' : 'bg-emerald-500'}`} />
              {stale ? `Stalled ${staleSeconds}s` : 'Live'}
            </span>
          )}
          <button
            onClick={() => fetchStrategies(true)}
            aria-label="Refresh strategies"
            title="Refresh strategies"
            className="p-1.5 border border-zinc-800 rounded-lg text-zinc-500 hover:text-white hover:border-zinc-700 focus-visible:outline-2 focus-visible:outline-emerald-400"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </header>

      {/* Command strip: one band of figures, one emergency control */}
      <section aria-label="Account and strategy totals" className="border-b border-zinc-800 bg-zinc-900">
        <div className="flex items-stretch flex-wrap px-6">
          <DeskFigure label="Day P&L" tone={ok ? deskTone(pnl) : 'neutral'} big
            value={ok ? signedInr(pnl) : portfolioLoading ? 'Loading' : '—'} />
          <DeskFigure label="Realized" tone={ok ? deskTone(portfolio.total_realized_pnl) : 'neutral'}
            value={ok ? signedInr(portfolio.total_realized_pnl) : '—'} />
          <DeskFigure label="Unrealized" tone={ok ? deskTone(portfolio.total_unrealized_pnl) : 'neutral'}
            value={ok ? signedInr(portfolio.total_unrealized_pnl) : '—'} />
          <DeskFigure label="Strategy P&L" tone={runningCount > 0 ? deskTone(strategyPnl) : 'neutral'}
            value={runningCount > 0 ? signedInr(strategyPnl) : '—'}
            hint={runningCount > 0 ? `${runningCount} run${runningCount === 1 ? '' : 's'}, strategy legs only` : 'Nothing running'} />
          <DeskFigure label="Margin free" value={ok ? inr(portfolio.available_funds) : '—'} />
          <DeskFigure label="Open positions" value={ok ? String(portfolio.positions.length) : '—'} />

          <div className="ml-auto flex items-center gap-3 py-3">
            {runningDuplicateCount > 0 && (
              <span className="text-xs text-amber-400">{runningDuplicateCount} duplicate run{runningDuplicateCount === 1 ? '' : 's'} in Strategies+</span>
            )}
            <button
              onClick={handleGlobalExit}
              disabled={globalExiting || runningCount === 0}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-red-400 ${
                confirmGlobalExit
                  ? 'bg-red-600 border-red-500 text-oncolor'
                  : 'border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20'
              }`}
              title={runningCount === 0 ? 'No strategies running' : confirmGlobalExit ? 'Click again to confirm' : 'Stop every running strategy'}
            >
              {globalExiting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                : confirmGlobalExit ? <AlertTriangle className="h-3.5 w-3.5" />
                : <Power className="h-3.5 w-3.5" />}
              {globalExiting ? 'Stopping…' : confirmGlobalExit ? `Click again to stop ${runningCount}` : 'Stop all'}
            </button>
          </div>
        </div>
        {portfolio && !portfolio.success && (
          <div className="flex items-center gap-2 px-6 py-1.5 border-t border-amber-500/20 bg-amber-500/10 text-xs text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Dhan session expired, so broker figures are hidden. Run <code className="font-mono">login.py</code> to sign in again.
            <button onClick={fetchPortfolio} className="ml-auto underline hover:text-amber-300">Retry</button>
          </div>
        )}
      </section>

      {/* Strike-collision banner — read-only, never blocks anything (see lib/strategyCollisions.ts) */}
      {visibleCollisions.length > 0 && (
        <div role="alert" className="border-b border-amber-500/20 bg-amber-500/10 px-6 py-2 flex flex-col gap-1.5">
          {visibleCollisions.map((c) => {
            const key = collisionKeyOf(c);
            const holders = c.legs.map((l) => `${l.strategyKey}${l.instanceId ? `:${l.instanceId}` : ''}`).join(' + ');
            return (
              <div key={key} className="flex items-start gap-2 text-xs">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
                <span className="text-amber-300">
                  <span className="font-bold">{holders}</span> are both short {c.underlying} {c.strike.toLocaleString('en-IN')} {c.optType} ({c.expiry}).
                  Dhan nets this as one broker position, so either strategy exiting sizes against the combined quantity.
                  Each strategy&apos;s <code className="font-mono">detect_phantom_leg_broker()</code> check self-corrects, but review before squaring off by hand.
                </span>
                <button
                  onClick={() => setDismissedCollisionKeys((prev) => new Set(prev).add(key))}
                  className="ml-auto shrink-0 rounded border border-amber-500/30 px-1.5 py-0.5 text-xs text-amber-400 hover:text-amber-300"
                >
                  Dismiss
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Toolbar — sticky under the header so search/status stay in reach */}
      <div className="sticky top-[57px] z-20 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-6 py-2 flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 pointer-events-none" />
          <input
            ref={searchRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search strategies"
            aria-label="Search strategies"
            className="w-56 rounded-lg border border-zinc-800 bg-zinc-900 pl-8 pr-12 py-1.5 text-xs text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50"
          />
          {query ? (
            <button onClick={() => setQuery('')} aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200">
              <X className="h-3 w-3" />
            </button>
          ) : (
            <kbd className="absolute right-2 top-1/2 -translate-y-1/2 rounded border border-zinc-700 px-1 text-[10px] font-mono text-zinc-500">/</kbd>
          )}
        </div>

        <div role="tablist" aria-label="Status filter" className="flex items-center rounded-lg border border-zinc-800 p-0.5 gap-0.5">
          {([
            { id: 'all', label: 'All', count: strategyCount },
            { id: 'running', label: 'Running', count: Object.values(strategies).filter(isPrimaryRunning).length },
            { id: 'stopped', label: 'Stopped', count: Object.values(strategies).filter(s => !isPrimaryRunning(s)).length },
          ] as const).map(({ id, label, count }) => (
            <button
              key={id}
              role="tab"
              aria-selected={statusFilter === id}
              onClick={() => setStatusFilter(id)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
                statusFilter === id
                  ? id === 'running' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-zinc-800 text-white'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {label}
              <span className="tabular-nums text-zinc-500">{count}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 ml-auto">
          <button onClick={() => setAllGroups(true)} title="Expand every index group"
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-semibold text-zinc-400 hover:text-white hover:bg-zinc-800">
            <ChevronsUpDown className="h-3.5 w-3.5" />Expand all
          </button>
          <button onClick={() => setAllGroups(false)} title="Collapse every index group"
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-semibold text-zinc-400 hover:text-white hover:bg-zinc-800">
            <ChevronsDownUp className="h-3.5 w-3.5" />Collapse all
          </button>
        </div>
      </div>

      {/* Main */}
      <main className="flex-1 w-full max-w-[1680px] mx-auto px-6 py-5">
        {loading && strategyCount === 0 ? (
          <div className="flex flex-col items-center justify-center p-16 min-h-[260px]">
            <RefreshCw className="h-5 w-5 text-emerald-400 animate-spin" />
            <span className="text-zinc-500 text-xs mt-3">Loading strategies…</span>
          </div>
        ) : error ? (
          <div role="alert" className="flex flex-col items-center justify-center p-12 rounded-xl border border-red-500/20 bg-red-500/10 text-center min-h-[260px]">
            <p className="text-sm font-semibold text-red-400">Can&apos;t reach the strategy API</p>
            <p className="text-xs text-zinc-400 mt-1">{error}</p>
            <button onClick={() => fetchStrategies(true)} className="mt-3 px-3 py-1.5 rounded-lg border border-zinc-700 text-xs font-semibold text-zinc-300 hover:text-white">Try again</button>
          </div>
        ) : visibleCount === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 p-16 min-h-[260px] text-center">
            <p className="text-sm font-semibold text-zinc-300">No strategies match</p>
            <p className="text-xs text-zinc-500">Try a different name, or show all statuses.</p>
            {isFiltered && (
              <button
                onClick={() => { setQuery(''); setStatusFilter('all'); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-300 hover:text-white text-xs font-semibold"
              >
                <X className="h-3.5 w-3.5" />Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {groupedStrategies.map(({ underlying, items: entries, runningCount: groupRunning, pnl: groupPnl, duplicateCount }) => {
              const open = groups.isOpen(underlying, groupRunning > 0);
              return (
                <section key={underlying} aria-label={underlying}>
                  <button
                    type="button"
                    onClick={() => groups.toggle(underlying, open)}
                    aria-expanded={open}
                    className="group w-full flex items-center gap-3 pb-2 border-b border-zinc-800 text-left focus-visible:outline-2 focus-visible:outline-emerald-400"
                  >
                    {open
                      ? <ChevronDown className="h-4 w-4 text-zinc-500 shrink-0" />
                      : <ChevronRight className="h-4 w-4 text-zinc-500 shrink-0" />}
                    <span className="text-sm font-bold text-white tracking-tight">{underlying}</span>
                    <span className="text-xs text-zinc-500 tabular-nums">
                      {entries.length} strateg{entries.length === 1 ? 'y' : 'ies'}
                    </span>
                    {groupRunning > 0 && (
                      <>
                        <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse motion-reduce:animate-none" />
                          {groupRunning} running
                        </span>
                        <span className={`text-xs font-bold tabular-nums ${groupPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {signedInr(groupPnl)}
                        </span>
                      </>
                    )}
                    {/* Duplicates have no card on this page, so say where they live. */}
                    {duplicateCount > 0 && (
                      <span className="text-xs font-semibold text-amber-400" title="Extra runs launched from Strategies+ have no card here">
                        +{duplicateCount} in Strategies+
                      </span>
                    )}
                    {/* Collapsed groups otherwise give no hint of what is inside */}
                    {!open && (
                      <span className="ml-auto text-xs text-zinc-500 truncate max-w-[50%] text-right">
                        {entries.map(([, item]) => item?.meta?.name).filter(Boolean).join(', ')}
                      </span>
                    )}
                  </button>
                  {open && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3 items-start pt-3">
                      {entries.map(([key, item]) => (
                        <StrategyCard
                          key={key}
                          meta={item.meta}
                          state={item.state}
                          onRefresh={fetchStrategies}
                          selectedBroker={broker}
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
