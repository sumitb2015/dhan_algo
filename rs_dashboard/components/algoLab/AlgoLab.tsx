'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Cpu, FlaskConical, Settings, Target, Zap } from 'lucide-react';
import NavBar from '@/components/NavBar';
import { cn } from '@/lib/utils';
import { BrokerPicker, usePageBroker, type DhanKotak } from '@/components/BrokerPicker';
import { useLiveTickerPoll } from '@/lib/useLiveTickerPoll';
import { STRATEGIES, getStrategy, strategyConfig } from '@/lib/algoLab/registry';
import { emptyState, type LedgerOp } from '@/lib/algoLab/ledger';
import type { AlgoStateFile } from '@/lib/algoLab/types';
import { LiveEngine } from './LiveEngine';
import { BacktestPanel } from './BacktestPanel';
import { RulesDrawer } from './RulesDrawer';

type Tab = 'live' | 'backtest';
const istDate = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

interface HeaderIndices {
  updated_at?: string;
  quotes?: Record<string, { ltp?: number | null; prev_close?: number | null; change_pct?: number | null }>;
}

function pickIndexLtps(d: HeaderIndices): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ['NIFTY', 'VIX']) {
    const v = d?.quotes?.[k]?.ltp;
    if (typeof v === 'number' && v > 0) out[k] = v;
  }
  return out;
}

/** /algo-lab?strategy=<key>&tab=live|backtest — one interface for every registered strategy (lib/algoLab/registry.ts). */
export default function AlgoLab() {
  const [key, setKey] = useState(STRATEGIES[0].key);
  const [tab, setTab] = useState<Tab>('live');

  useEffect(() => {
    // Read after mount (the server render has no URL); deferred so it is not a synchronous effect setState.
    const t = setTimeout(() => {
      const p = new URLSearchParams(window.location.search);
      const s = getStrategy(p.get('strategy'));
      if (s) setKey(s.key);
      if (p.get('tab') === 'backtest') setTab('backtest');
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const def = getStrategy(key) ?? STRATEGIES[0];
  const { fields, defaults } = useMemo(() => strategyConfig(def), [def]);

  const syncUrl = (k: string, t: Tab) => {
    const u = new URL(window.location.href);
    u.searchParams.set('strategy', k);
    if (t === 'backtest') u.searchParams.set('tab', t);
    else u.searchParams.delete('tab');
    window.history.replaceState(null, '', u.pathname + u.search);
  };

  // ── Top Indices & VIX Live Feed ──
  const { data: headerIndices } = useLiveTickerPoll('/api/scalper/top-indices', pickIndexLtps);
  const indexLtps = useMemo(() => (headerIndices ? pickIndexLtps(headerIndices) : {}), [headerIndices]);
  const niftyLtp = indexLtps.NIFTY ?? null;
  const niftyChangePct = headerIndices?.quotes?.NIFTY?.change_pct ?? null;
  const niftyPrevClose = headerIndices?.quotes?.NIFTY?.prev_close ?? null;
  const vixLtp = indexLtps.VIX ?? null;
  const vixChangePct = headerIndices?.quotes?.VIX?.change_pct ?? null;
  const vixPrevClose = headerIndices?.quotes?.VIX?.prev_close ?? null;

  // ── Ledger of the selected strategy ──
  const [stored, setState] = useState<AlgoStateFile | null>(null);
  // A previous strategy's file is never shown or traded under another strategy's name.
  const loaded = stored?.strategy === def.key;
  const state = loaded ? stored : emptyState(def.key, defaults);

  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const j = (await (await fetch(`/api/algo-lab/${def.key}/state`, { cache: 'no-store' })).json()) as AlgoStateFile & { success?: boolean };
        if (dead || !j.success || j.strategy !== def.key) return;
        // Only a newer revision replaces local state: a slow poll must not roll back a mutation's reply.
        setState((prev) => (!prev || prev.strategy !== j.strategy || j.rev > prev.rev ? j : prev));
      } catch {
        /* retry next tick */
      }
    };
    void load();
    const id = setInterval(load, 3000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [def.key, defaults]);

  const mutate = useCallback(
    async (op: LedgerOp): Promise<boolean> => {
      try {
        const res = await fetch(`/api/algo-lab/${def.key}/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) });
        const j = (await res.json()) as AlgoStateFile & { success?: boolean; error?: string };
        if (j.success) {
          setState((prev) => (!prev || prev.strategy !== j.strategy || j.rev >= prev.rev ? j : prev));
          return true;
        }
        toast.error(j.error ?? 'Ledger update refused');
        return false;
      } catch (e) {
        toast.error(String(e));
        return false;
      }
    },
    [def.key],
  );

  const [broker, setBroker, brokerLoaded] = usePageBroker('algoLab.broker');
  const [viewerId] = useState(() => `alab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [chain, setChain] = useState<{ expiries: string[]; expiry: string; setExpiry: (e: string) => void; locked: boolean; feed: string } | null>(null);
  const onChainLock = useCallback((c: NonNullable<typeof chain>) => setChain(c), []);

  const openCount = state.positions.filter((p) => p.status === 'OPEN').length;
  const switchStrategy = (k: string) => {
    if (k === def.key) return;
    if ((state.config.engineActive || openCount > 0) && !confirm(`${def.label} has its engine on or open positions. Leaving it stops its engine in this tab (open positions stay in its ledger). Switch?`)) return;
    setKey(k);
    setChain(null);
    syncUrl(k, tab);
  };
  const switchTab = (t: Tab) => {
    setTab(t);
    syncUrl(def.key, t);
  };

  const isBreakdown = def.key === 'breakdown_auto_scalper';

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-white">
      {/* Sticky Header — Standard Dhan Page Theme */}
      <div className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/95 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border',
                isBreakdown
                  ? 'border-emerald-500/25 bg-emerald-500/10'
                  : 'border-violet-500/25 bg-violet-500/10',
              )}
            >
              {isBreakdown ? <Target className="h-4 w-4 text-emerald-400" /> : <Cpu className="h-4 w-4 text-violet-400" />}
            </div>
            <div>
              <p
                className={cn(
                  'mb-0.5 text-[10px] font-bold uppercase tracking-[0.16em]',
                  isBreakdown ? 'text-emerald-400' : 'text-violet-400',
                )}
              >
                {isBreakdown ? 'Scalping · Multi-Strike Breakdown' : 'Automation · Live + Backtest'}
              </p>
              <h1 className="text-sm font-bold leading-none tracking-tight text-white">
                Algo Lab <span className="font-medium text-zinc-500">· {def.label}</span>
              </h1>
              <p className="mt-1 text-[10px] font-medium text-zinc-500">
                {isBreakdown
                  ? 'Automated multi-strike option breakdown seller with NIFTY trend bias & trailing SL'
                  : 'One unified terminal for automated strategy execution & backtesting'}
              </p>
            </div>
          </div>

          <select
            value={def.key}
            onChange={(e) => switchStrategy(e.target.value)}
            aria-label="Strategy"
            className="h-8 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-xs font-bold text-zinc-100 focus:border-zinc-700 focus:outline-none"
          >
            {STRATEGIES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label} ({s.side})
              </option>
            ))}
          </select>

          {def.status === 'UNVALIDATED' && (
            <span
              className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-400"
              title="No backtest + forward test has justified REAL money yet"
            >
              UNVALIDATED
            </span>
          )}

          {/* View Mode Tabs: Live Trading vs Backtest */}
          <div className="flex items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900 p-1 shadow-inner">
            <button
              type="button"
              onClick={() => switchTab('live')}
              aria-pressed={tab === 'live'}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all',
                tab === 'live' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200',
              )}
            >
              <Zap className="h-3.5 w-3.5 text-emerald-400" />
              <span>Live Trading</span>
              {openCount > 0 && (
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.2 font-mono text-[10px] font-bold text-emerald-400">
                  {openCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => switchTab('backtest')}
              aria-pressed={tab === 'backtest'}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all',
                tab === 'backtest' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200',
              )}
            >
              <FlaskConical className="h-3.5 w-3.5 text-violet-400" />
              <span>Backtest</span>
            </button>
          </div>
        </div>

        {/* Right Header Controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          {tab === 'live' && chain && chain.expiries.length > 0 && (
            <select
              value={chain.expiry}
              onChange={(e) => chain.setExpiry(e.target.value)}
              disabled={chain.locked}
              title={chain.locked ? 'Locked to the expiry of the open positions (their stops need its quotes)' : undefined}
              aria-label="Expiry"
              className="h-8 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-xs font-bold text-zinc-200 disabled:opacity-50 focus:border-zinc-700 focus:outline-none"
            >
              {chain.expiries.map((e) => (
                <option key={e} value={e}>
                  {def.underlyings[0]} {e}
                </option>
              ))}
            </select>
          )}

          {tab === 'live' && (
            <BrokerPicker
              value={broker as DhanKotak}
              onChange={setBroker}
              disabled={openCount > 0}
              disabledReason="Positions are open on the current broker"
            />
          )}

          {/* WebSocket Feed Indicator */}
          {tab === 'live' && chain && (
            <div
              className={cn(
                'flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-xs font-bold transition-all',
                chain.feed.includes('STALE')
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                  : chain.feed.includes('LIVE')
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                  : 'border-zinc-800 bg-zinc-900 text-zinc-400',
              )}
              title={chain.feed}
            >
              <span
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  chain.feed.includes('STALE')
                    ? 'animate-pulse bg-amber-400'
                    : chain.feed.includes('LIVE')
                    ? 'animate-ping bg-emerald-400'
                    : 'bg-zinc-500',
                )}
              />
              <span>{chain.feed}</span>
            </div>
          )}

          {/* NIFTY Live Chip */}
          <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs">
            <span className="text-[10px] font-bold uppercase tracking-wider text-sky-400">NIFTY</span>
            <span className="font-mono font-bold text-white">
              {niftyLtp != null ? niftyLtp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
            </span>
            {niftyChangePct != null && (
              <span
                className={cn('font-mono text-[11px] font-bold', niftyChangePct > 0 ? 'text-emerald-400' : niftyChangePct < 0 ? 'text-red-400' : 'text-zinc-400')}
                title={niftyPrevClose != null ? `Previous close: ${niftyPrevClose.toFixed(2)}` : undefined}
              >
                {niftyChangePct > 0 ? '▲' : niftyChangePct < 0 ? '▼' : ''} {niftyChangePct > 0 ? `+${niftyChangePct.toFixed(2)}%` : `${niftyChangePct.toFixed(2)}%`}
              </span>
            )}
          </div>

          {/* India VIX Live Chip */}
          <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs">
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400">INDIA VIX</span>
            <span className="font-mono font-bold text-white">{vixLtp != null ? vixLtp.toFixed(2) : '—'}</span>
            {vixChangePct != null && (
              <span
                className={cn('font-mono text-[11px] font-bold', vixChangePct > 0 ? 'text-amber-400' : 'text-sky-400')}
                title={vixPrevClose != null ? `Yesterday close: ₹${vixPrevClose.toFixed(2)}` : undefined}
              >
                {vixChangePct > 0 ? '▲' : vixChangePct < 0 ? '▼' : ''} {vixChangePct > 0 ? `+${vixChangePct.toFixed(2)}%` : `${vixChangePct.toFixed(2)}%`}
              </span>
            )}
          </div>

          {/* DATA Chip */}
          <div className="flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-bold tracking-wider text-amber-400">
            <span>DATA: {istDate()}</span>
          </div>

          {/* Rules Button */}
          <button
            type="button"
            onClick={() => setRulesOpen(true)}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-xs font-bold text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-800 hover:text-white"
          >
            <Settings className="h-3.5 w-3.5 text-amber-400" />
            <span>RULES</span>
          </button>

          <span className="h-5 w-px shrink-0 bg-zinc-800" />
          <NavBar />
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[1720px] flex-1 flex-col gap-4 px-6 py-5">
        <p className="text-xs text-zinc-400">
          <span className="font-bold text-zinc-200">{def.label}</span> · {def.description}{' '}
          <span className="text-zinc-500">Spec: {def.docPath}</span>
        </p>

        {/* Live stays mounted on the Backtest tab so a running engine keeps managing its positions. */}
        <div className={tab === 'live' ? 'block' : 'hidden'}>
          {loaded ? (
            <LiveEngine
              key={def.key}
              def={def}
              state={state}
              mutate={mutate}
              broker={broker as 'dhan' | 'kotak'}
              brokerLoaded={brokerLoaded}
              viewerId={viewerId}
              onOpenRules={() => setRulesOpen(true)}
              onChainLock={onChainLock}
              vixLtp={vixLtp}
              vixChangePct={vixChangePct}
              vixPrevClose={vixPrevClose}
            />
          ) : (
            <p className="py-10 text-center text-xs text-zinc-500">Loading the {def.label} ledger…</p>
          )}
        </div>

        {tab === 'backtest' && <BacktestPanel key={def.key} def={def} fields={fields} onOpenRules={() => setRulesOpen(true)} />}
      </div>

      <RulesDrawer
        open={rulesOpen}
        onClose={() => setRulesOpen(false)}
        title={def.label}
        strategyKey={def.key}
        fields={fields}
        config={state.config}
        defaults={defaults}
        mode={state.mode}
        realAllowed={broker === 'dhan' || broker === 'kotak'}
        onPatch={(patch) => void mutate({ op: 'setConfig', config: patch })}
        onSetMode={(m) => void mutate({ op: 'setMode', mode: m })}
        onResetSim={() => void mutate({ op: 'resetSim' })}
      />
    </div>
  );
}
