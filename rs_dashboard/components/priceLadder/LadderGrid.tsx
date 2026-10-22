'use client';

import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Minus, Plus, X } from 'lucide-react';
import { bias, bracketLevels, ladderRows, snapToStep, type LadderSide, type LadderSlice } from '@/lib/priceLadder';

/**
 * One order on the ladder, drawn as OptionX draws it: in the Buy or Sell column of its price row, as
 * `price | + − | qty`. The Price column itself only ever shows prices.
 *  - entry: an armed XY level or a resting plain order, in its own side's column; + / − change its lots, × cancels.
 *  - tgt / sl: an open bracket's exits, in the EXIT side's column with the position's quantity; + adds a lot to the
 *    position at market (it joins these levels), − exits one lot.
 *  - pos: a plain-mode open position at its average, in its side's column; + adds a lot, − exits one.
 *  - planned: the target / SL an armed bracket will get when it fills (dimmed, no + / −; drag moves it).
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

/** An open position's entry on the ladder's axis: drawn as a tinted row with a side / qty / fill tag in the Price column. */
export interface EntryMark { y: number; side: LadderSide; qty: number; avg?: number }

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
          // Draggable before the fill too: moving one changes the bracket's points from the entry level.
          if (lv.tgtY != null) add({ price: lv.tgtY, column: opposite(s.side), kind: 'tgt', label: 'Target', qty: s.qty, lots: s.lots, ids: [s.id], planned: true, drag: 'tgt' }, 0);
          add({ price: lv.slY, column: opposite(s.side), kind: 'sl', label: s.bracket.trailPts ? 'Trailing SL' : 'SL', qty: s.qty, lots: s.lots, ids: [s.id], planned: true, drag: 'sl' }, 0);
        }
      }
      if ((s.state === 'open' || s.state === 'exiting') && held > 0) {
        const entryPrice = s.entryY ?? s.entryLevel;
        if (entryPrice != null) {
          add({
            price: entryPrice, column: s.side, kind: 'pos', label: 'Position',
            qty: held, lots: heldLots, ids: [s.id], ...(live ? { adjust: 'position' as const } : {}),
          }, s.openedAt ?? 0);
        }
        if (s.bracket) {
          const common = { column: opposite(s.side), qty: held, lots: heldLots, ids: [s.id], ...(live ? { adjust: 'position' as const } : {}) };
          if (s.tgtY != null) add({ ...common, price: s.tgtY, kind: 'tgt', label: 'Target', ...(live ? { drag: 'tgt' as const } : {}) }, s.openedAt ?? 0);
          if (s.slY != null) add({ ...common, price: s.slY, kind: 'sl', label: s.bracket.trailPts ? 'Trailing SL' : 'SL', ...(live ? { drag: 'sl' as const } : {}) }, s.openedAt ?? 0);
        }
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

function InnerPriceWidget({ w, decimals }: { w: LadderWidget; decimals: number }) {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const what = `${w.label} at ${w.price.toFixed(decimals)}`;
  return (
    <div
      onClick={stop} onKeyDown={stop}
      draggable={!!w.drag}
      onDragStart={w.drag ? e => { e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ ids: w.ids, what: w.drag })); e.dataTransfer.effectAllowed = 'move'; } : undefined}
      title={w.planned ? `${w.label} — set when the entry fills; drag to another price to move it` : w.drag ? `${w.label} — drag to another price to move it` : what}
      data-widget={w.kind}
      className={`font-mono text-xs font-semibold select-none px-1 py-0.5 rounded transition-colors ${w.planned ? 'text-zinc-400 italic opacity-75' : 'text-zinc-100'} ${w.drag ? 'cursor-grab active:cursor-grabbing hover:text-white hover:bg-zinc-800/60' : ''}`}
    >
      {w.price.toFixed(decimals)}
    </div>
  );
}

function OuterControlWidget({ w, onAdjust, onCancel }: {
  w: LadderWidget;
  onAdjust: (w: LadderWidget, delta: 1 | -1) => void;
  onCancel: (id: string) => void;
}) {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const what = `${w.label} ${w.column} ${w.lots} lot${w.lots === 1 ? '' : 's'} at ${w.price}`;
  const plusTitle = w.adjust === 'position' ? 'Add 1 lot to the position at market' : 'One more lot on this order';
  const minusTitle = w.adjust === 'position' ? 'Exit 1 lot at market' : 'One lot fewer on this order';

  return (
    <div
      onClick={stop} onKeyDown={stop}
      draggable={!!w.drag}
      onDragStart={w.drag ? e => { e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ ids: w.ids, what: w.drag })); e.dataTransfer.effectAllowed = 'move'; } : undefined}
      className={`inline-flex items-center gap-1 select-none ${w.planned ? 'opacity-70' : ''}`}
      data-widget={w.kind}
    >
      {w.cancellable && w.column === 'BUY' && (
        <button type="button" aria-label={`Cancel ${what}`} onClick={() => onCancel(w.ids[0])}
          className="p-0.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400">
          <X className="w-3 h-3" />
        </button>
      )}

      {w.column === 'BUY' && (
        <span className={`px-2 py-0.5 rounded font-mono font-bold text-xs ${QTY_TONE[w.column]}`} title={`${w.lots} lot${w.lots === 1 ? '' : 's'}`}>
          {w.qty}
        </span>
      )}

      {w.adjust && (
        <div className="flex flex-col justify-center bg-zinc-900 border border-zinc-700 rounded overflow-hidden leading-none">
          <button type="button" aria-label={`Plus one lot: ${what}`} title={plusTitle} onClick={() => onAdjust(w, 1)}
            className="px-1 py-0.5 text-zinc-300 hover:text-white hover:bg-zinc-700 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400">
            <Plus className="w-2.5 h-2.5" />
          </button>
          <button type="button" aria-label={`Minus one lot: ${what}`} title={minusTitle} onClick={() => onAdjust(w, -1)}
            className="px-1 py-0.5 text-zinc-300 hover:text-white hover:bg-zinc-700 border-t border-zinc-800 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400">
            <Minus className="w-2.5 h-2.5" />
          </button>
        </div>
      )}

      {w.column === 'SELL' && (
        <span className={`px-2 py-0.5 rounded font-mono font-bold text-xs ${QTY_TONE[w.column]}`} title={`${w.lots} lot${w.lots === 1 ? '' : 's'}`}>
          {w.qty}
        </span>
      )}

      {w.cancellable && w.column === 'SELL' && (
        <button type="button" aria-label={`Cancel ${what}`} onClick={() => onCancel(w.ids[0])}
          className="p-0.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400">
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

/**
 * The ladder: Buy | Bids | Price | Offers | Sell.
 * Reference UI (OptionX):
 *  - Trigger prices for Target / SL / armed orders sit in the INNER column (Bids for BUY, Offers for SELL).
 *  - Controls (+ / − buttons and lot quantity) sit in the OUTER column (Buy for BUY, Sell for SELL).
 *  - The central Price column displays sequential price rungs, with the reference price (spot / LTP) highlighted.
 *  - An open position's entry row is tinted and outlined in blue, with a B/S + qty tag (and, in XY, the option's fill
 *    premium) in the Price column.
 */
export function LadderGrid({
  center, refPrice, tick, rows, widgets, limitZoneBuy, onPlace, onCancel, onMove, onAdjust, disabled, decimals, entryMarks, onScroll,
}: {
  center: number; refPrice: number; tick: number; rows: number; widgets: LadderWidget[];
  limitZoneBuy: 'below' | 'above';
  onPlace: (side: LadderSide, price: number) => void; onCancel: (id: string) => void;
  /** A widget dropped on another row: move that entry level / target / SL there (for every slice behind the widget). */
  onMove: (ids: string[], what: 'entry' | 'tgt' | 'sl', price: number) => void;
  onAdjust: (w: LadderWidget, delta: 1 | -1) => void;
  disabled: boolean; decimals: number;
  entryMarks?: EntryMark[];
  /** Scroll the window by N ticks (positive = up, toward higher prices). Wheel over the rows or the ▲ / ▼ buttons. */
  onScroll?: (ticks: number) => void;
}) {
  const prices = ladderRows(center, tick, rows);
  // Native, non-passive wheel listener: React's onWheel is passive, so it cannot stop the page scrolling too.
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef(onScroll);
  const rowsRef = useRef(rows);
  useEffect(() => { scrollRef.current = onScroll; rowsRef.current = rows; }, [onScroll, rows]);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      if (!scrollRef.current || e.ctrlKey) return;
      e.preventDefault();
      // One tick per ~40px so a trackpad's stream of small deltas does not fly through the ladder.
      // deltaMode 1 = lines, 2 = pages (a page of rows); 0 = pixels.
      acc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 40 * rowsRef.current : e.deltaY;
      const steps = Math.trunc(acc / 40);
      if (steps === 0) return;
      acc -= steps * 40;
      scrollRef.current(-steps);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const page = Math.max(1, Math.floor(rows / 3));
  const refRow = refPrice > 0 ? snapToStep(refPrice, tick) : null;
  const byRow = new Map<number, LadderWidget[]>();
  for (const w of widgets) {
    const k = snapToStep(w.price, tick);
    (byRow.get(k) ?? byRow.set(k, []).get(k)!).push(w);
  }
  const fmt = (v: number) => v.toFixed(decimals);

  return (
    <div className="rounded-lg border border-zinc-800 overflow-hidden bg-zinc-950">
      <div className="grid grid-cols-[1.3fr_0.8fr_0.8fr_0.8fr_1.3fr] text-xs font-bold text-white bg-zinc-800">
        <div className="px-2 py-1.5 text-center">Buy</div>
        <div className="px-2 py-1.5 text-center">Bids</div>
        <div className="px-2 py-1.5 text-center">Price</div>
        <div className="px-2 py-1.5 text-center">Offers</div>
        <div className="px-2 py-1.5 text-center">Sell</div>
      </div>
      {onScroll && (
        <button type="button" onClick={() => onScroll(page)} aria-label={`Scroll ladder up ${page} ticks`} title="Scroll up (or use the mouse wheel)"
          className="w-full flex items-center justify-center py-0.5 border-t border-zinc-900 text-zinc-400 hover:text-white hover:bg-zinc-800/60">
          <ChevronUp className="w-4 h-4" />
        </button>
      )}
      <div ref={bodyRef}>
      {prices.map(p => {
        const isRef = refRow != null && Math.abs(p - refRow) < tick / 2;
        const marks = entryMarks?.filter(m => Math.abs(p - snapToStep(m.y, tick)) < tick / 2) ?? [];
        const isEntry = marks.length > 0;
        // One tag per side on this row (several fills at one level add up); the avg is qty-weighted.
        const tags = (['BUY', 'SELL'] as const).map(side => {
          const ms = marks.filter(m => m.side === side);
          const qty = ms.reduce((a, m) => a + m.qty, 0);
          const priced = ms.filter(m => m.avg != null && m.avg > 0);
          const pq = priced.reduce((a, m) => a + m.qty, 0);
          const avg = pq > 0 ? priced.reduce((a, m) => a + m.avg! * m.qty, 0) / pq : null;
          return { side, qty, avg };
        }).filter(t => t.qty > 0);
        const below = refPrice > 0 && p < refPrice;
        const above = refPrice > 0 && p > refPrice;
        const buyZone = limitZoneBuy === 'below' ? below : above;
        const sellZone = limitZoneBuy === 'below' ? above : below;
        const ws = byRow.get(p) ?? [];
        const buyWs = ws.filter(w => w.column === 'BUY');
        const sellWs = ws.filter(w => w.column === 'SELL');

        return (
          <div
            key={p}
            className={`grid grid-cols-[1.3fr_0.8fr_0.8fr_0.8fr_1.3fr] border-t border-zinc-900 text-xs relative ${isRef ? 'bg-amber-500/15' : isEntry ? 'bg-blue-500/10' : ''} ${isEntry ? 'border-y-2 border-y-blue-500' : ''}`}
            onDragOver={e => { if (e.dataTransfer.types.includes(DRAG_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
            onDrop={e => {
              const raw = e.dataTransfer.getData(DRAG_MIME);
              if (!raw) return;
              e.preventDefault();
              try { const d = JSON.parse(raw) as { ids: string[]; what: 'entry' | 'tgt' | 'sl' }; onMove(d.ids, d.what, p); } catch { /* not ours */ }
            }}
          >
            {/* Column 1: Buy (Outer controls) */}
            <div
              role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
              aria-label={`Buy at ${fmt(p)}`}
              onClick={() => { if (!disabled) onPlace('BUY', p); }}
              onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPlace('BUY', p); } }}
              className={`h-7 flex items-center justify-end gap-1 px-1 overflow-hidden transition-colors ${buyZone ? 'bg-emerald-500/5' : ''} ${disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-emerald-500/25'} focus-visible:outline focus-visible:outline-1 focus-visible:outline-emerald-400`}
            >
              {buyWs.map(w => <OuterControlWidget key={w.key} w={w} onAdjust={onAdjust} onCancel={onCancel} />)}
            </div>

            {/* Column 2: Bids (Inner trigger price for Buy-side triggers) */}
            <div
              role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
              aria-label={`Bid ${fmt(p)}`}
              onClick={() => { if (!disabled) onPlace('BUY', p); }}
              onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPlace('BUY', p); } }}
              className={`h-7 flex items-center justify-center px-1 overflow-hidden transition-colors ${buyZone ? 'bg-emerald-500/10' : ''} ${disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-emerald-500/20'}`}
            >
              {buyWs.map(w => <InnerPriceWidget key={w.key} w={w} decimals={decimals} />)}
            </div>

            {/* Column 3: Price */}
            <div className={`h-7 flex items-center justify-center gap-1 font-mono overflow-hidden ${isRef ? 'font-bold text-amber-300' : isEntry ? 'font-bold text-blue-300' : 'text-zinc-200'}`}>
              {isEntry && tags.map(t => (
                <span
                  key={t.side}
                  title={`Entered: ${t.side} ${t.qty} at ${fmt(p)}${t.avg != null ? ` · fill ₹${t.avg.toFixed(2)}` : ''}`}
                  className={`shrink-0 px-1 rounded text-[10px] font-bold leading-4 text-oncolor ${t.side === 'BUY' ? 'bg-emerald-600' : 'bg-red-600'}`}
                >
                  {t.side === 'BUY' ? 'B' : 'S'}{t.qty}
                </span>
              ))}
              <span>{isRef ? refPrice.toFixed(2) : fmt(p)}</span>
              {/* XY only: the option's fill premium (in plain mode the row price IS the fill). */}
              {isEntry && tags[0]?.avg != null && Math.abs(tags[0].avg - p) >= tick && <span className="shrink-0 text-[10px] font-semibold text-blue-300">@{tags[0].avg.toFixed(2)}</span>}
            </div>

            {/* Column 4: Offers (Inner trigger price for Sell-side triggers) */}
            <div
              role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
              aria-label={`Offer ${fmt(p)}`}
              onClick={() => { if (!disabled) onPlace('SELL', p); }}
              onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPlace('SELL', p); } }}
              className={`h-7 flex items-center justify-center px-1 overflow-hidden transition-colors ${sellZone ? 'bg-red-500/10' : ''} ${disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-red-500/20'}`}
            >
              {sellWs.map(w => <InnerPriceWidget key={w.key} w={w} decimals={decimals} />)}
            </div>

            {/* Column 5: Sell (Outer controls) */}
            <div
              role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
              aria-label={`Sell at ${fmt(p)}`}
              onClick={() => { if (!disabled) onPlace('SELL', p); }}
              onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPlace('SELL', p); } }}
              className={`h-7 flex items-center justify-start gap-1 px-1 overflow-hidden transition-colors ${sellZone ? 'bg-red-500/5' : ''} ${disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-red-500/25'} focus-visible:outline focus-visible:outline-1 focus-visible:outline-red-400`}
            >
              {sellWs.map(w => <OuterControlWidget key={w.key} w={w} onAdjust={onAdjust} onCancel={onCancel} />)}
            </div>
          </div>
        );
      })}
      </div>
      {onScroll && (
        <button type="button" onClick={() => onScroll(-page)} aria-label={`Scroll ladder down ${page} ticks`} title="Scroll down (or use the mouse wheel)"
          className="w-full flex items-center justify-center py-0.5 border-t border-zinc-900 text-zinc-400 hover:text-white hover:bg-zinc-800/60">
          <ChevronDown className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
