'use client';

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { MtmGuardCard } from '@/components/priceLadder/MtmGuardCard';
import type { OrderStyle } from '@/lib/pnfBracket';
import type { LadderGuard } from '@/lib/priceLadderGuard';

// The order Style of the Price Ladder (Single | Bracket | Cover) and its MTM guard, for the P&F page. Bracket / Cover attach
// stop-loss (and target) exits, in POINTS of the chart's own price, to every entry placed from the trade bar or the chart rail;
// they are held by this page (keep it open). It floats over the chart's top padding so it costs no chart height. Numbers are typed as drafts and committed on blur / Enter (dhan-commit-on-blur).

export interface StyleState { style: OrderStyle; tgt: string; sl: string; trail: string; trailOn: boolean }
export const DEFAULT_STYLE: StyleState = { style: 'Single', tgt: '', sl: '', trail: '', trailOn: false };

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60';
const HELP = 'Single: the order only. Bracket: when it fills, a stop-loss and a target are placed at these points from the fill price; whichever is hit first closes the position and cancels the other. Cover: the stop-loss only. Trail moves the stop with the price. The exits are held by THIS page (the open tab), not at the broker, and only ever reduce the position.';

function PtsBox({ label, value, onCommit, disabled }: { label: string; value: string; onCommit: (v: string) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) { setSeen(value); setDraft(value); }
  const commit = (raw: string) => {
    const v = raw.replace(/[^\d.]/g, '');
    onCommit(v);
    setDraft(v);
  };
  return (
    <label className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
      {label}
      <input aria-label={`${label} points`} inputMode="decimal" placeholder="pts" value={draft} disabled={disabled}
             onChange={e => setDraft(e.target.value)}
             onBlur={e => commit(e.currentTarget.value)}
             onKeyDown={e => { if (e.key === 'Enter') { commit(e.currentTarget.value); e.currentTarget.blur(); } if (e.key === 'Escape') { setDraft(value); e.currentTarget.blur(); } }}
             className={`w-16 h-6 px-1.5 rounded bg-zinc-900 border border-zinc-700 text-xs font-mono text-zinc-100 placeholder:text-zinc-500 disabled:opacity-40 ${FOCUS}`} />
    </label>
  );
}

export default function PnfOrderStyle({ value, onChange, guard, guardOn }: {
  value: StyleState;
  onChange: (s: StyleState) => void;
  /** The active chart's MTM guard card inputs; absent when the chart cannot be traded (index). */
  guard?: { broker: string; real: boolean; chart: 1 | 2; chartLabel: string; mtm: number | null; guard?: LadderGuard; post: (body: Record<string, unknown>) => Promise<boolean> };
  guardOn: boolean;
}) {
  const [open, setOpen] = useState(false);
  const seg = (s: OrderStyle) => (
    <button key={s} type="button" aria-pressed={value.style === s} onClick={() => onChange({ ...value, style: s })} data-testid={`pnf-style-${s.toLowerCase()}`}
            className={`px-2 h-6 text-[11px] font-bold rounded transition-colors ${FOCUS} ${value.style === s ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>{s}</button>
  );
  return (
    <div data-testid="pnf-style-bar" className="absolute left-1/2 -translate-x-1/2 top-1 z-30 flex items-center gap-2 flex-wrap justify-center max-w-[96%] px-2 py-1 rounded-lg border border-zinc-700 bg-zinc-900 shadow-lg">
      <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-400" title={HELP}>Style</span>
      <div role="group" aria-label="Order style" className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-950">
        {(['Single', 'Bracket', 'Cover'] as const).map(seg)}
      </div>
      {value.style === 'Bracket' && <PtsBox label="Target" value={value.tgt} onCommit={v => onChange({ ...value, tgt: v })} />}
      {value.style !== 'Single' && <PtsBox label="SL" value={value.sl} onCommit={v => onChange({ ...value, sl: v })} />}
      {value.style !== 'Single' && (
        <span className="inline-flex items-center gap-1.5">
          <label className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
            <input type="checkbox" checked={value.trailOn} onChange={e => onChange({ ...value, trailOn: e.target.checked })} className={`accent-violet-500 ${FOCUS}`} />
            Trail SL by
          </label>
          {value.trailOn && <PtsBox label="Trail" value={value.trail} onCommit={v => onChange({ ...value, trail: v })} />}
        </span>
      )}

      {guard && (
        <span className="relative">
          <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} data-testid="pnf-guard-toggle"
                  className={`inline-flex items-center gap-1.5 px-2 h-6 rounded border text-[11px] font-bold ${FOCUS} ${guardOn ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300' : 'border-zinc-700 text-zinc-300 hover:text-white'}`}>
            <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
            MTM Guard {guardOn ? 'ON' : 'OFF'}
          </button>
          {open && (
            <div data-testid="pnf-guard-card" className="absolute right-0 top-full mt-1 z-50 w-72 rounded-lg bg-zinc-900 border border-zinc-700 shadow-xl">
              <MtmGuardCard
                key={`${guard.broker}:${guard.real}:${guard.chart}`}
                broker={guard.broker} real={guard.real} ladderId={guard.chart} mtm={guard.mtm} guard={guard.guard} post={guard.post}
                scopeName={guard.chartLabel}
                help={`Watches ${guard.chartLabel}'s P&L on ${guard.broker} ${guard.real ? 'REAL' : 'PAPER'}, measured from the moment you switch the guard on. When a rule trips, the resting orders and bracket exits of this chart are cancelled and its position is squared off. It is held by THIS page: it only works while the tab is open. Levels are remembered; the guard starts OFF every page load.`}
                tripNote="Exiting - it stays on until this chart's position is closed (an exit that did not go through is retried every few seconds)." />
            </div>
          )}
        </span>
      )}
    </div>
  );
}
