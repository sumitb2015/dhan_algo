'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import NavBar from './NavBar';
import { Zap, RefreshCw, Shield, ShieldOff, Plus } from 'lucide-react';
import {
  OptionPanel, PositionsTable, TabTable, FundsView, pollPositionFlat,
  type LiveQuotes, type BridgeStatus, type ChainOcEntry, type Toast,
  type PnlGuardStatus, type PositionGuard, type SortState,
} from './Scalper';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { useProfitLock, ProfitLockControls } from './ProfitLock';
import { useCopyTrade, CopyTradeControls } from './CopyTrade';
import { useBrokerSelector, scalperRoute, BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import { contractMultiplier } from '@/lib/positionPnl';
import TopWeightStocks from './TopWeightStocks';
import TopIndices from './TopIndices';

// ─── Types ────────────────────────────────────────────────────────

interface BoxConfig {
  id: string;
  side: 'CE' | 'PE';
  strike: number | null;
  lots: number;
  limitPrice: string;
}

const MIN_BOXES = 2;
const MAX_BOXES = 5;

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;
const STRIKE_STEP: Record<string, number> = { NIFTY: 50, BANKNIFTY: 100, SENSEX: 100 };

// ─── Main Component ───────────────────────────────────────────────

export default function AdvancedScalper() {
  // Underlying
  const [underlying, setUnderlying] = useState<typeof UNDERLYINGS[number]>('NIFTY');
  const strikeStep = STRIKE_STEP[underlying] ?? 50;

  // Expiry
  const [expiries, setExpiries]   = useState<string[]>([]);
  const [expiry, setExpiry]       = useState('');

  // Chain data (one-time fetch per expiry for prev close + strike list)
  const [allStrikes, setAllStrikes]     = useState<number[]>([]);
  const [prevClose, setPrevClose]       = useState<Record<string, { ce: number; pe: number }>>({});
  const [chainSpot, setChainSpot]       = useState(0);
  const [prevSpot, setPrevSpot]         = useState(0);

  // Security ID map per strike — enables fast-order (no Python per order)
  const [strikeMap, setStrikeMap]   = useState<Record<string, { ceId?: string; peId?: string; ceSymbol?: string; peSymbol?: string }>>({});
  const { broker, setBroker, authenticatedBrokers } = useBrokerSelector();
  const [lotSize, setLotSize]       = useState(75);

  // Orders in flight, keyed by box id — blocks double-fire and gates the Buy/Sell
  // buttons until strikeMap is loaded (avoids a silent fallback to the slow
  // Python order path right after an expiry switch).
  const [orderPendingBoxes, setOrderPendingBoxes] = useState<Set<string>>(new Set());
  const orderInFlightRef = useRef<Set<string>>(new Set());

  // Live data: direct WebSocket to the Python bridge (HTTP polling fallback)
  const { liveQuotes, bridgeStatus, lastUpdated, transport } = useLiveOptionsWS(expiry, broker, authenticatedBrokers, underlying);

  // Trading controls
  const [orderMode, setOrderMode] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [productType, setProductType] = useState<'INTRADAY' | 'MARGIN'>('INTRADAY');

  // Top-10-by-weight stocks panel. Off by default so no equity bridge is
  // spawned unless it's actually wanted.
  const [showTop10, setShowTop10] = useState(false);
  const boxCounterRef = useRef(2);
  const [boxes, setBoxes] = useState<BoxConfig[]>([
    { id: 'box-1', side: 'CE', strike: null, lots: 1, limitPrice: '' },
    { id: 'box-2', side: 'PE', strike: null, lots: 1, limitPrice: '' },
  ]);

  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Exit-all confirm-arm
  const [confirmExitAll, setConfirmExitAll] = useState(false);
  const [exitingAll, setExitingAll] = useState(false);

  // Bottom tabs
  const [activeTab, setActiveTab]       = useState<'positions' | 'orders' | 'trades' | 'funds'>('positions');
  const [positionsData, setPositionsData] = useState<Record<string, unknown>[]>([]);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [ordersData, setOrdersData]       = useState<Record<string, unknown>[]>([]);
  const [tradesData, setTradesData]       = useState<Record<string, unknown>[]>([]);
  const [fundsData, setFundsData]         = useState<Record<string, any> | null>(null);
  const [tabLoading, setTabLoading]       = useState(false);
  const [tableSort, setTableSort] = useState<SortState>({ key: 'none', dir: 'asc' });
  const handleTableSort = useCallback((key: string) => {
    setTableSort(prev => ({ key, dir: prev.key === key && prev.dir === 'asc' ? 'desc' : 'asc' }));
  }, []);

  // P&L Guard
  const [pnlGuardStatus, setPnlGuardStatus]   = useState<PnlGuardStatus | null>(null);
  const [pnlGuardLoading, setPnlGuardLoading] = useState(false);
  const [profitTarget, setProfitTarget]       = useState('');
  const [lossLimit, setLossLimit]             = useState('');
  const [guardProductTypes, setGuardProductTypes] = useState<string[]>(['INTRADAY']);
  const [enableKillSwitch, setEnableKillSwitch]   = useState(false);
  const [settingPnl, setSettingPnl]     = useState(false);
  const [clearingPnl, setClearingPnl]   = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [guardError, setGuardError]     = useState('');

  // Per-position guards (target / SL / trailing SL)
  const [posGuards, setPosGuards] = useState<Record<string, PositionGuard>>({});
  const [closingPositions, setClosingPositions] = useState<Set<string>>(new Set());

  const positionsRef = useRef<Record<string, unknown>[]>([]);
  const posGuardsRef = useRef<Record<string, PositionGuard>>({});
  // Synchronous re-entrancy lock: React state updates are async, so the guard
  // loop and a manual Close click can both enter closePosition before either
  // sees the other's `triggered`/`closingPositions` update.
  const closingInFlightRef = useRef<Set<string>>(new Set());
  const expiryRef = useRef('');
  const appliedPositionsRef = useRef<Set<string>>(new Set());
  const lastProcessedEntryCapitalRef = useRef<number>(0);
  useEffect(() => { expiryRef.current = expiry; }, [expiry]);

  // Predefined Target & SL preset settings (% / Pts / ₹)
  const [presetMode, setPresetMode] = useState<'PERCENT' | 'POINTS' | 'PRICE'>('PERCENT');
  const [defaultTargetVal, setDefaultTargetVal] = useState('10');
  const [defaultSlVal, setDefaultSlVal] = useState('5');
  const [autoApplyGuards, setAutoApplyGuards] = useState(false);

  // Combined Multi-Leg % Presets state (remembers selection even when flat)
  const [combinedTargetPct, setCombinedTargetPct] = useState<number | null>(null);
  const [combinedSlPct, setCombinedSlPct] = useState<number | null>(null);

  // Load preset preferences from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('advanced_scalper_presets');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.presetMode) setPresetMode(parsed.presetMode);
        if (parsed.defaultTargetVal !== undefined) setDefaultTargetVal(parsed.defaultTargetVal);
        if (parsed.defaultSlVal !== undefined) setDefaultSlVal(parsed.defaultSlVal);
        if (parsed.autoApplyGuards !== undefined) setAutoApplyGuards(parsed.autoApplyGuards);
        if (parsed.combinedTargetPct !== undefined) setCombinedTargetPct(parsed.combinedTargetPct);
        if (parsed.combinedSlPct !== undefined) setCombinedSlPct(parsed.combinedSlPct);
      }
    } catch {}
  }, []);

  // Save preset preferences to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('advanced_scalper_presets', JSON.stringify({
        presetMode, defaultTargetVal, defaultSlVal, autoApplyGuards, combinedTargetPct, combinedSlPct,
      }));
    } catch {}
  }, [presetMode, defaultTargetVal, defaultSlVal, autoApplyGuards, combinedTargetPct, combinedSlPct]);

  // ─── Derived values ──────────────────────────────────────────────

  const spot = liveQuotes?.spot ?? chainSpot;
  const atm  = spot > 0 ? Math.round(spot / strikeStep) * strikeStep : 0;

  const visibleStrikes = useMemo(() => {
    if (!allStrikes.length) return allStrikes;
    if (atm === 0) return allStrikes.slice(0, 21);
    const idx = allStrikes.reduce((best, sk, i) =>
      Math.abs(sk - atm) < Math.abs(allStrikes[best] - atm) ? i : best, 0);
    return allStrikes.slice(Math.max(0, idx - 10), idx + 11);
  }, [allStrikes, atm]);

  // True once the lookup for the current expiry has returned security IDs —
  // gates ordering so a click can never silently fall back to the slow
  // Python order path (strikeMap is reset to {} on every expiry change).
  const strikesReady = Object.keys(strikeMap).length > 0;

  const secIdToStrikeSide = useMemo(() => {
    const map: Record<string, { strike: number; side: 'ce' | 'pe' }> = {};
    for (const [strike, ids] of Object.entries(strikeMap)) {
      // Dhan is the only broker with a numeric securityId; everything else
      // joins on the trading symbol.
      if (broker !== 'dhan') {
        if (ids.ceSymbol) map[ids.ceSymbol] = { strike: Number(strike), side: 'ce' };
        if (ids.peSymbol) map[ids.peSymbol] = { strike: Number(strike), side: 'pe' };
      } else {
        if (ids.ceId) map[ids.ceId] = { strike: Number(strike), side: 'ce' };
        if (ids.peId) map[ids.peId] = { strike: Number(strike), side: 'pe' };
      }
    }
    return map;
  }, [strikeMap, broker]);

  const positionJoinKey = useCallback((pos: Record<string, unknown>): string => {
    return broker !== 'dhan'
      ? String(pos.tradingSymbol ?? '')
      : String(pos.securityId ?? (pos as Record<string, unknown>).security_id ?? '');
  }, [broker]);

  // Same realizedProfit=0-on-flat-position fix as the base Scalper (Dhan quirk, see Scalper.tsx)
  const realizedFixedPositions = useMemo(() => {
    return positionsData.map(pos => {
      const netQty = Number(pos.netQty);
      const mult  = contractMultiplier(pos);

      // ── LTP fallback: Dhan's /positions v2 API omits lastTradedPrice.
      // Back-calculate from unrealizedProfit so the table shows a value
      // even before the live WS bridge enriches the row, and for positions
      // on expiries / segments the bridge isn't watching (monthly options,
      // equities, Kotak positions with ltp=0 from their API).
      const brokerLtp = Number(pos.lastTradedPrice);
      let withLtp: typeof pos = pos;
      if ((!brokerLtp || !Number.isFinite(brokerLtp)) && netQty !== 0) {
        const unrealized = Number(pos.unrealizedProfit);
        const buyAvg     = Number(pos.buyAvg);
        const sellAvg    = Number(pos.sellAvg);
        if (Number.isFinite(unrealized) && mult > 0) {
          const derivedLtp = netQty > 0
            ? buyAvg  + unrealized / (netQty  * mult)
            : sellAvg - unrealized / (Math.abs(netQty) * mult);
          if (Number.isFinite(derivedLtp) && derivedLtp > 0) {
            withLtp = { ...pos, lastTradedPrice: derivedLtp };
          }
        }
      }

      // ── realizedProfit=0-on-flat-position fix
      if (netQty !== 0) return withLtp;

      const buyQty  = Number(pos.buyQty);
      const sellQty = Number(pos.sellQty);
      const buyAvgF = Number(pos.buyAvg);
      const sellAvgF = Number(pos.sellAvg);
      if (!buyQty || !sellQty) return withLtp;

      const recomputedRealized = mult * (sellQty * sellAvgF - buyQty * buyAvgF);
      if (Number(pos.realizedProfit) === recomputedRealized) return withLtp;

      return { ...withLtp, realizedProfit: recomputedRealized };
    });
  }, [positionsData]);

  const enrichedPositions = useMemo(() => {
    if (!liveQuotes?.strikes || Object.keys(secIdToStrikeSide).length === 0)
      return realizedFixedPositions;

    return realizedFixedPositions.map(pos => {
      const secId = positionJoinKey(pos);
      const mapping = secIdToStrikeSide[secId];
      if (!mapping) return pos;

      const strikeData = liveQuotes.strikes[String(mapping.strike)];
      if (!strikeData) return pos;

      const liveLtp = strikeData[mapping.side]?.ltp ?? 0;
      if (liveLtp <= 0) return pos;

      const netQty = Number(pos.netQty);
      const buyAvg = Number(pos.buyAvg);
      const sellAvg = Number(pos.sellAvg);
      const mult = contractMultiplier(pos);
      const unrealizedProfit = netQty === 0
        ? Number(pos.unrealizedProfit)
        : netQty > 0
          ? mult * netQty * (liveLtp - buyAvg)
          : mult * Math.abs(netQty) * (sellAvg - liveLtp);

      return { ...pos, lastTradedPrice: liveLtp, unrealizedProfit };
    });
  }, [realizedFixedPositions, liveQuotes, secIdToStrikeSide, positionJoinKey]);

  const totalPnl = enrichedPositions.reduce((sum, p) =>
    sum + (Number(p.realizedProfit) || 0) + (Number(p.unrealizedProfit) || 0), 0);

  // Combined Multi-Leg Premium Tracking & Strategy Stats
  const combinedStrategyStats = useMemo(() => {
    let entryCapitalSum = 0;
    let liveCapitalSum = 0;
    let openLegsCount = 0;
    let netQtySum = 0;

    for (const pos of enrichedPositions) {
      const netQty = Number(pos.netQty);
      if (netQty === 0) continue;

      netQtySum += netQty;
      const mult = contractMultiplier(pos);
      const isLong = netQty > 0;
      const entryPrice = isLong ? Number(pos.buyAvg) : Number(pos.sellAvg);
      const liveLtp = Number(pos.lastTradedPrice) || entryPrice;
      const absQty = Math.abs(netQty);

      if (entryPrice > 0 && mult > 0) {
        entryCapitalSum += entryPrice * absQty * mult;
        liveCapitalSum += liveLtp * absQty * mult;
        openLegsCount += 1;
      }
    }

    if (openLegsCount === 0 || entryCapitalSum === 0) {
      return { entryCapitalSum: 0, liveCapitalSum: 0, decayPct: 0, openLegsCount: 0, isNetSeller: true };
    }

    const isNetSeller = netQtySum <= 0;
    const decayPct = isNetSeller
      ? ((entryCapitalSum - liveCapitalSum) / entryCapitalSum) * 100
      : ((liveCapitalSum - entryCapitalSum) / entryCapitalSum) * 100;

    return { entryCapitalSum, liveCapitalSum, decayPct, openLegsCount, isNetSeller };
  }, [enrichedPositions]);

  // Auto-calculate P&L Guard Target & SL ₹ when combinedTargetPct or combinedSlPct are selected
  useEffect(() => {
    if (combinedStrategyStats.entryCapitalSum <= 0) {
      lastProcessedEntryCapitalRef.current = 0;
      return;
    }

    const isNewTrade = lastProcessedEntryCapitalRef.current === 0 && combinedStrategyStats.entryCapitalSum > 0;
    lastProcessedEntryCapitalRef.current = combinedStrategyStats.entryCapitalSum;

    if (isNewTrade || combinedTargetPct !== null) {
      if (combinedTargetPct !== null && combinedTargetPct > 0) {
        const calcTarget = Math.round((combinedStrategyStats.entryCapitalSum * combinedTargetPct) / 100);
        if (calcTarget > 0) setProfitTarget(String(calcTarget));
      }
    }

    if (isNewTrade || combinedSlPct !== null) {
      if (combinedSlPct !== null && combinedSlPct > 0) {
        const calcLoss = Math.round((combinedStrategyStats.entryCapitalSum * combinedSlPct) / 100);
        if (calcLoss > 0) setLossLimit(String(calcLoss));
      }
    }
  }, [combinedStrategyStats.entryCapitalSum, combinedTargetPct, combinedSlPct]);

  // Position row keyed by security ID — lets each box look up its own open position/P&L
  const positionsBySecId = useMemo(() => {
    const map: Record<string, Record<string, unknown>> = {};
    for (const pos of enrichedPositions) {
      const secId = positionJoinKey(pos);
      if (secId) map[secId] = pos;
    }
    return map;
  }, [enrichedPositions, positionJoinKey]);

  // Auto-apply default target & SL to newly opened positions (runs once per position lifecycle)
  useEffect(() => {
    // Clear appliedPositionsRef for positions that have gone flat
    const openSyms = new Set(enrichedPositions.filter(p => Number(p.netQty) !== 0).map(p => String(p.tradingSymbol ?? '')));
    for (const sym of appliedPositionsRef.current) {
      if (!openSyms.has(sym)) appliedPositionsRef.current.delete(sym);
    }

    if (!autoApplyGuards) return;
    const targetVal = parseFloat(defaultTargetVal);
    const slVal = parseFloat(defaultSlVal);
    if ((isNaN(targetVal) || targetVal <= 0) && (isNaN(slVal) || slVal <= 0)) return;

    setPosGuards(prev => {
      let changed = false;
      const next = { ...prev };

      for (const pos of enrichedPositions) {
        const sym = String(pos.tradingSymbol ?? '');
        const netQty = Number(pos.netQty);
        if (!sym || netQty === 0) continue;

        // Skip if already auto-applied once for this position lifecycle
        if (appliedPositionsRef.current.has(sym)) continue;

        const existing = next[sym];
        if (!existing || (!existing.target && !existing.sl)) {
          const buyAvg = Number(pos.buyAvg);
          const sellAvg = Number(pos.sellAvg);
          const isLong = netQty > 0;
          const entryPrice = isLong ? buyAvg : sellAvg;
          if (entryPrice <= 0) continue;

          let calcTarget = existing?.target ?? '';
          let calcSl = existing?.sl ?? '';

          if (!calcTarget && !isNaN(targetVal) && targetVal > 0) {
            if (presetMode === 'PERCENT') {
              const pct = targetVal / 100;
              calcTarget = (isLong ? entryPrice * (1 + pct) : entryPrice * (1 - pct)).toFixed(2);
            } else if (presetMode === 'POINTS') {
              calcTarget = (isLong ? entryPrice + targetVal : entryPrice - targetVal).toFixed(2);
            } else {
              calcTarget = targetVal.toFixed(2);
            }
          }

          if (!calcSl && !isNaN(slVal) && slVal > 0) {
            if (presetMode === 'PERCENT') {
              const pct = slVal / 100;
              calcSl = (isLong ? entryPrice * (1 - pct) : entryPrice * (1 + pct)).toFixed(2);
            } else if (presetMode === 'POINTS') {
              calcSl = (isLong ? entryPrice - slVal : entryPrice + slVal).toFixed(2);
            } else {
              calcSl = slVal.toFixed(2);
            }
          }

          if (calcTarget || calcSl) {
            next[sym] = {
              target: calcTarget,
              sl: calcSl,
              trailEnabled: existing?.trailEnabled ?? false,
              bestPrice: existing?.bestPrice ?? 0,
              triggered: false,
            };
            changed = true;
            appliedPositionsRef.current.add(sym);
          }
        }
      }
      return changed ? next : prev;
    });
  }, [enrichedPositions, autoApplyGuards, defaultTargetVal, defaultSlVal, presetMode]);

  const boxSecId = useCallback((box: BoxConfig): string | undefined => {
    if (box.strike == null) return undefined;
    const entry = strikeMap[String(box.strike)];
    return broker !== 'dhan'
      ? entry?.[box.side === 'CE' ? 'ceSymbol' : 'peSymbol']
      : entry?.[box.side === 'CE' ? 'ceId' : 'peId'];
  }, [strikeMap, broker]);

  // ─── useEffect 1: Load expiries based on broker + underlying ───────

  useEffect(() => {
    fetch(`/api/options/expiries?underlying=${underlying}&broker=${broker}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        const data = j.data;
        if (j.success && data?.length) {
          setExpiries(data);
          setExpiry(prev => data.includes(prev) ? prev : data[0]);
        }
      })
      .catch(() => {});
  }, [broker, underlying]);

  // ─── useEffect 1a: Load prev-close whenever underlying changes ────

  useEffect(() => {
    fetch(`/api/scalper/nifty-prev-close?underlying=${underlying}`)
      .then(r => r.json())
      .then((j: { success: boolean; prevClose?: number }) => {
        if (j.success && j.prevClose) setPrevSpot(j.prevClose);
      })
      .catch(() => {});
  }, [underlying]);

  // ─── useEffect 1b: Load mount data ───────────────────────────────

  useEffect(() => {
    fetch('/api/pnl-exit')
      .then(r => r.json())
      .then((j: { success: boolean; data?: PnlGuardStatus }) => {
        if (j.success && j.data) setPnlGuardStatus(j.data as PnlGuardStatus);
      })
      .catch(() => {});
  }, []);

  // ─── useEffect 2: On expiry change — reset, fetch chain, start WS ─

  useEffect(() => {
    if (!expiry) return;

    // Reset strike selections when expiry/underlying changes; lots/side presets
    // are preserved. chainSpot must be cleared too — NIFTY and SENSEX spot
    // values differ by ~3x magnitude, so leaving the old value in place would
    // briefly show e.g. "SENSEX 25453" (new underlying's label, old
    // underlying's spot) until the chain fetch below resolves.
    setBoxes(prev => prev.map(b => ({ ...b, strike: null })));
    setAllStrikes([]);
    setPrevClose({});
    setStrikeMap({});   // liveQuotes reset is handled inside useLiveOptionsWS
    setChainSpot(0);

    fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}&broker=${broker}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { chain: { oc?: Record<string, ChainOcEntry> }; spot: number } }) => {
        if (!j.success || !j.data?.chain?.oc) return;
        const oc = j.data.chain.oc;
        const strikes = Object.keys(oc).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
        setAllStrikes(strikes);

        const pc: Record<string, { ce: number; pe: number }> = {};
        for (const [sk, entry] of Object.entries(oc)) {
          pc[sk] = {
            ce: entry.ce?.previous_close ?? 0,
            pe: entry.pe?.previous_close ?? 0,
          };
        }
        setPrevClose(pc);

        const spotPrice = j.data.spot ?? 0;
        if (spotPrice > 0) setChainSpot(spotPrice);

        // Default every box's strike to ATM
        if (strikes.length) {
          const atmTarget = spotPrice > 0 ? Math.round(spotPrice / strikeStep) * strikeStep : 0;
          const nearest = atmTarget > 0
            ? strikes.reduce((prev, cur) => Math.abs(cur - atmTarget) < Math.abs(prev - atmTarget) ? cur : prev)
            : strikes[Math.floor(strikes.length / 2)];
          setBoxes(prev => prev.map(b => ({ ...b, strike: nearest })));
        }
      })
      .catch(() => {});

    // Start a WS bridge for every authenticated broker concurrently — each
    // runs independently on its own port/files (see useLiveOptionsWS), so
    // switching the broker selector never spawns or kills a process.
    for (const b of authenticatedBrokers) {
      fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', underlying, expiry, numStrikes: 30, broker: b }),
      }).catch(() => {});
    }

    // Cleanup: stop every started bridge when expiry/underlying changes or component unmounts
    return () => {
      fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop', brokers: authenticatedBrokers }),
      }).catch(() => {});
    };
  }, [expiry, underlying, authenticatedBrokers]);

  // Start the shared Nifty-50 equity bridge when the Top 10 panel is switched
  // on. The route is idempotent — it returns "Bridge already running" without
  // spawning when a live PID exists — so this is safe to fire on every enable.
  //
  // Deliberately NO stop on toggle-off or unmount, unlike the options bridges
  // above: this same process feeds the Live Dashboard page via the same route,
  // so killing it here would silently break that page. Hiding the panel stops
  // its polling; the bridge stays up and remains stoppable from Live Dashboard.
  useEffect(() => {
    if (!showTop10) return;
    fetch('/api/live-equity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    }).catch(() => {});
  }, [showTop10]);

  // Re-resolves strikeMap (Dhan securityId / Zerodha tradingsymbol per strike)
  // whenever the expiry OR the selected broker changes. Order routing is
  // still broker-specific — only the live-quotes WS bridges (started above)
  // run concurrently for both brokers regardless of selection.
  useEffect(() => {
    if (!expiry) return;

    const requestedExpiry = expiry;
    const lookupUrl = `${scalperRoute(broker, 'lookup')}?underlying=${underlying}&expiry=${expiry}`;
    fetch(lookupUrl)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { lotSize: number; strikes: Record<string, { ceId?: string; peId?: string; ceSymbol?: string; peSymbol?: string }> } }) => {
        if (requestedExpiry !== expiryRef.current) return;
        if (j.success && j.data) {
          setStrikeMap(j.data.strikes);
          setLotSize(j.data.lotSize);
        }
      })
      .catch(() => {});
  }, [expiry, broker, underlying]);

  // Live quotes arrive via useLiveOptionsWS (direct WebSocket push from the
  // Python bridge, rAF-coalesced; falls back to 100ms HTTP polling if the WS
  // is unavailable). The old useEffect-3 poll loop lived here.

  // ─── useEffect 4: Poll positions/orders/trades every 5s ──────────

  const fetchTabData = useCallback(() => {
    setTabLoading(true);
    fetch(scalperRoute(broker, 'all'))
      .then(r => r.json())
      .then((j: { success: boolean; positions?: Record<string, unknown>[]; positionsError?: string | null; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[]; funds?: Record<string, any>; pnl_guard?: any }) => {
        if (j.success) {
          setPositionsData(j.positions ?? []);
          setPositionsError(j.positionsError ?? null);
          setOrdersData(j.orders ?? []);
          setTradesData(j.trades ?? []);
          setFundsData(j.funds ?? null);
          setPnlGuardStatus(j.pnl_guard ?? null);
        }
      })
      .catch(() => {})
      .finally(() => setTabLoading(false));
  }, [broker]);

  const pollTabData = useCallback(() => {
    fetch(scalperRoute(broker, 'poll'))
      .then(r => r.json())
      .then((j: { success: boolean; positions?: Record<string, unknown>[]; positionsError?: string | null; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[] }) => {
        if (j.success) {
          setPositionsData(j.positions ?? []);
          setPositionsError(j.positionsError ?? null);
          setOrdersData(j.orders ?? []);
          setTradesData(j.trades ?? []);
        }
      })
      .catch(() => {});
  }, [broker]);

  useEffect(() => {
    fetchTabData();
    const id = setInterval(pollTabData, 5000);
    return () => clearInterval(id);
  }, [fetchTabData, pollTabData]);

  useEffect(() => { positionsRef.current = enrichedPositions; }, [enrichedPositions]);
  useEffect(() => { posGuardsRef.current = posGuards; }, [posGuards]);

  // Clear stale data immediately on broker switch so a Dhan position is
  // never displayed or acted on as if it belonged to Zerodha (or vice versa).
  useEffect(() => {
    setPositionsData([]);
    setOrdersData([]);
    setTradesData([]);
    setFundsData(null);
    setStrikeMap({});
  }, [broker]);

  // ─── Toast helper ─────────────────────────────────────────────────

  const addToast = useCallback((type: 'success' | 'error', message: string, detail?: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, type, message, detail }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), type === 'error' ? 7000 : 3000);
  }, []);

  // ─── Box management ─────────────────────────────────────────────

  const updateBox = useCallback((id: string, patch: Partial<BoxConfig>) => {
    setBoxes(prev => prev.map(b => (b.id === id ? { ...b, ...patch } : b)));
  }, []);

  const addBox = useCallback(() => {
    setBoxes(prev => {
      if (prev.length >= MAX_BOXES) return prev;
      const ceCount = prev.filter(b => b.side === 'CE').length;
      const peCount = prev.filter(b => b.side === 'PE').length;
      const side: 'CE' | 'PE' = ceCount <= peCount ? 'CE' : 'PE';
      boxCounterRef.current += 1;
      return [...prev, {
        id: `box-${boxCounterRef.current}`,
        side,
        strike: atm > 0 ? atm : null,
        lots: 1,
        limitPrice: '',
      }];
    });
  }, [atm]);

  const removeBox = useCallback((id: string) => {
    setBoxes(prev => {
      if (prev.length <= MIN_BOXES) return prev;
      const box = prev.find(b => b.id === id);
      if (!box) return prev;

      const secId = boxSecId(box);
      // Fail safe: if the box has a strike but the strike→securityId map hasn't
      // loaded yet (e.g. right after an expiry change), we can't verify whether
      // an open position backs this box — block removal instead of assuming flat.
      if (box.strike != null && !secId) {
        addToast('error', 'Cannot remove box', 'Strike data still loading — try again in a moment');
        return prev;
      }
      const pos = secId ? positionsBySecId[secId] : undefined;
      if (pos && Number(pos.netQty) !== 0) {
        addToast('error', 'Cannot remove box', 'Square off the open position first');
        return prev;
      }

      return prev.filter(b => b.id !== id);
    });
  }, [boxSecId, positionsBySecId, addToast]);

  // Pre-fill an existing empty box (or add a new one) from an open position so the
  // user can scale in (same strike) or add a hedge (new strike) via the order panel.
  const handleAddLeg = useCallback((pos: Record<string, unknown>) => {
    const sym = String(pos.tradingSymbol ?? '');
    let match: { strike: number; side: 'CE' | 'PE' } | null = null;
    for (const [strikeStr, entry] of Object.entries(strikeMap)) {
      if (entry.ceSymbol === sym) { match = { strike: Number(strikeStr), side: 'CE' }; break; }
      if (entry.peSymbol === sym) { match = { strike: Number(strikeStr), side: 'PE' }; break; }
    }
    if (!match) { addToast('error', 'Could not match position to a strike', sym); return; }
    const { strike, side } = match;

    const emptyBox = boxes.find(b => b.side === side && b.strike == null);
    if (emptyBox) {
      updateBox(emptyBox.id, { strike });
      addToast('success', `${side} panel set to ${strike}`, 'Pick Buy/Sell and lots to add this leg');
      return;
    }
    if (boxes.length >= MAX_BOXES) {
      addToast('error', 'Cannot add leg', `Max ${MAX_BOXES} boxes reached — remove one first`);
      return;
    }
    boxCounterRef.current += 1;
    setBoxes(prev => [...prev, { id: `box-${boxCounterRef.current}`, side, strike, lots: 1, limitPrice: '' }]);
    addToast('success', `${side} panel set to ${strike}`, 'Pick Buy/Sell and lots to add this leg');
  }, [strikeMap, boxes, updateBox, addToast]);

  // ─── placeOrder ───────────────────────────────────────────────────

  const placeOrder = useCallback(async (boxId: string, side: 'BUY' | 'SELL') => {
    const box = boxes.find(b => b.id === boxId);
    if (!box || !box.strike || !expiry) return;
    if (orderInFlightRef.current.has(boxId)) return;

    if (orderMode === 'LIMIT') {
      const priceNum = Number(box.limitPrice);
      if (!box.limitPrice || isNaN(priceNum) || priceNum <= 0) {
        addToast('error', 'Enter a valid limit price');
        return;
      }
    }

    orderInFlightRef.current.add(boxId);
    setOrderPendingBoxes(prev => new Set([...prev, boxId]));

    try {
      const entry = strikeMap[String(box.strike)];
      let res: Response;
      if (broker !== 'dhan') {
        // Every non-Dhan broker orders by trading symbol (Dhan is the only one
        // with a numeric securityId), so they share one request shape and only
        // the exchange spelling differs.
        const symbol = entry?.[box.side === 'CE' ? 'ceSymbol' : 'peSymbol'];
        if (!symbol) {
          addToast('error', `${side} ${box.side} failed`, `${BROKER_LABELS[broker]} strike data still loading`);
          return;
        }
        const exchange = broker === 'kotak'
          ? (underlying === 'SENSEX' ? 'bse_fo' : 'nse_fo')
          : (underlying === 'SENSEX' ? 'BFO' : 'NFO');
        res = await fetch(scalperRoute(broker, 'order'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tradingsymbol: symbol,
            quantity: box.lots * lotSize,
            side,
            orderType: orderMode,
            exchange,
            product: productType === 'MARGIN' ? 'NRML' : 'MIS',
            ...(orderMode === 'LIMIT' ? { price: Number(box.limitPrice) } : {}),
          }),
        });
      } else {
        const secId = entry?.[box.side === 'CE' ? 'ceId' : 'peId'];
        if (secId) {
          res = await fetch('/api/scalper/fast-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              securityId: secId,
              quantity: box.lots * lotSize,
              side,
              orderType: orderMode,
              exchangeSegment: underlying === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO',
              productType,
              ...(orderMode === 'LIMIT' ? { price: Number(box.limitPrice) } : {}),
            }),
          });
        } else {
          const body: Record<string, unknown> = {
            underlying, expiry, strike: box.strike, option: box.side, side, lots: box.lots, type: orderMode,
          };
          if (orderMode === 'LIMIT') body.price = Number(box.limitPrice);
          res = await fetch('/api/scalper/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        }
      }

      const j = await res.json() as { success: boolean; order_id?: string; error?: string };
      if (j.success) {
        addToast('success', `${side} ${box.side} placed`, `ID: ${j.order_id}`);
        setTimeout(fetchTabData, 1000);
      } else {
        addToast('error', `${side} ${box.side} failed`, j.error ?? 'Unknown error');
      }
    } catch (e) {
      addToast('error', 'Network error', String(e));
    } finally {
      orderInFlightRef.current.delete(boxId);
      setOrderPendingBoxes(prev => { const s = new Set(prev); s.delete(boxId); return s; });
    }
  }, [boxes, expiry, underlying, lotSize, strikeMap, orderMode, productType, broker, addToast, fetchTabData]);

  // ─── Per-position close ───────────────────────────────────────────

  // ok=false means the close could not be confirmed (order failed / errored) —
  // callers that chain further actions (e.g. strike shift) MUST NOT proceed as
  // if the position were closed. qty is the signed live netQty seen right
  // before closing (0 if already flat), for sizing a follow-up order off the
  // real prior exposure rather than a possibly-stale value passed in.
  const closePosition = useCallback(async (pos: Record<string, unknown>, reason: string, opts?: { verifyFlat?: boolean }): Promise<{ ok: boolean; qty: number }> => {
    const sym = String(pos.tradingSymbol ?? '');
    const fallbackSecId = String(pos.securityId ?? pos.security_id ?? '');

    if (!sym || !fallbackSecId) {
      addToast('error', `Cannot close ${sym || 'position'}`, 'Missing security ID');
      return { ok: false, qty: 0 };
    }

    // Prevent double-fire while order is in flight
    if (closingInFlightRef.current.has(sym)) return { ok: false, qty: 0 };
    closingInFlightRef.current.add(sym);
    setPosGuards(prev => prev[sym] ? { ...prev, [sym]: { ...prev[sym], triggered: true } } : prev);
    setClosingPositions(prev => new Set([...prev, sym]));

    try {
      // Exchange is derived from the POSITION itself (not the currently-selected
      // underlying) — a stale position from a different underlying than what's
      // selected in the UI must still close on its own exchange.
      let liveNetQty = 0;
      let liveSecId = fallbackSecId;
      let liveExchange = String(pos.exchangeSegment ?? pos.exchange ??
        (broker === 'kotak' ? 'nse_fo' : broker === 'zerodha' ? 'NFO' : 'NSE_FNO'));
      try {
        const posUrl = scalperRoute(broker, 'positions');
        const posRes = await fetch(posUrl);
        const posJson = await posRes.json() as { success: boolean; data?: Record<string, unknown>[] };
        if (posJson.success && posJson.data) {
          const match = posJson.data.find(p => String(p.tradingSymbol) === sym);
          if (match) {
            liveNetQty = Number(match.netQty);
            liveSecId = String(match.securityId ?? match.security_id ?? fallbackSecId);
            liveExchange = String(match.exchangeSegment ?? match.exchange ?? liveExchange);
          }
        }
      } catch {
        liveNetQty = Number(pos.netQty);
      }

      if (liveNetQty === 0) {
        addToast('success', `${sym} already flat`, `(${reason})`);
        setPosGuards(prev => { const next = { ...prev }; delete next[sym]; return next; });
        fetchTabData();
        return { ok: true, qty: 0 };
      }

      const side = liveNetQty > 0 ? 'SELL' : 'BUY';
      const qty = Math.abs(liveNetQty);

      const orderUrl = broker === 'dhan' ? '/api/scalper/fast-order' : scalperRoute(broker, 'order');
      const res = await fetch(orderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          // Dhan is the only broker that closes by numeric securityId; the rest
          // close by trading symbol.
          broker !== 'dhan'
            ? { tradingsymbol: sym, quantity: qty, side, orderType: 'MARKET', exchange: liveExchange }
            : { securityId: liveSecId, quantity: qty, side, orderType: 'MARKET', exchangeSegment: liveExchange },
        ),
      });
      const j = await res.json() as { success: boolean; order_id?: string; error?: string };
      if (j.success) {
        // A MARKET order accepted by the broker isn't necessarily filled — for
        // callers that chain a follow-up open (strike shift), poll live
        // positions briefly to confirm it actually went flat before reporting
        // success, so a post-acceptance rejection can't lead to a doubled
        // position. Skipped by default: the SL/target/manual-close paths that
        // use closePosition constantly during scalping need the fast return.
        if (opts?.verifyFlat) {
          const confirmedFlat = await pollPositionFlat(broker, sym);
          if (!confirmedFlat) {
            addToast('error', `Could not confirm ${sym} closed`, 'Order accepted but position still shows open — check manually');
            setPosGuards(prev => prev[sym] ? { ...prev, [sym]: { ...prev[sym], triggered: false } } : prev);
            return { ok: false, qty: liveNetQty };
          }
        }
        addToast('success', `Closed ${sym} (${reason})`, `${qty} qty · ID: ${j.order_id}`);
        // Drop the guard entirely — leaving it would carry stale bestPrice /
        // trailEnabled into a future re-entry on the same symbol.
        setPosGuards(prev => { const next = { ...prev }; delete next[sym]; return next; });
        setTimeout(fetchTabData, 800);
        return { ok: true, qty: liveNetQty };
      } else {
        addToast('error', `Close failed: ${sym}`, j.error ?? 'Unknown error');
        setPosGuards(prev => prev[sym] ? { ...prev, [sym]: { ...prev[sym], triggered: false } } : prev);
        return { ok: false, qty: liveNetQty };
      }
    } catch (e) {
      addToast('error', 'Network error closing position', String(e));
      setPosGuards(prev => prev[sym] ? { ...prev, [sym]: { ...prev[sym], triggered: false } } : prev);
      return { ok: false, qty: 0 };
    } finally {
      closingInFlightRef.current.delete(sym);
      setClosingPositions(prev => { const s = new Set(prev); s.delete(sym); return s; });
    }
  }, [broker, addToast, fetchTabData]);

  // ─── Shift Strike Up/Down (Auto-close active position & shift to new strike) ───
  const handleShiftStrike = useCallback(async (boxId: string, direction: 'UP' | 'DOWN') => {
    const box = boxes.find(b => b.id === boxId);
    if (!box || !box.strike || !visibleStrikes.length) return;
    if (orderInFlightRef.current.has(boxId)) return;

    const strikesToSearch = allStrikes.length ? allStrikes : visibleStrikes;
    const sorted = [...strikesToSearch].sort((a, b) => a - b);
    const currIdx = sorted.indexOf(box.strike);
    let targetIdx = -1;

    if (currIdx === -1) {
      // box.strike isn't in the list (stale/out-of-range) — fall back to a
      // direct step lookup instead of a neighbor index.
      const target = direction === 'UP' ? box.strike + strikeStep : box.strike - strikeStep;
      if (sorted.includes(target)) targetIdx = sorted.indexOf(target);
    } else if (direction === 'UP') {
      if (currIdx < sorted.length - 1) targetIdx = currIdx + 1;
    } else {
      if (currIdx > 0) targetIdx = currIdx - 1;
    }

    if (targetIdx === -1) {
      addToast('error', `Cannot shift ${direction.toLowerCase()}`, `No ${direction.toLowerCase()} strike available`);
      return;
    }

    const newStrike = sorted[targetIdx];

    // Check open position for this box. If strikeMap has no entry for the
    // CURRENT strike, we cannot reliably tell whether a live position exists
    // there (chain still loading, strike outside the fetched range, etc.) —
    // abort rather than silently treating it as flat, which would leave a
    // real position unmanaged while the box moves on to the new strike.
    if (!strikeMap[String(box.strike)]) {
      addToast('error', 'Cannot shift strike', `Position data for ${box.strike} ${box.side} not loaded yet — try again shortly`);
      return;
    }
    const secId = boxSecId(box);
    const pos = secId ? positionsBySecId[secId] : undefined;

    if (pos && Number(pos.netQty) !== 0) {
      orderInFlightRef.current.add(boxId);
      setOrderPendingBoxes(prev => new Set([...prev, boxId]));

      try {
        addToast('success', `Shifting ${box.strike} ${box.side} → ${newStrike} ${box.side}`, `Closing active position first...`);
        // 1. Close current position. closePosition re-fetches live positions
        // itself, so closeResult.qty is the real quantity that was open — not
        // the possibly-stale pos.netQty snapshot.
        const closeResult = await closePosition(pos, 'Strike Shift', { verifyFlat: true });
        if (!closeResult.ok) {
          // Close could not be confirmed — do NOT touch the box's strike or
          // open a new leg, or we'd risk both the old and new position open at
          // once. closePosition already toasted the error.
          addToast('error', 'Shift aborted', `${box.strike} ${box.side} close was not confirmed — position left untouched`);
          return;
        }
        if (closeResult.qty === 0) {
          // Already flat by the time we got here — nothing to roll, just move the box.
          updateBox(boxId, { strike: newStrike, limitPrice: '' });
          addToast('success', `${box.strike} ${box.side} was already flat`, `Strike moved to ${newStrike} ${box.side} — no order placed`);
          return;
        }

        const sideToOpen: 'BUY' | 'SELL' = closeResult.qty < 0 ? 'SELL' : 'BUY';
        const openLots = Math.max(1, Math.round(Math.abs(closeResult.qty) / lotSize));

        // 2. Update box strike
        updateBox(boxId, { strike: newStrike, limitPrice: '' });

        // 3. Place order on new strike
        const newSecEntry = strikeMap[String(newStrike)];
        let res: Response;
        if (broker !== 'dhan') {
          const symbol = newSecEntry?.[box.side === 'CE' ? 'ceSymbol' : 'peSymbol'];
          if (!symbol) {
            addToast('error', `Shift to ${newStrike} failed`, `Strike symbol data loading`);
            return;
          }
          const exchange = broker === 'kotak'
            ? (underlying === 'SENSEX' ? 'bse_fo' : 'nse_fo')
            : (underlying === 'SENSEX' ? 'BFO' : 'NFO');
          res = await fetch(scalperRoute(broker, 'order'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tradingsymbol: symbol,
              quantity: openLots * lotSize,
              side: sideToOpen,
              orderType: 'MARKET',
              exchange,
              product: productType === 'MARGIN' ? 'NRML' : 'MIS',
            }),
          });
        } else {
          const secId = newSecEntry?.[box.side === 'CE' ? 'ceId' : 'peId'];
          if (secId) {
            res = await fetch('/api/scalper/fast-order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                securityId: secId,
                quantity: openLots * lotSize,
                side: sideToOpen,
                orderType: 'MARKET',
                exchangeSegment: underlying === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO',
                productType,
              }),
            });
          } else {
            res = await fetch('/api/scalper/order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                underlying, expiry, strike: newStrike, option: box.side, side: sideToOpen, lots: openLots, type: 'MARKET',
              }),
            });
          }
        }

        const j = await res.json() as { success: boolean; order_id?: string; error?: string };
        if (j.success) {
          addToast('success', `Shift complete: ${newStrike} ${box.side}`, `${sideToOpen} ${openLots} lot(s) placed (ID: ${j.order_id})`);
          setTimeout(fetchTabData, 1000);
        } else {
          addToast('error', `New strike order failed`, j.error ?? 'Unknown error');
        }
      } catch (e) {
        addToast('error', 'Shift failed', String(e));
      } finally {
        orderInFlightRef.current.delete(boxId);
        setOrderPendingBoxes(prev => { const s = new Set(prev); s.delete(boxId); return s; });
      }
    } else {
      // No active position: simply update strike
      updateBox(boxId, { strike: newStrike, limitPrice: '' });
      addToast('success', `Strike shifted to ${newStrike} ${box.side}`);
    }
  }, [boxes, visibleStrikes, allStrikes, strikeStep, boxSecId, positionsBySecId, lotSize, updateBox, strikeMap, broker, underlying, productType, expiry, closePosition, addToast, fetchTabData]);

  // ─── Client-side profit lock (total P&L floor) ────────────────────

  const exitAllForLock = useCallback(async (reason: string) => {
    const open = positionsRef.current.filter(p => Number(p.netQty) !== 0);
    await Promise.allSettled(open.map(pos => closePosition(pos, reason)));
    setTimeout(fetchTabData, 1000);
  }, [closePosition, fetchTabData]);

  const hasOpenPositions = useMemo(
    () => enrichedPositions.some(p => Number(p.netQty) !== 0),
    [enrichedPositions]);

  const profitLock = useProfitLock({
    totalPnl,
    hasOpenPositions,
    exitAll: exitAllForLock,
    notify: addToast,
    storageKey: 'profit_lock_v1',
  });

  const copyTrade = useCopyTrade(addToast);

  const handleExitAll = useCallback(async () => {
    if (!confirmExitAll) {
      setConfirmExitAll(true);
      setTimeout(() => setConfirmExitAll(false), 3000);
      return;
    }
    setExitingAll(true);
    setConfirmExitAll(false);
    try {
      if (broker !== 'dhan') {
        const label = BROKER_LABELS[broker];
        const res = await fetch(scalperRoute(broker, 'exit-all'), { method: 'POST' });
        const data = await res.json() as { success: boolean; closed: string[]; errors: string[] };
        if (data.success) {
          addToast('success', `All ${label} positions liquidated.${data.closed.length ? ` (${data.closed.join(', ')})` : ''}`);
        } else {
          addToast('error', `${label} exit failed`, data.errors.join('; ') || 'Unknown error');
        }
      } else {
        const res = await fetch('/api/exit-all', { method: 'POST' });
        const data = await res.json();
        if (data.broker_exit) {
          const killed = data.killed?.length ?? 0;
          const fallback = data.trigger_fallback?.length ?? 0;
          const detail = killed > 0 ? ` ${killed} strategy process${killed === 1 ? '' : 'es'} terminated.` : '';
          const fb = fallback > 0 ? ` ${fallback} sent graceful shutdown.` : '';
          addToast('success', `All positions liquidated at broker.${detail}${fb}`);
        } else {
          addToast('error', data.error || 'Broker exit failed — check Dhan account manually.');
        }
      }
    } catch (e) {
      addToast('error', 'Network error calling exit-all API.', String(e));
    } finally {
      setExitingAll(false);
      setTimeout(fetchTabData, 1000);
    }
  }, [confirmExitAll, broker, addToast, fetchTabData]);

  const handleGuardChange = useCallback((sym: string, field: 'target' | 'sl', value: string) => {
    setPosGuards(prev => {
      const existing: PositionGuard = prev[sym] ?? { target: '', sl: '', trailEnabled: false, bestPrice: 0, triggered: false };
      return {
        ...prev,
        [sym]: { ...existing, [field]: value, triggered: false },
      };
    });
  }, []);

  const handleTrailToggle = useCallback((sym: string) => {
    setPosGuards(prev => {
      const existing: PositionGuard = prev[sym] ?? { target: '', sl: '', trailEnabled: false, bestPrice: 0, triggered: false };
      return {
        ...prev,
        [sym]: { ...existing, trailEnabled: !existing.trailEnabled, bestPrice: 0, triggered: false },
      };
    });
  }, []);

  // Guard monitoring — 1s interval reads LTP from positions data and fires closes
  useEffect(() => {
    const id = setInterval(() => {
      const guards = posGuardsRef.current;
      const positions = positionsRef.current;
      const peakUpdates: Record<string, number> = {};

      for (const pos of positions) {
        const sym = String(pos.tradingSymbol ?? '');
        const guard = guards[sym];
        if (!guard || guard.triggered) continue;

        const ltp = Number(pos.lastTradedPrice);
        const netQty = Number(pos.netQty);
        if (ltp <= 0 || netQty === 0) continue;

        const isLong = netQty > 0;

        const targetNum = parseFloat(guard.target);
        if (!isNaN(targetNum) && targetNum > 0) {
          if ((isLong && ltp >= targetNum) || (!isLong && ltp <= targetNum)) {
            closePosition(pos, 'Target hit');
            continue;
          }
        }

        if (guard.trailEnabled) {
          const slNum = parseFloat(guard.sl);
          if (!isNaN(slNum) && slNum > 0) {
            const entryPrice = isLong ? Number(pos.buyAvg) : Number(pos.sellAvg);
            if (entryPrice > 0) {
              const initialRisk = Math.abs(slNum - entryPrice);
              const currentBest = guard.bestPrice;
              const newBest = currentBest === 0
                ? ltp
                : (isLong ? Math.max(currentBest, ltp) : Math.min(currentBest, ltp));
              if (newBest !== currentBest) peakUpdates[sym] = newBest;

              const effectiveBest = peakUpdates[sym] ?? currentBest;
              if (effectiveBest > 0) {
                const trailSLPrice = isLong
                  ? effectiveBest - initialRisk
                  : effectiveBest + initialRisk;
                // Only enforce the trail once it's tighter than the original SL;
                // otherwise fall back to the original SL so the position stays protected.
                const trailActive = isLong ? trailSLPrice > slNum : trailSLPrice < slNum;
                if (trailActive) {
                  if ((isLong && ltp <= trailSLPrice) || (!isLong && ltp >= trailSLPrice)) {
                    closePosition(pos, 'Trail SL hit');
                    continue;
                  }
                } else if ((isLong && ltp <= slNum) || (!isLong && ltp >= slNum)) {
                  closePosition(pos, 'SL hit');
                  continue;
                }
              }
            }
          }
        } else {
          const slNum = parseFloat(guard.sl);
          if (!isNaN(slNum) && slNum > 0) {
            if ((isLong && ltp <= slNum) || (!isLong && ltp >= slNum)) {
              closePosition(pos, 'SL hit');
              continue;
            }
          }
        }
      }

      if (Object.keys(peakUpdates).length > 0) {
        setPosGuards(prev => {
          const next = { ...prev };
          for (const [s, best] of Object.entries(peakUpdates)) {
            if (next[s]) next[s] = { ...next[s], bestPrice: best };
          }
          return next;
        });
      }
    }, 1000);

    return () => clearInterval(id);
  }, [closePosition]);

  // ─── P&L Guard ────────────────────────────────────────────────────

  const fetchPnlGuardStatus = useCallback(async () => {
    setPnlGuardLoading(true);
    try {
      const res = await fetch('/api/pnl-exit');
      const j = await res.json();
      // A failed/empty GET is usually transient — don't wipe a known-good state
      // to null just because this one poll came back empty.
      if (j.success) setPnlGuardStatus(j.data ?? null);
    } catch {
      // ignore — keep showing the last known state
    } finally {
      setPnlGuardLoading(false);
    }
  }, []);

  // After a successful Set, Dhan's own GET can take several seconds to reflect
  // the change. Poll a few times before trusting a "not configured yet"
  // response — otherwise the optimistic ACTIVE badge flips back to NOT SET
  // a couple seconds later even though the guard really was applied.
  const reconcilePnlGuardAfterSet = useCallback((attempt = 1) => {
    setTimeout(async () => {
      try {
        const res = await fetch('/api/pnl-exit');
        const j = await res.json();
        const hasConfig = j.success && j.data && (Number(j.data.profit) > 0 || Math.abs(Number(j.data.loss)) > 0);
        if (hasConfig || attempt >= 4) {
          if (j.success) setPnlGuardStatus(j.data ?? null);
          return;
        }
        reconcilePnlGuardAfterSet(attempt + 1);
      } catch {
        if (attempt < 4) reconcilePnlGuardAfterSet(attempt + 1);
      }
    }, 1500);
  }, []);

  const handleSetPnl = async () => {
    // /api/pnl-exit is Dhan's native account-level guard only — no Zerodha
    // equivalent exists. The UI already hides these controls for Zerodha;
    // this is a defense-in-depth guard against calling it anyway.
    if (broker !== 'dhan') { addToast('error', 'P&L Guard is Dhan-only'); return; }
    // The field collects a positive loss magnitude ("exit when loss reaches ₹X"),
    // but Dhan's API rejects lossValue > 0 ("Loss Amount Cannot Be Greater Than
    // Zero") — it wants the P&L level itself, so the magnitude is sent negated.
    const p = Math.abs(parseFloat(profitTarget)) || 0;
    const l = Math.abs(parseFloat(lossLimit)) || 0;
    if (p <= 0 && l <= 0) { addToast('error', 'Enter a profit target or loss limit'); return; }
    setGuardError('');
    setSettingPnl(true);
    try {
      const res = await fetch('/api/pnl-exit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profitValue: p, lossValue: l > 0 ? -l : 0, productTypes: guardProductTypes, enableKillSwitch }),
      });
      const j = await res.json();
      if (j.success) {
        addToast('success', 'P&L Guard set');
        // Reflect the just-applied config immediately — Dhan's GET can lag a beat
        // behind the POST, so the ACTIVE badge shouldn't depend on winning that race.
        setPnlGuardStatus({
          pnlExitStatus: 'ACTIVE',
          profit: p > 0 ? p : undefined,
          loss: l > 0 ? l : undefined,
          productType: guardProductTypes,
          enableKillSwitch,
        });
        // Reconcile with the broker's actual state after it's had a moment to
        // persist the change, rather than racing it and clobbering the
        // optimistic ACTIVE state with a stale response.
        reconcilePnlGuardAfterSet();
      } else {
        const msg = j.error || 'Failed to set P&L Guard';
        addToast('error', 'Failed to set P&L Guard', j.error);
        setGuardError(msg);
      }
    } catch (e) {
      addToast('error', 'Network error', String(e));
      setGuardError(String(e));
    } finally {
      setSettingPnl(false);
    }
  };

  const handleClearPnl = async () => {
    if (broker !== 'dhan') { addToast('error', 'P&L Guard is Dhan-only'); return; }
    if (!confirmClear) { setConfirmClear(true); setTimeout(() => setConfirmClear(false), 3000); return; }
    setClearingPnl(true);
    try {
      const res = await fetch('/api/pnl-exit', { method: 'DELETE' });
      const j = await res.json();
      if (j.success) { addToast('success', 'P&L Guard cleared'); setPnlGuardStatus(null); }
      else addToast('error', 'Failed to clear P&L Guard', j.error);
    } catch (e) {
      addToast('error', 'Network error', String(e));
    } finally {
      setClearingPnl(false);
      setConfirmClear(false);
    }
  };

  // ─── JSX ─────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">

      {/* Fixed toast overlay */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={`pointer-events-auto px-4 py-3 rounded-xl border text-sm font-semibold
            shadow-2xl max-w-xs
            ${t.type === 'success'
              ? 'bg-emerald-900/95 border-emerald-500/40 text-emerald-200'
              : 'bg-rose-900/95 border-rose-500/40 text-rose-200'}`}>
            <p>{t.message}</p>
            {t.detail && <p className="text-xs opacity-70 mt-0.5 font-mono">{t.detail}</p>}
          </div>
        ))}
      </div>

      {/* Sticky header */}
      <div className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-4 py-2">
        <div className="flex items-center justify-between gap-3 flex-nowrap overflow-x-auto">
          <div className="flex items-center gap-3 flex-nowrap shrink-0">
            <div className="shrink-0 whitespace-nowrap">
              <h1 className="text-sm font-bold text-white tracking-tight flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-yellow-400" />
                {underlying} ADVANCED SCALPER
              </h1>
              <p className="text-xs font-bold font-mono tabular-nums text-zinc-200">
                {spot > 0
                  ? `${underlying} ${spot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : 'Loading…'}
              </p>
            </div>
            <div className="shrink-0"><NavBar /></div>
          </div>
          <div className="flex items-center gap-2 flex-nowrap shrink-0">
            {/* Broker selector — only shown when more than one broker is authenticated */}
            {authenticatedBrokers.length > 1 && (
              <select
                value={broker}
                onChange={e => setBroker(e.target.value as Broker)}
                className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold
                           rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 w-[88px] shrink-0"
              >
                {authenticatedBrokers.map(b => (
                  <option key={b} value={b}>{BROKER_LABELS[b]}</option>
                ))}
              </select>
            )}

            {/* Underlying selector — fixed width so the row layout doesn't shift
                when switching between underlyings of different name lengths
                (e.g. NIFTY vs BANKNIFTY) */}
            <select value={underlying} onChange={e => setUnderlying(e.target.value as typeof UNDERLYINGS[number])}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold
                         rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 w-[104px] shrink-0">
              {UNDERLYINGS.map(sym => <option key={sym} value={sym}>{sym}</option>)}
            </select>

            {/* Expiry selector */}
            <select value={expiry} onChange={e => setExpiry(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold
                         rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 shrink-0">
              {expiries.map(ex => <option key={ex} value={ex}>{ex}</option>)}
            </select>

            {/* Add Box */}
            <button onClick={addBox} disabled={boxes.length >= MAX_BOXES}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold rounded-lg
                         border border-emerald-600/40 bg-emerald-900/30 text-emerald-400
                         hover:bg-emerald-800/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed shrink-0 whitespace-nowrap">
              <Plus className="w-3.5 h-3.5" /> Add Box
            </button>
            <span className="text-[10px] text-zinc-500 font-mono shrink-0 whitespace-nowrap">{boxes.length}/{MAX_BOXES} boxes</span>

            {/* MARKET / LIMIT toggle */}
            <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl shrink-0">
              {(['MARKET', 'LIMIT'] as const).map(m => (
                <button key={m} onClick={() => setOrderMode(m)}
                  className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all whitespace-nowrap ${
                    orderMode === m
                      ? 'bg-zinc-700 text-zinc-100 border border-zinc-600'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}>
                  {m}
                </button>
              ))}
            </div>

            {/* INTRADAY / MARGIN toggle */}
            <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl shrink-0">
              {(['INTRADAY', 'MARGIN'] as const).map(pt => (
                <button key={pt} onClick={() => setProductType(pt)}
                  className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all whitespace-nowrap ${
                    productType === pt
                      ? 'bg-zinc-700 text-zinc-100 border border-zinc-600'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}>
                  {pt}
                </button>
              ))}
            </div>

            {/* Predefined Target & SL Presets Control Bar */}
            <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 px-2.5 py-1 rounded-xl shrink-0">
              <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider whitespace-nowrap">PRESETS:</span>
              
              {/* Mode Selector */}
              <div className="flex items-center bg-zinc-950 p-0.5 rounded-lg border border-zinc-800">
                {(['PERCENT', 'POINTS', 'PRICE'] as const).map(m => (
                  <button key={m} onClick={() => setPresetMode(m)}
                    className={`px-2 py-0.5 text-[10px] font-bold rounded transition-all whitespace-nowrap ${
                      presetMode === m
                        ? 'bg-emerald-900/70 text-emerald-300 border border-emerald-500/40 shadow-sm'
                        : 'text-zinc-500 hover:text-zinc-300'
                    }`}>
                    {m === 'PERCENT' ? '%' : m === 'POINTS' ? 'Pts' : '₹'}
                  </button>
                ))}
              </div>

              {/* Default Target */}
              <div className="flex items-center gap-1">
                <span className="text-[10px] font-bold text-emerald-400">TGT</span>
                <input
                  type="number" step="0.5" min="0"
                  value={defaultTargetVal}
                  onChange={e => setDefaultTargetVal(e.target.value)}
                  placeholder="10"
                  className="w-14 bg-zinc-950 border border-zinc-700 text-emerald-300 text-xs font-mono rounded px-1.5 py-0.5 focus:outline-none focus:border-emerald-500 text-center tabular-nums"
                  title={`Default Target value (${presetMode === 'PERCENT' ? '%' : presetMode === 'POINTS' ? 'Points' : '₹ Price'})`}
                />
              </div>

              {/* Default SL */}
              <div className="flex items-center gap-1">
                <span className="text-[10px] font-bold text-rose-400">SL</span>
                <input
                  type="number" step="0.5" min="0"
                  value={defaultSlVal}
                  onChange={e => setDefaultSlVal(e.target.value)}
                  placeholder="5"
                  className="w-14 bg-zinc-950 border border-zinc-700 text-rose-300 text-xs font-mono rounded px-1.5 py-0.5 focus:outline-none focus:border-rose-500 text-center tabular-nums"
                  title={`Default SL value (${presetMode === 'PERCENT' ? '%' : presetMode === 'POINTS' ? 'Points' : '₹ Price'})`}
                />
              </div>

              {/* Auto-Apply Toggle */}
              <button
                onClick={() => setAutoApplyGuards(v => !v)}
                title="Automatically apply Target & SL presets to new trades upon execution"
                className={`px-2 py-0.5 text-[10px] font-bold rounded border transition-all whitespace-nowrap ${
                  autoApplyGuards
                    ? 'bg-amber-900/60 border-amber-500/50 text-amber-300 shadow-sm'
                    : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:text-zinc-300'
                }`}
              >
                ⚡ Auto-Apply {autoApplyGuards ? 'ON' : 'OFF'}
              </button>
            </div>

            {/* Top 10 NIFTY heavyweights panel — display preference, so it sits
                with the other view toggles rather than the order controls. */}
            <button onClick={() => setShowTop10(v => !v)}
              title="Show the 10 heaviest NIFTY constituents with live % change"
              className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all shrink-0 whitespace-nowrap ${
                showTop10
                  ? 'bg-sky-900/50 border-sky-500/40 text-sky-300'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-500 hover:text-zinc-300'
              }`}>
              TOP 10 {showTop10 ? 'ON' : 'OFF'}
            </button>

            {/* Bridge status dot + transport badge + timestamp */}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className={`w-2 h-2 rounded-full ${
                bridgeStatus.status === 'RUNNING'  ? 'bg-emerald-400 animate-pulse' :
                bridgeStatus.status === 'STARTING' ? 'bg-yellow-400 animate-pulse'  :
                bridgeStatus.status === 'ERROR'    ? 'bg-rose-400'                  : 'bg-zinc-600'
              }`} />
              <span className={`text-[9px] font-bold px-1 py-0.5 rounded border w-9 text-center ${
                transport === 'ws'
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                  : 'bg-zinc-800 text-zinc-500 border-zinc-700'
              }`} title={transport === 'ws' ? 'Realtime WebSocket push' : 'HTTP polling fallback'}>
                {transport === 'ws' ? 'WS' : 'HTTP'}
              </span>
              {lastUpdated && <span className="text-[10px] text-zinc-500 font-mono whitespace-nowrap">{lastUpdated}</span>}
            </div>

            {/* Combined P&L chip across all boxes/positions — min-w keeps row
                layout stable regardless of the selected broker's actual P&L
                digit-count */}
            {positionsData.length > 0 && (
              <span className={`px-2.5 py-1.5 rounded-lg text-xs font-bold font-mono tabular-nums border min-w-[90px] text-center inline-block shrink-0 whitespace-nowrap ${
                totalPnl > 0
                  ? 'bg-emerald-900/40 border-emerald-500/30 text-emerald-400'
                  : totalPnl < 0
                  ? 'bg-rose-900/40 border-rose-500/30 text-rose-400'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-400'
              }`}>
                {totalPnl >= 0 ? '+' : ''}₹{totalPnl.toFixed(0)}
              </span>
            )}

          </div>
        </div>

        {/* P&L Guard bar — always visible; controls themselves are Dhan-only (see below) */}
        <div className="mt-2 pt-2 border-t border-zinc-800">
          {pnlGuardLoading ? (
            <p className="text-xs text-zinc-500 px-1">Loading…</p>
          ) : (() => {
            const isActive = pnlGuardStatus?.pnlExitStatus === 'ACTIVE';
            // Dhan may echo loss back as the negative level it was stored at rather
            // than the positive magnitude we sent — compare by magnitude either way.
            const hasConfig = !!(pnlGuardStatus && (Number(pnlGuardStatus.profit) > 0 || Math.abs(Number(pnlGuardStatus.loss)) > 0));
            const guardLabel = isActive ? 'ACTIVE' : hasConfig ? 'CONFIGURED' : 'NOT SET';
            const guardChipCls = isActive
              ? 'bg-emerald-900/60 text-emerald-400 border border-emerald-500/30'
              : hasConfig
              ? 'bg-amber-900/40 text-amber-400 border border-amber-500/30'
              : 'bg-zinc-800 text-zinc-500 border border-zinc-700';
            return (
              <div className="flex items-center gap-3 flex-nowrap overflow-x-auto pb-1">
                <span className="flex items-center gap-1 text-[10px] font-bold text-zinc-500 uppercase tracking-wider shrink-0 whitespace-nowrap">
                  <Shield className="w-3 h-3" /> P&amp;L Guard
                </span>

                {broker !== 'dhan' ? (
                  // Dhan's native /pnlExit is an account-level kill switch with no
                  // Zerodha equivalent — showing live-looking controls here would
                  // silently configure Dhan's guard while this tab shows Zerodha
                  // data, so surface that plainly instead of pretending it works.
                  <span
                    className="px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider bg-zinc-800 text-zinc-500 border border-zinc-700 shrink-0 whitespace-nowrap"
                    title="P&L Guard uses Dhan's native account-level pnlExit API, which has no Zerodha equivalent. Switch to Dhan to use it.">
                    DHAN ONLY
                  </span>
                ) : (
                  <>
                    <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider shrink-0 whitespace-nowrap ${guardChipCls}`}>
                      {guardLabel}
                    </span>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-[10px] text-zinc-500 font-semibold whitespace-nowrap">TARGET ₹</span>
                      <input type="number" min="0" placeholder="e.g. 5000" value={profitTarget}
                        onChange={e => setProfitTarget(e.target.value.replace(/-/g, ''))}
                        className="w-24 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono
                                   rounded px-2 py-1 focus:outline-none focus:border-emerald-500" />
                    </div>

                    {/* Loss limit — always a positive magnitude ("exit when loss reaches ₹X"); Dhan rejects a negative value */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-[10px] text-zinc-500 font-semibold whitespace-nowrap">SL ₹</span>
                      <input type="number" min="0" placeholder="e.g. 2000" value={lossLimit}
                        onChange={e => setLossLimit(e.target.value.replace(/-/g, ''))}
                        className="w-24 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono
                                   rounded px-2 py-1 focus:outline-none focus:border-rose-500" />
                    </div>

                    {/* Combined Strategy % Presets (Always visible; calculates Total P&L Guard Target & SL ₹) */}
                    <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 px-2 py-1 rounded-lg shrink-0">
                      <span className="text-[10px] text-zinc-400 font-bold whitespace-nowrap" title="Target & SL % for combined multi-leg portfolio">COMBINED %:</span>
                      <span className="text-[10px] text-emerald-400 font-bold">TGT</span>
                      {[10, 15, 20, 25, 30].map(pct => {
                        const isSelected = combinedTargetPct === pct;
                        return (
                          <button
                            key={pct}
                            type="button"
                            onClick={() => {
                              setCombinedTargetPct(prev => prev === pct ? null : pct);
                              if (combinedStrategyStats.entryCapitalSum > 0) {
                                const calcTarget = Math.round((combinedStrategyStats.entryCapitalSum * pct) / 100);
                                if (calcTarget > 0) setProfitTarget(String(calcTarget));
                              }
                            }}
                            className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-bold transition-all ${
                              isSelected
                                ? 'bg-emerald-600 text-white border border-emerald-400 shadow-sm'
                                : 'bg-emerald-950/80 border border-emerald-800/80 text-emerald-400 hover:bg-emerald-800 hover:text-white'
                            }`}
                            title={combinedStrategyStats.entryCapitalSum > 0
                              ? `Set total P&L Guard Target to +${pct}% (+₹${Math.round((combinedStrategyStats.entryCapitalSum * pct) / 100)})`
                              : `Set combined Target to +${pct}% (will apply when trade opens)`
                            }
                          >
                            +{pct}%
                          </button>
                        );
                      })}
                      <span className="text-[10px] text-rose-400 font-bold ml-1">SL</span>
                      {[5, 10, 15, 20].map(pct => {
                        const isSelected = combinedSlPct === pct;
                        return (
                          <button
                            key={pct}
                            type="button"
                            onClick={() => {
                              setCombinedSlPct(prev => prev === pct ? null : pct);
                              if (combinedStrategyStats.entryCapitalSum > 0) {
                                const calcLoss = Math.round((combinedStrategyStats.entryCapitalSum * pct) / 100);
                                if (calcLoss > 0) setLossLimit(String(calcLoss));
                              }
                            }}
                            className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-bold transition-all ${
                              isSelected
                                ? 'bg-rose-600 text-white border border-rose-400 shadow-sm'
                                : 'bg-rose-950/80 border border-rose-800/80 text-rose-400 hover:bg-rose-800 hover:text-white'
                            }`}
                            title={combinedStrategyStats.entryCapitalSum > 0
                              ? `Set total P&L Guard SL limit to -${pct}% (-₹${Math.round((combinedStrategyStats.entryCapitalSum * pct) / 100)})`
                              : `Set combined SL limit to -${pct}% (will apply when trade opens)`
                            }
                          >
                            -{pct}%
                          </button>
                        );
                      })}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {['INTRADAY', 'CNC', 'MARGIN'].map(pt => (
                        <button key={pt} onClick={() => setGuardProductTypes(prev =>
                          prev.includes(pt) ? prev.filter(x => x !== pt) : [...prev, pt]
                        )}
                          className={`px-2 py-1 rounded text-[10px] font-bold border transition-all whitespace-nowrap ${
                            guardProductTypes.includes(pt)
                              ? 'bg-violet-900/50 border-violet-500/40 text-violet-300'
                              : 'bg-zinc-900 border-zinc-700 text-zinc-500 hover:text-zinc-300'
                          }`}>
                          {pt}
                        </button>
                      ))}
                    </div>

                    <button onClick={() => setEnableKillSwitch(v => !v)}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-bold border transition-all shrink-0 whitespace-nowrap ${
                        enableKillSwitch
                          ? 'bg-rose-900/50 border-rose-500/40 text-rose-300'
                          : 'bg-zinc-900 border-zinc-700 text-zinc-500 hover:text-zinc-300'
                      }`}>
                      🔴 Kill Switch {enableKillSwitch ? 'ON' : 'OFF'}
                    </button>

                    <button onClick={handleSetPnl} disabled={settingPnl}
                      className="px-3 py-1.5 text-xs font-bold rounded-lg bg-violet-600 hover:bg-violet-500
                                 text-white border border-violet-500/40 transition-all disabled:opacity-50 shrink-0 whitespace-nowrap">
                      {settingPnl ? 'Setting…' : 'Set Guard'}
                    </button>

                    {hasConfig && (
                      <button onClick={handleClearPnl} disabled={clearingPnl}
                        className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all disabled:opacity-50 shrink-0 whitespace-nowrap ${
                          confirmClear
                            ? 'bg-rose-600 border-rose-500/40 text-white'
                            : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200'
                        }`}>
                        {clearingPnl ? 'Clearing…' : confirmClear ? 'Confirm Clear?' : 'Clear Guard'}
                      </button>
                    )}
                  </>
                )}

                {/* Exit ALL Positions (broker-level nuclear) */}
                <button onClick={handleExitAll} disabled={exitingAll}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shrink-0 whitespace-nowrap ${
                    exitingAll
                      ? 'bg-red-900/40 border-red-800 text-red-400'
                      : confirmExitAll
                      ? 'bg-red-600 border-red-500 text-white animate-pulse shadow-lg shadow-red-500/20'
                      : 'bg-red-950/60 border-red-900/60 text-red-400 hover:bg-red-900/40 hover:border-red-700 hover:text-red-300'
                  }`}
                  title="Immediately liquidate ALL positions at broker level (DELETE /positions)">
                  {exitingAll ? <RefreshCw className="h-3 w-3 animate-spin" /> : <ShieldOff className="h-3 w-3" />}
                  {exitingAll ? 'Exiting…' : confirmExitAll ? 'Confirm EXIT ALL?' : 'EXIT ALL Positions'}
                </button>

                {/* Client-side minimum profit lock (total P&L floor) */}
                <ProfitLockControls lock={profitLock} totalPnl={totalPnl} />

                {/* Dhan → Zerodha trade replication (arm/disarm + multiplier) */}
                <CopyTradeControls copyTrade={copyTrade} />

                {broker === 'dhan' && hasConfig && (
                  <span className="text-[10px] text-zinc-500 font-mono shrink-0 whitespace-nowrap">
                    {Number(pnlGuardStatus?.profit) > 0 ? `🎯 ₹${pnlGuardStatus?.profit}` : ''}
                    {Number(pnlGuardStatus?.profit) > 0 && Math.abs(Number(pnlGuardStatus?.loss)) > 0 ? '  ' : ''}
                    {Math.abs(Number(pnlGuardStatus?.loss)) > 0 ? `🛑 ₹${Math.abs(Number(pnlGuardStatus?.loss))}` : ''}
                  </span>
                )}

                {/* Persistent error — the toast auto-dismisses, this stays until the next attempt */}
                {broker === 'dhan' && guardError && (
                  <span className="text-[10px] text-rose-400 font-semibold shrink-0 whitespace-nowrap">⚠ {guardError}</span>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Centered underlying spot price strip */}
      {spot > 0 && (() => {
        const chg    = prevSpot > 0 ? spot - prevSpot : 0;
        const chgPct = prevSpot > 0 ? (chg / prevSpot) * 100 : 0;
        const isUp   = chg >= 0;
        return (
          <div className="flex justify-center items-center px-4 pb-1 pt-0">
            <div className="flex items-baseline gap-3 bg-zinc-900/60 border border-zinc-800 rounded-2xl px-8 py-3">
              <span className="text-xs font-bold text-zinc-500 uppercase tracking-widest">{underlying}</span>
              <span className="text-3xl font-bold font-mono tabular-nums text-white">
                {spot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              {prevSpot > 0 && (
                <div className={`flex items-baseline gap-1.5 text-sm font-semibold font-mono tabular-nums ${isUp ? 'text-emerald-400' : 'text-rose-400'}`}>
                  <span>{isUp ? '▲' : '▼'}</span>
                  <span>{Math.abs(chg).toFixed(2)}</span>
                  <span className="text-xs opacity-80">({isUp ? '+' : ''}{chgPct.toFixed(2)}%)</span>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Every box keeps the width it would have in a full 5-box row
          ((100% - 4 gaps) / 5); fewer boxes are centered, not stretched. */}
      <div className="flex flex-row justify-center gap-3 p-4 overflow-x-auto select-none">
        {boxes.map(box => {
          const ltp = box.strike != null
            ? (liveQuotes?.strikes?.[String(box.strike)]?.[box.side === 'CE' ? 'ce' : 'pe']?.ltp ?? 0)
            : 0;
          const pc = box.strike != null
            ? (prevClose[String(box.strike)]?.[box.side === 'CE' ? 'ce' : 'pe'] ?? 0)
            : 0;
          const pct = (ltp > 0 && pc > 0) ? ((ltp - pc) / pc) * 100 : null;

          const sideData = box.strike != null
            ? liveQuotes?.strikes?.[String(box.strike)]?.[box.side === 'CE' ? 'ce' : 'pe']
            : undefined;
          const high = sideData?.high ?? 0;
          const low  = sideData?.low ?? 0;

          const secId = boxSecId(box);
          const pos = secId ? positionsBySecId[secId] : undefined;
          const boxPnl = pos ? (Number(pos.realizedProfit) || 0) + (Number(pos.unrealizedProfit) || 0) : undefined;
          const hasOpenPosition = !!pos && Number(pos.netQty) !== 0;

          return (
            <div key={box.id} className="flex-none w-[calc(20%-0.6rem)] min-w-[300px]">
              <OptionPanel
                side={box.side}
                label={box.side === 'CE' ? 'CALLS' : 'PUTS'}
                strike={box.strike}
                visibleStrikes={visibleStrikes}
                atm={atm}
                ltp={ltp}
                pct={pct}
                high={high}
                low={low}
                buildup={sideData?.buildup ?? ''}
                oiChgPct={sideData?.oi_chg_pct ?? 0}
                limitPrice={box.limitPrice}
                orderMode={orderMode}
                onStrikeChange={v => updateBox(box.id, { strike: v, limitPrice: '' })}
                onShiftUp={() => handleShiftStrike(box.id, 'UP')}
                onShiftDown={() => handleShiftStrike(box.id, 'DOWN')}
                onLimitPriceChange={v => updateBox(box.id, { limitPrice: v })}
                onBuy={() => placeOrder(box.id, 'BUY')}
                onSell={() => placeOrder(box.id, 'SELL')}
                lots={box.lots}
                onLotsChange={l => updateBox(box.id, { lots: l })}
                onRemove={() => removeBox(box.id)}
                canRemove={boxes.length > MIN_BOXES && !hasOpenPosition}
                pnl={boxPnl}
                onSideChange={s => updateBox(box.id, { side: s, limitPrice: '' })}
                pending={orderPendingBoxes.has(box.id)}
                strikesReady={strikesReady}
              />
            </div>
          );
        })}

        {/* Both panels sit to the right of the last option box (the PE box in
            the default 2-box layout). Narrower than an option box — they only
            carry 3-4 numeric columns, so giving them a full box's 20% would
            waste width that the option boxes need for their price/OI blocks.
            Mounting is what starts each panel's polling; hidden costs nothing. */}
        {showTop10 && (
          <>
            <div className="flex-none w-[calc(15%-0.6rem)] min-w-[240px]">
              <TopWeightStocks />
            </div>
            <div className="flex-none w-[calc(13%-0.6rem)] min-w-[210px]">
              <TopIndices />
            </div>
          </>
        )}
      </div>

      {/* Live Combined Multi-Leg Strategy Banner */}
      {combinedStrategyStats.openLegsCount > 1 && combinedStrategyStats.entryCapitalSum > 0 && (
        <div className="mx-4 mb-3 flex items-center justify-between gap-3 bg-violet-950/70 border border-violet-700/60 rounded-xl px-4 py-2.5 shadow-lg">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="flex items-center gap-1.5 text-xs font-bold text-violet-300 uppercase tracking-wider">
              <Zap className="w-4 h-4 text-yellow-400" /> MULTI-LEG STRATEGY ({combinedStrategyStats.openLegsCount} LEGS ACTIVE)
            </span>
            <span className="text-xs font-mono text-zinc-300">
              Entry Capital Value: <strong className="text-white">₹{combinedStrategyStats.entryCapitalSum.toFixed(0)}</strong>
              {' '}&rarr; Current Value: <strong className="text-white">₹{combinedStrategyStats.liveCapitalSum.toFixed(0)}</strong>
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className={`text-xs font-bold font-mono tabular-nums px-2.5 py-1 rounded-lg border ${
              combinedStrategyStats.decayPct >= 0
                ? 'bg-emerald-900/60 border-emerald-500/40 text-emerald-300'
                : 'bg-rose-900/60 border-rose-500/40 text-rose-300'
            }`}>
              {combinedStrategyStats.decayPct >= 0 ? '+' : ''}{combinedStrategyStats.decayPct.toFixed(1)}% {
                combinedStrategyStats.decayPct >= 0
                  ? (combinedStrategyStats.isNetSeller ? 'Decay Captured' : 'Premium Growth')
                  : 'Loss'
              }
            </span>
          </div>
        </div>
      )}

      {/* Bottom tabs panel */}
      <div className="flex-1 flex flex-col mx-4 mb-4 bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
        <div className="flex items-center gap-1 px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/40">
          {([
            ['positions', positionsData] as const,
            ['orders',    ordersData]    as const,
            ['trades',    tradesData]    as const,
            ['funds',     []]            as const,
          ]).map(([tab, data]) => (
            <button key={tab} onClick={() => { setActiveTab(tab as typeof activeTab); setTableSort({ key: 'none', dir: 'asc' }); }}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all capitalize ${
                activeTab === tab
                  ? 'bg-zinc-700 text-zinc-100 border border-zinc-600'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}>
              {tab}{data.length > 0 ? ` (${data.length})` : ''}
            </button>
          ))}
          <button onClick={fetchTabData} disabled={tabLoading}
            className="ml-auto flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg
                       border border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200
                       transition-all disabled:opacity-50">
            <RefreshCw className={`w-3 h-3 ${tabLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {/* Table content */}
        <div className="flex-1 overflow-auto">
          {activeTab === 'funds' ? (
            <FundsView
              data={fundsData}
              realizedPnl={enrichedPositions.reduce((sum, p) => sum + (Number(p.realizedProfit) || 0), 0)}
            />
          ) : activeTab === 'positions' ? (
            <PositionsTable
              data={enrichedPositions}
              guards={posGuards}
              closingPositions={closingPositions}
              onGuardChange={handleGuardChange}
              onTrailToggle={handleTrailToggle}
              onClose={pos => closePosition(pos, 'Manual')}
              onAddLeg={handleAddLeg}
              sort={tableSort}
              onSort={handleTableSort}
              error={positionsError}
            />
          ) : (
            <TabTable
              tab={activeTab}
              data={activeTab === 'orders' ? ordersData : tradesData}
              sort={tableSort}
              onSort={handleTableSort}
            />
          )}
        </div>
      </div>
    </div>
  );
}
