'use client';

import React, { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { FOCUS_RING } from '@/components/Scalper';
import { LEG_COLUMN_LABELS, type LegColumns, type LegColumnKey } from '@/lib/legColumns';

interface LegColumnsMenuProps {
  columns: LegColumns;
  onChange: (next: LegColumns) => void;
}

/** "Columns" button + checkbox popover for the optional legs-table columns. */
export default function LegColumnsMenu({ columns, onChange }: LegColumnsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // Fixed-position popover: the strategy card and legs table clip overflow, which would cut an absolutely
  // positioned menu short on a strategy with only a couple of legs.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const close = () => setOpen(false);   // a fixed menu would drift from its button when the page moves
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const toggle = (key: LegColumnKey) => onChange({ ...columns, [key]: !columns[key] });

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        ref={btnRef}
        onClick={() => {
          if (!open && btnRef.current) {
            const r = btnRef.current.getBoundingClientRect();
            setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
          }
          setOpen(o => !o);
        }}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Choose legs table columns"
        title="Show or hide legs table columns"
        className={`h-6 px-2 inline-flex items-center gap-1 rounded border text-[11px] font-semibold transition-colors ${
          open ? 'bg-zinc-800 border-zinc-600 text-white' : 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-800'
        } ${FOCUS_RING}`}
      >
        <SlidersHorizontal className="w-3 h-3" /> Columns
      </button>
      {open && pos && (
        <div role="group" aria-label="Legs table columns" style={{ position: 'fixed', top: pos.top, right: pos.right }} className="z-40 w-64 rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl p-1.5">
          {LEG_COLUMN_LABELS.map(c => (
            <label key={c.key} title={c.hint} className="flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-zinc-800">
              <input
                type="checkbox"
                checked={columns[c.key]}
                onChange={() => toggle(c.key)}
                className={`mt-0.5 rounded border-zinc-700 text-emerald-500 focus:ring-0 ${FOCUS_RING}`}
              />
              <span className="flex flex-col leading-tight">
                <span className="text-xs font-semibold text-zinc-200">{c.label}</span>
                <span className="text-[10px] text-zinc-500">{c.hint}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
