'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Zap,
  RefreshCw,
  Volume2,
  VolumeX,
  Keyboard,
  Compass,
  Layers,
  ChevronDown,
  Activity,
  AlertCircle,
  Radio,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import CyberBiasRadar from './CyberBiasRadar';
import CyberOrderPad from './CyberOrderPad';
import CyberChart, { Candle, SeriesPoint, SpreadPoint } from './CyberChart';
import CyberPositionsPanel, { PositionItem, ScalpLogItem } from './CyberPositionsPanel';
import { cyberAudio } from '@/lib/cyberAudio';
import { contractMultiplier, scaleBrokerPnl } from '@/lib/positionPnl';

const POPULAR_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX', 'CRUDEOIL', 'RELIANCE', 'HDFCBANK'];
const INTERVALS = [
  { value: '1', label: '1m Scalp' },
  { value: '3', label: '3m Momentum' },
  { value: '5', label: '5m Trend' },
];

export default function CyberScalperTerminal() {
  const [symbol, setSymbol] = useState('NIFTY');
  const [timeframe, setTimeframe] = useState('1');
  const [expiry, setExpiry] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);

  // Live Data Feed
  const [feedData, setFeedData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [lastTickTime, setLastTickTime] = useState<string>('');

  // Positions & Orders
  const [positions, setPositions] = useState<PositionItem[]>([]);
  const [logs, setLogs] = useState<ScalpLogItem[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);

  // In-flight guards for the 2.5s poll loop below. cyber_scalper_feed.py spawns a fresh
  // Python process (full master-list reload) per call and regularly takes ~2.3-2.5s on its
  // own — right at the poll interval — so without this, any latency spike stacks up
  // multiple concurrent GETs to the same endpoint instead of the tick just being skipped.
  const feedInFlight = useRef(false);
  const positionsInFlight = useRef(false);

  // Audio mute sync
  useEffect(() => {
    setIsMuted(cyberAudio.isMuted());
  }, []);

  const toggleMute = () => {
    const muted = cyberAudio.toggleMute();
    setIsMuted(muted);
  };

  const addLog = (type: 'BUY' | 'SELL' | 'EXIT' | 'ERROR', message: string, detail?: string) => {
    const newLog: ScalpLogItem = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      time: new Date().toLocaleTimeString('en-IN', { hour12: false }),
      type,
      message,
      detail,
    };
    setLogs((prev) => [newLog, ...prev.slice(0, 49)]);
  };

  // Poll feed data
  const fetchFeed = useCallback(async () => {
    if (feedInFlight.current) return;
    feedInFlight.current = true;
    try {
      const q = new URLSearchParams({ symbol, interval: timeframe });
      if (expiry) q.set('expiry', expiry);

      const res = await fetch(`/api/cyber-scalper/feed?${q.toString()}`);
      const json = await res.json();

      if (json.success) {
        setFeedData(json);
        setFeedError(null);
        setLastTickTime(json.timeStr || new Date().toLocaleTimeString('en-IN', { hour12: false }));

        if (!expiry && json.options?.expiry) {
          setExpiry(json.options.expiry);
        }
      } else {
        setFeedError(json.error || 'Failed to fetch cyber telemetry feed');
      }
    } catch (err: any) {
      setFeedError(String(err.message || err));
    } finally {
      setIsLoading(false);
      feedInFlight.current = false;
    }
  }, [symbol, timeframe, expiry]);

  // Poll open positions from broker
  const fetchPositions = useCallback(async () => {
    if (positionsInFlight.current) return;
    positionsInFlight.current = true;
    try {
      const res = await fetch('/api/scalper/poll');
      const json = await res.json();
      if (json.success && Array.isArray(json.positions)) {
        const rawPositions = json.positions;
        const mapped: PositionItem[] = rawPositions.map((p: any) => {
          const qty = Number(p.netQty || 0);
          const buyAvg = Number(p.buyAvg || p.costPrice || 0);
          const sellAvg = Number(p.sellAvg || 0);

          // Dhan's /positions API omits lastTradedPrice entirely (see AdvancedScalper.tsx /
          // Scalper.tsx and the dhan-broker-positions skill) — p.ltp / p.lastPrice are never
          // populated on the raw payload, so reading them directly always renders "---". Back-
          // derive from unrealizedProfit the same way those terminals do. MCX P&L must be
          // rescaled by the barrels-per-lot multiplier FIRST (Dhan reports it unscaled), or the
          // derived LTP lands a hundredth of the way back from the entry price.
          const mult = contractMultiplier(p);
          const scaled = scaleBrokerPnl(p, mult);
          const unrealized = Number(scaled.unrealizedProfit) || 0;
          const realized = Number(scaled.realizedProfit) || 0;

          let ltp = Number(p.ltp || p.lastPrice || 0);
          if (!ltp && qty !== 0 && unrealized !== 0 && mult > 0) {
            const derived = qty > 0
              ? buyAvg + unrealized / (qty * mult)
              : sellAvg - unrealized / (Math.abs(qty) * mult);
            if (Number.isFinite(derived) && derived > 0) ltp = derived;
          }

          const pnl = qty !== 0 ? unrealized : realized;
          const points = buyAvg > 0 && ltp > 0 ? (qty > 0 ? ltp - buyAvg : buyAvg - ltp) : 0;

          return {
            id: String(p.securityId || p.tradingSymbol || Math.random()),
            tradingSymbol: String(p.tradingSymbol || p.securityId || 'POSITION'),
            securityId: p.securityId ? String(p.securityId) : undefined,
            productType: String(p.productType || 'INTRADAY'),
            exchangeSegment: String(p.exchangeSegment || 'NSE_FNO'),
            netQty: qty,
            buyAvg,
            ltp,
            pnl,
            points,
            side: qty >= 0 ? 'BUY' : 'SELL',
          };
        });
        setPositions(mapped);
      }
    } catch {
      // quiet fallback
    } finally {
      positionsInFlight.current = false;
    }
  }, []);

  // Main polling loop (every 2.5 seconds for fresh candles and bias calculations)
  useEffect(() => {
    fetchFeed();
    fetchPositions();

    const timer = setInterval(() => {
      fetchFeed();
      fetchPositions();
    }, 2500);

    return () => clearInterval(timer);
  }, [fetchFeed, fetchPositions]);

  // Execute Trade action (Instant via /api/scalper/fast-order)
  const handleExecuteTrade = async (params: {
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
  }) => {
    if (!params.securityId) {
      cyberAudio.error();
      addLog('ERROR', 'No security ID resolved for this contract', 'Master list match missing');
      alert('Cannot place order: Contract security ID not resolved');
      return;
    }

    setIsExecuting(true);
    addLog(
      params.direction,
      `Placing ${params.direction} order for ${params.tradingSymbol || params.strike || ''}`,
      `${params.lots} Lot(s) · ${params.qty} Qty @ ${params.orderType}`
    );

    try {
      const res = await fetch('/api/scalper/fast-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          securityId: params.securityId,
          quantity: params.qty,
          side: params.direction,
          orderType: params.orderType,
          price: params.orderType === 'LIMIT' ? params.price : 0,
          exchangeSegment: symbol === 'SENSEX' ? 'BSE_FNO' : symbol.includes('CRUDE') ? 'MCX_COMM' : 'NSE_FNO',
          productType: params.productType,
        }),
      });

      const json = await res.json();
      if (json.success) {
        cyberAudio.buy();
        addLog(
          params.direction,
          `ORDER FILLED! Order ID: ${json.order_id || 'OK'}`,
          `${params.qty} Qty of ${params.tradingSymbol || params.strike}`
        );
        await fetchPositions();
      } else {
        cyberAudio.error();
        addLog('ERROR', `Order Rejected: ${json.error || 'Unknown broker error'}`);
        alert(`Order Failed: ${json.error}`);
      }
    } catch (err: any) {
      cyberAudio.error();
      addLog('ERROR', `Network execution failed: ${err.message || err}`);
    } finally {
      setIsExecuting(false);
    }
  };

  // Close single position leg
  const handleClosePosition = async (pos: PositionItem) => {
    if (!pos.securityId || pos.netQty === 0) return;
    setIsExecuting(true);
    const closeSide = pos.netQty > 0 ? 'SELL' : 'BUY';
    addLog('EXIT', `Closing ${pos.tradingSymbol}`, `${Math.abs(pos.netQty)} Qty`);

    try {
      const res = await fetch('/api/scalper/fast-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          securityId: pos.securityId,
          quantity: Math.abs(pos.netQty),
          side: closeSide,
          orderType: 'MARKET',
          exchangeSegment: pos.exchangeSegment,
          productType: pos.productType,
        }),
      });

      const json = await res.json();
      if (json.success) {
        cyberAudio.exit();
        addLog('EXIT', `Position Closed: ${pos.tradingSymbol}`);
        await fetchPositions();
      } else {
        cyberAudio.error();
        addLog('ERROR', `Square-off failed: ${json.error}`);
      }
    } catch (err: any) {
      cyberAudio.error();
      addLog('ERROR', `Close error: ${err.message || err}`);
    } finally {
      setIsExecuting(false);
    }
  };

  // Panic Flatten All F&O Positions
  const handleFlattenAll = async () => {
    setIsExecuting(true);
    addLog('EXIT', 'EMERGENCY FLATTEN ALL INITIATED', 'Liquidating all open F&O positions');

    try {
      const res = await fetch('/api/exit-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'fno' }),
      });
      const json = await res.json();
      if (json.ok) {
        cyberAudio.exit();
        addLog('EXIT', 'ALL F&O POSITIONS FLATTENED CLEANLY');
        await fetchPositions();
      } else {
        cyberAudio.error();
        addLog('ERROR', `Emergency exit warning: ${json.error || 'Partial exit failure'}`);
      }
    } catch (err: any) {
      cyberAudio.error();
      addLog('ERROR', `Emergency flatten call error: ${err.message || err}`);
    } finally {
      setIsExecuting(false);
    }
  };

  // Global Keyboard Shortcuts (B = Buy Call, S = Buy Put, X = Flatten All)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when user is typing in an input
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) {
        return;
      }

      const key = e.key.toUpperCase();

      if (key === 'B' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const ceContract = feedData?.options?.ce;
        if (ceContract?.security_id) {
          handleExecuteTrade({
            direction: 'BUY',
            contractType: 'CE',
            securityId: ceContract.security_id,
            tradingSymbol: ceContract.trading_symbol,
            strike: ceContract.strike,
            expiry: feedData.options.expiry,
            lots: 1,
            qty: feedData.options.lot_size || 65,
            orderType: 'MARKET',
            productType: 'INTRADAY',
            price: ceContract.ltp,
          });
        }
      } else if (key === 'S' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const peContract = feedData?.options?.pe;
        if (peContract?.security_id) {
          handleExecuteTrade({
            direction: 'BUY',
            contractType: 'PE',
            securityId: peContract.security_id,
            tradingSymbol: peContract.trading_symbol,
            strike: peContract.strike,
            expiry: feedData.options.expiry,
            lots: 1,
            qty: feedData.options.lot_size || 65,
            orderType: 'MARKET',
            productType: 'INTRADAY',
            price: peContract.ltp,
          });
        }
      } else if (key === 'X') {
        e.preventDefault();
        handleFlattenAll();
      } else if (key === '1') {
        setTimeframe('1');
      } else if (key === '2') {
        setTimeframe('3');
      } else if (key === '3') {
        setTimeframe('5');
      } else if (key === 'M') {
        toggleMute();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [feedData]);

  const spot = feedData?.spot || 0;
  const change = feedData?.change || 0;
  const changePct = feedData?.changePct || 0;
  const isPositive = change >= 0;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white selection:bg-cyan-500 selection:text-black">
      {/* FUTURISTIC STICKY TELEMETRY HEADER */}
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-4 lg:px-6 py-3 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur-lg">
        {/* Left: Branding & Underlying */}
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500/20 via-emerald-500/10 to-violet-500/20 border border-cyan-500/30 text-cyan-400 shadow-lg shadow-cyan-500/10 shrink-0">
            <Zap className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-mono font-bold tracking-[0.2em] text-cyan-400 uppercase">
                FUTURISTIC SCALPER
              </span>
              {/* Mandatory DATA date chip per AGENTS.md */}
              <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">
                DATA: {feedData?.dataDate || 'LIVE'}
              </span>
              <span className="flex items-center gap-1 text-[9px] font-mono text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
                <span>{lastTickTime || 'POLLING'}</span>
              </span>
            </div>
            <h1 className="text-base lg:text-lg font-black tracking-tight text-white flex items-center gap-2">
              <span>CYBER SCALP</span>
              <span className="text-zinc-500 font-normal">|</span>
              <span className="text-cyan-400 font-mono">{symbol}</span>
              <span className="text-xs font-mono font-bold text-zinc-300">
                ₹{spot.toFixed(2)}
              </span>
              <span
                className={cn(
                  'text-xs font-mono font-bold px-1.5 py-0.2 rounded',
                  isPositive ? 'text-emerald-400 bg-emerald-500/10' : 'text-rose-400 bg-rose-500/10'
                )}
              >
                {isPositive ? '+' : ''}{change.toFixed(2)} ({isPositive ? '+' : ''}{changePct.toFixed(2)}%)
              </span>
            </h1>
          </div>
        </div>

        {/* Right: Controls & Selectors */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Symbol selector */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
            {POPULAR_SYMBOLS.slice(0, 4).map((s) => (
              <button
                key={s}
                onClick={() => {
                  cyberAudio.click();
                  setSymbol(s);
                  setExpiry(null);
                }}
                className={cn(
                  'px-2 py-1 rounded text-xs font-mono font-bold transition-all',
                  symbol === s
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
                    : 'text-zinc-400 hover:text-white'
                )}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Timeframe selector */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
            {INTERVALS.map((intv) => (
              <button
                key={intv.value}
                onClick={() => {
                  cyberAudio.click();
                  setTimeframe(intv.value);
                }}
                className={cn(
                  'px-2 py-1 rounded text-xs font-mono font-bold transition-all',
                  timeframe === intv.value
                    ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40 shadow-sm'
                    : 'text-zinc-400 hover:text-white'
                )}
              >
                {intv.label}
              </button>
            ))}
          </div>

          {/* Audio Mute button */}
          <button
            onClick={toggleMute}
            className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white transition-colors"
            title={isMuted ? 'Unmute Futuristic SFX [M]' : 'Mute Futuristic SFX [M]'}
          >
            {isMuted ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4 text-cyan-400" />}
          </button>

          {/* Refresh button */}
          <button
            onClick={() => {
              cyberAudio.click();
              fetchFeed();
              fetchPositions();
            }}
            className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-cyan-400 transition-colors"
            title="Refresh Feed"
          >
            <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin text-cyan-400')} />
          </button>
        </div>
      </div>

      {/* ERROR BANNER */}
      {feedError && (
        <div className="mx-4 lg:mx-6 mt-4 p-3 rounded-xl bg-red-900/20 border border-red-700/40 text-red-400 text-xs font-mono flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{feedError}</span>
        </div>
      )}

      {/* MAIN TERMINAL BODY */}
      <div className="flex-1 flex flex-col gap-4 p-4 lg:p-6 max-w-[1700px] mx-auto w-full">
        {/* 1. TELEMETRY HUD: 9/20 EMA DIFFERENCE + VWAP BIAS RADAR */}
        <CyberBiasRadar spot={spot} live={feedData?.live || null} />

        {/* 2. THE BIG SCALPING TERMINAL: MASSIVE BUY & SELL BUTTONS */}
        <CyberOrderPad
          symbol={symbol}
          spot={spot}
          options={feedData?.options || null}
          bias={feedData?.live?.bias || 'NEUTRAL'}
          isExecuting={isExecuting}
          onExecuteTrade={handleExecuteTrade}
          onFlattenAll={handleFlattenAll}
          openPositionsCount={positions.filter((p) => p.netQty !== 0).length}
        />

        {/* 3. INTERACTIVE CHART WITH EMA 9, EMA 20, VWAP & SPREAD DELTA */}
        <CyberChart
          candles={feedData?.candles || []}
          ema9Series={feedData?.series?.ema9 || []}
          ema20Series={feedData?.series?.ema20 || []}
          vwapSeries={feedData?.series?.vwap || []}
          spreadSeries={feedData?.series?.spread || []}
          symbol={symbol}
          interval={timeframe}
        />

        {/* 4. POSITIONS TABLE & LIVE TELEMETRY LOG */}
        <CyberPositionsPanel
          positions={positions}
          logs={logs}
          onClosePosition={handleClosePosition}
          isExecuting={isExecuting}
        />

        {/* FOOTER KEYBOARD SHORTCUTS REFERENCE */}
        <div className="flex items-center justify-between flex-wrap gap-2 pt-4 pb-2 border-t border-zinc-800 text-[11px] font-mono text-zinc-500">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="flex items-center gap-1 text-zinc-400">
              <Keyboard className="w-3.5 h-3.5" />
              <span>KEYBOARD HOTKEYS:</span>
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-emerald-400 font-bold border border-zinc-700">B</kbd> Buy ATM Call
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-rose-400 font-bold border border-zinc-700">S</kbd> Buy ATM Put
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-red-500 font-bold border border-zinc-700">X</kbd> Flatten All
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-purple-400 font-bold border border-zinc-700">1/2/3</kbd> 1m/3m/5m Timeframe
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-cyan-400 font-bold border border-zinc-700">M</kbd> Mute SFX
            </span>
          </div>
          <div>
            <span>9 & 20 EMA + VWAP MOMENTUM ENGINE · DHAN HQ V2 API</span>
          </div>
        </div>
      </div>
    </div>
  );
}
