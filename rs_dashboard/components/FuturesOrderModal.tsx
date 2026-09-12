'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  X,
  TrendingUp,
  TrendingDown,
  Shield,
  Target,
  Zap,
  Clock,
  Wallet,
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Sliders,
} from 'lucide-react';
import type { FuturesLookupData } from '@/app/api/futures/order/route';
import { fmtPrice, fmtLakhRs } from '@/lib/futuresFormatters';

export interface FuturesOrderInitialState {
  symbol: string;
  expiry?: string;
  side: 'BUY' | 'SELL';
  price?: number;
  lotSize?: number;
  initialLots?: number;
  productType?: 'INTRADAY' | 'MARGIN';
  stopLoss?: number;
  target?: number;
}

interface FuturesOrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialOrder: FuturesOrderInitialState | null;
  onOrderSuccess?: (orderId: string, details: string) => void;
}

export default function FuturesOrderModal({
  isOpen,
  onClose,
  initialOrder,
  onOrderSuccess,
}: FuturesOrderModalProps) {
  // ─── Committed order state ──────────────────────────────────────────────────
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [productType, setProductType] = useState<'INTRADAY' | 'MARGIN'>('INTRADAY');
  const [lots, setLots] = useState<number>(1);
  // Committed limit price string — the value used for computations and submission
  const [limitPrice, setLimitPrice] = useState<string>('');

  // ─── Draft inputs (commit-on-blur) ─────────────────────────────────────────
  // Per dhan-commit-on-blur skill: free-typed inputs that feed order parameters
  // must NOT update the committed state on every keystroke. Partial values like
  // clearing "1" to type "15" would briefly read as "1" and snap back.
  const [lotsDraft, setLotsDraft] = useState<string>('1');
  const [limitPriceDraft, setLimitPriceDraft] = useState<string>('');

  // ─── Reference-only fields from the trade plan (not sent to broker) ─────────
  const [stopLossRef, setStopLossRef] = useState<number | null>(null);
  const [targetRef, setTargetRef] = useState<number | null>(null);

  // ─── Async / UI state ────────────────────────────────────────────────────────
  const [contractData, setContractData] = useState<FuturesLookupData | null>(null);
  const [loadingContract, setLoadingContract] = useState<boolean>(false);
  const [placingOrder, setPlacingOrder] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successResult, setSuccessResult] = useState<{ orderId: string; summary: string } | null>(null);

  // ─── Out-of-order guard for fetchContract ────────────────────────────────────
  // Per dhan-polling-guards skill: a stale in-flight fetch resolving after a
  // newer one would overwrite a fresh LTP with outdated data.
  const fetchSeqRef = useRef(0);

  // ─── Commit helpers ──────────────────────────────────────────────────────────

  /** Called on blur or Enter from the lots text field. */
  const commitLots = useCallback((raw: string) => {
    const n = Math.max(1, parseInt(raw, 10) || 1);
    setLots(n);
    setLotsDraft(String(n));
  }, []);

  /** Called on blur or Enter from the limit price field. */
  const commitLimitPrice = useCallback((raw: string) => {
    setLimitPrice(raw);
    setLimitPriceDraft(raw);
  }, []);

  /** Helper to set both committed and draft lots atomically (used by steppers and presets). */
  const setLotsImmediate = useCallback((n: number) => {
    setLots(n);
    setLotsDraft(String(n));
  }, []);

  /** Helper to set both committed and draft limit price atomically (used by fetchContract). */
  const setLimitPriceImmediate = useCallback((s: string) => {
    setLimitPrice(s);
    setLimitPriceDraft(s);
  }, []);

  // ─── Sync initial state when modal opens ────────────────────────────────────
  useEffect(() => {
    if (isOpen && initialOrder) {
      setSide(initialOrder.side || 'BUY');
      setProductType(initialOrder.productType || 'INTRADAY');
      const initLots = initialOrder.initialLots || 1;
      setLots(initLots);
      setLotsDraft(String(initLots));
      setOrderType('MARKET');
      setErrorMsg(null);
      setSuccessResult(null);
      setContractData(null);

      if (initialOrder.price) {
        setLimitPriceImmediate(initialOrder.price.toFixed(2));
      } else {
        setLimitPriceImmediate('');
      }

      setStopLossRef(initialOrder.stopLoss ?? null);
      setTargetRef(initialOrder.target ?? null);

      // Fetch verified contract details (lot size, security ID, live LTP)
      fetchContract(initialOrder.symbol, initialOrder.expiry);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialOrder]);

  // ─── Contract lookup with staleness guard ────────────────────────────────────
  const fetchContract = useCallback(async (symbol: string, expiry?: string) => {
    const seq = ++fetchSeqRef.current;
    setLoadingContract(true);
    setErrorMsg(null);
    try {
      let url = `/api/futures/order?symbol=${encodeURIComponent(symbol)}`;
      if (expiry) url += `&expiry=${encodeURIComponent(expiry)}`;
      const res = await fetch(url);
      const json = await res.json();
      if (seq !== fetchSeqRef.current) return; // stale — a newer fetch is in flight
      if (!json.success || !json.data) {
        throw new Error(json.error ?? 'Contract details could not be resolved');
      }
      setContractData(json.data);
      if (json.data.ltp && json.data.ltp > 0) {
        setLimitPriceImmediate(json.data.ltp.toFixed(2));
      }
    } catch (err: unknown) {
      if (seq !== fetchSeqRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : 'Failed to lookup contract');
    } finally {
      if (seq === fetchSeqRef.current) setLoadingContract(false);
    }
  }, [setLimitPriceImmediate]);

  // ─── Keyboard: Escape closes modal ──────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // ─── Derived economics ───────────────────────────────────────────────────────
  const lotSize = contractData?.lotSize ?? initialOrder?.lotSize ?? 1;
  const totalQty = lots * lotSize;
  const currentLtp = contractData?.ltp ?? initialOrder?.price ?? 0;
  const execPrice = orderType === 'LIMIT' ? parseFloat(limitPrice) || currentLtp : currentLtp;
  const contractTurnover = execPrice * totalQty;

  // ─── Margin estimates ────────────────────────────────────────────────────────
  // MCX margin requirements differ substantially from NSE F&O:
  //   MCX: ~2.5% MIS, ~4% NRML (SPAN-based, much lower than equity F&O)
  //   NSE Index: ~10% MIS, ~19% NRML
  //   NSE Stocks: ~12% MIS, ~23% NRML
  const isMcx = contractData?.exchangeSegment === 'MCX_COMM';
  const isStock = contractData?.instrument === 'FUTSTK';
  const marginPct = isMcx
    ? (productType === 'INTRADAY' ? 0.025 : 0.04)
    : productType === 'INTRADAY'
      ? (isStock ? 0.12 : 0.10)
      : (isStock ? 0.23 : 0.19);
  const estimatedMargin = contractTurnover * marginPct;

  // ─── Order placement ─────────────────────────────────────────────────────────
  const handlePlaceOrder = async () => {
    if (!initialOrder?.symbol) return;
    setErrorMsg(null);
    setSuccessResult(null);

    if (orderType === 'LIMIT') {
      const p = parseFloat(limitPrice);
      if (isNaN(p) || p <= 0) {
        setErrorMsg('Please enter a valid limit price greater than 0');
        return;
      }
    }

    if (!Number.isInteger(lots) || lots <= 0) {
      setErrorMsg('Please enter a valid positive number of lots');
      return;
    }

    setPlacingOrder(true);

    try {
      const payload = {
        symbol: initialOrder.symbol,
        expiry: contractData?.expiry || initialOrder.expiry,
        side,
        lots,
        orderType,
        price: orderType === 'LIMIT' ? parseFloat(limitPrice) : 0,
        productType,
      };

      const res = await fetch('/api/futures/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      if (!json.success || !json.orderId) {
        throw new Error(json.error || 'Broker rejected futures order');
      }

      // Include product type in summary — per dhan-broker-positions skill,
      // position identity is (symbol, product). The user needs to know which
      // product was booked in order to correctly close the position later.
      const summary = `${side} ${lots}L (${totalQty} qty) ${contractData?.displayName || initialOrder.symbol} @ ${orderType} · ${productType}`;
      setSuccessResult({
        orderId: json.orderId,
        summary,
      });

      if (onOrderSuccess) {
        onOrderSuccess(json.orderId, summary);
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Order submission failed');
    } finally {
      setPlacingOrder(false);
    }
  };

  if (!isOpen) return null;

  const isBuy = side === 'BUY';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/70 backdrop-blur-md">
      <div className="relative w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 text-zinc-200">

        {/* Modal Top Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 bg-zinc-900/80">
          <div className="flex items-center gap-2.5">
            <div className={`h-8 w-8 rounded-lg flex items-center justify-center ${
              isBuy ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-red-400'
            }`}>
              {isBuy ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white font-mono tracking-tight">
                  {contractData?.displayName || `${initialOrder?.symbol} FUT`}
                </h2>
                {contractData?.expiry && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
                    Exp: {contractData.expiry}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-zinc-400">
                Segment: <span className="font-mono text-zinc-300">{contractData?.exchangeSegment || 'NSE_FNO'}</span> · Lot: <span className="font-mono text-white font-bold">{lotSize}</span>
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

        {/* Live LTP & Contract Quote Banner */}
        <div className="px-5 py-3 border-b border-zinc-800/80 bg-zinc-900/30 flex items-center justify-between">
          <div className="flex items-baseline gap-2.5">
            <span className="text-[11px] text-zinc-400">Live LTP:</span>
            <span className="text-lg font-mono font-bold text-white tabular-nums">
              {loadingContract ? (
                <span className="text-zinc-500 text-xs">Fetching...</span>
              ) : currentLtp > 0 ? (
                `₹${fmtPrice(currentLtp)}`
              ) : (
                '—'
              )}
            </span>
          </div>
          <button
            onClick={() => initialOrder?.symbol && fetchContract(initialOrder.symbol, initialOrder.expiry)}
            disabled={loadingContract}
            className="flex items-center gap-1 text-[10px] text-zinc-400 hover:text-white transition-colors cursor-pointer"
            title="Refresh live contract quote"
          >
            <RefreshCw className={`h-3 w-3 ${loadingContract ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {/* Modal Content / Form */}
        <div className="p-5 space-y-4 text-xs">

          {/* 1. BUY / SELL Side Toggle */}
          <div>
            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block mb-1.5">
              Order Side
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setSide('BUY')}
                className={`flex items-center justify-center gap-2 py-2 rounded-xl font-bold transition-all cursor-pointer ${
                  isBuy
                    ? 'bg-emerald-600 text-oncolor shadow-md shadow-emerald-900/30 ring-1 ring-emerald-400/50'
                    : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <TrendingUp className="h-4 w-4" />
                BUY / LONG
              </button>
              <button
                type="button"
                onClick={() => setSide('SELL')}
                className={`flex items-center justify-center gap-2 py-2 rounded-xl font-bold transition-all cursor-pointer ${
                  !isBuy
                    ? 'bg-rose-600 text-oncolor shadow-md shadow-rose-900/30 ring-1 ring-rose-400/50'
                    : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <TrendingDown className="h-4 w-4" />
                SELL / SHORT
              </button>
            </div>
          </div>

          {/* 2. Product Type: INTRADAY (MIS) vs MARGIN (NRML) */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                Product Type
              </label>
              <span className="text-[10px] text-zinc-400">
                {productType === 'INTRADAY' ? 'MIS (Auto square-off at 15:15)' : 'NRML (Overnight / Till expiry)'}
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

          {/* 3. Order Type: MARKET vs LIMIT */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block mb-1.5">
                Order Type
              </label>
              <div className="flex rounded-xl bg-zinc-900 border border-zinc-800 p-1">
                <button
                  type="button"
                  onClick={() => setOrderType('MARKET')}
                  className={`flex-1 py-1 text-center rounded-lg font-semibold transition-colors cursor-pointer ${
                    orderType === 'MARKET' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  MARKET
                </button>
                <button
                  type="button"
                  onClick={() => setOrderType('LIMIT')}
                  className={`flex-1 py-1 text-center rounded-lg font-semibold transition-colors cursor-pointer ${
                    orderType === 'LIMIT' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  LIMIT
                </button>
              </div>
            </div>

            {/* Limit Price input — commit-on-blur/Enter; Escape reverts draft */}
            <div>
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block mb-1.5">
                Limit Price (₹)
              </label>
              <input
                type="number"
                step="0.05"
                disabled={orderType !== 'LIMIT'}
                value={limitPriceDraft}
                onChange={e => setLimitPriceDraft(e.target.value)}
                onBlur={e => { if (orderType === 'LIMIT') commitLimitPrice(e.currentTarget.value); }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && orderType === 'LIMIT') {
                    commitLimitPrice((e.target as HTMLInputElement).value);
                    (e.target as HTMLInputElement).blur();
                  }
                  if (e.key === 'Escape') setLimitPriceDraft(limitPrice); // revert
                }}
                placeholder="0.00"
                className={`w-full px-3 py-1.5 rounded-xl border bg-zinc-900 font-mono text-white text-xs focus:outline-none transition-colors ${
                  orderType === 'LIMIT'
                    ? 'border-sky-500/50 focus:border-sky-400'
                    : 'border-zinc-800 opacity-40 cursor-not-allowed'
                }`}
              />
            </div>
          </div>

          {/* 4. Quantity / Lots — commit-on-blur/Enter; steppers and presets are immediate */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                Quantity (Lots)
              </label>
              <span className="text-[10px] font-mono text-zinc-300">
                Total: <strong className="text-white">{totalQty}</strong> units ({lots} lot{lots > 1 ? 's' : ''} × {lotSize})
              </span>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center rounded-xl bg-zinc-900 border border-zinc-800 flex-1 overflow-hidden">
                {/* − stepper: immediate (discrete button click) */}
                <button
                  type="button"
                  onClick={() => setLotsImmediate(Math.max(1, lots - 1))}
                  className="px-3 py-1.5 text-sm font-bold text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  −
                </button>
                {/* Typed lots: commit on blur / Enter; Escape reverts draft */}
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={lotsDraft}
                  onChange={e => setLotsDraft(e.target.value)}
                  onBlur={e => commitLots(e.currentTarget.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      commitLots((e.target as HTMLInputElement).value);
                      (e.target as HTMLInputElement).blur();
                    }
                    if (e.key === 'Escape') setLotsDraft(String(lots)); // revert
                  }}
                  className="w-full text-center bg-transparent font-mono font-bold text-white text-sm focus:outline-none"
                />
                {/* + stepper: immediate */}
                <button
                  type="button"
                  onClick={() => setLotsImmediate(lots + 1)}
                  className="px-3 py-1.5 text-sm font-bold text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  +
                </button>
              </div>

              {/* Quick Lot Presets — discrete choice, immediate */}
              <div className="flex items-center gap-1">
                {[1, 2, 3, 5].map(preset => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setLotsImmediate(preset)}
                    className={`px-2.5 py-1.5 rounded-lg font-mono text-xs font-semibold transition-colors cursor-pointer ${
                      lots === preset
                        ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                        : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {preset}L
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 5. Execution Summary & Margin Calculations */}
          <div className="p-3 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-1.5 font-mono text-[11px]">
            <div className="flex items-center justify-between text-zinc-400">
              <span>Contract Turnover:</span>
              <span className="text-zinc-200 font-semibold">{fmtLakhRs(contractTurnover)}</span>
            </div>
            <div className="flex items-center justify-between text-zinc-400">
              <span className="flex items-center gap-1">
                <Wallet className="h-3 w-3 text-sky-400" />
                Est. Margin Required:
              </span>
              <span className="text-sky-300 font-bold">
                {fmtLakhRs(estimatedMargin)} <span className="text-[9px] text-zinc-500">({(marginPct * 100).toFixed(1)}% {isMcx ? 'MCX' : isStock ? 'STK' : 'IDX'})</span>
              </span>
            </div>
          </div>

          {/* 6. Trade Plan Reference (SL / Target from SetupCard — NOT placed as broker orders) */}
          {(stopLossRef !== null || targetRef !== null) && (
            <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/50 space-y-1.5 font-mono text-[11px]">
              <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest mb-1">
                Trade Plan · Reference Only · Not placed as orders
              </p>
              {stopLossRef !== null && (
                <div className="flex items-center justify-between text-zinc-400">
                  <span>Stop Loss Ref:</span>
                  <span className="text-red-400 font-semibold">₹{fmtPrice(stopLossRef)}</span>
                </div>
              )}
              {targetRef !== null && (
                <div className="flex items-center justify-between text-zinc-400">
                  <span>Target Ref:</span>
                  <span className="text-emerald-400 font-semibold">₹{fmtPrice(targetRef)}</span>
                </div>
              )}
            </div>
          )}

          {/* Feedback Banners */}
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
                Order Submitted Successfully!
              </div>
              <p className="text-[11px] text-zinc-300 font-mono">
                Order ID: <span className="text-white font-bold">{successResult.orderId}</span>
              </p>
              <p className="text-[11px] text-zinc-400">{successResult.summary}</p>
            </div>
          )}
        </div>

        {/* Modal Footer / Action Button */}
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
            disabled={placingOrder || loadingContract}
            onClick={handlePlaceOrder}
            className={`flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-xl text-xs font-bold transition-all shadow-md cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
              isBuy
                ? 'bg-emerald-600 hover:bg-emerald-500 text-oncolor shadow-emerald-950/40'
                : 'bg-rose-600 hover:bg-rose-500 text-oncolor shadow-rose-950/40'
            }`}
          >
            {placingOrder ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Placing Futures Order…
              </>
            ) : (
              <>
                {isBuy ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                PLACE {side} ORDER ({totalQty} QTY)
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
