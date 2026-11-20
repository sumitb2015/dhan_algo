'use client';

import { useEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { gbContractLabel } from '@/lib/gearboxLedger';
import type { GearboxEngine } from './useGearboxEngine';

// ↑ Long / Exit / ↓ Short, the lots stepper, the held leg (entry / LTP / P&L ₹) and why the buttons are off; plus the risk inputs
// (SL / target in points of the held contract: option premium, or the future for a FUT leg; daily limits) that commit on blur / Enter only. REAL MONEY in REAL mode: the browser sends only
// the action, the server picks contract, size and exit quantity.

export const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-950';
const inr = (n: number) => `${n >= 0 ? '+' : '−'}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

export function TradeStrip({ e }: { e: GearboxEngine }) {
  const { held, config, mode } = e;
  const cap = mode === 'REAL' ? e.state?.caps.REAL ?? 1 : e.state?.caps.SIM ?? 10;
  const lots = config?.lots ?? 1;
  const entryOff = !!e.entryBlock;
  const reason = held && held.status !== 'open'
    ? `Position ${held.status.toUpperCase()} - ${held.status === 'unknown' ? 'check the Dhan book and resolve it' : 'waiting for the server'}`
    : e.entryBlock ?? (mode === 'REAL' ? 'REAL armed - orders go to Dhan' : 'SIM - paper fills at the option LTP');
  const pnl = e.heldPnl;
  const btn = 'flex h-11 min-w-[120px] items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-testid="gb-long" disabled={entryOff || held?.dir === 'LONG' || (!!held && held.status !== 'open')}
          onClick={() => void e.open('LONG')} className={cn(btn, 'bg-emerald-600 text-oncolor hover:bg-emerald-500', FOCUS_RING)}
          title={held?.dir === 'SHORT' ? 'Reverse: exit the short, then go long (↑)' : 'Go long (↑)'}>
          ↑ Long <kbd className="rounded bg-oncolor-dark/20 px-1 text-[10px] font-bold">↑</kbd>
        </button>
        <button type="button" data-testid="gb-exit" disabled={!held || held.status !== 'open' || e.busy}
          onClick={() => void e.exit()} className={cn(btn, 'bg-zinc-700 text-zinc-100 hover:bg-zinc-600', FOCUS_RING)} title="Exit the held leg (X)">
          Exit <kbd className="rounded bg-zinc-900 px-1 text-[10px] font-bold text-zinc-300">X</kbd>
        </button>
        <button type="button" data-testid="gb-short" disabled={entryOff || held?.dir === 'SHORT' || (!!held && held.status !== 'open')}
          onClick={() => void e.open('SHORT')} className={cn(btn, 'bg-red-600 text-oncolor hover:bg-red-500', FOCUS_RING)}
          title={held?.dir === 'LONG' ? 'Reverse: exit the long, then go short (↓)' : 'Go short (↓)'}>
          ↓ Short <kbd className="rounded bg-oncolor-dark/20 px-1 text-[10px] font-bold">↓</kbd>
        </button>
        <div className="ml-2 flex items-center gap-1" role="group" aria-label="Lots">
          <button type="button" aria-label="Decrease lots" disabled={!config || lots <= 1 || !!held}
            onClick={() => void e.setConfig({ lots: lots - 1 })}
            className={cn('flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40', FOCUS_RING)}>
            <Minus className="h-4 w-4" />
          </button>
          <span className="w-16 text-center text-sm font-bold tabular-nums text-zinc-100" data-testid="gb-lots" title={`Cap ${cap} lot${cap === 1 ? '' : 's'} in ${mode}`}>
            {lots} lot{lots === 1 ? '' : 's'}
          </span>
          <button type="button" aria-label="Increase lots" disabled={!config || lots >= cap || !!held}
            onClick={() => void e.setConfig({ lots: lots + 1 })}
            className={cn('flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40', FOCUS_RING)}>
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <span className="flex-1" />
        <div data-testid="gb-held" className={cn('rounded-xl border px-3 py-1.5 text-sm tabular-nums',
          !held ? 'border-zinc-800 text-zinc-400' : held.dir === 'LONG' ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-red-500/40 bg-red-500/10')}>
          {!held ? 'Flat · no leg held' : (
            <span className="flex flex-wrap items-center gap-x-3">
              <b className={held.dir === 'LONG' ? 'text-emerald-300' : 'text-red-300'}>{held.dir}</b>
              <span className="text-zinc-200">{held.leg.action} {held.lots}L {gbContractLabel(held.target)}</span>
              <span className="text-zinc-400">entry <b className="text-zinc-100">{held.entry.toFixed(2)}</b></span>
              <span className="text-zinc-400">LTP <b className="text-zinc-100">{e.heldLtp === null ? '—' : e.heldLtp.toFixed(2)}</b>{!e.heldFresh && e.heldLtp !== null ? ' (stale)' : ''}</span>
              <b className={pnl === null ? 'text-zinc-400' : pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>{pnl === null ? '—' : inr(pnl)}</b>
              {held.mode === 'REAL' && <span className="rounded bg-red-500/15 px-1.5 text-[10px] font-bold text-red-300">REAL</span>}
              {held.status !== 'open' && <span className="rounded bg-amber-500/15 px-1.5 text-[10px] font-bold text-amber-300">{held.status.toUpperCase()}</span>}
            </span>
          )}
        </div>
      </div>
      <p data-testid="gb-reason" aria-live="polite" className={cn('text-xs', e.entryBlock && !e.busy ? 'text-amber-400' : 'text-zinc-400')}>{reason}</p>
      {held?.status === 'unknown' && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <span className="font-bold">Order outcome UNKNOWN - check the Dhan order book and positions, then:</span>
          <ResolveBtn onClick={() => void e.resolve(held.id, 'open')}>It is open</ResolveBtn>
          <ResolveBtn onClick={() => void e.resolve(held.id, 'failed')}>Never filled</ResolveBtn>
          {e.heldLtp !== null && <ResolveBtn onClick={() => void e.resolve(held.id, 'closed', e.heldLtp!)}>It is closed (at {e.heldLtp.toFixed(2)})</ResolveBtn>}
        </div>
      )}
    </div>
  );
}

function ResolveBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={cn('rounded border border-amber-500/40 px-2 py-0.5 font-bold hover:bg-amber-500/20', FOCUS_RING)}>{children}</button>;
}

/** A free-typed positive number (empty = off) that commits on blur / Enter only; Escape reverts. */
export function NumInput({ value, onCommit, label, disabled }: { value: number | null; onCommit: (v: number | null) => void; label: string; disabled?: boolean }) {
  const shown = value === null ? '' : String(value);
  const [draft, setDraft] = useState(shown);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(shown); }, [shown]);
  const commit = (raw: string) => {
    const t = raw.trim();
    const n = t === '' ? null : Number(t);
    if (n !== null && !(Number.isFinite(n) && n > 0)) { setDraft(shown); return; }
    if (n !== value) onCommit(n);
  };
  return (
    <input aria-label={label} value={draft} disabled={disabled} inputMode="decimal" placeholder="off"
      onFocus={() => { focused.current = true; }}
      onChange={ev => setDraft(ev.target.value)}
      onBlur={ev => { focused.current = false; commit(ev.currentTarget.value); }}
      onKeyDown={ev => {
        if (ev.key === 'Enter') { commit(ev.currentTarget.value); ev.currentTarget.blur(); }
        else if (ev.key === 'Escape') { setDraft(shown); focused.current = false; ev.currentTarget.blur(); }
      }}
      className="h-8 w-20 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-right text-sm tabular-nums text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500/40 disabled:opacity-40" />
  );
}

export function RiskPanel({ e }: { e: GearboxEngine }) {
  const c = e.config;
  if (!c) return null;
  const field = (label: string, el: React.ReactNode, unit: string) => (
    <label className="flex items-center gap-2 text-xs text-zinc-400"><span>{label}</span>{el}<span className="text-zinc-500">{unit}</span></label>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2">
      {field('SL', <NumInput label="Stop loss in points (option premium, or the future for a FUT leg)" value={c.slPts} onCommit={v => void e.setConfig({ slPts: v })} />, 'pts')}
      {field('Target', <NumInput label="Target in points (option premium, or the future for a FUT leg)" value={c.tgtPts} onCommit={v => void e.setConfig({ tgtPts: v })} />, 'pts')}
      <span className="text-[11px] text-amber-400" title="The SL and target are watched by this browser tab (the leader tab when several are open)">
        browser-only — closes nothing if this tab is closed{e.isLeader === false ? ' · another tab watches them' : ''}
      </span>
      <span className="w-px self-stretch bg-zinc-800" aria-hidden />
      {field('Max loss / day', <NumInput label="Daily max loss in rupees" value={c.maxLoss} onCommit={v => void e.setConfig({ maxLoss: v })} />, '₹')}
      {field('Max trades / day', <NumInput label="Daily max trades" value={c.maxTrades} onCommit={v => void e.setConfig({ maxTrades: v === null ? null : Math.round(v) })} />, '')}
    </div>
  );
}
