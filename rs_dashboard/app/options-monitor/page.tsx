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

  // Spot price & market quotes state (Sensibull reference: 23398.10)
  const [spot, setSpot] = useState<number>(23398.10);
  const [prevClose, setPrevClose] = useState<number>(23398.10);
  const [change, setChange] = useState<number>(0);
  const [changePct, setChangePct] = useState<number>(0);
  const [ivPct, setIvPct] = useState<number>(13.13); // Sensibull ATM IV baseline (13.13%)
  const [vix, setVix] = useState<{ ltp: number; change?: number; change_pct?: number } | null>(null);

  // Live Futures state (Black-76 pricing & basis)
  const [futurePrice, setFuturePrice] = useState<number | null>(23463.60);
  const [futureSymbol, setFutureSymbol] = useState<string>('NIFTY-FUT');
  const [futureExpiry, setFutureExpiry] = useState<string>('15 Sep');
  const [futureBasis, setFutureBasis] = useState<number>(65.50);

  // Target Spot & Date Sliders state (Sensibull Parity)
  const [targetSpot, setTargetSpot] = useState<number>(23398.10);
  const [targetDays, setTargetDays] = useState<number>(4.0);

  // Active Option Positions / Strategy Legs. Starts empty — the "initialize realistic strategy
  // preset" effect below builds a real ATM±2-strike short strangle from the live chain once it
  // arrives (same live WS-tick -> chain last_price -> chain IV -> Black-76 Greeks lookup that
  // handleUpdateLegStrike already uses for any strike change). A non-empty initial array here
  // makes that effect's `activeLegs.length > 0` guard bail out immediately on every fresh load,
  // permanently freezing the page on whatever demo position was seeded here — this happened for
  // real (2026-09): the page always showed a static 23500 CE @ 61.20 / 23300 PE @ 55.65 strangle
  // from a reference screenshot, correct math notwithstanding, until a leg's strike was manually
  // touched and the live lookup ran for the first time.
  const [strategyName, setStrategyName] = useState<string>('Short Strangle');
  const [activeLegs, setActiveLegs] = useState<OptionLegModel[]>([]);
  // Expiry whose chain was last loaded — lets a chain load know which expiry the legs were on.
  const loadedExpiryRef = useRef<string>('');
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

  // Legs on another expiry (e.g. a monthly straddle while the page's active expiry is the weekly)
  // aren't covered by the bridge's main subscription. Ask it to also stream those contracts
  // (`watchExtra`); their ticks then arrive under liveQuotes.extra[expiry][strike].
  const offExpiryKey = useMemo(() => {
    const keys = new Set<string>();
    for (const l of activeLegs) {
      if (l.expiry && l.expiry !== selectedExpiry && (!l.underlying || l.underlying === selectedUnderlying)) {
        keys.add(`${l.expiry}|${l.strike}|${l.type}`);
      }
    }
    return Array.from(keys).sort().join(',');
  }, [activeLegs, selectedExpiry, selectedUnderlying]);

  useEffect(() => {
    if (!offExpiryKey) return;
    const requests = offExpiryKey.split(',').map((k) => {
      const [expiry, strike, side] = k.split('|');
      return { underlying: selectedUnderlying, expiry, strike: Number(strike), side };
    });
    fetch('/api/options/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'watchExtra', underlying: selectedUnderlying, requests }),
    }).catch(() => {});
  }, [offExpiryKey, selectedUnderlying]);

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
      // NOTE: Do NOT overwrite ivPct with India VIX!
      // ivPct is the expiry's ATM IV (13.13%), not 30-day India VIX.
    }
    if (liveQuotes.future && typeof liveQuotes.future.ltp === 'number' && liveQuotes.future.ltp > 0) {
      setFuturePrice(liveQuotes.future.ltp);
      if (liveQuotes.future.symbol) setFutureSymbol(liveQuotes.future.symbol);
      if (liveQuotes.future.expiry) setFutureExpiry(liveQuotes.future.expiry);
      if (typeof liveQuotes.future.basis === 'number') setFutureBasis(liveQuotes.future.basis);
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
        if (typeof chainData.future_price === 'number' && chainData.future_price > 0) {
          setFuturePrice(chainData.future_price);
        }
        if (chainData.future_symbol) setFutureSymbol(chainData.future_symbol);
        if (chainData.future_expiry) setFutureExpiry(chainData.future_expiry);
        if (typeof chainData.future_basis === 'number') setFutureBasis(chainData.future_basis);

        const rawOc = chainData.chain?.oc || chainData.chain || {};
        const { strikes, normalized } = extractChainStrikes(rawOc);
        if (strikes.length > 0) {
          setChainStrikes(strikes);
          setNormalizedChain((prev) => ({ ...prev, ...normalized }));

          // Switching the active expiry must carry the not-yet-entered legs with it, otherwise
          // they stay on the old expiry (a "29-Sep strangle" still listed as 22-Sep). Re-anchor
          // them to this chain: new expiry, security id, and price. Executed (isEntered) legs are
          // real positions and legs deliberately built on another expiry stay where they are.
          const prevExp = loadedExpiryRef.current;
          loadedExpiryRef.current = exp;
          if (prevExp && prevExp !== exp) {
            setActiveLegs((prev) => prev.map((l) => {
              if (l.isEntered) return l;
              if (l.underlying && l.underlying !== sym) return l;
              if ((l.expiry || prevExp) !== prevExp) return l;
              const cs = normalized[l.strike]?.[l.type === 'CE' ? 'ce' : 'pe'];
              const px = cs?.last_price || cs?.previous_close_price;
              const civ = cs?.implied_volatility;
              return {
                ...l,
                expiry: exp,
                securityId: cs?.security_id != null ? String(cs.security_id) : undefined,
                ...(typeof px === 'number' && px > 0 ? { entryPrice: px, ltp: px } : {}),
                ...(typeof civ === 'number' && civ > 0 ? { iv: civ / 100 } : {}),
              };
            }));
          }
        }

        // Compute average ATM IV from the real chain
        const currentSpot = chainData.spot || UNDERLYINGS[sym]?.defaultSpot || UNDERLYINGS.NIFTY.defaultSpot;
        const atm = Math.round(currentSpot / (UNDERLYINGS[sym]?.strikeStep || 50)) * (UNDERLYINGS[sym]?.strikeStep || 50);
        const atmData = normalized[atm];
        const atmCeIv = atmData?.ce?.implied_volatility;
        const atmPeIv = atmData?.pe?.implied_volatility;
        if (typeof atmCeIv === 'number' && atmCeIv > 0 && typeof atmPeIv === 'number' && atmPeIv > 0) {
          setIvPct(Math.round(((atmCeIv + atmPeIv) / 2) * 100) / 100);
        } else if (typeof atmCeIv === 'number' && atmCeIv > 0) {
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
    if (hasInitializedPresetRef.current || chainStrikes.length === 0 || Object.keys(normalizedChain).length === 0) {
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

    const ceIv = (ceChain?.implied_volatility ? ceChain.implied_volatility / 100 : 0.095);
    const peIv = (peChain?.implied_volatility ? peChain.implied_volatility / 100 : 0.11);

    const isFut = typeof futurePrice === 'number' && futurePrice > 0;
    const evalUnderlying = isFut ? (futurePrice as number) : spot;
    // Real remaining time to expiry, never the user's target-date slider — the initial
    // auto-populated legs must price off "today", not whatever days-to-target was last set.
    const effectiveTime = calculateTimeToExpiryYears(selectedExpiry);

    const gCe = computeBsGreeks('CE', evalUnderlying, ceStrike, effectiveTime, ceIv, uConfig.lotSize, 0.065, isFut);
    const gPe = computeBsGreeks('PE', evalUnderlying, peStrike, effectiveTime, peIv, uConfig.lotSize, 0.065, isFut);

    const cePrice = (typeof ceTick?.ce?.ltp === 'number' && ceTick.ce.ltp > 0)
      ? ceTick.ce.ltp
      : (ceChain?.last_price || ceChain?.previous_close_price || 75.65);

    const pePrice = (typeof peTick?.pe?.ltp === 'number' && peTick.pe.ltp > 0)
      ? peTick.pe.ltp
      : (peChain?.last_price || peChain?.previous_close_price || 44.65);

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
        delta: gCe.delta,
        gamma: gCe.gamma,
        theta: gCe.theta,
        vega: gCe.vega,
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
        delta: gPe.delta,
        gamma: gPe.gamma,
        theta: gPe.theta,
        vega: gPe.vega,
        iv: peIv,
        expiry: selectedExpiry,
      },
    ]);
  }, [chainStrikes, normalizedChain, spot, futurePrice, uConfig.strikeStep, uConfig.lotSize, ivPct, selectedExpiry, liveQuotes, activeLegs.length]);

  // ── 5. REALTIME MERGED LEGS WITH SUB-SECOND WS TICKS ────────────────────────
  // Real remaining time on the selected expiry — the target-date slider (targetDays) can never
  // be dragged past this, so a 0/1-DTE contract can't be priced as if 4 days of time value were
  // still left. Matches BasketPayoffChart/PositionsStrategyMonitor's identical clamp so the two
  // pages render the same payoff curve for the same legs.
  const maxTargetDays = useMemo(() => {
    return Math.max(0.05, calculateTimeToExpiryYears(selectedExpiry) * 365);
  }, [selectedExpiry]);

  // Effective time remaining for Black-76 Greeks & SD bands (annualized over 365 calendar days)
  const effectiveTimeToExpiryYears = useMemo(() => {
    return Math.max(0.0001, Math.min(targetDays, maxTargetDays) / 365);
  }, [targetDays, maxTargetDays]);

  const activeLegsBase = activeLegs;

  const legs: OptionLegModel[] = useMemo(() => {
    return activeLegsBase.map((leg) => {
      // A leg on another expiry/underlying must not be repriced from the ACTIVE expiry's ticks/chain
      // (same strike, different contract) nor use the active expiry's time to expiry. Keep its own
      // captured ltp/iv and recompute greeks over its own remaining time.
      if ((leg.expiry && leg.expiry !== selectedExpiry) || (leg.underlying && leg.underlying !== selectedUnderlying)) {
        const legIv = leg.iv || ivPct / 100;
        const isFut = typeof futurePrice === 'number' && futurePrice > 0;
        const extraTick = leg.expiry ? (liveQuotes as any)?.extra?.[leg.expiry]?.[String(leg.strike)] : undefined;
        const extraLtp = leg.type === 'CE' ? extraTick?.ce?.ltp : extraTick?.pe?.ltp;
        const offLtp = (typeof extraLtp === 'number' && extraLtp > 0) ? extraLtp : leg.ltp;
        const gOff = computeBsGreeks(
          leg.type,
          isFut ? (futurePrice as number) : spot,
          leg.strike,
          Math.max(0.0001, calculateTimeToExpiryYears(leg.expiry || selectedExpiry)),
          legIv,
          uConfig.lotSize,
          0.065,
          isFut
        );
        return { ...leg, ltp: offLtp, delta: gOff.delta, gamma: gOff.gamma, theta: gOff.theta, vega: gOff.vega, iv: legIv };
      }

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

      // Recompute Greeks via Black-76 on futures price
      const isFutures = typeof futurePrice === 'number' && futurePrice > 0;
      const evalUnderlying = isFutures ? (futurePrice as number) : spot;
      const g = computeBsGreeks(
        leg.type,
        evalUnderlying,
        leg.strike,
        effectiveTimeToExpiryYears,
        effectiveIv,
        uConfig.lotSize,
        0.065,
        isFutures
      );

      return {
        ...leg,
        expiry: leg.expiry || selectedExpiry,
        ltp: currentLtp,
        delta: g.delta,
        gamma: g.gamma,
        theta: g.theta,
        vega: g.vega,
        iv: effectiveIv,
      };
    });
  }, [activeLegsBase, liveQuotes, normalizedChain, selectedExpiry, selectedUnderlying, spot, futurePrice, effectiveTimeToExpiryYears, ivPct, uConfig.lotSize]);

  // Compute 2D payoff curve, breakevens & 1SD/2SD expected-move bands
  const { points: payoffPoints, breakevens, sdLevels } = useMemo(() => {
    return generatePayoffCurve(
      legs,
      spot,
      uConfig.lotSize,
      effectiveTimeToExpiryYears,
      ivPct / 100,
      uConfig.strikeStep,
      futurePrice ?? undefined,
      effectiveTimeToExpiryYears
    );
  }, [legs, spot, uConfig.lotSize, effectiveTimeToExpiryYears, ivPct, uConfig.strikeStep, futurePrice]);

  // Compute portfolio metrics (Total MTM, Net Delta, Net Gamma, Net Theta, Margin, POP)
  const portfolioGreeks = useMemo(() => {
    return computePortfolioMetrics(legs, spot, uConfig.lotSize, effectiveTimeToExpiryYears, breakevens, uConfig.strikeStep);
  }, [legs, spot, uConfig.lotSize, effectiveTimeToExpiryYears, breakevens, uConfig.strikeStep]);

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
        if (!guard || guard.triggered || !leg.isEntered) continue;

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
    // Reset spot and chain state to the new underlying's scale — otherwise the old
    // underlying's spot/strikes linger (wrong price scale) until the async fetch resolves,
    // or indefinitely if it fails, and overlapping strike keys can serve stale cross-
    // underlying quotes since the chain is merged rather than replaced on fetch.
    setSpot(UNDERLYINGS[sym]?.defaultSpot ?? UNDERLYINGS.NIFTY.defaultSpot);
    setChainStrikes([]);
    setNormalizedChain({});
    setExpiries([]);
    setSelectedExpiry('');
    notifyAction(`Switched underlying to ${sym}. Loading option chain & live quotes...`);
    fetchExpiries(sym).then((exp) => {
      if (exp) fetchOptionChain(sym, exp);
    });
  };

  // Shared leg-construction logic for both "Add to Monitor" and "Place Order Now" flows.
  const buildNewLeg = useCallback((newLegData: {
    type: OptType;
    side: Side;
    strike: number;
    lots: number;
    entryPrice: number;
  }): OptionLegModel => {
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

    const isFutures = typeof futurePrice === 'number' && futurePrice > 0;
    const evalUnderlying = isFutures ? (futurePrice as number) : spot;
    const g = computeBsGreeks(
      newLegData.type,
      evalUnderlying,
      newLegData.strike,
      effectiveTimeToExpiryYears,
      legIv,
      uConfig.lotSize,
      0.065,
      isFutures
    );

    const legLtp = (typeof wsPrice === 'number' && wsPrice > 0)
      ? wsPrice
      : (typeof chainPrice === 'number' && chainPrice > 0)
      ? chainPrice
      : newLegData.entryPrice;

    return {
      id: `leg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      type: newLegData.type,
      side: newLegData.side,
      strike: newLegData.strike,
      lots: newLegData.lots,
      qty: newLegData.lots * uConfig.lotSize,
      entryPrice: newLegData.entryPrice,
      ltp: legLtp,
      delta: g.delta,
      gamma: g.gamma,
      theta: g.theta,
      vega: g.vega,
      iv: legIv,
      expiry: selectedExpiry,
      underlying: selectedUnderlying,
      securityId: chainSide?.security_id != null ? String(chainSide.security_id) : undefined,
    };
  }, [selectedExpiry, selectedUnderlying, liveQuotes, normalizedChain, ivPct, spot, futurePrice, effectiveTimeToExpiryYears, uConfig.lotSize]);

  // Add custom leg (open for all strikes across the chain)
  const handleAddLeg = (newLegData: {
    type: OptType;
    side: Side;
    strike: number;
    lots: number;
    entryPrice: number;
    expiry?: string;
    securityId?: string;
    iv?: number;
  }) => {
    // A leg on a non-active expiry can't be priced from the page's active-expiry chain/ticks,
    // so it goes through the chain-modal path, which takes its own expiry/securityId/iv.
    if (newLegData.expiry && newLegData.expiry !== selectedExpiry) {
      handleAddLegFromChain({
        type: newLegData.type,
        side: newLegData.side,
        strike: newLegData.strike,
        ltp: newLegData.entryPrice,
        expiry: newLegData.expiry,
        underlying: selectedUnderlying,
        iv: newLegData.iv,
        securityId: newLegData.securityId,
        lots: newLegData.lots,
      });
      setStrategyName('Custom Strategy');
      return;
    }
    const newLeg = buildNewLeg(newLegData);
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

  // Update strike from dropdown. Returns false (and blocks the mutation) if the leg is
  // already live — a client-side strike swap on an entered leg would desync the UI from
  // the real broker position without ever sending a roll order.
  const handleUpdateLegStrike = (id: string, newStrike: number): boolean => {
    const target = activeLegs.find((l) => l.id === id);
    if (target?.isEntered) {
      notifyAction(
        `Cannot roll ${target.side} ${target.strike} ${target.type}: position is already live. Close it and open the new strike instead.`
      );
      return false;
    }

    const isFut = typeof futurePrice === 'number' && futurePrice > 0;
    const evalUnderlying = isFut ? (futurePrice as number) : spot;
    const timeYears = effectiveTimeToExpiryYears;

    setActiveLegs((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;
        if (l.isEntered) return l;

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
        const hasDhanGreeks = dhanGreeks && dhanGreeks.delta != null && dhanGreeks.gamma != null;
        const g = computeBsGreeks(l.type, evalUnderlying, newStrike, timeYears, effectiveIv, uConfig.lotSize, 0.065, isFut);

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
          securityId: chainSide?.security_id != null ? String(chainSide.security_id) : undefined,
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
    return true;
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
    const isFut = typeof futurePrice === 'number' && futurePrice > 0;
    const evalUnderlying = isFut ? (futurePrice as number) : spot;
    const t = effectiveTimeToExpiryYears;

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
      const hasDhanGreeks = dhanGreeks && dhanGreeks.delta != null && dhanGreeks.gamma != null;

      // 3. Fallback to Black-76 theoretical price on futures for this specific strike & type
      const fallbackGreeks = computeBsGreeks(type.toUpperCase() as OptType, evalUnderlying, strike, t, iv, uConfig.lotSize, 0.065, isFut);
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
      const gCe = computeBsGreeks('CE', evalUnderlying, ceS, t, ceQ.iv, uConfig.lotSize, 0.065, isFut);
      const gPe = computeBsGreeks('PE', evalUnderlying, peS, t, peQ.iv, uConfig.lotSize, 0.065, isFut);

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
      const gCe = computeBsGreeks('CE', evalUnderlying, atm, t, ceQ.iv, uConfig.lotSize, 0.065, isFut);
      const gPe = computeBsGreeks('PE', evalUnderlying, atm, t, peQ.iv, uConfig.lotSize, 0.065, isFut);

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

      const gCeS = computeBsGreeks('CE', evalUnderlying, ceShort, t, ceSq.iv, uConfig.lotSize, 0.065, isFut);
      const gPeS = computeBsGreeks('PE', evalUnderlying, peShort, t, peSq.iv, uConfig.lotSize, 0.065, isFut);
      const gCeL = computeBsGreeks('CE', evalUnderlying, ceLong, t, ceLq.iv, uConfig.lotSize, 0.065, isFut);
      const gPeL = computeBsGreeks('PE', evalUnderlying, peLong, t, peLq.iv, uConfig.lotSize, 0.065, isFut);

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
      const gPeS = computeBsGreeks('PE', evalUnderlying, peShort, t, peSq.iv, uConfig.lotSize, 0.065, isFut);
      const gPeL = computeBsGreeks('PE', evalUnderlying, peLong, t, peLq.iv, uConfig.lotSize, 0.065, isFut);

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
      const gCeS = computeBsGreeks('CE', evalUnderlying, ceShort, t, ceSq.iv, uConfig.lotSize, 0.065, isFut);
      const gCeL = computeBsGreeks('CE', evalUnderlying, ceLong, t, ceLq.iv, uConfig.lotSize, 0.065, isFut);

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
    if (handleUpdateLegStrike(ceLeg.id, newStrike)) {
      notifyAction(`Rolled Short CE UP from ${ceLeg.strike} to ${newStrike} (+${uConfig.strikeStep} pts OTM)`);
    }
  }, [activeLegs, uConfig.strikeStep, handleUpdateLegStrike]);

  // Roll Short CE DOWN (-1 strikeStep)
  const handleRollCeDown = useCallback(() => {
    const ceLeg = activeLegs.find((l) => l.type === 'CE' && l.side === 'SELL');
    if (!ceLeg) {
      notifyAction('No active short CE leg found to roll.');
      return;
    }
    const newStrike = ceLeg.strike - uConfig.strikeStep;
    if (handleUpdateLegStrike(ceLeg.id, newStrike)) {
      notifyAction(`Rolled Short CE DOWN from ${ceLeg.strike} to ${newStrike} (-${uConfig.strikeStep} pts)`);
    }
  }, [activeLegs, uConfig.strikeStep, handleUpdateLegStrike]);

  // Roll Short PE UP (+1 strikeStep)
  const handleRollPeUp = useCallback(() => {
    const peLeg = activeLegs.find((l) => l.type === 'PE' && l.side === 'SELL');
    if (!peLeg) {
      notifyAction('No active short PE leg found to roll.');
      return;
    }
    const newStrike = peLeg.strike + uConfig.strikeStep;
    if (handleUpdateLegStrike(peLeg.id, newStrike)) {
      notifyAction(`Rolled Short PE UP from ${peLeg.strike} to ${newStrike} (+${uConfig.strikeStep} pts)`);
    }
  }, [activeLegs, uConfig.strikeStep, handleUpdateLegStrike]);

  // Roll Short PE DOWN (-1 strikeStep)
  const handleRollPeDown = useCallback(() => {
    const peLeg = activeLegs.find((l) => l.type === 'PE' && l.side === 'SELL');
    if (!peLeg) {
      notifyAction('No active short PE leg found to roll.');
      return;
    }
    const newStrike = peLeg.strike - uConfig.strikeStep;
    if (handleUpdateLegStrike(peLeg.id, newStrike)) {
      notifyAction(`Rolled Short PE DOWN from ${peLeg.strike} to ${newStrike} (-${uConfig.strikeStep} pts OTM)`);
    }
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
    const hasCeDhan = ceDhanGreeks && ceDhanGreeks.delta != null && ceDhanGreeks.gamma != null;
    const hasPeDhan = peDhanGreeks && peDhanGreeks.delta != null && peDhanGreeks.gamma != null;

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

  // Resolves the broker security_id for a leg: prefer the id captured on the leg itself
  // at creation time (correct even if the shared, cross-expiry/underlying normalizedChain
  // has since been overwritten by a different underlying/expiry fetch), falling back to a
  // same-strike chain lookup only when the leg predates that capture.
  const resolveLegSecurityId = useCallback((leg: OptionLegModel): string | undefined => {
    if (leg.securityId) return leg.securityId;
    const legKey = leg.type.toLowerCase() as 'ce' | 'pe';
    const secId = normalizedChain[leg.strike]?.[legKey]?.security_id;
    return secId ? String(secId) : undefined;
  }, [normalizedChain]);

  const handleOpenTradeBasket = useCallback(() => {
    if (activeLegs.length === 0) {
      setIsAddLegOpen(true);
      notifyAction('Add legs or load a template preset before executing a basket order.');
      return;
    }

    const basketUnderlying = activeLegs[0].underlying ?? selectedUnderlying;
    const basketExpiry = activeLegs[0].expiry ?? selectedExpiry;
    const mismatched = activeLegs.find(
      (l) => (l.underlying ?? selectedUnderlying) !== basketUnderlying || (l.expiry ?? selectedExpiry) !== basketExpiry
    );
    if (mismatched) {
      notifyAction(
        `Cannot execute basket: legs span multiple underlyings/expiries (found ${mismatched.underlying ?? selectedUnderlying} ${mismatched.expiry ?? selectedExpiry} alongside ${basketUnderlying} ${basketExpiry}). Execute those legs individually instead.`
      );
      return;
    }

    const firstLots = activeLegs[0]?.lots || 1;
    const allSame = activeLegs.every((l) => l.lots === firstLots);
    const baseMultiplier = allSame ? firstLots : 1;

    const orderLegs: OptionTradeLeg[] = activeLegs.map((leg) => ({
      strike: leg.strike,
      optionType: leg.type,
      action: leg.side,
      lots: allSame ? 1 : leg.lots,
      securityId: resolveLegSecurityId(leg),
    }));

    setActiveTradeOrder({
      title: `${basketUnderlying} ${strategyName} (${activeLegs.length} Legs)`,
      underlying: basketUnderlying,
      expiry: basketExpiry,
      lotSize: UNDERLYINGS[basketUnderlying]?.lotSize ?? uConfig.lotSize,
      defaultLots: baseMultiplier,
      legs: orderLegs,
      productType: 'INTRADAY',
    });
    setOrderModalOpen(true);
  }, [activeLegs, selectedUnderlying, selectedExpiry, strategyName, uConfig.lotSize, resolveLegSecurityId, notifyAction]);

  const handleOpenSingleLegTrade = useCallback((leg: OptionLegModel) => {
    const legUnderlying = leg.underlying ?? selectedUnderlying;
    const legExpiry = leg.expiry ?? selectedExpiry;
    setActiveTradeOrder({
      title: `${legUnderlying} ${leg.strike} ${leg.type} (${leg.side})`,
      underlying: legUnderlying,
      expiry: legExpiry,
      lotSize: UNDERLYINGS[legUnderlying]?.lotSize ?? uConfig.lotSize,
      defaultLots: 1,
      legs: [
        {
          strike: leg.strike,
          optionType: leg.type,
          action: leg.side,
          lots: leg.lots,
          securityId: resolveLegSecurityId(leg),
        },
      ],
      productType: 'INTRADAY',
    });
    setOrderModalOpen(true);
  }, [selectedUnderlying, selectedExpiry, uConfig.lotSize, resolveLegSecurityId]);

  const handleOpenSingleLegClose = useCallback((leg: OptionLegModel) => {
    const legUnderlying = leg.underlying ?? selectedUnderlying;
    const legExpiry = leg.expiry ?? selectedExpiry;
    const oppositeAction = leg.side === 'BUY' ? 'SELL' : 'BUY';
    setActiveTradeOrder({
      title: `Square Off: ${legUnderlying} ${leg.strike} ${leg.type} (${oppositeAction})`,
      underlying: legUnderlying,
      expiry: legExpiry,
      lotSize: UNDERLYINGS[legUnderlying]?.lotSize ?? uConfig.lotSize,
      defaultLots: 1,
      legs: [
        {
          strike: leg.strike,
          optionType: leg.type,
          action: oppositeAction,
          lots: leg.lots,
          securityId: resolveLegSecurityId(leg),
        },
      ],
      productType: 'INTRADAY',
    });
    setOrderModalOpen(true);
  }, [selectedUnderlying, selectedExpiry, uConfig.lotSize, resolveLegSecurityId]);

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
    expiry?: string;
    securityId?: string;
  }) => {
    const legKey = leg.type.toLowerCase() as 'ce' | 'pe';
    const isAlt = !!leg.expiry && leg.expiry !== selectedExpiry;
    // The shared normalizedChain is the active expiry's; for another expiry trust only the
    // securityId the modal resolved from that expiry's own chain (else the order modal resolves it).
    const secId = isAlt ? leg.securityId : normalizedChain[leg.strike]?.[legKey]?.security_id;
    setActiveTradeOrder({
      title: `${selectedUnderlying} ${leg.strike} ${leg.type} (${leg.side})`,
      underlying: selectedUnderlying,
      expiry: isAlt ? leg.expiry! : selectedExpiry,
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
    underlying: string;
    iv?: number;
    delta?: number;
    securityId?: string;
    lots?: number;
  }) => {
    const legUnderlying = leg.underlying || selectedUnderlying;
    const legUConfig = UNDERLYINGS[legUnderlying] || uConfig;
    // Dhan greeks (leg.delta) cover the common case; the BS fallback below only matters when
    // those are missing, so an approximate spot for a non-page underlying is an acceptable trade-off.
    const legSpot = legUnderlying === selectedUnderlying ? spot : (legUConfig.defaultSpot ?? spot);

    const timeRemaining = calculateTimeToExpiryYears(leg.expiry || selectedExpiry);
    const legIv = leg.iv ?? ivPct / 100;
    const g = computeBsGreeks(leg.type, legSpot, leg.strike, timeRemaining, legIv, legUConfig.lotSize);

    const hasDhanDelta = typeof leg.delta === 'number';

    const newLeg: OptionLegModel = {
      id: `leg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: leg.type,
      side: leg.side,
      strike: leg.strike,
      lots: leg.lots ?? 1,
      qty: (leg.lots ?? 1) * legUConfig.lotSize,
      entryPrice: leg.ltp,
      ltp: leg.ltp,
      delta: hasDhanDelta ? leg.delta! : g.delta,
      gamma: g.gamma,
      theta: g.theta,
      vega: g.vega,
      iv: legIv,
      expiry: leg.expiry || selectedExpiry,
      underlying: legUnderlying,
      securityId: leg.securityId,
    };

    setActiveLegs((prev) => [...prev, newLeg]);
    notifyAction(`Added ${leg.side} ${leg.strike} ${leg.type} (${legUnderlying}) to strategy from Option Chain.`);
  }, [selectedUnderlying, selectedExpiry, ivPct, spot, uConfig, notifyAction]);

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
          onSelectUnderlying={handleSelectUnderlying}
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
          futurePrice={futurePrice}
          futureBasis={futureBasis}
          futureExpiry={futureExpiry}
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
              sdLevels={sdLevels}
              chainStrikes={chainStrikes}
              currentExpiry={selectedExpiry}
              futurePrice={futurePrice}
              futureBasis={futureBasis}
              futureExpiry={futureExpiry}
              targetSpot={targetSpot}
              onTargetSpotChange={setTargetSpot}
              targetDays={targetDays}
              onTargetDaysChange={setTargetDays}
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
        underlying={selectedUnderlying}
        expiries={expiries}
        currentExpiry={selectedExpiry}
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
        initialChain={normalizedChain}
        initialChainStrikes={chainStrikes}
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
