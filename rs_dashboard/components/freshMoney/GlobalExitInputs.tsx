'use client';

/**
 * Fresh Money — GLOBAL target / stop-loss on the combined P&L, in rupees. REAL MONEY: when the combined P&L of every
 * position on this page reaches either level, the dashboard server closes ALL of them with MARKET orders (shorts first;
 * lib/freshMoneyGlobalTick.ts). Unlike the per-position levels these are armed on the server the moment they are
 * committed (blur / Enter / − / +; Escape reverts), and they run with this tab closed. Blank = off.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import {
  fmtGlobalAmount, globalBreach, parseGlobalDraft, stepGlobalAmount, type FmGlobalExit, type GlobalState,
} from '@/lib/freshMoneyGlobalExit';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70';

export const GLOBAL_STATE_LABEL: Record<GlobalState, string> = {
  watching: 'watching',
  firing: 'closing everything',
  sent: 'all closes sent',
  unknown: 'exit UNKNOWN',
  incomplete: 'exit incomplete',
  rejected: 'exit REJECTED',
};

function AmountInput({ label, value, onCommit, disabled }: {
  label: string; value: number | null; onCommit: (v: number | null) => void; disabled?: boolean;
}) {
  const text = (v: number | null) => (v === null ? '' : String(v));
  const [draft, setDraft] = useState(text(value));
  const [error, setError] = useState<string | null>(null);
  const cancelBlur = useRef(false);
  const latest = useRef<number | null>(value);
  const [shown, setShown] = useState(value);
  useEffect(() => { latest.current = value; }, [value]);
  if (shown !== value) { setShown(value); setDraft(text(value)); }

  const commit = (raw: string) => {
    const r = parseGlobalDraft(raw);
    if (r !== null && typeof r === 'object') { setError(r.error); setDraft(text(value)); return; }
    setError(null);
    if (r === latest.current) return; // nothing changed: do not re-arm (re-arming restarts the record)
    latest.current = r;
    onCommit(r);
  };
  const step = (dir: 1 | -1) => {
    const next = stepGlobalAmount(latest.current, dir);
    latest.current = next;
    setError(null);
    setDraft(text(next));
    onCommit(next);
  };
  const stepBtn = `${FOCUS} flex h-6 w-6 items-center justify-center rounded border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white disabled:opacity-50`;
  return (
    <span className="flex items-center gap-1">
      <span className="text-[11px] text-zinc-400">{label}</span>
      <button type="button" disabled={disabled} onClick={() => step(-1)} aria-label={`${label} ₹500 lower`} className={stepBtn}>
        <Minus className="h-3 w-3" />
      </button>
      <span className="text-[11px] text-zinc-500" aria-hidden>₹</span>
      <input
        aria-label={`${label} in rupees (blank = off)`}
        inputMode="decimal"
        placeholder="off"
        value={draft}
        disabled={disabled}
        onChange={e => setDraft(e.target.value)}
        onBlur={e => { if (cancelBlur.current) { cancelBlur.current = false; return; } commit(e.currentTarget.value); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { commit(e.currentTarget.value); e.currentTarget.blur(); }
          if (e.key === 'Escape') { cancelBlur.current = true; setDraft(text(value)); setError(null); e.currentTarget.blur(); }
        }}
        className={`${FOCUS} h-6 w-16 rounded border border-zinc-700 bg-zinc-900 text-center text-[12px] font-bold tabular-nums text-white placeholder:font-normal placeholder:text-zinc-500 disabled:opacity-50`}
      />
      <button type="button" disabled={disabled} onClick={() => step(1)} aria-label={`${label} ₹500 higher`} className={stepBtn}>
        <Plus className="h-3 w-3" />
      </button>
      {error && <span className="text-[10px] font-bold text-amber-300" role="alert">{error}</span>}
    </span>
  );
}

export function GlobalExitInputs({ global, total, totalText, totalClass, unknownWhy, onSet, saving, watcherAlive }: {
  global: FmGlobalExit | null;
  /** Combined P&L now (null = unknown). */
  total: number | null;
  /** The combined P&L as the page formats rupees, and its colour class. */
  totalText?: string;
  totalClass?: string;
  /** Why the combined P&L is unknown (pnlUnknownReason), or null. */
  unknownWhy?: string | null;
  onSet: (target: number | null, sl: number | null) => void;
  saving: boolean;
  watcherAlive: boolean | null;
}) {
  const target = global?.target ?? null;
  const sl = global?.sl ?? null;
  const past = global?.state === 'watching' ? globalBreach(total, { target, sl }) : null;
  const bad = global && (global.state === 'unknown' || global.state === 'incomplete' || global.state === 'rejected');
  return (
    // Boxed apart from the per-position defaults: this one closes EVERYTHING (all brokers, all underlyings).
    <div className={`flex flex-wrap items-center gap-2 rounded-md border px-2 py-1 ${
      bad || (global?.state === 'watching' && total === null && unknownWhy) ? 'border-amber-500/50 bg-amber-500/5'
        : global?.state === 'watching' ? 'border-sky-500/40 bg-sky-500/5' : 'border-zinc-700 bg-zinc-950/30'}`}
      title="Total target / stop-loss in rupees on the combined P&L of every position on this page (booked + open). When either is reached the server closes ALL positions with MARKET orders, shorts first. Armed as soon as you commit a value; runs with the tab closed. Blank = off.">
      <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">Total · all brokers</span>
      {totalText !== undefined && (
        <span className="text-[12px] tabular-nums text-zinc-400" title="Combined P&L now: every position on this page, all brokers and underlyings (booked + open)">
          now <b className={totalClass}>{totalText}</b>
        </span>
      )}
      <AmountInput label="Target" value={target} onCommit={t => onSet(t, sl)} disabled={saving} />
      <AmountInput label="SL" value={sl} onCommit={v => onSet(target, v)} disabled={saving} />
      {global && (
        <span className={`flex items-center gap-1 text-[11px] ${bad ? 'font-bold text-amber-300' : 'text-zinc-400'}`} role={bad ? 'alert' : undefined}
          title={global.note}>
          <span className={`h-1.5 w-1.5 rounded-full ${bad ? 'bg-amber-400' : global.state === 'watching' ? 'bg-sky-400' : 'bg-zinc-500'}`} aria-hidden />
          {GLOBAL_STATE_LABEL[global.state]} · T {fmtGlobalAmount(target)} · SL {fmtGlobalAmount(sl === null ? null : sl)}
          {global.state === 'watching' && watcherAlive === false && <b className="text-red-300"> · watcher STOPPED</b>}
        </span>
      )}
      {global?.state === 'watching' && total === null && unknownWhy && (
        <span className="text-[11px] font-bold text-amber-300" role="alert" title={unknownWhy}>
          PAUSED — combined P&amp;L unknown, the total target / SL cannot fire: {unknownWhy}
        </span>
      )}
      {past && <span className="text-[11px] font-bold text-amber-300" role="alert">{past === 'sl' ? 'SL' : 'Target'} already past — closes everything within ~4 s</span>}
    </div>
  );
}
