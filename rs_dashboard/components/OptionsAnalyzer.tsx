'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { AlertCircle, RefreshCw, BarChart2, CheckSquare, Square, Info, Layers, Settings, Activity, ZapOff } from 'lucide-react';
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

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY'] as const;
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

export default function OptionsAnalyzer() {
  const [underlying, setUnderlying] = useState<typeof UNDERLYINGS[number]>('NIFTY');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [selectedExpiry, setSelectedExpiry] = useState<string>('');
  const [candleInterval, setCandleInterval] = useState<string>('5');

  // Indicator Settings States
  const [supertrendPeriod, setSupertrendPeriod] = useState<number>(7);
  const [supertrendMultiplier, setSupertrendMultiplier] = useState<number>(3.0);
  const [rsiPeriod, setRsiPeriod] = useState<number>(14);
  const [ema20Period, setEma20Period] = useState<number>(20);
  const [ema50Period, setEma50Period] = useState<number>(50);

  // Temporary Settings input states for Modal
  const [tempSupertrendPeriod, setTempSupertrendPeriod] = useState<number>(7);
  const [tempSupertrendMultiplier, setTempSupertrendMultiplier] = useState<number>(3.0);
  const [tempRsiPeriod, setTempRsiPeriod] = useState<number>(14);
  const [tempEma20Period, setTempEma20Period] = useState<number>(20);
  const [tempEma50Period, setTempEma50Period] = useState<number>(50);
  const [otmWeight, setOtmWeight] = useState<number>(30);      // % weight for OTM distance in composite score
  const [tempOtmWeight, setTempOtmWeight] = useState<number>(30);
  const [minPremiumThreshold, setMinPremiumThreshold] = useState<number>(20); // min LTP for adequate premium
  const [tempMinPremiumThreshold, setTempMinPremiumThreshold] = useState<number>(20);

  const [settingsOpen, setSettingsOpen] = useState(false);

  const [activeFactors, setActiveFactors] = useState<Record<string, boolean>>({
    price_change: true,
    oi_change: true,
    rsi: true,
    supertrend: true,
    vwap: true,
    ema20: true,
    ema50: true,
    min_premium: true,
  });

  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<AnalyzerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const underlyingRef = useRef(underlying);
  const selectedExpiryRef = useRef(selectedExpiry);

  useEffect(() => {
    underlyingRef.current = underlying;
  }, [underlying]);

  useEffect(() => {
    selectedExpiryRef.current = selectedExpiry;
  }, [selectedExpiry]);

  const handleUnderlyingChange = (sym: typeof UNDERLYINGS[number]) => {
    if (sym === underlying) return;
    setUnderlying(sym);
    setExpiries([]);
    setSelectedExpiry('');
    setData(null);
    setError(null);
  };
  const [hoveredMetric, setHoveredMetric] = useState<{ contractId: number, factorId: string, text: string } | null>(null);
  const [minScore, setMinScore] = useState<number>(0); // minimum composite score filter (0-100)

  // Live auto-refresh state
  const [isLive, setIsLive] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const liveIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const countdownRef = useRef<NodeJS.Timeout | null>(null);

  // Dynamic Factors Definition based on current settings
  const factors = useMemo<Factor[]>(() => [
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
      label: `RSI (${rsiPeriod})`,
      desc: `Seller perspective: Favorable if RSI < 50 (indicating bearish momentum on option premium)`,
      check: (c) => (c.rsi !== null ? c.rsi < 50 : null),
      formatValue: (c) => (c.rsi !== null ? `RSI: ${c.rsi.toFixed(1)}` : 'N/A')
    },
    {
      id: 'supertrend',
      label: `Supertrend (${supertrendPeriod}, ${supertrendMultiplier})`,
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
      label: `${ema20Period} EMA`,
      desc: `Seller perspective: Favorable if option price is below ${ema20Period} EMA (LTP < ${ema20Period} EMA)`,
      check: (c) => (c.ema20 !== null ? c.ltp < c.ema20 : null),
      formatValue: (c) => (c.ema20 !== null ? `LTP: ₹${c.ltp.toFixed(1)} vs ${ema20Period} EMA: ₹${c.ema20.toFixed(1)}` : 'N/A')
    },
    {
      id: 'ema50',
      label: `${ema50Period} EMA`,
      desc: `Seller perspective: Favorable if option price is below ${ema50Period} EMA (LTP < ${ema50Period} EMA)`,
      check: (c) => (c.ema50 !== null ? c.ltp < c.ema50 : null),
      formatValue: (c) => (c.ema50 !== null ? `LTP: ₹${c.ltp.toFixed(1)} vs ${ema50Period} EMA: ₹${c.ema50.toFixed(1)}` : 'N/A')
    },
    {
      id: 'min_premium',
      label: `Min Premium (≥₹${minPremiumThreshold})`,
      desc: `Seller perspective: Premium must be ≥ ₹${minPremiumThreshold} to cover costs and be worth selling`,
      check: (c) => c.ltp >= minPremiumThreshold,
      formatValue: (c) => `LTP: ₹${c.ltp.toFixed(1)} (threshold: ₹${minPremiumThreshold})`
    }
  ], [rsiPeriod, supertrendPeriod, supertrendMultiplier, ema20Period, ema50Period, minPremiumThreshold]);

  // Open settings & initialize temp variables
  const openSettings = () => {
    setTempSupertrendPeriod(supertrendPeriod);
    setTempSupertrendMultiplier(supertrendMultiplier);
    setTempRsiPeriod(rsiPeriod);
    setTempEma20Period(ema20Period);
    setTempEma50Period(ema50Period);
    setTempOtmWeight(otmWeight);
    setTempMinPremiumThreshold(minPremiumThreshold);
    setSettingsOpen(true);
  };

  const saveSettings = () => {
    setSupertrendPeriod(tempSupertrendPeriod);
    setSupertrendMultiplier(tempSupertrendMultiplier);
    setRsiPeriod(tempRsiPeriod);
    setEma20Period(tempEma20Period);
    setEma50Period(tempEma50Period);
    setOtmWeight(Math.max(0, Math.min(100, tempOtmWeight)));
    setMinPremiumThreshold(Math.max(1, tempMinPremiumThreshold));
    setSettingsOpen(false);
  };

  // Derived: Days To Expiry
  const daysToExpiry = useMemo(() => {
    if (!selectedExpiry) return null;
    const expDate = new Date(selectedExpiry);
    expDate.setHours(15, 30, 0, 0); // expire at 3:30 PM
    const now = new Date();
    const diff = Math.ceil((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return Math.max(0, diff);
  }, [selectedExpiry]);

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

  // Fetch analysis data. Returns true on success, false on failure/skip.
  const fetchAnalysis = useCallback(async (): Promise<boolean> => {
    if (!selectedExpiry || !expiries.includes(selectedExpiry)) return false;
    const fetchUnderlying = underlying;
    const fetchExpiry = selectedExpiry;
    try {
      setLoading(true);
      setError(null);
      const queryParams = new URLSearchParams({
        underlying: fetchUnderlying,
        expiry: fetchExpiry,
        interval: candleInterval,
        supertrendPeriod: String(supertrendPeriod),
        supertrendMultiplier: String(supertrendMultiplier),
        rsiPeriod: String(rsiPeriod),
        ema20Period: String(ema20Period),
        ema50Period: String(ema50Period)
      });
      const res = await fetch(`/api/options/analyzer?${queryParams.toString()}`);
      const json = await res.json();

      if (underlyingRef.current !== fetchUnderlying || selectedExpiryRef.current !== fetchExpiry) {
        return false;
      }

      if (json.success && json.data) {
        setData(json.data);
        return true;
      } else {
        throw new Error(json.error || 'Failed to fetch options ranking data');
      }
    } catch (err: any) {
      if (underlyingRef.current === fetchUnderlying && selectedExpiryRef.current === fetchExpiry) {
        console.error(err);
        setError(err.message || 'Error executing options ranking analyzer');
      }
      return false;
    } finally {
      if (underlyingRef.current === fetchUnderlying && selectedExpiryRef.current === fetchExpiry) {
        setLoading(false);
      }
    }
  }, [underlying, selectedExpiry, expiries, candleInterval, supertrendPeriod, supertrendMultiplier, rsiPeriod, ema20Period, ema50Period]);

  useEffect(() => {
    fetchAnalysis();
  }, [selectedExpiry, candleInterval, fetchAnalysis]);

  // Stop live mode when key params change
  useEffect(() => {
    setIsLive(false);
  }, [underlying, selectedExpiry, candleInterval]);

  // Live auto-refresh timer management
  useEffect(() => {
    const stopTimers = () => {
      if (liveIntervalRef.current) { clearInterval(liveIntervalRef.current); liveIntervalRef.current = null; }
      if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    };

    if (!isLive) {
      stopTimers();
      setCountdown(0);
      return;
    }

    const intervalMins = parseInt(candleInterval);
    const intervalSecs = intervalMins * 60;

    // Kick off first refresh immediately when going live
    fetchAnalysis().then(ok => { if (ok) setLastRefreshed(new Date()); });
    setCountdown(intervalSecs);

    // Countdown tick — every second
    countdownRef.current = setInterval(() => {
      setCountdown(prev => (prev <= 1 ? intervalSecs : prev - 1));
    }, 1000);

    // Main refresh interval
    liveIntervalRef.current = setInterval(() => {
      setCountdown(intervalSecs);
      fetchAnalysis().then(ok => { if (ok) setLastRefreshed(new Date()); });
    }, intervalSecs * 1000);

    return stopTimers;
    // Re-creates the timer whenever fetchAnalysis changes (e.g. indicator settings edited while live),
    // so live mode always refreshes with current settings instead of a stale closure.
  }, [isLive, candleInterval, fetchAnalysis]);

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

  // Score Calculator — returns factor score only (for circle display)
  const computeFactorScore = useCallback((contract: OptionContractData | null) => {
    if (!contract) return { score: 0, total: 0, pct: 0 };
    
    let greenCount = 0;
    let consideredCount = 0;

    factors.forEach(factor => {
      if (activeFactors[factor.id]) {
        const checkResult = factor.check(contract);
        if (checkResult !== null) {
          consideredCount++;
          if (checkResult) greenCount++;
        }
      }
    });

    return {
      score: greenCount,
      total: consideredCount,
      pct: consideredCount > 0 ? (greenCount / consideredCount) * 100 : 0
    };
  }, [activeFactors, factors]);

  // Processed Ranking Data with composite score = factorScore × (1-otmW) + otmScore × otmW
  const rankedContracts = useMemo(() => {
    if (!data?.strikes) return { ce: [], pe: [] };

    const atm = data.atm;
    const allStrikes = data.strikes.map(s => s.strike);
    const maxDist = allStrikes.reduce((max, s) => Math.max(max, Math.abs(s - atm)), 0) || 1;
    const otmW = otmWeight / 100;

    type RankedContract = OptionContractData & {
      strike: number;
      scoreInfo: { score: number; total: number; pct: number };
      otmDistPct: number;   // % distance from ATM (0 = ATM, 100 = max OTM in range)
      compositeScore: number; // 0–100, used for sorting
    };

    const ceContracts: RankedContract[] = [];
    const peContracts: RankedContract[] = [];

    data.strikes.forEach(row => {
      const otmDist = Math.abs(row.strike - atm);
      const otmNorm = otmDist / maxDist; // 0 (ATM) → 1 (most OTM)

      if (row.ce) {
        const fs = computeFactorScore(row.ce);
        const factorNorm = fs.pct / 100;
        // For CE: OTM = strike > ATM. Only apply OTM bonus for genuinely OTM strikes
        const ceIsOtm = row.strike >= atm;
        // Deny the OTM-distance bonus for contracts below the premium floor, so cheap
        // deep-OTM strikes can't outrank pricier ones on distance alone
        const cePremiumOk = !activeFactors['min_premium'] || row.ce.ltp >= minPremiumThreshold;
        const ceOtmScore = (ceIsOtm && cePremiumOk) ? otmNorm : 0;
        const composite = (factorNorm * (1 - otmW) + ceOtmScore * otmW) * 100;
        ceContracts.push({
          ...row.ce, strike: row.strike,
          scoreInfo: fs,
          otmDistPct: (otmDist / atm) * 100,
          compositeScore: composite
        });
      }
      if (row.pe) {
        const fs = computeFactorScore(row.pe);
        const factorNorm = fs.pct / 100;
        // For PE: OTM = strike < ATM. Only apply OTM bonus for genuinely OTM strikes
        const peIsOtm = row.strike <= atm;
        const pePremiumOk = !activeFactors['min_premium'] || row.pe.ltp >= minPremiumThreshold;
        const peOtmScore = (peIsOtm && pePremiumOk) ? otmNorm : 0;
        const composite = (factorNorm * (1 - otmW) + peOtmScore * otmW) * 100;
        peContracts.push({
          ...row.pe, strike: row.strike,
          scoreInfo: fs,
          otmDistPct: (otmDist / atm) * 100,
          compositeScore: composite
        });
      }
    });

    const sortFn = (a: RankedContract, b: RankedContract) => b.compositeScore - a.compositeScore;

    return {
      ce: [...ceContracts].sort(sortFn),
      pe: [...peContracts].sort(sortFn)
    };
  }, [data, computeFactorScore, otmWeight, activeFactors, minPremiumThreshold]);

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

        {isLive && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 border border-red-500/30 shrink-0">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-500" />
            </span>
            <span className="text-[10px] font-bold uppercase tracking-widest text-red-400">Live</span>
          </div>
        )}

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
                  onClick={() => handleUnderlyingChange(sym)}
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
                  onClick={() => setCandleInterval(int.value)}
                  className={cn(
                    "px-3 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 cursor-pointer select-none",
                    candleInterval === int.value
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
              <div className="h-6 w-px bg-zinc-800" />
              {/* DTE chip */}
              {daysToExpiry !== null && (
                <div className="flex flex-col items-end">
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">Expiry</span>
                  <span className={cn(
                    "tabular-nums text-sm font-bold",
                    daysToExpiry <= 2 ? "text-red-400" : daysToExpiry <= 5 ? "text-amber-400" : "text-zinc-200"
                  )}>
                    {daysToExpiry === 0 ? 'Today' : `${daysToExpiry}d`}
                  </span>
                </div>
              )}
              {/* Action buttons: Go Live + Settings + Refresh */}
              <div className="flex items-center gap-2">

                {/* Go Live toggle */}
                <button
                  onClick={() => setIsLive(prev => !prev)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition-all duration-200 cursor-pointer active:scale-95 select-none",
                    isLive
                      ? "bg-red-500/10 border-red-500/35 text-red-400 hover:bg-red-500/15 shadow-[0_0_12px_rgba(239,68,68,0.1)]"
                      : "bg-emerald-500/10 border-emerald-500/25 text-emerald-300 hover:bg-emerald-500/15 shadow-[0_0_12px_rgba(16,185,129,0.05)]"
                  )}
                  title={isLive ? 'Stop live auto-refresh' : `Start live auto-refresh (every ${candleInterval} min)`}
                >
                  {isLive ? (
                    <>
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                      </span>
                      <ZapOff className="h-3 w-3" />
                      Stop Live
                    </>
                  ) : (
                    <>
                      <Activity className="h-3 w-3" />
                      Go Live
                    </>
                  )}
                </button>

                {/* Countdown badge — only shown when live */}
                {isLive && countdown > 0 && (
                  <div className="flex flex-col items-center px-2 py-1 bg-zinc-900/80 border border-zinc-800 rounded-xl">
                    <span className="text-[9px] text-zinc-500 uppercase tracking-wider font-bold leading-none">Next</span>
                    <span className={cn(
                      "text-xs font-bold tabular-nums leading-none mt-0.5",
                      countdown <= 10 ? "text-amber-400" : "text-zinc-300"
                    )}>
                      {Math.floor(countdown / 60) > 0 ? `${Math.floor(countdown / 60)}m ` : ''}{(countdown % 60).toString().padStart(2, '0')}s
                    </span>
                  </div>
                )}

                {/* Last refreshed */}
                {lastRefreshed && isLive && (
                  <span className="text-[10px] text-zinc-600 font-medium hidden sm:block">
                    {lastRefreshed.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                )}

                <div className="h-5 w-px bg-zinc-800" />

                <button
                  onClick={openSettings}
                  className="p-2 border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800/80 hover:border-zinc-700 active:scale-95 transition-all duration-200 rounded-xl cursor-pointer"
                  title="Configure Technical Indicators Settings"
                >
                  <Settings className="h-3.5 w-3.5 text-zinc-400 hover:text-emerald-400" />
                </button>
                <button
                  onClick={() => { fetchAnalysis().then(() => setLastRefreshed(new Date())); }}
                  className="p-2 border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800/80 hover:border-zinc-700 active:scale-95 transition-all duration-200 rounded-xl cursor-pointer"
                  title="Manual refresh"
                  disabled={loading}
                >
                  <RefreshCw className={cn("h-3.5 w-3.5 text-zinc-400", loading && "animate-spin text-emerald-400")} />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Near-expiry warning banner */}
        {daysToExpiry !== null && daysToExpiry <= 3 && (
          <div className="bg-amber-500/10 border border-amber-500/25 px-4 py-2.5 rounded-xl flex items-center gap-3">
            <AlertCircle className="h-4 w-4 text-amber-400 flex-shrink-0" />
            <span className="text-xs font-semibold text-amber-300">
              ⚠️ Expiry in {daysToExpiry === 0 ? 'today' : `${daysToExpiry} day${daysToExpiry === 1 ? '' : 's'}`} — premiums are thin and gamma risk is extreme near expiry. Consider switching to a later expiry.
            </span>
          </div>
        )}

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
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
            {factors.map(f => {
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
                  <div className="flex items-center gap-1.8">
                    {checked ? (
                      <CheckSquare className="h-4 w-4 text-emerald-400 flex-shrink-0" />
                    ) : (
                      <Square className="h-4 w-4 text-zinc-600 flex-shrink-0" />
                    )}
                    <span className="text-xs font-bold text-zinc-200">{f.label}</span>
                  </div>
                  <span className="text-[10px] text-zinc-500 leading-tight block">{f.id === 'price_change' ? 'Change < 0' : f.id === 'oi_change' ? 'OI Change > 0' : f.id === 'rsi' ? `RSI < 50` : f.id === 'supertrend' ? 'Trend Bearish' : f.id === 'vwap' ? 'LTP < VWAP' : f.id === 'min_premium' ? `LTP ≥ ₹${minPremiumThreshold}` : 'LTP < EMA'}</span>
                </div>
              );
            })}
          </div>

          {/* Min Score Filter Slider */}
          <div className="flex flex-col gap-2 pt-3 border-t border-zinc-850/60 mt-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Min Score Filter</span>
                <span className="text-[10px] text-zinc-600">— show only strikes with composite score ≥</span>
              </div>
              <div className="flex items-center gap-2">
                {data && (
                  <span className="text-[10px] text-zinc-500 tabular-nums">
                    CE: <span className="text-zinc-300 font-bold">{rankedContracts.ce.filter(c => c.compositeScore >= minScore).length}</span>/{rankedContracts.ce.length}
                    {' · '}
                    PE: <span className="text-zinc-300 font-bold">{rankedContracts.pe.filter(c => c.compositeScore >= minScore).length}</span>/{rankedContracts.pe.length}
                  </span>
                )}
                <span className={cn(
                  "text-sm font-bold tabular-nums min-w-[3.5rem] text-right",
                  minScore >= 80 ? "text-emerald-400" : minScore >= 50 ? "text-amber-400" : "text-zinc-400"
                )}>
                  {minScore}%
                </span>
                {minScore > 0 && (
                  <button
                    onClick={() => setMinScore(0)}
                    className="text-[10px] text-zinc-600 hover:text-zinc-300 font-bold cursor-pointer transition-colors"
                    title="Reset filter"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-zinc-700 w-6 text-right">0</span>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={minScore}
                onChange={(e) => setMinScore(parseInt(e.target.value))}
                className="flex-1 accent-emerald-500 cursor-pointer"
              />
              <span className="text-[10px] text-zinc-700 w-8">100</span>
            </div>
            {/* Score threshold tick marks */}
            <div className="flex justify-between px-6 -mt-1">
              {[0, 25, 50, 75, 100].map(v => (
                <button
                  key={v}
                  onClick={() => setMinScore(v)}
                  className={cn(
                    "text-[9px] font-bold cursor-pointer transition-colors px-1 rounded",
                    minScore === v ? "text-emerald-400" : "text-zinc-700 hover:text-zinc-400"
                  )}
                >
                  {v}%
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Global Loading / Error / Main View */}
        {loading && !data && (
          <div className="flex flex-col items-center justify-center p-20 bg-zinc-950/20 border border-zinc-850/50 rounded-2xl gap-3">
            <RefreshCw className="h-8 w-8 text-emerald-400 animate-spin" />
            <span className="text-xs font-semibold text-zinc-400">Loading ATM+/-10 contracts indicators & ranking...</span>
          </div>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/25 p-4 rounded-xl flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-red-400 mt-0.5 flex-shrink-0" />
            <div className="flex flex-col gap-1">
              <span className="text-xs font-bold text-red-300">Execution Error</span>
              <span className="text-xs text-red-400/90 leading-relaxed">{error}</span>
            </div>
          </div>
        )}

        {data && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            
            {/* CALL OPTIONS TABLE (CE) */}
            <div className="bg-zinc-950/40 backdrop-blur-md border border-zinc-850 rounded-2xl p-4 shadow-xl flex flex-col gap-3">
              <div className="flex items-center justify-between border-b border-zinc-850 pb-2">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                  <span className="text-sm font-bold text-zinc-200">Call Options (CE) Ranking</span>
                </div>
                <span className="text-[10px] text-zinc-400 font-medium uppercase tracking-wider">Sorted by Seller Score & Premium</span>
              </div>
              
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-zinc-850/60 text-[10px] uppercase font-bold text-zinc-500 tracking-wider">
                      <th className="py-2.5 px-2">Strike</th>
                      <th className="py-2.5 px-2">LTP</th>
                      <th className="py-2.5 px-2">OI</th>
                      <th className="py-2.5 px-2 text-center" title="OTM distance as % of ATM strike. More OTM = safer to sell.">OTM%</th>
                      <th className="py-2.5 px-2 text-center" title={`Composite = Factors×${100-otmWeight}% + OTM×${otmWeight}%`}>Score</th>
                      {factors.map(f => activeFactors[f.id] && (
                        <th key={f.id} className="py-2.5 px-1.5 text-center font-bold" title={f.desc}>{f.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rankedContracts.ce.filter(c => c.compositeScore >= minScore).map(c => {
                      const isATM = Math.abs(c.strike - data.atm) < 1;
                      return (
                        <tr 
                          key={c.security_id} 
                          className={cn(
                            "border-b border-zinc-900/50 hover:bg-zinc-900/20 transition-colors text-xs font-semibold text-zinc-300",
                            isATM && "bg-emerald-500/5 hover:bg-emerald-500/8 border-l border-l-emerald-500/40"
                          )}
                        >
                          <td className="py-3 px-2 font-bold tabular-nums">
                            {c.strike.toLocaleString('en-IN')}
                            {isATM && <span className="ml-1 text-[8px] px-1 bg-emerald-500/20 text-emerald-400 rounded-sm font-bold">ATM</span>}
                          </td>
                          <td className="py-3 px-2 font-bold tabular-nums text-zinc-100">₹{c.ltp.toFixed(1)}</td>
                          <td className="py-3 px-2 tabular-nums text-zinc-400">{c.oi.toLocaleString('en-IN')}</td>
                          
                          {/* OTM Distance column */}
                          <td className="py-3 px-2 text-center">
                            <span className={cn(
                              "px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums",
                              c.strike > data.atm
                                ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                                : "bg-zinc-800/60 text-zinc-500 border border-zinc-700/40"
                            )}>
                              {c.otmDistPct.toFixed(2)}%
                            </span>
                          </td>

                          {/* Composite Score Badge */}
                          <td className="py-3 px-2 text-center">
                            <div className="flex flex-col items-center gap-0.5">
                              <span 
                                className={cn(
                                  "px-2 py-0.5 rounded-md text-[10px] font-bold shadow-md",
                                  c.compositeScore >= 70 && "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30",
                                  c.compositeScore < 70 && c.compositeScore >= 40 && "bg-amber-500/15 text-amber-400 border border-amber-500/30",
                                  c.compositeScore < 40 && "bg-red-500/15 text-red-400 border border-red-500/30"
                                )}
                              >
                                {c.compositeScore.toFixed(0)}%
                              </span>
                              <span className="text-[9px] text-zinc-600 tabular-nums">{c.scoreInfo.score}/{c.scoreInfo.total} sig</span>
                            </div>
                          </td>

                          {/* Dynamic Factors Circles */}
                          {factors.map(f => {
                            if (!activeFactors[f.id]) return null;
                            const checkResult = f.check(c);
                            const formattedText = f.formatValue(c);

                            return (
                              <td key={f.id} className="py-3 px-1.5 text-center">
                                <div 
                                  className="flex items-center justify-center relative cursor-help"
                                  onMouseEnter={() => setHoveredMetric({ contractId: c.security_id, factorId: f.id, text: formattedText })}
                                  onMouseLeave={() => setHoveredMetric(null)}
                                >
                                  <span 
                                    className={cn(
                                      "h-3 w-3 rounded-full border transition-all duration-200",
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

            {/* PUT OPTIONS TABLE (PE) */}
            <div className="bg-zinc-950/40 backdrop-blur-md border border-zinc-850 rounded-2xl p-4 shadow-xl flex flex-col gap-3">
              <div className="flex items-center justify-between border-b border-zinc-850 pb-2">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]" />
                  <span className="text-sm font-bold text-zinc-200">Put Options (PE) Ranking</span>
                </div>
                <span className="text-[10px] text-zinc-400 font-medium uppercase tracking-wider">Sorted by Seller Score & Premium</span>
              </div>
              
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-zinc-850/60 text-[10px] uppercase font-bold text-zinc-500 tracking-wider">
                      <th className="py-2.5 px-2">Strike</th>
                      <th className="py-2.5 px-2">LTP</th>
                      <th className="py-2.5 px-2">OI</th>
                      <th className="py-2.5 px-2 text-center" title="OTM distance as % of ATM strike. More OTM = safer to sell.">OTM%</th>
                      <th className="py-2.5 px-2 text-center" title={`Composite = Factors×${100-otmWeight}% + OTM×${otmWeight}%`}>Score</th>
                      {factors.map(f => activeFactors[f.id] && (
                        <th key={f.id} className="py-2.5 px-1.5 text-center font-bold" title={f.desc}>{f.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rankedContracts.pe.filter(c => c.compositeScore >= minScore).map(c => {
                      const isATM = Math.abs(c.strike - data.atm) < 1;
                      return (
                        <tr 
                          key={c.security_id} 
                          className={cn(
                            "border-b border-zinc-900/50 hover:bg-zinc-900/20 transition-colors text-xs font-semibold text-zinc-300",
                            isATM && "bg-red-500/5 hover:bg-red-500/8 border-l border-l-red-500/40"
                          )}
                        >
                          <td className="py-3 px-2 font-bold tabular-nums">
                            {c.strike.toLocaleString('en-IN')}
                            {isATM && <span className="ml-1 text-[8px] px-1 bg-red-500/20 text-red-400 rounded-sm font-bold">ATM</span>}
                          </td>
                          <td className="py-3 px-2 font-bold tabular-nums text-zinc-100">₹{c.ltp.toFixed(1)}</td>
                          <td className="py-3 px-2 tabular-nums text-zinc-400">{c.oi.toLocaleString('en-IN')}</td>
                          
                          {/* OTM Distance column */}
                          <td className="py-3 px-2 text-center">
                            <span className={cn(
                              "px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums",
                              c.strike < data.atm
                                ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                                : "bg-zinc-800/60 text-zinc-500 border border-zinc-700/40"
                            )}>
                              {c.otmDistPct.toFixed(2)}%
                            </span>
                          </td>

                          {/* Composite Score Badge */}
                          <td className="py-3 px-2 text-center">
                            <div className="flex flex-col items-center gap-0.5">
                              <span 
                                className={cn(
                                  "px-2 py-0.5 rounded-md text-[10px] font-bold shadow-md",
                                  c.compositeScore >= 70 && "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30",
                                  c.compositeScore < 70 && c.compositeScore >= 40 && "bg-amber-500/15 text-amber-400 border border-amber-500/30",
                                  c.compositeScore < 40 && "bg-red-500/15 text-red-400 border border-red-500/30"
                                )}
                              >
                                {c.compositeScore.toFixed(0)}%
                              </span>
                              <span className="text-[9px] text-zinc-600 tabular-nums">{c.scoreInfo.score}/{c.scoreInfo.total} sig</span>
                            </div>
                          </td>

                          {/* Dynamic Factors Circles */}
                          {factors.map(f => {
                            if (!activeFactors[f.id]) return null;
                            const checkResult = f.check(c);
                            const formattedText = f.formatValue(c);

                            return (
                              <td key={f.id} className="py-3 px-1.5 text-center">
                                <div 
                                  className="flex items-center justify-center relative cursor-help"
                                  onMouseEnter={() => setHoveredMetric({ contractId: c.security_id, factorId: f.id, text: formattedText })}
                                  onMouseLeave={() => setHoveredMetric(null)}
                                >
                                  <span 
                                    className={cn(
                                      "h-3 w-3 rounded-full border transition-all duration-200",
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

      {/* Floating Hover Tooltip */}
      <AnimatePresence>
        {hoveredMetric && (
          <div className="fixed bottom-6 right-6 z-50 pointer-events-none">
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              className="bg-zinc-950 border border-zinc-800/80 px-4 py-2.5 rounded-xl shadow-2xl flex items-center gap-2 max-w-sm pointer-events-none"
            >
              <Info className="h-4 w-4 text-emerald-400 flex-shrink-0" />
              <span className="text-xs font-semibold text-zinc-200 leading-tight">{hoveredMetric.text}</span>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Indicator Settings Modal */}
      <AnimatePresence>
        {settingsOpen && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-zinc-950 border border-zinc-850 p-6 rounded-2xl shadow-2xl max-w-sm w-full flex flex-col gap-4 text-zinc-200"
            >
              <div className="flex items-center justify-between border-b border-zinc-850 pb-3">
                <div className="flex items-center gap-2">
                  <Settings className="h-4.5 w-4.5 text-emerald-400" />
                  <span className="font-bold text-sm uppercase tracking-wider text-zinc-200">Indicator Settings</span>
                </div>
                <button
                  onClick={() => setSettingsOpen(false)}
                  className="text-xs text-zinc-500 hover:text-zinc-300 font-bold select-none cursor-pointer"
                >
                  ✕
                </button>
              </div>

              {/* Form Input fields */}
              <div className="flex flex-col gap-4 py-2">
                
                {/* Supertrend Period */}
                <div className="grid grid-cols-2 items-center gap-3">
                  <label className="text-xs font-semibold text-zinc-400">Supertrend Period</label>
                  <input
                    type="number"
                    value={tempSupertrendPeriod}
                    onChange={(e) => setTempSupertrendPeriod(parseInt(e.target.value) || 7)}
                    className="bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 font-bold outline-none focus:border-emerald-500/30 text-right"
                    min="1"
                    max="100"
                  />
                </div>

                {/* Supertrend Multiplier */}
                <div className="grid grid-cols-2 items-center gap-3">
                  <label className="text-xs font-semibold text-zinc-400">Supertrend Multiplier</label>
                  <input
                    type="number"
                    step="0.1"
                    value={tempSupertrendMultiplier}
                    onChange={(e) => setTempSupertrendMultiplier(parseFloat(e.target.value) || 3.0)}
                    className="bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 font-bold outline-none focus:border-emerald-500/30 text-right"
                    min="0.1"
                    max="20"
                  />
                </div>

                {/* RSI Period */}
                <div className="grid grid-cols-2 items-center gap-3">
                  <label className="text-xs font-semibold text-zinc-400">RSI Period</label>
                  <input
                    type="number"
                    value={tempRsiPeriod}
                    onChange={(e) => setTempRsiPeriod(parseInt(e.target.value) || 14)}
                    className="bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 font-bold outline-none focus:border-emerald-500/30 text-right"
                    min="1"
                    max="100"
                  />
                </div>

                {/* EMA 20 Period */}
                <div className="grid grid-cols-2 items-center gap-3">
                  <label className="text-xs font-semibold text-zinc-400">20 EMA Period</label>
                  <input
                    type="number"
                    value={tempEma20Period}
                    onChange={(e) => setTempEma20Period(parseInt(e.target.value) || 20)}
                    className="bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 font-bold outline-none focus:border-emerald-500/30 text-right"
                    min="1"
                    max="200"
                  />
                </div>

                {/* OTM Weight */}
                <div className="flex flex-col gap-2 pt-1 border-t border-zinc-850">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-zinc-400">OTM Safety Weight</label>
                    <span className="text-xs font-bold text-blue-400 tabular-nums">{tempOtmWeight}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="60"
                    step="5"
                    value={tempOtmWeight}
                    onChange={(e) => setTempOtmWeight(parseInt(e.target.value))}
                    className="w-full accent-emerald-500 cursor-pointer"
                  />
                  <p className="text-[10px] text-zinc-600 leading-tight">
                    Composite = Factors×{100 - tempOtmWeight}% + OTM Distance×{tempOtmWeight}%. Higher weight promotes safer OTM strikes when factors are tied.
                  </p>
                </div>

                {/* EMA 50 Period */}
                <div className="grid grid-cols-2 items-center gap-3">
                  <label className="text-xs font-semibold text-zinc-400">50 EMA Period</label>
                  <input
                    type="number"
                    value={tempEma50Period}
                    onChange={(e) => setTempEma50Period(parseInt(e.target.value) || 50)}
                    className="bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 font-bold outline-none focus:border-emerald-500/30 text-right"
                    min="1"
                    max="500"
                  />
                </div>
                {/* Min Premium Threshold */}
                <div className="grid grid-cols-2 items-center gap-3 pt-1 border-t border-zinc-850">
                  <div>
                    <label className="text-xs font-semibold text-zinc-400 block">Min Premium (₹)</label>
                    <span className="text-[10px] text-zinc-600">LTP ≥ threshold to score green</span>
                  </div>
                  <input
                    type="number"
                    value={tempMinPremiumThreshold}
                    onChange={(e) => setTempMinPremiumThreshold(parseInt(e.target.value) || 20)}
                    className="bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 font-bold outline-none focus:border-emerald-500/30 text-right"
                    min="1"
                    max="5000"
                  />
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2 justify-end border-t border-zinc-850 pt-3 mt-1">
                <button
                  onClick={() => setSettingsOpen(false)}
                  className="px-4 py-1.5 rounded-lg text-xs font-bold text-zinc-400 hover:text-zinc-200 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800/60 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={saveSettings}
                  className="px-4 py-1.5 rounded-lg text-xs font-bold text-emerald-300 bg-emerald-500/10 border border-emerald-500/25 hover:bg-emerald-500/15 cursor-pointer shadow-lg shadow-emerald-500/5"
                >
                  Apply Settings
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
