'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ChevronDown, ChevronUp, Play, Square, Zap,
} from 'lucide-react';
import {
  Area, AreaChart, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from 'recharts';
import { cn } from '@/lib/utils';
import {
  CONDITION_LABELS, CONDITION_NAMES, CONDITION_TOOLTIPS, HARD_GATES, STRATEGY_KEY,
  type CandlePayload, type ConditionName, type TerminalCandidate,
  type TerminalPayload, type TerminalState,
} from '@/lib/terminalTypes';

const POLL_MS = 3000;
const FLASH_MS = 600;
const STALE_MS = 15000;

type SortKey = 'score' | 'symbol' | 'ltp' | 'vwap_bps' | 'sector';

// ── Small shared bits ────────────────────────────────────────────────────────
const fmt = (n: number | null | undefined, d = 2) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(d);

const fmtInr = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? '—'
    : `${n < 0 ? '-' : ''}${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

function Panel({ title, right, children, className }: {
  title: string; right?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={cn('bg-zinc-900/60 border border-zinc-800/60 rounded-xl flex flex-col min-h-0', className)}>
      <header className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/60 shrink-0">
        <h2 className="text-xs font-bold text-white tracking-wide uppercase">{title}</h2>
        {right}
      </header>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </section>
  );
}

function Stat({ label, value, tone = 'neutral' }: {
  label: string; value: React.ReactNode; tone?: 'up' | 'down' | 'neutral' | 'warn';
}) {
  const toneCls = tone === 'up' ? 'text-emerald-400'
    : tone === 'down' ? 'text-red-400'
    : tone === 'warn' ? 'text-amber-400' : 'text-zinc-100';
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</span>
      <span className={cn('text-[13px] font-semibold tabular-nums', toneCls)}>{value}</span>
    </div>
  );
}

/** Eight pass/fail chips. Hard gates get a ring so a blocking failure is visible
 *  at a glance — a soft miss looks different from a gate that stops the trade. */
function ConditionStrip({ conds, blocked }: {
  conds: Record<ConditionName, boolean>; blocked: ConditionName[];
}) {
  return (
    <div className="flex gap-[3px]">
      {CONDITION_NAMES.map((name) => {
        const ok = !!conds?.[name];
        const isHard = HARD_GATES.includes(name);
        const isBlocking = blocked?.includes(name);
        return (
          <span
            key={name}
            title={`${CONDITION_TOOLTIPS[name]} — ${ok ? 'PASS' : 'FAIL'}`}
            className={cn(
              'inline-flex items-center justify-center w-[19px] h-[15px] rounded-[3px] text-[9px] font-bold tabular-nums',
              ok ? 'bg-emerald-500/15 text-emerald-400' : 'bg-zinc-800 text-zinc-600',
              isBlocking && 'bg-red-500/15 text-red-400 ring-1 ring-red-500/40',
              isHard && !isBlocking && 'ring-1 ring-zinc-700',
            )}
          >
            {CONDITION_LABELS[name]}
          </span>
        );
      })}
    </div>
  );
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="flex items-center gap-1.5">
      <span className="tabular-nums text-zinc-100 w-8 text-right">{score.toFixed(0)}</span>
      <span className="h-[4px] w-12 rounded-full bg-zinc-800 overflow-hidden">
        <span
          className={cn('block h-full rounded-full',
            pct >= 75 ? 'bg-emerald-500' : pct >= 60 ? 'bg-blue-500' : 'bg-zinc-600')}
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
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
    if (!selected) { setCandles(null); return; }
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

  const state: TerminalState | null = payload?.state ?? null;
  const running = !!payload?.running;
  const stale = lastTick > 0 && now - lastTick > STALE_MS;

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

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-100">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 border-b border-zinc-900 bg-zinc-950/90 backdrop-blur-md px-4 py-2">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="h-6 w-6 rounded-md bg-gradient-to-tr from-emerald-600 to-cyan-500 grid place-items-center">
              <Activity className="h-3.5 w-3.5 text-white" />
            </span>
            <span className="text-sm font-bold tracking-tight">INTRADAY TERMINAL</span>
          </div>

          <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-bold',
            state?.dry_run === false ? 'bg-red-500/15 text-red-400' : 'bg-zinc-800 text-zinc-300')}>
            {state?.dry_run === false ? 'LIVE' : 'DRY'}
          </span>

          <span className="flex items-center gap-1.5 text-[11px]">
            <span className={cn('h-1.5 w-1.5 rounded-full',
              stale ? 'bg-amber-400' : running ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600')} />
            <span className={stale ? 'text-amber-400' : 'text-zinc-400'}>
              {stale ? 'STALE' : running ? (state?.status ?? 'RUNNING') : 'STOPPED'}
            </span>
          </span>

          {payload?.store?.last && (
            <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 text-[10px] font-bold tabular-nums">
              DATA: {payload.store.last} · {payload.store.sessions}s
            </span>
          )}

          <div className="ml-auto flex items-center gap-5">
            <Stat label="Day P&L" value={fmtInr(dayPnl)}
                  tone={dayPnl > 0 ? 'up' : dayPnl < 0 ? 'down' : 'neutral'} />
            <Stat label="Pos" value={`${state?.risk.open ?? 0}/${state?.risk.max_positions ?? 0}`} />
            <Stat label="Trades" value={`${state?.risk.trades_today ?? 0}/${state?.risk.max_trades ?? 0}`} />
            <Stat label="Deployed" value={fmtInr(state?.risk.deployed ?? 0)} />
            <Stat label="NIFTY"
                  value={`${fmt(state?.benchmark.ltp, 1)} (${fmt(state?.benchmark.day_pct, 2)}%)`}
                  tone={(state?.benchmark.day_pct ?? 0) >= 0 ? 'up' : 'down'} />

            <div className="flex gap-1.5">
              <button
                onClick={() => control('start')}
                disabled={busy || running}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-oncolor text-[11px] font-semibold"
              >
                <Play className="h-3 w-3" /> Start
              </button>
              <button
                onClick={() => control('stop')}
                disabled={busy || !running}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:text-zinc-600 text-zinc-100 text-[11px] font-semibold"
              >
                <Square className="h-3 w-3" /> Stop
              </button>
            </div>
          </div>
        </div>

        {/* Standing warning: this is the single most important thing on the page. */}
        {state && !state.backtest_validated && (
          <div className="mt-1.5 flex items-center gap-2 rounded-md bg-amber-500/10 border border-amber-500/20 px-2 py-1">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
            <span className="text-[11px] text-amber-300">
              Rule set is <strong>not backtest-validated</strong>: best known config (5m/30m,
              VWAP exit off) returns −0.09R over 81 sessions — −0.09R even at zero cost —
              against a +0.15R gate. Dry run only;{' '}
              <code className="text-amber-200">--live</code> requires an explicit acknowledgement flag.
            </span>
          </div>
        )}
        {state?.pnl.priced === false && (
          <div className="mt-1.5 text-[11px] text-amber-400">
            An open position has no live price — the daily risk check is paused rather than acting on a partial mark.
          </div>
        )}
        {state?.halt_reason && (
          <div className="mt-1.5 text-[11px] text-red-400">HALTED: {state.halt_reason}</div>
        )}
        {err && <div className="mt-1.5 text-[11px] text-red-400">{err}</div>}
      </header>

      {!state ? (
        <div className="flex-1 grid place-items-center text-zinc-500 text-sm">
          No state file yet — start the strategy to populate the terminal.
        </div>
      ) : (
        <main className="flex-1 p-2 grid grid-cols-12 gap-2 auto-rows-min">
          {/* ── Signal blotter ───────────────────────────────────────── */}
          <Panel
            title={`Signal Blotter — ${state.candidates.filter((c) => c.gated).length} tradeable / ${state.candidates.length}`}
            className="col-span-12 xl:col-span-7 max-h-[52vh]"
            right={
              <div className="flex items-center gap-2">
                <select
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as SortKey)}
                  className="bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-200"
                >
                  <option value="score">Score</option>
                  <option value="symbol">Symbol</option>
                  <option value="ltp">LTP</option>
                  <option value="vwap_bps">vs VWAP</option>
                  <option value="sector">Sector</option>
                </select>
                <button onClick={() => setShowAll((v) => !v)}
                        className="inline-flex items-center gap-0.5 text-[10px] text-zinc-400 hover:text-zinc-200">
                  {showAll ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  {showAll ? 'Less' : 'All 50'}
                </button>
              </div>
            }
          >
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 z-10">
                <tr className="bg-zinc-800 text-xs font-bold text-white">
                  <th className="text-left px-2 py-1.5">#</th>
                  <th className="text-left px-2 py-1.5">Symbol</th>
                  <th className="text-left px-2 py-1.5">Score</th>
                  <th className="text-right px-2 py-1.5">LTP</th>
                  <th className="text-right px-2 py-1.5">vs VWAP</th>
                  <th className="text-right px-2 py-1.5">ATR</th>
                  <th className="text-left px-2 py-1.5">Sector</th>
                  <th className="text-left px-2 py-1.5">Conditions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c, i) => {
                  const bps = vwapBps(c);
                  const f = flash[c.symbol];
                  return (
                    <tr
                      key={c.symbol}
                      onClick={() => setSelected(c.symbol)}
                      className={cn(
                        'border-b border-zinc-800/40 cursor-pointer hover:bg-zinc-800/40',
                        !c.gated && 'opacity-55',
                        selected === c.symbol && 'bg-zinc-800/60',
                      )}
                    >
                      <td className="px-2 py-1 text-zinc-500 tabular-nums">{i + 1}</td>
                      <td className="px-2 py-1">
                        <span className="font-semibold text-zinc-100">{c.symbol}</span>
                        {c.gated && <span className="ml-1.5 text-[9px] font-bold text-emerald-400">●</span>}
                      </td>
                      <td className="px-2 py-1"><ScoreBar score={c.score} /></td>
                      <td className={cn('px-2 py-1 text-right tabular-nums',
                        f === 'up' ? 'bg-emerald-500/15 text-emerald-300'
                          : f === 'down' ? 'bg-red-500/15 text-red-300' : 'text-zinc-200')}>
                        {fmt(c.ltp)}
                      </td>
                      <td className={cn('px-2 py-1 text-right tabular-nums',
                        bps >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {bps >= 0 ? '+' : ''}{bps.toFixed(0)}bp
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-zinc-400">{fmt(c.atr, 2)}</td>
                      <td className="px-2 py-1 text-zinc-500">{c.sector}</td>
                      <td className="px-2 py-1">
                        <ConditionStrip conds={c.conditions} blocked={c.blocked_by} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>

          {/* ── Positions ────────────────────────────────────────────── */}
          <Panel title={`Open Positions — ${state.positions.length}`}
                 className="col-span-12 xl:col-span-5 max-h-[52vh]">
            {state.positions.length === 0 ? (
              <div className="p-6 text-center text-zinc-500 text-[11px]">No open positions</div>
            ) : (
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="bg-zinc-800 text-xs font-bold text-white">
                    <th className="text-left px-2 py-1.5">Symbol</th>
                    <th className="text-left px-2 py-1.5">Side</th>
                    <th className="text-right px-2 py-1.5">Qty</th>
                    <th className="text-right px-2 py-1.5">Entry</th>
                    <th className="text-right px-2 py-1.5">LTP</th>
                    <th className="text-right px-2 py-1.5">Stop</th>
                    <th className="text-right px-2 py-1.5">Target</th>
                    <th className="text-right px-2 py-1.5">R</th>
                    <th className="text-right px-2 py-1.5">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {state.positions.map((p) => (
                    <tr key={p.symbol} className="border-b border-zinc-800/40">
                      <td className="px-2 py-1 font-semibold">{p.symbol}</td>
                      <td className={cn('px-2 py-1 font-bold',
                        p.side === 'LONG' ? 'text-emerald-400' : 'text-red-400')}>{p.side}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{p.qty}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-zinc-400">{fmt(p.entry_price)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmt(p.ltp)}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-red-400">{fmt(p.stop)}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-emerald-400">{fmt(p.target)}</td>
                      <td className={cn('px-2 py-1 text-right tabular-nums',
                        p.r_multiple >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {p.r_multiple >= 0 ? '+' : ''}{fmt(p.r_multiple, 2)}R
                      </td>
                      <td className={cn('px-2 py-1 text-right tabular-nums font-semibold',
                        p.pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>{fmtInr(p.pnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          {/* ── Chart ────────────────────────────────────────────────── */}
          <Panel
            title={selected ? `${selected} — ${interval}m` : 'Chart — select a symbol'}
            className="col-span-12 xl:col-span-8 h-[34vh]"
            right={
              <div className="flex gap-1">
                {(['1', '5'] as const).map((iv) => (
                  <button key={iv} onClick={() => setIntervalPref(iv)}
                    className={cn('px-1.5 py-0.5 rounded text-[10px] font-semibold',
                      interval === iv ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}>
                    {iv}m
                  </button>
                ))}
              </div>
            }
          >
            <MiniChart payload={candles} />
          </Panel>

          {/* ── Equity + gauges ──────────────────────────────────────── */}
          <Panel title="Day P&L Curve" className="col-span-12 xl:col-span-4 h-[34vh]">
            <div className="p-2 h-full flex flex-col gap-2">
              <div className="flex-1 min-h-0">
                {equity.length < 2 ? (
                  <div className="h-full grid place-items-center text-zinc-500 text-[11px]">
                    No closed trades yet
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={equity} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#10b981" stopOpacity={0.5} />
                          <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="ts" tick={{ fontSize: 9, fill: '#71717a' }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 9, fill: '#71717a' }} axisLine={false} tickLine={false} width={44} />
                      <ReferenceLine y={0} stroke="#52525b" strokeWidth={1} />
                      <RTooltip
                        contentStyle={{ background: '#18181b', border: '1px solid #3f3f46',
                          borderRadius: 8, fontSize: 11 }}
                        labelStyle={{ color: '#a1a1aa' }}
                      />
                      <Area type="monotone" dataKey="pnl" stroke="#10b981" strokeWidth={1.6} fill="url(#eq)" />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
              <Gauge label="Daily loss used" value={state.risk.daily_loss_used}
                     max={state.risk.max_daily_loss} tone="red" />
              <Gauge label="Capital deployed" value={state.risk.deployed}
                     max={state.risk.max_deployed} tone="blue" />
            </div>
          </Panel>

          {/* ── Log ──────────────────────────────────────────────────── */}
          <Panel title="Order & Event Log" className="col-span-12 max-h-56">
            <div className="font-mono text-[11px]">
              {(payload?.orders ?? []).map((o, i) => (
                <div key={`o${i}`} className="flex gap-3 px-3 py-0.5 border-b border-zinc-800/30">
                  <span className="text-zinc-500 tabular-nums w-16 shrink-0">{o.ts.slice(11, 19)}</span>
                  <span className={cn('w-12 shrink-0 font-bold',
                    o.kind === 'ENTRY' ? 'text-emerald-400' : 'text-amber-400')}>{o.kind}</span>
                  <span className="w-24 shrink-0 text-zinc-100">{o.symbol}</span>
                  <span className="text-zinc-400">
                    {o.side} {o.qty} @ {fmt(o.price)} {o.reason && `· ${o.reason}`}
                    {o.dry_run && <span className="ml-1 text-zinc-600">(dry)</span>}
                  </span>
                </div>
              ))}
              {(state.events ?? []).slice().reverse().map((e, i) => (
                <div key={`e${i}`} className="flex gap-3 px-3 py-0.5 border-b border-zinc-800/30">
                  <span className="text-zinc-500 tabular-nums w-16 shrink-0">{e.ts}</span>
                  <span className={cn('w-12 shrink-0 font-bold',
                    e.level === 'ERROR' ? 'text-red-400'
                      : e.level === 'WARN' ? 'text-amber-400' : 'text-zinc-500')}>{e.type}</span>
                  <span className="w-24 shrink-0 text-zinc-300">{e.symbol || '—'}</span>
                  <span className="text-zinc-400">{e.msg}</span>
                </div>
              ))}
              {!payload?.orders?.length && !state.events?.length && (
                <div className="p-6 text-center text-zinc-500">No activity yet</div>
              )}
            </div>
          </Panel>
        </main>
      )}
    </div>
  );
}

function vwapBps(c: TerminalCandidate): number {
  if (!c.vwap || !c.price) return 0;
  return ((c.price - c.vwap) / c.vwap) * 10000;
}

function Gauge({ label, value, max, tone }: {
  label: string; value: number; max: number; tone: 'red' | 'blue';
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="shrink-0">
      <div className="flex justify-between text-[10px] mb-0.5">
        <span className="text-zinc-500">{label}</span>
        <span className="tabular-nums text-zinc-300">
          {fmtInr(value)} / {fmtInr(max)}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <div className={cn('h-full rounded-full',
          tone === 'red' ? (pct > 75 ? 'bg-red-500' : 'bg-amber-500') : 'bg-blue-500')}
          style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Lightweight inline candles — no chart library, so the panel adds no bundle weight. */
function MiniChart({ payload }: { payload: CandlePayload | null }) {
  if (!payload) {
    return <div className="h-full grid place-items-center text-zinc-500 text-[11px]">
      Select a symbol from the blotter
    </div>;
  }
  const bars = payload.bars ?? [];
  if (!bars.length) {
    return <div className="h-full grid place-items-center text-zinc-500 text-[11px]">
      {payload.error ?? 'No bars available'}
    </div>;
  }

  const show = bars.slice(-140);
  const hi = Math.max(...show.map((b) => b.h));
  const lo = Math.min(...show.map((b) => b.l));
  const span = hi - lo || 1;
  const W = 1000, H = 260, pad = 6;
  const bw = (W - pad * 2) / show.length;
  const y = (v: number) => pad + (1 - (v - lo) / span) * (H - pad * 2);

  const last = show[show.length - 1];
  const first = show[0];
  const up = last.c >= first.o;

  return (
    <div className="h-full flex flex-col">
      <div className="flex gap-4 px-3 py-1 text-[10px] tabular-nums border-b border-zinc-800/40">
        <span className="text-zinc-500">O <span className="text-zinc-300">{fmt(last.o)}</span></span>
        <span className="text-zinc-500">H <span className="text-zinc-300">{fmt(last.h)}</span></span>
        <span className="text-zinc-500">L <span className="text-zinc-300">{fmt(last.l)}</span></span>
        <span className="text-zinc-500">C <span className={up ? 'text-emerald-400' : 'text-red-400'}>{fmt(last.c)}</span></span>
        <span className="ml-auto text-zinc-600">{show.length} bars · {payload.interval}m</span>
      </div>
      <div className="flex-1 min-h-0">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-full">
          {show.map((b, i) => {
            const x = pad + i * bw + bw / 2;
            const green = b.c >= b.o;
            const col = green ? '#34d399' : '#f87171';
            const yO = y(b.o), yC = y(b.c);
            return (
              <g key={i}>
                <line x1={x} x2={x} y1={y(b.h)} y2={y(b.l)} stroke={col} strokeWidth={1} />
                <rect x={x - Math.max(bw * 0.3, 0.8)} width={Math.max(bw * 0.6, 1.6)}
                      y={Math.min(yO, yC)} height={Math.max(Math.abs(yC - yO), 1)} fill={col} />
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
