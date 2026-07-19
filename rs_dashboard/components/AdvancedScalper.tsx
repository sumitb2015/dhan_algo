'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import NavBar from './NavBar';
import { Zap, RefreshCw, Shield, ShieldOff, Plus } from 'lucide-react';
import {
  OptionPanel, PositionsTable, TabTable, FundsView,
  type LiveQuotes, type BridgeStatus, type ChainOcEntry, type Toast,
  type PnlGuardStatus, type PositionGuard, type SortState,
} from './Scalper';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { useProfitLock, ProfitLockControls } from './ProfitLock';
import { useCopyTrade, CopyTradeControls } from './CopyTrade';
import { useBrokerSelector, brokerRoute } from '@/hooks/useBrokerSelector';

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

// ─── Main Component ───────────────────────────────────────────────

export default function AdvancedScalper() {
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
  const { liveQuotes, bridgeStatus, lastUpdated, transport } = useLiveOptionsWS(expiry, broker, authenticatedBrokers);

  // Trading controls
  const [orderMode, setOrderMode] = useState<'MARKET' | 'LIMIT'>('MARKET');
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
  useEffect(() => { expiryRef.current = expiry; }, [expiry]);

  // ─── Derived values ──────────────────────────────────────────────

  const spot = liveQuotes?.spot ?? chainSpot;
  const atm  = spot > 0 ? Math.round(spot / 50) * 50 : 0;

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
      if (broker === 'zerodha') {
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
    return broker === 'zerodha'
      ? String(pos.tradingSymbol ?? '')
      : String(pos.securityId ?? (pos as Record<string, unknown>).security_id ?? '');
  }, [broker]);

  // Same realizedProfit=0-on-flat-position fix as the base Scalper (Dhan quirk, see Scalper.tsx)
  const realizedFixedPositions = useMemo(() => {
    return positionsData.map(pos => {
      const netQty = Number(pos.netQty);
      if (netQty !== 0) return pos;

      const buyQty = Number(pos.buyQty);
      const sellQty = Number(pos.sellQty);
      const buyAvg = Number(pos.buyAvg);
      const sellAvg = Number(pos.sellAvg);
      if (!buyQty || !sellQty) return pos;

      const recomputedRealized = sellQty * sellAvg - buyQty * buyAvg;
      if (Number(pos.realizedProfit) === recomputedRealized) return pos;

      return { ...pos, realizedProfit: recomputedRealized };
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
      const unrealizedProfit = netQty === 0
        ? Number(pos.unrealizedProfit)
        : netQty > 0
          ? netQty * (liveLtp - buyAvg)
          : Math.abs(netQty) * (sellAvg - liveLtp);

      return { ...pos, lastTradedPrice: liveLtp, unrealizedProfit };
    });
  }, [realizedFixedPositions, liveQuotes, secIdToStrikeSide, positionJoinKey]);

  const totalPnl = enrichedPositions.reduce((sum, p) =>
    sum + (Number(p.realizedProfit) || 0) + (Number(p.unrealizedProfit) || 0), 0);

  // Position row keyed by security ID — lets each box look up its own open position/P&L
  const positionsBySecId = useMemo(() => {
    const map: Record<string, Record<string, unknown>> = {};
    for (const pos of enrichedPositions) {
      const secId = positionJoinKey(pos);
      if (secId) map[secId] = pos;
    }
    return map;
  }, [enrichedPositions, positionJoinKey]);

  const boxSecId = useCallback((box: BoxConfig): string | undefined => {
    if (box.strike == null) return undefined;
    const entry = strikeMap[String(box.strike)];
    return broker === 'zerodha'
      ? entry?.[box.side === 'CE' ? 'ceSymbol' : 'peSymbol']
      : entry?.[box.side === 'CE' ? 'ceId' : 'peId'];
  }, [strikeMap, broker]);

  // ─── useEffect 1: Load expiries based on broker ───────────────────

  useEffect(() => {
    fetch(`/api/options/expiries?underlying=NIFTY&broker=${broker}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        if (j.success && j.data?.length) {
          setExpiries(j.data);
          setExpiry(prev => j.data.includes(prev) ? prev : j.data[0]);
        }
      })
      .catch(() => {});
  }, [broker]);

  // ─── useEffect 1b: Load mount data ───────────────────────────────

  useEffect(() => {
    fetch('/api/scalper/nifty-prev-close')
      .then(r => r.json())
      .then((j: { success: boolean; prevClose?: number }) => {
        if (j.success && j.prevClose) setPrevSpot(j.prevClose);
      })
      .catch(() => {});

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

    // Reset strike selections when expiry changes; lots/side presets are preserved
    setBoxes(prev => prev.map(b => ({ ...b, strike: null })));
    setAllStrikes([]);
    setPrevClose({});
    setStrikeMap({});   // liveQuotes reset is handled inside useLiveOptionsWS

    fetch(`/api/options/chain?underlying=NIFTY&expiry=${expiry}&broker=${broker}`)
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
          const atmTarget = spotPrice > 0 ? Math.round(spotPrice / 50) * 50 : 0;
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
        body: JSON.stringify({ action: 'start', underlying: 'NIFTY', expiry, numStrikes: 30, broker: b }),
      }).catch(() => {});
    }

    // Cleanup: stop every started bridge when expiry changes or component unmounts
    return () => {
      fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop', brokers: authenticatedBrokers }),
      }).catch(() => {});
    };
  }, [expiry, authenticatedBrokers]);

  // Re-resolves strikeMap (Dhan securityId / Zerodha tradingsymbol per strike)
  // whenever the expiry OR the selected broker changes. Order routing is
  // still broker-specific — only the live-quotes WS bridges (started above)
  // run concurrently for both brokers regardless of selection.
  useEffect(() => {
    if (!expiry) return;

    const requestedExpiry = expiry;
    const lookupUrl = brokerRoute(
      broker,
      `/api/scalper/lookup?underlying=NIFTY&expiry=${expiry}`,
      `/api/scalper/zerodha/lookup?expiry=${expiry}`,
    );
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
  }, [expiry, broker]);

  // Live quotes arrive via useLiveOptionsWS (direct WebSocket push from the
  // Python bridge, rAF-coalesced; falls back to 100ms HTTP polling if the WS
  // is unavailable). The old useEffect-3 poll loop lived here.

  // ─── useEffect 4: Poll positions/orders/trades every 5s ──────────

  const fetchTabData = useCallback(() => {
    setTabLoading(true);
    fetch(brokerRoute(broker, '/api/scalper/all', '/api/scalper/zerodha/all'))
      .then(r => r.json())
      .then((j: { success: boolean; positions?: Record<string, unknown>[]; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[]; funds?: Record<string, any>; pnl_guard?: any }) => {
        if (j.success) {
          setPositionsData(j.positions ?? []);
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
    fetch(brokerRoute(broker, '/api/scalper/poll', '/api/scalper/zerodha/poll'))
      .then(r => r.json())
      .then((j: { success: boolean; positions?: Record<string, unknown>[]; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[] }) => {
        if (j.success) {
          setPositionsData(j.positions ?? []);
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
      if (broker === 'zerodha') {
        const symbol = entry?.[box.side === 'CE' ? 'ceSymbol' : 'peSymbol'];
        if (!symbol) {
          addToast('error', `${side} ${box.side} failed`, 'Zerodha strike data still loading');
          return;
        }
        res = await fetch('/api/scalper/zerodha/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tradingsymbol: symbol,
            quantity: box.lots * lotSize,
            side,
            orderType: orderMode,
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
              ...(orderMode === 'LIMIT' ? { price: Number(box.limitPrice) } : {}),
            }),
          });
        } else {
          const body: Record<string, unknown> = {
            underlying: 'NIFTY', expiry, strike: box.strike, option: box.side, side, lots: box.lots, type: orderMode,
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
  }, [boxes, expiry, lotSize, strikeMap, orderMode, broker, addToast, fetchTabData]);

  // ─── Per-position close ───────────────────────────────────────────

  const closePosition = useCallback(async (pos: Record<string, unknown>, reason: string) => {
    const sym = String(pos.tradingSymbol ?? '');
    const fallbackSecId = String(pos.securityId ?? pos.security_id ?? '');

    if (!sym || !fallbackSecId) {
      addToast('error', `Cannot close ${sym || 'position'}`, 'Missing security ID');
      return;
    }

    // Prevent double-fire while order is in flight
    if (closingInFlightRef.current.has(sym)) return;
    closingInFlightRef.current.add(sym);
    setPosGuards(prev => prev[sym] ? { ...prev, [sym]: { ...prev[sym], triggered: true } } : prev);
    setClosingPositions(prev => new Set([...prev, sym]));

    try {
      let liveNetQty = 0;
      let liveSecId = fallbackSecId;
      try {
        const posUrl = brokerRoute(broker, '/api/scalper/positions', '/api/scalper/zerodha/positions');
        const posRes = await fetch(posUrl);
        const posJson = await posRes.json() as { success: boolean; data?: Record<string, unknown>[] };
        if (posJson.success && posJson.data) {
          const match = posJson.data.find(p => String(p.tradingSymbol) === sym);
          if (match) {
            liveNetQty = Number(match.netQty);
            liveSecId = String(match.securityId ?? match.security_id ?? fallbackSecId);
          }
        }
      } catch {
        liveNetQty = Number(pos.netQty);
      }

      if (liveNetQty === 0) {
        addToast('success', `${sym} already flat`, `(${reason})`);
        setPosGuards(prev => { const next = { ...prev }; delete next[sym]; return next; });
        fetchTabData();
        return;
      }

      const side = liveNetQty > 0 ? 'SELL' : 'BUY';
      const qty = Math.abs(liveNetQty);

      const orderUrl = brokerRoute(broker, '/api/scalper/fast-order', '/api/scalper/zerodha/order');
      const res = await fetch(orderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          broker === 'zerodha'
            ? { tradingsymbol: sym, quantity: qty, side, orderType: 'MARKET' }
            : { securityId: liveSecId, quantity: qty, side, orderType: 'MARKET' },
        ),
      });
      const j = await res.json() as { success: boolean; order_id?: string; error?: string };
      if (j.success) {
        addToast('success', `Closed ${sym} (${reason})`, `${qty} qty · ID: ${j.order_id}`);
        // Drop the guard entirely — leaving it would carry stale bestPrice /
        // trailEnabled into a future re-entry on the same symbol.
        setPosGuards(prev => { const next = { ...prev }; delete next[sym]; return next; });
        setTimeout(fetchTabData, 800);
      } else {
        addToast('error', `Close failed: ${sym}`, j.error ?? 'Unknown error');
        setPosGuards(prev => prev[sym] ? { ...prev, [sym]: { ...prev[sym], triggered: false } } : prev);
      }
    } catch (e) {
      addToast('error', 'Network error closing position', String(e));
      setPosGuards(prev => prev[sym] ? { ...prev, [sym]: { ...prev[sym], triggered: false } } : prev);
    } finally {
      closingInFlightRef.current.delete(sym);
      setClosingPositions(prev => { const s = new Set(prev); s.delete(sym); return s; });
    }
  }, [broker, addToast, fetchTabData]);

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
      if (broker === 'zerodha') {
        const res = await fetch('/api/scalper/zerodha/exit-all', { method: 'POST' });
        const data = await res.json() as { success: boolean; closed: string[]; errors: string[] };
        if (data.success) {
          addToast('success', `All Zerodha positions liquidated.${data.closed.length ? ` (${data.closed.join(', ')})` : ''}`);
        } else {
          addToast('error', 'Zerodha exit failed', data.errors.join('; ') || 'Unknown error');
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
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-sm font-bold text-white tracking-tight flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-yellow-400" />
                NIFTY ADVANCED SCALPER
              </h1>
              <p className="text-xs font-bold font-mono tabular-nums text-zinc-200">
                {spot > 0
                  ? `NIFTY ${spot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : 'Loading…'}
              </p>
            </div>
            <NavBar />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Expiry selector */}
            <select value={expiry} onChange={e => setExpiry(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold
                         rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500">
              {expiries.map(ex => <option key={ex} value={ex}>{ex}</option>)}
            </select>

            {/* Add Box */}
            <button onClick={addBox} disabled={boxes.length >= MAX_BOXES}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold rounded-lg
                         border border-emerald-600/40 bg-emerald-900/30 text-emerald-400
                         hover:bg-emerald-800/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
              <Plus className="w-3.5 h-3.5" /> Add Box
            </button>
            <span className="text-[10px] text-zinc-500 font-mono">{boxes.length}/{MAX_BOXES} boxes</span>

            {/* MARKET / LIMIT toggle */}
            <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl">
              {(['MARKET', 'LIMIT'] as const).map(m => (
                <button key={m} onClick={() => setOrderMode(m)}
                  className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${
                    orderMode === m
                      ? 'bg-zinc-700 text-zinc-100 border border-zinc-600'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}>
                  {m}
                </button>
              ))}
            </div>

            {/* Bridge status dot + transport badge + timestamp */}
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${
                bridgeStatus.status === 'RUNNING'  ? 'bg-emerald-400 animate-pulse' :
                bridgeStatus.status === 'STARTING' ? 'bg-yellow-400 animate-pulse'  :
                bridgeStatus.status === 'ERROR'    ? 'bg-rose-400'                  : 'bg-zinc-600'
              }`} />
              <span className={`text-[9px] font-bold px-1 py-0.5 rounded border ${
                transport === 'ws'
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                  : 'bg-zinc-800 text-zinc-500 border-zinc-700'
              }`} title={transport === 'ws' ? 'Realtime WebSocket push' : 'HTTP polling fallback'}>
                {transport === 'ws' ? 'WS' : 'HTTP'}
              </span>
              {lastUpdated && <span className="text-[10px] text-zinc-500 font-mono">{lastUpdated}</span>}
            </div>

            {/* Combined P&L chip across all boxes/positions */}
            {positionsData.length > 0 && (
              <span className={`px-2.5 py-1.5 rounded-lg text-xs font-bold font-mono tabular-nums border ${
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

        {/* P&L Guard bar — always visible, no toggle */}
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
              <div className="flex items-center gap-3 flex-wrap">
                <span className="flex items-center gap-1 text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                  <Shield className="w-3 h-3" /> P&amp;L Guard
                </span>

                <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider ${guardChipCls}`}>
                  {guardLabel}
                </span>

                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-zinc-500 font-semibold">TARGET ₹</span>
                  <input type="number" min="0" placeholder="e.g. 5000" value={profitTarget}
                    onChange={e => setProfitTarget(e.target.value.replace(/-/g, ''))}
                    className="w-24 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono
                               rounded px-2 py-1 focus:outline-none focus:border-emerald-500" />
                </div>

                {/* Loss limit — always a positive magnitude ("exit when loss reaches ₹X"); Dhan rejects a negative value */}
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-zinc-500 font-semibold">SL ₹</span>
                  <input type="number" min="0" placeholder="e.g. 2000" value={lossLimit}
                    onChange={e => setLossLimit(e.target.value.replace(/-/g, ''))}
                    className="w-24 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono
                               rounded px-2 py-1 focus:outline-none focus:border-rose-500" />
                </div>

                <div className="flex items-center gap-1">
                  {['INTRADAY', 'CNC', 'MARGIN'].map(pt => (
                    <button key={pt} onClick={() => setGuardProductTypes(prev =>
                      prev.includes(pt) ? prev.filter(x => x !== pt) : [...prev, pt]
                    )}
                      className={`px-2 py-1 rounded text-[10px] font-bold border transition-all ${
                        guardProductTypes.includes(pt)
                          ? 'bg-violet-900/50 border-violet-500/40 text-violet-300'
                          : 'bg-zinc-900 border-zinc-700 text-zinc-500 hover:text-zinc-300'
                      }`}>
                      {pt}
                    </button>
                  ))}
                </div>

                <button onClick={() => setEnableKillSwitch(v => !v)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-bold border transition-all ${
                    enableKillSwitch
                      ? 'bg-rose-900/50 border-rose-500/40 text-rose-300'
                      : 'bg-zinc-900 border-zinc-700 text-zinc-500 hover:text-zinc-300'
                  }`}>
                  🔴 Kill Switch {enableKillSwitch ? 'ON' : 'OFF'}
                </button>

                <button onClick={handleSetPnl} disabled={settingPnl}
                  className="px-3 py-1.5 text-xs font-bold rounded-lg bg-violet-600 hover:bg-violet-500
                             text-white border border-violet-500/40 transition-all disabled:opacity-50">
                  {settingPnl ? 'Setting…' : 'Set Guard'}
                </button>

                {hasConfig && (
                  <button onClick={handleClearPnl} disabled={clearingPnl}
                    className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all disabled:opacity-50 ${
                      confirmClear
                        ? 'bg-rose-600 border-rose-500/40 text-white'
                        : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200'
                    }`}>
                    {clearingPnl ? 'Clearing…' : confirmClear ? 'Confirm Clear?' : 'Clear Guard'}
                  </button>
                )}

                {/* Broker selector — only shown when more than one broker is authenticated */}
                {authenticatedBrokers.length > 1 && (
                  <select
                    value={broker}
                    onChange={e => setBroker(e.target.value as 'dhan' | 'zerodha')}
                    className="px-2 py-1.5 rounded-lg text-xs font-bold bg-zinc-900 border border-zinc-700 text-zinc-300"
                  >
                    {authenticatedBrokers.includes('dhan') && <option value="dhan">Dhan</option>}
                    {authenticatedBrokers.includes('zerodha') && <option value="zerodha">Zerodha</option>}
                  </select>
                )}

                {/* Exit ALL Positions (broker-level nuclear) */}
                <button onClick={handleExitAll} disabled={exitingAll}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed ${
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

                {hasConfig && (
                  <span className="text-[10px] text-zinc-500 font-mono">
                    {Number(pnlGuardStatus?.profit) > 0 ? `🎯 ₹${pnlGuardStatus?.profit}` : ''}
                    {Number(pnlGuardStatus?.profit) > 0 && Math.abs(Number(pnlGuardStatus?.loss)) > 0 ? '  ' : ''}
                    {Math.abs(Number(pnlGuardStatus?.loss)) > 0 ? `🛑 ₹${Math.abs(Number(pnlGuardStatus?.loss))}` : ''}
                  </span>
                )}

                {/* Persistent error — the toast auto-dismisses, this stays until the next attempt */}
                {guardError && (
                  <span className="text-[10px] text-rose-400 font-semibold">⚠ {guardError}</span>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Centered NIFTY spot price strip */}
      {spot > 0 && (() => {
        const chg    = prevSpot > 0 ? spot - prevSpot : 0;
        const chgPct = prevSpot > 0 ? (chg / prevSpot) * 100 : 0;
        const isUp   = chg >= 0;
        return (
          <div className="flex justify-center items-center px-4 pb-1 pt-0">
            <div className="flex items-baseline gap-3 bg-zinc-900/60 border border-zinc-800 rounded-2xl px-8 py-3">
              <span className="text-xs font-bold text-zinc-500 uppercase tracking-widest">NIFTY</span>
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
            <div key={box.id} className="flex-none w-[calc(20%-0.6rem)] min-w-[280px]">
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
      </div>

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
              sort={tableSort}
              onSort={handleTableSort}
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
