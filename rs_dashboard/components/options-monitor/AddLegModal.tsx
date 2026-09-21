'use client';

import React, { useState } from 'react';
import { OptType, Side, extractChainStrikes } from '@/lib/optionsMonitorMath';
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
  /** Underlying + expiry list let the user build a leg on any listed expiry,
   *  not just the page's active one. Omit to keep the single-expiry behaviour. */
  underlying?: string;
  expiries?: string[];
  currentExpiry?: string;
  onAddLeg: (leg: NewLegPayload) => void;
  onExecuteLeg?: (leg: NewLegPayload) => void;
}

export interface NewLegPayload {
  type: OptType;
  side: Side;
  strike: number;
  lots: number;
  entryPrice: number;
  /** Set only when the chosen expiry differs from the page's active expiry. */
  expiry?: string;
  securityId?: string;
  /** Implied vol as a fraction (0.13 = 13%) when known for that expiry. */
  iv?: number;
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
  underlying,
  expiries,
  currentExpiry,
  onAddLeg,
  onExecuteLeg,
}: AddLegModalProps) {
  const atmStrike = Math.round(spot / strikeStep) * strikeStep;
  const [type, setType] = useState<OptType>('CE');
  const [side, setSide] = useState<Side>('SELL');
  const [strike, setStrike] = useState<number>(atmStrike);
  const [lots, setLots] = useState<number>(defaultLots || 2);
  const [lotsDraft, setLotsDraft] = useState<string>(String(defaultLots || 2));

  const [expiry, setExpiry] = useState<string>(currentExpiry ?? '');
  const isAltExpiry = !!currentExpiry && !!expiry && expiry !== currentExpiry;
  // Chain for a non-active expiry, fetched here. The page's live ticks and chain only cover the
  // active expiry, so for an alternate expiry we must use this instead of (never mixed with) them.
  const [altChain, setAltChain] = useState<Record<number, { ce?: any; pe?: any }> | null>(null);
  const [altStrikes, setAltStrikes] = useState<number[]>([]);
  const [altLoading, setAltLoading] = useState(false);
  const effChain = isAltExpiry ? altChain ?? undefined : chain;
  const effLive = isAltExpiry ? undefined : liveQuotes;
  // Alt-expiry chain not loaded (in flight or failed): price/strike/securityId would be guesses.
  const altNotReady = isAltExpiry && (altLoading || !altChain);

  React.useEffect(() => {
    if (!isAltExpiry || !underlying) { setAltChain(null); setAltStrikes([]); return; }
    let cancelled = false;
    setAltLoading(true);
    setAltChain(null);
    setAltStrikes([]);
    fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}&broker=dhan`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const raw = data?.data?.chain?.oc || data?.data?.chain || {};
        const { strikes, normalized } = extractChainStrikes(raw);
        setAltStrikes(strikes);
        setAltChain(normalized);
        // Keep the selection valid for this expiry's strike list
        if (strikes.length > 0) setStrike((cur) => (strikes.includes(cur) ? cur : strikes.reduce((a, b) => Math.abs(b - cur) < Math.abs(a - cur) ? b : a)));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setAltLoading(false); });
    return () => { cancelled = true; };
  }, [isAltExpiry, expiry, underlying]);

  const resolvePrice = React.useCallback(
    (targetStrike: number, optType: OptType): number => {
      const legKey = optType.toLowerCase() as 'ce' | 'pe';
      const wsTick = effLive?.strikes?.[targetStrike] ?? effLive?.strikes?.[String(targetStrike)];
      const wsPrice = optType === 'CE' ? wsTick?.ce?.ltp : wsTick?.pe?.ltp;
      if (typeof wsPrice === 'number' && wsPrice > 0) return wsPrice;

      const chainEntry = effChain?.[targetStrike];
      const chainP = chainEntry?.[legKey]?.last_price ?? chainEntry?.[legKey]?.previous_close_price;
      if (typeof chainP === 'number' && chainP > 0) return chainP;

      return 35.0;
    },
    [effChain, effLive]
  );

  const [entryPrice, setEntryPrice] = useState<number>(() => resolvePrice(atmStrike, 'CE'));
  const [entryPriceDraft, setEntryPriceDraft] = useState<string>(() => String(resolvePrice(atmStrike, 'CE')));

  const commitLots = (raw: string) => {
    const val = Math.min(50, Math.max(1, parseInt(raw, 10) || 1));
    setLots(val);
    setLotsDraft(String(val));
  };

  const commitEntryPrice = (raw: string) => {
    const val = Math.max(0.05, Math.round((parseFloat(raw) || 0.05) * 100) / 100);
    setEntryPrice(val);
    setEntryPriceDraft(String(val));
  };

  // Snapshot strike/lots/entry-price defaults only on the closed->open transition — using
  // atmStrike/resolvePrice directly as effect deps would re-fire on every live spot tick or
  // chain refresh while the modal is open, silently overwriting a user's in-progress selection.
  const wasOpenRef = React.useRef(false);
  React.useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setExpiry(currentExpiry ?? '');
      setStrike(atmStrike);
      const initP = resolvePrice(atmStrike, type);
      setEntryPrice(initP);
      setEntryPriceDraft(String(initP));
      setLots(defaultLots || 2);
      setLotsDraft(String(defaultLots || 2));
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, atmStrike, resolvePrice, type, defaultLots, currentExpiry]);

  // Re-price the selected strike once an alternate expiry's chain has loaded
  React.useEffect(() => {
    if (!isAltExpiry || !altChain) return;
    const p = resolvePrice(strike, type);
    if (p > 0) { setEntryPrice(p); setEntryPriceDraft(String(p)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [altChain]);

  const handleExpiryChange = (exp: string) => {
    setExpiry(exp);
    if (exp === currentExpiry) {
      const p = resolvePrice(strike, type);
      if (p > 0) { setEntryPrice(p); setEntryPriceDraft(String(p)); }
    }
  };

  // Update entry price when strike or type changes
  const handleStrikeChange = (newStrike: number) => {
    setStrike(newStrike);
    const p = resolvePrice(newStrike, type);
    if (p > 0) {
      setEntryPrice(p);
      setEntryPriceDraft(String(p));
    }
  };

  const handleTypeChange = (newType: OptType) => {
    setType(newType);
    const p = resolvePrice(strike, newType);
    if (p > 0) {
      setEntryPrice(p);
      setEntryPriceDraft(String(p));
    }
  };

  if (!isOpen) return null;

  // Use real chain strikes if available, otherwise generate range around ATM
  const effStrikes = isAltExpiry ? altStrikes : chainStrikes;
  const strikeOptions: number[] = effStrikes && effStrikes.length > 0
    ? effStrikes
    : Array.from({ length: 41 }, (_, i) => atmStrike + (i - 20) * strikeStep);

  const altExtras = (): Pick<NewLegPayload, 'expiry' | 'securityId' | 'iv'> => {
    if (!isAltExpiry) return {};
    const side_ = effChain?.[strike]?.[type.toLowerCase() as 'ce' | 'pe'];
    const iv = side_?.implied_volatility;
    return {
      expiry,
      securityId: side_?.security_id != null ? String(side_.security_id) : undefined,
      iv: typeof iv === 'number' && iv > 0 ? iv / 100 : undefined,
    };
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalLots = Math.min(50, Math.max(1, parseInt(lotsDraft, 10) || lots));
    const finalPrice = Math.max(0.05, Math.round((parseFloat(entryPriceDraft) || entryPrice) * 100) / 100);
    onAddLeg({
      type,
      side,
      strike,
      lots: finalLots,
      entryPrice: finalPrice,
      ...altExtras(),
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

          {/* Expiry Selector */}
          {expiries && expiries.length > 0 && (
            <div>
              <label className="text-[10px] text-zinc-400 uppercase font-semibold block mb-1.5">
                EXPIRY {altLoading && <span className="text-zinc-500 normal-case">(loading chain…)</span>}
              </label>
              <select
                value={expiry}
                onChange={(e) => handleExpiryChange(e.target.value)}
                className="w-full bg-zinc-900 text-white font-bold px-3 py-2 rounded-xl border border-zinc-700 cursor-pointer focus:outline-none focus:border-indigo-500 text-xs"
              >
                {expiries.map((ex) => (
                  <option key={ex} value={ex}>{ex}{ex === currentExpiry ? ' (active)' : ''}</option>
                ))}
              </select>
            </div>
          )}

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
                max={50}
                value={lotsDraft}
                onChange={(e) => setLotsDraft(e.target.value)}
                onBlur={(e) => commitLots(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    commitLots((e.target as HTMLInputElement).value);
                  }
                  if (e.key === 'Escape') {
                    setLotsDraft(String(lots));
                  }
                }}
                className="w-full bg-zinc-900 text-white font-bold px-3 py-2 rounded-xl border border-zinc-700 focus:outline-none focus:border-indigo-500 text-xs"
              />
            </div>

            <div>
              <label className="text-[10px] text-zinc-400 uppercase font-semibold block mb-1.5">
                ENTRY PRICE (₹)
              </label>
              <input
                type="number"
                step="0.05"
                min={0.05}
                value={entryPriceDraft}
                onChange={(e) => setEntryPriceDraft(e.target.value)}
                onBlur={(e) => commitEntryPrice(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    commitEntryPrice((e.target as HTMLInputElement).value);
                  }
                  if (e.key === 'Escape') {
                    setEntryPriceDraft(String(entryPrice));
                  }
                }}
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
                  disabled={altNotReady}
                  onClick={() => {
                    onClose();
                    const finalLots = Math.min(50, Math.max(1, parseInt(lotsDraft, 10) || lots));
                    const finalPrice = Math.max(0.05, Math.round((parseFloat(entryPriceDraft) || entryPrice) * 100) / 100);
                    onExecuteLeg({
                      type,
                      side,
                      strike,
                      lots: finalLots,
                      entryPrice: finalPrice,
                      ...altExtras(),
                    });
                  }}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed bg-emerald-600 hover:bg-emerald-500 text-white font-bold shadow transition-colors cursor-pointer"
                  title="Open Broker Order Ticket to execute this trade on Dhan"
                >
                  <Zap className="w-3.5 h-3.5 fill-current" />
                  <span>PLACE ORDER NOW</span>
                </button>
              )}
              <button
                type="submit"
                disabled={altNotReady}
                className="disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold shadow transition-colors cursor-pointer"
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
