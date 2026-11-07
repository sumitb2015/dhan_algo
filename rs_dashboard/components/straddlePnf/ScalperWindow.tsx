'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowDownRight, ArrowLeftRight, ArrowUpRight, Crosshair, GripVertical, Loader2, Lock, LockOpen, Minus, Plus, X, XCircle } from 'lucide-react';
import { BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';

// The Renko page's floating Scalper: Buy / Sell at market, a lots stepper, Close and Reverse, and the live P&L. It is a second
// view of the page's order engine (usePnfTrade), so it trades the same position with the same lots as the trade bar.
// REAL opens LOCKED (one Unlock click, never remembered); hotkeys act only while the window has focus and never on key repeat.

export type ScalperPos = { x: number; y: number };

/**
 * What the window needs from a page's order engine. The P&F / Renko engine (usePnfTrade) satisfies it as is; another page
 * passes its own engine or a thin adapter. Every order call resolves true only when the order went through, and the engine
 * itself allows one order in flight (a synchronous ref, not React state), so a hotkey and a click in one frame send once.
 */
export interface ScalperEngine {
  isEquity: boolean;
  /** Most lots (or shares) one order may carry: the stepper and presets stop here; the server enforces its own cap too. */
  cap: number;
  lots: number;
  lotsDraft: string;
  setLotsDraft: (v: string) => void;
  /** Commit a typed value (on blur / Enter only, never per keystroke: dhan-commit-on-blur). */
  commitLots: (raw: string) => void;
  pickLots: (n: number) => void;
  busy: boolean;
  /** The contract is resolved and this broker can trade it. */
  ready: boolean;
  /** Why this broker / mode cannot trade the chart, or null. */
  unsupported: string | null;
  position: { side: 'LONG' | 'SHORT' | 'MIXED'; text: string } | null;
  /** Signed lots per leg ([] when flat or unknown). */
  positionLots: number[];
  /** Rupee P&L of the position (realised + open); null when there is nothing to show. */
  shownPnl: number | null;
  /** Average entry (paper only; null when the broker reply carries none). */
  paperAvg: number | null;
  /** The REAL position read failed (the window says "Position unknown" rather than "Flat"). */
  realError: string | null;
  /** Live price per leg; the window shows their sum as LTP. */
  prices: (number | null)[];
  unitsPerLot: number | null;
  executeOrder: (action: 'BUY' | 'SELL') => Promise<boolean>;
  executeSquareOff: () => Promise<boolean>;
  /** Confirmed close first, then the same size the other way; never one 2x order. */
  executeReverse: () => Promise<boolean>;
  /** What Close does when it is not "the whole position on this contract" (a mapped index chart closes only its own units). */
  closeTitle?: string | null;
}

export interface ScalperWindowProps {
  trade: ScalperEngine;
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
  /** A mapped index chart (Renko): Buy / Sell read Bull / Bear and name the option leg each one trades ("BUY CE"). */
  sideHints?: { BUY: string; SELL: string };
  /** A line under the header: what the window trades when the header's label is not the contract (the option an index chart holds). */
  subtitle?: string | null;
}

const WIDTH = 272;
const MARGIN = 8;
/** The full window's height until it is measured (its real height varies: Bull / Bear hints, Reverse / Close, the footer). */
const FULL_H = 240, MINI_W = 260, MINI_H = 40;
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
  trade, label, broker, mode, unlocked, onUnlockedChange, blocked, styleText, pos, onMove, minimized, onMinimizedChange, onClose, sideHints, subtitle,
}: ScalperWindowProps) {
  const {
    isEquity, cap, lots, lotsDraft, setLotsDraft, commitLots, pickLots, busy, ready, unsupported, position, positionLots,
    shownPnl, paperAvg, realError, prices, unitsPerLot, executeOrder, executeSquareOff, executeReverse, closeTitle,
  } = trade;
  const rootRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<ScalperPos | null>(null);
  const dragRef = useRef<{ dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);
  const [, setViewport] = useState(0);
  // The window's real height, so a saved spot is clamped by what is actually drawn (rows come and go: hints, Reverse / Close, footer).
  const [measuredH, setMeasuredH] = useState<number | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || minimized || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setMeasuredH(Math.ceil(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [minimized]);

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
  const width = WIDTH, height = minimized ? MINI_H : measuredH ?? FULL_H;
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
  // Flat with nothing booked today is ₹0, never a dash. But a REAL position that is open (or could not be read) with no figure yet shows
  // a dash: a ₹0 there would read as a flat, safe book.
  const pnl = shownPnl ?? (realError || (mode === 'REAL' && position) ? null : 0);
  const tone = pnl == null || Math.round(pnl) === 0 ? 'zinc' : pnl > 0 ? 'up' : 'down';
  const edge = tone === 'up' ? 'bg-emerald-500' : tone === 'down' ? 'bg-red-500' : 'bg-zinc-700';
  const pnlText = tone === 'up' ? 'text-emerald-400' : tone === 'down' ? 'text-red-400' : 'text-zinc-300';
  const lotsShort = (n: number) => (isEquity ? `${n} sh` : `${n}L`);
  const openLots = positionLots.length ? Math.max(...positionLots.map(Math.abs)) : 0;
  const sideWord = position ? (position.side === 'LONG' ? 'Long' : position.side === 'SHORT' ? 'Short' : 'Mixed') : 'Flat';
  // The footer speaks only when it has something to say: why trading is off, an order going out, or a Bracket / Cover style.
  const footer = reason ?? (busy ? 'Sending…' : styleText.startsWith('Single') ? null : styleText);

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
          {position && <span className="text-[11px] text-zinc-400">{sideWord} {lotsShort(openLots)}</span>}
        </button>
      </div>
    );
  }

  const keysHelp = 'Keys (click in the window first): B buy · S sell · X close · R reverse · ↑ ↓ lots. A held key never sends twice.';
  const iconBtn = `w-6 h-6 inline-flex items-center justify-center rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 ${FOCUS}`;

  return (
    <div ref={rootRef} role="dialog" aria-label={`Scalper - ${label}`} tabIndex={-1} onKeyDown={onKeyDown} style={{ ...place, width }}
         data-testid="scalper-window" title={keysHelp}
         className={`${shell} flex rounded-lg border bg-zinc-900 shadow-2xl overflow-hidden ${mode === 'REAL' ? 'border-red-500/60' : 'border-zinc-700'}`}>
      {/* The P&L edge: the window's state read from across the screen. */}
      <div data-testid="scalper-edge" data-tone={tone} className={`w-1 shrink-0 transition-colors ${edge}`} aria-hidden="true" />

      <div className="flex-1 min-w-0">
        {/* Header = drag handle */}
        <div onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
             className="flex items-center gap-1.5 h-8 pl-1.5 pr-1 border-b border-zinc-800 bg-zinc-950 cursor-grab active:cursor-grabbing">
          <GripVertical className="w-3.5 h-3.5 text-zinc-500 shrink-0" aria-hidden="true" />
          <span className="text-xs font-bold text-zinc-100">Scalper</span>
          <span className="flex-1 min-w-0 truncate text-[11px] text-zinc-400" title={label}>{label}</span>
          <span data-testid="scalper-mode"
                className={`shrink-0 px-1.5 h-5 inline-flex items-center rounded text-[10px] font-bold ${mode === 'REAL' ? 'bg-red-600 text-oncolor' : 'bg-zinc-800 text-zinc-300'}`}>
            {mode === 'REAL' ? `REAL · ${BROKER_LABELS[broker]}` : 'Paper'}
          </span>
          {mode === 'REAL' && unlocked && (
            <button type="button" data-nodrag aria-label="Lock the scalper" title="Lock: Buy / Sell stop working until you unlock again"
                    onClick={() => onUnlockedChange(false)} className={`${iconBtn} text-amber-400`}>
              <LockOpen className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
          <button type="button" data-nodrag aria-label="Minimise the scalper" onClick={() => onMinimizedChange(true)} className={iconBtn}>
            <Minus className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button type="button" data-nodrag aria-label="Close the scalper" onClick={onClose} className={iconBtn}>
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
        {subtitle && (
          <div data-testid="scalper-subtitle" className="px-2.5 pt-1.5 text-[11px] font-semibold text-zinc-300 truncate" title={subtitle}>{subtitle}</div>
        )}

        <div className="p-2.5 flex flex-col gap-2">
          {/* Position · LTP on the left, P&L on the right: one line */}
          <div className="flex items-center gap-2 min-h-7">
            <div className="min-w-0 flex flex-col">
              {realError ? (
                <span data-testid="scalper-position" className="text-xs font-semibold text-amber-400 truncate" title={realError}>Position unknown</span>
              ) : (
                <span data-testid="scalper-position"
                      className={`text-xs font-bold ${position?.side === 'LONG' ? 'text-emerald-400' : position?.side === 'SHORT' ? 'text-red-400' : position ? 'text-amber-400' : 'text-zinc-400'}`}>
                  {sideWord}{position ? ` ${lotsShort(openLots)}` : ''}
                  {position && paperAvg != null && <span className="font-normal text-zinc-400 tabular-nums"> @ {fmtPx(paperAvg)}</span>}
                </span>
              )}
              <span className="flex items-center gap-1 text-[11px] text-zinc-400">
                LTP <span data-testid="scalper-ltp" className="font-semibold tabular-nums text-zinc-200">{ltp == null ? '—' : fmtPx(ltp)}</span>
                {tickDir !== 0 && ltp != null && (tickDir > 0
                  ? <ArrowUpRight className="w-3 h-3 text-emerald-400" aria-label="up tick" />
                  : <ArrowDownRight className="w-3 h-3 text-red-400" aria-label="down tick" />)}
              </span>
            </div>
            <span data-testid="scalper-pnl" className={`ml-auto text-2xl font-bold tabular-nums leading-none ${pnlText}`}
                  title={mode === 'REAL' ? 'Broker book every 5 s, moved with every tick in between' : 'Paper ledger at the live price'}>
              {pnl == null ? '—' : inr(pnl)}
            </span>
          </div>

          {/* Lots: stepper and presets on one row, one height */}
          <div className="flex items-center gap-1">
            <div className="inline-flex items-center h-7 rounded-md border border-zinc-700 bg-zinc-950">
              <button type="button" aria-label={`Decrease ${isEquity ? 'quantity' : 'lots'}`} disabled={lots <= 1} onClick={() => pickLots(lots - 1)}
                      className={`w-6 h-full inline-flex items-center justify-center rounded-l-md text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 ${FOCUS}`}>
                <Minus className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
              <input type="text" inputMode="numeric" data-testid="scalper-lots" aria-label={isEquity ? 'Order quantity' : 'Order lots'}
                     title={unitsPerLot != null && unitsPerLot > 1 && !isEquity ? `${lots} × ${unitsPerLot} = ${(lots * unitsPerLot).toLocaleString('en-IN')} units` : undefined}
                     value={lotsDraft} onChange={e => setLotsDraft(e.target.value)} onBlur={e => commitLots(e.currentTarget.value)}
                     onKeyDown={e => {
                       if (e.key === 'Enter') { commitLots(e.currentTarget.value); rootRef.current?.focus(); }
                       if (e.key === 'Escape') { setLotsDraft(String(lots)); rootRef.current?.focus(); }
                     }}
                     className={`w-8 h-full text-center text-sm font-bold tabular-nums bg-transparent text-white ${FOCUS}`} />
              <button type="button" aria-label={`Increase ${isEquity ? 'quantity' : 'lots'}`} disabled={lots >= cap} onClick={() => pickLots(lots + 1)}
                      className={`w-6 h-full inline-flex items-center justify-center rounded-r-md text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 ${FOCUS}`}>
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
            <div className="ml-auto flex items-center gap-1" role="group" aria-label="Lot presets">
              {(isEquity ? [10, 50, 100, 500] : [1, 2, 5, 10]).filter(n => n <= cap).map(n => (
                <button key={n} type="button" aria-pressed={lots === n} onClick={() => pickLots(n)}
                        className={`min-w-8 px-1.5 h-7 rounded-md text-[11px] font-semibold tabular-nums border ${lots === n ? 'border-zinc-500 bg-zinc-700 text-white' : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200'} ${FOCUS}`}>
                  {isEquity ? n : `${n}L`}
                </button>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="relative">
            <div className={`grid grid-cols-2 gap-1.5 ${locked ? 'opacity-30 pointer-events-none' : ''}`} aria-hidden={locked || undefined}>
              {(['BUY', 'SELL'] as const).map(side => (
                <button key={side} type="button" data-testid={`scalper-${side.toLowerCase()}`} disabled={!canTrade} onClick={() => void executeOrder(side)}
                        aria-keyshortcuts={side === 'BUY' ? 'B' : 'S'}
                        aria-label={sideHints ? `${side === 'BUY' ? 'Bullish' : 'Bearish'}: ${sideHints[side]} ${lotsShort(lots)} at market` : `${side === 'BUY' ? 'Buy' : 'Sell'} ${lotsShort(lots)} at market`}
                        title={sideHints ? `${side === 'BUY' ? 'Bullish' : 'Bearish'}: ${sideHints[side]} (strike picked at the click); holding the other side's leg it reduces / closes that leg` : undefined}
                        className={`h-10 rounded-md px-2.5 inline-flex items-center gap-1.5 text-oncolor shadow transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${side === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500'} ${FOCUS}`}>
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : side === 'BUY' ? <ArrowUpRight className="w-4 h-4" aria-hidden="true" /> : <ArrowDownRight className="w-4 h-4" aria-hidden="true" />}
                  {sideHints
                    ? <span className="flex flex-col items-start leading-tight min-w-0">
                        <span className="text-sm font-bold">{side === 'BUY' ? 'Bull' : 'Bear'} <span className="text-xs font-semibold tabular-nums">{lotsShort(lots)}</span></span>
                        <span className="text-[10px] font-semibold truncate">{sideHints[side]}</span>
                      </span>
                    : <>
                        <span className="text-sm font-bold">{side === 'BUY' ? 'Buy' : 'Sell'}</span>
                        <span className="text-xs font-semibold tabular-nums">{lotsShort(lots)}</span>
                      </>}
                  <kbd className="ml-auto text-[10px] font-semibold px-1 rounded border border-oncolor/40">{side === 'BUY' ? 'B' : 'S'}</kbd>
                </button>
              ))}
              {!flat && (
                <>
                  <button type="button" data-testid="scalper-reverse" disabled={!canFlip} onClick={() => void executeReverse()} aria-keyshortcuts="R"
                          title={`Close the ${lotsShort(openLots)} position, then open ${lotsShort(Math.min(cap, openLots))} the other way`}
                          className={`h-7 rounded-md border border-zinc-700 bg-zinc-800 text-xs font-semibold text-zinc-100 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5 ${FOCUS}`}>
                    <ArrowLeftRight className="w-3.5 h-3.5" aria-hidden="true" /> Reverse <kbd className="text-[10px] text-zinc-400">R</kbd>
                  </button>
                  <button type="button" data-testid="scalper-close" disabled={!canTrade} onClick={() => void executeSquareOff()} aria-keyshortcuts="X"
                          title={closeTitle ?? (mode === 'REAL' ? `Closes the whole ${BROKER_LABELS[broker]} position on this contract (every product)` : 'Closes the paper position')}
                          className={`h-7 rounded-md bg-amber-600 hover:bg-amber-500 text-xs font-bold text-oncolor disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5 ${FOCUS}`}>
                    <XCircle className="w-3.5 h-3.5" aria-hidden="true" /> Close <kbd className="text-[10px]">X</kbd>
                  </button>
                </>
              )}
            </div>
            {locked && !blocked && (
              <div className="absolute inset-0 flex items-center justify-center">
                <button type="button" data-testid="scalper-unlock" onClick={() => { onUnlockedChange(true); rootRef.current?.focus(); }}
                        className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-red-500/60 bg-zinc-900 text-xs font-bold text-red-400 hover:bg-zinc-800 shadow-xl ${FOCUS}`}>
                  <Lock className="w-3.5 h-3.5" aria-hidden="true" /> Unlock to trade real money
                </button>
              </div>
            )}
          </div>
        </div>

        {footer && (
          <div data-testid="scalper-status" className={`px-2.5 py-1.5 border-t border-zinc-800 bg-zinc-950 text-[11px] leading-snug truncate ${reason ? 'text-amber-400' : 'text-zinc-400'}`} title={footer}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
