'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowDownRight, ArrowLeftRight, ArrowUpRight, Crosshair, GripVertical, Loader2, Lock, LockOpen, Minus, Plus, X, XCircle } from 'lucide-react';
import { BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import type { PnfTrade } from './usePnfTrade';

// The Renko page's floating Scalper: Buy / Sell at market, a lots stepper, Close and Reverse, and the live P&L. It is a second
// view of the page's order engine (usePnfTrade), so it trades the same position with the same lots as the trade bar.
// REAL opens LOCKED (one Unlock click, never remembered); hotkeys act only while the window has focus and never on key repeat.

export type ScalperPos = { x: number; y: number };

export interface ScalperWindowProps {
  trade: PnfTrade;
  /** The chart the window trades ("C1 · CRUDEOILM FUT 19 Nov 26"). */
  label: string;
  broker: Broker;
  mode: 'PAPER' | 'REAL';
  unlocked: boolean;
  onUnlockedChange: (v: boolean) => void;
  /** Why the chart cannot be traded by hand right now (AUTO holds it), or null. */
  blocked: string | null;
  /** The page's order Style as text ("Bracket · TGT 4 · SL 2 boxes"), so a bracket entry is never a surprise. */
  styleText: string;
  pos: ScalperPos | null;
  onMove: (p: ScalperPos) => void;
  minimized: boolean;
  onMinimizedChange: (v: boolean) => void;
  onClose: () => void;
}

const WIDTH = 300;
const MARGIN = 8;
const FULL_H = 470, MINI_W = 260, MINI_H = 40;
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60';
const inr = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
const fmtPx = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Keep the window on screen (a saved spot from a bigger monitor, or a window resize). */
function clamp(p: ScalperPos, w: number, h: number): ScalperPos {
  if (typeof window === 'undefined') return p;
  return {
    x: Math.min(Math.max(MARGIN, p.x), Math.max(MARGIN, window.innerWidth - w - MARGIN)),
    y: Math.min(Math.max(MARGIN, p.y), Math.max(MARGIN, window.innerHeight - h - MARGIN)),
  };
}

export default function ScalperWindow({
  trade, label, broker, mode, unlocked, onUnlockedChange, blocked, styleText, pos, onMove, minimized, onMinimizedChange, onClose,
}: ScalperWindowProps) {
  const {
    isEquity, cap, lots, lotsDraft, setLotsDraft, commitLots, pickLots, busy, ready, unsupported, position, positionLots,
    shownPnl, paperAvg, realError, prices, unitsPerLot, executeOrder, executeSquareOff, executeReverse,
  } = trade;
  const rootRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<ScalperPos | null>(null);
  const dragRef = useRef<{ dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);
  const [, setViewport] = useState(0);

  // Re-clamp on a window resize so the window is never stranded off-screen.
  useEffect(() => {
    const on = () => setViewport(n => n + 1);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  // Opened or expanded: take focus so the hotkeys work at once.
  useEffect(() => { if (!minimized) rootRef.current?.focus({ preventScroll: true }); }, [minimized]);

  // The last tick's direction, for the LTP arrow (kept with the render-time "seen" pattern, not an effect).
  const ltp = prices.every(p => p != null) && prices.length ? prices.reduce<number>((s, p) => s + (p ?? 0), 0) : null;
  const [seenLtp, setSeenLtp] = useState<number | null>(ltp);
  const [tickDir, setTickDir] = useState<1 | -1 | 0>(0);
  if (ltp !== seenLtp) {
    setSeenLtp(ltp);
    if (ltp != null && seenLtp != null && ltp !== seenLtp) setTickDir(ltp > seenLtp ? 1 : -1);
  }

  // Sizes for clamping a saved spot (the real box is measured while dragging).
  const width = WIDTH, height = minimized ? MINI_H : FULL_H;
  const at = drag ?? (pos ? clamp(pos, minimized ? MINI_W : width, height) : null);
  const place = at ? { left: at.x, top: at.y } : { right: 24, bottom: 24 };

  const startDrag = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-nodrag]')) return;
    const box = rootRef.current?.getBoundingClientRect();
    if (!box) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { dx: e.clientX - box.left, dy: e.clientY - box.top, sx: e.clientX, sy: e.clientY, moved: false };
  };
  const moveDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
    d.moved = true;
    const box = rootRef.current?.getBoundingClientRect();
    setDrag(clamp({ x: e.clientX - d.dx, y: e.clientY - d.dy }, box?.width ?? width, box?.height ?? height));
  };
  /** Ends a drag; true when the pointer actually moved (so a click on the minimised pill still expands it). */
  const endDrag = (): boolean => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.moved && drag) { onMove(drag); setDrag(null); return true; }
    setDrag(null);
    return false;
  };

  const locked = mode === 'REAL' && !unlocked;
  const reason = blocked ?? unsupported ?? (!ready ? 'Looking up the contract…' : locked ? 'REAL is locked - unlock to trade' : null);
  const canTrade = !reason && !busy;
  const flat = !position;
  const canFlip = canTrade && !!position && position.side !== 'MIXED';
  const pnl = shownPnl;
  const tone = pnl == null || Math.round(pnl) === 0 ? 'zinc' : pnl > 0 ? 'up' : 'down';
  const edge = tone === 'up' ? 'bg-emerald-500' : tone === 'down' ? 'bg-red-500' : 'bg-zinc-700';
  const pnlText = tone === 'up' ? 'text-emerald-400' : tone === 'down' ? 'text-red-400' : 'text-zinc-300';
  const unit = isEquity ? 'sh' : 'lot';
  const lotsWord = (n: number) => (isEquity ? `${n} sh` : `${n} lot${n === 1 ? '' : 's'}`);
  const openLots = positionLots.length ? Math.max(...positionLots.map(Math.abs)) : 0;
  // Points on a single-leg paper position: (LTP - average) in the position's direction.
  const pts = paperAvg != null && ltp != null && position && position.side !== 'MIXED' ? (ltp - paperAvg) * (position.side === 'LONG' ? 1 : -1) : null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.repeat) { e.preventDefault(); return; }       // a held key must never send a second order
    const k = e.key.toLowerCase();
    if (k === 'arrowup' || k === 'arrowdown') { e.preventDefault(); pickLots(lots + (k === 'arrowup' ? 1 : -1)); return; }
    if (!canTrade) return;
    if (k === 'b') { e.preventDefault(); void executeOrder('BUY'); }
    else if (k === 's') { e.preventDefault(); void executeOrder('SELL'); }
    else if (k === 'x' && !flat) { e.preventDefault(); void executeSquareOff(); }
    else if (k === 'r' && canFlip) { e.preventDefault(); void executeReverse(); }
  };

  const shell = `fixed z-40 select-none ${FOCUS}`;

  if (minimized) {
    return (
      <div ref={rootRef} style={place} className={shell} data-testid="scalper-window" data-minimized="true">
        <button type="button" data-testid="scalper-expand" aria-label="Expand the scalper"
                onPointerDown={startDrag} onPointerMove={moveDrag}
                onPointerUp={() => { if (!endDrag()) onMinimizedChange(false); }}
                className={`flex items-center gap-2 h-9 pl-1 pr-3 rounded-full border bg-zinc-900 shadow-2xl cursor-grab active:cursor-grabbing ${mode === 'REAL' ? 'border-red-500/60' : 'border-zinc-700'} ${FOCUS}`}>
          <span className={`w-1.5 h-7 rounded-full ${edge}`} aria-hidden="true" />
          <Crosshair className="w-3.5 h-3.5 text-zinc-400" aria-hidden="true" />
          <span className="text-xs font-semibold text-zinc-200">Scalper</span>
          <span data-testid="scalper-pnl-mini" className={`text-sm font-bold tabular-nums ${pnlText}`}>{pnl == null ? '—' : inr(pnl)}</span>
          {position && <span className="text-[11px] text-zinc-400">{position.side === 'LONG' ? 'Long' : position.side === 'SHORT' ? 'Short' : 'Mixed'} {openLots}{isEquity ? '' : 'L'}</span>}
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} role="dialog" aria-label={`Scalper - ${label}`} tabIndex={-1} onKeyDown={onKeyDown} style={{ ...place, width }}
         data-testid="scalper-window"
         className={`${shell} flex rounded-xl border bg-zinc-900 shadow-2xl overflow-hidden ${mode === 'REAL' ? 'border-red-500/60' : 'border-zinc-700'}`}>
      {/* The P&L edge: the window's state read from across the screen. */}
      <div data-testid="scalper-edge" data-tone={tone} className={`w-1 shrink-0 transition-colors ${edge}`} aria-hidden="true" />

      <div className="flex-1 min-w-0">
        {/* Header = drag handle */}
        <div onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
             className="flex items-center gap-1.5 h-9 pl-1.5 pr-1 border-b border-zinc-800 bg-zinc-950 cursor-grab active:cursor-grabbing">
          <GripVertical className="w-3.5 h-3.5 text-zinc-500 shrink-0" aria-hidden="true" />
          <span className="text-xs font-bold text-zinc-100">Scalper</span>
          <span className="min-w-0 truncate text-[11px] text-zinc-400" title={label}>{label}</span>
          <span className="ml-auto" />
          <span data-testid="scalper-mode"
                className={`shrink-0 px-1.5 h-5 inline-flex items-center rounded text-[10px] font-bold ${mode === 'REAL' ? 'bg-red-600 text-oncolor' : 'bg-zinc-800 text-zinc-300'}`}>
            {mode === 'REAL' ? `REAL · ${BROKER_LABELS[broker]}` : 'Paper'}
          </span>
          {mode === 'REAL' && unlocked && (
            <button type="button" data-nodrag aria-label="Lock the scalper" title="Lock: Buy / Sell stop working until you unlock again"
                    onClick={() => onUnlockedChange(false)}
                    className={`w-6 h-6 inline-flex items-center justify-center rounded text-amber-400 hover:bg-zinc-800 ${FOCUS}`}>
              <LockOpen className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
          <button type="button" data-nodrag aria-label="Minimise the scalper" onClick={() => onMinimizedChange(true)}
                  className={`w-6 h-6 inline-flex items-center justify-center rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 ${FOCUS}`}>
            <Minus className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button type="button" data-nodrag aria-label="Close the scalper" onClick={onClose}
                  className={`w-6 h-6 inline-flex items-center justify-center rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 ${FOCUS}`}>
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>

        {/* P&L and position */}
        <div className="px-3 pt-3 pb-2.5 border-b border-zinc-800">
          <div className="flex items-baseline gap-2">
            {tone === 'up' ? <ArrowUpRight className="w-5 h-5 text-emerald-400 self-center" aria-hidden="true" />
              : tone === 'down' ? <ArrowDownRight className="w-5 h-5 text-red-400 self-center" aria-hidden="true" /> : null}
            <span data-testid="scalper-pnl" className={`text-3xl font-bold tabular-nums leading-none ${pnlText}`}>{pnl == null ? '—' : inr(pnl)}</span>
            <span className="ml-auto text-[10px] text-zinc-500" title={mode === 'REAL' ? 'Broker book every 5 s, moved with every tick in between' : 'Paper ledger at the live price'}>
              {mode === 'REAL' ? 'book + live' : 'live'}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs">
            {realError ? (
              <span className="text-amber-400" title={realError}>Position unknown - {realError}</span>
            ) : position ? (
              <>
                <span data-testid="scalper-position"
                      className={`px-1.5 h-5 inline-flex items-center rounded font-bold ${position.side === 'LONG' ? 'bg-emerald-500/15 text-emerald-400' : position.side === 'SHORT' ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-400'}`}>
                  {position.side === 'LONG' ? 'Long' : position.side === 'SHORT' ? 'Short' : 'Mixed'} {lotsWord(openLots)}
                </span>
                {paperAvg != null && <span className="text-zinc-400 tabular-nums">avg {fmtPx(paperAvg)}</span>}
                {pts != null && <span className={`tabular-nums font-semibold ${pts > 0 ? 'text-emerald-400' : pts < 0 ? 'text-red-400' : 'text-zinc-400'}`}>{pts > 0 ? '+' : ''}{pts.toFixed(1)} pts</span>}
              </>
            ) : (
              <span data-testid="scalper-position" className="text-zinc-500">Flat</span>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-zinc-400">
            <span>LTP</span>
            <span data-testid="scalper-ltp" className="font-semibold tabular-nums text-zinc-100">{ltp == null ? '—' : fmtPx(ltp)}</span>
            {tickDir !== 0 && ltp != null && (tickDir > 0
              ? <ArrowUpRight className="w-3 h-3 text-emerald-400" aria-label="up tick" />
              : <ArrowDownRight className="w-3 h-3 text-red-400" aria-label="down tick" />)}
          </div>
        </div>

        {/* Lots */}
        <div className="px-3 pt-2.5">
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400 w-8">{isEquity ? 'Qty' : 'Lots'}</span>
            <div className="inline-flex items-center rounded-lg border border-zinc-700 bg-zinc-950">
              <button type="button" aria-label={`Decrease ${isEquity ? 'quantity' : 'lots'}`} disabled={lots <= 1} onClick={() => pickLots(lots - 1)}
                      className={`w-9 h-9 inline-flex items-center justify-center rounded-l-lg text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 ${FOCUS}`}>
                <Minus className="w-4 h-4" aria-hidden="true" />
              </button>
              <input type="text" inputMode="numeric" data-testid="scalper-lots" aria-label={isEquity ? 'Order quantity' : 'Order lots'}
                     value={lotsDraft} onChange={e => setLotsDraft(e.target.value)} onBlur={e => commitLots(e.currentTarget.value)}
                     onKeyDown={e => {
                       if (e.key === 'Enter') { commitLots(e.currentTarget.value); rootRef.current?.focus(); }
                       if (e.key === 'Escape') { setLotsDraft(String(lots)); rootRef.current?.focus(); }
                     }}
                     className={`w-12 h-9 text-center text-lg font-bold tabular-nums bg-transparent text-white rounded ${FOCUS}`} />
              <button type="button" aria-label={`Increase ${isEquity ? 'quantity' : 'lots'}`} disabled={lots >= cap} onClick={() => pickLots(lots + 1)}
                      className={`w-9 h-9 inline-flex items-center justify-center rounded-r-lg text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 ${FOCUS}`}>
                <Plus className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
            {!isEquity && unitsPerLot != null && unitsPerLot > 1 && (
              <span className="text-[11px] text-zinc-500 tabular-nums">= {(lots * unitsPerLot).toLocaleString('en-IN')} units</span>
            )}
          </div>
          <div className="mt-1.5 ml-10 flex items-center gap-1" role="group" aria-label="Lot presets">
            {(isEquity ? [10, 50, 100, 500] : [1, 2, 5, 10]).filter(n => n <= cap).map(n => (
              <button key={n} type="button" aria-pressed={lots === n} onClick={() => pickLots(n)}
                      className={`px-2 h-6 rounded-md text-[11px] font-semibold tabular-nums border ${lots === n ? 'border-zinc-500 bg-zinc-700 text-white' : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200'} ${FOCUS}`}>
                {isEquity ? n : `${n}L`}
              </button>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="relative px-3 pt-3 pb-3">
          <div className={`grid grid-cols-2 gap-2 ${locked ? 'opacity-30 pointer-events-none' : ''}`} aria-hidden={locked || undefined}>
            {(['BUY', 'SELL'] as const).map(side => (
              <button key={side} type="button" data-testid={`scalper-${side.toLowerCase()}`} disabled={!canTrade} onClick={() => void executeOrder(side)}
                      aria-keyshortcuts={side === 'BUY' ? 'B' : 'S'}
                      className={`h-16 rounded-lg px-3 flex flex-col items-start justify-center text-oncolor shadow transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${side === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500'} ${FOCUS}`}>
                <span className="w-full flex items-center gap-1.5 text-base font-bold">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : side === 'BUY' ? <ArrowUpRight className="w-4 h-4" aria-hidden="true" /> : <ArrowDownRight className="w-4 h-4" aria-hidden="true" />}
                  {side === 'BUY' ? 'Buy' : 'Sell'}
                  <kbd className="ml-auto text-[10px] font-semibold px-1 rounded border border-oncolor/40">{side === 'BUY' ? 'B' : 'S'}</kbd>
                </span>
                <span className="text-[11px] font-medium tabular-nums">{lotsWord(lots)} · market</span>
              </button>
            ))}
            <button type="button" data-testid="scalper-reverse" disabled={!canFlip} onClick={() => void executeReverse()} aria-keyshortcuts="R"
                    title={position ? `Close the ${lotsWord(openLots)} position, then open ${lotsWord(Math.min(cap, openLots))} the other way` : 'No position to reverse'}
                    className={`h-9 rounded-lg border border-zinc-700 bg-zinc-800 text-xs font-semibold text-zinc-100 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5 ${FOCUS}`}>
              <ArrowLeftRight className="w-3.5 h-3.5" aria-hidden="true" /> Reverse <kbd className="text-[10px] text-zinc-400">R</kbd>
            </button>
            <button type="button" data-testid="scalper-close" disabled={!canTrade || flat} onClick={() => void executeSquareOff()} aria-keyshortcuts="X"
                    title={mode === 'REAL' ? `Closes the whole ${BROKER_LABELS[broker]} position on this contract (every product)` : 'Closes the paper position'}
                    className={`h-9 rounded-lg bg-amber-600 hover:bg-amber-500 text-xs font-bold text-oncolor disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5 ${FOCUS}`}>
              <XCircle className="w-3.5 h-3.5" aria-hidden="true" /> Close <kbd className="text-[10px]">X</kbd>
            </button>
          </div>
          {locked && !blocked && (
            <div className="absolute inset-0 flex items-center justify-center">
              <button type="button" data-testid="scalper-unlock" onClick={() => { onUnlockedChange(true); rootRef.current?.focus(); }}
                      className={`inline-flex items-center gap-2 h-10 px-4 rounded-lg border border-red-500/60 bg-zinc-900 text-sm font-bold text-red-400 hover:bg-zinc-800 shadow-xl ${FOCUS}`}>
                <Lock className="w-4 h-4" aria-hidden="true" /> Unlock to trade real money
              </button>
            </div>
          )}
        </div>

        {/* Style and status */}
        <div className="px-3 py-2 border-t border-zinc-800 bg-zinc-950 text-[11px] leading-snug">
          <div className="text-zinc-400"><span className="text-zinc-500">Style</span> {styleText}{!isEquity && ` · ${unit} cap ${cap}`}</div>
          <div data-testid="scalper-status" className={reason ? 'text-amber-400' : 'text-zinc-500'}>
            {reason ?? (busy ? 'Sending…' : 'Keys: B buy · S sell · X close · R reverse · ↑↓ lots')}
          </div>
        </div>
      </div>
    </div>
  );
}
