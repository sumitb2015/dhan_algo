'use client';

import React, { useMemo, useState } from 'react';
import { X, Plus, AlertTriangle, LineChart, ChevronUp } from 'lucide-react';
import { legPnl, computeLegTrailingSL, type MultiLegLeg } from '@/lib/multiLegFocus';
import { computePayoff, type PayoffLeg } from '@/lib/basketStrategies';
import { FOCUS_RING } from '@/components/Scalper';
import RuleNumInput from './RuleNumInput';
import PayoffDiagram from '@/components/strategy/PayoffDiagram';

const SELECT_CLASS = `h-7 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded px-1.5 focus:outline-none focus:border-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed w-full ${FOCUS_RING}`;

const STATUS_STYLE: Record<MultiLegLeg['status'], string> = {
  DRAFT:   'bg-zinc-800 text-zinc-400 border-zinc-700',
  PLACING: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  OPEN:    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  CLOSING: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  CLOSED:  'bg-zinc-800 text-zinc-500 border-zinc-700',
  FAILED:  'bg-rose-500/10 text-rose-400 border-rose-500/20',
};

function fmtMoney(n: number): string {
  return `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

interface MultiLegLegRowProps {
  leg: MultiLegLeg;
  allStrikes: number[];
  ltp: number;
  spot?: number;
  editable: boolean;
  exiting: boolean;
  margin?: number;
  multiplier?: number;
  /** Lot size used to turn `leg.lots` into units when no fill qty exists yet
   *  (a DRAFT leg) — same `defaultLotSize` the parent row's own strategy-level
   *  payoff math uses, so a single leg's chart agrees with the strategy chart
   *  it's part of. */
  lotSize: number;
  /** This basket's front (main) expiry — legs matching it show "FRONT". */
  frontExpiry: string;
  /** Secondary expiry a leg toggles to for a Calendar/Diagonal strategy;
   *  undefined when the underlying only has one listed expiry available. */
  farExpiry?: string;
  onChange: (patch: Partial<MultiLegLeg>) => void;
  onRemove: () => void;
  onExit: () => void;
  onOpenAddLots?: () => void;
  /** Set when the broker shows more quantity at this strike than this
   *  strategy's own tracked qty — see MultiLegFocus.tsx's legQtyWarnings and
   *  the dhan-terminal-position-ownership skill's Invariant 6: the displayed
   *  qty/lots deliberately never inflate to match the broker's pooled total
   *  (it can include a sibling strategy's contribution), so this is the only
   *  visible sign of the gap once the one-shot toast has scrolled away. */
  qtyWarning?: { ownQty: number; brokerQty: number };
}

/** Total <td>/<th> columns in the legs table — kept in one place so the
 *  expandable payoff-diagram row below can span the full table width
 *  without drifting out of sync with MultiLegStrategyRow's <colgroup>. */
const TOTAL_COLS = 14;

export default function MultiLegLegRow({
  leg, allStrikes, ltp, spot, editable, exiting, margin, multiplier = 1, lotSize, frontExpiry, farExpiry, onChange, onRemove, onExit, onOpenAddLots, qtyWarning,
}: MultiLegLegRowProps) {
  const [showPayoff, setShowPayoff] = useState(false);
  const pnl = leg.fill ? legPnl(leg, ltp, multiplier) : 0;
  const pnlColor = pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-rose-400' : 'text-zinc-400';
  const trailingEval = computeLegTrailingSL(leg, ltp);
  const isFar = !!leg.expiry && leg.expiry !== frontExpiry;
  const canToggleExpiry = editable && !!farExpiry && farExpiry !== frontExpiry;

  const legPrice = (leg.fill?.avgPrice && leg.fill.avgPrice > 0) ? leg.fill.avgPrice : (ltp > 0 ? ltp : (leg.price || 0));
  const legBE = leg.option === 'CE' ? leg.strike + legPrice : leg.strike - legPrice;

  // Single-leg payoff-at-expiry curve — same computePayoff() this file's
  // parent uses for the whole-strategy chart (dhan-payoff-diagrams), just
  // fed one leg instead of the basket, so "one leg's own P&L shape" reads
  // consistently with the combined strategy curve above it. A CLOSED leg or
  // one with no resolvable premium yet has nothing meaningful to draw.
  const legQty = useMemo(() => {
    const units = (leg.fill?.qty && leg.fill.qty > 0) ? leg.fill.qty : leg.lots * lotSize;
    return units * multiplier;
  }, [leg.fill?.qty, leg.lots, lotSize, multiplier]);

  const legPayoff = useMemo(() => {
    if (leg.status === 'CLOSED' || legPrice <= 0 || leg.strike <= 0) return null;
    // A single leg's only breakeven sits at exactly strike ± premium
    // (dhan-payoff-diagrams: computePayoff only finds zero-crossings *inside*
    // [lo, hi] — it doesn't fall back to exactExpiryProfile's window-independent
    // walk). A window sized purely off strike (e.g. 8%) silently clips that
    // breakeven out of range for any leg whose premium exceeds it — a deep-ITM
    // leg or a large-premium BANKNIFTY/SENSEX strike, not just an edge case —
    // and computePayoff would then report "no breakeven" for a leg that
    // plainly has one. Padding by the premium itself guarantees the window
    // always spans it.
    const span = Math.max(Math.round(leg.strike * 0.08), legPrice * 1.5, 500);
    const lo = Math.max(0, leg.strike - span);
    const hi = leg.strike + span;
    const payoffLeg: PayoffLeg = { side: leg.side, option: leg.option, strike: leg.strike, premium: legPrice, qty: legQty };
    try {
      return computePayoff([payoffLeg], lo, hi);
    } catch {
      return null;
    }
  }, [leg.status, leg.side, leg.option, leg.strike, legPrice, legQty]);

  return (
    <>
    <tr className="border-b border-zinc-800/60 hover:bg-zinc-900/30 transition-colors">
      <td className="px-2 py-1.5">
        <select value={leg.side} disabled={!editable} className={SELECT_CLASS}
          onChange={e => onChange({ side: e.target.value as MultiLegLeg['side'] })}>
          <option value="B">BUY</option>
          <option value="S">SELL</option>
        </select>
      </td>
      <td className="px-1.5 py-1.5">
        <select value={leg.option} disabled={!editable} className={SELECT_CLASS}
          onChange={e => onChange({ option: e.target.value as MultiLegLeg['option'] })}>
          <option value="CE">CE</option>
          <option value="PE">PE</option>
        </select>
      </td>
      <td className="px-2 py-1.5">
        <select value={leg.strike} disabled={!editable} className={SELECT_CLASS}
          onChange={e => onChange({ strike: Number(e.target.value) })}>
          {!allStrikes.includes(leg.strike) && <option value={leg.strike}>{leg.strike}</option>}
          {allStrikes.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {legPrice > 0 && (
          <span className="block text-[10px] font-mono text-zinc-400 mt-0.5 tabular-nums" title={`Individual Leg Breakeven: ${legBE.toFixed(2)}`}>
            BE: {legBE.toFixed(1)}
            {spot && spot > 0 && (
              <span className="text-zinc-500"> ({legBE >= spot ? '+' : ''}{(((legBE - spot) / spot) * 100).toFixed(1)}%)</span>
            )}
          </span>
        )}
        {legPayoff && (
          <button
            type="button"
            onClick={() => setShowPayoff(v => !v)}
            className={`mt-0.5 inline-flex items-center gap-0.5 text-[9px] font-bold rounded px-1 py-0.5 border transition-colors ${FOCUS_RING} ${
              showPayoff
                ? 'text-sky-300 border-sky-500/40 bg-sky-500/10'
                : 'text-zinc-500 border-zinc-700 hover:text-sky-300 hover:border-sky-500/40'
            }`}
            title={showPayoff ? 'Hide this leg’s payoff diagram' : 'Show this leg’s payoff diagram'}
          >
            {showPayoff ? <ChevronUp className="w-2.5 h-2.5" /> : <LineChart className="w-2.5 h-2.5" />} Payoff
          </button>
        )}
      </td>
      <td className="px-1.5 py-1.5 text-center">
        <input type="number" min={1} value={leg.lots} disabled={!editable}
          onChange={e => onChange({ lots: Math.max(1, Number(e.target.value) || 1) })}
          className={`h-7 w-12 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono rounded px-1 text-center focus:outline-none focus:border-emerald-500 disabled:opacity-50 ${FOCUS_RING}`} />
        {qtyWarning && (
          <span
            className="mt-0.5 flex items-center justify-center gap-0.5 text-[9px] font-bold text-amber-400"
            title={`This strategy tracks ${qtyWarning.ownQty} qty, broker shows ${qtyWarning.brokerQty} at this strike — could be a manual top-up on this leg, or a sibling strategy sharing the strike. Check Orders/Positions.`}
          >
            <AlertTriangle className="w-2.5 h-2.5" /> Broker: {qtyWarning.brokerQty}
          </span>
        )}
      </td>
      <td className="px-2 py-1.5">
        <select value={leg.type} disabled={!editable} className={SELECT_CLASS}
          onChange={e => onChange({ type: e.target.value as MultiLegLeg['type'] })}>
          <option value="MARKET">MARKET</option>
          <option value="LIMIT">LIMIT</option>
        </select>
      </td>
      <td className="px-2 py-1.5 text-right font-mono text-xs text-zinc-300 tabular-nums">
        {ltp > 0 ? ltp.toFixed(2) : '—'}
        {leg.fill?.avgPrice != null && leg.fill.avgPrice > 0 && (
          <span className="block text-[10px] text-zinc-500 mt-0.5" title="Average fill price for this leg">
            Entry: {leg.fill.avgPrice.toFixed(2)}
          </span>
        )}
      </td>
      {/* SL Column */}
      <td className="px-2 py-1.5">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1">
            <RuleNumInput
              value={leg.sl}
              onCommit={val => onChange({ sl: val })}
              placeholder={leg.slType === 'price' ? 'Price' : 'Pts'}
              className="w-14 h-7 text-rose-300 placeholder-rose-900/40"
              title="Stop Loss (in points or price)"
            />
            <button
              type="button"
              onClick={() => onChange({ slType: leg.slType === 'price' ? 'pts' : 'price' })}
              className="h-7 px-1 text-[10px] font-mono font-bold rounded border border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white"
              title="Toggle between Points and Price"
            >
              {leg.slType === 'price' ? '₹' : 'pts'}
            </button>
          </div>
          {trailingEval.effectiveSL != null && (
            <span className={`text-[10px] font-mono ${leg.trail ? 'text-amber-400 font-semibold' : 'text-zinc-500'}`}>
              {leg.trail ? 'TSL' : 'SL'}: {trailingEval.effectiveSL.toFixed(1)}
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
              onCommit={val => onChange({ tp: val })}
              placeholder={leg.tpType === 'price' ? 'Price' : 'Pts'}
              className="w-14 h-7 text-emerald-300 placeholder-emerald-900/40"
              title="Take Profit (in points or price)"
            />
            <button
              type="button"
              onClick={() => onChange({ tpType: leg.tpType === 'price' ? 'pts' : 'price' })}
              className="h-7 px-1 text-[10px] font-mono font-bold rounded border border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white"
              title="Toggle between Points and Price"
            >
              {leg.tpType === 'price' ? '₹' : 'pts'}
            </button>
          </div>
          {trailingEval.tpPrice != null && (
            <span className="text-[10px] font-mono text-emerald-500">
              TP: {trailingEval.tpPrice.toFixed(1)}
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
            onChange={e => onChange({ trail: e.target.checked })}
            className="rounded border-zinc-700 text-amber-500 focus:ring-0"
          />
          <span className={leg.trail ? 'text-amber-400 font-bold' : 'text-zinc-500'}>
            1₹
          </span>
        </label>
      </td>
      {/* Expiry Column: toggles between the basket's front and far expiry —
         only relevant to a Calendar/Diagonal strategy staging legs across
         two different contracts. */}
      <td className="px-1.5 py-1.5 text-center">
        <button
          type="button"
          disabled={!canToggleExpiry}
          onClick={() => onChange({ expiry: isFar ? frontExpiry : (farExpiry ?? frontExpiry) })}
          title={canToggleExpiry ? 'Toggle between front and far expiry' : (leg.expiry || frontExpiry)}
          className={`px-1.5 py-1 rounded font-mono font-bold text-[9px] border transition-all disabled:opacity-50 disabled:cursor-default ${
            isFar
              ? 'bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/40'
              : 'bg-zinc-800 text-zinc-400 border-zinc-700'
          }`}
        >
          {isFar ? 'FAR' : 'FRONT'}
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
      <td className="px-1.5 py-1.5 text-center">
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${STATUS_STYLE[leg.status]}`}>
          {leg.status}
        </span>
      </td>
      <td className="px-2 py-1.5 text-center">
        {leg.status === 'OPEN' ? (
          <div className="flex items-center justify-center gap-1.5 whitespace-nowrap">
            {onOpenAddLots && (
              <button
                type="button"
                onClick={onOpenAddLots}
                disabled={exiting}
                title="Add lots to this open position"
                className={`h-6 px-2 text-[10px] font-bold text-emerald-400 hover:text-emerald-300 rounded border border-emerald-500/30 hover:bg-emerald-500/10 disabled:opacity-50 transition-colors inline-flex items-center gap-0.5 ${FOCUS_RING}`}
              >
                <Plus className="w-2.5 h-2.5" /> ADD
              </button>
            )}
            <button
              type="button"
              onClick={onExit}
              disabled={exiting}
              aria-label="Exit this leg"
              title="Exit this leg"
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
    {showPayoff && legPayoff && (
      <tr className="border-b border-zinc-800/60 bg-zinc-950/60">
        <td colSpan={TOTAL_COLS} className="px-3 py-3">
          <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-3">
            <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
              <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                {leg.side === 'B' ? 'Buy' : 'Sell'} {leg.strike} {leg.option} — payoff at expiry
              </span>
              <div className="flex items-center gap-2 text-[10px] font-mono">
                <span className="text-zinc-500">BE: <span className="text-zinc-200 font-bold">
                  {legPayoff.breakevens.length > 0
                    ? legPayoff.breakevens.map(b => Math.round(b).toLocaleString('en-IN')).join(' — ')
                    : 'None'}
                </span></span>
                <span className="text-zinc-700">·</span>
                <span className="text-zinc-500">Max P/L: <span className="text-emerald-400 font-bold">
                  {legPayoff.maxProfitUnlimited ? 'Unlimited' : `+${fmtMoney(legPayoff.maxProfit)}`}
                </span> / <span className="text-rose-400 font-bold">
                  {legPayoff.maxLossUnlimited ? 'Unlimited' : fmtMoney(legPayoff.maxLoss)}
                </span></span>
              </div>
            </div>
            <PayoffDiagram
              curve={legPayoff.points.map(p => ({ spot: p.x, pnl: p.y }))}
              currentSpot={spot ?? leg.strike}
              breakevens={legPayoff.breakevens}
            />
          </div>
        </td>
      </tr>
    )}
    </>
  );
}
