'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
  ChevronUp,
  ChevronDown,
  Lock,
} from 'lucide-react';
import { fmtPrice, fmtLakhRs } from '@/lib/futuresFormatters';
import type { LedgerBasket } from '@/lib/liveChartsLedger';

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

/** A leg exactly as it was placed - resolved securityId, product and final quantity - handed
 *  back to the caller so it can add the basket to its ownership ledger (see
 *  lib/liveChartsLedger.ts and the dhan-terminal-position-ownership skill). Never derived from
 *  a later broker read; this is what the modal itself just told the broker to do. */
export interface PlacedOptionLeg {
  securityId: string;
  exchangeSegment: string;
  strike: number;
  optionType: 'CE' | 'PE';
  action: 'BUY' | 'SELL';
  qty: number;
  productType: 'INTRADAY' | 'MARGIN';
}

interface OptionOrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialOrder: OptionOrderInitialState | null;
  onOrderSuccess?: (orderIds: string[], summary: string, legs: PlacedOptionLeg[], underlying: string, expiry: string, title: string) => void;
  /** This page's own traded baskets (see lib/liveChartsLedger.ts), used only to detect an
   *  already-open position at the strike being traded so the product type can be matched to
   *  it - never to size or originate an order (ownership stays the ledger's job, per the
   *  dhan-terminal-position-ownership skill). Omitted by callers with no such ledger. */
  existingBaskets?: LedgerBasket[];
}

const MAX_LOTS_PER_ORDER = 50;
type OrderTypeChoice = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
const ORDER_TYPE_LABELS: Record<OrderTypeChoice, string> = {
  MARKET: 'Market',
  LIMIT: 'Limit',
  SL: 'SL',
  'SL-M': 'SL-M',
};

export default function OptionOrderModal({
  isOpen,
  onClose,
  initialOrder,
  onOrderSuccess,
  existingBaskets,
}: OptionOrderModalProps) {
  const [productType, setProductType] = useState<'INTRADAY' | 'MARGIN'>('INTRADAY');
  const [productTypeLock, setProductTypeLock] = useState<'INTRADAY' | 'MARGIN' | null>(null);
  const [lotsMultiplier, setLotsMultiplier] = useState<number>(1);
  const [lotsDraft, setLotsDraft] = useState<string>('1');

  // Order type + price/trigger (LIMIT and SL/SL-M only) - commit-on-blur so a mid-type value
  // (e.g. "5" while typing "500") can never fire against the live basket.
  const [orderType, setOrderType] = useState<OrderTypeChoice>('MARKET');
  const [priceDraft, setPriceDraft] = useState<string>('');
  const [price, setPrice] = useState<number>(0);
  const [triggerDraft, setTriggerDraft] = useState<string>('');
  const [triggerPrice, setTriggerPrice] = useState<number>(0);

  const commitPrice = useCallback((raw: string) => {
    const n = Math.max(0, parseFloat(raw) || 0);
    setPrice(n);
    setPriceDraft(n > 0 ? String(n) : '');
  }, []);

  const commitTrigger = useCallback((raw: string) => {
    const n = Math.max(0, parseFloat(raw) || 0);
    setTriggerPrice(n);
    setTriggerDraft(n > 0 ? String(n) : '');
  }, []);

  // Resolved strikes and contract data
  const [lotSize, setLotSize] = useState<number>(1);
  const [resolvedLegs, setResolvedLegs] = useState<(OptionTradeLeg & { ltp?: number; securityId?: string })[]>([]);
  // Every strike on this expiry's chain -> {ceId, peId}, from the same lookup that resolved the
  // initial legs. Powers the strike up/down stepper without a second round-trip per click.
  const [strikesMap, setStrikesMap] = useState<Record<string, { ceId?: string; peId?: string }>>({});
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
      const chainStrikes = json.data.strikes || {};
      setStrikesMap(chainStrikes);
      const updated = baseLegs.map((leg) => {
        const strikeEntry = chainStrikes[String(leg.strike)];
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
      setStrikesMap({});
      setOrderType('MARKET');
      setPriceDraft('');
      setPrice(0);
      setTriggerDraft('');
      setTriggerPrice(0);

      fetchOptionDetails(initialOrder.underlying, initialOrder.expiry, initialOrder.legs);
    }
  }, [isOpen, initialOrder, fetchOptionDetails]);

  // A straddle-shaped basket - every leg at one common strike - is the only shape the strike
  // stepper (and the product-type match below) apply to; a strangle/multi-strike strategy has
  // no single "the strike" to shift.
  const commonStrike = useMemo(() => {
    const strikes = new Set(resolvedLegs.map((l) => l.strike));
    return strikes.size === 1 ? resolvedLegs[0]?.strike ?? null : null;
  }, [resolvedLegs]);

  const sortedChainStrikes = useMemo(
    () => Object.keys(strikesMap).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b),
    [strikesMap],
  );

  const adjustStrike = useCallback(
    (direction: 1 | -1) => {
      if (commonStrike === null || sortedChainStrikes.length === 0) return;
      const idx = sortedChainStrikes.indexOf(commonStrike);
      const nextIdx = idx === -1 ? -1 : idx + direction;
      if (nextIdx < 0 || nextIdx >= sortedChainStrikes.length) return;
      const nextStrike = sortedChainStrikes[nextIdx];
      const entry = strikesMap[String(nextStrike)];
      setResolvedLegs((prev) =>
        prev.map((leg) => ({
          ...leg,
          strike: nextStrike,
          securityId: (leg.optionType === 'CE' ? entry?.ceId : entry?.peId) ?? undefined,
        })),
      );
    },
    [commonStrike, sortedChainStrikes, strikesMap],
  );

  // Product type follows whatever is already open at this strike - Dhan nets by security ID, so
  // trading the same strike under a different product type here would sit alongside the existing
  // position as a separate book rather than adding to it (exactly what happened 2026-09:  2 lots
  // already open at 23350 under MARGIN, a fresh sell at 23350 went out INTRADAY instead).
  //
  // Checked two ways, broker first:
  //  1. The broker's live position book - the source of truth, and the only one that survives a
  //     page reload or a position opened in an earlier session/tab, which this page's own ledger
  //     (in-memory React state) does not. Reading it here only decides which dropdown value a new
  //     order uses - it never sizes an exit or originates ownership of a quantity, so it doesn't
  //     fall under the ledger-only rule in dhan-terminal-position-ownership (that rule guards
  //     exit sizing / P&L attribution, not this kind of product-type lookup).
  //  2. This page's own ledger, as a fallback for an order just placed whose fill the broker's
  //     position book hasn't caught up to yet (same race the ledger's own reconcile grace window
  //     exists for).
  useEffect(() => {
    if (!isOpen || !initialOrder || commonStrike === null) {
      setProductTypeLock(null);
      return;
    }
    let cancelled = false;

    const secIds = new Set(resolvedLegs.map((l) => String(l.securityId)).filter(Boolean));
    if (secIds.size > 0) {
      fetch('/api/scalper/positions')
        .then((res) => res.json())
        .then((json) => {
          if (cancelled) return;
          if (json.success && Array.isArray(json.data)) {
            const rows = json.data as Record<string, unknown>[];
            const match = rows.find((row) => {
              const secId = String(row.securityId ?? row.security_id ?? '');
              if (!secIds.has(secId)) return false;
              const netQty = Number(row.netQty ?? row.net_qty ?? 0);
              return Number.isFinite(netQty) && netQty !== 0;
            });
            const product = match
              ? String(match.productType ?? match.product ?? '').trim().toUpperCase()
              : '';
            if (product === 'INTRADAY' || product === 'MARGIN') {
              setProductType(product);
              setProductTypeLock(product);
              return;
            }
          }
          applyLedgerFallback();
        })
        .catch(() => {
          if (!cancelled) applyLedgerFallback();
        });
    } else {
      applyLedgerFallback();
    }

    function applyLedgerFallback() {
      if (cancelled) return;
      const match = (existingBaskets ?? [])
        .filter(
          (b) =>
            b.underlying.toUpperCase() === initialOrder!.underlying.toUpperCase() &&
            b.expiry === initialOrder!.expiry,
        )
        .flatMap((b) => b.legs)
        .find((l) => l.qty > 0 && l.strike === commonStrike);
      if (match) {
        setProductType(match.productType);
        setProductTypeLock(match.productType);
      } else {
        setProductTypeLock(null);
      }
    }

    return () => {
      cancelled = true;
    };
  }, [isOpen, initialOrder, commonStrike, existingBaskets, resolvedLegs]);

  // The title carries the strike, so a stepper-shifted straddle needs it recomputed rather than
  // showing the strike it was opened at.
  const displayTitle = useMemo(() => {
    if (commonStrike === null || !initialOrder) return initialOrder?.title ?? '';
    const hasCe = resolvedLegs.some((l) => l.optionType === 'CE');
    const hasPe = resolvedLegs.some((l) => l.optionType === 'PE');
    if (resolvedLegs.length === 2 && hasCe && hasPe) {
      return `${initialOrder.underlying} ${commonStrike} Straddle`;
    }
    return initialOrder.title;
  }, [commonStrike, resolvedLegs, initialOrder]);

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

    if (orderType === 'LIMIT' && !(price > 0)) {
      setErrorMsg('Enter a valid limit price');
      return;
    }
    if ((orderType === 'SL' || orderType === 'SL-M') && !(triggerPrice > 0)) {
      setErrorMsg('Enter a valid trigger price');
      return;
    }
    if (orderType === 'SL' && !(price > 0)) {
      setErrorMsg('SL orders require both a limit price and a trigger price');
      return;
    }

    setPlacingOrder(true);

    try {
      const underUpper = initialOrder.underlying.toUpperCase();
      const exchangeSegment =
        underUpper === 'SENSEX' ? 'BSE_FNO' : (underUpper === 'CRUDEOIL' || underUpper === 'CRUDEOILM') ? 'MCX_COMM' : 'NSE_FNO';
      const dhanOrderType = orderType === 'SL-M' ? 'STOP_LOSS_MARKET' : orderType === 'SL' ? 'STOP_LOSS' : orderType;

      const placedLegs: PlacedOptionLeg[] = resolvedLegs.map((leg) => ({
        securityId: String(leg.securityId),
        exchangeSegment,
        strike: leg.strike,
        optionType: leg.optionType,
        action: leg.action,
        qty: leg.lots * lotsMultiplier * lotSize,
        productType,
      }));

      const payloadLegs = placedLegs.map((leg) => ({
        securityId: leg.securityId,
        quantity: leg.qty,
        side: leg.action,
        orderType: dhanOrderType,
        exchangeSegment,
        ...(orderType === 'LIMIT' || orderType === 'SL' ? { price } : {}),
        ...(orderType === 'SL' || orderType === 'SL-M' ? { triggerPrice } : {}),
      }));

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
      const summary = `${displayTitle} · ${lotsMultiplier}x (${lotsMultiplier * lotSize} qty) · ${productType} · ${ORDER_TYPE_LABELS[orderType]}`;

      setSuccessResult({
        orderIds,
        summary,
      });

      if (onOrderSuccess) {
        onOrderSuccess(orderIds, summary, placedLegs, initialOrder.underlying, initialOrder.expiry, displayTitle);
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
                  Trade {displayTitle}
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
          {/* 0. Strike Stepper - only for a single-strike (straddle-shaped) basket; a strangle
              or multi-leg strategy has no one "the strike" to shift. */}
          {commonStrike !== null && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                  Strike
                </label>
                <span className="text-[10px] text-zinc-500">
                  {sortedChainStrikes.length > 0 ? 'Shift to any strike on this expiry' : 'Resolving chain…'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => adjustStrike(-1)}
                  disabled={sortedChainStrikes.indexOf(commonStrike) <= 0}
                  title="Lower strike"
                  className="p-2 rounded-xl border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
                <div className="flex-1 text-center font-mono font-bold text-white text-sm py-1.5 rounded-xl bg-zinc-900 border border-zinc-800">
                  {commonStrike}
                </div>
                <button
                  type="button"
                  onClick={() => adjustStrike(1)}
                  disabled={
                    sortedChainStrikes.length === 0 ||
                    sortedChainStrikes.indexOf(commonStrike) >= sortedChainStrikes.length - 1
                  }
                  title="Higher strike"
                  className="p-2 rounded-xl border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* 1. Product Type Selector */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                Product Type
              </label>
              <span className="text-[10px] text-zinc-400">
                {productTypeLock
                  ? `Locked - matches your open ${productTypeLock === 'INTRADAY' ? 'MIS' : 'NRML'} position at this strike`
                  : productType === 'INTRADAY' ? 'MIS (Auto square-off at 15:15)' : 'NRML (Overnight position)'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setProductType('INTRADAY')}
                disabled={!!productTypeLock}
                className={`flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-xl font-semibold text-center transition-all cursor-pointer disabled:cursor-not-allowed ${
                  productType === 'INTRADAY'
                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                    : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                } ${productTypeLock && productTypeLock !== 'INTRADAY' ? 'opacity-40' : ''}`}
              >
                {productTypeLock === 'INTRADAY' && <Lock className="h-3 w-3" />}
                INTRADAY (MIS)
              </button>
              <button
                type="button"
                onClick={() => setProductType('MARGIN')}
                disabled={!!productTypeLock}
                className={`flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-xl font-semibold text-center transition-all cursor-pointer disabled:cursor-not-allowed ${
                  productType === 'MARGIN'
                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                    : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                } ${productTypeLock && productTypeLock !== 'MARGIN' ? 'opacity-40' : ''}`}
              >
                {productTypeLock === 'MARGIN' && <Lock className="h-3 w-3" />}
                MARGIN (NRML)
              </button>
            </div>
          </div>

          {/* 1b. Order Type Selector */}
          <div>
            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider mb-1.5 block">
              Order Type
            </label>
            <div className="grid grid-cols-4 gap-2 mb-2">
              {(Object.keys(ORDER_TYPE_LABELS) as OrderTypeChoice[]).map((ot) => (
                <button
                  key={ot}
                  type="button"
                  onClick={() => setOrderType(ot)}
                  className={`py-1.5 px-2 rounded-xl font-semibold text-center text-xs transition-all cursor-pointer ${
                    orderType === ot
                      ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                      : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {ORDER_TYPE_LABELS[ot]}
                </button>
              ))}
            </div>

            {(orderType === 'LIMIT' || orderType === 'SL') && (
              <div className="mb-2">
                <label className="text-[10px] text-zinc-400 mb-1 block">Limit Price</label>
                <input
                  type="number"
                  step="0.05"
                  placeholder="0.00"
                  value={priceDraft}
                  onChange={(e) => setPriceDraft(e.target.value)}
                  onBlur={(e) => commitPrice(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      commitPrice((e.target as HTMLInputElement).value);
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  className="w-full py-1.5 px-3 rounded-xl bg-zinc-900 border border-zinc-800 font-mono text-sm text-white focus:outline-none focus:border-sky-500/50"
                />
              </div>
            )}

            {(orderType === 'SL' || orderType === 'SL-M') && (
              <div>
                <label className="text-[10px] text-zinc-400 mb-1 block">Trigger Price</label>
                <input
                  type="number"
                  step="0.05"
                  placeholder="0.00"
                  value={triggerDraft}
                  onChange={(e) => setTriggerDraft(e.target.value)}
                  onBlur={(e) => commitTrigger(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      commitTrigger((e.target as HTMLInputElement).value);
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  className="w-full py-1.5 px-3 rounded-xl bg-zinc-900 border border-zinc-800 font-mono text-sm text-white focus:outline-none focus:border-sky-500/50"
                />
              </div>
            )}
          </div>

          {/* 2. Spread Legs Breakdown */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                Basket Legs
              </label>
              <button
                type="button"
                onClick={() => fetchOptionDetails(initialOrder.underlying, initialOrder.expiry, resolvedLegs)}
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
