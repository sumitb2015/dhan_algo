'use client';

import React, { useEffect, useState } from 'react';
import { X, LogOut } from 'lucide-react';
import { fallbackLotSize, type MultiLegBasket, type MultiLegLeg } from '@/lib/multiLegFocus';
import { FOCUS_RING } from '@/components/Scalper';
import type { Broker } from '@/hooks/useBrokerSelector';

interface ExitLotsModalProps {
  isOpen: boolean;
  onClose: () => void;
  leg: MultiLegLeg | null;
  basket: MultiLegBasket | null;
  lotSize: number;
  currentLtp: number;
  broker: Broker;
  onConfirm: (params: { legId: string; lots: number; orderType: 'MARKET' | 'LIMIT'; limitPrice?: number }) => Promise<boolean | void>;
}

function fmtMoney(n: number): string {
  return `${n < 0 ? '-' : n > 0 ? '+' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export default function ExitLotsModal({ isOpen, onClose, leg, basket, lotSize, currentLtp, broker, onConfirm }: ExitLotsModalProps) {
  const [exitLots, setExitLots] = useState<number>(leg?.lots ?? 1);
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [limitPrice, setLimitPrice] = useState<number>(() => (currentLtp > 0 ? currentLtp : 0));
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, submitting, onClose]);

  if (!isOpen || !leg || !basket) return null;

  const isBuy = leg.side === 'B';
  // Resting LIMIT exits are cancelled and replaced through the Dhan order API only; other brokers exit at market.
  const limitOk = (basket.broker || broker) === 'dhan';
  const effectiveLot = lotSize > 0 ? lotSize : fallbackLotSize(basket.underlying ?? '', broker);
  const ownQty = (leg.fill?.qty && leg.fill.qty > 0) ? leg.fill.qty : leg.lots * effectiveLot;
  const unit = leg.lots > 0 ? ownQty / leg.lots : effectiveLot;
  const maxLots = Math.max(1, leg.lots);
  const lots = Math.min(maxLots, Math.max(1, exitLots));
  const exitQty = Math.round(lots * unit);
  const avg = (leg.fill?.avgPrice && leg.fill.avgPrice > 0) ? leg.fill.avgPrice : (leg.price ?? 0);
  const refPrice = orderType === 'LIMIT' && limitPrice > 0 ? limitPrice : currentLtp;
  const projPnl = refPrice > 0 && avg > 0 ? (isBuy ? refPrice - avg : avg - refPrice) * exitQty : null;
  const remaining = leg.lots - lots;
  const limitInvalid = orderType === 'LIMIT' && !(limitPrice > 0);
  const action = isBuy ? 'SELL' : 'BUY';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || limitInvalid) return;
    setSubmitting(true);
    try {
      const sent = await onConfirm({ legId: leg.id, lots, orderType, limitPrice: orderType === 'LIMIT' ? limitPrice : undefined });
      // A refused exit (toast explains why) leaves the ticket open so the lots/price can be corrected.
      if (sent !== false) onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const segBtn = (active: boolean) => `py-2 px-3 rounded-lg text-xs font-bold font-mono transition-all border ${
    active ? 'bg-rose-600 border-rose-500 text-oncolor shadow-sm' : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/80 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-label="Exit position">
      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl max-w-md w-full overflow-hidden flex flex-col">
        <div className="px-5 py-4 bg-zinc-900/90 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className={`text-[11px] font-bold font-mono px-2 py-0.5 rounded border ${isBuy ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-rose-500/10 text-rose-400 border-rose-500/30'}`}>
              {isBuy ? 'BUY' : 'SELL'} {leg.option}
            </span>
            <div>
              <h2 className="text-sm font-bold text-zinc-100 uppercase tracking-wide">Exit Position</h2>
              <p className="text-xs text-zinc-400 font-mono">{basket.underlying} {leg.strike} {leg.option} · Expiry {basket.expiry}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={`p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors ${FOCUS_RING}`}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="grid grid-cols-3 gap-2 p-3 rounded-xl bg-zinc-900/60 border border-zinc-800/80 font-mono text-xs">
            <div>
              <span className="text-[10px] text-zinc-500 font-semibold block uppercase">Open Lots</span>
              <span className="text-zinc-200 font-bold">{leg.lots} ({ownQty} qty)</span>
            </div>
            <div>
              <span className="text-[10px] text-zinc-500 font-semibold block uppercase">Avg Entry</span>
              <span className="text-zinc-200 font-bold">{avg > 0 ? `₹${avg.toFixed(2)}` : '—'}</span>
            </div>
            <div className="text-right">
              <span className="text-[10px] text-zinc-500 font-semibold block uppercase">Live LTP</span>
              <span className="text-emerald-400 font-bold">{currentLtp > 0 ? `₹${currentLtp.toFixed(2)}` : '—'}</span>
            </div>
          </div>

          <div>
            <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block mb-1.5">Execution Order Type</label>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setOrderType('MARKET')} className={segBtn(orderType === 'MARKET')}>MARKET</button>
              <button type="button" disabled={!limitOk} title={limitOk ? undefined : 'Limit exits are available on Dhan only (a resting order can only be cancelled there)'}
                onClick={() => { setOrderType('LIMIT'); if (limitPrice <= 0 && currentLtp > 0) setLimitPrice(currentLtp); }} className={`${segBtn(orderType === 'LIMIT')} disabled:opacity-40 disabled:cursor-not-allowed`}>LIMIT</button>
            </div>
          </div>

          {orderType === 'LIMIT' && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Limit Price (₹)</label>
                {currentLtp > 0 && (
                  <button type="button" onClick={() => setLimitPrice(currentLtp)} className="text-[10px] font-mono text-emerald-400 hover:underline">
                    Use LTP: ₹{currentLtp.toFixed(2)}
                  </button>
                )}
              </div>
              <input
                type="number" step="0.05" min="0.05"
                value={limitPrice || ''}
                onChange={e => setLimitPrice(Number(e.target.value) || 0)}
                placeholder="Enter limit price"
                className={`w-full h-9 bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-sm rounded-lg px-3 ${FOCUS_RING}`}
                required
              />
              <p className="text-[10px] text-zinc-500 mt-1">The leg stays open (SL, target and guards keep working) until this fills. Any other exit cancels this order first.</p>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Lots to Exit</label>
              <span className="text-xs font-mono text-zinc-400">= {exitQty} contracts</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number" min={1} max={maxLots} step={1}
                value={exitLots}
                onChange={e => setExitLots(Math.min(maxLots, Math.max(1, parseInt(e.target.value, 10) || 1)))}
                className={`w-28 h-9 bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-sm font-bold text-center rounded-lg px-3 ${FOCUS_RING}`}
              />
              <div className="flex items-center gap-1.5 flex-1">
                {maxLots > 1 && (
                  <button type="button" onClick={() => setExitLots(Math.max(1, Math.floor(maxLots / 2)))}
                    className={`flex-1 h-9 rounded-lg border border-zinc-700 bg-zinc-900 text-xs font-bold font-mono text-zinc-300 hover:bg-zinc-800 hover:text-white ${FOCUS_RING}`}>
                    Half
                  </button>
                )}
                <button type="button" onClick={() => setExitLots(maxLots)}
                  className={`flex-1 h-9 rounded-lg border border-zinc-700 bg-zinc-900 text-xs font-bold font-mono text-zinc-300 hover:bg-zinc-800 hover:text-white ${FOCUS_RING}`}>
                  All
                </button>
              </div>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-zinc-900 border border-zinc-800 space-y-2 text-xs font-mono">
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Order:</span>
              <span className="text-zinc-200 font-bold">{action} {exitQty} @ {orderType === 'LIMIT' ? (limitPrice > 0 ? `₹${limitPrice.toFixed(2)}` : '—') : 'MARKET'}</span>
            </div>
            <div className="flex items-center justify-between border-t border-zinc-800/80 pt-1.5">
              <span className="text-zinc-400">Remaining Position:</span>
              <span className="text-zinc-200 font-bold">{remaining > 0 ? `${remaining} Lots` : 'Fully closed'}</span>
            </div>
            <div className="flex items-center justify-between border-t border-zinc-800/80 pt-1.5">
              <span className="text-zinc-400">Projected P&amp;L on exit:</span>
              <span className={`font-bold ${projPnl == null ? 'text-zinc-500' : projPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{projPnl == null ? '—' : fmtMoney(projPnl)}</span>
            </div>
          </div>

          <div className="pt-2 flex items-center justify-end gap-2.5">
            <button type="button" onClick={onClose} disabled={submitting}
              className={`h-9 px-4 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300 text-xs font-bold hover:bg-zinc-800 hover:text-white transition-colors disabled:opacity-50 ${FOCUS_RING}`}>
              Cancel
            </button>
            <button type="submit" disabled={submitting || limitInvalid}
              className={`h-9 px-5 rounded-lg bg-rose-600 hover:bg-rose-500 text-oncolor text-xs font-bold shadow-lg transition-all flex items-center gap-1.5 disabled:opacity-50 ${FOCUS_RING}`}>
              <LogOut className="w-3.5 h-3.5" />
              {submitting ? 'Placing Order…' : `Confirm Exit ${lots} Lot${lots > 1 ? 's' : ''}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
