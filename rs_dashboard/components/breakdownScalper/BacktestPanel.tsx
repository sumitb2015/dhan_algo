'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChevronDown, ChevronRight, Download, FlaskConical, Play, RefreshCw, Square, AlertTriangle, Settings, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { summarize, WARMUP_SESSIONS_NEEDED, type BtAudit, type BtDayResult, type BtExitKind, type BtWindow } from '@/lib/breakdownBacktest';
import type { BreakdownConfig } from '@/lib/breakdownLedger';
import { BacktestAuditReport } from './BacktestAuditReport';
import { OptimizationReport } from './OptimizationReport';

interface RunStatus {
  state: 'running' | 'done' | 'error' | 'stopped' | 'interrupted';
  mode?: string;
  total?: number;
  done?: number;
  current?: string | null;
  message?: string;
  finishedAt?: string | null;
  updatedAt?: string;
}

interface BacktestResponse {
  success: boolean;
  /** true when the store still matches the version the page sent: `store.days` is then null (keep the cached days). */
  unchanged?: boolean;
  running: boolean;
  status: RunStatus | null;
  from: string;
  dbRange?: { earliest: string; latest: string };
  dataSource?: 'dhan' | 'breeze';
  missing: string[];
  configKey: string;
  config: BreakdownConfig;
  rulesChanged: boolean;
  store: {
    from: string;
    to: string | null;
    offline: boolean;
    window: BtWindow;
    updatedAt: string | null;
    config: BreakdownConfig;
    configKey: string;
    failures: Record<string, { at: string; error: string }>;
    audit: BtAudit | null;
    days: BtDayResult[] | null;
  } | null;
}

const EXIT_LABEL: Record<BtExitKind, string> = {
  TARGET: 'Target',
  TRAIL_SL: 'Trailing SL',
  INITIAL_SL: 'Initial SL',
  RECOVERY: 'Recovery',
  EOD: 'EOD',
  SESSION_END: 'Session end',
  CIRCUIT_BREAKER: 'Circuit Breaker',
};
const EXIT_TONE: Record<BtExitKind, string> = {
  TARGET: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  TRAIL_SL: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
  INITIAL_SL: 'bg-red-500/10 text-red-400 border-red-500/30',
  RECOVERY: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  EOD: 'bg-zinc-800 text-zinc-300 border-zinc-700',
  SESSION_END: 'bg-zinc-800 text-zinc-300 border-zinc-700',
  CIRCUIT_BREAKER: 'bg-red-500/20 text-red-300 border-red-500/40',
};

const inr = (n: number | null | undefined, sign = true) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = sign ? (n > 0 ? '+' : n < 0 ? '-' : '') : n < 0 ? '-' : '';
  return `${s}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
};
const px = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(2));
const pnlTone = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) || n === 0 ? 'text-zinc-400' : n > 0 ? 'text-emerald-400' : 'text-red-400';

const CONFIG_LABELS: [keyof BreakdownConfig, string, (v: unknown) => string][] = [
  ['timeframe', 'TF', (v) => `${v}m`],
  ['strikeWindow', 'Strikes', (v) => `ATM±${v}`],
  ['trendMode', 'Trend', String],
  ['slPct', 'SL', (v) => `${v}%`],
  ['trailStartPct', 'Lock@Profit', (v) => `${v ?? 15}%`],
  ['trailStepPts', 'Trail step', (v) => `${v ?? 5}pt`],
  ['trailByPts', 'Trail by', (v) => `${v ?? 2}pt`],
  ['targetPct', 'Target', (v) => `${v}%`],
  ['lotsPerTrade', 'Lots', String],
  ['maxConcurrent', 'Max open', String],
  ['maxSameSide', 'Per side', String],
  ['dailyLossLimit', 'Loss limit', (v) => `₹${Number(v).toLocaleString('en-IN')}`],
  ['hardCircuitBreaker', 'Hard breaker', (v) => (v === false ? 'off' : 'auto square-off')],
  ['entryStart', 'Entries', String],
  ['entryEnd', 'until', String],
  ['eodExit', 'EOD', String],
  ['recoveryExit', 'Recovery exit', (v) => (v ? 'on' : 'off')],
  ['useSupertrend', 'Supertrend', (v) => (v === false ? 'off' : 'on')],
  ['stPeriod', 'ST Period', (v) => String(v ?? 10)],
  ['stMultiplier', 'ST Mult', (v) => `${v ?? 2}x`],
  ['useVwap', 'VWAP', (v) => (v === false ? 'off' : 'on')],
  ['useEma', 'EMA', (v) => (v === false ? 'off' : 'on')],
  ['emaPeriod', 'EMA Period', (v) => String(v ?? 20)],
  ['brokerage', 'Brokerage', (v) => (v === 0 ? '₹0 (Kotak)' : `₹${v ?? 20}/ord`)],
  ['slippagePts', 'Slippage', (v) => (v ? `${v}pt/fill` : '0 (exact levels)')],
  ['btWarmOnly', 'Cold contracts', (v) => (v ? 'skipped' : 'traded')],
];

const ALL_WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;
type Weekday = (typeof ALL_WEEKDAYS)[number];

function csvOf(days: BtDayResult[]): string {
  const head = [
    'date', 'weekday', 'expiry', 'dte', 'source', 'n', 'contract', 'entry_time', 'entry_price', 'exit_time', 'exit_price',
    'lots', 'qty', 'hold_min', 'exit_kind', 'exit_reason', 'gross', 'costs', 'net', 'initial_sl', 'target',
    'lowest', 'trailing_sl_at_exit', 'max_adverse', 'rank_score', 'breakdown_age_bars', 'trend', 'spot', 'atm',
    'steps_from_atm', 'oi_view', 'warmup_bars',
  ];
  const q = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [...days]
    .sort((a, b) => a.date.localeCompare(b.date))
    .flatMap((d) =>
      d.trades.map((t) =>
        [
          d.date, d.weekday, d.expiry, d.dte, d.source, t.n, t.contract, t.entryTime, t.entryPrice, t.exitTime, t.exitPrice,
          t.lots, t.qty, t.holdMin, t.exitKind, t.exitReason, t.gross, t.costs, t.net, t.initialSl, t.targetPrice,
          t.lowestPrice, t.trailingSlAtExit, t.maxAdverse, t.rankScore, t.breakdownAgeBars, t.trendAtEntry, t.spotAtEntry,
          t.atmAtEntry, t.stepsFromAtm, t.oiView, t.warmupBars,
        ]
          .map(q)
          .join(','),
      ),
    );
  return [head.join(','), ...rows].join('\n');
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: { date: string; net: number; cum: number; trades: number } }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs shadow-lg">
      <p className="font-bold text-white mb-1">{p.date}</p>
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

/** Per-browser cache of the day results, keyed by the store's updatedAt: the page paints it instantly and only
 *  downloads the trade log again after a run actually changed it. */
const CACHE_KEY = 'breakdownScalper.backtestDays';

function readCache(): { stamp: string; days: BtDayResult[] } | null {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as { stamp?: unknown; days?: unknown } | null;
    return c && typeof c.stamp === 'string' && Array.isArray(c.days) ? { stamp: c.stamp, days: c.days as BtDayResult[] } : null;
  } catch {
    return null;
  }
}

function writeCache(stamp: string | null, days: BtDayResult[]) {
  try {
    if (stamp) localStorage.setItem(CACHE_KEY, JSON.stringify({ stamp, days }));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    /* storage full or blocked: the next poll simply downloads again */
  }
}

export function BacktestPanel({
  pageConfig,
  onRunningChange,
  onOpenSettings,
}: {
  pageConfig: BreakdownConfig;
  onRunningChange?: (running: boolean) => void;
  onOpenSettings?: () => void;
}) {
  const [data, setData] = useState<BacktestResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [days, setDays] = useState<BtDayResult[]>([]);
  /** Days whose trades are shown. Empty = every day folded, including days a later append adds. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** The whole trade-log section starts collapsed. */
  const [logOpen, setLogOpen] = useState(false);
  const stamp = useRef<string | null>(null);
  const cacheRead = useRef(false);
  const [rerunWindow, setRerunWindow] = useState<BtWindow>('db4');
  const [customFrom, setCustomFrom] = useState('2026-09-01');
  const [customTo, setCustomTo] = useState('2026-10-13');
  const [auditOpen, setAuditOpen] = useState(false);
  const [selectedWeekdays, setSelectedWeekdays] = useState<Set<string>>(() => new Set(ALL_WEEKDAYS));
  const initializedDates = useRef(false);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const autoStarted = useRef(false);

  const toggleWeekday = (wd: string) => {
    setSelectedWeekdays((prev) => {
      const next = new Set(prev);
      if (next.has(wd)) next.delete(wd);
      else next.add(wd);
      return next;
    });
  };

  const load = useCallback(async () => {
    const mine = ++seq.current;
    if (!cacheRead.current) {
      cacheRead.current = true;
      const cached = readCache();
      if (cached) {
        stamp.current = cached.stamp;
        setDays(cached.days);
      }
    }
    try {
      const q = stamp.current ? `?known=${encodeURIComponent(stamp.current)}` : '';
      const res = await fetch(`/api/breakdown-scalper/backtest${q}`, { cache: 'no-store' });
      const j = (await res.json()) as BacktestResponse;
      if (mine !== seq.current) return;
      if (j.success) {
        setData(j);
        setLoadError(null);
        if (!j.unchanged) {
          const next = j.store?.days ?? [];
          stamp.current = j.store?.updatedAt ?? null;
          setDays(next);
          writeCache(stamp.current, next);
        }
      } else setLoadError('Could not read backtest results');
    } catch (e) {
      if (mine === seq.current) setLoadError(String((e as Error).message ?? e));
    }
  }, []);

  const post = useCallback(
    async (body: Record<string, string>) => {
      setBusy(true);
      if (body.action === 'stop') {
        setData((prev) =>
          prev
            ? {
                ...prev,
                running: false,
                status: prev.status ? { ...prev.status, state: 'stopped', message: 'Stopping backtest engine…' } : null,
              }
            : null,
        );
      }
      try {
        const res = await fetch('/api/breakdown-scalper/backtest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = (await res.json()) as { success?: boolean; running?: boolean; status?: RunStatus };
        if (j && j.status && j.running !== undefined) {
          setData((prev) => (prev ? { ...prev, running: j.running ?? false, status: j.status ?? null } : null));
        }
      } finally {
        setBusy(false);
        void load();
      }
    },
    [load],
  );

  // Poll: every 4 s while a run is going, every 60 s otherwise (a file read on the server, no broker call).
  const running = data?.running ?? false;
  useEffect(() => {
    onRunningChange?.(running);
  }, [running, onRunningChange]);

  useEffect(() => {
    const t0 = setTimeout(load, 0);
    const id = setInterval(load, running ? 4000 : 60_000);
    return () => {
      clearTimeout(t0);
      clearInterval(id);
    };
  }, [load, running]);

  // Catch-up on page open: once per visit, only when sessions are missing, nothing is running and the rules the
  // store was built with still match the page (a rules change waits for an explicit Re-run).
  useEffect(() => {
    if (!data || autoStarted.current || data.running) return;
    if (data.rulesChanged || !data.missing.length) return;
    autoStarted.current = true;
    const t = setTimeout(() => void post(data.store ? { action: 'catchup' } : { action: 'rerun', window: 'week' }), 0);
    return () => clearTimeout(t);
  }, [data, post]);

  // A source switch brings a different store and DB range: re-seed the date pickers from it.
  const seenSource = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!data?.dataSource) return;
    if (seenSource.current && seenSource.current !== data.dataSource) initializedDates.current = false;
    seenSource.current = data.dataSource;
  }, [data?.dataSource]);

  useEffect(() => {
    if (data?.store && !initializedDates.current) {
      initializedDates.current = true;
      if (data.store.from) setCustomFrom(data.store.from);
      if (data.store.to) setCustomTo(data.store.to);
      if (data.store.window) setRerunWindow(data.store.window);
    } else if (data?.dbRange && !initializedDates.current) {
      if (data.dbRange.latest) setCustomTo(data.dbRange.latest);
    }
  }, [data]);

  const weekdayCounts = useMemo(() => {
    const counts: Record<string, number> = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0 };
    for (const d of days) {
      if (counts[d.weekday] !== undefined) counts[d.weekday]++;
    }
    return counts;
  }, [days]);

  /** Sessions per weekday that started without the previous session for indicator warm-up (day field, else the audit's). */
  const partialWarmup = useMemo(() => {
    const out: Record<string, number> = {};
    if (days.some((d) => d.warmupSessions != null)) {
      for (const d of days) if (d.warmupSessions != null && d.warmupSessions < WARMUP_SESSIONS_NEEDED) out[d.weekday] = (out[d.weekday] ?? 0) + 1;
    } else {
      for (const [wd, w] of Object.entries(data?.store?.audit?.warmup ?? {})) out[wd] = w.partial;
    }
    return out;
  }, [days, data?.store?.audit]);

  const filteredDays = useMemo(
    () => days.filter((d) => selectedWeekdays.has(d.weekday)),
    [days, selectedWeekdays],
  );

  const summary = useMemo(() => summarize(filteredDays), [filteredDays]);
  const chart = useMemo(
    () =>
      [...filteredDays]
        .sort((a, b) => a.date.localeCompare(b.date))
        .reduce<{ date: string; full: string; net: number; cum: number; trades: number }[]>((acc, d) => {
          const prev = acc.length ? acc[acc.length - 1].cum : 0;
          acc.push({ date: d.date.slice(5), full: d.date, net: d.net, cum: Math.round((prev + d.net) * 100) / 100, trades: d.trades.length });
          return acc;
        }, []),
    [filteredDays],
  );
  const cumByDate = useMemo(() => new Map(chart.map((c) => [c.full, c.cum])), [chart]);

  const status = data?.status;
  const failures = Object.entries(data?.store?.failures ?? {});
  const dataThrough = days[0]?.date ?? null;
  const allExpanded = filteredDays.length > 0 && filteredDays.every((d) => expanded.has(d.date));

  const exportCsv = () => {
    const target = filteredDays.length > 0 ? filteredDays : days;
    const blob = new Blob([csvOf(target)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `breakdown_scalper_backtest_${target[target.length - 1]?.date ?? 'x'}_${target[0]?.date ?? 'x'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const storeCfg = data?.store?.config ?? pageConfig;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-violet-500/25 bg-violet-500/10">
            <FlaskConical className="h-3.5 w-3.5 text-violet-400" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-violet-400">Offline Strategy backtest · NIFTY</p>
            <h2 className="text-sm font-bold text-white">
              Daily results {data?.store ? (data.store.to ? `${data.store.from} → ${data.store.to}` : `since ${data.store.from}`) : ''}{' '}
              <span className="text-xs font-medium text-emerald-400/90 font-mono">
                (100% offline · {data?.dataSource === 'breeze' ? 'ICICI Breeze DB' : 'Dhan options DB'})
              </span>
            </h2>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dataThrough && (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-bold tracking-wider text-amber-400">
              DATA: {dataThrough}
            </span>
          )}
          {running ? (
            <button
              type="button"
              onClick={() => void post({ action: 'stop' })}
              disabled={busy}
              className="flex h-7 items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 text-xs font-bold text-red-400 hover:bg-red-500/20 disabled:opacity-50"
            >
              <Square className="h-3 w-3" /> Stop
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void post({ action: 'catchup' })}
                disabled={busy || !!data?.rulesChanged}
                title={data?.rulesChanged ? 'Rules changed: use Re-run' : 'Backtest any session not yet in the results'}
                className="flex h-7 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 text-xs font-bold text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-50"
              >
                <Play className="h-3 w-3 text-emerald-400" /> Run now
              </button>
              <select
                value={rerunWindow}
                onChange={(e) => setRerunWindow(e.target.value as BtWindow)}
                aria-label="Re-run window"
                className="h-7 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-xs font-bold text-zinc-300 focus:outline-none"
              >
                <option value="db4">4 weeks (Options DB)</option>
                <option value="week">1 week (Options DB)</option>
                <option value="month">1 month (Options DB)</option>
                <option value="3months">3 months (Options DB)</option>
                <option value="6months">6 months (Options DB)</option>
                <option value="1year">1 year (Options DB)</option>
                <option value="all">All Data (2021–2026)</option>
                <option value="custom">Custom Date Range…</option>
              </select>
              {rerunWindow === 'custom' && (
                <div className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900/90 px-2 py-0.5 text-xs">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">From</span>
                  <input
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    min={data?.dbRange?.earliest ?? '2020-12-31'}
                    max={customTo || data?.dbRange?.latest || '2026-10-13'}
                    aria-label="Start date"
                    className="h-6 rounded border border-zinc-700 bg-zinc-950 px-1.5 text-xs font-mono text-zinc-200 focus:border-violet-500 focus:outline-none"
                  />
                  <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">To</span>
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    min={customFrom || data?.dbRange?.earliest || '2020-12-31'}
                    max={data?.dbRange?.latest ?? '2026-10-13'}
                    aria-label="End date"
                    className="h-6 rounded border border-zinc-700 bg-zinc-950 px-1.5 text-xs font-mono text-zinc-200 focus:border-violet-500 focus:outline-none"
                  />
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  if (rerunWindow === 'custom') {
                    if (!customFrom || !customTo) {
                      alert('Please select both Start Date and End Date.');
                      return;
                    }
                    if (customFrom > customTo) {
                      alert('Start Date cannot be after End Date.');
                      return;
                    }
                    if (confirm(`Rebuild the backtest from ${customFrom} to ${customTo} with current rules? Existing results will be replaced.`)) {
                      void post({ action: 'rerun', window: 'custom', from: customFrom, to: customTo });
                    }
                  } else {
                    const labels: Record<BtWindow, string> = {
                      db4: 'latest 4 weeks held in options DB',
                      week: 'last 1 week',
                      month: 'last 1 month',
                      '3months': 'last 3 months',
                      '6months': 'last 6 months',
                      '1year': 'last 1 year',
                      all: 'all available historical data (2021–2026)',
                      custom: `${customFrom} to ${customTo}`,
                    };
                    const label = labels[rerunWindow] ?? rerunWindow;
                    if (confirm(`Rebuild the backtest for ${label} with current rules? Existing results will be replaced.`)) {
                      void post({ action: 'rerun', window: rerunWindow });
                    }
                  }
                }}
                disabled={busy}
                className="flex h-7 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 text-xs font-bold text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-50"
              >
                <RefreshCw className={cn('h-3 w-3 text-sky-400', busy && 'animate-spin')} /> Re-run
              </button>
            </>
          )}
          <button
            type="button"
            onClick={exportCsv}
            disabled={!summary.trades}
            className="flex h-7 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 text-xs font-bold text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-50"
          >
            <Download className="h-3 w-3" /> CSV
          </button>
          <button
            type="button"
            onClick={() => {
              setAuditOpen(true);
              setTimeout(() => {
                const el = document.getElementById('backtest-audit-report');
                if (el) el.scrollIntoView({ behavior: 'smooth' });
              }, 50);
            }}
            className="flex h-7 items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 text-xs font-bold text-emerald-400 hover:bg-emerald-500/20"
            title="View Strategy & Backtest Verification Audit Report (2026-10-18)"
          >
            <ShieldCheck className="h-3.5 w-3.5" /> Audit
          </button>
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="flex h-7 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 text-xs font-bold text-zinc-300 hover:bg-zinc-800 hover:text-white"
              title="Configure Strategy Rules & Risk Parameters"
            >
              <Settings className="h-3 w-3 text-amber-400" /> Rules
            </button>
          )}
        </div>
      </div>

      {/* Status / warnings */}
      <div className="flex flex-col gap-2 px-4 pt-3">
        {status && (
          <div
            role="status"
            className={cn(
              'flex flex-col gap-2 rounded-lg border px-3 py-2 text-xs',
              running
                ? 'border-sky-500/30 bg-sky-500/10 text-sky-400'
                : status.state === 'error' || status.state === 'interrupted'
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                  : 'border-zinc-800 bg-zinc-900 text-zinc-400',
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              {running && <RefreshCw className="h-3 w-3 animate-spin" />}
              <span className="font-bold uppercase">{running ? 'Running' : status.state}</span>
              {running && status.total ? <span className="font-mono">{status.done ?? 0}/{status.total} sessions</span> : null}
              <span className="text-zinc-300">{status.message}</span>
              {!running && status.finishedAt && <span className="text-zinc-500">· {new Date(status.finishedAt).toLocaleString('en-IN')}</span>}
            </div>
            {running && typeof status.total === 'number' && status.total > 0 && (
              <div className="flex items-center gap-2 pt-0.5">
                <div className="flex-1 h-1.5 rounded-full bg-sky-950/80 overflow-hidden border border-sky-500/20">
                  <div
                    className="h-full bg-sky-400 transition-all duration-300"
                    style={{ width: `${Math.min(100, Math.round(((status.done ?? 0) / status.total) * 100))}%` }}
                  />
                </div>
                <span className="text-[10px] font-mono font-bold text-sky-300 shrink-0">
                  {Math.round(((status.done ?? 0) / status.total) * 100)}%
                </span>
              </div>
            )}
          </div>
        )}
        {data?.rulesChanged && (
          <div role="alert" className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            The page rules changed since these results were built. Daily appends are paused so every day stays comparable;
            press <span className="font-bold">Re-run</span> to rebuild with the current rules.
          </div>
        )}
        {!running && data && data.missing.length > 0 && !data.rulesChanged && (
          <div className="text-xs text-zinc-500">
            {data.missing.length} session(s) not backtested yet: {data.missing.slice(0, 8).join(', ')}
            {data.missing.length > 8 ? '…' : ''}
          </div>
        )}
        {failures.length > 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
            <span className="font-bold text-amber-400">Unavailable sessions (retried on the next run): </span>
            {failures.map(([d, f]) => (
              <span key={d} className="mr-3" title={f.error}>
                {d}: {f.error.slice(0, 90)}
              </span>
            ))}
          </div>
        )}
        {loadError && <div className="text-xs text-red-400">{loadError}</div>}
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
          <span className="font-bold text-zinc-400">Rules backtested:</span>
          {CONFIG_LABELS.map(([k, label, fmt]) => (
            <span key={k}>
              {label} <span className="font-mono text-zinc-300">{fmt(storeCfg[k])}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Weekday Filter Strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/40 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
            Weekday Filter:
          </span>
          <div className="inline-flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950/70 p-1">
            {ALL_WEEKDAYS.map((wd) => {
              const isSelected = selectedWeekdays.has(wd);
              const count = weekdayCounts[wd] ?? 0;
              const partial = partialWarmup[wd] ?? 0;
              return (
                <button
                  key={wd}
                  type="button"
                  onClick={() => toggleWeekday(wd)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-bold transition-colors',
                    isSelected
                      ? 'bg-violet-600 text-white shadow-sm hover:bg-violet-500'
                      : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200',
                  )}
                  title={`${isSelected ? 'Deselect' : 'Select'} ${wd} (${count} session${count === 1 ? '' : 's'})${
                    partial ? ` — ${partial} with no previous-session indicator warm-up: not comparable with live` : ''
                  }`}
                >
                  <span>{wd}</span>
                  {partial > 0 && (
                    <span className="text-[10px] font-bold text-amber-400" aria-label={`${partial} sessions with partial warm-up`}>
                      ⚠
                    </span>
                  )}
                  <span
                    className={cn(
                      'rounded px-1 text-[10px] font-mono tabular-nums',
                      isSelected ? 'bg-violet-700/80 text-violet-100' : 'bg-zinc-800 text-zinc-400',
                    )}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSelectedWeekdays(new Set(ALL_WEEKDAYS))}
              disabled={selectedWeekdays.size === ALL_WEEKDAYS.length}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                selectedWeekdays.size === ALL_WEEKDAYS.length
                  ? 'cursor-not-allowed text-zinc-600'
                  : 'text-violet-400 hover:bg-violet-500/10 hover:text-violet-300',
              )}
            >
              All
            </button>
            <span className="text-zinc-700">·</span>
            <button
              type="button"
              onClick={() => setSelectedWeekdays(new Set())}
              disabled={selectedWeekdays.size === 0}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                selectedWeekdays.size === 0
                  ? 'cursor-not-allowed text-zinc-600'
                  : 'text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200',
              )}
            >
              Clear
            </button>
          </div>
        </div>

        {selectedWeekdays.size < ALL_WEEKDAYS.length && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-zinc-400">
              Showing <span className="font-mono font-bold text-zinc-200">{filteredDays.length}</span> of{' '}
              <span className="font-mono text-zinc-400">{days.length}</span> sessions
            </span>
            {filteredDays.length === 0 && (
              <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-400">
                All weekdays deselected
              </span>
            )}
          </div>
        )}
      </div>

      {/* Primary KPI tiles */}
      <div className="grid grid-cols-2 gap-2 px-4 pt-3 pb-2 sm:grid-cols-4 xl:grid-cols-8">
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

      {/* Advanced Quant Metrics tiles */}
      <div className="grid grid-cols-2 gap-2 px-4 pb-3 sm:grid-cols-4 xl:grid-cols-8">
        {[
          [
            'Expectancy / Ratio',
            `${inr(summary.expectancy)} / ${summary.expectancyRatio != null ? summary.expectancyRatio.toFixed(2) : '—'}`,
            pnlTone(summary.expectancy),
          ],
          [
            'Sharpe (Annualized)',
            summary.dailySharpe != null ? summary.dailySharpe.toFixed(2) : '—',
            summary.dailySharpe != null && summary.dailySharpe >= 1 ? 'text-emerald-400' : 'text-zinc-200',
          ],
          [
            'Sortino (Annualized)',
            summary.dailySortino != null ? summary.dailySortino.toFixed(2) : '—',
            summary.dailySortino != null && summary.dailySortino >= 1.5 ? 'text-emerald-400' : 'text-zinc-200',
          ],
          [
            'Calmar (Return/DD)',
            summary.calmarRatio != null ? `${summary.calmarRatio.toFixed(2)}x` : '—',
            summary.calmarRatio != null && summary.calmarRatio >= 3 ? 'text-emerald-400' : 'text-zinc-200',
          ],
          [
            'Max Streaks (W / L)',
            `${summary.maxConsecWins}W / ${summary.maxConsecLosses}L`,
            'text-zinc-200',
          ],
          [
            'Avg Hold (Win / Loss)',
            `${summary.avgHoldWinnerMin != null ? `${summary.avgHoldWinnerMin}m` : '—'} / ${summary.avgHoldLoserMin != null ? `${summary.avgHoldLoserMin}m` : '—'}`,
            'text-zinc-200',
          ],
          [
            'CE Sells Net',
            `${inr(summary.ceStat?.net ?? 0)} (${summary.ceStat?.trades ?? 0}T, ${summary.ceStat?.winRate != null ? `${summary.ceStat.winRate.toFixed(0)}%` : '—'})`,
            pnlTone(summary.ceStat?.net),
          ],
          [
            'PE Sells Net',
            `${inr(summary.peStat?.net ?? 0)} (${summary.peStat?.trades ?? 0}T, ${summary.peStat?.winRate != null ? `${summary.peStat.winRate.toFixed(0)}%` : '—'})`,
            pnlTone(summary.peStat?.net),
          ],
        ].map(([label, value, tone]) => (
          <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">{label}</p>
            <p className={cn('mt-1 font-mono text-sm font-bold tabular-nums', tone)}>{value}</p>
          </div>
        ))}
      </div>

      {summary.trades > 0 && (
        <div className="flex flex-col gap-2 px-4 pb-2 text-[11px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-zinc-400">Exits:</span>
            {(Object.keys(EXIT_LABEL) as BtExitKind[])
              .filter((k) => summary.exitMix[k])
              .map((k) => (
                <span key={k} className={cn('rounded border px-1.5 py-0.5 font-bold', EXIT_TONE[k])}>
                  {EXIT_LABEL[k]} {summary.exitMix[k]}
                </span>
              ))}
            {summary.bestDay && (
              <span className="text-zinc-500 sm:ml-auto">
                Best {summary.bestDay.date} <span className="text-emerald-400 font-bold">{inr(summary.bestDay.net)}</span> · Worst {summary.worstDay?.date}{' '}
                <span className="text-red-400 font-bold">{inr(summary.worstDay?.net)}</span>
              </span>
            )}
          </div>

          {/* DTE Breakdown Badges */}
          {summary.dteBreakdown && summary.dteBreakdown.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-zinc-400">DTE Performance:</span>
              {summary.dteBreakdown.map((b) => (
                <span
                  key={b.dte}
                  className={cn(
                    'rounded border px-2 py-0.5 font-mono text-[10px] font-bold',
                    b.net >= 0
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                      : 'border-red-500/30 bg-red-500/10 text-red-400'
                  )}
                  title={`${b.sessions} session(s), ${b.trades} trade(s), ${b.wins} win(s)`}
                >
                  {b.dte}-DTE: {inr(b.net)} ({b.trades}T, {b.winRate != null ? `${b.winRate.toFixed(0)}%` : '—'})
                </span>
              ))}
            </div>
          )}

          {/* Slippage Sensitivity Stress Matrix */}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800/80 bg-zinc-950/40 px-2.5 py-1.5">
            <span className="font-bold text-zinc-400">Slippage Stress (est. drag @ 65 qty):</span>
            {[0, 0.5, 1.0, 1.5].map((slip) => {
              const drag = summary.trades * 2 * slip * 65;
              const stressedNet = summary.net - drag;
              return (
                <span
                  key={slip}
                  className="rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5 font-mono text-[10px]"
                >
                  <span className="text-zinc-400">@{slip}pt/fill: </span>
                  <span className={cn('font-bold', pnlTone(stressedNet))}>{inr(stressedNet)}</span>
                  {slip > 0 && <span className="text-zinc-500"> (-{inr(drag)})</span>}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Chart */}
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
                  <Cell key={d.date} fill={d.net >= 0 ? 'var(--color-emerald-500)' : 'var(--color-red-500)'} />
                ))}
              </Bar>
              <Line dataKey="cum" type="monotone" stroke="var(--color-violet-400)" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
          <p className="text-center text-[10px] text-zinc-500">Bars: day net after costs · Line: cumulative net</p>
        </div>
      )}

      {/* Day-wise trade log */}
      <div className="px-4 py-3">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setLogOpen((o) => !o)}
            aria-expanded={logOpen}
            className="flex items-center gap-1.5 text-xs font-bold text-zinc-200 hover:text-white"
          >
            {logOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Day-wise trade log
            <span className="font-medium text-zinc-500">
              ({filteredDays.length} session{filteredDays.length === 1 ? '' : 's'}, {summary.trades} trade{summary.trades === 1 ? '' : 's'})
            </span>
          </button>
          {logOpen && filteredDays.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(allExpanded ? new Set() : new Set(filteredDays.map((d) => d.date)))}
              className="text-[11px] font-bold text-sky-400 hover:text-sky-300"
            >
              {allExpanded ? 'Collapse all' : 'Expand all'}
            </button>
          )}
        </div>
        {!logOpen ? null : filteredDays.length === 0 ? (
          <p className="mt-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-6 text-center text-xs text-zinc-500">
            {days.length === 0
              ? running
                ? 'The first sessions are being backtested…'
                : 'No backtest results yet.'
              : 'No sessions match the selected weekday filter.'}
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full min-w-[1500px] text-left text-xs">
              <thead className="bg-zinc-800 text-xs font-bold text-white">
                <tr>
                  {[
                    '#', 'Contract', 'Entry', 'Entry ₹', 'Exit', 'Exit ₹', 'Qty', 'Hold', 'Exit type', 'Reason',
                    'Gross', 'Costs', 'Net', 'Max adverse', 'Init SL', 'Target', 'Lowest', 'Trail @ exit',
                    'Rank', 'BD age', 'Trend', 'Spot', 'ATM ±', 'OI',
                  ].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2.5 py-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {filteredDays.map((d) => {
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
                        <td colSpan={24} className="px-2.5 py-2">
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
                              Gross <span className={cn('font-mono', pnlTone(d.gross))}>{inr(d.gross)}</span>
                            </span>
                            <span className="text-zinc-400">
                              Costs <span className="font-mono text-zinc-200">{inr(d.costs, false)}</span>
                            </span>
                            <span className="text-zinc-400">
                              Net <span className={cn('font-mono font-bold', pnlTone(d.net))}>{inr(d.net)}</span>
                            </span>
                            <span className="text-zinc-400">
                              Cumulative <span className={cn('font-mono', pnlTone(cumByDate.get(d.date)))}>{inr(cumByDate.get(d.date))}</span>
                            </span>
                            {d.haltedAt && <span className="rounded border border-red-500/30 bg-red-500/10 px-1.5 font-bold text-red-400">Loss limit {d.haltedAt}</span>}
                            <span className="text-zinc-500">source: {d.source === 'db' ? 'options DB' : d.source === 'expired_api' ? 'Dhan expired API' : 'Dhan intraday API'}</span>
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
                            <td colSpan={24} className="px-6 py-2 text-zinc-500">
                              No trades{d.signalMinutes ? ` (${d.signalMinutes} minute(s) with an eligible signal, blocked by caps/locks)` : ' (no eligible fresh breakdown in the entry window)'}.
                            </td>
                          </tr>
                        ) : (
                          d.trades.map((t) => (
                            <tr key={`${d.date}-${t.n}`} className="whitespace-nowrap font-mono tabular-nums text-zinc-300 hover:bg-zinc-900/60">
                              <td className="px-2.5 py-1.5 text-zinc-500">{t.n}</td>
                              <td className="whitespace-nowrap px-2.5 py-1.5 font-sans font-bold text-white">
                                {t.strike} <span className={t.option === 'CE' ? 'text-red-400' : 'text-emerald-400'}>{t.option}</span>
                              </td>
                              <td className="px-2.5 py-1.5">{t.entryTime}</td>
                              <td className="px-2.5 py-1.5">{px(t.entryPrice)}</td>
                              <td className="px-2.5 py-1.5">{t.exitTime}</td>
                              <td className="px-2.5 py-1.5">{px(t.exitPrice)}</td>
                              <td className="whitespace-nowrap px-2.5 py-1.5">
                                {t.qty} <span className="text-zinc-500">({t.lots}L)</span>
                              </td>
                              <td className="whitespace-nowrap px-2.5 py-1.5">{t.holdMin}m</td>
                              <td className="px-2.5 py-1.5 font-sans">
                                <span className={cn('whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-bold', EXIT_TONE[t.exitKind])}>
                                  {EXIT_LABEL[t.exitKind]}
                                </span>
                              </td>
                              <td className="max-w-[260px] truncate px-2.5 py-1.5 font-sans text-zinc-400" title={t.exitReason}>
                                {t.exitReason}
                              </td>
                              <td className={cn('px-2.5 py-1.5', pnlTone(t.gross))}>{inr(t.gross)}</td>
                              <td className="px-2.5 py-1.5 text-zinc-400">{inr(t.costs, false)}</td>
                              <td className={cn('px-2.5 py-1.5 font-bold', pnlTone(t.net))}>{inr(t.net)}</td>
                              <td className="px-2.5 py-1.5 text-red-400">{t.maxAdverse > 0 ? `+${t.maxAdverse.toFixed(2)}` : '0.00'}</td>
                              <td className="px-2.5 py-1.5">{px(t.initialSl)}</td>
                              <td className="px-2.5 py-1.5">{px(t.targetPrice)}</td>
                              <td className="px-2.5 py-1.5">{px(t.lowestPrice)}</td>
                              <td className="px-2.5 py-1.5">{px(t.trailingSlAtExit)}</td>
                              <td className="px-2.5 py-1.5">{t.rankScore}</td>
                              <td className="px-2.5 py-1.5">{t.breakdownAgeBars}</td>
                              <td className="px-2.5 py-1.5 font-sans text-[11px]">{t.trendAtEntry}</td>
                              <td className="px-2.5 py-1.5">{px(t.spotAtEntry)}</td>
                              <td className="whitespace-nowrap px-2.5 py-1.5">
                                {t.atmAtEntry} <span className="text-zinc-500">±{t.stepsFromAtm}</span>
                              </td>
                              <td className="px-2.5 py-1.5 font-sans text-[11px] text-zinc-400">{t.oiView ?? '—'}</td>
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
          Replays each session minute by minute through the live engine&apos;s own rules (lib/breakdownScalper.ts): signals on
          closed bars, entries at the next bar&apos;s open, stops/targets checked inside each bar (adverse move first) and filled
          only at prices the bar traded, costs per F&amp;O order. A slot freed inside a bar is reusable from the next bar&apos;s open.
          Slippage is the configured points per fill (0 = fills exactly at the level, which live market orders will not get).
          Wednesdays have no previous session in the options DB (the new weekly contract starts there), so their early-session
          indicators differ from live; every other day warms up on the previous session. Not modelled: tick-level fills, broker rejections. Max adverse = worst premium rise above entry while open.
        </p>

        {/* Verification & Accuracy Audit Report */}
        <div id="backtest-audit-report" className="pt-2">
          <BacktestAuditReport
            audit={data?.store?.audit ?? null}
            storeConfigKey={data?.store?.configKey ?? null}
            tradeCount={days.reduce((a, d) => a + d.trades.length, 0)}
            isOpen={auditOpen}
            onToggle={() => setAuditOpen((o) => !o)}
          />
        </div>

        <OptimizationReport pageConfig={pageConfig} />
      </div>
    </section>
  );
}
