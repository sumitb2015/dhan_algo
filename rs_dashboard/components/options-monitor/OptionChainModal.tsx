'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  X,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Layers,
  Plus,
  Table2,
  Check,
  Zap,
} from 'lucide-react';
import { formatShortExpiry, UNDERLYINGS } from '@/lib/optionsMonitorMath';

interface ChainSideData {
  last_price?: number;
  previous_close_price?: number;
  oi?: number;
  previous_oi?: number;
  volume?: number;
  implied_volatility?: number;
  security_id?: string | number;
  greeks?: {
    delta?: number;
    theta?: number;
    gamma?: number;
    vega?: number;
  };
}

interface ChainRowData {
  strike: number;
  ce: ChainSideData | null;
  pe: ChainSideData | null;
  ceOIPct: number;
  peOIPct: number;
  cePriceChgPct: number | null;
  pePriceChgPct: number | null;
  ceOIChgPct: number | null;
  peOIChgPct: number | null;
  isATM: boolean;
  isMaxCEOI: boolean;
  isMaxPEOI: boolean;
}

export interface OptionChainModalProps {
  isOpen: boolean;
  onClose: () => void;
  underlying: string;
  expiries: string[];
  currentExpiry: string;
  spot: number;
  broker?: 'dhan' | 'kotak';
  liveQuotes?: {
    spot?: number;
    strikes?: Record<string, any>;
  } | null;
  onSelectExpiry?: (expiry: string) => void;
  onAddLeg?: (leg: {
    type: 'CE' | 'PE';
    side: 'BUY' | 'SELL';
    strike: number;
    ltp: number;
    expiry: string;
    iv?: number;
    delta?: number;
  }) => void;
}

const WING_OPTIONS = [5, 10, 15, 20] as const;

function fmtOI(n: number): string {
  if (!n) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 10_000_000) return `${sign}${(abs / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000) return `${sign}${(abs / 100_000).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
}

function fmtLTP(n: number | undefined): string {
  if (n === undefined || n === null || n <= 0) return '—';
  return `₹${n.toFixed(1)}`;
}

function fmtPct(n: number | null): string {
  if (n === null || isNaN(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function fmtGreek(n: number | undefined, decimals = 2): string {
  if (n === undefined || n === null || isNaN(n)) return '—';
  return n.toFixed(decimals);
}

export default function OptionChainModal({
  isOpen,
  onClose,
  underlying: initialUnderlying,
  expiries: initialExpiries,
  currentExpiry,
  spot: initialSpot,
  broker = 'dhan',
  liveQuotes,
  onSelectExpiry,
  onAddLeg,
}: OptionChainModalProps) {
  const [selectedUnderlying, setSelectedUnderlying] = useState(initialUnderlying);
  const [selectedExpiry, setSelectedExpiry] = useState(currentExpiry);
  const [availableExpiries, setAvailableExpiries] = useState<string[]>(initialExpiries);
  const [wings, setWings] = useState<number>(10);
  const [rows, setRows] = useState<ChainRowData[]>([]);
  const [liveSpot, setLiveSpot] = useState<number>(initialSpot);
  const [prevClose, setPrevClose] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [addedLegFeedback, setAddedLegFeedback] = useState<string | null>(null);

  // Monotonic request sequence to guard against out-of-order responses (dhan-polling-guards)
  const requestSeq = useRef<number>(0);

  // Sync state when modal opens
  useEffect(() => {
    if (isOpen) {
      setSelectedUnderlying(initialUnderlying);
      setSelectedExpiry(currentExpiry || initialExpiries[0] || '');
      setAvailableExpiries(initialExpiries);
      setLiveSpot(initialSpot);
    }
  }, [isOpen, initialUnderlying, currentExpiry, initialExpiries, initialSpot]);

  // Fetch expiries if underlying changes
  useEffect(() => {
    if (!isOpen) return;
    let isSubscribed = true;

    async function loadExpiries() {
      try {
        const res = await fetch(`/api/options/expiries?underlying=${selectedUnderlying}&broker=${broker}`);
        const json = await res.json();
        const exps: string[] = (json && json.success && (
          Array.isArray(json.data) ? json.data : (Array.isArray(json.expiries) ? json.expiries : [])
        )) || [];

        if (isSubscribed && exps.length > 0) {
          setAvailableExpiries(exps);
          if (!exps.includes(selectedExpiry)) {
            setSelectedExpiry(exps[0]);
            if (onSelectExpiry) onSelectExpiry(exps[0]);
          }
        }
      } catch (err) {
        console.error('[OptionChainModal] Failed to load expiries:', err);
      }
    }

    loadExpiries();
    return () => {
      isSubscribed = false;
    };
  }, [isOpen, selectedUnderlying, broker, selectedExpiry, onSelectExpiry]);

  // Fetch Option Chain data with decimal-key normalization and out-of-order protection
  const fetchOptionChain = useCallback(async () => {
    if (!selectedExpiry) return;
    const seq = ++requestSeq.current;
    const isStale = () => seq !== requestSeq.current;

    setIsLoading(true);
    setErrorMsg(null);

    try {
      const res = await fetch(
        `/api/options/chain?underlying=${selectedUnderlying}&expiry=${selectedExpiry}&broker=${broker}`
      );
      const json = await res.json();

      if (isStale()) return;

      if (!json.success || !json.data?.chain?.oc) {
        setErrorMsg(json.error || 'Failed to fetch option chain');
        return;
      }

      const spotPrice = Number(json.data.spot) || liveSpot;
      if (spotPrice > 0) setLiveSpot(spotPrice);
      if (json.data.prev_close) setPrevClose(Number(json.data.prev_close));

      const uConfig = UNDERLYINGS[selectedUnderlying] || { strikeStep: 50 };
      const strikeStep = uConfig.strikeStep || 50;
      const atmStrike = Math.round(spotPrice / strikeStep) * strikeStep;

      // Normalize raw OC keys: Dhan/Python returns float string keys e.g. "23400.000000"
      const rawOc = (json.data.chain.oc || {}) as Record<string, { ce?: ChainSideData; pe?: ChainSideData }>;
      const normalizedMap = new Map<number, { ce?: ChainSideData; pe?: ChainSideData }>();

      for (const [key, val] of Object.entries(rawOc)) {
        const strikeNum = Math.round(Number(key));
        if (!isNaN(strikeNum) && strikeNum > 0) {
          normalizedMap.set(strikeNum, val);
        }
      }

      const allStrikes = Array.from(normalizedMap.keys()).sort((a, b) => a - b);

      if (allStrikes.length === 0) {
        setErrorMsg('Option chain is empty for this expiry');
        return;
      }

      // Find closest strike index to ATM
      const atmIdx = allStrikes.reduce(
        (best, s, i) =>
          Math.abs(s - atmStrike) < Math.abs(allStrikes[best] - atmStrike) ? i : best,
        0
      );

      const lo = Math.max(0, atmIdx - wings);
      const hi = Math.min(allStrikes.length - 1, atmIdx + wings);
      const visibleStrikes = allStrikes.slice(lo, hi + 1);

      // Compute max OI for bars
      let maxCEOI = 0;
      let maxPEOI = 0;
      let maxCEStrike = 0;
      let maxPEStrike = 0;

      for (const s of visibleStrikes) {
        const item = normalizedMap.get(s);
        const ceOI = item?.ce?.oi || 0;
        const peOI = item?.pe?.oi || 0;
        if (ceOI > maxCEOI) {
          maxCEOI = ceOI;
          maxCEStrike = s;
        }
        if (peOI > maxPEOI) {
          maxPEOI = peOI;
          maxPEStrike = s;
        }
      }

      const processed: ChainRowData[] = visibleStrikes.map((s) => {
        const item = normalizedMap.get(s) || {};
        let ce = item.ce || null;
        let pe = item.pe || null;

        // If live quotes from WebSocket are active for this expiry, merge them
        if (selectedExpiry === currentExpiry && liveQuotes?.strikes) {
          const wsStrike =
            liveQuotes.strikes[s] ||
            liveQuotes.strikes[String(s)] ||
            liveQuotes.strikes[`${s}.000000`];
          if (wsStrike) {
            if (wsStrike.ce && (wsStrike.ce.ltp || wsStrike.ce.oi)) {
              ce = {
                ...ce,
                last_price: wsStrike.ce.ltp ?? ce?.last_price,
                previous_close_price: wsStrike.ce.prev_close ?? ce?.previous_close_price,
                oi: wsStrike.ce.oi ?? ce?.oi,
                volume: wsStrike.ce.volume ?? ce?.volume,
              };
            }
            if (wsStrike.pe && (wsStrike.pe.ltp || wsStrike.pe.oi)) {
              pe = {
                ...pe,
                last_price: wsStrike.pe.ltp ?? pe?.last_price,
                previous_close_price: wsStrike.pe.prev_close ?? pe?.previous_close_price,
                oi: wsStrike.pe.oi ?? pe?.oi,
                volume: wsStrike.pe.volume ?? pe?.volume,
              };
            }
          }
        }

        const ceOI = ce?.oi || 0;
        const peOI = pe?.oi || 0;

        const cePriceChgPct =
          ce?.last_price && ce?.previous_close_price
            ? ((ce.last_price - ce.previous_close_price) / ce.previous_close_price) * 100
            : null;
        const pePriceChgPct =
          pe?.last_price && pe?.previous_close_price
            ? ((pe.last_price - pe.previous_close_price) / pe.previous_close_price) * 100
            : null;

        const ceOIChgPct =
          ce?.oi && ce?.previous_oi
            ? ((ce.oi - ce.previous_oi) / ce.previous_oi) * 100
            : null;
        const peOIChgPct =
          pe?.oi && pe?.previous_oi
            ? ((pe.oi - pe.previous_oi) / pe.previous_oi) * 100
            : null;

        return {
          strike: s,
          ce,
          pe,
          ceOIPct: maxCEOI > 0 ? (ceOI / maxCEOI) * 100 : 0,
          peOIPct: maxPEOI > 0 ? (peOI / maxPEOI) * 100 : 0,
          cePriceChgPct,
          pePriceChgPct,
          ceOIChgPct,
          peOIChgPct,
          isATM: s === atmStrike,
          isMaxCEOI: s === maxCEStrike && maxCEOI > 0,
          isMaxPEOI: s === maxPEStrike && maxPEOI > 0,
        };
      });

      if (isStale()) return;

      setRows(processed);
      setLastUpdated(
        new Date().toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      );
    } catch (err) {
      if (isStale()) return;
      console.error('[OptionChainModal] Error:', err);
      setErrorMsg(String(err));
    } finally {
      if (!isStale()) {
        setIsLoading(false);
      }
    }
  }, [selectedUnderlying, selectedExpiry, liveSpot, wings, currentExpiry, liveQuotes, broker]);

  // Load option chain on expiry change or modal open
  useEffect(() => {
    if (isOpen && selectedExpiry) {
      fetchOptionChain();
    }
  }, [isOpen, selectedExpiry, fetchOptionChain]);

  // Handle adding a leg directly to the strategy
  const handleQuickAdd = (type: 'CE' | 'PE', side: 'BUY' | 'SELL', row: ChainRowData) => {
    const data = type === 'CE' ? row.ce : row.pe;
    const ltp = data?.last_price || 0;
    if (!ltp) return;

    if (onAddLeg) {
      onAddLeg({
        type,
        side,
        strike: row.strike,
        ltp,
        expiry: selectedExpiry,
        iv: data?.implied_volatility ? data.implied_volatility / 100 : undefined,
        delta: data?.greeks?.delta,
      });

      setAddedLegFeedback(`Added ${side} ${row.strike} ${type} @ ₹${ltp.toFixed(1)}`);
      setTimeout(() => setAddedLegFeedback(null), 2500);
    }
  };

  // Compute PCR (Put-Call Ratio)
  const { totalCeOI, totalPeOI, pcr } = useMemo(() => {
    let ceSum = 0;
    let peSum = 0;
    for (const r of rows) {
      ceSum += r.ce?.oi || 0;
      peSum += r.pe?.oi || 0;
    }
    const ratio = ceSum > 0 ? (peSum / ceSum).toFixed(2) : '—';
    return { totalCeOI: ceSum, totalPeOI: peSum, pcr: ratio };
  }, [rows]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 bg-oncolor-dark/70 backdrop-blur-sm transition-opacity">
      <div className="w-full max-w-6xl max-h-[92vh] bg-zinc-900 border border-zinc-800 rounded-2xl flex flex-col shadow-2xl text-white overflow-hidden animate-in fade-in zoom-in-95 duration-150 font-mono select-none">
        {/* ── HEADER ────────────────────────────────────────────────────────── */}
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950 px-4 py-3 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400">
                <Table2 className="w-4 h-4" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-white tracking-wider uppercase">
                    OPTION CHAIN — {selectedUnderlying}
                  </h2>
                  <span className="text-xs font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/30 tabular-nums">
                    ₹{liveSpot.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                  </span>
                </div>
                {lastUpdated && (
                  <span className="text-[10px] text-zinc-500 block">
                    Last updated: {lastUpdated}
                  </span>
                )}
              </div>
            </div>

            {/* Underlying Selector */}
            <div className="flex items-center gap-1 bg-zinc-900 p-0.5 rounded-lg border border-zinc-800 text-xs font-bold">
              {['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX'].map((sym) => (
                <button
                  key={sym}
                  type="button"
                  onClick={() => setSelectedUnderlying(sym)}
                  className={`px-2 py-0.5 rounded transition-colors cursor-pointer text-[10px] ${
                    selectedUnderlying === sym
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {sym}
                </button>
              ))}
            </div>
          </div>

          {/* Controls: Expiry selection & Wings */}
          <div className="flex items-center gap-2">
            {/* Expiry Dropdown */}
            <div className="flex items-center gap-1.5 bg-zinc-900 px-2.5 py-1 rounded-lg border border-zinc-800 text-xs">
              <span className="text-[10px] uppercase font-bold text-zinc-400">EXPIRY:</span>
              <select
                value={selectedExpiry}
                onChange={(e) => {
                  setSelectedExpiry(e.target.value);
                  if (onSelectExpiry) onSelectExpiry(e.target.value);
                }}
                className="bg-zinc-950 text-amber-400 font-bold px-2 py-0.5 rounded border border-zinc-700 text-xs cursor-pointer focus:outline-none focus:border-amber-500"
              >
                {availableExpiries.map((exp) => (
                  <option key={exp} value={exp}>
                    {exp} ({formatShortExpiry(exp)})
                  </option>
                ))}
              </select>
            </div>

            {/* Wings / Range */}
            <div className="hidden sm:flex items-center gap-1 bg-zinc-900 px-2 py-1 rounded-lg border border-zinc-800 text-xs">
              <span className="text-[10px] uppercase font-bold text-zinc-400">RANGE:</span>
              {WING_OPTIONS.map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setWings(w)}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold cursor-pointer transition-colors ${
                    wings === w
                      ? 'bg-zinc-700 text-white'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  ±{w}
                </button>
              ))}
            </div>

            {/* Refresh Button */}
            <button
              type="button"
              onClick={fetchOptionChain}
              disabled={isLoading}
              className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-zinc-700 transition-colors cursor-pointer"
              title="Refresh Option Chain"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-amber-400' : ''}`} />
            </button>

            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white border border-zinc-700 transition-colors cursor-pointer"
              title="Close Option Chain"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* ── EXPIRY PILLS ROW FOR RAPID SELECTION ───────────────────────────── */}
        <div className="flex items-center justify-between gap-2 px-4 py-1.5 bg-zinc-950/60 border-b border-zinc-800/80 text-xs shrink-0 overflow-x-auto">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-bold uppercase text-zinc-500">QUICK EXPIRY:</span>
            {availableExpiries.slice(0, 6).map((exp, idx) => (
              <button
                key={exp}
                type="button"
                onClick={() => {
                  setSelectedExpiry(exp);
                  if (onSelectExpiry) onSelectExpiry(exp);
                }}
                className={`px-2 py-0.5 rounded-md text-[10px] font-bold transition-colors cursor-pointer border ${
                  selectedExpiry === exp
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                    : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border-zinc-800 hover:text-white'
                }`}
              >
                {formatShortExpiry(exp)}
                {idx === 0 && <span className="ml-1 text-[9px] text-emerald-400">●</span>}
              </button>
            ))}
          </div>

          {/* Quick Feedback Notification */}
          {addedLegFeedback && (
            <div className="flex items-center gap-1 text-[11px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30 animate-in fade-in">
              <Check className="w-3 h-3 text-emerald-400" />
              <span>{addedLegFeedback}</span>
            </div>
          )}
        </div>

        {/* ── OPTION CHAIN TABLE ────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto overflow-x-auto min-h-0">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 z-20 bg-zinc-800 text-white font-bold shadow-sm">
              <tr>
                {/* Calls Header */}
                <th colSpan={7} className="py-1.5 px-3 text-center bg-sky-950/40 text-sky-300 border-r border-zinc-700/80 text-[11px] font-bold uppercase tracking-wider">
                  CALLS (CE)
                </th>

                {/* Strike Header */}
                <th className="py-1.5 px-3 text-center bg-zinc-800 text-amber-300 border-x border-zinc-700 text-xs font-bold uppercase tracking-wider">
                  STRIKE
                </th>

                {/* Puts Header */}
                <th colSpan={7} className="py-1.5 px-3 text-center bg-rose-950/40 text-rose-300 border-l border-zinc-700/80 text-[11px] font-bold uppercase tracking-wider">
                  PUTS (PE)
                </th>
              </tr>
              <tr className="bg-zinc-800/90 text-zinc-300 text-[10px] uppercase border-t border-zinc-700/60">
                {/* CE Sub-headers */}
                <th className="py-1 px-1.5 text-center">ADD</th>
                <th className="py-1 px-2 text-right">OI</th>
                <th className="py-1 px-2 text-right">OI CHG%</th>
                <th className="py-1 px-2 text-right">VOL</th>
                <th className="py-1 px-1.5 text-right">IV%</th>
                <th className="py-1 px-1.5 text-right">DELTA</th>
                <th className="py-1 px-2 text-right border-r border-zinc-700 font-bold text-white">LTP</th>

                {/* Strike */}
                <th className="py-1 px-3 text-center border-x border-zinc-700 font-bold text-white">STRIKE</th>

                {/* PE Sub-headers */}
                <th className="py-1 px-2 text-left border-l border-zinc-700 font-bold text-white">LTP</th>
                <th className="py-1 px-1.5 text-left">DELTA</th>
                <th className="py-1 px-1.5 text-left">IV%</th>
                <th className="py-1 px-2 text-left">VOL</th>
                <th className="py-1 px-2 text-left">OI CHG%</th>
                <th className="py-1 px-2 text-left">OI</th>
                <th className="py-1 px-1.5 text-center">ADD</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-zinc-800/70 font-mono text-[11px]">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={15} className="py-16 text-center text-zinc-500 italic">
                    {isLoading ? (
                      <span className="flex items-center justify-center gap-2">
                        <RefreshCw className="w-4 h-4 animate-spin text-amber-400" />
                        Loading option chain for {selectedExpiry}...
                      </span>
                    ) : errorMsg ? (
                      <span className="text-red-400">{errorMsg}</span>
                    ) : (
                      'No strikes available for this expiry.'
                    )}
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const isAtm = row.isATM;
                  const isItmCe = row.strike < liveSpot;
                  const isItmPe = row.strike > liveSpot;

                  return (
                    <tr
                      key={row.strike}
                      className={`transition-colors ${
                        isAtm
                          ? 'bg-amber-500/15 font-bold hover:bg-amber-500/20'
                          : 'hover:bg-zinc-800/40'
                      }`}
                    >
                      {/* CE: Quick Add Buttons */}
                      <td className="py-1.5 px-1.5 text-center whitespace-nowrap">
                        {onAddLeg && row.ce?.last_price ? (
                          <div className="flex items-center justify-center gap-0.5">
                            <button
                              type="button"
                              onClick={() => handleQuickAdd('CE', 'BUY', row)}
                              className="px-1 py-0.5 rounded bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-white border border-emerald-500/30 text-[9px] font-bold cursor-pointer transition-colors"
                              title={`Buy ${row.strike} CE`}
                            >
                              +B
                            </button>
                            <button
                              type="button"
                              onClick={() => handleQuickAdd('CE', 'SELL', row)}
                              className="px-1 py-0.5 rounded bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white border border-red-500/30 text-[9px] font-bold cursor-pointer transition-colors"
                              title={`Sell ${row.strike} CE`}
                            >
                              +S
                            </button>
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>

                      {/* CE: OI & Bar */}
                      <td className="py-1.5 px-2 text-right tabular-nums relative">
                        <div
                          className="absolute right-0 top-0 bottom-0 bg-sky-500/15 pointer-events-none"
                          style={{ width: `${Math.min(row.ceOIPct, 100)}%` }}
                        />
                        <span className="relative z-10 text-zinc-200">
                          {fmtOI(row.ce?.oi || 0)}
                        </span>
                        {row.isMaxCEOI && (
                          <span className="relative z-10 ml-1 text-[8px] bg-sky-500/30 text-sky-300 px-1 py-0.2 rounded font-bold">
                            MAX
                          </span>
                        )}
                      </td>

                      {/* CE: OI Chg% */}
                      <td
                        className={`py-1.5 px-2 text-right tabular-nums ${
                          (row.ceOIChgPct || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {fmtPct(row.ceOIChgPct)}
                      </td>

                      {/* CE: Volume */}
                      <td className="py-1.5 px-2 text-right tabular-nums text-zinc-400">
                        {fmtOI(row.ce?.volume || 0)}
                      </td>

                      {/* CE: IV */}
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-zinc-400">
                        {row.ce?.implied_volatility ? `${row.ce.implied_volatility.toFixed(1)}%` : '—'}
                      </td>

                      {/* CE: Delta */}
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-zinc-300">
                        {fmtGreek(row.ce?.greeks?.delta, 2)}
                      </td>

                      {/* CE: LTP */}
                      <td
                        className={`py-1.5 px-2 text-right tabular-nums border-r border-zinc-700 font-bold ${
                          isItmCe ? 'text-amber-300 bg-amber-500/5' : 'text-white'
                        }`}
                      >
                        {fmtLTP(row.ce?.last_price)}
                      </td>

                      {/* ── STRIKE (CENTER) ── */}
                      <td
                        className={`py-1.5 px-3 text-center tabular-nums border-x border-zinc-700 font-bold ${
                          isAtm
                            ? 'text-amber-400 text-xs bg-amber-500/20 shadow-inner'
                            : 'text-zinc-100'
                        }`}
                      >
                        <span>{row.strike.toLocaleString('en-IN')}</span>
                        {isAtm && (
                          <span className="ml-1 text-[9px] bg-amber-400 text-zinc-950 px-1 py-0.2 rounded font-extrabold uppercase">
                            ATM
                          </span>
                        )}
                      </td>

                      {/* PE: LTP */}
                      <td
                        className={`py-1.5 px-2 text-left tabular-nums border-l border-zinc-700 font-bold ${
                          isItmPe ? 'text-amber-300 bg-amber-500/5' : 'text-white'
                        }`}
                      >
                        {fmtLTP(row.pe?.last_price)}
                      </td>

                      {/* PE: Delta */}
                      <td className="py-1.5 px-1.5 text-left tabular-nums text-zinc-300">
                        {fmtGreek(row.pe?.greeks?.delta, 2)}
                      </td>

                      {/* PE: IV */}
                      <td className="py-1.5 px-1.5 text-left tabular-nums text-zinc-400">
                        {row.pe?.implied_volatility ? `${row.pe.implied_volatility.toFixed(1)}%` : '—'}
                      </td>

                      {/* PE: Volume */}
                      <td className="py-1.5 px-2 text-left tabular-nums text-zinc-400">
                        {fmtOI(row.pe?.volume || 0)}
                      </td>

                      {/* PE: OI Chg% */}
                      <td
                        className={`py-1.5 px-2 text-left tabular-nums ${
                          (row.peOIChgPct || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {fmtPct(row.peOIChgPct)}
                      </td>

                      {/* PE: OI & Bar */}
                      <td className="py-1.5 px-2 text-left tabular-nums relative">
                        <div
                          className="absolute left-0 top-0 bottom-0 bg-rose-500/15 pointer-events-none"
                          style={{ width: `${Math.min(row.peOIPct, 100)}%` }}
                        />
                        <span className="relative z-10 text-zinc-200">
                          {fmtOI(row.pe?.oi || 0)}
                        </span>
                        {row.isMaxPEOI && (
                          <span className="relative z-10 ml-1 text-[8px] bg-rose-500/30 text-rose-300 px-1 py-0.2 rounded font-bold">
                            MAX
                          </span>
                        )}
                      </td>

                      {/* PE: Quick Add Buttons */}
                      <td className="py-1.5 px-1.5 text-center whitespace-nowrap">
                        {onAddLeg && row.pe?.last_price ? (
                          <div className="flex items-center justify-center gap-0.5">
                            <button
                              type="button"
                              onClick={() => handleQuickAdd('PE', 'BUY', row)}
                              className="px-1 py-0.5 rounded bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-white border border-emerald-500/30 text-[9px] font-bold cursor-pointer transition-colors"
                              title={`Buy ${row.strike} PE`}
                            >
                              +B
                            </button>
                            <button
                              type="button"
                              onClick={() => handleQuickAdd('PE', 'SELL', row)}
                              className="px-1 py-0.5 rounded bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white border border-red-500/30 text-[9px] font-bold cursor-pointer transition-colors"
                              title={`Sell ${row.strike} PE`}
                            >
                              +S
                            </button>
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* ── FOOTER STATS (PCR, TOTAL OI, ACTIONS) ─────────────────────────── */}
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-950 px-4 py-2.5 text-xs shrink-0">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <span className="text-zinc-500 text-[10px] font-bold uppercase">PCR:</span>
              <span
                className={`font-bold tabular-nums ${
                  Number(pcr) > 1.2
                    ? 'text-emerald-400'
                    : Number(pcr) < 0.8
                    ? 'text-red-400'
                    : 'text-amber-400'
                }`}
              >
                {pcr}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-zinc-500 text-[10px] font-bold uppercase">TOTAL CE OI:</span>
              <span className="text-zinc-200 font-bold tabular-nums">{fmtOI(totalCeOI)}</span>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-zinc-500 text-[10px] font-bold uppercase">TOTAL PE OI:</span>
              <span className="text-zinc-200 font-bold tabular-nums">{fmtOI(totalPeOI)}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {onSelectExpiry && (
              <button
                type="button"
                onClick={() => {
                  onSelectExpiry(selectedExpiry);
                  onClose();
                }}
                className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-bold transition-colors cursor-pointer"
                title="Apply this expiry to the main monitor"
              >
                Apply Expiry ({formatShortExpiry(selectedExpiry)})
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-zinc-700 text-xs font-bold transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
