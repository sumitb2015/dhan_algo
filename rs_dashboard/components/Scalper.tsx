'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import NavBar from './NavBar';
import { Zap, RefreshCw, Shield, ChevronDown } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────

interface OptionSide { ltp: number; oi: number; volume: number }
interface StrikeData  { strike: number; ce: OptionSide; pe: OptionSide }

interface LiveQuotes {
  updated_at: string | null;
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
  const [ceLoading, setCeLoading] = useState(false);
  const [peLoading, setPeLoading] = useState(false);

  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Bottom tabs
  const [activeTab, setActiveTab]       = useState<'positions' | 'orders' | 'trades'>('positions');
  const [positionsData, setPositionsData] = useState<Record<string, unknown>[]>([]);
  const [ordersData, setOrdersData]       = useState<Record<string, unknown>[]>([]);
  const [tradesData, setTradesData]       = useState<Record<string, unknown>[]>([]);
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

  const pollRef = useRef<NodeJS.Timeout | null>(null);

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
            if (j.quotes?.strikes) {
              setLiveQuotes(j.quotes);
              setLastUpdated(new Date().toLocaleTimeString('en-IN', {
                hour: '2-digit', minute: '2-digit', second: '2-digit',
              }));
            }
          }
        })
        .catch(() => {});
    };

    poll();
    pollRef.current = setInterval(poll, 500);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [expiry]);

  // ─── useEffect 4: Poll positions/orders/trades every 5s ──────────

  const fetchTabData = useCallback(() => {
    setTabLoading(true);
    Promise.all([
      fetch('/api/scalper/positions').then(r => r.json()).catch(() => ({ success: false, data: [] })),
      fetch('/api/scalper/orders').then(r => r.json()).catch(() => ({ success: false, data: [] })),
      fetch('/api/scalper/trades').then(r => r.json()).catch(() => ({ success: false, data: [] })),
    ]).then(([pos, ord, trd]) => {
      const p = pos as { success: boolean; data?: Record<string, unknown>[] };
      const o = ord as { success: boolean; data?: Record<string, unknown>[] };
      const t = trd as { success: boolean; data?: Record<string, unknown>[] };
      if (p.success) setPositionsData(p.data ?? []);
      if (o.success) setOrdersData(o.data ?? []);
      if (t.success) setTradesData(t.data ?? []);
    }).finally(() => setTabLoading(false));
  }, []);

  useEffect(() => {
    fetchTabData();
    const id = setInterval(fetchTabData, 5000);
    return () => clearInterval(id);
  }, [fetchTabData]);

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

    const setter = option === 'CE' ? setCeLoading : setPeLoading;
    setter(true);
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
    } finally {
      setter(false);
    }
  }, [ceStrike, peStrike, ceLimitPrice, peLimitPrice, expiry, lots, lotSize, strikeMap, orderMode, addToast, fetchTabData]);

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

  useEffect(() => {
    if (showPnlGuard) fetchPnlGuardStatus();
  }, [showPnlGuard, fetchPnlGuardStatus]);

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
              P&amp;L Guard
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
          loading={ceLoading}
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
          loading={peLoading}
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
          <TabTable
            tab={activeTab}
            data={activeTab === 'positions' ? positionsData : activeTab === 'orders' ? ordersData : tradesData}
          />
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
  loading: boolean;
  onStrikeChange: (s: number) => void;
  onLimitPriceChange: (p: string) => void;
  onBuy: () => void;
  onSell: () => void;
}

function OptionPanel({
  side, label, strike, visibleStrikes, atm, ltp, pct,
  limitPrice, orderMode, loading, onStrikeChange, onLimitPriceChange, onBuy, onSell,
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
      <div className="bg-zinc-800/50 rounded-xl p-4">
        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1">LTP</p>
        <p className="text-3xl font-bold font-mono tabular-nums text-white leading-none">
          {fmtLTP(ltp)}
        </p>
        {pct !== null ? (
          <p className={`text-sm font-semibold font-mono mt-1.5 ${isPos(pct) ? 'text-emerald-400' : 'text-rose-400'}`}>
            {isPos(pct) ? '▲' : '▼'} {Math.abs(pct).toFixed(2)}%
          </p>
        ) : (
          <p className="text-xs text-zinc-600 mt-1.5">— vs prev close</p>
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
          disabled={loading || !strike}
          className="py-3.5 px-4 text-sm font-bold rounded-xl transition-all active:scale-95
                     bg-emerald-600 hover:bg-emerald-500 text-white
                     disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100
                     shadow-lg shadow-emerald-900/20"
        >
          {loading ? '…' : `BUY ${side}`}
        </button>
        <button
          onClick={onSell}
          disabled={loading || !strike}
          className="py-3.5 px-4 text-sm font-bold rounded-xl transition-all active:scale-95
                     bg-rose-600 hover:bg-rose-500 text-white
                     disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100
                     shadow-lg shadow-rose-900/20"
        >
          {loading ? '…' : `SELL ${side}`}
        </button>
      </div>
    </div>
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
