'use client';

import React, { useState, useEffect } from 'react';
import { Zap, ArrowUpRight, ArrowDownRight, Sparkles, Lock, Unlock, AlertOctagon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { cyberAudio } from '@/lib/cyberAudio';
import { MCX_LOT_MULTIPLIER } from '@/lib/positionPnl';

interface OptionContract {
  strike: number;
  security_id: string | null;
  trading_symbol: string | null;
  display_name?: string | null;
  ltp: number;
}

interface FutureContract {
  security_id: string | null;
  trading_symbol: string | null;
  display_name?: string | null;
  expiry?: string;
  lot_size?: number;
  ltp: number;
  all_expiries?: string[];
}

/** Underlyings whose future contract IS a directly tradeable instrument alongside its
 * options chain, per the feed script's `futures_capable` flag (cyber_scalper_feed.py).
 * Gates the Futures/Options mode toggle so it doesn't appear for symbols with no
 * `future` data behind it. */
const FUTURES_CAPABLE_SYMBOLS = new Set(['CRUDEOILM', 'NIFTY']);

/** "2026-09-29" -> "SEP" for the compact expiry-switcher buttons. */
function formatExpiryMonth(dateStr: string): string {
  const dt = new Date(dateStr);
  if (Number.isNaN(dt.getTime())) return dateStr;
  return dt.toLocaleDateString('en-IN', { month: 'short' }).toUpperCase();
}

interface OrderPadProps {
  symbol: string;
  spot: number;
  options: {
    atm_strike?: number;
    expiry?: string;
    all_expiries?: string[];
    lot_size?: number;
    ce?: OptionContract;
    pe?: OptionContract;
  } | null;
  future?: FutureContract | null;
  bias: string;
  isExecuting: boolean;
  onExecuteTrade: (params: {
    direction: 'BUY' | 'SELL';
    contractType: 'CE' | 'PE' | 'DIRECT';
    securityId?: string;
    tradingSymbol?: string;
    strike?: number;
    expiry?: string;
    lots: number;
    qty: number;
    orderType: 'MARKET' | 'LIMIT';
    productType: 'INTRADAY' | 'MARGIN';
    price?: number;
    targetPts?: number;
    slPts?: number;
  }) => Promise<void>;
  onFlattenAll: () => Promise<void>;
  onSelectFutureExpiry?: (expiry: string | null) => void;
  openPositionsCount: number;
  suggestedTargetPts?: number | null;
  suggestedSlPts?: number | null;
}

export default function CyberOrderPad({
  symbol,
  spot,
  options,
  future,
  bias,
  isExecuting,
  onExecuteTrade,
  onFlattenAll,
  onSelectFutureExpiry,
  openPositionsCount,
  suggestedTargetPts,
  suggestedSlPts,
}: OrderPadProps) {
  // Settings
  const [tradeMode, setTradeMode] = useState<'OPTIONS' | 'FUTURES'>('OPTIONS');
  const [lots, setLots] = useState<number>(1);
  const [tempLots, setTempLots] = useState<string>('1');
  // Every order from this terminal is a margin (NRML) trade — no intraday/MIS
  // mode here, so there is nothing for the user to pick.
  const productType = 'MARGIN' as const;
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [targetPts, setTargetPts] = useState<number | null>(30);
  const [slPts, setSlPts] = useState<number | null>(30);
  const [safetyLock, setSafetyLock] = useState<boolean>(false); // false = Instant 1-click execution!

  const futuresCapable = FUTURES_CAPABLE_SYMBOLS.has(symbol) && !!future;

  // Switching symbol away from a futures-capable one (or FUTURES mode having no data
  // for the new symbol) must not leave the pad stuck trying to trade a future that
  // doesn't exist for whatever is now selected.
  useEffect(() => {
    if (!futuresCapable && tradeMode === 'FUTURES') setTradeMode('OPTIONS');
  }, [futuresCapable, tradeMode]);

  const effectiveMode = futuresCapable ? tradeMode : 'OPTIONS';

  const lotSize = effectiveMode === 'FUTURES' ? (future?.lot_size || 1) : (options?.lot_size || 65);
  const totalQty = lots * lotSize;

  // Dhan's MCX order quantity is itself denominated in lots (get_lot_size returns 1 for
  // CRUDEOIL/CRUDEOILM, not the barrels-per-lot count), so totalQty above is already the
  // correct order qty to send — but using it for the premium/notional text below would
  // understate a CRUDEOILM lot's true outlay by 10x (100x for CRUDEOIL). Use the real
  // contract size for that display only; every non-MCX symbol's lotSize IS its true
  // per-lot multiplier already, so this is a no-op for them.
  const contractSize = MCX_LOT_MULTIPLIER[symbol] ?? lotSize;

  const atmStrike = options?.atm_strike || Math.round(spot / 50) * 50;
  const ceContract = options?.ce;
  const peContract = options?.pe;

  // Commit on blur for custom lots
  const handleLotsCommit = () => {
    const val = parseInt(tempLots, 10);
    if (!isNaN(val) && val > 0 && val <= 100) {
      setLots(val);
      setTempLots(String(val));
    } else {
      setTempLots(String(lots));
    }
  };

  const handleQuickLot = (l: number) => {
    cyberAudio.click();
    setLots(l);
    setTempLots(String(l));
  };

  // BUY CALL trigger
  const handleBuyCall = async () => {
    if (isExecuting) return;
    cyberAudio.buy();

    if (safetyLock) {
      const confirmAction = window.confirm(`EXECUTE INSTANT BUY: ${lots} Lot(s) (${totalQty} Qty) of ${symbol} ${ceContract?.display_name || 'ATM CE'}?`);
      if (!confirmAction) return;
    }

    await onExecuteTrade({
      direction: 'BUY',
      contractType: 'CE',
      securityId: ceContract?.security_id || undefined,
      tradingSymbol: ceContract?.trading_symbol || undefined,
      strike: ceContract?.strike || atmStrike,
      expiry: options?.expiry,
      lots,
      qty: totalQty,
      orderType,
      productType,
      price: ceContract?.ltp || spot,
      targetPts: targetPts || undefined,
      slPts: slPts || undefined,
    });
  };

  // BUY PUT trigger
  const handleBuyPut = async () => {
    if (isExecuting) return;
    cyberAudio.sell();

    if (safetyLock) {
      const confirmAction = window.confirm(`EXECUTE INSTANT BUY: ${lots} Lot(s) (${totalQty} Qty) of ${symbol} ${peContract?.display_name || 'ATM PE'}?`);
      if (!confirmAction) return;
    }

    await onExecuteTrade({
      direction: 'BUY',
      contractType: 'PE',
      securityId: peContract?.security_id || undefined,
      tradingSymbol: peContract?.trading_symbol || undefined,
      strike: peContract?.strike || atmStrike,
      expiry: options?.expiry,
      lots,
      qty: totalQty,
      orderType,
      productType,
      price: peContract?.ltp || spot,
      targetPts: targetPts || undefined,
      slPts: slPts || undefined,
    });
  };

  // LONG the future contract directly (not an option leg)
  const handleBuyFuture = async () => {
    if (isExecuting) return;
    cyberAudio.buy();

    if (safetyLock) {
      const confirmAction = window.confirm(`EXECUTE INSTANT LONG: ${lots} Lot(s) (${totalQty} Qty) of ${future?.display_name || `${symbol} FUT`}?`);
      if (!confirmAction) return;
    }

    await onExecuteTrade({
      direction: 'BUY',
      contractType: 'DIRECT',
      securityId: future?.security_id || undefined,
      tradingSymbol: future?.trading_symbol || undefined,
      expiry: future?.expiry,
      lots,
      qty: totalQty,
      orderType,
      productType,
      price: future?.ltp || spot,
      targetPts: targetPts || undefined,
      slPts: slPts || undefined,
    });
  };

  // SHORT the future contract directly
  const handleSellFuture = async () => {
    if (isExecuting) return;
    cyberAudio.sell();

    if (safetyLock) {
      const confirmAction = window.confirm(`EXECUTE INSTANT SHORT: ${lots} Lot(s) (${totalQty} Qty) of ${future?.display_name || `${symbol} FUT`}?`);
      if (!confirmAction) return;
    }

    await onExecuteTrade({
      direction: 'SELL',
      contractType: 'DIRECT',
      securityId: future?.security_id || undefined,
      tradingSymbol: future?.trading_symbol || undefined,
      expiry: future?.expiry,
      lots,
      qty: totalQty,
      orderType,
      productType,
      price: future?.ltp || spot,
      targetPts: targetPts || undefined,
      slPts: slPts || undefined,
    });
  };

  // LIMIT BUY below the current futures price — a dip-buy resting order.
  const handleBuyBelowFuture = async (pts: number) => {
    if (isExecuting || !future?.ltp) return;
    cyberAudio.buy();
    const limitPrice = Number((future.ltp - pts).toFixed(2));

    if (safetyLock) {
      const confirmAction = window.confirm(`PLACE LIMIT BUY: ${lots} Lot(s) (${totalQty} Qty) of ${future?.display_name || `${symbol} FUT`} @ ₹${limitPrice.toFixed(2)} (LTP -${pts} pts)?`);
      if (!confirmAction) return;
    }

    await onExecuteTrade({
      direction: 'BUY',
      contractType: 'DIRECT',
      securityId: future?.security_id || undefined,
      tradingSymbol: future?.trading_symbol || undefined,
      expiry: future?.expiry,
      lots,
      qty: totalQty,
      orderType: 'LIMIT',
      productType,
      price: limitPrice,
      targetPts: targetPts || undefined,
      slPts: slPts || undefined,
    });
  };

  // LIMIT SHORT above the current futures price — a fade-the-spike resting order.
  const handleShortAboveFuture = async (pts: number) => {
    if (isExecuting || !future?.ltp) return;
    cyberAudio.sell();
    const limitPrice = Number((future.ltp + pts).toFixed(2));

    if (safetyLock) {
      const confirmAction = window.confirm(`PLACE LIMIT SHORT: ${lots} Lot(s) (${totalQty} Qty) of ${future?.display_name || `${symbol} FUT`} @ ₹${limitPrice.toFixed(2)} (LTP +${pts} pts)?`);
      if (!confirmAction) return;
    }

    await onExecuteTrade({
      direction: 'SELL',
      contractType: 'DIRECT',
      securityId: future?.security_id || undefined,
      tradingSymbol: future?.trading_symbol || undefined,
      expiry: future?.expiry,
      lots,
      qty: totalQty,
      orderType: 'LIMIT',
      productType,
      price: limitPrice,
      targetPts: targetPts || undefined,
      slPts: slPts || undefined,
    });
  };

  // Panic flatten all
  const handlePanicFlatten = async () => {
    cyberAudio.exit();
    const confirmed = window.confirm('EMERGENCY FLATTEN ALL: Close all active F&O scalping positions immediately?');
    if (confirmed) {
      await onFlattenAll();
    }
  };

  const isBullish = bias.includes('BULLISH');
  const isBearish = bias.includes('BEARISH');

  return (
    <div className="bg-zinc-900/70 border border-zinc-800/80 rounded-xl p-3 lg:p-4 backdrop-blur-md shadow-xl flex flex-col gap-3">
      {/* Header & Mode Selector */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-cyan-500/10 border border-cyan-500/25 flex items-center justify-center text-cyan-400 shrink-0">
            <Zap className="w-3.5 h-3.5" />
          </div>
          <div>
            <h2 className="text-xs font-bold tracking-tight text-white flex items-center gap-1.5">
              ORDER PAD
              <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-emerald-500/15 text-emerald-300 font-normal border border-emerald-500/30">
                MARGIN
              </span>
            </h2>
            <p className="text-[10px] text-zinc-400 font-mono">
              {effectiveMode === 'FUTURES' ? (
                <>
                  <b className="text-white">{future?.trading_symbol || symbol}</b> · Exp{' '}
                  <b className="text-zinc-200">{future?.expiry || 'Active'}</b>
                </>
              ) : (
                <>
                  ATM <b className="text-white">{atmStrike}</b> · Exp{' '}
                  <b className="text-zinc-200">{options?.expiry || 'Active'}</b>
                </>
              )}
            </p>
          </div>
        </div>

        {/* Safety Lock & Hotkeys indicator */}
        <div className="flex items-center gap-1.5">
          {/* Futures/Options mode toggle — only for symbols with a tradeable future
              contract of their own (see FUTURES_CAPABLE_SYMBOLS above). */}
          {futuresCapable && (
            <div className="flex items-center bg-zinc-950 border border-zinc-800 rounded-lg p-0.5">
              {(['OPTIONS', 'FUTURES'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    cyberAudio.click();
                    setTradeMode(m);
                  }}
                  className={cn(
                    'px-1.5 py-0.5 rounded text-[9px] font-mono font-bold transition-all',
                    effectiveMode === m
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                      : 'text-zinc-400 hover:text-white'
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          )}

          {/* Future contract expiry switcher — current month + next 2 months,
              per cyber_scalper_feed.py's find_future_contract(). */}
          {effectiveMode === 'FUTURES' && (future?.all_expiries?.length ?? 0) > 1 && (
            <div className="flex items-center bg-zinc-950 border border-zinc-800 rounded-lg p-0.5">
              {future!.all_expiries!.map((exp) => (
                <button
                  key={exp}
                  onClick={() => {
                    cyberAudio.click();
                    onSelectFutureExpiry?.(exp);
                  }}
                  className={cn(
                    'px-1.5 py-0.5 rounded text-[9px] font-mono font-bold transition-all',
                    future?.expiry === exp
                      ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                      : 'text-zinc-400 hover:text-white'
                  )}
                  title={exp}
                >
                  {formatExpiryMonth(exp)}
                </button>
              ))}
            </div>
          )}

          <button
            onClick={() => {
              cyberAudio.click();
              setSafetyLock(!safetyLock);
            }}
            className={cn(
              'px-2 py-0.5 rounded-lg border text-[10px] font-mono font-bold flex items-center gap-1 transition-all',
              safetyLock
                ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
            )}
            title={safetyLock ? 'Safety confirmation dialog enabled' : 'Instant 1-Click execution armed'}
          >
            {safetyLock ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
            <span>{safetyLock ? 'CONFIRM ON' : '1-CLICK'}</span>
          </button>

          {/* Panic FLATTEN ALL */}
          {openPositionsCount > 0 && (
            <button
              onClick={handlePanicFlatten}
              disabled={isExecuting}
              className="px-2 py-0.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-mono font-black tracking-wide flex items-center gap-1 shadow-md shadow-rose-900/30 active:scale-95 transition-all"
            >
              <AlertOctagon className="w-3 h-3" />
              <span>FLATTEN ({openPositionsCount}) [X]</span>
            </button>
          )}
        </div>
      </div>

      {/* BIG BUY & SELL ACTION BUTTONS */}
      {effectiveMode === 'FUTURES' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* LONG the future */}
          <button
            onClick={handleBuyFuture}
            disabled={isExecuting}
            className={cn(
              'group relative overflow-hidden rounded-xl px-3 py-2 border text-center transition-all duration-150 cursor-pointer active:scale-[0.98] select-none',
              'bg-gradient-to-br from-emerald-950/60 via-zinc-950/80 to-emerald-900/30',
              'border-emerald-500/50 hover:border-emerald-400 hover:shadow-lg hover:shadow-emerald-500/10',
              isBullish && 'ring-1 ring-emerald-400/40'
            )}
          >
            <div className="flex items-center justify-center gap-1.5">
              <span className="px-1.5 py-0.2 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-mono text-[9px] font-bold uppercase tracking-wide">
                [B]
              </span>
              <h3 className="text-base font-black text-white tracking-tight flex items-center gap-1.5">
                <span>LONG FUTURE</span>
                <ArrowUpRight className="w-4 h-4 text-emerald-400" />
              </h3>
              {isBullish && <Sparkles className="w-3 h-3 text-emerald-400" />}
              <span className="text-lg font-mono font-black text-emerald-400 ml-1">
                ₹{future?.ltp ? future.ltp.toFixed(2) : '---'}
              </span>
            </div>

            <div className="text-[11px] font-mono text-zinc-400 mt-1">
              {future?.display_name || `${symbol} FUT`} · {lots}L ({totalQty}) · ₹{(lots * contractSize * (future?.ltp || 0)).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </div>
          </button>

          {/* SHORT the future */}
          <button
            onClick={handleSellFuture}
            disabled={isExecuting}
            className={cn(
              'group relative overflow-hidden rounded-xl px-3 py-2 border text-center transition-all duration-150 cursor-pointer active:scale-[0.98] select-none',
              'bg-gradient-to-br from-rose-950/60 via-zinc-950/80 to-rose-900/30',
              'border-rose-500/50 hover:border-rose-400 hover:shadow-lg hover:shadow-rose-500/10',
              isBearish && 'ring-1 ring-rose-400/40'
            )}
          >
            <div className="flex items-center justify-center gap-1.5">
              <span className="px-1.5 py-0.2 rounded bg-rose-500/20 border border-rose-500/40 text-rose-300 font-mono text-[9px] font-bold uppercase tracking-wide">
                [S]
              </span>
              <h3 className="text-base font-black text-white tracking-tight flex items-center gap-1.5">
                <span>SHORT FUTURE</span>
                <ArrowDownRight className="w-4 h-4 text-rose-400" />
              </h3>
              {isBearish && <Sparkles className="w-3 h-3 text-rose-400" />}
              <span className="text-lg font-mono font-black text-rose-400 ml-1">
                ₹{future?.ltp ? future.ltp.toFixed(2) : '---'}
              </span>
            </div>

            <div className="text-[11px] font-mono text-zinc-400 mt-1">
              {future?.display_name || `${symbol} FUT`} · {lots}L ({totalQty}) · ₹{(lots * contractSize * (future?.ltp || 0)).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </div>
          </button>
        </div>
      ) : (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* BIG BUY (CALL / LONG) BUTTON */}
        <button
          onClick={handleBuyCall}
          disabled={isExecuting}
          className={cn(
            'group relative overflow-hidden rounded-xl px-3 py-2 border text-center transition-all duration-150 cursor-pointer active:scale-[0.98] select-none',
            'bg-gradient-to-br from-emerald-950/60 via-zinc-950/80 to-emerald-900/30',
            'border-emerald-500/50 hover:border-emerald-400 hover:shadow-lg hover:shadow-emerald-500/10',
            isBullish && 'ring-1 ring-emerald-400/40'
          )}
        >
          <div className="flex items-center justify-center gap-1.5">
            <span className="px-1.5 py-0.2 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-mono text-[9px] font-bold uppercase tracking-wide">
              [B]
            </span>
            <h3 className="text-base font-black text-white tracking-tight flex items-center gap-1.5">
              <span>BUY ATM CALL</span>
              <ArrowUpRight className="w-4 h-4 text-emerald-400" />
            </h3>
            {isBullish && <Sparkles className="w-3 h-3 text-emerald-400" />}
            <span className="text-lg font-mono font-black text-emerald-400 ml-1">
              ₹{ceContract?.ltp ? ceContract.ltp.toFixed(2) : '---'}
            </span>
          </div>

          <div className="text-[11px] font-mono text-zinc-400 mt-1">
            {ceContract?.display_name || `${symbol} ${atmStrike} CE`} · {lots}L ({totalQty}) · ₹{(lots * contractSize * (ceContract?.ltp || 0)).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </div>
        </button>

        {/* BIG SELL (PUT / SHORT) BUTTON */}
        <button
          onClick={handleBuyPut}
          disabled={isExecuting}
          className={cn(
            'group relative overflow-hidden rounded-xl px-3 py-2 border text-center transition-all duration-150 cursor-pointer active:scale-[0.98] select-none',
            'bg-gradient-to-br from-rose-950/60 via-zinc-950/80 to-rose-900/30',
            'border-rose-500/50 hover:border-rose-400 hover:shadow-lg hover:shadow-rose-500/10',
            isBearish && 'ring-1 ring-rose-400/40'
          )}
        >
          <div className="flex items-center justify-center gap-1.5">
            <span className="px-1.5 py-0.2 rounded bg-rose-500/20 border border-rose-500/40 text-rose-300 font-mono text-[9px] font-bold uppercase tracking-wide">
              [S]
            </span>
            <h3 className="text-base font-black text-white tracking-tight flex items-center gap-1.5">
              <span>BUY ATM PUT</span>
              <ArrowDownRight className="w-4 h-4 text-rose-400" />
            </h3>
            {isBearish && <Sparkles className="w-3 h-3 text-rose-400" />}
            <span className="text-lg font-mono font-black text-rose-400 ml-1">
              ₹{peContract?.ltp ? peContract.ltp.toFixed(2) : '---'}
            </span>
          </div>

          <div className="text-[11px] font-mono text-zinc-400 mt-1">
            {peContract?.display_name || `${symbol} ${atmStrike} PE`} · {lots}L ({totalQty}) · ₹{(lots * contractSize * (peContract?.ltp || 0)).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </div>
        </button>
      </div>
      )}

      {/* LIMIT OFFSET LADDER — dip-buy below / fade-short above the futures LTP.
          Futures-only: this terminal never sells/writes options, so "short" has
          no equivalent instrument in Options mode. */}
      {effectiveMode === 'FUTURES' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div className="bg-zinc-950/70 border border-zinc-800/80 rounded-lg p-2 flex flex-col justify-between">
            <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400 mb-2">
              <span>BUY BELOW (LIMIT)</span>
              <span className="text-emerald-400 font-bold">
                {future?.ltp ? `LTP ₹${future.ltp.toFixed(2)}` : '---'}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {[10, 20, 30].map((pts) => (
                <button
                  key={`buy-below-${pts}`}
                  onClick={() => handleBuyBelowFuture(pts)}
                  disabled={isExecuting || !future?.ltp}
                  className="flex-1 py-1 rounded-lg font-mono text-xs font-bold border bg-zinc-900 border-emerald-800/60 text-emerald-300 hover:bg-emerald-950/60 hover:border-emerald-500/60 transition-all disabled:opacity-30 active:scale-95"
                  title={future?.ltp ? `Buy limit @ ₹${(future.ltp - pts).toFixed(2)} (LTP -${pts} pts)` : 'Waiting for LTP'}
                >
                  -{pts}
                </button>
              ))}
            </div>
          </div>

          <div className="bg-zinc-950/70 border border-zinc-800/80 rounded-lg p-2 flex flex-col justify-between">
            <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400 mb-2">
              <span>SHORT ABOVE (LIMIT)</span>
              <span className="text-rose-400 font-bold">
                {future?.ltp ? `LTP ₹${future.ltp.toFixed(2)}` : '---'}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {[10, 20, 30].map((pts) => (
                <button
                  key={`short-above-${pts}`}
                  onClick={() => handleShortAboveFuture(pts)}
                  disabled={isExecuting || !future?.ltp}
                  className="flex-1 py-1 rounded-lg font-mono text-xs font-bold border bg-zinc-900 border-rose-800/60 text-rose-300 hover:bg-rose-950/60 hover:border-rose-500/60 transition-all disabled:opacity-30 active:scale-95"
                  title={future?.ltp ? `Short limit @ ₹${(future.ltp + pts).toFixed(2)} (LTP +${pts} pts)` : 'Waiting for LTP'}
                >
                  +{pts}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* QUICK SCALP CONFIGURATION CONTROLS */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 pt-1">
        {/* Lots Quick Multiplier */}
        <div className="bg-zinc-950/70 border border-zinc-800/80 rounded-lg p-2 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400 mb-2">
            <span>LOT MULTIPLIER</span>
            <span className="text-white font-bold">{totalQty} QTY</span>
          </div>
          <div className="flex items-center gap-1.5">
            {[1, 2, 3, 5, 10].map((l) => (
              <button
                key={`lot-${l}`}
                onClick={() => handleQuickLot(l)}
                className={cn(
                  'flex-1 py-1 rounded-lg font-mono text-xs font-bold border transition-all',
                  lots === l
                    ? 'bg-cyan-500/20 border-cyan-500/60 text-cyan-300'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700'
                )}
              >
                {l}L
              </button>
            ))}
            <input
              type="text"
              value={tempLots}
              onChange={(e) => setTempLots(e.target.value)}
              onBlur={handleLotsCommit}
              onKeyDown={(e) => e.key === 'Enter' && handleLotsCommit()}
              className="w-12 py-1 px-1 bg-zinc-900 border border-zinc-800 rounded-lg text-xs font-mono text-center text-white focus:border-cyan-500 focus:outline-none"
              title="Custom Lots (commit on blur or Enter)"
            />
          </div>
        </div>

        {/* Target Presets */}
        <div className="bg-zinc-950/70 border border-zinc-800/80 rounded-lg p-2 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400 mb-2">
            <span>TARGET PRESET (PTS)</span>
            <div className="flex items-center gap-1.5">
              {suggestedTargetPts && (
                <button
                  onClick={() => {
                    cyberAudio.click();
                    setTargetPts(Math.round(suggestedTargetPts));
                  }}
                  className="px-1.5 py-0.2 rounded text-[9px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30 transition-all"
                  title="Apply 9/20 Strategy Target"
                >
                  ATR TP: +{Math.round(suggestedTargetPts)}
                </button>
              )}
              <span className="text-emerald-400 font-bold">{targetPts ? `+${targetPts} PTS` : 'OFF'}</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {[null, 5, 10, 20, 30].map((t, idx) => (
              <button
                key={`target-${idx}`}
                onClick={() => {
                  cyberAudio.click();
                  setTargetPts(t);
                }}
                className={cn(
                  'flex-1 py-1 rounded-lg font-mono text-xs font-bold border transition-all',
                  targetPts === t
                    ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700'
                )}
              >
                {t === null ? 'OFF' : `+${t}`}
              </button>
            ))}
          </div>
        </div>

        {/* Stop Loss Presets */}
        <div className="bg-zinc-950/70 border border-zinc-800/80 rounded-lg p-2 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400 mb-2">
            <span>STOP LOSS PRESET (PTS)</span>
            <div className="flex items-center gap-1.5">
              {suggestedSlPts && (
                <button
                  onClick={() => {
                    cyberAudio.click();
                    setSlPts(Math.round(suggestedSlPts));
                  }}
                  className="px-1.5 py-0.2 rounded text-[9px] font-mono font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40 hover:bg-rose-500/30 transition-all"
                  title="Apply 9/20 Strategy Stop Loss"
                >
                  ATR SL: -{Math.round(suggestedSlPts)}
                </button>
              )}
              <span className="text-rose-400 font-bold">{slPts ? `-${slPts} PTS` : 'OFF'}</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {[null, 10, 15, 20, 30].map((s, idx) => (
              <button
                key={`sl-${idx}`}
                onClick={() => {
                  cyberAudio.click();
                  setSlPts(s);
                }}
                className={cn(
                  'flex-1 py-1 rounded-lg font-mono text-xs font-bold border transition-all',
                  slPts === s
                    ? 'bg-rose-500/20 border-rose-500/60 text-rose-300'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700'
                )}
              >
                {s === null ? 'OFF' : `-${s}`}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
