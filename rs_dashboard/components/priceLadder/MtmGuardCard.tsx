'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Info, ShieldCheck } from 'lucide-react';
import type { LadderGuard } from '@/lib/priceLadderGuard';

// The global MTM guard of one broker + SIM/REAL mode: target, stop-loss, trailing and Protect profit over the ladder's
// whole P&L. The server watcher enforces it (lib/priceLadderGuard.ts), so it works with this tab closed. Numbers are
// typed as drafts and only sent by Save — a half-typed level must never reach a live rule (dhan-commit-on-blur).

const HELP = 'Watches this broker\'s ladder P&L (closed + open, all contracts and pairs). When a rule trips, every open position exits at market, armed levels are cancelled and the guard switches off. Protect profit: once MTM touches the trigger, a drop to the locked amount exits. Runs on the server, so it works with this tab closed. Resets each day. Full guide: docs/PRICE_LADDER_GUIDE.md';

const FIELDS = ['target', 'stop', 'trailBy', 'lockAt', 'lockKeep', 'lockStepEvery', 'lockStepKeep'] as const;
type Field = (typeof FIELDS)[number];
type Draft = Record<Field, string>;
const LABELS: Record<Field, string> = { target: 'Target', stop: 'Stop-loss', trailBy: 'Trail by', lockAt: 'When MTM reaches', lockKeep: 'Lock at least', lockStepEvery: 'Then every', lockStepKeep: 'raise lock by' };

const toDraft = (g?: LadderGuard): Draft => Object.fromEntries(FIELDS.map(f => [f, g?.[f] != null ? String(g[f]) : ''])) as Draft;
const rs = (v: number) => `${v < 0 ? '−' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;

function Box({ label, value, onChange, step = 100 }: { label: string; value: string; onChange: (v: string) => void; step?: number }) {
  const bump = (dir: 1 | -1) => {
    const n = Number(value) || 0;
    onChange(String(Math.max(0, n + dir * step)));
  };
  const arrow = 'flex-1 flex items-center justify-center text-zinc-500 hover:text-white hover:bg-zinc-800 leading-none';
  return (
    <div className="relative inline-flex w-24">
      <input
        aria-label={label} inputMode="decimal" placeholder="off" value={value}
        onChange={e => onChange(e.target.value.replace(/[^\d.]/g, ''))}
        onKeyDown={e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); bump(e.key === 'ArrowUp' ? 1 : -1); } }}
        className="w-full pl-2 pr-5 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-xs font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
      />
      <div className="absolute right-px top-px bottom-px w-4 flex flex-col rounded-r overflow-hidden border-l border-zinc-700">
        <button type="button" tabIndex={-1} aria-label={`Increase ${label}`} onMouseDown={e => e.preventDefault()} onClick={() => bump(1)} className={`${arrow} border-b border-zinc-700`}>
          <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor"><path d="M4 0l4 5H0z" /></svg>
        </button>
        <button type="button" tabIndex={-1} aria-label={`Decrease ${label}`} onMouseDown={e => e.preventDefault()} onClick={() => bump(-1)} className={arrow}>
          <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor"><path d="M4 5L0 0h8z" /></svg>
        </button>
      </div>
    </div>
  );
}

export function MtmGuardCard({ broker, real, mtm, guard, post }: {
  broker: string; real: boolean; mtm: number | null; guard?: LadderGuard;
  post: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(guard));
  const [dirty, setDirty] = useState(false);
  const on = !!guard?.on;
  // Follow the server (another tab, a fire) until the user starts typing. The parent keys this card by broker + mode.
  const sig = guard ? JSON.stringify(FIELDS.map(f => guard[f])) : '';
  const [seen, setSeen] = useState(sig);
  if (seen !== sig) { setSeen(sig); if (!dirty) setDraft(toDraft(guard)); }

  const set = (f: Field) => (v: string) => { setDraft(d => ({ ...d, [f]: v })); setDirty(true); setConfirmNow(null); };
  const [confirmNow, setConfirmNow] = useState<string | null>(null);

  /** Every filled box must be a positive number (the lock may be 0); nothing is silently dropped or defaulted. */
  const parse = (): Record<string, number | undefined> | string => {
    const out: Record<string, number | undefined> = {};
    for (const f of FIELDS) {
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
    if (v.target != null && mtm >= v.target) return `MTM ${rs(mtm)} is already at or above the target`;
    if (v.stop != null && mtm <= -v.stop) return `MTM ${rs(mtm)} is already at or below the stop-loss`;
    if (v.lockAt != null && v.lockKeep != null && v.lockKeep >= 0 && mtm >= v.lockAt && mtm <= v.lockKeep) return `MTM ${rs(mtm)} is already inside the locked profit`;
    return null;
  };
  const save = (nextOn: boolean) => {
    const v = parse();
    if (typeof v === 'string') { toast.error(v); return; }
    if (nextOn && !on) {
      const warn = alreadyPast(v);
      if (warn && !confirmNow) { setConfirmNow(warn); return; }
    }
    setConfirmNow(null);
    void post({ action: 'guard', broker, mode: real ? 'real' : 'sim', on: nextOn, ...v }).then(ok => { if (ok) setDirty(false); });
  };

  const row = 'flex items-center justify-between gap-2';
  const lab = 'text-zinc-400 font-medium';
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 flex flex-col gap-1.5 text-xs">
      <div className={row}>
        <span className="flex items-center gap-1.5 text-[13px] font-semibold tracking-tight text-zinc-100"><ShieldCheck className="w-3.5 h-3.5 text-emerald-400" aria-hidden /> MTM guard <span className="inline-flex text-zinc-500" title={HELP} aria-label={HELP} role="img"><Info className="w-3 h-3" aria-hidden /></span></span>
        <span className={`font-mono font-semibold ${mtm == null ? 'text-zinc-500' : mtm >= 0 ? 'text-emerald-400' : 'text-red-400'}`} title="The ladder's own P&L for this broker and mode">{mtm == null ? '—' : rs(mtm)}</span>
      </div>
      <div className={row}><span className={lab}>Target ₹</span><Box label="MTM target in rupees" value={draft.target} onChange={set('target')} /></div>
      <div className={row}><span className={lab}>Stop-loss ₹</span><Box label="MTM stop-loss in rupees" value={draft.stop} onChange={set('stop')} /></div>
      <div className={row} title="Exit when MTM gives back this much from its best since the guard was switched on"><span className={lab}>Trail by ₹</span><Box label="MTM trailing give-back in rupees" value={draft.trailBy} onChange={set('trailBy')} /></div>

      <div className="mt-1 pt-1.5 border-t border-zinc-800 flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold text-zinc-300">Protect profit</span>
        <div className={row}><span className={lab}>When MTM reaches ₹</span><Box label="Protect profit trigger in rupees" value={draft.lockAt} onChange={set('lockAt')} /></div>
        <div className={row}><span className={lab}>Lock at least ₹</span><Box label="Profit to lock in rupees" value={draft.lockKeep} onChange={set('lockKeep')} /></div>
        <div className={row} title="Optional: for every further step of MTM, the locked profit rises too"><span className={lab}>Then every +₹</span><Box label="Lock step in rupees" value={draft.lockStepEvery} onChange={set('lockStepEvery')} /></div>
        <div className={row}><span className={lab}>raise lock by ₹</span><Box label="Lock raise per step in rupees" value={draft.lockStepKeep} onChange={set('lockStepKeep')} /></div>
      </div>

      <div className="flex items-center gap-1.5 pt-1">
        {on ? (
          <>
            <button type="button" onClick={() => save(true)} disabled={!dirty} className="flex-1 px-2 py-1 rounded border border-zinc-700 text-zinc-200 hover:text-white disabled:opacity-40">Update</button>
            <button type="button" onClick={() => save(false)} className="flex-1 px-2 py-1 rounded border border-red-500/40 bg-red-500/10 text-red-300 hover:text-red-200">Switch off</button>
          </>
        ) : (
          <button type="button" onClick={() => save(true)} className="flex-1 px-2 py-1 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 font-semibold hover:text-emerald-200">Switch on</button>
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
        <p className="text-[10px] text-amber-300">Tripped: {guard.tripped}. Exiting; waiting for an order still in flight to settle.</p>
      )}
      {!on && guard?.firedReason && (
        <p className="text-[10px] text-amber-300">Fired: {guard.firedReason}. Everything was exited; switch on to guard again.</p>
      )}
    </div>
  );
}
