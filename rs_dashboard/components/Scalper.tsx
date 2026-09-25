'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { scalperRoute, type Broker } from '@/hooks/useBrokerSelector';
import { contractMultiplier } from '@/lib/positionPnl';
import { partialCloseChips } from '@/lib/partialQty';
import { positionKey, positionProduct, findLivePosition } from '@/lib/positionProduct';
import { normalizeExpiry, parseTradingSymbol } from '@/lib/positionLegs';
import { cn } from '@/lib/utils';

// Visible keyboard-only focus ring for every clickable control on this page and
// on AdvancedScalper.tsx (which imports this rather than redefining it, since
// both pages share OptionPanel/PositionsTable/TabTable/FundsView already).
// `focus-visible` (not `focus`) keeps mouse clicks silent. Mirrors FocusTool.tsx's
// own FOCUS_RING, which stays file-local there since nothing else imports it.
export const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-950';

// Micro-type scale for this page's dense control/label text — the three sizes
// already in use here, named once. No text-[8px] tier exists in this file
// (unlike FocusTool's TXT_MICRO), so only three are defined.
export const TXT_LABEL   = 'text-[9px]';  // field labels, badges — default micro size
export const TXT_VALUE   = 'text-[10px]'; // secondary readouts, most of this file's micro text
export const TXT_CAPTION = 'text-[11px]'; // switch labels, nuclear-action buttons

/**
 * Turns a Target/SL pair — two numbers with no visual relationship today —
 * into one bar: rose from -SL to 0, emerald from 0 to +Target, and a marker
 * at the current total. Mirrors FocusTool.tsx's RiskRail, minus the trail
 * lock floor tick (this page's P&L Guard has no trail concept). Exported so
 * AdvancedScalper.tsx's own Guard bar can reuse it rather than redefining it.
 * The exact numbers stay as text next to the bar — on a real-money page the
 * figure matters more than the visual, so the bar is supplementary.
 */
export function RiskRail({ totalPnl, target, stop }: {
  totalPnl: number; target: number | null; stop: number | null;
}) {
  const hasTarget = target != null && target > 0;
  const hasStop = stop != null && stop > 0;
  const fmt = (v: number) => `${v >= 0 ? '+' : '−'}₹${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

  if (!hasTarget && !hasStop) {
    return <div className="h-1.5 w-24 rounded-full bg-zinc-800 shrink-0" title="Set a Target or SL to see it plotted here" />;
  }
  const lo = hasStop ? -(stop as number) : Math.min(totalPnl, 0) * 1.2 || -1;
  const hi = hasTarget ? (target as number) : Math.max(totalPnl, 0) * 1.2 || 1;
  if (!(hi > lo)) {
    return <div className="h-1.5 w-24 rounded-full bg-zinc-800 shrink-0" />;
  }
  const pct = (v: number) => ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * 100;
  const zero = pct(0);
  return (
    <div className="flex items-center gap-2 shrink-0">
      <div
        className="relative h-1.5 w-24 rounded-full bg-zinc-800 overflow-hidden"
        title={`SL ${hasStop ? fmt(-(stop as number)) : '—'} · Target ${hasTarget ? fmt(target as number) : '—'} · Total ${fmt(totalPnl)}`}
      >
        <div className="absolute inset-y-0 bg-rose-500/25" style={{ left: 0, width: `${zero}%` }} />
        <div className="absolute inset-y-0 bg-emerald-500/25" style={{ left: `${zero}%`, width: `${100 - zero}%` }} />
        <div className="absolute inset-y-0 w-px bg-zinc-600" style={{ left: `${zero}%` }} />
        <div
          className={cn('absolute -top-0.5 h-2.5 w-0.5 rounded-full', totalPnl >= 0 ? 'bg-emerald-400' : 'bg-rose-400')}
          style={{ left: `${pct(totalPnl)}%` }}
        />
      </div>
      <span className={cn(TXT_VALUE, 'font-mono text-zinc-500 whitespace-nowrap')}>{fmt(totalPnl)}</span>
    </div>
  );
}


// A MARKET close order being accepted by the broker doesn't guarantee it filled.
// Polls the live positions book a few times so callers that chain a follow-up
// action (e.g. strike shift opening the new leg) can confirm the symbol is
// actually flat before proceeding — instead of assuming success from order
// acceptance alone. Not used on the hot SL/target/manual-close paths, where
// the extra round trips would add latency scalping can't afford.
// Polls the live book until `accept(absNetQty)` holds, resolving the observed
// absolute netQty — or null on timeout. A missing row counts as flat (0).
// `ref` identifies WHICH book to watch — it must carry the same product as the
// position being closed, or the poll reads the other product's row and can
// report a leg flat while it is still fully open.
async function pollPositionQty(
  broker: Broker,
  ref: Record<string, unknown>,
  accept: (absNetQty: number) => boolean,
  attempts = 4,
  delayMs = 500,
): Promise<number | null> {
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, delayMs));
    try {
      const res = await fetch(scalperRoute(broker, 'positions'));
      const j = await res.json() as { success: boolean; data?: Record<string, unknown>[] };
      if (j.success && j.data) {
        const found = findLivePosition(j.data, ref);
        // An ambiguous book is inconclusive, not flat — retry rather than
        // reporting a close that may not have happened.
        if (found.kind === 'ambiguous') continue;
        const abs = found.kind === 'match' ? Math.abs(Number(found.row.netQty) || 0) : 0;
        if (accept(abs)) return abs;
      }
    } catch {
      // treat as inconclusive, retry
    }
  }
  return null;
}

export async function pollPositionFlat(broker: Broker, ref: Record<string, unknown>, attempts = 4, delayMs = 500): Promise<boolean> {
  return (await pollPositionQty(broker, ref, abs => abs === 0, attempts, delayMs)) !== null;
}

// Partial-close counterpart: succeeds as soon as the book shows the leg has
// shrunk by at least `minReduction` units, and resolves how much actually left
// (which can exceed the request if something else closed concurrently). null
// means the reduction was never observed — callers that chain a follow-up open
// must treat that as a failure rather than sizing off a guess.
export async function pollPositionReduced(
  broker: Broker,
  ref: Record<string, unknown>,
  prevAbs: number,
  minReduction: number,
  attempts = 4,
  delayMs = 500,
): Promise<number | null> {
  const observed = await pollPositionQty(broker, ref, abs => prevAbs - abs >= minReduction, attempts, delayMs);
  return observed === null ? null : prevAbs - observed;
}

// ─── Types ────────────────────────────────────────────────────────

export interface OptionSide {
  ltp: number; oi: number; volume: number; high?: number; low?: number; open?: number; prev_close?: number; change?: number; change_pct?: number;
  /** Prev-day OI change % and 4-way buildup label ('LB'|'SB'|'SC'|'LU'|'') from the WS bridge */
  oi_chg_pct?: number; buildup?: string;
}
export interface StrikeData  { strike: number; ce: OptionSide; pe: OptionSide }

export interface LiveQuotes {
  updated_at: string | null;
  underlying?: string;
  expiry?: string;
  spot: number;
  spot_change?: number;
  spot_change_pct?: number;
  atm: number;
  straddle_premium: number;
  strikes: Record<string, StrikeData>;
  vix?: { ltp: number; prev_close?: number; change?: number; change_pct?: number } | null;
  future?: { ltp: number; symbol?: string; expiry?: string; basis?: number } | null;
  /** Off-expiry contracts the bridge was separately asked to track (see
   *  /api/options/live's `watchExtra` action) — {expiry: {strike: {ce/pe: {ltp}}}}.
   *  Namespaced by expiry so a strike number shared with the main tracked
   *  expiry never collides with it. LTP only — no OI/buildup/prev-close. */
  extra?: Record<string, Record<string, { ce?: { ltp: number }; pe?: { ltp: number } }>>;
}

export interface BridgeStatus {
  status: 'RUNNING' | 'STOPPED' | 'STARTING' | 'ERROR';
  pid?: number;
  subscribed?: number;
}

export interface ChainOcEntry {
  ce?: { last_price?: number; previous_close?: number; previous_close_price?: number };
  pe?: { last_price?: number; previous_close?: number; previous_close_price?: number };
}

export interface Toast {
  id: string;
  type: 'success' | 'error';
  message: string;
  detail?: string;
}

export interface PnlGuardStatus {
  pnlExitStatus: 'ACTIVE' | 'INACTIVE' | string;
  profit?: number;
  loss?: number;
  productType?: string[];
  enableKillSwitch?: boolean;
}

export interface PositionGuard {
  target: string;        // take-profit price (₹)
  sl: string;            // stop-loss price (₹); also the anchor for trailing SL
  trailEnabled: boolean; // checkbox: trail SL 1:1 with profit from the configured SL level
  bestPrice: number;     // best price achieved (max LTP for long, min LTP for short); 0 = not yet set
  triggered: boolean;    // prevents double-fire while order is in flight
}

// ─── Helpers ──────────────────────────────────────────────────────

export function fmtLTP(n: number): string {
  return n > 0
    ? `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—';
}


// ─── OptionPanel ──────────────────────────────────────────────────

export interface OptionPanelProps {
  side: 'CE' | 'PE';
  label: string;
  strike: number | null;
  visibleStrikes: number[];
  atm: number;
  ltp: number;
  pct: number | null;
  /** Day high/low of the selected strike (0 or omitted hides the H/L row) */
  high?: number;
  low?: number;
  /** 4-way OI buildup label ('LB'|'SB'|'SC'|'LU'); empty/omitted hides the chip */
  buildup?: string;
  /** OI change vs prev day (%), shown alongside the buildup label */
  oiChgPct?: number;
  limitPrice: string;
  orderMode: 'MARKET' | 'LIMIT';
  onStrikeChange: (s: number) => void;
  /** Callbacks for shifting the strike up or down (auto-closing active position if any) */
  onShiftUp?: () => void;
  onShiftDown?: () => void;
  /** Strikes moved per chevron click. The −/+ stepper renders only when onShiftStepsChange is supplied. */
  shiftSteps?: number;
  onShiftStepsChange?: (n: number) => void;
  /** Fraction of the open position the shift chevrons roll. A compact ½/Full toggle renders
   *  only when this and onMoveFractionChange are both supplied; omit for the legacy full roll. */
  moveFraction?: 'HALF' | 'FULL';
  onMoveFractionChange?: (f: 'HALF' | 'FULL') => void;
  /** Greys out the ½ segment (e.g. the leg has fewer than 2 open lots) with an explanatory tooltip. */
  halfMoveDisabled?: boolean;
  halfMoveDisabledReason?: string;
  onLimitPriceChange: (p: string) => void;
  onBuy: () => void;
  onSell: () => void;
  /** Per-box lot count (defaults to shared/global lots when omitted, matching original 2-box Scalper) */
  lots?: number;
  onLotsChange?: (l: number) => void;
  /** Shows a remove ("×") control in the header when provided; used by Advanced Scalper's dynamic box list */
  onRemove?: () => void;
  canRemove?: boolean;
  /** Per-box realized+unrealized P&L, shown under the LTP tile when provided */
  pnl?: number;
  /** Turns the CE/PE badge into a toggle when provided; used by Advanced Scalper's per-box side switch */
  onSideChange?: (side: 'CE' | 'PE') => void;
  /** Disables Buy/Sell while an order for this box/side is already in flight (blocks double-fire) */
  pending?: boolean;
  /** False while the strike→securityId lookup for the current expiry hasn't loaded yet — disables
   *  Buy/Sell so an order can never silently fall back to the slow Python order path. Omit/true = ready. */
  strikesReady?: boolean;
}

export const BUILDUP_STYLES: Record<string, { text: string; cls: string }> = {
  LB: { text: 'Long Buildup',   cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
  SB: { text: 'Short Buildup',  cls: 'bg-rose-500/10 text-rose-400 border-rose-500/20' },
  SC: { text: 'Short Covering', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
  LU: { text: 'Long Unwinding', cls: 'bg-zinc-500/10 text-zinc-400 border-zinc-600' },
};

/**
 * Ignores every on* callback prop on purpose: the caller (AdvancedScalper's
 * boxes.map) hands this a freshly-created closure for every one of them on
 * every render (they close over `box.id`), which would defeat memoization
 * if compared, but they're otherwise harmless to recreate. Only the data
 * props are compared — `strike`/`ltp`/`pct`/etc are the values that
 * actually change per WS tick, and `visibleStrikes` is itself a stable
 * memoized array at the call site, so this comparator is what lets an
 * option-ticket box skip re-rendering on a tick that didn't touch it.
 */
function optionPanelPropsEqual(prev: OptionPanelProps, next: OptionPanelProps): boolean {
  return prev.side === next.side && prev.label === next.label && prev.strike === next.strike
    && prev.visibleStrikes === next.visibleStrikes && prev.atm === next.atm && prev.ltp === next.ltp
    && prev.pct === next.pct && prev.high === next.high && prev.low === next.low
    && prev.buildup === next.buildup && prev.oiChgPct === next.oiChgPct
    && prev.limitPrice === next.limitPrice && prev.orderMode === next.orderMode
    && prev.shiftSteps === next.shiftSteps && prev.moveFraction === next.moveFraction && prev.halfMoveDisabled === next.halfMoveDisabled
    && prev.halfMoveDisabledReason === next.halfMoveDisabledReason
    && prev.lots === next.lots && prev.canRemove === next.canRemove && prev.pnl === next.pnl
    && prev.pending === next.pending && prev.strikesReady === next.strikesReady;
}

export const OptionPanel = React.memo(function OptionPanel({
  side, label, strike, visibleStrikes, atm, ltp, pct, high, low, buildup, oiChgPct,
  limitPrice, orderMode, onStrikeChange, onShiftUp, onShiftDown, shiftSteps = 1, onShiftStepsChange, onLimitPriceChange, onBuy, onSell,
  lots, onLotsChange, onRemove, canRemove, pnl, onSideChange,
  moveFraction, onMoveFractionChange, halfMoveDisabled, halfMoveDisabledReason,
  pending = false, strikesReady = true,
}: OptionPanelProps) {
  const orderDisabled = !strike || pending || !strikesReady;
  const showStepper = lots !== undefined && !!onLotsChange;
  const showMoveToggle = !!moveFraction && !!onMoveFractionChange;
  const rollsHalf = moveFraction === 'HALF';
  const isPos = (v: number) => v >= 0;
  // The WS bridge (live_options_ws.py) is the single source of buildup labels.
  // Re-deriving them here with a second set of dead-bands made the same strike
  // show different labels in different panels, and an empty label from the bridge
  // means "not classifiable" (missing prev-day baseline), not "compute it yourself".
  const buildupStyle = buildup ? BUILDUP_STYLES[buildup] : undefined;

  // The "← ATM" hint only fits when the panel itself has room for it — a fixed
  // select width would either clip the hint on a narrow panel or sit mostly
  // empty on a wide one. Track the panel's actual rendered width and switch
  // between a compact (number only) and full (number + hint) layout.
  const rootRef = useRef<HTMLDivElement>(null);
  // Default to compact so an unmeasured first paint can't overflow the card;
  // ResizeObserver corrects it to the real state on the next frame.
  const [compact, setCompact] = useState(true);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const COMPACT_BELOW_PX = 315;
    const ro = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setCompact(width < COMPACT_BELOW_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={rootRef} className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-4 min-w-0">
      {/* Header: badge + strike selector + shift buttons + remove */}
      <div className="flex items-center justify-between gap-2 min-w-0">
        {onSideChange ? (
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg shrink-0">
            {(['CE', 'PE'] as const).map(s => (
              <button key={s} onClick={() => onSideChange(s)}
                className={cn(
                  'px-2.5 py-1 text-xs font-bold uppercase tracking-widest rounded-md transition-all',
                  side === s
                    ? (s === 'CE'
                        ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20'
                        : 'bg-rose-500/10 text-rose-400 border border-rose-500/20')
                    : 'text-zinc-500 hover:text-zinc-300 border border-transparent',
                  FOCUS_RING,
                )}>
                {s}
              </button>
            ))}
          </div>
        ) : (
          <span className={`shrink-0 text-xs font-bold uppercase tracking-widest px-2.5 py-1 rounded-lg border ${
            side === 'CE'
              ? 'bg-sky-500/10 text-sky-400 border-sky-500/20'
              : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
          }`}>{label} ({side})</span>
        )}

        <div className="flex items-center gap-0.5 justify-end shrink-0">
          {onShiftUp && (
            <button
              onClick={onShiftUp}
              disabled={orderDisabled}
              title={`Shift strike up ${shiftSteps} — rolls ${rollsHalf ? 'HALF of' : 'the entire'} the open position`}
              aria-label={`Shift ${side} strike up ${shiftSteps}`}
              className={cn(
                'shrink-0 w-6 h-6 flex items-center justify-center rounded-lg border border-emerald-500/20',
                'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-oncolor hover:border-emerald-500',
                'disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95', FOCUS_RING,
              )}
            >
              <ChevronUp size={14} strokeWidth={2.5} />
            </button>
          )}
          <select value={strike ?? ''} onChange={e => onStrikeChange(Number(e.target.value))}
            className={`shrink-0 ${compact ? 'w-[88px]' : 'w-[136px]'} bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold
                       rounded-lg px-1.5 py-1.5 focus:outline-none focus:border-emerald-500 tabular-nums transition-[width]`}>
            {!strike && <option value="">— select —</option>}
            {visibleStrikes.map(sk => (
              <option key={sk} value={sk}>
                {sk.toLocaleString('en-IN')}{sk === atm && !compact ? ' ← ATM' : ''}
              </option>
            ))}
          </select>
          {onShiftDown && (
            <button
              onClick={onShiftDown}
              disabled={orderDisabled}
              title={`Shift strike down ${shiftSteps} — rolls ${rollsHalf ? 'HALF of' : 'the entire'} the open position`}
              aria-label={`Shift ${side} strike down ${shiftSteps}`}
              className={cn(
                'shrink-0 w-6 h-6 flex items-center justify-center rounded-lg border border-rose-500/20',
                'bg-rose-500/10 text-rose-400 hover:bg-rose-500 hover:text-oncolor hover:border-rose-500',
                'disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95', FOCUS_RING,
              )}
            >
              <ChevronDown size={14} strokeWidth={2.5} />
            </button>
          )}
          {onRemove && (
            <button
              onClick={onRemove}
              disabled={!canRemove}
              title={canRemove ? 'Remove box' : 'Square off position before removing'}
              aria-label="Remove box"
              className={cn(
                'shrink-0 w-6 h-6 flex items-center justify-center rounded-lg border border-zinc-700',
                'bg-zinc-800 text-zinc-400 hover:text-rose-300 hover:border-rose-500/40',
                'disabled:opacity-30 disabled:cursor-not-allowed transition-all text-sm font-bold', FOCUS_RING,
              )}
            >×</button>
          )}
        </div>
      </div>

      {/* Per-box lot stepper + strike-move fraction toggle. The header row above
          is already tight (chevrons + strike select + remove, hence the compact
          ResizeObserver), so the toggle lives down here beside the stepper. */}
      {(showStepper || showMoveToggle) && (
        <div className="flex items-center justify-center gap-2 self-center">
          {lots !== undefined && onLotsChange && (
            <div className="flex items-center bg-zinc-900 border border-zinc-700 rounded-lg overflow-hidden">
              <button onClick={() => onLotsChange(Math.max(1, lots - 1))} title="Reduce lots by one" aria-label="Reduce lots by one"
                className={cn('px-2.5 py-1 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors font-bold text-sm', FOCUS_RING)}>−</button>
              <span className="px-2 text-xs font-mono tabular-nums text-zinc-200 min-w-[3.5rem] text-center border-x border-zinc-700">
                {lots} lot{lots !== 1 ? 's' : ''}
              </span>
              <button onClick={() => onLotsChange(lots + 1)} title="Add one lot" aria-label="Add one lot"
                className={cn('px-2.5 py-1 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors font-bold text-sm', FOCUS_RING)}>+</button>
            </div>
          )}
          {onShiftStepsChange && (
            <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-700 rounded-lg px-1.5 py-1">
              <span className={cn(TXT_LABEL, 'font-bold uppercase tracking-wider text-zinc-400')}>Steps</span>
              <button type="button" aria-label="Decrease strikes per shift" disabled={shiftSteps <= 1}
                onClick={() => onShiftStepsChange(shiftSteps - 1)}
                className={cn('px-1.5 text-zinc-400 hover:text-white font-bold text-sm disabled:opacity-30', FOCUS_RING)}>−</button>
              <span className="text-xs font-mono font-bold text-zinc-200 tabular-nums w-4 text-center">{shiftSteps}</span>
              <button type="button" aria-label="Increase strikes per shift" disabled={shiftSteps >= 10}
                onClick={() => onShiftStepsChange(shiftSteps + 1)}
                className={cn('px-1.5 text-zinc-400 hover:text-white font-bold text-sm disabled:opacity-30', FOCUS_RING)}>+</button>
            </div>
          )}
          {moveFraction && onMoveFractionChange && (
            <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-700 rounded-lg px-1.5 py-1">
              <span className={cn(TXT_LABEL, 'font-bold uppercase tracking-wider text-zinc-400')}>Move</span>
              {(['HALF', 'FULL'] as const).map(f => {
                const isHalf = f === 'HALF';
                const dis = isHalf && !!halfMoveDisabled;
                return (
                  <button
                    key={f}
                    type="button"
                    disabled={dis}
                    onClick={() => onMoveFractionChange(f)}
                    title={dis
                      ? (halfMoveDisabledReason ?? 'Needs ≥2 open lots to move half')
                      : isHalf
                        ? 'Chevrons roll HALF the open quantity (rounded down to whole lots)'
                        : 'Chevrons roll the ENTIRE open position'}
                    className={cn(
                      'px-1.5 py-0.5 rounded font-bold', TXT_LABEL, 'transition-all disabled:opacity-30 disabled:cursor-not-allowed',
                      moveFraction === f
                        ? 'bg-amber-600 border border-amber-400 text-oncolor'
                        : 'bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200',
                      FOCUS_RING,
                    )}
                  >
                    {isHalf ? '½' : 'Full'}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* LTP + % change */}
      <div className="bg-zinc-800/50 rounded-xl p-4 text-center">
        <p className={cn(TXT_VALUE, 'font-bold text-white uppercase tracking-widest mb-1')}>LTP</p>
        <div className="flex items-center justify-center gap-2">
          <p className="text-3xl font-bold font-mono tabular-nums text-white leading-none">
            {fmtLTP(ltp)}
          </p>

        </div>
        {pct !== null ? (
          <p className={`text-sm font-semibold font-mono mt-1.5 ${isPos(pct) ? 'text-emerald-400' : 'text-rose-400'}`}>
            {isPos(pct) ? '▲' : '▼'} {Math.abs(pct).toFixed(2)}%
          </p>
        ) : (
          <p className="text-xs text-zinc-300 mt-1.5">— vs prev close</p>
        )}
        {(high ?? 0) > 0 && (low ?? 0) > 0 && (
          <p className="text-xs font-mono tabular-nums mt-1.5">
            <span className="text-zinc-500 font-bold">H </span>
            <span className="text-emerald-400">{fmtLTP(high!)}</span>
            <span className="text-zinc-600 mx-1.5">·</span>
            <span className="text-zinc-500 font-bold">L </span>
            <span className="text-rose-400">{fmtLTP(low!)}</span>
          </p>
        )}
        {buildupStyle && (
          <p className="mt-2">
            <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border font-bold', TXT_CAPTION, buildupStyle.cls)}>
              {buildupStyle.text}
              {(oiChgPct ?? 0) !== 0 && (
                <span className="font-mono tabular-nums font-semibold">
                  OI {oiChgPct! > 0 ? '+' : ''}{oiChgPct!.toFixed(1)}%
                </span>
              )}
            </span>
          </p>
        )}
        {pnl !== undefined && (
          <p className={`text-xs font-bold font-mono tabular-nums mt-2 ${pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-rose-400' : 'text-zinc-500'}`}>
            P&amp;L {pnl >= 0 ? '+' : ''}₹{pnl.toFixed(0)}
          </p>
        )}
      </div>

      {/* Limit price input (only in LIMIT mode) */}
      {orderMode === 'LIMIT' && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-400 font-medium whitespace-nowrap">Limit ₹</span>
          <input
            type="number" step="0.05" min="0.05"
            value={limitPrice}
            onChange={e => onLimitPriceChange(e.target.value)}
            placeholder="0.00"
            className={cn(
              'flex-1 bg-zinc-800 border border-zinc-700 text-zinc-200 text-sm font-mono',
              'rounded-lg px-3 py-2 focus:outline-none focus:border-emerald-500 tabular-nums',
              'placeholder:text-zinc-600', FOCUS_RING,
            )}
          />
        </div>
      )}

      {/* BUY / SELL buttons */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={onBuy}
          disabled={orderDisabled}
          title={!strikesReady ? 'Loading strike IDs…' : undefined}
          className={cn(
            'py-3.5 px-4 text-sm font-bold rounded-xl transition-all active:scale-95',
            'bg-emerald-600 hover:bg-emerald-500 text-oncolor',
            'disabled:opacity-40 disabled:cursor-not-allowed',
            'shadow-lg shadow-emerald-900/20', FOCUS_RING,
          )}
        >
          {pending ? '…' : `BUY ${side}`}
        </button>
        <button
          onClick={onSell}
          disabled={orderDisabled}
          title={!strikesReady ? 'Loading strike IDs…' : undefined}
          className={cn(
            'py-3.5 px-4 text-sm font-bold rounded-xl transition-all active:scale-95',
            'bg-rose-600 hover:bg-rose-500 text-oncolor',
            'disabled:opacity-40 disabled:cursor-not-allowed',
            'shadow-lg shadow-rose-900/20', FOCUS_RING,
          )}
        >
          {pending ? '…' : `SELL ${side}`}
        </button>
      </div>
    </div>
  );
}, optionPanelPropsEqual);

// ─── Sorting helpers ────────────────────────────────────────────────

export type SortState = { key: string; dir: 'asc' | 'desc' };

export function sortRows(data: Record<string, unknown>[], sort: SortState): Record<string, unknown>[] {
  if (sort.key === 'none') return data;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...data].sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key];
    const an = Number(av), bn = Number(bv);
    if (av !== '' && bv !== '' && av != null && bv != null && !isNaN(an) && !isNaN(bn)) return (an - bn) * dir;
    return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
  });
}

export function SortableTH({ children, sortKey, currentSort, onSort, align = 'left', className = '' }: {
  children: React.ReactNode;
  sortKey: string;
  currentSort: SortState;
  onSort: (key: string) => void;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  const active = currentSort.key === sortKey;
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  return (
    <th
      className={`px-3 py-2.5 text-xs font-bold text-white ${alignCls} whitespace-nowrap cursor-pointer select-none hover:bg-zinc-700 ${className}`}
      onClick={() => onSort(sortKey)}
    >
      <span className={`inline-flex items-center gap-1 ${align === 'right' ? 'flex-row-reverse' : ''}`}>
        {children}
        {active && (currentSort.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
      </span>
    </th>
  );
}

// ─── GuardStepper ─────────────────────────────────────────────────

export function GuardStepper({ value, onChange, colorCls, disabled }: {
  value: string;
  onChange: (v: string) => void;
  colorCls: string;
  disabled?: boolean;
}) {
  const step = (delta: number) => {
    const cur = parseFloat(value) || 0;
    const next = Math.max(0, cur + delta);
    onChange(next.toFixed(2));
  };
  return (
    <div className="flex flex-col">
      <button type="button" onClick={() => step(1)} tabIndex={-1} disabled={disabled} aria-label="Increase by 1"
        className={cn('leading-none', TXT_LABEL, 'px-1 rounded-t border border-b-0 border-zinc-700 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed', colorCls, FOCUS_RING)}>▲</button>
      <button type="button" onClick={() => step(-1)} tabIndex={-1} disabled={disabled} aria-label="Decrease by 1"
        className={cn('leading-none', TXT_LABEL, 'px-1 rounded-b border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed', colorCls, FOCUS_RING)}>▼</button>
    </div>
  );
}

// ─── GuardInput ───────────────────────────────────────────────────
// Number input + stepper whose typed value commits only on Enter or blur.
// Keystrokes stay in a local draft so the 1s guard monitor never acts on a
// partially typed price (e.g. "1" while typing "150"). Escape reverts the
// draft; stepper clicks still commit immediately. An amber border marks an
// uncommitted draft.

export function GuardInput({ value, onCommit, colorCls, focusBorderCls, disabled }: {
  value: string;
  onCommit: (v: string) => void;
  colorCls: string;
  focusBorderCls: string;
  disabled?: boolean;
}) {
  const [draft, setDraftState] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const setDraft = (v: string | null) => { draftRef.current = v; setDraftState(v); };

  const shown = draft ?? value;
  const dirty = draft !== null && draft !== value;

  const commit = () => {
    const d = draftRef.current;
    if (d !== null && d !== value) onCommit(d);
    setDraft(null);
  };

  return (
    <div className="flex items-center gap-1">
      <input
        type="number" step="0.05" min="0"
        value={shown}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            commit();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
        placeholder="—"
        disabled={disabled}
        title="Press Enter or click away to apply"
        className={cn(
          'w-20 bg-zinc-900 border text-xs font-mono rounded px-2 py-1 focus:outline-none tabular-nums text-right placeholder:text-zinc-600 disabled:opacity-40',
          colorCls,
          dirty ? 'border-amber-400' : cn('border-zinc-700', focusBorderCls),
          FOCUS_RING,
        )}
      />
      <GuardStepper
        value={shown}
        onChange={v => { setDraft(null); onCommit(v); }}
        colorCls={colorCls}
        disabled={disabled}
      />
    </div>
  );
}

// ─── PositionsTable ───────────────────────────────────────────────

export interface PositionsTableProps {
  data: Record<string, unknown>[];
  broker: Broker;
  /** Keyed by lib/positionProduct's `positionKey` — (symbol, product), NOT symbol
   *  alone. The same symbol can be open under two products, and they are separate
   *  positions with separate guards. */
  guards: Record<string, PositionGuard>;
  /** Same composite key as `guards`. */
  closingPositions: Set<string>;
  onGuardChange: (positionKey: string, field: 'target' | 'sl', value: string) => void;
  onTrailToggle: (positionKey: string) => void;
  onClose: (pos: Record<string, unknown>) => void;
  onAddLeg: (pos: Record<string, unknown>) => void;
  /** Per-row lot size for the partial square-off chips. Return null when it can't be
   *  resolved for that row (e.g. a leg from a different underlying than the terminal has
   *  loaded) — the chips then hide and only the full Close button is offered.
   *  Rows themselves carry no lot size: no broker's position shape reports one. */
  lotSizeFor?: (row: Record<string, unknown>) => number | null;
  /** Partial square-off. `units` is ABSOLUTE quantity, already rounded to whole lots. */
  onClosePartial?: (pos: Record<string, unknown>, units: number, pct: number) => void;
  sort: SortState;
  onSort: (key: string) => void;
  // Set when the last positions fetch failed (network/API error) rather than
  // genuinely returning zero positions — lets the empty state say so instead
  // of implying the account is flat.
  error?: string | null;
  /** Multi-select checkboxes for a bulk "Exit Selected" action. Optional —
   *  omitted entirely (as in the basic Scalper terminal) hides the checkbox
   *  column rather than rendering it disabled. Keyed by the same `positionKey`
   *  as `guards`/`closingPositions`. */
  selected?: Set<string>;
  onToggleSelect?: (positionKey: string) => void;
  onToggleSelectAll?: () => void;
}

/** Quick Target / SL chips in the positions table. Percent-only by design —
 *  a mix of % and point chips read ambiguously on options priced ₹5–₹400. */
const GUARD_PRESET_PCTS = [10, 15, 20, 25, 30];

/**
 * Best-effort expiry for one position row. Dhan's raw `/positions` payload
 * passes through with its native `drvExpiryDate` intact (see
 * lib/positionLegs.ts's resolveContract, which prefers the same field).
 *
 * The trading-symbol fallback is Kotak-only, deliberately: its compact form
 * always carries an explicit day (`CRUDEOILM17AUG264150CE`), which is what
 * `parseTradingSymbol`'s regex assumes. Zerodha's monthly-expiry symbols have
 * no day at all (`NIFTY26JUL23900PE` — YY+MON+STRIKE), so the same regex
 * misreads its year digits as a day and its leading strike digits as a year,
 * fabricating a wrong past-dated expiry (e.g. "2023-07-26", strike 900)
 * instead of the correct "no day info" null. Gate the fallback on broker
 * rather than trying to make the shared regex disambiguate an inherently
 * ambiguous digit run.
 */
export function resolveRowExpiry(row: Record<string, unknown>, tradingSymbol: string, broker: Broker): string | null {
  const native = normalizeExpiry(row.drvExpiryDate);
  if (native) return native;
  return broker === 'kotak' ? (parseTradingSymbol(tradingSymbol)?.expiry ?? null) : null;
}

interface PositionRowProps {
  row: Record<string, unknown>;
  rowKey: string;
  broker: Broker;
  guard?: PositionGuard;
  isClosing: boolean;
  onGuardChange: (positionKey: string, field: 'target' | 'sl', value: string) => void;
  onTrailToggle: (positionKey: string) => void;
  onClose: (pos: Record<string, unknown>) => void;
  onAddLeg: (pos: Record<string, unknown>) => void;
  lotSizeFor?: (row: Record<string, unknown>) => number | null;
  onClosePartial?: (pos: Record<string, unknown>, units: number, pct: number) => void;
  selected?: boolean;
  onToggleSelect?: (positionKey: string) => void;
}

/**
 * Ignores the on* callback props on purpose: PositionsTable hands this a
 * freshly-created closure for each of them on every render (they close over
 * `row`/`rowKey`), which would defeat memoization if compared, but they're
 * otherwise harmless to recreate. `row` and `guard` are what actually vary
 * per tick, and both come from AdvancedScalper's own value-diffed
 * `enrichedPositions`/`posGuards`, which keep the same object reference
 * across ticks that don't change this row's numbers — that's what makes
 * this comparator useful rather than a no-op.
 */
function positionRowPropsEqual(prev: PositionRowProps, next: PositionRowProps): boolean {
  return prev.row === next.row && prev.guard === next.guard && prev.isClosing === next.isClosing
    && prev.broker === next.broker && prev.selected === next.selected;
}

const PositionRow = React.memo(function PositionRow({
  row, rowKey, broker, guard, isClosing, onGuardChange, onTrailToggle, onClose, onAddLeg, lotSizeFor, onClosePartial,
  selected, onToggleSelect,
}: PositionRowProps) {
  const sym = String(row.tradingSymbol ?? '');
  const netQty = Number(row.netQty);
  const ltp = Number(row.lastTradedPrice);
  const isLong = netQty > 0;
  const realPnl = Number(row.realizedProfit);
  const unrealPnl = Number(row.unrealizedProfit);
  const buyAvg = Number(row.buyAvg);
  const sellAvg = Number(row.sellAvg);

  // Compute current effective trailing SL price to show below the checkbox
  const targetNum = parseFloat(guard?.target ?? '');
  const slNum = parseFloat(guard?.sl ?? '');
  const entryPrice = isLong ? buyAvg : sellAvg;
  const initialRisk = (entryPrice > 0 && !isNaN(slNum) && slNum > 0) ? Math.abs(slNum - entryPrice) : 0;
  const trailBest = guard?.bestPrice ?? 0;
  const effectiveTrailSL = (netQty !== 0 && guard?.trailEnabled && trailBest > 0 && initialRisk > 0)
    ? (isLong ? trailBest - initialRisk : trailBest + initialRisk)
    : null;

  const mult = contractMultiplier(row);
  // A flat row (netQty 0) is a closed-out leg the broker still reports for
  // the day. There is nothing left to protect, so every guard control is
  // inert — the monitoring loop skips netQty === 0 rows anyway.
  const isFlat = netQty === 0;
  const guardsDisabled = isClosing || isFlat;
  const hasGuard = !isFlat && guard && (guard.target || guard.sl || guard.trailEnabled);
  // Rupee magnitude of the Target/SL price levels, for the RiskRail —
  // same diff*qty*mult math the Target/SL subtexts below compute inline,
  // pulled up so the rail can share it without duplicating the formula.
  const targetRupeeMag = (!isFlat && !isNaN(targetNum) && targetNum > 0 && entryPrice > 0 && mult > 0)
    ? Math.abs((isLong ? targetNum - entryPrice : entryPrice - targetNum) * Math.abs(netQty) * mult) : null;
  const slRupeeMag = (!isFlat && !isNaN(slNum) && slNum > 0 && entryPrice > 0 && mult > 0)
    ? Math.abs((isLong ? entryPrice - slNum : slNum - entryPrice) * Math.abs(netQty) * mult) : null;

  return (
    <tr className={`hover:bg-zinc-800/40 transition-colors ${isClosing ? 'opacity-40' : ''} ${guard?.triggered ? 'bg-zinc-800/20' : ''}`}>
      {onToggleSelect && (
        <td className="px-2 py-2 text-center">
          <input
            type="checkbox"
            checked={selected ?? false}
            onChange={() => onToggleSelect(rowKey)}
            disabled={netQty === 0}
            title={netQty === 0 ? 'Position is flat' : `Select ${sym} for bulk exit`}
            className="w-4 h-4 accent-rose-500 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          />
        </td>
      )}
      <td className="px-3 py-2 whitespace-nowrap font-mono text-zinc-300">
        <div className="flex items-center gap-1.5">
          {hasGuard && !guard.triggered && (
            <span className="w-1.5 h-1.5 rounded-full bg-violet-400 flex-shrink-0" title="Guard active" />
          )}
          {sym}
        </div>
      </td>
      <td className="px-3 py-2 whitespace-nowrap font-mono text-zinc-400">{resolveRowExpiry(row, sym, broker) ?? '—'}</td>
      <td className="px-3 py-2 whitespace-nowrap font-mono text-right tabular-nums text-zinc-300">{netQty}</td>
      <td className="px-3 py-2 whitespace-nowrap font-mono text-right tabular-nums text-zinc-300">{buyAvg > 0 ? buyAvg.toFixed(2) : '—'}</td>
      <td className="px-3 py-2 whitespace-nowrap font-mono text-right tabular-nums text-zinc-300">{sellAvg > 0 ? sellAvg.toFixed(2) : '—'}</td>
      <td className="px-3 py-2 whitespace-nowrap font-mono text-right tabular-nums text-zinc-300">{ltp > 0 ? ltp.toFixed(2) : '—'}</td>
      <td className={`px-3 py-2 whitespace-nowrap font-mono text-right tabular-nums ${!isNaN(realPnl) && realPnl !== 0 ? (realPnl > 0 ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-400'}`}>
        {isNaN(realPnl) ? '—' : realPnl.toFixed(0)}
      </td>
      <td className={`px-3 py-2 whitespace-nowrap font-mono text-right tabular-nums ${!isNaN(unrealPnl) && unrealPnl !== 0 ? (unrealPnl > 0 ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-400'}`}>
        {isNaN(unrealPnl) ? '—' : unrealPnl.toFixed(0)}
      </td>
      <td className="px-3 py-2 whitespace-nowrap font-mono text-zinc-300">{String(row.productType ?? '—')}</td>

      {/* Target input & quick presets */}
      <td className="px-2 py-1.5">
        <div className="flex flex-col items-center gap-1">
          <GuardInput
            value={guard?.target ?? ''}
            onCommit={v => onGuardChange(rowKey, 'target', v)}
            colorCls="text-emerald-300"
            focusBorderCls="focus:border-emerald-500"
            disabled={guardsDisabled}
          />
          {/* Preset Chips */}
          <div className={cn('flex items-center gap-0.5', TXT_LABEL, 'font-mono')}>
            {GUARD_PRESET_PCTS.map(pct => (
              <button
                key={pct}
                disabled={guardsDisabled || entryPrice <= 0}
                onClick={() => {
                  if (entryPrice <= 0) return;
                  // Target is always a move IN FAVOUR of the position:
                  // longs profit as price rises, shorts as it falls.
                  const calculated = isLong
                    ? entryPrice * (1 + pct / 100)
                    : entryPrice * (1 - pct / 100);
                  if (calculated > 0) onGuardChange(rowKey, 'target', calculated.toFixed(2));
                }}
                className={cn('px-1 py-0.5 rounded bg-emerald-950/80 border border-emerald-800/60 text-emerald-400 hover:bg-emerald-800 hover:text-oncolor transition-all disabled:opacity-30', FOCUS_RING)}
                title={`Set Target ${pct}% in profit from entry ₹${entryPrice.toFixed(2)}`}
              >
                +{pct}%
              </button>
            ))}
          </div>
          {/* Target P&L Subtext */}
          {!isFlat && !isNaN(targetNum) && targetNum > 0 && entryPrice > 0 && mult > 0 && (() => {
            const diff = isLong ? targetNum - entryPrice : entryPrice - targetNum;
            const pctVal = (diff / entryPrice) * 100;
            const rupeeVal = diff * Math.abs(netQty) * mult;
            const isProfit = diff >= 0;
            return (
              <span className={cn(TXT_LABEL, 'font-mono tabular-nums whitespace-nowrap', isProfit ? 'text-emerald-400/90' : 'text-rose-400/90')}>
                {isProfit ? '+' : ''}{pctVal.toFixed(1)}% ({isProfit ? '+' : ''}₹{rupeeVal.toFixed(0)})
              </span>
            );
          })()}
        </div>
      </td>

      {/* SL input & quick presets */}
      <td className="px-2 py-1.5">
        <div className="flex flex-col items-center gap-1">
          <GuardInput
            value={guard?.sl ?? ''}
            onCommit={v => onGuardChange(rowKey, 'sl', v)}
            colorCls="text-rose-300"
            focusBorderCls="focus:border-rose-500"
            disabled={guardsDisabled}
          />
          {/* Preset Chips */}
          <div className={cn('flex items-center gap-0.5', TXT_LABEL, 'font-mono')}>
            {GUARD_PRESET_PCTS.map(pct => (
              <button
                key={pct}
                disabled={guardsDisabled || entryPrice <= 0}
                onClick={() => {
                  if (entryPrice <= 0) return;
                  // SL is always a move AGAINST the position.
                  const calculated = isLong
                    ? entryPrice * (1 - pct / 100)
                    : entryPrice * (1 + pct / 100);
                  if (calculated > 0) onGuardChange(rowKey, 'sl', calculated.toFixed(2));
                }}
                className={cn('px-1 py-0.5 rounded bg-rose-950/80 border border-rose-800/60 text-rose-400 hover:bg-rose-800 hover:text-oncolor transition-all disabled:opacity-30', FOCUS_RING)}
                title={`Set SL ${pct}% in loss from entry ₹${entryPrice.toFixed(2)}`}
              >
                -{pct}%
              </button>
            ))}
          </div>
          {/* SL Loss Subtext */}
          {!isFlat && !isNaN(slNum) && slNum > 0 && entryPrice > 0 && mult > 0 && (() => {
            const diff = isLong ? entryPrice - slNum : slNum - entryPrice;
            const pctVal = (diff / entryPrice) * 100;
            const rupeeVal = diff * Math.abs(netQty) * mult;
            const isLoss = diff >= 0;
            return (
              <span className={cn(TXT_LABEL, 'font-mono tabular-nums whitespace-nowrap', isLoss ? 'text-rose-400/90' : 'text-emerald-400/90')}>
                {isLoss ? '-' : '+'}{pctVal.toFixed(1)}% ({isLoss ? '-' : '+'}₹{Math.abs(rupeeVal).toFixed(0)})
              </span>
            );
          })()}
          {/* Risk rail — where this leg's unrealized P&L sits between its
              SL and Target rupee levels, at a glance rather than reading
              three disconnected numbers across two columns. */}
          {(targetRupeeMag != null || slRupeeMag != null) && (
            <RiskRail totalPnl={unrealPnl} target={targetRupeeMag} stop={slRupeeMag} />
          )}
        </div>
      </td>

      {/* Trail SL checkbox + effective SL price when active */}
      <td className="px-2 py-1.5 text-center">
        <div className="flex flex-col items-center gap-0.5">
          <input
            type="checkbox"
            checked={guard?.trailEnabled ?? false}
            onChange={() => onTrailToggle(rowKey)}
            disabled={guardsDisabled || !guard?.sl}
            title={isFlat ? 'Position is flat' : guard?.sl ? 'Trail SL 1:1 with profit' : 'Set SL first'}
            className="w-4 h-4 accent-amber-400 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          />
          {effectiveTrailSL !== null && (
            <span className={cn(TXT_VALUE, 'font-mono text-amber-400 tabular-nums')}>
              @{effectiveTrailSL.toFixed(1)}
            </span>
          )}
        </div>
      </td>

      {/* Manual close / add-leg buttons + partial square-off chips */}
      <td className="px-2 py-1.5 text-center">
        <div className="flex flex-col items-center gap-1">
          <div className="flex items-center justify-center gap-1.5">
            <button
              onClick={() => onAddLeg(row)}
              disabled={isClosing || netQty === 0}
              title={`Load ${sym}'s strike into the order panel to add more or hedge`}
              className={cn('px-2.5 py-1', TXT_CAPTION, 'font-bold rounded border transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-emerald-900/40 border-emerald-500/30 text-emerald-400 hover:bg-emerald-800/60 hover:text-emerald-200 active:scale-95', FOCUS_RING)}
            >
              Add
            </button>
            <button
              onClick={() => onClose(row)}
              disabled={isClosing || netQty === 0}
              title={`Market close ${sym} — 100% (${Math.abs(netQty)} qty)`}
              className={cn('px-2.5 py-1', TXT_CAPTION, 'font-bold rounded border transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-rose-900/40 border-rose-500/30 text-rose-400 hover:bg-rose-800/60 hover:text-rose-200 active:scale-95', FOCUS_RING)}
            >
              {isClosing ? '…' : 'Close'}
            </button>
          </div>
          {/* Partial square-off. 100% is the Close button above, so only the
              fractions appear here. A chip is disabled when it maps to under a
              lot, or to the same lot count as a smaller one — see lib/partialQty. */}
          {onClosePartial && lotSizeFor && netQty !== 0 && (() => {
            const ls = lotSizeFor(row);
            if (!ls || ls <= 0) return null;
            return (
              <div className={cn('flex items-center gap-0.5', TXT_LABEL, 'font-mono')}>
                {partialCloseChips(netQty, ls, [25, 50, 75]).map(c => (
                  <button
                    key={c.pct}
                    type="button"
                    disabled={isClosing || !c.enabled}
                    onClick={() => onClosePartial(row, c.units, c.pct)}
                    title={c.title}
                    className={cn('px-1 py-0.5 rounded bg-rose-950/80 border border-rose-800/60 text-rose-400 hover:bg-rose-800 hover:text-oncolor transition-all disabled:opacity-30 disabled:cursor-not-allowed', FOCUS_RING)}
                  >
                    {c.pct}%
                  </button>
                ))}
              </div>
            );
          })()}
        </div>
      </td>
    </tr>
  );
}, positionRowPropsEqual);

export const PositionsTable = React.memo(function PositionsTable({ data, broker, guards, closingPositions, onGuardChange, onTrailToggle, onClose, onAddLeg, lotSizeFor, onClosePartial, sort, onSort, error, selected, onToggleSelect, onToggleSelectAll }: PositionsTableProps) {
  // The broker positions API does not guarantee a stable row order between
  // polls, so with no explicit column sort applied ('none') the rows would
  // otherwise reshuffle on every 5s refresh. Pin each row to the order it was
  // first seen in, so the table only reorders when the user picks a sort.
  const rowOrderRef = useRef<Map<string, number>>(new Map());
  const nextOrderRef = useRef(0);
  const sortedData = useMemo(() => {
    if (sort.key !== 'none') return sortRows(data, sort);
    const order = rowOrderRef.current;
    for (const row of data) {
      const k = positionKey(row);
      if (!order.has(k)) order.set(k, nextOrderRef.current++);
    }
    return [...data].sort((a, b) => (order.get(positionKey(a))! - order.get(positionKey(b))!));
  }, [data, sort]);

  // Only rows with an open (non-flat) position are selectable, matching the
  // per-row checkbox's own disabled condition. Computed unconditionally
  // (ahead of the empty-state early return below) since it's hook-backed —
  // conditionally skipping it would violate the Rules of Hooks.
  const selectableKeys = useMemo(
    () => sortedData.filter(r => Number(r.netQty) !== 0).map(r => positionKey(r)),
    [sortedData]);
  const headerCbRef = useRef<HTMLInputElement>(null);
  const allSelected = selectableKeys.length > 0 && selectableKeys.every(k => selected?.has(k));
  const someSelected = !allSelected && selectableKeys.some(k => selected?.has(k));
  useEffect(() => {
    if (headerCbRef.current) headerCbRef.current.indeterminate = someSelected;
  }, [someSelected]);

  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-32 text-sm" title={error ?? undefined}>
        {error ? (
          <span className="text-amber-500">Failed to load positions — retrying… ({error})</span>
        ) : (
          <span className="text-zinc-600">No positions data</span>
        )}
      </div>
    );
  }

  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-zinc-800 z-10">
        <tr>
          {onToggleSelectAll && (
            <th className="px-2 py-2.5 text-center">
              <input
                ref={headerCbRef}
                type="checkbox"
                checked={allSelected}
                onChange={onToggleSelectAll}
                disabled={selectableKeys.length === 0}
                title="Select all open positions"
                className="w-4 h-4 accent-rose-500 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              />
            </th>
          )}
          <SortableTH sortKey="tradingSymbol" currentSort={sort} onSort={onSort}>Symbol</SortableTH>
          <SortableTH sortKey="drvExpiryDate" currentSort={sort} onSort={onSort}>Expiry</SortableTH>
          <SortableTH sortKey="netQty" currentSort={sort} onSort={onSort} align="right">Qty</SortableTH>
          <SortableTH sortKey="buyAvg" currentSort={sort} onSort={onSort} align="right">Buy Avg</SortableTH>
          <SortableTH sortKey="sellAvg" currentSort={sort} onSort={onSort} align="right">Sell Avg</SortableTH>
          <SortableTH sortKey="lastTradedPrice" currentSort={sort} onSort={onSort} align="right">LTP</SortableTH>
          <SortableTH sortKey="realizedProfit" currentSort={sort} onSort={onSort} align="right">Real P&L</SortableTH>
          <SortableTH sortKey="unrealizedProfit" currentSort={sort} onSort={onSort} align="right">Unreal P&L</SortableTH>
          <SortableTH sortKey="productType" currentSort={sort} onSort={onSort}>Product</SortableTH>
          <th className="px-3 py-2.5 text-xs font-bold text-emerald-400 text-center whitespace-nowrap">Target ₹</th>
          <th className="px-3 py-2.5 text-xs font-bold text-rose-400 text-center whitespace-nowrap">SL ₹</th>
          <th className="px-3 py-2.5 text-xs font-bold text-amber-400 text-center whitespace-nowrap">Trail SL</th>
          <th className="px-3 py-2.5 text-xs font-bold text-white text-center whitespace-nowrap">Actions</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-800/50">
        {sortedData.map(row => {
          // Guards and the closing spinner are keyed per (symbol, product): two
          // rows can share a symbol, and they are separate positions.
          const rowKey = positionKey(row);
          return (
            <PositionRow
              key={rowKey}
              row={row}
              rowKey={rowKey}
              broker={broker}
              guard={guards[rowKey]}
              isClosing={closingPositions.has(rowKey)}
              onGuardChange={onGuardChange}
              onTrailToggle={onTrailToggle}
              onClose={onClose}
              onAddLeg={onAddLeg}
              lotSizeFor={lotSizeFor}
              onClosePartial={onClosePartial}
              selected={selected?.has(rowKey) ?? false}
              onToggleSelect={onToggleSelect}
            />
          );
        })}
      </tbody>
    </table>
  );
});

// ─── TabTable ─────────────────────────────────────────────────────

export interface TabTableProps {
  tab: 'positions' | 'orders' | 'trades';
  data: Record<string, unknown>[];
  sort: SortState;
  onSort: (key: string) => void;
}

export const COLUMNS: Record<string, { key: string; label: string; numeric?: boolean; highlight?: 'side' | 'pnl' }[]> = {
  positions: [
    { key: 'tradingSymbol',    label: 'Symbol' },
    { key: 'netQty',           label: 'Qty',          numeric: true },
    { key: 'buyAvg',           label: 'Buy Avg',      numeric: true },
    { key: 'sellAvg',          label: 'Sell Avg',     numeric: true },
    { key: 'lastTradedPrice',  label: 'LTP',          numeric: true },
    { key: 'realizedProfit',   label: 'Realized P&L', numeric: true, highlight: 'pnl' },
    { key: 'unrealizedProfit', label: 'Unreal. P&L',  numeric: true, highlight: 'pnl' },
    { key: 'productType',      label: 'Product' },
  ],
  orders: [
    { key: 'tradingSymbol',   label: 'Symbol' },
    { key: 'orderStatus',     label: 'Status' },
    { key: 'transactionType', label: 'Side',   highlight: 'side' },
    { key: 'quantity',        label: 'Qty',    numeric: true },
    { key: 'price',           label: 'Price',  numeric: true },
    { key: 'orderType',       label: 'Type' },
    { key: 'createTime',      label: 'Time' },
  ],
  trades: [
    { key: 'tradingSymbol',   label: 'Symbol' },
    { key: 'transactionType', label: 'Side',   highlight: 'side' },
    { key: 'tradedQuantity',  label: 'Qty',    numeric: true },
    { key: 'tradedPrice',     label: 'Price',  numeric: true },
    { key: 'createTime',      label: 'Time' },
  ],
};

export function TabTable({ tab, data, sort, onSort }: TabTableProps) {
  const cols = COLUMNS[tab];
  const sortedData = useMemo(() => sortRows(data, sort), [data, sort]);

  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-32 text-zinc-600 text-sm">
        No {tab} data
      </div>
    );
  }
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-zinc-800 z-10">
        <tr>
          {cols.map(c => (
            <SortableTH key={c.key} sortKey={c.key} currentSort={sort} onSort={onSort} align={c.numeric ? 'right' : 'left'}>
              {c.label}
            </SortableTH>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-800/50">
        {sortedData.map((row, i) => (
          <tr key={i} className="hover:bg-zinc-800/40 transition-colors">
            {cols.map(c => {
              const val = row[c.key] ?? (c.key === 'createTime' ? (row.updateTime || row.exchangeTime || row.ordEntTm || row.ordDtTm || row.order_timestamp) : null);
              const str = (val == null || String(val).trim() === '') ? '—' : String(val);
              let cls = `px-3 py-2 whitespace-nowrap font-mono ${c.numeric ? 'text-right tabular-nums' : ''}`;
              if (c.highlight === 'side') {
                cls += str === 'BUY' ? ' text-emerald-400 font-bold' : str === 'SELL' ? ' text-rose-400 font-bold' : ' text-zinc-300';
              } else if (c.highlight === 'pnl') {
                const n = Number(val);
                cls += !isNaN(n) && n !== 0 ? (n > 0 ? ' text-emerald-400' : ' text-rose-400') : ' text-zinc-400';
              } else {
                cls += ' text-zinc-300';
              }
              return <td key={c.key} className={cls}>{str}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── FundsView ────────────────────────────────────────────────────

export interface FundsViewProps {
  data: Record<string, any> | null;
  realizedPnl: number;
}

export function formatFundsValue(val: number): string {
  if (val === 0) return '0';
  if (Number.isInteger(val)) {
    return val.toLocaleString('en-IN');
  }
  return val.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

export function FundsView({ data, realizedPnl }: FundsViewProps) {
  if (!data) {
    return (
      <div className="flex items-center justify-center h-32 text-zinc-600 text-sm">
        No funds data available
      </div>
    );
  }

  const available = Number(data.availabelBalance) || 0;
  const used = Number(data.utilizedAmount) || 0;
  const total = available + used;

  // Collateral-aware brokers (Kotak) report how much of the balance is pledged
  // holdings rather than money. Showing only the headline invites sizing a
  // trade against Rs 9L that cannot pay a single rupee of option premium, so
  // the split is surfaced whenever the broker gives it.
  const collateral = Number(data.collateralAmount);
  const cash = Number(data.cashBalance);
  const hasCollateralSplit = Number.isFinite(collateral) && Number.isFinite(cash) && collateral > 0;

  const rows = [
    { label: 'Total Balance', value: total },
    { label: 'Used Margin', value: used },
    { label: 'Realized P&L', value: realizedPnl },
    { label: 'Available', value: available },
    ...(hasCollateralSplit
      ? [{ label: 'Collateral', value: collateral }, { label: 'Cash', value: cash }]
      : []),
  ];

  const renderSection = (title: string) => (
    <div className="flex-1 min-w-[280px] bg-zinc-900/20 border border-zinc-800/60 rounded-xl p-5">
      <h3 className="text-zinc-200 text-sm font-semibold mb-4 tracking-wide border-b border-zinc-800/80 pb-2">{title}</h3>
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="border-b border-zinc-800/40 text-zinc-500 font-semibold text-left">
            <th className="pb-2 font-medium">Type</th>
            <th className="pb-2 text-right font-medium">Balance</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/20 text-zinc-300">
          {rows.map((row) => (
            <tr key={row.label} className="hover:bg-zinc-800/10 transition-colors">
              <td className="py-3 text-left text-zinc-400">{row.label}</td>
              <td className={`py-3 text-right font-semibold ${
                row.label === 'Realized P&L' && row.value !== 0
                  ? row.value > 0 ? 'text-emerald-400' : 'text-rose-400'
                  : row.label === 'Cash' && row.value <= 0
                    ? 'text-amber-400'
                    : 'text-zinc-100'
              }`}
              title={row.label === 'Cash' && row.value <= 0
                ? 'No cash: the balance is collateral from pledged holdings. Option writes are backed by it, but any premium debit (a BUY, including buying back a short to close) may be rejected.'
                : undefined}>
                {formatFundsValue(row.value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="flex flex-wrap gap-5 p-5">
      {renderSection('NSE - Derivatives')}
      {renderSection('NSE - Equity')}
    </div>
  );
}
