'use client';

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { MtmGuardCard } from '@/components/priceLadder/MtmGuardCard';
import type { OrderStyle } from '@/lib/pnfBracket';
import type { LadderGuard } from '@/lib/priceLadderGuard';
import type { BoxValue } from '@/lib/pnfGuardBoxes';

// The order Style of the Price Ladder (Single | Bracket | Cover) and its MTM guard, for the P&F page. Bracket / Cover attach
// stop-loss (and target) exits, in P&F BOXES of the chart (the page converts them to points with the chart's own box size), to every entry placed from the trade bar or the chart rail;
// they are held by this page (keep it open). It floats over the chart's top padding so it costs no chart height. Numbers are typed as drafts and committed on blur / Enter (dhan-commit-on-blur).

export interface StyleState { style: OrderStyle; tgt: string; sl: string; trail: string; trailOn: boolean }
export const DEFAULT_STYLE: StyleState = { style: 'Single', tgt: '', sl: '', trail: '', trailOn: false };

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60';
const HELP = 'Single: the order only. Bracket: when it fills, a stop-loss and a target are placed this many P&F boxes from the fill price; whichever is hit first closes the position and cancels the other. Cover: the stop-loss only. Trail moves the stop with the price. The exits are held by THIS page (the open tab), not at the broker, and only ever reduce the position.';

function BoxesBox({ label, value, onCommit, disabled, boxPts, logPct = null }: { label: string; value: string; onCommit: (v: string) => void; disabled?: boolean; boxPts?: number; logPct?: number | null }) {
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
      <input aria-label={`${label} boxes`} inputMode="decimal" placeholder="boxes" value={draft} disabled={disabled}
             onChange={e => setDraft(e.target.value)}
             onBlur={e => commit(e.currentTarget.value)}
             onKeyDown={e => { if (e.key === 'Enter') { commit(e.currentTarget.value); e.currentTarget.blur(); } if (e.key === 'Escape') { setDraft(value); e.currentTarget.blur(); } }}
             className={`w-16 h-6 px-1.5 rounded bg-zinc-900 border border-zinc-700 text-xs font-mono text-zinc-100 placeholder:text-zinc-500 disabled:opacity-40 ${FOCUS}`} />
      <span className="text-[10px] text-zinc-500">box{Number(value) === 1 ? '' : 'es'}{logPct !== null ? ` of ${logPct}% (log steps from the fill)` : boxPts && Number(value) > 0 ? ` = ${(Number(value) * boxPts).toLocaleString('en-IN', { maximumFractionDigits: 2 })} pts` : ''}</span>
    </label>
  );
}

export default function PnfOrderStyle({ value: saved, onChange, guard, guardOn, boxPts, logPct = null, serverGuards, bracketsOff }: {
  value: StyleState;
  /**
   * Why Bracket / Cover cannot be used on the active chart (a Renko index chart trading options has no rail to hold the exits yet), or
   * absent. The bar then shows Single, with Bracket / Cover disabled: the saved choice is kept for the other charts.
   */
  bracketsOff?: string;
  /** The active chart's box size in price points (shown next to each box count as its point equivalent). */
  boxPts?: number;
  /** A Renko Log % chart's brick %: its boxes are log steps (from the fill for a bracket, from the entry for the guard), not points. */
  logPct?: number | null;
  onChange: (s: StyleState) => void;
  /**
   * The active chart's MTM guard card inputs; absent when the chart cannot be traded. `index`: a Renko index chart trading its CE / PE
   * map - the guard watches that option's P&L, so it takes rupee levels only (a chart box is an index move, not the option's).
   */
  guard?: { broker: string; real: boolean; chart: 1 | 2; chartLabel: string; mtm: number | null; rupeesPerBox?: BoxValue | null; guard?: LadderGuard; post: (body: Record<string, unknown>) => Promise<boolean>; index?: boolean };
  guardOn: boolean;
  /**
   * Every MTM guard the dashboard SERVER holds for this page (it exits open REAL AUTO positions by them, tab open or not), any broker /
   * mode: always shown, so a guard is never enforced unseen. `mine`: for the page's own broker and mode (the card shows it too).
   */
  serverGuards?: { chart: 1 | 2; mine: boolean; text: string }[];
}) {
  const [open, setOpen] = useState(false);
  const value: StyleState = bracketsOff ? { ...saved, style: 'Single' } : saved;
  const seg = (s: OrderStyle) => {
    const off = !!bracketsOff && s !== 'Single';
    return (
      <button key={s} type="button" aria-pressed={value.style === s} disabled={off} title={off ? bracketsOff : undefined}
              onClick={() => onChange({ ...saved, style: s })} data-testid={`pnf-style-${s.toLowerCase()}`}
              className={`px-2 h-6 text-[11px] font-bold rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS} ${value.style === s ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>{s}</button>
    );
  };
  return (
    <div data-testid="pnf-style-bar" className="flex items-center gap-2 flex-wrap">
      <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400" title={HELP}>Style</span>
      <div role="group" aria-label="Order style" className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-950">
        {(['Single', 'Bracket', 'Cover'] as const).map(seg)}
      </div>
      {value.style === 'Bracket' && <BoxesBox label="Target" value={value.tgt} boxPts={boxPts} logPct={logPct} onCommit={v => onChange({ ...value, tgt: v })} />}
      {value.style !== 'Single' && <BoxesBox label="SL" value={value.sl} boxPts={boxPts} logPct={logPct} onCommit={v => onChange({ ...value, sl: v })} />}
      {value.style !== 'Single' && (
        <span className="inline-flex items-center gap-1.5">
          <label className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
            <input type="checkbox" checked={value.trailOn} onChange={e => onChange({ ...value, trailOn: e.target.checked })} className={`accent-violet-500 ${FOCUS}`} />
            Trail SL by
          </label>
          {value.trailOn && <BoxesBox label="Trail" value={value.trail} boxPts={boxPts} logPct={logPct} onCommit={v => onChange({ ...value, trail: v })} />}
        </span>
      )}

      {guard && (
        <span className="relative">
          <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} data-testid="pnf-guard-toggle"
                  className={`inline-flex items-center gap-1.5 px-2 h-6 rounded border text-[11px] font-bold ${FOCUS} ${guardOn ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300' : 'border-zinc-700 text-zinc-300 hover:text-white'}`}>
            <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
            MTM Guard {guardOn ? 'ON' : 'OFF'}
          </button>
          {serverGuards && (
            <span data-testid="pnf-server-guards" className="ml-1.5 inline-flex items-center gap-1 align-middle"
                  title="MTM guards held by the dashboard SERVER: it squares off open REAL AUTO positions by them even with this tab closed. One for another broker or mode (amber) is not shown on the card until the page is switched to it.">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Server</span>
              {serverGuards.length === 0
                ? <span className="px-1.5 h-5 inline-flex items-center rounded border border-zinc-700 text-[10px] font-bold text-zinc-400">OFF</span>
                : serverGuards.map(g => (
                  <span key={g.chart} className={`px-1.5 h-5 inline-flex items-center rounded border text-[10px] font-mono font-bold ${g.mine ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/50 bg-amber-500/15 text-amber-300'}`}>
                    {g.text}
                  </span>
                ))}
            </span>
          )}
          {open && (
            <div data-testid="pnf-guard-card" className="absolute right-0 top-full mt-1 z-50 w-72 rounded-lg bg-zinc-900 border border-zinc-700 shadow-xl">
              <MtmGuardCard
                key={`${guard.broker}:${guard.real}:${guard.chart}:${guard.index ? 'ix' : 'c'}`}
                broker={guard.broker} real={guard.real} ladderId={guard.chart} mtm={guard.mtm} guard={guard.guard} post={guard.post}
                scopeName={guard.chartLabel}
                boxesLabel={guard.index ? undefined : logPct !== null ? `log bricks of ${logPct}%, counted from the entry price` : boxPts ? `boxes of ${boxPts.toLocaleString('en-IN', { maximumFractionDigits: 4 })} pts` : 'boxes of the chart'} rupeesPerBox={guard.index ? null : guard.rupeesPerBox ?? null}
                help={guard.index
                  ? `Watches the P&L of the option ${guard.chartLabel} trades on ${guard.broker} ${guard.real ? 'REAL' : 'PAPER'} - AUTO's option position plus the lots this chart opened from the trade bar / Scalper (its own units only, never another page's lots of the same strike) - measured from the moment you switch the guard on. Rupee levels only: a box of this chart is an index move, not the option's. When a rule trips, AUTO's option is exited and this chart's own units are closed. It is held by THIS page (the server also guards an open REAL AUTO position with the tab closed). The guard stays ON until you switch it off, and every new trade is measured from its own start. Levels are remembered; the guard starts OFF every page load.`
                  : `Watches ${guard.chartLabel}'s P&L on ${guard.broker} ${guard.real ? 'REAL' : 'PAPER'}, measured from the moment you switch the guard on. When a rule trips, the resting orders and bracket exits of this chart are cancelled and its position is squared off. It is held by THIS page: it only works while the tab is open. The guard stays ON until you switch it off, and every new trade is measured from its own start. Levels are remembered; the guard starts OFF every page load.`}
                tripNote="Exiting - it stays on until this chart's position is closed (an exit that did not go through is retried every few seconds)." />
            </div>
          )}
        </span>
      )}
    </div>
  );
}
