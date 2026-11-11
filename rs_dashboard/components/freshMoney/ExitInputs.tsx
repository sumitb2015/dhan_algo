'use client';

/**
 * Fresh Money — target / stop-loss inputs. REAL MONEY: these levels make the dashboard server send MARKET closes
 * (lib/freshMoneyExitServer.ts). A number box commits only on blur / Enter (Escape reverts; dhan-commit-on-blur), so a
 * half-typed "5" of "50" never becomes a live level. Blank = off.
 */

import React, { useRef, useState } from 'react';
import {
  breached, fmtExitSpec, levelsFor, validateExitSpec, type ExitDir, type ExitSpec, type ExitUnit, type FmExit,
} from '@/lib/freshMoneyExits';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70';

export const EXIT_STATE_LABEL: Record<FmExit['state'], string> = {
  'waiting-fill': 'waiting fill',
  watching: 'watching',
  firing: 'exit sending',
  sent: 'exit sent',
  unknown: 'exit UNKNOWN',
  incomplete: 'exit incomplete',
};
export const exitNeedsLook = (x: FmExit | undefined) => !!x && (x.state === 'unknown' || x.state === 'incomplete');

/** One level: number + % | pts. `onCommit` gets the new spec (null = off) only on blur / Enter / a unit click. */
export function ExitSpecInput({ label, value, onCommit, disabled }: {
  label: string; value: ExitSpec | null; onCommit: (v: ExitSpec | null) => void; disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value ? String(value.value) : '');
  const [unit, setUnit] = useState<ExitUnit>(value?.unit ?? 'pct');
  const [error, setError] = useState<string | null>(null);
  const cancelBlur = useRef(false);
  // Follow a change from outside (a restored preference, a Save elsewhere).
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(value ? String(value.value) : '');
    if (value) setUnit(value.unit);
  }

  const commit = (raw: string, u: ExitUnit) => {
    const t = raw.trim();
    const r = validateExitSpec(t === '' ? null : { value: Number(t), unit: u });
    if (r && 'error' in r) { setError(r.error); setDraft(value ? String(value.value) : ''); return; }
    setError(null);
    onCommit(r);
  };

  return (
    <span className="flex items-center gap-1">
      <span className="text-[11px] text-zinc-400">{label}</span>
      <input
        aria-label={`${label} value (blank = off)`}
        inputMode="decimal"
        placeholder="off"
        value={draft}
        disabled={disabled}
        onChange={e => setDraft(e.target.value.replace(/[^0-9.]/g, ''))}
        onBlur={e => { if (cancelBlur.current) { cancelBlur.current = false; return; } commit(e.currentTarget.value, unit); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { commit(e.currentTarget.value, unit); e.currentTarget.blur(); }
          if (e.key === 'Escape') { cancelBlur.current = true; setDraft(value ? String(value.value) : ''); setError(null); e.currentTarget.blur(); }
        }}
        className={`${FOCUS} h-6 w-14 rounded border border-zinc-700 bg-zinc-900 text-center text-[12px] font-bold tabular-nums text-white placeholder:font-normal placeholder:text-zinc-500 disabled:opacity-50`}
      />
      <span role="group" aria-label={`${label} unit`} className="flex rounded border border-zinc-700 bg-zinc-900 p-px">
        {(['pct', 'pts'] as const).map(u => (
          <button key={u} type="button" disabled={disabled} aria-pressed={unit === u}
            onClick={() => { setUnit(u); if (draft.trim() !== '') commit(draft, u); }}
            className={`${FOCUS} rounded-sm px-1.5 text-[10px] font-bold leading-[18px] ${unit === u ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
            {u === 'pct' ? '%' : 'pts'}
          </button>
        ))}
      </span>
      {error && <span className="text-[10px] font-bold text-amber-300" role="alert">{error}</span>}
    </span>
  );
}

/** The Positions panel's editor for one position: preview the prices from its current average, then Save / Clear. */
export function ExitEditor({ exit, avgPrice, ltp, dir, onSave, onCancel, saving }: {
  exit: FmExit | undefined; avgPrice: number | null; ltp: number | null; dir: ExitDir;
  onSave: (target: ExitSpec | null, sl: ExitSpec | null) => void; onCancel: () => void; saving: boolean;
}) {
  const [target, setTarget] = useState<ExitSpec | null>(exit?.target ?? null);
  const [sl, setSl] = useState<ExitSpec | null>(exit?.sl ?? null);
  const lv = avgPrice !== null ? levelsFor(avgPrice, dir, target, sl) : null;
  const past = lv && ltp !== null ? breached(ltp, dir, lv) : null;
  const p = (n: number | null | undefined) => (n == null ? 'off' : n.toFixed(2));
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2 py-2">
      <ExitSpecInput label="Target" value={target} onCommit={setTarget} disabled={saving} />
      <ExitSpecInput label="SL" value={sl} onCommit={setSl} disabled={saving} />
      <span className="text-[11px] tabular-nums text-zinc-400">
        {lv ? <>from avg {avgPrice!.toFixed(2)}: target <b className="text-zinc-200">{p(lv.targetPx)}</b> · SL <b className="text-zinc-200">{p(lv.slPx)}</b></> : 'levels set once the fill price is known'}
      </span>
      {past && <span className="text-[11px] font-bold text-amber-300" role="alert">{past === 'sl' ? 'SL' : 'Target'} already past — exits within ~4 s</span>}
      <span className="ml-auto flex items-center gap-1.5">
        <button type="button" disabled={saving} onClick={() => onSave(target, sl)}
          className={`${FOCUS} rounded border border-sky-500/50 bg-sky-500/10 px-2 py-0.5 text-[11px] font-bold text-sky-300 hover:bg-sky-500/20 disabled:opacity-50`}>Save</button>
        <button type="button" disabled={saving} onClick={() => onSave(null, null)} title="Remove this position's target and stop-loss"
          className={`${FOCUS} rounded border border-zinc-700 px-2 py-0.5 text-[11px] font-bold text-zinc-300 hover:text-white disabled:opacity-50`}>Clear</button>
        <button type="button" disabled={saving} onClick={onCancel}
          className={`${FOCUS} rounded px-2 py-0.5 text-[11px] text-zinc-400 hover:text-zinc-200 disabled:opacity-50`}>Cancel</button>
      </span>
    </div>
  );
}

/** "T 130.00 · SL 80.00" (hover text), or what the record is waiting for. */
export function exitLevelsText(x: FmExit | undefined): string {
  if (!x) return '';
  if (x.state === 'waiting-fill') return `levels waiting for the fill price (${[x.target ? `T ${fmtExitSpec(x.target)}` : '', x.sl ? `SL ${fmtExitSpec(x.sl)}` : ''].filter(Boolean).join(' · ')})`;
  const p = (n: number | null) => (n === null ? 'off' : n.toFixed(2));
  return `T ${p(x.targetPx)} · SL ${p(x.slPx)}${x.state !== 'watching' ? ` · ${EXIT_STATE_LABEL[x.state]}` : ''}`;
}
