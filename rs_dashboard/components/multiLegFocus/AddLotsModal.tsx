'use client';

import React, { useState, useMemo } from 'react';
import { X, Plus, ArrowRight, ShieldAlert, Target } from 'lucide-react';
import type { MultiLegBasket, MultiLegLeg } from '@/lib/multiLegFocus';
import { FOCUS_RING } from '@/components/Scalper';
import type { Broker } from '@/hooks/useBrokerSelector';

interface AddLotsModalProps {
  isOpen: boolean;
  onClose: () => void;
  leg: MultiLegLeg | null;
  basket: MultiLegBasket | null;
  lotSize: number;
  currentLtp: number;
  broker: Broker;
  onConfirm: (params: {
    legId: string;
    lots: number;
    orderType: 'MARKET' | 'LIMIT';
    limitPrice?: number;
    newSl?: number;
    newTp?: number;
  }) => Promise<void>;
}

function fmtMoney(n: number): string {
  return `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export default function AddLotsModal({
  isOpen,
  onClose,
  leg,
  basket,
  lotSize,
  currentLtp,
  broker,
  onConfirm,
}: AddLotsModalProps) {
  const [addLots, setAddLots] = useState<number>(1);
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [limitPrice, setLimitPrice] = useState<number>(() => {
    return currentLtp > 0 ? currentLtp : (leg?.price || 0);
  });
  const [adjustRisk, setAdjustRisk] = useState<boolean>(false);
  const [newSl, setNewSl] = useState<string>(() => (leg?.sl != null ? String(leg.sl) : ''));
  const [newTp, setNewTp] = useState<string>(() => (leg?.tp != null ? String(leg.tp) : ''));
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Sync limit price with currentLtp when switching to LIMIT if not set
  const effectivePrice = orderType === 'LIMIT' && limitPrice > 0
    ? limitPrice
    : (currentLtp > 0 ? currentLtp : (leg?.price || 0));

  const effectiveLot = lotSize > 0
    ? lotSize
    : (basket?.underlying === 'NIFTY' ? 65
      : basket?.underlying === 'BANKNIFTY' ? 15
      : basket?.underlying === 'SENSEX' ? 20
      : (broker === 'dhan' ? 1 : basket?.underlying === 'CRUDEOIL' ? 100 : 10));
  const currentQty = (leg?.fill?.qty && leg.fill.qty > 0) ? leg.fill.qty : ((leg?.lots || 1) * effectiveLot);
  const currentAvg = (leg?.fill?.avgPrice && leg.fill.avgPrice > 0) ? leg.fill.avgPrice : (leg?.price || currentLtp);
  const addQty = addLots * effectiveLot;
  const newTotalQty = currentQty + addQty;
  const newTotalLots = (leg?.lots || 0) + addLots;

  const projectedAvgPrice = useMemo(() => {
    if (newTotalQty <= 0) return 0;
    return ((currentAvg * currentQty) + (effectivePrice * addQty)) / newTotalQty;
  }, [currentAvg, currentQty, effectivePrice, addQty, newTotalQty]);

  if (!isOpen || !leg || !basket) return null;

  const isBuy = leg.side === 'B';
  const label = `${isBuy ? 'BUY' : 'SELL'} ${basket.underlying} ${leg.strike} ${leg.option}`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (addLots <= 0 || submitting) return;
    if (orderType === 'LIMIT' && (limitPrice <= 0 || isNaN(limitPrice))) return;

    setSubmitting(true);
    try {
      await onConfirm({
        legId: leg.id,
        lots: addLots,
        orderType,
        limitPrice: orderType === 'LIMIT' ? limitPrice : undefined,
        newSl: adjustRisk && newSl.trim() !== '' ? Number(newSl) : undefined,
        newTp: adjustRisk && newTp.trim() !== '' ? Number(newTp) : undefined,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl max-w-md w-full overflow-hidden flex flex-col">
        {/* Modal Header */}
        <div className="px-5 py-4 bg-zinc-900/90 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className={`text-[11px] font-bold font-mono px-2 py-0.5 rounded border ${
              isBuy ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
            }`}>
              {leg.side === 'B' ? 'BUY' : 'SELL'} {leg.option}
            </span>
            <div>
              <h2 className="text-sm font-bold text-zinc-100 uppercase tracking-wide">
                Add Lots to Position
              </h2>
              <p className="text-xs text-zinc-400 font-mono">
                {basket.underlying} {leg.strike} {leg.option} · Expiry {basket.expiry}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Current Position Snapshot */}
          <div className="grid grid-cols-3 gap-2 p-3 rounded-xl bg-zinc-900/60 border border-zinc-800/80 font-mono text-xs">
            <div>
              <span className="text-[10px] text-zinc-500 font-semibold block uppercase">Current Lots</span>
              <span className="text-zinc-200 font-bold">{leg.lots} ({currentQty} qty)</span>
            </div>
            <div>
              <span className="text-[10px] text-zinc-500 font-semibold block uppercase">Avg Entry</span>
              <span className="text-zinc-200 font-bold">₹{currentAvg.toFixed(2)}</span>
            </div>
            <div className="text-right">
              <span className="text-[10px] text-zinc-500 font-semibold block uppercase">Live LTP</span>
              <span className="text-emerald-400 font-bold">{currentLtp > 0 ? `₹${currentLtp.toFixed(2)}` : '—'}</span>
            </div>
          </div>

          {/* Order Type Toggle */}
          <div>
            <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block mb-1.5">
              Execution Order Type
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setOrderType('MARKET')}
                className={`py-2 px-3 rounded-lg text-xs font-bold font-mono transition-all border ${
                  orderType === 'MARKET'
                    ? 'bg-emerald-600 border-emerald-500 text-white shadow-sm'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                }`}
              >
                MARKET
              </button>
              <button
                type="button"
                onClick={() => {
                  setOrderType('LIMIT');
                  if (limitPrice <= 0 && currentLtp > 0) setLimitPrice(currentLtp);
                }}
                className={`py-2 px-3 rounded-lg text-xs font-bold font-mono transition-all border ${
                  orderType === 'LIMIT'
                    ? 'bg-emerald-600 border-emerald-500 text-white shadow-sm'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                }`}
              >
                LIMIT
              </button>
            </div>
          </div>

          {/* Limit Price Input (if LIMIT) */}
          {orderType === 'LIMIT' && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                  Limit Price (₹)
                </label>
                {currentLtp > 0 && (
                  <button
                    type="button"
                    onClick={() => setLimitPrice(currentLtp)}
                    className="text-[10px] font-mono text-emerald-400 hover:underline"
                  >
                    Use LTP: ₹{currentLtp.toFixed(2)}
                  </button>
                )}
              </div>
              <input
                type="number"
                step="0.05"
                min="0.05"
                value={limitPrice || ''}
                onChange={e => setLimitPrice(Number(e.target.value) || 0)}
                placeholder="Enter limit price"
                className={`w-full h-9 bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-sm rounded-lg px-3 focus:outline-none focus:border-emerald-500 ${FOCUS_RING}`}
                required
              />
            </div>
          )}

          {/* Lots to Add */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                Lots to Enter
              </label>
              <span className="text-xs font-mono text-zinc-400">
                = {addLots * effectiveLot} contracts
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="1"
                step="1"
                value={addLots}
                onChange={e => setAddLots(Math.max(1, parseInt(e.target.value, 10) || 1))}
                className={`w-28 h-9 bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-sm font-bold text-center rounded-lg px-3 focus:outline-none focus:border-emerald-500 ${FOCUS_RING}`}
              />
              <div className="flex items-center gap-1.5 flex-1">
                {[1, 2, 5].map(lots => (
                  <button
                    key={lots}
                    type="button"
                    onClick={() => setAddLots(prev => prev + lots)}
                    className="flex-1 h-9 rounded-lg border border-zinc-700 bg-zinc-900 text-xs font-bold font-mono text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
                  >
                    +{lots}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Projected Calculations Banner */}
          <div className="p-3.5 rounded-xl bg-zinc-900 border border-zinc-800 space-y-2 text-xs font-mono">
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Resulting Total Position:</span>
              <span className="text-zinc-200 font-bold">{newTotalLots} Lots ({newTotalQty} qty)</span>
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

          {/* Optional Risk Levels (SL / TP) adjustment */}
          <div className="border border-zinc-800 rounded-xl p-3 bg-zinc-950">
            <label className="flex items-center gap-2 cursor-pointer select-none text-xs font-semibold text-zinc-300">
              <input
                type="checkbox"
                checked={adjustRisk}
                onChange={e => setAdjustRisk(e.target.checked)}
                className="rounded border-zinc-700 text-emerald-500 focus:ring-0"
              />
              <span>Update Stop Loss / Target for new blended average</span>
            </label>

            {adjustRisk && (
              <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-zinc-800">
                <div>
                  <label className="text-[10px] text-rose-400 font-bold uppercase block mb-1 flex items-center gap-1">
                    <ShieldAlert className="w-3 h-3" /> Stop Loss ({leg.slType ?? 'pts'})
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={newSl}
                    onChange={e => setNewSl(e.target.value)}
                    placeholder={leg.sl != null ? String(leg.sl) : 'SL'}
                    className={`w-full h-8 bg-zinc-900 border border-zinc-700 text-rose-300 font-mono text-xs rounded px-2 focus:outline-none focus:border-rose-500 ${FOCUS_RING}`}
                  />
                </div>
                <div>
                  <label className="text-[10px] text-emerald-400 font-bold uppercase block mb-1 flex items-center gap-1">
                    <Target className="w-3 h-3" /> Take Profit ({leg.tpType ?? 'pts'})
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={newTp}
                    onChange={e => setNewTp(e.target.value)}
                    placeholder={leg.tp != null ? String(leg.tp) : 'TP'}
                    className={`w-full h-8 bg-zinc-900 border border-zinc-700 text-emerald-300 font-mono text-xs rounded px-2 focus:outline-none focus:border-emerald-500 ${FOCUS_RING}`}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Modal Footer */}
          <div className="pt-2 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className={`h-9 px-4 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300 text-xs font-bold hover:bg-zinc-800 hover:text-white transition-colors disabled:opacity-50 ${FOCUS_RING}`}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className={`h-9 px-5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-lg transition-all flex items-center gap-1.5 disabled:opacity-50 ${FOCUS_RING}`}
            >
              <Plus className="w-3.5 h-3.5" />
              {submitting ? 'Placing Order…' : `Confirm Add ${addLots} Lot${addLots > 1 ? 's' : ''}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
