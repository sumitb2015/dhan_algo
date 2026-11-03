'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Info, ShieldCheck } from 'lucide-react';
import { StepArrows } from '@/components/priceLadder/StepArrows';
import type { LadderGuard } from '@/lib/priceLadderGuard';
import { effectiveGuard } from '@/lib/pnfGuardBoxes';

// The MTM guard of one ladder + broker + SIM/REAL mode: target, stop-loss, trailing and Protect profit over the P&L of
// the orders this ladder placed (the other ladder has its own). The server watcher enforces it (lib/priceLadderGuard.ts), so it works with this tab closed. Numbers are
// typed as drafts and only sent by Save — a half-typed level must never reach a live rule (dhan-commit-on-blur).

const HELP = 'Watches this ladder\'s P&L on this broker (closed + open, every contract and pair this ladder placed; the other ladder has its own guard). When a rule trips, every open position of this ladder exits at market, armed levels are cancelled and the guard switches off. Protect profit: once MTM touches the trigger, a drop to the locked amount exits. Runs on the server, so it works with this tab closed. Your levels are remembered across days, but the guard starts OFF each day: switch it on. Full guide: docs/PRICE_LADDER_GUIDE.md';

const RUPEE_FIELDS = ['target', 'stop', 'trailBy', 'lockAt', 'lockKeep', 'lockStepEvery', 'lockStepKeep'] as const;
/** The P&F / Renko page also takes target / stop in chart boxes (shown only when the page passes `boxesLabel`). */
const BOX_FIELDS = ['targetBoxes', 'stopBoxes'] as const;
const ALL_FIELDS = [...RUPEE_FIELDS, ...BOX_FIELDS] as const;
type Field = (typeof ALL_FIELDS)[number];
type Draft = Record<Field, string>;
const LABELS: Record<Field, string> = { target: 'Target', stop: 'Stop-loss', trailBy: 'Trail by', lockAt: 'When MTM reaches', lockKeep: 'Lock at least', lockStepEvery: 'Then every', lockStepKeep: 'raise lock by', targetBoxes: 'Target (boxes)', stopBoxes: 'Stop-loss (boxes)' };

const toDraft = (g?: LadderGuard): Draft => Object.fromEntries(ALL_FIELDS.map(f => [f, g?.[f] != null ? String(g[f]) : ''])) as Draft;
const rs = (v: number) => `${v < 0 ? '−' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;

function Box({ label, value, onChange, step = 100, unit = '₹' }: { label: string; value: string; onChange: (v: string) => void; step?: number; unit?: string }) {
  const bump = (dir: 1 | -1) => {
    const n = Number(value) || 0;
    onChange(String(Math.max(0, n + dir * step)));
  };
  return (
    <div className="relative inline-flex w-28">
      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-zinc-500 pointer-events-none select-none" aria-hidden>{unit}</span>
      <input
        aria-label={label} inputMode="decimal" placeholder="off" value={value}
        onChange={e => onChange(e.target.value.replace(/[^\d.]/g, ''))}
        onKeyDown={e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); bump(e.key === 'ArrowUp' ? 1 : -1); } }}
        className={`w-full h-6 ${unit === '₹' ? 'pl-5' : 'pl-8'} pr-6 rounded bg-zinc-900 border border-zinc-700 text-xs font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500`}
      />
      <StepArrows label={label} onStep={bump} />
    </div>
  );
}

export function MtmGuardCard({ broker, real, ladderId = 1, mtm, guard, post, help, scopeName, tripNote, boxesLabel, rupeesPerBox }: {
  broker: string; real: boolean; ladderId?: 1 | 2; mtm: number | null; guard?: LadderGuard;
  post: (body: Record<string, unknown>) => Promise<boolean>;
  /** Another page's wording (the P&F page's guard is held by its open tab, per chart). */
  help?: string; scopeName?: string; tripNote?: string;
  /** P&F / Renko only: shows the target / stop-loss in BOXES rows; the text names the box ("boxes of 5 pts"). */
  boxesLabel?: string;
  /** What one box is worth in rupees for the open position (null: no position yet), to warn when a level is already past. */
  rupeesPerBox?: number | null;
}) {
  const FIELDS = boxesLabel ? ALL_FIELDS : RUPEE_FIELDS;
  const scope = scopeName ?? `Ladder ${ladderId}`;
  const [draft, setDraft] = useState<Draft>(() => toDraft(guard));
  const [dirty, setDirty] = useState(false);
  const on = !!guard?.on;
  // Follow the server (another tab, a fire) until the user starts typing. The parent keys this card by broker + mode.
  const sig = guard ? JSON.stringify(FIELDS.map(f => guard[f])) : '';
  const unitOf = (g?: LadderGuard): 'rs' | 'box' => (boxesLabel && g && (g.targetBoxes != null || g.stopBoxes != null) ? 'box' : 'rs');
  /** Target and stop-loss are in rupees OR in chart boxes, never both (the P&F / Renko page only; the ladders are always rupees). */
  const [unit, setUnit] = useState<'rs' | 'box'>(() => unitOf(guard));
  const [seen, setSeen] = useState(sig);
  if (seen !== sig) { setSeen(sig); if (!dirty) { setDraft(toDraft(guard)); setUnit(unitOf(guard)); } }

  const set = (f: Field) => (v: string) => { setDraft(d => ({ ...d, [f]: v })); setDirty(true); setConfirmNow(null); };
  const [confirmNow, setConfirmNow] = useState<string | null>(null);

  /** Every filled box must be a positive number (the lock may be 0); nothing is silently dropped or defaulted. */
  const parse = (): Record<string, number | undefined> | string => {
    const out: Record<string, number | undefined> = {};
    for (const f of FIELDS) {
      // the unit not chosen is not sent: its levels are dropped, so a guard never holds a rupee level and a box level at once
      if (boxesLabel && ((unit === 'rs' && (f === 'targetBoxes' || f === 'stopBoxes')) || (unit === 'box' && (f === 'target' || f === 'stop')))) continue;
      if (draft[f] === '') continue;
      const n = Number(draft[f]);
      if (!Number.isFinite(n) || n < 0 || (n === 0 && f !== 'lockKeep')) return `"${draft[f]}" is not a valid amount for ${LABELS[f]}`;
      out[f] = n;
    }
    if (out.lockAt != null && out.lockKeep == null) return 'Protect profit: fill "Lock at least" (0 locks break-even)';
    if (out.lockAt == null && out.lockKeep != null) return 'Protect profit: fill "When MTM reaches"';
    return out;
  };
  /** Already past one of its own levels? Then switching on exits everything on the next tick — say so first. */
  const alreadyPast = (v: Record<string, number | undefined>): string | null => {
    if (mtm == null) return null;
    // the same folding of box levels into rupees that the guard itself enforces
    const eff = effectiveGuard({ on: true, ...v }, rupeesPerBox ?? null);
    if (eff.target != null && mtm >= eff.target) return `MTM ${rs(mtm)} is already at or above the target`;
    if (eff.stop != null && mtm <= -eff.stop) return `MTM ${rs(mtm)} is already at or below the stop-loss`;
    if (v.lockAt != null && v.lockKeep != null && v.lockKeep >= 0 && mtm >= v.lockAt && mtm <= v.lockKeep) return `MTM ${rs(mtm)} is already inside the locked profit`;
    return null;
  };
  const save = (nextOn: boolean) => {
    if (!nextOn) {
      // Switching off never needs a valid draft: a half-typed edit must not keep a live exit-everything rule on.
      setConfirmNow(null);
      void post({ action: 'guard', broker, mode: real ? 'real' : 'sim', pane: ladderId, on: false });
      return;
    }
    const v = parse();
    if (typeof v === 'string') { toast.error(v); return; }
    if (nextOn && !on) {
      const warn = alreadyPast(v);
      if (warn && !confirmNow) { setConfirmNow(warn); return; }
    }
    setConfirmNow(null);
    void post({ action: 'guard', broker, mode: real ? 'real' : 'sim', pane: ladderId, on: nextOn, ...v }).then(ok => { if (ok) setDirty(false); });
  };

  const row = 'flex items-center justify-between gap-2';
  const lab = 'text-zinc-400 font-medium';
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 flex flex-col gap-1.5 text-xs">
      <div className={row}>
        <span className="flex items-center gap-1.5 text-[13px] font-semibold tracking-tight text-zinc-100"><ShieldCheck className="w-3.5 h-3.5 text-emerald-400" aria-hidden /> MTM guard <span className="inline-flex text-zinc-500" title={help ?? `${HELP} This guard covers only ladder ${ladderId} on ${broker} ${real ? 'REAL' : 'SIM'}.`} aria-label={help ?? HELP} role="img"><Info className="w-3 h-3" aria-hidden /></span></span>
        <span className={`font-mono font-semibold ${mtm == null ? 'text-zinc-500' : mtm >= 0 ? 'text-emerald-400' : 'text-red-400'}`} title={`${scope}'s own P&L for this broker and mode`}>{mtm == null ? '—' : rs(mtm)}</span>
      </div>
      {boxesLabel && (
        <div className={row}>
          <span className={lab} title="Target and stop-loss are in rupees or in chart boxes, not both">Target / stop in</span>
          <div role="group" aria-label="Target and stop-loss unit" className="inline-flex rounded border border-zinc-700 p-0.5 gap-0.5">
            {(['rs', 'box'] as const).map(u => (
              <button key={u} type="button" aria-pressed={unit === u} onClick={() => { setUnit(u); setDirty(true); setConfirmNow(null); }}
                      className={`px-2 h-5 rounded text-[11px] font-bold ${unit === u ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>{u === 'rs' ? '₹ Rupees' : 'Boxes'}</button>
            ))}
          </div>
        </div>
      )}
      {unit === 'rs' ? (
        <>
          <div className={row}><span className={lab}>Target</span><Box label="MTM target in rupees" value={draft.target} onChange={set('target')} /></div>
          <div className={row}><span className={lab}>Stop-loss</span><Box label="MTM stop-loss in rupees" value={draft.stop} onChange={set('stop')} /></div>
        </>
      ) : (
        <>
          <div className={row} title={`Exit when the position is up this many boxes (${boxesLabel})`}><span className={lab}>Target</span><Box label="MTM target in boxes" unit="box" step={1} value={draft.targetBoxes} onChange={set('targetBoxes')} /></div>
          <div className={row} title={`Exit when the position is down this many boxes (${boxesLabel})`}><span className={lab}>Stop-loss</span><Box label="MTM stop-loss in boxes" unit="box" step={1} value={draft.stopBoxes} onChange={set('stopBoxes')} /></div>
          <p className="text-[10px] text-zinc-500">Boxes: {boxesLabel}. A box is worth {rupeesPerBox ? rs(rupeesPerBox) : '— (no position)'} on the open position.</p>
        </>
      )}
      <div className={row} title="Exit when MTM gives back this much from its best since the guard was switched on"><span className={lab}>Trail by</span><Box label="MTM trailing give-back in rupees" value={draft.trailBy} onChange={set('trailBy')} /></div>

      <div className="mt-1.5 pt-2 border-t border-zinc-800 flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-300" title="Once MTM reaches the trigger, a floor is locked: if MTM falls back to it, everything exits">Protect profit</span>
        <div className={row}><span className={lab}>When MTM reaches</span><Box label="Protect profit trigger in rupees" value={draft.lockAt} onChange={set('lockAt')} /></div>
        <div className={row}><span className={lab}>Lock at least</span><Box label="Profit to lock in rupees" value={draft.lockKeep} onChange={set('lockKeep')} /></div>
        <div className={row} title="Optional: for every further step of MTM, the locked profit rises too"><span className={lab}>Then every +</span><Box label="Lock step in rupees" value={draft.lockStepEvery} onChange={set('lockStepEvery')} /></div>
        <div className={row}><span className={lab}>Raise lock by</span><Box label="Lock raise per step in rupees" value={draft.lockStepKeep} onChange={set('lockStepKeep')} /></div>
      </div>

      <div className="flex items-center gap-1.5 pt-1.5">
        {on ? (
          <>
            <button type="button" onClick={() => save(true)} disabled={!dirty} className="flex-1 h-7 px-2 rounded border border-zinc-700 text-zinc-200 font-semibold hover:text-white disabled:opacity-40">Update</button>
            <button type="button" onClick={() => save(false)} className="flex-1 h-7 px-2 rounded border border-red-500/40 bg-red-500/10 text-red-300 font-semibold hover:text-red-200">Switch off</button>
          </>
        ) : (
          <button type="button" onClick={() => save(true)} className="flex-1 h-7 px-2 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 font-semibold hover:text-emerald-200">Switch on</button>
        )}
      </div>
      {on && guard && !guard.tripped && (
        <p className="text-[10px] text-zinc-400 font-mono">
          Guarding · best {guard.peak != null ? rs(guard.peak) : '—'}{guard.floor != null ? ` · locked ${rs(guard.floor)}` : ''}
        </p>
      )}
      {confirmNow && (
        <p className="text-[10px] text-amber-300">{confirmNow} — switching on exits everything straight away. Press Switch on again to confirm, or change the level.</p>
      )}
      {on && guard?.tripped && (
        <p className="text-[10px] text-amber-300">Tripped: {guard.tripped}. {tripNote ?? 'Exiting — it stays on until every position and order of this broker and mode is closed (a rejected or held exit is retried; a long waits for its short).'}</p>
      )}
      {!on && guard?.firedReason && (
        <p className="text-[10px] text-amber-300">Fired: {guard.firedReason}. Everything was exited; switch on to guard again.</p>
      )}
    </div>
  );
}
