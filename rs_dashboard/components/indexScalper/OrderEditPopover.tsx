'use client';

// Edit one of this page's working orders from its chart chip: its lots (a select: a discrete choice, never a half-typed
// number) and its price (typed, committed only by Save / Enter: dhan-commit-on-blur). A Limit edits its price; a stop
// (SL-M or SL-limit) its TRIGGER, the level its line is drawn at, an SL-limit's limit moving by the same amount
// (movedLevels). The terminal checks and sends it.

import { useEffect, useRef } from 'react';
import type { OrderRowView } from '@/lib/indexScalperAccount';
import { cn } from '@/lib/utils';

export interface OrderEditDraft { id: string; lots: number; price: string }

interface Props {
  top: number;
  ord: OrderRowView;
  draft: OrderEditDraft;
  maxLots: number;
  onDraft: (d: OrderEditDraft) => void;
  onSave: (lots: number, level: number | null) => void;
  onClose: () => void;
}

export default function OrderEditPopover({ top, ord, draft, maxLots, onDraft, onSave, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (ref.current?.contains(t) || t?.closest?.(`[aria-label="Edit order ${ord.id}"]`)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose, ord.id]);

  const stop = ord.rawType === 'STOP_LOSS_MARKET' || ord.rawType === 'STOP_LOSS';
  const current = stop ? ord.trigger : ord.price;
  const typed = draft.price.trim();
  const level = /^(\d+(\.\d*)?|\.\d+)$/.test(typed) ? Number(typed) : null;
  const priceChanged = level !== null && current !== null && Math.abs(level - current) > 1e-9;
  const badPrice = typed !== '' && level === null;
  const save = () => { if (!badPrice) onSave(draft.lots, priceChanged ? level : null); };

  return (
    <div ref={ref} role="dialog" aria-label={`Edit order ${ord.id}`} style={{ top }} onMouseDown={e => e.stopPropagation()}
      className="absolute right-[84px] z-[70] w-[250px] rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl p-2 flex flex-col gap-1.5 font-sans text-xs">
      <div className="flex items-center justify-between gap-2 min-w-0">
        <span className={cn('font-bold whitespace-nowrap', ord.side === 'BUY' ? 'text-sky-400' : 'text-rose-400')}>{ord.side} {ord.orderType}</span>
        <span className="text-zinc-400 text-[10px] truncate" title={ord.symbol}>{ord.symbol}</span>
      </div>
      <label className="flex items-center justify-between gap-2 text-zinc-300">
        <span>Lots</span>
        <select aria-label="Order lots" value={draft.lots} disabled={!!ord.tradedQty}
          onChange={e => onDraft({ ...draft, lots: Number(e.target.value) })}
          className="h-7 w-16 px-1 rounded border border-zinc-700 bg-zinc-950 font-mono text-zinc-100 disabled:opacity-50">
          {Array.from({ length: maxLots }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2 text-zinc-300">
        <span>{stop ? 'Trigger' : 'Limit price'}</span>
        <input aria-label={stop ? 'Order trigger' : 'Order price'} inputMode="decimal" value={draft.price}
          onChange={e => onDraft({ ...draft, price: e.target.value })}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onClose(); e.stopPropagation(); }}
          className="h-7 w-24 px-1.5 rounded border border-zinc-700 bg-zinc-950 font-mono text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60" />
      </label>
      {ord.rawType === 'STOP_LOSS' && <div className="text-[10px] text-zinc-400">The limit ({ord.price?.toFixed(2) ?? '—'}) moves by the same amount.</div>}
      {!!ord.tradedQty && <div className="text-[10px] text-amber-400">Part-filled: only its price can change.</div>}
      {badPrice && <div className="text-[10px] text-amber-400">Enter a plain price, like 182.50</div>}
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onClose} className="h-7 px-2 rounded text-zinc-300 hover:bg-zinc-800">Close</button>
        <button type="button" onClick={save} disabled={badPrice}
          className="h-7 px-2 rounded bg-sky-600 hover:bg-sky-500 text-oncolor font-bold disabled:opacity-40">Modify</button>
      </div>
    </div>
  );
}
