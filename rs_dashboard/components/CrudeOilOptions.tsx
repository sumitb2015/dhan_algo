'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { RefreshCw, AlertCircle, Loader2 } from 'lucide-react';
import CrudeOilOITab from './CrudeOilOITab';
import CrudeOilCumulativeOITab from './CrudeOilCumulativeOITab';

// ─── Types ────────────────────────────────────────────────────────

interface OptionSide {
  last_price?: number;
  oi?: number;
  implied_volatility?: number;
  volume?: number;
  security_id?: string | number;
}

interface RawChainEntry { ce?: OptionSide; pe?: OptionSide }

interface ProcessedRow {
  strike: number;
  ce: OptionSide | null;
  pe: OptionSide | null;
  ceOIPct: number;
  peOIPct: number;
  pcr: number | null;
  straddle: number;        // CE LTP + PE LTP
  isATM: boolean;
  isMaxCEOI: boolean;
  isMaxPEOI: boolean;
  isMinStraddle: boolean;
}

interface CrudePosition {
  symbol: string;
  securityId?: string;
  exchangeSegment?: string;
  positionType: string;
  netQty: number;
  buyAvg: number;
  sellAvg: number;
  lastPrice: number;
  realizedProfit: number;
  unrealizedProfit: number;
}

interface CrudeOrder {
  orderId: string;
  symbol: string;
  exchange: string;
  orderType: string;
  transactionType: string;
  productType: string;
  quantity: number;
  filledQty: number;
  price: number;
  triggerPrice: number;
  tradedPrice: number;
  status: string;
  validity: string;
  createTime: string;
  updateTime: string;
}

interface CrudeTrade {
  orderId: string;
  symbol: string;
  exchange: string;
  transactionType: string;
  productType: string;
  tradedQuantity: number;
  tradedPrice: number;
  tradeId: string;
  createTime: string;
  exchangeTime: string;
}

// ─── Constants ────────────────────────────────────────────────────

const UNDERLYING  = 'CRUDEOIL';
const STRIKE_STEP = 100;
const POLL_MS     = 15_000;

const WING_OPTIONS = [5, 10, 15, 20] as const;
type Wings = typeof WING_OPTIONS[number];

// ─── Helpers ──────────────────────────────────────────────────────

function fmtNum(n: number, dec = 0): string {
  return n.toLocaleString('en-IN', {
    maximumFractionDigits: dec,
    minimumFractionDigits: dec,
  });
}

function fmtOI(n: number): string {
  if (n === 0) return '—';
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 10_000_000) return `${sign}${(abs / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000)    return `${sign}${(abs / 100_000).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
}

function fmtLTP(n: number | undefined): string {
  if (!n) return '—';
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
}

function fmtPnl(n: number): string {
  const abs = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${n < 0 ? '-' : '+'}₹${abs}`;
}

function pctColor(n: number): string {
  return n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-400';
}

function pctSign(n: number): string {
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

function statusColor(status: string): string {
  const s = status.toUpperCase();
  if (s.includes('TRADED') || s.includes('EXECUTED') || s.includes('COMPLETE')) return 'text-emerald-400';
  if (s.includes('REJECT') || s.includes('CANCEL')) return 'text-red-400';
  if (s.includes('PENDING') || s.includes('OPEN') || s.includes('TRANSIT')) return 'text-amber-400';
  return 'text-zinc-400';
}

interface StrikeEntry { key: string; strike: number; entry: RawChainEntry }

function parseStrikeEntries(oc: Record<string, RawChainEntry>): StrikeEntry[] {
  return Object.entries(oc)
    .map(([key, entry]) => ({ key, strike: Number(key), entry }))
    .filter(x => !isNaN(x.strike))
    .sort((a, b) => a.strike - b.strike);
}

function computeMaxPain(entries: StrikeEntry[]): number {
  if (!entries.length) return 0;
  let maxPain = entries[0].strike;
  let minPayout = Infinity;
  for (const { strike: K } of entries) {
    let payout = 0;
    for (const { strike: s, entry } of entries) {
      payout += (entry.ce?.oi ?? 0) * Math.max(0, K - s);
      payout += (entry.pe?.oi ?? 0) * Math.max(0, s - K);
    }
    if (payout < minPayout) { minPayout = payout; maxPain = K; }
  }
  return maxPain;
}

// ─── Sub-components ───────────────────────────────────────────────

function StatTile({ label, value, sub, subColor }: { label: string; value: React.ReactNode; sub?: React.ReactNode; subColor?: string }) {
  return (
    <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800 flex flex-col gap-1">
      <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">{label}</span>
      <span className="text-lg font-bold text-zinc-100 tabular-nums">{value}</span>
      {sub && <span className={`text-xs ${subColor ?? 'text-zinc-400'}`}>{sub}</span>}
    </div>
  );
}

function OIBar({ pct, side }: { pct: number; side: 'ce' | 'pe' }) {
  const barColor = side === 'ce' ? 'rgba(59,130,246,0.35)' : 'rgba(239,68,68,0.35)';
  const width = `${Math.min(pct, 100)}%`;
  return (
    <div className="relative h-4 w-full min-w-[48px]">
      {side === 'ce' ? (
        <div
          className="absolute inset-y-0 right-0 rounded-sm"
          style={{ width, backgroundColor: barColor }}
        />
      ) : (
        <div
          className="absolute inset-y-0 left-0 rounded-sm"
          style={{ width, backgroundColor: barColor }}
        />
      )}
      <span className={`relative z-10 text-[10px] tabular-nums font-bold text-zinc-200 ${side === 'ce' ? 'float-right' : 'float-left'}`}>
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────

export default function CrudeOilOptions() {
  const [expiries, setExpiries]       = useState<string[]>([]);
  const [expiry, setExpiry]           = useState<string>('');
  const [spot, setSpot]               = useState(0);
  const [prevClose, setPrevClose]     = useState(0);
  const [change, setChange]           = useState(0);
  const [changePct, setChangePct]     = useState(0);

  const [rows, setRows]               = useState<ProcessedRow[]>([]);
  const [atm, setAtm]                 = useState(0);
  const [chainPCR, setChainPCR]       = useState<number | null>(null);
  const [maxPain, setMaxPain]         = useState<number | null>(null);
  const [totalCEOI, setTotalCEOI]     = useState(0);
  const [totalPEOI, setTotalPEOI]     = useState(0);
  const [atmStraddle, setAtmStraddle] = useState<number | null>(null);
  const [wings, setWings]             = useState<Wings>(10);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');

  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const [lots, setLots]               = useState(1);
  // MCX order quantity is in LOTS (verified from live order book), so lot size is 1 —
  // NOT 100 (that's barrels per lot, already baked into the contract)
  const [lotSize, setLotSize]         = useState(1);
  const [orderMessage, setOrderMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const [ordering, setOrdering]       = useState(false);

  // Confirmation dialog for SL/Target auto-exit
  type ConfirmPayload = {
    symbol: string;
    reason: string;
    leg: { securityId: string; quantity: number; side: 'BUY' | 'SELL'; exchangeSegment: string };
  };
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmPayload | null>(null);

  const [crudePositions, setCrudePositions] = useState<CrudePosition[]>([]);
  const [crudeOrders, setCrudeOrders]       = useState<CrudeOrder[]>([]);
  const [crudeTrades, setCrudeTrades]       = useState<CrudeTrade[]>([]);
  const [tradesError, setTradesError]       = useState<string | null>(null);
  const [tradesLoading, setTradesLoading]   = useState(true);
  const [activeActivityTab, setActiveActivityTab] = useState<'positions' | 'orders' | 'trades'>('positions');
  const tradesIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const [activeTab, setActiveTab]           = useState<'chain' | 'oi' | 'cumulative'>('chain');



  const [exitingAll, setExitingAll]         = useState(false);

  const activePositions = crudePositions.filter(p => p.netQty !== 0);
  const activePositionsCount = activePositions.length;

  const totalRealized   = crudePositions.reduce((sum, p) => sum + p.realizedProfit, 0);
  const totalUnrealized = crudePositions.reduce((sum, p) => sum + p.unrealizedProfit, 0);
  const totalPnl        = totalRealized + totalUnrealized;

  const handleExitAll = async () => {
    if (activePositions.length === 0) return;

    if (!confirm(`Are you sure you want to close ALL ${activePositions.length} open Crude Oil positions immediately?`)) {
      return;
    }

    setExitingAll(true);
    setOrderMessage(null);

    const legs = activePositions.map(p => ({
      securityId: p.securityId || '',
      quantity: Math.abs(p.netQty),
      side: (p.netQty > 0 ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
      exchangeSegment: p.exchangeSegment || 'MCX_COMM',
    }));

    try {
      const res = await fetch('/api/options/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ legs, mode: 'intraday' }),
      });

      const json = await res.json() as { success: boolean; error?: string };
      if (json.success) {
        setOrderMessage({ text: 'Square-off orders placed successfully for all active positions.', isError: false });
        void fetchCrudeTrades();
      } else {
        setOrderMessage({ text: json.error ?? 'Failed to square off some positions.', isError: true });
      }
    } catch (err) {
      setOrderMessage({ text: `Error during square off: ${String(err)}`, isError: true });
    } finally {
      setExitingAll(false);
    }
  };

  useEffect(() => {
    fetch(`/api/lotsize?symbol=${UNDERLYING}`)
      .then(r => r.json())
      .then(json => {
        if (json.lot_size) setLotSize(json.lot_size);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (orderMessage) {
      const t = setTimeout(() => setOrderMessage(null), 6000);
      return () => clearTimeout(t);
    }
  }, [orderMessage]);

  const handlePlaceOrder = useCallback(async (securityId: string | number, side: 'BUY' | 'SELL') => {
    if (ordering) return;
    setOrdering(true);
    setOrderMessage(null);
    try {
      const qty = lots * lotSize;
      const res = await fetch('/api/options/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          legs: [{ securityId: String(securityId), quantity: qty, side, exchangeSegment: 'MCX_COMM' }],
          mode: 'intraday'
        })
      });
      const json = await res.json();
      if (json.success) {
        setOrderMessage({
          text: `Successfully fired MARKET order to ${side} ${qty} Qty (${lots} Lot${lots > 1 ? 's' : ''})! Order ID: ${json.data?.[0]?.orderId || 'N/A'}`,
          isError: false
        });
      } else {
        setOrderMessage({ text: `Failed: ${json.error || 'Unknown error'}`, isError: true });
      }
    } catch (err) {
      setOrderMessage({ text: `Error placing order: ${String(err)}`, isError: true });
    } finally {
      setOrdering(false);
    }
  }, [lots, lotSize, ordering]);

  // Fetch expiries
  useEffect(() => {
    async function loadExpiries() {
      try {
        const res = await fetch(`/api/options/expiries?underlying=${UNDERLYING}`);
        const json = await res.json() as { success: boolean; data?: string[]; error?: string };
        if (json.success && json.data?.length) {
          setExpiries(json.data);
          setExpiry(json.data[0]);
        } else {
          setError(json.error ?? 'Failed to load expiries');
        }
      } catch (err) {
        setError(String(err));
      }
    }
    void loadExpiries();
  }, []);

  // Fetch spot price
  const fetchSpot = useCallback(async () => {
    try {
      const res = await fetch(`/api/options/spot?underlying=${UNDERLYING}`);
      const json = await res.json() as {
        success: boolean;
        spot?: number;
        prev_close?: number;
        change?: number;
        change_pct?: number;
      };
      if (json.success) {
        setSpot(json.spot ?? 0);
        setPrevClose(json.prev_close ?? 0);
        setChange(json.change ?? 0);
        setChangePct(json.change_pct ?? 0);
      }
    } catch { /* ignore spot errors, chain fetch has fallback spot */ }
  }, []);

  // Fetch option chain
  const fetchChain = useCallback(async () => {
    if (!expiry) return;
    try {
      const res = await fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${expiry}`);
      const json = await res.json() as {
        success: boolean;
        data?: { chain: { oc?: Record<string, RawChainEntry> }; spot: number };
        error?: string;
      };

      if (!json.success || !json.data?.chain?.oc) {
        setError(json.error ?? 'No chain data');
        return;
      }

      const spotPrice = json.data.spot ?? 0;
      if (spotPrice <= 0) {
        setError('Spot price unavailable — showing last known chain');
        return;
      }
      const atmStrike = Math.round(spotPrice / STRIKE_STEP) * STRIKE_STEP;

      const oc        = json.data.chain.oc;
      if (!oc || Object.keys(oc).length === 0) {
        setError('Option chain data empty — showing last known chain');
        return;
      }

      const allEntries = parseStrikeEntries(oc).filter(({ strike }) => strike % STRIKE_STEP === 0);
      const mpStrike = computeMaxPain(allEntries);

      // Slicing window around ATM
      const atmIdx  = allEntries.reduce((best, { strike }, i) =>
        Math.abs(strike - atmStrike) < Math.abs(allEntries[best].strike - atmStrike) ? i : best, 0);
      const lo      = Math.max(0, atmIdx - wings);
      const hi      = Math.min(allEntries.length - 1, atmIdx + wings);
      const visible = allEntries.slice(lo, hi + 1);

      let totCE = 0, totPE = 0;
      for (const { entry } of allEntries) {
        totCE += entry.ce?.oi ?? 0;
        totPE += entry.pe?.oi ?? 0;
      }

      let maxCEOI = 0, maxPEOI = 0, maxCEStrike = 0, maxPEStrike = 0;
      for (const { strike, entry } of visible) {
        const ceOI = entry.ce?.oi ?? 0;
        const peOI = entry.pe?.oi ?? 0;
        if (ceOI > maxCEOI) { maxCEOI = ceOI; maxCEStrike = strike; }
        if (peOI > maxPEOI) { maxPEOI = peOI; maxPEStrike = strike; }
      }

      const straddleMap = new Map<number, number>();
      let minStraddle = Infinity, minStraddleStrike = 0;
      for (const { strike, entry } of visible) {
        const s = (entry.ce?.last_price ?? 0) + (entry.pe?.last_price ?? 0);
        straddleMap.set(strike, s);
        if (s > 0 && s < minStraddle) { minStraddle = s; minStraddleStrike = strike; }
      }

      const processed: ProcessedRow[] = visible.map(({ strike, entry }) => {
        const ce    = entry.ce ?? null;
        const pe    = entry.pe ?? null;
        const ceOI  = ce?.oi ?? 0;
        const peOI  = pe?.oi ?? 0;
        const strad = straddleMap.get(strike) ?? 0;
        return {
          strike,
          ce,
          pe,
          ceOIPct:       maxCEOI > 0 ? (ceOI / maxCEOI) * 100 : 0,
          peOIPct:       maxPEOI > 0 ? (peOI / maxPEOI) * 100 : 0,
          pcr:           ceOI > 0 ? peOI / ceOI : null,
          straddle:      strad,
          isATM:         strike === atmStrike,
          isMaxCEOI:     strike === maxCEStrike && maxCEOI > 0,
          isMaxPEOI:     strike === maxPEStrike && maxPEOI > 0,
          isMinStraddle: strike === minStraddleStrike && minStraddle < Infinity,
        };
      });

      const atmRow = processed.find(r => r.isATM);
      const atmStrad = atmRow ? atmRow.straddle : null;

      // Update states
      if (spotPrice > 0) setSpot(spotPrice);
      setAtm(atmStrike);
      setRows(processed);
      setTotalCEOI(totCE);
      setTotalPEOI(totPE);
      setChainPCR(totCE > 0 ? totPE / totCE : null);
      setMaxPain(mpStrike);
      setAtmStraddle(atmStrad && atmStrad > 0 ? atmStrad : null);
      setLastUpdated(new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }));
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [expiry, wings]);

  // Combined fetch trigger
  const runPoll = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchSpot(), fetchChain()]);
    setLoading(false);
  }, [fetchSpot, fetchChain]);

  // Set up polling
  useEffect(() => {
    if (!expiry) return;
    void runPoll();
    intervalRef.current = setInterval(runPoll, POLL_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [expiry, runPoll]);

  // Fetch crude oil positions/orders/trades (independent poll loop)
  const fetchCrudeTrades = useCallback(async () => {
    try {
      const res = await fetch('/api/crudeoil-trades');
      const json = await res.json() as {
        success: boolean;
        positions?: CrudePosition[];
        orders?: CrudeOrder[];
        trades?: CrudeTrade[];
        error?: string;
      };
      if (json.success) {
        setCrudePositions(json.positions ?? []);
        setCrudeOrders(json.orders ?? []);
        setCrudeTrades(json.trades ?? []);
        setTradesError(null);
      } else {
        setTradesError(json.error ?? 'Failed to load crude oil trades data');
      }
    } catch (err) {
      setTradesError(String(err));
    } finally {
      setTradesLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchCrudeTrades();
    tradesIntervalRef.current = setInterval(fetchCrudeTrades, POLL_MS);
    return () => { if (tradesIntervalRef.current) clearInterval(tradesIntervalRef.current); };
  }, [fetchCrudeTrades]);

  // --- SL and Target: dashboard-level thresholds ---
  const [editingConfigs, setEditingConfigs] = useState<Record<string, { sl?: string; target?: string }>>({});

  // riskConfigs holds committed threshold values (these are only dashboard-level triggers — NOT broker orders)
  const [riskConfigs, setRiskConfigs] = useState<Record<string, { sl: number | null; target: number | null }>>({});

  useEffect(() => {
    try {
      const saved = localStorage.getItem('crude_risk_configs_v2');
      if (saved) setRiskConfigs(JSON.parse(saved));
    } catch {}
  }, []);

  const saveRiskConfigs = (updated: typeof riskConfigs) => {
    setRiskConfigs(updated);
    localStorage.setItem('crude_risk_configs_v2', JSON.stringify(updated));
  };

  const handleInputChange = (symbol: string, key: 'sl' | 'target', value: string) => {
    setEditingConfigs(prev => ({
      ...prev,
      [symbol]: { ...(prev[symbol] || {}), [key]: value },
    }));
  };

  // Called when user presses Enter or blurs the input
  // Only stores a threshold locally — never touches the broker here.
  // `overrideValue` bypasses the editing buffer (setState is async, so a caller that
  // just queued a value can't rely on editingConfigs having it yet — e.g. the ✕ button).
  const handleInputCommit = useCallback((symbol: string, key: 'sl' | 'target', overrideValue?: string) => {
    const editState = editingConfigs[symbol];
    if (overrideValue === undefined && (!editState || editState[key] === undefined)) return;

    const rawVal = overrideValue !== undefined ? overrideValue : editState![key]!;
    const price = (rawVal === '' || isNaN(parseFloat(rawVal))) ? null : parseFloat(rawVal);

    // Always clear the editing buffer
    setEditingConfigs(prev => {
      const copy = { ...prev };
      if (copy[symbol]) {
        delete copy[symbol][key];
        if (Object.keys(copy[symbol]).length === 0) delete copy[symbol];
      }
      return copy;
    });

    if (price === null || price <= 0) {
      // User cleared the field → just remove the threshold
      const updated = { ...riskConfigs };
      if (updated[symbol]) {
        updated[symbol] = { ...updated[symbol], [key]: null };
        if (updated[symbol].sl === null && updated[symbol].target === null) delete updated[symbol];
      }
      saveRiskConfigs(updated);
      setOrderMessage({ text: `${key === 'sl' ? 'Stop-Loss' : 'Target'} removed for ${symbol}.`, isError: false });
      return;
    }

    // Find the position to validate direction against current LTP
    const pos = crudePositions.find(p => p.symbol === symbol && p.netQty !== 0);
    if (!pos) {
      setOrderMessage({ text: `Cannot set ${key.toUpperCase()}: active position not found for ${symbol}.`, isError: true });
      return;
    }

    const ltp = pos.lastPrice;
    const isShort = pos.netQty < 0;

    // Require a known LTP — reject if 0/unavailable
    if (ltp <= 0) {
      setOrderMessage({ text: `Cannot set ${key.toUpperCase()}: LTP for ${symbol} is not yet available. Wait for price data and try again.`, isError: true });
      return;
    }

    // ─── Direction validation ─────────────────────────────────────────────────────────
    // SHORT (sold options): price must RISE to hit SL, FALL to hit Target
    //   SL must be ABOVE ltp    |   Target must be BELOW ltp
    // LONG (bought options): price must FALL to hit SL, RISE to hit Target
    //   SL must be BELOW ltp    |   Target must be ABOVE ltp
    if (key === 'sl') {
      if (isShort && price <= ltp) {
        setOrderMessage({
          text: `❌ SL rejected: You are SHORT ${symbol} (LTP ₹${ltp.toFixed(1)}). SL (₹${price}) must be ABOVE the current price. The monitor fires when price rises to your SL.`,
          isError: true,
        });
        return;
      }
      if (!isShort && price >= ltp) {
        setOrderMessage({
          text: `❌ SL rejected: You are LONG ${symbol} (LTP ₹${ltp.toFixed(1)}). SL (₹${price}) must be BELOW the current price. The monitor fires when price falls to your SL.`,
          isError: true,
        });
        return;
      }
    } else {
      if (isShort && price >= ltp) {
        setOrderMessage({
          text: `❌ Target rejected: You are SHORT ${symbol} (LTP ₹${ltp.toFixed(1)}). Target (₹${price}) must be BELOW the current price. The monitor fires when the option decays to your target.`,
          isError: true,
        });
        return;
      }
      if (!isShort && price <= ltp) {
        setOrderMessage({
          text: `❌ Target rejected: You are LONG ${symbol} (LTP ₹${ltp.toFixed(1)}). Target (₹${price}) must be ABOVE the current price.`,
          isError: true,
        });
        return;
      }
    }

    // All checks passed — save threshold locally
    const updated = {
      ...riskConfigs,
      [symbol]: {
        ...(riskConfigs[symbol] || { sl: null, target: null }),
        [key]: price,
      },
    };
    saveRiskConfigs(updated);
    const dir = key === 'sl'
      ? (isShort ? 'will fire when price RISES to' : 'will fire when price FALLS to')
      : (isShort ? 'will fire when price FALLS to' : 'will fire when price RISES to');
    setOrderMessage({
      text: `✅ ${key === 'sl' ? 'Stop-Loss' : 'Target'} set for ${symbol}: monitor ${dir} ₹${price}. A confirmation dialog will appear before any order is placed.`,
      isError: false,
    });
  }, [editingConfigs, crudePositions, riskConfigs]);

  // Prune stale configs when positions close
  useEffect(() => {
    if (Object.keys(riskConfigs).length === 0) return;
    let hasStale = false;
    const cleaned = { ...riskConfigs };
    Object.keys(cleaned).forEach(sym => {
      const pos = crudePositions.find(p => p.symbol === sym);
      if (!pos || pos.netQty === 0) { delete cleaned[sym]; hasStale = true; }
    });
    if (hasStale) saveRiskConfigs(cleaned);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crudePositions]);

  // ─── Auto-exit monitor: check SL/Target thresholds each poll tick ─────────────────
  // When breached, set pendingConfirm so the user sees a dialog BEFORE any order fires.
  useEffect(() => {
    if (crudePositions.length === 0 || pendingConfirm) return;

    for (const p of crudePositions) {
      if (p.netQty === 0) continue;
      const config = riskConfigs[p.symbol];
      if (!config) continue;
      const ltp = p.lastPrice;
      if (ltp <= 0) continue;

      const isShort = p.netQty < 0;
      let triggered: { type: 'SL' | 'Target'; threshold: number } | null = null;

      if (isShort) {
        if (config.sl   !== null && config.sl   > 0 && ltp >= config.sl)   triggered = { type: 'SL',     threshold: config.sl };
        if (config.target !== null && config.target > 0 && ltp <= config.target) triggered = { type: 'Target', threshold: config.target };
      } else {
        if (config.sl   !== null && config.sl   > 0 && ltp <= config.sl)   triggered = { type: 'SL',     threshold: config.sl };
        if (config.target !== null && config.target > 0 && ltp >= config.target) triggered = { type: 'Target', threshold: config.target };
      }

      if (triggered && p.securityId) {
        // Immediately clear the config to prevent re-triggering on next tick
        const cleaned = { ...riskConfigs };
        delete cleaned[p.symbol];
        saveRiskConfigs(cleaned);

        setPendingConfirm({
          symbol: p.symbol,
          reason: `${triggered.type} hit! LTP ₹${ltp.toFixed(1)} ${triggered.type === 'SL' ? (isShort ? '≥' : '≤') : (isShort ? '≤' : '≥')} threshold ₹${triggered.threshold}`,
          leg: {
            securityId: p.securityId,
            quantity: Math.abs(p.netQty),
            side: (isShort ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
            exchangeSegment: p.exchangeSegment || 'MCX_COMM',
          },
        });
        break; // Handle one at a time
      }
    }
  }, [crudePositions, riskConfigs, pendingConfirm]);

  // Style helpers
  const thCls = 'text-xs font-bold text-zinc-300 bg-zinc-800/80 px-3 py-2.5 whitespace-nowrap border-b border-zinc-700';

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="sticky top-0 w-full border-b border-zinc-900 bg-zinc-950/60 backdrop-blur-md px-5 py-3 flex items-center gap-4 z-20 flex-wrap">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 shadow">
            <RefreshCw className="h-4 w-4 text-white" />
          </div>
          <div>
            <div className="text-sm font-bold text-zinc-100 leading-none">Crude Oil Options</div>
            <div className="text-[10px] text-zinc-500 mt-0.5">MCX Commodity Option Chain & Stats</div>
          </div>
        </div>


        {/* Action Controls & Navigation */}
        <div className="ml-auto flex items-center gap-3">
          {crudePositions.length > 0 && (
            <div className="flex items-center gap-2.5 px-3.5 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Crude P&L</span>
              <span className={`text-sm font-bold tabular-nums ${totalPnl > 0 ? 'text-emerald-400' : totalPnl < 0 ? 'text-red-400' : 'text-zinc-300'}`}>
                {fmtPnl(totalPnl)}
              </span>
              <span className="text-[10px] text-zinc-500 tabular-nums whitespace-nowrap">
                R {fmtPnl(totalRealized)} · U {fmtPnl(totalUnrealized)}
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={handleExitAll}
            disabled={exitingAll || activePositionsCount === 0}
            className="text-xs font-bold px-3.5 py-1.5 rounded-lg border border-red-900/60 bg-red-950/20 hover:bg-red-900/40 hover:border-red-700/80 transition-all duration-200 text-red-400 hover:text-red-200 disabled:opacity-40 disabled:pointer-events-none flex items-center gap-1.5 cursor-pointer shadow-md"
          >
            {exitingAll ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <AlertCircle className="h-3.5 w-3.5" />
            )}
            Exit All Positions ({activePositionsCount})
          </button>

          <Link
            href="/options"
            className="text-xs font-bold px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 transition-colors text-zinc-300 hover:text-zinc-100"
          >
            ← Go to Nifty Options
          </Link>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        
        {/* Error Notification */}
        {error && (
          <div className="flex items-center gap-2 text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-sm">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Tab Selection Bar with Expiry Selector */}
        <div className="flex flex-wrap items-center justify-between border-b border-zinc-800 pb-0 mb-6 gap-3">
          <div className="flex gap-1 -mb-px">
            {([
              { key: 'chain',      label: 'Option Chain' },
              { key: 'oi',         label: 'Open Interest' },
              { key: 'cumulative', label: 'Cumulative OI' },
            ] as const).map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setActiveTab(key)}
                className={`px-4 py-2.5 text-xs font-semibold capitalize transition-all border-b-2 cursor-pointer -mb-px ${
                  activeTab === key
                    ? 'text-white border-blue-500 font-bold'
                    : 'text-zinc-400 border-transparent hover:text-zinc-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Expiry Selector (shown for Chain and OI tabs) */}
          {(activeTab === 'chain' || activeTab === 'oi') && (
            <div className="flex items-center gap-2 mb-2 sm:mb-0">
              <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Expiry:</span>
              {expiries.length === 0 ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />
              ) : (
                <select
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                  className="bg-zinc-900 border border-zinc-800 rounded-lg text-xs font-semibold text-zinc-200 px-3 py-1.5 focus:outline-none focus:border-blue-500 cursor-pointer"
                >
                  {expiries.map(exp => (
                    <option key={exp} value={exp}>
                      {new Date(exp).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>

        {/* Stats Grid */}
        {(activeTab === 'chain' || activeTab === 'oi') && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatTile
                label="Crude Spot (Fut)"
                value={spot ? `₹${fmtNum(spot)}` : '—'}
                sub={spot && prevClose > 0 ? (
                  <span className={pctColor(changePct)}>
                    {change >= 0 ? '+' : ''}{fmtNum(change, 1)} ({pctSign(changePct)})
                  </span>
                ) : 'Fetching...'}
                subColor="text-zinc-400"
              />

              <StatTile
                label="Put-Call Ratio (PCR)"
                value={chainPCR !== null ? chainPCR.toFixed(3) : '—'}
                sub={chainPCR !== null ? (chainPCR > 1.2 ? 'Bullish Sentiment' : chainPCR < 0.8 ? 'Bearish Sentiment' : 'Neutral') : '—'}
                subColor={chainPCR !== null ? (chainPCR > 1.2 ? 'text-emerald-400' : chainPCR < 0.8 ? 'text-red-400' : 'text-zinc-500') : 'text-zinc-500'}
              />

              <StatTile
                label="Max Pain Strike"
                value={maxPain !== null ? `₹${fmtNum(maxPain)}` : '—'}
                sub="Options sellers' sweet spot"
              />

              <StatTile
                label="ATM Straddle Premium"
                value={atmStraddle ? `₹${fmtNum(atmStraddle, 1)}` : '—'}
                sub={atmStraddle && atm ? `Range: ${fmtNum(atm - atmStraddle)} – ${fmtNum(atm + atmStraddle)}` : '—'}
                subColor="text-cyan-400"
              />
            </div>

            {/* Additional Stats Row */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <StatTile label="Total Call OI" value={fmtOI(totalCEOI)} sub="Resistance Walls" subColor="text-blue-400" />
              <StatTile label="Total Put OI" value={fmtOI(totalPEOI)} sub="Support Walls" subColor="text-red-400" />
              <StatTile
                label="OI Bias (CE − PE)"
                value={(totalCEOI === 0 && totalPEOI === 0) ? '—' : (totalCEOI - totalPEOI >= 0 ? '+' : '') + fmtOI(totalCEOI - totalPEOI)}
                sub={totalCEOI - totalPEOI > 0 ? 'Heavy Resistance' : totalCEOI - totalPEOI < 0 ? 'Heavy Support' : 'Balanced'}
                subColor={totalCEOI - totalPEOI > 0 ? 'text-red-400' : totalCEOI - totalPEOI < 0 ? 'text-emerald-400' : 'text-zinc-500'}
              />
            </div>
          </>
        )}

        {/* Dynamic Tab Content: Option Chain Tab */}
        {activeTab === 'chain' && (
          <>
            {/* Controls and Selectors */}
            <div className="flex flex-wrap items-center gap-4 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">


          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Visible strikes:</span>
            <div className="flex gap-1">
              {WING_OPTIONS.map(w => (
                <button
                  key={w}
                  onClick={() => setWings(w)}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                    wings === w
                      ? 'bg-indigo-600 text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                  }`}
                >
                  ±{w}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 border-l border-zinc-800 pl-4">
            <span className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Lots:</span>
            <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-805 rounded-lg p-0.5">
              <button
                disabled={lots <= 1}
                onClick={() => setLots(prev => Math.max(1, prev - 1))}
                className="px-2 py-0.5 text-xs font-bold text-zinc-400 hover:text-white disabled:opacity-30 disabled:pointer-events-none rounded hover:bg-zinc-800"
              >
                -
              </button>
              <span className="w-8 text-center text-xs font-mono font-bold text-zinc-200">{lots}</span>
              <button
                onClick={() => setLots(prev => prev + 1)}
                className="px-2 py-0.5 text-xs font-bold text-zinc-400 hover:text-white rounded hover:bg-zinc-800"
              >
                +
              </button>
            </div>
            <span className="text-[10px] text-zinc-500 font-mono">({lots * lotSize} Qty)</span>
          </div>

          <div className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />}
            <span>Last Updated: {lastUpdated ?? '—'} (refresh 15s)</span>
          </div>
        </div>

        {/* Order Feedback Message */}
        {orderMessage && (
          <div className={`text-xs font-semibold rounded-xl px-4 py-3 border flex items-center gap-2 animate-fadeIn ${
            orderMessage.isError
              ? 'bg-red-500/10 border-red-500/20 text-red-400'
              : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
          }`}>
            <span className={`inline-block w-2 h-2 rounded-full ${orderMessage.isError ? 'bg-red-500 animate-pulse' : 'bg-emerald-500'}`} />
            <span className="flex-1">{orderMessage.text}</span>
            <button onClick={() => setOrderMessage(null)} className="text-[10px] text-zinc-400 hover:text-white font-bold ml-auto px-1.5 py-0.5 hover:bg-zinc-800/40 rounded">
              Dismiss
            </button>
          </div>
        )}

        {/* Smart Option Chain Table */}
        <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>
                <th className={`${thCls} text-right text-blue-300`}>CE OI</th>
                <th className={`${thCls} text-right text-blue-300`}>CE OI %</th>
                <th className={`${thCls} text-right text-blue-300`}>CE LTP</th>
                <th className={`${thCls} text-center text-amber-300 border-x border-zinc-750 w-32`}>STRIKE</th>
                <th className={`${thCls} text-left text-red-300`}>PE LTP</th>
                <th className={`${thCls} text-left text-red-300`}>PE OI %</th>
                <th className={`${thCls} text-left text-red-300`}>PE OI</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-8 text-zinc-500">
                    {loading ? 'Loading option chain data...' : 'Select an expiry date to display option chain.'}
                  </td>
                </tr>
              ) : (
                rows.map(row => {
                  const isITM_CE = row.strike < spot && spot > 0;
                  const isITM_PE = row.strike > spot && spot > 0;

                  const ceDim = isITM_CE ? 'text-zinc-400' : 'text-zinc-100';
                  const peDim = isITM_PE ? 'text-zinc-400' : 'text-zinc-100';

                  const ceBg = row.ce?.oi ? `rgba(59,130,246,${Math.min(row.ceOIPct * 0.005, 0.45)})` : 'transparent';
                  const peBg = row.pe?.oi ? `rgba(239,68,68,${Math.min(row.peOIPct * 0.005, 0.45)})` : 'transparent';

                  const rowBg = row.isATM
                    ? 'bg-amber-500/10'
                    : 'bg-zinc-900/40 hover:bg-zinc-800/60';

                  const borderL = row.isATM
                    ? 'border-l-2 border-l-amber-400'
                    : row.isMaxCEOI
                      ? 'border-l-4 border-l-blue-400'
                      : '';

                  const borderR = row.isMaxPEOI
                    ? 'border-r-4 border-r-red-400'
                    : '';

                  return (
                    <tr
                      key={row.strike}
                      className={`transition-colors border-b border-zinc-800/60 last:border-b-0 ${rowBg} ${borderL} ${borderR}`}
                    >
                      {/* CE OI */}
                      <td className="px-3 py-2 text-right" style={{ backgroundColor: ceBg }}>
                        <div className="flex items-center justify-end gap-1.5">
                          {row.isMaxCEOI && (
                            <span className="text-[9px] font-extrabold text-blue-400 bg-blue-500/20 px-1 py-0.5 rounded">MAX</span>
                          )}
                          <span className={`tabular-nums font-semibold ${ceDim}`}>
                            {fmtOI(row.ce?.oi ?? 0)}
                          </span>
                        </div>
                      </td>

                      {/* CE OI% Bar */}
                      <td className="px-3 py-2 w-20">
                        <OIBar pct={row.ceOIPct} side="ce" />
                      </td>

                      {/* CE LTP */}
                      <td className={`px-3 py-2 text-right tabular-nums font-bold ${isITM_CE ? 'text-zinc-400' : 'text-zinc-100'}`}>
                        <div className="flex items-center justify-end gap-2">
                          <span>{fmtLTP(row.ce?.last_price)}</span>
                          {row.ce?.security_id && (
                            <div className="flex gap-1">
                              <button
                                disabled={ordering}
                                onClick={() => handlePlaceOrder(row.ce!.security_id!, 'SELL')}
                                className="bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white disabled:opacity-50 disabled:pointer-events-none border border-red-500/30 rounded px-1.5 py-0.5 font-bold transition-all text-[10px]"
                                title="Market Sell Option"
                              >
                                S
                              </button>
                              <button
                                disabled={ordering}
                                onClick={() => handlePlaceOrder(row.ce!.security_id!, 'BUY')}
                                className="bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-white disabled:opacity-50 disabled:pointer-events-none border border-emerald-500/30 rounded px-1.5 py-0.5 font-bold transition-all text-[10px]"
                                title="Market Buy Option"
                              >
                                B
                              </button>
                            </div>
                          )}
                        </div>
                      </td>

                      {/* Strike */}
                      <td className={`px-4 py-2 text-center font-bold tabular-nums border-x border-zinc-800 ${
                        row.isATM ? 'text-amber-300 text-sm' : 'text-zinc-200'
                      }`}>
                        {fmtNum(row.strike)}
                        {row.isATM && <span className="ml-1 text-[9px] text-amber-500">ATM</span>}
                      </td>

                      {/* PE LTP */}
                      <td className={`px-3 py-2 text-left tabular-nums font-bold ${isITM_PE ? 'text-zinc-400' : 'text-zinc-100'}`}>
                        <div className="flex items-center justify-start gap-2">
                          {row.pe?.security_id && (
                            <div className="flex gap-1">
                              <button
                                disabled={ordering}
                                onClick={() => handlePlaceOrder(row.pe!.security_id!, 'BUY')}
                                className="bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-white disabled:opacity-50 disabled:pointer-events-none border border-emerald-500/30 rounded px-1.5 py-0.5 font-bold transition-all text-[10px]"
                                title="Market Buy Option"
                              >
                                B
                              </button>
                              <button
                                disabled={ordering}
                                onClick={() => handlePlaceOrder(row.pe!.security_id!, 'SELL')}
                                className="bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white disabled:opacity-50 disabled:pointer-events-none border border-red-500/30 rounded px-1.5 py-0.5 font-bold transition-all text-[10px]"
                                title="Market Sell Option"
                              >
                                S
                              </button>
                            </div>
                          )}
                          <span>{fmtLTP(row.pe?.last_price)}</span>
                        </div>
                      </td>

                      {/* PE OI% Bar */}
                      <td className="px-3 py-2 w-20">
                        <OIBar pct={row.peOIPct} side="pe" />
                      </td>

                      {/* PE OI */}
                      <td className="px-3 py-2 text-left" style={{ backgroundColor: peBg }}>
                        <div className="flex items-center justify-start gap-1.5">
                          <span className={`tabular-nums font-semibold ${peDim}`}>
                            {fmtOI(row.pe?.oi ?? 0)}
                          </span>
                          {row.isMaxPEOI && (
                            <span className="text-[9px] font-extrabold text-red-400 bg-red-500/20 px-1 py-0.5 rounded">MAX</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Crude Oil Positions / Orders / Trades */}
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 pb-2">
            <h2 className="text-sm font-bold text-zinc-300 uppercase tracking-wider">Crude Oil Activity</h2>
            
            {/* Tab Switchers */}
            <div className="flex bg-zinc-900/80 border border-zinc-850 rounded-lg p-0.5 shadow-inner">
              {(['positions', 'orders', 'trades'] as const).map((tab) => {
                const isActive = activeActivityTab === tab;
                const label = tab.charAt(0).toUpperCase() + tab.slice(1);
                
                let count = 0;
                if (tab === 'positions') count = crudePositions.length;
                else if (tab === 'orders') count = crudeOrders.length;
                else if (tab === 'trades') count = crudeTrades.length;

                return (
                  <button
                    key={tab}
                    onClick={() => setActiveActivityTab(tab)}
                    className={`relative px-4 py-1.5 rounded-md text-xs font-bold transition-all duration-255 flex items-center gap-2 ${
                      isActive
                        ? 'bg-zinc-800 text-zinc-100 shadow-sm border border-zinc-700/50'
                        : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
                    }`}
                  >
                    <span>{label}</span>
                    {count > 0 && (
                      <span className={`px-1.5 py-0.5 text-[10px] font-mono font-extrabold rounded-full transition-colors ${
                        isActive ? 'bg-indigo-600 text-white' : 'bg-zinc-800 text-zinc-500'
                      }`}>
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {tradesError && (
            <div className="flex items-center gap-2 text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-sm">
              <AlertCircle className="h-5 w-5 shrink-0" />
              <span>{tradesError}</span>
            </div>
          )}

          {/* Positions Tab */}
          {activeActivityTab === 'positions' && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-x-auto animate-fadeIn">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th className={thCls}>Symbol</th>
                    <th className={thCls}>Type</th>
                    <th className={thCls}>Net Qty</th>
                    <th className={thCls}>Buy Avg</th>
                    <th className={thCls}>Sell Avg</th>
                    <th className={thCls}>LTP</th>
                    <th className={`${thCls} w-28 text-center`} title="SHORT: SL must be ABOVE current LTP. LONG: SL must be BELOW current LTP.">SL Threshold ℹ</th>
                    <th className={`${thCls} w-28 text-center`} title="SHORT: Target must be BELOW current LTP. LONG: Target must be ABOVE current LTP.">Target Threshold ℹ</th>
                    <th className={thCls}>Realized</th>
                    <th className={thCls}>Unrealized</th>
                  </tr>
                </thead>
                <tbody>
                  {tradesLoading ? (
                    <tr><td colSpan={10} className="px-4 py-8 text-center text-zinc-500">Loading positions…</td></tr>
                  ) : crudePositions.length === 0 ? (
                    <tr><td colSpan={10} className="px-4 py-8 text-center text-zinc-500">No open positions</td></tr>
                  ) : (
                    crudePositions.map((p, i) => {
                      const config = riskConfigs[p.symbol] || { sl: null, target: null };
                      const isEditingSL     = editingConfigs[p.symbol]?.sl !== undefined;
                      const isEditingTarget = editingConfigs[p.symbol]?.target !== undefined;
                      const slInputVal      = isEditingSL     ? editingConfigs[p.symbol].sl!     : (config.sl     !== null ? String(config.sl)     : '');
                      const tgtInputVal     = isEditingTarget ? editingConfigs[p.symbol].target! : (config.target !== null ? String(config.target) : '');

                      const renderThresholdCell = (key: 'sl' | 'target', thresholdVal: string) => {
                        if (p.netQty === 0) return <span className="text-zinc-600">—</span>;
                        const committed = key === 'sl' ? config.sl : config.target;
                        const isSl = key === 'sl';

                        // Show active threshold badge + clear button
                        if (committed !== null && !isEditingSL && key === 'sl') {
                          return (
                            <div className="flex items-center gap-1 justify-center">
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md border text-orange-300 bg-orange-950/40 border-orange-800/60 animate-pulse">
                                👁 SL ₹{committed}
                              </span>
                              <button type="button" title="Remove SL threshold" onClick={() => {
                                handleInputCommit(p.symbol, 'sl', '');
                              }} className="text-zinc-500 hover:text-red-400 transition-colors cursor-pointer text-xs">✕</button>
                            </div>
                          );
                        }
                        if (committed !== null && !isEditingTarget && key === 'target') {
                          return (
                            <div className="flex items-center gap-1 justify-center">
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md border text-emerald-300 bg-emerald-950/40 border-emerald-800/60 animate-pulse">
                                👁 TGT ₹{committed}
                              </span>
                              <button type="button" title="Remove Target threshold" onClick={() => {
                                handleInputCommit(p.symbol, 'target', '');
                              }} className="text-zinc-500 hover:text-red-400 transition-colors cursor-pointer text-xs">✕</button>
                            </div>
                          );
                        }

                        // Input field
                        return (
                          <input
                            type="number"
                            step="0.1"
                            placeholder={isSl ? "SL price" : "Target price"}
                            value={thresholdVal}
                            onChange={(e) => handleInputChange(p.symbol, key, e.target.value)}
                            onBlur={() => handleInputCommit(p.symbol, key)}
                            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                            className={`w-20 bg-zinc-950/80 border rounded text-center py-1 text-xs tabular-nums focus:outline-none focus:ring-1 transition-all font-semibold ${
                              isSl
                                ? 'border-zinc-800 focus:border-orange-500/50 focus:ring-orange-500/20 text-zinc-200'
                                : 'border-zinc-800 focus:border-emerald-500/50 focus:ring-emerald-500/20 text-zinc-200'
                            }`}
                          />
                        );
                      };

                      return (
                        <tr key={`${p.symbol}-${i}`} className="border-t border-zinc-800/80 hover:bg-zinc-800/20 transition-colors">
                          <td className="px-3 py-2 text-zinc-200 font-semibold">{p.symbol}</td>
                          <td className="px-3 py-2 text-zinc-400">{p.positionType}</td>
                          <td className="px-3 py-2 tabular-nums text-zinc-200">{p.netQty}</td>
                          <td className="px-3 py-2 tabular-nums text-zinc-400">{fmtLTP(p.buyAvg)}</td>
                          <td className="px-3 py-2 tabular-nums text-zinc-400">{fmtLTP(p.sellAvg)}</td>
                          <td className="px-3 py-2 tabular-nums text-zinc-200">{fmtLTP(p.lastPrice)}</td>
                          <td className="px-2 py-1 text-center">{renderThresholdCell('sl', slInputVal)}</td>
                          <td className="px-2 py-1 text-center">{renderThresholdCell('target', tgtInputVal)}</td>
                          <td className={`px-3 py-2 tabular-nums font-semibold ${pctColor(p.realizedProfit)}`}>{fmtLTP(p.realizedProfit)}</td>
                          <td className={`px-3 py-2 tabular-nums font-semibold ${pctColor(p.unrealizedProfit)}`}>{fmtLTP(p.unrealizedProfit)}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* ─── Confirmation Dialog for SL/Target auto-exit ─────────────────────────── */}
          {pendingConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
              <div className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl p-6 max-w-sm w-full mx-4 flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-red-900/40 border border-red-700/60 flex items-center justify-center shrink-0">
                    <AlertCircle className="h-5 w-5 text-red-400" />
                  </div>
                  <div>
                    <div className="text-sm font-bold text-zinc-100">Exit Position?</div>
                    <div className="text-xs text-zinc-400 mt-0.5">{pendingConfirm.symbol}</div>
                  </div>
                </div>
                <div className="text-xs text-zinc-300 bg-zinc-800/60 rounded-xl px-4 py-3 leading-relaxed border border-zinc-700/40">
                  {pendingConfirm.reason}
                </div>
                <div className="text-xs text-zinc-500">
                  A <span className="font-bold text-zinc-300">MARKET {pendingConfirm.leg.side}</span> order for{' '}
                  <span className="font-bold text-zinc-300">{pendingConfirm.leg.quantity} units</span> will be sent to the broker.
                </div>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      const { leg } = pendingConfirm;
                      setPendingConfirm(null);
                      void (async () => {
                        try {
                          const res = await fetch('/api/options/order', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ legs: [{ ...leg, orderType: 'MARKET' }], mode: 'intraday' }),
                          });
                          const json = await res.json() as { success: boolean; error?: string };
                          setOrderMessage(json.success
                            ? { text: `Exit order placed for ${pendingConfirm.symbol}.`, isError: false }
                            : { text: `Exit order failed: ${json.error ?? 'Unknown error'}`, isError: true }
                          );
                          void fetchCrudeTrades();
                        } catch (err) {
                          setOrderMessage({ text: `Exit order error: ${String(err)}`, isError: true });
                        }
                      })();
                    }}
                    className="flex-1 py-2 rounded-xl text-xs font-bold bg-red-600 hover:bg-red-500 text-white transition-all cursor-pointer"
                  >
                    ✓ Confirm Exit
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingConfirm(null)}
                    className="flex-1 py-2 rounded-xl text-xs font-bold bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-all cursor-pointer border border-zinc-700"
                  >
                    ✗ Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Orders Tab */}
          {activeActivityTab === 'orders' && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-x-auto animate-fadeIn">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th className={thCls}>Order ID</th>
                    <th className={thCls}>Symbol</th>
                    <th className={thCls}>Side</th>
                    <th className={thCls}>Product</th>
                    <th className={thCls}>Qty</th>
                    <th className={thCls}>Filled</th>
                    <th className={thCls}>Price</th>
                    <th className={thCls}>Status</th>
                    <th className={thCls}>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {tradesLoading ? (
                    <tr><td colSpan={9} className="px-4 py-8 text-center text-zinc-500">Loading orders…</td></tr>
                  ) : crudeOrders.length === 0 ? (
                    <tr><td colSpan={9} className="px-4 py-8 text-center text-zinc-500">No orders today</td></tr>
                  ) : (
                    crudeOrders.map((o) => (
                      <tr key={o.orderId} className="border-t border-zinc-800/80 hover:bg-zinc-800/20 transition-colors">
                        <td className="px-3 py-2 text-zinc-400">{o.orderId}</td>
                        <td className="px-3 py-2 text-zinc-200 font-semibold">{o.symbol}</td>
                        <td className={`px-3 py-2 font-bold ${o.transactionType === 'SELL' ? 'text-red-400' : 'text-emerald-400'}`}>{o.transactionType}</td>
                        <td className="px-3 py-2 text-zinc-400">{o.productType}</td>
                        <td className="px-3 py-2 tabular-nums text-zinc-200">{o.quantity}</td>
                        <td className="px-3 py-2 tabular-nums text-zinc-400">{o.filledQty}</td>
                        <td className="px-3 py-2 tabular-nums text-zinc-200">{fmtLTP(o.price)}</td>
                        <td className={`px-3 py-2 font-semibold ${statusColor(o.status)}`}>{o.status}</td>
                        <td className="px-3 py-2 text-zinc-500">{o.updateTime || o.createTime}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Trades Tab */}
          {activeActivityTab === 'trades' && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-x-auto animate-fadeIn">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th className={thCls}>Order ID</th>
                    <th className={thCls}>Symbol</th>
                    <th className={thCls}>Side</th>
                    <th className={thCls}>Qty</th>
                    <th className={thCls}>Price</th>
                    <th className={thCls}>Exchange Time</th>
                  </tr>
                </thead>
                <tbody>
                  {tradesLoading ? (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-zinc-500">Loading trades…</td></tr>
                  ) : crudeTrades.length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-zinc-500">No trades today</td></tr>
                  ) : (
                    crudeTrades.map((t, i) => (
                      <tr key={`${t.orderId}-${i}`} className="border-t border-zinc-800/80 hover:bg-zinc-800/20 transition-colors">
                        <td className="px-3 py-2 text-zinc-400">{t.orderId}</td>
                        <td className="px-3 py-2 text-zinc-200 font-semibold">{t.symbol}</td>
                        <td className={`px-3 py-2 font-bold ${t.transactionType === 'SELL' ? 'text-red-400' : 'text-emerald-400'}`}>{t.transactionType}</td>
                        <td className="px-3 py-2 tabular-nums text-zinc-200">{t.tradedQuantity}</td>
                        <td className="px-3 py-2 tabular-nums text-zinc-200">{fmtLTP(t.tradedPrice)}</td>
                        <td className="px-3 py-2 text-zinc-500">{t.exchangeTime}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
          </>
        )}

        {/* Dynamic Tab Content: Open Interest Tab */}
        {activeTab === 'oi' && (
          <CrudeOilOITab expiry={expiry} />
        )}

        {/* Dynamic Tab Content: Cumulative OI Tab */}
        {activeTab === 'cumulative' && (
          <CrudeOilCumulativeOITab expiry={expiry} />
        )}

      </main>
    </div>
  );
}
