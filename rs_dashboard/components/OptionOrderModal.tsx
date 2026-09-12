'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  X,
  Zap,
  TrendingDown,
  TrendingUp,
  Shield,
  Wallet,
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { fmtPrice, fmtLakhRs } from '@/lib/futuresFormatters';

export interface OptionTradeLeg {
  strike: number;
  optionType: 'CE' | 'PE';
  action: 'BUY' | 'SELL';
  lots: number;
  securityId?: string;
}

export interface OptionOrderInitialState {
  title: string;
  underlying: string;
  expiry: string;
  legs: OptionTradeLeg[];
  defaultLots?: number;
  lotSize?: number;
  productType?: 'INTRADAY' | 'MARGIN';
}

interface OptionOrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialOrder: OptionOrderInitialState | null;
  onOrderSuccess?: (orderIds: string[], summary: string) => void;
}

const MAX_LOTS_PER_ORDER = 50;

export default function OptionOrderModal({
  isOpen,
  onClose,
  initialOrder,
  onOrderSuccess,
}: OptionOrderModalProps) {
  const [productType, setProductType] = useState<'INTRADAY' | 'MARGIN'>('INTRADAY');
  const [lotsMultiplier, setLotsMultiplier] = useState<number>(1);
  const [lotsDraft, setLotsDraft] = useState<string>('1');

  // Resolved strikes and contract data
  const [lotSize, setLotSize] = useState<number>(1);
  const [resolvedLegs, setResolvedLegs] = useState<(OptionTradeLeg & { ltp?: number; securityId?: string })[]>([]);
  const [loadingLookup, setLoadingLookup] = useState<boolean>(false);
  const [placingOrder, setPlacingOrder] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successResult, setSuccessResult] = useState<{ orderIds: string[]; summary: string } | null>(null);

  // Out-of-order guard
  const fetchSeqRef = useRef(0);

  // Commit-on-blur for lots
  const commitLots = useCallback((raw: string) => {
    const n = Math.min(MAX_LOTS_PER_ORDER, Math.max(1, parseInt(raw, 10) || 1));
    setLotsMultiplier(n);
    setLotsDraft(String(n));
  }, []);

  const setLotsImmediate = useCallback((n: number) => {
    const clamped = Math.min(MAX_LOTS_PER_ORDER, Math.max(1, n));
    setLotsMultiplier(clamped);
    setLotsDraft(String(clamped));
  }, []);

  // Keyboard Escape listener
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Lookup contract security IDs and lot size when modal opens
  const fetchOptionDetails = useCallback(async (underlying: string, expiry: string, baseLegs: OptionTradeLeg[]) => {
    const seq = ++fetchSeqRef.current;
    setLoadingLookup(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/scalper/lookup?underlying=${encodeURIComponent(underlying.toUpperCase())}&expiry=${encodeURIComponent(expiry)}`);
      const json = await res.json();
      if (seq !== fetchSeqRef.current) return;
      if (!json.success || !json.data) {
        throw new Error(json.error ?? 'Option chain contract details could not be resolved');
      }

      const chainLot = json.data.lotSize || 1;
      setLotSize(chainLot);

      // Match each leg to its securityId
      const strikesMap = json.data.strikes || {};
      const updated = baseLegs.map((leg) => {
        const strikeEntry = strikesMap[String(leg.strike)];
        const secId = (leg.optionType === 'CE' ? strikeEntry?.ceId : strikeEntry?.peId) || leg.securityId;
        return {
          ...leg,
          securityId: secId,
        };
      });

      setResolvedLegs(updated);
    } catch (err: unknown) {
      if (seq !== fetchSeqRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : 'Failed to lookup option security IDs');
    } finally {
      if (seq === fetchSeqRef.current) setLoadingLookup(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen && initialOrder) {
      setProductType(initialOrder.productType || 'INTRADAY');
      const initLots = initialOrder.defaultLots || 1;
      setLotsMultiplier(initLots);
      setLotsDraft(String(initLots));
      setErrorMsg(null);
      setSuccessResult(null);
      setResolvedLegs(initialOrder.legs);

      fetchOptionDetails(initialOrder.underlying, initialOrder.expiry, initialOrder.legs);
    }
  }, [isOpen, initialOrder, fetchOptionDetails]);

  // Handle Order Placement
  const handlePlaceOrder = async () => {
    if (!initialOrder) return;
    setErrorMsg(null);
    setSuccessResult(null);

    // Validation
    if (lotsMultiplier <= 0 || lotsMultiplier > MAX_LOTS_PER_ORDER) {
      setErrorMsg(`Lots must be between 1 and ${MAX_LOTS_PER_ORDER}`);
      return;
    }

    const missingSecId = resolvedLegs.find((l) => !l.securityId);
    if (missingSecId) {
      setErrorMsg(`Contract ID missing for ${missingSecId.strike} ${missingSecId.optionType}. Please click Refresh.`);
      return;
    }

    setPlacingOrder(true);

    try {
      const underUpper = initialOrder.underlying.toUpperCase();
      const exchangeSegment =
        underUpper === 'SENSEX' ? 'BSE_FNO' : (underUpper === 'CRUDEOIL' || underUpper === 'CRUDEOILM') ? 'MCX_COMM' : 'NSE_FNO';

      const payloadLegs = resolvedLegs.map((leg) => {
        const totalLegLots = leg.lots * lotsMultiplier;
        const totalQty = totalLegLots * lotSize;
        return {
          securityId: String(leg.securityId),
          quantity: totalQty,
          side: leg.action,
          orderType: 'MARKET',
          exchangeSegment,
        };
      });

      const res = await fetch('/api/options/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          legs: payloadLegs,
          mode: productType === 'MARGIN' ? 'positional' : 'intraday',
        }),
      });

      const json = await res.json();
      if (!json.success) {
        throw new Error(json.error || 'Failed to place spread options order');
      }

      const orderIds: string[] = (json.data || []).map((d: { orderId: string }) => d.orderId).filter(Boolean);
      const summary = `${initialOrder.title} · ${lotsMultiplier}x (${lotsMultiplier * lotSize} qty) · ${productType}`;

      setSuccessResult({
        orderIds,
        summary,
      });

      if (onOrderSuccess) {
        onOrderSuccess(orderIds, summary);
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Order submission failed');
    } finally {
      setPlacingOrder(false);
    }
  };

  if (!isOpen || !initialOrder) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/70 backdrop-blur-md">
      <div className="relative w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 text-zinc-200">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 bg-zinc-900/80">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-sky-500/20 text-sky-400 flex items-center justify-center">
              <Zap className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-tight">
                  Trade {initialOrder.title}
                </h2>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
                  Exp: {initialOrder.expiry}
                </span>
              </div>
              <p className="text-[10px] text-zinc-400">
                Underlying: <span className="font-mono text-white font-bold">{initialOrder.underlying}</span> · Lot Size: <span className="font-mono text-white font-bold">{lotSize}</span>
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 space-y-4 text-xs">
          {/* 1. Product Type Selector */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                Product Type
              </label>
              <span className="text-[10px] text-zinc-400">
                {productType === 'INTRADAY' ? 'MIS (Auto square-off at 15:15)' : 'NRML (Overnight position)'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setProductType('INTRADAY')}
                className={`py-1.5 px-3 rounded-xl font-semibold text-center transition-all cursor-pointer ${
                  productType === 'INTRADAY'
                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                    : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                INTRADAY (MIS)
              </button>
              <button
                type="button"
                onClick={() => setProductType('MARGIN')}
                className={`py-1.5 px-3 rounded-xl font-semibold text-center transition-all cursor-pointer ${
                  productType === 'MARGIN'
                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                    : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                MARGIN (NRML)
              </button>
            </div>
          </div>

          {/* 2. Spread Legs Breakdown */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                Basket Legs
              </label>
              <button
                type="button"
                onClick={() => fetchOptionDetails(initialOrder.underlying, initialOrder.expiry, initialOrder.legs)}
                disabled={loadingLookup}
                className="flex items-center gap-1 text-[10px] text-zinc-400 hover:text-white cursor-pointer"
              >
                <RefreshCw className={`h-3 w-3 ${loadingLookup ? 'animate-spin' : ''}`} />
                Reload IDs
              </button>
            </div>

            <div className="space-y-1.5">
              {resolvedLegs.map((leg, idx) => {
                const isBuy = leg.action === 'BUY';
                const legQty = leg.lots * lotsMultiplier * lotSize;
                return (
                  <div
                    key={idx}
                    className="flex items-center justify-between p-2.5 rounded-xl border border-zinc-800 bg-zinc-900/60 font-mono text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        isBuy ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-red-400 border border-rose-500/30'
                      }`}>
                        {leg.action}
                      </span>
                      <span className="font-bold text-white">
                        {leg.strike} {leg.optionType}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 text-right text-[11px]">
                      <span className="text-zinc-400">
                        {leg.lots * lotsMultiplier} lot{leg.lots * lotsMultiplier > 1 ? 's' : ''} (<strong className="text-white">{legQty}</strong> qty)
                      </span>
                      <span className="text-[10px] text-zinc-500">
                        {leg.securityId ? `ID: ${leg.securityId}` : <span className="text-amber-400">Resolving...</span>}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 3. Multiplier / Quantity Stepper (Commit-on-blur) */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                Order Multiplier (Lots)
              </label>
              <span className="text-[10px] font-mono text-zinc-400">
                Max {MAX_LOTS_PER_ORDER} lots per basket
              </span>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center rounded-xl bg-zinc-900 border border-zinc-800 flex-1 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setLotsImmediate(lotsMultiplier - 1)}
                  className="px-3 py-1.5 text-sm font-bold text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  −
                </button>
                <input
                  type="number"
                  min="1"
                  max={MAX_LOTS_PER_ORDER}
                  value={lotsDraft}
                  onChange={(e) => setLotsDraft(e.target.value)}
                  onBlur={(e) => commitLots(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      commitLots((e.target as HTMLInputElement).value);
                      (e.target as HTMLInputElement).blur();
                    }
                    if (e.key === 'Escape') setLotsDraft(String(lotsMultiplier));
                  }}
                  className="w-full text-center bg-transparent font-mono font-bold text-white text-sm focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setLotsImmediate(lotsMultiplier + 1)}
                  className="px-3 py-1.5 text-sm font-bold text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  +
                </button>
              </div>

              {/* Quick presets */}
              <div className="flex items-center gap-1">
                {[1, 2, 3, 5].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setLotsImmediate(preset)}
                    className={`px-2.5 py-1.5 rounded-lg font-mono text-xs font-semibold transition-colors cursor-pointer ${
                      lotsMultiplier === preset
                        ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                        : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {preset}x
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Feedback Messages */}
          {errorMsg && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {successResult && (
            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs space-y-1">
              <div className="flex items-center gap-1.5 font-bold">
                <CheckCircle2 className="h-4 w-4" />
                Spread Orders Dispatched Successfully!
              </div>
              <p className="text-[11px] text-zinc-300 font-mono">
                Order IDs: <span className="text-white font-bold">{successResult.orderIds.join(', ')}</span>
              </p>
              <p className="text-[11px] text-zinc-400">{successResult.summary}</p>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-4 border-t border-zinc-800 bg-zinc-900/80 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold rounded-xl border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white transition-colors cursor-pointer"
          >
            Cancel
          </button>

          <button
            type="button"
            disabled={placingOrder || loadingLookup || resolvedLegs.some((l) => !l.securityId)}
            onClick={handlePlaceOrder}
            className="flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-xl text-xs font-bold transition-all shadow-md cursor-pointer bg-sky-600 hover:bg-sky-500 text-oncolor disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {placingOrder ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Placing Options Orders…
              </>
            ) : (
              <>
                <Zap className="h-4 w-4" />
                SUBMIT BASKET ORDER ({resolvedLegs.length} LEGS)
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
