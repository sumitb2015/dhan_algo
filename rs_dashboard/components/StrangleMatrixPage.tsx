'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity, Sliders, RefreshCw, Pause, Play, BookOpen, X,
  Layers, TrendingUp, TrendingDown, Shield, Zap, Info,
  Copy, Check, ChevronRight, BarChart2, Eye, Compass, Target, Sparkles, Send
} from 'lucide-react';
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine
} from 'recharts';
import type { StrangleCell } from '@/lib/strangleMath';
import type { UnderlyingType, RiskProfile } from '@/lib/ultimateScannerTypes';
import type { MultiLegBasket } from '@/lib/multiLegFocus';
import NavBar from './NavBar';

interface StrangleMatrixResponse {
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
  dataDate?: string;
  expiries?: { expiry: string; dte: number; atmStrike?: number }[];
  rows?: { offset: number; cells: (StrangleCell | null)[] }[];
  marginSweep?: { total: number; live: number; sweeping: boolean };
  stale?: boolean;
}

const POLL_MS = 4000;

function passesRiskProfile(cell: StrangleCell, profile: RiskProfile): boolean {
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
function StrangleReadmeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
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
              <h2 className="text-sm font-bold text-white tracking-tight">ATM-Offset Strangle Matrix Guide</h2>
              <p className="text-[11px] text-zinc-400">Mastering Return on Margin (RoM%), offset selection, and safety buffers</p>
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
            { id: 'concepts', label: '1. What is Strangle Matrix?' },
            { id: 'metrics', label: '2. RoM% & Breakeven Math' },
            { id: 'execution', label: '3. Optimal Strike Selection' },
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
                  <Zap className="w-3.5 h-3.5" /> Core Concept: ATM-Offset Symmetric Short Strangle
                </p>
                <p className="text-zinc-300 text-[11px]">
                  An ATM-Offset Strangle simultaneously sells 1 Out-of-The-Money (OTM) Put and 1 OTM Call at an equal number of strike intervals away from ATM (e.g., ATM±2 sells ATM-2 PE and ATM+2 CE).
                </p>
              </div>

              <div>
                <h4 className="text-zinc-100 font-bold mb-1.5 text-xs uppercase tracking-wider">How Offset (ATM±N) Works</h4>
                <p className="text-zinc-400 text-[11px]">
                  On NIFTY (strike step = 50 pts), if spot is 24,500:
                </p>
                <ul className="list-disc pl-5 mt-1.5 space-y-1 text-zinc-300 text-[11px]">
                  <li><strong className="text-zinc-100">ATM±1 (±50 pts):</strong> Sells 24,450 PE + 24,550 CE (High premium, close to ATM).</li>
                  <li><strong className="text-zinc-100">ATM±3 (±150 pts):</strong> Sells 24,350 PE + 24,650 CE (Balanced sweet spot for 1-2 week expiries).</li>
                  <li><strong className="text-zinc-100">ATM±6 (±300 pts):</strong> Sells 24,200 PE + 24,800 CE (High safety buffer, &gt;85% POP).</li>
                </ul>
              </div>

              <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800">
                <h4 className="text-zinc-100 font-bold mb-1 text-xs">Why This Cross-Expiry Matrix Matters</h4>
                <p className="text-zinc-400 text-[11px]">
                  Different expiries price volatility differently. The matrix allows instant comparison of annualized return versus distance % OTM across weekly and monthly cycles to spot mispriced premium sweet spots.
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
                    <span className="font-bold text-emerald-400 block">Return on Margin (RoM%)</span>
                    <p className="font-mono text-[11px] text-zinc-300">
                      RoM% = (Total Net Premium ₹ / SPAN Margin ₹) × 100
                    </p>
                    <p className="text-[10px] text-zinc-400">
                      Measures absolute cash return on capital blocked for the expiry cycle.
                    </p>
                  </div>

                  <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800 space-y-1">
                    <span className="font-bold text-cyan-400 block">Annualized RoM%</span>
                    <p className="font-mono text-[11px] text-zinc-300">
                      Annualized = (RoM% / DTE) × 365
                    </p>
                    <p className="text-[10px] text-zinc-400">
                      Standardizes return across different days to expiration.
                    </p>
                  </div>

                  <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800 space-y-1">
                    <span className="font-bold text-amber-400 block">Probability of Profit (POP%)</span>
                    <p className="font-mono text-[11px] text-zinc-300">
                      POP ≈ (1 − |Δ_PE| − |Δ_CE|) × Buffer
                    </p>
                    <p className="text-[10px] text-zinc-400">
                      Probability that spot stays between lower and upper breakevens at expiry.
                    </p>
                  </div>

                  <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800 space-y-1">
                    <span className="font-bold text-purple-400 block">Breakeven Tunnel</span>
                    <p className="font-mono text-[11px] text-zinc-300">
                      [PE Strike − Total Credit, CE Strike + Total Credit]
                    </p>
                    <p className="text-[10px] text-zinc-400">
                      Total points collection buffers the position on both upside and downside.
                    </p>
                  </div>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-zinc-900/80 border border-zinc-800">
                <h4 className="text-zinc-100 font-bold mb-1.5 text-xs">Color Coding Key in Matrix:</h4>
                <ul className="space-y-1 text-zinc-300 text-[11px]">
                  <li><span className="inline-block w-2.5 h-2.5 rounded bg-emerald-500/25 border border-emerald-500/60 mr-2" /><strong className="text-emerald-300">Great RoM (≥ 2.5%):</strong> Outstanding yield for the given distance.</li>
                  <li><span className="inline-block w-2.5 h-2.5 rounded bg-emerald-500/10 border border-emerald-500/30 mr-2" /><strong className="text-emerald-400">Good RoM (≥ 1.0%):</strong> Healthy premium decay rate.</li>
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
                    <strong className="text-zinc-100">Weekly Sweet Spot:</strong> For 3 to 7 DTE, targeting <strong>ATM±2 to ATM±4</strong> usually captures 1.2%–2.5% RoM with &gt;70% POP.
                  </li>
                  <li>
                    <strong className="text-zinc-100">Monthly Defence:</strong> For 15 to 30 DTE, targeting <strong>ATM±5 to ATM±8</strong> (2.5%–4.0% OTM distance) provides huge breathing room and steady theta decay.
                  </li>
                  <li>
                    <strong className="text-zinc-100">Profit Booking:</strong> Exit when 50%–70% of max credit is captured, or when DTE drops below 1 day to eliminate gamma risk.
                  </li>
                </ul>
              </div>

              <div className="p-3 rounded-xl bg-amber-950/20 border border-amber-500/30 text-amber-300 space-y-1 text-[11px]">
                <p className="font-bold flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5" /> Risk Management Rule
                </p>
                <p className="text-zinc-400">
                  Always maintain predefined stop loss (e.g. 50% to 100% of individual leg premium). If market trends heavily, roll the winning leg towards ATM to collect additional credit or hedge with long wings.
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
interface CellDetailModalProps {
  cell: StrangleCell | null;
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

function CellDetailModal({
  cell, expiry, dte, underlying, spot, lotSize, lots, unit, lastPolledAt, onClose, onEnter, entering, enterError
}: CellDetailModalProps) {
  const [copied, setCopied] = useState(false);

  if (!cell) return null;

  const totalQty = lots * lotSize;
  const totalCreditInr = cell.netPremiumPoints * totalQty;
  const totalMargin = cell.estMargin * lots;

  const handleCopyOrder = () => {
    const text = `SELL ${underlying} ${cell.putStrike} PE (${cell.putLtp.toFixed(2)}) + SELL ${underlying} ${cell.callStrike} CE (${cell.callLtp.toFixed(2)}) [Expiry: ${expiry}] | Net: ₹${Math.round(totalCreditInr).toLocaleString('en-IN')}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/80 backdrop-blur-md animate-in fade-in duration-150">
      <div className="relative w-full max-w-xl bg-zinc-950 border border-zinc-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/70">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white tracking-tight">
                  ATM±{cell.offset} Short Strangle
                </h3>
                <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                  {expiry} ({dte}d)
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                {underlying} @ {spot.toLocaleString('en-IN')} · Strike Span: {cell.putStrike} PE / {cell.callStrike} CE (±{cell.strikeDistancePoints} pts)
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
        <div className="p-6 space-y-5 text-xs">
          {/* Top Key Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800">
              <span className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">Total Credit</span>
              <span className="text-base font-mono font-bold text-emerald-400 block">
                ₹{Math.round(totalCreditInr).toLocaleString('en-IN')}
              </span>
              <span className="text-[10px] text-zinc-400">{cell.netPremiumPoints.toFixed(2)} pts ({lots} lot{lots > 1 ? 's' : ''})</span>
            </div>

            <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800">
              <span className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">Return on Margin</span>
              <span className="text-base font-mono font-bold text-cyan-300 block">
                {cell.romPct.toFixed(2)}%
              </span>
              <span className="text-[10px] text-zinc-400">{cell.romAnnualizedPct.toFixed(0)}% Annualized</span>
            </div>

            <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800">
              <span className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">Win Probability</span>
              <span className="text-base font-mono font-bold text-emerald-300 block">
                {cell.popPct}% POP
              </span>
              <span className="text-[10px] text-zinc-400">Risk: {cell.riskTier}</span>
            </div>

            <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800">
              <span className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">Safety Buffer</span>
              <span className="text-base font-mono font-bold text-amber-300 block">
                ±{cell.distancePct.toFixed(2)}%
              </span>
              <span className="text-[10px] text-zinc-400">{cell.distancePoints} pts OTM</span>
            </div>
          </div>

          {/* Leg Details (Put & Call) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* PUT Leg */}
            <div className="p-4 rounded-xl bg-purple-950/20 border border-purple-800/40 space-y-2">
              <div className="flex items-center justify-between pb-2 border-b border-purple-800/40">
                <span className="font-bold text-purple-300 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-purple-400" />
                  PUT (PE) LEG · SELL
                </span>
                <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  {cell.putStrike} PE
                </span>
              </div>
              <div className="space-y-1.5 font-mono text-xs">
                <div className="flex justify-between text-zinc-400 font-sans">
                  <span>Premium (LTP):</span>
                  <span className="text-zinc-100 font-bold font-mono">₹{cell.putLtp.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-zinc-400 font-sans">
                  <span>Delta (Δ):</span>
                  <span className="text-purple-300 font-mono">{cell.putDelta !== undefined ? cell.putDelta.toFixed(2) : '—'}</span>
                </div>
                <div className="flex justify-between text-zinc-400 font-sans">
                  <span>Implied Vol (IV):</span>
                  <span className="text-zinc-300 font-mono">{cell.putIv ? `${cell.putIv}%` : '—'}</span>
                </div>
                {cell.putOi && (
                  <div className="flex justify-between text-zinc-400 font-sans">
                    <span>Open Interest:</span>
                    <span className="text-zinc-300 font-mono">{(cell.putOi / 1000).toFixed(1)}k</span>
                  </div>
                )}
              </div>
            </div>

            {/* CALL Leg */}
            <div className="p-4 rounded-xl bg-sky-950/20 border border-sky-800/40 space-y-2">
              <div className="flex items-center justify-between pb-2 border-b border-sky-800/40">
                <span className="font-bold text-sky-300 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-sky-400" />
                  CALL (CE) LEG · SELL
                </span>
                <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30">
                  {cell.callStrike} CE
                </span>
              </div>
              <div className="space-y-1.5 font-mono text-xs">
                <div className="flex justify-between text-zinc-400 font-sans">
                  <span>Premium (LTP):</span>
                  <span className="text-zinc-100 font-bold font-mono">₹{cell.callLtp.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-zinc-400 font-sans">
                  <span>Delta (Δ):</span>
                  <span className="text-sky-300 font-mono">{cell.callDelta !== undefined ? cell.callDelta.toFixed(2) : '—'}</span>
                </div>
                <div className="flex justify-between text-zinc-400 font-sans">
                  <span>Implied Vol (IV):</span>
                  <span className="text-zinc-300 font-mono">{cell.callIv ? `${cell.callIv}%` : '—'}</span>
                </div>
                {cell.callOi && (
                  <div className="flex justify-between text-zinc-400 font-sans">
                    <span>Open Interest:</span>
                    <span className="text-zinc-300 font-mono">{(cell.callOi / 1000).toFixed(1)}k</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Breakeven Safety Tunnel Visualizer */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 space-y-2.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-bold text-zinc-300 flex items-center gap-1.5">
                <Compass className="w-3.5 h-3.5 text-amber-400" />
                Breakeven Safety Channel
              </span>
              <span className="text-zinc-400 font-mono">
                Total Corridor: <strong className="text-zinc-200">{cell.breakevenWidth} pts</strong> ({((cell.breakevenWidth / spot) * 100).toFixed(2)}%)
              </span>
            </div>

            {/* Visual Gauge */}
            <div className="relative pt-6 pb-2">
              <div className="h-2.5 rounded-full bg-zinc-800 overflow-hidden relative border border-zinc-700">
                <div className="absolute inset-y-0 left-1/4 right-1/4 bg-emerald-500/40 rounded-full" />
              </div>
              {/* Markers */}
              <div className="flex justify-between items-center text-[10px] font-mono text-zinc-400 mt-2">
                <div className="text-left">
                  <span className="text-purple-400 block font-bold">Lower BE</span>
                  <span>{cell.breakevens[0]}</span>
                </div>
                <div className="text-center">
                  <span className="text-amber-400 block font-bold">Current Spot</span>
                  <span className="text-white font-bold">{spot.toLocaleString('en-IN')}</span>
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
              {cell.marginSource === 'live' ? 'Live SPAN Margin' : 'Est. Blocked SPAN Margin'}
              {cell.marginSource === 'live' && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-emerald-400"
                  title="Priced via Dhan's margin calculator, not the flat estimate"
                />
              )}
              :
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
                Prices as of {new Date(lastPolledAt).toLocaleTimeString('en-IN')} — refreshes live while open
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
export default function StrangleMatrixPage() {
  const router = useRouter();
  const [underlying, setUnderlying] = useState<UnderlyingType>('NIFTY');
  const [data, setData] = useState<StrangleMatrixResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [readmeOpen, setReadmeOpen] = useState(false);

  // Active view tab
  const [activeTab, setActiveTab] = useState<'matrix' | 'curves' | 'breakevens'>('matrix');

  // Display configuration
  const [displayMetric, setDisplayMetric] = useState<'all' | 'rom' | 'premium' | 'pop' | 'breakeven'>('all');
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
    cell: StrangleCell;
    expiry: string;
    dte: number;
  } | null>(null);

  // Enter-trade (send to Multi-Leg Focus) state
  const [entering, setEntering] = useState(false);
  const [enterError, setEnterError] = useState<string | null>(null);
  const tradeInFlight = useRef(false);

  const handleEnterTrade = useCallback(async () => {
    if (!selectedModal || tradeInFlight.current) return;
    tradeInFlight.current = true;
    setEntering(true);
    setEnterError(null);
    try {
      const { cell, expiry } = selectedModal;
      const basket: Partial<MultiLegBasket> = {
        name: `ATM±${cell.offset} Short Strangle (${expiry})`,
        underlying,
        expiry,
        broker: 'dhan',
        presetKey: 'short-strangle',
        legs: [
          { id: '1', side: 'S', option: 'PE', strike: cell.putStrike, lots, type: 'MARKET', status: 'DRAFT' },
          { id: '2', side: 'S', option: 'CE', strike: cell.callStrike, lots, type: 'MARKET', status: 'DRAFT' },
        ],
      };
      await fetch('/api/multi-leg-focus/baskets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basket),
      });
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
      const res = await fetch(`/api/options/strangle-matrix?underlying=${underlying}`);
      const json = (await res.json()) as StrangleMatrixResponse;
      if (requestId !== pollRequestId.current) return;
      if (json.success) {
        setData(json);
        setError(null);
        setLastPolledAt(new Date().toISOString());
      } else {
        setError(json.error ?? 'Failed to load strangle matrix');
      }
    } catch (err) {
      if (requestId !== pollRequestId.current) return;
      setError(String((err as Error).message ?? err));
    } finally {
      if (requestId === pollRequestId.current && isManual) {
        setRefreshing(false);
      }
    }
  }, [underlying]);

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

  // Keep the drilldown modal's cell in sync with each new poll — without
  // this, "Copy Trade Legs" can copy LTPs from whenever the modal was
  // opened, tens of seconds stale, with nothing on screen to warn the user.
  useEffect(() => {
    if (!selectedModal || !data?.rows || !data.expiries) return;
    const expIdx = data.expiries.findIndex(e => e.expiry === selectedModal.expiry);
    if (expIdx === -1) return;
    const row = data.rows.find(r => r.offset === selectedModal.cell.offset);
    const freshCell = row?.cells[expIdx];
    if (freshCell && freshCell !== selectedModal.cell) {
      setSelectedModal(prev => (prev ? { ...prev, cell: freshCell } : prev));
    }
    // Only re-sync off `data` — re-running when selectedModal itself changes
    // (e.g. right after opening) would be a no-op loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Derived Summary Highlights — must respect the same active filters as the
  // matrix cells (offset depth, distance range, risk profile, Min RoM%), or
  // the "Top Pick" tiles can surface a cell the filtered table doesn't even
  // show. Same defect class already fixed once for getCellVisuals.
  const topStats = useMemo(() => {
    if (!data?.rows || data.rows.length === 0) return null;

    let bestRomCell: StrangleCell | null = null;
    let bestRomExpiry = '';
    let safestCell: StrangleCell | null = null;
    let safestExpiry = '';

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
          if (!safestCell || c.popPct > safestCell.popPct) {
            safestCell = c;
            safestExpiry = exp;
          }
        });
      });

    return {
      bestRomCell: bestRomCell as StrangleCell | null,
      bestRomExpiry,
      safestCell: safestCell as StrangleCell | null,
      safestExpiry,
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
            item[`prem_${exp}`] = unit === 'inr' ? c.netPremium * lots : c.netPremiumPoints;
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
          putStrike: c.putStrike,
          callStrike: c.callStrike,
          lowerBe: c.breakevens[0],
          upperBe: c.breakevens[1],
          spot,
          width: c.breakevenWidth,
        };
      })
      .filter(Boolean);
  }, [data, offsetRowCount]);

  function getCellVisuals(cell: StrangleCell | null): {
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

    if (!passesRiskProfile(cell, riskProfile)) {
      return {
        bg: 'bg-zinc-900/30',
        border: 'border-zinc-800/60',
        text: 'text-zinc-500',
        muted: true,
        isGreat: false,
        isGood: false,
      };
    }

    if (cell.romPct < minRomPct) {
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
        // emerald-500-based (not emerald-950) so the tint reads clearly against
        // the dark-mode page ground, not just in light mode — matches the
        // Great/Good legend swatches in CellDetailModal above.
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
            <Activity className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-bold text-emerald-500 uppercase tracking-[0.18em]">
                Live ATM-Offset Strangle Matrix
              </span>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-[9px] font-bold text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Live Volatility Grid
              </span>
            </div>
            <h1 className="text-base font-bold text-white tracking-tight leading-none mt-0.5">
              Strangle Matrix
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
                onClick={() => setUnderlying(u)}
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

          {/* Unit Toggle & Multiplier */}
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

          {/* Lots Multiplier (when in INR mode) */}
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

          {/* DATA Date Chip */}
          <span className="text-[10px] font-mono font-bold text-amber-300 px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 uppercase tracking-wide">
            DATA: {data?.dataDate || 'TODAY'}
          </span>

          {/* Live Margin Sweep Progress — background job fetches Dhan's real
              SPAN+exposure margin for every grid cell over ~1 req/s; this is
              the confirmation that the whole grid is priced off Dhan's real
              margin calculator rather than the flat per-underlying estimate. */}
          {data?.marginSweep && data.marginSweep.total > 0 && (
            <span
              className={`flex items-center gap-1.5 text-[10px] font-mono font-bold px-2.5 py-1.5 rounded-lg bg-zinc-900 border uppercase tracking-wide ${
                data.marginSweep.live >= data.marginSweep.total
                  ? 'text-emerald-300 border-emerald-500/40'
                  : 'text-amber-300 border-zinc-800'
              }`}
              title="Cells priced with Dhan's real multi-leg margin calculator vs. the flat per-underlying estimate"
            >
              {data.marginSweep.live >= data.marginSweep.total ? (
                <>
                  <Check className="w-3 h-3" />
                  ALL MARGINS LIVE ({data.marginSweep.total})
                </>
              ) : (
                <>LIVE MARGIN: {data.marginSweep.live}/{data.marginSweep.total}{data.marginSweep.sweeping ? '…' : ''}</>
              )}
            </span>
          )}

          {/* Pause / Resume Button */}
          <button
            onClick={() => setPaused(p => !p)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-semibold text-zinc-300 hover:text-white transition-all cursor-pointer"
          >
            {paused ? <Play className="w-3.5 h-3.5 text-emerald-400" /> : <Pause className="w-3.5 h-3.5 text-amber-400" />}
            <span>{paused ? 'Resume' : 'Pause'}</span>
          </button>

          {/* Manual Refresh */}
          <button
            onClick={() => fetchMatrix(true)}
            disabled={refreshing}
            className="h-8 w-8 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-emerald-400 hover:border-emerald-500/40 transition-colors disabled:opacity-50 cursor-pointer"
            title="Refresh strangle matrix"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin text-emerald-400' : ''}`} />
          </button>

          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </header>

      {/* ─── Main Workspace ──────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col px-6 py-5 max-w-[1600px] mx-auto w-full gap-5">
        {/* Top Pulse Stats Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <PulseStat
            label={`${underlying} Spot`}
            value={currentSpot > 0 ? currentSpot.toLocaleString('en-IN') : '—'}
            sub={
              currentSpot > 0 ? (
                <span className={currentChange >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                  {currentChange >= 0 ? '+' : ''}{currentChange.toFixed(2)} ({currentChangePct.toFixed(2)}%)
                </span>
              ) : 'Loading...'
            }
            icon={Compass}
            color="text-white"
          />

          <PulseStat
            label="ATM Strike"
            value={data?.atmStrike ? data.atmStrike.toLocaleString('en-IN') : '—'}
            sub={`Strike Step: ±${currentStep} pts`}
            icon={Target}
            color="text-emerald-300"
          />

          <PulseStat
            label="Top Yield Pick"
            value={
              topStats?.bestRomCell
                ? `ATM±${topStats.bestRomCell.offset} (${topStats.bestRomCell.romPct.toFixed(1)}%)`
                : '—'
            }
            sub={topStats?.bestRomExpiry ? `Exp: ${topStats.bestRomExpiry}` : 'Calculating...'}
            icon={Zap}
            color="text-emerald-400"
          />

          <PulseStat
            label="Highest Safety Pick"
            value={
              topStats?.safestCell
                ? `ATM±${topStats.safestCell.offset} (${topStats.safestCell.popPct}% POP)`
                : '—'
            }
            sub={topStats?.safestCell ? `±${topStats.safestCell.distancePct.toFixed(1)}% OTM` : 'Calculating...'}
            icon={Shield}
            color="text-cyan-300"
          />

          <PulseStat
            label="Est. SPAN Margin"
            value={topStats?.bestRomCell ? `₹${(topStats.bestRomCell.estMargin * lots).toLocaleString('en-IN')}` : '—'}
            sub={`Lot Size: ${currentLotSize} (${lots} lot${lots > 1 ? 's' : ''})`}
            icon={Layers}
            color="text-zinc-200"
          />

          <PulseStat
            label="Active Expiries"
            value={data?.expiries ? `${data.expiries.length} Cycles` : '—'}
            sub={lastPolledAt ? `Updated ${new Date(lastPolledAt).toLocaleTimeString('en-IN')}` : 'Polling...'}
            icon={Activity}
            color="text-zinc-300"
            badge={data?.stale ? (
              <span
                className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40"
                title="Dhan's live feed is unreachable — showing the last successful snapshot, not current prices"
              >
                STALE
              </span>
            ) : undefined}
          />
        </div>

        {/* ─── Interactive Controls & Filter Bar ────────────────────────────── */}
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-4 flex flex-col gap-4 shadow-xl">
          {/* Top Row: View Tabs & Metric Focus */}
          <div className="flex items-center justify-between gap-3 flex-wrap pb-3 border-b border-zinc-800/80">
            {/* View Mode Tabs */}
            <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 p-1 rounded-xl">
              {[
                { id: 'matrix', label: 'Heatmap Grid', icon: Layers },
                { id: 'curves', label: 'RoM & Premium Curves', icon: BarChart2 },
                { id: 'breakevens', label: 'Safety Corridor', icon: Compass },
              ].map(tab => {
                const TabIcon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as typeof activeTab)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                      activeTab === tab.id
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <TabIcon className="w-3.5 h-3.5" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Metric Focus Selector */}
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Metric Focus:</span>
              <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 p-1 rounded-xl">
                {[
                  { id: 'all', label: 'Comprehensive' },
                  { id: 'rom', label: 'RoM% Heatmap' },
                  { id: 'premium', label: 'Credit ₹/pts' },
                  { id: 'pop', label: 'POP & Distance' },
                  { id: 'breakeven', label: 'Breakevens' },
                ].map(m => (
                  <button
                    key={m.id}
                    onClick={() => setDisplayMetric(m.id as typeof displayMetric)}
                    className={`px-2.5 py-1 text-[11px] font-bold rounded-lg transition-all cursor-pointer ${
                      displayMetric === m.id
                        ? 'bg-zinc-800 text-white border border-zinc-700 shadow-sm'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Bottom Row: Filter Sliders */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            {/* Offset Depth */}
            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                <span>Offset Depth: ATM±1 to ±{offsetRowCount}</span>
                <span className="font-mono text-emerald-400">±{offsetRowCount * currentStep} pts</span>
              </div>
              <input
                type="range" min="3" max="15" step="1"
                value={offsetRowCount}
                onChange={e => setOffsetRowCount(parseInt(e.target.value, 10))}
                className="w-full accent-emerald-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
              />
            </div>

            {/* Min RoM % */}
            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                <span>Min RoM%: {minRomPct.toFixed(1)}%</span>
                <span className="font-mono text-cyan-400">Yield Filter</span>
              </div>
              <input
                type="range" min="0" max="6" step="0.2"
                value={minRomPct}
                onChange={e => setMinRomPct(parseFloat(e.target.value))}
                className="w-full accent-cyan-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
              />
            </div>

            {/* Distance % OTM */}
            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                <span>Distance % OTM: {minDistancePct.toFixed(1)}%–{maxDistancePct.toFixed(1)}%</span>
                <span className="font-mono text-amber-400">Safety Buffer</span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="range" min="0.2" max="6" step="0.2"
                  value={minDistancePct}
                  onChange={e => {
                    const v = parseFloat(e.target.value);
                    setMinDistancePct(v);
                    if (v > maxDistancePct) setMaxDistancePct(v);
                  }}
                  className="w-full accent-amber-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
                />
                <input
                  type="range" min="0.2" max="8" step="0.2"
                  value={maxDistancePct}
                  onChange={e => {
                    const v = parseFloat(e.target.value);
                    setMaxDistancePct(v);
                    if (v < minDistancePct) setMinDistancePct(v);
                  }}
                  className="w-full accent-amber-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
                />
              </div>
            </div>

            {/* Risk Profile Selector */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                Risk Classification
              </span>
              <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 p-1 rounded-xl">
                {(['all', 'conservative', 'moderate', 'aggressive'] as const).map(p => (
                  <button
                    key={p}
                    onClick={() => setRiskProfile(p)}
                    className={`flex-1 py-1.5 text-[11px] font-semibold capitalize rounded-lg transition-all cursor-pointer ${
                      riskProfile === p
                        ? 'bg-zinc-800 text-white border border-zinc-700'
                        : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {p === 'all' ? 'All' : p.slice(0, 4)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="p-4 rounded-xl bg-red-950/40 border border-red-800/60 text-red-400 text-xs flex items-center justify-between">
            <div>
              <strong>Error Loading Matrix:</strong> {error}
            </div>
            <button
              onClick={() => fetchMatrix(true)}
              className="px-3 py-1 bg-red-900/60 hover:bg-red-800/80 rounded-lg text-white font-bold text-[11px] transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading Spinner */}
        {!data && !error && (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-zinc-400 text-xs">
            <RefreshCw className="w-6 h-6 animate-spin text-emerald-400" />
            <span>Scanning option chains and computing cross-expiry strangle matrix…</span>
          </div>
        )}

        {/* ─── TAB 1: HERO HEATMAP MATRIX ─────────────────────────────────── */}
        {data?.expiries && data.rows && activeTab === 'matrix' && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-x-auto shadow-2xl">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-zinc-800 text-white font-bold text-xs uppercase tracking-wider sticky top-0 z-20">
                <tr className="border-b border-zinc-700">
                  <th className="py-3.5 px-4 sticky left-0 bg-zinc-800 z-30 min-w-[180px] shadow-sm">
                    <div className="flex items-center gap-1.5">
                      <span>Offset / Strike Pair</span>
                    </div>
                    <div className="text-[10px] font-normal text-zinc-400 normal-case mt-0.5">
                      Span from ATM ({currentSpot ? `Spot: ${currentSpot}` : ''})
                    </div>
                  </th>
                  {data.expiries.map(e => (
                    <th key={e.expiry} className="py-3.5 px-4 text-center min-w-[190px] border-l border-zinc-700/60">
                      <div className="text-white font-bold text-xs flex items-center justify-center gap-1.5">
                        <span>{e.expiry}</span>
                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                          {e.dte}d
                        </span>
                      </div>
                      <div className="text-[10px] font-normal text-zinc-400 normal-case mt-0.5">
                        ATM: <strong className="text-zinc-300">{e.atmStrike || data.atmStrike}</strong>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800 text-zinc-300">
                {visibleRows.map(row => {
                  const repCell = row.cells.find(c => c !== null) ?? null;
                  return (
                    <tr key={row.offset} className="hover:bg-zinc-800/40 transition-colors group">
                      {/* Sticky Left Column */}
                      <td className="py-3 px-4 font-bold text-white sticky left-0 bg-zinc-900 group-hover:bg-zinc-800/80 z-10 border-r border-zinc-800">
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-0.5 rounded-md bg-zinc-800 border border-zinc-700 text-xs font-mono font-bold text-emerald-400">
                            ATM±{row.offset}
                          </span>
                          <span className="text-[11px] font-mono text-zinc-400 font-normal">
                            ±{row.offset * currentStep} pts
                          </span>
                        </div>
                        {repCell && (
                          <div className="text-[11px] font-mono font-medium text-zinc-300 mt-1 flex items-center gap-1">
                            <span className="text-purple-300">{repCell.putStrike} PE</span>
                            <span className="text-zinc-500">/</span>
                            <span className="text-sky-300">{repCell.callStrike} CE</span>
                          </div>
                        )}
                      </td>

                      {/* Expiry Cells */}
                      {row.cells.map((cell, i) => {
                        const expiryObj = data.expiries![i];
                        const visuals = getCellVisuals(cell);
                        const creditVal = cell
                          ? unit === 'inr'
                            ? `₹${Math.round(cell.netPremiumPoints * currentLotSize * lots).toLocaleString('en-IN')}`
                            : `${cell.netPremiumPoints.toFixed(2)} pts`
                          : '—';

                        return (
                          <td
                            key={expiryObj.expiry}
                            onClick={() => {
                              if (cell) {
                                setEnterError(null);
                                setSelectedModal({
                                  cell,
                                  expiry: expiryObj.expiry,
                                  dte: expiryObj.dte,
                                });
                              }
                            }}
                            className={`py-3 px-3 text-center border-l border-zinc-800/60 transition-all ${visuals.bg} ${cell ? 'cursor-pointer hover:ring-1 hover:ring-emerald-500/50 hover:shadow-lg' : ''}`}
                          >
                            {cell ? (
                              <div className="flex flex-col gap-1 items-center">
                                {/* Metric View: RoM Focus */}
                                {displayMetric === 'rom' && (
                                  <>
                                    <div className="text-base font-mono font-bold text-emerald-300">
                                      {cell.romPct.toFixed(2)}%
                                    </div>
                                    <div className="text-[10px] text-zinc-400 font-mono">
                                      {cell.romAnnualizedPct.toFixed(0)}% Ann.
                                    </div>
                                    <div className="text-[10px] text-zinc-500">
                                      Credit: {creditVal}
                                    </div>
                                  </>
                                )}

                                {/* Metric View: Credit Focus */}
                                {displayMetric === 'premium' && (
                                  <>
                                    <div className="text-sm font-mono font-bold text-white">
                                      {creditVal}
                                    </div>
                                    <div className="text-[10px] text-emerald-400 font-mono">
                                      RoM: {cell.romPct.toFixed(2)}%
                                    </div>
                                    <div className="text-[10px] text-zinc-400">
                                      PE: ₹{cell.putLtp.toFixed(1)} | CE: ₹{cell.callLtp.toFixed(1)}
                                    </div>
                                  </>
                                )}

                                {/* Metric View: POP & Distance */}
                                {displayMetric === 'pop' && (
                                  <>
                                    <div className="text-sm font-mono font-bold text-cyan-300">
                                      {cell.popPct}% POP
                                    </div>
                                    <div className="text-[10px] text-amber-300 font-mono">
                                      ±{cell.distancePct.toFixed(2)}% ({cell.distancePoints} pts)
                                    </div>
                                    <div className="text-[10px] text-zinc-400">
                                      Tier: {cell.riskTier}
                                    </div>
                                  </>
                                )}

                                {/* Metric View: Breakevens */}
                                {displayMetric === 'breakeven' && (
                                  <>
                                    <div className="text-[11px] font-mono font-bold text-purple-300">
                                      BE: {cell.breakevens[0]}
                                    </div>
                                    <div className="text-[11px] font-mono font-bold text-sky-300">
                                      to {cell.breakevens[1]}
                                    </div>
                                    <div className="text-[10px] text-zinc-400 font-mono">
                                      Width: {cell.breakevenWidth} pts
                                    </div>
                                  </>
                                )}

                                {/* Metric View: Comprehensive (All Details) */}
                                {displayMetric === 'all' && (
                                  <>
                                    <div className="flex items-center justify-between w-full">
                                      <span className="font-mono font-bold text-white text-xs">
                                        {creditVal}
                                      </span>
                                      <span className={`text-[10px] font-mono font-bold px-1.5 py-0.2 rounded border ${
                                        visuals.isGreat
                                          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                                          : visuals.isGood
                                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                                          : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                                      }`}>
                                        {cell.romPct.toFixed(2)}%
                                      </span>
                                    </div>

                                    <div className="flex items-center justify-between w-full text-[10px] text-zinc-400 font-mono">
                                      <span>±{cell.distancePct.toFixed(2)}% OTM</span>
                                      <span className="text-cyan-400 font-semibold">{cell.popPct}% POP</span>
                                    </div>

                                    <div className="flex items-center justify-between w-full text-[9px] text-zinc-500">
                                      <span>{cell.romAnnualizedPct.toFixed(0)}% Ann.</span>
                                      <span>Δ {cell.deltaNet >= 0 ? `+${cell.deltaNet}` : cell.deltaNet}</span>
                                    </div>
                                  </>
                                )}
                              </div>
                            ) : (
                              <span className="text-zinc-600 font-mono text-xs">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {visibleRows.length === 0 && (
              <div className="py-16 text-center text-xs text-zinc-400">
                No strangle offsets match the current filter criteria. Adjust the sliders above.
              </div>
            )}
          </div>
        )}

        {/* ─── TAB 2: CURVES & CHARTS ──────────────────────────────────────── */}
        {data?.expiries && data.rows && activeTab === 'curves' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* RoM % Decay Curve */}
            <div className="p-5 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-xl flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-white">Return on Margin (RoM%) by Offset</h3>
                  <p className="text-[11px] text-zinc-400">Comparing return decay across strike distance for each expiry</p>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                  RoM%
                </span>
              </div>
              <div className="h-72 w-full pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={curveChartData}>
                    {/* Grid/axis/tooltip chrome intentionally carries no stroke/fill/contentStyle —
                        app/globals.css themes Recharts chrome globally by class name (dhan-theme-tokens skill);
                        hardcoding hex here would be dead code that silently disagrees with the theme. */}
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="offset" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `${v}%`} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                    {data.expiries.map((e, idx) => {
                      const colors = ['#10b981', '#06b6d4', '#8b5cf6', '#f59e0b', '#ec4899'];
                      return (
                        <Line
                          key={e.expiry}
                          type="monotone"
                          dataKey={`rom_${e.expiry}`}
                          name={`${e.expiry} (${e.dte}d)`}
                          stroke={colors[idx % colors.length]}
                          strokeWidth={2}
                          dot={{ r: 3 }}
                        />
                      );
                    })}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Total Premium Decay Curve */}
            <div className="p-5 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-xl flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Net Premium Collection ({unit === 'inr' ? '₹ Total' : 'Points'})
                  </h3>
                  <p className="text-[11px] text-zinc-400">Total credit received as offset increases</p>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/30">
                  {unit === 'inr' ? `₹ (Lots: ${lots})` : 'Points'}
                </span>
              </div>
              <div className="h-72 w-full pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={curveChartData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="offset" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={v => unit === 'inr' ? `₹${(v/1000).toFixed(0)}k` : `${v}`} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                    {data.expiries.map((e, idx) => {
                      const colors = ['#10b981', '#06b6d4', '#8b5cf6', '#f59e0b', '#ec4899'];
                      return (
                        <Area
                          key={e.expiry}
                          type="monotone"
                          dataKey={`prem_${e.expiry}`}
                          name={`${e.expiry} (${e.dte}d)`}
                          stroke={colors[idx % colors.length]}
                          fill={colors[idx % colors.length]}
                          fillOpacity={0.15}
                          strokeWidth={2}
                        />
                      );
                    })}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}

        {/* ─── TAB 3: BREAKEVEN CORRIDOR ───────────────────────────────────── */}
        {data?.expiries && data.rows && activeTab === 'breakevens' && (
          <div className="p-5 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-xl flex flex-col gap-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <h3 className="text-sm font-bold text-white">Breakeven Safety Corridor</h3>
                <p className="text-[11px] text-zinc-400">
                  Lower &amp; Upper Breakevens vs Current Spot ({currentSpot.toLocaleString('en-IN')}) for {data.expiries[0]?.expiry}
                </p>
              </div>
              <span className="text-[10px] font-mono px-2.5 py-1 rounded bg-amber-500/10 text-amber-400 border border-amber-500/30 font-bold">
                Front Expiry: {data.expiries[0]?.expiry}
              </span>
            </div>

            <div className="h-80 w-full pt-2">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={breakevenChartData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="offset" tick={{ fontSize: 10 }} />
                  <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                  <ReferenceLine y={currentSpot} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: `Spot: ${currentSpot}`, fill: '#f59e0b', fontSize: 10, position: 'insideTopRight' }} />
                  <Line type="monotone" dataKey="upperBe" name="Upper Breakeven" stroke="#06b6d4" strokeWidth={2} dot={{ r: 3 }} />
                  <Line type="monotone" dataKey="callStrike" name="Call Strike" stroke="#38bdf8" strokeDasharray="3 3" strokeWidth={1} dot={false} />
                  <Line type="monotone" dataKey="putStrike" name="Put Strike" stroke="#c084fc" strokeDasharray="3 3" strokeWidth={1} dot={false} />
                  <Line type="monotone" dataKey="lowerBe" name="Lower Breakeven" stroke="#a855f7" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </main>

      {/* ─── Modals ──────────────────────────────────────────────────────── */}
      <StrangleReadmeModal
        open={readmeOpen}
        onClose={() => setReadmeOpen(false)}
      />

      <CellDetailModal
        cell={selectedModal?.cell ?? null}
        expiry={selectedModal?.expiry ?? ''}
        dte={selectedModal?.dte ?? 0}
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
    </div>
  );
}
