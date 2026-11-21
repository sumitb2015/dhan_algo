'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef, useId } from 'react';
import {
  Play, Pause, SkipBack, SkipForward, ChevronLeft, ChevronRight,
  RefreshCw, TrendingUp, TrendingDown, AlertTriangle, CheckCircle2,
  Calendar, Layers, ShieldCheck, Clock, Trash2, BarChart2, Target, Award, Percent
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface Holding {
  symbol: string;
  industry: string;
  qty: number;
  entry_price: number;
  ltp: number;
  value: number;
  weight_pct: number;
  unrealised: number;
  unrealised_pct: number;
  stop_price: number;
  stage: string;
  room_to_stop_pct: number;
  hold_days: number;
  rank: number | null;
  rank_at_entry: number;
  rank_strikes: number;
}

interface Execution {
  symbol: string;
  action: 'BUY' | 'SELL';
  qty: number;
  price: number;
  amount: number;
  pnl?: number;
  pnl_pct?: number;
  reason: string;
}

interface TopRank {
  rank: number;
  symbol: string;
  industry: string;
  rs: number;
  status: string;
}

interface ClosedTrade {
  symbol: string;
  industry: string;
  entry_date: string;
  exit_date: string;
  entry_price: number;
  exit_price: number;
  qty: number;
  invested: number;
  pnl: number;
  pnl_pct: number;
  cost: number;
  exit_reason: string;
  hold_days: number;
}

interface DailySnapshot {
  date: string;
  day_name: string;
  day_index: number;
  is_review_day: boolean;
  regime_on: boolean;
  regime_enabled?: boolean;
  breakout_days?: number;
  equity: number;
  cash: number;
  invested: number;
  deployed_pct: number;
  realized_pnl: number;
  unrealised_pnl: number;
  total_pnl: number;
  total_pnl_pct: number;
  day_pnl: number;
  slots: number;
  active_slots: number;
  executions_today: Execution[];
  holdings: Holding[];
  top_ranks: TopRank[];
  closed_trades: ClosedTrade[];
}

interface SimulationResponse {
  success: boolean;
  config: {
    universe: string;
    capital: number;
    slots: number;
    regime_enabled?: boolean;
    breakout_days?: number;
    start: string;
    end: string;
    trading_days: number;
  };
  initial_capital: number;
  final_equity: number;
  total_return_pct: number;
  total_trades: number;
  snapshots: DailySnapshot[];
  error?: string;
}

const PRESETS = [
  { label: 'Last 1 Month', start: '2026-10-15', end: '2026-11-20' },
  { label: 'Last 3 Months', start: '2026-08-15', end: '2026-11-20' },
  { label: 'Last 6 Months', start: '2026-05-15', end: '2026-11-20' },
  { label: '2024 Bull Run', start: '2024-01-01', end: '2024-06-30' },
  { label: '2020 COVID Crash', start: '2020-02-01', end: '2020-08-31' },
];

const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const signed = (n: number) => `${n >= 0 ? '+' : '−'}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
const pnlColor = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-400');

const Info = ({ tip, className = '', children }: { tip: React.ReactNode; className?: string; children: React.ReactNode }) => (
  <Tooltip>
    <TooltipTrigger className={`cursor-help ${className}`}>{children}</TooltipTrigger>
    <TooltipContent>
      <span className="block max-w-xs text-xs leading-relaxed">{tip}</span>
    </TooltipContent>
  </Tooltip>
);

const TH = ({ children, align = 'left', tip }: { children: React.ReactNode; align?: 'left' | 'right'; tip?: React.ReactNode }) => (
  <th className={`text-xs font-bold text-white px-3 py-2 whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}>
    {tip ? (
      <Info tip={tip} className="font-bold text-white underline decoration-dotted decoration-zinc-500 underline-offset-2">
        {children}
      </Info>
    ) : children}
  </th>
);

const TD = ({ children, align = 'left', className = '', title }: { children: React.ReactNode; align?: 'left' | 'right'; className?: string; title?: string }) => (
  <td className={`px-3 py-2 whitespace-nowrap ${align === 'right' ? 'text-right tabular-nums' : ''} ${className}`} title={title}>
    {children}
  </td>
);

function StatTile({ label, value, sub, tone = 'neutral', tip }: {
  label: string; value: string; sub?: string; tone?: 'neutral' | 'good' | 'bad'; tip?: React.ReactNode;
}) {
  const valueColor = tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-red-400' : 'text-zinc-100';
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded px-3 py-2 min-w-[130px] flex-1">
      {tip ? (
        <Info tip={tip} className="text-xs text-zinc-500 uppercase tracking-wider underline decoration-dotted decoration-zinc-600 underline-offset-2">
          {label}
        </Info>
      ) : (
        <div className="text-xs text-zinc-500 uppercase tracking-wider">{label}</div>
      )}
      <div className={`text-lg font-bold tabular-nums ${valueColor}`}>{value}</div>
      {sub && <div className="text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

function MiniEquitySparkline({ snapshots, currentIdx, onSelectIdx, baseline }: {
  snapshots: DailySnapshot[]; currentIdx: number; onSelectIdx: (idx: number) => void;
  /** Starting capital: the zero line. Equity above it is a profit (green), below it a loss (red). */
  baseline: number;
}) {
  const uid = useId().replace(/:/g, '');
  if (snapshots.length < 2) return null;
  const equities = snapshots.map((s) => s.equity);
  const min = Math.min(...equities);
  const max = Math.max(...equities);
  // The scale always contains the zero line, even if equity never crosses it.
  const lo = Math.min(min, baseline);
  const hi = Math.max(max, baseline);
  const range = hi - lo || 1;
  const h = 48;
  const w = 400;
  const yOf = (eq: number) => h - ((eq - lo) / range) * (h - 10) - 5;
  const zeroY = yOf(baseline);

  const points = snapshots.map((s, i) => {
    const x = (i / (snapshots.length - 1)) * w;
    return `${x.toFixed(1)},${yOf(s.equity).toFixed(1)}`;
  }).join(' ');

  const currentX = (currentIdx / (snapshots.length - 1)) * w;
  const currentPnl = equities[currentIdx] - baseline;

  return (
    <div className="bg-zinc-900/80 border border-zinc-800 rounded p-2 flex flex-col gap-1 w-full max-w-md">
      <div className="flex items-center justify-between text-[11px] text-zinc-400">
        <span className="font-semibold uppercase tracking-wider">Equity Trajectory</span>
        <span className="font-mono text-zinc-300">
          Min {rupees(min)} · Max {rupees(max)}
        </span>
      </div>
      <div className="relative cursor-pointer" onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const targetIdx = Math.round(clickRatio * (snapshots.length - 1));
        onSelectIdx(targetIdx);
      }}>
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-12 overflow-visible">
          <defs>
            <clipPath id={`${uid}-above`}><rect x={-2} y={-h} width={w + 4} height={zeroY + h} /></clipPath>
            <clipPath id={`${uid}-below`}><rect x={-2} y={zeroY} width={w + 4} height={h * 2} /></clipPath>
          </defs>
          {/* Zero line = starting capital */}
          <line x1={0} y1={zeroY} x2={w} y2={zeroY} className="stroke-zinc-500" strokeWidth="1" strokeDasharray="4 3" />
          {/* Same polyline twice: green where it sits above the zero line, red where it sits below */}
          <polyline fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    clipPath={`url(#${uid}-above)`} points={points} />
          <polyline fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    clipPath={`url(#${uid}-below)`} points={points} />
          {/* Vertical cursor */}
          <line x1={currentX} y1={0} x2={currentX} y2={h} stroke="#38bdf8" strokeWidth="2" strokeDasharray="3 3" />
          <circle cx={currentX} cy={yOf(equities[currentIdx])} r="4" fill="#38bdf8" />
        </svg>
      </div>
      <div className="flex items-center justify-between text-[10px] text-zinc-500">
        <span>┄ Zero line = start {rupees(baseline)}</span>
        <span className={`font-mono ${currentPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {currentPnl >= 0 ? '+' : '−'}{rupees(Math.abs(currentPnl))} on this day
        </span>
      </div>
    </div>
  );
}

/** Compact label for a rejection reason (full text stays in the pill's tooltip). */
function shortReason(reason: string): string {
  let m: RegExpMatchArray | null;
  if (reason.startsWith('trend not stacked')) return 'Trend not stacked';
  if (reason.startsWith('200 SMA not rising')) return '200 SMA not rising';
  if (reason.startsWith('<25% above 52w low')) return '<25% off low';
  if (reason.startsWith('>20% below 52w high')) return '>20% off high';
  if ((m = reason.match(/^below (\d+)d pivot high/))) return `Below ${m[1]}d pivot`;
  if ((m = reason.match(/^extended (\d+)% above pivot/))) return `Extended +${m[1]}%`;
  if (reason.startsWith('volume <')) return 'Low volume';
  if ((m = reason.match(/^RS rank <(\d+) \((.+)\)/))) return `RS ${m[2]} (<${m[1]})`;
  if (reason.startsWith('insufficient history')) return 'Short history';
  return reason;
}

/** Stop distance each model used before it became a setting (mirrors default_stop_pct in simulate_momentum_replay.py). */
const defaultStopFor = (strategy: string) => (strategy === 'clenow' ? 15 : 12);

export default function MomentumSimulationReplay({
  initialCapital = 500000,
  initialSlots = 10,
  activeStrategy = 'minervini',
  onStrategyChange,
}: {
  initialCapital?: number;
  initialSlots?: number;
  activeStrategy?: string;
  onStrategyChange?: (s: string) => void;
}) {
  const [startDate, setStartDate] = useState('2026-10-15');
  const [endDate, setEndDate] = useState('2026-11-20');
  const [capital, setCapital] = useState(initialCapital);
  const [slots, setSlots] = useState(initialSlots);
  const [regimeEnabled, setRegimeEnabled] = useState(true);
  const [benchmark, setBenchmark] = useState<'nifty50' | 'nifty500'>('nifty50');
  const [regimeInterval, setRegimeInterval] = useState<'weekly' | 'daily'>('weekly');
  const [forceFresh, setForceFresh] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);
  const [strategy, setStrategy] = useState(activeStrategy);
  const [breakoutDays, setBreakoutDays] = useState<number>(() => {
    if (activeStrategy === 'minervini') return 20;
    if (activeStrategy === '52w_high') return 5;
    return 55;
  });

  const [stopPct, setStopPct] = useState<number>(() => defaultStopFor(activeStrategy));
  const [sectorCap, setSectorCap] = useState<number>(2);
  const [sectorDraft, setSectorDraft] = useState<string>('2');
  const [stopDraft, setStopDraft] = useState<string>(() => String(defaultStopFor(activeStrategy)));

  const [simData, setSimData] = useState<SimulationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [currentIdx, setCurrentIdx] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState<number>(1200); // ms per step

  // Only the newest request may touch the page. A fresh window takes 20+ s to compute, so an older request
  // can finish AFTER a newer, cached one and overwrite it with stale settings' results.
  const reqSeq = useRef(0);
  const reqAbort = useRef<AbortController | null>(null);
  useEffect(() => () => reqAbort.current?.abort(), []);

  const fetchSimulation = useCallback(async (
    start: string,
    end: string,
    cap: number,
    slt: number,
    strat: string = strategy,
    reg: boolean = regimeEnabled,
    bo: number = breakoutDays,
    sl: number = stopPct,
    bench: 'nifty50' | 'nifty500' = benchmark,
    interval: 'weekly' | 'daily' = regimeInterval,
    force: boolean = forceFresh,
    sc: number = sectorCap
  ) => {
    const myReq = ++reqSeq.current;
    reqAbort.current?.abort();
    const ac = new AbortController();
    reqAbort.current = ac;
    const isStale = () => myReq !== reqSeq.current;
    setLoading(true);
    setError(null);
    setIsPlaying(false);
    try {
      let json;
      if (force) {
        const res = await fetch(`/api/momentum/simulation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            start, end, capital: cap, slots: slt,
            strategy: strat, regime: reg, breakout_days: bo,
            stop_pct: sl, benchmark: bench, regime_interval: interval,
            force: true,
            sector_cap: sc,
          }),
          signal: ac.signal,
        });
        json = await res.json();
      } else {
        const qs = `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&capital=${cap}&slots=${slt}&strategy=${encodeURIComponent(strat)}&regime=${reg}&breakout_days=${bo}&stop_pct=${sl}&benchmark=${bench}&regime_interval=${interval}&sector_cap=${sc}`;
        const res = await fetch(`/api/momentum/simulation${qs}`, { signal: ac.signal });
        json = await res.json();
      }
      if (isStale()) return;
      if (!json.success) throw new Error(json.error || 'Failed to generate simulation replay');
      setSimData(json);
      setCurrentIdx(0);
    } catch (e) {
      if (isStale() || (e instanceof DOMException && e.name === 'AbortError')) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [strategy, regimeEnabled, breakoutDays, stopPct, benchmark, regimeInterval, forceFresh, sectorCap]);

  const handleClearCache = async () => {
    if (!window.confirm('Delete all cached simulation replay JSON files in debug/replays? Future runs will recompute fresh.')) return;
    setClearingCache(true);
    try {
      const res = await fetch('/api/momentum/simulation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear_cache' }),
      });
      const data = await res.json();
      setCacheNotice(data.message || 'Cached replays cleared successfully.');
      setTimeout(() => setCacheNotice(null), 5000);
      fetchSimulation(startDate, endDate, capital, slots, strategy, regimeEnabled, breakoutDays, stopPct, benchmark, regimeInterval, true);
    } catch (e) {
      setError('Failed to clear cache: ' + String(e));
    } finally {
      setClearingCache(false);
    }
  };

  useEffect(() => {
    const defaultBo = activeStrategy === 'minervini' ? 20 : activeStrategy === '52w_high' ? 5 : 55;
    fetchSimulation(startDate, endDate, capital, slots, activeStrategy, regimeEnabled, defaultBo, defaultStopFor(activeStrategy));
  }, []);

  useEffect(() => {
    if (activeStrategy && activeStrategy !== strategy) {
      setStrategy(activeStrategy);
      const newBo = activeStrategy === 'minervini' ? 20 : activeStrategy === '52w_high' ? 5 : 55;
      setBreakoutDays(newBo);
      const newSl = defaultStopFor(activeStrategy);
      setStopPct(newSl);
      setStopDraft(String(newSl));
      fetchSimulation(startDate, endDate, capital, slots, activeStrategy, regimeEnabled, newBo, newSl);
    }
  }, [activeStrategy]);

  // Playback loop
  useEffect(() => {
    if (!isPlaying || !simData?.snapshots.length) return;
    const timer = setInterval(() => {
      setCurrentIdx((prev) => {
        if (prev >= simData.snapshots.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, playSpeed);
    return () => clearInterval(timer);
  }, [isPlaying, simData, playSpeed]);

  // Free-typed value: commit on blur/Enter only, clamped to the range the route accepts.
  const commitStop = () => {
    const n = Number(stopDraft);
    if (!Number.isFinite(n) || n <= 0) {
      setStopDraft(String(stopPct));
      return;
    }
    const v = Math.round(Math.max(2, Math.min(30, n)) * 10) / 10;
    setStopDraft(String(v));
    if (v !== stopPct) {
      setStopPct(v);
      fetchSimulation(startDate, endDate, capital, slots, strategy, regimeEnabled, breakoutDays, v);
    }
  };

  // Same commit-on-blur rule as the stop-loss box. The cap is a whole number of positions per sector.
  const commitSector = () => {
    const n = Math.round(Number(sectorDraft));
    if (!Number.isFinite(n) || n < 1) {
      setSectorDraft(String(sectorCap));
      return;
    }
    const v = Math.min(10, n);
    setSectorDraft(String(v));
    if (v !== sectorCap) {
      setSectorCap(v);
      fetchSimulation(startDate, endDate, capital, slots, strategy, regimeEnabled, breakoutDays, stopPct, benchmark, regimeInterval, forceFresh, v);
    }
  };

  // The cap the shown replay was actually run with (not the box, which may be ahead of it while a run is in flight).
  const shownSectorCap = (simData?.config as { sector_cap?: number } | undefined)?.sector_cap ?? 2;

  const snapshots = simData?.snapshots || [];
  const currentSnapshot = snapshots[currentIdx] || null;

  // Step helpers
  const handlePrevDay = () => setCurrentIdx((i) => Math.max(0, i - 1));
  const handleNextDay = () => setCurrentIdx((i) => Math.min(snapshots.length - 1, i + 1));
  const handlePrevWeek = () => {
    for (let i = currentIdx - 1; i >= 0; i--) {
      if (snapshots[i].is_review_day) {
        setCurrentIdx(i);
        return;
      }
    }
    setCurrentIdx(0);
  };
  const handleNextWeek = () => {
    for (let i = currentIdx + 1; i < snapshots.length; i++) {
      if (snapshots[i].is_review_day) {
        setCurrentIdx(i);
        return;
      }
    }
    setCurrentIdx(snapshots.length - 1);
  };

  const sectorCounts = useMemo(() => {
    if (!currentSnapshot) return {};
    return currentSnapshot.holdings.reduce((acc: Record<string, number>, h) => {
      const sec = h.industry || 'Unknown';
      acc[sec] = (acc[sec] || 0) + 1;
      return acc;
    }, {});
  }, [currentSnapshot]);

  return (
    <div className="space-y-4">
      {/* Date Range Selector & Presets */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Calendar size={16} className="text-emerald-400" />
            <span className="text-xs font-bold text-zinc-200 uppercase tracking-wider">
              Simulation Date Range
            </span>
            <span className="text-xs text-zinc-500">(2019-06 to 2026-11 available)</span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {PRESETS.map((p) => {
              const active = startDate === p.start && endDate === p.end;
              return (
                <button
                  key={p.label}
                  onClick={() => {
                    setStartDate(p.start);
                    setEndDate(p.end);
                    fetchSimulation(p.start, p.end, capital, slots, strategy, regimeEnabled, breakoutDays, stopPct);
                  }}
                  className={`text-xs px-2.5 py-1 rounded border transition-colors cursor-pointer ${
                    active
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 font-bold'
                      : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-white hover:border-zinc-500'
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-zinc-800/80">
          {/* Strategy Model Selector */}
          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <span className="font-semibold text-zinc-300">Model:</span>
            <select
              value={strategy}
              onChange={(e) => {
                const newStrat = e.target.value;
                setStrategy(newStrat);
                let newBo = breakoutDays;
                if (newStrat === 'minervini') {
                  newBo = 20;
                } else if (newStrat === '52w_high') {
                  newBo = 55;
                } else if (newStrat === 'turtle_rs') {
                  newBo = 55;
                }
                setBreakoutDays(newBo);
                const newSl = defaultStopFor(newStrat);
                setStopPct(newSl);
                setStopDraft(String(newSl));
                onStrategyChange?.(newStrat);
                fetchSimulation(startDate, endDate, capital, slots, newStrat, regimeEnabled, newBo, newSl);
              }}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-xs font-semibold focus:outline-none focus:border-emerald-500 cursor-pointer"
            >
              <option value="minervini">Minervini Trend Template (+25.4% CAGR · 54.8% Win)</option>
              <option value="clenow">Clenow Smooth Momentum (+36.4% CAGR · 2.19 PF)</option>
              <option value="52w_high">52-Week High Breakout (+19.4% CAGR · 1.76 PF)</option>
              <option value="turtle_rs">Turtle Composite RS (+14.9% CAGR · -14.3% DD)</option>
            </select>
          </div>

          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span>From:</span>
            <input
              type="date"
              min="2019-06-01"
              max="2026-11-20"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-xs focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span>To:</span>
            <input
              type="date"
              min="2019-06-01"
              max="2026-11-20"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-xs focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span>Capital:</span>
            <input
              type="number"
              step={25000}
              value={capital}
              onChange={(e) => setCapital(Number(e.target.value) || 500000)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-xs w-28 focus:outline-none focus:border-emerald-500"
            />
          </div>

          {/* Benchmark Selector */}
          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <Info tip="Benchmark index used for Relative Strength (RS) scoring and Market Regime filter. Nifty 50 is the proven, lower-churn default (+200% return, PF 4.15 in 2020-23); Nifty 500 benchmarks against the broader 500-stock universe.">
              <span className="cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-2">
                Benchmark:
              </span>
            </Info>
            <select
              value={benchmark}
              onChange={(e) => {
                const b = e.target.value as 'nifty50' | 'nifty500';
                setBenchmark(b);
                fetchSimulation(startDate, endDate, capital, slots, strategy, regimeEnabled, breakoutDays, stopPct, b, regimeInterval, forceFresh);
              }}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-xs focus:outline-none focus:border-emerald-500 cursor-pointer"
            >
              <option value="nifty50">Nifty 50 (Proven Default)</option>
              <option value="nifty500">Nifty 500 (Broad Index)</option>
            </select>
          </div>

          {/* Regime Check Frequency Selector */}
          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <Info tip="Regime evaluation frequency. Weekly Check (evaluated on prior week's close vs 200 SMA) is the proven default that protects against intra-week noise and false breakdowns. Daily Check tests every day's close vs 200 SMA.">
              <span className="cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-2">
                Regime Check:
              </span>
            </Info>
            <select
              value={regimeInterval}
              onChange={(e) => {
                const ri = e.target.value as 'weekly' | 'daily';
                setRegimeInterval(ri);
                fetchSimulation(startDate, endDate, capital, slots, strategy, regimeEnabled, breakoutDays, stopPct, benchmark, ri, forceFresh);
              }}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-xs focus:outline-none focus:border-emerald-500 cursor-pointer"
            >
              <option value="weekly">Weekly (Prior Week Close · Proven)</option>
              <option value="daily">Daily (Daily Close)</option>
            </select>
          </div>

          {/* Regime Filter Toggle */}
          <label className="flex items-center gap-1.5 cursor-pointer text-xs select-none px-2 py-1 bg-zinc-800/60 border border-zinc-700 rounded hover:border-zinc-500 transition-colors">
            <input
              type="checkbox"
              checked={regimeEnabled}
              onChange={(e) => {
                const val = e.target.checked;
                setRegimeEnabled(val);
                fetchSimulation(startDate, endDate, capital, slots, strategy, val, breakoutDays, stopPct, benchmark, regimeInterval, forceFresh);
              }}
              className="rounded border-zinc-700 bg-zinc-800 text-emerald-500 focus:ring-0 cursor-pointer"
            />
            <Info tip={
              `Regime Filter: Halts new buys when ${benchmark === 'nifty50' ? 'Nifty 50' : 'Nifty 500'} trades below its ${regimeInterval} 200 SMA to prevent bear market drawdowns.`
            }>
              <span className={regimeEnabled ? 'text-zinc-200 font-medium cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-2' : 'text-zinc-400 cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-2'}>
                Regime Filter ({benchmark === 'nifty50' ? 'Nifty 50' : 'Nifty 500'} 200 SMA · {regimeInterval === 'weekly' ? 'Weekly' : 'Daily'})
              </span>
            </Info>
            <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${
              regimeEnabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'
            }`}>
              {regimeEnabled ? 'ON' : 'OFF'}
            </span>
          </label>

          {/* Dynamic Context-Aware Secondary Control */}
          {strategy === 'turtle_rs' && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
              <Info tip="Lookback period for Donchian Channel upper breakout. Standard 55-day, fast 20-day, or intermediate 30-day.">
                <span className="cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-2">
                  Donchian Breakout:
                </span>
              </Info>
              <select
                value={breakoutDays}
                onChange={(e) => {
                  const bo = Number(e.target.value);
                  setBreakoutDays(bo);
                  fetchSimulation(startDate, endDate, capital, slots, strategy, regimeEnabled, bo, stopPct);
                }}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-xs focus:outline-none focus:border-emerald-500 cursor-pointer"
              >
                <option value={55}>55 Days (Standard)</option>
                <option value={20}>20 Days (Fast)</option>
                <option value={30}>30 Days</option>
              </select>
            </div>
          )}

          {strategy === 'minervini' && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
              <Info tip="Mark Minervini's base pivot breakout lookback. 20-day high represents standard Stage 2 base consolidation; 10-day high represents tight VCP contraction.">
                <span className="cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-2">
                  Pivot Breakout:
                </span>
              </Info>
              <select
                value={breakoutDays}
                onChange={(e) => {
                  const bo = Number(e.target.value);
                  setBreakoutDays(bo);
                  fetchSimulation(startDate, endDate, capital, slots, strategy, regimeEnabled, bo, stopPct);
                }}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-xs focus:outline-none focus:border-emerald-500 cursor-pointer"
              >
                <option value={20}>20 Days (Stage 2 Base)</option>
                <option value={10}>10 Days (Tight VCP)</option>
              </select>
            </div>
          )}

          {strategy === '52w_high' && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
              <Info tip="George & Hwang 52-week high trigger. True Breakout enters on fresh 52-week highs (with 5% max extension); Proximity modes allow entering leaders within 5% or 10% of their 52W high.">
                <span className="cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-2">
                  52W Trigger:
                </span>
              </Info>
              <select
                value={breakoutDays}
                onChange={(e) => {
                  const bo = Number(e.target.value);
                  setBreakoutDays(bo);
                  fetchSimulation(startDate, endDate, capital, slots, strategy, regimeEnabled, bo, stopPct);
                }}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-xs focus:outline-none focus:border-emerald-500 cursor-pointer"
              >
                <option value={55}>True Breakout (New 52W High)</option>
                <option value={5}>Proximity (Within 5%)</option>
                <option value={10}>Proximity (Within 10%)</option>
              </select>
            </div>
          )}

          {strategy === 'clenow' && (
            <Info tip="Andreas Clenow 'Stocks on the Move' model: Ranks equities purely by annualized 90-day log-linear regression slope multiplied by R² (coefficient of determination). Breakout gates are bypassed.">
              <div className="px-2 py-1 bg-zinc-800/60 border border-zinc-700 rounded text-xs text-zinc-300 font-mono flex items-center gap-1.5 cursor-help">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span>Rank: 90D Exp Slope × R²</span>
              </div>
            </Info>
          )}

          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <Info tip="Initial stop-loss distance below the entry price, in %. The position is sold at the next open after a close below it. 12% is the default (Clenow 10%); the trailing rules of each model still apply on top. Applied when you press Enter or leave the box.">
              <span className="cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-2">
                Stop-loss:
              </span>
            </Info>
            <input
              type="number"
              inputMode="decimal"
              min={2}
              max={30}
              step={0.5}
              value={stopDraft}
              aria-label="Stop-loss percent"
              onChange={(e) => setStopDraft(e.target.value)}
              onBlur={commitStop}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-xs font-mono text-right focus:outline-none focus:border-emerald-500"
            />
            <span>%</span>
            {stopPct !== defaultStopFor(strategy) && (
              <button
                type="button"
                aria-label="Reset stop-loss to the model default"
                onClick={() => {
                  const d = defaultStopFor(strategy);
                  setStopPct(d);
                  setStopDraft(String(d));
                  fetchSimulation(startDate, endDate, capital, slots, strategy, regimeEnabled, breakoutDays, d);
                }}
                className="px-1.5 py-0.5 rounded border border-zinc-700 text-[10px] text-zinc-300 hover:border-emerald-500 cursor-pointer"
              >
                Reset
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <Info tip="Maximum open positions in the same sector (NSE industry). A new entry in a full sector is skipped and the next qualifying stock is taken. 2 is the default; 1 is the most diversified. Applied when you press Enter or leave the box.">
              <span className="cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-2">
                Max / sector:
              </span>
            </Info>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={10}
              step={1}
              value={sectorDraft}
              aria-label="Maximum positions per sector"
              onChange={(e) => setSectorDraft(e.target.value)}
              onBlur={commitSector}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className="w-12 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-xs font-mono text-right focus:outline-none focus:border-emerald-500"
            />
          </div>

          <label className="flex items-center gap-1.5 cursor-pointer text-xs select-none px-2 py-1 bg-zinc-800 border border-zinc-700 rounded hover:border-zinc-500 transition-colors">
            <input
              type="checkbox"
              checked={forceFresh}
              onChange={(e) => setForceFresh(e.target.checked)}
              className="rounded border-zinc-700 bg-zinc-800 text-emerald-500 focus:ring-0 cursor-pointer"
            />
            <span className="text-zinc-300">Force Fresh Re-run</span>
          </label>

          <button
            type="button"
            title="Delete all cached replay json files in debug/replays so they recompute with latest data"
            onClick={handleClearCache}
            disabled={clearingCache}
            className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-400 hover:text-red-400 rounded text-xs flex items-center gap-1 cursor-pointer transition-colors"
          >
            <Trash2 size={12} className={clearingCache ? 'animate-spin' : ''} />
            <span>Clear Cache</span>
          </button>

          <button
            onClick={() => fetchSimulation(startDate, endDate, capital, slots, strategy, regimeEnabled, breakoutDays, stopPct, benchmark, regimeInterval, forceFresh)}
            disabled={loading}
            className="ml-auto px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Simulating…' : 'Run Simulation'}
          </button>
        </div>
      </div>

      {cacheNotice && (
        <div className="bg-emerald-500/10 border border-emerald-500/40 rounded px-4 py-2 text-xs text-emerald-300 flex items-center gap-2">
          <CheckCircle2 size={14} />
          <span>{cacheNotice}</span>
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/40 rounded px-4 py-3 text-xs text-red-400 flex items-center gap-2">
          <AlertTriangle size={15} />
          <span>{error}</span>
        </div>
      )}

      {loading && !simData && (
        <div className="py-20 flex flex-col items-center justify-center gap-3">
          <RefreshCw size={24} className="animate-spin text-emerald-400" />
          <div className="text-xs text-zinc-400 uppercase tracking-widest font-semibold">
            Simulating day-by-day historical portfolio…
          </div>
        </div>
      )}

      {simData && currentSnapshot && (
        <>
          {/* Time-Travel Control Strip */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-4">
              {/* Day Milestone Banner */}
              <div className="flex items-center gap-3 flex-wrap">
                <div className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 flex items-center gap-2">
                  <Clock size={15} className="text-sky-400" />
                  <span className="text-sm font-bold text-white tabular-nums">
                    {currentSnapshot.date} ({currentSnapshot.day_name})
                  </span>
                  <span className="text-xs text-zinc-500">
                    Day {currentIdx + 1} of {snapshots.length}
                  </span>
                </div>

                <span className="px-2 py-1 rounded text-xs font-bold bg-zinc-800 text-zinc-200 border border-zinc-700 flex items-center gap-1.5">
                  <span className="text-emerald-400 font-mono text-[10px] uppercase">STRATEGY:</span>
                  <span>
                    {strategy === 'minervini'
                      ? 'Minervini Stage 2'
                      : strategy === '52w_high'
                      ? '52-Week High'
                      : strategy === 'clenow'
                      ? 'Clenow Smooth'
                      : 'Turtle RS'}
                  </span>
                </span>

                {currentSnapshot.is_review_day && (
                  <span className="px-2 py-1 rounded text-xs font-bold bg-sky-500/10 text-sky-400 border border-sky-500/40 flex items-center gap-1">
                    <Layers size={13} /> WEEKLY REVIEW
                  </span>
                )}

                {!regimeEnabled ? (
                  <Info tip={`Market Regime Filter is DISABLED. Trades are evaluated purely on individual stock relative strength and breakout, regardless of ${benchmark === 'nifty50' ? 'Nifty 50' : 'Nifty 500'} trend.`}>
                    <span className="px-2 py-1 rounded text-xs font-bold border bg-purple-500/10 text-purple-300 border-purple-500/40 flex items-center gap-1">
                      <ShieldCheck size={13} /> REGIME FILTER: OFF (All Trades Allowed)
                    </span>
                  </Info>
                ) : currentSnapshot.regime_on ? (
                  <Info tip={`Market Regime is ON. ${benchmark === 'nifty50' ? 'Nifty 50' : 'Nifty 500'} is trading above its ${regimeInterval} 200 SMA — buying and rebalancing allowed.`}>
                    <span className="px-2 py-1 rounded text-xs font-bold border bg-emerald-500/10 text-emerald-400 border-emerald-500/40 flex items-center gap-1">
                      <ShieldCheck size={13} /> REGIME: BULL (ON)
                    </span>
                  </Info>
                ) : (
                  <Info tip={`Market Regime is OFF. ${benchmark === 'nifty50' ? 'Nifty 50' : 'Nifty 500'} is below its ${regimeInterval} 200 SMA. The strategy sits in 100% cash to protect capital from market drawdown. No new buys are taken.`}>
                    <span className="px-2 py-1 rounded text-xs font-bold border bg-red-500/10 text-red-400 border-red-500/40 flex items-center gap-1">
                      <AlertTriangle size={13} /> REGIME: BEAR (OFF — 100% Cash)
                    </span>
                  </Info>
                )}

                {currentSnapshot.executions_today.length > 0 && (
                  <span className="px-2 py-1 rounded text-xs font-bold bg-amber-500/10 text-amber-300 border border-amber-500/40 flex items-center gap-1">
                    <CheckCircle2 size={13} /> {currentSnapshot.executions_today.length} Trades Executed
                  </span>
                )}
              </div>

              {/* Mini Sparkline Chart */}
              <MiniEquitySparkline
                baseline={simData?.config?.capital ?? simData?.initial_capital ?? snapshots[0]?.equity ?? 0}
                snapshots={snapshots}
                currentIdx={currentIdx}
                onSelectIdx={(idx) => setCurrentIdx(idx)}
              />
            </div>

            {/* Scrubber slider and controls */}
            <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-zinc-800">
              <div className="flex items-center gap-1">
                <button
                  onClick={handlePrevWeek}
                  disabled={currentIdx === 0}
                  className="p-1.5 rounded bg-zinc-800 border border-zinc-700 hover:border-zinc-500 text-zinc-300 disabled:opacity-30 cursor-pointer"
                  title="Jump to Previous Review (Monday)"
                >
                  <SkipBack size={13} />
                </button>
                <button
                  onClick={handlePrevDay}
                  disabled={currentIdx === 0}
                  className="p-1.5 rounded bg-zinc-800 border border-zinc-700 hover:border-zinc-500 text-zinc-300 disabled:opacity-30 cursor-pointer"
                  title="Previous Day"
                >
                  <ChevronLeft size={14} />
                </button>
                <button
                  onClick={() => setIsPlaying((p) => !p)}
                  className={`px-3 py-1.5 rounded text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-colors ${
                    isPlaying
                      ? 'bg-amber-500 text-black hover:bg-amber-400'
                      : 'bg-emerald-600 text-white hover:bg-emerald-500'
                  }`}
                  title={isPlaying ? 'Pause auto-play' : 'Play day-by-day playback'}
                >
                  {isPlaying ? <Pause size={13} /> : <Play size={13} />}
                  <span>{isPlaying ? 'Pause' : 'Play'}</span>
                </button>
                <button
                  onClick={handleNextDay}
                  disabled={currentIdx === snapshots.length - 1}
                  className="p-1.5 rounded bg-zinc-800 border border-zinc-700 hover:border-zinc-500 text-zinc-300 disabled:opacity-30 cursor-pointer"
                  title="Next Day"
                >
                  <ChevronRight size={14} />
                </button>
                <button
                  onClick={handleNextWeek}
                  disabled={currentIdx === snapshots.length - 1}
                  className="p-1.5 rounded bg-zinc-800 border border-zinc-700 hover:border-zinc-500 text-zinc-300 disabled:opacity-30 cursor-pointer"
                  title="Jump to Next Review (Monday)"
                >
                  <SkipForward size={13} />
                </button>
              </div>

              {/* Slider Scrubber */}
              <div className="flex-1 min-w-[200px] flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={snapshots.length - 1}
                  value={currentIdx}
                  onChange={(e) => setCurrentIdx(Number(e.target.value))}
                  className="w-full accent-emerald-500 h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>

              <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                <span>Speed:</span>
                <select
                  value={playSpeed}
                  onChange={(e) => setPlaySpeed(Number(e.target.value))}
                  className="bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs rounded px-1.5 py-0.5 focus:outline-none"
                >
                  <option value={1800}>0.7x</option>
                  <option value={1200}>1x</option>
                  <option value={600}>2x</option>
                  <option value={300}>4x</option>
                </select>
              </div>
            </div>
          </div>

          {/* Today's Executions Activity Box */}
          {currentSnapshot.executions_today.length > 0 ? (
            <div className="bg-zinc-900 border border-emerald-500/30 rounded-lg p-3">
              <div className="text-xs font-bold text-emerald-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <CheckCircle2 size={14} /> Orders Filled Today ({currentSnapshot.executions_today.length})
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-zinc-300">
                  <thead className="bg-zinc-800">
                    <tr>
                      <TH>Action</TH>
                      <TH>Symbol</TH>
                      <TH align="right">Qty</TH>
                      <TH align="right">Fill Price</TH>
                      <TH align="right">Amount</TH>
                      <TH align="right">P&L</TH>
                      <TH>Trigger Reason</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {currentSnapshot.executions_today.map((ex, i) => (
                      <tr key={`${ex.symbol}-${i}`} className="border-t border-zinc-800">
                        <TD>
                          <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${
                            ex.action === 'BUY'
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                              : 'bg-red-500/10 text-red-400 border border-red-500/30'
                          }`}>
                            {ex.action}
                          </span>
                        </TD>
                        <TD className="font-bold text-white">{ex.symbol}</TD>
                        <TD align="right">{ex.qty}</TD>
                        <TD align="right">{ex.price.toFixed(2)}</TD>
                        <TD align="right">{rupees(ex.amount)}</TD>
                        <TD align="right" className={ex.pnl ? pnlColor(ex.pnl) : 'text-zinc-500'}>
                          {ex.pnl ? signed(ex.pnl) : '—'}
                          {ex.pnl_pct !== undefined && ex.pnl_pct !== 0 ? ` (${ex.pnl_pct > 0 ? '+' : ''}${ex.pnl_pct.toFixed(1)}%)` : ''}
                        </TD>
                        <TD className="text-zinc-400">{ex.reason}</TD>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="bg-zinc-900/60 border border-zinc-800 rounded px-3 py-2 text-xs text-zinc-500 flex items-center justify-between">
              <span>No trade executions on this day. Held positions were monitored against stop loss and trailing ratchet floors.</span>
              <span className="text-zinc-400 font-mono">Day change: <b className={pnlColor(currentSnapshot.day_pnl)}>{signed(currentSnapshot.day_pnl)}</b></span>
            </div>
          )}

          {/* StatTiles as of Day D */}
          <div className="flex flex-wrap gap-2">
            <StatTile label="Equity" value={rupees(currentSnapshot.equity)} sub={`from ${rupees(simData.initial_capital)}`} />
            <StatTile label="Total P&L" value={signed(currentSnapshot.total_pnl)} sub={`${currentSnapshot.total_pnl_pct >= 0 ? '+' : ''}${currentSnapshot.total_pnl_pct.toFixed(2)}%`} tone={currentSnapshot.total_pnl >= 0 ? 'good' : 'bad'} />
            <StatTile label="Realized" value={signed(currentSnapshot.realized_pnl)} tone={currentSnapshot.realized_pnl >= 0 ? 'good' : 'bad'} />
            <StatTile label="Unrealised" value={signed(currentSnapshot.unrealised_pnl)} tone={currentSnapshot.unrealised_pnl >= 0 ? 'good' : 'bad'} />
            <StatTile label="Deployed" value={`${currentSnapshot.deployed_pct.toFixed(0)}%`} sub={`${currentSnapshot.active_slots}/${currentSnapshot.slots} slots · cash ${rupees(currentSnapshot.cash)}`} />
            <StatTile label="Day P&L" value={signed(currentSnapshot.day_pnl)} tone={currentSnapshot.day_pnl >= 0 ? 'good' : 'bad'} sub="session mark-to-market" />
          </div>

          {/* Sector Diversification Strip as of Day D */}
          {currentSnapshot.holdings.length > 0 && (
            <div className="bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs">
              <div className="text-zinc-500 font-bold uppercase tracking-wider mb-2 flex items-center justify-between">
                <span>Sector Diversification on {currentSnapshot.date} (Max {shownSectorCap} position{shownSectorCap === 1 ? '' : 's'}/sector)</span>
                <span className="text-zinc-400 font-normal">{Object.keys(sectorCounts).length} active sectors</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(sectorCounts).map(([sec, count]) => {
                  const isMax = count >= shownSectorCap;
                  return (
                    <div
                      key={sec}
                      className={`px-2 py-1 rounded border flex items-center gap-1.5 ${
                        isMax ? 'bg-amber-500/10 border-amber-500/30 text-amber-300' : 'bg-zinc-800/80 border-zinc-700 text-zinc-300'
                      }`}
                    >
                      <span>{sec}</span>
                      <span className={`px-1 rounded text-[10px] font-bold ${
                        isMax ? 'bg-amber-500/20 text-amber-200' : 'bg-zinc-700 text-zinc-200'
                      }`}>
                        {count}/{shownSectorCap}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Holdings as of Day D */}
          <div>
            <div className="text-xs font-bold text-zinc-300 uppercase tracking-wider mb-2 flex items-center justify-between">
              <span>Holdings as of {currentSnapshot.date} ({currentSnapshot.holdings.length}/{currentSnapshot.slots} slots)</span>
              {currentSnapshot.holdings.length > 0 && (
                <span className="text-zinc-500 font-normal">
                  Total Invested: <b className="text-zinc-300">{rupees(currentSnapshot.invested)}</b>
                </span>
              )}
            </div>
            <div className="overflow-x-auto border border-zinc-800 rounded">
              <table className="w-full text-xs text-zinc-300">
                <thead className="bg-zinc-800">
                  <tr>
                    <TH>Symbol</TH>
                    <TH tip="Sector group">Sector</TH>
                    <TH align="right" tip="Current rank / rank at entry">Rank</TH>
                    <TH align="right">Qty</TH>
                    <TH align="right">Entry</TH>
                    <TH align="right">LTP</TH>
                    <TH align="right">Value</TH>
                    <TH align="right">Weight</TH>
                    <TH align="right">P&L</TH>
                    <TH align="right">P&L %</TH>
                    <TH align="right" tip="Stop price on this date. Ratchets upwards only.">Stop</TH>
                    <TH tip="Exit ladder stage: hard stop -> breakeven -> trailing">Stage</TH>
                    <TH align="right">Room to stop</TH>
                    <TH align="right">Days</TH>
                  </tr>
                </thead>
                <tbody>
                  {currentSnapshot.holdings.length === 0 && (
                    <tr>
                      <td colSpan={14} className="px-3 py-6 text-center text-zinc-400">
                        <div className="flex flex-col items-center justify-center gap-2 max-w-md mx-auto py-2">
                          <div className="flex items-center gap-2 font-semibold text-zinc-300">
                            {regimeEnabled && !currentSnapshot.regime_on ? (
                              <>
                                <AlertTriangle size={16} className="text-red-400" />
                                <span>100% in Cash — Market Regime Gate is OFF</span>
                              </>
                            ) : (
                              <span>No open positions on this date — 100% in cash.</span>
                            )}
                          </div>
                          {regimeEnabled && !currentSnapshot.regime_on ? (
                            <>
                              <p className="text-xs text-zinc-500 leading-relaxed">
                                {benchmark === 'nifty50' ? 'Nifty 50' : 'Nifty 500'} was trading below its {regimeInterval} 200 SMA on this date. By design, all new entries are halted to preserve capital during market downtrends.
                              </p>
                              <button
                                onClick={() => {
                                  setRegimeEnabled(false);
                                  fetchSimulation(startDate, endDate, capital, slots, strategy, false, breakoutDays);
                                }}
                                className="mt-1 px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs text-zinc-300 hover:text-white transition-colors cursor-pointer"
                              >
                                Simulate Without Regime Filter (Trade Through Downtrend)
                              </button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  )}
                  {currentSnapshot.holdings.map((h) => (
                    <tr key={h.symbol} className="border-t border-zinc-800 hover:bg-zinc-900">
                      <TD className="font-bold text-zinc-100">{h.symbol}</TD>
                      <TD className="text-zinc-500">{h.industry}</TD>
                      <TD align="right">
                        <span className={h.rank_strikes > 0 ? 'text-amber-400' : 'text-zinc-400'}>
                          {h.rank ?? '—'}
                        </span>
                        <span className="text-zinc-600"> / {h.rank_at_entry}</span>
                      </TD>
                      <TD align="right">{h.qty}</TD>
                      <TD align="right">{h.entry_price.toFixed(2)}</TD>
                      <TD align="right" className="text-zinc-100">{h.ltp.toFixed(2)}</TD>
                      <TD align="right" className="text-zinc-200">{rupees(h.value)}</TD>
                      <TD align="right" className="text-zinc-400">{h.weight_pct.toFixed(1)}%</TD>
                      <TD align="right" className={pnlColor(h.unrealised)}>{signed(h.unrealised)}</TD>
                      <TD align="right" className={pnlColor(h.unrealised_pct)}>
                        {h.unrealised_pct >= 0 ? '+' : ''}{h.unrealised_pct.toFixed(2)}%
                      </TD>
                      <TD align="right">{h.stop_price.toFixed(2)}</TD>
                      <TD>
                        <span className={`px-1.5 py-0.5 rounded text-xs ${
                          h.stage === 'trailing'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : h.stage === 'breakeven'
                            ? 'bg-sky-500/10 text-sky-400'
                            : 'bg-zinc-800 text-zinc-400'
                        }`}>
                          {h.stage}
                        </span>
                      </TD>
                      <TD align="right">
                        <div className="flex items-center gap-2 justify-end">
                          <span className="text-zinc-400 tabular-nums">{h.room_to_stop_pct.toFixed(1)}%</span>
                          <div className="w-14 h-1.5 bg-zinc-800 rounded overflow-hidden">
                            <div
                              className={`h-full ${
                                h.room_to_stop_pct < 5 ? 'bg-red-500' : h.room_to_stop_pct < 12 ? 'bg-amber-500' : 'bg-emerald-500'
                              }`}
                              style={{ width: `${Math.min(h.room_to_stop_pct * 4, 100)}%` }}
                            />
                          </div>
                        </div>
                      </TD>
                      <TD align="right" className="text-zinc-400">{h.hold_days}</TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Top 25 Rankings on Day D */}
            <div>
              <div className="text-xs font-bold text-zinc-300 uppercase tracking-wider mb-2">
                Top 25 Relative Strength Rankings on {currentSnapshot.date}
              </div>
              <div className="overflow-x-auto border border-zinc-800 rounded max-h-96 overflow-y-auto">
                <table className="w-full text-xs text-zinc-300">
                  <thead className="bg-zinc-800 sticky top-0">
                    <tr>
                      <TH align="right">#</TH>
                      <TH>Symbol</TH>
                      <TH>Sector</TH>
                      <TH align="right">RS</TH>
                      <TH>Status</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {currentSnapshot.top_ranks.length === 0 && (
                      <tr><td colSpan={5} className="px-3 py-6 text-center text-zinc-500">No rankings data</td></tr>
                    )}
                    {currentSnapshot.top_ranks.map((r, i) => {
                      const held = currentSnapshot.holdings.some((h) => h.symbol === r.symbol);
                      return (
                        <tr key={r.symbol} className="border-t border-zinc-800 hover:bg-zinc-900">
                          <TD align="right" className="text-zinc-500">{i + 1}</TD>
                          <TD className={held ? 'font-bold text-emerald-400' : 'text-zinc-100'}>{r.symbol}</TD>
                          <TD className="text-zinc-500 text-xs truncate max-w-[120px]" title={r.industry}>
                            {r.industry || '—'}
                          </TD>
                          <TD align="right" className={r.rs >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                            {r.rs >= 0 ? '+' : ''}{r.rs.toFixed(4)}
                          </TD>
                          <TD>
                            {r.status === 'HELD' || held ? (
                              <span className="px-1.5 py-0.5 rounded text-xs bg-emerald-500/10 text-emerald-400 font-bold inline-flex items-center gap-1">
                                ● HELD
                              </span>
                            ) : r.status === 'QUALIFIED' ? (
                              <span className="px-1.5 py-0.5 rounded text-xs bg-sky-500/10 text-sky-400 font-bold">
                                QUALIFIED
                              </span>
                            ) : r.status.startsWith('Cooldown') ? (
                              <span className="px-1.5 py-0.5 rounded text-xs bg-amber-500/10 text-amber-400">
                                {r.status}
                              </span>
                            ) : (
                              <div className="flex flex-wrap gap-1" title={r.status}>
                                {r.status.split(' · ').map((reason) => (
                                  <span
                                    key={reason}
                                    title={reason}
                                    className="px-1.5 py-0.5 rounded-full text-[11px] leading-none bg-zinc-800 border border-zinc-700 text-zinc-300 whitespace-nowrap"
                                  >
                                    {shortReason(reason)}
                                  </span>
                                ))}
                              </div>
                            )}
                          </TD>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Closed Trades up to Day D */}
            <div>
              <div className="text-xs font-bold text-zinc-300 uppercase tracking-wider mb-2">
                Closed Trades up to {currentSnapshot.date} ({currentSnapshot.closed_trades.length})
              </div>
              <div className="overflow-x-auto border border-zinc-800 rounded max-h-96 overflow-y-auto">
                <table className="w-full text-xs text-zinc-300">
                  <thead className="bg-zinc-800 sticky top-0">
                    <tr>
                      <TH>Symbol</TH>
                      <TH>Exit Date</TH>
                      <TH align="right">P&L</TH>
                      <TH align="right">%</TH>
                      <TH>Reason</TH>
                      <TH align="right">Days</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {currentSnapshot.closed_trades.length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-6 text-center text-zinc-500">No closed trades yet</td></tr>
                    )}
                    {[...currentSnapshot.closed_trades].reverse().map((t, i) => (
                      <tr key={`${t.symbol}-${t.exit_date}-${i}`} className="border-t border-zinc-800 hover:bg-zinc-900">
                        <TD className="font-bold text-zinc-100">{t.symbol}</TD>
                        <TD className="text-zinc-500">{t.exit_date}</TD>
                        <TD align="right" className={pnlColor(t.pnl)}>{signed(t.pnl)}</TD>
                        <TD align="right" className={pnlColor(t.pnl_pct)}>
                          <span className="inline-flex items-center gap-1">
                            {t.pnl_pct >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                            {t.pnl_pct >= 0 ? '+' : ''}{t.pnl_pct.toFixed(2)}%
                          </span>
                        </TD>
                        <TD><span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">{t.exit_reason}</span></TD>
                        <TD align="right" className="text-zinc-400">{t.hold_days}</TD>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
