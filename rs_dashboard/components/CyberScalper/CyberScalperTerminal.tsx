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
import CyberPositionsPanel, { PositionItem, PositionGuard, ScalpLogItem } from './CyberPositionsPanel';
import CyberBloombergRibbon from './CyberBloombergRibbon';
import CyberStrategyIntelligence, { StrategyData } from './CyberStrategyIntelligence';
import { matchTradesFifo, type ExitedPositionItem } from '@/lib/fifoPositions';
import { saveTerminalOrder } from '@/lib/terminalTradeStore';
import { cyberAudio } from '@/lib/cyberAudio';
import { contractMultiplier, scaleBrokerPnl } from '@/lib/positionPnl';
import { useBrokerSelector, scalperRoute, BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';

const POPULAR_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX', 'CRUDEOILM', 'CRUDEOIL', 'RELIANCE', 'HDFCBANK'];
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

  // Market data (candles, EMA/VWAP bias, option/future LTPs) always comes from Dhan
  // regardless of the broker selected here — same convention as AdvancedScalper.tsx.
  // Only order placement and the positions book are broker-specific.
  const { broker, setBroker, authenticatedBrokers } = useBrokerSelector();
  // Non-Dhan CE/PE trading symbols for the currently selected expiry, keyed by
  // strike — Dhan is the only broker with a numeric securityId, everyone else
  // orders by trading symbol (see submitLegOrder in AdvancedScalper.tsx, same
  // pattern). Unused while broker === 'dhan'.
  const [brokerStrikeMap, setBrokerStrikeMap] = useState<Record<string, { ceSymbol?: string; peSymbol?: string }>>({});
  // Kotak near-month FUT contract for MCX underlyings (CRUDEOILM/CRUDEOIL); null for all others.
  const [brokerFuture, setBrokerFuture] = useState<{ trading_symbol: string; expiry?: string; lot_size?: number; exchange_segment?: string } | null>(null);

  // Live Data Feed
  const [feedData, setFeedData] = useState<any>(null);
  const feedDataRef = useRef<any>(null);
  useEffect(() => { feedDataRef.current = feedData; }, [feedData]);

  const [isLoading, setIsLoading] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [lastTickTime, setLastTickTime] = useState<string>('');

  // Positions, Guards (TP / SL / Trailing) & Logs
  const [positions, setPositions] = useState<PositionItem[]>([]);
  const [exitedPositions, setExitedPositions] = useState<ExitedPositionItem[]>([]);
  const [guards, setGuards] = useState<Record<string, PositionGuard>>({});
  const [logs, setLogs] = useState<ScalpLogItem[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);

  // In-flight guards for the 2.5s poll loop below. cyber_scalper_feed.py spawns a fresh
  // Python process (full master-list reload) per call and regularly takes ~2.3-2.5s on its
  // own — right at the poll interval — so without this, any latency spike stacks up
  // multiple concurrent GETs to the same endpoint instead of the tick just being skipped.
  const feedInFlight = useRef(false);
  const positionsInFlight = useRef(false);
  // Latest-broker guard: fetchPositions captures `broker` in its own closure, but a
  // request issued just before a broker switch can still resolve after it — same
  // race fixed in AdvancedScalper.tsx's positions poller.
  const brokerRef = useRef(broker);
  useEffect(() => { brokerRef.current = broker; }, [broker]);

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

  // Strategy suggested levels overrides for the order pad
  const [padTargetPts, setPadTargetPts] = useState<number | null>(null);
  const [padSlPts, setPadSlPts] = useState<number | null>(null);

  const handleApplyStrategyLevels = (tPts: number, sPts: number) => {
    setPadTargetPts(tPts);
    setPadSlPts(sPts);
    addLog('BUY', `Loaded 9/20 Strategy Quant Levels: TP +${tPts} pts | SL -${sPts} pts`);
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
    const requestedBroker = broker;
    try {
      const res = await fetch(scalperRoute(broker, 'poll'));
      const json = await res.json();
      // Broker was switched while this request was in flight — drop it rather than
      // repopulate the (already-cleared) positions list with the previous broker's rows.
      if (requestedBroker !== brokerRef.current) return;
      if (json.success && Array.isArray(json.positions)) {
        const rawPositions = json.positions;
        const currentFeed = feedDataRef.current;

        // Perform FIFO trade matching to resolve true active open entry prices & exited trades
        let fifoOpenMap: Record<string, any> = {};
        if (Array.isArray(json.trades) && json.trades.length > 0) {
          const fifoRes = matchTradesFifo(json.trades);
          fifoOpenMap = fifoRes.openMap;
          if (fifoRes.exitedList.length > 0) {
            setExitedPositions(fifoRes.exitedList);
          }
        }

        const mapped: PositionItem[] = rawPositions.map((p: any) => {
          const qty = Number(p.netQty || 0);
          const buyAvg = Number(p.buyAvg || p.costPrice || 0);
          const sellAvg = Number(p.sellAvg || 0);

          const sym = String(p.tradingSymbol || p.securityId || 'POSITION');
          const prd = String(p.productType || p.prod || 'INTRADAY');
          const posId = `${sym}_${prd}`;

          // If FIFO resolved the exact entry price for this open position, use it!
          // Otherwise fall back to the broker's position avg (sellAvg for short, buyAvg for long)
          const fifoOpen = fifoOpenMap[sym] || fifoOpenMap[String(p.tradingSymbol || '')];
          const avgPrice = fifoOpen && fifoOpen.qty === Math.abs(qty) && fifoOpen.avgPrice > 0
            ? fifoOpen.avgPrice
            : (qty < 0 ? (sellAvg || buyAvg) : (buyAvg || sellAvg));

          const mult = contractMultiplier(p);
          const scaled = scaleBrokerPnl(p, mult);
          const unrealized = Number(scaled.unrealizedProfit) || 0;
          const realized = Number(scaled.realizedProfit) || 0;

          let ltp = Number(p.ltp || p.lastPrice || p.lastTradedPrice || 0);
          if (!ltp && qty !== 0 && unrealized !== 0 && mult > 0) {
            const derived = qty > 0
              ? buyAvg + unrealized / (qty * mult)
              : sellAvg - unrealized / (Math.abs(qty) * mult);
            if (Number.isFinite(derived) && derived > 0) ltp = derived;
          }

          // Join live market LTP from feedData if broker returns 0 (essential for Kotak/Zerodha):
          if (!ltp && currentFeed) {
            const symUpper = sym.toUpperCase();
            const secId = String(p.securityId || '');

            // 1. Future contract match (e.g. CRUDEOILM21SEP26FUT)
            if (
              currentFeed.future?.ltp && (
                symUpper.includes('FUT') ||
                symUpper === String(currentFeed.future.trading_symbol || '').toUpperCase() ||
                secId === String(currentFeed.future.security_id || '')
              )
            ) {
              ltp = Number(currentFeed.future.ltp) || 0;
            }
            // 2. CE contract match
            else if (
              currentFeed.options?.ce?.ltp && (
                symUpper === String(currentFeed.options.ce.trading_symbol || '').toUpperCase() ||
                secId === String(currentFeed.options.ce.security_id || '')
              )
            ) {
              ltp = Number(currentFeed.options.ce.ltp) || 0;
            }
            // 3. PE contract match
            else if (
              currentFeed.options?.pe?.ltp && (
                symUpper === String(currentFeed.options.pe.trading_symbol || '').toUpperCase() ||
                secId === String(currentFeed.options.pe.security_id || '')
              )
            ) {
              ltp = Number(currentFeed.options.pe.ltp) || 0;
            }
            // 4. Spot fallback if matches underlying symbol
            else if (currentFeed.spot && symUpper.includes(symbol)) {
              ltp = Number(currentFeed.spot) || 0;
            }
          }

          const points = avgPrice > 0 && ltp > 0
            ? (qty > 0 ? ltp - avgPrice : avgPrice - ltp)
            : 0;

          // Pure active open position unrealized P&L
          let pnl = qty !== 0
            ? (points !== 0 ? points * Math.abs(qty) * (mult > 0 ? mult : 1) : unrealized)
            : realized;

          return {
            id: posId,
            tradingSymbol: sym,
            securityId: p.securityId ? String(p.securityId) : undefined,
            productType: prd,
            exchangeSegment: String(p.exchangeSegment ?? p.exchange ?? 'NSE_FNO'),
            netQty: qty,
            buyAvg,
            sellAvg,
            avgPrice,
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
  }, [broker]);

  // Clear stale positions immediately on broker switch so a Dhan position is never
  // displayed or acted on as if it belonged to Zerodha/Kotak (or vice versa).
  useEffect(() => {
    setPositions([]);
  }, [broker]);

  // Non-Dhan CE/PE trading-symbol lookup for the currently selected underlying +
  // expiry. Dhan's own ce/pe security IDs come from feedData.options directly (see
  // cyber_scalper_feed.py) and need no separate lookup.
  useEffect(() => {
    const expiryVal = feedData?.options?.expiry;
    if (broker === 'dhan' || !expiryVal) {
      setBrokerStrikeMap({});
      setBrokerFuture(null);
      return;
    }
    let cancelled = false;
    fetch(`${scalperRoute(broker, 'lookup')}?underlying=${symbol}&expiry=${expiryVal}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { strikes: Record<string, { ceSymbol?: string; peSymbol?: string }>; future?: { trading_symbol: string; expiry?: string; lot_size?: number; exchange_segment?: string } | null } }) => {
        if (!cancelled && j.success && j.data) {
          setBrokerStrikeMap(j.data.strikes);
          setBrokerFuture(j.data.future || null);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [broker, symbol, feedData?.options?.expiry]);

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

  // Execute Trade action (Instant via /api/scalper/fast-order for Dhan, broker-specific
  // trading-symbol order routes for everyone else)
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
    // Zerodha doesn't support MCX commodity — block futures mode for it.
    // Kotak is now supported via brokerFuture resolved from the instruments cache.
    if (broker === 'zerodha' && params.contractType === 'DIRECT') {
      cyberAudio.error();
      addLog('ERROR', `Futures trading not supported on Zerodha`, `Zerodha has no MCX commodity support`);
      alert(`Futures trading is not supported on Zerodha`);
      return;
    }

    // Every non-Dhan broker orders by trading symbol (Dhan is the only one with a
    // numeric securityId) — resolve it from the broker's own strike lookup rather
    // than the Dhan-sourced tradingSymbol the order pad passed in, which is in
    // Dhan's own symbol format and meaningless to another broker's order API.
    let brokerTradingSymbol: string | undefined = params.tradingSymbol;
    let brokerExchange = symbol === 'SENSEX' ? 'BSE_FNO' : symbol.includes('CRUDE') ? 'MCX_COMM' : 'NSE_FNO';
    if (broker !== 'dhan') {
      if (params.contractType === 'DIRECT') {
        // Kotak futures: use the resolved near-month FUT trading symbol.
        // Dhan's MCX lot_size is always 1 (it orders by lots, not barrels), so
        // params.qty = lots × 1. Kotak Neo requires absolute barrels, so we must
        // multiply: e.g. 2 lots × 10 barrels/lot = 20 for CRUDEOILM.
        brokerTradingSymbol = brokerFuture?.trading_symbol;
        brokerExchange = brokerFuture?.exchange_segment ?? 'mcx_fo';
        if (!brokerTradingSymbol) {
          cyberAudio.error();
          addLog('ERROR', `Kotak future contract still loading`, `CRUDEOILM FUT not resolved yet`);
          alert(`Cannot place order: Kotak future contract not resolved yet — try again in a moment`);
          return;
        }
        // Scale lots → absolute barrels for the Kotak Neo order API
        params = { ...params, qty: params.lots * (brokerFuture?.lot_size ?? 10) };
      } else {
        const entry = params.strike != null ? brokerStrikeMap[String(params.strike)] : undefined;
        brokerTradingSymbol = entry?.[params.contractType === 'CE' ? 'ceSymbol' : 'peSymbol'];
        if (!brokerTradingSymbol) {
          cyberAudio.error();
          addLog('ERROR', `${BROKER_LABELS[broker]} strike data still loading`, `Strike ${params.strike} not resolved yet`);
          alert(`Cannot place order: ${BROKER_LABELS[broker]} contract not resolved yet — try again in a moment`);
          return;
        }
        brokerExchange = broker === 'kotak'
          ? (symbol === 'SENSEX' ? 'bse_fo' : symbol.includes('CRUDE') ? 'mcx_fo' : 'nse_fo')
          : (symbol === 'SENSEX' ? 'BFO' : symbol.includes('CRUDE') ? 'MCX' : 'NFO');
      }
    } else if (!params.securityId) {
      cyberAudio.error();
      addLog('ERROR', 'No security ID resolved for this contract', 'Master list match missing');
      alert('Cannot place order: Contract security ID not resolved');
      return;
    }

    setIsExecuting(true);
    addLog(
      params.direction,
      `Placing ${params.direction} order for ${brokerTradingSymbol || params.strike || ''}`,
      `${params.lots} Lot(s) · ${params.qty} Qty @ ${params.orderType} (${BROKER_LABELS[broker]})`
    );

    try {
      const orderUrl = broker === 'dhan' ? '/api/scalper/fast-order' : scalperRoute(broker, 'order');
      const res = await fetch(orderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          broker === 'dhan'
            ? {
                securityId: params.securityId,
                quantity: params.qty,
                side: params.direction,
                orderType: params.orderType,
                price: params.orderType === 'LIMIT' ? params.price : 0,
                exchangeSegment: brokerExchange,
                productType: params.productType,
              }
            : {
                tradingsymbol: brokerTradingSymbol,
                quantity: params.qty,
                side: params.direction,
                orderType: params.orderType,
                price: params.orderType === 'LIMIT' ? params.price : 0,
                exchange: brokerExchange,
                product: params.productType === 'MARGIN' ? 'NRML' : 'MIS',
              },
        ),
      });

      const json = await res.json();
      if (json.success) {
        cyberAudio.buy();
        addLog(
          params.direction,
          `ORDER FILLED! Order ID: ${json.order_id || 'OK'}`,
          `${params.qty} Qty of ${brokerTradingSymbol || params.strike}`
        );
        saveTerminalOrder({
          orderId: json.order_id ? String(json.order_id) : undefined,
          tradingSymbol: String(brokerTradingSymbol || params.strike || ''),
          securityId: params.securityId ? String(params.securityId) : undefined,
          side: params.direction,
          qty: params.qty,
          price: params.price,
          broker,
          symbol,
        });
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
    if (pos.netQty === 0) return;
    if (broker === 'dhan' && !pos.securityId) return;
    if (broker !== 'dhan' && !pos.tradingSymbol) return;
    setIsExecuting(true);
    const closeSide = pos.netQty > 0 ? 'SELL' : 'BUY';
    addLog('EXIT', `Closing ${pos.tradingSymbol}`, `${Math.abs(pos.netQty)} Qty (${BROKER_LABELS[broker]})`);

    try {
      const orderUrl = broker === 'dhan' ? '/api/scalper/fast-order' : scalperRoute(broker, 'order');
      const res = await fetch(orderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          broker === 'dhan'
            ? {
                securityId: pos.securityId,
                quantity: Math.abs(pos.netQty),
                side: closeSide,
                orderType: 'MARKET',
                exchangeSegment: pos.exchangeSegment,
                productType: pos.productType,
              }
            : {
                // Dhan is the only broker that closes by numeric securityId; the rest
                // close by trading symbol. pos.exchangeSegment and pos.productType
                // already carry that broker's own native spelling (e.g. Kotak's
                // 'nse_fo'/'mcx_fo' and 'NRML'/'MIS') straight off its positions
                // payload (see lib/kotakShape.ts / lib/zerodhaShape.ts) — not the
                // dashboard's INTRADAY/MARGIN convention, so pass them through as-is.
                tradingsymbol: pos.tradingSymbol,
                quantity: Math.abs(pos.netQty),
                side: closeSide,
                orderType: 'MARKET',
                exchange: pos.exchangeSegment,
                product: pos.productType,
              },
        ),
      });

      const json = await res.json();
      if (json.success) {
        cyberAudio.exit();
        addLog('EXIT', `Position Closed: ${pos.tradingSymbol}`);
        saveTerminalOrder({
          orderId: json.order_id ? String(json.order_id) : undefined,
          tradingSymbol: pos.tradingSymbol,
          securityId: pos.securityId ? String(pos.securityId) : undefined,
          side: closeSide,
          qty: Math.abs(pos.netQty),
          price: pos.ltp,
          broker,
          symbol,
        });
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

  // ─── Guard Management: Target, Stop Loss & Trailing SL ─────────────
  const handleGuardChange = useCallback((posKey: string, field: 'target' | 'sl', val: string) => {
    setGuards((prev) => ({
      ...prev,
      [posKey]: {
        target: field === 'target' ? val : (prev[posKey]?.target ?? ''),
        sl: field === 'sl' ? val : (prev[posKey]?.sl ?? ''),
        trailEnabled: prev[posKey]?.trailEnabled ?? false,
        bestPrice: prev[posKey]?.bestPrice ?? 0,
        triggered: false,
      },
    }));
  }, []);

  const handleToggleTrail = useCallback((posKey: string) => {
    cyberAudio.click();
    setGuards((prev) => {
      const cur = prev[posKey];
      const nextActive = !cur?.trailEnabled;
      return {
        ...prev,
        [posKey]: {
          target: cur?.target ?? '',
          sl: cur?.sl ?? '',
          trailEnabled: nextActive,
          bestPrice: cur?.bestPrice ?? 0,
          triggered: false,
        },
      };
    });
  }, []);

  const handleSetPresetPts = useCallback((pos: PositionItem, type: 'TP' | 'SL', pts: number) => {
    cyberAudio.click();
    const isLong = pos.netQty > 0;
    const entry = pos.avgPrice > 0 ? pos.avgPrice : (isLong ? pos.buyAvg : (pos.sellAvg || pos.ltp));
    if (entry <= 0) return;

    if (type === 'TP') {
      const tpPrice = isLong ? entry + pts : entry - pts;
      handleGuardChange(pos.id, 'target', tpPrice.toFixed(2));
      addLog('BUY', `Target set for ${pos.tradingSymbol}: +${pts} pts (₹${tpPrice.toFixed(2)})`);
    } else {
      const slPrice = isLong ? entry - pts : entry + pts;
      handleGuardChange(pos.id, 'sl', slPrice.toFixed(2));
      addLog('SELL', `Stop Loss set for ${pos.tradingSymbol}: -${pts} pts (₹${slPrice.toFixed(2)})`);
    }
  }, [handleGuardChange]);

  const handleToggleTrailAll = useCallback(() => {
    cyberAudio.click();
    const active = positions.filter((p) => p.netQty !== 0);
    if (active.length === 0) return;
    const anyOff = active.some((p) => !guards[p.id]?.trailEnabled);
    setGuards((prev) => {
      const next = { ...prev };
      active.forEach((p) => {
        next[p.id] = {
          target: prev[p.id]?.target ?? '',
          sl: prev[p.id]?.sl ?? '',
          trailEnabled: anyOff,
          bestPrice: prev[p.id]?.bestPrice ?? 0,
          triggered: false,
        };
      });
      return next;
    });
    addLog('BUY', anyOff ? 'Trailing SL enabled on all open positions' : 'Trailing SL disabled on all positions');
  }, [positions, guards]);

  // ─── Automated Risk Watcher (TP, SL, Trailing SL) ───────────────────
  useEffect(() => {
    const active = positions.filter((p) => p.netQty !== 0);
    if (active.length === 0) return;

    const peakUpdates: Record<string, number> = {};

    for (const pos of active) {
      const guard = guards[pos.id];
      if (!guard || guard.triggered) continue;

      const ltp = pos.ltp;
      if (!ltp || ltp <= 0) continue;

      const isLong = pos.netQty > 0;
      const entryPrice = pos.avgPrice > 0 ? pos.avgPrice : (isLong ? pos.buyAvg : (pos.sellAvg || 0));
      if (entryPrice <= 0) continue;

      // 1. Take Profit (Target) check
      const targetNum = parseFloat(guard.target);
      if (!isNaN(targetNum) && targetNum > 0) {
        if ((isLong && ltp >= targetNum) || (!isLong && ltp <= targetNum)) {
          guard.triggered = true;
          cyberAudio.exit();
          addLog(
            'EXIT',
            `TARGET HIT: +${pos.points.toFixed(2)} pts!`,
            `Closed ${pos.tradingSymbol} @ ₹${ltp.toFixed(2)} (Target: ₹${targetNum.toFixed(2)})`
          );
          handleClosePosition(pos);
          continue;
        }
      }

      // 2. Trailing Stop Loss or Hard Stop Loss check
      const slNum = parseFloat(guard.sl);
      if (!isNaN(slNum) && slNum > 0) {
        const initialRisk = Math.abs(entryPrice - slNum);

        if (guard.trailEnabled) {
          const currentBest = guard.bestPrice || entryPrice;
          const newBest = isLong ? Math.max(currentBest, ltp) : Math.min(currentBest, ltp);
          if (newBest !== currentBest) {
            peakUpdates[pos.id] = newBest;
          }

          const effectiveBest = peakUpdates[pos.id] ?? newBest;
          const trailFloor = isLong ? effectiveBest - initialRisk : effectiveBest + initialRisk;
          const isTrailActive = isLong ? trailFloor > slNum : trailFloor < slNum;

          if (isTrailActive) {
            if ((isLong && ltp <= trailFloor) || (!isLong && ltp >= trailFloor)) {
              guard.triggered = true;
              cyberAudio.exit();
              addLog(
                'EXIT',
                `TRAILING STOP TRIGGERED!`,
                `Closed ${pos.tradingSymbol} @ ₹${ltp.toFixed(2)} (Locked floor: ₹${trailFloor.toFixed(2)})`
              );
              handleClosePosition(pos);
              continue;
            }
          } else if ((isLong && ltp <= slNum) || (!isLong && ltp >= slNum)) {
            guard.triggered = true;
            cyberAudio.error();
            addLog(
              'ERROR',
              `STOP LOSS HIT!`,
              `Closed ${pos.tradingSymbol} @ ₹${ltp.toFixed(2)} (SL: ₹${slNum.toFixed(2)})`
            );
            handleClosePosition(pos);
            continue;
          }
        } else {
          // Hard SL (no trailing)
          if ((isLong && ltp <= slNum) || (!isLong && ltp >= slNum)) {
            guard.triggered = true;
            cyberAudio.error();
            addLog(
              'ERROR',
              `STOP LOSS HIT!`,
              `Closed ${pos.tradingSymbol} @ ₹${ltp.toFixed(2)} (SL: ₹${slNum.toFixed(2)})`
            );
            handleClosePosition(pos);
            continue;
          }
        }
      }
    }

    if (Object.keys(peakUpdates).length > 0) {
      setGuards((prev) => {
        const next = { ...prev };
        for (const [id, best] of Object.entries(peakUpdates)) {
          if (next[id]) next[id] = { ...next[id], bestPrice: best };
        }
        return next;
      });
    }
  }, [positions, guards, handleClosePosition]);

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
      {/* BLOOMBERG QUANT STICKY HEADER */}
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-4 lg:px-6 py-2.5 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur-md">
        {/* Left: Branding & Underlying */}
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25 shrink-0">
            <Zap className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-bold text-emerald-500 uppercase tracking-[0.18em]">
                QUANT TERMINAL · 9/20 EMA & VWAP SCALPER
              </span>
              {/* Mandatory DATA date chip per AGENTS.md */}
              <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold">
                DATA: {feedData?.dataDate || 'LIVE'}
              </span>
              <span className="flex items-center gap-1 text-[9px] font-mono text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
                <span>{lastTickTime || 'LIVE'}</span>
              </span>
            </div>
            <h1 className="text-sm font-bold text-white tracking-tight flex items-center gap-2 mt-0.5">
              <span>CYBER SCALPER</span>
              <span className="text-zinc-600 font-normal">|</span>
              <span className="text-white font-mono font-bold">{symbol}</span>
              <span className="text-xs font-mono font-bold text-zinc-200">
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
          {/* Broker selector */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
            {authenticatedBrokers.map((b) => (
              <button
                key={b}
                onClick={() => {
                  cyberAudio.click();
                  setBroker(b);
                }}
                className={cn(
                  'px-2 py-1 rounded text-xs font-mono font-bold transition-all',
                  broker === b
                    ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40 shadow-sm'
                    : 'text-zinc-400 hover:text-white'
                )}
                title={`Trade via ${BROKER_LABELS[b]}`}
              >
                {BROKER_LABELS[b]}
              </button>
            ))}
          </div>

          {/* Symbol selector */}
          <div className="flex items-center flex-wrap bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 gap-0.5">
            {POPULAR_SYMBOLS.map((s) => (
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

      {/* BLOOMBERG HIGH-DENSITY MARKET RIBBON */}
      <CyberBloombergRibbon
        symbol={symbol}
        spot={spot}
        change={change}
        changePct={changePct}
        dataDate={feedData?.dataDate}
        live={feedData?.live || null}
        strategy={feedData?.strategy || null}
        lastTickTime={lastTickTime}
        broker={broker}
        openMtm={positions.reduce((sum, p) => sum + (p.netQty !== 0 ? p.pnl : 0), 0)}
      />

      {/* ERROR BANNER */}
      {feedError && (
        <div className="mx-4 lg:mx-6 mt-4 p-3 rounded-xl bg-red-900/20 border border-red-700/40 text-red-400 text-xs font-mono flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{feedError}</span>
        </div>
      )}

      {/* MAIN TERMINAL BODY */}
      <div className="flex-1 flex flex-col gap-4 p-4 lg:p-6 max-w-[1700px] mx-auto w-full">
        {/* 1. EMA 9 & 20 SCALP STRATEGY CONFLUENCE & RISK MATRIX */}
        <CyberStrategyIntelligence
          spot={spot}
          strategy={feedData?.strategy || null}
          onApplyLevels={handleApplyStrategyLevels}
        />

        {/* 2. TELEMETRY HUD: 9/20 EMA DIFFERENCE + VWAP BIAS RADAR */}
        <CyberBiasRadar spot={spot} live={feedData?.live || null} />

        {/* 3. THE BIG SCALPING TERMINAL: MASSIVE BUY & SELL BUTTONS */}
        <CyberOrderPad
          symbol={symbol}
          spot={spot}
          options={feedData?.options || null}
          future={
            broker === 'dhan'
              ? feedData?.future || null
              : broker === 'kotak' && brokerFuture && feedData?.future
              ? { ...feedData.future, trading_symbol: brokerFuture.trading_symbol, lot_size: brokerFuture.lot_size ?? 10 }
              : null
          }
          bias={feedData?.live?.bias || 'NEUTRAL'}
          isExecuting={isExecuting}
          onExecuteTrade={handleExecuteTrade}
          onFlattenAll={handleFlattenAll}
          openPositionsCount={positions.filter((p) => p.netQty !== 0).length}
          suggestedTargetPts={padTargetPts ?? (feedData?.strategy?.target_pts ? Math.round(feedData.strategy.target_pts) : null)}
          suggestedSlPts={padSlPts ?? (feedData?.strategy?.sl_pts ? Math.round(feedData.strategy.sl_pts) : null)}
        />

        {/* 4. POSITIONS TABLE WITH TARGET, SL, TRAILING & LIVE TELEMETRY LOG */}
        <CyberPositionsPanel
          symbol={symbol}
          positions={positions}
          exitedPositions={exitedPositions}
          logs={logs}
          guards={guards}
          onGuardChange={handleGuardChange}
          onToggleTrail={handleToggleTrail}
          onSetPresetPts={handleSetPresetPts}
          onToggleTrailAll={handleToggleTrailAll}
          onClosePosition={handleClosePosition}
          onFlattenAll={handleFlattenAll}
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
