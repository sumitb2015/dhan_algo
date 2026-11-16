'use client';

import { useState, type ReactNode } from 'react';
import { FOCUS_RING } from '@/components/Scalper';

/** Free-typed number that only commits on blur / Enter (dhan-commit-on-blur): "2" on the way to "25" must not filter live. */
export function NumField({ label, value, onCommit, step = 1, min = 0, width = 'w-16', title }: {
  title?: string; label: string; value: number; onCommit: (n: number) => void; step?: number; min?: number; width?: string;
}) {
  const [draft, setDraft] = useState<string>(String(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value) { setSeen(value); setDraft(String(value)); }   // external change (clamped / reset) wins over a stale draft
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(n) && n >= min) onCommit(n); else setDraft(String(value));
  };
  return (
    <label className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-400" title={title}>
      {label}
      <input
        type="number" inputMode="decimal" step={step} min={min} value={draft} aria-label={label}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className={`${width} h-7 bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-xs rounded px-1.5 ${FOCUS_RING}`}
      />
    </label>
  );
}

export function Seg<T extends string | number>({ value, options, onChange, label }: {
  value: T; options: { v: T; l: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center rounded border border-zinc-700 overflow-hidden">
      {options.map((o) => (
        <button
          key={String(o.v)} type="button" onClick={() => onChange(o.v)} aria-pressed={value === o.v}
          className={`h-7 px-2 text-[11px] font-bold font-mono ${FOCUS_RING} ${value === o.v ? 'bg-emerald-600 text-oncolor' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}
        >{o.l}</button>
      ))}
    </div>
  );
}

export function Check({ label, checked, onChange, title }: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-300 cursor-pointer" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className={FOCUS_RING} />{label}
    </label>
  );
}

/** A labelled cluster of controls in a toolbar: a small caption over a bordered group. */
export function Cluster({ label, children, tone = 'zinc', title }: { label: string; children: ReactNode; tone?: 'zinc' | 'red'; title?: string }) {
  return (
    <div role="group" aria-label={label} title={title}
      className={`flex items-center gap-2 flex-wrap rounded-lg border px-2 py-1.5 ${tone === 'red' ? 'border-red-500/50' : 'border-zinc-800 bg-zinc-900/40'}`}>
      <span className={`text-[10px] font-bold uppercase tracking-[0.14em] ${tone === 'red' ? 'text-red-400' : 'text-zinc-500'}`}>{label}</span>
      {children}
    </div>
  );
}

/** An on/off switch. `danger` paints it red while on (auto-exit with REAL money armed). */
export function Switch({ label, on, onChange, danger = false, title }: { label: string; on: boolean; onChange: (v: boolean) => void; danger?: boolean; title?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} title={title}
      className={`h-7 pl-1 pr-2 rounded border inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider ${FOCUS_RING} ${
        on ? (danger ? 'bg-red-600 border-red-500 text-oncolor' : 'bg-emerald-600 border-emerald-500 text-oncolor') : 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:text-white'}`}>
      <span aria-hidden="true" className={`relative inline-block w-6 h-3.5 rounded-full ${on ? 'bg-oncolor-dark/40' : 'bg-zinc-700'}`}>
        <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-oncolor transition-[left] ${on ? 'left-3' : 'left-0.5'}`} />
      </span>
      {label}
    </button>
  );
}

/** In-page confirmation (never window.confirm: it blocks the 1 s loops and automation). Escape / backdrop = cancel. */
export function ConfirmDialog({ title, body, confirmLabel, danger = false, onConfirm, onCancel }: {
  title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 px-4" role="dialog" aria-modal="true" aria-label={title}
      onClick={onCancel} onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}>
      <div className="w-full max-w-sm rounded-xl border border-zinc-700 bg-zinc-900 p-4 flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h2 className={`text-sm font-bold ${danger ? 'text-red-400' : 'text-white'}`}>{title}</h2>
        <div className="text-xs text-zinc-300 leading-snug">{body}</div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} autoFocus
            className={`h-8 px-3 rounded border border-zinc-700 bg-zinc-900 text-[11px] font-bold text-zinc-300 hover:text-white ${FOCUS_RING}`}>Cancel</button>
          <button type="button" onClick={onConfirm}
            className={`h-8 px-3 rounded text-[11px] font-bold text-oncolor ${danger ? 'bg-red-600 hover:bg-red-500' : 'bg-emerald-600 hover:bg-emerald-500'} ${FOCUS_RING}`}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
