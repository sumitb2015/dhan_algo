'use client';

import { Minus, Plus, X } from 'lucide-react';
import { bias, bracketLevels, ladderRows, snapToStep, type LadderSide, type LadderSlice } from '@/lib/priceLadder';

/**
 * One order on the ladder, drawn as OptionX draws it: in the Buy or Sell column of its price row, as
 * `price | + − | qty`. The Price column itself only ever shows prices.
 *  - entry: an armed XY level or a resting plain order, in its own side's column; + / − change its lots, × cancels.
 *  - tgt / sl: an open bracket's exits, in the EXIT side's column with the position's quantity; + adds a lot to the
 *    position at market (it joins these levels), − exits one lot.
 *  - pos: a plain-mode open position at its average, in its side's column; + adds a lot, − exits one.
 *  - planned: the target / SL an armed bracket will get when it fills (dashed, no controls).
 */
export interface LadderWidget {
  key: string;
  price: number;
  column: LadderSide;
  kind: 'entry' | 'tgt' | 'sl' | 'pos';
  label: string;
  qty: number;
  lots: number;
  /** Slices behind this widget (several open slices can share one target or SL). The first is the newest. */
  ids: string[];
  planned?: boolean;
  /** + / − on an unfilled order (change its lots) or on an open position (add a lot / exit a lot). */
  adjust?: 'order' | 'position';
  cancellable?: boolean;
  drag?: 'entry' | 'tgt' | 'sl';
}

const opposite = (s: LadderSide): LadderSide => (s === 'BUY' ? 'SELL' : 'BUY');

/** Widgets for the slices of the contract on screen, on the ladder's own axis (index levels in XY, premium in plain). */
export function widgetsFor(slices: LadderSlice[], mode: 'xy' | 'plain'): LadderWidget[] {
  const groups = new Map<string, LadderWidget>();
  const newest = new Map<string, number>();
  const add = (w: Omit<LadderWidget, 'key'>, at: number) => {
    // Unfilled orders never merge; open and exiting slices at one level do not either (an exiting one must not strip the
    // + / − / drag controls from the open ones).
    const key = `${w.kind}|${w.column}|${w.price}|${w.planned ? 'p' : ''}|${w.adjust ?? 'none'}|${w.adjust === 'order' ? w.ids[0] : ''}`;
    const g = groups.get(key);
    if (!g) { groups.set(key, { ...w, key }); newest.set(key, at); return; }
    // One exit level shared by several slices: one widget with their total quantity, newest slice first.
    g.qty += w.qty; g.lots += w.lots;
    if (at >= (newest.get(key) ?? 0)) { g.ids = [...w.ids, ...g.ids]; newest.set(key, at); } else g.ids = [...g.ids, ...w.ids];
  };
  for (const s of slices) {
    const held = Number(s.filledQty) || 0;
    const heldLots = Math.max(1, Math.round(held / s.contract.lotSize));
    const live = s.state === 'open';
    if (mode === 'xy' && s.kind === 'xy') {
      if (s.state === 'armed' && s.entryLevel) {
        add({ price: s.entryLevel, column: s.side, kind: 'entry', label: s.orderType === 'SL' ? 'SL entry' : 'Entry', qty: s.qty, lots: s.lots, ids: [s.id], adjust: 'order', cancellable: true, drag: 'entry' }, 0);
        if (s.bracket) {
          // As in OptionX: the bracket's target and SL show the moment it is placed, before it fills.
          const lv = bracketLevels(bias(s.contract.opt, s.side), s.entryLevel, s.bracket);
          if (lv.tgtY != null) add({ price: lv.tgtY, column: opposite(s.side), kind: 'tgt', label: 'Target', qty: s.qty, lots: s.lots, ids: [s.id], planned: true }, 0);
          add({ price: lv.slY, column: opposite(s.side), kind: 'sl', label: s.bracket.trailPts ? 'Trailing SL' : 'SL', qty: s.qty, lots: s.lots, ids: [s.id], planned: true }, 0);
        }
      }
      if ((s.state === 'open' || s.state === 'exiting') && s.bracket && held > 0) {
        const common = { column: opposite(s.side), qty: held, lots: heldLots, ids: [s.id], ...(live ? { adjust: 'position' as const } : {}) };
        if (s.tgtY != null) add({ ...common, price: s.tgtY, kind: 'tgt', label: 'Target', ...(live ? { drag: 'tgt' as const } : {}) }, s.openedAt ?? 0);
        if (s.slY != null) add({ ...common, price: s.slY, kind: 'sl', label: s.bracket.trailPts ? 'Trailing SL' : 'SL', ...(live ? { drag: 'sl' as const } : {}) }, s.openedAt ?? 0);
      }
    }
    if (mode === 'plain' && s.kind === 'plain' && s.state === 'working') {
      const p = s.limitPrice ?? s.triggerPrice;
      if (p) add({ price: p, column: s.side, kind: 'entry', label: s.orderType === 'SL' ? 'SL order' : 'Limit order', qty: s.qty, lots: s.lots, ids: [s.id], cancellable: true, ...(s.mode === 'sim' ? { adjust: 'order' as const } : {}) }, 0);
    }
    if (mode === 'plain' && (s.state === 'open' || s.state === 'exiting') && s.avg && held > 0) {
      add({ price: s.avg, column: s.side, kind: 'pos', label: 'Position', qty: held, lots: heldLots, ids: [s.id], ...(live ? { adjust: 'position' as const } : {}) }, s.openedAt ?? 0);
    }
  }
  return [...groups.values()];
}

const QTY_TONE: Record<LadderSide, string> = {
  BUY: 'bg-emerald-600 text-oncolor',
  SELL: 'bg-red-600 text-oncolor',
};
const TAG: Record<LadderWidget['kind'], string> = { entry: '', tgt: 'TGT', sl: 'SL', pos: 'POS' };

const DRAG_MIME = 'application/x-price-ladder';

function Widget({ w, decimals, onAdjust, onCancel }: {
  w: LadderWidget; decimals: number;
  onAdjust: (w: LadderWidget, delta: 1 | -1) => void; onCancel: (id: string) => void;
}) {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const what = `${w.label} ${w.column} ${w.lots} lot${w.lots === 1 ? '' : 's'} at ${w.price}`;
  const plusTitle = w.adjust === 'position' ? 'Add 1 lot to the position at market' : 'One more lot on this order';
  const minusTitle = w.adjust === 'position' ? 'Exit 1 lot at market' : 'One lot fewer on this order';
  return (
    <span
      onClick={stop} onKeyDown={stop}
      draggable={!!w.drag}
      onDragStart={w.drag ? e => { e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ ids: w.ids, what: w.drag })); e.dataTransfer.effectAllowed = 'move'; } : undefined}
      title={w.planned ? `${w.label} — set when the entry fills` : w.drag ? `${w.label} — drag to another price to move it` : w.label}
      data-widget={w.kind}
      className={`inline-flex items-stretch h-5 rounded border text-[10px] font-mono overflow-hidden ${w.planned ? 'border-dashed border-zinc-600 opacity-60' : 'border-zinc-700'} ${w.drag ? 'cursor-grab' : ''}`}
    >
      <span className="flex items-center gap-1 px-1.5 bg-zinc-800 text-zinc-200">
        {TAG[w.kind] && <span className="font-bold text-zinc-400">{TAG[w.kind]}</span>}
        {w.price.toFixed(decimals)}
      </span>
      {w.adjust && (
        <span className="flex flex-col bg-zinc-900 border-x border-zinc-700">
          <button type="button" aria-label={`Plus one lot: ${what}`} title={plusTitle} onClick={() => onAdjust(w, 1)}
            className="flex-1 px-0.5 text-zinc-300 hover:text-white hover:bg-zinc-700 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400">
            <Plus className="w-2.5 h-2.5" />
          </button>
          <button type="button" aria-label={`Minus one lot: ${what}`} title={minusTitle} onClick={() => onAdjust(w, -1)}
            className="flex-1 px-0.5 text-zinc-300 hover:text-white hover:bg-zinc-700 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400">
            <Minus className="w-2.5 h-2.5" />
          </button>
        </span>
      )}
      <span className={`flex items-center px-1.5 font-bold ${QTY_TONE[w.column]}`} title={`${w.lots} lot${w.lots === 1 ? '' : 's'}`}>
        {w.qty}
      </span>
      {w.cancellable && (
        <button type="button" aria-label={`Cancel ${what}`} onClick={() => onCancel(w.ids[0])}
          className="px-0.5 bg-zinc-900 text-zinc-400 hover:text-white hover:bg-zinc-700 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400">
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}

/**
 * The ladder: Buy | Bids | Price | Offers | Sell. A click on an empty part of the Buy or Sell cell places at that row's
 * price; orders sit in those cells as widgets. No depth in v1 (Bids/Offers only carry the limit-zone tint), and the
 * reference row (spot in XY, LTP in plain) is lit. `limitZoneBuy` flips for a Put in XY mode, so the tint follows the
 * option, not the index.
 */
export function LadderGrid({
  center, refPrice, tick, rows, widgets, limitZoneBuy, onPlace, onCancel, onMove, onAdjust, disabled, decimals,
}: {
  center: number; refPrice: number; tick: number; rows: number; widgets: LadderWidget[];
  limitZoneBuy: 'below' | 'above';
  onPlace: (side: LadderSide, price: number) => void; onCancel: (id: string) => void;
  /** A widget dropped on another row: move that entry level / target / SL there (for every slice behind the widget). */
  onMove: (ids: string[], what: 'entry' | 'tgt' | 'sl', price: number) => void;
  onAdjust: (w: LadderWidget, delta: 1 | -1) => void;
  disabled: boolean; decimals: number;
}) {
  const prices = ladderRows(center, tick, rows);
  const refRow = refPrice > 0 ? snapToStep(refPrice, tick) : null;
  const byRow = new Map<number, LadderWidget[]>();
  for (const w of widgets) {
    const k = snapToStep(w.price, tick);
    (byRow.get(k) ?? byRow.set(k, []).get(k)!).push(w);
  }
  const fmt = (v: number) => v.toFixed(decimals);

  const cell = (side: LadderSide, p: number, zone: boolean, ws: LadderWidget[]) => (
    <div
      role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
      aria-label={`${side === 'BUY' ? 'Buy' : 'Sell'} at ${fmt(p)}`}
      onClick={() => { if (!disabled) onPlace(side, p); }}
      onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPlace(side, p); } }}
      className={`h-7 flex items-center gap-1 px-1 overflow-hidden transition-colors ${side === 'BUY' ? 'justify-end' : 'justify-start'} ${zone ? (side === 'BUY' ? 'bg-emerald-500/5' : 'bg-red-500/5') : ''} ${disabled ? 'cursor-not-allowed' : side === 'BUY' ? 'cursor-pointer hover:bg-emerald-500/25' : 'cursor-pointer hover:bg-red-500/25'} focus-visible:outline focus-visible:outline-1 ${side === 'BUY' ? 'focus-visible:outline-emerald-400' : 'focus-visible:outline-red-400'}`}
    >
      {ws.map(w => <Widget key={w.key} w={w} decimals={decimals} onAdjust={onAdjust} onCancel={onCancel} />)}
    </div>
  );

  return (
    <div className="rounded-lg border border-zinc-800 overflow-hidden bg-zinc-950">
      <div className="grid grid-cols-[1.6fr_0.6fr_0.8fr_0.6fr_1.6fr] text-xs font-bold text-white bg-zinc-800">
        <div className="px-2 py-1.5 text-center">Buy</div>
        <div className="px-2 py-1.5 text-center">Bids</div>
        <div className="px-2 py-1.5 text-center">Price</div>
        <div className="px-2 py-1.5 text-center">Offers</div>
        <div className="px-2 py-1.5 text-center">Sell</div>
      </div>
      {prices.map(p => {
        const isRef = refRow != null && Math.abs(p - refRow) < tick / 2;
        const below = refPrice > 0 && p < refPrice;
        const above = refPrice > 0 && p > refPrice;
        const buyZone = limitZoneBuy === 'below' ? below : above;
        const sellZone = limitZoneBuy === 'below' ? above : below;
        const ws = byRow.get(p) ?? [];
        return (
          <div
            key={p}
            className={`grid grid-cols-[1.6fr_0.6fr_0.8fr_0.6fr_1.6fr] border-t border-zinc-900 text-xs ${isRef ? 'bg-amber-500/15' : ''}`}
            onDragOver={e => { if (e.dataTransfer.types.includes(DRAG_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
            onDrop={e => {
              const raw = e.dataTransfer.getData(DRAG_MIME);
              if (!raw) return;
              e.preventDefault();
              try { const d = JSON.parse(raw) as { ids: string[]; what: 'entry' | 'tgt' | 'sl' }; onMove(d.ids, d.what, p); } catch { /* not ours */ }
            }}
          >
            {cell('BUY', p, buyZone, ws.filter(w => w.column === 'BUY'))}
            <div className={`h-7 ${buyZone ? 'bg-emerald-500/10' : ''}`} />
            <div className={`h-7 flex items-center justify-center font-mono ${isRef ? 'font-bold text-amber-300' : 'text-zinc-200'}`}>
              {isRef ? refPrice.toFixed(2) : fmt(p)}
            </div>
            <div className={`h-7 ${sellZone ? 'bg-red-500/10' : ''}`} />
            {cell('SELL', p, sellZone, ws.filter(w => w.column === 'SELL'))}
          </div>
        );
      })}
    </div>
  );
}
