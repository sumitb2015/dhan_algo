'use client';

/**
 * Quick "Add Lots" order ticket for the Advanced Scalper positions table's
 * ADD button.
 *
 * Previously ADD only pre-filled an empty order box with the position's
 * strike/side, leaving lots and Buy/Sell to be set manually — and for a
 * position on an expiry other than the one currently selected, it switched
 * the WHOLE terminal's expiry (resetting every other order box) just to
 * resolve the contract. This modal places the order directly instead: it
 * resolves its own (security id / trading symbol, lot size) for whichever
 * expiry the position is actually on via the same `lookup` endpoint the
 * terminal itself uses, entirely independent of the terminal's currently
 * selected expiry — see AdvancedScalper.tsx's `openAddLotsModal` for how the
 * target (expiry, strike, option) gets resolved, and `submitLegOrder` for
 * the actual order call this modal's Confirm button drives.
 *
 * Modeled on multiLegFocus/AddLotsModal.tsx (same "Add Lots to Position"
 * concept for the Multi-Leg Focus tool), copied rather than imported per
 * this app's convention for these small standalone modals — see
 * FocusOptionChainModal.tsx's header comment for the same rationale.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { X, Plus, ArrowRight } from 'lucide-react';
import { scalperRoute, type Broker } from '@/hooks/useBrokerSelector';
import { FOCUS_RING } from '@/components/Scalper';

export interface AddLotsTarget {
  pos: Record<string, unknown>;
  /** The position's OWN expiry — may differ from the terminal's selected one. */
  posExpiry: string;
  strike: number;
  option: 'CE' | 'PE';
}

interface StrikeEntry { ceId?: string; peId?: string; ceSymbol?: string; peSymbol?: string }

export interface SubmitLegOrderParams {
  optionSide: 'CE' | 'PE';
  legExpiry: string;
  strike: number;
  side: 'BUY' | 'SELL';
  lots: number;
  mode: 'MARKET' | 'LIMIT';
  limitPrice?: number;
  entry?: StrikeEntry;
  legLotSize: number;
  legProductType: 'INTRADAY' | 'MARGIN';
}

interface AddLotsModalProps {
  isOpen: boolean;
  onClose: () => void;
  target: AddLotsTarget | null;
  underlying: string;
  broker: Broker;
  defaultProductType: 'INTRADAY' | 'MARGIN';
  onConfirm: (params: SubmitLegOrderParams) => Promise<void>;
}

function fmtMoney(n: number): string {
  return `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export default function AdvancedScalperAddLotsModal({
  isOpen, onClose, target, underlying, broker, defaultProductType, onConfirm,
}: AddLotsModalProps) {
  const [entry, setEntry] = useState<StrikeEntry | null>(null);
  const [resolvedLotSize, setResolvedLotSize] = useState<number | null>(null);
  const [resolveError, setResolveError] = useState('');
  const [resolving, setResolving] = useState(false);

  const [addLots, setAddLots] = useState(1);
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [limitPrice, setLimitPrice] = useState(0);
  const [productType, setProductType] = useState<'INTRADAY' | 'MARGIN'>(defaultProductType);
  const [submitting, setSubmitting] = useState(false);

  // Fresh lookup every time the modal opens on a new target — never reuses
  // the terminal's own strikeMap, which is scoped to whatever expiry is
  // currently selected there, not necessarily this position's expiry.
  useEffect(() => {
    if (!isOpen || !target) return;
    setEntry(null);
    setResolvedLotSize(null);
    setResolveError('');
    setResolving(true);
    let cancelled = false;

    fetch(`${scalperRoute(broker, 'lookup')}?underlying=${underlying}&expiry=${target.posExpiry}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { lotSize: number; strikes: Record<string, StrikeEntry> } }) => {
        if (cancelled) return;
        if (!j.success || !j.data) {
          setResolveError('Could not load strike data for this expiry');
          return;
        }
        const found = j.data.strikes[String(target.strike)];
        if (!found) {
          setResolveError(`Strike ${target.strike} not found on ${target.posExpiry}`);
          return;
        }
        setEntry(found);
        setResolvedLotSize(j.data.lotSize > 0 ? j.data.lotSize : null);
      })
      .catch(() => { if (!cancelled) setResolveError('Network error loading strike data'); })
      .finally(() => { if (!cancelled) setResolving(false); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, target?.pos, target?.posExpiry, target?.strike, broker, underlying]);

  // Reset per-order fields whenever a new target opens, not on every render.
  useEffect(() => {
    if (!isOpen) return;
    setAddLots(1);
    setOrderType('MARKET');
    setLimitPrice(0);
    setProductType(defaultProductType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, target?.pos]);

  const pos = target?.pos;
  const netQty = Number(pos?.netQty) || 0;
  const isBuy = netQty > 0;
  const side: 'BUY' | 'SELL' = isBuy ? 'BUY' : 'SELL';
  const currentQty = Math.abs(netQty);
  const currentAvg = isBuy ? Number(pos?.buyAvg) || 0 : Number(pos?.sellAvg) || 0;
  const ltp = Number(pos?.lastTradedPrice) || 0;

  const effectiveLot = resolvedLotSize ?? 0;
  const effectivePrice = orderType === 'LIMIT' && limitPrice > 0 ? limitPrice : (ltp > 0 ? ltp : currentAvg);
  const addQty = addLots * effectiveLot;
  const newTotalQty = currentQty + addQty;

  const projectedAvgPrice = useMemo(() => {
    if (newTotalQty <= 0) return 0;
    return ((currentAvg * currentQty) + (effectivePrice * addQty)) / newTotalQty;
  }, [currentAvg, currentQty, effectivePrice, addQty, newTotalQty]);

  if (!isOpen || !target || !pos) return null;

  const canSubmit = !resolving && !resolveError && effectiveLot > 0 && addLots > 0
    && (orderType === 'MARKET' || (limitPrice > 0 && !isNaN(limitPrice)));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm({
        optionSide: target.option,
        legExpiry: target.posExpiry,
        strike: target.strike,
        side,
        lots: addLots,
        mode: orderType,
        limitPrice: orderType === 'LIMIT' ? limitPrice : undefined,
        entry: entry ?? undefined,
        legLotSize: effectiveLot,
        legProductType: productType,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const label = `${underlying} ${target.strike} ${target.option}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/80 backdrop-blur-sm p-4">
      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl max-w-md w-full overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 bg-zinc-900/90 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className={`text-[11px] font-bold font-mono px-2 py-0.5 rounded border ${
              isBuy ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
            }`}>
              {side} {target.option}
            </span>
            <div>
              <h2 className="text-sm font-bold text-zinc-100 uppercase tracking-wide">Add Lots to Position</h2>
              <p className="text-xs text-zinc-400 font-mono">{label} · Expiry {target.posExpiry}</p>
            </div>
          </div>
          <button type="button" onClick={onClose}
            aria-label="Close" title="Close"
            className={`p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors ${FOCUS_RING}`}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {resolveError && (
            <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-lg px-4 py-2">
              {resolveError}
            </div>
          )}
          {resolving && (
            <div className="text-xs text-zinc-400 bg-zinc-900/60 border border-zinc-800 rounded-lg px-4 py-2 animate-pulse">
              Resolving {label} on {target.posExpiry}…
            </div>
          )}

          {/* Current Position Snapshot */}
          <div className="grid grid-cols-3 gap-2 p-3 rounded-xl bg-zinc-900/60 border border-zinc-800/80 font-mono text-xs">
            <div>
              <span className="text-[10px] text-zinc-500 font-semibold block uppercase">Current Qty</span>
              <span className="text-zinc-200 font-bold">
                {currentQty}{effectiveLot > 0 ? ` (${(currentQty / effectiveLot).toFixed(currentQty % effectiveLot === 0 ? 0 : 2)} lots)` : ''}
              </span>
            </div>
            <div>
              <span className="text-[10px] text-zinc-500 font-semibold block uppercase">Avg Entry</span>
              <span className="text-zinc-200 font-bold">₹{currentAvg.toFixed(2)}</span>
            </div>
            <div className="text-right">
              <span className="text-[10px] text-zinc-500 font-semibold block uppercase">Live LTP</span>
              <span className="text-emerald-400 font-bold">{ltp > 0 ? `₹${ltp.toFixed(2)}` : '—'}</span>
            </div>
          </div>

          {/* Product Type Toggle */}
          <div>
            <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block mb-1.5">
              Product
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(['MARGIN', 'INTRADAY'] as const).map(pt => (
                <button key={pt} type="button" onClick={() => setProductType(pt)}
                  className={`py-2 px-3 rounded-lg text-xs font-bold font-mono transition-all border ${
                    productType === pt
                      ? 'bg-emerald-600 border-emerald-500 text-white shadow-sm'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                  }`}>
                  {pt}
                </button>
              ))}
            </div>
          </div>

          {/* Order Type Toggle */}
          <div>
            <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block mb-1.5">
              Execution Order Type
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setOrderType('MARKET')}
                className={`py-2 px-3 rounded-lg text-xs font-bold font-mono transition-all border ${
                  orderType === 'MARKET'
                    ? 'bg-emerald-600 border-emerald-500 text-white shadow-sm'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                }`}>
                MARKET
              </button>
              <button type="button" onClick={() => { setOrderType('LIMIT'); if (limitPrice <= 0 && ltp > 0) setLimitPrice(ltp); }}
                className={`py-2 px-3 rounded-lg text-xs font-bold font-mono transition-all border ${
                  orderType === 'LIMIT'
                    ? 'bg-emerald-600 border-emerald-500 text-white shadow-sm'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                }`}>
                LIMIT
              </button>
            </div>
          </div>

          {orderType === 'LIMIT' && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Limit Price (₹)</label>
                {ltp > 0 && (
                  <button type="button" onClick={() => setLimitPrice(ltp)}
                    className="text-[10px] font-mono text-emerald-400 hover:underline">
                    Use LTP: ₹{ltp.toFixed(2)}
                  </button>
                )}
              </div>
              <input type="number" step="0.05" min="0.05" value={limitPrice || ''}
                onChange={e => setLimitPrice(Number(e.target.value) || 0)}
                placeholder="Enter limit price"
                className={`w-full h-9 bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-sm rounded-lg px-3 focus:outline-none focus:border-emerald-500 ${FOCUS_RING}`}
                required />
            </div>
          )}

          {/* Lots to Add */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Lots to Add</label>
              <span className="text-xs font-mono text-zinc-400">
                {effectiveLot > 0 ? `= ${addQty} contracts` : ''}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input type="number" min="1" step="1" value={addLots}
                onChange={e => setAddLots(Math.max(1, parseInt(e.target.value, 10) || 1))}
                className={`w-28 h-9 bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-sm font-bold text-center rounded-lg px-3 focus:outline-none focus:border-emerald-500 ${FOCUS_RING}`} />
              <div className="flex items-center gap-1.5 flex-1">
                {[1, 2, 5].map(lots => (
                  <button key={lots} type="button" onClick={() => setAddLots(prev => prev + lots)}
                    className="flex-1 h-9 rounded-lg border border-zinc-700 bg-zinc-900 text-xs font-bold font-mono text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors">
                    +{lots}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Projected Calculations */}
          {effectiveLot > 0 && (
            <div className="p-3.5 rounded-xl bg-zinc-900 border border-zinc-800 space-y-2 text-xs font-mono">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Resulting Total Qty:</span>
                <span className="text-zinc-200 font-bold">{newTotalQty}</span>
              </div>
              <div className="flex items-center justify-between border-t border-zinc-800/80 pt-1.5">
                <span className="text-zinc-400">Projected New Average:</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-500 line-through">₹{currentAvg.toFixed(2)}</span>
                  <ArrowRight className="w-3 h-3 text-zinc-500" />
                  <span className="text-emerald-400 font-bold text-sm">₹{projectedAvgPrice.toFixed(2)}</span>
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-zinc-800/80 pt-1.5">
                <span className="text-zinc-400">{isBuy ? 'Premium Debit:' : 'Premium Credit:'}</span>
                <span className={`font-bold ${isBuy ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {fmtMoney(effectivePrice * addQty)}
                </span>
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="pt-2 flex items-center justify-end gap-2.5">
            <button type="button" onClick={onClose} disabled={submitting}
              className={`h-9 px-4 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300 text-xs font-bold hover:bg-zinc-800 hover:text-white transition-colors disabled:opacity-50 ${FOCUS_RING}`}>
              Cancel
            </button>
            <button type="submit" disabled={!canSubmit || submitting}
              className={`h-9 px-5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-lg transition-all flex items-center gap-1.5 disabled:opacity-50 ${FOCUS_RING}`}>
              <Plus className="w-3.5 h-3.5" />
              {submitting ? 'Placing Order…' : `Confirm ${side} ${addLots} Lot${addLots > 1 ? 's' : ''}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
