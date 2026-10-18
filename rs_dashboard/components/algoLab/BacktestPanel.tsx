'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, ChevronDown, ChevronRight, Download, FlaskConical, Play, RefreshCw, Settings, ShieldCheck, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { summarize, type BtWindow } from '@/lib/algoLab/runStore';
import type { BtAudit } from '@/lib/algoLab/audit';
import type { DayResult } from '@/lib/algoLab/simulator';
import type { AlgoConfig, ConfigField, StrategyDefinition } from '@/lib/algoLab/types';
import { AuditReport } from './AuditReport';
import { exitLabel, exitTone, fmtCell, inr, pnlTone, px } from './format';

interface RunStatus {
  state: 'running' | 'starting' | 'done' | 'error' | 'stopped' | 'interrupted';
  total?: number;
  done?: number;
  message?: string;
  finishedAt?: string | null;
}

interface BacktestResponse {
  success: boolean;
  unchanged?: boolean;
  running: boolean;
  status: RunStatus | null;
  dbRange: { earliest: string; latest: string } | null;
  missing: string[];
  configKey: string;
  rulesChanged: boolean;
  store: {
    from: string;
    to: string | null;
    window: BtWindow;
    updatedAt: string | null;
    config: AlgoConfig;
    failures: Record<string, { at: string; error: string }>;
    audit: BtAudit | null;
    days: DayResult[] | null;
  } | null;
}

const WINDOW_LABEL: Record<BtWindow, string> = {
  db4: 'Latest 4 weeks',
  week: '1 week',
  month: '1 month',
  '3months': '3 months',
  '6months': '6 months',
  '1year': '1 year',
  all: 'All data in the options DB',
  custom: 'Custom range…',
};
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;

function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: { full: string; net: number; cum: number; trades: number } }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-bold text-white">{p.full}</p>
      <p className="text-zinc-400">
        Day net <span className={cn('font-mono font-bold', pnlTone(p.net))}>{inr(p.net)}</span>
      </p>
      <p className="text-zinc-400">
        Cumulative <span className={cn('font-mono font-bold', pnlTone(p.cum))}>{inr(p.cum)}</span>
      </p>
      <p className="text-zinc-500">{p.trades} trade(s)</p>
    </div>
  );
}

const cacheKey = (k: string) => `algoLab.${k}.backtestDays`;
function readCache(k: string): { stamp: string; days: DayResult[] } | null {
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey(k)) ?? 'null') as { stamp?: unknown; days?: unknown } | null;
    return c && typeof c.stamp === 'string' && Array.isArray(c.days) ? { stamp: c.stamp, days: c.days as DayResult[] } : null;
  } catch {
    return null;
  }
}
function writeCache(k: string, stamp: string | null, days: DayResult[]) {
  try {
    if (stamp) localStorage.setItem(cacheKey(k), JSON.stringify({ stamp, days }));
    else localStorage.removeItem(cacheKey(k));
  } catch {
    /* storage full or blocked: the next poll downloads again */
  }
}

function fmtValue(f: ConfigField, v: unknown): string {
  if (f.kind === 'boolean') return v ? 'on' : 'off';
  if (f.kind === 'select') return f.options.find((o) => String(o.value) === String(v))?.label ?? String(v);
  if (f.kind === 'number' && f.unit) return f.unit === '₹' ? `₹${Number(v).toLocaleString('en-IN')}` : `${v} ${f.unit}`;
  return String(v);
}

export function BacktestPanel({
  def,
  fields,
  onOpenRules,
}: {
  def: StrategyDefinition;
  fields: ConfigField[];
  onOpenRules: () => void;
}) {
  const api = `/api/algo-lab/${def.key}/backtest`;
  const [data, setData] = useState<BacktestResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [days, setDays] = useState<DayResult[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [logOpen, setLogOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [win, setWin] = useState<BtWindow>('db4');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [weekdays, setWeekdays] = useState<Set<string>>(() => new Set(WEEKDAYS));
  const [busy, setBusy] = useState(false);
  const stamp = useRef<string | null>(null);
  const seq = useRef(0);
  const cacheRead = useRef(false);
  const autoStarted = useRef(false);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    if (!cacheRead.current) {
      cacheRead.current = true;
      const c = readCache(def.key);
      if (c) {
        stamp.current = c.stamp;
        setDays(c.days);
      }
    }
    try {
      const q = stamp.current ? `?known=${encodeURIComponent(stamp.current)}` : '';
      const j = (await (await fetch(`${api}${q}`, { cache: 'no-store' })).json()) as BacktestResponse;
      if (mine !== seq.current) return; // a newer poll is in flight
      if (!j.success) return setLoadError('Could not read backtest results');
      setData(j);
      setLoadError(null);
      if (!j.unchanged) {
        const next = j.store?.days ?? [];
        stamp.current = j.store?.updatedAt ?? null;
        setDays(next);
        writeCache(def.key, stamp.current, next);
      }
    } catch (e) {
      if (mine === seq.current) setLoadError(String((e as Error).message ?? e));
    }
  }, [api, def.key]);

  const post = useCallback(
    async (body: Record<string, string>) => {
      setBusy(true);
      try {
        await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } finally {
        setBusy(false);
        void load();
      }
    },
    [api, load],
  );

  const running = data?.running ?? false;
  useEffect(() => {
    const t0 = setTimeout(load, 0);
    const id = setInterval(load, running ? 4000 : 60_000);
    return () => {
      clearTimeout(t0);
      clearInterval(id);
    };
  }, [load, running]);

  // Catch-up once per visit: only when sessions are missing, nothing runs and the rules still match the results.
  useEffect(() => {
    if (!data || autoStarted.current || data.running || !data.store || data.rulesChanged || !data.missing.length) return;
    autoStarted.current = true;
    const t = setTimeout(() => void post({ action: 'catchup' }), 0);
    return () => clearTimeout(t);
  }, [data, post]);

  const rerun = () => {
    if (win === 'custom') {
      if (!from || !to || from > to) return setRangeError('Pick a start date on or before the end date.');
      setRangeError(null);
      if (confirm(`Rebuild the backtest from ${from} to ${to} with the current rules? Existing results are replaced.`)) {
        void post({ action: 'rerun', window: 'custom', from, to });
      }
      return;
    }
    if (confirm(`Rebuild the backtest for "${WINDOW_LABEL[win]}" with the current rules? Existing results are replaced.`)) {
      void post({ action: 'rerun', window: win });
    }
  };

  const weekdayCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const d of days) c[d.weekday] = (c[d.weekday] ?? 0) + 1;
    return c;
  }, [days]);
  const coldDays = useMemo(() => {
    const c: Record<string, number> = {};
    for (const d of days) if (d.warmupSessions != null && d.warmupSessions < 1) c[d.weekday] = (c[d.weekday] ?? 0) + 1;
    return c;
  }, [days]);
  const shown = useMemo(() => days.filter((d) => weekdays.has(d.weekday)), [days, weekdays]);
  const summary = useMemo(() => summarize(shown), [shown]);
  const chart = useMemo(
    () =>
      [...shown]
        .sort((a, b) => a.date.localeCompare(b.date))
        .reduce<{ date: string; full: string; net: number; cum: number; trades: number }[]>((acc, d) => {
          const prev = acc.length ? acc[acc.length - 1].cum : 0;
          acc.push({ date: d.date.slice(5), full: d.date, net: d.net, cum: Math.round((prev + d.net) * 100) / 100, trades: d.trades.length });
          return acc;
        }, []),
    [shown],
  );
  const cumByDate = useMemo(() => new Map(chart.map((c) => [c.full, c.cum])), [chart]);
  const allExpanded = shown.length > 0 && shown.every((d) => expanded.has(d.date));
  const storeCfg = data?.store?.config;
  const status = data?.status;
  const failures = Object.entries(data?.store?.failures ?? {});
  const stratCols = def.columns.scanner;
  const colCount = 17 + stratCols.length;

  const exportCsv = () => {
    const head = ['date', 'weekday', 'expiry', 'n', 'contract', 'side', 'entry_time', 'decision', 'entry', 'exit_time', 'exit', 'qty', 'hold_min', 'exit_kind', 'exit_reason', 'gross', 'costs', 'net', 'initial_stop', 'target', 'stop_at_exit', 'best', 'max_adverse', 'score', 'bias', 'warmup_bars', ...stratCols.map((c) => c.key)];
    const q = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [...shown]
      .sort((a, b) => a.date.localeCompare(b.date))
      .flatMap((d) =>
        d.trades.map((t) =>
          [d.date, d.weekday, d.expiry, t.n, t.contract, t.side, t.entryTime, t.decisionPrice, t.entryPrice, t.exitTime, t.exitPrice, t.qty, t.holdMin, t.exitKind, t.exitReason, t.gross, t.costs, t.net, t.initialStop, t.target, t.stopAtExit, t.best, t.maxAdverse, t.score, t.bias, t.warmupBars, ...stratCols.map((c) => t.cols[c.key])]
            .map(q)
            .join(','),
        ),
      );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([[head.join(','), ...rows].join('\n')], { type: 'text/csv' }));
    a.download = `${def.key}_backtest_${chart[0]?.full ?? 'x'}_${chart[chart.length - 1]?.full ?? 'x'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const btn = 'flex h-7 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 text-xs font-bold text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-50';

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-violet-500/25 bg-violet-500/10">
            <FlaskConical className="h-3.5 w-3.5 text-violet-400" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-violet-400">Offline backtest · NIFTY · options DB</p>
            <h2 className="text-sm font-bold text-white">
              {def.label} {data?.store ? `· ${data.store.from} → ${data.store.to ?? 'today'}` : ''}
            </h2>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <button type="button" onClick={() => void post({ action: 'stop' })} disabled={busy} className="flex h-7 items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 text-xs font-bold text-red-400 hover:bg-red-500/20 disabled:opacity-50">
              <Square className="h-3 w-3" /> Stop
            </button>
          ) : (
            <>
              {data?.store && (
                <button type="button" onClick={() => void post({ action: 'catchup' })} disabled={busy || data.rulesChanged || !data.missing.length} title={data.rulesChanged ? 'Rules changed: use Re-run' : 'Backtest the sessions not yet in the results'} className={btn}>
                  <Play className="h-3 w-3 text-emerald-400" /> Run missing
                </button>
              )}
              <select value={win} onChange={(e) => setWin(e.target.value as BtWindow)} aria-label="Backtest window" className="h-7 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-xs font-bold text-zinc-300 focus:outline-none">
                {(Object.keys(WINDOW_LABEL) as BtWindow[]).map((w) => (
                  <option key={w} value={w}>
                    {WINDOW_LABEL[w]}
                  </option>
                ))}
              </select>
              {win === 'custom' && (
                <span className="flex items-center gap-1.5 text-xs">
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} min={data?.dbRange?.earliest} max={data?.dbRange?.latest} aria-label="Start date" className="h-7 rounded border border-zinc-700 bg-zinc-950 px-1.5 font-mono text-xs text-zinc-200" />
                  <span className="text-zinc-500">→</span>
                  <input type="date" value={to} onChange={(e) => setTo(e.target.value)} min={data?.dbRange?.earliest} max={data?.dbRange?.latest} aria-label="End date" className="h-7 rounded border border-zinc-700 bg-zinc-950 px-1.5 font-mono text-xs text-zinc-200" />
                </span>
              )}
              <button type="button" onClick={rerun} disabled={busy} className={btn}>
                <RefreshCw className={cn('h-3 w-3 text-sky-400', busy && 'animate-spin')} /> {data?.store ? 'Re-run' : 'Run backtest'}
              </button>
            </>
          )}
          <button type="button" onClick={exportCsv} disabled={!summary.trades} className={btn}>
            <Download className="h-3 w-3" /> CSV
          </button>
          <button
            type="button"
            onClick={() => {
              setAuditOpen(true);
              setTimeout(() => document.getElementById('algo-lab-audit')?.scrollIntoView({ behavior: 'smooth' }), 50);
            }}
            className="flex h-7 items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 text-xs font-bold text-emerald-400 hover:bg-emerald-500/20"
          >
            <ShieldCheck className="h-3.5 w-3.5" /> Audit
          </button>
          <button type="button" onClick={onOpenRules} className={btn}>
            <Settings className="h-3 w-3 text-amber-400" /> Rules
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2 px-4 pt-3">
        {rangeError && <p className="text-xs text-red-400">{rangeError}</p>}
        {status && (
          <div
            role="status"
            className={cn(
              'flex flex-col gap-2 rounded-lg border px-3 py-2 text-xs',
              running ? 'border-sky-500/30 bg-sky-500/10 text-sky-400' : status.state === 'error' || status.state === 'interrupted' ? 'border-amber-500/30 bg-amber-500/10 text-amber-400' : 'border-zinc-800 bg-zinc-900 text-zinc-400',
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              {running && <RefreshCw className="h-3 w-3 animate-spin" />}
              <span className="font-bold uppercase">{running ? 'Running' : status.state}</span>
              {running && status.total ? (
                <span className="font-mono">
                  {status.done ?? 0}/{status.total} sessions
                </span>
              ) : null}
              <span className="text-zinc-300">{status.message}</span>
              {!running && status.finishedAt && <span className="text-zinc-500">· {new Date(status.finishedAt).toLocaleString('en-IN')}</span>}
            </div>
            {running && status.total ? (
              <div className="h-1.5 overflow-hidden rounded-full border border-sky-500/20 bg-zinc-950">
                <div className="h-full bg-sky-400 transition-all duration-300" style={{ width: `${Math.min(100, Math.round(((status.done ?? 0) / status.total) * 100))}%` }} />
              </div>
            ) : null}
          </div>
        )}
        {data?.rulesChanged && (
          <div role="alert" className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            The rules changed since these results were built; appends are paused so every day stays comparable. Press Re-run to rebuild.
          </div>
        )}
        {!data?.store && !running && data && (
          <p className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-4 text-center text-xs text-zinc-400">
            No backtest yet. Pick a window and press <span className="font-bold text-zinc-200">Run backtest</span> — it replays the options DB
            {data.dbRange ? ` (${data.dbRange.earliest} → ${data.dbRange.latest})` : ''} through this strategy&apos;s rules.
          </p>
        )}
        {failures.length > 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
            <span className="font-bold text-amber-400">Unavailable sessions: </span>
            {failures.slice(0, 10).map(([d, f]) => (
              <span key={d} className="mr-3" title={f.error}>
                {d}
              </span>
            ))}
          </div>
        )}
        {loadError && <div className="text-xs text-red-400">{loadError}</div>}
        {storeCfg && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
            <span className="font-bold text-zinc-400">Rules backtested:</span>
            {fields.map((f) => (
              <span key={f.key}>
                {f.label} <span className="font-mono text-zinc-300">{fmtValue(f, storeCfg[f.key])}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {days.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2.5 border-b border-zinc-800 px-4 py-2.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Weekdays</span>
            <div className="inline-flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950/70 p-1">
              {WEEKDAYS.map((wd) => {
                const on = weekdays.has(wd);
                const cold = coldDays[wd] ?? 0;
                return (
                  <button
                    key={wd}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setWeekdays((p) => {
                        const n = new Set(p);
                        if (n.has(wd)) n.delete(wd);
                        else n.add(wd);
                        return n;
                      })
                    }
                    title={cold ? `${cold} session(s) without previous-day warm-up` : undefined}
                    className={cn('flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-bold', on ? 'bg-violet-600 text-oncolor hover:bg-violet-500' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200')}
                  >
                    {wd}
                    {cold > 0 && <span className="text-[10px] text-amber-400">⚠</span>}
                    <span className={cn('rounded px-1 font-mono text-[10px]', on ? 'bg-violet-800 text-oncolor' : 'bg-zinc-800 text-zinc-400')}>{weekdayCounts[wd] ?? 0}</span>
                  </button>
                );
              })}
            </div>
            {weekdays.size < WEEKDAYS.length && (
              <span className="text-[11px] text-zinc-400">
                Showing {shown.length} of {days.length} sessions
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 px-4 py-3 sm:grid-cols-4 xl:grid-cols-8">
            {[
              ['Net P&L (after costs)', inr(summary.net), pnlTone(summary.net)],
              ['Gross / Costs', `${inr(summary.gross)} / ${inr(summary.costs, false)}`, 'text-zinc-200'],
              ['Sessions / with trades', `${summary.days} / ${summary.tradingDays}`, 'text-zinc-200'],
              ['Trades / Win rate', `${summary.trades} / ${summary.winRate == null ? '—' : `${summary.winRate.toFixed(0)}%`}`, 'text-zinc-200'],
              ['Avg per day / trade', `${inr(summary.avgPerDay)} / ${inr(summary.avgPerTrade)}`, pnlTone(summary.avgPerDay)],
              ['Avg win / loss', `${inr(summary.avgWin)} / ${inr(summary.avgLoss)}`, 'text-zinc-200'],
              ['Max drawdown', inr(summary.maxDrawdown), summary.maxDrawdown < 0 ? 'text-red-400' : 'text-zinc-400'],
              ['Profit factor', summary.profitFactor == null ? '—' : summary.profitFactor.toFixed(2), 'text-zinc-200'],
            ].map(([label, value, tone]) => (
              <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">{label}</p>
                <p className={cn('mt-1 font-mono text-sm font-bold tabular-nums', tone)}>{value}</p>
              </div>
            ))}
          </div>
          {summary.trades > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pb-1 text-[11px]">
              <span className="text-zinc-500">Exits:</span>
              {Object.entries(summary.exitMix).map(([k, n]) => (
                <span key={k} className={cn('rounded border px-1.5 py-0.5 font-bold', exitTone(k))}>
                  {exitLabel(k)} {n}
                </span>
              ))}
            </div>
          )}

          {chart.length > 0 && (
            <div className="px-4 pt-2">
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 6" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} width={64} tickFormatter={(v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--chart-cursor-fill)', opacity: 0.5 }} />
                  <ReferenceLine y={0} strokeDasharray="4 2" />
                  <Bar dataKey="net" maxBarSize={28} isAnimationActive={false}>
                    {chart.map((d) => (
                      <Cell key={d.full} fill={d.net >= 0 ? 'var(--color-emerald-500)' : 'var(--color-red-500)'} />
                    ))}
                  </Bar>
                  <Line dataKey="cum" type="monotone" stroke="var(--color-violet-400)" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
              <p className="text-center text-[10px] text-zinc-500">Bars: day net after costs · Line: cumulative net</p>
            </div>
          )}
        </>
      )}

      <div className="px-4 py-3">
        {days.length > 0 && (
          <div className="flex items-center justify-between">
            <button type="button" onClick={() => setLogOpen((o) => !o)} aria-expanded={logOpen} className="flex items-center gap-1.5 text-xs font-bold text-zinc-200 hover:text-white">
              {logOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              Day-wise trade log <span className="font-medium text-zinc-500">({shown.length} sessions, {summary.trades} trades)</span>
            </button>
            {logOpen && shown.length > 0 && (
              <button type="button" onClick={() => setExpanded(allExpanded ? new Set() : new Set(shown.map((d) => d.date)))} className="text-[11px] font-bold text-sky-400 hover:text-sky-300">
                {allExpanded ? 'Collapse all' : 'Expand all'}
              </button>
            )}
          </div>
        )}
        {logOpen && shown.length > 0 && (
          <div className="mt-2 overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full min-w-[1300px] text-left text-xs">
              <thead className="bg-zinc-800 text-xs font-bold text-white">
                <tr>
                  {['#', 'Contract', 'Entry', 'Entry ₹', 'Exit', 'Exit ₹', 'Qty', 'Hold', 'Exit type', 'Reason', 'Gross', 'Costs', 'Net', 'Init stop', 'Target', 'Best', 'Score', ...stratCols.map((c) => c.label)].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2.5 py-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {shown.map((d) => {
                  const open = expanded.has(d.date);
                  return (
                    <Fragment key={d.date}>
                      <tr
                        className="cursor-pointer bg-zinc-900 hover:bg-zinc-800/60"
                        onClick={() =>
                          setExpanded((s) => {
                            const n = new Set(s);
                            if (n.has(d.date)) n.delete(d.date);
                            else n.add(d.date);
                            return n;
                          })
                        }
                      >
                        <td colSpan={colCount} className="px-2.5 py-2">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                            <span className="flex items-center gap-1 font-bold text-white">
                              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                              {d.date} <span className="font-medium text-zinc-400">{d.weekday}</span>
                            </span>
                            <span className="text-zinc-400">
                              Expiry <span className="font-mono text-zinc-200">{d.expiry}</span> ({d.dte} DTE)
                            </span>
                            <span className="text-zinc-400">
                              Spot <span className="font-mono text-zinc-200">{px(d.spotOpen)} → {px(d.spotClose)}</span>
                            </span>
                            <span className="text-zinc-400">
                              Trades <span className="font-mono text-zinc-200">{d.trades.length}</span> ({d.wins}W/{d.losses}L)
                            </span>
                            <span className="text-zinc-400">
                              Net <span className={cn('font-mono font-bold', pnlTone(d.net))}>{inr(d.net)}</span>
                            </span>
                            <span className="text-zinc-400">
                              Cumulative <span className={cn('font-mono', pnlTone(cumByDate.get(d.date)))}>{inr(cumByDate.get(d.date))}</span>
                            </span>
                            {d.haltedAt && <span className="rounded border border-red-500/30 bg-red-500/10 px-1.5 font-bold text-red-400">Loss limit {d.haltedAt}</span>}
                            {d.notes.map((n) => (
                              <span key={n} className="text-zinc-500">
                                {n}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                      {open &&
                        (d.trades.length === 0 ? (
                          <tr>
                            <td colSpan={colCount} className="px-6 py-2 text-zinc-500">
                              No trades{d.signalMinutes ? ` (${d.signalMinutes} minute(s) with an eligible signal, blocked by caps/locks)` : ''}.
                            </td>
                          </tr>
                        ) : (
                          d.trades.map((t) => (
                            <tr key={`${d.date}-${t.n}`} className="whitespace-nowrap font-mono tabular-nums text-zinc-300 hover:bg-zinc-900/60">
                              <td className="px-2.5 py-1.5 text-zinc-500">{t.n}</td>
                              <td className="px-2.5 py-1.5 font-sans font-bold text-white">
                                {t.strike} <span className={t.option === 'CE' ? 'text-emerald-400' : 'text-red-400'}>{t.option}</span>{' '}
                                <span className="text-[10px] text-zinc-500">{t.side}</span>
                              </td>
                              <td className="px-2.5 py-1.5">{t.entryTime}</td>
                              <td className="px-2.5 py-1.5">{px(t.entryPrice)}</td>
                              <td className="px-2.5 py-1.5">{t.exitTime}</td>
                              <td className="px-2.5 py-1.5">{px(t.exitPrice)}</td>
                              <td className="px-2.5 py-1.5">
                                {t.qty} <span className="text-zinc-500">({t.lots}L)</span>
                              </td>
                              <td className="px-2.5 py-1.5">{t.holdMin}m</td>
                              <td className="px-2.5 py-1.5 font-sans">
                                <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-bold', exitTone(t.exitKind))}>{exitLabel(t.exitKind)}</span>
                              </td>
                              <td className="max-w-[240px] truncate px-2.5 py-1.5 font-sans text-zinc-400" title={t.exitReason}>
                                {t.exitReason}
                              </td>
                              <td className={cn('px-2.5 py-1.5', pnlTone(t.gross))}>{inr(t.gross)}</td>
                              <td className="px-2.5 py-1.5 text-zinc-400">{inr(t.costs, false)}</td>
                              <td className={cn('px-2.5 py-1.5 font-bold', pnlTone(t.net))}>{inr(t.net)}</td>
                              <td className="px-2.5 py-1.5">{px(t.initialStop)}</td>
                              <td className="px-2.5 py-1.5">{px(t.target)}</td>
                              <td className="px-2.5 py-1.5">{px(t.best)}</td>
                              <td className="px-2.5 py-1.5">{t.score}</td>
                              {stratCols.map((c) => (
                                <td key={c.key} className="px-2.5 py-1.5">
                                  {fmtCell(c, t.cols[c.key])}
                                </td>
                              ))}
                            </tr>
                          ))
                        ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">
          Replays each session minute by minute through the strategy&apos;s own rules — the functions the Live tab runs: signals on
          bars closed before the minute, entry at that minute&apos;s open, stops and exits checked inside each bar with the adverse move
          first, fills only at prices the bar traded, Dhan F&amp;O costs per order, slippage per fill from the rules.
        </p>
        <AuditReport
          audit={data?.store?.audit ?? null}
          storeConfigKey={data?.configKey && !data.rulesChanged ? data.configKey : null}
          tradeCount={days.reduce((a, d) => a + d.trades.length, 0)}
          side={def.side}
          open={auditOpen}
          onToggle={() => setAuditOpen((o) => !o)}
        />
      </div>
    </section>
  );
}
