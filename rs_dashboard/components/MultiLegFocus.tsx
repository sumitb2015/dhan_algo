'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Plus, RefreshCw, Layers, ClipboardList, ListTree } from 'lucide-react';
import NavBar from './NavBar';
import { type Toast, FOCUS_RING } from './Scalper';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { useBrokerSelector, scalperRoute, BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import {
  STRATEGY_CATEGORIES, type StrategyCategory, type StrategyTemplate, type OptionType, nearestStrike, strikeStep,
} from '@/lib/basketStrategies';
import { sortLegsForPlacement, resolveOrderRequest, type StrikeIdentifier } from '@/lib/basketOrders';
import StrategyCardGrid from './basket/StrategyCardGrid';
import MultiLegStrategyRow from './multiLegFocus/MultiLegStrategyRow';
import OrdersTradesModal from './multiLegFocus/OrdersTradesModal';
import MultiLegOptionChainModal from './multiLegFocus/MultiLegOptionChainModal';
import {
  resolveTemplateLegs, reconcileLegWithBroker, sortLegsForExit, findLegPosition,
  computeLegTrailingSL, computeStrategyMetrics, checkStrategyRisk, fallbackLotSize,
  positionProduct, type MultiLegLeg, type MultiLegBasket, type StrategyRiskConfig, type MultiLegStatus,
} from '@/lib/multiLegFocus';
import { closeOrderProduct } from '@/lib/positionProduct';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'CRUDEOILM'] as const;
type Underlying = typeof UNDERLYINGS[number];

const DEFAULT_INDEX_STEP: Record<Underlying, number> = {
  NIFTY: 50,
  BANKNIFTY: 100,
  SENSEX: 100,
  CRUDEOIL: 50,
  CRUDEOILM: 50,
};
const DEFAULT_INDEX_SPOT: Record<Underlying, number> = {
  NIFTY: 24000,
  BANKNIFTY: 51000,
  SENSEX: 79000,
  CRUDEOIL: 8500,
  CRUDEOILM: 8500,
};

const ALL_STRATEGY_TEMPLATES: StrategyTemplate[] = Object.values(STRATEGY_CATEGORIES).flat();

function fmtMoney(n: number): string {
  return `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export default function MultiLegFocus() {
  const { broker, setBroker, authenticatedBrokers, hasAuthenticatedBroker } = useBrokerSelector();

  // Multi-Basket State: list of all strategies
  const [baskets, setBaskets] = useState<MultiLegBasket[]>([]);
  const basketsRef = useRef<MultiLegBasket[]>([]);
  useEffect(() => { basketsRef.current = baskets; }, [baskets]);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = useCallback((type: 'success' | 'error', message: string, detail?: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, type, message, detail }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), type === 'error' ? 7000 : 3000);
  }, []);

  // ── Broker Margin / Funds Information ──────────────────────────────
  const [fundsData, setFundsData] = useState<{ available: number; used: number } | null>(null);
  const [basketMargins, setBasketMargins] = useState<Record<string, {
    legMargins: Record<string, number>;
    basketMargin: number;
    overallMargin: number;
    hedgeBenefit: number;
    spanMargin: number;
    exposureMargin: number;
  }>>({});

  const pollFunds = useCallback(() => {
    fetch(scalperRoute(broker, 'funds'))
      .then(r => r.json())
      .then((j: { success: boolean; data?: Record<string, unknown> }) => {
        if (j.success && j.data) {
          const available = Number(j.data.availabelBalance ?? j.data.availableBalance ?? 0);
          const used = Number(j.data.utilizedAmount ?? j.data.usedMargin ?? j.data.marginUsed ?? 0);
          setFundsData({ available, used });
        }
      })
      .catch(() => {});
  }, [broker]);

  useEffect(() => {
    pollFunds();
    const interval = setInterval(pollFunds, 12000);
    return () => clearInterval(interval);
  }, [pollFunds]);

  // ── India VIX Ticker ────────────────────────────────────────────────
  const [vixData, setVixData] = useState<{ vix: number; prevClose: number } | null>(null);

  useEffect(() => {
    const pollVix = () => {
      fetch('/api/scalper/vix')
        .then(r => r.json())
        .then((j: { success: boolean; vix?: number; prevClose?: number }) => {
          if (j.success && j.vix !== undefined && j.prevClose !== undefined) {
            setVixData({ vix: j.vix, prevClose: j.prevClose });
          }
        })
        .catch(() => {});
    };
    pollVix();
    const interval = setInterval(pollVix, 60_000);
    return () => clearInterval(interval);
  }, []);


  // ── Orders & Tradebook State ──────────────────────────────────────
  const [showOrdersModal, setShowOrdersModal] = useState(false);
  const [showChainModal, setShowChainModal] = useState(false);
  const [ordersData, setOrdersData] = useState<Record<string, unknown>[]>([]);
  const [tradesData, setTradesData] = useState<Record<string, unknown>[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);

  const fetchOrdersAndTrades = useCallback(async () => {
    setOrdersLoading(true);
    setOrdersError(null);
    try {
      const res = await fetch(scalperRoute(broker, 'poll'));
      const j = await res.json() as {
        success: boolean;
        positions?: Record<string, unknown>[];
        orders?: Record<string, unknown>[];
        trades?: Record<string, unknown>[];
        positionsError?: string | null;
        error?: string;
      };
      if (j.success) {
        if (Array.isArray(j.orders)) setOrdersData(j.orders);
        if (Array.isArray(j.trades)) setTradesData(j.trades);
      } else if (j.error || j.positionsError) {
        setOrdersError(j.error || j.positionsError || 'Failed to fetch orders');
      }
    } catch (e) {
      setOrdersError(String((e as Error).message));
    } finally {
      setOrdersLoading(false);
    }
  }, [broker]);

  // ── Expiries and Market Data by Underlying ─────────────────────────
  const [expiriesMap, setExpiriesMap] = useState<Record<string, string[]>>({});
  const [chainData, setChainData] = useState<Record<string, { spot: number; strikes: number[]; quotes: Record<string, { ce: number; pe: number }>; prevClose?: number }>>({});
  const [lookupCache, setLookupCache] = useState<Record<string, { lotSize: number; strikes: Record<string, StrikeIdentifier> }>>({});
  const lookupCacheRef = useRef(lookupCache);
  useEffect(() => { lookupCacheRef.current = lookupCache; }, [lookupCache]);

  const [selectedUnderlying, setSelectedUnderlying] = useState<Underlying>('NIFTY');
  // Set once the user explicitly clicks an underlying pill — from then on their
  // choice wins over whatever basket happens to be first/open (previously a
  // pill click was inert as soon as any basket existed).
  const [hasManualUnderlying, setHasManualUnderlying] = useState(false);

  // Active / Primary underlying & expiry for WebSocket streaming
  const activeUnderlying = useMemo(() => {
    if (hasManualUnderlying) return selectedUnderlying;
    const open = baskets.find(b => b.legs.some(l => l.status === 'OPEN'));
    return (open?.underlying as Underlying) ?? (baskets[0]?.underlying as Underlying) ?? selectedUnderlying;
  }, [baskets, selectedUnderlying, hasManualUnderlying]);

  const activeExpiry = useMemo(() => {
    return expiriesMap[activeUnderlying]?.[0] ?? '';
  }, [expiriesMap, activeUnderlying]);

  const authKey = Array.from(
    new Set(authenticatedBrokers.map(b => (b === 'kotak' ? 'dhan' : b))),
  ).sort().join(',');

  const { liveQuotes, bridgeStatus, lastUpdated, transport } = useLiveOptionsWS(activeExpiry, broker, authenticatedBrokers, activeUnderlying);

  // ── Start / Stop Live Options WS Bridge ───────────────────────────
  useEffect(() => {
    if (!activeExpiry || !activeUnderlying) return;

    const brokersToStart = authKey.split(',').filter(Boolean) as Broker[];
    if (!brokersToStart.length) brokersToStart.push('dhan');

    for (const b of brokersToStart) {
      fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', underlying: activeUnderlying, expiry: activeExpiry, numStrikes: 35, broker: b }),
      }).catch(() => {});
    }

    return () => {
      fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop', brokers: brokersToStart }),
      }).catch(() => {});
    };
  }, [activeExpiry, activeUnderlying, authKey]);

  // ── Spot & Previous Close for Header Ticker ────────────────────────
  // /api/scalper/nifty-prev-close only knows NIFTY/BANKNIFTY/SENSEX — for any
  // other underlying it silently falls back to NIFTY's prev close, which would
  // compare e.g. CRUDEOIL's spot against NIFTY's previous close. Only use it
  // for the underlyings it actually supports; commodities get their prev_close
  // from the per-underlying option chain fetch instead (chainData[pair]).
  const INDEX_UNDERLYINGS = new Set<Underlying>(['NIFTY', 'BANKNIFTY', 'SENSEX']);
  const [spotPrevClose, setSpotPrevClose] = useState<number>(0);

  useEffect(() => {
    if (!INDEX_UNDERLYINGS.has(activeUnderlying)) {
      setSpotPrevClose(0);
      return;
    }
    fetch(`/api/scalper/nifty-prev-close?underlying=${activeUnderlying}`)
      .then(r => r.json())
      .then((j: { success: boolean; prevClose?: number }) => {
        if (j.success && j.prevClose && j.prevClose > 0) {
          setSpotPrevClose(j.prevClose);
        }
      })
      .catch(() => {});
  }, [activeUnderlying]);

  const activeSpot = useMemo(() => {
    if (liveQuotes?.spot && liveQuotes.spot > 0) return liveQuotes.spot;
    const pair = `${activeUnderlying}:${activeExpiry}`;
    return chainData[pair]?.spot ?? 0;
  }, [liveQuotes?.spot, chainData, activeUnderlying, activeExpiry]);

  const effectivePrevClose = useMemo(() => {
    if (INDEX_UNDERLYINGS.has(activeUnderlying)) return spotPrevClose;
    const pair = `${activeUnderlying}:${activeExpiry}`;
    return chainData[pair]?.prevClose ?? 0;
  }, [activeUnderlying, activeExpiry, spotPrevClose, chainData]);

  const spotChange = useMemo(() => {
    if (liveQuotes && liveQuotes.spot_change !== undefined && liveQuotes.spot_change !== 0) {
      return liveQuotes.spot_change;
    }
    if (activeSpot > 0 && effectivePrevClose > 0) return activeSpot - effectivePrevClose;
    return 0;
  }, [activeSpot, effectivePrevClose, liveQuotes?.spot_change]);

  const spotChangePct = useMemo(() => {
    if (liveQuotes && liveQuotes.spot_change_pct !== undefined && liveQuotes.spot_change_pct !== 0) {
      return liveQuotes.spot_change_pct;
    }
    if (activeSpot > 0 && effectivePrevClose > 0) return ((activeSpot - effectivePrevClose) / effectivePrevClose) * 100;
    return 0;
  }, [activeSpot, effectivePrevClose, liveQuotes?.spot_change_pct]);

  const liveVix = liveQuotes?.vix;
  const currentVix = (liveVix && liveVix.ltp > 0) ? liveVix.ltp : (vixData?.vix ?? 0);
  const currentVixPrevClose = (liveVix && (liveVix.prev_close ?? 0) > 0) ? liveVix.prev_close! : (vixData?.prevClose ?? 0);
  const vixChange = (liveVix && liveVix.change !== undefined && liveVix.change !== 0)
    ? liveVix.change
    : (currentVix > 0 && currentVixPrevClose > 0)
    ? currentVix - currentVixPrevClose
    : (vixData ? vixData.vix - vixData.prevClose : 0);
  const vixChangePct = (liveVix && liveVix.change_pct !== undefined && liveVix.change_pct !== 0)
    ? liveVix.change_pct
    : (currentVixPrevClose > 0)
    ? (vixChange / currentVixPrevClose) * 100
    : 0;

  // ── Pricing helpers for Quick Add Presets Grid ─────────────────────
  const activePair = `${activeUnderlying}:${activeExpiry}`;
  const activeChain = chainData[activePair];
  const gridStrikes = useMemo(() => {
    if (activeChain?.strikes?.length) return activeChain.strikes;
    if (liveQuotes?.strikes) {
      const keys = Object.keys(liveQuotes.strikes).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
      if (keys.length) return keys;
    }
    return [23600, 23800, 24000, 24200, 24400];
  }, [activeChain?.strikes, liveQuotes?.strikes]);

  const gridStep = useMemo(() => strikeStep(gridStrikes) || DEFAULT_INDEX_STEP[activeUnderlying] || 50, [gridStrikes, activeUnderlying]);
  const gridAtm = useMemo(() => (activeSpot > 0 ? nearestStrike(gridStrikes, activeSpot) : null), [gridStrikes, activeSpot]);

  const autoPremium = useCallback((strike: number, option: OptionType, legExpiry?: string): number => {
    const key = String(strike);
    const side = option === 'CE' ? 'ce' : 'pe';
    if (legExpiry != null && legExpiry !== activeExpiry) {
      const extraLtp = liveQuotes?.extra?.[legExpiry]?.[key]?.[side]?.ltp ?? 0;
      if (extraLtp > 0) return extraLtp;
    }
    const liveLtp = liveQuotes?.strikes?.[key]?.[side]?.ltp ?? 0;
    if (liveLtp > 0) return liveLtp;

    const pair = `${activeUnderlying}:${legExpiry || activeExpiry}`;
    const chain = chainData[pair];
    if (chain?.quotes) {
      const q = chain.quotes[key];
      const val = (side === 'ce' ? q?.ce : q?.pe) ?? 0;
      if (val > 0) return val;
    }
    return 0;
  }, [liveQuotes, activeExpiry, activeUnderlying, chainData]);

  // Fetch expiries for all underlyings on mount or broker change
  useEffect(() => {
    for (const u of UNDERLYINGS) {
      fetch(`/api/options/expiries?underlying=${u}&broker=${broker}`)
        .then(r => r.json())
        .then((j: { success: boolean; data?: string[] }) => {
          if (j.success && j.data?.length) {
            setExpiriesMap(prev => ({ ...prev, [u]: j.data! }));
          }
        })
        .catch(() => {});
    }
  }, [broker]);

  // Auto-backfill empty expiry on initial baskets once expiriesMap resolves
  useEffect(() => {
    setBaskets(prev => {
      let changed = false;
      const next = prev.map(b => {
        if (!b.expiry && expiriesMap[b.underlying]?.[0]) {
          changed = true;
          return { ...b, expiry: expiriesMap[b.underlying][0], updatedAt: new Date().toISOString() };
        }
        return b;
      });
      return changed ? next : prev;
    });
  }, [expiriesMap]);

  // Fetch chain data for all unique (underlying, expiry) pairs needed by current baskets
  const fetchAllChains = useCallback(() => {
    const pairs = new Set<string>();
    for (const b of basketsRef.current) {
      if (b.underlying && b.expiry) {
        pairs.add(`${b.underlying}:${b.expiry}`);
      }
    }
    // Also include active if not present
    if (activeUnderlying && activeExpiry) {
      pairs.add(`${activeUnderlying}:${activeExpiry}`);
    }

    for (const pair of pairs) {
      const [u, exp] = pair.split(':');
      if (!u || !exp) continue;

      fetch(`/api/options/chain?underlying=${u}&expiry=${exp}&broker=${broker}`)
        .then(r => r.json())
        .then((j: { success: boolean; data?: { chain?: { oc?: Record<string, unknown> } | Record<string, unknown>; strikes?: number[]; spot?: number; prev_close?: number } }) => {
          if (!j.success || !j.data) return;
          const oc = (j.data.chain as { oc?: Record<string, unknown> })?.oc ?? (j.data.chain as Record<string, unknown> | undefined);
          let strikes: number[] = [];
          const quotes: Record<string, { ce: number; pe: number }> = {};
          let spot = Number(j.data.spot) || 0;
          const prevClose = Number(j.data.prev_close) || 0;

          if (oc && typeof oc === 'object') {
            strikes = Object.keys(oc).map(Number).filter(n => !isNaN(n) && n > 0).sort((a, b) => a - b);
            for (const [sk, entryRaw] of Object.entries(oc)) {
              const strikeNum = Math.round(parseFloat(sk));
              if (isNaN(strikeNum)) continue;
              const entry = entryRaw as {
                ce?: { last_price?: number; ltp?: number; previous_close_price?: number; previous_close?: number };
                pe?: { last_price?: number; ltp?: number; previous_close_price?: number; previous_close?: number };
              };
              const ce = Number(entry?.ce?.last_price || entry?.ce?.ltp || entry?.ce?.previous_close_price || entry?.ce?.previous_close || 0);
              const pe = Number(entry?.pe?.last_price || entry?.pe?.ltp || entry?.pe?.previous_close_price || entry?.pe?.previous_close || 0);
              quotes[String(strikeNum)] = { ce, pe };
            }
          } else if (Array.isArray(j.data.strikes) && j.data.strikes.length > 0) {
            strikes = j.data.strikes;
          }

          setChainData(prev => ({
            ...prev,
            [pair]: {
              spot: spot > 0 ? spot : (prev[pair]?.spot ?? 0),
              strikes: strikes.length > 0 ? strikes : (prev[pair]?.strikes ?? []),
              quotes: { ...(prev[pair]?.quotes ?? {}), ...quotes },
              prevClose: prevClose > 0 ? prevClose : prev[pair]?.prevClose,
            },
          }));
        })
        .catch(() => {});

      // Also ensure lookup data (lot size & strike map) is loaded
      if (!lookupCacheRef.current[pair]) {
        const lookupUrl = broker === 'dhan'
          ? `/api/scalper/lookup?underlying=${u}&expiry=${exp}`
          : scalperRoute(broker, `lookup?underlying=${u}&expiry=${exp}`);
        fetch(lookupUrl)
          .then(r => r.json())
          .then((j: { success: boolean; data?: { lotSize?: number; strikes?: Record<string, StrikeIdentifier> } }) => {
            if (j.success && j.data) {
              setLookupCache(prev => ({
                ...prev,
                [pair]: {
                  lotSize: j.data!.lotSize ?? fallbackLotSize(u as Underlying, broker),
                  strikes: j.data!.strikes ?? {},
                },
              }));
            }
          })
          .catch(() => {});
      }
    }
  }, [broker, activeUnderlying, activeExpiry]);

  useEffect(() => {
    fetchAllChains();
    const interval = setInterval(fetchAllChains, 3000);
    return () => clearInterval(interval);
  }, [fetchAllChains]);

  // ── Restore saved baskets on mount ─────────────────────────────────
  useEffect(() => {
    fetch('/api/multi-leg-focus/baskets')
      .then(r => r.json())
      .then((j: { success: boolean; data?: MultiLegBasket[] }) => {
        if (j.success && Array.isArray(j.data) && j.data.length > 0) {
          setBaskets(j.data);
        } else {
          // If no baskets stored yet, create a default Short Strangle draft row
          const pair = `${activeUnderlying}:${activeExpiry}`;
          const chain = chainData[pair];
          const allStrikes = chain?.strikes?.length ? chain.strikes : [23600, 23800, 24000, 24200, 24400];
          const step = strikeStep(allStrikes) || DEFAULT_INDEX_STEP[activeUnderlying] || 50;
          const spot = chain?.spot ?? DEFAULT_INDEX_SPOT[activeUnderlying] ?? 24000;
          const atm = nearestStrike(allStrikes, spot) ?? (Math.round(spot / step) * step);

          const initialBasket: MultiLegBasket = {
            id: `basket-${Date.now()}`,
            name: 'Short Strangle',
            underlying: activeUnderlying,
            expiry: activeExpiry,
            broker,
            presetKey: 'short-strangle',
            legs: [
              { id: '1', side: 'S', option: 'CE', strike: atm + step, lots: 1, type: 'MARKET', status: 'DRAFT' },
              { id: '2', side: 'S', option: 'PE', strike: atm - step, lots: 1, type: 'MARKET', status: 'DRAFT' },
            ],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          setBaskets([initialBasket]);
        }
      })
      .catch(() => {});
  }, [broker]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Register all off-selected-expiry basket legs with watchExtra ────
  useEffect(() => {
    const extraRequests: { underlying: string; expiry: string; strike: number; side: 'CE' | 'PE' }[] = [];
    for (const b of baskets) {
      if (!b.expiry || !b.underlying) continue;
      for (const l of b.legs) {
        if (l.strike && (l.option === 'CE' || l.option === 'PE')) {
          extraRequests.push({
            underlying: b.underlying,
            expiry: b.expiry,
            strike: l.strike,
            side: l.option,
          });
        }
      }
    }
    if (extraRequests.length === 0) return;
    fetch('/api/options/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'watchExtra', underlying: activeUnderlying, requests: extraRequests }),
    }).catch(() => {});
  }, [baskets, activeUnderlying]);

  // ── LTP Resolver per Basket & Leg ─────────────────────────────────
  const ltpFor = useCallback((basket: MultiLegBasket, leg: MultiLegLeg): number => {
    // 1. If WebSocket quotes match this basket's underlying & expiry:
    const targetUnderlying = liveQuotes?.underlying ?? activeUnderlying;
    const targetExpiry = liveQuotes?.expiry ?? activeExpiry;
    if (liveQuotes?.strikes && basket.underlying === targetUnderlying && basket.expiry === targetExpiry) {
      const liveEntry = liveQuotes.strikes[String(leg.strike)];
      const liveLtp = (leg.option === 'CE' ? liveEntry?.ce?.ltp : liveEntry?.pe?.ltp) ?? 0;
      if (liveLtp > 0) return liveLtp;
    }

    // 2. If WebSocket quotes have off-expiry live tick from watchExtra:
    if (liveQuotes?.extra && liveQuotes.extra[basket.expiry]) {
      const expEntry = liveQuotes.extra[basket.expiry][String(leg.strike)];
      const extraLtp = (leg.option === 'CE' ? expEntry?.ce?.ltp : expEntry?.pe?.ltp) ?? 0;
      if (extraLtp > 0) return extraLtp;
    }

    // 3. Chain quotes lookup fallback
    const pair = `${basket.underlying}:${basket.expiry}`;
    const chain = chainData[pair];
    if (chain?.quotes) {
      const q = chain.quotes[String(leg.strike)];
      const val = (leg.option === 'CE' ? q?.ce : q?.pe) ?? 0;
      if (val > 0) return val;
    }

    return 0;
  }, [liveQuotes, activeUnderlying, activeExpiry, chainData]);

  // ── Margin Calculator across Baskets ──────────────────────────────
  const fetchMarginsForBaskets = useCallback(() => {
    for (const basket of basketsRef.current) {
      if (!basket.legs || basket.legs.length === 0 || !basket.expiry) continue;
      const pair = `${basket.underlying}:${basket.expiry}`;
      const lookup = lookupCache[pair];
      const lotSize = lookup?.lotSize ?? fallbackLotSize(basket.underlying as Underlying, broker);
      const strikes = lookup?.strikes ?? {};

      const legsPayload = basket.legs.map(leg => {
        const strikeEntry = strikes[String(leg.strike)];
        const resolvedSecId = leg.orderRef?.securityId || (leg.option === 'CE' ? strikeEntry?.ceId : strikeEntry?.peId);
        const price = (leg.fill?.avgPrice && leg.fill.avgPrice > 0) ? leg.fill.avgPrice : (leg.price ?? 0);
        const qty = leg.fill?.qty && leg.fill.qty > 0 ? leg.fill.qty : (leg.lots * lotSize);

        return {
          id: leg.id,
          side: leg.side,
          option: leg.option,
          strike: leg.strike,
          lots: leg.lots,
          quantity: qty,
          price,
          securityId: resolvedSecId,
          status: leg.status,
        };
      });

      fetch('/api/multi-leg-focus/margin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          underlying: basket.underlying,
          expiry: basket.expiry,
          broker,
          legs: legsPayload,
        }),
      })
        .then(r => r.json())
        .then((j: { success: boolean; data?: {
          legMargins: Record<string, number>;
          basketMargin: number;
          overallMargin: number;
          hedgeBenefit: number;
          spanMargin: number;
          exposureMargin: number;
        } }) => {
          if (j.success && j.data) {
            setBasketMargins(prev => ({
              ...prev,
              [basket.id]: j.data!,
            }));
          }
        })
        .catch(() => {});
    }
  }, [lookupCache, broker]);

  // Composition-only signature (underlying/expiry/strikes/side/lots/orderRef) —
  // live LTP ticks do not change margin requirements. Keying the margin fetch
  // on basket composition prevents rapid refiring and Dhan 429 rate limit errors.
  const basketsCompositionSignature = useMemo(() => {
    return baskets.map(b =>
      `${b.id}:${b.underlying}:${b.expiry}:${b.legs.map(l => `${l.side}-${l.option}-${l.strike}x${l.lots}-${l.status}-${l.orderRef?.securityId || ''}`).join('|')}`
    ).join(';');
  }, [baskets]);

  useEffect(() => {
    const timer = setTimeout(fetchMarginsForBaskets, 500);
    return () => clearTimeout(timer);
  }, [basketsCompositionSignature, lookupCache, fetchMarginsForBaskets]);

  // ── Persist Basket Helper ─────────────────────────────────────────
  const persistBasket = useCallback((basket: MultiLegBasket) => {
    fetch('/api/multi-leg-focus/baskets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(basket),
    }).catch(() => {});
  }, []);

  const updateBasket = useCallback((basketId: string, patch: Partial<MultiLegBasket>) => {
    setBaskets(prev => {
      const next = prev.map(b => {
        if (b.id !== basketId) return b;
        if (patch.underlying && patch.underlying !== b.underlying) {
          const newUnderlying = patch.underlying as Underlying;
          const newExp = expiriesMap[newUnderlying]?.[0] ?? '';
          const pair = `${newUnderlying}:${newExp}`;
          const strikes = chainData[pair]?.strikes?.length ? chainData[pair].strikes : [];
          const spot = chainData[pair]?.spot ?? DEFAULT_INDEX_SPOT[newUnderlying] ?? 24000;
          const step = DEFAULT_INDEX_STEP[newUnderlying] ?? 50;
          const newAtm = nearestStrike(strikes, spot) ?? (Math.round(spot / step) * step);

          let newLegs = b.legs;
          if (b.legs.every(l => l.status === 'DRAFT')) {
            const tpl = ALL_STRATEGY_TEMPLATES.find(t => t.key === b.presetKey);
            if (tpl) {
              newLegs = resolveTemplateLegs(tpl, newAtm, strikes, step);
            } else {
              const oldPair = `${b.underlying}:${b.expiry}`;
              const oldStrikes = chainData[oldPair]?.strikes?.length ? chainData[oldPair].strikes : [];
              const oldSpot = chainData[oldPair]?.spot ?? DEFAULT_INDEX_SPOT[b.underlying as Underlying] ?? spot;
              const oldStep = DEFAULT_INDEX_STEP[b.underlying as Underlying] ?? 50;
              const oldAtm = nearestStrike(oldStrikes, oldSpot) ?? (Math.round(oldSpot / oldStep) * oldStep);
              const diff = newAtm - oldAtm;
              newLegs = b.legs.map(l => ({
                ...l,
                strike: Math.round((l.strike + diff) / step) * step,
              }));
            }
          }

          return {
            ...b,
            ...patch,
            underlying: newUnderlying,
            expiry: newExp,
            legs: newLegs,
            updatedAt: new Date().toISOString(),
          };
        }

        return { ...b, ...patch, updatedAt: new Date().toISOString() };
      });
      const target = next.find(b => b.id === basketId);
      if (target) persistBasket(target);
      return next;
    });
  }, [expiriesMap, chainData, persistBasket]);

  const deleteBasket = useCallback((basketId: string) => {
    const target = basketsRef.current.find(b => b.id === basketId);
    if (target && target.legs.some(l => l.status === 'OPEN' || l.status === 'PLACING' || l.status === 'CLOSING')) {
      addToast('error', 'Cannot delete active strategy', 'Exit all open positions before deleting this row.');
      return;
    }
    setBaskets(prev => prev.filter(b => b.id !== basketId));
    fetch('/api/multi-leg-focus/baskets', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: basketId }),
    }).catch(() => {});
  }, [addToast]);

  // ── Add Strategy (from template or blank) ──────────────────────────
  const [category, setCategory] = useState<StrategyCategory>('Range Bound');

  const addStrategy = useCallback((template?: StrategyTemplate, targetUnderlying?: Underlying) => {
    const u: Underlying = targetUnderlying ?? selectedUnderlying ?? 'NIFTY';
    const exp = expiriesMap[u]?.[0] ?? '';
    const pair = `${u}:${exp}`;
    const strikes = chainData[pair]?.strikes?.length ? chainData[pair].strikes : [];
    const spot = chainData[pair]?.spot ?? DEFAULT_INDEX_SPOT[u];
    const step = DEFAULT_INDEX_STEP[u];
    const atm = nearestStrike(strikes, spot) ?? (Math.round(spot / step) * step);

    const tpl = template ?? {
      key: 'custom',
      name: 'Custom Strategy',
      legs: [
        { side: 'S' as const, option: 'CE' as const, offset: 2, ratio: 1 },
        { side: 'S' as const, option: 'PE' as const, offset: -2, ratio: 1 },
      ],
    };

    const newBasket: MultiLegBasket = {
      id: `mlf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: tpl.name,
      underlying: u,
      expiry: exp,
      broker,
      presetKey: tpl.key,
      legs: resolveTemplateLegs(tpl, atm, strikes, step),
      riskConfig: {
        targetValue: undefined,
        targetUnit: 'pts',
        slValue: undefined,
        slUnit: 'pts',
        armed: false,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    setBaskets(prev => [...prev, newBasket]);
    persistBasket(newBasket);
    addToast('success', `Added ${tpl.name} Strategy`, `Underlying: ${u} · Ready in Draft`);
  }, [selectedUnderlying, expiriesMap, chainData, broker, persistBasket, addToast]);

  // ── Global P&L Across All Baskets ─────────────────────────────────
  const overallTotalPnl = useMemo(() => {
    let sum = 0;
    for (const b of baskets) {
      const crudeMult = broker === 'dhan'
        ? (b.underlying === 'CRUDEOIL' ? 100 : b.underlying === 'CRUDEOILM' ? 10 : 1)
        : 1;
      const metrics = computeStrategyMetrics(b.legs, l => ltpFor(b, l), crudeMult);
      sum += metrics.totalPnlRupees;
    }
    return sum;
  }, [baskets, ltpFor, broker]);

  const activeStrategiesCount = useMemo(() => {
    return baskets.filter(b => b.legs.some(l => l.status === 'OPEN')).length;
  }, [baskets]);

  // ── Placement & Exits per Basket ──────────────────────────────────
  const [placingMap, setPlacingMap] = useState<Record<string, boolean>>({});
  const [exitingMap, setExitingMap] = useState<Record<string, boolean>>({});
  const [exitingLegs, setExitingLegs] = useState<Set<string>>(new Set());
  const exitingLegsRef = useRef<Set<string>>(new Set());

  const placeBasket = useCallback(async (basketId: string) => {
    const basket = basketsRef.current.find(b => b.id === basketId);
    if (!basket || !basket.legs.length || !basket.expiry) return;

    if (!hasAuthenticatedBroker) {
      addToast('error', 'No broker logged in', 'Log in before placing orders');
      return;
    }

    const pair = `${basket.underlying}:${basket.expiry}`;
    const lookup = lookupCache[pair];
    const lotSize = lookup?.lotSize ?? fallbackLotSize(basket.underlying as Underlying, broker);
    const strikeMap = lookup?.strikes ?? {};

    setPlacingMap(prev => ({ ...prev, [basketId]: true }));

    const ordered = sortLegsForPlacement(basket.legs);
    let working: MultiLegLeg[] = basket.legs.map(l => ({ ...l, status: 'PLACING' as MultiLegStatus }));
    updateBasket(basketId, { legs: working });

    try {
      for (const leg of ordered) {
        const label = `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}`;
        const qty = leg.lots * lotSize;
        const req = resolveOrderRequest(broker, {
          side: leg.side,
          option: leg.option,
          strike: leg.strike,
          qty,
          type: leg.type,
          price: leg.type === 'LIMIT' ? leg.price : undefined,
          underlying: basket.underlying as Underlying,
          productType: 'MARGIN',
        }, strikeMap);

        if (!req) {
          addToast('error', `${label} — no order identifier resolved`, 'Strike lookup not ready yet');
          working = working.map(l => (l.id === leg.id ? { ...l, status: 'FAILED' as MultiLegStatus } : l));
          updateBasket(basketId, { legs: working });
          continue;
        }

        try {
          const res = await fetch(req.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body),
          });
          const j = await res.json() as { success: boolean; order_id?: string; securityId?: string; symbol?: string; price?: number; error?: string };

          if (j.success) {
            const currentLtp = ltpFor(basket, leg);
            const fillPrice = (j.price && j.price > 0) ? j.price : (currentLtp > 0 ? currentLtp : (leg.price ?? 0));
            const secId = j.securityId ?? (req.body.securityId as string | undefined);
            const sym = j.symbol ?? (req.body.tradingsymbol as string | undefined);

            working = working.map(l => {
              if (l.id !== leg.id) return l;
              return {
                ...l,
                status: 'OPEN' as MultiLegStatus,
                fill: { qty, avgPrice: fillPrice },
                orderRef: { securityId: secId, symbol: sym },
              };
            });
            addToast('success', `Placed ${label}`, `ID: ${j.order_id ?? 'OK'}`);
          } else {
            working = working.map(l => (l.id === leg.id ? { ...l, status: 'FAILED' as MultiLegStatus } : l));
            addToast('error', `Rejected ${label}`, j.error ?? 'Unknown broker error');
          }
          updateBasket(basketId, { legs: working });
        } catch (e) {
          working = working.map(l => (l.id === leg.id ? { ...l, status: 'FAILED' as MultiLegStatus } : l));
          updateBasket(basketId, { legs: working });
          addToast('error', `Order failed for ${label}`, String(e));
        }
      }
    } finally {
      setPlacingMap(prev => ({ ...prev, [basketId]: false }));
      pollFunds();
      fetchMarginsForBaskets();
    }
  }, [broker, hasAuthenticatedBroker, lookupCache, updateBasket, ltpFor, addToast, pollFunds, fetchMarginsForBaskets]);

  const exitOneLeg = useCallback(async (basketId: string, leg: MultiLegLeg) => {
    if (exitingLegsRef.current.has(leg.id)) return;
    exitingLegsRef.current.add(leg.id);
    setExitingLegs(prev => new Set(prev).add(leg.id));

    const label = `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}`;
    const basket = basketsRef.current.find(b => b.id === basketId);

    try {
      const res = await fetch(scalperRoute(broker, 'positions'));
      const j = await res.json() as { success: boolean; data?: Record<string, unknown>[] };
      const rows = j.success && Array.isArray(j.data) ? j.data : [];
      const match = findLegPosition(broker, leg, rows);

      if (match.kind === 'flat') {
        updateBasket(basketId, {
          legs: basketsRef.current.find(b => b.id === basketId)?.legs.map(l => (l.id === leg.id ? { ...l, status: 'CLOSED' as const, fill: { qty: 0, avgPrice: l.fill?.avgPrice ?? 0 } } : l)) ?? [],
        });
        addToast('success', `${label} already flat at broker`, 'Updated status to CLOSED');
        return;
      }

      if (match.kind !== 'match') {
        addToast('error', `Cannot exit ${label}`, 'Could not match broker position');
        return;
      }

      const netQty = Number(match.row.netQty ?? 0);
      const expectedSign = leg.side === 'B' ? 1 : -1;
      if (Math.sign(netQty) !== expectedSign) {
        addToast(
          'error',
          `Cannot exit ${label}`,
          `Broker position sign mismatch (netQty ${netQty}) for a ${leg.side === 'B' ? 'BUY' : 'SELL'} leg — check Orders/Positions`,
        );
        return;
      }

      // Safe sizing: clamped to what this leg opened, clamped by what broker shows
      const brokerAbs = Math.abs(netQty);
      const ownQty = leg.fill?.qty && leg.fill.qty > 0 ? leg.fill.qty : brokerAbs;
      const qty = Math.min(ownQty, brokerAbs);
      if (qty <= 0) {
        addToast('error', `Cannot exit ${label}`, 'Resolved exit quantity is zero');
        return;
      }

      const side = leg.side === 'B' ? 'SELL' : 'BUY';
      const product = positionProduct(match.row);
      const productPayload = closeOrderProduct(broker, product);

      if (!productPayload) {
        addToast('error', `Cannot exit ${label}`, `Unsupported product "${product}"`);
        return;
      }

      const isSensex = basket?.underlying === 'SENSEX';
      const isCrude = basket?.underlying === 'CRUDEOIL' || basket?.underlying === 'CRUDEOILM';
      const defaultSegDhan = isSensex ? 'BSE_FNO' : (isCrude ? 'MCX_COMM' : 'NSE_FNO');
      const defaultExchOther = broker === 'kotak'
        ? (isSensex ? 'bse_fo' : (isCrude ? 'mcx_fo' : 'nse_fo'))
        : (isSensex ? 'BFO' : (isCrude ? 'MCX' : 'NFO'));

      const orderUrl = broker === 'dhan' ? '/api/scalper/fast-order' : scalperRoute(broker, 'order');
      const body = broker === 'dhan'
        ? { securityId: leg.orderRef?.securityId, quantity: qty, side, orderType: 'MARKET', exchangeSegment: match.row.exchangeSegment ?? defaultSegDhan, ...productPayload.fields }
        : { tradingsymbol: leg.orderRef?.symbol, quantity: qty, side, orderType: 'MARKET', exchange: match.row.exchange ?? defaultExchOther, ...productPayload.fields };

      const res2 = await fetch(orderUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j2 = await res2.json() as { success: boolean; order_id?: string; error?: string };

      if (j2.success) {
        addToast('success', `Exited ${label}`, `ID: ${j2.order_id}`);
        updateBasket(basketId, {
          legs: basketsRef.current.find(b => b.id === basketId)?.legs.map(l => (l.id === leg.id ? { ...l, status: 'CLOSED' as const, fill: { qty: 0, avgPrice: l.fill?.avgPrice ?? 0 } } : l)) ?? [],
        });
      } else {
        addToast('error', `Exit failed for ${label}`, j2.error ?? 'Unknown error');
      }
    } catch (e) {
      addToast('error', `Exit unconfirmed for ${label}`, String(e));
    } finally {
      exitingLegsRef.current.delete(leg.id);
      setExitingLegs(prev => {
        const next = new Set(prev);
        next.delete(leg.id);
        return next;
      });
      pollFunds();
      fetchMarginsForBaskets();
    }
  }, [broker, updateBasket, addToast, pollFunds, fetchMarginsForBaskets]);

  const exitingBasketsRef = useRef<Set<string>>(new Set());

  const exitBasket = useCallback(async (basketId: string) => {
    if (exitingBasketsRef.current.has(basketId)) return;
    exitingBasketsRef.current.add(basketId);
    setExitingMap(prev => ({ ...prev, [basketId]: true }));

    try {
      const basket = basketsRef.current.find(b => b.id === basketId);
      if (!basket) return;
      const openLegs = sortLegsForExit(basket.legs.filter(l => l.status === 'OPEN' || l.status === 'CLOSING'));
      for (const leg of openLegs) {
        await exitOneLeg(basketId, leg);
      }
    } finally {
      exitingBasketsRef.current.delete(basketId);
      setExitingMap(prev => ({ ...prev, [basketId]: false }));
    }
  }, [exitOneLeg]);

  // ── Add Lots to Existing Position Leg ─────────────────────────────
  const addLotsToLeg = useCallback(async (basketId: string, params: {
    legId: string;
    lots: number;
    orderType: 'MARKET' | 'LIMIT';
    limitPrice?: number;
    newSl?: number;
    newTp?: number;
  }) => {
    const basket = basketsRef.current.find(b => b.id === basketId);
    if (!basket) return;
    const leg = basket.legs.find(l => l.id === params.legId);
    if (!leg) return;

    if (!hasAuthenticatedBroker) {
      addToast('error', 'No broker logged in', 'Log in before placing orders');
      return;
    }

    const pair = `${basket.underlying}:${basket.expiry}`;
    const lookup = lookupCache[pair];
    const lotSize = lookup?.lotSize ?? fallbackLotSize(basket.underlying as Underlying, broker);
    const strikeMap = lookup?.strikes ?? {};

    const qty = params.lots * lotSize;
    const label = `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}`;

    const req = resolveOrderRequest(broker, {
      side: leg.side,
      option: leg.option,
      strike: leg.strike,
      qty,
      type: params.orderType,
      price: params.orderType === 'LIMIT' ? params.limitPrice : undefined,
      underlying: basket.underlying as Underlying,
      productType: 'MARGIN',
    }, strikeMap);

    if (!req) {
      addToast('error', `Order failed for ${label}`, 'Could not resolve security identifier');
      return;
    }

    try {
      const res = await fetch(req.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const j = await res.json() as { success: boolean; order_id?: string; securityId?: string; symbol?: string; price?: number; error?: string };

      if (j.success) {
        const currentLtp = ltpFor(basket, leg);
        const fillPrice = (j.price && j.price > 0)
          ? j.price
          : ((params.limitPrice && params.limitPrice > 0)
            ? params.limitPrice
            : (currentLtp > 0 ? currentLtp : (leg.price ?? 0)));

        const oldQty = (leg.fill?.qty && leg.fill.qty > 0) ? leg.fill.qty : (leg.lots * lotSize);
        const oldAvg = (leg.fill?.avgPrice && leg.fill.avgPrice > 0) ? leg.fill.avgPrice : (leg.price || currentLtp);
        const newTotalQty = oldQty + qty;
        const newAvgPrice = ((oldAvg * oldQty) + (fillPrice * qty)) / newTotalQty;
        const newLots = leg.lots + params.lots;

        const latestLegs = basketsRef.current.find(b => b.id === basket.id)?.legs ?? basket.legs;
        const updatedLegs = latestLegs.map(l => {
          if (l.id !== leg.id) return l;
          return {
            ...l,
            lots: newLots,
            price: newAvgPrice,
            ...(params.newSl !== undefined ? { sl: params.newSl } : {}),
            ...(params.newTp !== undefined ? { tp: params.newTp } : {}),
            fill: {
              qty: newTotalQty,
              avgPrice: newAvgPrice,
              orderId: j.order_id ?? l.fill?.orderId,
            },
          };
        });

        updateBasket(basket.id, { legs: updatedLegs });
        addToast('success', `Added ${params.lots} lot(s) to ${label}`, `New Avg: ₹${newAvgPrice.toFixed(2)} (${newLots} lots total)`);
        pollFunds();
        fetchMarginsForBaskets();
      } else {
        addToast('error', `Add lots failed for ${label}`, j.error ?? 'Unknown broker error');
      }
    } catch (e) {
      addToast('error', `Add lots failed for ${label}`, String(e));
    }
  }, [broker, hasAuthenticatedBroker, lookupCache, ltpFor, updateBasket, addToast, pollFunds, fetchMarginsForBaskets]);

  // ── Add New Leg to Active Basket ──────────────────────────────────
  const addNewLegToBasket = useCallback(async (basketId: string, params: {
    side: 'B' | 'S';
    option: 'CE' | 'PE';
    strike: number;
    lots: number;
    orderType: 'MARKET' | 'LIMIT';
    limitPrice?: number;
  }) => {
    const basket = basketsRef.current.find(b => b.id === basketId);
    if (!basket) return;

    if (!hasAuthenticatedBroker) {
      addToast('error', 'No broker logged in', 'Log in before placing orders');
      return;
    }

    const pair = `${basket.underlying}:${basket.expiry}`;
    const lookup = lookupCache[pair];
    const lotSize = lookup?.lotSize ?? fallbackLotSize(basket.underlying as Underlying, broker);
    const strikeMap = lookup?.strikes ?? {};

    const qty = params.lots * lotSize;
    const label = `${params.side === 'B' ? 'BUY' : 'SELL'} ${params.strike} ${params.option}`;

    const req = resolveOrderRequest(broker, {
      side: params.side,
      option: params.option,
      strike: params.strike,
      qty,
      type: params.orderType,
      price: params.orderType === 'LIMIT' ? params.limitPrice : undefined,
      underlying: basket.underlying as Underlying,
      productType: 'MARGIN',
    }, strikeMap);

    if (!req) {
      addToast('error', `Order failed for ${label}`, 'Could not resolve security identifier');
      return;
    }

    try {
      const res = await fetch(req.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const j = await res.json() as { success: boolean; order_id?: string; securityId?: string; symbol?: string; price?: number; error?: string };

      if (j.success) {
        const chain = chainData[pair];
        const q = chain?.quotes?.[String(params.strike)];
        const curLtp = (params.option === 'CE' ? q?.ce : q?.pe) ?? 0;
        const fillPrice = (j.price && j.price > 0)
          ? j.price
          : ((params.limitPrice && params.limitPrice > 0) ? params.limitPrice : curLtp);

        const newLeg: MultiLegLeg = {
          id: `mll_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          side: params.side,
          option: params.option,
          strike: params.strike,
          lots: params.lots,
          type: params.orderType,
          price: fillPrice,
          status: 'OPEN',
          fill: {
            qty,
            avgPrice: fillPrice,
            orderId: j.order_id,
          },
          orderRef: {
            securityId: j.securityId ?? (req.body.securityId as string | undefined),
            symbol: j.symbol ?? (req.body.tradingsymbol as string | undefined),
          },
        };

        const latestLegs = basketsRef.current.find(b => b.id === basket.id)?.legs ?? basket.legs;
        updateBasket(basket.id, { legs: [...latestLegs, newLeg] });
        addToast('success', `Added new leg ${label}`, `Filled @ ₹${fillPrice.toFixed(2)} (${params.lots} lots)`);
        pollFunds();
        fetchMarginsForBaskets();
      } else {
        addToast('error', `Add leg failed for ${label}`, j.error ?? 'Unknown broker error');
      }
    } catch (e) {
      addToast('error', `Add leg failed for ${label}`, String(e));
    }
  }, [broker, hasAuthenticatedBroker, lookupCache, chainData, updateBasket, addToast, pollFunds, fetchMarginsForBaskets]);

  // ── Broker Positions Poller across ALL Baskets ─────────────────────
  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      const anyPlaced = basketsRef.current.some(b => b.legs.some(l => l.orderRef != null));
      if (!anyPlaced && !showOrdersModal) return;

      try {
        const res = await fetch(scalperRoute(broker, 'poll'));
        const j = await res.json() as {
          success: boolean;
          data?: Record<string, unknown>[];
          positions?: Record<string, unknown>[];
          orders?: Record<string, unknown>[];
          trades?: Record<string, unknown>[];
          positionsError?: string | null;
          error?: string;
        };
        if (cancelled) return;
        if (!j.success) {
          if (j.error || j.positionsError) setOrdersError(j.error || j.positionsError || null);
          return;
        }
        setOrdersError(null);
        const rows = j.positions ?? j.data ?? [];
        if (Array.isArray(j.orders)) setOrdersData(j.orders);
        if (Array.isArray(j.trades)) setTradesData(j.trades);

        if (anyPlaced) {
          setBaskets(prevBaskets => {
            let anyChange = false;
            const nextBaskets = prevBaskets.map(basket => {
              let basketChange = false;
              const pair = `${basket.underlying}:${basket.expiry}`;
              const lotSize = lookupCacheRef.current[pair]?.lotSize ?? fallbackLotSize(basket.underlying as Underlying, broker);

              const nextLegs = basket.legs.map(leg => {
                if (!leg.orderRef) return leg;
                const match = findLegPosition(broker, leg, rows);
                const reconciled = reconcileLegWithBroker(leg, match, leg.lots * lotSize, lotSize);

                if (
                  reconciled.status !== leg.status ||
                  reconciled.lots !== leg.lots ||
                  reconciled.fill?.qty !== leg.fill?.qty ||
                  reconciled.fill?.avgPrice !== leg.fill?.avgPrice ||
                  reconciled.closedFill?.exitPrice !== leg.closedFill?.exitPrice
                ) {
                  basketChange = true;
                  anyChange = true;
                  return reconciled;
                }
                return leg;
              });

              if (basketChange) {
                const updated = { ...basket, legs: nextLegs, updatedAt: new Date().toISOString() };
                persistBasket(updated);
                return updated;
              }
              return basket;
            });

            return anyChange ? nextBaskets : prevBaskets;
          });
        }
      } catch (err) {
        if (!cancelled) setOrdersError(String((err as Error).message));
      }
    };

    poll();
    const interval = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [broker, showOrdersModal, persistBasket]);

  // ── Automated Risk Watcher: SL, TP, Trailing SL, Strategy Target/SL ─
  const triggeredLegExitsRef = useRef<Set<string>>(new Set());
  const triggeredStrategyExitsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const basket of baskets) {
      const openLegs = basket.legs.filter(l => l.status === 'OPEN' && l.fill);
      if (openLegs.length === 0) {
        triggeredStrategyExitsRef.current.delete(basket.id);
        continue;
      }

      // 1. Strategy Target and SL
      if (basket.riskConfig?.armed && !triggeredStrategyExitsRef.current.has(basket.id) && !exitingMap[basket.id]) {
        const crudeMult = broker === 'dhan'
          ? (basket.underlying === 'CRUDEOIL' ? 100 : basket.underlying === 'CRUDEOILM' ? 10 : 1)
          : 1;
        const metrics = computeStrategyMetrics(basket.legs, l => ltpFor(basket, l), crudeMult);
        const decision = checkStrategyRisk(metrics, basket.riskConfig);

        if (decision === 'TARGET') {
          triggeredStrategyExitsRef.current.add(basket.id);
          addToast('success', `${basket.name ?? 'Strategy'} Target Reached`, `Closed basket at ${metrics.pnlPts >= 0 ? '+' : ''}${metrics.pnlPts.toFixed(1)} pts (${metrics.pnlPct >= 0 ? '+' : ''}${metrics.pnlPct.toFixed(1)}%)`);
          exitBasket(basket.id);
          continue;
        } else if (decision === 'SL') {
          triggeredStrategyExitsRef.current.add(basket.id);
          addToast('error', `${basket.name ?? 'Strategy'} Stop Loss Reached`, `Closed basket at ${metrics.pnlPts.toFixed(1)} pts (${metrics.pnlPct.toFixed(1)}%)`);
          exitBasket(basket.id);
          continue;
        }
      }

      // 2. Leg-wise SL, TP, and Trailing SL
      let bestUpdated = false;
      const updatedLegs = basket.legs.map(leg => {
        if (leg.status !== 'OPEN' || !leg.fill) return leg;
        const ltp = ltpFor(basket, leg);
        if (ltp <= 0) return leg;

        const evalResult = computeLegTrailingSL(leg, ltp);

        if (evalResult.newBestPrice !== leg.bestPrice && evalResult.newBestPrice != null) {
          bestUpdated = true;
          leg = { ...leg, bestPrice: evalResult.newBestPrice };
        }

        if (evalResult.triggered && !triggeredLegExitsRef.current.has(leg.id) && !exitingLegsRef.current.has(leg.id)) {
          triggeredLegExitsRef.current.add(leg.id);
          const label = `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}`;
          const trigMsg =
            evalResult.triggered === 'TRAIL_SL'
              ? `Trailing SL Hit at ₹${ltp.toFixed(2)} (Stop: ₹${evalResult.effectiveSL?.toFixed(2)})`
              : evalResult.triggered === 'SL'
              ? `Stop Loss Hit at ₹${ltp.toFixed(2)} (Stop: ₹${evalResult.effectiveSL?.toFixed(2)})`
              : `Take Profit Hit at ₹${ltp.toFixed(2)} (Target: ₹${evalResult.tpPrice?.toFixed(2)})`;

          addToast(evalResult.triggered === 'TP' ? 'success' : 'error', `${label} Triggered`, trigMsg);
          exitOneLeg(basket.id, leg);
        }

        return leg;
      });

      if (bestUpdated) {
        updateBasket(basket.id, { legs: updatedLegs });
      }
    }
  }, [baskets, ltpFor, exitingMap, exitBasket, exitOneLeg, updateBasket, addToast]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <NavBar />

      {/* Floating Notifications */}
      <div className="fixed top-16 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={`pointer-events-auto px-4 py-3 rounded-xl border text-sm font-semibold shadow-2xl max-w-xs ${
            t.type === 'success' ? 'bg-emerald-900/95 border-emerald-500/40 text-emerald-200' : 'bg-rose-900/95 border-rose-500/40 text-rose-200'
          }`}>
            <p>{t.message}</p>
            {t.detail && <p className="text-xs opacity-80 mt-0.5">{t.detail}</p>}
          </div>
        ))}
      </div>

      {!hasAuthenticatedBroker && (
        <div className="z-20 bg-amber-900/95 border-b border-amber-500/40 px-4 py-2 text-center">
          <p className="text-xs font-bold text-amber-200">No broker logged in — log in to fetch live data and place orders.</p>
        </div>
      )}

      {/* Top Global Command Bar */}
      <div className="sticky top-0 z-30 bg-zinc-950/95 backdrop-blur border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-bold tracking-wide uppercase text-white flex items-center gap-1.5">
              <Layers className="w-4 h-4 text-emerald-400" />
              Multi-Leg Strategy Focus
            </h1>
            <span className="text-xs text-zinc-400 font-semibold">
              {activeStrategiesCount} Running · {baskets.length} Total
            </span>

            {/* Underlying Ticker Selector Pills */}
            <div className="flex items-center gap-0.5 bg-zinc-900 p-0.5 rounded-lg border border-zinc-800">
              {UNDERLYINGS.map(u => (
                <button
                  key={u}
                  type="button"
                  onClick={() => { setSelectedUnderlying(u); setHasManualUnderlying(true); }}
                  className={`px-2 py-1 text-[11px] font-bold rounded-md transition-colors ${
                    activeUnderlying === u
                      ? 'bg-zinc-700 text-white shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                  }`}
                  title={`Focus on ${u} options & spot`}
                >
                  {u}
                </button>
              ))}
            </div>

            {/* Live Spot Ticker from WebSocket */}
            {activeSpot > 0 && (
              <div
                className="h-8 flex items-baseline gap-2 px-3 rounded-lg bg-zinc-900 border border-zinc-700/80 font-mono tabular-nums shadow-sm"
                title={`${activeUnderlying} Spot from ${liveQuotes?.spot ? 'WebSocket Live Feed' : 'Option Chain'} | Prev Close: ${effectivePrevClose > 0 ? effectivePrevClose.toFixed(2) : '—'}`}
              >
                <span className="text-[11px] font-bold text-zinc-400 tracking-wider">{activeUnderlying}</span>
                <span className="text-sm font-bold text-white">
                  {activeSpot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                {(effectivePrevClose > 0 || liveQuotes?.spot_change !== undefined) && (
                  <span className={`text-xs font-semibold flex items-center gap-0.5 ${spotChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    <span>{spotChange >= 0 ? '▲' : '▼'}</span>
                    <span>{Math.abs(spotChange).toFixed(2)}</span>
                    <span className="text-[11px] opacity-90">({spotChange >= 0 ? '+' : ''}{spotChangePct.toFixed(2)}%)</span>
                  </span>
                )}
              </div>
            )}

            {/* India VIX Ticker */}
            {vixData && (
              <div
                className="h-8 flex items-baseline gap-2 px-3 rounded-lg bg-zinc-900 border border-zinc-700/80 font-mono tabular-nums shadow-sm"
                title={`India VIX | Prev Close: ${vixData.prevClose.toFixed(2)}`}
              >
                <span className="text-[11px] font-bold text-zinc-400 tracking-wider">VIX</span>
                <span className="text-sm font-bold text-white">{vixData.vix.toFixed(2)}</span>
                <span className={`text-xs font-semibold flex items-center gap-0.5 ${vixChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  <span>{vixChange >= 0 ? '▲' : '▼'}</span>
                  <span>{Math.abs(vixChange).toFixed(2)}</span>
                  <span className="text-[11px] opacity-90">({vixChange >= 0 ? '+' : ''}{vixChangePct.toFixed(2)}%)</span>
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {/* Broker Selector */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-zinc-400 font-semibold">Broker:</span>
              <select
                value={broker}
                onChange={e => setBroker(e.target.value as Broker)}
                className="h-8 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-bold rounded-lg px-2 focus:outline-none focus:border-emerald-500"
              >
                {Object.entries(BROKER_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>

            {/* Broker Margin / Funds Information */}
            {fundsData && (
              <div className="flex items-center gap-2">
                <span
                  className="h-8 flex items-center gap-1.5 px-2.5 rounded-lg text-xs font-bold font-mono tabular-nums bg-zinc-900 border border-zinc-700 text-zinc-200"
                  title="Available Margin / Cash from Broker"
                >
                  <span className="text-zinc-400 font-medium text-[11px]">Avail Margin:</span>
                  <span className="text-emerald-400 font-bold">{fmtMoney(fundsData.available)}</span>
                </span>
                <span
                  className="h-8 flex items-center gap-1.5 px-2.5 rounded-lg text-xs font-bold font-mono tabular-nums bg-zinc-900 border border-zinc-700 text-zinc-200"
                  title="Used / Blocked Margin from Broker"
                >
                  <span className="text-zinc-400 font-medium text-[11px]">Used Margin:</span>
                  <span className="text-amber-400 font-bold">{fmtMoney(fundsData.used)}</span>
                </span>
              </div>
            )}

            {/* Overall P&L */}
            <span className={`h-8 flex items-center px-3 rounded-lg text-xs font-bold font-mono tabular-nums border ${
              overallTotalPnl >= 0 ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/5' : 'text-rose-400 border-rose-500/30 bg-rose-500/5'
            }`}>
              Total P&L: {overallTotalPnl >= 0 ? '+' : ''}{fmtMoney(overallTotalPnl)}
            </span>

            {/* Orders & Tradebook Button */}
            <button
              type="button"
              onClick={() => {
                setShowOrdersModal(true);
                fetchOrdersAndTrades();
              }}
              className={`h-8 px-3 inline-flex items-center gap-1.5 text-xs font-bold rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 hover:text-white transition-colors cursor-pointer ${FOCUS_RING}`}
              title="View today's broker orders and executed trades"
            >
              <ClipboardList className="w-3.5 h-3.5 text-sky-400" />
              <span>Orders</span>
              {ordersData.length > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-sky-500/20 text-sky-300 border border-sky-500/30">
                  {ordersData.length}
                </span>
              )}
            </button>

            {/* Option Chain & Greeks Button */}
            <button
              type="button"
              onClick={() => setShowChainModal(true)}
              className={`h-8 px-3 inline-flex items-center gap-1.5 text-xs font-bold rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 hover:text-white transition-colors cursor-pointer ${FOCUS_RING}`}
              title="View option chain with Greeks (IV, Delta, Theta, Gamma, Vega)"
            >
              <ListTree className="w-3.5 h-3.5 text-violet-400" />
              <span>Option Chain</span>
            </button>

            {/* + Add Strategy Button */}
            <button
              type="button"
              onClick={() => addStrategy()}
              className={`h-8 px-3 inline-flex items-center gap-1.5 text-xs font-bold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors ${FOCUS_RING}`}
            >
              <Plus className="w-3.5 h-3.5" />
              New Strategy Row
            </button>

            {/* Manual Refresh Button */}
            <button
              type="button"
              onClick={() => {
                fetchAllChains();
                pollFunds();
                fetchMarginsForBaskets();
              }}
              title="Refresh quotes and margins"
              className={`h-8 w-8 flex items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-white ${FOCUS_RING}`}
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>

            {/* WS Live Badge */}
            <span className={`h-8 flex items-center px-2 text-[11px] font-bold font-mono rounded-lg border ${
              bridgeStatus?.status === 'RUNNING' && liveQuotes
                ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                : 'text-zinc-400 bg-zinc-900 border-zinc-700'
            }`}>
              {bridgeStatus?.status === 'RUNNING' && liveQuotes ? '● WS Live' : 'REST Chain'}
            </span>
          </div>
        </div>

        {/* Strategy Templates Bar — NEVER disabled so user can always add another strategy! */}
        <div className="mt-2.5 pt-2.5 border-t border-zinc-800/80">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
              Quick Add Strategy Presets
            </span>
            <span className="text-[10px] text-zinc-500">
              Click any strategy to instantiate a new independent parallel row
            </span>
          </div>
          <StrategyCardGrid
            category={category}
            onCategoryChange={setCategory}
            selectedKey={null}
            onSelectTemplate={addStrategy}
            disabled={false}
            atmStrike={gridAtm}
            step={gridStep}
            allStrikes={gridStrikes}
            autoPremium={autoPremium}
            frontExpiry={activeExpiry}
            farExpiry={expiriesMap[activeUnderlying]?.[1] ?? ''}
          />
        </div>
      </div>

      {/* Main Container: Parallel Strategy Rows */}
      <div className="p-4 flex flex-col gap-4 max-w-[1700px] mx-auto">
        {baskets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3 border border-zinc-800/60 rounded-xl bg-zinc-900/20">
            <Layers className="w-10 h-10 text-zinc-600" />
            <p className="text-sm font-semibold text-zinc-300">No Active or Draft Strategies</p>
            <p className="text-xs text-zinc-500">Click &ldquo;New Strategy Row&rdquo; or pick a preset above to run strategies in parallel.</p>
            <button
              type="button"
              onClick={() => addStrategy()}
              className="mt-2 h-8 px-4 inline-flex items-center gap-1.5 text-xs font-bold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white"
            >
              <Plus className="w-3.5 h-3.5" /> Add First Strategy
            </button>
          </div>
        ) : (
          baskets.map((basket, idx) => {
            const pair = `${basket.underlying}:${basket.expiry}`;
            const chain = chainData[pair];
            const lookup = lookupCache[pair];
            const expiries = expiriesMap[basket.underlying] ?? [];
            const allStrikes = chain?.strikes?.length ? chain.strikes : [23600, 23800, 24000, 24200, 24400];
            const step = strikeStep(allStrikes) || DEFAULT_INDEX_STEP[basket.underlying as Underlying] || 50;
            const rowSpot = (basket.underlying === activeUnderlying && liveQuotes?.spot && liveQuotes.spot > 0)
              ? liveQuotes.spot
              : (chain?.spot ?? DEFAULT_INDEX_SPOT[basket.underlying as Underlying] ?? 24000);
            const atmStrike = nearestStrike(allStrikes, rowSpot) ?? (Math.round(rowSpot / step) * step);
            const lotSize = lookup?.lotSize ?? fallbackLotSize(basket.underlying as Underlying, broker);

            return (
              <MultiLegStrategyRow
                key={basket.id}
                basket={basket}
                index={idx}
                broker={broker}
                hasAuthenticatedBroker={hasAuthenticatedBroker}
                expiries={expiries}
                allStrikes={allStrikes}
                lotSize={lotSize}
                step={step}
                atmStrike={atmStrike}
                spot={rowSpot}
                ltpFor={leg => ltpFor(basket, leg)}
                ltpForStrike={(strk, opt) => {
                  const key = String(strk);
                  const side = opt === 'CE' ? 'ce' : 'pe';
                  if (basket.underlying === activeUnderlying && basket.expiry === activeExpiry) {
                    const liveLtp = liveQuotes?.strikes?.[key]?.[side]?.ltp ?? 0;
                    if (liveLtp > 0) return liveLtp;
                  }
                  if (liveQuotes?.extra?.[basket.expiry]) {
                    const extraLtp = liveQuotes.extra[basket.expiry]?.[key]?.[side]?.ltp ?? 0;
                    if (extraLtp > 0) return extraLtp;
                  }
                  const pair = `${basket.underlying}:${basket.expiry}`;
                  const chain = chainData[pair];
                  const q = chain?.quotes?.[key];
                  return (opt === 'CE' ? q?.ce : q?.pe) ?? 0;
                }}
                onUpdate={patch => updateBasket(basket.id, patch)}
                onDelete={() => deleteBasket(basket.id)}
                onPlace={() => placeBasket(basket.id)}
                onExit={() => exitBasket(basket.id)}
                onExitLeg={leg => exitOneLeg(basket.id, leg)}
                onAddLots={params => addLotsToLeg(basket.id, params)}
                onAddNewLeg={params => addNewLegToBasket(basket.id, params)}
                placing={!!placingMap[basket.id]}
                exiting={!!exitingMap[basket.id]}
                exitingLegs={exitingLegs}
                legMargins={basketMargins[basket.id]?.legMargins}
                basketMargin={basketMargins[basket.id]?.basketMargin}
                overallMargin={basketMargins[basket.id]?.overallMargin}
                hedgeBenefit={basketMargins[basket.id]?.hedgeBenefit}
              />
            );
          })
        )}
      </div>

      {/* Full-Width Orders & Tradebook Modal */}
      <OrdersTradesModal
        isOpen={showOrdersModal}
        onClose={() => setShowOrdersModal(false)}
        broker={broker}
        ordersData={ordersData}
        tradesData={tradesData}
        isLoading={ordersLoading}
        error={ordersError}
        onRefresh={fetchOrdersAndTrades}
      />

      {/* Option Chain & Greeks Modal */}
      <MultiLegOptionChainModal
        isOpen={showChainModal}
        onClose={() => setShowChainModal(false)}
        underlying={activeUnderlying}
        expiriesMap={expiriesMap}
        broker={broker}
      />
    </div>
  );
}
