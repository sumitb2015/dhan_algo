'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import NavBar from './NavBar';
import { RefreshCw, AlertCircle, Loader2 } from 'lucide-react';

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

// ─── Constants ────────────────────────────────────────────────────

const UNDERLYING  = 'CRUDEOIL';
const STRIKE_STEP = 50;
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

function pctColor(n: number): string {
  return n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-400';
}

function pctSign(n: number): string {
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
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
  const [lotSize, setLotSize]         = useState(100); // CRUDEOIL option lot size default is 100
  const [orderMessage, setOrderMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const [ordering, setOrdering]       = useState(false);

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
          legs: [{ securityId: String(securityId), quantity: qty, side }],
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
      const atmStrike = Math.round(spotPrice / STRIKE_STEP) * STRIKE_STEP;
      const oc        = json.data.chain.oc;

      const allEntries = parseStrikeEntries(oc);
      const mpStrike = computeMaxPain(allEntries);

      // Slicing window around ATM
      const atmIdx  = allEntries.reduce((best, { strike }, i) =>
        Math.abs(strike - atmStrike) < Math.abs(allEntries[best].strike - atmStrike) ? i : best, 0);
      const lo      = Math.max(0, atmIdx - wings);
      const hi      = Math.min(allEntries.length - 1, atmIdx + wings);
      const visible = allEntries.slice(lo, hi + 1);

      let totCE = 0, totPE = 0;
      let maxCEOI = 0, maxPEOI = 0, maxCEStrike = 0, maxPEStrike = 0;
      for (const { strike, entry } of visible) {
        const ceOI = entry.ce?.oi ?? 0;
        const peOI = entry.pe?.oi ?? 0;
        totCE += ceOI;
        totPE += peOI;
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

        <NavBar />

        {/* Nifty toggle button */}
        <Link
          href="/options"
          className="ml-auto text-xs font-bold px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 transition-colors text-zinc-300 hover:text-zinc-100"
        >
          ← Go to Nifty Options
        </Link>
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

        {/* Stats Grid */}
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

        {/* Controls and Selectors */}
        <div className="flex flex-wrap items-center gap-4 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Expiry Date:</span>
            {expiries.length === 0 ? (
              <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
            ) : (
              <select
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded-lg text-xs font-semibold text-zinc-100 px-3 py-1.5 focus:outline-none focus:border-indigo-500"
              >
                {expiries.map(exp => (
                  <option key={exp} value={exp}>
                    {new Date(exp).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </option>
                ))}
              </select>
            )}
          </div>

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
                                onClick={() => handlePlaceOrder(row.ce!.security_id!, 'BUY')}
                                className="bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-white disabled:opacity-50 disabled:pointer-events-none border border-emerald-500/30 rounded px-1.5 py-0.5 font-bold transition-all text-[10px]"
                                title="Market Buy Option"
                              >
                                B
                              </button>
                              <button
                                disabled={ordering}
                                onClick={() => handlePlaceOrder(row.ce!.security_id!, 'SELL')}
                                className="bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white disabled:opacity-50 disabled:pointer-events-none border border-red-500/30 rounded px-1.5 py-0.5 font-bold transition-all text-[10px]"
                                title="Market Sell Option"
                              >
                                S
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

      </main>
    </div>
  );
}
