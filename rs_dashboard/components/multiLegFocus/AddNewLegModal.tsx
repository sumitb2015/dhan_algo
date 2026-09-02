'use client';

import React, { useState } from 'react';
import { X, Plus } from 'lucide-react';
import type { MultiLegBasket } from '@/lib/multiLegFocus';
import { FOCUS_RING } from '@/components/Scalper';

interface AddNewLegModalProps {
  isOpen: boolean;
  onClose: () => void;
  basket: MultiLegBasket | null;
  allStrikes: number[];
  atmStrike: number;
  lotSize: number;
  ltpForStrike: (strike: number, option: 'CE' | 'PE') => number;
  onAddLeg: (params: {
    side: 'B' | 'S';
    option: 'CE' | 'PE';
    strike: number;
    lots: number;
    orderType: 'MARKET' | 'LIMIT';
    limitPrice?: number;
  }) => Promise<void>;
}

export default function AddNewLegModal({
  isOpen,
  onClose,
  basket,
  allStrikes,
  atmStrike,
  lotSize,
  ltpForStrike,
  onAddLeg,
}: AddNewLegModalProps) {
  const [side, setSide] = useState<'B' | 'S'>('S');
  const [option, setOption] = useState<'CE' | 'PE'>('CE');
  const [strike, setStrike] = useState<number>(() => (atmStrike > 0 ? atmStrike : (allStrikes[0] ?? 24000)));
  const [lots, setLots] = useState<number>(1);
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [limitPrice, setLimitPrice] = useState<number>(0);
  const [submitting, setSubmitting] = useState<boolean>(false);

  if (!isOpen || !basket) return null;

  const currentLtp = ltpForStrike(strike, option);
  const effectiveLot = lotSize > 0
    ? lotSize
    : (basket.underlying === 'NIFTY' ? 65
      : basket.underlying === 'BANKNIFTY' ? 15
      : basket.underlying === 'SENSEX' ? 20
      : (basket.underlying === 'CRUDEOIL' ? 1 : 1));
  const totalQty = lots * effectiveLot;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lots <= 0 || submitting) return;
    if (orderType === 'LIMIT' && (limitPrice <= 0 || isNaN(limitPrice))) return;

    setSubmitting(true);
    try {
      await onAddLeg({
        side,
        option,
        strike,
        lots,
        orderType,
        limitPrice: orderType === 'LIMIT' ? limitPrice : undefined,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl max-w-md w-full overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 bg-zinc-900/90 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-zinc-100 uppercase tracking-wide">
              Add New Leg to Active Strategy
            </h2>
            <p className="text-xs text-zinc-400 font-mono">
              {basket.name} · {basket.underlying} · Expiry {basket.expiry}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Side & Option Type */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block mb-1">
                Side
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setSide('B')}
                  className={`py-1.5 rounded-lg text-xs font-bold border transition-all ${
                    side === 'B'
                      ? 'bg-emerald-600 border-emerald-500 text-white'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  BUY
                </button>
                <button
                  type="button"
                  onClick={() => setSide('S')}
                  className={`py-1.5 rounded-lg text-xs font-bold border transition-all ${
                    side === 'S'
                      ? 'bg-rose-600 border-rose-500 text-white'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  SELL
                </button>
              </div>
            </div>

            <div>
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block mb-1">
                Option
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setOption('CE')}
                  className={`py-1.5 rounded-lg text-xs font-bold border transition-all ${
                    option === 'CE'
                      ? 'bg-zinc-800 border-zinc-600 text-white'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  CE
                </button>
                <button
                  type="button"
                  onClick={() => setOption('PE')}
                  className={`py-1.5 rounded-lg text-xs font-bold border transition-all ${
                    option === 'PE'
                      ? 'bg-zinc-800 border-zinc-600 text-white'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  PE
                </button>
              </div>
            </div>
          </div>

          {/* Strike Selection */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                Strike
              </label>
              {currentLtp > 0 && (
                <span className="text-xs font-mono text-emerald-400">
                  LTP: ₹{currentLtp.toFixed(2)}
                </span>
              )}
            </div>
            <select
              value={strike}
              onChange={e => {
                const s = Number(e.target.value);
                setStrike(s);
                const l = ltpForStrike(s, option);
                if (l > 0) setLimitPrice(l);
              }}
              className={`w-full h-9 bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-sm rounded-lg px-3 focus:outline-none focus:border-emerald-500 ${FOCUS_RING}`}
            >
              {!allStrikes.includes(strike) && <option value={strike}>{strike}</option>}
              {allStrikes.map(s => (
                <option key={s} value={s}>
                  {s} {s === atmStrike ? '(ATM)' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Lots */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                Lots
              </label>
              <span className="text-xs font-mono text-zinc-400">
                = {totalQty} contracts
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="1"
                step="1"
                value={lots}
                onChange={e => setLots(Math.max(1, parseInt(e.target.value, 10) || 1))}
                className={`w-28 h-9 bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-sm font-bold text-center rounded-lg px-3 focus:outline-none focus:border-emerald-500 ${FOCUS_RING}`}
              />
              <div className="flex items-center gap-1.5 flex-1">
                {[1, 2, 5].map(l => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLots(prev => prev + l)}
                    className="flex-1 h-9 rounded-lg border border-zinc-700 bg-zinc-900 text-xs font-bold font-mono text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
                  >
                    +{l}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Order Type & Price */}
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

          {orderType === 'LIMIT' && (
            <div>
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block mb-1">
                Limit Price (₹)
              </label>
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

          {/* Footer */}
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
              {submitting ? 'Placing Order…' : 'Place & Add Leg'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
