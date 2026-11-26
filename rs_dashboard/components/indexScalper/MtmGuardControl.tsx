'use client';

// Header control for the global MTM target / stop (lib/indexScalperMtmGuard.ts): an on / off switch, the target and stop
// in rupees, and what it is doing. The amounts are free-typed, so they commit on blur / Enter only (dhan-commit-on-blur):
// typing 8000 must never briefly arm a stop of 8. Esc reverts the box.

import { useEffect, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { parseRupees, type MtmGuardSettings } from '@/lib/indexScalperMtmGuard';

function RupeeBox({ label, value, onCommit, cls }: { label: string; value: number; onCommit: (v: number) => boolean; cls: string }) {
  const [draft, setDraft] = useState(String(value));
  const [bad, setBad] = useState(false);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) { setDraft(String(value)); setBad(false); } }, [value]);
  const commit = (raw: string) => {
    const n = parseRupees(raw);
    if (n === null) { setBad(true); return; } // keep the last good value; the box says it was not taken
    setBad(false);
    // A refused change (the page says why) puts the box back to the level actually in force.
    const applied = n === value || onCommit(n);
    setDraft(String(applied ? n : value));
  };
  return (
    <label className="flex items-center gap-1">
      <span className={cn('text-[10px] font-bold', cls)}>{label}</span>
      <input inputMode="numeric" aria-label={`MTM ${label === 'T' ? 'target' : 'stop loss'} in rupees`} aria-invalid={bad} value={draft}
        onFocus={() => { focused.current = true; }}
        onChange={e => setDraft(e.target.value)}
        onBlur={e => { focused.current = false; commit(e.currentTarget.value); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { commit(e.currentTarget.value); e.currentTarget.blur(); }
          if (e.key === 'Escape') { setDraft(String(value)); setBad(false); e.currentTarget.blur(); }
          e.stopPropagation();
        }}
        className={cn('h-6 w-[54px] px-1 rounded border bg-zinc-900 text-[11px] font-mono tabular-nums text-zinc-100 text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
          bad ? 'border-amber-500' : 'border-zinc-700')} />
    </label>
  );
}

export default function MtmGuardControl({ settings, onChange, note, pnl, scope }: {
  settings: MtmGuardSettings;
  /** Apply new settings; false = refused (the page shows why). */
  onChange: (s: MtmGuardSettings) => boolean;
  /** Why it is paused / what it did last, shown small beside the boxes. */
  note: string | null;
  /** The day P&L the guard watches (this underlying only; the account panel's total is the whole account). */
  pnl: number | null;
  scope: string;
}) {
  return (
    <div role="group" aria-label="MTM target and stop loss" data-testid="mtm-guard"
      title="MTM exit: T = target and SL = stop loss in rupees on this underlying's day P&L. When either is reached, every position on it is exited once."
      className={cn('h-7 px-1.5 flex items-center gap-1 rounded border', settings.on ? 'border-sky-500/50' : 'border-zinc-700')}>
      <Switch size="sm" checked={settings.on} onCheckedChange={on => onChange({ ...settings, on })} aria-label="MTM target / stop loss exit" />
      <Activity className="w-3.5 h-3.5 text-zinc-300 min-[2200px]:hidden" aria-hidden /><span className="hidden min-[2200px]:inline text-[10px] font-bold text-zinc-300">MTM</span>
      <RupeeBox label="T" value={settings.target} cls="text-emerald-400" onCommit={target => onChange({ ...settings, target })} />
      <RupeeBox label="SL" value={settings.stop} cls="text-rose-400" onCommit={stop => onChange({ ...settings, stop })} />
      <span data-testid="mtm-guard-pnl" aria-label={`${scope} day P&L the MTM exit watches`}
        className={cn('text-[11px] font-mono tabular-nums font-semibold', pnl === null ? 'text-zinc-500' : pnl >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
        {pnl === null ? '—' : `${pnl >= 0 ? '+' : '-'}${Math.abs(Math.round(pnl)).toLocaleString('en-IN')}`}
      </span>
      {note && <span data-testid="mtm-guard-note" className="text-[10px] text-amber-300 whitespace-nowrap">{note}</span>}
    </div>
  );
}
