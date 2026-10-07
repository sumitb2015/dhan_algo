'use client';

import React, { useState } from 'react';
import { Layers, Unlink, X } from 'lucide-react';
import { FOCUS_RING } from '@/components/Scalper';

export interface GroupTarget { id: string; label: string }

interface Props {
  count: number;
  busy: boolean;
  /** Existing groups the selection can be moved into (same broker + underlying only). */
  targets: GroupTarget[];
  onGroup: (name: string, targetBasketId?: string) => void;
  onUngroup: () => void;
  onClear: () => void;
}

const NEW = '__new__';

/** Floating bar shown while trades are ticked: name a new group, or move them into one. */
export default function GroupSelectionBar({ count, busy, targets, onGroup, onUngroup, onClear }: Props) {
  const [name, setName] = useState('');
  const [dest, setDest] = useState(NEW);
  const destValid = dest === NEW || targets.some(t => t.id === dest);
  const target = destValid ? dest : NEW;
  const submit = () => {
    if (busy) return;
    onGroup(name, target === NEW ? undefined : target);
    setName('');
  };
  return (
    <div role="region" aria-label="Group selected trades"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl border border-emerald-500/40 bg-zinc-900 shadow-2xl max-w-[calc(100vw-2rem)]">
      <span className="text-xs font-bold text-zinc-100 tabular-nums">{count} trade{count === 1 ? '' : 's'} selected</span>
      <select value={target} onChange={e => setDest(e.target.value)} aria-label="Move selected trades into"
        className={`h-7 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded px-1.5 max-w-[14rem] ${FOCUS_RING}`}>
        <option value={NEW}>New group…</option>
        {targets.map(t => <option key={t.id} value={t.id}>Into: {t.label}</option>)}
      </select>
      {target === NEW && (
        <input value={name} maxLength={40} placeholder="Group name (optional)" aria-label="New group name"
          onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          className={`h-7 w-44 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs rounded px-2 focus:border-emerald-500 ${FOCUS_RING}`} />
      )}
      <button type="button" onClick={submit} disabled={busy}
        className={`h-7 px-3 inline-flex items-center gap-1 text-xs font-bold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-oncolor disabled:opacity-50 ${FOCUS_RING}`}>
        <Layers className="w-3.5 h-3.5" /> {target === NEW ? 'Group' : 'Move'}
      </button>
      <button type="button" onClick={onUngroup} disabled={busy}
        title="Give each selected trade its own row"
        className={`h-7 px-2.5 inline-flex items-center gap-1 text-xs font-bold rounded-lg border border-zinc-700 text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 ${FOCUS_RING}`}>
        <Unlink className="w-3.5 h-3.5" /> Ungroup
      </button>
      <button type="button" onClick={onClear} aria-label="Clear selection"
        className={`h-7 w-7 inline-flex items-center justify-center rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 ${FOCUS_RING}`}>
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
