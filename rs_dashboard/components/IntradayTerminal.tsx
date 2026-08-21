'use client';

/**
 * Intraday Terminal — ops surface for strategies/intraday_equity/nifty50_vwap_rs.py.
 *
 * This file owns polling, the strategy control plane and layout only; every
 * panel lives in IntradayTerminalPanels.tsx and every derived number in
 * lib/terminalIntel.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, Play, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import NavBar from './NavBar';
import {
  STRATEGY_KEY,
  type CandlePayload, type TerminalCandidate, type TerminalPayload, type TerminalState,
} from '@/lib/terminalTypes';
import {
  gateBlockers, health, nearMiss, nearMissSymbols, regime, sectorHeat,
  sessionClock, tradeStats, vwapBps,
} from '@/lib/terminalIntel';
import {
  BlotterControls, BlotterTable, EquityCurve, GateBlockerPanel, IntelRibbon, LogFeed,
  MiniChart, NearMissPanel, Panel, PositionsTable, RiskGauges, SectorHeatPanel,
  Segmented, Stat, fmt, fmtInr, type SortKey,
} from './IntradayTerminalPanels';

const POLL_MS = 3000;
const FLASH_MS = 600;
const STALE_MS = 15000;

const INTERVALS = [{ value: '1' as const, label: '1m' }, { value: '5' as const, label: '5m' }];

export default function IntradayTerminal() {
  const [payload, setPayload] = useState<TerminalPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastTick, setLastTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [candles, setCandles] = useState<CandlePayload | null>(null);
  const [interval, setIntervalPref] = useState<'1' | '5'>('1');
  const [busy, setBusy] = useState(false);

  const prevLtp = useRef<Record<string, number>>({});
  const [flash, setFlash] = useState<Record<string, 'up' | 'down'>>({});

  // ── Poll ──────────────────────────────────────────────────────────────
  const poll = useCallback(async () => {
    try {
      const r = await fetch('/api/intraday-terminal', { cache: 'no-store' });
      const j: TerminalPayload = await r.json();
      setPayload(j);
      setErr(j.success ? null : (j.error ?? 'request failed'));
      setLastTick(Date.now());

      const next: Record<string, 'up' | 'down'> = {};
      for (const c of j.state?.candidates ?? []) {
        const prev = prevLtp.current[c.symbol];
        if (prev !== undefined && c.ltp && c.ltp !== prev) {
          next[c.symbol] = c.ltp > prev ? 'up' : 'down';
        }
        if (c.ltp) prevLtp.current[c.symbol] = c.ltp;
      }
      if (Object.keys(next).length) {
        setFlash(next);
        setTimeout(() => setFlash({}), FLASH_MS);
      }
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(id); clearInterval(clock); };
  }, [poll]);

  // ── Candles for the selected symbol ───────────────────────────────────
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/intraday-candles?symbol=${encodeURIComponent(selected)}&interval=${interval}`,
          { cache: 'no-store' });
        const j: CandlePayload = await r.json();
        if (!cancelled) setCandles(j);
      } catch { /* transient — the next tick retries */ }
    };
    load();
    const id = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, [selected, interval]);

  // Rendered off the payload's own symbol rather than cleared in the effect:
  // clearing there is a synchronous setState-in-effect, and this also stops the
  // previous symbol's bars flashing up for one tick after a new selection.
  const shownCandles = candles && candles.symbol === selected ? candles : null;

  const state: TerminalState | null = payload?.state ?? null;
  const running = !!payload?.running;
  const staleMs = lastTick > 0 ? now - lastTick : 0;
  const stale = lastTick > 0 && staleMs > STALE_MS;

  const control = async (action: 'start' | 'stop') => {
    setBusy(true);
    try {
      // Reuses the existing strategy control plane rather than adding a second
      // way to start a process — /api/strategies owns spawn + PID bookkeeping.
      await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, strategy: STRATEGY_KEY, args: [] }),
      });
      setTimeout(poll, 800);
    } finally {
      setBusy(false);
    }
  };

  // ── Derived intelligence ──────────────────────────────────────────────
  const intel = useMemo(() => ({
    regime: regime(state),
    blockers: gateBlockers(state),
    near: nearMiss(state),
    nearSet: nearMissSymbols(state),
    sectors: sectorHeat(state),
    stats: tradeStats(payload?.orders ?? []),
  }), [state, payload?.orders]);

  // Minute-resolution so the session clock does not recompute every second tick.
  const nowMins = useMemo(() => {
    const d = new Date(now);
    return d.getHours() * 60 + d.getMinutes();
  }, [now]);
  const clock = useMemo(() => sessionClock(state, nowMins), [state, nowMins]);
  // `stale` rather than the raw age: the clock ticks every second but the
  // verdict only changes when it crosses the staleness line.
  const feedHealth = useMemo(() => health(state, running, stale), [state, running, stale]);

  // ── Blotter rows ──────────────────────────────────────────────────────
  const rows = useMemo(() => {
    const list = [...(state?.candidates ?? [])];
    const cmp: Record<SortKey, (a: TerminalCandidate, b: TerminalCandidate) => number> = {
      score: (a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol),
      symbol: (a, b) => a.symbol.localeCompare(b.symbol),
      ltp: (a, b) => (b.ltp || 0) - (a.ltp || 0),
      sector: (a, b) => a.sector.localeCompare(b.sector) || b.score - a.score,
      vwap_bps: (a, b) => vwapBps(b) - vwapBps(a),
    };
    list.sort(cmp[sortKey]);
    // Tradeable names pin to the top regardless of sort: this is a trading
    // surface, and what can fire matters more than the sort column.
    list.sort((a, b) => Number(b.gated) - Number(a.gated));
    return showAll ? list : list.slice(0, 18);
  }, [state?.candidates, sortKey, showAll]);

  const dayPnl = state?.pnl.day ?? 0;
  const equity = (state?.equity_curve ?? []).map((p) => ({ ts: p.ts, pnl: p.day_pnl }));
  const selectedPosition = state?.positions.find((p) => p.symbol === selected) ?? null;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-6 py-3">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25 shrink-0">
              <Activity className="h-[15px] w-[15px] text-emerald-400" />
            </div>
            <div>
              <p className="text-[9px] font-bold text-emerald-500 uppercase tracking-[0.18em] mb-0.5">
                Algo · Nifty 50 Cash
              </p>
              <h1 className="text-sm font-bold text-white tracking-tight leading-none">Intraday Terminal</h1>
              <p className="text-[10px] text-zinc-500 font-medium mt-1">
                VWAP + relative-strength auto-trader — signal book, risk and execution
              </p>
            </div>
          </div>

          <NavBar />

          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <span className={cn('px-2 py-1 rounded-lg text-[10px] font-bold border',
              state?.dry_run === false
                ? 'bg-red-500/10 border-red-500/30 text-red-400'
                : 'bg-zinc-900 border-zinc-800 text-zinc-400')}>
              {state?.dry_run === false ? 'LIVE' : 'DRY RUN'}
            </span>

            <span className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-[10px] font-bold">
              <span className={cn('h-1.5 w-1.5 rounded-full',
                stale ? 'bg-amber-400' : running ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600')} />
              <span className={stale ? 'text-amber-400' : running ? 'text-emerald-400' : 'text-zinc-400'}>
                {stale ? 'STALE' : running ? (state?.status ?? 'RUNNING') : 'STOPPED'}
              </span>
            </span>

            {payload?.store?.last && (
              <span
                className="font-mono text-[10px] bg-zinc-900 text-zinc-400 px-2 py-1 rounded-lg border border-zinc-800"
                title={`${payload.store.symbols} symbols · shallowest history ${payload.store.sessions} sessions`}
              >
                DATA: {payload.store.last}
              </span>
            )}

            <button
              onClick={() => control('start')}
              disabled={busy || running}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-900 disabled:text-zinc-600 disabled:border disabled:border-zinc-800 text-oncolor text-[11px] font-bold"
            >
              <Play className="h-3 w-3" /> Start
            </button>
            <button
              onClick={() => control('stop')}
              disabled={busy || !running}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 disabled:text-zinc-600 text-zinc-200 text-[11px] font-bold"
            >
              <Square className="h-3 w-3" /> Stop
            </button>
          </div>
        </div>

        {/* KPI strip — one cohesive header block rather than a second bar. */}
        <div className="mt-2.5 pt-2.5 border-t border-zinc-800/60 flex items-center gap-6 flex-wrap">
          <Stat label="Day P&L" value={fmtInr(dayPnl)}
                tone={dayPnl > 0 ? 'up' : dayPnl < 0 ? 'down' : 'neutral'} />
          <Stat label="Realised" value={fmtInr(state?.pnl.realized ?? 0)}
                tone={(state?.pnl.realized ?? 0) >= 0 ? 'up' : 'down'} />
          <Stat label="Unrealised" value={fmtInr(state?.pnl.unrealized ?? 0)}
                tone={(state?.pnl.unrealized ?? 0) >= 0 ? 'up' : 'down'} />
          <Stat label="Positions" value={`${state?.risk.open ?? 0}/${state?.risk.max_positions ?? 0}`} />
          <Stat label="Trades" value={`${state?.risk.trades_today ?? 0}/${state?.risk.max_trades ?? 0}`} />
          <Stat label="Deployed" value={fmtInr(state?.risk.deployed ?? 0)}
                hint={`Cap ${fmtInr(state?.risk.max_deployed ?? 0)}`} />
          <Stat label="Risk / trade" value={fmtInr(state?.risk.risk_per_trade ?? 0)} />
          <Stat
            label={state?.benchmark.symbol ?? 'NIFTY'}
            value={`${fmt(state?.benchmark.ltp, 1)} (${fmt(state?.benchmark.day_pct, 2)}%)`}
            tone={(state?.benchmark.day_pct ?? 0) >= 0 ? 'up' : 'down'}
          />
          <Stat label="Tradeable now" value={intel.regime ? `${intel.regime.tradeable}/${intel.regime.universe}` : '—'}
                tone={(intel.regime?.tradeable ?? 0) > 0 ? 'up' : 'neutral'} />
        </div>

        {/* Standing warning: this is the single most important thing on the page. */}
        {state && !state.backtest_validated && (
          <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-1.5">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
            <span className="text-[11px] text-amber-300">
              Rule set is <strong>not backtest-validated</strong>: best known config (5m/30m,
              VWAP exit off) returns −0.09R over 81 sessions — −0.09R even at zero cost —
              against a +0.15R gate. Dry run only;{' '}
              <code className="text-amber-200 font-mono">--live</code> requires an explicit acknowledgement flag.
            </span>
          </div>
        )}
        {state?.pnl.priced === false && (
          <div className="mt-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-1.5 text-[11px] text-amber-300">
            An open position has no live price — the daily risk check is paused rather than acting on a partial mark.
          </div>
        )}
        {state?.halt_reason && (
          <div className="mt-2 rounded-lg bg-red-900/20 border border-red-700/40 px-3 py-1.5 text-[11px] text-red-400">
            HALTED: {state.halt_reason}
          </div>
        )}
        {err && (
          <div className="mt-2 rounded-lg bg-red-900/20 border border-red-700/40 px-3 py-1.5 text-[11px] text-red-400">
            {err}
          </div>
        )}
      </header>

      {!state ? (
        <div className="flex-1 grid place-items-center text-zinc-500 text-sm px-6">
          No state file yet — start the strategy to populate the terminal.
        </div>
      ) : (
        <main className="flex-1 grid grid-cols-12 gap-3 px-6 py-4 auto-rows-min">
          {/* ── Intelligence ribbon ──────────────────────────────────── */}
          <div className="col-span-12">
            <IntelRibbon
              regime={intel.regime}
              clock={clock}
              health={feedHealth}
              stats={intel.stats}
              dayPnl={dayPnl}
            />
          </div>

          {/* ── Signal blotter ───────────────────────────────────────── */}
          <Panel
            title="Signal Blotter"
            subtitle={`${state.candidates.filter((c) => c.gated).length} tradeable · ${intel.near.length} one gate away · ${state.candidates.length} scanned`}
            className="col-span-12 xl:col-span-7 max-h-[46vh]"
            right={
              <BlotterControls
                sortKey={sortKey}
                onSort={setSortKey}
                showAll={showAll}
                onToggleAll={() => setShowAll((v) => !v)}
                total={state.candidates.length}
              />
            }
          >
            <BlotterTable
              rows={rows}
              selected={selected}
              onSelect={setSelected}
              flash={flash}
              nearMiss={intel.nearSet}
            />
          </Panel>

          {/* ── Positions ────────────────────────────────────────────── */}
          <Panel
            title="Open Positions"
            subtitle={`${state.positions.length} of ${state.risk.max_positions} · max ${state.risk.max_per_sector} per sector`}
            className="col-span-12 xl:col-span-5 max-h-[46vh]"
          >
            <PositionsTable positions={state.positions} />
          </Panel>

          {/* ── Gate blockers ────────────────────────────────────────── */}
          <Panel
            title="Gate Blockers"
            subtitle="Why the book is not firing"
            className="col-span-12 md:col-span-6 xl:col-span-4 max-h-[38vh]"
          >
            <GateBlockerPanel blockers={intel.blockers} universe={state.candidates.length} />
          </Panel>

          {/* ── Chart ────────────────────────────────────────────────── */}
          <Panel
            title={selected ? `${selected} — ${interval}m` : 'Chart'}
            subtitle={selected
              ? (selectedPosition ? 'Open position — entry, stop and target overlaid' : 'VWAP overlay')
              : 'Select a symbol from the blotter'}
            className="col-span-12 xl:col-span-8 h-[38vh]"
            right={<Segmented options={INTERVALS} value={interval} onChange={setIntervalPref} />}
          >
            <MiniChart payload={shownCandles} position={selectedPosition} />
          </Panel>

          {/* ── Sector heat ──────────────────────────────────────────── */}
          <Panel
            title="Sector Heat"
            subtitle="Mean score · tradeable · open vs cap"
            className="col-span-12 md:col-span-6 xl:col-span-4 max-h-[38vh]"
          >
            <SectorHeatPanel rows={intel.sectors} cap={state.risk.max_per_sector} />
          </Panel>

          {/* ── One gate away ────────────────────────────────────────── */}
          <Panel
            title="One Gate Away"
            subtitle="Most likely to fire next"
            className="col-span-12 md:col-span-6 xl:col-span-4 max-h-[34vh]"
          >
            <NearMissPanel rows={intel.near} onSelect={setSelected} />
          </Panel>

          {/* ── Equity + risk budget ─────────────────────────────────── */}
          <Panel
            title="Day P&L Curve"
            subtitle="Realised, marked at each exit"
            className="col-span-12 md:col-span-6 xl:col-span-4 h-[34vh]"
          >
            <div className="p-3 h-full flex flex-col gap-3">
              <div className="flex-1 min-h-0"><EquityCurve data={equity} /></div>
              <RiskGauges risk={state.risk} />
            </div>
          </Panel>

          {/* ── Log ──────────────────────────────────────────────────── */}
          <Panel
            title="Order & Event Log"
            subtitle={`${payload?.orders?.length ?? 0} orders today`}
            className="col-span-12 max-h-64"
          >
            <LogFeed
              orders={payload?.orders ?? []}
              events={(state.events ?? []).slice().reverse()}
            />
          </Panel>
        </main>
      )}
    </div>
  );
}
