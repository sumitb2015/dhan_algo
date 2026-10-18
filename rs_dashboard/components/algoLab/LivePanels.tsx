'use client';

import { useState } from 'react';
import { Activity, ListChecks, Power, ScrollText, Settings, Trash2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { legOf, openPnlOf } from '@/lib/algoLab/ledger';
import type { AlgoPosition, AuditLogItem, Candidate, GateResult, LedgerMode, StrategyDefinition } from '@/lib/algoLab/types';
import { exitLabel, exitTone, fmtCell, inr, pnlTone, px } from './format';

const panel = 'rounded-xl border border-zinc-800 bg-zinc-900/40';
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
  onToggleEngine,
  onSquareOff,
  onOpenRules,
}: {
  def: StrategyDefinition;
  gate: GateResult | null;
  engineActive: boolean;
  mode: LedgerMode;
  openCount: number;
  realized: number;
  unrealized: number;
  account: { total: number; limit: number } | null;
  onToggleEngine: () => void;
  onSquareOff: () => void;
  onOpenRules: () => void;
}) {
  const tone = gate?.tone === 'bull' ? 'text-emerald-400' : gate?.tone === 'bear' ? 'text-red-400' : 'text-amber-400';
  return (
    <section className={cn(panel, 'flex flex-wrap items-center justify-between gap-4 px-4 py-3')}>
      <div className="flex flex-wrap items-center gap-5">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Gate</p>
          <p className={cn('text-sm font-bold', tone)}>{gate?.bias ?? '—'}</p>
          <p className="max-w-[320px] text-[11px] text-zinc-400">{gate?.detail ?? 'Waiting for the feed'}</p>
        </div>
        {gate?.metrics && (
          <div className="flex flex-wrap gap-3 text-[11px]">
            {Object.entries(gate.metrics).map(([k, v]) => (
              <span key={k} className="text-zinc-500">
                {k.toUpperCase()} <span className="font-mono text-zinc-200">{v ?? '—'}</span>
              </span>
            ))}
          </div>
        )}
        <div className="text-[11px] text-zinc-500">
          Allowed <span className="font-mono font-bold text-zinc-200">{gate?.allowed.length ? gate.allowed.join(' + ') : 'none'}</span> · {def.side}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-right">
          <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Today · {mode}</p>
          <p className="font-mono text-xs">
            Realized <span className={pnlTone(realized)}>{inr(realized)}</span> · Open <span className={pnlTone(unrealized)}>{inr(unrealized)}</span> ·{' '}
            {openCount} open
          </p>
          {account && (
            <p className="font-mono text-[10px] text-zinc-500" title="REAL P&L today across every Algo Lab strategy">
              Account (REAL, all strategies) <span className={pnlTone(account.total)}>{inr(account.total)}</span> / cap −₹{account.limit.toLocaleString('en-IN')}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onToggleEngine}
          aria-pressed={engineActive}
          className={cn(
            'flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-bold',
            engineActive ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400' : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white',
          )}
        >
          <Power className="h-3.5 w-3.5" /> {engineActive ? 'Engine ON' : 'Engine OFF'}
        </button>
        <button type="button" onClick={onSquareOff} disabled={!openCount} className="flex h-8 items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 text-xs font-bold text-red-400 hover:bg-red-500/20 disabled:opacity-40">
          <XCircle className="h-3.5 w-3.5" /> Square off
        </button>
        <button type="button" onClick={onOpenRules} aria-label="Open rules" className="flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-300 hover:text-white">
          <Settings className="h-3.5 w-3.5 text-amber-400" /> Rules
        </button>
      </div>
    </section>
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
          <ListChecks className="h-3.5 w-3.5 text-sky-400" /> Positions
        </h2>
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show today&apos;s closed
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
          <Activity className="h-3.5 w-3.5 text-emerald-400" /> Scanner {atm ? <span className="font-mono text-zinc-500">ATM {atm}</span> : null}
          <span className="font-medium normal-case text-zinc-500">· {rows.filter((r) => r.eligible).length} eligible</span>
        </h2>
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
          <input type="checkbox" checked={eligibleOnly} onChange={(e) => setEligibleOnly(e.target.checked)} /> Eligible only
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
                      {def.side === 'BUY' ? 'Buy' : 'Sell'}
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
          <ScrollText className="h-3.5 w-3.5 text-violet-400" /> Engine log
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
