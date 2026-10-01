'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Plus, RefreshCw, Layers, ClipboardList, ListTree, ChevronDown, ChevronRight, Download, History, CircleHelp } from 'lucide-react';
import Link from 'next/link';
import NavBar from './NavBar';
import { type Toast, FOCUS_RING } from './Scalper';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { useBrokerSelector, scalperRoute, BROKER_LABELS, BROKERS, type Broker } from '@/hooks/useBrokerSelector';
import {
  STRATEGY_CATEGORIES, type StrategyCategory, type StrategyTemplate, type OptionType, nearestStrike, strikeStep,
} from '@/lib/basketStrategies';
import { sortLegsForPlacement, resolveOrderRequest, type StrikeIdentifier } from '@/lib/basketOrders';
import StrategyCardGrid from './basket/StrategyCardGrid';
import MultiLegStrategyRow from './multiLegFocus/MultiLegStrategyRow';
import OrdersTradesModal from './multiLegFocus/OrdersTradesModal';
import ImportPositionsModal, { type ImportCandidate, type ImportRequest } from './multiLegFocus/ImportPositionsModal';
import HistoryModal from './multiLegFocus/HistoryModal';
import MultiLegOptionChainModal from './multiLegFocus/MultiLegOptionChainModal';
import HelpModal from './HelpModal';
import {
  resolveTemplateLegs, reconcileLegWithBroker, sortLegsForExit, findLegPosition, claimableLegQty, executionBroker,
  applyOrderOutcomes, normalizeOrderRow, withPendingOrder, LEG_FILL_GRACE_MS, legBrokerMismatch, classifyDhanOrder, type DhanOrderPhase, type NormalizedOrder,
  computeLegTrailingSL, computeStrategyMetrics, checkStrategyRisk, fallbackLotSize,
  positionProduct, computeBasketStatus, closedFillFromRow,
  findSiblingLegCollisions, describeSiblingCollisions,
  legQtyWarningsFor, recordOutsideReduction, legCountsToday, type LegQtyWarning,
  findUntrackedPositions, contractHintFromRow, legFromUntracked,
  type MultiLegLeg, type MultiLegBasket, type StrategyRiskConfig, type MultiLegStatus,
} from '@/lib/multiLegFocus';
import { closeOrderProduct } from '@/lib/positionProduct';
import { planLegShifts, clampShiftSteps } from '@/lib/strikeShift';
import { pnlMultiplier } from '@/lib/multiLegArchive';
import { previousDaysPnl, type TradeHistoryResponse } from '@/lib/portfolioDailyPnl';
import { DEFAULT_LEG_COLUMNS, loadLegColumns, saveLegColumns, type LegColumns } from '@/lib/legColumns';
import { strikeAllowed, strikeRuleApplies, allowedStrikes, snapToAllowed, assessSpread } from '@/lib/farExpiryRules';

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

function fallbackStrikesFor(underlying: Underlying): number[] {
  const spot = DEFAULT_INDEX_SPOT[underlying] ?? 24000;
  const step = DEFAULT_INDEX_STEP[underlying] ?? 50;
  return Array.from({ length: 9 }, (_, i) => spot + (i - 4) * step);
}

const ALL_STRATEGY_TEMPLATES: StrategyTemplate[] = Object.values(STRATEGY_CATEGORIES).flat();

/** lookupCache key. Per broker: Dhan's entries carry security ids, Zerodha/Kotak's
 *  carry trading symbols, and MCX lot sizes differ 100x between them — one
 *  broker's entry must never size or resolve another broker's order. */
type LookupEntry = { lotSize: number; strikes: Record<string, StrikeIdentifier> };

function lkKey(broker: string, underlying: string, expiry: string): string {
  return `${broker}|${underlying}:${expiry}`;
}

function fmtMoney(n: number): string {
  return `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

/** Margin-relevant composition of a basket — LTP ticks don't change it. */
const basketCompKey = (b: MultiLegBasket) =>
  `${b.underlying}:${b.expiry}:${b.legs.map(l => `${l.side}-${l.option}-${l.strike}@${l.expiry || b.expiry}x${l.lots}`).join('|')}`;

export interface MultiLegFocusProps {
  embedded?: boolean;
  hideHeader?: boolean;
  activeUnderlyingProp?: Underlying;
  onUnderlyingChangeProp?: (u: Underlying) => void;
  expiriesMapProp?: Record<string, string[]>;
  /** app/multi-leg-focus/README.md, read by the page; the How to use button shows only when set. */
  helpMarkdown?: string;
}

export default function MultiLegFocus({
  embedded = false,
  hideHeader = false,
  activeUnderlyingProp,
  onUnderlyingChangeProp,
  expiriesMapProp,
  helpMarkdown,
}: MultiLegFocusProps = {}) {
  const [showHelp, setShowHelp] = useState(false);
  const { broker, setBroker, authenticatedBrokers, hasAuthenticatedBroker } = useBrokerSelector();

  // Multi-Basket State: list of all strategies
  const [baskets, setBaskets] = useState<MultiLegBasket[]>([]);
  const basketsRef = useRef<MultiLegBasket[]>([]);
  useEffect(() => { basketsRef.current = baskets; }, [baskets]);
  // Set once the "restore saved baskets" fetch below has settled (mount, and
  // again on every broker switch, since that effect re-fires on [broker]).
  // The poll effect's untracked-position scan runs immediately on mount too
  // and reads basketsRef.current — which starts at [] and only reflects the
  // real stored baskets after that fetch resolves. Scanning against an empty
  // list makes every already-tracked open position look "unclaimed" and
  // re-adopts it as a brand-new duplicate basket. Gate the scan on this so
  // it never runs before the real baskets are known.
  const basketsLoadedRef = useRef(false);

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
    legMarginSource: Record<string, 'live' | 'estimate'>;
    basketMargin: number;
    basketMarginSource: 'live' | 'estimate';
    overallMargin: number;
    hedgeBenefit: number;
    spanMargin: number;
    exposureMargin: number;
  }>>({});

  // Optional legs-table columns (shared by every strategy row); a browser-local preference. Read in the
  // initial state: strategy rows only exist after the baskets load client-side, so nothing that depends on
  // this is ever part of the server-rendered HTML.
  const [legColumns, setLegColumns] = useState<LegColumns>(() => (typeof window === 'undefined' ? DEFAULT_LEG_COLUMNS : loadLegColumns()));
  const changeLegColumns = useCallback((next: LegColumns) => { setLegColumns(next); saveLegColumns(next); }, []);

  const marginCompRef = useRef<Record<string, string>>({});   // basketId -> composition the stored margin was computed for
  const fundsAtRef = useRef(0);                               // when fundsData was last read
  const placementLockRef = useRef(false);                     // one placement in flight at a time

  const fundsInflightRef = useRef<string | null>(null);   // broker with a funds read in flight: an N-leg exit ends N times in a row, one read not N
  const brokerNowRef = useRef(broker);
  useEffect(() => { brokerNowRef.current = broker; }, [broker]);
  const pollFunds = useCallback(() => {
    if (fundsInflightRef.current === broker) return;
    fundsInflightRef.current = broker;
    fetch(scalperRoute(broker, 'funds'))
      .then(r => r.json())
      .then((j: { success: boolean; data?: Record<string, unknown> }) => {
        // A reply for a broker that is no longer selected must not become the funds the order gate trusts.
        if (brokerNowRef.current !== broker) return;
        if (j.success && j.data) {
          const available = Number(j.data.availabelBalance ?? j.data.availableBalance ?? 0);
          const used = Number(j.data.utilizedAmount ?? j.data.usedMargin ?? j.data.marginUsed ?? 0);
          setFundsData({ available, used });
          fundsAtRef.current = Date.now();
        }
      })
      .catch(() => {})
      .finally(() => { if (fundsInflightRef.current === broker) fundsInflightRef.current = null; });
  }, [broker]);

  useEffect(() => {
    fundsAtRef.current = 0;   // broker changed: whatever funds we hold belong to the previous one
    pollFunds();
    const interval = setInterval(pollFunds, 4000);
    return () => clearInterval(interval);
  }, [pollFunds]);

  // ── India VIX Ticker ────────────────────────────────────────────────
  const [vixData, setVixData] = useState<{ vix: number; prevClose: number; stale: boolean } | null>(null);

  useEffect(() => {
    const pollVix = () => {
      fetch('/api/scalper/vix')
        .then(r => r.json())
        .then((j: { success: boolean; vix?: number; prevClose?: number; stale?: boolean }) => {
          if (j.success && j.vix !== undefined && j.prevClose !== undefined) {
            setVixData({ vix: j.vix, prevClose: j.prevClose, stale: j.stale ?? false });
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
  const [chainData, setChainData] = useState<Record<string, { spot: number; strikes: number[]; quotes: Record<string, { ce: number; pe: number; ceIv?: number; peIv?: number }>; prevClose?: number }>>({});
  const [lookupCache, setLookupCache] = useState<Record<string, LookupEntry>>({});
  const lookupCacheRef = useRef(lookupCache);
  useEffect(() => { lookupCacheRef.current = lookupCache; }, [lookupCache]);

  // Fallback securityId for a Dhan leg whose orderRef never captured one (or
  // lost it) — re-resolves from the strike/expiry chain lookup rather than
  // trusting only what was recorded at placement time, so a leg like that
  // isn't permanently unmatchable/unexitable. Dhan-only: every other broker
  // matches by trading symbol instead (see findLegPosition).
  const resolveDhanSecurityId = useCallback((b: MultiLegBasket, l: MultiLegLeg): string | undefined => {
    const strikeEntry = lookupCacheRef.current[lkKey('dhan', b.underlying, l.expiry || b.expiry)]?.strikes?.[String(l.strike)];
    return l.option === 'CE' ? strikeEntry?.ceId : strikeEntry?.peId;
  }, []);

  const [selectedUnderlying, setSelectedUnderlying] = useState<Underlying>(activeUnderlyingProp ?? 'NIFTY');
  // Set once the user explicitly clicks an underlying pill — from then on their
  // choice wins over whatever basket happens to be first/open (previously a
  // pill click was inert as soon as any basket existed).
  const [hasManualUnderlying, setHasManualUnderlying] = useState(Boolean(activeUnderlyingProp));

  useEffect(() => {
    if (activeUnderlyingProp && activeUnderlyingProp !== selectedUnderlying) {
      setSelectedUnderlying(activeUnderlyingProp);
      setHasManualUnderlying(true);
    }
  }, [activeUnderlyingProp, selectedUnderlying]);

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
        body: JSON.stringify({ action: 'stop', brokers: brokersToStart, underlying: activeUnderlying }),
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
    return fallbackStrikesFor(activeUnderlying);
  }, [activeChain?.strikes, liveQuotes?.strikes, activeUnderlying]);

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

  // Sync expiriesMap from parent prop if supplied. Runs alongside (not instead
  // of) the self-fetch below: the parent (Scalp Cockpit) only ever tracks its
  // own single active underlying, so it cannot supply expiries for whatever
  // underlying an individual DRAFT basket's own "Index" dropdown picks.
  useEffect(() => {
    if (expiriesMapProp && Object.keys(expiriesMapProp).length > 0) {
      setExpiriesMap(prev => ({ ...prev, ...expiriesMapProp }));
    }
  }, [expiriesMapProp]);

  // Underlyings actually in play: the top-level active pill plus every basket
  // row's own underlying (each row can independently pick any of the 5 via
  // its "Index" dropdown, so it must not be left waiting on the active pill).
  const neededUnderlyings = useMemo(() => {
    const set = new Set<string>();
    if (activeUnderlying) set.add(activeUnderlying);
    for (const b of baskets) {
      if (b.underlying) set.add(b.underlying);
    }
    return Array.from(set).sort().join(',');
  }, [activeUnderlying, baskets]);

  useEffect(() => {
    const list = neededUnderlyings ? neededUnderlyings.split(',') : [];
    for (const u of list) {
      // Also check expiriesMapProp directly, not just the expiriesMap state
      // it feeds: the prop-sync effect above updates that state via its own
      // setExpiriesMap call, which may not have committed yet in the same
      // render pass this effect runs in — reading only the state here would
      // race a redundant fetch for an underlying the parent already supplied.
      if (expiriesMap[u]?.length || expiriesMapProp?.[u]?.length) continue;
      fetch(`/api/options/expiries?underlying=${u}&broker=${broker}`)
        .then(r => r.json())
        .then((j: { success: boolean; data?: string[] }) => {
          if (j.success && j.data?.length) {
            setExpiriesMap(prev => ({ ...prev, [u]: j.data! }));
          }
        })
        .catch(() => {});
    }
  }, [broker, neededUnderlyings, expiriesMapProp]);

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

  // Lot size + strike -> id/symbol map for one broker/underlying/expiry, cached.
  const lookupPendingRef = useRef<Map<string, Promise<LookupEntry | undefined>>>(new Map());
  const ensureLookup = useCallback((lb: string, u: string, exp: string): Promise<LookupEntry | undefined> => {
    const key = lkKey(lb, u, exp);
    const cached = lookupCacheRef.current[key];
    if (cached) return Promise.resolve(cached);
    const pending = lookupPendingRef.current.get(key);
    if (pending) return pending;
    const lookupUrl = lb === 'dhan'
      ? `/api/scalper/lookup?underlying=${u}&expiry=${exp}`
      : scalperRoute(lb as Broker, `lookup?underlying=${u}&expiry=${exp}`);
    const p = fetch(lookupUrl)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { lotSize?: number; strikes?: Record<string, StrikeIdentifier> } }) => {
        if (!j.success || !j.data) return undefined;
        const entry: LookupEntry = {
          lotSize: j.data.lotSize ?? fallbackLotSize(u as Underlying, lb),
          strikes: j.data.strikes ?? {},
        };
        lookupCacheRef.current = { ...lookupCacheRef.current, [key]: entry };
        setLookupCache(prev => ({ ...prev, [key]: entry }));
        return entry;
      })
      .catch(() => undefined)
      .finally(() => { lookupPendingRef.current.delete(key); });
    lookupPendingRef.current.set(key, p);
    return p;
  }, []);

  // Fetch chain data for all unique (underlying, expiry) pairs needed by current baskets
  const fetchAllChains = useCallback(() => {
    // pair -> brokers that need its lookup (ids/lot size): each basket's own
    // execution broker, plus the selected one for drafts and the active pair.
    const pairs = new Map<string, Set<string>>();
    const need = (pair: string, b: string) => {
      if (!pairs.has(pair)) pairs.set(pair, new Set());
      pairs.get(pair)!.add(b);
    };
    for (const b of basketsRef.current) {
      const bk = executionBroker(b, broker);
      if (b.underlying && b.expiry) {
        need(`${b.underlying}:${b.expiry}`, bk);
      }
      // A Calendar/Diagonal leg's far expiry needs its own chain/lookup data
      // — it's a different contract from the basket's front-month expiry.
      for (const l of b.legs) {
        if (b.underlying && l.expiry && l.expiry !== b.expiry) {
          need(`${b.underlying}:${l.expiry}`, bk);
        }
      }
    }
    // Also include active if not present
    if (activeUnderlying && activeExpiry) {
      need(`${activeUnderlying}:${activeExpiry}`, broker);
    }

    for (const [pair, lookupBrokers] of pairs) {
      const [u, exp] = pair.split(':');
      if (!u || !exp) continue;

      fetch(`/api/options/chain?underlying=${u}&expiry=${exp}&broker=${broker}`)
        .then(r => r.json())
        .then((j: { success: boolean; data?: { chain?: { oc?: Record<string, unknown> } | Record<string, unknown>; strikes?: number[]; spot?: number; prev_close?: number } }) => {
          if (!j.success || !j.data) return;
          const oc = (j.data.chain as { oc?: Record<string, unknown> })?.oc ?? (j.data.chain as Record<string, unknown> | undefined);
          let strikes: number[] = [];
          const quotes: Record<string, { ce: number; pe: number; ceIv?: number; peIv?: number }> = {};
          let spot = Number(j.data.spot) || 0;
          const prevClose = Number(j.data.prev_close) || 0;

          if (oc && typeof oc === 'object') {
            strikes = Object.keys(oc).map(Number).filter(n => !isNaN(n) && n > 0).sort((a, b) => a - b);
            for (const [sk, entryRaw] of Object.entries(oc)) {
              const strikeNum = Math.round(parseFloat(sk));
              if (isNaN(strikeNum)) continue;
              const entry = entryRaw as {
                ce?: { last_price?: number; ltp?: number; previous_close_price?: number; previous_close?: number; implied_volatility?: number };
                pe?: { last_price?: number; ltp?: number; previous_close_price?: number; previous_close?: number; implied_volatility?: number };
              };
              const ce = Number(entry?.ce?.last_price || entry?.ce?.ltp || entry?.ce?.previous_close_price || entry?.ce?.previous_close || 0);
              const pe = Number(entry?.pe?.last_price || entry?.pe?.ltp || entry?.pe?.previous_close_price || entry?.pe?.previous_close || 0);
              const ceIv = Number(entry?.ce?.implied_volatility) || undefined;
              const peIv = Number(entry?.pe?.implied_volatility) || undefined;
              quotes[String(strikeNum)] = { ce, pe, ceIv, peIv };
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

      // Also ensure lookup data (lot size & strike map) is loaded, per broker
      for (const lb of lookupBrokers) void ensureLookup(lb, u, exp);
    }
  }, [broker, activeUnderlying, activeExpiry, ensureLookup]);

  useEffect(() => {
    fetchAllChains();
    const interval = setInterval(fetchAllChains, 3000);
    return () => clearInterval(interval);
  }, [fetchAllChains]);

  // ── Restore saved baskets on mount ─────────────────────────────────
  useEffect(() => {
    basketsLoadedRef.current = false;
    fetch('/api/multi-leg-focus/baskets')
      .then(r => r.json())
      .then((j: { success: boolean; data?: MultiLegBasket[] }) => {
        if (j.success && Array.isArray(j.data) && j.data.length > 0) {
          setBaskets(j.data);
        } else {
          // If no baskets stored yet, create a default Short Strangle draft row
          const pair = `${activeUnderlying}:${activeExpiry}`;
          const chain = chainData[pair];
          const allStrikes = chain?.strikes?.length ? chain.strikes : fallbackStrikesFor(activeUnderlying);
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
            multiplier: 1,
            legs: [
              { id: '1', side: 'S', option: 'CE', strike: atm + step, expiry: activeExpiry, ratio: 1, lots: 1, type: 'MARKET', status: 'DRAFT' },
              { id: '2', side: 'S', option: 'PE', strike: atm - step, expiry: activeExpiry, ratio: 1, lots: 1, type: 'MARKET', status: 'DRAFT' },
            ],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          setBaskets([initialBasket]);
        }
        basketsLoadedRef.current = true;
      })
      .catch(() => { basketsLoadedRef.current = true; });
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
            expiry: l.expiry || b.expiry,
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
    const legExpiry = leg.expiry || basket.expiry;

    // 1. If WebSocket quotes match this basket's underlying & expiry:
    const targetUnderlying = liveQuotes?.underlying ?? activeUnderlying;
    const targetExpiry = liveQuotes?.expiry ?? activeExpiry;
    if (liveQuotes?.strikes && basket.underlying === targetUnderlying && legExpiry === targetExpiry) {
      const liveEntry = liveQuotes.strikes[String(leg.strike)];
      const liveLtp = (leg.option === 'CE' ? liveEntry?.ce?.ltp : liveEntry?.pe?.ltp) ?? 0;
      if (liveLtp > 0) return liveLtp;
    }

    // 2. If WebSocket quotes have off-expiry live tick from watchExtra:
    if (liveQuotes?.extra && liveQuotes.extra[legExpiry]) {
      const expEntry = liveQuotes.extra[legExpiry][String(leg.strike)];
      const extraLtp = (leg.option === 'CE' ? expEntry?.ce?.ltp : expEntry?.pe?.ltp) ?? 0;
      if (extraLtp > 0) return extraLtp;
    }

    // 3. Chain quotes lookup fallback
    const pair = `${basket.underlying}:${legExpiry}`;
    const chain = chainData[pair];
    if (chain?.quotes) {
      const q = chain.quotes[String(leg.strike)];
      const val = (leg.option === 'CE' ? q?.ce : q?.pe) ?? 0;
      if (val > 0) return val;
    }

    return 0;
  }, [liveQuotes, activeUnderlying, activeExpiry, chainData]);

  // ── Margin Calculator across Baskets ──────────────────────────────
  // Composition-only signature per basket (underlying/expiry/strikes/side/
  // lots/resolved securityId/broker) — live LTP ticks do not change margin
  // requirements. Tracked per basket ID, not just joined across all baskets:
  // fetchMarginsForBaskets fires once for every basket whenever ANY basket's
  // composition changes (they share one effect trigger below), so without
  // this per-basket check, editing one basket would re-fetch margin for
  // every OTHER open basket too — multiplying Dhan calls through the shared
  // account-wide pacer (ultimateScannerDhan.ts's pacedMarginCall) for
  // baskets that didn't actually change.
  const lastFetchedMarginSignatureRef = useRef<Record<string, string>>({});

  const fetchMarginsForBaskets = useCallback(() => {
    for (const basket of basketsRef.current) {
      if (!basket.legs || basket.legs.length === 0 || !basket.expiry) continue;
      const bk = executionBroker(basket, broker);
      const lookup = lookupCache[lkKey(bk, basket.underlying, basket.expiry)];
      const lotSize = lookup?.lotSize ?? fallbackLotSize(basket.underlying as Underlying, bk);

      const legsPayload = basket.legs.map(leg => {
        // A Calendar/Diagonal far leg resolves its security id against its
        // OWN expiry's strike map, never the basket's front-month one.
        const legStrikes = lookupCache[lkKey(bk, basket.underlying, leg.expiry || basket.expiry)]?.strikes ?? {};
        const strikeEntry = legStrikes[String(leg.strike)];
        const resolvedSecId = leg.orderRef?.securityId || (leg.option === 'CE' ? strikeEntry?.ceId : strikeEntry?.peId);
        const price = (leg.fill?.avgPrice && leg.fill.avgPrice > 0) ? leg.fill.avgPrice : (leg.price ?? 0);
        const qty = leg.fill?.qty && leg.fill.qty > 0 ? leg.fill.qty : (leg.lots * lotSize);

        return {
          id: leg.id,
          side: leg.side,
          option: leg.option,
          strike: leg.strike,
          expiry: leg.expiry || basket.expiry,
          lots: leg.lots,
          quantity: qty,
          price,
          securityId: resolvedSecId,
          status: leg.status,
        };
      });

      // Include the *resolved* securityId (not just leg.orderRef?.securityId)
      // so a leg going from unresolved -> resolved as lookupCache populates
      // is treated as a real composition change, not skipped as unchanged.
      const signature = `${bk}:${basket.underlying}:${basket.expiry}:${legsPayload.map(l =>
        `${l.side}-${l.option}-${l.strike}@${l.expiry}x${l.lots}-${l.status}-${l.securityId || ''}`
      ).join('|')}`;
      if (lastFetchedMarginSignatureRef.current[basket.id] === signature) continue;
      lastFetchedMarginSignatureRef.current[basket.id] = signature;
      const compAtRequest = `${bk}|${basketCompKey(basket)}`;

      fetch('/api/multi-leg-focus/margin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          underlying: basket.underlying,
          expiry: basket.expiry,
          broker: bk,
          legs: legsPayload,
        }),
      })
        .then(r => r.json())
        .then((j: { success: boolean; data?: {
          legMargins: Record<string, number>;
          legMarginSource: Record<string, 'live' | 'estimate'>;
          basketMargin: number;
          basketMarginSource: 'live' | 'estimate';
          overallMargin: number;
          hedgeBenefit: number;
          spanMargin: number;
          exposureMargin: number;
        } }) => {
          if (j.success && j.data) {
            marginCompRef.current[basket.id] = compAtRequest;
            setBasketMargins(prev => ({
              ...prev,
              [basket.id]: j.data!,
            }));
          } else {
            // Not delivered — un-mark this signature so a later trigger
            // (any basket's composition change, or an explicit re-fetch
            // after placing/exiting) retries it instead of leaving this
            // basket's margin stale indefinitely.
            delete lastFetchedMarginSignatureRef.current[basket.id];
          }
        })
        .catch(() => {
          delete lastFetchedMarginSignatureRef.current[basket.id];
        });
    }
  }, [lookupCache, broker]);

  // Composition-only signature (underlying/expiry/strikes/side/lots/orderRef) —
  // live LTP ticks do not change margin requirements. Keying the margin fetch
  // on basket composition prevents rapid refiring and Dhan 429 rate limit errors.
  const basketsCompositionSignature = useMemo(() => {
    return baskets.map(b =>
      `${b.id}:${b.underlying}:${b.expiry}:${b.legs.map(l => `${l.side}-${l.option}-${l.strike}@${l.expiry || b.expiry}x${l.lots}-${l.status}-${l.orderRef?.securityId || ''}`).join('|')}`
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
          const newFarExp = expiriesMap[newUnderlying]?.[1] ?? newExp;
          const pair = `${newUnderlying}:${newExp}`;
          const strikes = chainData[pair]?.strikes?.length ? chainData[pair].strikes : [];
          const spot = chainData[pair]?.spot ?? DEFAULT_INDEX_SPOT[newUnderlying] ?? 24000;
          const step = DEFAULT_INDEX_STEP[newUnderlying] ?? 50;
          const newAtm = nearestStrike(strikes, spot) ?? (Math.round(spot / step) * step);

          let newLegs = b.legs;
          if (b.legs.every(l => l.status === 'DRAFT')) {
            const tpl = ALL_STRATEGY_TEMPLATES.find(t => t.key === b.presetKey);
            // A Calendar/Diagonal strategy (by template, or by a leg someone
            // manually toggled to FAR) needs a real second expiry for the new
            // underlying — otherwise resolveTemplateLegs/the diff-shift below
            // would silently collapse the far leg back onto the front expiry,
            // recreating the same-strike/same-expiry degenerate bug this
            // feature was built to fix. Abort the underlying switch entirely
            // (matches addStrategy's guard for the equivalent case at creation).
            const needsFarExpiry = tpl
              ? tpl.legs.some(l => l.expiryRole === 'far')
              : b.legs.some(l => l.expiry && l.expiry !== b.expiry);
            if (needsFarExpiry && newFarExp === newExp) {
              addToast(
                'error',
                'Secondary expiry required',
                `${newUnderlying} needs a second listed expiry to keep this Calendar/Diagonal strategy — underlying not changed`,
              );
              return b;
            }
            if (tpl) {
              newLegs = resolveTemplateLegs(tpl, newAtm, strikes, step, newExp, newFarExp, b.multiplier || 1);
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
                expiry: l.expiry && l.expiry !== b.expiry ? newFarExp : newExp,
              }));
            }
          }

          return {
            ...b,
            ...patch,
            underlying: newUnderlying,
            expiry: newExp,
            farExpiry: newFarExp !== newExp ? newFarExp : undefined,
            legs: newLegs,
            updatedAt: new Date().toISOString(),
          };
        }

        // Changing the basket's (front) expiry must carry its DRAFT front-expiry
        // legs along. Otherwise those legs keep the old expiry, differ from
        // basket.expiry, and the row misreads a plain short strangle as a
        // Calendar/Diagonal (FAR legs + Far Expiry selector). Legs already on
        // a different (far) expiry, and placed legs, are left untouched.
        if (patch.expiry && patch.expiry !== b.expiry) {
          const newExp = patch.expiry;
          // Moving onto a far expiry: DRAFT legs on a non-100 strike snap to the nearest allowed one.
          const listed = expiriesMap[b.underlying] ?? [];
          const pool = chainData[`${b.underlying}:${newExp}`]?.strikes?.length
            ? chainData[`${b.underlying}:${newExp}`].strikes
            : (chainData[`${b.underlying}:${b.expiry}`]?.strikes ?? []);
          const snappedLegs: string[] = [];
          const movedLegs = b.legs.map(l => {
            if (!(l.status === 'DRAFT' && (!l.expiry || l.expiry === b.expiry))) return l;
            const snapped = snapToAllowed(b.underlying, newExp, listed, l.strike, pool);
            if (snapped !== l.strike) snappedLegs.push(`${l.strike}→${snapped} ${l.option}`);
            return { ...l, expiry: newExp, strike: snapped };
          });
          if (snappedLegs.length) {
            addToast('success', 'Strikes snapped to ×100', `Far expiry only trades multiples of 100: ${snappedLegs.join(', ')}`);
          }
          return {
            ...b,
            ...patch,
            legs: movedLegs,
            farExpiry: patch.farExpiry ?? (b.farExpiry === newExp ? undefined : b.farExpiry),
            updatedAt: new Date().toISOString(),
          };
        }

        return { ...b, ...patch, updatedAt: new Date().toISOString() };
      });
      const target = next.find(b => b.id === basketId);
      if (target) persistBasket(target);
      // Mirrored synchronously (not left to the basketsRef-sync effect,
      // which only runs after this render commits and paints) so a
      // concurrent poll tick's untracked-position scan — which reads
      // basketsRef.current, not this hook's state — can't read a stale
      // basket list that's still missing an orderRef this call just placed.
      basketsRef.current = next;
      return next;
    });
  }, [expiriesMap, chainData, persistBasket, addToast]);

  // Functional legs update: `fn` always receives the LATEST legs (React's `prev`),
  // never a basketsRef snapshot. updateBasket's updater is deferred when another
  // update is already queued, so two async continuations finishing in the same
  // tick (concurrent exits / reopens) could otherwise each write from a stale
  // list and silently revert or drop the other's leg.
  const patchLegs = useCallback((basketId: string, fn: (legs: MultiLegLeg[]) => MultiLegLeg[]) => {
    setBaskets(prev => {
      const next = prev.map(b => (b.id === basketId ? { ...b, legs: fn(b.legs), updatedAt: new Date().toISOString() } : b));
      const target = next.find(b => b.id === basketId);
      if (target) persistBasket(target);
      basketsRef.current = next;
      return next;
    });
  }, [persistBasket]);

  const deleteBasket = useCallback((basketId: string) => {
    const target = basketsRef.current.find(b => b.id === basketId);
    if (target && target.legs.some(l => l.status === 'OPEN' || l.status === 'PLACING' || l.status === 'CLOSING')) {
      addToast('error', 'Cannot delete active strategy', 'Exit all open positions before deleting this row.');
      return;
    }
    setBaskets(prev => prev.filter(b => b.id !== basketId));
    setBasketMargins(prev => {
      if (!(basketId in prev)) return prev;
      const next = { ...prev };
      delete next[basketId];
      return next;
    });
    delete lastFetchedMarginSignatureRef.current[basketId];
    fetch('/api/multi-leg-focus/baskets', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: basketId }),
    }).catch(() => {});
  }, [addToast]);

  // ── Add Strategy (from template or blank) ──────────────────────────
  const [category, setCategory] = useState<StrategyCategory>('Range Bound');
  const [presetsCollapsed, setPresetsCollapsed] = useState(false);
  useEffect(() => {
    try { setPresetsCollapsed(localStorage.getItem('mlf_presets_collapsed') === '1'); } catch { /* ignore */ }
  }, []);
  const togglePresets = useCallback(() => {
    setPresetsCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem('mlf_presets_collapsed', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const addStrategy = useCallback((template?: StrategyTemplate, targetUnderlying?: Underlying) => {
    const u: Underlying = targetUnderlying ?? selectedUnderlying ?? 'NIFTY';
    const exp = expiriesMap[u]?.[0] ?? '';
    const farExp = expiriesMap[u]?.[1] ?? '';
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

    if (tpl.legs.some(l => l.expiryRole === 'far') && !farExp) {
      addToast('error', 'Secondary expiry required', `${u} needs a second listed expiry to build a Calendar/Diagonal strategy`);
      return;
    }

    const newBasket: MultiLegBasket = {
      id: `mlf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: tpl.name,
      underlying: u,
      expiry: exp,
      farExpiry: farExp && farExp !== exp ? farExp : undefined,
      broker,
      presetKey: tpl.key,
      multiplier: 1,
      legs: resolveTemplateLegs(tpl, atm, strikes, step, exp, farExp, 1),
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
  // Today is the broker positions MTM's scope: live legs in full plus legs
  // closed today. Prev 3D is the whole Dhan account's net realized P&L over
  // the 3 market days before today — the Trader's Diary's own daily series
  // (/api/portfolio-trades), so the two pages can't disagree.
  // Ticks each minute so both roll over at IST midnight on a page left open.
  const [pnlNow, setPnlNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setPnlNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const [tradeHistory, setTradeHistory] = useState<TradeHistoryResponse | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/portfolio-trades');
        const j = await res.json() as TradeHistoryResponse;
        if (alive && j.success && j.available) setTradeHistory(j);
      } catch { /* keep the last good copy */ }
    };
    void load();
    // The file only changes when a Diary/Weekly Target sync runs, so a slow refresh is enough.
    const t = setInterval(load, 10 * 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const overallTodayPnl = useMemo(() => {
    let today = 0;
    for (const b of baskets) {
      today += computeStrategyMetrics(b.legs.filter(l => legCountsToday(l, pnlNow)), l => ltpFor(b, l), pnlMultiplier(b)).totalPnlRupees;
    }
    return today;
  }, [baskets, ltpFor, pnlNow]);
  const prevDaysPnl = useMemo(() => {
    if (!tradeHistory) return null;
    const todayIst = new Date(pnlNow).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    return previousDaysPnl(tradeHistory, todayIst, 3);
  }, [tradeHistory, pnlNow]);

  const activeStrategiesCount = useMemo(() => {
    return baskets.filter(b => b.legs.some(l => l.status === 'OPEN')).length;
  }, [baskets]);

  // ── Placement & Exits per Basket ──────────────────────────────────
  const [placingMap, setPlacingMap] = useState<Record<string, boolean>>({});
  const [exitingMap, setExitingMap] = useState<Record<string, boolean>>({});
  const [exitingLegs, setExitingLegs] = useState<Set<string>>(new Set());
  const exitingLegsRef = useRef<Set<string>>(new Set());

  // One-shot-per-occurrence dedup for the "tracked qty on a contract doesn't
  // match the broker" toast — the poll runs every 3s, so without this it would
  // re-fire every tick for as long as the gap persists. Cleared once it resolves.
  const underAllocatedWarnedRef = useRef<Set<string>>(new Set());

  // Persistent (not one-shot) per-leg record of the SAME gap the toast above
  // reports once — the toast is easy to miss or dismiss, and by design
  // reconcileLegWithBroker never lets the displayed qty/lots reflect the
  // broker's true pooled total (Invariant 6 — see dhan-terminal-position-
  // ownership skill). 'under' = broker holds more than every leg on the
  // contract together (Claim/Import); 'over' = less (Reduce). Rebuilt fresh
  // every poll tick (not merged) so a resolved gap disappears immediately.
  // Signed broker netQty of each leg's matched live row, from the last poll.
  const [brokerNetByLeg, setBrokerNetByLeg] = useState<Map<string, number>>(() => new Map());
  const legQtyWarnings = useMemo<Record<string, LegQtyWarning>>(
    () => legQtyWarningsFor(baskets, brokerNetByLeg),
    [baskets, brokerNetByLeg],
  );

  // ── Far-expiry strike rule + bid/ask spread guards ───────────────────
  // Far expiries (3rd listed onward) only trade liquidly on multiples of 100, and a
  // wide or one-sided book means a market order fills badly. Both are checked BEFORE
  // any order leaves; see lib/farExpiryRules.ts for the rules and thresholds.
  /** Legs whose strike is not tradable on their own expiry (far expiry, non-100 strike). */
  const blockedStrikeLegs = useCallback(<T extends { strike: number; expiry?: string }>(basket: MultiLegBasket, legs: T[]): T[] => {
    const listed = expiriesMap[basket.underlying] ?? [];
    // Order paths fail CLOSED: with the expiry list not loaded yet we cannot tell near from
    // far, so require a multiple of 100 rather than let a far 50-strike through.
    if (!listed.length && strikeRuleApplies(basket.underlying)) return legs.filter(l => l.strike % 100 !== 0);
    return legs.filter(l => !strikeAllowed(basket.underlying, l.expiry || basket.expiry, listed, l.strike));
  }, [expiriesMap]);

  const toastBlockedStrikes = useCallback((blocked: { strike: number; option: OptionType; expiry?: string }[], basket: MultiLegBasket) => {
    const listLoaded = (expiriesMap[basket.underlying] ?? []).length > 0;
    addToast('error', listLoaded ? 'Strike not allowed on a far expiry' : 'Expiry list not loaded — only ×100 strikes allowed',
      `${blocked.map(l => `${l.strike} ${l.option} (${l.expiry || basket.expiry})`).join(', ')} — ${listLoaded ? 'far expiries only trade strikes in multiples of 100' : 'until the expiry list loads, only strikes in multiples of 100 can be placed'}. Nothing was placed.`);
  }, [addToast, expiriesMap]);

  type SpreadIssues = { noMarket: string[]; wide: string[]; unavailable: boolean };
  /** One depth call for every leg about to be opened. Never throws; a failed or
   *  partial lookup is `unavailable` / skipped (unknown never blocks trading). */
  const fetchSpreadIssues = useCallback(async (
    basket: MultiLegBasket,
    legs: { option: OptionType; strike: number; expiry?: string; type: 'MARKET' | 'LIMIT' }[],
  ): Promise<SpreadIssues> => {
    const out: SpreadIssues = { noMarket: [], wide: [], unavailable: false };
    if (!legs.length) return out;
    try {
      const res = await fetch('/api/multi-leg-focus/depth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Bounded: an order must never wait long on a market-data nicety; a timeout is
        // treated as 'unavailable' (proceed with a toast), like any other failure.
        signal: AbortSignal.timeout(2500),
        body: JSON.stringify({
          underlying: basket.underlying,
          legs: legs.map(l => {
            const exp = l.expiry || basket.expiry;
            // Depth is Dhan market data whatever broker trades the leg; ids only when Dhan's lookup is loaded.
            const ident = lookupCache[lkKey('dhan', basket.underlying, exp)]?.strikes?.[String(l.strike)];
            return { strike: l.strike, option: l.option, expiry: exp, securityId: l.option === 'CE' ? ident?.ceId : ident?.peId };
          }),
        }),
      });
      const j = await res.json() as { success: boolean; data?: Record<string, { bid: number; ask: number }> };
      if (!j.success || !j.data) { out.unavailable = true; return out; }
      for (const l of legs) {
        const exp = l.expiry || basket.expiry;
        const a = assessSpread(j.data[`${exp}:${l.strike}:${l.option}`]);
        const tag = `${l.strike} ${l.option}`;
        if (a.status === 'no_market') out.noMarket.push(`${tag} (bid ${a.bid || '—'} / ask ${a.ask || '—'})`);
        // A user-set LIMIT price is its own protection; only MARKET legs warn on width.
        else if (a.status === 'wide' && l.type === 'MARKET') out.wide.push(`${tag}: ${a.bid} / ${a.ask} (spread ₹${a.spread.toFixed(2)}, ${a.pct.toFixed(1)}%)`);
      }
    } catch { out.unavailable = true; }
    return out;
  }, [lookupCache]);

  /** Turns spread findings into UI: blocks on no bid/ask, confirms on wide. true = proceed. */
  const resolveSpreadIssues = useCallback((issues: SpreadIssues): boolean => {
    if (issues.noMarket.length) {
      addToast('error', 'No bid/ask — order blocked', `${issues.noMarket.join(', ')} — the book is empty on one side. Nothing was placed.`);
      return false;
    }
    if (issues.unavailable) addToast('error', 'Spread check unavailable', 'Could not read bid/ask — continuing without the spread check.');
    if (issues.wide.length && !window.confirm(`Wide bid/ask spread — a market order may fill poorly:\n\n${issues.wide.join('\n')}\n\nContinue?`)) return false;
    return true;
  }, [addToast]);

  // Dhan ACKs an order as TRANSIT and can reject it (RMS/margin/freeze) seconds
  // later. Where a later step depends on a leg really being open — the SELLs
  // after the hedges, or auto-reversing legs on an abort — the ACK is not
  // enough: wait for the order's actual outcome. 'pending' after the deadline
  // means unknown (treat as NOT confirmed; the poll's pendingOrders settles it).
  const confirmDhanOrder = useCallback(async (orderId: string, orderType: 'MARKET' | 'LIMIT', timeoutMs = 6000): Promise<{
    phase: DhanOrderPhase; filledQty: number; avgPrice: number; reason: string;
  }> => {
    const deadline = Date.now() + timeoutMs;
    let last = { phase: 'pending' as DhanOrderPhase, filledQty: 0, avgPrice: 0, reason: '' };
    for (;;) {
      try {
        const res = await fetch(`/api/scalper/orders?orderId=${encodeURIComponent(orderId)}`);
        const j = await res.json() as { success: boolean; data?: { orderStatus: string; filledQty: number; averageTradedPrice: number; reason: string } };
        if (j.success && j.data) {
          last = {
            phase: classifyDhanOrder(j.data.orderStatus, orderType),
            filledQty: j.data.filledQty, avgPrice: j.data.averageTradedPrice, reason: j.data.reason,
          };
          if (last.phase !== 'pending') return last;
        }
      } catch { /* retry until the deadline */ }
      if (Date.now() + 400 > deadline) return last;
      await new Promise(r => setTimeout(r, 400));
    }
  }, []);

  const placeBasketInner = useCallback(async (basketId: string) => {
    const basket = basketsRef.current.find(b => b.id === basketId);
    if (!basket || !basket.legs.length || !basket.expiry) return;

    if (!hasAuthenticatedBroker) {
      addToast('error', 'No broker logged in', 'Log in before placing orders');
      return;
    }
    // The strategy's own account (its row badge) — never the toolbar selection.
    const bk = executionBroker(basket, broker) as Broker;

    const blockedLegs = blockedStrikeLegs(basket, basket.legs);
    if (blockedLegs.length) { toastBlockedStrikes(blockedLegs, basket); return; }
    // Started now so it overlaps the margin/funds checks below (no added round trip
    // on the happy path); its verdict is applied only once margin has passed.
    const spreadPromise = fetchSpreadIssues(basket, basket.legs);

    // Pre-trade margin gate — block placement outright rather than letting a
    // leg-by-leg sequence run into a mid-strategy margin rejection with no
    // warning (that's exactly how a naked leg gets left open: one leg fills,
    // the next is rejected for margin, and the strategy just stops there).
    // Only blocks when margin has actually been computed for this exact
    // composition (fetchMarginsForBaskets runs reactively as legs are
    // edited); if it hasn't resolved yet, placement proceeds and the
    // broker's own reject is the backstop — same as MultiLegStrategyRow's
    // button-level check, kept here too since the button state can be stale.
    // Fail CLOSED: with legs fired concurrently there is no chance to react
    // between legs, so an unverified margin check is a block.
    const marginEntry = basketMargins[basketId];
    const requiredMargin = marginEntry?.basketMargin;
    if (requiredMargin == null || marginCompRef.current[basketId] !== `${bk}|${basketCompKey(basket)}`) {
      addToast('error', 'Margin not verified — placement blocked', 'Required margin is not calculated for the current legs yet. Wait a moment and retry.');
      return;
    }
    if (marginEntry.basketMarginSource === 'estimate'
        && !window.confirm('Required margin is only an ESTIMATE (broker calculator unavailable). Place anyway?')) return;

    // Funds: reuse the poll reading when fresh (<5s) so the common case adds no
    // round trip; otherwise read live.
    const readFunds = async (): Promise<number | null> => {
      try {
        const fr = await fetch(scalperRoute(bk, 'funds'));
        const fj = await fr.json() as { success: boolean; data?: Record<string, unknown> };
        if (!fj.success || !fj.data) return null;
        const available = Number(fj.data.availabelBalance ?? fj.data.availableBalance ?? 0);
        if (brokerNowRef.current === bk) {
          setFundsData({ available, used: Number(fj.data.utilizedAmount ?? fj.data.usedMargin ?? fj.data.marginUsed ?? 0) });
          fundsAtRef.current = Date.now();
        }
        return available;
      } catch { return null; }
    };
    const availableFunds = (bk === broker && fundsData && Date.now() - fundsAtRef.current < 5000) ? fundsData.available : await readFunds();
    if (availableFunds == null) {
      addToast('error', 'Funds unavailable — placement blocked', 'Could not read available margin from the broker. Retry once funds load.');
      return;
    }
    if (requiredMargin > availableFunds) {
      addToast(
        'error',
        'Insufficient margin — placement blocked',
        `This strategy needs ~${fmtMoney(requiredMargin)} but only ${fmtMoney(availableFunds)} is available. Add funds or reduce lots before placing.`,
      );
      return;
    }
    if (!resolveSpreadIssues(await spreadPromise)) return;

    const lookup = lookupCache[lkKey(bk, basket.underlying, basket.expiry)];
    const lotSize = lookup?.lotSize ?? fallbackLotSize(basket.underlying as Underlying, bk);
    // A Calendar/Diagonal far leg trades a different contract than the
    // basket's front-month expiry — it must resolve its own security id
    // against ITS OWN expiry's strike map, never the front one.
    const strikeMapFor = (legExpiry: string) => lookupCache[lkKey(bk, basket.underlying, legExpiry)]?.strikes ?? {};

    // Another basket already holding one of these contracts means both share a
    // single netted broker row — warn before placing, let the user override.
    const collisions = findSiblingLegCollisions(
      basketsRef.current, basketId,
      basket.legs.map(l => ({ side: l.side, option: l.option, strike: l.strike, expiry: l.expiry || basket.expiry })),
    );
    if (collisions.length && !window.confirm(describeSiblingCollisions(collisions))) return;

    setPlacingMap(prev => ({ ...prev, [basketId]: true }));

    const ordered = sortLegsForPlacement(basket.legs);
    let working: MultiLegLeg[] = basket.legs.map(l => ({ ...l, status: 'PLACING' as MultiLegStatus }));
    updateBasket(basketId, { broker: bk, legs: working });

    type PlacedLeg = {
      legId: string;
      label: string;
      side: 'B' | 'S';
      option: OptionType;
      strike: number;
      qty: number;
      type: 'MARKET' | 'LIMIT';
      expiry: string;
      securityId?: string;
      symbol?: string;
    };
    const placedLegs: PlacedLeg[] = [];

    // Flattens whatever already filled in this call by firing opposite-side
    // MARKET orders for each — best-effort, since a rejected or
    // network-unconfirmed reversal can't otherwise be undone from here.
    // Mirrors Baskets.tsx's rollbackPlacedLegs; MultiLegFocus never had one.
    //
    // A MARKET leg is safe to assume filled the instant its order response
    // reports success (that's what MARKET means), so it's safe to reverse
    // automatically. A LIMIT leg is NOT — "accepted" only means the broker is
    // holding a resting order that may not have filled yet. Firing an
    // opposite-side MARKET order against a LIMIT leg that never filled would
    // itself create a fresh naked position (in the opposite direction) while
    // the original resting order stays live and could still fill later —
    // exactly the failure this rollback exists to prevent. So LIMIT legs are
    // surfaced for the user to check/cancel manually instead of auto-reversed.
    const rollbackPlacedLegs = async () => {
      if (!placedLegs.length) return;
      const marketLegs = placedLegs.filter(p => p.type === 'MARKET');
      const limitLegs = placedLegs.filter(p => p.type === 'LIMIT');
      if (marketLegs.length) {
        addToast(
          'error',
          `Auto-flattening ${marketLegs.length} placed leg(s)`,
          'A later leg in this strategy was rejected — reversing what already filled so nothing is left naked. Verify in Orders/Positions after.',
        );
      }
      if (limitLegs.length) {
        addToast(
          'error',
          `${limitLegs.length} placed LIMIT leg(s) NOT auto-reversed`,
          `${limitLegs.map(p => p.label).join(', ')} — a resting limit order may not have filled yet; check Orders and cancel/close manually.`,
        );
      }
      for (const p of [...marketLegs].reverse()) {
        const reverseReq = resolveOrderRequest(bk, {
          side: p.side === 'B' ? 'S' : 'B', option: p.option, strike: p.strike, qty: p.qty, type: 'MARKET',
          underlying: basket.underlying as Underlying, productType: 'MARGIN',
          securityId: p.securityId, tradingsymbol: p.symbol,
        }, strikeMapFor(p.expiry));
        if (!reverseReq) {
          addToast('error', `Could not auto-reverse ${p.label}`, 'No order identifier — close manually from Orders/Positions');
          continue;
        }
        try {
          const res = await fetch(reverseReq.url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reverseReq.body),
          });
          const j = await res.json() as { success: boolean; order_id?: string; price?: number; error?: string };
          if (j.success) {
            addToast('success', `Reversed ${p.label}`, `ID: ${j.order_id}`);
            const reversedLeg = basketsRef.current.find(b => b.id === basketId)?.legs.find(l => l.id === p.legId);
            const currentLtp = reversedLeg ? ltpFor(basket, reversedLeg) : 0;
            const exitPrice = (j.price && j.price > 0) ? j.price : (currentLtp > 0 ? currentLtp : (reversedLeg?.fill?.avgPrice ?? 0));
            patchLegs(basketId, legs => legs.map(l =>
              (l.id === p.legId
                ? withPendingOrder({ ...l, status: 'CLOSED' as MultiLegStatus, closedAt: Date.now(), fill: { qty: 0, avgPrice: l.fill?.avgPrice ?? 0 }, closedFill: { qty: p.qty, exitPrice } }, j.order_id, 'exit', p.qty, exitPrice)
                : l)));
          } else {
            addToast('error', `Reverse failed for ${p.label}`, `${j.error ?? 'Unknown error'} — close manually from Orders/Positions`);
          }
        } catch (e) {
          addToast('error', `Reverse UNCONFIRMED for ${p.label}`, `Close manually from Orders/Positions: ${String(e)}`);
        }
      }
    };

    // Place one leg; resolves false on any failure (already toasted + marked FAILED).
    const placeOneLegRaw = async (leg: MultiLegLeg): Promise<boolean> => {
      const label = `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}`;
      const qty = leg.lots * lotSize;
      const req = resolveOrderRequest(bk, {
        side: leg.side,
        option: leg.option,
        strike: leg.strike,
        qty,
        type: leg.type,
        price: leg.type === 'LIMIT' ? leg.price : undefined,
        underlying: basket.underlying as Underlying,
        productType: 'MARGIN',
      }, strikeMapFor(leg.expiry || basket.expiry));

      if (!req) {
        addToast('error', `${label} — no order identifier resolved`, 'Strike lookup not ready yet — strategy stopped');
        working = working.map(l => (l.id === leg.id ? { ...l, status: 'FAILED' as MultiLegStatus } : l));
        updateBasket(basketId, { legs: working });
        return false;
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
          let fillPrice = (j.price && j.price > 0) ? j.price : (currentLtp > 0 ? currentLtp : (leg.price ?? 0));
          const secId = j.securityId ?? (req.body.securityId as string | undefined);
          const sym = j.symbol ?? (req.body.tradingsymbol as string | undefined);

          // Dhan: an ACK is not a fill. Confirm before this leg counts as placed —
          // it gates the SELL phase and decides what an abort auto-reverses.
          let confirmedQty = qty;
          let unconfirmed = false;
          if (bk === 'dhan' && j.order_id) {
            const c = await confirmDhanOrder(String(j.order_id), leg.type);
            if (c.phase === 'dead') {
              working = working.map(l => (l.id === leg.id ? { ...l, status: 'FAILED' as MultiLegStatus } : l));
              updateBasket(basketId, { legs: working });
              addToast('error', `Rejected ${label} after acceptance — strategy stopped`, c.reason || 'Order rejected/cancelled by the broker');
              return false;
            }
            if (c.phase === 'filled') {
              if (c.avgPrice > 0) fillPrice = c.avgPrice;
              if (c.filledQty > 0) confirmedQty = c.filledQty;
            }
            unconfirmed = c.phase === 'pending';
          }

          working = working.map(l => {
            if (l.id !== leg.id) return l;
            return {
              ...l,
              status: 'OPEN' as MultiLegStatus,
              fill: { qty: confirmedQty, avgPrice: fillPrice, orderId: j.order_id },
              filledAt: Date.now(),
              orderRef: { securityId: secId, symbol: sym },
              pendingOrders: j.order_id ? [{ id: String(j.order_id), kind: 'grow' as const, qty: confirmedQty, at: Date.now(), price: fillPrice }] : undefined,
            };
          });
          updateBasket(basketId, { legs: working });
          if (unconfirmed) {
            // Tracked (the poll settles it) but NOT counted as placed: no later phase
            // runs on it, and an abort never auto-reverses an order that may not exist.
            addToast('error', `${label}: fill not confirmed — strategy stopped`, `Order ${j.order_id} still not TRADED. It is tracked on this row; check Orders before acting — it will NOT be auto-reversed.`);
            return false;
          }
          addToast('success', `Placed ${label}`, `ID: ${j.order_id ?? 'OK'}`);
          placedLegs.push({
            legId: leg.id, label, side: leg.side, option: leg.option, strike: leg.strike, qty: confirmedQty, type: leg.type,
            expiry: leg.expiry || basket.expiry,
            securityId: secId, symbol: sym,
          });
          return true;
        }
        working = working.map(l => (l.id === leg.id ? { ...l, status: 'FAILED' as MultiLegStatus } : l));
        updateBasket(basketId, { legs: working });
        addToast('error', `Rejected ${label} — strategy stopped`, j.error ?? 'Unknown broker error');
        return false;
      } catch (e) {
        working = working.map(l => (l.id === leg.id ? { ...l, status: 'FAILED' as MultiLegStatus } : l));
        updateBasket(basketId, { legs: working });
        addToast('error', `Order failed for ${label} — strategy stopped`, String(e));
        return false;
      }
    };

    // Never throws: a synchronous failure before the fetch (identifier resolution,
    // LTP lookup) must not reject Promise.all while sibling orders are in flight,
    // or the rollback below would be skipped.
    const placeOneLeg = async (leg: MultiLegLeg): Promise<boolean> => {
      try {
        return await placeOneLegRaw(leg);
      } catch (e) {
        working = working.map(l => (l.id === leg.id ? { ...l, status: 'FAILED' as MultiLegStatus } : l));
        updateBasket(basketId, { legs: working });
        addToast('error', `Order failed for ${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option} — strategy stopped`, String(e));
        return false;
      }
    };

    // Legs never attempted (the run aborted before their phase) go back to DRAFT
    // instead of hanging in PLACING. Must run BEFORE rollbackPlacedLegs, which
    // writes CLOSED statuses via basketsRef.
    const releaseUnattempted = () => {
      // Off `working` (this run's synchronous truth), not basketsRef, which may
      // not have applied the latest FAILED/OPEN writes yet.
      working = working.map(l => (l.status === 'PLACING' ? { ...l, status: 'DRAFT' as MultiLegStatus } : l));
      updateBasket(basketId, { legs: working });
    };

    try {
      // Two phases, legs within a phase fired concurrently: all BUY (hedge)
      // legs must be acknowledged before any SELL leg goes out, so a rejected
      // hedge can never leave a naked short. A failure inside a phase stops
      // the next phase and rolls back whatever already went through.
      for (const phase of [ordered.filter(l => l.side === 'B'), ordered.filter(l => l.side === 'S')]) {
        if (!phase.length) continue;
        if (phase[0].side === 'S' && placedLegs.length) {
          // Hedges are in. Premium paid may have eaten into the margin the sells
          // need — re-read funds, but only when the buffer isn't obviously ample
          // (keeps the common case free of an extra round trip).
          const premiumPaid = placedLegs.reduce((sum, p) => {
            const l = basket.legs.find(x => x.id === p.legId);
            return sum + (l ? p.qty * (ltpFor(basket, l) || l.price || 0) : 0);
          }, 0);
          if (availableFunds - premiumPaid < requiredMargin * 1.2) {
            const nowAvail = await readFunds();
            if (nowAvail == null || nowAvail < requiredMargin) {
              addToast('error', 'Margin short after hedges — sells NOT placed',
                nowAvail == null ? 'Could not re-verify funds; unwinding hedges.' : `Available ${fmtMoney(nowAvail)} < required ${fmtMoney(requiredMargin)}; unwinding hedges.`);
              releaseUnattempted();
              await rollbackPlacedLegs();
              return;
            }
          }
        }
        const results = await Promise.all(phase.map(placeOneLeg));
        if (results.some(ok => !ok)) {
          releaseUnattempted();
          await rollbackPlacedLegs();
          return;
        }
      }
    } finally {
      setPlacingMap(prev => ({ ...prev, [basketId]: false }));
      pollFunds();
      fetchMarginsForBaskets();
    }
  }, [broker, hasAuthenticatedBroker, lookupCache, updateBasket, patchLegs, ltpFor, addToast, confirmDhanOrder, pollFunds, fetchMarginsForBaskets, basketMargins, fundsData, blockedStrikeLegs, toastBlockedStrikes, fetchSpreadIssues, resolveSpreadIssues]);

  // The lock is taken synchronously, before any await inside placeBasketInner
  // (funds read, confirm dialogs), so a fast double-click cannot slip a second
  // placement through the gap. Released on every exit path.
  const placeBasket = useCallback(async (basketId: string) => {
    if (placementLockRef.current) {
      addToast('error', 'Another placement is in progress', 'Wait for it to finish before placing another strategy.');
      return;
    }
    placementLockRef.current = true;
    try {
      await placeBasketInner(basketId);
    } finally {
      placementLockRef.current = false;
      fundsAtRef.current = 0;   // force a live funds read for the next placement
    }
  }, [placeBasketInner, addToast]);

  const exitOneLeg = useCallback(async (basketId: string, leg: MultiLegLeg): Promise<{ closed: boolean; qty: number; maxAfter?: number }> => {
    let closed = false;   // true once this leg is confirmed flat/exited
    let closedQty = 0;    // units this call actually sent to close (0 when already flat)
    let maxAfter: number | undefined;   // broker |netQty| once the exit fills (set when an order was sent)
    if (exitingLegsRef.current.has(leg.id)) return { closed, qty: closedQty };
    exitingLegsRef.current.add(leg.id);
    setExitingLegs(prev => new Set(prev).add(leg.id));

    const label = `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}`;
    const basket = basketsRef.current.find(b => b.id === basketId);
    // The strategy's own account — never the toolbar selection (see executionBroker).
    const bk = (basket ? executionBroker(basket, broker) : broker) as Broker;
    if (legBrokerMismatch(leg, bk)) {
      addToast('error', `Cannot exit ${label} here`, `This leg was placed on a different broker than this strategy's ${BROKER_LABELS[bk] ?? bk} badge — exit it from that broker's Orders/Positions.`);
      exitingLegsRef.current.delete(leg.id);
      setExitingLegs(prev => { const next = new Set(prev); next.delete(leg.id); return next; });
      return { closed, qty: closedQty };
    }

    // Hedge Protection Guard: Warn if manually exiting a BUY leg while short legs remain open
    if (leg.side === 'B') {
      const openShorts = (basket?.legs ?? []).filter(l => l.status === 'OPEN' && l.side === 'S' && l.id !== leg.id);
      if (openShorts.length > 0) {
        const matchingShorts = openShorts.filter(l => l.option === leg.option);
        const warning = matchingShorts.length > 0
          ? `Warning: Exiting this ${leg.strike} ${leg.option} BUY hedge will leave your short ${matchingShorts.map(s => `${s.strike} ${s.option}`).join(', ')} leg completely NAKED without protection, and will increase margin requirements.\n\nExit this hedge anyway?`
          : `Warning: This strategy still has open short legs (${openShorts.map(s => `${s.strike} ${s.option}`).join(', ')}). Exiting this BUY leg will increase margin requirements.\n\nExit anyway?`;
        if (!window.confirm(warning)) {
          exitingLegsRef.current.delete(leg.id);
          setExitingLegs(prev => {
            const next = new Set(prev);
            next.delete(leg.id);
            return next;
          });
          return { closed: false, qty: 0 };
        }
      }
    }

    try {
      const res = await fetch(scalperRoute(bk, 'positions'));
      const j = await res.json() as { success: boolean; data?: Record<string, unknown>[] };
      const rows = j.success && Array.isArray(j.data) ? j.data : [];
      const fallbackSecId = (bk === 'dhan' && basket && !leg.orderRef?.securityId)
        ? resolveDhanSecurityId(basket, leg)
        : undefined;
      const match = findLegPosition(bk, leg, rows, fallbackSecId);
      const securityId = leg.orderRef?.securityId ?? fallbackSecId;

      // Persist a resolved fallback securityId onto the leg — but only once
      // findLegPosition has actually CONFIRMED it against a live broker row
      // (match or flat), not merely resolved it from the strike/expiry chain
      // cache. That cache can be stale (chain shifted, wrong pair briefly
      // resolved); binding the leg to an unconfirmed id would mask a real
      // lookup failure as if it had been validated.
      if (fallbackSecId && !leg.orderRef?.securityId && (match.kind === 'match' || match.kind === 'flat')) {
        patchLegs(basketId, legs => legs.map(l =>
          (l.id === leg.id ? { ...l, orderRef: { ...l.orderRef, securityId: fallbackSecId } } : l)));
      }

      // Just placed/added: the position book can lag the fill by seconds, so
      // "flat"/"not found" here is not evidence the leg is closed. Don't mark
      // it CLOSED (that would untrack a live position) — ask for a retry.
      // Only the short post-fill window (not a still-pending grow order, which can
      // hold for minutes if the order book is unreachable) — a manual exit must
      // never be blocked for long.
      const latestLeg = basketsRef.current.find(b => b.id === basketId)?.legs.find(l => l.id === leg.id) ?? leg;
      const freshFill = latestLeg.filledAt != null && Date.now() - latestLeg.filledAt < LEG_FILL_GRACE_MS;
      if (match.kind !== 'match' && freshFill) {
        addToast('error', `Cannot exit ${label} yet`, 'The broker has not shown this just-placed position yet — retry in a few seconds.');
        return { closed, qty: closedQty };
      }

      if (match.kind === 'flat') {
        const closedFill = closedFillFromRow(match.row, leg.side === 'B', latestLeg.fill?.qty) ?? latestLeg.closedFill;
        patchLegs(basketId, legs => legs.map(l => (l.id === leg.id ? { ...l, status: 'CLOSED' as const, closedAt: Date.now(), fill: { qty: 0, avgPrice: l.fill?.avgPrice ?? 0 }, closedFill } : l)));
        addToast('success', `${label} already flat at broker`, 'Updated status to CLOSED');
        closed = true;
        return { closed, qty: closedQty };
      }

      if (match.kind !== 'match') {
        addToast('error', `Cannot exit ${label}`, 'Could not match broker position');
        return { closed, qty: closedQty };
      }

      const netQty = Number(match.row.netQty ?? 0);
      const expectedSign = leg.side === 'B' ? 1 : -1;
      if (Math.sign(netQty) !== expectedSign) {
        addToast(
          'error',
          `Cannot exit ${label}`,
          `Broker position sign mismatch (netQty ${netQty}) for a ${leg.side === 'B' ? 'BUY' : 'SELL'} leg — check Orders/Positions`,
        );
        return { closed, qty: closedQty };
      }

      // Safe sizing: clamped to what this leg opened, clamped by what broker shows
      const brokerAbs = Math.abs(netQty);
      const ownQty = leg.fill?.qty && leg.fill.qty > 0 ? leg.fill.qty : brokerAbs;
      const qty = Math.min(ownQty, brokerAbs);
      // Mid-lag after an add: the broker shows only part of what was just
      // placed. Exiting now would close that part and mark the whole leg
      // CLOSED, untracking the rest when it lands — wait for the book instead.
      if (brokerAbs < ownQty && freshFill) {
        addToast('error', `Cannot exit ${label} yet`, `Broker shows ${brokerAbs} of this leg's ${ownQty} — a just-placed order is still settling. Retry in a few seconds.`);
        return { closed, qty: closedQty };
      }
      if (qty <= 0) {
        addToast('error', `Cannot exit ${label}`, 'Resolved exit quantity is zero');
        return { closed, qty: closedQty };
      }

      const side = leg.side === 'B' ? 'SELL' : 'BUY';
      const product = positionProduct(match.row);
      const productPayload = closeOrderProduct(bk, product);

      if (!productPayload) {
        addToast('error', `Cannot exit ${label}`, `Unsupported product "${product}"`);
        return { closed, qty: closedQty };
      }

      const isSensex = basket?.underlying === 'SENSEX';
      const isCrude = basket?.underlying === 'CRUDEOIL' || basket?.underlying === 'CRUDEOILM';
      const defaultSegDhan = isSensex ? 'BSE_FNO' : (isCrude ? 'MCX_COMM' : 'NSE_FNO');
      const defaultExchOther = bk === 'kotak'
        ? (isSensex ? 'bse_fo' : (isCrude ? 'mcx_fo' : 'nse_fo'))
        : (isSensex ? 'BFO' : (isCrude ? 'MCX' : 'NFO'));

      const orderUrl = bk === 'dhan' ? '/api/scalper/fast-order' : scalperRoute(bk, 'order');
      const body = bk === 'dhan'
        ? { securityId, quantity: qty, side, orderType: 'MARKET', exchangeSegment: match.row.exchangeSegment ?? defaultSegDhan, ...productPayload.fields }
        : {
            tradingsymbol: leg.orderRef?.symbol
              ?? (match.row.tradingSymbol as string | undefined)
              ?? (match.row.tradingsymbol as string | undefined)
              ?? (match.row.symbol as string | undefined),
            quantity: qty,
            side,
            orderType: 'MARKET',
            exchange: match.row.exchange ?? defaultExchOther,
            ...productPayload.fields,
          };

      const res2 = await fetch(orderUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j2 = await res2.json() as { success: boolean; order_id?: string; price?: number; error?: string };

      if (j2.success) {
        addToast('success', `Exited ${label}`, `ID: ${j2.order_id}`);
        const currentLtp = basket ? ltpFor(basket, leg) : 0;
        const exitPrice = (j2.price && j2.price > 0) ? j2.price : (currentLtp > 0 ? currentLtp : (leg.fill?.avgPrice ?? 0));
        patchLegs(basketId, legs => legs.map(l => (l.id === leg.id
          ? withPendingOrder({ ...l, status: 'CLOSED' as const, closedAt: Date.now(), fill: { qty: 0, avgPrice: l.fill?.avgPrice ?? 0 }, closedFill: { qty, exitPrice } }, j2.order_id, 'exit', qty, exitPrice)
          : l)));
        closed = true;
        closedQty = qty;
        maxAfter = brokerAbs - qty;
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
    return { closed, qty: closedQty, maxAfter };
  }, [broker, patchLegs, addToast, pollFunds, fetchMarginsForBaskets, resolveDhanSecurityId]);

  const exitingBasketsRef = useRef<Set<string>>(new Set());

  const exitBasket = useCallback(async (basketId: string) => {
    if (exitingBasketsRef.current.has(basketId)) return;
    exitingBasketsRef.current.add(basketId);
    setExitingMap(prev => ({ ...prev, [basketId]: true }));

    try {
      const basket = basketsRef.current.find(b => b.id === basketId);
      if (!basket) return;
      const openLegs = sortLegsForExit(basket.legs.filter(l => l.status === 'OPEN' || l.status === 'CLOSING'));
      // Legs exit concurrently within a side group; shorts (BUY-to-close) are
      // fully done before longs so margin is never released out of order.
      const shorts = openLegs.filter(l => l.side === 'S');
      const longs = openLegs.filter(l => l.side === 'B');
      const shortResults = shorts.length
        ? await Promise.all(shorts.map(leg => exitOneLeg(basketId, leg).catch(() => ({ closed: false, qty: 0, maxAfter: undefined as number | undefined }))))
        : [];
      if (longs.length) {
        // Never sell the hedges while a short is still open — that would leave
        // it naked (and release the margin that supports it).
        if (shortResults.some(r => !r.closed)) {
          addToast('error', 'Long legs NOT exited', 'A short leg did not close — keeping the hedges in place. Resolve the short, then exit again.');
          return;
        }
        // An exit ACK is not a fill (it can still be rejected by RMS). Confirm the
        // shorts actually came down at the broker before selling the hedges.
        const toVerify = shorts.map((l, i) => ({ l, maxAfter: shortResults[i].maxAfter })).filter(v => v.maxAfter != null);
        if (toVerify.length) {
          const bk = executionBroker(basket, brokerNowRef.current) as Broker;
          let verified = false;
          for (let attempt = 0; attempt < 4 && !verified; attempt++) {
            if (attempt > 0) await new Promise(r => setTimeout(r, 700));
            try {
              const res = await fetch(scalperRoute(bk, 'positions'));
              const j = await res.json() as { success: boolean; data?: Record<string, unknown>[] };
              if (!j.success || !Array.isArray(j.data)) continue;
              verified = toVerify.every(({ l, maxAfter }) => {
                const fb = bk === 'dhan' && !l.orderRef?.securityId ? resolveDhanSecurityId(basket, l) : undefined;
                const m = findLegPosition(bk, l, j.data!, fb);
                return m.kind === 'flat' || (m.kind === 'match' && Math.abs(Number(m.row.netQty ?? 0)) <= maxAfter!);
              });
            } catch { /* retry */ }
          }
          if (!verified && !window.confirm('Could not confirm the short legs are closed at the broker yet (an exit can still be rejected). Exit the hedge (BUY) legs anyway?')) {
            addToast('error', 'Hedges kept', 'Short exits not confirmed yet — exit the long legs once Orders/Positions show the shorts closed.');
            return;
          }
        }
        await Promise.allSettled(longs.map(leg => exitOneLeg(basketId, leg)));
      }
    } finally {
      exitingBasketsRef.current.delete(basketId);
      setExitingMap(prev => ({ ...prev, [basketId]: false }));
    }
  }, [exitOneLeg, addToast, resolveDhanSecurityId]);

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

    const legExpiry = leg.expiry || basket.expiry;
    // The strategy's own account — never the toolbar selection (see executionBroker).
    const bk = executionBroker(basket, broker) as Broker;
    const lookup = lookupCache[lkKey(bk, basket.underlying, legExpiry)];
    const lotSize = lookup?.lotSize ?? fallbackLotSize(basket.underlying as Underlying, bk);
    const strikeMap = lookup?.strikes ?? {};

    const qty = params.lots * lotSize;
    const label = `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}`;
    if (legBrokerMismatch(leg, bk)) {
      addToast('error', `Cannot add to ${label}`, `This leg was placed on a different broker than this strategy's ${BROKER_LABELS[bk] ?? bk} badge.`);
      return;
    }

    const collisions = findSiblingLegCollisions(
      basketsRef.current, basketId, [{ side: leg.side, option: leg.option, strike: leg.strike, expiry: legExpiry }]);
    if (collisions.length && !window.confirm(describeSiblingCollisions(collisions))) return;

    const req = resolveOrderRequest(bk, {
      side: leg.side,
      option: leg.option,
      strike: leg.strike,
      qty,
      type: params.orderType,
      price: params.orderType === 'LIMIT' ? params.limitPrice : undefined,
      underlying: basket.underlying as Underlying,
      productType: 'MARGIN',
      securityId: leg.orderRef?.securityId,
      tradingsymbol: leg.orderRef?.symbol,
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

        // Grown from the LATEST leg (functional update), not the pre-await
        // snapshot — a poll tick may have reconciled it while the order was out.
        const grow = (l: MultiLegLeg): MultiLegLeg => {
          const oldQty = (l.fill?.qty && l.fill.qty > 0) ? l.fill.qty : (l.lots * lotSize);
          const oldAvg = (l.fill?.avgPrice && l.fill.avgPrice > 0) ? l.fill.avgPrice : (l.price || currentLtp);
          const totalQty = oldQty + qty;
          const avg = ((oldAvg * oldQty) + (fillPrice * qty)) / totalQty;
          return withPendingOrder({
            ...l,
            lots: Math.max(1, Math.round(totalQty / lotSize)),
            price: avg,
            ...(params.newSl !== undefined ? { sl: params.newSl } : {}),
            ...(params.newTp !== undefined ? { tp: params.newTp } : {}),
            filledAt: Date.now(),
            fill: { qty: totalQty, avgPrice: avg, orderId: j.order_id ?? l.fill?.orderId },
          }, j.order_id, 'grow', qty, fillPrice);
        };
        const latest = basketsRef.current.find(b => b.id === basket.id)?.legs.find(l => l.id === leg.id) ?? leg;
        const preview = grow(latest);
        const newAvgPrice = preview.price ?? fillPrice;
        const newLots = preview.lots;
        patchLegs(basket.id, legs => legs.map(l => (l.id === leg.id ? grow(l) : l)));
        addToast('success', `Added ${params.lots} lot(s) to ${label}`, `New Avg: ₹${newAvgPrice.toFixed(2)} (${newLots} lots total)`);
        pollFunds();
        fetchMarginsForBaskets();
      } else {
        addToast('error', `Add lots failed for ${label}`, j.error ?? 'Unknown broker error');
      }
    } catch (e) {
      addToast('error', `Add lots failed for ${label}`, String(e));
    }
  }, [broker, hasAuthenticatedBroker, lookupCache, ltpFor, patchLegs, addToast, pollFunds, fetchMarginsForBaskets]);

  // ── Claim an under-tracked broker qty for this leg ─────────────────
  // Reconciliation never grows a leg's ledger from broker qty (a pooled Dhan
  // position can hold a sibling's share), so a gap it can't attribute stays a
  // warning. This is the explicit, user-confirmed attribution: read the broker
  // live, subtract every other tracked leg on the contract, and adopt the rest.
  const claimBrokerQty = useCallback(async (basketId: string, legId: string) => {
    const basket = basketsRef.current.find(b => b.id === basketId);
    const leg = basket?.legs.find(l => l.id === legId);
    if (!basket || !leg || leg.status !== 'OPEN') return;
    if (legBrokerMismatch(leg, basket.broker)) return;
    const label = `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}`;
    try {
      const res = await fetch(scalperRoute(basket.broker as Broker, 'positions'));
      const j = await res.json() as { success: boolean; data?: Record<string, unknown>[]; error?: string };
      if (!j.success || !Array.isArray(j.data)) {
        addToast('error', `Cannot claim ${label}`, j.error ?? 'Broker positions unavailable');
        return;
      }
      const fb = basket.broker === 'dhan' && !leg.orderRef?.securityId ? resolveDhanSecurityId(basket, leg) : undefined;
      const match = findLegPosition(basket.broker, leg, j.data, fb);
      if (match.kind !== 'match') {
        addToast('error', `Cannot claim ${label}`, 'No single live broker position matches this leg');
        return;
      }
      const latest = basketsRef.current;
      const claim = claimableLegQty(latest, basketId, legId, Number(match.row.netQty) || 0);
      const cur = latest.find(b => b.id === basketId)?.legs.find(l => l.id === legId);
      if (!claim || !cur) {
        addToast('error', `Cannot claim ${label}`, 'Broker position side does not match this leg');
        return;
      }
      const ownQty = cur.fill?.qty ?? 0;
      const legExpiry = cur.expiry || basket.expiry;
      const lotSize = lookupCacheRef.current[lkKey(basket.broker, basket.underlying, legExpiry)]?.lotSize
        ?? fallbackLotSize(basket.underlying as Underlying, basket.broker);
      const claimQty = Math.floor(claim.claimQty / lotSize) * lotSize;
      if (claimQty <= ownQty) {
        addToast('error', `Nothing to claim for ${label}`, claim.othersQty > 0
          ? `Broker ${Math.abs(Number(match.row.netQty))} − ${claim.othersQty} tracked by other legs leaves no extra for this leg`
          : 'This leg already tracks the full broker quantity');
        return;
      }
      if (!window.confirm(
        `${label}: this leg tracks ${ownQty} qty, broker shows ${Math.abs(Number(match.row.netQty))}`
        + (claim.othersQty > 0 ? ` (${claim.othersQty} of it tracked by other legs)` : '')
        + `.\n\nSet this leg to ${claimQty} qty (${claimQty / lotSize} lots)? Exits will then close the full ${claimQty}.`
        + '\n\nOnly do this if the extra quantity was placed for THIS leg (not a manual trade meant to stay separate).',
      )) return;
      const brokerAvg = Number(match.row.sellAvg || match.row.buyAvg || match.row.costPrice || 0);
      patchLegs(basketId, legs => legs.map(l => {
        if (l.id !== legId) return l;
        const oldAvg = l.fill?.avgPrice ?? 0;
        // Broker avg is the pooled position's; it's this leg's only when nothing else shares the contract.
        const avgPrice = claim.othersQty === 0 && brokerAvg > 0 ? brokerAvg : oldAvg;
        return { ...l, lots: claimQty / lotSize, price: avgPrice, fill: { ...l.fill, qty: claimQty, avgPrice }, filledAt: Date.now() };
      }));
      addToast('success', `${label} now tracks ${claimQty} qty`, `${claimQty / lotSize} lots`);
      fetchMarginsForBaskets();
    } catch (e) {
      addToast('error', `Cannot claim ${label}`, String(e));
    }
  }, [addToast, patchLegs, resolveDhanSecurityId, fetchMarginsForBaskets]);

  // ── Record an outside exit on this leg (no order placed) ───────────
  // The counterpart of Claim: legs on this contract together track MORE than
  // the broker holds, because something closed quantity outside this tool.
  // Which leg that close belonged to is the user's call, never guessed.
  const reduceOutsideQty = useCallback(async (basketId: string, legId: string) => {
    const basket = basketsRef.current.find(b => b.id === basketId);
    const leg = basket?.legs.find(l => l.id === legId);
    if (!basket || !leg || leg.status !== 'OPEN') return;
    if (legBrokerMismatch(leg, basket.broker)) return;
    const label = `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}`;
    try {
      const res = await fetch(scalperRoute(basket.broker as Broker, 'positions'));
      const j = await res.json() as { success: boolean; data?: Record<string, unknown>[]; error?: string };
      if (!j.success || !Array.isArray(j.data)) {
        addToast('error', `Cannot reduce ${label}`, j.error ?? 'Broker positions unavailable');
        return;
      }
      const fb = basket.broker === 'dhan' && !leg.orderRef?.securityId ? resolveDhanSecurityId(basket, leg) : undefined;
      const match = findLegPosition(basket.broker, leg, j.data, fb);
      if (match.kind !== 'match') {
        addToast('error', `Cannot reduce ${label}`, match.kind === 'flat'
          ? 'Broker shows this contract flat — the next poll closes the leg by itself'
          : 'No single live broker position matches this leg');
        return;
      }
      const latest = basketsRef.current;
      const w = legQtyWarningsFor(latest, new Map([[`${basketId}:${legId}`, Number(match.row.netQty) || 0]]))[`${basketId}:${legId}`];
      const cur = latest.find(b => b.id === basketId)?.legs.find(l => l.id === legId);
      if (!cur || !w || w.kind !== 'over') {
        addToast('error', `Nothing to reduce on ${label}`, 'The strategies on this contract no longer track more than the broker holds (or an order is still in flight — retry in a few seconds)');
        return;
      }
      const cut = Math.min(w.gap, cur.fill?.qty ?? 0);
      const legExpiry = cur.expiry || basket.expiry;
      const lotSize = lookupCacheRef.current[lkKey(basket.broker, basket.underlying, legExpiry)]?.lotSize
        ?? fallbackLotSize(basket.underlying as Underlying, basket.broker);
      // The closing side's day average: exact when a single outside order did the close.
      const closeAvg = Number((cur.side === 'S' ? match.row.buyAvg : match.row.sellAvg) || 0);
      const suggested = closeAvg > 0 ? closeAvg : ltpFor(basket, cur);
      const entered = window.prompt(
        `${label} (${basket.name || 'Strategy'}): strategies on this contract track ${w.trackedQty}, broker holds ${w.brokerQty}.\n\n`
        + `Record that ${cut} qty of THIS leg (tracks ${cur.fill?.qty ?? 0}) was closed outside this tool? No order is placed.\n`
        + (cut < (cur.fill?.qty ?? 0) ? `The leg keeps ${(cur.fill?.qty ?? 0) - cut}; the closed ${cut} is kept as a separate CLOSED row for P&L.\n` : '')
        + `\nExit price (broker's ${cur.side === 'S' ? 'buy' : 'sell'} average for today${closeAvg > 0 ? '' : ' unavailable — LTP'}):`,
        suggested > 0 ? String(Math.round(suggested * 100) / 100) : '',
      );
      if (entered == null) return;
      const exitPrice = Number(entered);
      if (!(exitPrice > 0)) {
        addToast('error', `Cannot reduce ${label}`, 'Exit price must be a positive number');
        return;
      }
      patchLegs(basketId, legs => legs.flatMap(l => (l.id === legId ? recordOutsideReduction(l, cut, exitPrice, lotSize) : [l])));
      addToast('success', `${label}: recorded ${cut} qty closed outside the tool`, `Exit ₹${exitPrice.toFixed(2)} · no order placed`);
      fetchMarginsForBaskets();
    } catch (e) {
      addToast('error', `Cannot reduce ${label}`, String(e));
    }
  }, [addToast, patchLegs, resolveDhanSecurityId, fetchMarginsForBaskets, ltpFor]);

  // One toast per contract gap — not per leg on it, not per poll tick.
  useEffect(() => {
    const labels = new Map<string, string>();
    for (const b of basketsRef.current) for (const l of b.legs) {
      labels.set(`${b.id}:${l.id}`, `${l.side === 'B' ? 'BUY' : 'SELL'} ${l.strike} ${l.option}`);
    }
    const live = new Set<string>();
    const toasted = new Set<string>();
    for (const [key, w] of Object.entries(legQtyWarnings)) {
      const label = labels.get(key) ?? key;
      const occurrence = `${label}|${w.kind}|${w.brokerQty}|${w.trackedQty}`;
      live.add(occurrence);
      if (underAllocatedWarnedRef.current.has(occurrence) || toasted.has(occurrence)) continue;
      toasted.add(occurrence);
      addToast(
        'error',
        w.kind === 'over' ? `${label}: strategies track MORE than the broker holds` : `${label}: broker holds more than the strategies track`,
        w.kind === 'over'
          ? `Tracked ${w.trackedQty}, broker ${w.brokerQty}: ${w.gap} was closed outside this tool. Use Reduce on the leg it belonged to.`
          : `Tracked ${w.trackedQty}, broker ${w.brokerQty}: ${w.gap} is untracked. Claim it on a leg, or Import it.`,
      );
    }
    underAllocatedWarnedRef.current = new Set([...live]);
  }, [legQtyWarnings, addToast]);

  // ── Import positions taken outside the tool ────────────────────────
  const [showImportModal, setShowImportModal] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);

  // Untracked qty per logged-in broker, each contract verified against that
  // broker's own strike lookup: a symbol parse is only a hint (Zerodha's
  // monthly symbols misparse), and a wrong strike would misprice the leg.
  const scanUntracked = useCallback(async (): Promise<{ candidates: ImportCandidate[]; errors: string[] }> => {
    const underlyings = Object.keys(DEFAULT_INDEX_SPOT);
    const brokers = Array.from(new Set(authenticatedBrokers)) as Broker[];
    const errors: string[] = [];
    const perBroker = await Promise.all(brokers.map(async b => {
      try {
        const res = await fetch(scalperRoute(b, 'positions'));
        const j = await res.json() as { success: boolean; data?: Record<string, unknown>[]; error?: string };
        if (!j.success || !Array.isArray(j.data)) {
          errors.push(`${BROKER_LABELS[b] ?? b}: ${j.error ?? 'positions unavailable'}`);
          return [];
        }
        const found = findUntrackedPositions(b, j.data, basketsRef.current, row => contractHintFromRow(row, underlyings));
        return Promise.all(found.map(async (pos): Promise<ImportCandidate> => {
          const h = pos.hint;
          if (!h?.expiry) return { ...pos, error: 'Expiry not in the broker data — cannot verify the contract' };
          const entry = await ensureLookup(b, h.underlying, h.expiry);
          const ids = entry?.strikes?.[String(h.strike)];
          const got = b === 'dhan'
            ? (h.option === 'CE' ? ids?.ceId : ids?.peId)
            : (h.option === 'CE' ? ids?.ceSymbol : ids?.peSymbol);
          if (!entry || !got || String(got).toUpperCase() !== pos.ident.toUpperCase()) {
            return { ...pos, error: `Could not verify ${h.strike} ${h.option} ${h.expiry} against ${BROKER_LABELS[b] ?? b}'s contract list` };
          }
          return {
            ...pos,
            contract: { underlying: h.underlying, option: h.option, strike: h.strike, expiry: h.expiry },
            lotSize: entry.lotSize,
          };
        }));
      } catch (e) {
        errors.push(`${BROKER_LABELS[b] ?? b}: ${String((e as Error).message ?? e)}`);
        return [];
      }
    }));
    return { candidates: perBroker.flat(), errors };
  }, [authenticatedBrokers, ensureLookup]);

  const importPositions = useCallback(async (req: ImportRequest): Promise<boolean> => {
    const first = req.items[0]?.candidate;
    if (!first?.contract) return false;
    const brokerId = first.broker;
    const underlying = first.contract.underlying;
    if (req.items.some(i => i.candidate.broker !== brokerId || i.candidate.contract?.underlying !== underlying)) {
      addToast('error', 'Import refused', 'Pick positions from one broker and one underlying');
      return false;
    }
    // Re-read the broker: another poll, a Claim, or an order may have moved
    // the untracked qty since the scan.
    try {
      const res = await fetch(scalperRoute(brokerId as Broker, 'positions'));
      const j = await res.json() as { success: boolean; data?: Record<string, unknown>[]; error?: string };
      if (!j.success || !Array.isArray(j.data)) {
        addToast('error', 'Import failed', j.error ?? 'Broker positions unavailable');
        return false;
      }
      const fresh = findUntrackedPositions(brokerId, j.data, basketsRef.current, row => contractHintFromRow(row, [underlying]));
      for (const it of req.items) {
        const now = fresh.find(f => f.ident === it.candidate.ident && f.side === it.candidate.side);
        if (!now || it.qty > now.untrackedQty) {
          addToast('error', 'Import refused', `${it.candidate.tradingSymbol}: only ${now?.untrackedQty ?? 0} is untracked now. Rescan.`);
          return false;
        }
      }
    } catch (e) {
      addToast('error', 'Import failed', String(e));
      return false;
    }

    const legs = req.items.map(it => legFromUntracked(it.candidate, it.candidate.contract!, it.qty, it.avgPrice, it.candidate.lotSize ?? 0));
    if (req.target.kind === 'existing') {
      const basketId = req.target.basketId;
      const target = basketsRef.current.find(b => b.id === basketId);
      if (!target || target.broker !== brokerId || target.underlying !== underlying) {
        addToast('error', 'Import refused', 'That strategy is on a different broker or underlying');
        return false;
      }
      patchLegs(basketId, cur => [...cur, ...legs]);
      addToast('success', `Imported ${legs.length} position(s) into ${target.name || 'strategy'}`, 'No orders placed');
    } else {
      const expiry = legs.map(l => l.expiry!).sort()[0];
      const nowIso = new Date().toISOString();
      const newBasket: MultiLegBasket = {
        id: `mlf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name: req.target.name,
        underlying,
        expiry,
        broker: brokerId,
        presetKey: 'custom',
        multiplier: 1,
        legs,
        riskConfig: { targetValue: undefined, targetUnit: 'pts', slValue: undefined, slUnit: 'pts', armed: false },
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      setBaskets(prev => {
        const next = [...prev, newBasket];
        basketsRef.current = next;
        return next;
      });
      persistBasket(newBasket);
      addToast('success', `Created ${req.target.name}`, `${legs.length} imported position(s) · no orders placed`);
    }
    fetchMarginsForBaskets();
    return true;
  }, [addToast, patchLegs, persistBasket, fetchMarginsForBaskets]);

  // ── Add New Leg to Active Basket ──────────────────────────────────
  const addNewLegCore = useCallback(async (basketId: string, params: {
    side: 'B' | 'S';
    option: 'CE' | 'PE';
    strike: number;
    expiry?: string;
    lots: number;
    orderType: 'MARKET' | 'LIMIT';
    limitPrice?: number;
  }, opts?: {
    /** Caller already confirmed sibling-contract collisions for a whole group. */
    skipCollisionCheck?: boolean;
    /** Risk settings inherited from the leg this one replaces (strike shift). */
    carry?: Partial<MultiLegLeg>;
    /** Caller already ran the bid/ask check (shift checks BEFORE closing anything). */
    skipSpreadCheck?: boolean;
  }): Promise<boolean> => {
    const basket = basketsRef.current.find(b => b.id === basketId);
    if (!basket) return false;

    if (!hasAuthenticatedBroker) {
      addToast('error', 'No broker logged in', 'Log in before placing orders');
      return false;
    }

    const legExpiry = params.expiry || basket.expiry;
    const blockedNew = blockedStrikeLegs(basket, [{ strike: params.strike, option: params.option, expiry: legExpiry }]);
    if (blockedNew.length) { toastBlockedStrikes(blockedNew, basket); return false; }
    const pair = `${basket.underlying}:${legExpiry}`;
    // The strategy's own account — never the toolbar selection (see executionBroker).
    const bk = executionBroker(basket, broker) as Broker;
    const lookup = lookupCache[lkKey(bk, basket.underlying, legExpiry)];
    const lotSize = lookup?.lotSize ?? fallbackLotSize(basket.underlying as Underlying, bk);
    const strikeMap = lookup?.strikes ?? {};

    const qty = params.lots * lotSize;
    const label = `${params.side === 'B' ? 'BUY' : 'SELL'} ${params.strike} ${params.option}`;

    const collisions = findSiblingLegCollisions(
      basketsRef.current, basketId, [{ side: params.side, option: params.option, strike: params.strike, expiry: legExpiry }]);
    if (!opts?.skipCollisionCheck && collisions.length && !window.confirm(describeSiblingCollisions(collisions))) return false;
    if (!opts?.skipSpreadCheck
        && !resolveSpreadIssues(await fetchSpreadIssues(basket, [{ option: params.option, strike: params.strike, expiry: legExpiry, type: params.orderType }]))) return false;

    const req = resolveOrderRequest(bk, {
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
      return false;
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
        let fillPrice = (j.price && j.price > 0)
          ? j.price
          : ((params.limitPrice && params.limitPrice > 0) ? params.limitPrice : curLtp);

        // Dhan: confirm the ACK became a fill before reporting success — a shift
        // reopens its SELLs only after the BUY reopen returns true.
        let unconfirmed = false;
        if (bk === 'dhan' && j.order_id) {
          const c = await confirmDhanOrder(String(j.order_id), params.orderType);
          if (c.phase === 'dead') {
            addToast('error', `${label} rejected after acceptance`, c.reason || 'Order rejected/cancelled by the broker — nothing opened');
            return false;
          }
          if (c.phase === 'filled' && c.avgPrice > 0) fillPrice = c.avgPrice;
          unconfirmed = c.phase === 'pending';
        }

        const newLeg: MultiLegLeg = {
          ...(opts?.carry ?? {}),
          bestPrice: undefined,
          id: `mll_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          side: params.side,
          option: params.option,
          strike: params.strike,
          expiry: legExpiry,
          lots: params.lots,
          type: params.orderType,
          price: fillPrice,
          status: 'OPEN',
          filledAt: Date.now(),
          fill: {
            qty,
            avgPrice: fillPrice,
            orderId: j.order_id,
          },
          orderRef: {
            securityId: j.securityId ?? (req.body.securityId as string | undefined),
            symbol: j.symbol ?? (req.body.tradingsymbol as string | undefined),
          },
          pendingOrders: j.order_id ? [{ id: String(j.order_id), kind: 'grow', qty, at: Date.now() }] : undefined,
        };

        // Dhan nets by security id, so a leg identical to one already OPEN
        // (same side/option/strike/expiry) is the SAME position — merge the
        // lots into that row (weighted avg) instead of listing a duplicate.
        // The write is functional (latest legs, never a snapshot) so concurrent
        // reopens cannot drop each other's leg.
        const sameContract = (l: MultiLegLeg) =>
          l.status === 'OPEN' && l.side === params.side && l.option === params.option
          && l.strike === params.strike && (l.expiry || basket.expiry) === legExpiry;
        const mergeInto = (existing: MultiLegLeg) => {
          const oldQty = (existing.fill?.qty && existing.fill.qty > 0) ? existing.fill.qty : existing.lots * lotSize;
          const oldAvg = (existing.fill?.avgPrice && existing.fill.avgPrice > 0) ? existing.fill.avgPrice : (existing.price || fillPrice);
          const totalQty = oldQty + qty;
          const avg = (oldAvg * oldQty + fillPrice * qty) / totalQty;
          return withPendingOrder({
            ...existing,
            lots: existing.lots + params.lots,
            price: avg,
            filledAt: Date.now(),
            fill: { ...existing.fill, qty: totalQty, avgPrice: avg, orderId: j.order_id ?? existing.fill?.orderId },
          } as MultiLegLeg, j.order_id, 'grow', qty, fillPrice);
        };
        const seen = (basketsRef.current.find(b => b.id === basket.id)?.legs ?? basket.legs).find(sameContract);
        patchLegs(basket.id, legs => {
          const existing = legs.find(sameContract);
          return existing ? legs.map(l => (l.id === existing.id ? mergeInto(existing) : l)) : [...legs, newLeg];
        });
        pollFunds();
        fetchMarginsForBaskets();
        if (unconfirmed) {
          addToast('error', `${label}: fill not confirmed`, `Order ${j.order_id} still not TRADED — tracked on this row; check Orders. Nothing further was placed on it.`);
          return false;
        }
        if (seen) {
          const merged = mergeInto(seen);
          addToast('success', `Added ${params.lots} lot(s) to ${label}`, `New Avg: ₹${(merged.price ?? 0).toFixed(2)} (${merged.lots} lots total)`);
        } else {
          addToast('success', `Added new leg ${label}`, `Filled @ ₹${fillPrice.toFixed(2)} (${params.lots} lots)`);
        }
        return true;
      } else {
        addToast('error', `Add leg failed for ${label}`, j.error ?? 'Unknown broker error');
        return false;
      }
    } catch (e) {
      addToast('error', `Add leg failed for ${label}`, String(e));
      return false;
    }
  }, [broker, hasAuthenticatedBroker, lookupCache, chainData, patchLegs, addToast, confirmDhanOrder, pollFunds, fetchMarginsForBaskets, blockedStrikeLegs, toastBlockedStrikes, fetchSpreadIssues, resolveSpreadIssues]);

  const addNewLegToBasket = useCallback(async (basketId: string, params: Parameters<typeof addNewLegCore>[1]) => {
    await addNewLegCore(basketId, params);
  }, [addNewLegCore]);

  const [scalingMap, setScalingMap] = useState<Record<string, boolean>>({});

  const scaleStrategy = useCallback(async (basketId: string, multiplierDelta: number = 1) => {
    if (scalingMap[basketId]) return;
    // Scaling only ever ADDS; a reduction would need exit sizing (resolveOrderRequest has no sign guard).
    if (!(multiplierDelta >= 1)) return;
    const basket = basketsRef.current.find(b => b.id === basketId);
    if (!basket) return;

    const openLegs = basket.legs.filter(l => l.status === 'OPEN');
    if (!openLegs.length) return;
    if (openLegs.some(l => legBrokerMismatch(l, executionBroker(basket, broker)))) {
      addToast('error', 'Cannot scale', "Some legs were placed on a different broker than this strategy's badge — scale them from that broker.");
      return;
    }

    if (!hasAuthenticatedBroker) {
      addToast('error', 'No broker logged in', 'Log in before placing orders');
      return;
    }

    setScalingMap(prev => ({ ...prev, [basketId]: true }));
    const bk = executionBroker(basket, broker) as Broker;

    try {
      const currentMult = basket.multiplier || 1;
      const newMult = currentMult + multiplierDelta;

      // Sibling collisions check
      const collisions = findSiblingLegCollisions(
        basketsRef.current, basketId,
        openLegs.map(l => ({ side: l.side, option: l.option, strike: l.strike, expiry: l.expiry || basket.expiry })),
      );
      if (collisions.length && !window.confirm(describeSiblingCollisions(collisions))) return;

      // Invariant 9: 2-phase placement (BUYs first, then SELLs)
      const buyLegs = openLegs.filter(l => l.side === 'B');
      const sellLegs = openLegs.filter(l => l.side === 'S');

      const placeScaleLeg = async (leg: MultiLegLeg) => {
        const legExpiry = leg.expiry || basket.expiry;
        const lookup = lookupCache[lkKey(bk, basket.underlying, legExpiry)];
        const strikeMap = lookup?.strikes ?? {};
        const lotSize = lookup?.lotSize ?? fallbackLotSize(basket.underlying as Underlying, bk);
        const baseRatio = leg.ratio ?? Math.max(1, Math.round(leg.lots / currentMult));
        const addLots = baseRatio * multiplierDelta;
        const qty = addLots * lotSize;

        const req = resolveOrderRequest(bk, {
          side: leg.side,
          option: leg.option,
          strike: leg.strike,
          qty,
          type: 'MARKET',
          underlying: basket.underlying as Underlying,
          productType: 'MARGIN',
          securityId: leg.orderRef?.securityId,
          tradingsymbol: leg.orderRef?.symbol,
        }, strikeMap);

        if (!req) throw new Error(`Could not resolve security for ${leg.strike} ${leg.option}`);

        const res = await fetch(req.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
        });
        const j = await res.json() as { success: boolean; order_id?: string; price?: number; error?: string };
        if (!j.success) throw new Error(j.error || `Order failed for ${leg.strike} ${leg.option}`);

        const currentLtp = ltpFor(basket, leg);
        let fillPrice = (j.price && j.price > 0) ? j.price : (currentLtp > 0 ? currentLtp : (leg.price ?? 0));
        // Dhan: a hedge ACK must be a real fill before the SELL phase runs.
        let unconfirmed = false;
        if (bk === 'dhan' && j.order_id) {
          const c = await confirmDhanOrder(String(j.order_id), 'MARKET');
          if (c.phase === 'dead') throw new Error(`${leg.strike} ${leg.option} rejected after acceptance${c.reason ? `: ${c.reason}` : ''}`);
          if (c.phase === 'filled' && c.avgPrice > 0) fillPrice = c.avgPrice;
          unconfirmed = c.phase === 'pending';
        }
        // Immediately update leg fill ledger so partial fills are never orphaned (Invariant 1).
        // Functional: grown from the LATEST leg, not the pre-await snapshot.
        patchLegs(basketId, legs => legs.map(l => {
          if (l.id !== leg.id) return l;
          const oldQty = (l.fill?.qty && l.fill.qty > 0) ? l.fill.qty : (l.lots * lotSize);
          const oldAvg = (l.fill?.avgPrice && l.fill.avgPrice > 0) ? l.fill.avgPrice : (l.price || currentLtp);
          const totalQty = oldQty + qty;
          const avg = ((oldAvg * oldQty) + (fillPrice * qty)) / totalQty;
          return withPendingOrder({
            ...l,
            lots: l.lots + addLots,
            price: avg,
            filledAt: Date.now(),
            fill: { qty: totalQty, avgPrice: avg, orderId: j.order_id ?? l.fill?.orderId },
          }, j.order_id, 'grow', qty, fillPrice);
        }));
        // Recorded above (the poll settles it), but not confirmed: stop the next phase.
        if (unconfirmed) throw new Error(`${leg.strike} ${leg.option} fill not confirmed (order ${j.order_id}) — check Orders`);
      };

      // Phase 1: BUY legs concurrently. allSettled, not all: a rejected hedge must
      // stop the sells, but its siblings' fills are already on the ledger.
      const buyResults = await Promise.allSettled(buyLegs.map(placeScaleLeg));
      const buyFail = buyResults.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (buyFail) throw new Error(`Hedge leg failed — SELL legs NOT scaled: ${String(buyFail.reason)}`);

      // Phase 2: SELL legs concurrently (only if all BUYs succeeded)
      const sellResults = await Promise.allSettled(sellLegs.map(placeScaleLeg));
      const sellFail = sellResults.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (sellFail) throw new Error(`Some SELL legs did not scale (the rest did — check the legs table): ${String(sellFail.reason)}`);

      // Legs were already written per order above; only the multiplier is left.
      updateBasket(basketId, { multiplier: newMult });

      addToast('success', `Scaled ${basket.name || basket.underlying} to ${newMult}×`, `Added +${multiplierDelta}× to all ${openLegs.length} open legs`);
      pollFunds();
      fetchMarginsForBaskets();
    } catch (e) {
      addToast('error', 'Scale strategy failed', String(e));
    } finally {
      setScalingMap(prev => ({ ...prev, [basketId]: false }));
    }
  }, [hasAuthenticatedBroker, broker, lookupCache, ltpFor, updateBasket, patchLegs, addToast, confirmDhanOrder, pollFunds, fetchMarginsForBaskets]);


  // ── Shift legs N strikes (roll: close old leg, reopen at strike ± N) ──
  // The old leg stays in the basket as CLOSED (realized P&L kept); the new leg is
  // appended OPEN and inherits the old leg's SL/TP/trail settings. Same guards as
  // the Advanced Scalper's shift: refuse on chain-edge clamp (whole plan), one
  // combined collision confirm, close confirmed BEFORE anything reopens, reopen
  // sized off what actually closed (never broker net qty).
  const shiftLegs = useCallback(async (basketId: string, legIds: string[], direction: 'UP' | 'DOWN', steps: number) => {
    const basket = basketsRef.current.find(b => b.id === basketId);
    if (!basket) return;
    if (!hasAuthenticatedBroker) {
      addToast('error', 'No broker logged in', 'Log in before shifting');
      return;
    }
    if (placementLockRef.current) {
      addToast('error', 'Another placement is in progress', 'Wait for it to finish before shifting.');
      return;
    }
    const selected = basket.legs.filter(l => legIds.includes(l.id) && l.status === 'OPEN');
    if (!selected.length) {
      addToast('error', 'Nothing to shift', 'No open legs selected');
      return;
    }
    // A group shift must move every selected leg or none: a leg with no ledger
    // quantity cannot be sized for a reopen, so refuse rather than shift the rest.
    const unsized = selected.filter(l => !((l.fill?.qty ?? 0) > 0));
    if (unsized.length) {
      addToast('error', 'Cannot shift', `${unsized.map(l => `${l.strike} ${l.option}`).join(', ')} has no recorded fill quantity — positions left untouched`);
      return;
    }
    const targets = selected;
    // The strategy's own account — never the toolbar selection (see executionBroker).
    const bk = executionBroker(basket, broker) as Broker;
    if (targets.some(l => legBrokerMismatch(l, bk))) {
      addToast('error', 'Cannot shift', "A selected leg was placed on a different broker than this strategy's badge — positions left untouched.");
      return;
    }

    const strikesFor = (legExpiry: string | undefined) =>
      allowedStrikes(basket.underlying, legExpiry || basket.expiry, expiriesMap[basket.underlying] ?? [],
        Object.keys(lookupCache[lkKey(bk, basket.underlying, legExpiry || basket.expiry)]?.strikes ?? {}).map(Number).sort((a, b) => a - b));
    const fallbackStep = DEFAULT_INDEX_STEP[basket.underlying as Underlying] || 50;
    const plan = planLegShifts(targets, strikesFor, direction, steps, fallbackStep);
    if (!plan.ok) {
      addToast('error', `Cannot shift ${direction.toLowerCase()}`, `${plan.reason} — positions left untouched`);
      return;
    }
    const moveFor = new Map(plan.moves.map(m => [m.legId, m]));
    const blockedTargets = blockedStrikeLegs(basket, targets.map(t => ({ strike: moveFor.get(t.id)!.to, option: t.option, expiry: t.expiry })));
    if (blockedTargets.length) { toastBlockedStrikes(blockedTargets, basket); return; }

    // One confirm for every contract the shift lands on: another basket already
    // holding it, or one of THIS basket's other open legs (the reopen would merge).
    const legExpiryOf = (l: MultiLegLeg) => l.expiry || basket.expiry;
    const collisions = findSiblingLegCollisions(
      basketsRef.current, basketId,
      targets.map(l => ({ side: l.side, option: l.option, strike: moveFor.get(l.id)!.to, expiry: legExpiryOf(l) })));
    const selfHeld = basket.legs.filter(o => o.status === 'OPEN' && !moveFor.has(o.id) && targets.some(t => {
      const mv = moveFor.get(t.id)!;
      return t.side === o.side && t.option === o.option && mv.to === o.strike && legExpiryOf(t) === legExpiryOf(o);
    }));
    // Dhan nets by security id: landing on a contract this strategy already holds on the
    // OPPOSITE side (e.g. shifting a short onto the long hedge strike) would offset the
    // existing leg instead of opening a new one. Not a merge — refuse outright.
    const opposite = basket.legs.filter(o => o.status === 'OPEN' && !moveFor.has(o.id) && targets.some(t => {
      const mv = moveFor.get(t.id)!;
      return t.side !== o.side && t.option === o.option && mv.to === o.strike && legExpiryOf(t) === legExpiryOf(o);
    }));
    if (opposite.length) {
      addToast('error', 'Cannot shift onto an opposite leg',
        `${opposite.map(l => `${l.side === 'B' ? 'BUY' : 'SELL'} ${l.strike} ${l.option}`).join(', ')} is open on that contract — it would net against the shifted leg. Positions left untouched.`);
      return;
    }
    const warnings: string[] = [];
    if (collisions.length) warnings.push(describeSiblingCollisions(collisions));
    if (selfHeld.length) warnings.push(`This strategy already holds ${selfHeld.map(l => `${l.strike} ${l.option}`).join(', ')} — the shifted leg will merge into it.`);
    if (warnings.length && !window.confirm(`${warnings.join('\n\n')}\n\nContinue?`)) return;

    placementLockRef.current = true;
    const desc = plan.moves.map(m => { const l = targets.find(t => t.id === m.legId)!; return `${m.from}→${m.to} ${l.option}`; }).join(', ');
    try {
      // Bid/ask of the NEW strikes, checked before anything is closed (lock already held, so a
      // double-click cannot slip in); a refusal after the close would strand the strategy half-rolled.
      if (!resolveSpreadIssues(await fetchSpreadIssues(basket, targets.map(t => ({ option: t.option, strike: moveFor.get(t.id)!.to, expiry: t.expiry, type: 'MARKET' as const }))))) return;
      addToast('success', `Shifting ${direction.toLowerCase()} ${clampShiftSteps(steps)}: ${desc}`, 'Closing current legs first…');

      // ── Phase A: close. Shorts first (concurrently), then longs; longs are
      // skipped if any short did not close. Any failure aborts before reopening.
      const lotSizeFor = (l: MultiLegLeg) =>
        lookupCache[lkKey(bk, basket.underlying, legExpiryOf(l))]?.lotSize ?? fallbackLotSize(basket.underlying as Underlying, bk);
      const ownQty = new Map(targets.map(l => [l.id, l.fill!.qty]));
      const closedQty = new Map<string, number>();
      const closeGroup = async (group: MultiLegLeg[]) => {
        const res = await Promise.all(group.map(l => exitOneLeg(basketId, l).catch(() => ({ closed: false, qty: 0 }))));
        group.forEach((l, i) => { if (res[i].closed) closedQty.set(l.id, res[i].qty); });
        return res.every(r => r.closed);
      };
      const shorts = targets.filter(l => l.side === 'S');
      const longs = targets.filter(l => l.side === 'B');
      let allClosed = shorts.length ? await closeGroup(shorts) : true;
      if (allClosed && longs.length) allClosed = await closeGroup(longs);
      if (!allClosed) {
        const closedNames = targets.filter(l => closedQty.has(l.id)).map(l => `${l.strike} ${l.option}`);
        addToast('error', 'Shift aborted — nothing reopened',
          `${closedNames.length ? `Closed: ${closedNames.join(', ')}. ` : 'Nothing closed. '}Other legs are still open. Check Orders/Positions, then retry.`);
        return;
      }

      // A market close is acknowledged before it is guaranteed filled. Confirm the
      // position book actually came down before opening the replacement, or a slow
      // fill leaves old + new legs live at once.
      const toReopen = targets.filter(l => (closedQty.get(l.id) ?? 0) > 0);
      for (const l of targets) {
        if (closedQty.has(l.id) && !toReopen.includes(l)) {
          addToast('error', `${l.strike} ${l.option} was already flat`, `Nothing to roll — no new leg opened at ${moveFor.get(l.id)!.to}`);
        }
      }
      let verified = false;
      for (let attempt = 0; attempt < 3 && !verified && toReopen.length; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 500));
        try {
          const res = await fetch(scalperRoute(bk, 'positions'));
          const j = await res.json() as { success: boolean; data?: Record<string, unknown>[] };
          if (!j.success || !Array.isArray(j.data)) continue;
          verified = toReopen.every(l => {
            const fb = bk === 'dhan' && !l.orderRef?.securityId ? resolveDhanSecurityId(basket, l) : undefined;
            const m = findLegPosition(bk, l, j.data!, fb);
            return m.kind === 'flat' || (m.kind === 'match' && Math.abs(Number(m.row.netQty ?? 0)) < (ownQty.get(l.id) ?? 0));
          });
        } catch { /* retry */ }
      }
      if (toReopen.length && !verified
          && !window.confirm('Could not confirm the old legs are flat at the broker (a shared contract can hide it). Open the replacement legs anyway?')) {
        addToast('error', 'Shift stopped — old legs closed, nothing reopened', 'Add the new legs manually once flat is confirmed.');
        return;
      }

      // ── Phase B: reopen. BUY legs first (concurrently), then SELL legs; if a
      // hedge fails to reopen the shorts stay closed (flat is safe, naked is not).
      const reopen = async (l: MultiLegLeg) => {
        const units = closedQty.get(l.id) ?? 0;
        const ls = lotSizeFor(l);
        const lots = Math.floor(units / ls);
        const mv = moveFor.get(l.id)!;
        if (lots < 1) {
          addToast('error', `Not reopened: ${mv.to} ${l.option}`, `${units} qty closed is under one lot — add it manually`);
          return false;
        }
        if (lots * ls !== units) addToast('error', 'Partial re-entry', `Reopening ${lots * ls} of ${units} qty at ${mv.to} ${l.option}`);
        const ok = await addNewLegCore(basketId, {
          side: l.side, option: l.option, strike: mv.to, expiry: legExpiryOf(l), lots, orderType: 'MARKET',
        }, {
          skipCollisionCheck: true,
          skipSpreadCheck: true,
          carry: { sl: l.sl, slType: l.slType, tp: l.tp, tpType: l.tpType, trail: l.trail },
        });
        if (!ok) addToast('error', `Closed ${mv.from} ${l.option} but NOT reopened at ${mv.to}`, 'Position is flat at that leg — add the new leg manually');
        return ok;
      };
      const buys = toReopen.filter(l => l.side === 'B');
      const sells = toReopen.filter(l => l.side === 'S');
      const buyOk = buys.length ? (await Promise.all(buys.map(reopen))).every(Boolean) : true;
      if (!buyOk) {
        if (sells.length) addToast('error', 'Hedge reopen failed — short legs NOT reopened', 'Shorts stay closed (flat). Fix the hedge, then add the short legs.');
        return;
      }
      if (sells.length) await Promise.all(sells.map(reopen));
    } finally {
      placementLockRef.current = false;
      fundsAtRef.current = 0;
      pollFunds();
      fetchMarginsForBaskets();
    }
  }, [hasAuthenticatedBroker, lookupCache, broker, expiriesMap, addToast, exitOneLeg, addNewLegCore, resolveDhanSecurityId, pollFunds, fetchMarginsForBaskets, blockedStrikeLegs, toastBlockedStrikes, fetchSpreadIssues, resolveSpreadIssues]);

  // ── Broker Positions Poller across ALL Baskets ─────────────────────
  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      // No early-return on "nothing placed yet": the untracked-position scan
      // below needs to run even when this tool has zero baskets, so it can
      // discover a straddle/strangle opened from Scalper (or another broker
      // session) that this tool has never seen before.
      const anyPlaced = basketsRef.current.some(b => b.legs.some(l => l.orderRef != null));

      type PollJson = {
        success: boolean;
        data?: Record<string, unknown>[];
        positions?: Record<string, unknown>[];
        orders?: Record<string, unknown>[];
        trades?: Record<string, unknown>[];
        positionsError?: string | null;
        error?: string;
      };

      try {
        // A basket can carry a different broker than whatever is currently
        // selected in the toolbar (e.g. a Dhan strategy tracked while Kotak
        // is selected — every basket is shown regardless of the selector).
        // Reconciling every basket against only the selected broker's rows
        // means an exit made on a non-selected broker's leg is never
        // observed, so it stays stuck OPEN forever. So poll every broker
        // unconditionally, not just the selected one / ones in use.
        const pollBrokers = new Set<Broker>(BROKERS);
        const results = await Promise.all(
          Array.from(pollBrokers).map(async (b) => {
            try {
              const res = await fetch(scalperRoute(b, 'poll'));
              const j = await res.json() as PollJson;
              if (!j.success) return { broker: b, rows: null as Record<string, unknown>[] | null, j: null as PollJson | null, error: j.error || j.positionsError || null };
              return { broker: b, rows: j.positions ?? j.data ?? [], j, error: null as string | null };
            } catch (e) {
              return { broker: b, rows: null as Record<string, unknown>[] | null, j: null as PollJson | null, error: String((e as Error).message) };
            }
          }),
        );
        if (cancelled) return;

        // A poll that answered success but flagged positionsError carries an
        // EMPTY positions list — that's "unknown", not "flat", so it must not
        // reach reconciliation (which would read every leg as not found/flat).
        const rowsByBroker: Partial<Record<Broker, Record<string, unknown>[]>> = {};
        const ordersByBroker: Partial<Record<Broker, Map<string, NormalizedOrder>>> = {};
        for (const r of results) {
          if (r.rows && !r.j?.positionsError) rowsByBroker[r.broker] = r.rows;
          if (Array.isArray(r.j?.orders)) {
            const m = new Map<string, NormalizedOrder>();
            for (const row of r.j!.orders!) { const n = normalizeOrderRow(row); if (n) m.set(n.id, n); }
            ordersByBroker[r.broker] = m;
          }
        }

        const selectedResult = results.find(r => r.broker === broker);
        setOrdersError(selectedResult?.error ?? null);
        if (selectedResult?.j) {
          if (Array.isArray(selectedResult.j.orders)) setOrdersData(selectedResult.j.orders);
          if (Array.isArray(selectedResult.j.trades)) setTradesData(selectedResult.j.trades);
        }

        if (anyPlaced) {
          // Collected outside setBaskets's updater (which React can invoke more
          // than once, e.g. under Strict Mode) so the toast side-effect below
          // fires exactly once per real poll tick, not once per updater call.
          const brokerNetByLeg = new Map<string, number>();
          // Rejected/cancelled orders found this tick — toasted once, outside the updater.
          const orderOutcomeToasts = new Map<string, { label: string; kind: 'grow' | 'exit'; status: string; unfilled: number; unknownFill?: boolean }>();

          setBaskets(prevBaskets => {
            let anyChange = false;
            const nextBaskets = prevBaskets.map(basket => {
              let basketChange = false;
              const lotSize = lookupCacheRef.current[lkKey(basket.broker, basket.underlying, basket.expiry)]?.lotSize ?? fallbackLotSize(basket.underlying as Underlying, basket.broker);
              const basketRows = rowsByBroker[basket.broker as Broker];
              const basketOrders = ordersByBroker[basket.broker as Broker];

              const nextLegs = basket.legs.map(origLeg => {
                // 1. Settle orders the broker ACKed but later rejected/cancelled.
                let leg = origLeg;
                if (basketOrders && leg.pendingOrders?.length) {
                  const out = applyOrderOutcomes(leg, basketOrders, lotSize);
                  leg = out.leg;
                  for (const n of out.notes) {
                    orderOutcomeToasts.set(`${basket.id}:${leg.id}:${n.kind}:${n.status}:${n.unfilled}`, {
                      label: `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}`, ...n,
                    });
                  }
                }
                if (!leg.orderRef || !basketRows || legBrokerMismatch(leg, basket.broker)) {
                  if (leg !== origLeg) { basketChange = true; anyChange = true; }
                  return leg;
                }
                const fallbackSecId = (basket.broker === 'dhan' && !leg.orderRef.securityId)
                  ? resolveDhanSecurityId(basket, leg)
                  : undefined;
                const match = findLegPosition(basket.broker, leg, basketRows, fallbackSecId);
                // reconcileLegWithBroker compares against `leg` (post order-outcome);
                // the change check below compares against the original.
                let reconciled = reconcileLegWithBroker(leg, match, leg.lots * lotSize, lotSize);
                // Self-heal a leg that only ever recorded a symbol/no securityId
                // (see resolveDhanSecurityId) as soon as the poll resolves one,
                // so it stops being permanently unmatchable for future exits.
                // reconcileLegWithBroker can return the same object reference
                // (not_found/ambiguous branch) — never mutate it, always copy.
                // Only bind it once CONFIRMED against a live row (match/flat) —
                // the strike/expiry chain cache this id came from can be stale,
                // and binding on an unconfirmed id would mask that silently.
                if (fallbackSecId && !reconciled.orderRef?.securityId && (match.kind === 'match' || match.kind === 'flat')) {
                  reconciled = { ...reconciled, orderRef: { ...reconciled.orderRef, securityId: fallbackSecId } };
                }

                // Feeds legQtyWarnings (legQtyWarningsFor), which checks the SUM of every
                // leg on this contract against the broker (per-leg clamping alone
                // can't see two legs over-tracking one pooled position).
                if (match.kind === 'match') {
                  brokerNetByLeg.set(`${basket.id}:${leg.id}`, Number(match.row.netQty) || 0);
                }

                if (
                  leg !== origLeg ||
                  reconciled.status !== leg.status ||
                  reconciled.lots !== leg.lots ||
                  reconciled.fill?.qty !== leg.fill?.qty ||
                  reconciled.fill?.avgPrice !== leg.fill?.avgPrice ||
                  reconciled.closedFill?.exitPrice !== leg.closedFill?.exitPrice ||
                  reconciled.orderRef?.securityId !== leg.orderRef?.securityId
                ) {
                  basketChange = true;
                  anyChange = true;
                  return reconciled;
                }
                return origLeg;
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

          // A fresh Map every tick, so legQtyWarnings re-evaluates as fill-grace windows expire.
          setBrokerNetByLeg(brokerNetByLeg);


          for (const o of orderOutcomeToasts.values()) {
            if (o.unknownFill) {
              addToast('error', `${o.label}: order ${o.status}`, 'Broker did not report how much filled — this leg was NOT adjusted. Check Orders/Positions.');
            } else if (o.kind === 'grow') {
              addToast('error', `${o.label}: order ${o.status} after acceptance`, `${o.unfilled} qty never opened — removed from this leg's tracked quantity.`);
            } else {
              addToast('error', `${o.label}: EXIT ${o.status} — position is still OPEN`, `${o.unfilled} qty did not close; the leg is tracked as OPEN again. Exit it again or check Orders.`);
            }
          }
        }
      } catch (err) {
        if (!cancelled) setOrdersError(String((err as Error).message));
      }
    };

    poll();
    const interval = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [broker, persistBasket, resolveDhanSecurityId, addToast]);

  // ── Automated Risk Watcher: SL, TP, Trailing SL, Strategy Target/SL ─
  // id -> when its auto-exit last fired. An exit that fails (429, match miss,
  // reject) leaves the leg OPEN; after RISK_EXIT_RETRY_MS the rule may fire
  // again instead of the stop being silently disarmed for the rest of the day.
  const triggeredLegExitsRef = useRef<Map<string, number>>(new Map());
  const triggeredStrategyExitsRef = useRef<Map<string, number>>(new Map());
  const RISK_EXIT_RETRY_MS = 15_000;
  const recentlyTriggered = (m: Map<string, number>, id: string) => {
    const t = m.get(id);
    return t != null && Date.now() - t < RISK_EXIT_RETRY_MS;
  };

  useEffect(() => {
    for (const basket of baskets) {
      const openLegs = basket.legs.filter(l => l.status === 'OPEN' && l.fill);
      if (openLegs.length === 0) {
        triggeredStrategyExitsRef.current.delete(basket.id);
        continue;
      }

      // 1. Strategy Target and SL
      if (basket.riskConfig?.armed && !recentlyTriggered(triggeredStrategyExitsRef.current, basket.id) && !exitingMap[basket.id]) {
        const crudeMult = basket.broker === 'dhan'
          ? (basket.underlying === 'CRUDEOIL' ? 100 : basket.underlying === 'CRUDEOILM' ? 10 : 1)
          : 1;
        const metrics = computeStrategyMetrics(basket.legs, l => ltpFor(basket, l), crudeMult);
        const decision = checkStrategyRisk(metrics, basket.riskConfig);

        if (decision === 'TARGET') {
          triggeredStrategyExitsRef.current.set(basket.id, Date.now());
          addToast('success', `${basket.name ?? 'Strategy'} Target Reached`, `Closed basket at ${metrics.pnlPts >= 0 ? '+' : ''}${metrics.pnlPts.toFixed(1)} pts (${metrics.pnlPct >= 0 ? '+' : ''}${metrics.pnlPct.toFixed(1)}%)`);
          exitBasket(basket.id);
          continue;
        } else if (decision === 'SL') {
          triggeredStrategyExitsRef.current.set(basket.id, Date.now());
          addToast('error', `${basket.name ?? 'Strategy'} Stop Loss Reached`, `Closed basket at ${metrics.pnlPts.toFixed(1)} pts (${metrics.pnlPct.toFixed(1)}%)`);
          exitBasket(basket.id);
          continue;
        }
      }

      // 2. Leg-wise SL, TP, and Trailing SL
      const bestUpdates = new Map<string, number>();
      for (const leg of basket.legs) {
        if (leg.status !== 'OPEN' || !leg.fill) continue;
        const ltp = ltpFor(basket, leg);
        if (ltp <= 0) continue;

        const evalResult = computeLegTrailingSL(leg, ltp);

        if (evalResult.newBestPrice !== leg.bestPrice && evalResult.newBestPrice != null) {
          bestUpdates.set(leg.id, evalResult.newBestPrice);
        }

        if (evalResult.triggered && !recentlyTriggered(triggeredLegExitsRef.current, leg.id) && !exitingLegsRef.current.has(leg.id)) {
          triggeredLegExitsRef.current.set(leg.id, Date.now());
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
      }

      // Functional, bestPrice only: writing back this render's `basket.legs`
      // wholesale could revert a fill an in-flight order just recorded.
      if (bestUpdates.size) {
        patchLegs(basket.id, legs => legs.map(l => {
          const bp = bestUpdates.get(l.id);
          return bp != null && l.status === 'OPEN' ? { ...l, bestPrice: bp } : l;
        }));
      }
    }
  }, [baskets, ltpFor, exitingMap, exitBasket, exitOneLeg, patchLegs, addToast]); // eslint-disable-line react-hooks/exhaustive-deps

  // Open/draft/placing rows stay put; fully-exited (every leg CLOSED) rows sink
  // to the bottom so a long-running page doesn't bury active positions under
  // its own trade history. Array#sort is stable (ES2019+), so relative order
  // within each group is preserved exactly as baskets were created/updated.
  const sortedBaskets = useMemo(() => {
    return [...baskets].sort((a, b) => {
      const aExited = computeBasketStatus(a.legs) === 'CLOSED' ? 1 : 0;
      const bExited = computeBasketStatus(b.legs) === 'CLOSED' ? 1 : 0;
      return aExited - bExited;
    });
  }, [baskets]);
  const firstExitedIdx = useMemo(
    () => sortedBaskets.findIndex(b => computeBasketStatus(b.legs) === 'CLOSED'),
    [sortedBaskets],
  );

  return (
    <div className={embedded ? 'flex flex-col w-full' : 'min-h-screen bg-zinc-950 text-zinc-100'}>
      {!hideHeader && <NavBar />}

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
      <div className={`${hideHeader ? 'bg-zinc-950/95 border-b border-zinc-800 px-3 py-2' : 'sticky top-0 z-30 bg-zinc-950/95 backdrop-blur border-b border-zinc-800 px-4 py-3'}`}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            {!hideHeader && (
              <h1 className="text-sm font-bold tracking-wide uppercase text-white flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-emerald-400" />
                Multi-Leg Strategy Focus
              </h1>
            )}
            <span className="text-xs text-zinc-400 font-semibold">
              {activeStrategiesCount} Running · {baskets.length} Total
            </span>

            {/* Underlying Ticker Selector Pills */}
            <div className="flex items-center gap-0.5 bg-zinc-900 p-0.5 rounded-lg border border-zinc-800">
              {UNDERLYINGS.map(u => (
                <button
                  key={u}
                  type="button"
                  onClick={() => {
                    setSelectedUnderlying(u);
                    setHasManualUnderlying(true);
                    onUnderlyingChangeProp?.(u);
                  }}
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

            {/* India VIX Ticker — prefers the live WS tick (liveVix) over the
                60s REST poll (vixData); only shows STALE when falling back to
                a REST/CSV value with no live WS tick to override it. */}
            {(vixData || (liveVix && liveVix.ltp > 0)) && (() => {
              const vixIsLive = !!(liveVix && liveVix.ltp > 0);
              const vixShowsStale = !vixIsLive && !!vixData?.stale;
              return (
                <div
                  className={`h-8 flex items-baseline gap-2 px-3 rounded-lg bg-zinc-900 border font-mono tabular-nums shadow-sm ${vixShowsStale ? 'border-amber-500/60' : 'border-zinc-700/80'}`}
                  title={`India VIX | Prev Close: ${currentVixPrevClose.toFixed(2)}${vixShowsStale ? ' | STALE: live feed unavailable, showing yesterday\'s close from CSV' : ''}`}
                >
                  <span className="text-[11px] font-bold text-zinc-400 tracking-wider">VIX</span>
                  <span className="text-sm font-bold text-white">{currentVix.toFixed(2)}</span>
                  <span className={`text-xs font-semibold flex items-center gap-0.5 ${vixChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    <span>{vixChange >= 0 ? '▲' : '▼'}</span>
                    <span>{Math.abs(vixChange).toFixed(2)}</span>
                    <span className="text-[11px] opacity-90">({vixChange >= 0 ? '+' : ''}{vixChangePct.toFixed(2)}%)</span>
                  </span>
                  {vixShowsStale && <span className="text-[10px] font-bold text-amber-400 tracking-wider">STALE</span>}
                </div>
              );
            })()}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {/* Broker Selector */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-zinc-400 font-semibold">Broker:</span>
              <select
                value={broker}
                onChange={e => setBroker(e.target.value as Broker)}
                title="Broker for NEW strategies, and for the funds/orders shown here. An existing strategy always trades on the broker badge on its own row."
                aria-label="Broker for new strategies"
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

            {/* Today's P&L (broker MTM scope) and lifetime P&L */}
            <span
              className={`h-8 flex items-center px-3 rounded-lg text-xs font-bold font-mono tabular-nums border ${
                overallTodayPnl >= 0 ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/5' : 'text-rose-400 border-rose-500/30 bg-rose-500/5'
              }`}
              title="Open legs (MTM from entry) plus legs closed today: the same scope as the broker's positions P&L. Positions no strategy tracks are not included."
            >
              Today: {overallTodayPnl >= 0 ? '+' : ''}{fmtMoney(overallTodayPnl)}
            </span>
            {prevDaysPnl ? (
              <Link
                href="/portfolio/diary"
                className={`h-8 flex items-center px-3 rounded-lg text-xs font-bold font-mono tabular-nums border ${
                  prevDaysPnl.net >= 0 ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/5' : 'text-rose-400 border-rose-500/30 bg-rose-500/5'
                } ${FOCUS_RING}`}
                title={`Whole Dhan account, net realized P&L (after charges) over the previous 3 market days — from the Trader's Diary${
                  tradeHistory?.generatedAt ? `, synced ${tradeHistory.generatedAt.slice(0, 16).replace('T', ' ')}` : ''
                }:\n${
                  prevDaysPnl.days.map(d => `${d.date}: ${d.netPnl >= 0 ? '+' : ''}${fmtMoney(d.netPnl)}`).join('\n')
                }\nGross ${prevDaysPnl.gross >= 0 ? '+' : ''}${fmtMoney(prevDaysPnl.gross)} − charges ${fmtMoney(prevDaysPnl.charges)}`}
              >
                Prev 3D: {prevDaysPnl.net >= 0 ? '+' : ''}{fmtMoney(prevDaysPnl.net)}
              </Link>
            ) : (
              <span
                className="h-8 flex items-center px-3 rounded-lg text-xs font-bold font-mono border border-zinc-700 text-zinc-500"
                title="No trade history yet: run a sync from the Trader's Diary"
              >
                Prev 3D: —
              </span>
            )}

            {/* How to use (the page's README) */}
            {helpMarkdown && (
              <button
                type="button"
                onClick={() => setShowHelp(true)}
                className={`h-8 px-3 inline-flex items-center gap-1.5 text-xs font-bold rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 hover:text-white transition-colors cursor-pointer ${FOCUS_RING}`}
              >
                <CircleHelp className="w-3.5 h-3.5 text-zinc-400" />
                <span>How to use</span>
              </button>
            )}

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

            {/* Import positions taken outside the tool */}
            <button
              type="button"
              onClick={() => setShowImportModal(true)}
              disabled={!hasAuthenticatedBroker}
              className={`h-8 px-3 inline-flex items-center gap-1.5 text-xs font-bold rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS_RING}`}
              title="Group positions taken outside this tool into a strategy (no orders placed)"
            >
              <Download className="w-3.5 h-3.5 text-emerald-400" />
              <span>Import</span>
            </button>

            {/* Archived (closed on earlier days) strategies */}
            <button
              type="button"
              onClick={() => setShowHistoryModal(true)}
              className={`h-8 px-3 inline-flex items-center gap-1.5 text-xs font-bold rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 hover:text-white transition-colors cursor-pointer ${FOCUS_RING}`}
              title="Strategies closed on earlier days, with realized P&L"
            >
              <History className="w-3.5 h-3.5 text-amber-400" />
              <span>History</span>
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
          <div className={`flex items-center justify-between flex-wrap gap-2 ${presetsCollapsed ? '' : 'mb-1.5'}`}>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={togglePresets}
                aria-expanded={!presetsCollapsed}
                aria-label={presetsCollapsed ? 'Expand strategy presets' : 'Collapse strategy presets'}
                className="flex items-center gap-1 text-[11px] font-bold text-zinc-400 hover:text-zinc-200 uppercase tracking-wider rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
              >
                {presetsCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                Strategy Presets
              </button>

              {/* 1-Click Fast Scalp Buttons */}
              <div className="flex items-center gap-1 flex-wrap">
                {ALL_STRATEGY_TEMPLATES.filter(t => ['short-straddle', 'short-strangle', 'iron-condor', 'bull-call-spread', 'bear-put-spread'].includes(t.key)).map(tpl => (
                  <button
                    key={tpl.key}
                    type="button"
                    onClick={() => addStrategy(tpl)}
                    className="px-2 py-0.5 text-[10px] font-bold rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-emerald-400 border border-zinc-700/80 transition-colors"
                    title={`Instant 1-click ${tpl.name} with ATM strikes`}
                  >
                    + {tpl.name.replace('Short ', '').replace(' Spread', '')}
                  </button>
                ))}
              </div>
            </div>

            {!presetsCollapsed && (
              <span className="text-[10px] text-zinc-500">
                Click any strategy card below to instantiate a new row
              </span>
            )}
          </div>
          {!presetsCollapsed && <StrategyCardGrid
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
          />}
        </div>
      </div>

      {/* Main Container: Parallel Strategy Rows */}
      <div className={embedded ? 'p-2 flex flex-col gap-2.5 w-full' : 'p-4 flex flex-col gap-4 w-full'}>
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
          sortedBaskets.map((basket, idx) => {
            const pair = `${basket.underlying}:${basket.expiry}`;
            const chain = chainData[pair];
            const rowBroker = executionBroker(basket, broker);
            const lookup = lookupCache[lkKey(rowBroker, basket.underlying, basket.expiry)];
            const expiries = expiriesMap[basket.underlying] ?? [];
            const allStrikes = chain?.strikes?.length ? chain.strikes : fallbackStrikesFor(basket.underlying as Underlying);
            const step = strikeStep(allStrikes) || DEFAULT_INDEX_STEP[basket.underlying as Underlying] || 50;
            const rowSpot = (basket.underlying === activeUnderlying && liveQuotes?.spot && liveQuotes.spot > 0)
              ? liveQuotes.spot
              : (chain?.spot ?? DEFAULT_INDEX_SPOT[basket.underlying as Underlying] ?? 24000);
            const atmStrike = nearestStrike(allStrikes, rowSpot) ?? (Math.round(rowSpot / step) * step);
            const lotSize = lookup?.lotSize ?? fallbackLotSize(basket.underlying as Underlying, rowBroker);

            return (
              <React.Fragment key={basket.id}>
                {idx === firstExitedIdx && (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Exited</span>
                    <div className="flex-1 h-px bg-zinc-800" />
                  </div>
                )}
                <MultiLegStrategyRow
                basket={basket}
                index={idx}
                broker={rowBroker as Broker}
                hasAuthenticatedBroker={hasAuthenticatedBroker}
                expiries={expiries}
                allStrikes={allStrikes}
                lotSize={lotSize}
                step={step}
                atmStrike={atmStrike}
                spot={rowSpot}
                ltpFor={leg => ltpFor(basket, leg)}
                ltpForStrike={(strk, opt, legExpiry) => {
                  const key = String(strk);
                  const side = opt === 'CE' ? 'ce' : 'pe';
                  const targetExpiry = legExpiry || basket.expiry;
                  if (basket.underlying === activeUnderlying && targetExpiry === activeExpiry) {
                    const liveLtp = liveQuotes?.strikes?.[key]?.[side]?.ltp ?? 0;
                    if (liveLtp > 0) return liveLtp;
                  }
                  if (liveQuotes?.extra?.[targetExpiry]) {
                    const extraLtp = liveQuotes.extra[targetExpiry]?.[key]?.[side]?.ltp ?? 0;
                    if (extraLtp > 0) return extraLtp;
                  }
                  const pair = `${basket.underlying}:${targetExpiry}`;
                  const chain = chainData[pair];
                  const q = chain?.quotes?.[key];
                  return (opt === 'CE' ? q?.ce : q?.pe) ?? 0;
                }}
                ivForStrike={(strk, opt, legExpiry) => {
                  const key = String(strk);
                  const targetExpiry = legExpiry || basket.expiry;
                  const pair = `${basket.underlying}:${targetExpiry}`;
                  const q = chainData[pair]?.quotes?.[key];
                  const iv = opt === 'CE' ? q?.ceIv : q?.peIv;
                  return iv && iv > 0 ? iv / 100 : 0;
                }}
                onUpdate={patch => updateBasket(basket.id, patch)}
                onDelete={() => deleteBasket(basket.id)}
                onPlace={() => placeBasket(basket.id)}
                onExit={() => exitBasket(basket.id)}
                onExitLeg={async leg => {
                  const w = legQtyWarnings[`${basket.id}:${leg.id}`];
                  if (w?.kind === 'over' && !window.confirm(
                    `Strategies on ${leg.strike} ${leg.option} track ${w.trackedQty} but the broker holds only ${w.brokerQty}: `
                    + `${w.gap} was already closed outside this tool.\n\nIf that close was THIS leg's, use Reduce instead: exiting now `
                    + `would close quantity another strategy still tracks.\n\nExit ${leg.fill?.qty ?? 0} anyway?`,
                  )) return;
                  await exitOneLeg(basket.id, leg);
                }}
                onShiftLegs={(legIds, direction, steps) => shiftLegs(basket.id, legIds, direction, steps)}
                legColumns={legColumns}
                onLegColumnsChange={changeLegColumns}
                onAddLots={params => addLotsToLeg(basket.id, params)}
                onClaimBrokerQty={legId => claimBrokerQty(basket.id, legId)}
                onReduceOutsideQty={legId => reduceOutsideQty(basket.id, legId)}
                pnlNow={pnlNow}
                onAddNewLeg={params => addNewLegToBasket(basket.id, params)}
                onScaleStrategy={multiplierDelta => scaleStrategy(basket.id, multiplierDelta)}
                scaling={!!scalingMap[basket.id]}
                placing={!!placingMap[basket.id]}
                exiting={!!exitingMap[basket.id]}
                exitingLegs={exitingLegs}
                legMargins={basketMargins[basket.id]?.legMargins}
                legMarginSource={basketMargins[basket.id]?.legMarginSource}
                basketMargin={basketMargins[basket.id]?.basketMargin}
                basketMarginSource={basketMargins[basket.id]?.basketMarginSource}
                overallMargin={basketMargins[basket.id]?.overallMargin}
                hedgeBenefit={basketMargins[basket.id]?.hedgeBenefit}
                availableFunds={rowBroker === broker ? fundsData?.available : undefined}
                legQtyWarnings={legQtyWarnings}
                allBaskets={baskets}
                />
              </React.Fragment>
            );
          })
        )}
      </div>

      {showHelp && helpMarkdown && (
        <HelpModal title="How to use Multi-Leg Focus" markdown={helpMarkdown} onClose={() => setShowHelp(false)} />
      )}

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

      {showHistoryModal && <HistoryModal onClose={() => setShowHistoryModal(false)} />}

      {showImportModal && (
        <ImportPositionsModal
          onClose={() => setShowImportModal(false)}
          baskets={baskets}
          scan={scanUntracked}
          onImport={importPositions}
        />
      )}

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
