'use client';

import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Minus, Plus, X } from 'lucide-react';
import { oiAtRow, barPct, oiChangePct, compactOi, type OiStrike } from '@/lib/priceLadderOi';
import { bias, bracketLevels, ladderRows, rowPnl, snapToStep, type LadderSide, type LadderSlice, type LadderZones } from '@/lib/priceLadder';
import { pairBias, type LadderPair } from '@/lib/priceLadderPair';
import type { LadderBasket } from '@/lib/priceLadderBasket';

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
  /** MCX (Dhan qty in lots): barrels per lot, so the badge can show barrels. Absent = qty is already in units. */
  mult?: number;
  /** A trailing SL's distance behind the best level (continuous trail); the marker shows it with − / + to change it. */
  trail?: number;
}

/** An open position's entry on the ladder's axis: drawn as a tinted row with a side / qty / fill tag in the Price column. */
export interface EntryMark { y: number; side: LadderSide; qty: number; avg?: number; /** Open P&L in rupees; null = no price yet, absent = not shown. */ pnl?: number | null }

const opposite = (s: LadderSide): LadderSide => (s === 'BUY' ? 'SELL' : 'BUY');

/** Widgets for the slices of the contract on screen, on the ladder's own axis (index levels in XY, premium in plain). */
export function widgetsFor(slices: LadderSlice[], mode: 'xy' | 'plain'): LadderWidget[] {
  // Every slice on screen is one contract, so one multiplier.
  const contractMult = slices.find(s => s.contract.mult)?.contract.mult;
  const groups = new Map<string, LadderWidget>();
  const newest = new Map<string, number>();
  const add = (w: Omit<LadderWidget, 'key'>, at: number) => {
    // Unfilled orders never merge; open and exiting slices at one level do not either (an exiting one must not strip the
    // + / − / drag controls from the open ones).
    const key = `${w.kind}|${w.column}|${w.price}|${w.planned ? 'p' : ''}|${w.adjust ?? 'none'}|${w.adjust === 'order' ? w.ids[0] : ''}`;
    const g = groups.get(key);
    if (!g) { groups.set(key, { ...w, key, ...(contractMult ? { mult: contractMult } : {}) }); newest.set(key, at); return; }
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
          add({ price: lv.slY, column: opposite(s.side), kind: 'sl', label: s.bracket.trailPts ? 'Trailing SL' : 'SL', qty: s.qty, lots: s.lots, ids: [s.id], planned: true, drag: 'sl', ...(s.bracket.trailPts ? { trail: s.bracket.trailPts } : {}) }, 0);
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
          if (s.slY != null) add({ ...common, price: s.slY, kind: 'sl', label: s.bracket.trailPts ? 'Trailing SL' : 'SL', ...(live ? { drag: 'sl' as const } : {}), ...(s.bracket.trailPts ? { trail: s.bracket.trailPts } : {}) }, s.openedAt ?? 0);
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

/**
 * Widgets for the pairs on screen, on the combined-premium axis: an armed entry (× cancels, drag moves) with its planned
 * target / SL, and an open pair's position plus target / SL (drag; a trailing SL shows − / +). No + / − lots on a pair
 * in Phase 1: exit it from the pair table.
 */
export function pairWidgetsFor(pairs: LadderPair[]): LadderWidget[] {
  const out: LadderWidget[] = [];
  // Open pairs on one level (a '+1 lot' shares its pair's levels) draw as ONE widget with their total, newest id first —
  // its + / − and drag act on all of them.
  const merged = new Map<string, LadderWidget>();
  const newest = new Map<string, number>();
  const addOpen = (w: LadderWidget, at: number) => {
    const k = `${w.kind}|${w.column}|${w.price}`;
    const g = merged.get(k);
    if (!g) { merged.set(k, { ...w, key: `po|${k}` }); newest.set(k, at); return; }
    g.qty += w.qty; g.lots += w.lots;
    if (at >= (newest.get(k) ?? 0)) { g.ids = [...w.ids, ...g.ids]; newest.set(k, at); } else g.ids = [...g.ids, ...w.ids];
  };
  for (const p of pairs) {
    const lotSize = p.legs.ce.contract.lotSize;
    const mult = p.legs.ce.contract.mult;
    const common = { qty: p.qty, lots: p.lots, ids: [p.id], ...(mult ? { mult } : {}) };
    const exitCol = opposite(p.side);
    const trail = p.bracket?.trailPts ? { trail: p.bracket.trailPts } : {};
    const slLabel = p.bracket?.trailPts ? 'Trailing SL' : 'SL';
    if (p.state === 'armed' && p.entryLevel) {
      out.push({ ...common, key: `pe|${p.id}`, price: p.entryLevel, column: p.side, kind: 'entry', label: p.orderType === 'SL' ? 'Pair breakout entry' : 'Pair entry', cancellable: true, drag: 'entry' });
      if (p.bracket) {
        const lv = bracketLevels(pairBias(p.side), p.entryLevel, p.bracket);
        if (lv.tgtY != null) out.push({ ...common, key: `pt|${p.id}`, price: lv.tgtY, column: exitCol, kind: 'tgt', label: 'Target', planned: true, drag: 'tgt' });
        out.push({ ...common, key: `ps|${p.id}`, price: lv.slY, column: exitCol, kind: 'sl', label: slLabel, planned: true, drag: 'sl', ...trail });
      }
    }
    // A position (also while exiting, BROKEN or UNKNOWN) stays marked at its combined fill; only an open pair's exits drag.
    if ((p.state === 'exiting' || p.state === 'rolling' || p.state === 'broken' || p.state === 'unknown') && p.entryY != null) {
      out.push({ ...common, key: `pp|${p.id}`, price: p.entryY, column: p.side, kind: 'pos', label: `Pair position (${p.state})`, lots: Math.max(1, Math.round(p.qty / lotSize)) });
    }
    if (p.state === 'open') {
      // + adds one lot to both legs at market (joining these levels); − exits one lot of both legs.
      const live = { ...common, adjust: 'position' as const, lots: Math.max(1, Math.round(p.qty / lotSize)) };
      const at = p.openedAt ?? p.createdAt;
      if (p.entryY != null) addOpen({ ...live, key: '', price: p.entryY, column: p.side, kind: 'pos', label: 'Pair position' }, at);
      if (p.tgtY != null) addOpen({ ...live, key: '', price: p.tgtY, column: exitCol, kind: 'tgt', label: 'Target', drag: 'tgt' }, at);
      if (p.slY != null) addOpen({ ...live, key: '', price: p.slY, column: exitCol, kind: 'sl', label: slLabel, drag: 'sl', ...trail }, at);
    }
  }
  return [...out, ...merged.values()];
}

/**
 * Widgets for the baskets on screen, on the net-premium axis: an armed entry (× cancels, drag moves) with its planned
 * target / SL, and an open basket's position plus target / SL (drag; a trailing SL shows − / +). Lots are changed with the
 * 25 / 50 / 75 / Exit buttons, so no + / − on the widgets.
 */
export function basketWidgetsFor(baskets: LadderBasket[]): LadderWidget[] {
  const out: LadderWidget[] = [];
  for (const b of baskets) {
    const lotSize = b.legs[0].contract.lotSize;
    const mult = b.legs[0].contract.mult;
    const common = { qty: b.lots * lotSize, lots: b.lots, ids: [b.id], ...(mult ? { mult } : {}) };
    const exitCol = opposite(b.side);
    const trail = b.bracket?.trailPts ? { trail: b.bracket.trailPts } : {};
    const slLabel = b.bracket?.trailPts ? 'Trailing SL' : 'SL';
    if (b.state === 'armed' && b.entryLevel) {
      out.push({ ...common, key: `be|${b.id}`, price: b.entryLevel, column: b.side, kind: 'entry', label: b.orderType === 'SL' ? 'Basket breakout entry' : 'Basket entry', cancellable: true, drag: 'entry' });
      if (b.bracket) {
        const lv = bracketLevels(pairBias(b.side), b.entryLevel, b.bracket);
        if (lv.tgtY != null) out.push({ ...common, key: `bt|${b.id}`, price: lv.tgtY, column: exitCol, kind: 'tgt', label: 'Target', planned: true, drag: 'tgt' });
        out.push({ ...common, key: `bs|${b.id}`, price: lv.slY, column: exitCol, kind: 'sl', label: slLabel, planned: true, drag: 'sl', ...trail });
      }
    }
    if ((b.state === 'open' || b.state === 'exiting' || b.state === 'unknown') && b.entryY != null) {
      out.push({ ...common, key: `bp|${b.id}`, price: b.entryY, column: b.side, kind: 'pos', label: b.state === 'open' ? 'Basket position' : `Basket position (${b.state})` });
      if (b.state === 'open') {
        if (b.tgtY != null) out.push({ ...common, key: `bpt|${b.id}`, price: b.tgtY, column: exitCol, kind: 'tgt', label: 'Target', drag: 'tgt' });
        if (b.slY != null) out.push({ ...common, key: `bps|${b.id}`, price: b.slY, column: exitCol, kind: 'sl', label: slLabel, drag: 'sl', ...trail });
      }
    }
  }
  return out;
}

const QTY_TONE: Record<LadderSide, string> = {
  BUY: 'bg-emerald-600 text-oncolor',
  SELL: 'bg-red-600 text-oncolor',
};
/** The Price column's span of the row, in %: the grid template below is 1.3 / 0.8 / 0.8 / 0.8 / 1.3 fr (total 5), so Price starts at
 *  (1.3+0.8)/5 = 42 % and ends at 58 %. The OI bars use the 42 % outside it (the right-[58%] / left-[58%] classes below are the same geometry as literals Tailwind can see); change them together. */
const PRICE_COL_LEFT_PCT = 42;

const TAG: Record<LadderWidget['kind'], string> = { entry: '', tgt: 'TGT', sl: 'SL', pos: 'POS' };

const DRAG_MIME = 'application/x-price-ladder';

function InnerPriceWidget({ w, decimals, tick, onTrail }: {
  w: LadderWidget; decimals: number; tick: number; onTrail?: (w: LadderWidget, delta: number) => void;
}) {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const what = `${w.label} at ${w.price.toFixed(decimals)}`;
  // A trailing SL: its distance in view, with − / + (one ladder tick) to tighten / widen it.
  if (w.trail != null && onTrail) {
    const btn = 'px-0.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-700 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400';
    return (
      <div onClick={stop} onKeyDown={stop} data-widget={w.kind} className="flex items-center gap-0.5 select-none">
        <button type="button" className={btn} aria-label={`Tighten the trailing SL by ${tick} (now ${w.trail} behind)`} title={`Tighten the trail by ${tick} — the SL moves closer now`} onClick={() => onTrail(w, -tick)}>
          <Minus className="w-2.5 h-2.5" />
        </button>
        <InnerPriceWidget w={{ ...w, trail: undefined }} decimals={decimals} tick={tick} />
        <span className="font-mono text-[10px] text-amber-300" title={`Trailing ${w.trail} behind the best level`}>T{w.trail}</span>
        <button type="button" className={btn} aria-label={`Widen the trailing SL by ${tick} (now ${w.trail} behind)`} title={`Widen the trail by ${tick} — the SL follows from further back (it never moves back)`} onClick={() => onTrail(w, tick)}>
          <Plus className="w-2.5 h-2.5" />
        </button>
      </div>
    );
  }
  return (
    <div
      onClick={stop} onKeyDown={stop}
      draggable={!!w.drag}
      onDragStart={w.drag ? e => { e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ ids: w.ids, what: w.drag })); e.dataTransfer.effectAllowed = 'move'; } : undefined}
      title={w.planned ? `${w.label} — set when the entry fills; drag to another price to move it` : w.drag ? `${w.label} — drag to another price to move it` : what}
      data-widget={w.kind}
      className={`font-mono text-xs font-semibold select-none px-1 py-0.5 rounded transition-colors inline-flex items-center gap-1 ${w.planned ? 'text-zinc-400 italic opacity-75' : 'text-zinc-100'} ${w.drag ? 'cursor-grab active:cursor-grabbing hover:text-white hover:bg-zinc-800/60' : ''}`}
    >
      {TAG[w.kind] && (
        <span className={`px-1 py-0.5 rounded text-[9px] font-bold font-mono tracking-tight ${
          w.kind === 'tgt' ? 'bg-emerald-600 text-oncolor' :
          w.kind === 'sl' ? 'bg-red-600 text-oncolor' :
          'bg-blue-600 text-oncolor'
        }`}>
          {TAG[w.kind]}
        </span>
      )}
      <span>{w.price.toFixed(decimals)}</span>
    </div>
  );
}

/** Quantity on a widget: units (index options), or barrels for MCX where Dhan's qty is lots. */
function QtyBadge({ w }: { w: LadderWidget }) {
  const lots = `${w.lots} lot${w.lots === 1 ? '' : 's'}`;
  return (
    <span className={`px-2 py-0.5 rounded font-mono font-bold text-xs whitespace-nowrap ${QTY_TONE[w.column]}`} title={w.mult ? `${lots} = ${w.qty * w.mult} barrels` : lots}>
      {w.mult ? `${w.qty * w.mult} bbl` : w.qty}
    </span>
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
        <QtyBadge w={w} />
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
        <QtyBadge w={w} />
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

export interface LadderKeyLevels {
  pdh?: number | null;
  pdl?: number | null;
  dayHigh?: number | null;
  dayLow?: number | null;
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
  center, refPrice, tick, rows, widgets, limitZoneBuy, onPlace, onCancel, onMove, onAdjust, disabled, decimals, entryMarks, oi, onScroll,
  zones = 'classic', stopLimitFor, onTrail, onHoldChange, keyLevels,
}: {
  center: number; refPrice: number; tick: number; rows: number; widgets: LadderWidget[];
  limitZoneBuy: 'below' | 'above';
  /** Anywhere: the stop side of each column is live too, lightly tinted and labelled with what a click there places. */
  zones?: LadderZones;
  /** Plain: the SL-limit's limit for a stop click at `price` (labels only; the server computes the real one). */
  stopLimitFor?: (side: LadderSide, price: number) => number | null;
  /** − / + on a trailing SL marker: change its trail distance by `delta` index points. */
  onTrail?: (w: LadderWidget, delta: number) => void;
  onPlace: (side: LadderSide, price: number) => void; onCancel: (id: string) => void;
  /** A widget dropped on another row: move that entry level / target / SL there (for every slice behind the widget). */
  onMove: (ids: string[], what: 'entry' | 'tgt' | 'sl', price: number) => void;
  onAdjust: (w: LadderWidget, delta: 1 | -1) => void;
  disabled: boolean; decimals: number;
  entryMarks?: EntryMark[];
  /** XY only: the chain's OI per strike, drawn as bars behind the strike rows (call left of Price, put right), `max` = 100 %. */
  oi?: { rows: OiStrike[]; max: number };
  /** Scroll the window by N ticks (positive = up, toward higher prices). Wheel over the rows or the ▲ / ▼ buttons. */
  onScroll?: (ticks: number) => void;
  /**
   * The pointer is over the ladder (or a cell has keyboard focus): true while it is, false when it leaves. The page holds
   * the rows still meanwhile, so a re-centre on a price tick cannot move a row under the mouse between aim and click.
   */
  onHoldChange?: (held: boolean) => void;
  /** Key market levels (PDH, PDL, Today High, Today Low), marked in the Price column. */
  keyLevels?: LadderKeyLevels;
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
    <div
      className="rounded-lg border border-zinc-800 overflow-hidden bg-zinc-950"
      onMouseEnter={() => onHoldChange?.(true)} onMouseLeave={() => onHoldChange?.(false)}
      onFocus={() => onHoldChange?.(true)}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onHoldChange?.(false); }}
    >
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
        const rowPnlNow = isEntry ? rowPnl(marks) : undefined;
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
        const anywhere = zones === 'anywhere';
        // Declared before `what` below, which reads it (a later `const` would throw while the row renders).
        const atRef = Math.abs(p - refPrice) < 1e-9;
        // What a click places, for the label: the limit side is a LIMIT; in Anywhere the other side is a stop.
        const what = (side: LadderSide, inZone: boolean) => {
          const verb = side === 'BUY' ? 'Buy' : 'Sell';
          if (inZone || !anywhere || refPrice <= 0 || atRef) return `${verb} at ${fmt(p)}`;
          const lim = stopLimitFor?.(side, p);
          return stopLimitFor ? `${verb} SL-limit at ${fmt(p)}${lim ? ` (limit ${lim.toFixed(2)})` : ''}` : `${verb} breakout at ${fmt(p)}`;
        };
        const buyLabel = what('BUY', buyZone);
        const sellLabel = what('SELL', sellZone);
        const buyStop = anywhere && !buyZone && refPrice > 0 && !atRef;
        const sellStop = anywhere && !sellZone && refPrice > 0 && !atRef;
        // The stop side is the amber tint; its tooltip / aria-label say what a click there places.
        const ws = byRow.get(p) ?? [];
        const buyWs = ws.filter(w => w.column === 'BUY');
        const sellWs = ws.filter(w => w.column === 'SELL');

        const isPdh = keyLevels?.pdh != null && Math.abs(p - snapToStep(keyLevels.pdh, tick)) < tick / 2;
        const isPdl = keyLevels?.pdl != null && Math.abs(p - snapToStep(keyLevels.pdl, tick)) < tick / 2;
        const isDayHigh = keyLevels?.dayHigh != null && Math.abs(p - snapToStep(keyLevels.dayHigh, tick)) < tick / 2;
        const isDayLow = keyLevels?.dayLow != null && Math.abs(p - snapToStep(keyLevels.dayLow, tick)) < tick / 2;

        const oiRow = oi ? oiAtRow(oi.rows, p, tick) : null;
        const hasBuyTgt = buyWs.some(w => w.kind === 'tgt');
        const hasBuySl = buyWs.some(w => w.kind === 'sl');
        const hasRowTgt = ws.some(w => w.kind === 'tgt');
        const hasRowSl = ws.some(w => w.kind === 'sl');

        return (
          <div
            key={p}
            className={`grid grid-cols-[1.3fr_0.8fr_0.8fr_0.8fr_1.3fr] border-t border-zinc-900 dark:border-zinc-800 text-xs relative ${isRef ? 'bg-amber-500/15 dark:bg-amber-500/25' : isEntry ? 'bg-blue-500/10 dark:bg-blue-500/20' : ''} ${isEntry ? 'border-y-2 border-y-blue-500' : ''}`}
            onDragOver={e => { if (e.dataTransfer.types.includes(DRAG_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
            onDrop={e => {
              const raw = e.dataTransfer.getData(DRAG_MIME);
              if (!raw) return;
              e.preventDefault();
              try { const d = JSON.parse(raw) as { ids: string[]; what: 'entry' | 'tgt' | 'sl' }; onMove(d.ids, d.what, p); } catch { /* not ours */ }
            }}
          >
            {oiRow && oi && (() => {
              const chg = (v: number, pv: number | null) => { const c = oiChangePct(v, pv); return c == null ? 'no previous-day OI' : `${c >= 0 ? '+' : ''}${c.toFixed(1)}% vs prev day`; };
              const pePct = barPct(oiRow.peOi, oi.max), cePct = barPct(oiRow.ceOi, oi.max);
              // A row carrying order widgets keeps its bars but not their numbers: the labels would sit under the widgets (hover still gives the OI).
              const showNum = ws.length === 0 && buyWs.length === 0;
              // Each bar uses at most the PRICE_COL_LEFT_PCT of the row outside the Price column.
              return (
                <div className="absolute inset-0 pointer-events-none select-none" aria-hidden="true">
                  {/* Call OI (red) grows to the LEFT of the Price column, Put OI (green) to the RIGHT. */}
                  {cePct > 0 && (
                    <div title={`${oiRow.strike} CE OI ${oiRow.ceOi.toLocaleString('en-IN')} · ${chg(oiRow.ceOi, oiRow.cePrev)}`}
                      className="absolute top-0.5 bottom-0.5 right-[58%] rounded-l bg-red-500/25 flex items-center pl-1 text-[9px] font-mono text-zinc-400"
                      style={{ width: `${cePct * PRICE_COL_LEFT_PCT / 100}%` }}>{showNum ? compactOi(oiRow.ceOi) : null}</div>
                  )}
                  {pePct > 0 && (
                    <div title={`${oiRow.strike} PE OI ${oiRow.peOi.toLocaleString('en-IN')} · ${chg(oiRow.peOi, oiRow.pePrev)}`}
                      className="absolute top-0.5 bottom-0.5 left-[58%] rounded-r bg-emerald-500/25 flex items-center justify-end pr-1 text-[9px] font-mono text-zinc-400"
                      style={{ width: `${pePct * PRICE_COL_LEFT_PCT / 100}%` }}>{showNum ? compactOi(oiRow.peOi) : null}</div>
                  )}
                </div>
              );
            })()}
            {/* Column 1: Buy (Outer controls) */}
            <div
              role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
              aria-label={buyLabel} title={buyStop ? buyLabel : undefined}
              onClick={() => { if (!disabled) onPlace('BUY', p); }}
              onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPlace('BUY', p); } }}
              className={`h-7 flex items-center justify-end gap-1 px-1 overflow-hidden transition-colors ${buyZone ? 'bg-emerald-500/5 dark:bg-emerald-500/12' : buyStop ? 'bg-amber-500/5 dark:bg-amber-500/10' : ''} ${disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-emerald-500/25 dark:hover:bg-emerald-500/35'} focus-visible:outline focus-visible:outline-1 focus-visible:outline-emerald-400`}
            >
              {buyWs.map(w => <OuterControlWidget key={w.key} w={w} onAdjust={onAdjust} onCancel={onCancel} />)}
            </div>

            {/* Column 2: Bids (Inner trigger price for Buy-side triggers) */}
            <div
              role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
              aria-label={buyStop ? buyLabel : `Bid ${fmt(p)}`} title={buyStop ? buyLabel : undefined}
              onClick={() => { if (!disabled) onPlace('BUY', p); }}
              onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPlace('BUY', p); } }}
              className={`h-7 flex items-center justify-center gap-1 px-1 overflow-hidden transition-colors ${buyZone ? 'bg-emerald-500/10 dark:bg-emerald-500/22' : buyStop ? 'bg-amber-500/10 dark:bg-amber-500/18' : ''} ${disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-emerald-500/20 dark:hover:bg-emerald-500/35'}`}
            >
              {buyWs.map(w => <InnerPriceWidget key={w.key} w={w} decimals={decimals} tick={tick} onTrail={onTrail} />)}
              {hasRowTgt && !hasBuyTgt && (
                <span title="Target"
                  className="px-1 py-0.5 rounded text-[9px] font-bold font-mono tracking-tight bg-emerald-600 text-oncolor pointer-events-none select-none">
                  TGT
                </span>
              )}
              {hasRowSl && !hasBuySl && (
                <span title="Stop Loss"
                  className="px-1 py-0.5 rounded text-[9px] font-bold font-mono tracking-tight bg-red-600 text-oncolor pointer-events-none select-none">
                  SL
                </span>
              )}
            </div>

            {/* Column 3: Price */}
            <div className={`h-7 flex items-center justify-center gap-1 font-mono overflow-hidden ${isPdh ? 'bg-rose-500/25 ring-1 ring-inset ring-rose-500/50' : isPdl ? 'bg-emerald-500/25 ring-1 ring-inset ring-emerald-500/50' : isDayHigh ? 'bg-amber-500/25 ring-1 ring-inset ring-amber-500/50' : isDayLow ? 'bg-cyan-500/25 ring-1 ring-inset ring-cyan-500/50' : ''} ${isRef ? 'font-bold text-amber-300' : isEntry ? 'font-bold text-blue-300' : 'text-zinc-200 dark:text-zinc-100'}`}>
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
              {isPdh && (
                <span title={`Previous Day High: ${keyLevels?.pdh?.toFixed(decimals)}`}
                  className="shrink-0 px-1 py-0.5 rounded text-[9px] font-bold font-mono tracking-tight leading-none shadow-sm bg-rose-500/20 text-rose-300 border border-rose-500/40 pointer-events-none select-none">
                  PDH
                </span>
              )}
              {isDayHigh && (
                <span title={`Today's High: ${keyLevels?.dayHigh?.toFixed(decimals)}`}
                  className="shrink-0 px-1 py-0.5 rounded text-[9px] font-bold font-mono tracking-tight leading-none shadow-sm bg-amber-500/20 text-amber-300 border border-amber-500/40 pointer-events-none select-none">
                  DH
                </span>
              )}
              {isDayLow && (
                <span title={`Today's Low: ${keyLevels?.dayLow?.toFixed(decimals)}`}
                  className="shrink-0 px-1 py-0.5 rounded text-[9px] font-bold font-mono tracking-tight leading-none shadow-sm bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 pointer-events-none select-none">
                  DL
                </span>
              )}
              {isPdl && (
                <span title={`Previous Day Low: ${keyLevels?.pdl?.toFixed(decimals)}`}
                  className="shrink-0 px-1 py-0.5 rounded text-[9px] font-bold font-mono tracking-tight leading-none shadow-sm bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 pointer-events-none select-none">
                  PDL
                </span>
              )}
              {/* XY only: the option's fill premium (in plain mode the row price IS the fill). */}
              {isEntry && tags[0]?.avg != null && Math.abs(tags[0].avg - p) >= tick && <span className="shrink-0 text-[10px] font-semibold text-blue-300">@{tags[0].avg.toFixed(2)}</span>}
              {rowPnlNow !== undefined && (
                <span
                  title="Open P&L at the live price"
                  className={`shrink-0 px-1 rounded text-[10px] font-bold leading-4 ${rowPnlNow == null ? 'text-zinc-400' : rowPnlNow >= 0 ? 'text-emerald-400' : 'text-red-400'}`}
                >
                  {rowPnlNow == null ? '—' : `${rowPnlNow >= 0 ? '+' : '−'}₹${Math.abs(Math.round(rowPnlNow)).toLocaleString('en-IN')}`}
                </span>
              )}
            </div>

            {/* Column 4: Offers (Inner trigger price for Sell-side triggers) */}
            <div
              role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
              aria-label={sellStop ? sellLabel : `Offer ${fmt(p)}`} title={sellStop ? sellLabel : undefined}
              onClick={() => { if (!disabled) onPlace('SELL', p); }}
              onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPlace('SELL', p); } }}
              className={`h-7 flex items-center justify-center px-1 overflow-hidden transition-colors ${sellZone ? 'bg-red-500/10 dark:bg-red-500/22' : sellStop ? 'bg-amber-500/10 dark:bg-amber-500/18' : ''} ${disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-red-500/20 dark:hover:bg-red-500/35'}`}
            >
              {sellWs.map(w => <InnerPriceWidget key={w.key} w={w} decimals={decimals} tick={tick} onTrail={onTrail} />)}
            </div>

            {/* Column 5: Sell (Outer controls) */}
            <div
              role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
              aria-label={sellLabel} title={sellStop ? sellLabel : undefined}
              onClick={() => { if (!disabled) onPlace('SELL', p); }}
              onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPlace('SELL', p); } }}
              className={`h-7 flex items-center justify-start gap-1 px-1 overflow-hidden transition-colors ${sellZone ? 'bg-red-500/5 dark:bg-red-500/12' : sellStop ? 'bg-amber-500/5 dark:bg-amber-500/10' : ''} ${disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-red-500/25 dark:hover:bg-red-500/35'} focus-visible:outline focus-visible:outline-1 focus-visible:outline-red-400`}
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
