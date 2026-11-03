'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import { rowPnl, type AutoRow } from '@/lib/pnfAutoLedger';

// One chart's AUTO switch, lots and status (engine: ./usePnfAuto.ts). AUTO is armed per page load; in REAL mode arming takes a
// second, explicit click. Lots commit on blur / Enter (dhan-commit-on-blur) and are locked while AUTO is armed or holds a position.

const MAX_LOTS = 20;
const inr = (n: number) => `${n > 0 ? '+' : n < 0 ? '-' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;

export type { AutoRule } from '@/lib/pnfAutoRule';
import type { AutoRule } from '@/lib/pnfAutoRule';

export interface AutoControlsProps {
  chart: 1 | 2;
  armed: boolean;
  /** What AUTO trades on, for the button tooltip (default: the P&F double top / bottom rule). */
  rule?: string;
  mode: 'PAPER' | 'REAL';
  disabledReason: string | null;
  lots: number;
  onLots: (n: number) => void;
  onArm: (on: boolean) => void;
  row: AutoRow | undefined;
  price: number | null;
  note: string;
  halt: string | null;
  onResolve: (as: 'open' | 'flat') => void;
  /** Close the open position now at the live price (and switch AUTO off). */
  onExit?: () => void;
  /** Renko only: which pattern AUTO trades. Absent on P&F (one rule). Locked while armed or holding a position. */
  autoRule?: AutoRule;
  onAutoRule?: (r: AutoRule) => void;
  /** The page clock (ms), for spotting a stale reservation. */
  nowMs: number;
}

/** A row only the user can settle: an unknown outcome, or a reservation left over by a tab that died with the order out. */
const STALE_PENDING_MS = 60_000;
export const needsResolve = (r: AutoRow, nowMs: number) =>
  r.state === 'unknownEntry' || r.state === 'unknownExit'
  || ((r.state === 'entering' || r.state === 'exiting') && nowMs - (r.pendingSince ?? r.entryT) * 1000 > STALE_PENDING_MS);

export default function AutoControls({ chart, armed, mode, disabledReason, lots, onLots, onArm, row, price, note, halt, onResolve, onExit, nowMs, rule, autoRule, onAutoRule }: AutoControlsProps) {
  const [confirmReal, setConfirmReal] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const [draft, setDraft] = useState(String(lots));
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setDraft(String(lots));
  }, [lots]);
  useEffect(() => {
    if (!confirmReal) return;
    const id = setTimeout(() => setConfirmReal(false), 6_000);
    return () => clearTimeout(id);
  }, [confirmReal]);

  useEffect(() => {
    if (!confirmExit) return;
    const id = setTimeout(() => setConfirmExit(false), 6_000);
    return () => clearTimeout(id);
  }, [confirmExit]);
  const canExit = !!onExit && row?.state === 'open';
  const clickExit = () => {
    if (!onExit || !row) return;
    if (row.mode === 'REAL' && !confirmExit) { setConfirmExit(true); return; }
    setConfirmExit(false);
    onExit();
  };

  const locked = armed || !!row;
  const commit = (raw: string) => {
    const n = parseInt(raw, 10);
    const next = Number.isInteger(n) ? Math.max(1, Math.min(MAX_LOTS, n)) : lots;
    setDraft(String(next));
    if (next !== lots) onLots(next);
  };
  const toggle = () => {
    if (armed) { onArm(false); return; }
    if (mode === 'REAL' && !confirmReal) { setConfirmReal(true); return; }
    setConfirmReal(false);
    onArm(true);
  };

  const open = row?.state === 'open';
  const pnl = open && price !== null ? rowPnl(row.side, row.entryPrice, price, row.unitsPerPoint) : null;
  const unresolved = row && row.state !== 'open';

  return (
    <span data-testid={`pnf-auto-${chart}`} data-armed={armed} className="flex items-center gap-1.5 min-w-0 shrink font-sans">
      <button type="button" onClick={toggle} disabled={!!disabledReason && !armed} aria-pressed={armed}
              aria-label={armed ? `Stop AUTO on chart ${chart}` : `Start AUTO on chart ${chart}`}
              title={disabledReason ?? (armed ? `AUTO ${mode}: ${rule ?? 'double-bottom SELL / double-top BUY, exit on the first column reversal'}` : 'Trade this chart automatically')}
              className={`inline-flex items-center gap-1 h-6 px-2 rounded border text-[11px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${armed
                ? mode === 'REAL' ? 'border-red-500/50 bg-red-500/15 text-red-300' : 'border-violet-500/50 bg-violet-500/15 text-violet-300'
                : confirmReal ? 'border-red-500/60 bg-red-500/20 text-red-300' : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white'}`}>
        <Bot className="w-3 h-3" aria-hidden="true" />
        {confirmReal && !armed ? 'ARM REAL AUTO?' : 'AUTO'}
        {armed && <span className={`w-1.5 h-1.5 rounded-full ${mode === 'REAL' ? 'bg-red-400' : 'bg-violet-400'} animate-pulse`} aria-hidden="true" />}
      </button>
      {autoRule && onAutoRule && (
        <select aria-label={`AUTO rule on chart ${chart}`} value={autoRule} disabled={locked} onChange={e => onAutoRule(e.target.value as AutoRule)}
                title={locked ? 'Stop AUTO (and close its position) to change the rule' : 'Which pattern AUTO trades'}
                className="h-6 rounded border border-zinc-700 bg-zinc-950 px-1 text-[11px] font-bold text-zinc-200 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60">
          <option value="nbrick">N-brick</option>
          <option value="trend">N-brick (trend)</option>
          <option value="twoback">Two-back</option>
          <option value="oneback">One-back</option>
        </select>
      )}
      <span className="inline-flex items-center rounded border border-zinc-700 bg-zinc-950" title={locked ? 'Stop AUTO (and close its position) to change lots' : 'Lots per AUTO trade'}>
        <span className="pl-1 text-[11px] font-bold text-zinc-400" aria-hidden="true">L</span>
        <button type="button" aria-label={`Fewer AUTO lots on chart ${chart}`} disabled={locked || lots <= 1} onClick={() => onLots(lots - 1)}
                className="w-5 h-6 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60">−</button>
        <input aria-label={`AUTO lots on chart ${chart}`} value={draft} disabled={locked}
               onFocus={() => { focusedRef.current = true; }}
               onChange={e => setDraft(e.target.value)}
               onBlur={e => { focusedRef.current = false; commit(e.currentTarget.value); }}
               onKeyDown={e => {
                 if (e.key === 'Enter') { commit(e.currentTarget.value); e.currentTarget.blur(); }
                 if (e.key === 'Escape') { setDraft(String(lots)); e.currentTarget.blur(); }
               }}
               className="w-7 h-6 text-center text-[11px] font-mono font-bold bg-transparent text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 rounded disabled:text-zinc-400" />
        <button type="button" aria-label={`More AUTO lots on chart ${chart}`} disabled={locked || lots >= MAX_LOTS} onClick={() => onLots(lots + 1)}
                className="w-5 h-6 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60">+</button>
      </span>
      <span data-testid={`pnf-auto-status-${chart}`} className="font-mono text-[11px] truncate min-w-0 max-w-[13rem]" title={halt ?? note}>
        {unresolved ? (
          (row.state === 'entering' || row.state === 'exiting') && !needsResolve(row, nowMs)
            ? <span className="text-amber-400">{row.state === 'entering' ? 'ENTERING…' : 'EXITING…'}</span>
            : <span className="text-red-400 font-bold">UNRESOLVED</span>
        ) : open ? (
          <span className={row.side === 'SELL' ? 'text-red-400' : 'text-emerald-400'}>
            {row.side === 'SELL' ? 'SHORT' : 'LONG'} {row.lots}L @ {row.entryPrice.toFixed(2)}
            {pnl !== null && <span className={`ml-1 font-bold ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{inr(pnl)}</span>}
            {row.stop !== undefined && <span className="ml-1 text-zinc-400" title="Protective stop (one brick beyond the pullback)">SL {row.stop.toFixed(2)}</span>}
            {row.mode === 'PAPER' && <span className="ml-1 text-zinc-400">paper</span>}
          </span>
        ) : halt ? (
          <span className="text-red-400 font-bold">HALTED</span>
        ) : armed ? (
          <span className="text-zinc-400">{note || 'waiting for a signal'}</span>
        ) : disabledReason ? <span className="text-zinc-500">{disabledReason}</span> : null}
      </span>
      {canExit && (
        <button type="button" data-testid={`pnf-auto-exit-${chart}`} onClick={clickExit}
                aria-label={`Exit the AUTO position on chart ${chart} now`}
                title={row?.mode === 'REAL' ? 'Close this REAL position at market now and switch AUTO off (click twice)' : 'Close this paper position at the live price and switch AUTO off'}
                className={`h-6 px-2 rounded border text-[11px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 ${confirmExit ? 'border-red-500/60 bg-red-500/20 text-red-300' : 'border-zinc-700 text-zinc-200 hover:bg-zinc-800'}`}>
          {confirmExit ? 'EXIT REAL?' : 'Exit'}
        </button>
      )}
      {row && needsResolve(row, nowMs) && (
        <span className="flex items-center gap-1" title="Check the broker's Positions / Orders first, then tell AUTO what is there">
          <button type="button" onClick={() => onResolve('open')} className="h-6 px-2 rounded border border-zinc-700 text-[11px] font-bold text-zinc-200 hover:bg-zinc-800">Is open</button>
          <button type="button" onClick={() => onResolve('flat')} className="h-6 px-2 rounded border border-zinc-700 text-[11px] font-bold text-zinc-200 hover:bg-zinc-800">Is flat</button>
        </span>
      )}
    </span>
  );
}
