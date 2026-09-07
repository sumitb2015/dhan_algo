'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity, Sliders, RefreshCw, Pause, Play, BookOpen, X,
  Layers, TrendingUp, TrendingDown, Shield, Zap, Info,
  Copy, Check, ChevronRight, BarChart2, Eye, Compass, Target, Sparkles, Send,
  ArrowRight, Award, Flame
} from 'lucide-react';
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine
} from 'recharts';
import type { BatmanCell } from '@/lib/batmanMath';
import type { UnderlyingType, RiskProfile } from '@/lib/ultimateScannerTypes';
import type { MultiLegBasket } from '@/lib/multiLegFocus';
import NavBar from './NavBar';

interface BatmanMatrixResponse {
  success: boolean;
  error?: string;
  underlying?: UnderlyingType;
  spot?: number;
  prevClose?: number;
  change?: number;
  changePct?: number;
  atmStrike?: number;
  step?: number;
  lotSize?: number;
  wing?: number;
  dataDate?: string;
  expiries?: { expiry: string; dte: number; atmStrike?: number }[];
  rows?: { offset: number; cells: (BatmanCell | null)[] }[];
  stale?: boolean;
}

const POLL_MS = 4000;

function passesRiskProfile(cell: BatmanCell, profile: RiskProfile): boolean {
  if (profile === 'conservative') return cell.popPct >= 72 && cell.riskTier !== 'Aggressive';
  if (profile === 'moderate') return cell.popPct >= 58 && cell.riskTier !== 'Aggressive';
  if (profile === 'aggressive') return cell.riskTier !== 'Conservative';
  return true;
}

// ─── Stat Box Component ─────────────────────────────────────────────────────
function PulseStat({
  label, value, sub, icon: Icon, color = 'text-zinc-100', badge,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: React.ElementType;
  color?: string;
  badge?: React.ReactNode;
}) {
  return (
    <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-3.5 flex flex-col justify-between shadow-sm min-w-0 hover:border-zinc-700 transition-colors">
      <div className="flex items-center justify-between gap-1 mb-1">
        <div className="flex items-center gap-1.5 text-[10px] font-bold text-zinc-400 uppercase tracking-wider truncate">
          {Icon && <Icon className="w-3.5 h-3.5 text-zinc-400 shrink-0" />}
          <span className="truncate">{label}</span>
        </div>
        {badge}
      </div>
      <div className={`text-lg font-mono font-bold tabular-nums leading-tight ${color} truncate`}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-zinc-400 mt-1 font-medium truncate">{sub}</div>}
    </div>
  );
}

// ─── Strategy Guide Modal ───────────────────────────────────────────────────
function BatmanReadmeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [guideTab, setGuideTab] = useState<'concepts' | 'metrics' | 'execution'>('concepts');

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/80 backdrop-blur-md animate-in fade-in duration-150">
      <div className="relative w-full max-w-2xl bg-zinc-950 border border-zinc-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/70 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <BookOpen className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight">Batman Strategy Matrix Guide</h2>
              <p className="text-[11px] text-zinc-400">Mastering 4-leg double ratio spreads, dual ear profit peaks, and wing width selection</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center px-6 pt-3 border-b border-zinc-800/80 bg-zinc-900/40 gap-2 shrink-0">
          {[
            { id: 'concepts', label: '1. What is Batman Strategy?' },
            { id: 'metrics', label: '2. Dual Peaks & Breakeven Math' },
            { id: 'execution', label: '3. Wing Width & Risk Management' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setGuideTab(tab.id as typeof guideTab)}
              className={`px-3.5 py-2 text-xs font-bold border-b-2 transition-all cursor-pointer ${
                guideTab === tab.id
                  ? 'border-emerald-400 text-emerald-300'
                  : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto space-y-4 text-xs text-zinc-300 leading-relaxed font-sans">
          {guideTab === 'concepts' && (
            <div className="space-y-4">
              <div className="p-3.5 rounded-xl bg-emerald-950/30 border border-emerald-500/30 text-emerald-300 space-y-1">
                <p className="font-bold flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5" /> Core Concept: 4-Leg Double Ratio Spread
                </p>
                <p className="text-zinc-300 text-[11px]">
                  The Batman strategy combines a Bull Put Ratio spread with a Bear Call Ratio spread. By buying 1 inner OTM option and selling 2 further OTM options on both sides (1:2 ratio), you finance the inner long hedges while creating two massive profit peaks (&ldquo;ears&rdquo;) at the sold strikes.
                </p>
              </div>

              <div>
                <h4 className="text-zinc-100 font-bold mb-1.5 text-xs uppercase tracking-wider">The Anatomy of Batman</h4>
                <ul className="list-disc pl-5 mt-1.5 space-y-1 text-zinc-300 text-[11px]">
                  <li><strong className="text-zinc-100">Center Body (Floor Profit):</strong> If the underlying stays between the two long strikes, all options expire worthless. You keep 100% of the initial net credit collected (Net Credit &gt; 0).</li>
                  <li><strong className="text-zinc-100">Dual Ear Peaks (Max Profit):</strong> If spot lands near either short strike (Short PE or Short CE), the inner long option is worth its full wing width (W × Step), resulting in maximum profit = (Wing Points + Net Credit) × Lot Size.</li>
                  <li><strong className="text-zinc-100">Tail Risk:</strong> Beyond the short strikes, you are net short 1 naked option on each side. Tail risk is managed with stop losses or rolling.</li>
                </ul>
              </div>

              <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800">
                <h4 className="text-zinc-100 font-bold mb-1 text-xs">Why This Cross-Expiry Matrix Matters</h4>
                <p className="text-zinc-400 text-[11px]">
                  Different expiries and wing widths offer vastly different risk-reward trade-offs. The Batman Matrix scans all 15 inner offsets across the next 5 expiries simultaneously, allowing you to instantly identify high-yield sweet spots where credit is maximized and breakevens are broad.
                </p>
              </div>
            </div>
          )}

          {guideTab === 'metrics' && (
            <div className="space-y-4">
              <div>
                <h4 className="text-zinc-100 font-bold mb-2 text-xs uppercase tracking-wider">Mathematical Definitions</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800 space-y-1">
                    <span className="font-bold text-emerald-400 block">Floor Net Credit</span>
                    <p className="font-mono text-[11px] text-zinc-300">
                      Credit = (2 × Short PE − Long PE) + (2 × Short CE − Long CE)
                    </p>
                    <p className="text-[10px] text-zinc-400">
                      Baseline profit kept if spot finishes anywhere inside the inner wings.
                    </p>
                  </div>

                  <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800 space-y-1">
                    <span className="font-bold text-cyan-400 block">Ear Peak Profit</span>
                    <p className="font-mono text-[11px] text-zinc-300">
                      Max Profit = (Wing Points + Net Credit) × Lot Size
                    </p>
                    <p className="text-[10px] text-zinc-400">
                      Achieved at the short strikes where long options expire at max intrinsic value.
                    </p>
                  </div>

                  <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800 space-y-1">
                    <span className="font-bold text-amber-400 block">Lower Breakeven</span>
                    <p className="font-mono text-[11px] text-zinc-300">
                      BE_lower = Short PE Strike − (Wing + Net Credit)
                    </p>
                    <p className="text-[10px] text-zinc-400">
                      Downside breakeven sits far below the short put strike.
                    </p>
                  </div>

                  <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800 space-y-1">
                    <span className="font-bold text-purple-400 block">Upper Breakeven</span>
                    <p className="font-mono text-[11px] text-zinc-300">
                      BE_upper = Short CE Strike + (Wing + Net Credit)
                    </p>
                    <p className="text-[10px] text-zinc-400">
                      Upside breakeven sits far above the short call strike.
                    </p>
                  </div>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-zinc-900/80 border border-zinc-800">
                <h4 className="text-zinc-100 font-bold mb-1.5 text-xs">Color Coding Key in Matrix:</h4>
                <ul className="space-y-1 text-zinc-300 text-[11px]">
                  <li><span className="inline-block w-2.5 h-2.5 rounded bg-emerald-500/25 border border-emerald-500/60 mr-2" /><strong className="text-emerald-300">Great RoM (≥ 2.5%):</strong> Exceptional yield for the given safety buffer.</li>
                  <li><span className="inline-block w-2.5 h-2.5 rounded bg-emerald-500/10 border border-emerald-500/30 mr-2" /><strong className="text-emerald-400">Good RoM (≥ 1.0%):</strong> Healthy premium collection and high win probability.</li>
                  <li><span className="inline-block w-2.5 h-2.5 rounded bg-zinc-800 border border-zinc-700 mr-2" /><strong className="text-zinc-400">Neutral / Muted:</strong> Standard baseline or deep OTM defensive wings.</li>
                </ul>
              </div>
            </div>
          )}

          {guideTab === 'execution' && (
            <div className="space-y-4">
              <div className="p-3.5 rounded-xl bg-zinc-900 border border-zinc-800 space-y-2">
                <h4 className="text-emerald-400 font-bold text-xs flex items-center gap-1.5">
                  <Target className="w-3.5 h-3.5" /> Best Execution Guidelines
                </h4>
                <ul className="list-disc pl-5 space-y-1.5 text-zinc-300 text-[11px]">
                  <li>
                    <strong className="text-zinc-100">Wing Width Selection:</strong> A 2-strike wing ($W=2$, e.g. 100 pts on NIFTY) is standard. For higher volatility, expanding to $W=3$ (150 pts) creates larger ears and wider breakevens.
                  </li>
                  <li>
                    <strong className="text-zinc-100">Weekly Sweet Spot:</strong> Target <strong>ATM±2 to ATM±4</strong> on near expiries (3–8 DTE) to collect 1.0%–2.0% RoM with wide breakeven safety corridors.
                  </li>
                  <li>
                    <strong className="text-zinc-100">Profit Booking:</strong> Take profit when 50%–70% of max floor credit is collected, or when spot approaches an ear peak for an outsized gain.
                  </li>
                </ul>
              </div>

              <div className="p-3 rounded-xl bg-amber-950/20 border border-amber-500/30 text-amber-300 space-y-1 text-[11px]">
                <p className="font-bold flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5" /> Risk Management Rule
                </p>
                <p className="text-zinc-400">
                  Because tail risk is undefined beyond the breakevens, always maintain a hard stop loss (e.g. 100% of initial credit or when spot breaches an outer short strike).
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-zinc-800 bg-zinc-900/70 flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-bold transition-colors cursor-pointer"
          >
            Got It
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Cell Detail Drilldown Modal ────────────────────────────────────────────
interface BatmanCellModalProps {
  cell: BatmanCell | null;
  expiry: string;
  dte: number;
  underlying: UnderlyingType;
  spot: number;
  lotSize: number;
  lots: number;
  unit: 'pts' | 'inr';
  lastPolledAt: string | null;
  onClose: () => void;
  onEnter: () => void;
  entering: boolean;
  enterError: string | null;
}

function BatmanCellModal({
  cell, expiry, dte, underlying, spot, lotSize, lots, unit, lastPolledAt, onClose, onEnter, entering, enterError
}: BatmanCellModalProps) {
  const [copied, setCopied] = useState(false);

  if (!cell) return null;

  const totalQty = lots * lotSize;
  const totalFloorInr = cell.netPremiumPoints * totalQty;
  const totalEarMaxInr = cell.maxProfitPoints * totalQty;
  const totalMargin = cell.estMargin * lots;

  const handleCopyOrder = () => {
    const text = `BATMAN SPREAD [${underlying} Expiry: ${expiry}]:
BUY 1x ${cell.longPutStrike} PE (₹${cell.longPutLtp.toFixed(2)})
SELL 2x ${cell.shortPutStrike} PE (₹${cell.shortPutLtp.toFixed(2)})
BUY 1x ${cell.longCallStrike} CE (₹${cell.longCallLtp.toFixed(2)})
SELL 2x ${cell.shortCallStrike} CE (₹${cell.shortCallLtp.toFixed(2)})
Net Credit: ₹${Math.round(totalFloorInr).toLocaleString('en-IN')} (${cell.netPremiumPoints.toFixed(2)} pts)
Ear Max Profit: ₹${Math.round(totalEarMaxInr).toLocaleString('en-IN')} (${cell.maxProfitPoints.toFixed(2)} pts)`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/80 backdrop-blur-md animate-in fade-in duration-150">
      <div className="relative w-full max-w-2xl bg-zinc-950 border border-zinc-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/70">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white tracking-tight">
                  ATM±{cell.offset} Batman Spread
                </h3>
                <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                  Wing: ±{cell.wingPoints}pts (W={cell.wing})
                </span>
                <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700">
                  {expiry} ({dte}d)
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                {underlying} @ {spot.toLocaleString('en-IN')} · Strikes: {cell.shortPutStrike}P / {cell.longPutStrike}P / {cell.longCallStrike}C / {cell.shortCallStrike}C
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 text-xs max-h-[75vh] overflow-y-auto">
          {/* Key Metrics Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800">
              <span className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">Floor Net Credit</span>
              <span className="text-base font-mono font-bold text-emerald-400 block">
                ₹{Math.round(totalFloorInr).toLocaleString('en-IN')}
              </span>
              <span className="text-[10px] text-zinc-400">{cell.netPremiumPoints.toFixed(2)} pts (100% inside body)</span>
            </div>

            <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800">
              <span className="text-[10px] uppercase font-bold text-cyan-400 block mb-1 flex items-center gap-1">
                <Sparkles className="w-3 h-3" /> Ear Max Profit
              </span>
              <span className="text-base font-mono font-bold text-cyan-300 block">
                ₹{Math.round(totalEarMaxInr).toLocaleString('en-IN')}
              </span>
              <span className="text-[10px] text-zinc-400">{cell.maxProfitPoints.toFixed(2)} pts at short strikes</span>
            </div>

            <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800">
              <span className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">Return on Margin</span>
              <span className="text-base font-mono font-bold text-emerald-300 block">
                {cell.romPct.toFixed(2)}%
              </span>
              <span className="text-[10px] text-zinc-400">{cell.romAnnualizedPct.toFixed(0)}% Annualized</span>
            </div>

            <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800">
              <span className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">Win Probability</span>
              <span className="text-base font-mono font-bold text-amber-300 block">
                {cell.popPct}% POP
              </span>
              <span className="text-[10px] text-zinc-400">Risk: {cell.riskTier}</span>
            </div>
          </div>

          {/* 4-Leg Breakdown */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* PUT SIDE WING */}
            <div className="p-4 rounded-xl bg-purple-950/20 border border-purple-800/40 space-y-2.5">
              <div className="flex items-center justify-between pb-2 border-b border-purple-800/40">
                <span className="font-bold text-purple-300 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-purple-400" />
                  PUT SPREAD WING (1:2 RATIO)
                </span>
                <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  Credit: +{cell.putCredit.toFixed(2)} pts
                </span>
              </div>

              {/* Legs Table */}
              <div className="space-y-1.5 font-mono text-xs">
                <div className="flex items-center justify-between p-2 rounded bg-zinc-900/80 border border-zinc-800">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400">BUY 1x</span>
                    <span className="text-white font-bold">{cell.longPutStrike} PE</span>
                  </div>
                  <span className="text-zinc-200">₹{cell.longPutLtp.toFixed(2)}</span>
                </div>

                <div className="flex items-center justify-between p-2 rounded bg-zinc-900/80 border border-zinc-800">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">SELL 2x</span>
                    <span className="text-white font-bold">{cell.shortPutStrike} PE</span>
                    <span className="text-[10px] text-purple-400 font-sans font-bold">(Ear)</span>
                  </div>
                  <span className="text-zinc-200">₹{cell.shortPutLtp.toFixed(2)}</span>
                </div>
              </div>

              <div className="flex justify-between text-[11px] text-zinc-400 pt-1">
                <span>Put Ear Distance:</span>
                <span className="font-mono text-zinc-300">{cell.distancePoints} pts OTM (±{cell.distancePct.toFixed(2)}%)</span>
              </div>
            </div>

            {/* CALL SIDE WING */}
            <div className="p-4 rounded-xl bg-sky-950/20 border border-sky-800/40 space-y-2.5">
              <div className="flex items-center justify-between pb-2 border-b border-sky-800/40">
                <span className="font-bold text-sky-300 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-sky-400" />
                  CALL SPREAD WING (1:2 RATIO)
                </span>
                <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30">
                  Credit: +{cell.callCredit.toFixed(2)} pts
                </span>
              </div>

              {/* Legs Table */}
              <div className="space-y-1.5 font-mono text-xs">
                <div className="flex items-center justify-between p-2 rounded bg-zinc-900/80 border border-zinc-800">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400">BUY 1x</span>
                    <span className="text-white font-bold">{cell.longCallStrike} CE</span>
                  </div>
                  <span className="text-zinc-200">₹{cell.longCallLtp.toFixed(2)}</span>
                </div>

                <div className="flex items-center justify-between p-2 rounded bg-zinc-900/80 border border-zinc-800">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">SELL 2x</span>
                    <span className="text-white font-bold">{cell.shortCallStrike} CE</span>
                    <span className="text-[10px] text-sky-400 font-sans font-bold">(Ear)</span>
                  </div>
                  <span className="text-zinc-200">₹{cell.shortCallLtp.toFixed(2)}</span>
                </div>
              </div>

              <div className="flex justify-between text-[11px] text-zinc-400 pt-1">
                <span>Call Ear Distance:</span>
                <span className="font-mono text-zinc-300">{Math.round(cell.shortCallStrike - spot)} pts OTM</span>
              </div>
            </div>
          </div>

          {/* Batman Payoff & Safety Corridor Visualizer */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 space-y-3">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-bold text-zinc-300 flex items-center gap-1.5">
                <Compass className="w-3.5 h-3.5 text-amber-400" />
                Batman Payoff Corridor & Breakeven Range
              </span>
              <span className="text-zinc-400 font-mono">
                Total Safety Channel: <strong className="text-zinc-200">{cell.breakevenWidth} pts</strong> ({((cell.breakevenWidth / spot) * 100).toFixed(2)}%)
              </span>
            </div>

            {/* Gauge Strip */}
            <div className="relative pt-6 pb-2">
              <div className="h-3 rounded-full bg-zinc-800 overflow-hidden relative border border-zinc-700">
                <div className="absolute inset-y-0 left-1/6 right-1/6 bg-emerald-500/30 rounded-full" />
                <div className="absolute inset-y-0 left-1/3 right-1/3 bg-cyan-500/40 rounded-full" />
              </div>
              <div className="flex justify-between items-center text-[10px] font-mono text-zinc-400 mt-2">
                <div className="text-left">
                  <span className="text-purple-400 block font-bold">Lower BE</span>
                  <span>{cell.breakevens[0]}</span>
                </div>
                <div className="text-center">
                  <span className="text-purple-300 block font-bold">Put Ear</span>
                  <span>{cell.shortPutStrike}</span>
                </div>
                <div className="text-center">
                  <span className="text-amber-400 block font-bold">Spot</span>
                  <span className="text-white font-bold">{spot.toLocaleString('en-IN')}</span>
                </div>
                <div className="text-center">
                  <span className="text-sky-300 block font-bold">Call Ear</span>
                  <span>{cell.shortCallStrike}</span>
                </div>
                <div className="text-right">
                  <span className="text-sky-400 block font-bold">Upper BE</span>
                  <span>{cell.breakevens[1]}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Margin & Sizing Notes */}
          <div className="p-3 rounded-xl bg-zinc-900/60 border border-zinc-800/80 flex items-center justify-between text-zinc-400 text-[11px]">
            <span className="flex items-center gap-1.5">
              {cell.marginSource === 'live' ? 'Live SPAN Margin' : 'Est. Blocked SPAN Margin'}:
            </span>
            <span className="font-mono font-bold text-zinc-200">
              ₹{totalMargin.toLocaleString('en-IN')} ({lots} lot{lots > 1 ? 's' : ''} × {lotSize} qty)
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-zinc-800 bg-zinc-900/70 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={handleCopyOrder}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold transition-colors cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-400" />}
              <span>{copied ? 'Copied to Clipboard!' : 'Copy Trade Legs'}</span>
            </button>
            {lastPolledAt && (
              <span className="text-[10px] text-zinc-500 font-mono">
                Prices as of {new Date(lastPolledAt).toLocaleTimeString('en-IN')}
              </span>
            )}
            {enterError && (
              <span className="text-[10px] text-rose-400 font-semibold">{enterError}</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onEnter}
              disabled={entering}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-60 disabled:cursor-not-allowed text-zinc-950 text-xs font-bold transition-colors cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{entering ? 'Preparing…' : 'Enter'}</span>
            </button>
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-bold transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────
export default function BatmanMatrixPage() {
  const router = useRouter();
  const [underlying, setUnderlying] = useState<UnderlyingType>('NIFTY');
  const [wing, setWing] = useState<number>(2); // 2 strikes is standard default
  const [data, setData] = useState<BatmanMatrixResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [readmeOpen, setReadmeOpen] = useState(false);

  // Active view tab
  const [activeTab, setActiveTab] = useState<'matrix' | 'curves' | 'breakevens'>('matrix');

  // Display configuration
  const [displayMetric, setDisplayMetric] = useState<'all' | 'rom' | 'premium' | 'earMax' | 'pop' | 'breakeven'>('all');
  const [unit, setUnit] = useState<'pts' | 'inr'>('inr');
  const [lots, setLots] = useState(1);

  // Header filters
  const [offsetRowCount, setOffsetRowCount] = useState(12);
  const [minRomPct, setMinRomPct] = useState(0.2);
  const [minDistancePct, setMinDistancePct] = useState(0.2);
  const [maxDistancePct, setMaxDistancePct] = useState(6.0);
  const [riskProfile, setRiskProfile] = useState<RiskProfile>('all');
  const [goodRomPct, setGoodRomPct] = useState(1.0);
  const [greatRomPct, setGreatRomPct] = useState(2.5);

  // Drilldown modal state
  const [selectedModal, setSelectedModal] = useState<{
    cell: BatmanCell;
    expiry: string;
    dte: number;
  } | null>(null);

  // Enter-trade state
  const [entering, setEntering] = useState(false);
  const [enterError, setEnterError] = useState<string | null>(null);
  const tradeInFlight = useRef(false);

  const isLoading = (!data || data.underlying !== underlying || data.wing !== wing) && !error;

  const handleUnderlyingChange = (u: UnderlyingType) => {
    if (u === underlying) return;
    setData(null);
    setUnderlying(u);
  };

  const handleWingChange = (w: number) => {
    if (w === wing) return;
    setData(null);
    setWing(w);
  };

  const handleEnterTrade = useCallback(async () => {
    if (!selectedModal || tradeInFlight.current) return;
    tradeInFlight.current = true;
    setEntering(true);
    setEnterError(null);
    try {
      const { cell, expiry } = selectedModal;
      const basket: Partial<MultiLegBasket> = {
        name: `ATM±${cell.offset} Batman (${expiry})`,
        underlying,
        expiry,
        broker: 'dhan',
        presetKey: 'batman',
        legs: [
          { id: '1', side: 'B', option: 'PE', strike: cell.longPutStrike, lots: lots * 1, type: 'MARKET', status: 'DRAFT' },
          { id: '2', side: 'S', option: 'PE', strike: cell.shortPutStrike, lots: lots * 2, type: 'MARKET', status: 'DRAFT' },
          { id: '3', side: 'B', option: 'CE', strike: cell.longCallStrike, lots: lots * 1, type: 'MARKET', status: 'DRAFT' },
          { id: '4', side: 'S', option: 'CE', strike: cell.shortCallStrike, lots: lots * 2, type: 'MARKET', status: 'DRAFT' },
        ],
      };
      const res = await fetch('/api/multi-leg-focus/baskets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basket),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      router.push('/multi-leg-focus');
    } catch (err) {
      setEnterError(`Failed to send to Multi-Leg Focus: ${String(err)}`);
      setEntering(false);
      tradeInFlight.current = false;
    }
  }, [selectedModal, underlying, lots, router]);

  const pollRequestId = useRef(0);

  const fetchMatrix = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    const requestId = ++pollRequestId.current;
    try {
      const res = await fetch(`/api/options/batman-matrix?underlying=${underlying}&wing=${wing}`);
      const json = (await res.json()) as BatmanMatrixResponse;
      if (requestId !== pollRequestId.current) return;
      if (json.success) {
        setData(json);
        setError(null);
        setLastPolledAt(new Date().toISOString());
      } else {
        setError(json.error ?? 'Failed to load Batman matrix');
      }
    } catch (err) {
      if (requestId !== pollRequestId.current) return;
      setError(String((err as Error).message ?? err));
    } finally {
      if (requestId === pollRequestId.current && isManual) {
        setRefreshing(false);
      }
    }
  }, [underlying, wing]);

  // Polling lifecycle
  useEffect(() => {
    if (paused) return;

    fetchMatrix();

    let intervalId: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (intervalId) return;
      intervalId = setInterval(() => fetchMatrix(false), POLL_MS);
    };
    const stop = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        fetchMatrix();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchMatrix, paused]);

  // Sync drilldown modal cell on poll updates
  useEffect(() => {
    if (!selectedModal || !data?.rows || !data.expiries) return;
    const expIdx = data.expiries.findIndex(e => e.expiry === selectedModal.expiry);
    if (expIdx === -1) return;
    const row = data.rows.find(r => r.offset === selectedModal.cell.offset);
    const freshCell = row?.cells[expIdx];
    if (freshCell && freshCell !== selectedModal.cell) {
      setSelectedModal(prev => (prev ? { ...prev, cell: freshCell } : prev));
    }
  }, [data]);

  const visibleRows = useMemo(() => {
    if (!data?.rows) return [];
    return data.rows
      .filter(row => row.offset <= offsetRowCount)
      .filter(row => {
        return row.cells.some(cell => {
          if (!cell) return false;
          return cell.distancePct >= minDistancePct && cell.distancePct <= maxDistancePct;
        });
      });
  }, [data, offsetRowCount, minDistancePct, maxDistancePct]);

  // Top Highlights
  const topStats = useMemo(() => {
    if (!data?.rows || data.rows.length === 0) return null;

    let bestRomCell: BatmanCell | null = null;
    let bestRomExpiry = '';
    let bestEarProfitCell: BatmanCell | null = null;
    let bestEarProfitExpiry = '';

    data.rows
      .filter(r => r.offset <= offsetRowCount)
      .forEach(r => {
        r.cells.forEach((c, idx) => {
          if (!c) return;
          if (c.distancePct < minDistancePct || c.distancePct > maxDistancePct) return;
          if (!passesRiskProfile(c, riskProfile)) return;
          if (c.romPct < minRomPct) return;

          const exp = data.expiries?.[idx]?.expiry ?? '';
          if (!bestRomCell || c.romPct > bestRomCell.romPct) {
            bestRomCell = c;
            bestRomExpiry = exp;
          }
          if (!bestEarProfitCell || c.maxProfit > bestEarProfitCell.maxProfit) {
            bestEarProfitCell = c;
            bestEarProfitExpiry = exp;
          }
        });
      });

    return {
      bestRomCell: bestRomCell as BatmanCell | null,
      bestRomExpiry,
      bestEarProfitCell: bestEarProfitCell as BatmanCell | null,
      bestEarProfitExpiry,
    };
  }, [data, offsetRowCount, minDistancePct, maxDistancePct, riskProfile, minRomPct]);

  // Derived Chart Datasets
  const curveChartData = useMemo(() => {
    if (!data?.rows || !data.expiries) return [];
    return data.rows
      .filter(r => r.offset <= offsetRowCount)
      .map(row => {
        const item: Record<string, number | string> = {
          offset: `ATM±${row.offset}`,
          offsetNum: row.offset,
        };
        row.cells.forEach((c, idx) => {
          const exp = data.expiries![idx]?.expiry;
          if (exp && c) {
            item[`rom_${exp}`] = c.romPct;
            item[`ear_${exp}`] = unit === 'inr' ? c.maxProfit * lots : c.maxProfitPoints;
          }
        });
        return item;
      });
  }, [data, offsetRowCount, unit, lots]);

  const breakevenChartData = useMemo(() => {
    if (!data?.rows || !data.expiries || data.expiries.length === 0) return [];
    const firstExpIdx = 0;
    const spot = data.spot || 0;
    return data.rows
      .filter(r => r.offset <= offsetRowCount)
      .map(row => {
        const c = row.cells[firstExpIdx];
        if (!c) return null;
        return {
          offset: `ATM±${row.offset}`,
          shortPut: c.shortPutStrike,
          longPut: c.longPutStrike,
          longCall: c.longCallStrike,
          shortCall: c.shortCallStrike,
          lowerBe: c.breakevens[0],
          upperBe: c.breakevens[1],
          spot,
          width: c.breakevenWidth,
        };
      })
      .filter(Boolean);
  }, [data, offsetRowCount]);

  function getCellVisuals(cell: BatmanCell | null): {
    bg: string;
    border: string;
    text: string;
    muted: boolean;
    isGreat: boolean;
    isGood: boolean;
  } {
    if (!cell) {
      return {
        bg: 'bg-zinc-950/40',
        border: 'border-zinc-800/40',
        text: 'text-zinc-600',
        muted: true,
        isGreat: false,
        isGood: false,
      };
    }

    if (cell.distancePct < minDistancePct || cell.distancePct > maxDistancePct) {
      return {
        bg: 'bg-zinc-900/30',
        border: 'border-zinc-800/60',
        text: 'text-zinc-600',
        muted: true,
        isGreat: false,
        isGood: false,
      };
    }

    if (!passesRiskProfile(cell, riskProfile) || cell.romPct < minRomPct) {
      return {
        bg: 'bg-zinc-900/30',
        border: 'border-zinc-800/60',
        text: 'text-zinc-500',
        muted: true,
        isGreat: false,
        isGood: false,
      };
    }

    if (cell.romPct >= greatRomPct) {
      return {
        bg: 'bg-emerald-500/25 hover:bg-emerald-500/35',
        border: 'border-emerald-500/60 hover:border-emerald-400',
        text: 'text-emerald-300',
        muted: false,
        isGreat: true,
        isGood: true,
      };
    }

    if (cell.romPct >= goodRomPct) {
      return {
        bg: 'bg-emerald-500/10 hover:bg-emerald-500/20',
        border: 'border-emerald-500/30 hover:border-emerald-500/50',
        text: 'text-emerald-400',
        muted: false,
        isGreat: false,
        isGood: true,
      };
    }

    return {
      bg: 'bg-zinc-900/60 hover:bg-zinc-800/60',
      border: 'border-zinc-800 hover:border-zinc-700',
      text: 'text-zinc-300',
      muted: false,
      isGreat: false,
      isGood: false,
    };
  }

  const currentLotSize = data?.lotSize || 65;
  const currentStep = data?.step || 50;
  const currentSpot = data?.spot || 0;
  const currentChange = data?.change || 0;
  const currentChangePct = data?.changePct || 0;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white font-sans selection:bg-emerald-500/30">
      {/* ─── Sticky Control Header ────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/25 shrink-0 shadow-[0_0_15px_rgba(16,185,129,0.15)]">
            <Layers className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-bold text-emerald-500 uppercase tracking-[0.18em]">
                Live Double Ratio Spread Matrix
              </span>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-[9px] font-bold text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Live Batman Grid
              </span>
            </div>
            <h1 className="text-base font-bold text-white tracking-tight leading-none mt-0.5">
              Batman Matrix
            </h1>
          </div>
        </div>

        {/* Global Controls */}
        <div className="flex items-center gap-2.5 flex-wrap ml-auto">
          {/* Readme / Strategy Guide */}
          <button
            onClick={() => setReadmeOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-xs font-bold transition-all cursor-pointer shadow-sm"
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>How to Trade</span>
          </button>

          {/* Underlying Selector */}
          <div className="flex items-center rounded-lg bg-zinc-900 border border-zinc-800 p-0.5">
            {(['NIFTY', 'BANKNIFTY', 'SENSEX'] as const).map(u => (
              <button
                key={u}
                onClick={() => handleUnderlyingChange(u)}
                className={`px-3 py-1 text-xs font-bold rounded-md transition-all cursor-pointer ${
                  underlying === u
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {u}
              </button>
            ))}
          </div>

          {/* Wing Width Selector (W strikes) */}
          <div className="flex items-center rounded-lg bg-zinc-900 border border-zinc-800 p-0.5" title="Spread width between inner and outer strikes">
            <span className="text-[10px] text-zinc-400 font-bold px-2">Wing:</span>
            {[1, 2, 3, 4].map(w => (
              <button
                key={w}
                onClick={() => handleWingChange(w)}
                className={`px-2 py-1 text-xs font-mono font-bold rounded-md transition-all cursor-pointer ${
                  wing === w
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                ±{w * currentStep}pts
              </button>
            ))}
          </div>

          {/* Unit Toggle */}
          <div className="flex items-center rounded-lg bg-zinc-900 border border-zinc-800 p-0.5">
            <button
              onClick={() => setUnit('pts')}
              className={`px-2.5 py-1 text-xs font-bold rounded-md transition-all cursor-pointer ${
                unit === 'pts' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Pts
            </button>
            <button
              onClick={() => setUnit('inr')}
              className={`px-2.5 py-1 text-xs font-bold rounded-md transition-all cursor-pointer ${
                unit === 'inr' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              ₹ Total
            </button>
          </div>

          {/* Lots Multiplier */}
          {unit === 'inr' && (
            <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 px-2 py-1 rounded-lg">
              <span className="text-[10px] text-zinc-400 font-bold">Lots:</span>
              {[1, 2, 5, 10].map(l => (
                <button
                  key={l}
                  onClick={() => setLots(l)}
                  className={`px-1.5 py-0.5 text-[10px] font-mono font-bold rounded transition-all cursor-pointer ${
                    lots === l ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  ×{l}
                </button>
              ))}
            </div>
          )}

          {/* Pause / Resume */}
          <button
            onClick={() => setPaused(!paused)}
            className={`p-1.5 rounded-lg border transition-all cursor-pointer ${
              paused
                ? 'bg-amber-500/15 border-amber-500/40 text-amber-400'
                : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white'
            }`}
            title={paused ? 'Resume live polling' : 'Pause live polling'}
          >
            {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          </button>

          {/* Manual Refresh */}
          <button
            onClick={() => fetchMatrix(true)}
            disabled={refreshing || isLoading}
            className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white transition-all cursor-pointer disabled:opacity-50"
            title="Refresh now"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing || isLoading ? 'animate-spin text-emerald-400' : ''}`} />
          </button>

          {/* Data Date Chip */}
          {data?.dataDate && (
            <span className="text-[10px] font-mono font-bold px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-amber-400">
              DATA: {data.dataDate}
            </span>
          )}

          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </header>

      {/* ─── Top Highlights KPI Bar ───────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 px-6 py-3 border-b border-zinc-800/80 bg-zinc-950/60">
        {/* Top RoM Pick */}
        <PulseStat
          label="Highest RoM% Setup"
          icon={Award}
          color="text-emerald-400"
          value={
            topStats?.bestRomCell ? (
              <span className="flex items-center gap-1.5">
                {topStats.bestRomCell.romPct.toFixed(2)}% RoM
                <span className="text-xs font-normal text-zinc-400 font-sans">
                  ({topStats.bestRomCell.romAnnualizedPct.toFixed(0)}% p.a.)
                </span>
              </span>
            ) : (
              '—'
            )
          }
          sub={
            topStats?.bestRomCell && topStats.bestRomExpiry ? (
              <span className="truncate block">
                ATM±{topStats.bestRomCell.offset} ({topStats.bestRomExpiry}) · {topStats.bestRomCell.shortPutStrike}P/{topStats.bestRomCell.shortCallStrike}C
              </span>
            ) : undefined
          }
          badge={
            topStats?.bestRomCell && (
              <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300">
                {topStats.bestRomCell.popPct}% POP
              </span>
            )
          }
        />

        {/* Highest Ear Peak Profit Pick */}
        <PulseStat
          label="Max Ear Profit Pick"
          icon={Flame}
          color="text-cyan-400"
          value={
            topStats?.bestEarProfitCell ? (
              <span>
                ₹{Math.round(topStats.bestEarProfitCell.maxProfit * lots).toLocaleString('en-IN')}
                <span className="text-xs font-normal text-zinc-400 font-sans ml-1.5">
                  ({topStats.bestEarProfitCell.maxProfitPoints.toFixed(1)} pts)
                </span>
              </span>
            ) : (
              '—'
            )
          }
          sub={
            topStats?.bestEarProfitCell && topStats.bestEarProfitExpiry ? (
              <span className="truncate block">
                ATM±{topStats.bestEarProfitCell.offset} ({topStats.bestEarProfitExpiry}) · Wing ±{topStats.bestEarProfitCell.wingPoints}pts
              </span>
            ) : undefined
          }
          badge={
            <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300">
              Peak Ear
            </span>
          }
        />

        {/* Market Reference */}
        <PulseStat
          label={`${underlying} Spot & ATM`}
          icon={Activity}
          color="text-white"
          value={
            <span className="flex items-center gap-2">
              {currentSpot > 0 ? currentSpot.toLocaleString('en-IN') : '—'}
              {currentChange !== 0 && (
                <span className={`text-xs font-semibold ${currentChange >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {currentChange >= 0 ? '+' : ''}{currentChange.toFixed(2)} ({currentChangePct >= 0 ? '+' : ''}{currentChangePct.toFixed(2)}%)
                </span>
              )}
            </span>
          }
          sub={
            <span className="font-mono text-[10px] text-zinc-400">
              ATM: <strong className="text-zinc-200">{data?.atmStrike || Math.round(currentSpot / currentStep) * currentStep}</strong> · Step: {currentStep} · Lot: {currentLotSize}
            </span>
          }
        />

        {/* Structure Status */}
        <PulseStat
          label="Batman Architecture"
          icon={Layers}
          color="text-amber-400"
          value={`Wing: ±${wing * currentStep} pts`}
          sub={
            <span className="text-[10px] text-zinc-400">
              Ratio: 1 Buy : 2 Sell · Dual Profit Peaks at {wing * currentStep} pts
            </span>
          }
          badge={
            <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300">
              W={wing}
            </span>
          }
        />
      </div>

      {/* ─── Controls & Filter Bar ───────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 px-6 py-2.5 border-b border-zinc-800 bg-zinc-950/80 flex-wrap text-xs">
        {/* View Mode Tabs */}
        <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
          {[
            { id: 'matrix', label: 'Matrix View', icon: Layers },
            { id: 'curves', label: 'Term Curves', icon: BarChart2 },
            { id: 'breakevens', label: 'Corridors', icon: Compass },
          ].map(tab => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as typeof activeTab)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-bold transition-all cursor-pointer ${
                  active
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Filters Group */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Display Metric Selector (in Matrix mode) */}
          {activeTab === 'matrix' && (
            <div className="flex items-center gap-1.5 text-zinc-400 text-xs">
              <span>Show:</span>
              <select
                value={displayMetric}
                onChange={e => setDisplayMetric(e.target.value as typeof displayMetric)}
                className="bg-zinc-900 border border-zinc-800 text-white rounded-lg px-2.5 py-1 text-xs focus:outline-none focus:border-emerald-500"
              >
                <option value="all">All Metrics (Compact)</option>
                <option value="rom">RoM % Focus</option>
                <option value="premium">Net Credit Focus</option>
                <option value="earMax">Ear Max Profit Focus</option>
                <option value="pop">POP % Focus</option>
                <option value="breakeven">Breakevens</option>
              </select>
            </div>
          )}

          {/* Offset Depth Filter */}
          <div className="flex items-center gap-1.5 text-zinc-400 text-xs">
            <span>Rows:</span>
            <select
              value={offsetRowCount}
              onChange={e => setOffsetRowCount(Number(e.target.value))}
              className="bg-zinc-900 border border-zinc-800 text-white rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-emerald-500 font-mono"
            >
              {[8, 10, 12, 15].map(n => (
                <option key={n} value={n}>ATM±{n}</option>
              ))}
            </select>
          </div>

          {/* Risk Profile Filter */}
          <div className="flex items-center rounded-lg bg-zinc-900 border border-zinc-800 p-0.5">
            {(['all', 'conservative', 'moderate', 'aggressive'] as const).map(p => (
              <button
                key={p}
                onClick={() => setRiskProfile(p)}
                className={`px-2.5 py-1 text-[11px] font-bold capitalize rounded-md transition-all cursor-pointer ${
                  riskProfile === p
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          {/* Min RoM Threshold */}
          <div className="flex items-center gap-1.5 text-zinc-400 text-xs">
            <span>Min RoM:</span>
            <select
              value={minRomPct}
              onChange={e => setMinRomPct(Number(e.target.value))}
              className="bg-zinc-900 border border-zinc-800 text-white rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-emerald-500 font-mono"
            >
              <option value={0.1}>&ge;0.1%</option>
              <option value={0.5}>&ge;0.5%</option>
              <option value={1.0}>&ge;1.0%</option>
              <option value={1.5}>&ge;1.5%</option>
              <option value={2.0}>&ge;2.0%</option>
            </select>
          </div>
        </div>
      </div>

      {/* ─── Main Content Area ───────────────────────────────────────────── */}
      <main className="flex-1 p-6 overflow-x-auto">
        {error && (
          <div className="mb-4 p-4 rounded-xl bg-red-950/40 border border-red-800 text-red-400 text-xs flex items-center justify-between">
            <span><strong>Matrix Error:</strong> {error}</span>
            <button onClick={() => fetchMatrix(true)} className="px-2 py-1 rounded bg-red-900 text-white font-bold cursor-pointer">
              Retry
            </button>
          </div>
        )}

        {/* Loading Spinner */}
        {isLoading && (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-zinc-400 text-xs">
            <RefreshCw className="w-6 h-6 animate-spin text-emerald-400" />
            <span>Scanning option chains and computing cross-expiry Batman matrix…</span>
          </div>
        )}

        {/* ── TAB 1: MATRIX VIEW ─────────────────────────────────────────── */}
        {!isLoading && data?.expiries && data.rows && activeTab === 'matrix' && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-x-auto shadow-2xl">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-zinc-800 text-white font-bold text-xs uppercase tracking-wider sticky top-0 z-20">
                <tr className="border-b border-zinc-700">
                  <th className="py-3.5 px-4 sticky left-0 bg-zinc-800 z-30 min-w-[180px] shadow-sm border-r border-zinc-700">
                    <div className="flex items-center gap-1.5">
                      <span>Inner Offset (ATM±N)</span>
                    </div>
                    <div className="text-[10px] font-normal text-zinc-400 normal-case mt-0.5">
                      Span from ATM ({currentSpot ? `Spot: ${currentSpot.toLocaleString('en-IN')}` : ''})
                    </div>
                  </th>
                  {data?.expiries?.map((exp, i) => (
                    <th key={exp.expiry} className="py-3 px-3 text-center border-r border-zinc-700/80 min-w-[170px]">
                      <div className="flex flex-col items-center">
                        <span className="font-bold text-white text-xs">{exp.expiry}</span>
                        <span className="text-[10px] text-zinc-400 font-mono font-medium">
                          {exp.dte} DTE · ATM: {exp.atmStrike}
                        </span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80 text-zinc-300">
                {visibleRows.map(row => (
                  <tr key={row.offset} className="hover:bg-zinc-800/40 transition-colors group">
                    {/* Y-Axis Label */}
                    <td className="py-3 px-4 font-mono sticky left-0 bg-zinc-900 group-hover:bg-zinc-850 z-10 border-r border-zinc-800">
                      <div className="flex flex-col">
                        <span className="font-bold text-white text-xs">ATM±{row.offset}</span>
                        <span className="text-[10px] text-zinc-400">
                          ±{row.offset * currentStep}pts (Inner)
                        </span>
                        <span className="text-[9px] text-zinc-500 font-sans">
                          Outer Wing: ±{wing * currentStep}pts
                        </span>
                      </div>
                    </td>

                    {/* Expiry Cells */}
                    {row.cells.map((cell, idx) => {
                      const exp = data?.expiries?.[idx];
                      const visuals = getCellVisuals(cell);
                      if (!cell || !exp) {
                        return (
                          <td key={idx} className="py-3 px-3 text-center border-r border-zinc-800/60 bg-zinc-950/20 text-zinc-600 font-mono text-[10px]">
                            —
                          </td>
                        );
                      }

                      const netDisplay = unit === 'inr' ? `₹${(cell.netPremium * lots).toLocaleString('en-IN')}` : `${cell.netPremiumPoints.toFixed(1)} pts`;
                      const earDisplay = unit === 'inr' ? `₹${(cell.maxProfit * lots).toLocaleString('en-IN')}` : `${cell.maxProfitPoints.toFixed(1)} pts`;

                      return (
                        <td
                          key={exp.expiry}
                          onClick={() => setSelectedModal({ cell, expiry: exp.expiry, dte: exp.dte })}
                          className={`py-2.5 px-3 text-center border-r border-zinc-800/60 transition-all cursor-pointer select-none group relative ${visuals.bg} ${visuals.border}`}
                          title={`Click for drilldown: ${cell.shortPutStrike}P / ${cell.longPutStrike}P / ${cell.longCallStrike}C / ${cell.shortCallStrike}C`}
                        >
                          <div className="flex flex-col gap-1">
                            {/* Top row: RoM% & POP% */}
                            <div className="flex items-center justify-between text-[11px] font-mono">
                              <span className={`font-bold tabular-nums ${visuals.text}`}>
                                {cell.romPct.toFixed(1)}% RoM
                              </span>
                              <span className="text-[10px] text-zinc-400">
                                {cell.popPct}%
                              </span>
                            </div>

                            {/* Middle row: Net Credit & Ear Peak Profit */}
                            <div className="flex items-center justify-between text-xs font-mono font-bold">
                              <span className="text-white tabular-nums" title="Net Initial Credit (Floor Profit)">
                                {netDisplay}
                              </span>
                              <span className="text-cyan-400 tabular-nums text-[10px] font-sans" title="Ear Peak Profit at Short Strikes">
                                🦇 {earDisplay}
                              </span>
                            </div>

                            {/* Bottom row: Strikes Corridor */}
                            <div className="flex items-center justify-between text-[9px] font-mono text-zinc-400 pt-0.5 border-t border-zinc-800/40">
                              <span className="truncate">{cell.shortPutStrike}P .. {cell.shortCallStrike}C</span>
                              <span className="text-zinc-500">±{cell.distancePct.toFixed(1)}%</span>
                            </div>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── TAB 2: TERM STRUCTURE CURVES ───────────────────────────────── */}
        {!isLoading && data?.expiries && data.rows && activeTab === 'curves' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* RoM% vs DTE Curve */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                    Return on Margin (RoM %) Curves Across Expiries
                  </h3>
                  <p className="text-[11px] text-zinc-400">Comparing yield curves as inner strike offsets move further OTM</p>
                </div>
              </div>
              <div className="h-80 w-full pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={curveChartData} margin={{ top: 10, right: 20, left: 0, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="offset" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `${v}%`} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                    {data?.expiries?.map((exp, i) => {
                      const colors = ['#10b981', '#06b6d4', '#8b5cf6', '#f59e0b', '#ec4899'];
                      return (
                        <Line
                          key={exp.expiry}
                          type="monotone"
                          dataKey={`rom_${exp.expiry}`}
                          name={`${exp.expiry} (${exp.dte}d)`}
                          stroke={colors[i % colors.length]}
                          strokeWidth={2}
                          dot={{ r: 2 }}
                        />
                      );
                    })}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Ear Max Profit Curves */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                    Ear Peak Profit Potential ({unit === 'inr' ? '₹' : 'pts'})
                  </h3>
                  <p className="text-[11px] text-zinc-400">Max potential profit reached at the sold outer strikes</p>
                </div>
              </div>
              <div className="h-80 w-full pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={curveChartData} margin={{ top: 10, right: 20, left: 0, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="offset" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={v => unit === 'inr' ? `₹${(v/1000).toFixed(0)}k` : `${v}`} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                    {data?.expiries?.map((exp, i) => {
                      const colors = ['#06b6d4', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];
                      return (
                        <Line
                          key={exp.expiry}
                          type="monotone"
                          dataKey={`ear_${exp.expiry}`}
                          name={`${exp.expiry} (${exp.dte}d)`}
                          stroke={colors[i % colors.length]}
                          strokeWidth={2}
                          dot={{ r: 2 }}
                        />
                      );
                    })}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}

        {/* ── TAB 3: BREAKEVEN CORRIDORS ──────────────────────────────────── */}
        {!isLoading && data?.expiries && data.rows && activeTab === 'breakevens' && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                  Breakeven Corridors vs Current Spot
                </h3>
                <p className="text-[11px] text-zinc-400">Visualizing the expanding safety channels as offset moves out on nearest expiry</p>
              </div>
              <span className="text-xs font-mono font-bold text-amber-400 bg-zinc-950 px-3 py-1 rounded-lg border border-zinc-800">
                Spot: {currentSpot.toLocaleString('en-IN')}
              </span>
            </div>

            <div className="h-96 w-full pt-2">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={breakevenChartData} margin={{ top: 10, right: 20, left: 10, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="offset" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} domain={['dataMin - 200', 'dataMax + 200']} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                  <ReferenceLine y={currentSpot} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: 'SPOT', fill: '#f59e0b', fontSize: 10, position: 'insideTopRight' }} />
                  <Area type="monotone" dataKey="upperBe" name="Upper Breakeven" stroke="#06b6d4" fill="#06b6d4" fillOpacity={0.15} />
                  <Area type="monotone" dataKey="shortCall" name="Short Call (Ear)" stroke="#38bdf8" fill="#38bdf8" fillOpacity={0.2} />
                  <Area type="monotone" dataKey="shortPut" name="Short Put (Ear)" stroke="#c084fc" fill="#c084fc" fillOpacity={0.2} />
                  <Area type="monotone" dataKey="lowerBe" name="Lower Breakeven" stroke="#a855f7" fill="#a855f7" fillOpacity={0.15} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </main>

      {/* ─── Drilldown Modal ─────────────────────────────────────────────── */}
      <BatmanCellModal
        cell={selectedModal?.cell || null}
        expiry={selectedModal?.expiry || ''}
        dte={selectedModal?.dte || 0}
        underlying={underlying}
        spot={currentSpot}
        lotSize={currentLotSize}
        lots={lots}
        unit={unit}
        lastPolledAt={lastPolledAt}
        onClose={() => setSelectedModal(null)}
        onEnter={handleEnterTrade}
        entering={entering}
        enterError={enterError}
      />

      {/* ─── Readme / Strategy Guide Modal ───────────────────────────────── */}
      <BatmanReadmeModal open={readmeOpen} onClose={() => setReadmeOpen(false)} />
    </div>
  );
}
