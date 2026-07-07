'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Check, HelpCircle, AlertCircle, RefreshCw, BarChart2, CheckSquare, Square, Info, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import NavBar from '@/components/NavBar';

// Types
interface OptionContractData {
  symbol: string;
  display_name: string;
  security_id: number;
  ltp: number;
  prev_close: number;
  oi: number;
  prev_oi: number;
  rsi: number | null;
  vwap: number | null;
  ema20: number | null;
  ema50: number | null;
  supertrend_dir: number | null; // 1 for Bullish, -1 for Bearish
  error?: string;
}

interface StrikeRow {
  strike: number;
  ce: OptionContractData | null;
  pe: OptionContractData | null;
}

interface AnalyzerResponse {
  spot: number;
  atm: number;
  expiry: string;
  strikes: StrikeRow[];
}

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'] as const;
const INTERVALS = [
  { label: '1 Min', value: '1' },
  { label: '2 Min', value: '2' },
  { label: '3 Min', value: '3' },
  { label: '5 Min', value: '5' },
] as const;

// Factor Definition
interface Factor {
  id: string;
  label: string;
  desc: string;
  check: (contract: OptionContractData) => boolean | null;
  formatValue: (contract: OptionContractData) => string;
}

const FACTORS: Factor[] = [
  {
    id: 'price_change',
    label: 'Price Change',
    desc: 'Seller perspective: Favorable if option price went down (Change < 0)',
    check: (c) => {
      const change = c.ltp - c.prev_close;
      return change < 0;
    },
    formatValue: (c) => {
      const change = c.ltp - c.prev_close;
      const pct = c.prev_close > 0 ? (change / c.prev_close) * 100 : 0;
      return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% (₹${change.toFixed(1)})`;
    }
  },
  {
    id: 'oi_change',
    label: 'OI Change',
    desc: 'Seller perspective: Favorable if open interest increased (OI Change > 0), showing writing interest',
    check: (c) => {
      const change = c.oi - c.prev_oi;
      return change > 0;
    },
    formatValue: (c) => {
      const change = c.oi - c.prev_oi;
      const pct = c.prev_oi > 0 ? (change / c.prev_oi) * 100 : 0;
      return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% (${change.toLocaleString('en-IN')})`;
    }
  },
  {
    id: 'rsi',
    label: 'RSI (14)',
    desc: 'Seller perspective: Favorable if RSI < 50 (indicating bearish trend on option price)',
    check: (c) => (c.rsi !== null ? c.rsi < 50 : null),
    formatValue: (c) => (c.rsi !== null ? `RSI: ${c.rsi.toFixed(1)}` : 'N/A')
  },
  {
    id: 'supertrend',
    label: 'Supertrend',
    desc: 'Seller perspective: Favorable if Supertrend is Bearish',
    check: (c) => (c.supertrend_dir !== null ? c.supertrend_dir === -1 : null),
    formatValue: (c) => {
      if (c.supertrend_dir === 1) return 'Bullish';
      if (c.supertrend_dir === -1) return 'Bearish';
      return 'N/A';
    }
  },
  {
    id: 'vwap',
    label: 'VWAP',
    desc: 'Seller perspective: Favorable if option price is below VWAP (LTP < VWAP)',
    check: (c) => (c.vwap !== null ? c.ltp < c.vwap : null),
    formatValue: (c) => (c.vwap !== null ? `LTP: ₹${c.ltp.toFixed(1)} vs VWAP: ₹${c.vwap.toFixed(1)}` : 'N/A')
  },
  {
    id: 'ema20',
    label: '20 EMA',
    desc: 'Seller perspective: Favorable if option price is below 20 EMA (LTP < 20 EMA)',
    check: (c) => (c.ema20 !== null ? c.ltp < c.ema20 : null),
    formatValue: (c) => (c.ema20 !== null ? `LTP: ₹${c.ltp.toFixed(1)} vs 20 EMA: ₹${c.ema20.toFixed(1)}` : 'N/A')
  },
  {
    id: 'ema50',
    label: '50 EMA',
    desc: 'Seller perspective: Favorable if option price is below 50 EMA (LTP < 50 EMA)',
    check: (c) => (c.ema50 !== null ? c.ltp < c.ema50 : null),
    formatValue: (c) => (c.ema50 !== null ? `LTP: ₹${c.ltp.toFixed(1)} vs 50 EMA: ₹${c.ema50.toFixed(1)}` : 'N/A')
  }
];

export default function OptionsAnalyzer() {
  const [underlying, setUnderlying] = useState<typeof UNDERLYINGS[number]>('NIFTY');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [selectedExpiry, setSelectedExpiry] = useState<string>('');
  const [interval, setInterval] = useState<string>('5');
  const [activeFactors, setActiveFactors] = useState<Record<string, boolean>>({
    price_change: true,
    oi_change: true,
    rsi: true,
    supertrend: true,
    vwap: true,
    ema20: true,
    ema50: true,
  });

  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<AnalyzerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoveredMetric, setHoveredMetric] = useState<{ contractId: number, factorId: string, text: string } | null>(null);

  // Fetch expiries
  const loadExpiries = useCallback(async (symbol: string) => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/options/expiries?underlying=${symbol}`);
      const json = await res.json();
      if (json.success && json.data?.length) {
        setExpiries(json.data);
        setSelectedExpiry(json.data[0]);
      } else {
        throw new Error(json.error || 'Failed to load expiries');
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Error fetching expiries');
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadExpiries(underlying);
  }, [underlying, loadExpiries]);

  // Fetch analysis data
  const fetchAnalysis = useCallback(async () => {
    if (!selectedExpiry) return;
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/options/analyzer?underlying=${underlying}&expiry=${selectedExpiry}&interval=${interval}`);
      const json = await res.json();
      if (json.success && json.data) {
        setData(json.data);
      } else {
        throw new Error(json.error || 'Failed to fetch options ranking data');
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Error executing options ranking analyzer');
    } finally {
      setLoading(false);
    }
  }, [underlying, selectedExpiry, interval]);

  useEffect(() => {
    fetchAnalysis();
  }, [selectedExpiry, interval, fetchAnalysis]);

  // Toggle factors
  const toggleFactor = (id: string) => {
    setActiveFactors(prev => ({
      ...prev,
      [id]: !prev[id]
    }));
  };

  const selectAllFactors = (val: boolean) => {
    const updated = { ...activeFactors };
    Object.keys(updated).forEach(k => {
      updated[k] = val;
    });
    setActiveFactors(updated);
  };

  // Score Calculator
  const computeScore = useCallback((contract: OptionContractData | null) => {
    if (!contract) return { score: 0, total: 0, pct: 0 };
    
    let greenCount = 0;
    let consideredCount = 0;

    FACTORS.forEach(factor => {
      if (activeFactors[factor.id]) {
        const checkResult = factor.check(contract);
        if (checkResult !== null) {
          consideredCount++;
          if (checkResult) {
            greenCount++;
          }
        }
      }
    });

    return {
      score: greenCount,
      total: consideredCount,
      pct: consideredCount > 0 ? (greenCount / consideredCount) * 100 : 0
    };
  }, [activeFactors]);

  // Processed Ranking Data
  const rankedContracts = useMemo(() => {
    if (!data?.strikes) return { ce: [], pe: [] };

    const ceContracts: (OptionContractData & { strike: number; scoreInfo: { score: number, total: number, pct: number } })[] = [];
    const peContracts: (OptionContractData & { strike: number; scoreInfo: { score: number, total: number, pct: number } })[] = [];

    data.strikes.forEach(row => {
      if (row.ce) {
        ceContracts.push({
          ...row.ce,
          strike: row.strike,
          scoreInfo: computeScore(row.ce)
        });
      }
      if (row.pe) {
        peContracts.push({
          ...row.pe,
          strike: row.strike,
          scoreInfo: computeScore(row.pe)
        });
      }
    });

    // Sort CE options (Highest Seller Score first, then lower strike first to break ties)
    const sortedCE = [...ceContracts].sort((a, b) => {
      if (b.scoreInfo.pct !== a.scoreInfo.pct) {
        return b.scoreInfo.pct - a.scoreInfo.pct;
      }
      return b.ltp - a.ltp; // higher premium is more attractive to sell
    });

    // Sort PE options (Highest Seller Score first, then higher strike first to break ties)
    const sortedPE = [...peContracts].sort((a, b) => {
      if (b.scoreInfo.pct !== a.scoreInfo.pct) {
        return b.scoreInfo.pct - a.scoreInfo.pct;
      }
      return b.ltp - a.ltp; // higher premium is more attractive to sell
    });

    return { ce: sortedCE, pe: sortedPE };
  }, [data, computeScore]);

  return (
    <div className="flex flex-col min-h-screen bg-black text-zinc-100">
      {/* Sticky header */}
      <header className="sticky top-0 w-full border-b border-zinc-900 bg-zinc-950/60 backdrop-blur-md px-5 py-3 flex items-center gap-4 z-20 flex-wrap">
        <div className="flex items-center gap-3 shrink-0">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-500/10">
            <Layers className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight bg-gradient-to-r from-white via-zinc-200 to-zinc-500 bg-clip-text text-transparent leading-none">
              Option Analyzer
            </h1>
            <p className="text-[10px] text-zinc-400 font-medium mt-0.5">
              Rank ATM+/-10 strikes for option sellers
            </p>
          </div>
        </div>

        <NavBar />
      </header>

      {/* Main Content Wrapper */}
      <div className="flex-1 overflow-auto p-4 sm:p-6 max-w-7xl mx-auto w-full flex flex-col gap-6">
        {/* Upper Control Bar */}
        <div className="bg-zinc-950/40 backdrop-blur-md border border-zinc-850 p-4 rounded-2xl flex flex-wrap items-center justify-between gap-4 shadow-xl">
        <div className="flex flex-wrap items-center gap-4">
          {/* Underlying Selector */}
          <div className="flex bg-zinc-900/60 p-1 border border-zinc-800 rounded-xl">
            {UNDERLYINGS.map(sym => (
              <button
                key={sym}
                onClick={() => setUnderlying(sym)}
                className={cn(
                  "px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 cursor-pointer select-none",
                  underlying === sym 
                    ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/25 shadow-lg shadow-emerald-500/5" 
                    : "text-zinc-400 hover:text-zinc-100 border border-transparent"
                )}
              >
                {sym}
              </button>
            ))}
          </div>

          {/* Expiry Selector */}
          <div className="flex flex-col gap-1">
            <select
              value={selectedExpiry}
              onChange={(e) => setSelectedExpiry(e.target.value)}
              className="bg-zinc-900 border border-zinc-850 rounded-xl px-3 py-1.5 text-xs font-bold text-zinc-200 outline-none focus:border-emerald-500/30"
              disabled={loading && expiries.length === 0}
            >
              {expiries.map(exp => (
                <option key={exp} value={exp}>
                  {new Date(exp).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()}
                </option>
              ))}
            </select>
          </div>

          {/* Interval Selector */}
          <div className="flex bg-zinc-900/60 p-1 border border-zinc-800 rounded-xl">
            {INTERVALS.map(int => (
              <button
                key={int.value}
                onClick={() => setInterval(int.value)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 cursor-pointer select-none",
                  interval === int.value 
                    ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/25 shadow-lg shadow-emerald-500/5" 
                    : "text-zinc-400 hover:text-zinc-100 border border-transparent"
                )}
              >
                {int.label}
              </button>
            ))}
          </div>
        </div>

        {/* Live Info Chips */}
        {data && (
          <div className="flex items-center gap-4 text-xs font-semibold">
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">Spot Price</span>
              <span className="text-zinc-100 tabular-nums text-sm font-bold">₹{data.spot.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
            </div>
            <div className="h-6 w-px bg-zinc-800" />
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">ATM Strike</span>
              <span className="text-emerald-400 tabular-nums text-sm font-bold">{data.atm.toLocaleString('en-IN')}</span>
            </div>
            <button
              onClick={fetchAnalysis}
              className="p-2 border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800/80 hover:border-zinc-700 active:scale-95 transition-all duration-200 rounded-xl cursor-pointer"
              title="Refresh analysis"
              disabled={loading}
            >
              <RefreshCw className={cn("h-3.5 w-3.5 text-zinc-400", loading && "animate-spin text-emerald-400")} />
            </button>
          </div>
        )}
      </div>

      {/* Factors / Filters Checklist Panel */}
      <div className="bg-zinc-950/40 backdrop-blur-md border border-zinc-850 p-4.5 rounded-2xl shadow-xl flex flex-col gap-3.5">
        <div className="flex items-center justify-between border-b border-zinc-850 pb-2">
          <div className="flex items-center gap-2">
            <BarChart2 className="h-4 w-4 text-emerald-400" />
            <span className="text-xs font-bold uppercase tracking-widest text-zinc-300">Factors To Consider (Option Seller Perspective)</span>
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={() => selectAllFactors(true)}
              className="text-[11px] font-semibold text-emerald-400 hover:text-emerald-300 transition-colors cursor-pointer"
            >
              Select All
            </button>
            <span className="text-zinc-700">|</span>
            <button 
              onClick={() => selectAllFactors(false)}
              className="text-[11px] font-semibold text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
            >
              Clear All
            </button>
          </div>
        </div>

        {/* Checkboxes Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          {FACTORS.map(f => {
            const checked = activeFactors[f.id];
            return (
              <div 
                key={f.id}
                onClick={() => toggleFactor(f.id)}
                className={cn(
                  "p-2.5 rounded-xl border flex flex-col gap-1 cursor-pointer select-none transition-all duration-200 hover:-translate-y-0.5",
                  checked
                    ? "bg-emerald-500/5 border-emerald-500/35 shadow-[0_0_12px_rgba(16,185,129,0.02)]"
                    : "bg-zinc-900/30 border-zinc-850 hover:border-zinc-700 hover:bg-zinc-800/10"
                )}
                title={f.desc}
              >
                <div className="flex items-center gap-2">
                  <div className="shrink-0 text-emerald-400">
                    {checked ? (
                      <CheckSquare className="h-4 w-4 fill-emerald-500/10 stroke-[2.5]" />
                    ) : (
                      <Square className="h-4 w-4 text-zinc-600 stroke-[2]" />
                    )}
                  </div>
                  <span className={cn("text-xs font-bold transition-colors duration-150", checked ? "text-emerald-300" : "text-zinc-400")}>
                    {f.label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Main Ranking Display */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-300 p-4 rounded-xl flex items-start gap-3 shadow-lg animate-pulse">
          <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-1">
            <span className="text-sm font-bold">Analysis Failed</span>
            <span className="text-xs font-medium text-red-300/80">{error}</span>
            <button 
              onClick={fetchAnalysis}
              className="mt-2 text-xs font-semibold underline text-red-300 hover:text-white cursor-pointer w-fit"
            >
              Retry executing analysis
            </button>
          </div>
        </div>
      )}

      {loading && !data && (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <RefreshCw className="h-10 w-10 text-emerald-400 animate-spin" />
          <span className="text-sm text-zinc-400 font-semibold animate-pulse">Executing script & compiling indicators (ATM +/- 10)...</span>
        </div>
      )}

      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 relative">
          
          {/* Floating Metric Info Box */}
          <AnimatePresence>
            {hoveredMetric && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className="absolute z-50 bg-zinc-950 border border-zinc-800 p-2.5 rounded-xl shadow-2xl max-w-xs text-xs font-medium text-zinc-300"
                style={{
                  top: '15%',
                  left: '50%',
                  transform: 'translateX(-50%)',
                }}
              >
                <div className="flex items-center gap-1.5 text-zinc-400 border-b border-zinc-800 pb-1 mb-1 font-bold text-[10px] uppercase tracking-wider">
                  <Info className="h-3 w-3 text-emerald-400" />
                  {FACTORS.find(f => f.id === hoveredMetric.factorId)?.label}
                </div>
                <span>{hoveredMetric.text}</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* CALLS (CE) TABLE */}
          <div className="bg-zinc-950/40 backdrop-blur-md border border-zinc-850 p-4 rounded-2xl flex flex-col gap-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-zinc-850 pb-2">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.5)]" />
                <span className="text-xs font-bold uppercase tracking-widest text-zinc-300">CALLS (CE) SELLER RANKING</span>
              </div>
              <span className="text-[10px] text-zinc-400 font-bold bg-zinc-900 border border-zinc-800 px-2 py-0.5 rounded-md">
                Best Sell Candidates Top
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-zinc-900 text-[10px] uppercase font-bold text-zinc-500 tracking-wider">
                    <th className="py-2.5 px-2">Rank</th>
                    <th className="py-2.5 px-2">Strike</th>
                    <th className="py-2.5 px-2">LTP</th>
                    <th className="py-2.5 px-2 text-center">Seller Score</th>
                    {FACTORS.map(f => activeFactors[f.id] && (
                      <th key={f.id} className="py-2.5 px-1.5 text-center text-[9px] font-bold" title={f.desc}>
                        {f.label.split(' ')[0]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900 text-xs font-semibold">
                  {rankedContracts.ce.map((c, idx) => {
                    const isATM = Math.abs(c.strike - data.spot) < 25; // Nifty ATM check
                    return (
                      <tr 
                        key={c.security_id} 
                        className={cn(
                          "hover:bg-zinc-900/40 transition-colors duration-150",
                          isATM && "bg-blue-500/3 hover:bg-blue-500/5"
                        )}
                      >
                        <td className="py-3 px-2 font-bold text-zinc-500 tabular-nums">
                          #{idx + 1}
                        </td>
                        <td className="py-3 px-2 tabular-nums">
                          <span className={cn(isATM ? "text-blue-400 font-bold" : "text-zinc-200")}>
                            {c.strike.toLocaleString('en-IN')}
                          </span>
                          {isATM && <span className="ml-1 text-[9px] font-bold bg-blue-500/10 text-blue-300 border border-blue-500/20 px-1 rounded-sm">ATM</span>}
                        </td>
                        <td className="py-3 px-2 text-zinc-300 font-bold tabular-nums">
                          ₹{c.ltp.toFixed(2)}
                        </td>
                        <td className="py-3 px-2">
                          <div className="flex flex-col items-center gap-1">
                            <span className="text-[11px] font-bold text-emerald-400 tabular-nums">
                              {c.scoreInfo.pct.toFixed(0)}%
                            </span>
                            <div className="w-12 h-1 bg-zinc-900 rounded-full overflow-hidden border border-zinc-800/40">
                              <div 
                                className="h-full bg-emerald-500 transition-all duration-500" 
                                style={{ width: `${c.scoreInfo.pct}%` }} 
                              />
                            </div>
                            <span className="text-[8px] text-zinc-500 font-bold tracking-tighter tabular-nums">
                              ({c.scoreInfo.score}/{c.scoreInfo.total})
                            </span>
                          </div>
                        </td>
                        
                        {/* Indicators Dots */}
                        {FACTORS.map(f => {
                          if (!activeFactors[f.id]) return null;
                          const checkResult = f.check(c);
                          const formattedText = f.formatValue(c);

                          return (
                            <td key={f.id} className="py-3 px-1.5 text-center">
                              <div 
                                className="flex items-center justify-center"
                                onMouseEnter={() => setHoveredMetric({ contractId: c.security_id, factorId: f.id, text: formattedText })}
                                onMouseLeave={() => setHoveredMetric(null)}
                              >
                                <span 
                                  className={cn(
                                    "h-3 w-3 rounded-full border transition-all duration-200 cursor-help",
                                    checkResult === true && "bg-emerald-500 border-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.4)]",
                                    checkResult === false && "bg-red-500 border-red-400 shadow-[0_0_8px_rgba(239,68,68,0.4)]",
                                    checkResult === null && "bg-zinc-800 border-zinc-700"
                                  )}
                                />
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* PUTS (PE) TABLE */}
          <div className="bg-zinc-950/40 backdrop-blur-md border border-zinc-850 p-4 rounded-2xl flex flex-col gap-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-zinc-850 pb-2">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.5)]" />
                <span className="text-xs font-bold uppercase tracking-widest text-zinc-300">PUTS (PE) SELLER RANKING</span>
              </div>
              <span className="text-[10px] text-zinc-400 font-bold bg-zinc-900 border border-zinc-800 px-2 py-0.5 rounded-md">
                Best Sell Candidates Top
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-zinc-900 text-[10px] uppercase font-bold text-zinc-500 tracking-wider">
                    <th className="py-2.5 px-2">Rank</th>
                    <th className="py-2.5 px-2">Strike</th>
                    <th className="py-2.5 px-2">LTP</th>
                    <th className="py-2.5 px-2 text-center">Seller Score</th>
                    {FACTORS.map(f => activeFactors[f.id] && (
                      <th key={f.id} className="py-2.5 px-1.5 text-center text-[9px] font-bold" title={f.desc}>
                        {f.label.split(' ')[0]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900 text-xs font-semibold">
                  {rankedContracts.pe.map((c, idx) => {
                    const isATM = Math.abs(c.strike - data.spot) < 25; // Nifty ATM check
                    return (
                      <tr 
                        key={c.security_id} 
                        className={cn(
                          "hover:bg-zinc-900/40 transition-colors duration-150",
                          isATM && "bg-rose-500/3 hover:bg-rose-500/5"
                        )}
                      >
                        <td className="py-3 px-2 font-bold text-zinc-500 tabular-nums">
                          #{idx + 1}
                        </td>
                        <td className="py-3 px-2 tabular-nums">
                          <span className={cn(isATM ? "text-rose-400 font-bold" : "text-zinc-200")}>
                            {c.strike.toLocaleString('en-IN')}
                          </span>
                          {isATM && <span className="ml-1 text-[9px] font-bold bg-rose-500/10 text-rose-300 border border-rose-500/20 px-1 rounded-sm">ATM</span>}
                        </td>
                        <td className="py-3 px-2 text-zinc-300 font-bold tabular-nums">
                          ₹{c.ltp.toFixed(2)}
                        </td>
                        <td className="py-3 px-2">
                          <div className="flex flex-col items-center gap-1">
                            <span className="text-[11px] font-bold text-emerald-400 tabular-nums">
                              {c.scoreInfo.pct.toFixed(0)}%
                            </span>
                            <div className="w-12 h-1 bg-zinc-900 rounded-full overflow-hidden border border-zinc-800/40">
                              <div 
                                className="h-full bg-emerald-500 transition-all duration-500" 
                                style={{ width: `${c.scoreInfo.pct}%` }} 
                              />
                            </div>
                            <span className="text-[8px] text-zinc-500 font-bold tracking-tighter tabular-nums">
                              ({c.scoreInfo.score}/{c.scoreInfo.total})
                            </span>
                          </div>
                        </td>
                        
                        {/* Indicators Dots */}
                        {FACTORS.map(f => {
                          if (!activeFactors[f.id]) return null;
                          const checkResult = f.check(c);
                          const formattedText = f.formatValue(c);

                          return (
                            <td key={f.id} className="py-3 px-1.5 text-center">
                              <div 
                                className="flex items-center justify-center"
                                onMouseEnter={() => setHoveredMetric({ contractId: c.security_id, factorId: f.id, text: formattedText })}
                                onMouseLeave={() => setHoveredMetric(null)}
                              >
                                <span 
                                  className={cn(
                                    "h-3 w-3 rounded-full border transition-all duration-200 cursor-help",
                                    checkResult === true && "bg-emerald-500 border-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.4)]",
                                    checkResult === false && "bg-red-500 border-red-400 shadow-[0_0_8px_rgba(239,68,68,0.4)]",
                                    checkResult === null && "bg-zinc-800 border-zinc-700"
                                  )}
                                />
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
