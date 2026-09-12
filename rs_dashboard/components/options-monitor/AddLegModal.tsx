'use client';

import React, { useState } from 'react';
import { OptType, Side } from '@/lib/optionsMonitorMath';
import { X, Plus, Check, Zap } from 'lucide-react';

interface AddLegModalProps {
  isOpen: boolean;
  onClose: () => void;
  spot: number;
  strikeStep: number;
  defaultLots: number;
  chainStrikes?: number[];
  chain?: Record<number, { ce?: any; pe?: any }>;
  liveQuotes?: any;
  onAddLeg: (leg: {
    type: OptType;
    side: Side;
    strike: number;
    lots: number;
    entryPrice: number;
  }) => void;
  onExecuteLeg?: (leg: {
    type: OptType;
    side: Side;
    strike: number;
    lots: number;
    entryPrice: number;
  }) => void;
}

export default function AddLegModal({
  isOpen,
  onClose,
  spot,
  strikeStep,
  defaultLots,
  chainStrikes,
  chain,
  liveQuotes,
  onAddLeg,
  onExecuteLeg,
}: AddLegModalProps) {
  const atmStrike = Math.round(spot / strikeStep) * strikeStep;
  const [type, setType] = useState<OptType>('CE');
  const [side, setSide] = useState<Side>('SELL');
  const [strike, setStrike] = useState<number>(atmStrike);
  const [lots, setLots] = useState<number>(defaultLots || 2);

  const resolvePrice = React.useCallback(
    (targetStrike: number, optType: OptType): number => {
      const legKey = optType.toLowerCase() as 'ce' | 'pe';
      const wsTick = liveQuotes?.strikes?.[targetStrike] ?? liveQuotes?.strikes?.[String(targetStrike)];
      const wsPrice = optType === 'CE' ? wsTick?.ce?.ltp : wsTick?.pe?.ltp;
      if (typeof wsPrice === 'number' && wsPrice > 0) return wsPrice;

      const chainEntry = chain?.[targetStrike];
      const chainP = chainEntry?.[legKey]?.last_price ?? chainEntry?.[legKey]?.previous_close_price;
      if (typeof chainP === 'number' && chainP > 0) return chainP;

      return 35.0;
    },
    [chain, liveQuotes]
  );

  const [entryPrice, setEntryPrice] = useState<number>(() => resolvePrice(atmStrike, 'CE'));

  // Update entry price when modal opens or ATM/chain updates
  React.useEffect(() => {
    if (isOpen) {
      setStrike(atmStrike);
      setEntryPrice(resolvePrice(atmStrike, type));
    }
  }, [isOpen, atmStrike, resolvePrice, type]);

  // Update entry price when strike or type changes
  const handleStrikeChange = (newStrike: number) => {
    setStrike(newStrike);
    const p = resolvePrice(newStrike, type);
    if (p > 0) setEntryPrice(p);
  };

  const handleTypeChange = (newType: OptType) => {
    setType(newType);
    const p = resolvePrice(strike, newType);
    if (p > 0) setEntryPrice(p);
  };

  if (!isOpen) return null;

  // Use real chain strikes if available, otherwise generate range around ATM
  const strikeOptions: number[] = chainStrikes && chainStrikes.length > 0
    ? chainStrikes
    : Array.from({ length: 41 }, (_, i) => atmStrike + (i - 20) * strikeStep);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onAddLeg({
      type,
      side,
      strike,
      lots: Math.max(1, lots),
      entryPrice: Math.max(0.05, entryPrice),
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/80 backdrop-blur-sm select-none font-mono">
      <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-950 p-5 shadow-2xl text-zinc-100 animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
          <div>
            <h3 className="text-sm font-bold text-white uppercase tracking-wider">
              ADD CUSTOM OPTION LEG
            </h3>
            <p className="text-[11px] text-zinc-400 font-sans mt-0.5">
              Select any strike, side, and contract parameters across the option chain.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="mt-4 space-y-4 text-xs">
          {/* Side & Type Buttons */}
          <div className="grid grid-cols-2 gap-3">
            {/* Side: BUY vs SELL */}
            <div>
              <label className="text-[10px] text-zinc-400 uppercase font-semibold block mb-1.5">
                ORDER SIDE
              </label>
              <div className="grid grid-cols-2 gap-1.5 bg-zinc-900 p-1 rounded-xl border border-zinc-800">
                <button
                  type="button"
                  onClick={() => setSide('SELL')}
                  className={`py-1.5 rounded-lg font-bold text-center transition-colors cursor-pointer ${
                    side === 'SELL'
                      ? 'bg-rose-600 text-white shadow'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  SELL
                </button>
                <button
                  type="button"
                  onClick={() => setSide('BUY')}
                  className={`py-1.5 rounded-lg font-bold text-center transition-colors cursor-pointer ${
                    side === 'BUY'
                      ? 'bg-emerald-600 text-white shadow'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  BUY
                </button>
              </div>
            </div>

            {/* Type: CE vs PE */}
            <div>
              <label className="text-[10px] text-zinc-400 uppercase font-semibold block mb-1.5">
                OPTION TYPE
              </label>
              <div className="grid grid-cols-2 gap-1.5 bg-zinc-900 p-1 rounded-xl border border-zinc-800">
                <button
                  type="button"
                  onClick={() => handleTypeChange('CE')}
                  className={`py-1.5 rounded-lg font-bold text-center transition-colors cursor-pointer ${
                    type === 'CE'
                      ? 'bg-sky-600 text-white shadow'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  CALL (CE)
                </button>
                <button
                  type="button"
                  onClick={() => handleTypeChange('PE')}
                  className={`py-1.5 rounded-lg font-bold text-center transition-colors cursor-pointer ${
                    type === 'PE'
                      ? 'bg-amber-600 text-white shadow'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  PUT (PE)
                </button>
              </div>
            </div>
          </div>

          {/* Strike Selector (Open for all strikes) */}
          <div>
            <label className="text-[10px] text-zinc-400 uppercase font-semibold block mb-1.5">
              STRIKE PRICE (ALL STRIKES OPEN)
            </label>
            <select
              value={strike}
              onChange={(e) => handleStrikeChange(Number(e.target.value))}
              className="w-full bg-zinc-900 text-white font-bold px-3 py-2 rounded-xl border border-zinc-700 cursor-pointer focus:outline-none focus:border-indigo-500 text-xs"
            >
              {strikeOptions.map((s) => {
                const diff = s - atmStrike;
                const isAtm = diff === 0;
                return (
                  <option key={s} value={s}>
                    {s} {isAtm ? '(ATM)' : diff > 0 ? `(+${diff} OTM)` : `(${diff} OTM)`}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Lots & Entry Price */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-zinc-400 uppercase font-semibold block mb-1.5">
                LOTS
              </label>
              <input
                type="number"
                min={1}
                max={20}
                value={lots}
                onChange={(e) => setLots(Number(e.target.value))}
                className="w-full bg-zinc-900 text-white font-bold px-3 py-2 rounded-xl border border-zinc-700 focus:outline-none focus:border-indigo-500 text-xs"
              />
            </div>

            <div>
              <label className="text-[10px] text-zinc-400 uppercase font-semibold block mb-1.5">
                ENTRY PRICE (₹)
              </label>
              <input
                type="number"
                step="0.1"
                min={0.1}
                value={entryPrice}
                onChange={(e) => setEntryPrice(Number(e.target.value))}
                className="w-full bg-zinc-900 text-white font-bold px-3 py-2 rounded-xl border border-zinc-700 focus:outline-none focus:border-indigo-500 text-xs"
              />
            </div>
          </div>

          {/* Footer buttons */}
          <div className="mt-5 flex items-center justify-between gap-2.5 pt-3 border-t border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-xl border border-zinc-700 bg-zinc-800 text-zinc-300 font-bold hover:bg-zinc-750 transition-colors cursor-pointer"
            >
              CANCEL
            </button>
            <div className="flex items-center gap-2">
              {onExecuteLeg && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onExecuteLeg({
                      type,
                      side,
                      strike,
                      lots: Math.max(1, lots),
                      entryPrice: Math.max(0.05, entryPrice),
                    });
                  }}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold shadow transition-colors cursor-pointer"
                  title="Open Broker Order Ticket to execute this trade on Dhan"
                >
                  <Zap className="w-3.5 h-3.5 fill-current" />
                  <span>PLACE ORDER NOW</span>
                </button>
              )}
              <button
                type="submit"
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold shadow transition-colors cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>ADD TO MONITOR</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
