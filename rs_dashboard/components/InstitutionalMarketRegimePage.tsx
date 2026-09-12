'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Calendar,
  CheckCircle2,
  ChevronRight,
  Clock,
  Compass,
  ExternalLink,
  Flame,
  HelpCircle,
  Info,
  Layers,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Zap,
} from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  Area,
} from 'recharts';
import type { MarketRegimeAnalysis, DistributionDay } from '@/lib/marketRegime';
import NavBar from './NavBar';

interface ApiResponse {
  selected: MarketRegimeAnalysis;
  nifty50: {
    status: string;
    statusLabel: string;
    tone: string;
    activeCount: number;
    price: number;
    change1D: number;
  };
  nifty500: {
    status: string;
    statusLabel: string;
    tone: string;
    activeCount: number;
    price: number;
    change1D: number;
  };
  dataDate: string;
}

const LOOKBACK_OPTIONS = [
  { label: '3M', value: 65 },
  { label: '6M', value: 125 },
  { label: '1Y', value: 250 },
  { label: '2Y', value: 500 },
];

export default function InstitutionalMarketRegimePage() {
  const [selectedIndex, setSelectedIndex] = useState<'NIFTY50' | 'NIFTY500'>('NIFTY500');
  const [lookback, setLookback] = useState<number>(250);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDistDay, setSelectedDistDay] = useState<DistributionDay | null>(null);

  const fetchData = useCallback(
    async (force = false) => {
      setLoading(true);
      setError(null);
      try {
        const url = `/api/market-regime?index=${selectedIndex}&lookback=${lookback}${force ? '&refresh=true' : ''}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as ApiResponse;
        setData(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch market regime data');
      } finally {
        setLoading(false);
      }
    },
    [selectedIndex, lookback]
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const reg = data?.selected;

  // Visual tones
  const isCorrection = reg?.status === 'IN_CORRECTION';
  const isPressure = reg?.status === 'UPTREND_UNDER_PRESSURE';
  const isUptrend = reg?.status === 'CONFIRMED_UPTREND';
  const isRally = reg?.status === 'RALLY_ATTEMPT';

  const toneBorder = isCorrection
    ? 'border-red-500/40 bg-red-950/20'
    : isPressure
      ? 'border-amber-500/40 bg-amber-950/20'
      : isRally
        ? 'border-sky-500/40 bg-sky-950/20'
        : 'border-emerald-500/40 bg-emerald-950/20';

  const toneText = isCorrection
    ? 'text-red-400'
    : isPressure
      ? 'text-amber-400'
      : isRally
        ? 'text-sky-400'
        : 'text-emerald-400';

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-zinc-100 selection:bg-emerald-500/30">
      {/* Sticky Header (Quant-Terminal style) */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-4 px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center justify-center w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700 transition-colors"
            title="Return to Terminal Home"
          >
            <Compass className="w-4 h-4 text-amber-400" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-amber-400">
                CANSLIM · INSTITUTIONAL TIMING
              </span>
              {data?.dataDate && (
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
                  DATA: {data.dataDate}
                </span>
              )}
            </div>
            <h1 className="text-sm font-bold text-white tracking-tight flex items-center gap-2">
              Market Regime &amp; Distribution Days
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-400 font-medium">
                O&apos;Neil Institutional Framework
              </span>
            </h1>
          </div>
        </div>

        {/* Index Selector & Period Controls */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-1 rounded-lg">
            <button
              onClick={() => setSelectedIndex('NIFTY500')}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${
                selectedIndex === 'NIFTY500'
                  ? 'bg-zinc-800 text-white shadow-sm border border-zinc-700'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Nifty 500 (Broad)
            </button>
            <button
              onClick={() => setSelectedIndex('NIFTY50')}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${
                selectedIndex === 'NIFTY50'
                  ? 'bg-zinc-800 text-white shadow-sm border border-zinc-700'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Nifty 50 (Large)
            </button>
          </div>

          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-1 rounded-lg">
            {LOOKBACK_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                onClick={() => setLookback(opt.value)}
                className={`px-2 py-0.5 text-xs font-mono rounded-md transition-all ${
                  lookback === opt.value
                    ? 'bg-zinc-800 text-emerald-400 font-bold border border-zinc-700'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            onClick={() => fetchData(true)}
            disabled={loading}
            className="p-1.5 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white hover:border-zinc-700 disabled:opacity-50 transition-colors"
            title="Force recalculate and sync"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-emerald-400' : ''}`} />
          </button>

          <NavBar />
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 px-6 py-5 flex flex-col gap-5 max-w-[1600px] mx-auto w-full">
        {error && (
          <div className="p-3.5 rounded-xl border border-red-800/60 bg-red-950/40 text-red-300 text-xs flex items-center gap-2">
            <AlertOctagon className="w-4 h-4 text-red-400 shrink-0" />
            <span>Failed to load regime data: {error}</span>
          </div>
        )}

        {/* ─── Hero Regime Status Card ────────────────────────────────────────── */}
        <section className={`rounded-2xl border p-5 transition-all shadow-lg ${toneBorder}`}>
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
            {/* Left: Giant Verdict Badge */}
            <div className="flex items-start gap-4">
              <div
                className={`w-14 h-14 rounded-2xl flex items-center justify-center shrink-0 border ${
                  isCorrection
                    ? 'bg-red-500/20 border-red-500/40 text-red-400'
                    : isPressure
                      ? 'bg-amber-500/20 border-amber-500/40 text-amber-400'
                      : isRally
                        ? 'bg-sky-500/20 border-sky-500/40 text-sky-400'
                        : 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400'
                }`}
              >
                {isCorrection ? (
                  <ShieldAlert className="w-7 h-7" />
                ) : isPressure ? (
                  <AlertTriangle className="w-7 h-7" />
                ) : isRally ? (
                  <Flame className="w-7 h-7" />
                ) : (
                  <ShieldCheck className="w-7 h-7" />
                )}
              </div>

              <div>
                <div className="flex items-center gap-2.5">
                  <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-400">
                    MARKET REGIME VERDICT · {reg?.indexLabel}
                  </span>
                  <span
                    className={`text-[9px] font-bold uppercase px-2 py-0.5 rounded-full border ${
                      isCorrection
                        ? 'bg-red-500/20 text-red-300 border-red-500/40'
                        : isPressure
                          ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                          : isRally
                            ? 'bg-sky-500/20 text-sky-300 border-sky-500/40'
                            : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                    }`}
                  >
                    {isCorrection ? 'RISK-OFF' : isPressure ? 'DEFENSIVE' : isRally ? 'WATCHFUL' : 'RISK-ON'}
                  </span>
                </div>

                <h2 className={`text-2xl font-black tracking-tight leading-tight mt-0.5 ${toneText}`}>
                  {reg?.statusLabel || 'Calculating…'}
                </h2>

                <p className="text-xs text-zinc-300 mt-1 max-w-2xl leading-relaxed font-normal">
                  {reg?.description}
                </p>
              </div>
            </div>

            {/* Right: Distribution Days Meter */}
            <div className="flex items-center gap-5 shrink-0 bg-zinc-950/80 border border-zinc-800/80 rounded-xl p-3.5 font-mono">
              <div className="flex flex-col">
                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                  Active Dist. Days (25D)
                </span>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span
                    className={`text-3xl font-black tabular-nums ${
                      (reg?.activeDistributionCount ?? 0) >= 6
                        ? 'text-red-400'
                        : (reg?.activeDistributionCount ?? 0) >= 4
                          ? 'text-amber-400'
                          : 'text-emerald-400'
                    }`}
                  >
                    {reg?.activeDistributionCount ?? 0}
                  </span>
                  <span className="text-xs text-zinc-500">/ 25 Sessions</span>
                </div>
                <span className="text-[10px] text-zinc-400 mt-1">
                  Thresholds: 0–3 Bullish, 4–5 Warning, 6+ Bear
                </span>
              </div>

              <div className="w-px h-12 bg-zinc-800" />

              <div className="flex flex-col">
                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                  Index Close &amp; 1D%
                </span>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span className="text-lg font-bold text-white tabular-nums">
                    ₹{reg?.currentPrice?.toLocaleString('en-IN') ?? '—'}
                  </span>
                  <span
                    className={`text-xs font-bold ${
                      (reg?.change1D ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    {(reg?.change1D ?? 0) >= 0 ? '+' : ''}
                    {reg?.change1D?.toFixed(2)}%
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-zinc-400 mt-1">
                  <span>SMA50: ₹{reg?.sma50?.toFixed(0)}</span>
                  <span>·</span>
                  <span>SMA200: ₹{reg?.sma200?.toFixed(0)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Actionable Investor Playbook Matrix */}
          {reg?.investorPlaybook && (
            <div className="mt-4 pt-4 border-t border-zinc-800/80 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-3">
                <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                  RECOMMENDED POSTURE
                </div>
                <div className={`text-xs font-bold mt-1 ${toneText}`}>
                  {reg.investorPlaybook.posture}
                </div>
              </div>

              <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-3">
                <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                  POSITION SIZING DISCIPLINE
                </div>
                <div className="text-xs font-bold text-zinc-100 mt-1">
                  {reg.investorPlaybook.positionSizing}
                </div>
              </div>

              <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-3">
                <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                  STOP-LOSS &amp; PROFIT POLICY
                </div>
                <div className="text-xs font-semibold text-zinc-200 mt-1">
                  {reg.investorPlaybook.stopLossPolicy}
                </div>
              </div>

              <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-3">
                <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                  BREAKOUT BUYING RULES
                </div>
                <div className="text-xs font-semibold text-zinc-200 mt-1">
                  {reg.investorPlaybook.breakoutDiscipline}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* ─── Dual Index At-a-Glance Strip ─────────────────────────────────── */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div
            onClick={() => setSelectedIndex('NIFTY50')}
            className={`p-4 rounded-xl border cursor-pointer transition-all ${
              selectedIndex === 'NIFTY50'
                ? 'bg-zinc-900/90 border-emerald-500/50 shadow-md ring-1 ring-emerald-500/30'
                : 'bg-zinc-900/40 border-zinc-800 hover:border-zinc-700'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-zinc-300">NIFTY 50 INDEX</span>
              <span
                className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                  data?.nifty50.status === 'IN_CORRECTION'
                    ? 'bg-red-500/20 text-red-400'
                    : data?.nifty50.status === 'UPTREND_UNDER_PRESSURE'
                      ? 'bg-amber-500/20 text-amber-400'
                      : 'bg-emerald-500/20 text-emerald-400'
                }`}
              >
                {data?.nifty50.statusLabel || '—'}
              </span>
            </div>
            <div className="flex items-baseline justify-between mt-2 font-mono">
              <span className="text-lg font-bold text-white">
                ₹{data?.nifty50.price?.toLocaleString('en-IN') ?? '—'}
              </span>
              <span className="text-xs text-zinc-400">
                {data?.nifty50.activeCount ?? 0} Distribution Days
              </span>
            </div>
          </div>

          <div
            onClick={() => setSelectedIndex('NIFTY500')}
            className={`p-4 rounded-xl border cursor-pointer transition-all ${
              selectedIndex === 'NIFTY500'
                ? 'bg-zinc-900/90 border-emerald-500/50 shadow-md ring-1 ring-emerald-500/30'
                : 'bg-zinc-900/40 border-zinc-800 hover:border-zinc-700'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-zinc-300">NIFTY 500 INDEX (BROAD UNIVERSE)</span>
              <span
                className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                  data?.nifty500.status === 'IN_CORRECTION'
                    ? 'bg-red-500/20 text-red-400'
                    : data?.nifty500.status === 'UPTREND_UNDER_PRESSURE'
                      ? 'bg-amber-500/20 text-amber-400'
                      : 'bg-emerald-500/20 text-emerald-400'
                }`}
              >
                {data?.nifty500.statusLabel || '—'}
              </span>
            </div>
            <div className="flex items-baseline justify-between mt-2 font-mono">
              <span className="text-lg font-bold text-white">
                ₹{data?.nifty500.price?.toLocaleString('en-IN') ?? '—'}
              </span>
              <span className="text-xs text-zinc-400">
                {data?.nifty500.activeCount ?? 0} Distribution Days
              </span>
            </div>
          </div>
        </section>

        {/* ─── Main Charts Panel ────────────────────────────────────────────── */}
        <section className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h3 className="text-sm font-bold text-white">
                Institutional Distribution Days &amp; Index Price Action
              </h3>
              <p className="text-[11px] text-zinc-500">
                Distribution Days highlighted in red (<span className="text-red-400">●</span>) with volume surge. Follow-Through Days in green (<span className="text-emerald-400">★</span>).
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs font-mono">
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" />
                <span className="text-zinc-400">Distribution Day (Drop ≥ 0.20% on Vol)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-amber-400 inline-block" />
                <span className="text-zinc-400">SMA 50</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-indigo-400 inline-block" />
                <span className="text-zinc-400">SMA 200</span>
              </div>
            </div>
          </div>

          {/* Chart 1: Price + Moving Averages + Distribution Markers */}
          <div className="h-[360px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={reg?.history || []}
                margin={{ top: 10, right: 10, left: 10, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 6" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  minTickGap={40}
                />
                <YAxis
                  domain={['auto', 'auto']}
                  orientation="right"
                  tickLine={false}
                  tickFormatter={(v) => v.toFixed(0)}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload || !payload.length) return null;
                    const item = payload[0].payload;
                    return (
                      <div className="bg-zinc-950/98 border border-zinc-700 rounded-xl px-3.5 py-2.5 text-xs shadow-2xl backdrop-blur font-mono">
                        <div className="font-bold text-white mb-1">{item.date}</div>
                        <div className="flex justify-between gap-4 text-zinc-300">
                          <span>Close:</span>
                          <span className="font-bold text-white">₹{item.close.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between gap-4 text-zinc-400">
                          <span>1D Change:</span>
                          <span className={item.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                            {item.changePct >= 0 ? '+' : ''}
                            {item.changePct.toFixed(2)}%
                          </span>
                        </div>
                        <div className="flex justify-between gap-4 text-zinc-400">
                          <span>SMA 50:</span>
                          <span className="text-amber-400">₹{item.sma50}</span>
                        </div>
                        <div className="flex justify-between gap-4 text-zinc-400">
                          <span>SMA 200:</span>
                          <span className="text-indigo-400">₹{item.sma200}</span>
                        </div>
                        {item.isDistribution && (
                          <div className="mt-1.5 pt-1.5 border-t border-zinc-800 text-red-400 font-bold flex items-center gap-1">
                            <AlertOctagon className="w-3.5 h-3.5" />
                            <span>INSTITUTIONAL DISTRIBUTION DAY</span>
                          </div>
                        )}
                        {item.isFTD && (
                          <div className="mt-1.5 pt-1.5 border-t border-zinc-800 text-emerald-400 font-bold flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>FOLLOW-THROUGH DAY (FTD)</span>
                          </div>
                        )}
                      </div>
                    );
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="sma200"
                  stroke="#818cf8"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="sma50"
                  stroke="#fbbf24"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="close"
                  stroke="#f4f4f5"
                  strokeWidth={2}
                  dot={(props) => {
                    const { cx, cy, payload } = props;
                    if (cx === undefined || cy === undefined) return <></>;
                    if (payload.isDistribution) {
                      return (
                        <circle
                          key={`dist-${payload.date}`}
                          cx={cx}
                          cy={cy}
                          r={5}
                          fill="#ef4444"
                          stroke="#7f1d1d"
                          strokeWidth={2}
                        />
                      );
                    }
                    if (payload.isFTD) {
                      return (
                        <polygon
                          key={`ftd-${payload.date}`}
                          points={`${cx},${cy - 7} ${cx + 5},${cy + 5} ${cx - 5},${cy + 5}`}
                          fill="#10b981"
                          stroke="#064e3b"
                          strokeWidth={1.5}
                        />
                      );
                    }
                    return <></>;
                  }}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Chart 2: Rolling Distribution Days Count (with danger zones) */}
          <div className="pt-2 border-t border-zinc-800 flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs font-mono text-zinc-400">
              <span>Rolling 25-Session Distribution Count</span>
              <span className="text-[10px] text-zinc-500">
                Green: 0–3 (Safe) | Amber: 4–5 (Pressure) | Red: 6+ (Correction)
              </span>
            </div>
            <div className="h-[120px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={reg?.history || []}
                  margin={{ top: 5, right: 10, left: 10, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 6" vertical={false} />
                  <XAxis dataKey="date" hide />
                  <YAxis
                    domain={[0, 8]}
                    orientation="right"
                    tickLine={false}
                  />
                  <ReferenceLine y={3} stroke="#10b981" strokeDasharray="3 3" strokeOpacity={0.6} />
                  <ReferenceLine y={5} stroke="#f59e0b" strokeDasharray="3 3" strokeOpacity={0.6} />
                  <ReferenceLine y={6} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.6} />
                  <Bar
                    dataKey="rollingDistCount"
                    fill="#ef4444"
                    radius={[2, 2, 0, 0]}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>

        {/* ─── Active Distribution Days Table ───────────────────────────────── */}
        <section className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-white">
                Active Distribution Days in Current 25-Session Window
              </h3>
              <p className="text-[11px] text-zinc-500">
                A distribution day drops off after 25 sessions, or earlier if the index gains ≥ 5.0% from its close.
              </p>
            </div>
            <span className="text-xs font-mono font-bold text-amber-400">
              {reg?.activeDistributionDays.length || 0} Active Sessions
            </span>
          </div>

          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-left font-mono text-xs">
              <thead className="bg-zinc-800 text-xs font-bold text-white">
                <tr>
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Index Close</th>
                  <th className="px-4 py-2.5">1D Change %</th>
                  <th className="px-4 py-2.5">Volume Surge</th>
                  <th className="px-4 py-2.5">Sessions Active</th>
                  <th className="px-4 py-2.5">5% Rally Rule Progress</th>
                  <th className="px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80 bg-zinc-950/60">
                {reg?.activeDistributionDays.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-zinc-500">
                      No active distribution days in the current 25-session window. Market trend is clean!
                    </td>
                  </tr>
                ) : (
                  reg?.activeDistributionDays.map((d) => {
                    const pctNeeded = d.distanceTo5Pct;
                    return (
                      <tr
                        key={d.date}
                        className="hover:bg-zinc-900/50 transition-colors"
                      >
                        <td className="px-4 py-2.5 font-bold text-white flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-red-500" />
                          {d.date}
                        </td>
                        <td className="px-4 py-2.5 text-zinc-200">
                          ₹{d.close.toFixed(2)}
                        </td>
                        <td className="px-4 py-2.5 font-bold text-red-400">
                          {d.changePct.toFixed(2)}%
                        </td>
                        <td className="px-4 py-2.5 text-zinc-300">
                          {d.volumeVs50Avg.toFixed(2)}x 50D avg
                        </td>
                        <td className="px-4 py-2.5 text-zinc-400">
                          Day {d.daysAgo} of 25{' '}
                          <span className="text-[10px] text-zinc-500">
                            ({d.expirySessionsLeft} left)
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="w-24 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                              <div
                                className="h-full bg-emerald-500"
                                style={{
                                  width: `${Math.min(100, Math.max(0, (d.maxGainSince / 5.0) * 100))}%`,
                                }}
                              />
                            </div>
                            <span className="text-[10px] text-zinc-400">
                              Max +{d.maxGainSince.toFixed(1)}% (Needs +{pctNeeded.toFixed(1)}%)
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/30">
                            ACTIVE
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* ─── Methodology & Investor Guide ─────────────────────────────────── */}
        <section className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-3 text-xs leading-relaxed text-zinc-400">
          <div className="flex items-center gap-2 text-zinc-200 font-bold">
            <Info className="w-4 h-4 text-amber-400" />
            <span>HOW INSTITUTIONAL DISTRIBUTION DAYS PROTECT YOUR CAPITAL</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
            <div className="bg-zinc-950 p-3.5 rounded-xl border border-zinc-800/80">
              <h4 className="text-white font-bold mb-1">What is a Distribution Day?</h4>
              <p className="text-zinc-400 text-[11px]">
                A session where the index declines by ≥ 0.20% on volume heavier than the prior day. This indicates institutional funds (mutual funds, FIIs) are selling shares in quantity.
              </p>
            </div>
            <div className="bg-zinc-950 p-3.5 rounded-xl border border-zinc-800/80">
              <h4 className="text-white font-bold mb-1">The 25-Day Rolling Window</h4>
              <p className="text-zinc-400 text-[11px]">
                Distribution days expire automatically after 25 trading sessions. Furthermore, if the index gains 5% or more above the close of that distribution day at any time, that day drops off early.
              </p>
            </div>
            <div className="bg-zinc-950 p-3.5 rounded-xl border border-zinc-800/80">
              <h4 className="text-white font-bold mb-1">Follow-Through Day (FTD)</h4>
              <p className="text-zinc-400 text-[11px]">
                A confirmed bottom signal occurring on Day 4 or later of a rally attempt, where the index surges ≥ 1.25% on above-average volume. This marks the signal to start buying leaders.
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
