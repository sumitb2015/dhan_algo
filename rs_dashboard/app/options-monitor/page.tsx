'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import NavBar from '@/components/NavBar';
import TopMetricBar from '@/components/options-monitor/TopMetricBar';
import PositionsStrategyMonitor from '@/components/options-monitor/PositionsStrategyMonitor';
import RiskGreeksMatrix from '@/components/options-monitor/RiskGreeksMatrix';
import AddLegModal from '@/components/options-monitor/AddLegModal';
import HotkeysModal from '@/components/options-monitor/HotkeysModal';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import {
  UNDERLYINGS,
  OptionLegModel,
  OptType,
  Side,
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

  // View Mode: 'broker' (Live Dhan positions) vs 'custom' (What-if Desk Simulator)
  const [viewMode, setViewMode] = useState<'broker' | 'custom'>('custom');
  const [strategyName, setStrategyName] = useState<string>('Short Strangle');
  const [brokerLegs, setBrokerLegs] = useState<OptionLegModel[]>([]);
  const [customLegs, setCustomLegs] = useState<OptionLegModel[]>([]);
  const [isBrokerLoading, setIsBrokerLoading] = useState<boolean>(false);
  const hasInitializedPresetRef = useRef<boolean>(false);

  // Modals state
  const [isAddLegOpen, setIsAddLegOpen] = useState<boolean>(false);
  const [isHotkeysOpen, setIsHotkeysOpen] = useState<boolean>(false);

  // Last action notification message
  const [lastActionMessage, setLastActionMessage] = useState<string | null>(
    'Session initialized. Real-time option chain & WebSocket stream connecting...'
  );

  const notifyAction = (msg: string) => {
    setLastActionMessage(msg);
  };

  // ── 1. REALTIME WEBSOCKET FEED ─────────────────────────────────────────────
  const { liveQuotes, bridgeStatus, transport } = useLiveOptionsWS(
    selectedExpiry,
    'dhan',
    ['dhan'],
    selectedUnderlying
  );

  // Synchronize incoming ticks from WebSocket to spot & VIX
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
  }, [liveQuotes]);

  // ── 2. FETCH REAL EXPIRIES ────────────────────────────────────────────────
  const fetchExpiries = useCallback(async (sym: string) => {
    try {
      const res = await fetch(`/api/options/expiries?underlying=${sym}&broker=dhan`, { cache: 'no-store' });
      const data = await res.json();
      if (data && data.success && Array.isArray(data.expiries) && data.expiries.length > 0) {
        setExpiries(data.expiries);
        setSelectedExpiry(data.expiries[0]);
        return data.expiries[0];
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

        const rawOc = chainData.chain?.oc || {};
        const { strikes, normalized } = extractChainStrikes(rawOc);
        setChainStrikes(strikes);
        setNormalizedChain(normalized);

        // Compute average ATM IV from the real chain
        const currentSpot = chainData.spot || spot;
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
  }, [spot]);

  // ── 4. FETCH LIVE BROKER POSITIONS ────────────────────────────────────────
  const fetchBrokerPositions = useCallback(async () => {
    setIsBrokerLoading(true);
    try {
      const res = await fetch('/api/options/positions-live', { cache: 'no-store' });
      const data = await res.json();
      if (data && data.has_positions && Array.isArray(data.legs) && data.legs.length > 0) {
        const timeRemaining = calculateTimeToExpiryYears(selectedExpiry);
        const currentSpot = spot;

        // Filter legs for the currently selected underlying (e.g. NIFTY)
        const matched = data.legs.filter((l: any) =>
          String(l.symbol).toUpperCase().startsWith(selectedUnderlying)
        );

        if (matched.length > 0) {
          const mapped: OptionLegModel[] = matched.map((l: any, idx: number) => {
            const strike = Math.round(Number(l.strike));
            const type: OptType = String(l.type).toUpperCase() === 'PE' ? 'PE' : 'CE';
            const side: Side = String(l.side).toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
            const qty = Math.abs(Number(l.netQty));
            const lots = Math.max(1, Math.round(qty / uConfig.lotSize));
            const entryPrice = Number(l.entryPrice) || 0;
            const ltp = Number(l.ltp) || entryPrice;
            const legIv = ivPct / 100;

            const g = computeBsGreeks(type, currentSpot, strike, timeRemaining, legIv, uConfig.lotSize);

            return {
              id: `broker_${idx}_${l.symbol}`,
              type,
              side,
              strike,
              lots,
              qty,
              entryPrice,
              ltp,
              delta: g.delta,
              gamma: g.gamma,
              theta: g.theta,
              vega: g.vega,
              iv: legIv,
            };
          });

          setBrokerLegs(mapped);

          // If this is the initial mount and we found real broker positions, default to 'broker' mode
          if (!hasInitializedPresetRef.current) {
            setViewMode('broker');
            setStrategyName('Dhan Live Positions');
            notifyAction(`Loaded ${mapped.length} live broker positions from Dhan HQ.`);
          }
          return;
        }
      }
      setBrokerLegs([]);
    } catch (err) {
      console.error('[OptionsMonitor] Error fetching broker positions:', err);
    } finally {
      setIsBrokerLoading(false);
    }
  }, [selectedExpiry, spot, selectedUnderlying, uConfig.lotSize, ivPct]);

  // Initial mount: load expiries, chain, and broker positions
  useEffect(() => {
    document.title = 'Options Risk & Strategy Monitor | Dhan Algo';

    let isSubscribed = true;
    (async () => {
      const exp = await fetchExpiries(selectedUnderlying);
      if (isSubscribed && exp) {
        await fetchOptionChain(selectedUnderlying, exp);
        await fetchBrokerPositions();
      }
    })();

    return () => {
      isSubscribed = false;
    };
  }, [selectedUnderlying, fetchExpiries, fetchOptionChain, fetchBrokerPositions]);

  // When selectedExpiry changes, re-fetch chain
  useEffect(() => {
    if (selectedExpiry) {
      fetchOptionChain(selectedUnderlying, selectedExpiry);
    }
  }, [selectedExpiry, selectedUnderlying, fetchOptionChain]);

  // Initialize realistic Desk preset once chain data arrives (if not in broker mode)
  useEffect(() => {
    if (hasInitializedPresetRef.current || chainStrikes.length === 0 || Object.keys(normalizedChain).length === 0) {
      return;
    }
    hasInitializedPresetRef.current = true;

    // Build real Short Strangle from the actual option chain
    const atm = Math.round(spot / uConfig.strikeStep) * uConfig.strikeStep;
    const ceStrike = atm + 2 * uConfig.strikeStep;
    const peStrike = atm - 2 * uConfig.strikeStep;

    const ceChain = normalizedChain[ceStrike]?.ce;
    const peChain = normalizedChain[peStrike]?.pe;

    const cePrice = ceChain?.last_price || ceChain?.previous_close_price || 35.0;
    const pePrice = peChain?.last_price || peChain?.previous_close_price || 30.0;
    const ceIv = (ceChain?.implied_volatility ? ceChain.implied_volatility / 100 : ivPct / 100);
    const peIv = (peChain?.implied_volatility ? peChain.implied_volatility / 100 : ivPct / 100);

    const t = calculateTimeToExpiryYears(selectedExpiry);
    const gCe = computeBsGreeks('CE', spot, ceStrike, t, ceIv, uConfig.lotSize);
    const gPe = computeBsGreeks('PE', spot, peStrike, t, peIv, uConfig.lotSize);

    setCustomLegs([
      {
        id: `desk_ce_init_${Date.now()}`,
        type: 'CE',
        side: 'SELL',
        strike: ceStrike,
        lots: 2,
        qty: 2 * uConfig.lotSize,
        entryPrice: cePrice,
        ltp: cePrice,
        delta: gCe.delta,
        gamma: gCe.gamma,
        theta: gCe.theta,
        vega: gCe.vega,
        iv: ceIv,
      },
      {
        id: `desk_pe_init_${Date.now()}`,
        type: 'PE',
        side: 'SELL',
        strike: peStrike,
        lots: 2,
        qty: 2 * uConfig.lotSize,
        entryPrice: pePrice,
        ltp: pePrice,
        delta: gPe.delta,
        gamma: gPe.gamma,
        theta: gPe.theta,
        vega: gPe.vega,
        iv: peIv,
      },
    ]);
  }, [chainStrikes, normalizedChain, spot, uConfig.strikeStep, uConfig.lotSize, ivPct, selectedExpiry]);

  // ── 5. REALTIME MERGED LEGS WITH SUB-SECOND WS TICKS ────────────────────────
  // Dynamically recompute each active leg's LTP, Greeks, and MTM as market ticks stream in!
  const activeLegsBase = viewMode === 'broker' ? brokerLegs : customLegs;

  const legs: OptionLegModel[] = useMemo(() => {
    const timeYears = calculateTimeToExpiryYears(selectedExpiry);

    return activeLegsBase.map((leg) => {
      // 1. Look up live WebSocket tick quote
      const tickData = liveQuotes?.strikes?.[leg.strike] ?? liveQuotes?.strikes?.[String(leg.strike)];
      const wsLtp = leg.type === 'CE' ? tickData?.ce?.ltp : tickData?.pe?.ltp;

      // 2. Fallback to Option Chain last_price / previous_close_price
      const chainEntry = normalizedChain[leg.strike];
      const chainLtp = leg.type === 'CE' ? chainEntry?.ce?.last_price : chainEntry?.pe?.last_price;
      const chainPrev = leg.type === 'CE' ? chainEntry?.ce?.previous_close_price : chainEntry?.pe?.previous_close_price;

      const currentLtp = (typeof wsLtp === 'number' && wsLtp > 0)
        ? wsLtp
        : (typeof chainLtp === 'number' && chainLtp > 0)
        ? chainLtp
        : (typeof chainPrev === 'number' && chainPrev > 0)
        ? chainPrev
        : leg.ltp;

      // Implied Volatility
      const chainIv = leg.type === 'CE'
        ? chainEntry?.ce?.implied_volatility
        : chainEntry?.pe?.implied_volatility;
      const effectiveIv = (typeof chainIv === 'number' && chainIv > 0)
        ? chainIv / 100
        : leg.iv || ivPct / 100;

      // Recompute real Greeks via Black-Scholes using actual spot, strike, T, and IV
      const g = computeBsGreeks(leg.type, spot, leg.strike, timeYears, effectiveIv, uConfig.lotSize);

      return {
        ...leg,
        ltp: currentLtp,
        delta: g.delta,
        gamma: g.gamma,
        theta: g.theta,
        vega: g.vega,
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
    const g = computeBsGreeks(newLegData.type, spot, newLegData.strike, timeYears, ivPct / 100, uConfig.lotSize);

    const newLeg: OptionLegModel = {
      id: `desk_leg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      type: newLegData.type,
      side: newLegData.side,
      strike: newLegData.strike,
      lots: newLegData.lots,
      qty: newLegData.lots * uConfig.lotSize,
      entryPrice: newLegData.entryPrice,
      ltp: newLegData.entryPrice,
      delta: g.delta,
      gamma: g.gamma,
      theta: g.theta,
      vega: g.vega,
      iv: ivPct / 100,
    };

    setViewMode('custom');
    setCustomLegs((prev) => [...prev, newLeg]);
    setStrategyName('Custom Strikes');
    notifyAction(`Added ${newLegData.side} ${newLegData.strike} ${newLegData.type} (${newLegData.lots} Lots)`);
  };

  // Remove leg
  const handleRemoveLeg = (id: string) => {
    if (viewMode === 'broker') {
      notifyAction('Broker position views are read-only from the broker account. Switch to Desk mode to edit.');
      return;
    }
    const leg = customLegs.find((l) => l.id === id);
    setCustomLegs((prev) => prev.filter((l) => l.id !== id));
    if (leg) notifyAction(`Closed ${leg.side} ${leg.strike} ${leg.type}`);
  };

  // Update strike from dropdown
  const handleUpdateLegStrike = (id: string, newStrike: number) => {
    if (viewMode === 'broker') {
      notifyAction('Switch to Desk mode to modify strikes.');
      return;
    }
    const timeYears = calculateTimeToExpiryYears(selectedExpiry);

    setCustomLegs((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;
        const chainEntry = normalizedChain[newStrike];
        const newPrice = l.type === 'CE'
          ? chainEntry?.ce?.last_price || chainEntry?.ce?.previous_close_price
          : chainEntry?.pe?.last_price || chainEntry?.pe?.previous_close_price;

        const g = computeBsGreeks(l.type, spot, newStrike, timeYears, l.iv, uConfig.lotSize);
        return {
          ...l,
          strike: newStrike,
          entryPrice: typeof newPrice === 'number' && newPrice > 0 ? newPrice : g.price,
          ltp: typeof newPrice === 'number' && newPrice > 0 ? newPrice : g.price,
          delta: g.delta,
          gamma: g.gamma,
          theta: g.theta,
          vega: g.vega,
        };
      })
    );
    notifyAction(`Updated strike to ${newStrike}`);
  };

  // Quick Shift strike by steps (+1 or -1 strikeStep)
  const handleQuickShiftStrike = (id: string, steps: number) => {
    if (viewMode === 'broker') {
      notifyAction('Switch to Desk mode to shift strikes.');
      return;
    }
    const leg = customLegs.find((l) => l.id === id);
    if (!leg) return;
    const newStrike = leg.strike + steps * uConfig.strikeStep;
    handleUpdateLegStrike(id, newStrike);
  };

  // Load Strategy Preset Templates using real option chain market prices!
  const handleSelectStrategyPreset = (presetId: string) => {
    setViewMode('custom');
    const atm = Math.round(spot / uConfig.strikeStep) * uConfig.strikeStep;
    const t = calculateTimeToExpiryYears(selectedExpiry);

    if (presetId === 'clear') {
      setCustomLegs([]);
      setStrategyName('No Active Legs');
      notifyAction('Cleared all positions.');
      return;
    }

    const getRealQuote = (strike: number, type: 'ce' | 'pe') => {
      const entry = normalizedChain[strike];
      const p = entry?.[type]?.last_price || entry?.[type]?.previous_close_price;
      const iv = entry?.[type]?.implied_volatility ? entry[type].implied_volatility / 100 : ivPct / 100;
      return { price: typeof p === 'number' && p > 0 ? p : 35.0, iv };
    };

    if (presetId === 'short_strangle') {
      setStrategyName('Short Strangle');
      const ceS = atm + uConfig.strikeStep * 2;
      const peS = atm - uConfig.strikeStep * 2;
      const ceQ = getRealQuote(ceS, 'ce');
      const peQ = getRealQuote(peS, 'pe');
      const gCe = computeBsGreeks('CE', spot, ceS, t, ceQ.iv, uConfig.lotSize);
      const gPe = computeBsGreeks('PE', spot, peS, t, peQ.iv, uConfig.lotSize);

      setCustomLegs([
        {
          id: `ce_${Date.now()}`,
          type: 'CE',
          side: 'SELL',
          strike: ceS,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: ceQ.price,
          ltp: ceQ.price,
          delta: gCe.delta,
          gamma: gCe.gamma,
          theta: gCe.theta,
          vega: gCe.vega,
          iv: ceQ.iv,
        },
        {
          id: `pe_${Date.now()}`,
          type: 'PE',
          side: 'SELL',
          strike: peS,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: peQ.price,
          ltp: peQ.price,
          delta: gPe.delta,
          gamma: gPe.gamma,
          theta: gPe.theta,
          vega: gPe.vega,
          iv: peQ.iv,
        },
      ]);
      notifyAction(`Loaded Short Strangle at ${peS} PE / ${ceS} CE using live chain prices`);
    } else if (presetId === 'short_straddle') {
      setStrategyName('Short Straddle');
      const ceQ = getRealQuote(atm, 'ce');
      const peQ = getRealQuote(atm, 'pe');
      const gCe = computeBsGreeks('CE', spot, atm, t, ceQ.iv, uConfig.lotSize);
      const gPe = computeBsGreeks('PE', spot, atm, t, peQ.iv, uConfig.lotSize);

      setCustomLegs([
        {
          id: `ce_${Date.now()}`,
          type: 'CE',
          side: 'SELL',
          strike: atm,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: ceQ.price,
          ltp: ceQ.price,
          delta: gCe.delta,
          gamma: gCe.gamma,
          theta: gCe.theta,
          vega: gCe.vega,
          iv: ceQ.iv,
        },
        {
          id: `pe_${Date.now()}`,
          type: 'PE',
          side: 'SELL',
          strike: atm,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: peQ.price,
          ltp: peQ.price,
          delta: gPe.delta,
          gamma: gPe.gamma,
          theta: gPe.theta,
          vega: gPe.vega,
          iv: peQ.iv,
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

      setCustomLegs([
        {
          id: `ce_short_${Date.now()}`,
          type: 'CE',
          side: 'SELL',
          strike: ceShort,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: ceSq.price,
          ltp: ceSq.price,
          delta: gCeS.delta,
          gamma: gCeS.gamma,
          theta: gCeS.theta,
          vega: gCeS.vega,
          iv: ceSq.iv,
        },
        {
          id: `pe_short_${Date.now()}`,
          type: 'PE',
          side: 'SELL',
          strike: peShort,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: peSq.price,
          ltp: peSq.price,
          delta: gPeS.delta,
          gamma: gPeS.gamma,
          theta: gPeS.theta,
          vega: gPeS.vega,
          iv: peSq.iv,
        },
        {
          id: `ce_long_${Date.now()}`,
          type: 'CE',
          side: 'BUY',
          strike: ceLong,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: ceLq.price,
          ltp: ceLq.price,
          delta: gCeL.delta,
          gamma: gCeL.gamma,
          theta: gCeL.theta,
          vega: gCeL.vega,
          iv: ceLq.iv,
        },
        {
          id: `pe_long_${Date.now()}`,
          type: 'PE',
          side: 'BUY',
          strike: peLong,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: peLq.price,
          ltp: peLq.price,
          delta: gPeL.delta,
          gamma: gPeL.gamma,
          theta: gPeL.theta,
          vega: gPeL.vega,
          iv: peLq.iv,
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

      setCustomLegs([
        {
          id: `pe_short_${Date.now()}`,
          type: 'PE',
          side: 'SELL',
          strike: peShort,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: peSq.price,
          ltp: peSq.price,
          delta: gPeS.delta,
          gamma: gPeS.gamma,
          theta: gPeS.theta,
          vega: gPeS.vega,
          iv: peSq.iv,
        },
        {
          id: `pe_long_${Date.now()}`,
          type: 'PE',
          side: 'BUY',
          strike: peLong,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: peLq.price,
          ltp: peLq.price,
          delta: gPeL.delta,
          gamma: gPeL.gamma,
          theta: gPeL.theta,
          vega: gPeL.vega,
          iv: peLq.iv,
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

      setCustomLegs([
        {
          id: `ce_short_${Date.now()}`,
          type: 'CE',
          side: 'SELL',
          strike: ceShort,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: ceSq.price,
          ltp: ceSq.price,
          delta: gCeS.delta,
          gamma: gCeS.gamma,
          theta: gCeS.theta,
          vega: gCeS.vega,
          iv: ceSq.iv,
        },
        {
          id: `ce_long_${Date.now()}`,
          type: 'CE',
          side: 'BUY',
          strike: ceLong,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: ceLq.price,
          ltp: ceLq.price,
          delta: gCeL.delta,
          gamma: gCeL.gamma,
          theta: gCeL.theta,
          vega: gCeL.vega,
          iv: ceLq.iv,
        },
      ]);
      notifyAction(`Loaded Bear Call Credit Spread`);
    }
  };

  // Hotkey [C]: Roll Short CE
  const handleRollCe = useCallback(() => {
    if (viewMode === 'broker') {
      notifyAction('Switch to Desk mode to perform what-if rolls.');
      return;
    }
    const ceLeg = customLegs.find((l) => l.type === 'CE' && l.side === 'SELL');
    if (!ceLeg) {
      notifyAction('No active short CE leg found to roll.');
      return;
    }
    const newStrike = ceLeg.strike + uConfig.strikeStep;
    handleUpdateLegStrike(ceLeg.id, newStrike);
    notifyAction(`[HOTKEY C] Rolled Short CE from ${ceLeg.strike} to ${newStrike} (+${uConfig.strikeStep} pts OTM)`);
  }, [customLegs, uConfig.strikeStep, viewMode]);

  // Hotkey [P]: Roll Short PE
  const handleRollPe = useCallback(() => {
    if (viewMode === 'broker') {
      notifyAction('Switch to Desk mode to perform what-if rolls.');
      return;
    }
    const peLeg = customLegs.find((l) => l.type === 'PE' && l.side === 'SELL');
    if (!peLeg) {
      notifyAction('No active short PE leg found to roll.');
      return;
    }
    const newStrike = peLeg.strike - uConfig.strikeStep;
    handleUpdateLegStrike(peLeg.id, newStrike);
    notifyAction(`[HOTKEY P] Rolled Short PE from ${peLeg.strike} to ${newStrike} (-${uConfig.strikeStep} pts OTM)`);
  }, [customLegs, uConfig.strikeStep, viewMode]);

  // Hotkey [H]: 1-Click Delta Hedge
  const handleDeltaHedge = useCallback(() => {
    if (viewMode === 'broker') {
      notifyAction('Switch to Desk mode to test Delta hedges.');
      return;
    }
    const currentDelta = portfolioGreeks.netDelta;
    if (Math.abs(currentDelta) < 1.0) {
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
  }, [portfolioGreeks.netDelta, spot, uConfig.strikeStep, normalizedChain, viewMode]);

  // Hotkey [W]: Add Wings
  const handleAddWings = useCallback(() => {
    if (viewMode === 'broker') {
      notifyAction('Switch to Desk mode to simulate wing additions.');
      return;
    }
    const ceLeg = customLegs.find((l) => l.type === 'CE' && l.side === 'SELL');
    const peLeg = customLegs.find((l) => l.type === 'PE' && l.side === 'SELL');

    if (!ceLeg || !peLeg) {
      notifyAction('Add Wings requires active Short CE and Short PE legs.');
      return;
    }

    const wingCeStrike = ceLeg.strike + uConfig.strikeStep * 3;
    const wingPeStrike = peLeg.strike - uConfig.strikeStep * 3;
    const t = calculateTimeToExpiryYears(selectedExpiry);

    const ceChainP = normalizedChain[wingCeStrike]?.ce?.last_price || normalizedChain[wingCeStrike]?.ce?.previous_close_price;
    const peChainP = normalizedChain[wingPeStrike]?.pe?.last_price || normalizedChain[wingPeStrike]?.pe?.previous_close_price;

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
      delta: gCe.delta,
      gamma: gCe.gamma,
      theta: gCe.theta,
      vega: gCe.vega,
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
      delta: gPe.delta,
      gamma: gPe.gamma,
      theta: gPe.theta,
      vega: gPe.vega,
      iv: ivPct / 100,
    };

    setCustomLegs((prev) => [...prev, ceWing, peWing]);
    setStrategyName('Iron Condor (Wings Added)');
    notifyAction(`[HOTKEY W] Wings Added: Bought ${wingPeStrike} PE & ${wingCeStrike} CE`);
  }, [customLegs, spot, ivPct, uConfig.strikeStep, uConfig.lotSize, normalizedChain, selectedExpiry, viewMode]);

  // Hotkey [X]: Trim 50%
  const handleTrim50 = useCallback(() => {
    if (viewMode === 'broker') {
      notifyAction('Direct trims on live broker positions disabled here. Use Scalper terminal or order ticket to square off.');
      return;
    }
    if (customLegs.length === 0) {
      notifyAction('No active legs to trim.');
      return;
    }
    setCustomLegs((prev) =>
      prev.map((l) => {
        const newLots = Math.max(1, Math.round(l.lots / 2));
        return {
          ...l,
          lots: newLots,
          qty: newLots * uConfig.lotSize,
        };
      })
    );
    notifyAction('[HOTKEY X] Trimmed 50% lots across desk legs.');
  }, [customLegs, uConfig.lotSize, viewMode]);

  // Hotkey [ESC]: Flatten Desk
  const handleFlatten = useCallback(() => {
    if (viewMode === 'broker') {
      notifyAction('To square off real broker positions, use the Emergency Exit button in the Scalper.');
      return;
    }
    if (customLegs.length === 0) {
      notifyAction('Position already flat.');
      return;
    }
    setCustomLegs([]);
    setStrategyName('Flat / No Position');
    notifyAction('[HOTKEY ESC] Desk positions cleared.');
  }, [customLegs, viewMode]);

  // ── 7. GLOBAL KEYBOARD SHORTCUTS ──────────────────────────────────────────
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

      if (key === 'C') {
        e.preventDefault();
        handleRollCe();
      } else if (key === 'P') {
        e.preventDefault();
        handleRollPe();
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
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleRollCe, handleRollPe, handleDeltaHedge, handleAddWings, handleTrim50, handleFlatten]);

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
                  DATA: {todayStr}
                </span>
              </div>
              <h1 className="text-sm font-bold text-white tracking-tight leading-none mt-0.5">
                Options Risk &amp; Strategy Monitor
              </h1>
              <p className="text-[10px] text-zinc-400 font-medium mt-0.5">
                Real-time Greeks matrix, sub-second tick streaming, strike clearances &amp; 2D payoff matrix
              </p>
            </div>
          </div>

          {/* Right: Quick Links + Separator + <NavBar /> */}
          <div className="flex items-center gap-2.5 flex-wrap ml-auto">
            <Link
              href="/scalper"
              className="hidden sm:inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300 hover:text-white transition-colors"
            >
              Scalper →
            </Link>
            <Link
              href="/options"
              className="hidden sm:inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300 hover:text-white transition-colors"
            >
              Options Charts →
            </Link>

            <span className="w-px h-5 bg-zinc-800 shrink-0 hidden sm:inline-block" />

            <NavBar />
          </div>
        </header>

        {/* ROW 2: Live Metrics Bar (Matches the user's diagram with sub-second WebSocket quotes) */}
        <TopMetricBar
          selectedUnderlying={selectedUnderlying}
          onSelectUnderlying={handleSelectUnderlying}
          expiries={expiries}
          selectedExpiry={selectedExpiry}
          onSelectExpiry={(exp) => setSelectedExpiry(exp)}
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
          isLiveLoading={isChainLoading || isBrokerLoading}
          wsTransport={transport}
          wsStatus={bridgeStatus.status}
          onRefreshQuotes={() => {
            fetchOptionChain(selectedUnderlying, selectedExpiry);
            fetchBrokerPositions();
            notifyAction('Refreshed live market quotes.');
          }}
          onToggleHotkeysModal={() => setIsHotkeysOpen(true)}
          viewMode={viewMode}
          onToggleViewMode={(m) => {
            setViewMode(m);
            setStrategyName(m === 'broker' ? 'Dhan Live Positions' : 'Custom Strikes');
            notifyAction(`Switched view to ${m === 'broker' ? 'Dhan Live Broker Positions' : 'What-If Desk Simulator'}`);
          }}
          brokerLegsCount={brokerLegs.length}
        />
      </div>

      {/* ── MAIN WORKSPACE (60% / 40% Two-Column Layout) ───────────────────── */}
      <main className="flex-1 w-full max-w-[1700px] mx-auto p-3 md:p-4">
        <div className="flex flex-col lg:flex-row gap-4">
          {/* LEFT COLUMN: 60% Width */}
          <div className="w-full lg:w-[60%] flex-1">
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
              viewMode={viewMode}
              onSyncBroker={fetchBrokerPositions}
              isBrokerLoading={isBrokerLoading}
              onAddLegClick={() => setIsAddLegOpen(true)}
              onRemoveLeg={handleRemoveLeg}
              onUpdateLegStrike={handleUpdateLegStrike}
              onQuickShiftStrike={handleQuickShiftStrike}
              onSelectStrategyPreset={handleSelectStrategyPreset}
            />
          </div>

          {/* RIGHT COLUMN: 40% Width */}
          <div className="w-full lg:w-[40%] shrink-0">
            <RiskGreeksMatrix
              greeks={portfolioGreeks}
              lastActionMessage={lastActionMessage}
              onRollCe={handleRollCe}
              onRollPe={handleRollPe}
              onDeltaHedge={handleDeltaHedge}
              onAddWings={handleAddWings}
              onTrim50={handleTrim50}
              onFlatten={handleFlatten}
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
        onAddLeg={handleAddLeg}
      />

      <HotkeysModal
        isOpen={isHotkeysOpen}
        onClose={() => setIsHotkeysOpen(false)}
      />
    </div>
  );
}
