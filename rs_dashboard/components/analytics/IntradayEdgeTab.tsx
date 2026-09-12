'use client';

/**
 * Intraday Seller's Edge Terminal:
 * 1. Live Combined Premium (CP) & High-Water Mark Decay Tracker
 * 2. Institutional Regime & Writing Pressure Index (WPI)
 * 3. CE:PE Value Imbalance & Real-time Rebalancing Cues
 * 4. Time-of-Day Expected Decay Benchmark
 * 5. Intraday Leg Execution (Trim 50%, Close 100%, Add Strike)
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Activity,
  Zap,
  TrendingUp,
  TrendingDown,
  Shield,
  ShieldAlert,
  AlertTriangle,
  Clock,
  CheckCircle2,
  Lock,
  Scale,
  RefreshCw,
  ArrowRight,
  Info,
  Sliders,
  Flame,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts';
import { cn } from '@/lib/utils';
import { legExpiries, type PositionLeg } from '@/lib/positionLegs';
import type { ClosePct } from '@/lib/partialQty';
import type { AnalyticsUnderlying } from '@/lib/analyticsUnderlyings';
import type { Broker } from '@/hooks/useBrokerSelector';
import {
  buildMultiExpiryCurve,
  computePayoffStats,
  type ChainOc,
  type PayoffStats,
} from '@/lib/optionsStrategy';
import { isIntradayProduct } from '@/lib/positionProduct';
import PositionsLegTable from './PositionsLegTable';
import AddStrikePicker from './AddStrikePicker';
import PositionsPayoffChart, { type CurvePoint, type OiBar } from './PositionsPayoffChart';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RegimeApiData {
  signal: number;
  oiZ: number;
  slopeZ: number;
  wpiZ: number;
  priceTrendZ: number;
  label: string;
  confirmed: boolean;
  confirmationState: string;
  reason: string;
  strategy: string;
}

interface DecayHistoryPoint {
  time: string;
  decayPct: number;
  hwmPct: number;
  cp: number;
}

interface Props {
  legs: PositionLeg[];
  allPricedLegs: PositionLeg[];
  lotSize: number;
  spot: number;
  strikeStep: number;
  underlying: AnalyticsUnderlying;
  broker: Broker;
  chains: Record<string, ChainOc>;
  finalExpiry: string | null;
  intradayCurve: CurvePoint[];
  intradayStats: PayoffStats | null;
  oiBars: OiBar[];
  showOi: boolean;
  onToggleOi: () => void;
  onCloseLeg: (leg: PositionLeg, pct: ClosePct) => void;
  closingKeys: Set<string>;
  onAddToLeg: (leg: PositionLeg, side: 'BUY' | 'SELL', lots: number) => void;
  addingKeys: Set<string>;
  onPlacedOrder: (label: string, orderId?: string) => void;
  onErrorOrder: (label: string, error?: string) => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  canZoomIn?: boolean;
  canZoomOut?: boolean;
  regime?: RegimeApiData | null;
}

function fmtInr(n: number): string {
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}₹${abs.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

// ── Time of Day Benchmark Math ────────────────────────────────────────────────

/**
 * Expected decay % based on Indian Market Time (09:15 to 15:15 = 360 mins)
 */
function getExpectedDecayPct(): { expected: number; label: string; phase: string } {
  const now = new Date();
  // Get Indian Standard Time hours & minutes
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const istDate = new Date(utc + 5.5 * 3600000);
  const h = istDate.getHours();
  const m = istDate.getMinutes();
  const curMin = h * 60 + m;

  const startMin = 9 * 60 + 15; // 09:15 IST
  const endMin = 15 * 60 + 15; // 15:15 IST

  if (curMin < startMin) {
    return { expected: 0, label: 'Pre-Market', phase: 'Pre-Market Discovery' };
  }
  if (curMin >= endMin) {
    return { expected: 95, label: 'Post-15:15', phase: 'Closeout Complete' };
  }

  const elapsed = curMin - startMin; // 0 to 360

  // Non-linear empirical model for weekly Indian index options:
  // 0-45m (09:15-10:00): Morning crush (0 to 18%)
  // 45-195m (10:00-12:30): Steady theta (18% to 50%)
  // 195-270m (12:30-13:45): Lunch consolidation (50% to 62%)
  // 270-360m (13:45-15:15): Gamma expiry push (62% to 95%)
  let expected = 0;
  let phase = 'Active Session';

  if (elapsed <= 45) {
    expected = (elapsed / 45) * 18;
    phase = 'Morning IV Crush';
  } else if (elapsed <= 195) {
    expected = 18 + ((elapsed - 45) / 150) * 32;
    phase = 'Steady Theta Decay';
  } else if (elapsed <= 270) {
    expected = 50 + ((elapsed - 195) / 75) * 12;
    phase = 'Lunch Lull / Consolidation';
  } else {
    expected = 62 + ((elapsed - 270) / 90) * 33;
    phase = 'Expiry Gamma Window';
  }

  return { expected: Math.min(95, Math.max(0, expected)), label: `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')} IST`, phase };
}

export default function IntradayEdgeTab({
  legs,
  allPricedLegs,
  lotSize,
  spot,
  strikeStep,
  underlying,
  broker,
  chains,
  finalExpiry,
  intradayCurve,
  intradayStats,
  oiBars,
  showOi,
  onToggleOi,
  onCloseLeg,
  closingKeys,
  onAddToLeg,
  addingKeys,
  onPlacedOrder,
  onErrorOrder,
  onZoomIn,
  onZoomOut,
  canZoomIn,
  canZoomOut,
  regime: propRegime,
}: Props) {
  // Toggle: Look at MIS-product legs only, or all open legs for this underlying
  const [scopeMode, setScopeMode] = useState<'all' | 'mis'>('all');

  // Regime state
  const [fetchedRegime, setFetchedRegime] = useState<RegimeApiData | null>(null);
  const [regimeLoading, setRegimeLoading] = useState(false);

  const regime = propRegime ?? fetchedRegime;

  // Combined Premium decay history
  const [decayHistory, setDecayHistory] = useState<DecayHistoryPoint[]>([]);
  const hwmRef = useRef<number>(0);

  // Filter active legs based on scopeMode
  const activeLegs = useMemo(() => {
    if (scopeMode === 'mis') {
      return allPricedLegs.filter((l) => isIntradayProduct(l.display.productType));
    }
    return allPricedLegs;
  }, [allPricedLegs, scopeMode]);

  // Separate Call & Put short legs
  const shortLegs = useMemo(() => activeLegs.filter((l) => l.side === 'SELL'), [activeLegs]);
  const shortCalls = useMemo(() => shortLegs.filter((l) => l.type === 'CE'), [shortLegs]);
  const shortPuts = useMemo(() => shortLegs.filter((l) => l.type === 'PE'), [shortLegs]);

  const activeExpiries = useMemo(() => legExpiries(activeLegs), [activeLegs]);
  const activeTargetExpiry = useMemo(() => {
    return activeExpiries.length ? activeExpiries[0] : finalExpiry;
  }, [activeExpiries, finalExpiry]);

  const activeCurve = useMemo(() => {
    if (!activeLegs.length || !spot || !activeTargetExpiry) return intradayCurve;
    return buildMultiExpiryCurve(activeLegs, spot, 1, activeTargetExpiry, strikeStep, 0.04);
  }, [activeLegs, spot, activeTargetExpiry, strikeStep, intradayCurve]);

  const activeStats = useMemo(() => {
    if (!activeLegs.length || !spot || !activeTargetExpiry) return intradayStats;
    return computePayoffStats(activeLegs, spot, 1, activeTargetExpiry, strikeStep, 0.04);
  }, [activeLegs, spot, activeTargetExpiry, strikeStep, intradayStats]);

  // ── Poll Institutional Regime ─────────────────────────────────────────────
  const fetchRegime = useCallback(async () => {
    setRegimeLoading(true);
    try {
      const res = await fetch(`/api/options/iv-history?mode=cumulative&underlying=${underlying}&fallback=1`);
      const json = await res.json();
      if (json?.success && json?.regime) {
        setFetchedRegime(json.regime as RegimeApiData);
      }
    } catch {
      // Advisory only
    } finally {
      setRegimeLoading(false);
    }
  }, [underlying]);

  useEffect(() => {
    if (!propRegime) {
      fetchRegime();
      const id = setInterval(fetchRegime, 20_000);
      return () => clearInterval(id);
    }
  }, [fetchRegime, propRegime]);

  // ── Real-time Option Chain Metrics (PCR, Max Pain, ATM Straddle) ──────────
  const chainMetrics = useMemo(() => {
    if (!finalExpiry || !chains[finalExpiry]) {
      // fallback to first available chain
      const firstExp = Object.keys(chains)[0];
      if (!firstExp || !chains[firstExp]) return null;
      return computeChainStats(chains[firstExp], spot, strikeStep);
    }
    return computeChainStats(chains[finalExpiry], spot, strikeStep);
  }, [chains, finalExpiry, spot, strikeStep]);

  // ── Live Combined Premium (CP) & Decay Math ──────────────────────────────
  const cpStats = useMemo(() => {
    if (!shortLegs.length) return null;

    let totalEntryValue = 0;
    let totalLiveValue = 0;
    let totalQty = 0;

    let ceEntryVal = 0, ceLiveVal = 0, ceQty = 0;
    let peEntryVal = 0, peLiveVal = 0, peQty = 0;

    for (const l of shortCalls) {
      const q = l.qtyLots;
      const entry = l.price;
      const ltp = l.display.ltp ?? entry;
      ceEntryVal += entry * q;
      ceLiveVal += ltp * q;
      ceQty += q;
    }

    for (const l of shortPuts) {
      const q = l.qtyLots;
      const entry = l.price;
      const ltp = l.display.ltp ?? entry;
      peEntryVal += entry * q;
      peLiveVal += ltp * q;
      peQty += q;
    }

    totalEntryValue = ceEntryVal + peEntryVal;
    totalLiveValue = ceLiveVal + peLiveVal;
    totalQty = ceQty + peQty;

    if (totalEntryValue <= 0) return null;

    const decayCaptured = totalEntryValue - totalLiveValue;
    const decayPct = (decayCaptured / totalEntryValue) * 100;

    // Update session HWM
    if (decayPct > hwmRef.current) {
      hwmRef.current = decayPct;
    }
    const hwmPct = Math.max(hwmRef.current, decayPct);
    const drawdownPct = Math.max(0, hwmPct - decayPct);

    // Per-lot equivalents
    const lots = lotSize > 0 ? totalQty / (lotSize * 2) : 1;
    const entryCpPerLot = lots > 0 ? totalEntryValue / (lots * (lotSize || 1)) : 0;
    const liveCpPerLot = lots > 0 ? totalLiveValue / (lots * (lotSize || 1)) : 0;

    // Imbalance Ratio between Short CE & Short PE
    let imbalanceRatio = 1.0;
    let dominantSide: 'CE' | 'PE' | 'BALANCED' = 'BALANCED';

    if (ceLiveVal > 0 && peLiveVal > 0) {
      if (ceLiveVal >= peLiveVal) {
        imbalanceRatio = ceLiveVal / peLiveVal;
        dominantSide = 'CE';
      } else {
        imbalanceRatio = peLiveVal / ceLiveVal;
        dominantSide = 'PE';
      }
    } else if (ceLiveVal > 0 && peLiveVal === 0) {
      imbalanceRatio = 99.0;
      dominantSide = 'CE';
    } else if (peLiveVal > 0 && ceLiveVal === 0) {
      imbalanceRatio = 99.0;
      dominantSide = 'PE';
    }

    return {
      totalEntryValue,
      totalLiveValue,
      decayCaptured,
      decayPct,
      hwmPct,
      drawdownPct,
      entryCpPerLot,
      liveCpPerLot,
      ceLiveVal,
      peLiveVal,
      ceEntryVal,
      peEntryVal,
      imbalanceRatio,
      dominantSide,
      hasBothWings: shortCalls.length > 0 && shortPuts.length > 0,
    };
  }, [shortLegs, shortCalls, shortPuts, lotSize]);

  // Record decay point into history series
  useEffect(() => {
    if (!cpStats) return;
    const nowStr = new Date().toLocaleTimeString('en-IN', { hour12: false });
    setDecayHistory((prev) => {
      // Don't add duplicate time stamps
      if (prev.length > 0 && prev[prev.length - 1].time.slice(0, 5) === nowStr.slice(0, 5)) {
        return prev;
      }
      const next = [
        ...prev,
        {
          time: nowStr.slice(0, 5),
          decayPct: parseFloat(cpStats.decayPct.toFixed(1)),
          hwmPct: parseFloat(cpStats.hwmPct.toFixed(1)),
          cp: parseFloat(cpStats.liveCpPerLot.toFixed(1)),
        },
      ];
      return next.slice(-40); // Keep last 40 observations
    });
  }, [cpStats]);

  // ── Time of Day Benchmark ────────────────────────────────────────────────
  const tod = useMemo(() => getExpectedDecayPct(), []);
  const decayPaceDiff = cpStats ? cpStats.decayPct - tod.expected : null;

  return (
    <div className="space-y-4">
      {/* ── Top Bar: Mode Toggle & Status ──────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/60 px-4 py-3 backdrop-blur-md shadow-sm">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-400 shadow-inner">
            <Flame className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-white">
              Intraday Seller&apos;s Edge Terminal
            </h3>
            <p className="text-[10px] text-zinc-400 font-medium">
              Combined Premium decay velocity, Writing Pressure Index (WPI), and real-time rebalancing cues
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Scope Selector: All Legs vs MIS Only */}
          <div className="flex items-center rounded-lg border border-zinc-700/80 bg-zinc-950/80 p-0.5 shadow-inner">
            <button
              type="button"
              onClick={() => setScopeMode('all')}
              className={cn(
                'rounded-md px-2.5 py-1 text-[10px] font-bold transition-all',
                scopeMode === 'all'
                  ? 'bg-zinc-800 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200',
              )}
            >
              All Open Legs ({allPricedLegs.length})
            </button>
            <button
              type="button"
              onClick={() => setScopeMode('mis')}
              className={cn(
                'rounded-md px-2.5 py-1 text-[10px] font-bold transition-all',
                scopeMode === 'mis'
                  ? 'bg-zinc-800 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200',
              )}
            >
              MIS / Intraday Only ({allPricedLegs.filter((l) => isIntradayProduct(l.display.productType)).length})
            </button>
          </div>

          <button
            type="button"
            onClick={fetchRegime}
            disabled={regimeLoading}
            className="flex items-center gap-1 rounded-lg border border-zinc-750 bg-zinc-900 px-2 py-1 text-[10px] font-semibold text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white"
          >
            <RefreshCw className={cn('h-3 w-3', regimeLoading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* ── Pillar 1: Institutional Writing Pressure & Regime Intelligence ── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
        {/* Card 1: WPI & Institutional Bias */}
        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-3.5 backdrop-blur-md shadow-sm lg:col-span-2">
          <div className="flex items-center justify-between gap-2 border-b border-zinc-800/60 pb-2">
            <div className="flex items-center gap-1.5">
              <Shield className="h-3.5 w-3.5 text-sky-400" />
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-300">
                Institutional Writing Pressure (WPI)
              </span>
            </div>
            {regime && (
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider',
                  regime.confirmed
                    ? 'border border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                    : 'border border-amber-500/30 bg-amber-500/15 text-amber-300',
                )}
              >
                {regime.confirmed ? 'Confirmed Regime' : 'Pending / Unconfirmed'}
              </span>
            )}
          </div>

          <div className="mt-2.5 flex flex-wrap items-baseline gap-2">
            <span
              className={cn(
                'font-mono text-base font-extrabold tracking-tight',
                regime?.label.includes('Bullish')
                  ? 'text-emerald-400'
                  : regime?.label.includes('Bearish')
                  ? 'text-rose-400'
                  : 'text-sky-300',
              )}
            >
              {regime?.label ?? (chainMetrics?.pcr && chainMetrics.pcr >= 1.0 ? 'Bullish Put Bias' : 'Neutral Flow')}
            </span>
            <span className="font-mono text-xs text-zinc-400">
              {regime?.strategy ? `(${regime.strategy})` : 'Range-Bound / Neutral Theta'}
            </span>
          </div>

          <p className="mt-1 text-[11px] text-zinc-400 leading-relaxed">
            {regime?.reason ??
              (chainMetrics
                ? `Total Put OI (${(chainMetrics.totalPutOi / 100000).toFixed(1)}L) vs Call OI (${(chainMetrics.totalCallOi / 100000).toFixed(1)}L). PCR is ${chainMetrics.pcr.toFixed(2)}.`
                : 'Evaluating option chain open interest and premium slope…')}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-zinc-800/60 pt-2 font-mono text-[10px]">
            <div>
              <span className="text-zinc-500">WPI Z-Score: </span>
              <strong className={regime && regime.wpiZ > 0.5 ? 'text-emerald-400' : regime && regime.wpiZ < -0.5 ? 'text-rose-400' : 'text-zinc-300'}>
                {regime ? `${regime.wpiZ > 0 ? '+' : ''}${regime.wpiZ.toFixed(2)}z` : 'Live'}
              </strong>
            </div>
            <div>
              <span className="text-zinc-500">OI Divergence Z: </span>
              <strong className={regime && regime.oiZ > 0 ? 'text-emerald-400' : 'text-zinc-300'}>
                {regime ? `${regime.oiZ > 0 ? '+' : ''}${regime.oiZ.toFixed(2)}z` : '—'}
              </strong>
            </div>
            <div>
              <span className="text-zinc-500">Slope: </span>
              <strong className="text-zinc-300">
                {regime ? `${regime.slopeZ > 0 ? '+' : ''}${regime.slopeZ.toFixed(2)}z` : '—'}
              </strong>
            </div>
          </div>
        </div>

        {/* Card 2: Chain Dynamics (PCR & Max Pain) */}
        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-3.5 backdrop-blur-md shadow-sm">
          <div className="flex items-center gap-1.5 border-b border-zinc-800/60 pb-2">
            <Scale className="h-3.5 w-3.5 text-emerald-400" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-300">PCR &amp; Max Pain</span>
          </div>

          <div className="mt-2.5 space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-wider text-zinc-400">Put-Call Ratio (PCR)</span>
              <span
                className={cn(
                  'font-mono text-base font-bold tabular-nums',
                  chainMetrics && chainMetrics.pcr >= 1.2
                    ? 'text-emerald-400'
                    : chainMetrics && chainMetrics.pcr <= 0.8
                    ? 'text-rose-400'
                    : 'text-sky-300',
                )}
              >
                {chainMetrics ? chainMetrics.pcr.toFixed(2) : '—'}
              </span>
            </div>

            <div className="flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-wider text-zinc-400">Max Pain Strike</span>
              <span className="font-mono text-xs font-bold text-zinc-200">
                {chainMetrics?.maxPainStrike ? chainMetrics.maxPainStrike.toLocaleString('en-IN') : '—'}
              </span>
            </div>

            <div className="flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-wider text-zinc-400">ATM Straddle</span>
              <span className="font-mono text-xs font-bold text-amber-300">
                {chainMetrics?.atmStraddlePrice ? `₹${chainMetrics.atmStraddlePrice.toFixed(1)}` : '—'}
              </span>
            </div>
          </div>
        </div>

        {/* Card 3: Time-of-Day Decay Benchmark */}
        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-3.5 backdrop-blur-md shadow-sm">
          <div className="flex items-center gap-1.5 border-b border-zinc-800/60 pb-2">
            <Clock className="h-3.5 w-3.5 text-violet-400" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-300">Decay vs. Clock</span>
          </div>

          <div className="mt-2.5 space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-wider text-zinc-400">Session Phase</span>
              <span className="font-mono text-[11px] font-bold text-violet-300 truncate max-w-[120px]" title={tod.phase}>
                {tod.phase}
              </span>
            </div>

            <div className="flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-wider text-zinc-400">Expected Decay</span>
              <span className="font-mono text-xs font-bold text-zinc-300">
                ~{tod.expected.toFixed(0)}% of daily theta
              </span>
            </div>

            <div className="flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-wider text-zinc-400">Actual Decay Pace</span>
              {decayPaceDiff !== null ? (
                <span
                  className={cn(
                    'font-mono text-xs font-bold tabular-nums',
                    decayPaceDiff >= 5
                      ? 'text-emerald-400'
                      : decayPaceDiff <= -5
                      ? 'text-rose-400'
                      : 'text-sky-300',
                  )}
                >
                  {decayPaceDiff >= 0 ? '+' : ''}
                  {decayPaceDiff.toFixed(1)}% ({decayPaceDiff >= 5 ? 'Ahead' : decayPaceDiff <= -5 ? 'Lagging' : 'On Track'})
                </span>
              ) : (
                <span className="font-mono text-xs text-zinc-500">No active shorts</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Pillar 2 & 3: Live Combined Premium (CP) & Imbalance Rebalancing ── */}
      {cpStats ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          {/* Combined Premium Tiles & Timeline */}
          <div className="space-y-3.5 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 backdrop-blur-md shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
                <h4 className="text-xs font-bold uppercase tracking-wider text-white">
                  Combined Premium Decay Tracker
                </h4>
              </div>

              {/* Trailing High-Water Mark Floor Badge */}
              <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[10px] font-mono">
                <span className="text-zinc-500">Peak Decay (HWM):</span>
                <strong className="text-emerald-300">+{cpStats.hwmPct.toFixed(1)}%</strong>
              </div>
            </div>

            {/* 4 Stat Tiles */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3 shadow-inner">
                <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">Entry CP</div>
                <div className="mt-0.5 font-mono text-sm font-bold text-zinc-200 tabular-nums">
                  ₹{cpStats.entryCpPerLot.toFixed(1)}
                </div>
                <div className="mt-0.5 text-[9px] text-zinc-500 font-medium">per lot combined</div>
              </div>

              <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3 shadow-inner">
                <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">Live CP</div>
                <div className="mt-0.5 font-mono text-sm font-bold text-sky-300 tabular-nums">
                  ₹{cpStats.liveCpPerLot.toFixed(1)}
                </div>
                <div className="mt-0.5 text-[9px] text-zinc-500 font-medium">current market</div>
              </div>

              <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3 shadow-inner">
                <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">Decay Captured</div>
                <div
                  className={cn(
                    'mt-0.5 font-mono text-sm font-bold tabular-nums',
                    cpStats.decayPct >= 0 ? 'text-emerald-400' : 'text-rose-400',
                  )}
                >
                  {cpStats.decayPct >= 0 ? '+' : ''}
                  {cpStats.decayPct.toFixed(1)}%
                </div>
                <div className="mt-0.5 font-mono text-[9px] text-zinc-400 font-medium">
                  {fmtInr(cpStats.decayCaptured)}
                </div>
              </div>

              <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3 shadow-inner">
                <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">Peak Giveback</div>
                <div
                  className={cn(
                    'mt-0.5 font-mono text-sm font-bold tabular-nums',
                    cpStats.drawdownPct >= 10 ? 'text-rose-400' : 'text-zinc-400',
                  )}
                >
                  {cpStats.drawdownPct > 0 ? `-${cpStats.drawdownPct.toFixed(1)}%` : '0.0%'}
                </div>
                <div className="mt-0.5 text-[9px] text-zinc-500 font-medium">
                  {cpStats.drawdownPct >= 10 ? '⚠️ Protect profit' : 'within safe zone'}
                </div>
              </div>
            </div>

            {/* Scalp Locks Milestone Strip */}
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-2.5 text-[10px]">
              <span className="font-bold uppercase tracking-wider text-zinc-400">Scalp Locks:</span>

              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono font-bold',
                  cpStats.decayPct >= 25
                    ? 'border border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                    : 'border border-zinc-800 bg-zinc-900/60 text-zinc-500',
                )}
              >
                {cpStats.decayPct >= 25 ? <CheckCircle2 className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                25% Floor
              </span>

              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono font-bold',
                  cpStats.decayPct >= 40
                    ? 'border border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                    : 'border border-zinc-800 bg-zinc-900/60 text-zinc-500',
                )}
              >
                {cpStats.decayPct >= 40 ? <CheckCircle2 className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                40% Target
              </span>

              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono font-bold',
                  cpStats.decayPct >= 60
                    ? 'border border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                    : 'border border-zinc-800 bg-zinc-900/60 text-zinc-500',
                )}
              >
                {cpStats.decayPct >= 60 ? <CheckCircle2 className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                60% Target
              </span>

              {cpStats.drawdownPct >= 10 && (
                <span className="ml-auto inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/15 px-2 py-0.5 font-bold text-rose-300 animate-pulse">
                  <AlertTriangle className="h-3 w-3" /> Giveback Warning
                </span>
              )}
            </div>

            {/* Live Decay Sparkline / Mini Curve */}
            {decayHistory.length > 2 && (
              <div className="pt-1">
                <div className="h-36 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={decayHistory} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                      <defs>
                        <linearGradient id="decayGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                      <XAxis dataKey="time" stroke="#71717a" tick={{ fontSize: 9 }} />
                      <YAxis stroke="#71717a" tick={{ fontSize: 9 }} domain={['dataMin - 5', 'dataMax + 5']} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#09090b',
                          borderColor: '#3f3f46',
                          borderRadius: '8px',
                          fontSize: '11px',
                          fontFamily: 'monospace',
                        }}
                        formatter={(val: any) => [`${val}%`, 'Decay Captured']}
                      />
                      <ReferenceLine y={25} stroke="#38bdf8" strokeDasharray="3 3" label={{ value: '25% Floor', fill: '#38bdf8', fontSize: 9 }} />
                      <Area type="monotone" dataKey="decayPct" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#decayGradient)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>

          {/* CE:PE Value Imbalance & Rebalance Action Matrix */}
          <div className="flex flex-col justify-between space-y-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 backdrop-blur-md shadow-sm">
            <div className="flex items-center justify-between gap-2 border-b border-zinc-800/60 pb-2">
              <div className="flex items-center gap-2">
                <Scale className="h-4 w-4 text-sky-400" />
                <h4 className="text-xs font-bold uppercase tracking-wider text-white">
                  CE:PE Imbalance &amp; Rebalancing
                </h4>
              </div>

              <span
                className={cn(
                  'rounded-md px-2 py-0.5 font-mono text-[10px] font-bold uppercase',
                  cpStats.imbalanceRatio <= 1.4
                    ? 'border border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                    : cpStats.imbalanceRatio <= 2.0
                    ? 'border border-amber-500/30 bg-amber-500/15 text-amber-300'
                    : 'border border-rose-500/30 bg-rose-500/15 text-rose-300 animate-pulse',
                )}
              >
                Ratio: {cpStats.imbalanceRatio.toFixed(2)}x (
                {cpStats.imbalanceRatio <= 1.4 ? 'Balanced' : cpStats.imbalanceRatio <= 2.0 ? 'Moderate Skew' : 'Critical Imbalance'})
              </span>
            </div>

            {/* Side-by-Side CE vs PE Value Comparison */}
            <div className="grid grid-cols-2 gap-3">
              <div
                className={cn(
                  'rounded-xl border p-3 shadow-inner',
                  cpStats.dominantSide === 'CE' && cpStats.imbalanceRatio > 1.5
                    ? 'border-rose-800/70 bg-rose-950/25'
                    : 'border-zinc-800/80 bg-zinc-950/60',
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-rose-300">Short Calls (CE)</span>
                  <span className="font-mono text-[10px] text-zinc-400">{shortCalls.length} leg(s)</span>
                </div>
                <div className="mt-1 font-mono text-base font-bold text-zinc-100 tabular-nums">
                  {fmtInr(cpStats.ceLiveVal)}
                </div>
                <div className="text-[9px] text-zinc-500 font-medium">
                  Entry: {fmtInr(cpStats.ceEntryVal)}
                </div>
              </div>

              <div
                className={cn(
                  'rounded-xl border p-3 shadow-inner',
                  cpStats.dominantSide === 'PE' && cpStats.imbalanceRatio > 1.5
                    ? 'border-rose-800/70 bg-rose-950/25'
                    : 'border-zinc-800/80 bg-zinc-950/60',
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-sky-300">Short Puts (PE)</span>
                  <span className="font-mono text-[10px] text-zinc-400">{shortPuts.length} leg(s)</span>
                </div>
                <div className="mt-1 font-mono text-base font-bold text-zinc-100 tabular-nums">
                  {fmtInr(cpStats.peLiveVal)}
                </div>
                <div className="text-[9px] text-zinc-500 font-medium">
                  Entry: {fmtInr(cpStats.peEntryVal)}
                </div>
              </div>
            </div>

            {/* Actionable Rebalancing Recommendation */}
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/70 p-3 text-xs shadow-inner">
              <div className="flex items-center gap-1.5 font-bold uppercase tracking-wider text-zinc-300 text-[10px]">
                <Zap className="h-3 w-3 text-amber-400" />
                <span>Prescription &amp; Rebalance Rule</span>
              </div>

              <p className="mt-1 text-[11px] text-zinc-300 leading-relaxed">
                {cpStats.imbalanceRatio <= 1.4 ? (
                  <span className="text-emerald-400">
                    ✓ Both wings are within the optimal 1.0x–1.4x neutral decay corridor. Delta is balanced and theta decay is symmetrical.
                  </span>
                ) : cpStats.dominantSide === 'CE' ? (
                  <span>
                    <strong>Market is rallying:</strong> Call leg value has expanded to{' '}
                    <span className="text-rose-400 font-bold">{cpStats.imbalanceRatio.toFixed(1)}x</span> of Put value. Put wing has surrendered most of its juice.
                    <br />
                    <span className="text-amber-300 font-semibold mt-1 inline-block">
                      Recommendation: Roll Winner PE closer to spot (ATM) to collect fresh premium, or trim 50% of Loser CE to contain negative delta.
                    </span>
                  </span>
                ) : (
                  <span>
                    <strong>Market is declining:</strong> Put leg value has expanded to{' '}
                    <span className="text-rose-400 font-bold">{cpStats.imbalanceRatio.toFixed(1)}x</span> of Call value. Call wing has surrendered most of its juice.
                    <br />
                    <span className="text-amber-300 font-semibold mt-1 inline-block">
                      Recommendation: Roll Winner CE closer to spot (ATM) to collect fresh premium, or trim 50% of Loser PE to contain positive delta crash risk.
                    </span>
                  </span>
                )}
              </p>
            </div>
          </div>
        </div>
      ) : (
        /* Empty State banner if no short legs open */
        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-5 text-center shadow-sm">
          <Scale className="mx-auto h-8 w-8 text-zinc-500" />
          <h4 className="mt-2 text-xs font-bold uppercase tracking-wider text-zinc-200">
            No Active Short Option Legs Open
          </h4>
          <p className="mt-1 text-[11px] text-zinc-400 max-w-md mx-auto">
            The Combined Premium (CP) &amp; Rebalance Tracker automatically activates when you hold short call and short put legs for {underlying}. Use the strike picker below to place or draft a straddle or strangle.
          </p>
        </div>
      )}

      {/* ── Active Intraday Positions Table & Execution ────────────────────── */}
      <div className="space-y-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 backdrop-blur-md shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-sky-400" />
            <h4 className="text-xs font-bold uppercase tracking-wider text-white">
              {scopeMode === 'all' ? 'All Active Legs' : 'Intraday (MIS) Legs'} ({activeLegs.length})
            </h4>
          </div>
        </div>

        <AddStrikePicker
          broker={broker}
          underlying={underlying}
          strikeStep={strikeStep}
          spot={spot}
          lotSize={lotSize}
          onPlaced={onPlacedOrder}
          onError={onErrorOrder}
        />

        <PositionsLegTable
          legs={activeLegs}
          unparseable={[]}
          lotSize={lotSize}
          onClose={onCloseLeg}
          closingKeys={closingKeys}
          onAdd={onAddToLeg}
          addingKeys={addingKeys}
        />
      </div>

      {/* ── Intraday Payoff Chart ─────────────────────────────────────────── */}
      {activeCurve.length > 0 && (
        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 backdrop-blur-md shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-white">Intraday Payoff Diagram</span>
            <span className="font-mono text-[10px] text-zinc-400">Target: {activeTargetExpiry ?? 'Today'}</span>
          </div>

          <PositionsPayoffChart
            height={400}
            expiryCurve={activeCurve}
            targetCurve={null}
            breakevens={activeStats?.breakevensExpiry ?? []}
            spot={spot}
            targetSpot={spot}
            expiryLabel={activeTargetExpiry ?? 'Today'}
            targetLabel="Today"
            oiBars={oiBars}
            showOi={showOi}
            onToggleOi={onToggleOi}
            onZoomIn={onZoomIn ?? (() => {})}
            onZoomOut={onZoomOut ?? (() => {})}
            canZoomIn={canZoomIn ?? false}
            canZoomOut={canZoomOut ?? false}
          />
        </div>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeChainStats(oc: ChainOc, spot: number, strikeStep: number) {
  let totalCallOi = 0;
  let totalPutOi = 0;

  const strikeKeys = Object.keys(oc)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  if (!strikeKeys.length) return null;

  for (const s of strikeKeys) {
    const row = oc[String(s)];
    if (row?.ce?.oi) totalCallOi += row.ce.oi;
    if (row?.pe?.oi) totalPutOi += row.pe.oi;
  }

  const pcr = totalCallOi > 0 ? totalPutOi / totalCallOi : 1.0;

  // Nearest ATM strike
  const nearestAtm = strikeKeys.reduce((best, sk) => (Math.abs(sk - spot) < Math.abs(best - spot) ? sk : best), strikeKeys[0]);
  const atmRow = oc[String(nearestAtm)];
  const ceLtp = atmRow?.ce?.last_price ?? 0;
  const peLtp = atmRow?.pe?.last_price ?? 0;
  const atmStraddlePrice = ceLtp > 0 && peLtp > 0 ? ceLtp + peLtp : 0;

  // Max Pain Calculation
  let minPayout = Infinity;
  let maxPainStrike = nearestAtm;

  for (const testStrike of strikeKeys) {
    let payout = 0;
    for (const s of strikeKeys) {
      const row = oc[String(s)];
      const ceOi = row?.ce?.oi ?? 0;
      const peOi = row?.pe?.oi ?? 0;

      if (testStrike > s && ceOi > 0) {
        payout += (testStrike - s) * ceOi;
      }
      if (testStrike < s && peOi > 0) {
        payout += (s - testStrike) * peOi;
      }
    }
    if (payout < minPayout) {
      minPayout = payout;
      maxPainStrike = testStrike;
    }
  }

  return {
    totalCallOi,
    totalPutOi,
    pcr,
    nearestAtm,
    atmStraddlePrice,
    maxPainStrike,
  };
}
