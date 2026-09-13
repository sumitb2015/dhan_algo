'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { ShieldAlert, Table2 } from 'lucide-react';
import NavBar from '@/components/NavBar';
import TopMetricBar from '@/components/options-monitor/TopMetricBar';
import PositionsStrategyMonitor from '@/components/options-monitor/PositionsStrategyMonitor';
import RiskGreeksMatrix from '@/components/options-monitor/RiskGreeksMatrix';
import AddLegModal from '@/components/options-monitor/AddLegModal';
import HotkeysModal from '@/components/options-monitor/HotkeysModal';
import OptionChainModal from '@/components/options-monitor/OptionChainModal';
import OptionOrderModal, { type OptionOrderInitialState, type OptionTradeLeg } from '@/components/OptionOrderModal';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import {
  UNDERLYINGS,
  OptionLegModel,
  OptType,
  Side,
  PositionGuard,
  computeBsGreeks,
  generatePayoffCurve,
  computePortfolioMetrics,
  calculateTimeToExpiryYears,
  extractChainStrikes,
} from '@/lib/optionsMonitorMath';

export default function OptionsMonitorPage() {
  // Underlying configuration
  const [selectedUnderlying, setSelectedUnderlying] = useState<string>('NIFTY');
  const uConfig = UNDERLYINGS[selectedUnderlying] || UNDERLYINGS.NIFTY;

  // Real-time Dhan margin & funds state
  const [availableMargin, setAvailableMargin] = useState<number | null>(null);
  const [isFundsLoading, setIsFundsLoading] = useState<boolean>(false);

  // Expiries & Option Chain state
  const [expiries, setExpiries] = useState<string[]>([]);
  const [selectedExpiry, setSelectedExpiry] = useState<string>('');
  const [chainStrikes, setChainStrikes] = useState<number[]>([]);
  const [normalizedChain, setNormalizedChain] = useState<Record<number, { ce?: any; pe?: any }>>({});
  const [isChainLoading, setIsChainLoading] = useState<boolean>(false);

  // Spot price & market quotes state
  const [spot, setSpot] = useState<number>(uConfig.defaultSpot);
  const [prevClose, setPrevClose] = useState<number>(uConfig.defaultSpot);
  const [change, setChange] = useState<number>(0);
  const [changePct, setChangePct] = useState<number>(0);
  const [ivPct, setIvPct] = useState<number>(14.5);
  const [vix, setVix] = useState<{ ltp: number; change?: number; change_pct?: number } | null>(null);

  // Active Option Positions / Strategy Legs
  const [strategyName, setStrategyName] = useState<string>('Short Strangle');
  const [activeLegs, setActiveLegs] = useState<OptionLegModel[]>([]);
  const hasInitializedPresetRef = useRef<boolean>(false);

  // Position Guards (Target, Stop Loss, Trailing SL) per leg
  const [posGuards, setPosGuards] = useState<Record<string, PositionGuard>>({});
  const posGuardsRef = useRef<Record<string, PositionGuard>>({});
  useEffect(() => {
    posGuardsRef.current = posGuards;
  }, [posGuards]);

  // Modals state
  const [isAddLegOpen, setIsAddLegOpen] = useState<boolean>(false);
  const [isHotkeysOpen, setIsHotkeysOpen] = useState<boolean>(false);
  const [isOptionChainOpen, setIsOptionChainOpen] = useState<boolean>(false);

  // Last action notification message
  const [lastActionMessage, setLastActionMessage] = useState<string | null>(
    'Session initialized. Real-time option chain & WebSocket stream connecting...'
  );

  const notifyAction = useCallback((msg: string) => {
    setLastActionMessage(msg);
  }, []);

  // ── 1. REALTIME WEBSOCKET FEED ─────────────────────────────────────────────
  const { liveQuotes, bridgeStatus, transport, lastUpdated } = useLiveOptionsWS(
    selectedExpiry,
    'dhan',
    ['dhan'],
    selectedUnderlying
  );

  // Start and maintain options WebSocket bridge for live quotes
  useEffect(() => {
    if (!selectedExpiry) return;

    fetch('/api/options/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'start',
        underlying: selectedUnderlying,
        expiry: selectedExpiry,
        numStrikes: 30,
        broker: 'dhan',
      }),
    }).catch(() => {});

    return () => {
      fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'stop',
          brokers: ['dhan'],
          underlying: selectedUnderlying,
        }),
      }).catch(() => {});
    };
  }, [selectedExpiry, selectedUnderlying]);

  // Synchronize incoming ticks from WebSocket to spot, VIX, and normalized chain
  useEffect(() => {
    if (!liveQuotes) return;

    if (typeof liveQuotes.spot === 'number' && liveQuotes.spot > 0) {
      setSpot(liveQuotes.spot);
    }
    if (typeof liveQuotes.spot_change === 'number') {
      setChange(liveQuotes.spot_change);
    }
    if (typeof liveQuotes.spot_change_pct === 'number') {
      setChangePct(liveQuotes.spot_change_pct);
    }
    if (liveQuotes.vix && typeof liveQuotes.vix.ltp === 'number') {
      setVix(liveQuotes.vix);
      if (liveQuotes.vix.ltp > 0) {
        setIvPct(liveQuotes.vix.ltp);
      }
    }

    // Merge strikes from live WebSocket quotes into normalizedChain and chainStrikes
    if (liveQuotes.strikes && Object.keys(liveQuotes.strikes).length > 0) {
      setNormalizedChain((prev) => {
        const next = { ...prev };
        for (const [k, v] of Object.entries(liveQuotes.strikes!)) {
          const s = Math.round(Number(k));
          if (isNaN(s) || s <= 0) continue;
          const existing = next[s] || {};
          const quoteCe = (v as any).ce;
          const quotePe = (v as any).pe;
          next[s] = {
            ce: {
              ...existing.ce,
              last_price: quoteCe?.ltp ?? existing.ce?.last_price,
              previous_close_price: quoteCe?.prev_close ?? existing.ce?.previous_close_price,
              oi: quoteCe?.oi ?? existing.ce?.oi,
              volume: quoteCe?.volume ?? existing.ce?.volume,
            },
            pe: {
              ...existing.pe,
              last_price: quotePe?.ltp ?? existing.pe?.last_price,
              previous_close_price: quotePe?.prev_close ?? existing.pe?.previous_close_price,
              oi: quotePe?.oi ?? existing.pe?.oi,
              volume: quotePe?.volume ?? existing.pe?.volume,
            },
          };
        }
        return next;
      });

      setChainStrikes((prev) => {
        if (prev.length > 0) return prev;
        return Object.keys(liveQuotes.strikes!)
          .map(Number)
          .filter((n) => !isNaN(n) && n > 0)
          .sort((a, b) => a - b);
      });
    }
  }, [liveQuotes]);

  // ── 2. FETCH REAL EXPIRIES ────────────────────────────────────────────────
  const fetchExpiries = useCallback(async (sym: string) => {
    try {
      const res = await fetch(`/api/options/expiries?underlying=${sym}&broker=dhan`, { cache: 'no-store' });
      const data = await res.json();
      const expList: string[] = (data && data.success && (
        Array.isArray(data.data) ? data.data : (Array.isArray(data.expiries) ? data.expiries : [])
      )) || [];
      if (expList.length > 0) {
        setExpiries(expList);
        setSelectedExpiry(expList[0]);
        return expList[0];
      }
    } catch (err) {
      console.error('[OptionsMonitor] Failed to fetch expiries:', err);
    }
    return '';
  }, []);

  // ── 3. FETCH REAL OPTION CHAIN ────────────────────────────────────────────
  const fetchOptionChain = useCallback(async (sym: string, exp: string) => {
    if (!exp) return;
    setIsChainLoading(true);
    try {
      const res = await fetch(`/api/options/chain?underlying=${sym}&expiry=${exp}&broker=dhan`, {
        cache: 'no-store',
      });
      const data = await res.json();
      if (data && data.success && data.data) {
        const chainData = data.data;
        if (typeof chainData.spot === 'number' && chainData.spot > 0) {
          setSpot(chainData.spot);
        }
        if (typeof chainData.prev_close === 'number') {
          setPrevClose(chainData.prev_close);
        }
        if (typeof chainData.change === 'number') {
          setChange(chainData.change);
        }
        if (typeof chainData.change_pct === 'number') {
          setChangePct(chainData.change_pct);
        }

        const rawOc = chainData.chain?.oc || chainData.chain || {};
        const { strikes, normalized } = extractChainStrikes(rawOc);
        if (strikes.length > 0) {
          setChainStrikes(strikes);
          setNormalizedChain((prev) => ({ ...prev, ...normalized }));
        }

        // Compute average ATM IV from the real chain
        const currentSpot = chainData.spot || 23400;
        const atm = Math.round(currentSpot / (UNDERLYINGS[sym]?.strikeStep || 50)) * (UNDERLYINGS[sym]?.strikeStep || 50);
        const atmData = normalized[atm];
        const atmCeIv = atmData?.ce?.implied_volatility;
        const atmPeIv = atmData?.pe?.implied_volatility;
        if (typeof atmCeIv === 'number' && atmCeIv > 0) {
          setIvPct(atmCeIv);
        } else if (typeof atmPeIv === 'number' && atmPeIv > 0) {
          setIvPct(atmPeIv);
        }
      }
    } catch (err) {
      console.error('[OptionsMonitor] Failed to fetch option chain:', err);
    } finally {
      setIsChainLoading(false);
    }
  }, []);

  // ── 4. FETCH CURRENT AVAILABLE MARGIN (DHAN API ONLY) ────────────────────
  const fetchAvailableMargin = useCallback(async () => {
    setIsFundsLoading(true);
    try {
      const res = await fetch('/api/scalper/funds', { cache: 'no-store' });
      const json = await res.json();
      if (json && json.success && json.data) {
        const bal =
          json.data.availabelBalance ??
          json.data.availableBalance ??
          json.data.cashLimit ??
          json.data.cashBalance;
        if (typeof bal === 'number' && Number.isFinite(bal)) {
          setAvailableMargin(bal);
          return;
        }
      }
      setAvailableMargin(null);
    } catch (err) {
      console.error('[OptionsMonitor] Failed to fetch available margin from Dhan API:', err);
      setAvailableMargin(null);
    } finally {
      setIsFundsLoading(false);
    }
  }, []);

  // Initial mount: load expiries, chain, and Dhan funds
  useEffect(() => {
    document.title = 'Options Risk & Strategy Monitor | Dhan Algo';

    let isSubscribed = true;
    (async () => {
      fetchAvailableMargin();
      const exp = await fetchExpiries(selectedUnderlying);
      if (isSubscribed && exp) {
        await fetchOptionChain(selectedUnderlying, exp);
      }
    })();

    return () => {
      isSubscribed = false;
    };
  }, [selectedUnderlying, fetchExpiries, fetchOptionChain, fetchAvailableMargin]);

  // When selectedExpiry changes, re-fetch chain
  useEffect(() => {
    if (selectedExpiry) {
      fetchOptionChain(selectedUnderlying, selectedExpiry);
    }
  }, [selectedExpiry, selectedUnderlying, fetchOptionChain]);

  // Initialize realistic strategy preset once chain data arrives (if no broker positions loaded)
  useEffect(() => {
    if (hasInitializedPresetRef.current || (chainStrikes.length === 0 && Object.keys(normalizedChain).length === 0)) {
      return;
    }
    if (activeLegs.length > 0) {
      hasInitializedPresetRef.current = true;
      return;
    }
    hasInitializedPresetRef.current = true;

    // Build real Short Strangle from the actual option chain or live WebSocket quotes
    const atm = Math.round(spot / uConfig.strikeStep) * uConfig.strikeStep;
    const ceStrike = atm + 2 * uConfig.strikeStep;
    const peStrike = atm - 2 * uConfig.strikeStep;

    const ceTick = liveQuotes?.strikes?.[ceStrike] ?? liveQuotes?.strikes?.[String(ceStrike)];
    const peTick = liveQuotes?.strikes?.[peStrike] ?? liveQuotes?.strikes?.[String(peStrike)];

    const ceChain = normalizedChain[ceStrike]?.ce;
    const peChain = normalizedChain[peStrike]?.pe;

    const t = calculateTimeToExpiryYears(selectedExpiry);
    const ceIv = (ceChain?.implied_volatility ? ceChain.implied_volatility / 100 : ivPct / 100);
    const peIv = (peChain?.implied_volatility ? peChain.implied_volatility / 100 : ivPct / 100);

    const gCe = computeBsGreeks('CE', spot, ceStrike, t, ceIv, uConfig.lotSize);
    const gPe = computeBsGreeks('PE', spot, peStrike, t, peIv, uConfig.lotSize);

    const ceDhanGreeks = ceChain?.greeks;
    const hasCeDhan = ceDhanGreeks && (ceDhanGreeks.delta !== 0 || ceDhanGreeks.gamma !== 0);

    const peDhanGreeks = peChain?.greeks;
    const hasPeDhan = peDhanGreeks && (peDhanGreeks.delta !== 0 || peDhanGreeks.gamma !== 0);

    const cePrice = (typeof ceTick?.ce?.ltp === 'number' && ceTick.ce.ltp > 0)
      ? ceTick.ce.ltp
      : (ceChain?.last_price || ceChain?.previous_close_price || gCe.price);

    const pePrice = (typeof peTick?.pe?.ltp === 'number' && peTick.pe.ltp > 0)
      ? peTick.pe.ltp
      : (peChain?.last_price || peChain?.previous_close_price || gPe.price);

    setActiveLegs([
      {
        id: `leg_ce_init_${Date.now()}`,
        type: 'CE',
        side: 'SELL',
        strike: ceStrike,
        lots: 1,
        qty: 1 * uConfig.lotSize,
        entryPrice: cePrice,
        ltp: cePrice,
        delta: hasCeDhan ? ceDhanGreeks.delta : gCe.delta,
        gamma: hasCeDhan ? ceDhanGreeks.gamma : gCe.gamma,
        theta: hasCeDhan ? ceDhanGreeks.theta : gCe.theta,
        vega: hasCeDhan ? ceDhanGreeks.vega : gCe.vega,
        iv: ceIv,
        expiry: selectedExpiry,
      },
      {
        id: `leg_pe_init_${Date.now()}`,
        type: 'PE',
        side: 'SELL',
        strike: peStrike,
        lots: 1,
        qty: 1 * uConfig.lotSize,
        entryPrice: pePrice,
        ltp: pePrice,
        delta: hasPeDhan ? peDhanGreeks.delta : gPe.delta,
        gamma: hasPeDhan ? peDhanGreeks.gamma : gPe.gamma,
        theta: hasPeDhan ? peDhanGreeks.theta : gPe.theta,
        vega: hasPeDhan ? peDhanGreeks.vega : gPe.vega,
        iv: peIv,
        expiry: selectedExpiry,
      },
    ]);
  }, [chainStrikes, normalizedChain, spot, uConfig.strikeStep, uConfig.lotSize, ivPct, selectedExpiry, liveQuotes, activeLegs.length]);

  // ── 5. REALTIME MERGED LEGS WITH SUB-SECOND WS TICKS ────────────────────────
  // Dynamically recompute each active leg's LTP, Greeks, and MTM as market ticks stream in!
  const activeLegsBase = activeLegs;

  const legs: OptionLegModel[] = useMemo(() => {
    const timeYears = calculateTimeToExpiryYears(selectedExpiry);

    return activeLegsBase.map((leg) => {
      // 1. Look up live WebSocket tick quote
      const tickData = liveQuotes?.strikes?.[leg.strike] ?? liveQuotes?.strikes?.[String(leg.strike)];
      const wsLtp = leg.type === 'CE' ? tickData?.ce?.ltp : tickData?.pe?.ltp;

      // 2. Fallback to Option Chain last_price / previous_close_price
      const chainEntry = normalizedChain[leg.strike];
      const chainSide = leg.type === 'CE' ? chainEntry?.ce : chainEntry?.pe;
      const chainLtp = chainSide?.last_price;
      const chainPrev = chainSide?.previous_close_price;

      const currentLtp = (typeof wsLtp === 'number' && wsLtp > 0)
        ? wsLtp
        : (typeof chainLtp === 'number' && chainLtp > 0)
        ? chainLtp
        : (typeof chainPrev === 'number' && chainPrev > 0)
        ? chainPrev
        : leg.ltp;

      // Implied Volatility
      const chainIv = chainSide?.implied_volatility;
      const effectiveIv = (typeof chainIv === 'number' && chainIv > 0)
        ? chainIv / 100
        : leg.iv || ivPct / 100;

      // Prioritize Dhan API Greeks from option chain
      const dhanGreeks = chainSide?.greeks;
      const hasDhanGreeks = dhanGreeks && (dhanGreeks.delta !== 0 || dhanGreeks.gamma !== 0);

      // Recompute Greeks via Black-Scholes as fallback if Dhan Greeks unavailable
      const g = computeBsGreeks(leg.type, spot, leg.strike, timeYears, effectiveIv, uConfig.lotSize);

      return {
        ...leg,
        expiry: leg.expiry || selectedExpiry,
        ltp: currentLtp,
        delta: hasDhanGreeks ? dhanGreeks.delta : g.delta,
        gamma: hasDhanGreeks ? dhanGreeks.gamma : g.gamma,
        theta: hasDhanGreeks ? dhanGreeks.theta : g.theta,
        vega: hasDhanGreeks ? dhanGreeks.vega : g.vega,
        iv: effectiveIv,
      };
    });
  }, [activeLegsBase, liveQuotes, normalizedChain, selectedExpiry, spot, ivPct, uConfig.lotSize]);

  // Compute portfolio metrics (Total MTM, Net Delta, Net Gamma, Net Theta, Margin)
  const portfolioGreeks = useMemo(() => {
    return computePortfolioMetrics(legs, spot, uConfig.lotSize);
  }, [legs, spot, uConfig.lotSize]);

  // Compute 2D payoff curve & breakevens
  const { points: payoffPoints, breakevens } = useMemo(() => {
    const timeYears = calculateTimeToExpiryYears(selectedExpiry);
    return generatePayoffCurve(legs, spot, uConfig.lotSize, timeYears, ivPct / 100, uConfig.strikeStep);
  }, [legs, spot, uConfig.lotSize, selectedExpiry, ivPct, uConfig.strikeStep]);

  // Total lots & total quantity
  const totalLots = useMemo(() => legs.reduce((sum, l) => sum + l.lots, 0), [legs]);
  const totalQty = useMemo(() => legs.reduce((sum, l) => sum + l.qty, 0), [legs]);

  // Keep live legs reference for interval guards evaluation
  const legsRef = useRef<OptionLegModel[]>([]);
  useEffect(() => {
    legsRef.current = legs;
  }, [legs]);

  const handleGuardChange = useCallback((legId: string, field: 'target' | 'sl', value: string) => {
    setPosGuards((prev) => {
      const existing: PositionGuard = prev[legId] ?? {
        target: '',
        sl: '',
        trailEnabled: false,
        bestPrice: 0,
        triggered: false,
      };
      return {
        ...prev,
        [legId]: { ...existing, [field]: value, triggered: false, triggerReason: undefined },
      };
    });
  }, []);

  const handleTrailToggle = useCallback((legId: string) => {
    setPosGuards((prev) => {
      const existing: PositionGuard = prev[legId] ?? {
        target: '',
        sl: '',
        trailEnabled: false,
        bestPrice: 0,
        triggered: false,
      };
      return {
        ...prev,
        [legId]: {
          ...existing,
          trailEnabled: !existing.trailEnabled,
          bestPrice: 0,
          triggered: false,
          triggerReason: undefined,
        },
      };
    });
  }, []);

  // 1s monitoring loop to evaluate active legs against Target, Stop Loss, and Trailing SL
  useEffect(() => {
    const id = setInterval(() => {
      const guards = posGuardsRef.current;
      const currentLegs = legsRef.current;
      if (!currentLegs || currentLegs.length === 0) return;

      const peakUpdates: Record<string, number> = {};
      const triggeredUpdates: Record<string, string> = {};

      for (const leg of currentLegs) {
        const guard = guards[leg.id];
        if (!guard || guard.triggered) continue;

        const ltp = leg.ltp;
        const entryPrice = leg.entryPrice;
        if (ltp <= 0 || entryPrice <= 0) continue;

        const isLong = leg.side === 'BUY';

        // 1. Target (take profit)
        const targetNum = parseFloat(guard.target);
        if (!isNaN(targetNum) && targetNum > 0) {
          if ((isLong && ltp >= targetNum) || (!isLong && ltp <= targetNum)) {
            triggeredUpdates[leg.id] = 'Target hit';
            continue;
          }
        }

        // 2. Trailing SL & Stop Loss
        const slNum = parseFloat(guard.sl);
        if (guard.trailEnabled && !isNaN(slNum) && slNum > 0) {
          const initialRisk = Math.abs(slNum - entryPrice);
          const currentBest = guard.bestPrice;
          const newBest = currentBest === 0
            ? ltp
            : (isLong ? Math.max(currentBest, ltp) : Math.min(currentBest, ltp));
          if (newBest !== currentBest) {
            peakUpdates[leg.id] = newBest;
          }

          const effectiveBest = peakUpdates[leg.id] ?? currentBest;
          if (effectiveBest > 0 && initialRisk > 0) {
            const trailSLPrice = isLong
              ? effectiveBest - initialRisk
              : effectiveBest + initialRisk;

            const trailActive = isLong ? trailSLPrice > slNum : trailSLPrice < slNum;
            if (trailActive) {
              if ((isLong && ltp <= trailSLPrice) || (!isLong && ltp >= trailSLPrice)) {
                triggeredUpdates[leg.id] = 'Trail SL hit';
                continue;
              }
            } else if ((isLong && ltp <= slNum) || (!isLong && ltp >= slNum)) {
              triggeredUpdates[leg.id] = 'SL hit';
              continue;
            }
          }
        } else if (!isNaN(slNum) && slNum > 0) {
          // Standard Stop Loss
          if ((isLong && ltp <= slNum) || (!isLong && ltp >= slNum)) {
            triggeredUpdates[leg.id] = 'SL hit';
            continue;
          }
        }
      }

      if (Object.keys(peakUpdates).length > 0 || Object.keys(triggeredUpdates).length > 0) {
        setPosGuards((prev) => {
          const next = { ...prev };
          for (const [sId, best] of Object.entries(peakUpdates)) {
            if (next[sId]) {
              next[sId] = { ...next[sId], bestPrice: best };
            }
          }
          for (const [sId, reason] of Object.entries(triggeredUpdates)) {
            if (next[sId]) {
              next[sId] = { ...next[sId], triggered: true, triggerReason: reason };
            }
          }
          return next;
        });

        for (const [sId, reason] of Object.entries(triggeredUpdates)) {
          const matchedLeg = currentLegs.find((l) => l.id === sId);
          if (matchedLeg) {
            notifyAction(
              `⚠️ ALERT: ${matchedLeg.side} ${matchedLeg.strike} ${matchedLeg.type} ${reason}! LTP: ₹${matchedLeg.ltp.toFixed(1)}`
            );
          }
        }
      }
    }, 1000);

    return () => clearInterval(id);
  }, [notifyAction]);

  // ── 6. INTERACTIVE ACTIONS (LEGS, PRESETS, HOTKEYS) ────────────────────────

  // Handle switching underlying
  const handleSelectUnderlying = (sym: string) => {
    setSelectedUnderlying(sym);
    hasInitializedPresetRef.current = false;
    notifyAction(`Switched underlying to ${sym}. Loading option chain & live quotes...`);
  };

  // Add custom leg (open for all strikes across the chain)
  const handleAddLeg = (newLegData: {
    type: OptType;
    side: Side;
    strike: number;
    lots: number;
    entryPrice: number;
  }) => {
    const timeYears = calculateTimeToExpiryYears(selectedExpiry);

    const tickData = liveQuotes?.strikes?.[newLegData.strike] ?? liveQuotes?.strikes?.[String(newLegData.strike)];
    const wsPrice = newLegData.type === 'CE' ? tickData?.ce?.ltp : tickData?.pe?.ltp;

    const chainEntry = normalizedChain[newLegData.strike];
    const chainSide = newLegData.type === 'CE' ? chainEntry?.ce : chainEntry?.pe;
    const chainPrice = chainSide?.last_price || chainSide?.previous_close_price;

    const chainIv = chainSide?.implied_volatility;
    const legIv = (typeof chainIv === 'number' && chainIv > 0)
      ? chainIv / 100
      : ivPct / 100;

    const dhanGreeks = chainSide?.greeks;
    const hasDhanGreeks = dhanGreeks && (dhanGreeks.delta !== 0 || dhanGreeks.gamma !== 0);
    const g = computeBsGreeks(newLegData.type, spot, newLegData.strike, timeYears, legIv, uConfig.lotSize);

    const legLtp = (typeof wsPrice === 'number' && wsPrice > 0)
      ? wsPrice
      : (typeof chainPrice === 'number' && chainPrice > 0)
      ? chainPrice
      : newLegData.entryPrice;

    const newLeg: OptionLegModel = {
      id: `leg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      type: newLegData.type,
      side: newLegData.side,
      strike: newLegData.strike,
      lots: newLegData.lots,
      qty: newLegData.lots * uConfig.lotSize,
      entryPrice: newLegData.entryPrice,
      ltp: legLtp,
      delta: hasDhanGreeks ? dhanGreeks.delta : g.delta,
      gamma: hasDhanGreeks ? dhanGreeks.gamma : g.gamma,
      theta: hasDhanGreeks ? dhanGreeks.theta : g.theta,
      vega: hasDhanGreeks ? dhanGreeks.vega : g.vega,
      iv: legIv,
      expiry: selectedExpiry,
    };

    setActiveLegs((prev) => [...prev, newLeg]);
    setStrategyName('Custom Strategy');
    notifyAction(`Added ${newLegData.side} ${newLegData.strike} ${newLegData.type} (${newLegData.lots} Lots)`);
  };

  // Remove leg
  const handleRemoveLeg = (id: string) => {
    const leg = activeLegs.find((l) => l.id === id);
    setActiveLegs((prev) => prev.filter((l) => l.id !== id));
    setPosGuards((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (leg) notifyAction(`Closed ${leg.side} ${leg.strike} ${leg.type}`);
  };

  // Update strike from dropdown
  const handleUpdateLegStrike = (id: string, newStrike: number) => {
    const timeYears = calculateTimeToExpiryYears(selectedExpiry);

    setActiveLegs((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;

        const tickData = liveQuotes?.strikes?.[newStrike] ?? liveQuotes?.strikes?.[String(newStrike)];
        const wsPrice = l.type === 'CE' ? tickData?.ce?.ltp : tickData?.pe?.ltp;

        const chainEntry = normalizedChain[newStrike];
        const chainSide = l.type === 'CE' ? chainEntry?.ce : chainEntry?.pe;
        const chainPrice = chainSide?.last_price || chainSide?.previous_close_price;

        const chainIv = chainSide?.implied_volatility;
        const effectiveIv = (typeof chainIv === 'number' && chainIv > 0)
          ? chainIv / 100
          : l.iv || ivPct / 100;

        const dhanGreeks = chainSide?.greeks;
        const hasDhanGreeks = dhanGreeks && (dhanGreeks.delta !== 0 || dhanGreeks.gamma !== 0);
        const g = computeBsGreeks(l.type, spot, newStrike, timeYears, effectiveIv, uConfig.lotSize);

        const currentPrice = (typeof wsPrice === 'number' && wsPrice > 0)
          ? wsPrice
          : (typeof chainPrice === 'number' && chainPrice > 0)
          ? chainPrice
          : g.price;

        return {
          ...l,
          strike: newStrike,
          entryPrice: currentPrice,
          ltp: currentPrice,
          delta: hasDhanGreeks ? dhanGreeks.delta : g.delta,
          gamma: hasDhanGreeks ? dhanGreeks.gamma : g.gamma,
          theta: hasDhanGreeks ? dhanGreeks.theta : g.theta,
          vega: hasDhanGreeks ? dhanGreeks.vega : g.vega,
          iv: effectiveIv,
        };
      })
    );
    setPosGuards((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    notifyAction(`Updated strike to ${newStrike}`);
  };

  // Quick Shift strike by steps (+1 or -1 strikeStep)
  const handleQuickShiftStrike = (id: string, steps: number) => {
    const leg = activeLegs.find((l) => l.id === id);
    if (!leg) return;
    const newStrike = leg.strike + steps * uConfig.strikeStep;
    handleUpdateLegStrike(id, newStrike);
  };

  // Load Strategy Preset Templates using real option chain market prices!
  const handleSelectStrategyPreset = (presetId: string) => {
    const atm = Math.round(spot / uConfig.strikeStep) * uConfig.strikeStep;
    const t = calculateTimeToExpiryYears(selectedExpiry);

    if (presetId === 'clear') {
      setActiveLegs([]);
      setPosGuards({});
      setStrategyName('No Active Legs');
      notifyAction('Cleared all positions.');
      return;
    }
    setPosGuards({});

    const getRealQuote = (strike: number, type: 'ce' | 'pe') => {
      // 1. Check live WebSocket quotes
      const tickData = liveQuotes?.strikes?.[strike] ?? liveQuotes?.strikes?.[String(strike)];
      const wsPrice = type === 'ce' ? tickData?.ce?.ltp : tickData?.pe?.ltp;

      // 2. Check normalized option chain
      const entry = normalizedChain[strike];
      const chainSide = entry?.[type];
      const chainP = chainSide?.last_price || chainSide?.previous_close_price;
      const iv = chainSide?.implied_volatility ? chainSide.implied_volatility / 100 : ivPct / 100;
      const dhanGreeks = chainSide?.greeks;
      const hasDhanGreeks = dhanGreeks && (dhanGreeks.delta !== 0 || dhanGreeks.gamma !== 0);

      // 3. Fallback to Black-Scholes theoretical price for this specific strike & type
      const fallbackGreeks = computeBsGreeks(type.toUpperCase() as OptType, spot, strike, t, iv, uConfig.lotSize);
      const price = (typeof wsPrice === 'number' && wsPrice > 0)
        ? wsPrice
        : (typeof chainP === 'number' && chainP > 0)
        ? chainP
        : fallbackGreeks.price;

      return {
        price,
        iv,
        delta: hasDhanGreeks ? dhanGreeks.delta : fallbackGreeks.delta,
        gamma: hasDhanGreeks ? dhanGreeks.gamma : fallbackGreeks.gamma,
        theta: hasDhanGreeks ? dhanGreeks.theta : fallbackGreeks.theta,
        vega: hasDhanGreeks ? dhanGreeks.vega : fallbackGreeks.vega,
      };
    };

    if (presetId === 'short_strangle') {
      setStrategyName('Short Strangle');
      const ceS = atm + uConfig.strikeStep * 2;
      const peS = atm - uConfig.strikeStep * 2;
      const ceQ = getRealQuote(ceS, 'ce');
      const peQ = getRealQuote(peS, 'pe');
      const gCe = computeBsGreeks('CE', spot, ceS, t, ceQ.iv, uConfig.lotSize);
      const gPe = computeBsGreeks('PE', spot, peS, t, peQ.iv, uConfig.lotSize);

      setActiveLegs([
        {
          id: `ce_${Date.now()}`,
          type: 'CE',
          side: 'SELL',
          strike: ceS,
          lots: 1,
          qty: 1 * uConfig.lotSize,
          entryPrice: ceQ.price,
          ltp: ceQ.price,
          delta: gCe.delta,
          gamma: gCe.gamma,
          theta: gCe.theta,
          vega: gCe.vega,
          iv: ceQ.iv,
          expiry: selectedExpiry,
        },
        {
          id: `pe_${Date.now()}`,
          type: 'PE',
          side: 'SELL',
          strike: peS,
          lots: 1,
          qty: 1 * uConfig.lotSize,
          entryPrice: peQ.price,
          ltp: peQ.price,
          delta: gPe.delta,
          gamma: gPe.gamma,
          theta: gPe.theta,
          vega: gPe.vega,
          iv: peQ.iv,
          expiry: selectedExpiry,
        },
      ]);
      notifyAction(`Loaded Short Strangle at ${peS} PE / ${ceS} CE using live chain prices`);
    } else if (presetId === 'short_straddle') {
      setStrategyName('Short Straddle');
      const ceQ = getRealQuote(atm, 'ce');
      const peQ = getRealQuote(atm, 'pe');
      const gCe = computeBsGreeks('CE', spot, atm, t, ceQ.iv, uConfig.lotSize);
      const gPe = computeBsGreeks('PE', spot, atm, t, peQ.iv, uConfig.lotSize);

      setActiveLegs([
        {
          id: `ce_${Date.now()}`,
          type: 'CE',
          side: 'SELL',
          strike: atm,
          lots: 1,
          qty: 1 * uConfig.lotSize,
          entryPrice: ceQ.price,
          ltp: ceQ.price,
          delta: gCe.delta,
          gamma: gCe.gamma,
          theta: gCe.theta,
          vega: gCe.vega,
          iv: ceQ.iv,
          expiry: selectedExpiry,
        },
        {
          id: `pe_${Date.now()}`,
          type: 'PE',
          side: 'SELL',
          strike: atm,
          lots: 1,
          qty: 1 * uConfig.lotSize,
          entryPrice: peQ.price,
          ltp: peQ.price,
          delta: gPe.delta,
          gamma: gPe.gamma,
          theta: gPe.theta,
          vega: gPe.vega,
          iv: peQ.iv,
          expiry: selectedExpiry,
        },
      ]);
      notifyAction(`Loaded Short Straddle at ATM ${atm} using live chain prices`);
    } else if (presetId === 'iron_condor') {
      setStrategyName('Iron Condor');
      const ceShort = atm + uConfig.strikeStep * 2;
      const peShort = atm - uConfig.strikeStep * 2;
      const ceLong = atm + uConfig.strikeStep * 5;
      const peLong = atm - uConfig.strikeStep * 5;

      const ceSq = getRealQuote(ceShort, 'ce');
      const peSq = getRealQuote(peShort, 'pe');
      const ceLq = getRealQuote(ceLong, 'ce');
      const peLq = getRealQuote(peLong, 'pe');

      const gCeS = computeBsGreeks('CE', spot, ceShort, t, ceSq.iv, uConfig.lotSize);
      const gPeS = computeBsGreeks('PE', spot, peShort, t, peSq.iv, uConfig.lotSize);
      const gCeL = computeBsGreeks('CE', spot, ceLong, t, ceLq.iv, uConfig.lotSize);
      const gPeL = computeBsGreeks('PE', spot, peLong, t, peLq.iv, uConfig.lotSize);

      setActiveLegs([
        {
          id: `ce_short_${Date.now()}`,
          type: 'CE',
          side: 'SELL',
          strike: ceShort,
          lots: 1,
          qty: 1 * uConfig.lotSize,
          entryPrice: ceSq.price,
          ltp: ceSq.price,
          delta: gCeS.delta,
          gamma: gCeS.gamma,
          theta: gCeS.theta,
          vega: gCeS.vega,
          iv: ceSq.iv,
          expiry: selectedExpiry,
        },
        {
          id: `pe_short_${Date.now()}`,
          type: 'PE',
          side: 'SELL',
          strike: peShort,
          lots: 1,
          qty: 1 * uConfig.lotSize,
          entryPrice: peSq.price,
          ltp: peSq.price,
          delta: gPeS.delta,
          gamma: gPeS.gamma,
          theta: gPeS.theta,
          vega: gPeS.vega,
          iv: peSq.iv,
          expiry: selectedExpiry,
        },
        {
          id: `ce_long_${Date.now()}`,
          type: 'CE',
          side: 'BUY',
          strike: ceLong,
          lots: 1,
          qty: 1 * uConfig.lotSize,
          entryPrice: ceLq.price,
          ltp: ceLq.price,
          delta: gCeL.delta,
          gamma: gCeL.gamma,
          theta: gCeL.theta,
          vega: gCeL.vega,
          iv: ceLq.iv,
          expiry: selectedExpiry,
        },
        {
          id: `pe_long_${Date.now()}`,
          type: 'PE',
          side: 'BUY',
          strike: peLong,
          lots: 1,
          qty: 1 * uConfig.lotSize,
          entryPrice: peLq.price,
          ltp: peLq.price,
          delta: gPeL.delta,
          gamma: gPeL.gamma,
          theta: gPeL.theta,
          vega: gPeL.vega,
          iv: peLq.iv,
          expiry: selectedExpiry,
        },
      ]);
      notifyAction(`Loaded Iron Condor with defined risk wings`);
    } else if (presetId === 'bull_put_spread') {
      setStrategyName('Bull Put Spread');
      const peShort = atm - uConfig.strikeStep;
      const peLong = atm - uConfig.strikeStep * 3;
      const peSq = getRealQuote(peShort, 'pe');
      const peLq = getRealQuote(peLong, 'pe');
      const gPeS = computeBsGreeks('PE', spot, peShort, t, peSq.iv, uConfig.lotSize);
      const gPeL = computeBsGreeks('PE', spot, peLong, t, peLq.iv, uConfig.lotSize);

      setActiveLegs([
        {
          id: `pe_short_${Date.now()}`,
          type: 'PE',
          side: 'SELL',
          strike: peShort,
          lots: 1,
          qty: 1 * uConfig.lotSize,
          entryPrice: peSq.price,
          ltp: peSq.price,
          delta: gPeS.delta,
          gamma: gPeS.gamma,
          theta: gPeS.theta,
          vega: gPeS.vega,
          iv: peSq.iv,
          expiry: selectedExpiry,
        },
        {
          id: `pe_long_${Date.now()}`,
          type: 'PE',
          side: 'BUY',
          strike: peLong,
          lots: 1,
          qty: 1 * uConfig.lotSize,
          entryPrice: peLq.price,
          ltp: peLq.price,
          delta: gPeL.delta,
          gamma: gPeL.gamma,
          theta: gPeL.theta,
          vega: gPeL.vega,
          iv: peLq.iv,
          expiry: selectedExpiry,
        },
      ]);
      notifyAction(`Loaded Bull Put Credit Spread`);
    } else if (presetId === 'bear_call_spread') {
      setStrategyName('Bear Call Spread');
      const ceShort = atm + uConfig.strikeStep;
      const ceLong = atm + uConfig.strikeStep * 3;
      const ceSq = getRealQuote(ceShort, 'ce');
      const ceLq = getRealQuote(ceLong, 'ce');
      const gCeS = computeBsGreeks('CE', spot, ceShort, t, ceSq.iv, uConfig.lotSize);
      const gCeL = computeBsGreeks('CE', spot, ceLong, t, ceLq.iv, uConfig.lotSize);

      setActiveLegs([
        {
          id: `ce_short_${Date.now()}`,
          type: 'CE',
          side: 'SELL',
          strike: ceShort,
          lots: 1,
          qty: 1 * uConfig.lotSize,
          entryPrice: ceSq.price,
          ltp: ceSq.price,
          delta: gCeS.delta,
          gamma: gCeS.gamma,
          theta: gCeS.theta,
          vega: gCeS.vega,
          iv: ceSq.iv,
          expiry: selectedExpiry,
        },
        {
          id: `ce_long_${Date.now()}`,
          type: 'CE',
          side: 'BUY',
          strike: ceLong,
          lots: 1,
          qty: 1 * uConfig.lotSize,
          entryPrice: ceLq.price,
          ltp: ceLq.price,
          delta: gCeL.delta,
          gamma: gCeL.gamma,
          theta: gCeL.theta,
          vega: gCeL.vega,
          iv: ceLq.iv,
          expiry: selectedExpiry,
        },
      ]);
      notifyAction(`Loaded Bear Call Credit Spread`);
    }
  };

  // Roll Short CE UP (+1 strikeStep)
  const handleRollCeUp = useCallback(() => {
    const ceLeg = activeLegs.find((l) => l.type === 'CE' && l.side === 'SELL');
    if (!ceLeg) {
      notifyAction('No active short CE leg found to roll.');
      return;
    }
    const newStrike = ceLeg.strike + uConfig.strikeStep;
    handleUpdateLegStrike(ceLeg.id, newStrike);
    notifyAction(`Rolled Short CE UP from ${ceLeg.strike} to ${newStrike} (+${uConfig.strikeStep} pts OTM)`);
  }, [activeLegs, uConfig.strikeStep, handleUpdateLegStrike]);

  // Roll Short CE DOWN (-1 strikeStep)
  const handleRollCeDown = useCallback(() => {
    const ceLeg = activeLegs.find((l) => l.type === 'CE' && l.side === 'SELL');
    if (!ceLeg) {
      notifyAction('No active short CE leg found to roll.');
      return;
    }
    const newStrike = ceLeg.strike - uConfig.strikeStep;
    handleUpdateLegStrike(ceLeg.id, newStrike);
    notifyAction(`Rolled Short CE DOWN from ${ceLeg.strike} to ${newStrike} (-${uConfig.strikeStep} pts)`);
  }, [activeLegs, uConfig.strikeStep, handleUpdateLegStrike]);

  // Roll Short PE UP (+1 strikeStep)
  const handleRollPeUp = useCallback(() => {
    const peLeg = activeLegs.find((l) => l.type === 'PE' && l.side === 'SELL');
    if (!peLeg) {
      notifyAction('No active short PE leg found to roll.');
      return;
    }
    const newStrike = peLeg.strike + uConfig.strikeStep;
    handleUpdateLegStrike(peLeg.id, newStrike);
    notifyAction(`Rolled Short PE UP from ${peLeg.strike} to ${newStrike} (+${uConfig.strikeStep} pts)`);
  }, [activeLegs, uConfig.strikeStep, handleUpdateLegStrike]);

  // Roll Short PE DOWN (-1 strikeStep)
  const handleRollPeDown = useCallback(() => {
    const peLeg = activeLegs.find((l) => l.type === 'PE' && l.side === 'SELL');
    if (!peLeg) {
      notifyAction('No active short PE leg found to roll.');
      return;
    }
    const newStrike = peLeg.strike - uConfig.strikeStep;
    handleUpdateLegStrike(peLeg.id, newStrike);
    notifyAction(`Rolled Short PE DOWN from ${peLeg.strike} to ${newStrike} (-${uConfig.strikeStep} pts OTM)`);
  }, [activeLegs, uConfig.strikeStep, handleUpdateLegStrike]);

  const handleRollCe = handleRollCeUp;
  const handleRollPe = handleRollPeDown;

  // Adjust lots for a specific leg (+1 or -1)
  const handleUpdateLegLots = useCallback((id: string, deltaLots: number) => {
    setActiveLegs((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;
        const nextLots = Math.max(1, l.lots + deltaLots);
        return {
          ...l,
          lots: nextLots,
          qty: nextLots * uConfig.lotSize,
        };
      })
    );
    notifyAction(`Adjusted position lot sizing (${deltaLots > 0 ? '+1' : '-1'} Lot)`);
  }, [uConfig.lotSize]);

  // Adjust lots for all legs simultaneously (+1 or -1)
  const handleUpdateAllLots = useCallback((deltaLots: number) => {
    setActiveLegs((prev) =>
      prev.map((l) => {
        const nextLots = Math.max(1, l.lots + deltaLots);
        return {
          ...l,
          lots: nextLots,
          qty: nextLots * uConfig.lotSize,
        };
      })
    );
    notifyAction(`Adjusted all legs by ${deltaLots > 0 ? '+1' : '-1'} Lot`);
  }, [uConfig.lotSize]);

  // Hotkey [H]: 1-Click Delta Hedge
  const handleDeltaHedge = useCallback(() => {
    const currentDelta = portfolioGreeks.netDelta;
    if (Math.abs(currentDelta) < 0.25) {
      notifyAction(`Delta is already balanced (${currentDelta > 0 ? '+' : ''}${currentDelta.toFixed(2)} Δ). No hedge required.`);
      return;
    }

    const atm = Math.round(spot / uConfig.strikeStep) * uConfig.strikeStep;
    if (currentDelta > 0) {
      const hedgeStrike = atm - uConfig.strikeStep;
      const hedgePrice = normalizedChain[hedgeStrike]?.pe?.last_price || 28.0;
      handleAddLeg({
        type: 'PE',
        side: 'BUY',
        strike: hedgeStrike,
        lots: 1,
        entryPrice: hedgePrice,
      });
      notifyAction(`[HOTKEY H] Delta Hedge: Bought 1 Lot ${hedgeStrike} PE to neutralize +${currentDelta.toFixed(2)} Δ`);
    } else {
      const hedgeStrike = atm + uConfig.strikeStep;
      const hedgePrice = normalizedChain[hedgeStrike]?.ce?.last_price || 28.0;
      handleAddLeg({
        type: 'CE',
        side: 'BUY',
        strike: hedgeStrike,
        lots: 1,
        entryPrice: hedgePrice,
      });
      notifyAction(`[HOTKEY H] Delta Hedge: Bought 1 Lot ${hedgeStrike} CE to neutralize ${currentDelta.toFixed(2)} Δ`);
    }
  }, [portfolioGreeks.netDelta, spot, uConfig.strikeStep, normalizedChain]);

  // Hotkey [W]: Add Wings
  const handleAddWings = useCallback(() => {
    const ceLeg = activeLegs.find((l) => l.type === 'CE' && l.side === 'SELL');
    const peLeg = activeLegs.find((l) => l.type === 'PE' && l.side === 'SELL');

    if (!ceLeg || !peLeg) {
      notifyAction('Add Wings requires active Short CE and Short PE legs.');
      return;
    }

    const wingCeStrike = ceLeg.strike + uConfig.strikeStep * 3;
    const wingPeStrike = peLeg.strike - uConfig.strikeStep * 3;
    const t = calculateTimeToExpiryYears(selectedExpiry);

    const ceChainEntry = normalizedChain[wingCeStrike]?.ce;
    const peChainEntry = normalizedChain[wingPeStrike]?.pe;
    const ceChainP = ceChainEntry?.last_price || ceChainEntry?.previous_close_price;
    const peChainP = peChainEntry?.last_price || peChainEntry?.previous_close_price;

    const ceDhanGreeks = ceChainEntry?.greeks;
    const peDhanGreeks = peChainEntry?.greeks;
    const hasCeDhan = ceDhanGreeks && (ceDhanGreeks.delta !== 0 || ceDhanGreeks.gamma !== 0);
    const hasPeDhan = peDhanGreeks && (peDhanGreeks.delta !== 0 || peDhanGreeks.gamma !== 0);

    const gCe = computeBsGreeks('CE', spot, wingCeStrike, t, ivPct / 100, uConfig.lotSize);
    const gPe = computeBsGreeks('PE', spot, wingPeStrike, t, ivPct / 100, uConfig.lotSize);

    const ceWing: OptionLegModel = {
      id: `wing_ce_${Date.now()}`,
      type: 'CE',
      side: 'BUY',
      strike: wingCeStrike,
      lots: ceLeg.lots,
      qty: ceLeg.lots * uConfig.lotSize,
      entryPrice: typeof ceChainP === 'number' && ceChainP > 0 ? ceChainP : gCe.price,
      ltp: typeof ceChainP === 'number' && ceChainP > 0 ? ceChainP : gCe.price,
      delta: hasCeDhan ? ceDhanGreeks.delta : gCe.delta,
      gamma: hasCeDhan ? ceDhanGreeks.gamma : gCe.gamma,
      theta: hasCeDhan ? ceDhanGreeks.theta : gCe.theta,
      vega: hasCeDhan ? ceDhanGreeks.vega : gCe.vega,
      iv: ivPct / 100,
    };

    const peWing: OptionLegModel = {
      id: `wing_pe_${Date.now()}`,
      type: 'PE',
      side: 'BUY',
      strike: wingPeStrike,
      lots: peLeg.lots,
      qty: peLeg.lots * uConfig.lotSize,
      entryPrice: typeof peChainP === 'number' && peChainP > 0 ? peChainP : gPe.price,
      ltp: typeof peChainP === 'number' && peChainP > 0 ? peChainP : gPe.price,
      delta: hasPeDhan ? peDhanGreeks.delta : gPe.delta,
      gamma: hasPeDhan ? peDhanGreeks.gamma : gPe.gamma,
      theta: hasPeDhan ? peDhanGreeks.theta : gPe.theta,
      vega: hasPeDhan ? peDhanGreeks.vega : gPe.vega,
      iv: ivPct / 100,
    };

    setActiveLegs((prev) => [...prev, ceWing, peWing]);
    setStrategyName('Iron Condor (Wings Added)');
    notifyAction(`[HOTKEY W] Wings Added: Bought ${wingPeStrike} PE & ${wingCeStrike} CE`);
  }, [activeLegs, spot, ivPct, uConfig.strikeStep, uConfig.lotSize, normalizedChain, selectedExpiry]);

  // Hotkey [X]: Trim 50%
  const handleTrim50 = useCallback(() => {
    if (activeLegs.length === 0) {
      notifyAction('No active legs to trim.');
      return;
    }
    setActiveLegs((prev) =>
      prev.map((l) => {
        const newLots = Math.max(1, Math.round(l.lots / 2));
        return {
          ...l,
          lots: newLots,
          qty: newLots * uConfig.lotSize,
        };
      })
    );
    notifyAction('[HOTKEY X] Trimmed 50% lots across positions.');
  }, [activeLegs, uConfig.lotSize]);

  // Hotkey [ESC]: Flatten
  const handleFlatten = useCallback(() => {
    if (activeLegs.length === 0) {
      notifyAction('Position already flat.');
      return;
    }
    setActiveLegs([]);
    setStrategyName('Flat / No Position');
    notifyAction('[HOTKEY ESC] Positions cleared.');
  }, [activeLegs]);

  // ── 7. ORDER EXECUTION STATE & HANDLERS ──────────────────────────────────
  const [orderModalOpen, setOrderModalOpen] = useState(false);
  const [activeTradeOrder, setActiveTradeOrder] = useState<OptionOrderInitialState | null>(null);

  const handleOpenTradeBasket = useCallback(() => {
    if (activeLegs.length === 0) {
      setIsAddLegOpen(true);
      notifyAction('Add legs or load a template preset before executing a basket order.');
      return;
    }

    const firstLots = activeLegs[0]?.lots || 1;
    const allSame = activeLegs.every((l) => l.lots === firstLots);
    const baseMultiplier = allSame ? firstLots : 1;

    const orderLegs: OptionTradeLeg[] = activeLegs.map((leg) => {
      const legKey = leg.type.toLowerCase() as 'ce' | 'pe';
      const secId = normalizedChain[leg.strike]?.[legKey]?.security_id;
      return {
        strike: leg.strike,
        optionType: leg.type,
        action: leg.side,
        lots: allSame ? 1 : leg.lots,
        securityId: secId ? String(secId) : undefined,
      };
    });

    setActiveTradeOrder({
      title: `${selectedUnderlying} ${strategyName} (${activeLegs.length} Legs)`,
      underlying: selectedUnderlying,
      expiry: selectedExpiry,
      lotSize: uConfig.lotSize,
      defaultLots: baseMultiplier,
      legs: orderLegs,
      productType: 'INTRADAY',
    });
    setOrderModalOpen(true);
  }, [activeLegs, selectedUnderlying, strategyName, selectedExpiry, uConfig.lotSize, normalizedChain, notifyAction]);

  const handleOpenSingleLegTrade = useCallback((leg: OptionLegModel) => {
    const legKey = leg.type.toLowerCase() as 'ce' | 'pe';
    const secId = normalizedChain[leg.strike]?.[legKey]?.security_id;
    setActiveTradeOrder({
      title: `${selectedUnderlying} ${leg.strike} ${leg.type} (${leg.side})`,
      underlying: selectedUnderlying,
      expiry: selectedExpiry,
      lotSize: uConfig.lotSize,
      defaultLots: 1,
      legs: [
        {
          strike: leg.strike,
          optionType: leg.type,
          action: leg.side,
          lots: leg.lots,
          securityId: secId ? String(secId) : undefined,
        },
      ],
      productType: 'INTRADAY',
    });
    setOrderModalOpen(true);
  }, [selectedUnderlying, selectedExpiry, uConfig.lotSize, normalizedChain]);

  const handleOpenSingleLegClose = useCallback((leg: OptionLegModel) => {
    const legKey = leg.type.toLowerCase() as 'ce' | 'pe';
    const secId = normalizedChain[leg.strike]?.[legKey]?.security_id;
    const oppositeAction = leg.side === 'BUY' ? 'SELL' : 'BUY';
    setActiveTradeOrder({
      title: `Square Off: ${selectedUnderlying} ${leg.strike} ${leg.type} (${oppositeAction})`,
      underlying: selectedUnderlying,
      expiry: selectedExpiry,
      lotSize: uConfig.lotSize,
      defaultLots: 1,
      legs: [
        {
          strike: leg.strike,
          optionType: leg.type,
          action: oppositeAction,
          lots: leg.lots,
          securityId: secId ? String(secId) : undefined,
        },
      ],
      productType: 'INTRADAY',
    });
    setOrderModalOpen(true);
  }, [selectedUnderlying, selectedExpiry, uConfig.lotSize, normalizedChain]);

  const handleOpenNewTrade = useCallback(() => {
    if (activeLegs.length > 0) {
      handleOpenTradeBasket();
    } else {
      setIsAddLegOpen(true);
    }
  }, [activeLegs.length, handleOpenTradeBasket]);

  const handleExecuteLegFromModal = useCallback((leg: {
    type: OptType;
    side: Side;
    strike: number;
    lots: number;
    entryPrice: number;
  }) => {
    const legKey = leg.type.toLowerCase() as 'ce' | 'pe';
    const secId = normalizedChain[leg.strike]?.[legKey]?.security_id;
    setActiveTradeOrder({
      title: `${selectedUnderlying} ${leg.strike} ${leg.type} (${leg.side})`,
      underlying: selectedUnderlying,
      expiry: selectedExpiry,
      lotSize: uConfig.lotSize,
      defaultLots: 1,
      legs: [
        {
          strike: leg.strike,
          optionType: leg.type,
          action: leg.side,
          lots: leg.lots,
          securityId: secId ? String(secId) : undefined,
        },
      ],
      productType: 'INTRADAY',
    });
    setOrderModalOpen(true);
  }, [selectedUnderlying, selectedExpiry, uConfig.lotSize, normalizedChain]);

  const handleOrderSuccess = useCallback((orderIds: string[], summary: string) => {
    notifyAction(`Intraday orders placed successfully [INTRADAY]! IDs: ${orderIds.join(', ')}`);
    setActiveLegs((prev) => prev.map((l) => ({ ...l, isEntered: true })));
    fetchAvailableMargin();
  }, [notifyAction, fetchAvailableMargin]);

  const handleToggleLegEntered = useCallback((id: string) => {
    setActiveLegs((prev) =>
      prev.map((l) => (l.id === id ? { ...l, isEntered: !l.isEntered } : l))
    );
  }, []);

  const handleAddLegFromChain = useCallback((leg: {
    type: 'CE' | 'PE';
    side: 'BUY' | 'SELL';
    strike: number;
    ltp: number;
    expiry: string;
    iv?: number;
    delta?: number;
  }) => {
    const timeRemaining = calculateTimeToExpiryYears(leg.expiry || selectedExpiry);
    const legIv = leg.iv ?? ivPct / 100;
    const g = computeBsGreeks(leg.type, spot, leg.strike, timeRemaining, legIv, uConfig.lotSize);

    const chainSide = leg.type === 'CE' ? normalizedChain[leg.strike]?.ce : normalizedChain[leg.strike]?.pe;
    const dhanGreeks = chainSide?.greeks;
    const hasDhanGreeks = dhanGreeks && (dhanGreeks.delta !== 0 || dhanGreeks.gamma !== 0);

    const newLeg: OptionLegModel = {
      id: `leg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: leg.type,
      side: leg.side,
      strike: leg.strike,
      lots: 1,
      qty: uConfig.lotSize,
      entryPrice: leg.ltp,
      ltp: leg.ltp,
      delta: leg.delta ?? (hasDhanGreeks ? dhanGreeks.delta : g.delta),
      gamma: hasDhanGreeks ? dhanGreeks.gamma : g.gamma,
      theta: hasDhanGreeks ? dhanGreeks.theta : g.theta,
      vega: hasDhanGreeks ? dhanGreeks.vega : g.vega,
      iv: legIv,
      expiry: leg.expiry || selectedExpiry,
    };

    setActiveLegs((prev) => [...prev, newLeg]);
    notifyAction(`Added ${leg.side} ${leg.strike} ${leg.type} to strategy from Option Chain.`);
  }, [selectedExpiry, ivPct, spot, uConfig.lotSize, normalizedChain, notifyAction]);

  // ── 8. GLOBAL KEYBOARD SHORTCUTS ──────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      const key = e.key.toUpperCase();

      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        if (e.shiftKey) {
          handleRollCeDown();
        } else {
          handleRollCeUp();
        }
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        if (e.shiftKey) {
          handleRollPeUp();
        } else {
          handleRollPeDown();
        }
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        handleUpdateAllLots(1);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        handleUpdateAllLots(-1);
      } else if (key === 'H') {
        e.preventDefault();
        handleDeltaHedge();
      } else if (key === 'W') {
        e.preventDefault();
        handleAddWings();
      } else if (key === 'X') {
        e.preventDefault();
        handleTrim50();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleFlatten();
      } else if (key === 'A') {
        e.preventDefault();
        setIsAddLegOpen(true);
      } else if (e.key === 'F5' || key === 'T') {
        e.preventDefault();
        handleOpenNewTrade();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    handleRollCeUp,
    handleRollCeDown,
    handleRollPeUp,
    handleRollPeDown,
    handleUpdateAllLots,
    handleDeltaHedge,
    handleAddWings,
    handleTrim50,
    handleFlatten,
    handleOpenNewTrade,
  ]);

  const todayStr = new Date().toISOString().split('T')[0];

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col font-sans">
      {/* ── STICKY TOP HEADER STACK (Canonical App Header + Live Strategy Metrics Strip) ── */}
      <div className="sticky top-0 z-30 w-full flex flex-col bg-zinc-950/95 backdrop-blur shadow-md">
        {/* ROW 1: Canonical App Header with Icon, Title, Eyebrow, Quick Navigation & NavBar */}
        <header className="w-full border-b border-zinc-800/80 px-4 md:px-6 py-2 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/25 shrink-0 shadow-sm shadow-indigo-500/10">
              <ShieldAlert className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="text-[9px] font-bold text-indigo-400 uppercase tracking-[0.18em]">
                  OPTIONS RISK DESK · {selectedUnderlying}
                </p>
                <span className="text-[9px] font-bold font-mono px-1.5 py-0.2 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
                  REALTIME DERIVATIVES
                </span>
              </div>
              <h1 className="text-sm font-bold text-white tracking-wide">
                Options Risk & Strategy Monitor
              </h1>
            </div>
          </div>

          {/* Center Navigation Shortcuts */}
          <div className="hidden lg:flex items-center gap-1 bg-zinc-900 p-1 rounded-xl border border-zinc-800 text-xs font-medium">
            <button
              type="button"
              onClick={() => setIsOptionChainOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 font-bold transition-colors cursor-pointer"
              title="Open Interactive Option Chain Window"
            >
              <Table2 className="w-3.5 h-3.5" />
              <span>Option Chain</span>
            </button>
            <Link
              href="/options/live-charts"
              className="px-2.5 py-1 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            >
              IV Charts
            </Link>
            <Link
              href="/advanced-scalper"
              className="px-2.5 py-1 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            >
              Advanced Scalper
            </Link>
            <Link
              href="/scalper"
              className="px-2.5 py-1 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            >
              Scalper Terminal
            </Link>
            <Link
              href="/multi-leg-focus"
              className="px-2.5 py-1 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            >
              Multi-Leg Focus
            </Link>
          </div>

          {/* Right Controls: Global Navbar */}
          <div className="flex items-center gap-2">
            <NavBar />
          </div>
        </header>

        {/* ROW 2: Bloomberg Top Metric Bar (Data currency chip, Spot, Greeks, Transport status) */}
        <TopMetricBar
          selectedUnderlying={selectedUnderlying}
          onSelectUnderlying={(sym) => {
            setSelectedUnderlying(sym);
            hasInitializedPresetRef.current = false;
            fetchExpiries(sym).then((exp) => {
              if (exp) fetchOptionChain(sym, exp);
            });
          }}
          expiries={expiries}
          selectedExpiry={selectedExpiry}
          onSelectExpiry={(exp) => {
            setSelectedExpiry(exp);
            fetchOptionChain(selectedUnderlying, exp);
            notifyAction(`Switched active expiry to ${exp}`);
          }}
          spot={spot}
          prevClose={prevClose}
          change={change}
          changePct={changePct}
          ivPct={ivPct}
          vix={vix}
          totalMtm={portfolioGreeks.totalMtm}
          mtmPct={portfolioGreeks.mtmPct}
          netTheta={portfolioGreeks.netTheta}
          estimatedMargin={portfolioGreeks.estimatedMargin}
          availableMargin={availableMargin}
          isFundsLoading={isFundsLoading}
          isLiveLoading={isChainLoading}
          wsTransport={transport}
          wsStatus={bridgeStatus.status}
          lastUpdated={lastUpdated}
          onRefreshQuotes={() => {
            fetchOptionChain(selectedUnderlying, selectedExpiry);
            fetchAvailableMargin();
            notifyAction('Refreshed live market quotes & Dhan funds.');
          }}
          onToggleHotkeysModal={() => setIsHotkeysOpen(true)}
          onOpenTrade={handleOpenNewTrade}
          onOpenOptionChain={() => setIsOptionChainOpen(true)}
        />
      </div>

      {/* ── MAIN WORKSPACE (Expanded Left Strategy / Narrow Right Rail) ── */}
      <main className="flex-1 w-full max-w-[1700px] mx-auto p-3 md:p-4">
        <div className="flex flex-col lg:flex-row gap-3 md:gap-4">
          {/* LEFT COLUMN: Expansive Strategy, Positions Table & Payoff Curve */}
          <div className="flex-1 min-w-0 w-full">
            <PositionsStrategyMonitor
              strategyName={strategyName}
              totalLots={totalLots}
              totalQty={totalQty}
              legs={legs}
              spot={spot}
              strikeStep={uConfig.strikeStep}
              payoffPoints={payoffPoints}
              breakevens={breakevens}
              chainStrikes={chainStrikes}
              currentExpiry={selectedExpiry}
              guards={posGuards}
              onGuardChange={handleGuardChange}
              onTrailToggle={handleTrailToggle}
              onAddLegClick={() => setIsAddLegOpen(true)}
              onRemoveLeg={handleRemoveLeg}
              onUpdateLegStrike={handleUpdateLegStrike}
              onQuickShiftStrike={handleQuickShiftStrike}
              onSelectStrategyPreset={handleSelectStrategyPreset}
              onUpdateLegLots={handleUpdateLegLots}
              onUpdateAllLots={handleUpdateAllLots}
              onOpenTradeBasket={handleOpenTradeBasket}
              onOpenSingleLegTrade={handleOpenSingleLegTrade}
              onCloseSingleLeg={handleOpenSingleLegClose}
              onToggleLegEntered={handleToggleLegEntered}
              onOpenOptionChain={() => setIsOptionChainOpen(true)}
            />
          </div>

          {/* RIGHT COLUMN: Professional Narrow Greeks & Quick Execution Rail */}
          <div className="w-full lg:w-[320px] xl:w-[340px] shrink-0">
            <RiskGreeksMatrix
              greeks={portfolioGreeks}
              lastActionMessage={lastActionMessage}
              availableMargin={availableMargin}
              onRollCe={handleRollCe}
              onRollPe={handleRollPe}
              onRollCeUp={handleRollCeUp}
              onRollCeDown={handleRollCeDown}
              onRollPeUp={handleRollPeUp}
              onRollPeDown={handleRollPeDown}
              onDeltaHedge={handleDeltaHedge}
              onAddWings={handleAddWings}
              onTrim50={handleTrim50}
              onFlatten={handleFlatten}
              onOpenTradeBasket={handleOpenTradeBasket}
            />
          </div>
        </div>
      </main>

      {/* ── MODALS ───────────────────────────────────────────────────────── */}
      <AddLegModal
        isOpen={isAddLegOpen}
        onClose={() => setIsAddLegOpen(false)}
        spot={spot}
        strikeStep={uConfig.strikeStep}
        defaultLots={2}
        chainStrikes={chainStrikes}
        chain={normalizedChain}
        liveQuotes={liveQuotes}
        onAddLeg={handleAddLeg}
        onExecuteLeg={handleExecuteLegFromModal}
      />

      <HotkeysModal
        isOpen={isHotkeysOpen}
        onClose={() => setIsHotkeysOpen(false)}
      />

      {/* ── BROKER ORDER EXECUTION MODAL ─────────────────────────────────── */}
      <OptionOrderModal
        isOpen={orderModalOpen}
        onClose={() => setOrderModalOpen(false)}
        initialOrder={activeTradeOrder}
        onOrderSuccess={handleOrderSuccess}
      />

      {/* ── OPTION CHAIN MODAL WINDOW ─────────────────────────────────────── */}
      <OptionChainModal
        isOpen={isOptionChainOpen}
        onClose={() => setIsOptionChainOpen(false)}
        underlying={selectedUnderlying}
        expiries={expiries}
        currentExpiry={selectedExpiry}
        spot={spot}
        broker="dhan"
        liveQuotes={liveQuotes}
        onSelectExpiry={(exp) => {
          setSelectedExpiry(exp);
          fetchOptionChain(selectedUnderlying, exp);
          notifyAction(`Switched active expiry to ${exp}`);
        }}
        onAddLeg={handleAddLegFromChain}
      />
    </div>
  );
}
