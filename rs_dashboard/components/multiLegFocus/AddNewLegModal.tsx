'use client';

import React, { useState } from 'react';
import { X, Plus } from 'lucide-react';
import { fallbackLotSize, formatExpiryLabel, type MultiLegBasket } from '@/lib/multiLegFocus';
import { FOCUS_RING } from '@/components/Scalper';
import { allowedStrikes, snapToAllowed, strikeAllowed } from '@/lib/farExpiryRules';

interface AddNewLegModalProps {
  isOpen: boolean;
  onClose: () => void;
  basket: MultiLegBasket | null;
  allStrikes: number[];
  /** Sorted listed expiries for this underlying — drives the far-expiry 100-multiple rule. */
  listedExpiries?: string[];
  atmStrike: number;
  lotSize: number;
  ltpForStrike: (strike: number, option: 'CE' | 'PE', expiry?: string) => number;
  onAddLeg: (params: {
    side: 'B' | 'S';
    option: 'CE' | 'PE';
    strike: number;
    expiry: string;
    lots: number;
    orderType: 'MARKET' | 'LIMIT' | 'SL' | 'SLM';
    limitPrice?: number;
    /** SL / SLM only: the order rests at the exchange until this prints. */
    triggerPrice?: number;
  }) => Promise<void>;
}

const DAY_MS = 86_400_000;
const dteLabel = (expiry: string): string => {
  const days = Math.round((Date.parse(expiry) - Date.parse(new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10))) / DAY_MS);
  return Number.isFinite(days) ? (days <= 0 ? (days === 0 ? 'Expiry day' : 'Expired') : `${days} DTE`) : '';
};

export default function AddNewLegModal({
  isOpen,
  onClose,
  basket,
  allStrikes,
  listedExpiries = [],
  atmStrike,
  lotSize,
  ltpForStrike,
  onAddLeg,
}: AddNewLegModalProps) {
  const [side, setSide] = useState<'B' | 'S'>('S');
  const [option, setOption] = useState<'CE' | 'PE'>('CE');
  const [strike, setStrike] = useState<number>(() => {
    const start = atmStrike > 0 ? atmStrike : (allStrikes[0] ?? 24000);
    // Opens on the basket's own expiry; on a far expiry the ATM strike may not be a multiple of 100.
    return basket ? snapToAllowed(basket.underlying, basket.expiry, listedExpiries, start, allStrikes) : start;
  });
  // Defaults to the basket's front expiry; only togglable to FAR when this
  // basket actually has a second expiry (a Calendar/Diagonal strategy).
  const [expiry, setExpiry] = useState<string>(() => basket?.expiry ?? '');
  const [lots, setLots] = useState<number>(1);
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT' | 'SL' | 'SLM'>('MARKET');
  const [limitPrice, setLimitPrice] = useState<number>(0);
  // Stop-entry prices stay as typed text: nothing reads them until Place, so a half-typed
  // "24" never becomes a trigger (dhan-commit-on-blur).
  const [triggerDraft, setTriggerDraft] = useState<string>('');
  const [slLimitDraft, setSlLimitDraft] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);

  if (!isOpen || !basket) return null;

  // Expired contracts cannot be traded; the basket's own expiry stays so its row never disappears.
  const todayIst = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const expiryChoices = Array.from(new Set([basket.expiry, basket.farExpiry, ...listedExpiries].filter((e): e is string => !!e)))
    .filter(e => e >= todayIst || e === basket.expiry || e === expiry)
    .sort();
  const effectiveExpiry = expiry || basket.expiry;
  const strikeChoices = allowedStrikes(basket.underlying, effectiveExpiry, listedExpiries, allStrikes);
  const strikeOk = strikeAllowed(basket.underlying, effectiveExpiry, listedExpiries, strike);
  const currentLtp = ltpForStrike(strike, option, effectiveExpiry);
  const effectiveLot = lotSize > 0 ? lotSize : fallbackLotSize(basket.underlying, basket.broker);
  const totalQty = lots * effectiveLot;

  // Stop-loss entry: Dhan only. It rests until the trigger prints, so it must sit on the far
  // side of the live price (a BUY stop above it, a SELL stop below it) or Dhan rejects it.
  const isStop = orderType === 'SL' || orderType === 'SLM';
  // Compared exactly as it will be sent: the order request snaps both prices to the 0.05 tick.
  const tick = (v: number) => Math.round(v * 20) / 20;
  const triggerNum = tick(Number(triggerDraft) || 0);
  const slLimitNum = tick(Number(slLimitDraft) || 0);
  const stopError: string | null = !isStop ? null
    : !(triggerNum > 0) ? 'Enter the trigger price'
    : !(currentLtp > 0) ? 'No live price for this strike yet, so the trigger side cannot be checked'
    : currentLtp > 0 && side === 'B' && triggerNum <= currentLtp ? `A BUY stop trigger must be above the current price (₹${currentLtp.toFixed(2)})`
    : currentLtp > 0 && side === 'S' && triggerNum >= currentLtp ? `A SELL stop trigger must be below the current price (₹${currentLtp.toFixed(2)})`
    : orderType === 'SL' && !(slLimitNum > 0) ? 'Enter the limit price'
    : orderType === 'SL' && side === 'B' && slLimitNum < triggerNum ? 'A BUY stop-limit price must be at or above its trigger'
    : orderType === 'SL' && side === 'S' && slLimitNum > triggerNum ? 'A SELL stop-limit price must be at or below its trigger'
    : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lots <= 0 || submitting || !strikeOk) return;
    if (orderType === 'LIMIT' && (limitPrice <= 0 || isNaN(limitPrice))) return;
    if (stopError) return;

    setSubmitting(true);
    try {
      await onAddLeg({
        side,
        option,
        strike,
        expiry: effectiveExpiry,
        lots,
        orderType,
        limitPrice: orderType === 'LIMIT' ? limitPrice : orderType === 'SL' ? slLimitNum : undefined,
        triggerPrice: isStop ? triggerNum : undefined,
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
              {basket.name} · {basket.underlying} · Expiry {effectiveExpiry}
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
                const l = ltpForStrike(s, option, effectiveExpiry);
                if (l > 0) setLimitPrice(l);
              }}
              className={`w-full h-9 bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-sm rounded-lg px-3 focus:outline-none focus:border-emerald-500 ${FOCUS_RING}`}
            >
              {!strikeChoices.includes(strike) && <option value={strike}>{strike}</option>}
              {strikeChoices.map(s => (
                <option key={s} value={s}>
                  {s} {s === atmStrike ? '(ATM)' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Expiry — any listed expiry for this underlying, not just the
             basket's own pair, so a leg can be added on a different expiry. */}
          {expiryChoices.length > 1 && (
            <div>
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block mb-1">
                Expiry
              </label>
              <select
                value={effectiveExpiry}
                onChange={e => {
                  const exp = e.target.value;
                  setExpiry(exp);
                  const snapped = snapToAllowed(basket.underlying, exp, listedExpiries, strike, allStrikes);
                  setStrike(snapped);
                  const l = ltpForStrike(snapped, option, exp);
                  if (l > 0) setLimitPrice(l);
                }}
                className={`w-full h-9 bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-sm rounded-lg px-3 focus:outline-none focus:border-emerald-500 ${FOCUS_RING}`}
              >
                {expiryChoices.map(exp => (
                  <option key={exp} value={exp}>
                    {formatExpiryLabel(exp)} · {dteLabel(exp)}{exp === basket.expiry ? ' (strategy)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

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
          <div className={`grid gap-2 ${basket.broker === 'dhan' ? 'grid-cols-4' : 'grid-cols-2'}`}>
            {([
              ['MARKET', 'MARKET', 'Fill now at the market'],
              ['LIMIT', 'LIMIT', 'Rest at your limit price'],
              ['SL', 'SL-L', 'Stop-limit: open when the trigger prints, at your limit price'],
              ['SLM', 'SL-M', 'Stop-market: open at the market when the trigger prints'],
            ] as const).filter(([k]) => basket.broker === 'dhan' || k === 'MARKET' || k === 'LIMIT').map(([k, label, tip]) => (
              <button
                key={k}
                type="button"
                title={tip}
                onClick={() => {
                  setOrderType(k);
                  if (k === 'LIMIT' && limitPrice <= 0 && currentLtp > 0) setLimitPrice(currentLtp);
                }}
                className={`py-2 px-2 rounded-lg text-xs font-bold font-mono transition-all border ${FOCUS_RING} ${
                  orderType === k
                    ? 'bg-emerald-600 border-emerald-500 text-white shadow-sm'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {isStop && (
            <div className="space-y-2">
              <p className="text-[11px] text-zinc-400">
                Rests at the exchange. The leg opens here only once the trigger prints and the order trades.{orderType === 'SL' ? ' Put the limit a little beyond the trigger (BUY above, SELL below), or a gap past it leaves the order unfilled.' : ''}
              </p>
              <div className={`grid gap-2 ${orderType === 'SL' ? 'grid-cols-2' : 'grid-cols-1'}`}>
                <div>
                  <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block mb-1">Trigger Price (₹)</label>
                  <input
                    type="number" step="0.05" min="0.05" inputMode="decimal"
                    value={triggerDraft}
                    onChange={e => setTriggerDraft(e.target.value)}
                    placeholder={currentLtp > 0 ? `LTP ${currentLtp.toFixed(2)}` : 'Trigger'}
                    aria-label="Stop trigger price"
                    className={`w-full h-9 bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-sm rounded-lg px-3 focus:outline-none focus:border-emerald-500 ${FOCUS_RING}`}
                  />
                </div>
                {orderType === 'SL' && (
                  <div>
                    <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block mb-1">Limit Price (₹)</label>
                    <input
                      type="number" step="0.05" min="0.05" inputMode="decimal"
                      value={slLimitDraft}
                      onChange={e => setSlLimitDraft(e.target.value)}
                      placeholder="Limit"
                      aria-label="Stop limit price"
                      className={`w-full h-9 bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-sm rounded-lg px-3 focus:outline-none focus:border-emerald-500 ${FOCUS_RING}`}
                    />
                  </div>
                )}
              </div>
              {stopError && (triggerDraft !== '' || slLimitDraft !== '') && <p className="text-[11px] text-red-400" role="alert">{stopError}</p>}
            </div>
          )}

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
              disabled={submitting || !strikeOk || !!stopError}
              title={strikeOk ? undefined : 'Far expiries only allow strikes in multiples of 100'}
              className={`h-9 px-5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-lg transition-all flex items-center gap-1.5 disabled:opacity-50 ${FOCUS_RING}`}
            >
              <Plus className="w-3.5 h-3.5" />
              {submitting ? 'Placing Order…' : isStop ? 'Place Stop Order' : 'Place & Add Leg'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
