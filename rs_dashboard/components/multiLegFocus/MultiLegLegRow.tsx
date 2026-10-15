'use client';

import React, { useState } from 'react';
import { X, Plus, AlertTriangle, ChevronUp, ChevronDown, Unlink, LineChart, Bell, LogOut } from 'lucide-react';
import { clampShiftSteps, MAX_SHIFT_STEPS } from '@/lib/strikeShift';
import {
  legPnl, computeLegTrailingSL, legRiskView, legTrailPatch, nextLegThresholdType, formatExpiryLabel, legAvgPrice, legExitPrice, restingExitOrders, legQtyUnits, legPnlPct, legOtmPct, type MultiLegLeg, type AutoLegRule,
} from '@/lib/multiLegFocus';
import { DEFAULT_LEG_COLUMNS, type LegColumns } from '@/lib/legColumns';
import { FOCUS_RING } from '@/components/Scalper';
import type { OiBuildup } from '@/lib/oiBuildup';
import RuleNumInput from './RuleNumInput';

const SELECT_CLASS = `h-7 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded px-1.5 focus:outline-none focus:border-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed w-full ${FOCUS_RING}`;

const STATUS_STYLE: Record<MultiLegLeg['status'], string> = {
  DRAFT:   'bg-zinc-800 text-zinc-400 border-zinc-700',
  PLACING: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  OPEN:    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  CLOSING: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  CLOSED:  'bg-zinc-800 text-zinc-500 border-zinc-700',
  FAILED:  'bg-rose-500/10 text-rose-400 border-rose-500/20',
};

// Long side = green/amber family, short side = red/sky, matching the Buildup tab.
const OI_BUILDUP_STYLE: Record<OiBuildup, string> = {
  'Long Buildup':   'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  'Short Buildup':  'bg-red-500/10 text-red-400 border-red-500/30',
  'Short Covering': 'bg-sky-500/10 text-sky-400 border-sky-500/30',
  'Long Unwinding': 'bg-amber-500/10 text-amber-400 border-amber-500/30',
};

function fmtMoney(n: number): string {
  return `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

interface MultiLegLegRowProps {
  leg: MultiLegLeg;
  /** Opens this contract's own premium chart; undefined when the underlying has no chart data. */
  onOpenChart?: () => void;
  allStrikes: number[];
  ltp: number;
  /** The basket's auto SL/TP rule, so the shown stop is the one the risk loop enforces (legRiskView). */
  autoLegRule?: AutoLegRule;
  spot?: number;
  editable: boolean;
  exiting: boolean;
  margin?: number;
  multiplier?: number;
  /** This basket's main expiry; a leg on any other expiry is highlighted as a second contract. */
  frontExpiry: string;
  /** Secondary expiry a leg toggles to for a Calendar/Diagonal strategy;
   *  undefined when the underlying only has one listed expiry available. */
  farExpiry?: string;
  onChange: (patch: Partial<MultiLegLeg>) => void;
  onRemove: () => void;
  /** Opens the exit ticket (lots, market/limit). */
  onOpenExit: () => void;
  onOpenAddLots?: () => void;
  /** Roll this OPEN leg N strikes (N is the strategy card's Steps stepper). */
  onShift?: (direction: 'UP' | 'DOWN', steps?: number) => void;
  shiftSteps?: number;
  shiftBusy?: boolean;
  /** Strike is not tradable on this leg's expiry (far expiry needs a multiple of 100). */
  strikeBlocked?: boolean;
  /** An open short with no open BUY hedge of the same option type and expiry in its strategy. */
  unhedged?: boolean;
  /** Optional columns to render (must match the header in MultiLegStrategyRow). */
  columns?: LegColumns;
  /** Exit column shown (only when the strategy has a closed leg). */
  showExit?: boolean;
  /** Strategy-level multiplier (for display of base ratio). */
  strategyMultiplier?: number;
  /** Live implied volatility as a fraction (0.14 = 14%); 0 when unknown. */
  iv?: number;
  /** OI buildup for this contract; null when it cannot be classified. */
  oiBuildup?: OiBuildup | null;
  /** Selection for regrouping (checkbox). Omit to hide the control. */
  selected?: boolean;
  onSelect?: (on: boolean) => void;
  /** Tag commit. Preferred over onChange, which saves from this render's legs. */
  onTag?: (tag: string | undefined) => void;
  /** Move this trade out of its group into the Ungrouped trades table. */
  onDetach?: () => void;
}

/** Tag chip: shows the label, click to edit; commits on blur / Enter, Esc cancels. */
export function TagCell({ value, onCommit }: { value?: string; onCommit: (v: string) => void }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  // Enter/Esc unmount the input, which can still deliver a blur: settle only once per edit.
  const settled = React.useRef(false);
  const done = (save: boolean) => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    const v = draft.trim().slice(0, 24);
    if (save && v !== (value ?? '')) onCommit(v);
  };
  if (editing) {
    return (
      <input autoFocus list="mlf-tag-options" value={draft} maxLength={24} aria-label="Trade tag"
        onChange={e => setDraft(e.target.value)} onBlur={() => done(true)}
        onKeyDown={e => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); }}
        className={`h-5 w-full min-w-0 bg-zinc-900 border border-emerald-500 text-zinc-200 text-[10px] font-semibold rounded px-1 ${FOCUS_RING}`} />
    );
  }
  return (
    <button type="button" onClick={() => { settled.current = false; setDraft(value ?? ''); setEditing(true); }}
      title={value ? 'Edit tag' : 'Add a tag to this trade'}
      className={`max-w-full truncate h-5 px-1.5 rounded border text-[10px] font-semibold ${FOCUS_RING} ${value
        ? 'bg-sky-500/10 border-sky-500/30 text-sky-300 hover:bg-sky-500/20'
        : 'border-dashed border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500'}`}>
      {value || '+ tag'}
    </button>
  );
}

/** Free-typed roll distance for one leg. Commits on blur / Enter (never per keystroke, so a half-typed
 *  "1" of "15" can't be used by a click), Esc reverts, empty goes back to the strategy's Shift stepper. */
function ShiftStepsInput({ value, fallback, disabled, onCommit }: {
  value: number | null; fallback: number; disabled?: boolean; onCommit: (n: number | null) => void;
}) {
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  const commit = (raw: string) => {
    const t = raw.trim();
    if (!t) { onCommit(null); setDraft(''); return; }
    const n = Number(t);
    if (!Number.isFinite(n) || n < 1) { setDraft(value == null ? '' : String(value)); return; }
    const c = clampShiftSteps(n);
    onCommit(c); setDraft(String(c));
  };
  return (
    <input
      type="text" inputMode="numeric" value={draft} disabled={disabled}
      placeholder={String(fallback)}
      aria-label="Strikes to roll this leg"
      title={`Strikes to roll this leg (1-${MAX_SHIFT_STEPS}). Empty = the strategy's Shift value (${fallback})`}
      onChange={e => setDraft(e.target.value.replace(/[^\d]/g, ''))}
      onBlur={e => commit(e.currentTarget.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') { commit(e.currentTarget.value); e.currentTarget.blur(); }
        if (e.key === 'Escape') { setDraft(value == null ? '' : String(value)); e.currentTarget.blur(); }
      }}
      className={`h-6 w-9 bg-zinc-900 border-r border-zinc-700 text-center text-[11px] font-mono font-bold text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:bg-zinc-800 disabled:opacity-50 ${FOCUS_RING}`}
    />
  );
}

/** What hitting a leg's SL / Target does: close the leg (default) or only alert. Shown once a value is set. */
function HitActionToggle({ kind, action, onChange }: { kind: 'stop' | 'target'; action: 'EXIT' | 'ALERT' | undefined; onChange: (a: 'EXIT' | 'ALERT') => void }) {
  const alert = action === 'ALERT';
  return (
    <button
      type="button"
      onClick={() => onChange(alert ? 'EXIT' : 'ALERT')}
      aria-label={alert ? `At ${kind}: alert only. Switch to close the leg` : `At ${kind}: close the leg. Switch to alert only`}
      title={alert ? `At ${kind}: alert only (toast + sound), the leg stays open. Click to close the leg instead.` : `At ${kind}: close the leg. Click to only alert instead.`}
      className={`h-7 w-6 inline-flex items-center justify-center rounded border ${alert ? 'border-amber-500/40 bg-amber-500/10 text-amber-400' : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-100'} ${FOCUS_RING}`}
    >
      {alert ? <Bell className="w-3 h-3" aria-hidden /> : <LogOut className="w-3 h-3" aria-hidden />}
    </button>
  );
}

export default function MultiLegLegRow({
  leg, allStrikes, ltp, autoLegRule, spot, editable, exiting, margin, multiplier = 1, strategyMultiplier = 1, frontExpiry, farExpiry, onChange, onRemove, onOpenExit, onOpenAddLots, onShift, shiftSteps = 1, shiftBusy = false, strikeBlocked = false, unhedged = false, columns = DEFAULT_LEG_COLUMNS, showExit = false, iv = 0, oiBuildup = null, selected = false, onSelect, onTag, onDetach, onOpenChart,
}: MultiLegLegRowProps) {
  // This leg's own roll distance (any N up to MAX_SHIFT_STEPS); empty = follow the strategy's Shift stepper.
  const [ownSteps, setOwnSteps] = useState<number | null>(null);
  const steps = ownSteps ?? shiftSteps;
  const restingExit = restingExitOrders(leg)[0];
  const isFut = leg.option === 'FUT';
  const pnl = leg.fill ? legPnl(leg, ltp, multiplier) : 0;
  const pnlColor = pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-rose-400' : 'text-zinc-400';
  // New legs default to % of entry premium. A leg that already carries a value but no type was saved
  // as points, so it keeps meaning points; the type is written with every committed value.
  const slType = leg.slType ?? (leg.sl == null ? 'pct' : 'pts');
  const tpType = leg.tpType ?? (leg.tp == null ? 'pct' : 'pts');
  const trailingEval = computeLegTrailingSL(legRiskView(leg, autoLegRule, ltp), ltp);
  // Trail on with a priced stop: the SL box shows the live trailed stop, read-only.
  const trailLocked = !!leg.trail && trailingEval.effectiveSL != null;
  // SL / trail edits re-anchor the trail at the current LTP.
  const changeRisk = (patch: Partial<MultiLegLeg>) => onChange(legTrailPatch(leg, patch, ltp));
  const isFar = !!leg.expiry && leg.expiry !== frontExpiry;
  const canToggleExpiry = editable && !!farExpiry && farExpiry !== frontExpiry;

  const avgPrice = legAvgPrice(leg);
  const exitPrice = legExitPrice(leg);
  const qtyUnits = legQtyUnits(leg);
  const pnlPct = leg.fill ? legPnlPct(leg, ltp, multiplier) : null;
  const otmPct = leg.status === 'CLOSED' ? null : legOtmPct(leg, spot ?? 0);
  const numCell = 'px-2 py-1.5 text-right font-mono text-xs tabular-nums';
  const dash = <span className="text-zinc-600">—</span>;

  const legPrice = (leg.fill?.avgPrice && leg.fill.avgPrice > 0) ? leg.fill.avgPrice : (ltp > 0 ? ltp : (leg.price || 0));
  const legBE = leg.option === 'CE' ? leg.strike + legPrice : leg.strike - legPrice;

  return (
    <tr className={`border-b border-zinc-800/60 hover:bg-zinc-900/30 transition-colors ${selected ? 'bg-emerald-500/5' : ''}`}>
      <td className="px-1.5 py-1.5">
        <div className="flex flex-col items-start gap-1">
          {onSelect && (
            <input type="checkbox" checked={selected} onChange={e => onSelect(e.target.checked)}
              aria-label={`Select ${leg.strike} ${leg.option} to group`}
              className="h-3.5 w-3.5 accent-emerald-500 cursor-pointer" />
          )}
          <TagCell value={leg.tag} onCommit={v => (onTag ? onTag(v || undefined) : onChange({ tag: v || undefined }))} />
          {onOpenChart && !isFut && (
            <button type="button" onClick={onOpenChart}
              aria-label={`Chart ${leg.strike} ${leg.option} premium`}
              title={`Chart: this contract's own premium (${leg.strike} ${leg.option}, 1 lot)`}
              className={`h-5 px-1 inline-flex items-center gap-0.5 rounded border border-emerald-500/40 text-[10px] font-semibold text-emerald-300 hover:bg-emerald-500/10 ${FOCUS_RING}`}>
              <LineChart className="w-3 h-3" aria-hidden /> Chart
            </button>
          )}
          {onDetach && (
            <button type="button" onClick={onDetach}
              aria-label={`Remove ${leg.strike} ${leg.option} from this group`}
              title="Ungroup: move this trade to the Ungrouped trades table (no order is placed)"
              className={`h-5 px-1 inline-flex items-center gap-0.5 rounded border border-zinc-700 text-[10px] font-semibold text-zinc-400 hover:text-white hover:border-zinc-500 ${FOCUS_RING}`}>
              <Unlink className="w-3 h-3" aria-hidden /> Ungroup
            </button>
          )}
        </div>
      </td>
      <td className="px-2 py-1.5">
        <select value={leg.side} disabled={!editable} className={SELECT_CLASS}
          onChange={e => onChange({ side: e.target.value as MultiLegLeg['side'] })}>
          <option value="B">BUY</option>
          <option value="S">SELL</option>
        </select>
      </td>
      <td className="px-1.5 py-1.5">
        {isFut ? <span className="text-xs font-bold text-zinc-200">FUT</span> : (
        <select value={leg.option} disabled={!editable} className={SELECT_CLASS}
          onChange={e => onChange({ option: e.target.value as MultiLegLeg['option'] })}>
          <option value="CE">CE</option>
          <option value="PE">PE</option>
        </select>
        )}
      </td>
      <td className="px-2 py-1.5">
        {isFut ? <span className="text-xs text-zinc-500" title="Futures have no strike">—</span> : <>
        <select value={leg.strike} disabled={!editable} className={SELECT_CLASS}
          onChange={e => onChange({ strike: Number(e.target.value) })}>
          {!allStrikes.includes(leg.strike) && <option value={leg.strike}>{leg.strike}</option>}
          {allStrikes.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {unhedged && (
          <span className="mt-0.5 flex items-center gap-0.5 text-[9px] font-bold text-red-400" title="Naked short: no open BUY hedge on this side (same option type and expiry)">
            <AlertTriangle className="w-2.5 h-2.5" /> UNHEDGED
          </span>
        )}
        {strikeBlocked && (
          <span className="mt-0.5 flex items-center gap-0.5 text-[9px] font-bold text-amber-400" title="Far expiries only allow strikes in multiples of 100 — pick another strike or this leg cannot be placed">
            <AlertTriangle className="w-2.5 h-2.5" /> ×100 only
          </span>
        )}
        {legPrice > 0 && (
          <span className="block text-[10px] font-mono text-zinc-400 mt-0.5 tabular-nums" title={`Individual Leg Breakeven: ${legBE.toFixed(2)}`}>
            BE: {legBE.toFixed(1)}
            {spot && spot > 0 && (
              <span className="text-zinc-500"> ({legBE >= spot ? '+' : ''}{(((legBE - spot) / spot) * 100).toFixed(1)}%)</span>
            )}
          </span>
        )}
        </>}
      </td>
      {columns.otm && (
        <td className={`${numCell} ${otmPct != null && otmPct < 0 && leg.side === 'S' ? 'text-amber-400' : 'text-zinc-300'}`}
          title={otmPct != null && otmPct < 0 && leg.side === 'S' ? 'Short leg is in the money' : 'Distance of the strike from spot'}>
          {otmPct != null ? `${Math.abs(otmPct).toFixed(1)}% ${otmPct >= 0 ? 'OTM' : 'ITM'}` : dash}
        </td>
      )}
      {columns.iv && (
        <td className={`${numCell} text-zinc-300`} title="Live implied volatility">
          {iv > 0 && leg.status !== 'CLOSED' ? `${(iv * 100).toFixed(1)}%` : dash}
        </td>
      )}
      {columns.oi && (
        <td className="px-1 py-1.5 text-center">
          {oiBuildup ? (
            <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-bold whitespace-nowrap ${OI_BUILDUP_STYLE[oiBuildup]}`}
              title={`${oiBuildup}: OI change x this contract's price change vs the previous session`}>
              {oiBuildup}
            </span>
          ) : dash}
        </td>
      )}
      <td className="px-1.5 py-1.5 text-center">
        <input type="number" min={1} value={leg.lots} disabled={!editable}
          onChange={e => onChange({ lots: Math.max(1, Number(e.target.value) || 1) })}
          className={`h-7 w-12 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono rounded px-1 text-center focus:outline-none focus:border-emerald-500 disabled:opacity-50 ${FOCUS_RING}`} />
        {(leg.ratio != null || (strategyMultiplier != null && strategyMultiplier > 1)) && (
          <span
            className="block text-[9px] font-mono text-zinc-500 mt-0.5 tabular-nums"
            title={`Base ratio: ${Number((leg.ratio ?? 1).toFixed(2))} lot(s) · Strategy Multiplier: ${strategyMultiplier ?? 1}×`}
          >
            {Number((leg.ratio ?? 1).toFixed(2))}× ratio
          </span>
        )}
      </td>
      {columns.qty && (
        <td className={`${numCell} text-zinc-300`} title="Quantity in units (lots x lot size), as recorded for this leg">
          {qtyUnits != null ? qtyUnits.toLocaleString('en-IN') : dash}
        </td>
      )}
      <td className="px-2 py-1.5">
        <select value={leg.type} disabled={!editable} className={SELECT_CLASS}
          onChange={e => onChange({ type: e.target.value as MultiLegLeg['type'] })}>
          <option value="MARKET">MARKET</option>
          <option value="LIMIT">LIMIT</option>
        </select>
      </td>
      <td className="px-2 py-1.5 text-right font-mono text-xs text-zinc-300 tabular-nums">
        {ltp > 0 ? ltp.toFixed(2) : '—'}
      </td>
      {columns.avg && (
        <td className={`${numCell} text-zinc-300`} title="Average entry price">{avgPrice != null ? avgPrice.toFixed(2) : dash}</td>
      )}
      {showExit && (
        <td
          className={`${numCell} text-zinc-300`}
          title={leg.closedFill?.estimated
            ? 'Estimated: closed outside this tool. Dhan\'s day average for the contract, not this slice\'s own fill'
            : 'Closing fill price'}
        >
          {exitPrice != null ? exitPrice.toFixed(2) : dash}
          {exitPrice != null && leg.closedFill?.estimated && <span className="ml-1 text-[10px] text-amber-400">est.</span>}
        </td>
      )}
      {/* SL Column */}
      <td className="px-2 py-1.5">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1">
            {trailLocked ? (
              // Trail on: the box shows the live trailed stop (a price) and is read-only; untick the trail to edit the SL.
              <input
                type="text"
                readOnly
                value={trailingEval.effectiveSL!.toFixed(1)}
                aria-label={`Trailing stop ${trailingEval.effectiveSL!.toFixed(1)}. Untick the trail to edit the stop loss`}
                title={`Trailing stop (price), moves ₹1 per ₹1 of new best price. Set at ${trailingEval.initialSLPrice?.toFixed(1)}. Untick the trail to edit it.`}
                className={`w-14 h-7 bg-zinc-800 border border-amber-500/40 text-amber-400 font-semibold text-xs font-mono rounded px-1.5 cursor-not-allowed focus:outline-none ${FOCUS_RING}`}
              />
            ) : (
              <RuleNumInput
                value={leg.sl}
                onCommit={val => changeRisk({ sl: val, slType: slType })}
                placeholder={slType === 'price' ? 'Price' : slType === 'pct' ? '%' : 'Pts'}
                className="w-14 h-7 text-rose-300 placeholder-rose-900/40"
                title="Stop Loss (points, % of entry premium, or price)"
              />
            )}
            <button
              type="button"
              disabled={trailLocked}
              onClick={() => changeRisk({ slType: nextLegThresholdType(slType) })}
              className="h-7 px-1 text-[10px] font-mono font-bold rounded border border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-zinc-400"
              title={trailLocked ? 'Trailing stop shown as a price. Untick the trail to change the unit' : 'Cycle Points → % of entry → Price'}
            >
              {trailLocked ? '₹' : slType === 'price' ? '₹' : slType === 'pct' ? '%' : 'pts'}
            </button>
            {leg.sl != null && <HitActionToggle kind="stop" action={leg.slAction} onChange={a => onChange({ slAction: a })} />}
          </div>
          {trailingEval.effectiveSL != null && (
            <span className={`text-[10px] font-mono ${leg.trail ? 'text-amber-400 font-semibold' : 'text-zinc-500'}`}>
              {trailLocked
                ? `TSL from ${trailingEval.initialSLPrice?.toFixed(1)}`
                : `SL: ${trailingEval.effectiveSL.toFixed(1)}`}{leg.slAction === 'ALERT' ? ' · alert' : ''}
            </span>
          )}
        </div>
      </td>
      {/* TP Column */}
      <td className="px-2 py-1.5">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1">
            <RuleNumInput
              value={leg.tp}
              onCommit={val => onChange({ tp: val, tpType: tpType })}
              placeholder={tpType === 'price' ? 'Price' : tpType === 'pct' ? '%' : 'Pts'}
              className="w-14 h-7 text-emerald-300 placeholder-emerald-900/40"
              title="Take Profit (points, % of entry premium, or price)"
            />
            <button
              type="button"
              onClick={() => onChange({ tpType: nextLegThresholdType(tpType) })}
              className="h-7 px-1 text-[10px] font-mono font-bold rounded border border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white"
              title="Cycle Points → % of entry → Price"
            >
              {tpType === 'price' ? '₹' : tpType === 'pct' ? '%' : 'pts'}
            </button>
            {leg.tp != null && <HitActionToggle kind="target" action={leg.tpAction} onChange={a => onChange({ tpAction: a })} />}
          </div>
          {trailingEval.tpPrice != null && (
            <span className="text-[10px] font-mono text-emerald-500">
              TP: {trailingEval.tpPrice.toFixed(1)}{leg.tpAction === 'ALERT' ? ' · alert' : ''}
            </span>
          )}
        </div>
      </td>
      {/* Trail Column (1 rupee step) */}
      <td className="px-1 py-1.5 text-center">
        <label className="inline-flex items-center gap-0.5 cursor-pointer select-none text-[11px] font-semibold" title="Trailing SL: tightens SL by ₹1 for every ₹1 favorable move">
          <input
            type="checkbox"
            checked={!!leg.trail}
            onChange={e => changeRisk({ trail: e.target.checked })}
            className="rounded border-zinc-700 text-amber-500 focus:ring-0"
          />
          <span className={leg.trail ? 'text-amber-400 font-bold' : 'text-zinc-500'}>
            1₹
          </span>
        </label>
      </td>
      {/* Expiry Column: the leg's actual expiry date. For a Calendar/Diagonal strategy it also
         toggles between the basket's two expiries; a leg on the second one is highlighted. */}
      <td className="px-1.5 py-1.5 text-center">
        <button
          type="button"
          disabled={!canToggleExpiry}
          onClick={() => onChange({ expiry: isFar ? frontExpiry : (farExpiry ?? frontExpiry) })}
          title={canToggleExpiry
            ? `${leg.expiry || frontExpiry} — click to switch to ${isFar ? frontExpiry : farExpiry}`
            : `Expiry ${leg.expiry || frontExpiry}`}
          className={`px-1.5 py-1 rounded font-mono font-bold text-[10px] whitespace-nowrap border transition-all disabled:opacity-50 disabled:cursor-default ${
            isFar
              ? 'bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/40'
              : 'bg-zinc-800 text-zinc-400 border-zinc-700'
          }`}
        >
          {formatExpiryLabel(leg.expiry || frontExpiry)}
        </button>
      </td>
      {/* Margin Column: Blocked for OPEN, Required for DRAFT */}
      <td className="px-2 py-1.5 text-right">
        {leg.status === 'CLOSED' ? (
          <span className="text-zinc-600 font-mono text-xs">—</span>
        ) : margin != null && margin > 0 ? (
          <div className="flex flex-col items-end">
            <span className="font-mono text-xs font-bold text-zinc-200 tabular-nums">
              {fmtMoney(margin)}
            </span>
            <span className={`text-[9px] font-semibold ${
              leg.status === 'OPEN' ? 'text-emerald-400' : 'text-sky-400'
            }`}>
              {leg.status === 'OPEN' ? 'Blocked' : 'Required'}
            </span>
          </div>
        ) : (
          <span className="text-zinc-600 font-mono text-xs">—</span>
        )}
      </td>
      <td className="px-2 py-1.5 text-right font-mono text-xs font-bold tabular-nums">
        {leg.fill ? <span className={pnlColor}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(0)}</span> : <span className="text-zinc-600">—</span>}
      </td>
      {columns.pnlPct && (
        <td className={`${numCell} font-bold ${pnlPct == null ? '' : pnlPct > 0 ? 'text-emerald-400' : pnlPct < 0 ? 'text-rose-400' : 'text-zinc-400'}`}
          title="P&L as a % of the entry premium">
          {pnlPct != null ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : dash}
        </td>
      )}
      <td className="px-1.5 py-1.5 text-center">
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${STATUS_STYLE[leg.status]}`}>
          {leg.status}
        </span>
      </td>
      <td className="px-2 py-1.5 text-center sticky right-0 z-[1] bg-zinc-900 shadow-[-6px_0_6px_-6px_var(--chart-cursor-line)]">
        {leg.status === 'OPEN' ? (
          <div className="flex items-center justify-end gap-1.5 whitespace-nowrap [&>*]:shrink-0">
            {onShift && (
              <div className="inline-flex items-center rounded border border-zinc-700 overflow-hidden">
                <ShiftStepsInput value={ownSteps} fallback={shiftSteps} disabled={exiting || shiftBusy} onCommit={setOwnSteps} />
                <button
                  type="button"
                  onClick={() => onShift('DOWN', steps)}
                  disabled={exiting || shiftBusy}
                  aria-label={`Shift this leg down ${steps} strike${steps > 1 ? 's' : ''}`}
                  title={`Roll down ${steps} strike${steps > 1 ? 's' : ''} (close, then reopen lower)`}
                  className={`h-6 w-6 inline-flex items-center justify-center text-zinc-300 hover:text-white hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`}
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onShift('UP', steps)}
                  disabled={exiting || shiftBusy}
                  aria-label={`Shift this leg up ${steps} strike${steps > 1 ? 's' : ''}`}
                  title={`Roll up ${steps} strike${steps > 1 ? 's' : ''} (close, then reopen higher)`}
                  className={`h-6 w-6 inline-flex items-center justify-center text-zinc-300 hover:text-white hover:bg-zinc-800 border-l border-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`}
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            {onOpenAddLots && (
              <button
                type="button"
                onClick={onOpenAddLots}
                disabled={exiting || shiftBusy}
                title="Add lots to this open position"
                className={`h-6 px-2 text-[10px] font-bold text-emerald-400 hover:text-emerald-300 rounded border border-emerald-500/30 hover:bg-emerald-500/10 disabled:opacity-50 transition-colors inline-flex items-center gap-0.5 ${FOCUS_RING}`}
              >
                <Plus className="w-2.5 h-2.5" /> ADD
              </button>
            )}
            {restingExit && (
              <span className="h-6 px-1.5 inline-flex items-center text-[10px] font-bold font-mono text-amber-400 rounded border border-amber-500/40 bg-amber-500/10"
                title={`Limit exit resting: ${restingExit.qty} @ ₹${(restingExit.price ?? 0).toFixed(2)}. The leg stays open and protected until it fills; any other exit cancels it first.`}>
                LMT {restingExit.price != null ? restingExit.price.toFixed(2) : ''}
              </span>
            )}
            <button
              type="button"
              onClick={onOpenExit}
              disabled={exiting || shiftBusy}
              aria-label="Exit this leg"
              title="Exit this leg — choose lots and market/limit"
              className={`h-6 px-2.5 text-[10px] font-bold text-rose-400 hover:text-rose-300 rounded border border-rose-500/30 hover:bg-rose-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${FOCUS_RING}`}
            >
              {exiting ? 'Exiting…' : 'EXIT'}
            </button>
          </div>
        ) : editable ? (
          <button onClick={onRemove} aria-label="Remove leg" title="Remove leg"
            className={`w-6 h-6 inline-flex items-center justify-center text-zinc-500 hover:text-rose-300 ${FOCUS_RING}`}>
            <X className="w-3.5 h-3.5" />
          </button>
        ) : null}
      </td>
    </tr>
  );
}
