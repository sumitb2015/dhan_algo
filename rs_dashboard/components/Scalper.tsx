'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import NavBar from './NavBar';
import { Zap, RefreshCw, Shield, ChevronDown } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────

interface OptionSide { ltp: number; oi: number; volume: number }
interface StrikeData  { strike: number; ce: OptionSide; pe: OptionSide }

interface LiveQuotes {
  updated_at: string | null;
  underlying?: string;
  expiry?: string;
  spot: number;
  atm: number;
  straddle_premium: number;
  strikes: Record<string, StrikeData>;
}

interface BridgeStatus {
  status: 'RUNNING' | 'STOPPED' | 'STARTING' | 'ERROR';
  pid?: number;
  subscribed?: number;
}

interface ChainOcEntry {
  ce?: { last_price?: number; previous_close?: number };
  pe?: { last_price?: number; previous_close?: number };
}

interface Toast {
  id: string;
  type: 'success' | 'error';
  message: string;
  detail?: string;
}

interface PnlGuardStatus {
  pnlExitStatus: 'ACTIVE' | 'INACTIVE' | string;
  profit?: number;
  loss?: number;
  productType?: string[];
  enableKillSwitch?: boolean;
}

interface PositionGuard {
  target: string;        // take-profit price (₹)
  sl: string;            // stop-loss price (₹); also the anchor for trailing SL
  trailEnabled: boolean; // checkbox: trail SL 1:1 with profit from the configured SL level
  bestPrice: number;     // best price achieved (max LTP for long, min LTP for short); 0 = not yet set
  triggered: boolean;    // prevents double-fire while order is in flight
}

// ─── Helpers ──────────────────────────────────────────────────────

function fmtLTP(n: number): string {
  return n > 0
    ? `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—';
}

function fmtOI(n: number): string {
  if (n >= 10_000_000) return `${(n / 10_000_000).toFixed(2)}Cr`;
  if (n >= 100_000)    return `${(n / 100_000).toFixed(1)}L`;
  return n > 0 ? n.toLocaleString('en-IN') : '—';
}

// ─── Main Component ───────────────────────────────────────────────

export default function Scalper() {
  // Expiry
  const [expiries, setExpiries]   = useState<string[]>([]);
  const [expiry, setExpiry]       = useState('');

  // Chain data (one-time fetch per expiry for prev close + strike list)
  const [allStrikes, setAllStrikes]     = useState<number[]>([]);
  const [prevClose, setPrevClose]       = useState<Record<string, { ce: number; pe: number }>>({});
  const [chainSpot, setChainSpot]       = useState(0);
  const [prevSpot, setPrevSpot]         = useState(0);

  // Security ID map per strike — enables fast-order (no Python per order)
  const [strikeMap, setStrikeMap]   = useState<Record<string, { ceId?: string; peId?: string }>>({});
  const [lotSize, setLotSize]       = useState(75);

  // WS bridge live data
  const [liveQuotes, setLiveQuotes]   = useState<LiveQuotes | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({ status: 'STOPPED' });
  const [lastUpdated, setLastUpdated]   = useState('');

  // Trading controls
  const [lots, setLots]           = useState(1);
  const [orderMode, setOrderMode] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [ceStrike, setCeStrike]   = useState<number | null>(null);
  const [peStrike, setPeStrike]   = useState<number | null>(null);
  const [ceLimitPrice, setCeLimitPrice] = useState('');
  const [peLimitPrice, setPeLimitPrice] = useState('');

  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Bottom tabs
  const [activeTab, setActiveTab]       = useState<'positions' | 'orders' | 'trades' | 'funds'>('positions');
  const [positionsData, setPositionsData] = useState<Record<string, unknown>[]>([]);
  const [ordersData, setOrdersData]       = useState<Record<string, unknown>[]>([]);
  const [tradesData, setTradesData]       = useState<Record<string, unknown>[]>([]);
  const [fundsData, setFundsData]         = useState<Record<string, any> | null>(null);
  const [tabLoading, setTabLoading]       = useState(false);

  // P&L Guard
  const [showPnlGuard, setShowPnlGuard]       = useState(false);
  const [pnlGuardStatus, setPnlGuardStatus]   = useState<PnlGuardStatus | null>(null);
  const [pnlGuardLoading, setPnlGuardLoading] = useState(false);
  const [profitTarget, setProfitTarget]       = useState('');
  const [lossLimit, setLossLimit]             = useState('');
  const [guardProductTypes, setGuardProductTypes] = useState<string[]>(['INTRADAY']);
  const [enableKillSwitch, setEnableKillSwitch]   = useState(false);
  const [settingPnl, setSettingPnl]     = useState(false);
  const [clearingPnl, setClearingPnl]   = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  // Per-position guards (target / SL / trailing SL)
  const [posGuards, setPosGuards] = useState<Record<string, PositionGuard>>({});
  const [closingPositions, setClosingPositions] = useState<Set<string>>(new Set());

  const pollRef = useRef<NodeJS.Timeout | null>(null);
  // Refs for guard monitor interval — avoids stale closures
  const positionsRef = useRef<Record<string, unknown>[]>([]);
  const posGuardsRef = useRef<Record<string, PositionGuard>>({});

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

  const ceLtp = ceStrike != null ? (liveQuotes?.strikes?.[String(ceStrike)]?.ce?.ltp ?? 0) : 0;
  const peLtp = peStrike != null ? (liveQuotes?.strikes?.[String(peStrike)]?.pe?.ltp ?? 0) : 0;

  const cePrevClose = ceStrike != null ? (prevClose[String(ceStrike)]?.ce ?? 0) : 0;
  const pePrevClose = peStrike != null ? (prevClose[String(peStrike)]?.pe ?? 0) : 0;
  const cePct = (ceLtp > 0 && cePrevClose > 0) ? ((ceLtp - cePrevClose) / cePrevClose) * 100 : null;
  const pePct = (peLtp > 0 && pePrevClose > 0) ? ((peLtp - pePrevClose) / pePrevClose) * 100 : null;

  const secIdToStrikeSide = useMemo(() => {
    const map: Record<string, { strike: number; side: 'ce' | 'pe' }> = {};
    for (const [strike, ids] of Object.entries(strikeMap)) {
      if (ids.ceId) map[ids.ceId] = { strike: Number(strike), side: 'ce' };
      if (ids.peId) map[ids.peId] = { strike: Number(strike), side: 'pe' };
    }
    return map;
  }, [strikeMap]);

  const enrichedPositions = useMemo(() => {
    if (!liveQuotes?.strikes || Object.keys(secIdToStrikeSide).length === 0)
      return positionsData;

    return positionsData.map(pos => {
      const secId = String(pos.securityId ?? (pos as Record<string, unknown>).security_id ?? '');
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
  }, [positionsData, liveQuotes, secIdToStrikeSide]);

  const totalPnl = positionsData.reduce((sum, p) =>
    sum + (Number(p.realizedProfit) || 0) + (Number(p.unrealizedProfit) || 0), 0);

  // ─── useEffect 1: Load expiries on mount ─────────────────────────

  useEffect(() => {
    fetch('/api/options/expiries?underlying=NIFTY')
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        if (j.success && j.data?.length) {
          setExpiries(j.data);
          setExpiry(j.data[0]);
        }
      })
      .catch(() => {});

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

    // Reset strike state when expiry changes
    setCeStrike(null);
    setPeStrike(null);
    setAllStrikes([]);
    setPrevClose({});
    setLiveQuotes(null);
    setStrikeMap({});

    // One-time chain fetch for prev close prices + strike list
    fetch(`/api/options/chain?underlying=NIFTY&expiry=${expiry}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { chain: { oc?: Record<string, ChainOcEntry> }; spot: number } }) => {
        if (!j.success || !j.data?.chain?.oc) return;
        const oc = j.data.chain.oc;
        const strikes = Object.keys(oc).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
        setAllStrikes(strikes);

        // Extract prev close for each strike
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

        // Default both strikes to ATM
        if (strikes.length) {
          const atmTarget = spotPrice > 0 ? Math.round(spotPrice / 50) * 50 : 0;
          const nearest = atmTarget > 0
            ? strikes.reduce((prev, cur) => Math.abs(cur - atmTarget) < Math.abs(prev - atmTarget) ? cur : prev)
            : strikes[Math.floor(strikes.length / 2)];
          setCeStrike(nearest);
          setPeStrike(nearest);
        }
      })
      .catch(() => {});

    // Lookup security IDs for all strikes of this expiry — enables fast-order path
    fetch(`/api/scalper/lookup?underlying=NIFTY&expiry=${expiry}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { lotSize: number; strikes: Record<string, { ceId?: string; peId?: string }> } }) => {
        if (j.success && j.data) {
          setStrikeMap(j.data.strikes);
          setLotSize(j.data.lotSize);
        }
      })
      .catch(() => {});

    // Start WS bridge
    fetch('/api/options/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', underlying: 'NIFTY', expiry, numStrikes: 30 }),
    }).catch(() => {});

    // Cleanup: stop bridge when expiry changes or component unmounts
    return () => {
      fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      }).catch(() => {});
    };
  }, [expiry]);

  // ─── useEffect 3: Poll live data at 500ms ────────────────────────

  useEffect(() => {
    if (!expiry) return;

    const poll = () => {
      fetch('/api/options/live')
        .then(r => r.json())
        .then((j: { success: boolean; status: BridgeStatus; quotes: LiveQuotes }) => {
          if (j.success) {
            setBridgeStatus(j.status ?? { status: 'STOPPED' });

            const q = j.quotes;
            // Guard 1: quotes must belong to the currently selected expiry
            if (q?.expiry && q.expiry !== expiry) return;

            // Guard 2: reject stale data older than 10 seconds
            if (q?.updated_at) {
              const ageMs = Date.now() - new Date(q.updated_at).getTime();
              if (ageMs > 10_000) return;
            }

            // Guard 3: must have at least one strike entry (empty {} is truthy in JS)
            if (q?.strikes && Object.keys(q.strikes).length > 0) {
              setLiveQuotes(q);
              setLastUpdated(new Date().toLocaleTimeString('en-IN', {
                hour: '2-digit', minute: '2-digit', second: '2-digit',
              }));
            }
          }
        })
        .catch(() => {});
    };

    poll();
    pollRef.current = setInterval(poll, 100);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [expiry]);

  // ─── useEffect 4: Poll positions/orders/trades every 5s ──────────

  const fetchTabData = useCallback(() => {
    setTabLoading(true);
    fetch('/api/scalper/all')
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
  }, []);

  const pollTabData = useCallback(() => {
    fetch('/api/scalper/poll')
      .then(r => r.json())
      .then((j: { success: boolean; positions?: Record<string, unknown>[]; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[] }) => {
        if (j.success) {
          setPositionsData(j.positions ?? []);
          setOrdersData(j.orders ?? []);
          setTradesData(j.trades ?? []);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchTabData();
    const id = setInterval(pollTabData, 5000);
    return () => clearInterval(id);
  }, [fetchTabData, pollTabData]);

  // Keep refs in sync so the guard interval always reads latest values without stale closures
  useEffect(() => { positionsRef.current = positionsData; }, [positionsData]);
  useEffect(() => { posGuardsRef.current = posGuards; }, [posGuards]);

  // ─── Toast helper ─────────────────────────────────────────────────

  const addToast = useCallback((type: 'success' | 'error', message: string, detail?: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, type, message, detail }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  }, []);

  // ─── placeOrder ───────────────────────────────────────────────────

  const placeOrder = useCallback(async (side: 'BUY' | 'SELL', option: 'CE' | 'PE') => {
    const strike = option === 'CE' ? ceStrike : peStrike;
    const limitPrice = option === 'CE' ? ceLimitPrice : peLimitPrice;
    if (!strike || !expiry) return;

    if (orderMode === 'LIMIT') {
      const priceNum = Number(limitPrice);
      if (!limitPrice || isNaN(priceNum) || priceNum <= 0) {
        addToast('error', 'Enter a valid limit price');
        return;
      }
    }

    try {
      // Fast path: direct Dhan REST call (no Python spawn, no CSV load)
      const secId = strikeMap[String(strike)]?.[option === 'CE' ? 'ceId' : 'peId'];
      let res: Response;
      if (secId) {
        res = await fetch('/api/scalper/fast-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            securityId: secId,
            quantity: lots * lotSize,
            side,
            orderType: orderMode,
            ...(orderMode === 'LIMIT' ? { price: Number(limitPrice) } : {}),
          }),
        });
      } else {
        // Fallback: Python path (strikeMap not yet loaded)
        const body: Record<string, unknown> = {
          underlying: 'NIFTY', expiry, strike, option, side, lots, type: orderMode,
        };
        if (orderMode === 'LIMIT') body.price = Number(limitPrice);
        res = await fetch('/api/scalper/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }

      const j = await res.json() as { success: boolean; order_id?: string; error?: string };
      if (j.success) {
        addToast('success', `${side} ${option} placed`, `ID: ${j.order_id}`);
        setTimeout(fetchTabData, 1000);
      } else {
        addToast('error', `${side} ${option} failed`, j.error ?? 'Unknown error');
      }
    } catch (e) {
      addToast('error', 'Network error', String(e));
    }
  }, [ceStrike, peStrike, ceLimitPrice, peLimitPrice, expiry, lots, lotSize, strikeMap, orderMode, addToast, fetchTabData]);

  // ─── Per-position close ───────────────────────────────────────────

  const closePosition = useCallback(async (pos: Record<string, unknown>, reason: string) => {
    const sym = String(pos.tradingSymbol ?? '');
    const fallbackSecId = String(pos.securityId ?? pos.security_id ?? '');

    if (!sym || !fallbackSecId) {
      addToast('error', `Cannot close ${sym || 'position'}`, 'Missing security ID');
      return;
    }

    // Prevent double-fire while order is in flight
    setPosGuards(prev => prev[sym] ? { ...prev, [sym]: { ...prev[sym], triggered: true } } : prev);
    setClosingPositions(prev => new Set([...prev, sym]));

    try {
      // Fetch live positions to get the current open quantity (avoids acting on stale data)
      let liveNetQty = 0;
      let liveSecId = fallbackSecId;
      try {
        const posRes = await fetch('/api/scalper/positions');
        const posJson = await posRes.json() as { success: boolean; data?: Record<string, unknown>[] };
        if (posJson.success && posJson.data) {
          const match = posJson.data.find(p => String(p.tradingSymbol) === sym);
          if (match) {
            liveNetQty = Number(match.netQty);
            liveSecId = String(match.securityId ?? match.security_id ?? fallbackSecId);
          }
        }
      } catch {
        // Fall back to the quantity from the position object passed in
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

      const res = await fetch('/api/scalper/fast-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ securityId: liveSecId, quantity: qty, side, orderType: 'MARKET' }),
      });
      const j = await res.json() as { success: boolean; order_id?: string; error?: string };
      if (j.success) {
        addToast('success', `Closed ${sym} (${reason})`, `${qty} qty · ID: ${j.order_id}`);
        setTimeout(fetchTabData, 800);
      } else {
        addToast('error', `Close failed: ${sym}`, j.error ?? 'Unknown error');
        setPosGuards(prev => prev[sym] ? { ...prev, [sym]: { ...prev[sym], triggered: false } } : prev);
      }
    } catch (e) {
      addToast('error', 'Network error closing position', String(e));
      setPosGuards(prev => prev[sym] ? { ...prev, [sym]: { ...prev[sym], triggered: false } } : prev);
    } finally {
      setClosingPositions(prev => { const s = new Set(prev); s.delete(sym); return s; });
    }
  }, [addToast, fetchTabData]);

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

        // Target (take profit)
        const targetNum = parseFloat(guard.target);
        if (!isNaN(targetNum) && targetNum > 0) {
          if ((isLong && ltp >= targetNum) || (!isLong && ltp <= targetNum)) {
            closePosition(pos, 'Target hit');
            continue;
          }
        }

        if (guard.trailEnabled) {
          // Trailing SL: 1:1 with profit, anchored to the configured SL level
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
                // Only enforce once trail SL is tighter than the original SL
                const trailActive = isLong ? trailSLPrice > slNum : trailSLPrice < slNum;
                if (trailActive && ((isLong && ltp <= trailSLPrice) || (!isLong && ltp >= trailSLPrice))) {
                  closePosition(pos, 'Trail SL hit');
                  continue;
                }
              }
            }
          }
        } else {
          // Hard SL (no trailing)
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
      setPnlGuardStatus(j.success ? (j.data ?? null) : null);
    } catch {
      setPnlGuardStatus(null);
    } finally {
      setPnlGuardLoading(false);
    }
  }, []);



  const handleSetPnl = async () => {
    const p = parseFloat(profitTarget) || 0;
    const l = parseFloat(lossLimit) || 0;
    if (p <= 0 && l <= 0) { addToast('error', 'Enter a profit target or loss limit'); return; }
    setSettingPnl(true);
    try {
      const res = await fetch('/api/pnl-exit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profitValue: p, lossValue: l, productTypes: guardProductTypes, enableKillSwitch }),
      });
      const j = await res.json();
      if (j.success) { addToast('success', 'P&L Guard set'); await fetchPnlGuardStatus(); }
      else addToast('error', 'Failed to set P&L Guard', j.error);
    } catch (e) {
      addToast('error', 'Network error', String(e));
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
                NIFTY SCALPER
              </h1>
              <p className="text-xs font-mono tabular-nums text-zinc-400">
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

            {/* Lots +/- */}
            <div className="flex items-center bg-zinc-900 border border-zinc-700 rounded-lg overflow-hidden">
              <button onClick={() => setLots(l => Math.max(1, l - 1))}
                className="px-2.5 py-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors font-bold text-sm">−</button>
              <span className="px-2 text-xs font-mono tabular-nums text-zinc-200 min-w-[3.5rem] text-center border-x border-zinc-700">
                {lots} lot{lots !== 1 ? 's' : ''}
              </span>
              <button onClick={() => setLots(l => l + 1)}
                className="px-2.5 py-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors font-bold text-sm">+</button>
            </div>

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

            {/* Bridge status dot + timestamp */}
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${
                bridgeStatus.status === 'RUNNING'  ? 'bg-emerald-400 animate-pulse' :
                bridgeStatus.status === 'STARTING' ? 'bg-yellow-400 animate-pulse'  :
                bridgeStatus.status === 'ERROR'    ? 'bg-rose-400'                  : 'bg-zinc-600'
              }`} />
              {lastUpdated && <span className="text-[10px] text-zinc-500 font-mono">{lastUpdated}</span>}
            </div>

            {/* Today's P&L chip */}
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

            {/* P&L Guard toggle */}
            <button onClick={() => setShowPnlGuard(v => !v)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-all ${
                showPnlGuard
                  ? 'bg-violet-900/40 border-violet-500/40 text-violet-300'
                  : pnlGuardStatus?.pnlExitStatus === 'ACTIVE'
                  ? 'bg-emerald-900/30 border-emerald-500/30 text-emerald-400'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200'
              }`}>
              <Shield className="w-3.5 h-3.5" />
              <span>
                P&amp;L Guard
                {pnlGuardStatus?.pnlExitStatus === 'ACTIVE' && (
                  <span className="ml-1 text-[10px] font-bold font-mono">
                    ({pnlGuardStatus.profit ? `🎯₹${pnlGuardStatus.profit}` : ''}
                    {pnlGuardStatus.profit && pnlGuardStatus.loss ? ' | ' : ''}
                    {pnlGuardStatus.loss ? `🛑₹${pnlGuardStatus.loss}` : ''})
                  </span>
                )}
              </span>
              <ChevronDown className={`w-3 h-3 transition-transform ${showPnlGuard ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>

        {/* P&L Guard panel */}
        {showPnlGuard && (
          <div className="mt-2 pt-2 border-t border-zinc-800">
            {pnlGuardLoading ? (
              <p className="text-xs text-zinc-500 px-1">Loading…</p>
            ) : (
              <div className="flex items-center gap-3 flex-wrap">
                {/* Status chip */}
                <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider ${
                  pnlGuardStatus?.pnlExitStatus === 'ACTIVE'
                    ? 'bg-emerald-900/60 text-emerald-400 border border-emerald-500/30'
                    : 'bg-zinc-800 text-zinc-500 border border-zinc-700'
                }`}>
                  {pnlGuardStatus?.pnlExitStatus === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE'}
                </span>

                {/* Profit target */}
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-zinc-500 font-semibold">TARGET ₹</span>
                  <input type="number" placeholder="e.g. 5000" value={profitTarget}
                    onChange={e => setProfitTarget(e.target.value)}
                    className="w-24 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono
                               rounded px-2 py-1 focus:outline-none focus:border-emerald-500" />
                </div>

                {/* Loss limit */}
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-zinc-500 font-semibold">SL ₹</span>
                  <input type="number" placeholder="e.g. 2000" value={lossLimit}
                    onChange={e => setLossLimit(e.target.value)}
                    className="w-24 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono
                               rounded px-2 py-1 focus:outline-none focus:border-rose-500" />
                </div>

                {/* Product types */}
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

                {/* Kill switch */}
                <button onClick={() => setEnableKillSwitch(v => !v)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-bold border transition-all ${
                    enableKillSwitch
                      ? 'bg-rose-900/50 border-rose-500/40 text-rose-300'
                      : 'bg-zinc-900 border-zinc-700 text-zinc-500 hover:text-zinc-300'
                  }`}>
                  🔴 Kill Switch {enableKillSwitch ? 'ON' : 'OFF'}
                </button>

                {/* Set button */}
                <button onClick={handleSetPnl} disabled={settingPnl}
                  className="px-3 py-1.5 text-xs font-bold rounded-lg bg-violet-600 hover:bg-violet-500
                             text-white border border-violet-500/40 transition-all disabled:opacity-50">
                  {settingPnl ? 'Setting…' : 'Set Guard'}
                </button>

                {/* Clear button */}
                {pnlGuardStatus?.pnlExitStatus === 'ACTIVE' && (
                  <button onClick={handleClearPnl} disabled={clearingPnl}
                    className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all disabled:opacity-50 ${
                      confirmClear
                        ? 'bg-rose-600 border-rose-500/40 text-white'
                        : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200'
                    }`}>
                    {clearingPnl ? 'Clearing…' : confirmClear ? 'Confirm Clear?' : 'Clear Guard'}
                  </button>
                )}

                {/* Current guard values */}
                {pnlGuardStatus?.pnlExitStatus === 'ACTIVE' && (
                  <span className="text-[10px] text-zinc-500 font-mono">
                    {pnlGuardStatus.profit ? `🎯 ₹${pnlGuardStatus.profit}` : ''}
                    {pnlGuardStatus.profit && pnlGuardStatus.loss ? '  ' : ''}
                    {pnlGuardStatus.loss ? `🛑 ₹${pnlGuardStatus.loss}` : ''}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
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

      {/* Trading panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 p-4">
        <OptionPanel
          side="CE"
          label="CALLS"
          strike={ceStrike}
          visibleStrikes={visibleStrikes}
          atm={atm}
          ltp={ceLtp}
          pct={cePct}
          limitPrice={ceLimitPrice}
          orderMode={orderMode}
          onStrikeChange={v => setCeStrike(v)}
          onLimitPriceChange={setCeLimitPrice}
          onBuy={() => placeOrder('BUY', 'CE')}
          onSell={() => placeOrder('SELL', 'CE')}
        />
        <OptionPanel
          side="PE"
          label="PUTS"
          strike={peStrike}
          visibleStrikes={visibleStrikes}
          atm={atm}
          ltp={peLtp}
          pct={pePct}
          limitPrice={peLimitPrice}
          orderMode={orderMode}
          onStrikeChange={v => setPeStrike(v)}
          onLimitPriceChange={setPeLimitPrice}
          onBuy={() => placeOrder('BUY', 'PE')}
          onSell={() => placeOrder('SELL', 'PE')}
        />
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
            <button key={tab} onClick={() => setActiveTab(tab as typeof activeTab)}
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
              realizedPnl={positionsData.reduce((sum, p) => sum + (Number(p.realizedProfit) || 0), 0)}
            />
          ) : activeTab === 'positions' ? (
            <PositionsTable
              data={positionsData}
              guards={posGuards}
              closingPositions={closingPositions}
              onGuardChange={handleGuardChange}
              onTrailToggle={handleTrailToggle}
              onClose={pos => closePosition(pos, 'Manual')}
            />
          ) : (
            <TabTable
              tab={activeTab}
              data={activeTab === 'orders' ? ordersData : tradesData}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── OptionPanel ──────────────────────────────────────────────────

interface OptionPanelProps {
  side: 'CE' | 'PE';
  label: string;
  strike: number | null;
  visibleStrikes: number[];
  atm: number;
  ltp: number;
  pct: number | null;
  limitPrice: string;
  orderMode: 'MARKET' | 'LIMIT';
  onStrikeChange: (s: number) => void;
  onLimitPriceChange: (p: string) => void;
  onBuy: () => void;
  onSell: () => void;
}

function OptionPanel({
  side, label, strike, visibleStrikes, atm, ltp, pct,
  limitPrice, orderMode, onStrikeChange, onLimitPriceChange, onBuy, onSell,
}: OptionPanelProps) {
  const isPos = (v: number) => v >= 0;

  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-4">
      {/* Header: badge + strike selector */}
      <div className="flex items-center justify-between gap-3">
        <span className={`text-xs font-bold uppercase tracking-widest px-2.5 py-1 rounded-lg border ${
          side === 'CE'
            ? 'bg-sky-500/10 text-sky-400 border-sky-500/20'
            : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
        }`}>{label} ({side})</span>

        <select value={strike ?? ''} onChange={e => onStrikeChange(Number(e.target.value))}
          className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold
                     rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 tabular-nums">
          {!strike && <option value="">— select —</option>}
          {visibleStrikes.map(sk => (
            <option key={sk} value={sk}>
              {sk.toLocaleString('en-IN')}{sk === atm ? ' ← ATM' : ''}
            </option>
          ))}
        </select>
      </div>

      {/* LTP + % change */}
      <div className="bg-zinc-800/50 rounded-xl p-4 text-center">
        <p className="text-[10px] font-bold text-white uppercase tracking-widest mb-1">LTP</p>
        <p className="text-3xl font-bold font-mono tabular-nums text-white leading-none">
          {fmtLTP(ltp)}
        </p>
        {pct !== null ? (
          <p className={`text-sm font-semibold font-mono mt-1.5 ${isPos(pct) ? 'text-emerald-400' : 'text-rose-400'}`}>
            {isPos(pct) ? '▲' : '▼'} {Math.abs(pct).toFixed(2)}%
          </p>
        ) : (
          <p className="text-xs text-zinc-300 mt-1.5">— vs prev close</p>
        )}
      </div>

      {/* Limit price input (only in LIMIT mode) */}
      {orderMode === 'LIMIT' && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-400 font-medium whitespace-nowrap">Limit ₹</span>
          <input
            type="number" step="0.05" min="0.05"
            value={limitPrice}
            onChange={e => onLimitPriceChange(e.target.value)}
            placeholder="0.00"
            className="flex-1 bg-zinc-800 border border-zinc-700 text-zinc-200 text-sm font-mono
                       rounded-lg px-3 py-2 focus:outline-none focus:border-emerald-500 tabular-nums
                       placeholder:text-zinc-600"
          />
        </div>
      )}

      {/* BUY / SELL buttons */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={onBuy}
          disabled={!strike}
          className="py-3.5 px-4 text-sm font-bold rounded-xl transition-all active:scale-95
                     bg-emerald-600 hover:bg-emerald-500 text-white
                     disabled:opacity-40 disabled:cursor-not-allowed
                     shadow-lg shadow-emerald-900/20"
        >
          BUY {side}
        </button>
        <button
          onClick={onSell}
          disabled={!strike}
          className="py-3.5 px-4 text-sm font-bold rounded-xl transition-all active:scale-95
                     bg-rose-600 hover:bg-rose-500 text-white
                     disabled:opacity-40 disabled:cursor-not-allowed
                     shadow-lg shadow-rose-900/20"
        >
          SELL {side}
        </button>
      </div>
    </div>
  );
}

// ─── PositionsTable ───────────────────────────────────────────────

interface PositionsTableProps {
  data: Record<string, unknown>[];
  guards: Record<string, PositionGuard>;
  closingPositions: Set<string>;
  onGuardChange: (sym: string, field: 'target' | 'sl', value: string) => void;
  onTrailToggle: (sym: string) => void;
  onClose: (pos: Record<string, unknown>) => void;
}

function PositionsTable({ data, guards, closingPositions, onGuardChange, onTrailToggle, onClose }: PositionsTableProps) {
  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-32 text-zinc-600 text-sm">
        No positions data
      </div>
    );
  }

  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-zinc-800 z-10">
        <tr>
          <th className="px-3 py-2.5 text-xs font-bold text-white text-left whitespace-nowrap">Symbol</th>
          <th className="px-3 py-2.5 text-xs font-bold text-white text-right whitespace-nowrap">Qty</th>
          <th className="px-3 py-2.5 text-xs font-bold text-white text-right whitespace-nowrap">Buy Avg</th>
          <th className="px-3 py-2.5 text-xs font-bold text-white text-right whitespace-nowrap">Sell Avg</th>
          <th className="px-3 py-2.5 text-xs font-bold text-white text-right whitespace-nowrap">LTP</th>
          <th className="px-3 py-2.5 text-xs font-bold text-white text-right whitespace-nowrap">Real P&L</th>
          <th className="px-3 py-2.5 text-xs font-bold text-white text-right whitespace-nowrap">Unreal P&L</th>
          <th className="px-3 py-2.5 text-xs font-bold text-white text-left whitespace-nowrap">Product</th>
          <th className="px-3 py-2.5 text-xs font-bold text-emerald-400 text-center whitespace-nowrap">Target ₹</th>
          <th className="px-3 py-2.5 text-xs font-bold text-rose-400 text-center whitespace-nowrap">SL ₹</th>
          <th className="px-3 py-2.5 text-xs font-bold text-amber-400 text-center whitespace-nowrap">Trail SL</th>
          <th className="px-3 py-2.5 text-xs font-bold text-white text-center whitespace-nowrap">Close</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-800/50">
        {data.map((row, i) => {
          const sym = String(row.tradingSymbol ?? '');
          const guard = guards[sym];
          const isClosing = closingPositions.has(sym);
          const netQty = Number(row.netQty);
          const ltp = Number(row.lastTradedPrice);
          const isLong = netQty > 0;
          const realPnl = Number(row.realizedProfit);
          const unrealPnl = Number(row.unrealizedProfit);
          const buyAvg = Number(row.buyAvg);
          const sellAvg = Number(row.sellAvg);

          // Compute current effective trailing SL price to show below the checkbox
          const slNum = parseFloat(guard?.sl ?? '');
          const entryPrice = isLong ? buyAvg : sellAvg;
          const initialRisk = (entryPrice > 0 && !isNaN(slNum) && slNum > 0) ? Math.abs(slNum - entryPrice) : 0;
          const trailBest = guard?.bestPrice ?? 0;
          const effectiveTrailSL = (guard?.trailEnabled && trailBest > 0 && initialRisk > 0)
            ? (isLong ? trailBest - initialRisk : trailBest + initialRisk)
            : null;

          const hasGuard = guard && (guard.target || guard.sl || guard.trailEnabled);

          return (
            <tr key={i} className={`hover:bg-zinc-800/40 transition-colors ${isClosing ? 'opacity-40' : ''} ${guard?.triggered ? 'bg-zinc-800/20' : ''}`}>
              <td className="px-3 py-2 whitespace-nowrap font-mono text-zinc-300">
                <div className="flex items-center gap-1.5">
                  {hasGuard && !guard.triggered && (
                    <span className="w-1.5 h-1.5 rounded-full bg-violet-400 flex-shrink-0" title="Guard active" />
                  )}
                  {sym}
                </div>
              </td>
              <td className="px-3 py-2 whitespace-nowrap font-mono text-right tabular-nums text-zinc-300">{netQty}</td>
              <td className="px-3 py-2 whitespace-nowrap font-mono text-right tabular-nums text-zinc-300">{buyAvg > 0 ? buyAvg.toFixed(2) : '—'}</td>
              <td className="px-3 py-2 whitespace-nowrap font-mono text-right tabular-nums text-zinc-300">{sellAvg > 0 ? sellAvg.toFixed(2) : '—'}</td>
              <td className="px-3 py-2 whitespace-nowrap font-mono text-right tabular-nums text-zinc-300">{ltp > 0 ? ltp.toFixed(2) : '—'}</td>
              <td className={`px-3 py-2 whitespace-nowrap font-mono text-right tabular-nums ${!isNaN(realPnl) && realPnl !== 0 ? (realPnl > 0 ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-400'}`}>
                {isNaN(realPnl) ? '—' : realPnl.toFixed(0)}
              </td>
              <td className={`px-3 py-2 whitespace-nowrap font-mono text-right tabular-nums ${!isNaN(unrealPnl) && unrealPnl !== 0 ? (unrealPnl > 0 ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-400'}`}>
                {isNaN(unrealPnl) ? '—' : unrealPnl.toFixed(0)}
              </td>
              <td className="px-3 py-2 whitespace-nowrap font-mono text-zinc-300">{String(row.productType ?? '—')}</td>

              {/* Target input */}
              <td className="px-2 py-1.5">
                <input
                  type="number" step="0.05" min="0"
                  value={guard?.target ?? ''}
                  onChange={e => onGuardChange(sym, 'target', e.target.value)}
                  placeholder="—"
                  disabled={isClosing}
                  className="w-20 bg-zinc-900 border border-zinc-700 text-emerald-300 text-xs font-mono rounded px-2 py-1 focus:outline-none focus:border-emerald-500 tabular-nums text-right placeholder:text-zinc-600 disabled:opacity-40"
                />
              </td>

              {/* SL input */}
              <td className="px-2 py-1.5">
                <input
                  type="number" step="0.05" min="0"
                  value={guard?.sl ?? ''}
                  onChange={e => onGuardChange(sym, 'sl', e.target.value)}
                  placeholder="—"
                  disabled={isClosing}
                  className="w-20 bg-zinc-900 border border-zinc-700 text-rose-300 text-xs font-mono rounded px-2 py-1 focus:outline-none focus:border-rose-500 tabular-nums text-right placeholder:text-zinc-600 disabled:opacity-40"
                />
              </td>

              {/* Trail SL checkbox + effective SL price when active */}
              <td className="px-2 py-1.5 text-center">
                <div className="flex flex-col items-center gap-0.5">
                  <input
                    type="checkbox"
                    checked={guard?.trailEnabled ?? false}
                    onChange={() => onTrailToggle(sym)}
                    disabled={isClosing || !guard?.sl}
                    title={guard?.sl ? 'Trail SL 1:1 with profit' : 'Set SL first'}
                    className="w-4 h-4 accent-amber-400 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  />
                  {effectiveTrailSL !== null && (
                    <span className="text-[10px] font-mono text-amber-400 tabular-nums">
                      @{effectiveTrailSL.toFixed(1)}
                    </span>
                  )}
                </div>
              </td>

              {/* Manual close button */}
              <td className="px-2 py-1.5 text-center">
                <button
                  onClick={() => onClose(row)}
                  disabled={isClosing || netQty === 0}
                  title={`Market close ${sym}`}
                  className="px-2.5 py-1 text-[11px] font-bold rounded border transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-rose-900/40 border-rose-500/30 text-rose-400 hover:bg-rose-800/60 hover:text-rose-200 active:scale-95"
                >
                  {isClosing ? '…' : 'Close'}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── TabTable ─────────────────────────────────────────────────────

interface TabTableProps {
  tab: 'positions' | 'orders' | 'trades';
  data: Record<string, unknown>[];
}

const COLUMNS: Record<string, { key: string; label: string; numeric?: boolean; highlight?: 'side' | 'pnl' }[]> = {
  positions: [
    { key: 'tradingSymbol',    label: 'Symbol' },
    { key: 'netQty',           label: 'Qty',          numeric: true },
    { key: 'buyAvg',           label: 'Buy Avg',      numeric: true },
    { key: 'sellAvg',          label: 'Sell Avg',     numeric: true },
    { key: 'lastTradedPrice',  label: 'LTP',          numeric: true },
    { key: 'realizedProfit',   label: 'Realized P&L', numeric: true, highlight: 'pnl' },
    { key: 'unrealizedProfit', label: 'Unreal. P&L',  numeric: true, highlight: 'pnl' },
    { key: 'productType',      label: 'Product' },
  ],
  orders: [
    { key: 'tradingSymbol',   label: 'Symbol' },
    { key: 'orderStatus',     label: 'Status' },
    { key: 'transactionType', label: 'Side',   highlight: 'side' },
    { key: 'quantity',        label: 'Qty',    numeric: true },
    { key: 'price',           label: 'Price',  numeric: true },
    { key: 'orderType',       label: 'Type' },
    { key: 'createTime',      label: 'Time' },
  ],
  trades: [
    { key: 'tradingSymbol',   label: 'Symbol' },
    { key: 'transactionType', label: 'Side',   highlight: 'side' },
    { key: 'tradedQuantity',  label: 'Qty',    numeric: true },
    { key: 'tradedPrice',     label: 'Price',  numeric: true },
    { key: 'createTime',      label: 'Time' },
  ],
};

function TabTable({ tab, data }: TabTableProps) {
  const cols = COLUMNS[tab];
  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-32 text-zinc-600 text-sm">
        No {tab} data
      </div>
    );
  }
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-zinc-800 z-10">
        <tr>
          {cols.map(c => (
            <th key={c.key} className={`px-3 py-2.5 text-xs font-bold text-white text-left whitespace-nowrap ${c.numeric ? 'text-right' : ''}`}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-800/50">
        {data.map((row, i) => (
          <tr key={i} className="hover:bg-zinc-800/40 transition-colors">
            {cols.map(c => {
              const val = row[c.key];
              const str = val == null ? '—' : String(val);
              let cls = `px-3 py-2 whitespace-nowrap font-mono ${c.numeric ? 'text-right tabular-nums' : ''}`;
              if (c.highlight === 'side') {
                cls += str === 'BUY' ? ' text-emerald-400 font-bold' : str === 'SELL' ? ' text-rose-400 font-bold' : ' text-zinc-300';
              } else if (c.highlight === 'pnl') {
                const n = Number(val);
                cls += !isNaN(n) && n !== 0 ? (n > 0 ? ' text-emerald-400' : ' text-rose-400') : ' text-zinc-400';
              } else {
                cls += ' text-zinc-300';
              }
              return <td key={c.key} className={cls}>{str}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── FundsView ────────────────────────────────────────────────────

interface FundsViewProps {
  data: Record<string, any> | null;
  realizedPnl: number;
}

function formatFundsValue(val: number): string {
  if (val === 0) return '0';
  if (Number.isInteger(val)) {
    return val.toLocaleString('en-IN');
  }
  return val.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

function FundsView({ data, realizedPnl }: FundsViewProps) {
  if (!data) {
    return (
      <div className="flex items-center justify-center h-32 text-zinc-600 text-sm">
        No funds data available
      </div>
    );
  }

  const available = Number(data.availabelBalance) || 0;
  const used = Number(data.utilizedAmount) || 0;
  const total = available + used;

  const rows = [
    { label: 'Total Balance', value: total },
    { label: 'Used Margin', value: used },
    { label: 'Realized P&L', value: realizedPnl },
    { label: 'Available', value: available },
  ];

  const renderSection = (title: string) => (
    <div className="flex-1 min-w-[280px] bg-zinc-900/20 border border-zinc-800/60 rounded-xl p-5">
      <h3 className="text-zinc-200 text-sm font-semibold mb-4 tracking-wide border-b border-zinc-800/80 pb-2">{title}</h3>
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="border-b border-zinc-800/40 text-zinc-500 font-semibold text-left">
            <th className="pb-2 font-medium">Type</th>
            <th className="pb-2 text-right font-medium">Balance</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/20 text-zinc-300">
          {rows.map((row) => (
            <tr key={row.label} className="hover:bg-zinc-800/10 transition-colors">
              <td className="py-3 text-left text-zinc-400">{row.label}</td>
              <td className={`py-3 text-right font-semibold ${
                row.label === 'Realized P&L' && row.value !== 0
                  ? row.value > 0 ? 'text-emerald-400' : 'text-rose-400'
                  : 'text-zinc-100'
              }`}>
                {formatFundsValue(row.value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="flex flex-wrap gap-5 p-5">
      {renderSection('NSE - Derivatives')}
      {renderSection('NSE - Equity')}
    </div>
  );
}
