'use client';

// Add / configure indicators for the /index-scalper chart. Parameter fields commit on blur / Enter (clamped to the
// catalogue range), so a half-typed value never recomputes the chart.

import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { INDICATOR_CATALOG, LINE_WIDTHS, catalogEntry, clampParam, indicatorLabel, validWidth, type IndicatorInstance, type IndicatorKind } from '@/lib/indexScalperIndicators';
import { cn } from '@/lib/utils';

const SWATCHES = ['#3b82f6', '#f59e0b', '#ec4899', '#22c55e', '#a78bfa', '#06b6d4', '#eab308', '#ef4444', '#e4e4e7'];

function ParamField({ value, onCommit, label }: { value: number; onCommit: (n: number) => void; label: string }) {
  const [draft, setDraft] = useState(String(value));
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => { const n = Number(draft); onCommit(n); };
  return (
    <label className="flex items-center justify-between gap-3 text-xs text-zinc-300">
      {label}
      <input inputMode="decimal" value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className="w-20 h-7 px-2 rounded bg-zinc-800 border border-zinc-700 text-right tabular-nums text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60" />
    </label>
  );
}

export default function IndicatorPicker({ open, indicators, editId, onAdd, onChange, onRemove, onEdit, onClose }: {
  open: boolean;
  indicators: IndicatorInstance[];
  editId: string | null;
  onAdd: (k: IndicatorKind) => void;
  onChange: (id: string, patch: Partial<IndicatorInstance>) => void;
  onRemove: (id: string) => void;
  onEdit: (id: string | null) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  // Escape closes it (the backdrop otherwise blocks every click on the page until the X is used).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const editing = editId ? indicators.find(i => i.id === editId) ?? null : null;
  const list = INDICATOR_CATALOG.filter(c => c.label.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-24 bg-oncolor-dark/60" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Indicators" className="w-[420px] max-w-[calc(100vw-24px)] rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <h2 className="text-sm font-bold text-white">{editing ? `Settings: ${indicatorLabel(editing)}` : 'Indicators'}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60"><X className="w-4 h-4" /></button>
        </div>

        {editing ? (
          <div className="p-4 flex flex-col gap-3">
            {catalogEntry(editing.kind).params.map(p => (
              <ParamField key={p.key} label={p.label} value={editing.params[p.key] ?? p.def}
                onCommit={n => onChange(editing.id, { params: { ...editing.params, [p.key]: clampParam(editing.kind, p.key, n) } })} />
            ))}
            <div className="flex items-center gap-2 text-xs text-zinc-300">Colour
              <div className="flex gap-1">
                {SWATCHES.map(c => (
                  <button key={c} type="button" aria-label={`Colour ${c}`} onClick={() => onChange(editing.id, { color: c })}
                    className={cn('w-5 h-5 rounded-full border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60', editing.color === c ? 'border-white' : 'border-transparent')} style={{ backgroundColor: c }} />
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-zinc-300">Line width
              <div role="group" aria-label="Line width" className="flex rounded border border-zinc-700 overflow-hidden">
                {([null, ...LINE_WIDTHS] as const).map(w => {
                  const on = (validWidth(editing.width) ?? null) === w;
                  return (
                    <button key={w ?? 'auto'} type="button" aria-pressed={on} aria-label={w === null ? 'Line width auto' : `Line width ${w}`}
                      title={w === null ? "Each line's default width" : `${w} px`}
                      onClick={() => onChange(editing.id, { width: w ?? undefined })}
                      className={cn('h-7 px-2 flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60', on ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:bg-zinc-800')}>
                      {w === null ? 'Auto' : <span className="block w-4 rounded-full bg-current" style={{ height: w }} />}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex justify-between pt-2">
              <button type="button" onClick={() => { onRemove(editing.id); onClose(); }} className="text-xs font-semibold text-rose-400 hover:text-rose-300">Remove</button>
              <button type="button" onClick={onClose} className="h-8 px-3 rounded bg-sky-600 hover:bg-sky-500 text-oncolor text-xs font-bold">Done</button>
            </div>
          </div>
        ) : (
          <div className="p-3">
            <div className="relative mb-2">
              <Search className="w-4 h-4 text-zinc-500 absolute left-2 top-2" />
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search indicators"
                className="w-full h-8 pl-8 pr-2 rounded bg-zinc-800 border border-zinc-700 text-sm text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60" />
            </div>
            <ul className="max-h-72 overflow-auto">
              {list.map(c => (
                <li key={c.kind}>
                  <button type="button" onClick={() => onAdd(c.kind)}
                    className="w-full flex items-center justify-between px-2 py-2 rounded text-left hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60">
                    <span className="text-sm text-zinc-100">{c.label}</span>
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500">{c.pane === 'price' ? 'On price' : 'Own pane'}</span>
                  </button>
                </li>
              ))}
            </ul>
            {indicators.length > 0 && (
              <>
                <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mt-3 mb-1 px-1">On chart</div>
                <ul>
                  {indicators.map(i => (
                    <li key={i.id} className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-zinc-800">
                      <span className="flex items-center gap-2 text-sm text-zinc-200"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: i.color }} />{indicatorLabel(i)}</span>
                      <span className="flex gap-3 text-xs">
                        <button type="button" onClick={() => onEdit(i.id)} className="text-sky-400 hover:text-sky-300">Settings</button>
                        <button type="button" onClick={() => onRemove(i.id)} className="text-rose-400 hover:text-rose-300">Remove</button>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
