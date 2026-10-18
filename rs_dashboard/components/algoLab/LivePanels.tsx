'use client';

import { useState } from 'react';
import {
  Activity,
  AlertOctagon,
  BookOpen,
  ListChecks,
  Minus,
  Pause,
  Play,
  ScrollText,
  Settings,
  ShieldAlert,
  Trash2,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { legOf, openPnlOf } from '@/lib/algoLab/ledger';
import type { AlgoPosition, AuditLogItem, Candidate, GateResult, LedgerMode, StrategyDefinition } from '@/lib/algoLab/types';
import { exitLabel, exitTone, fmtCell, inr, pnlTone, px } from './format';

const panel = 'rounded-xl border border-zinc-800 bg-zinc-950/70 backdrop-blur';
const head = 'flex items-center justify-between gap-2 border-b border-zinc-800 px-4 py-2.5';
const TH = 'whitespace-nowrap px-2.5 py-2';

export function BiasStrip({
  def,
  gate,
  engineActive,
  mode,
  openCount,
  realized,
  unrealized,
  account,
  dailyLossLimit = 5000,
  maxConcurrent = 2,
  maxSameSide = 1,
  underlying = 'NIFTY',
  vixLtp,
  vixChangePct,
  vixPrevClose,
  wsTransport = 'ws',
  wsStatus = 'RUNNING',
  wsStale = false,
  onToggleEngine,
  onSquareOff,
  onOpenRules,
  onOpenDocs,
}: {
  def: StrategyDefinition;
  gate: GateResult | null;
  engineActive: boolean;
  mode: LedgerMode;
  openCount: number;
  realized: number;
  unrealized: number;
  account: { total: number; limit: number } | null;
  dailyLossLimit?: number;
  maxConcurrent?: number;
  maxSameSide?: number;
  underlying?: string;
  vixLtp?: number | null;
  vixChangePct?: number | null;
  vixPrevClose?: number | null;
  wsTransport?: 'ws' | 'poll';
  wsStatus?: string;
  wsStale?: boolean;
  onToggleEngine: () => void;
  onSquareOff: () => void;
  onOpenRules: () => void;
  onOpenDocs?: () => void;
}) {
  const totalPnl = realized + unrealized;
  const isLossBreached = totalPnl <= -dailyLossLimit;
  const remainingBudget = Math.max(0, dailyLossLimit + totalPnl);
  const budgetPct = Math.min(100, Math.max(0, (remainingBudget / dailyLossLimit) * 100));

  const pnlColor = (v: number) => (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-zinc-400');

  // Trend detection
  const isBull = gate?.tone === 'bull' || gate?.bias === 'BULLISH';
  const isBear = gate?.tone === 'bear' || gate?.bias === 'BEARISH';
  const isSideways = !isBull && !isBear;

  const m = gate?.metrics;
  const spot = typeof m?.spot === 'number' ? m.spot : null;
  const emaFast = typeof m?.emaFast === 'number' ? m.emaFast : null;
  const emaSlow = typeof m?.emaSlow === 'number' ? m.emaSlow : null;
  const spread = typeof m?.spread === 'number' ? m.spread : null;
  const stLine = typeof m?.stLine === 'number' ? m.stLine : null;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 backdrop-blur">
      {/* Top row: Underlying telemetry & Market Trend & Action Buttons */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        {/* Left: Underlying ticker & indicator chips */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">{underlying} SPOT:</span>
            <span className="font-mono text-base font-extrabold text-white">{spot != null && spot > 0 ? spot.toFixed(1) : '—'}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-zinc-400">
            {emaFast != null && emaSlow != null && (
              <>
                <span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5">
                  EMA Fast: <strong className="font-mono text-zinc-200">{emaFast.toFixed(1)}</strong>
                </span>
                <span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5">
                  EMA Slow: <strong className="font-mono text-zinc-200">{emaSlow.toFixed(1)}</strong>
                </span>
                <span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5">
                  Spread:{' '}
                  <strong className={cn('font-mono', spread != null && spread > 0 ? 'text-emerald-400' : spread != null && spread < 0 ? 'text-red-400' : 'text-zinc-400')}>
                    {spread != null ? (spread > 0 ? `+${spread.toFixed(1)}` : spread.toFixed(1)) : '—'}
                  </strong>
                </span>
              </>
            )}

            {stLine != null && (
              <span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5">
                ST: <strong className="font-mono text-zinc-200">{stLine.toFixed(1)}</strong>
              </span>
            )}

            <span className="flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5">
              <span className="text-zinc-400">INDIA VIX:</span>
              <strong className="font-mono text-zinc-100">{vixLtp != null ? vixLtp.toFixed(2) : '—'}</strong>
              {vixChangePct != null && (
                <span
                  className={cn('font-mono text-[11px] font-bold', vixChangePct > 0 ? 'text-amber-400' : 'text-sky-400')}
                  title={vixPrevClose != null ? `Yesterday close: ₹${vixPrevClose.toFixed(2)}` : undefined}
                >
                  {vixChangePct > 0 ? '▲' : vixChangePct < 0 ? '▼' : ''} {vixChangePct > 0 ? `+${vixChangePct.toFixed(2)}%` : `${vixChangePct.toFixed(2)}%`}
                </span>
              )}
            </span>

            {wsStatus && (
              <span
                className={cn(
                  'flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[11px] font-bold',
                  wsStatus !== 'RUNNING'
                    ? 'border-zinc-800 bg-zinc-900 text-zinc-400'
                    : wsStale
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                    : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
                )}
                title={`Live Options WebSocket: ${wsStatus} · Transport: ${wsTransport?.toUpperCase() ?? 'WS'}`}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    wsStatus !== 'RUNNING' ? 'bg-zinc-500' : wsStale ? 'animate-pulse bg-amber-400' : 'animate-ping bg-emerald-400',
                  )}
                />
                <span>{wsStatus !== 'RUNNING' ? `WS ${wsStatus}` : wsStale ? 'WS STALE' : `LIVE · ${wsTransport?.toUpperCase() ?? 'WS'}`}</span>
              </span>
            )}
          </div>
        </div>

        {/* Center / Right: Engine Controls & Actions */}
        <div className="flex items-center gap-2">
          {/* Engine state button */}
          <button
            type="button"
            onClick={onToggleEngine}
            disabled={isLossBreached}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold shadow-sm transition-all',
              engineActive
                ? 'border border-emerald-500/40 bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30'
                : 'border border-zinc-700 bg-zinc-800/90 text-zinc-300 hover:bg-zinc-700',
              isLossBreached && 'cursor-not-allowed opacity-50',
            )}
          >
            {engineActive ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
                </span>
                <Pause className="h-3.5 w-3.5" />
                <span>AUTO-TRADER ACTIVE</span>
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5 text-zinc-400" />
                <span>AUTO-TRADER PAUSED</span>
              </>
            )}
          </button>

          {/* Square Off All */}
          <button
            type="button"
            onClick={onSquareOff}
            disabled={openCount === 0}
            className="flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-bold text-red-400 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            title="Immediately close all active open positions"
          >
            <AlertOctagon className="h-3.5 w-3.5" />
            <span>EXIT ALL ({openCount})</span>
          </button>

          {/* Settings button */}
          <button
            type="button"
            onClick={onOpenRules}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-800"
          >
            <Settings className="h-3.5 w-3.5 text-zinc-400" />
            <span>RULES</span>
          </button>

          {/* Docs / Playbook button */}
          {onOpenDocs ? (
            <button
              type="button"
              onClick={onOpenDocs}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-emerald-400 transition hover:border-emerald-500/30 hover:bg-zinc-800"
              title="Open Strategy Playbook & Rules Documentation"
            >
              <BookOpen className="h-3.5 w-3.5 text-emerald-400" />
              <span>PLAYBOOK</span>
            </button>
          ) : (
            <span className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-[11px] font-mono text-zinc-400" title={def.docPath}>
              SPEC: {def.docPath.split('/').pop()}
            </span>
          )}
        </div>
      </div>

      {/* Second row: Market Direction Filter Badges, Risk Monitor & India VIX */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
        {/* 1. Underlying Trend / Strategy Gate Badge */}
        <div className="flex items-center justify-between rounded-lg border border-zinc-800/80 bg-zinc-900/60 p-2.5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Market Direction Filter</p>
            <div className="mt-0.5 flex items-center gap-1.5">
              {isBull && <TrendingUp className="h-4 w-4 text-emerald-400" />}
              {isBear && <TrendingDown className="h-4 w-4 text-red-400" />}
              {isSideways && <Minus className="h-4 w-4 text-amber-400" />}
              <span className={cn('text-sm font-extrabold tracking-tight', isBull ? 'text-emerald-400' : isBear ? 'text-red-400' : 'text-amber-400')}>
                {gate?.bias ?? (isBull ? 'BULLISH' : isBear ? 'BEARISH' : 'SIDEWAYS')}
              </span>
            </div>
          </div>
          <span className="text-[10px] font-medium text-zinc-500">Auto Bias Active</span>
        </div>

        {/* 2. Selling Eligibility Pill */}
        <div className="flex items-center justify-between rounded-lg border border-zinc-800/80 bg-zinc-900/60 p-2.5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Eligible Trading Side</p>
            <div className="mt-0.5 flex items-center gap-1.5">
              {gate?.allowed?.length ? (
                gate.allowed.map((opt) => (
                  <span
                    key={opt}
                    className={cn(
                      'rounded border px-2 py-0.5 text-xs font-bold uppercase tracking-wider',
                      opt === 'PE'
                        ? 'border-emerald-500/30 bg-emerald-500/20 text-emerald-300'
                        : opt === 'CE'
                        ? 'border-red-500/30 bg-red-500/20 text-red-300'
                        : 'border-sky-500/30 bg-sky-500/20 text-sky-300',
                    )}
                  >
                    {def.side} {opt} ONLY
                  </span>
                ))
              ) : (
                <span className="rounded border border-amber-500/30 bg-amber-500/20 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-amber-300">
                  BLOCKED: SIDEWAYS
                </span>
              )}
            </div>
          </div>
          <span className="max-w-[130px] truncate text-right text-[10px] font-medium text-zinc-500" title={gate?.detail ?? undefined}>
            {gate?.detail ?? 'Active'}
          </span>
        </div>

        {/* 3. India VIX · Volatility Regime Card */}
        <div className="flex items-center justify-between rounded-lg border border-zinc-800/80 bg-zinc-900/60 p-2.5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">India VIX · Volatility</p>
            <div className="mt-0.5 flex items-center gap-1.5">
              <Activity className={cn('h-4 w-4', vixChangePct != null && vixChangePct > 0 ? 'text-amber-400' : 'text-sky-400')} />
              <span className="font-mono text-sm font-extrabold text-white">{vixLtp != null ? vixLtp.toFixed(2) : '—'}</span>
              {vixChangePct != null && (
                <span className={cn('font-mono text-xs font-bold', vixChangePct > 0 ? 'text-amber-400' : 'text-sky-400')}>
                  {vixChangePct > 0 ? '▲' : vixChangePct < 0 ? '▼' : ''} {vixChangePct > 0 ? `+${vixChangePct.toFixed(2)}%` : `${vixChangePct.toFixed(2)}%`}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end">
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                vixLtp == null
                  ? 'bg-zinc-800 text-zinc-500'
                  : vixLtp < 13
                  ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                  : vixLtp <= 18
                  ? 'border border-sky-500/20 bg-sky-500/10 text-sky-400'
                  : 'border border-amber-500/20 bg-amber-500/10 text-amber-400',
              )}
            >
              {vixLtp == null ? 'N/A' : vixLtp < 13 ? 'Low Vol' : vixLtp <= 18 ? 'Normal Vol' : 'Elevated'}
            </span>
            {vixPrevClose != null && <span className="mt-0.5 font-mono text-[9px] text-zinc-500">prev {vixPrevClose.toFixed(2)}</span>}
          </div>
        </div>

        {/* 4. Portfolio Allocation & Positions Limit */}
        <div className="flex items-center justify-between rounded-lg border border-zinc-800/80 bg-zinc-900/60 p-2.5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Concurrent Positions</p>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="text-sm font-extrabold text-white">
                {openCount} <span className="text-xs text-zinc-500">/ {maxConcurrent} MAX</span>
              </span>
              <span className="text-[10px] text-zinc-500">(max {maxSameSide}/side)</span>
            </div>
          </div>
          <div className="flex flex-col items-end">
            <span
              className={cn(
                'rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase',
                mode === 'REAL' ? 'border-red-500/30 bg-red-500/20 text-red-400' : 'border-emerald-500/30 bg-emerald-500/20 text-emerald-400',
              )}
            >
              {mode} MODE
            </span>
          </div>
        </div>

        {/* 5. Daily P&L & Loss Limit Gauge */}
        <div className="flex flex-col justify-between rounded-lg border border-zinc-800/80 bg-zinc-900/60 p-2.5">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Daily P&amp;L / Loss Limit</p>
            <span className={cn('text-xs font-bold tabular-nums', pnlColor(totalPnl))}>
              {totalPnl >= 0 ? `+₹${totalPnl.toLocaleString('en-IN')}` : `-₹${Math.abs(totalPnl).toLocaleString('en-IN')}`}
            </span>
          </div>

          <div className="mt-1 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
              <div
                className={cn('h-full rounded-full transition-all', isLossBreached ? 'bg-red-500' : budgetPct < 30 ? 'bg-amber-500' : 'bg-emerald-500')}
                style={{ width: `${budgetPct}%` }}
              />
            </div>
            <span className="whitespace-nowrap font-medium tabular-nums text-[10px] text-zinc-400">Limit: ₹{dailyLossLimit.toLocaleString('en-IN')}</span>
          </div>

          {isLossBreached && (
            <p className="mt-1 flex items-center gap-1 text-[10px] font-bold text-red-400">
              <ShieldAlert className="h-3 w-3" /> HARD DAILY LOSS LIMIT REACHED — LOCKED OUT
            </p>
          )}
          {account && (
            <p className="mt-0.5 font-mono text-[9px] text-zinc-500" title="REAL P&L today across every Algo Lab strategy">
              All strategies: <span className={pnlTone(account.total)}>{inr(account.total)}</span> / cap −₹{account.limit.toLocaleString('en-IN')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function PositionsTable({
  def,
  positions,
  ltpOf,
  today,
  isUnknown,
  onClose,
}: {
  def: StrategyDefinition;
  positions: AlgoPosition[];
  ltpOf: (p: AlgoPosition) => number | null;
  today: string;
  isUnknown: (id: string) => boolean;
  onClose: (p: AlgoPosition) => void;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const istDay = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);
  const rows = positions.filter((p) => p.status === 'OPEN' || (showClosed && p.closedAt != null && istDay(p.closedAt) === today));
  const cols = def.columns.scanner;
  return (
    <section className={panel}>
      <div className={head}>
        <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-200">
          <ListChecks className="h-3.5 w-3.5 text-sky-400" /> Active Positions &amp; Trade Log
        </h2>
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500" /> Show today&apos;s closed
        </label>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-zinc-500">No open positions.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-left text-xs">
            <thead className="bg-zinc-800 text-xs font-bold text-white">
              <tr>
                {['Contract', 'Mode', 'Qty', 'Entry ₹', 'LTP', 'Stop', 'Target', 'Best', 'P&L', ...cols.map((c) => c.label), 'Status', ''].map((h, i) => (
                  <th key={`${h}${i}`} className={TH}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {rows.map((p) => {
                const l = legOf(p);
                const ltp = p.status === 'OPEN' ? ltpOf(p) : p.exitPrice ?? null;
                const pnl = p.status === 'OPEN' ? openPnlOf(p, ltp) : p.realized;
                const unknown = p.status === 'OPEN' && isUnknown(p.id);
                return (
                  <tr key={p.id} className={cn('whitespace-nowrap font-mono tabular-nums text-zinc-300', p.status === 'CLOSED' && 'opacity-60')}>
                    <td className="px-2.5 py-1.5 font-sans font-bold text-white">
                      {l.strike} <span className={l.option === 'CE' ? 'text-emerald-400' : 'text-red-400'}>{l.option}</span>{' '}
                      <span className="text-[10px] text-zinc-500">
                        {p.side} · {p.expiry} · {p.tag}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 font-sans">
                      <span className={cn('rounded border px-1.5 text-[10px] font-bold', p.mode === 'REAL' ? 'border-red-500/30 bg-red-500/10 text-red-400' : 'border-zinc-700 text-zinc-400')}>
                        {p.mode} · {p.broker}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5">
                      {l.qty} <span className="text-zinc-500">({l.qty / l.lotSize}L)</span>
                    </td>
                    <td className="px-2.5 py-1.5">{px(l.entryPrice)}</td>
                    <td className="px-2.5 py-1.5">{px(ltp)}</td>
                    <td className="px-2.5 py-1.5">{px(p.stop)}</td>
                    <td className="px-2.5 py-1.5">{px(p.target)}</td>
                    <td className="px-2.5 py-1.5">{px(p.best)}</td>
                    <td className={cn('px-2.5 py-1.5 font-bold', pnlTone(pnl))}>{inr(pnl)}</td>
                    {cols.map((c) => (
                      <td key={c.key} className="px-2.5 py-1.5">
                        {fmtCell(c, p.entryCols?.[c.key])}
                      </td>
                    ))}
                    <td className="px-2.5 py-1.5 font-sans">
                      {p.status === 'CLOSED' ? (
                        <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-bold', exitTone(p.exitKind ?? 'MANUAL'))} title={p.exitReason}>
                          {exitLabel(p.exitKind ?? 'MANUAL')}
                        </span>
                      ) : unknown ? (
                        <span className="rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-bold text-red-400">EXIT UNKNOWN</span>
                      ) : (
                        <span className="text-[10px] font-bold text-emerald-400">OPEN</span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5 font-sans">
                      {p.status === 'OPEN' && (
                        <button type="button" onClick={() => onClose(p)} className="rounded border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] font-bold text-red-400 hover:bg-red-500/20">
                          Close
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function ScannerTable({ def, rows, atm, onEnter }: { def: StrategyDefinition; rows: Candidate[]; atm: number | null; onEnter: (c: Candidate) => void }) {
  const [eligibleOnly, setEligibleOnly] = useState(false);
  const shown = eligibleOnly ? rows.filter((r) => r.eligible) : rows;
  const cols = def.columns.scanner;
  return (
    <section className={panel}>
      <div className={head}>
        <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-200">
          <Activity className="h-3.5 w-3.5 text-emerald-400" /> Multi-Strike Scanner Matrix {atm ? <span className="font-mono text-zinc-500">ATM {atm}</span> : null}
          <span className="font-medium normal-case text-zinc-500">· {rows.filter((r) => r.eligible).length} eligible</span>
        </h2>
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
          <input type="checkbox" checked={eligibleOnly} onChange={(e) => setEligibleOnly(e.target.checked)} className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500" /> Eligible only
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-zinc-500">{rows.length ? 'No eligible contracts right now.' : 'Waiting for the options feed and bars…'}</p>
      ) : (
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full min-w-[800px] text-left text-xs">
            <thead className="sticky top-0 bg-zinc-800 text-xs font-bold text-white">
              <tr>
                {['Contract', 'LTP', 'Score', ...cols.map((c) => c.label), 'Status', ''].map((h, i) => (
                  <th key={`${h}${i}`} className={TH}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {shown.map((c) => (
                <tr key={c.key} className={cn('whitespace-nowrap font-mono tabular-nums', c.eligible ? 'text-zinc-200' : 'text-zinc-500')}>
                  <td className="px-2.5 py-1.5 font-sans font-bold">
                    {c.strike} <span className={c.option === 'CE' ? 'text-emerald-400' : 'text-red-400'}>{c.option}</span>
                  </td>
                  <td className="px-2.5 py-1.5">{px(c.ltp)}</td>
                  <td className="px-2.5 py-1.5">{c.score.toFixed(1)}</td>
                  {cols.map((col) => (
                    <td key={col.key} className="px-2.5 py-1.5">
                      {fmtCell(col, c.cols[col.key])}
                    </td>
                  ))}
                  <td className="px-2.5 py-1.5 font-sans text-[11px]">{c.eligible ? <span className="font-bold text-emerald-400">ELIGIBLE</span> : c.blockReason}</td>
                  <td className="px-2.5 py-1.5 font-sans">
                    <button
                      type="button"
                      onClick={() => onEnter(c)}
                      className={cn(
                        'rounded border px-2 py-0.5 text-[11px] font-bold',
                        def.side === 'BUY' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20' : 'border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20',
                      )}
                    >
                      {def.side === 'BUY' ? 'Buy' : 'Short'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function LogPanel({ logs, onClear }: { logs: AuditLogItem[]; onClear: () => void }) {
  const tone: Record<AuditLogItem['level'], string> = { INFO: 'text-zinc-400', WARN: 'text-amber-400', ERROR: 'text-red-400', TRADE: 'text-sky-400' };
  return (
    <section className={panel}>
      <div className={head}>
        <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-200">
          <ScrollText className="h-3.5 w-3.5 text-violet-400" /> Engine &amp; Audit Log
        </h2>
        <button type="button" onClick={onClear} aria-label="Clear log" className="rounded p-1 text-zinc-500 hover:text-zinc-200">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <ul className="max-h-[260px] overflow-auto px-4 py-2 font-mono text-[11px]">
        {logs.length === 0 && <li className="py-2 text-zinc-500">No events yet.</li>}
        {logs.map((l) => (
          <li key={l.id} className="flex gap-3 py-0.5">
            <span className="shrink-0 text-zinc-500">{new Date(l.at).toLocaleTimeString('en-IN', { hour12: false })}</span>
            <span className={cn('shrink-0 font-bold', tone[l.level])}>{l.level}</span>
            <span className="text-zinc-300">{l.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
