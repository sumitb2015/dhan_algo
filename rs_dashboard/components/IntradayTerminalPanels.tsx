'use client';

/**
 * Presentational panels for the Intraday Terminal.
 *
 * Split out of IntradayTerminal.tsx so the shell owns only polling, the control
 * plane and layout. Everything here is a pure render of props — no fetching.
 */

import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer,
  Tooltip as RTooltip, XAxis, YAxis,
} from 'recharts';
import { cn } from '@/lib/utils';
import {
  CONDITION_LABELS, CONDITION_NAMES, CONDITION_TOOLTIPS, HARD_GATES,
  type CandleBar, type CandlePayload, type ConditionName, type TerminalCandidate,
  type TerminalEvent, type TerminalOrder, type TerminalPosition, type TerminalState,
} from '@/lib/terminalTypes';
import {
  vwapBps,
  type GateBlocker, type Health, type NearMiss, type Regime,
  type SectorRow, type SessionClock, type Tone, type TradeStats,
} from '@/lib/terminalIntel';

// ── Formatting ───────────────────────────────────────────────────────────────

export const fmt = (n: number | null | undefined, d = 2) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(d);

export const fmtInr = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? '—'
    : `${n < 0 ? '-' : ''}${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const TONE_TEXT: Record<Tone, string> = {
  up: 'text-emerald-400',
  down: 'text-red-400',
  warn: 'text-amber-400',
  neutral: 'text-zinc-100',
};

// ── Shell bits ───────────────────────────────────────────────────────────────

export function Panel({ title, subtitle, right, children, className }: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn(
      'bg-zinc-900/60 border border-zinc-800 rounded-2xl flex flex-col min-h-0 overflow-hidden',
      className,
    )}>
      <header className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-zinc-800/60 shrink-0">
        <div className="min-w-0">
          <h2 className="text-xs font-bold text-white tracking-wide uppercase truncate">{title}</h2>
          {subtitle && <p className="text-[10px] text-zinc-500 font-medium truncate">{subtitle}</p>}
        </div>
        {right}
      </header>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </section>
  );
}

export function Stat({ label, value, tone = 'neutral', hint }: {
  label: string; value: React.ReactNode; tone?: Tone; hint?: string;
}) {
  return (
    <div className="flex flex-col leading-tight" title={hint}>
      <span className="text-[9px] uppercase tracking-[0.14em] text-zinc-500 font-bold">{label}</span>
      <span className={cn('text-[13px] font-semibold tabular-nums', TONE_TEXT[tone])}>{value}</span>
    </div>
  );
}

/** Segmented control — the skill's standard view-mode toggle. */
export function Segmented<T extends string>({ options, value, onChange }: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'px-2 py-0.5 rounded-md text-[10px] font-bold transition-colors',
            value === o.value
              ? 'bg-emerald-500/15 text-emerald-300'
              : 'text-zinc-500 hover:text-zinc-300',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Eight pass/fail chips. Hard gates get a ring so a blocking failure is visible
 *  at a glance — a soft miss looks different from a gate that stops the trade. */
export function ConditionStrip({ conds, blocked }: {
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

export function ScoreBar({ score }: { score: number }) {
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

export function Gauge({ label, value, max, tone }: {
  label: string; value: number; max: number; tone: 'red' | 'blue' | 'emerald';
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const bar = tone === 'red'
    ? (pct > 75 ? 'bg-red-500' : pct > 50 ? 'bg-amber-500' : 'bg-amber-400')
    : tone === 'blue' ? 'bg-blue-500' : 'bg-emerald-500';
  return (
    <div className="shrink-0">
      <div className="flex justify-between text-[10px] mb-0.5">
        <span className="text-zinc-500 font-medium">{label}</span>
        <span className="tabular-nums text-zinc-300">{fmtInr(value)} / {fmtInr(max)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', bar)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── Intelligence ribbon ──────────────────────────────────────────────────────

function BreadthBar({ label, pct }: { label: string; pct: number }) {
  const tone = pct >= 55 ? 'bg-emerald-500' : pct >= 30 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="min-w-[104px]">
      <div className="flex justify-between text-[10px] mb-1">
        <span className="text-zinc-500 font-medium">{label}</span>
        <span className="tabular-nums text-zinc-300 font-semibold">{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

function RibbonBlock({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return (
    <div className={cn('flex flex-col justify-center gap-1.5 py-1',
      !first && 'pl-5 border-l border-zinc-800')}>
      {children}
    </div>
  );
}

/**
 * The read-at-a-glance strip: is the tape tradeable, how much of the entry
 * window is left, is the feed honest, and what has today actually produced.
 */
export function IntelRibbon({ regime, clock, health, stats, dayPnl }: {
  regime: Regime | null;
  clock: SessionClock | null;
  health: Health;
  stats: TradeStats | null;
  dayPnl: number;
}) {
  const rTone = regime?.tone ?? 'neutral';
  const ring = rTone === 'up' ? 'border-emerald-500/30' : rTone === 'down' ? 'border-red-500/30' : 'border-amber-500/30';

  return (
    <div className={cn('relative overflow-hidden rounded-2xl border bg-zinc-900/60', ring)}>
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-emerald-500/[0.06] via-transparent to-red-500/[0.05]" />

      <div className="relative flex items-stretch gap-5 px-5 py-3.5 flex-wrap">
        {/* Regime */}
        <RibbonBlock first>
          <span className="text-[9px] uppercase tracking-[0.16em] text-zinc-500 font-bold">Universe regime</span>
          {regime ? (
            <div className="flex items-baseline gap-2">
              <span className={cn('text-xl font-bold tabular-nums leading-none', TONE_TEXT[rTone])}>
                {regime.score.toFixed(0)}
              </span>
              <span className={cn('text-[11px] font-bold', TONE_TEXT[rTone])}>{regime.label}</span>
            </div>
          ) : (
            <span className="text-sm text-zinc-500">—</span>
          )}
          <span className="text-[10px] text-zinc-500">
            {regime ? `${regime.tradeable} tradeable / ${regime.universe} · mean score ${regime.meanScore.toFixed(0)}` : 'no scan yet'}
          </span>
        </RibbonBlock>

        {/* Breadth legs */}
        {regime && (
          <RibbonBlock>
            <div className="flex gap-4 flex-wrap">
              <BreadthBar label="Above VWAP" pct={regime.aboveVwapPct} />
              <BreadthBar label="ST bull 5m" pct={regime.stBullPct} />
              <BreadthBar label="RS+ vs NIFTY" pct={regime.rsDayPct} />
            </div>
          </RibbonBlock>
        )}

        {/* Session clock */}
        <RibbonBlock>
          <span className="text-[9px] uppercase tracking-[0.16em] text-zinc-500 font-bold">Session</span>
          {clock ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className={cn('text-[13px] font-bold', TONE_TEXT[clock.tone])}>{clock.label}</span>
                {clock.minsLeft !== null && (
                  <span className="text-[11px] tabular-nums text-zinc-300 font-semibold">
                    {clock.minsLeft}m left
                  </span>
                )}
              </div>
              <div className="h-1 w-40 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className={cn('h-full rounded-full',
                    clock.phase === 'ENTRY' ? 'bg-emerald-500'
                      : clock.phase === 'PRE' ? 'bg-zinc-600' : 'bg-amber-500')}
                  style={{ width: `${clock.entryProgress * 100}%` }}
                />
              </div>
              <span className="text-[10px] text-zinc-500 tabular-nums">
                {clock.entryStart}–{clock.entryCutoff} entry · {clock.squareOff} square-off
              </span>
            </>
          ) : (
            <span className="text-sm text-zinc-500">—</span>
          )}
        </RibbonBlock>

        {/* Health */}
        <RibbonBlock>
          <span className="text-[9px] uppercase tracking-[0.16em] text-zinc-500 font-bold">Feed health</span>
          <div className="flex items-center gap-1.5">
            <span className={cn('h-1.5 w-1.5 rounded-full',
              health.verdict === 'OK' ? 'bg-emerald-400 animate-pulse'
                : health.verdict === 'OFFLINE' ? 'bg-zinc-600' : 'bg-amber-400')} />
            <span className={cn('text-[13px] font-bold', TONE_TEXT[health.tone])}>{health.verdict}</span>
          </div>
          <span className="text-[10px] text-zinc-500 max-w-[190px]">
            {health.reasons.length
              ? health.reasons.join(' · ')
              : `poll ${health.pollLagS != null ? `${health.pollLagS.toFixed(0)}s` : '—'} · last ${health.lastPoll ?? '—'}`}
          </span>
        </RibbonBlock>

        {/* Today */}
        <RibbonBlock>
          <span className="text-[9px] uppercase tracking-[0.16em] text-zinc-500 font-bold">Closed today</span>
          {stats ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] font-bold text-zinc-100 tabular-nums">{stats.closed} trades</span>
                <span className={cn('text-[11px] font-bold tabular-nums',
                  stats.winRate >= 50 ? 'text-emerald-400' : 'text-red-400')}>
                  {stats.winRate.toFixed(0)}% win
                </span>
              </div>
              <span className="text-[10px] text-zinc-500 tabular-nums">
                PF {stats.profitFactor === null ? '∞' : stats.profitFactor.toFixed(2)} ·
                {' '}exp {fmtInr(stats.expectancy)} · best {fmtInr(stats.best)} / worst {fmtInr(stats.worst)}
              </span>
            </>
          ) : (
            <span className="text-[11px] text-zinc-500">No closed trades yet</span>
          )}
        </RibbonBlock>

        {/* Day P&L, pinned right */}
        <div className="ml-auto flex flex-col justify-center items-end pl-5 border-l border-zinc-800">
          <span className="text-[9px] uppercase tracking-[0.16em] text-zinc-500 font-bold">Day P&amp;L</span>
          <span className={cn('text-2xl font-bold tabular-nums leading-tight',
            dayPnl > 0 ? 'text-emerald-400' : dayPnl < 0 ? 'text-red-400' : 'text-zinc-100')}>
            {fmtInr(dayPnl)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Gate blockers ────────────────────────────────────────────────────────────

export function GateBlockerPanel({ blockers, universe }: {
  blockers: GateBlocker[]; universe: number;
}) {
  if (!blockers.length) {
    return <div className="p-6 text-center text-zinc-500 text-[11px]">No scan data yet</div>;
  }
  return (
    <div className="p-3 flex flex-col gap-2">
      {blockers.map((b) => (
        <div key={b.name} title={CONDITION_TOOLTIPS[b.name]}>
          <div className="flex items-center justify-between text-[10px] mb-1">
            <span className="flex items-center gap-1.5">
              <span className={cn('inline-flex items-center justify-center w-[19px] h-[15px] rounded-[3px] text-[9px] font-bold',
                b.hard ? 'bg-zinc-800 text-zinc-300 ring-1 ring-zinc-700' : 'bg-zinc-800 text-zinc-500')}>
                {CONDITION_LABELS[b.name]}
              </span>
              <span className={b.hard ? 'text-zinc-300 font-semibold' : 'text-zinc-500'}>
                {b.hard ? 'gate' : 'score'}
              </span>
              {b.soleBlockFor > 0 && (
                <span className="text-amber-400 font-semibold">
                  · sole blocker for {b.soleBlockFor}
                </span>
              )}
            </span>
            <span className="tabular-nums text-zinc-400">{b.failing}/{universe} failing</span>
          </div>
          <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className={cn('h-full rounded-full',
                !b.hard ? 'bg-zinc-600'
                  : b.pct >= 70 ? 'bg-red-500' : b.pct >= 40 ? 'bg-amber-500' : 'bg-emerald-500')}
              style={{ width: `${b.pct}%` }}
            />
          </div>
        </div>
      ))}
      <p className="text-[10px] text-zinc-500 mt-1">
        Hard gates must all pass for a name to be tradeable; the rest only feed the score.
      </p>
    </div>
  );
}

// ── Near miss ────────────────────────────────────────────────────────────────

export function NearMissPanel({ rows, onSelect }: {
  rows: NearMiss[]; onSelect: (s: string) => void;
}) {
  if (!rows.length) {
    return <div className="p-6 text-center text-zinc-500 text-[11px]">Nothing within one gate</div>;
  }
  return (
    <div className="p-2 flex flex-col">
      {rows.map((r) => (
        <button
          key={r.symbol}
          onClick={() => onSelect(r.symbol)}
          className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-zinc-800/50 text-left"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
          <span className="text-[11px] font-semibold text-zinc-100 w-24 truncate">{r.symbol}</span>
          <span className="text-[11px] tabular-nums text-zinc-400 w-8 text-right">{r.score.toFixed(0)}</span>
          <span
            className="ml-auto text-[10px] font-bold text-amber-400"
            title={CONDITION_TOOLTIPS[r.blocker]}
          >
            needs {CONDITION_LABELS[r.blocker]}
          </span>
        </button>
      ))}
    </div>
  );
}

// ── Sector heat ──────────────────────────────────────────────────────────────

export function SectorHeatPanel({ rows, cap }: { rows: SectorRow[]; cap: number }) {
  if (!rows.length) {
    return <div className="p-6 text-center text-zinc-500 text-[11px]">No scan data yet</div>;
  }
  return (
    <div className="p-3 flex flex-col gap-1.5">
      {rows.map((r) => (
        <div
          key={r.sector}
          className={cn('flex items-center gap-2 rounded-lg px-2 py-1',
            r.atCap && 'ring-1 ring-amber-500/40 bg-amber-500/[0.06]')}
          title={r.atCap ? `Sector cap reached (${r.open}/${cap} positions)` : undefined}
        >
          <span className="text-[11px] text-zinc-300 w-28 truncate">{r.sector}</span>
          <div className="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className={cn('h-full rounded-full',
                r.meanScore >= 70 ? 'bg-emerald-500' : r.meanScore >= 50 ? 'bg-blue-500' : 'bg-zinc-600')}
              style={{ width: `${Math.max(0, Math.min(100, r.meanScore))}%` }}
            />
          </div>
          <span className="text-[10px] tabular-nums text-zinc-400 w-7 text-right">{r.meanScore.toFixed(0)}</span>
          <span className="text-[10px] tabular-nums text-emerald-400 w-9 text-right">{r.gated}✓</span>
          <span className={cn('text-[10px] tabular-nums w-8 text-right',
            r.atCap ? 'text-amber-400 font-bold' : 'text-zinc-500')}>
            {r.open}/{cap}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Blotter ──────────────────────────────────────────────────────────────────

export type SortKey = 'score' | 'symbol' | 'ltp' | 'vwap_bps' | 'sector';

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'score', label: 'Score' },
  { value: 'symbol', label: 'Symbol' },
  { value: 'ltp', label: 'LTP' },
  { value: 'vwap_bps', label: 'vs VWAP' },
  { value: 'sector', label: 'Sector' },
];

export function BlotterControls({ sortKey, onSort, showAll, onToggleAll, total }: {
  sortKey: SortKey; onSort: (k: SortKey) => void;
  showAll: boolean; onToggleAll: () => void; total: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <select
        value={sortKey}
        onChange={(e) => onSort(e.target.value as SortKey)}
        className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1 text-[10px] font-semibold text-zinc-300"
      >
        {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <button
        onClick={onToggleAll}
        className="inline-flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 text-[10px] font-semibold text-zinc-400 hover:text-zinc-200"
      >
        {showAll ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        {showAll ? 'Top 18' : `All ${total}`}
      </button>
    </div>
  );
}

export function BlotterTable({ rows, selected, onSelect, flash, nearMiss }: {
  rows: TerminalCandidate[];
  selected: string | null;
  onSelect: (s: string) => void;
  flash: Record<string, 'up' | 'down'>;
  nearMiss: Set<string>;
}) {
  return (
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
          const near = !c.gated && nearMiss.has(c.symbol);
          return (
            <tr
              key={c.symbol}
              onClick={() => onSelect(c.symbol)}
              className={cn(
                'border-b border-zinc-800/40 cursor-pointer hover:bg-zinc-800/40',
                !c.gated && !near && 'opacity-55',
                near && 'opacity-85',
                selected === c.symbol && 'bg-zinc-800/60',
              )}
            >
              <td className="px-2 py-1 text-zinc-500 tabular-nums">{i + 1}</td>
              <td className="px-2 py-1">
                <span className="font-semibold text-zinc-100">{c.symbol}</span>
                {c.gated && (
                  <span className="ml-1.5 text-[9px] font-bold text-emerald-400" title="Tradeable — all hard gates pass">●</span>
                )}
                {near && (
                  <span className="ml-1.5 text-[9px] font-bold text-amber-400" title="One hard gate away">◐</span>
                )}
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
  );
}

// ── Positions ────────────────────────────────────────────────────────────────

/** Where LTP sits between stop and target — risk read without arithmetic. */
function RiskRail({ p }: { p: TerminalPosition }) {
  const lo = Math.min(p.stop, p.target);
  const hi = Math.max(p.stop, p.target);
  const span = hi - lo;
  if (!(span > 0) || !Number.isFinite(p.ltp)) {
    return <span className="text-zinc-600">—</span>;
  }
  const pos = Math.max(0, Math.min(1, (p.ltp - lo) / span));
  const entry = Math.max(0, Math.min(1, (p.entry_price - lo) / span));
  // A LONG runs stop→target left-to-right; a SHORT is the mirror image.
  const left = p.side === 'SHORT' ? 1 - pos : pos;
  const entryLeft = p.side === 'SHORT' ? 1 - entry : entry;
  return (
    <div className="relative h-1.5 w-20 rounded-full bg-gradient-to-r from-red-500/40 via-zinc-700 to-emerald-500/40">
      <span className="absolute top-[-2px] h-[10px] w-px bg-zinc-500" style={{ left: `${entryLeft * 100}%` }} />
      <span
        className={cn('absolute top-[-1px] h-[8px] w-[3px] rounded-full',
          p.r_multiple >= 0 ? 'bg-emerald-400' : 'bg-red-400')}
        style={{ left: `calc(${left * 100}% - 1.5px)` }}
      />
    </div>
  );
}

export function PositionsTable({ positions }: { positions: TerminalPosition[] }) {
  if (!positions.length) {
    return <div className="p-6 text-center text-zinc-500 text-[11px]">No open positions</div>;
  }
  return (
    <table className="w-full text-[11px]">
      <thead className="sticky top-0 z-10">
        <tr className="bg-zinc-800 text-xs font-bold text-white">
          <th className="text-left px-2 py-1.5">Symbol</th>
          <th className="text-left px-2 py-1.5">Side</th>
          <th className="text-right px-2 py-1.5">Qty</th>
          <th className="text-right px-2 py-1.5">Entry</th>
          <th className="text-right px-2 py-1.5">LTP</th>
          <th className="text-right px-2 py-1.5">Stop</th>
          <th className="text-right px-2 py-1.5">Target</th>
          <th className="text-left px-2 py-1.5">Risk</th>
          <th className="text-right px-2 py-1.5">R</th>
          <th className="text-right px-2 py-1.5">P&amp;L</th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => (
          <tr key={p.symbol} className="border-b border-zinc-800/40">
            <td className="px-2 py-1 font-semibold text-zinc-100">{p.symbol}</td>
            <td className={cn('px-2 py-1 font-bold',
              p.side === 'LONG' ? 'text-emerald-400' : 'text-red-400')}>{p.side}</td>
            <td className="px-2 py-1 text-right tabular-nums text-zinc-200">{p.qty}</td>
            <td className="px-2 py-1 text-right tabular-nums text-zinc-400">{fmt(p.entry_price)}</td>
            <td className="px-2 py-1 text-right tabular-nums text-zinc-100">{fmt(p.ltp)}</td>
            <td className="px-2 py-1 text-right tabular-nums text-red-400">{fmt(p.stop)}</td>
            <td className="px-2 py-1 text-right tabular-nums text-emerald-400">{fmt(p.target)}</td>
            <td className="px-2 py-1"><RiskRail p={p} /></td>
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
  );
}

// ── Equity curve ─────────────────────────────────────────────────────────────

// Grid/axis colours are themed globally by recharts class name in app/globals.css,
// so only the shape is set here — a hex would be overridden anyway and would break
// white mode if the global rule ever moved.
const gridProps = { strokeDasharray: '3 6', vertical: false as const };

function EquityTooltip({ active, payload, label }: {
  active?: boolean; payload?: { value: number }[]; label?: string;
}) {
  if (!active || !payload?.length) return null;
  const v = payload[0].value;
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[160px] font-mono">
      <div className="text-zinc-400 mb-1">{label}</div>
      <div className="flex justify-between gap-8">
        <span className="text-zinc-500">Realised</span>
        <span className={v >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtInr(v)}</span>
      </div>
    </div>
  );
}

export function EquityCurve({ data }: { data: { ts: string; pnl: number }[] }) {
  if (data.length < 2) {
    return (
      <div className="h-full grid place-items-center text-zinc-500 text-[11px]">
        No closed trades yet
      </div>
    );
  }
  const last = data[data.length - 1].pnl;
  const col = last >= 0 ? '#10b981' : '#ef4444';
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="terminal-eq" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={col} stopOpacity={0.45} />
            <stop offset="100%" stopColor={col} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="ts" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 9 }} axisLine={false} tickLine={false} width={46} />
        <ReferenceLine y={0} stroke="currentColor" strokeWidth={1} className="text-zinc-600" />
        <RTooltip
          content={<EquityTooltip />}
          cursor={{ stroke: 'currentColor', strokeWidth: 1, strokeDasharray: '4 4', className: 'text-zinc-600' }}
        />
        <Area type="monotone" dataKey="pnl" stroke={col} strokeWidth={1.6} fill="url(#terminal-eq)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── Price chart ──────────────────────────────────────────────────────────────

/**
 * Cumulative session VWAP over the full bar list.
 *
 * Computed over ALL bars and trimmed by the caller — slicing to the visible
 * window first would restart the cumulation and draw a VWAP that never was.
 */
function sessionVwap(bars: CandleBar[]): number[] {
  const out: number[] = [];
  let cumPV = 0, cumV = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    cumPV += tp * (b.v || 0);
    cumV += b.v || 0;
    out.push(cumV > 0 ? cumPV / cumV : b.c);
  }
  return out;
}

/**
 * Lightweight inline candles — no chart library, so the panel adds no bundle
 * weight on a page that already ships recharts for the equity curve.
 *
 * VWAP is recomputed here from the bars (typical price × volume, cumulative)
 * rather than taken from the state file: the state carries one scalar for the
 * latest tick, and the whole point of the overlay is the session's path.
 */
export function MiniChart({ payload, position }: {
  payload: CandlePayload | null;
  position?: TerminalPosition | null;
}) {
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

  const vwapAll = sessionVwap(bars);

  const N = 140;
  const show = bars.slice(-N);
  const vwap = vwapAll.slice(-N);

  const levels: { v: number; col: string; label: string }[] = [];
  if (position) {
    if (Number.isFinite(position.stop)) levels.push({ v: position.stop, col: '#ef4444', label: 'SL' });
    if (Number.isFinite(position.target)) levels.push({ v: position.target, col: '#10b981', label: 'TP' });
    // Entry is chrome, not a data series — currentColor so it flips with the theme.
    if (Number.isFinite(position.entry_price)) levels.push({ v: position.entry_price, col: 'currentColor', label: 'E' });
  }

  const hi = Math.max(...show.map((b) => b.h), ...vwap, ...levels.map((l) => l.v));
  const lo = Math.min(...show.map((b) => b.l), ...vwap, ...levels.map((l) => l.v));
  const span = hi - lo || 1;
  const W = 1000, H = 260, pad = 8;
  const bw = (W - pad * 2) / show.length;
  const y = (v: number) => pad + (1 - (v - lo) / span) * (H - pad * 2);
  const x = (i: number) => pad + i * bw + bw / 2;

  const last = show[show.length - 1];
  const first = show[0];
  const up = last.c >= first.o;
  const lastVwap = vwap[vwap.length - 1];
  const bps = lastVwap ? ((last.c - lastVwap) / lastVwap) * 10000 : 0;

  return (
    <div className="h-full flex flex-col">
      <div className="flex gap-4 px-3 py-1 text-[10px] tabular-nums border-b border-zinc-800/40 flex-wrap">
        <span className="text-zinc-500">O <span className="text-zinc-300">{fmt(last.o)}</span></span>
        <span className="text-zinc-500">H <span className="text-zinc-300">{fmt(last.h)}</span></span>
        <span className="text-zinc-500">L <span className="text-zinc-300">{fmt(last.l)}</span></span>
        <span className="text-zinc-500">C <span className={up ? 'text-emerald-400' : 'text-red-400'}>{fmt(last.c)}</span></span>
        <span className="text-zinc-500">VWAP <span className="text-blue-400">{fmt(lastVwap)}</span></span>
        <span className={bps >= 0 ? 'text-emerald-400' : 'text-red-400'}>
          {bps >= 0 ? '+' : ''}{bps.toFixed(0)}bp
        </span>
        <span className="ml-auto text-zinc-600">{show.length} bars · {payload.interval}m</span>
      </div>
      <div className="flex-1 min-h-0">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-full text-zinc-500">
          {levels.map((l) => (
            <g key={l.label}>
              <line x1={0} x2={W} y1={y(l.v)} y2={y(l.v)} stroke={l.col} strokeWidth={1}
                    strokeDasharray="6 6" opacity={0.7} />
            </g>
          ))}
          <polyline
            points={vwap.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
            fill="none" stroke="#60a5fa" strokeWidth={1.2} opacity={0.85}
          />
          {show.map((b, i) => {
            const green = b.c >= b.o;
            const col = green ? '#34d399' : '#f87171';
            const yO = y(b.o), yC = y(b.c);
            return (
              <g key={i}>
                <line x1={x(i)} x2={x(i)} y1={y(b.h)} y2={y(b.l)} stroke={col} strokeWidth={1} />
                <rect x={x(i) - Math.max(bw * 0.3, 0.8)} width={Math.max(bw * 0.6, 1.6)}
                      y={Math.min(yO, yC)} height={Math.max(Math.abs(yC - yO), 1)} fill={col} />
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// ── Log ──────────────────────────────────────────────────────────────────────

export function LogFeed({ orders, events }: {
  orders: TerminalOrder[]; events: TerminalEvent[];
}) {
  if (!orders.length && !events.length) {
    return <div className="p-6 text-center text-zinc-500 text-[11px]">No activity yet</div>;
  }
  return (
    <div className="font-mono text-[11px]">
      {orders.map((o, i) => (
        <div
          key={`o${i}`}
          className={cn('flex gap-3 px-3 py-0.5 border-b border-zinc-800/30 border-l-2',
            o.kind === 'ENTRY' ? 'border-l-emerald-500/60' : 'border-l-amber-500/60')}
        >
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
      {events.map((e, i) => (
        <div
          key={`e${i}`}
          className={cn('flex gap-3 px-3 py-0.5 border-b border-zinc-800/30 border-l-2',
            e.level === 'ERROR' ? 'border-l-red-500/60'
              : e.level === 'WARN' ? 'border-l-amber-500/50' : 'border-l-zinc-700')}
        >
          <span className="text-zinc-500 tabular-nums w-16 shrink-0">{e.ts}</span>
          <span className={cn('w-12 shrink-0 font-bold',
            e.level === 'ERROR' ? 'text-red-400'
              : e.level === 'WARN' ? 'text-amber-400' : 'text-zinc-500')}>{e.type}</span>
          <span className="w-24 shrink-0 text-zinc-300">{e.symbol || '—'}</span>
          <span className="text-zinc-400">{e.msg}</span>
        </div>
      ))}
    </div>
  );
}

/** Re-exported so the shell can render risk gauges without importing state types twice. */
export function RiskGauges({ risk }: { risk: TerminalState['risk'] }) {
  return (
    <div className="flex flex-col gap-2">
      <Gauge label="Daily loss used" value={risk.daily_loss_used} max={risk.max_daily_loss} tone="red" />
      <Gauge label="Capital deployed" value={risk.deployed} max={risk.max_deployed} tone="blue" />
      <Gauge label="Trades used" value={risk.trades_today} max={risk.max_trades} tone="emerald" />
    </div>
  );
}
