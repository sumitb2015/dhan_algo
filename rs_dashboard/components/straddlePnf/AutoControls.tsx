'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import { holdsPosition, markPnl, PYRAMID_HARD_MAX, type AutoRow } from '@/lib/pnfAutoLedger';
import type { AutoProduct } from '@/lib/pnfOrderLogic';
import { PYRAMID_EVERY_MAX, TRAIL_BOXES_MAX, TRAIL_BOXES_MIN } from '@/lib/pnfAuto';

// One chart's AUTO switch, lots and status (engine: ./usePnfAuto.ts). The switch is saved in the AUTO ledger and resumed after a reload in
// the same mode (the dashboard server runs the saved arming, lib/pnfAutoEngine.ts); in REAL mode
// arming takes a second, explicit click. Lots commit on blur / Enter (dhan-commit-on-blur) and are locked while AUTO is armed or holds a position.

const MAX_LOTS = PYRAMID_HARD_MAX;                     // the ledger's lot limit (one source for the lots box, Max and the ledger)
const inr = (n: number) => `${n > 0 ? '+' : n < 0 ? '-' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;

export type { AutoRule } from '@/lib/pnfAutoRule';
import type { AutoRule, AutoSide } from '@/lib/pnfAutoRule';

export interface AutoControlsProps {
  chart: 1 | 2;
  armed: boolean;
  /** What AUTO trades on, for the button tooltip (default: the P&F double top / bottom rule). */
  rule?: string;
  mode: 'PAPER' | 'REAL';
  disabledReason: string | null;
  lots: number;
  onLots: (n: number) => void;
  onArm: (on: boolean) => void;
  row: AutoRow | undefined;
  price: number | null;
  note: string;
  /** The open position's trailing SL level (after a pyramid add), or null. */
  trailSl?: number | null;
  halt: string | null;
  onResolve: (as: 'open' | 'flat' | 'added' | 'notAdded') => void;
  /** Renko only: add one lot per new best brick up to `max` total lots. Locked while armed. */
  pyramid?: { on: boolean; max: number; every: number; trailOn: boolean; trail: number };
  onPyramid?: (p: { on: boolean; max: number; every: number; trailOn: boolean; trail: number }) => void;
  /** Close the open position now at the live price (and switch AUTO off). */
  onExit?: () => void;
  /** Renko only: which pattern AUTO trades. Absent on P&F (one rule). Locked while armed or holding a position. */
  autoRule?: AutoRule;
  onAutoRule?: (r: AutoRule) => void;
  /** Which side AUTO may open: both, buy only or sell only. Exits are not filtered. Locked only while armed. */
  autoSide?: AutoSide;
  onAutoSide?: (s: AutoSide) => void;
  /** The page clock (ms), for spotting a stale reservation. */
  nowMs: number;
  /** A saved arming that was NOT switched back on after a reload, and why (e.g. "switch the page to REAL to resume"). */
  resumeNote?: string | null;
  /** The product new AUTO entries are sent with (MIS / NRML). Absent = MIS only (a stock). Locked while armed or holding a position. */
  product?: AutoProduct;
  onProduct?: (p: AutoProduct) => void;
  /** Today's entry cutoff and square-off for this chart, e.g. "NRML: entries stop 15:25, squared off 15:35". */
  eodText?: string | null;
}

/** A row only the user can settle: an unknown outcome, or a reservation left over by a tab that died with the order out. */
const STALE_PENDING_MS = 60_000;
export const needsResolve = (r: AutoRow, nowMs: number) =>
  r.state === 'unknownEntry' || r.state === 'unknownExit' || r.state === 'unknownAdd'
  || ((r.state === 'entering' || r.state === 'exiting' || r.state === 'adding') && nowMs - (r.pendingSince ?? r.entryT) * 1000 > STALE_PENDING_MS);

export default function AutoControls({ chart, armed, mode, disabledReason, lots, onLots, onArm, row, price, note, trailSl, halt, onResolve, onExit, nowMs, rule, autoRule, onAutoRule, autoSide, onAutoSide, resumeNote, pyramid, onPyramid, product, onProduct, eodText }: AutoControlsProps) {
  const [confirmReal, setConfirmReal] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const [draft, setDraft] = useState(String(lots));
  const focusedRef = useRef(false);
  /** Escape cancels: the blur it triggers must not commit the typed text (onBlur runs synchronously inside blur()). */
  const cancelBlurRef = useRef(false);
  const [maxDraft, setMaxDraft] = useState(String(pyramid?.max ?? 10));
  const maxFocusedRef = useRef(false);
  useEffect(() => {
    if (!maxFocusedRef.current) setMaxDraft(String(pyramid?.max ?? 10));
  }, [pyramid?.max]);
  const [everyDraft, setEveryDraft] = useState(String(pyramid?.every ?? 1));
  const everyFocusedRef = useRef(false);
  useEffect(() => {
    if (!everyFocusedRef.current) setEveryDraft(String(pyramid?.every ?? 1));
  }, [pyramid?.every]);
  const commitEvery = (raw: string) => {
    if (!pyramid || !onPyramid) return;
    const n = parseInt(raw, 10);
    const next = Number.isInteger(n) ? Math.max(1, Math.min(PYRAMID_EVERY_MAX, n)) : pyramid.every;
    setEveryDraft(String(next));
    if (next !== pyramid.every) onPyramid({ ...pyramid, every: next });
  };
  const [trailDraft, setTrailDraft] = useState(String(pyramid?.trail ?? 2));
  const trailFocusedRef = useRef(false);
  useEffect(() => {
    if (!trailFocusedRef.current) setTrailDraft(String(pyramid?.trail ?? 2));
  }, [pyramid?.trail]);
  const commitTrail = (raw: string) => {
    if (!pyramid || !onPyramid) return;
    const n = parseInt(raw, 10);
    const next = Number.isInteger(n) ? Math.max(TRAIL_BOXES_MIN, Math.min(TRAIL_BOXES_MAX, n)) : pyramid.trail;
    setTrailDraft(String(next));
    if (next !== pyramid.trail) onPyramid({ ...pyramid, trail: next });
  };
  const commitMax = (raw: string) => {
    if (!pyramid || !onPyramid) return;
    const n = parseInt(raw, 10);
    const next = Number.isInteger(n) ? Math.max(1, Math.min(MAX_LOTS, n)) : pyramid.max;
    setMaxDraft(String(next));
    if (next !== pyramid.max) onPyramid({ ...pyramid, max: next });
  };
  useEffect(() => {
    if (!focusedRef.current) setDraft(String(lots));
  }, [lots]);
  useEffect(() => {
    if (!confirmReal) return;
    const id = setTimeout(() => setConfirmReal(false), 6_000);
    return () => clearTimeout(id);
  }, [confirmReal]);

  useEffect(() => {
    if (!confirmExit) return;
    const id = setTimeout(() => setConfirmExit(false), 6_000);
    return () => clearTimeout(id);
  }, [confirmExit]);
  const canExit = !!onExit && row?.state === 'open';
  const clickExit = () => {
    if (!onExit || !row) return;
    if (row.mode === 'REAL' && !confirmExit) { setConfirmExit(true); return; }
    setConfirmExit(false);
    onExit();
  };

  const locked = armed || !!row;
  const commit = (raw: string) => {
    const n = parseInt(raw, 10);
    const next = Number.isInteger(n) ? Math.max(1, Math.min(MAX_LOTS, n)) : lots;
    setDraft(String(next));
    if (next !== lots) onLots(next);
  };
  const open = row?.state === 'open';
  // Stopping REAL AUTO while it holds a position takes a second click: the position still exits on its rule, but nothing re-enters
  // (2026-11-04: one click at 15:31 switched chart 1 off, its 15:39 reversal exited and the opposite side was never taken).
  const stopNeedsConfirm = armed && mode === 'REAL' && open;
  const toggle = () => {
    if (armed) {
      if (stopNeedsConfirm && !confirmReal) { setConfirmReal(true); return; }
      setConfirmReal(false);
      onArm(false);
      return;
    }
    if (mode === 'REAL' && !confirmReal) { setConfirmReal(true); return; }
    setConfirmReal(false);
    onArm(true);
  };

  // confirmed units' P&L: also while a pyramid add is on the wire or unresolved (the position is held all along)
  // `price` is the price of the contract the row holds: an index chart's row is marked on its OPTION's premium
  const pnl = row && holdsPosition(row) && price !== null ? markPnl(row, price) : null;
  const unresolved = row && row.state !== 'open';

  return (
    <span data-testid={`pnf-auto-${chart}`} data-armed={armed} className="flex flex-wrap items-center gap-x-1.5 gap-y-1 min-w-0 font-sans [&_button]:scroll-mt-48 [&_input]:scroll-mt-48 [&_select]:scroll-mt-48">
      <button type="button" onClick={toggle} disabled={!!disabledReason && !armed} aria-pressed={armed}
              aria-label={armed ? `Stop AUTO on chart ${chart}` : `Start AUTO on chart ${chart}`}
              title={disabledReason ?? (armed && confirmReal ? 'Click again to stop AUTO: the open position still exits on its rule, but nothing re-enters'
                : armed ? `AUTO ${mode}: ${rule ?? 'double-bottom SELL / double-top BUY, exit on the first column reversal'}` : 'Trade this chart automatically')}
              className={`inline-flex items-center gap-1 h-6 px-2 rounded border text-[11px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${armed
                ? confirmReal ? 'border-amber-500/60 bg-amber-500/20 text-amber-300' : mode === 'REAL' ? 'border-red-500/50 bg-red-500/15 text-red-300' : 'border-violet-500/50 bg-violet-500/15 text-violet-300'
                : confirmReal ? 'border-red-500/60 bg-red-500/20 text-red-300' : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white'}`}>
        <Bot className="w-3 h-3" aria-hidden="true" />
        {confirmReal ? (armed ? 'STOP AUTO? no re-entry' : 'ARM REAL AUTO?') : 'AUTO'}
        {armed && <span className={`w-1.5 h-1.5 rounded-full ${mode === 'REAL' ? 'bg-red-400' : 'bg-violet-400'} animate-pulse`} aria-hidden="true" />}
      </button>
      {autoRule && onAutoRule && (
        <select aria-label={`AUTO rule on chart ${chart}`} value={autoRule} disabled={armed} onChange={e => onAutoRule(e.target.value as AutoRule)}
                title={armed ? 'Stop AUTO to change the rule' : row ? 'Which pattern AUTO trades next: the open position keeps the exit it was opened with' : 'Which pattern AUTO trades'}
                className="h-6 rounded border border-zinc-700 bg-zinc-950 px-1 text-[11px] font-bold text-zinc-200 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60">
          <option value="supertrend">Supertrend</option>
          <option value="nbrick">N-brick</option>
          <option value="trend">N-brick (trend)</option>
          <option value="twoback">Two-back</option>
          <option value="oneback">One-back</option>
        </select>
      )}
      {autoSide && onAutoSide && (
        <select aria-label={`AUTO side on chart ${chart}`} value={autoSide} disabled={armed} onChange={e => onAutoSide(e.target.value as AutoSide)}
                title={armed ? 'Stop AUTO to change the side' : 'Which side AUTO may open. An open position always exits by its own rule, whatever you pick'}
                className="h-6 rounded border border-zinc-700 bg-zinc-950 px-1 text-[11px] font-bold text-zinc-200 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60">
          <option value="both">Buy + Sell</option>
          <option value="buy">Buy only</option>
          <option value="sell">Sell only</option>
        </select>
      )}
      {product && onProduct && (
        <span role="group" aria-label={`AUTO product on chart ${chart}`} className="inline-flex items-center rounded border border-zinc-700 bg-zinc-950"
              title={`${locked ? 'Stop AUTO (and close its position) to change the product. ' : ''}MIS squares off at 15:15 on NSE, NRML at 15:35 (MCX: 10 minutes before its close for both).${eodText ? ` Now: ${eodText}.` : ''}`}>
          {(['INTRADAY', 'MARGIN'] as const).map((p, i) => (
            <button key={p} type="button" data-testid={`pnf-auto-prod-${p === 'MARGIN' ? 'nrml' : 'mis'}-${chart}`} aria-pressed={product === p} disabled={locked}
                    aria-label={`AUTO trades ${p === 'MARGIN' ? 'NRML' : 'MIS'} on chart ${chart}`}
                    onClick={() => onProduct(p)}
                    className={`h-6 px-1.5 ${i === 0 ? 'rounded-l' : 'rounded-r'} text-[11px] font-bold disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 ${product === p ? 'bg-violet-500/20 text-violet-300' : 'text-zinc-400 hover:text-white'}`}>
              {p === 'MARGIN' ? 'NRML' : 'MIS'}
            </button>
          ))}
        </span>
      )}
      <span className="inline-flex items-center rounded border border-zinc-700 bg-zinc-950" title={locked ? 'Stop AUTO (and close its position) to change lots' : 'Lots per AUTO trade'}>
        <span className="pl-1 text-[11px] font-bold text-zinc-400" aria-hidden="true">L</span>
        <button type="button" aria-label={`Fewer AUTO lots on chart ${chart}`} disabled={locked || lots <= 1} onClick={() => onLots(lots - 1)}
                className="w-5 h-6 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60">−</button>
        <input aria-label={`AUTO lots on chart ${chart}`} value={draft} disabled={locked}
               onFocus={() => { focusedRef.current = true; }}
               onChange={e => setDraft(e.target.value)}
               onBlur={e => { focusedRef.current = false; if (cancelBlurRef.current) { cancelBlurRef.current = false; return; } commit(e.currentTarget.value); }}
               onKeyDown={e => {
                 if (e.key === 'Enter') { commit(e.currentTarget.value); e.currentTarget.blur(); }
                 if (e.key === 'Escape') { setDraft(String(lots)); cancelBlurRef.current = true; e.currentTarget.blur(); }
               }}
               className="w-7 h-6 text-center text-[11px] font-mono font-bold bg-transparent text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 rounded disabled:text-zinc-400" />
        <button type="button" aria-label={`More AUTO lots on chart ${chart}`} disabled={locked || lots >= MAX_LOTS} onClick={() => onLots(lots + 1)}
                className="w-5 h-6 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60">+</button>
      </span>
      {pyramid && onPyramid && (
        <span className="inline-flex items-center rounded border border-zinc-700 bg-zinc-950"
              title={armed ? 'Stop AUTO to change adds' : 'Add one lot every N bricks the position moves in its favour (N bricks past the last add, or past the entry brick for the first add; only on a new best brick, at most one lot per bar), up to Max total lots. The next entry starts again at the base lots.'}>
          <button type="button" data-testid={`pnf-auto-pyr-${chart}`} aria-pressed={pyramid.on} disabled={armed}
                  aria-label={`${pyramid.on ? 'Stop adding' : 'Add'} one lot every ${pyramid.every} new brick${pyramid.every > 1 ? 's' : ''} on chart ${chart}`}
                  onClick={() => onPyramid({ ...pyramid, on: !pyramid.on })}
                  className={`h-6 px-1.5 rounded-l text-[11px] font-bold disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 ${pyramid.on ? 'bg-violet-500/20 text-violet-300' : 'text-zinc-400 hover:text-white'}`}>
            {pyramid.on ? '+1L every' : pyramid.every > 1 ? `+1L every ${pyramid.every} bricks` : '+1L every brick'}
          </button>
          {pyramid.on && (
            <>
              <input aria-label={`Bricks between AUTO adds on chart ${chart}`} data-testid={`pnf-auto-pyr-every-${chart}`} value={everyDraft} disabled={armed}
                     title={`Add a lot every N bricks (1-${PYRAMID_EVERY_MAX}); 1 = every new best brick. Enter or click away to apply`}
                     inputMode="numeric"
                     onFocus={() => { everyFocusedRef.current = true; }}
                     onChange={e => setEveryDraft(e.target.value)}
                     onBlur={e => { everyFocusedRef.current = false; if (cancelBlurRef.current) { cancelBlurRef.current = false; return; } commitEvery(e.currentTarget.value); }}
                     onKeyDown={e => {
                       if (e.key === 'Enter') { commitEvery(e.currentTarget.value); e.currentTarget.blur(); }
                       if (e.key === 'Escape') { setEveryDraft(String(pyramid.every)); cancelBlurRef.current = true; e.currentTarget.blur(); }
                     }}
                     className="w-7 h-6 text-center text-[11px] font-mono font-bold bg-transparent text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 rounded disabled:text-zinc-400" />
              <span className="text-[11px] font-bold text-zinc-400" aria-hidden="true">{pyramid.every === 1 ? 'brick' : 'bricks'} ·</span>
              <span className="pl-1 text-[11px] font-bold text-zinc-400" aria-hidden="true">Max</span>
              <input aria-label={`Maximum AUTO lots with adds on chart ${chart}`} data-testid={`pnf-auto-pyr-max-${chart}`} value={maxDraft} disabled={armed}
                     onFocus={() => { maxFocusedRef.current = true; }}
                     onChange={e => setMaxDraft(e.target.value)}
                     onBlur={e => { maxFocusedRef.current = false; if (cancelBlurRef.current) { cancelBlurRef.current = false; return; } commitMax(e.currentTarget.value); }}
                     onKeyDown={e => {
                       if (e.key === 'Enter') { commitMax(e.currentTarget.value); e.currentTarget.blur(); }
                       if (e.key === 'Escape') { setMaxDraft(String(pyramid.max)); cancelBlurRef.current = true; e.currentTarget.blur(); }
                     }}
                     className="w-7 h-6 text-center text-[11px] font-mono font-bold bg-transparent text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 rounded disabled:text-zinc-400" />
              <span className="text-[11px] font-bold text-zinc-400" aria-hidden="true">·</span>
              <button type="button" data-testid={`pnf-auto-trail-${chart}`} aria-pressed={pyramid.trailOn} disabled={armed}
                      aria-label={`${pyramid.trailOn ? 'Switch off' : 'Switch on'} the trailing stop after an add on chart ${chart}`}
                      title={armed ? 'Stop AUTO to change the trailing SL' : 'Trailing SL after the first add: exit when a closed brick is N boxes back from the best brick since entry. Does not wait for the Supertrend. Runs in this tab (the server MTM guard and end-of-day exit still apply).'}
                      onClick={() => onPyramid({ ...pyramid, trailOn: !pyramid.trailOn })}
                      className={`h-6 px-1.5 ml-0.5 text-[11px] font-bold rounded disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 ${pyramid.trailOn ? 'bg-red-500/15 text-red-300' : 'text-zinc-400 hover:text-white'}`}>
                Trail SL{pyramid.trailOn ? '' : ' off'}
              </button>
              {pyramid.trailOn && (<>
                <input aria-label={`Trailing SL boxes after an add on chart ${chart}`} data-testid={`pnf-auto-trail-bx-${chart}`} value={trailDraft} disabled={armed}
                       title={`Boxes back from the best brick (${TRAIL_BOXES_MIN}-${TRAIL_BOXES_MAX}). 2 = the first opposite brick (a Renko reversal is a 2-box move). Enter or click away to apply`} inputMode="numeric"
                       onFocus={() => { trailFocusedRef.current = true; }}
                       onChange={e => setTrailDraft(e.target.value)}
                       onBlur={e => { trailFocusedRef.current = false; if (cancelBlurRef.current) { cancelBlurRef.current = false; return; } commitTrail(e.currentTarget.value); }}
                       onKeyDown={e => {
                         if (e.key === 'Enter') { commitTrail(e.currentTarget.value); e.currentTarget.blur(); }
                         if (e.key === 'Escape') { setTrailDraft(String(pyramid.trail)); cancelBlurRef.current = true; e.currentTarget.blur(); }
                       }}
                       className="w-7 h-6 text-center text-[11px] font-mono font-bold bg-transparent text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 rounded disabled:text-zinc-400" />
                <span className="pr-1 text-[11px] font-bold text-zinc-400" aria-hidden="true">bx</span>
              </>)}
            </>
          )}
        </span>
      )}
      {/* A held position (side, lots, price, P&L, trail SL) is shown whole; only a waiting note is truncated. */}
      <span data-testid={`pnf-auto-status-${chart}`} className={`font-mono text-[11px] ${open || unresolved ? 'whitespace-nowrap' : 'truncate min-w-0 max-w-[13rem]'}`} title={halt ?? note}>
        {unresolved ? (<>
          {(row.state === 'entering' || row.state === 'exiting' || row.state === 'adding') && !needsResolve(row, nowMs)
            ? <span className="text-amber-400">{row.state === 'entering' ? 'ENTERING…' : row.state === 'adding' ? `ADDING… ${row.lots}L` : 'EXITING…'}</span>
            : <span className="text-red-400 font-bold">UNRESOLVED{row.state === 'adding' || row.state === 'unknownAdd' ? ` ADD · ${row.lots}L held` : ''}</span>}
          {pnl !== null && <span className={`ml-1 font-bold ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{inr(pnl)}</span>}
        </>) : open ? (
          <span className={row.side === 'SELL' ? 'text-red-400' : 'text-emerald-400'}>
            {row.traded ? (
              // an index chart's row: the chart direction, then the option it holds and the premium it was bought / sold at
              <span data-testid={`pnf-auto-traded-${chart}`} title={`Index ${row.side === 'BUY' ? 'bullish' : 'bearish'} at ${row.entryPrice.toFixed(2)}; holds the option`}>
                {row.side === 'SELL' ? 'BEAR' : 'BULL'} · {row.traded.action} {row.lots}L {row.traded.target.strike} {row.traded.target.side} @ {row.mode === 'REAL' && !row.entryFilled ? '~' : ''}{row.traded.entryPremium.toFixed(2)}
              </span>
            ) : <>
            {row.side === 'SELL' ? 'SHORT' : 'LONG'} {row.lots}L{row.base && row.lots > row.base.lots ? <span className="text-zinc-400" title="Base lots + lots added on new best bricks"> ({row.base.lots}+{row.lots - row.base.lots})</span> : null} @ <span title={row.mode === 'REAL' && (!row.entryFilled || row.adds?.some(a => a.status === 'done' && !a.filled)) ? 'The price AUTO decided at: not yet replaced by the broker\'s fill' : undefined}>{row.mode === 'REAL' && (!row.entryFilled || row.adds?.some(a => a.status === 'done' && !a.filled)) ? '~' : ''}{row.entryPrice.toFixed(2)}</span>{row.base && row.lots > row.base.lots ? <span className="text-zinc-400"> avg</span> : null}
            </>}
            {pnl !== null && <span className={`ml-1 font-bold ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{inr(pnl)}</span>}
            {row.stop !== undefined && <span className="ml-1 text-zinc-400" title="Protective stop (one brick beyond the pullback)">SL {row.stop.toFixed(2)}</span>}
            {row.mode === 'PAPER' && <span className="ml-1 text-zinc-400">paper</span>}
            {trailSl != null && <span data-testid={`pnf-auto-trail-sl-${chart}`} className="ml-1 text-red-300" title="Trailing SL after an add: exits on a closed brick at this level">SL {trailSl.toFixed(2)}</span>}
            {row.product === 'MARGIN' && <span className="ml-1 text-zinc-400" title={eodText ?? 'Opened NRML'}>NRML</span>}
            {!armed && <span data-testid={`pnf-auto-off-${chart}`} className="ml-1 px-1 rounded bg-amber-500/15 text-amber-300 font-bold"
                             title={`AUTO is OFF on this chart${resumeNote ? ` (${resumeNote})` : ''}: this position still exits by its rule, but nothing re-enters after it. Arm AUTO to keep trading.`}>AUTO OFF · exit only</span>}
          </span>
        ) : halt ? (
          <span className="text-red-400 font-bold">HALTED</span>
        ) : armed ? (
          <span className="text-zinc-400">{note || 'waiting for a signal'}</span>
        ) : disabledReason ? <span className="text-zinc-500">{disabledReason}</span>
          : resumeNote ? <span data-testid={`pnf-auto-resume-${chart}`} className="text-amber-300">AUTO not resumed: {resumeNote}</span> : null}
      </span>
      {canExit && (
        <button type="button" data-testid={`pnf-auto-exit-${chart}`} onClick={clickExit}
                aria-label={`Exit the AUTO position on chart ${chart} now`}
                title={row?.mode === 'REAL' ? 'Close this REAL position at market now and switch AUTO off (click twice)' : 'Close this paper position at the live price and switch AUTO off'}
                className={`h-6 px-2 rounded border text-[11px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 ${confirmExit ? 'border-red-500/60 bg-red-500/20 text-red-300' : 'border-zinc-700 text-zinc-200 hover:bg-zinc-800'}`}>
          {confirmExit ? 'EXIT REAL?' : 'Exit'}
        </button>
      )}
      {row && needsResolve(row, nowMs) && (row.state === 'adding' || row.state === 'unknownAdd') ? (
        <span className="flex items-center gap-1" title="An added lot's order outcome is unclear. Check the broker's Positions / Orders first, then tell AUTO whether the extra lot is there">
          <button type="button" onClick={() => onResolve('added')} className="h-6 px-2 rounded border border-zinc-700 text-[11px] font-bold text-zinc-200 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60">Add went through</button>
          <button type="button" onClick={() => onResolve('notAdded')} className="h-6 px-2 rounded border border-zinc-700 text-[11px] font-bold text-zinc-200 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60">Add did not happen</button>
          <button type="button" onClick={() => onResolve('flat')} className="h-6 px-2 rounded border border-zinc-700 text-[11px] font-bold text-zinc-200 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60">Is flat</button>
        </span>
      ) : row && needsResolve(row, nowMs) && (
        <span className="flex items-center gap-1" title="Check the broker's Positions / Orders first, then tell AUTO what is there">
          <button type="button" onClick={() => onResolve('open')} className="h-6 px-2 rounded border border-zinc-700 text-[11px] font-bold text-zinc-200 hover:bg-zinc-800">Is open</button>
          <button type="button" onClick={() => onResolve('flat')} className="h-6 px-2 rounded border border-zinc-700 text-[11px] font-bold text-zinc-200 hover:bg-zinc-800">Is flat</button>
        </span>
      )}
    </span>
  );
}
