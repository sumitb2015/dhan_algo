'use client';

import React, { useState } from 'react';
import {
  Crosshair,
  ShieldCheck,
  AlertTriangle,
  Zap,
  Target,
  CheckCircle2,
  XCircle,
  HelpCircle,
  TrendingUp,
  TrendingDown,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Sparkles,
  ArrowRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { cyberAudio } from '@/lib/cyberAudio';

export interface StrategyData {
  setup_key: string;
  setup_name: string;
  setup_quality: 'A+' | 'HIGH' | 'GOOD' | 'CAUTION' | 'LOW';
  badge_text: string;
  action_headline: string;
  action_detail: string;
  atr14: number;
  dist_ema9: number;
  dist_ema20: number;
  dist_ema20_pct: number;
  in_value_zone: boolean;
  value_zone_low: number;
  value_zone_high: number;
  extension_ratio: number;
  is_overextended: boolean;
  sl_anchor: number;
  target_1: number;
  target_2: number;
  sl_pts: number;
  target_pts: number;
  rr_ratio: number;
  crossover: {
    bars_since_cross: number;
    cross_type: string;
    cross_price: number;
    cross_time: string;
  };
  checklist: {
    vwap_aligned: boolean;
    ema_stacked: boolean;
    spread_velocity: boolean;
    in_sweet_spot: boolean;
    controlled_risk: boolean;
    score: number;
    max_score: number;
  };
}

interface StrategyIntelligenceProps {
  spot: number;
  strategy: StrategyData | null;
  onApplyLevels?: (targetPts: number, slPts: number) => void;
}

export default function CyberStrategyIntelligence({
  spot,
  strategy,
  onApplyLevels,
}: StrategyIntelligenceProps) {
  const [showPlaybook, setShowPlaybook] = useState(false);

  if (!strategy) {
    return null;
  }

  const {
    setup_quality,
    setup_name,
    badge_text,
    action_headline,
    action_detail,
    atr14,
    dist_ema20,
    extension_ratio,
    in_value_zone,
    value_zone_low,
    value_zone_high,
    sl_anchor,
    target_1,
    target_2,
    sl_pts,
    target_pts,
    rr_ratio,
    crossover,
    checklist,
  } = strategy;

  const isAplus = setup_quality === 'A+';
  const isHigh = setup_quality === 'HIGH';
  const isCaution = setup_quality === 'CAUTION';
  const isLow = setup_quality === 'LOW';

  // Quality badge theme
  const qualityTheme = isAplus
    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 shadow-emerald-500/10'
    : isHigh
    ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 shadow-cyan-500/10'
    : isCaution
    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-amber-500/10'
    : isLow
    ? 'bg-zinc-800 text-zinc-400 border-zinc-700'
    : 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40 shadow-indigo-500/10';

  return (
    <div className="relative bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4 lg:p-5 backdrop-blur-md shadow-2xl transition-all">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4 pb-3 border-b border-zinc-800">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25 shrink-0">
            <Crosshair className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-[0.18em]">
                STRATEGY ENGINE · 9/20 EMA & VWAP
              </span>
              <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-zinc-800 text-zinc-300 border border-zinc-700">
                ATR(14): {atr14.toFixed(1)} pts
              </span>
            </div>
            <h2 className="text-sm font-bold text-white tracking-tight flex items-center gap-2">
              <span>{setup_name}</span>
              <span className={cn('px-2 py-0.5 rounded text-[10px] font-mono font-bold border', qualityTheme)}>
                {setup_quality} GRADE
              </span>
            </h2>
          </div>
        </div>

        {/* Playbook Rules Toggle */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              cyberAudio.click();
              setShowPlaybook(!showPlaybook);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 border border-zinc-700 text-zinc-300 hover:text-white text-xs font-mono font-bold transition-all"
          >
            <BookOpen className="w-3.5 h-3.5 text-cyan-400" />
            <span>9/20 SCALP RULES</span>
            {showPlaybook ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Main 3-Column Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Column 1: Active Setup & Action Recommendation */}
        <div className="bg-zinc-950/70 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 mb-1.5">
              <span>TACTICAL SCALP ACTION</span>
              <span className={cn('px-2 py-0.5 rounded text-[9px] font-bold font-mono border', qualityTheme)}>
                {badge_text}
              </span>
            </div>
            <h3
              className={cn(
                'text-base font-black tracking-tight mb-2 flex items-center gap-1.5',
                isAplus || isHigh ? 'text-emerald-400' : isCaution ? 'text-amber-400' : 'text-zinc-200'
              )}
            >
              {action_headline}
            </h3>
            <p className="text-xs text-zinc-400 font-sans leading-relaxed mb-4">
              {action_detail}
            </p>
          </div>

          <div className="space-y-2 pt-3 border-t border-zinc-800/80 font-mono text-xs">
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Value Zone (9/20 Pocket):</span>
              <span
                className={cn(
                  'font-bold tabular-nums',
                  in_value_zone ? 'text-emerald-400' : 'text-zinc-300'
                )}
              >
                ₹{value_zone_low.toFixed(1)} — ₹{value_zone_high.toFixed(1)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Dist to 20 EMA:</span>
              <span
                className={cn(
                  'font-bold tabular-nums',
                  Math.abs(dist_ema20) < atr14 ? 'text-emerald-400' : 'text-zinc-300'
                )}
              >
                {dist_ema20 >= 0 ? `+${dist_ema20.toFixed(1)}` : dist_ema20.toFixed(1)} pts ({extension_ratio.toFixed(1)}x ATR)
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Recent Crossover:</span>
              <span className="text-zinc-300 font-bold tabular-nums">
                {crossover.cross_type !== 'NONE'
                  ? `${crossover.cross_type.replace('_', ' ')} (${crossover.bars_since_cross}m ago @ ${crossover.cross_time})`
                  : 'Steady Stack'}
              </span>
            </div>
          </div>
        </div>

        {/* Column 2: 5-Point Confluence Matrix */}
        <div className="bg-zinc-950/70 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 mb-2">
              <span>CONFLUENCE CHECKLIST</span>
              <span
                className={cn(
                  'px-2 py-0.5 rounded text-[10px] font-mono font-bold border',
                  checklist.score >= 4
                    ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                    : checklist.score >= 3
                    ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40'
                    : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                )}
              >
                SCORE: {checklist.score} / {checklist.max_score}
              </span>
            </div>

            {/* Visual Progress Bar */}
            <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden mb-3">
              <div
                className={cn(
                  'h-full transition-all duration-300',
                  checklist.score >= 4
                    ? 'bg-emerald-500'
                    : checklist.score >= 3
                    ? 'bg-cyan-500'
                    : checklist.score >= 2
                    ? 'bg-amber-500'
                    : 'bg-rose-500'
                )}
                style={{ width: `${(checklist.score / checklist.max_score) * 100}%` }}
              />
            </div>

            {/* Checklist items */}
            <div className="space-y-2 text-xs font-mono">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400 flex items-center gap-1.5">
                  {checklist.vwap_aligned ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                  )}
                  <span>1. Institutional VWAP Bias</span>
                </span>
                <span className={checklist.vwap_aligned ? 'text-emerald-400 font-bold' : 'text-zinc-500'}>
                  {checklist.vwap_aligned ? 'PASSED' : 'CONTRADICT'}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-zinc-400 flex items-center gap-1.5">
                  {checklist.ema_stacked ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                  )}
                  <span>2. 9/20 EMA Directional Stack</span>
                </span>
                <span className={checklist.ema_stacked ? 'text-emerald-400 font-bold' : 'text-zinc-500'}>
                  {checklist.ema_stacked ? 'ALIGNED' : 'FLAT/CROSS'}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-zinc-400 flex items-center gap-1.5">
                  {checklist.spread_velocity ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
                  )}
                  <span>3. Momentum Spread Velocity</span>
                </span>
                <span className={checklist.spread_velocity ? 'text-emerald-400 font-bold' : 'text-zinc-500'}>
                  {checklist.spread_velocity ? 'EXPANDING' : 'SLOWING'}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-zinc-400 flex items-center gap-1.5">
                  {checklist.in_sweet_spot ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
                  )}
                  <span>4. Value Zone Sweet-Spot</span>
                </span>
                <span className={checklist.in_sweet_spot ? 'text-emerald-400 font-bold' : 'text-zinc-500'}>
                  {checklist.in_sweet_spot ? 'POCKET' : 'OUTSIDE'}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-zinc-400 flex items-center gap-1.5">
                  {checklist.controlled_risk ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  )}
                  <span>5. Controlled Extension Risk</span>
                </span>
                <span className={checklist.controlled_risk ? 'text-emerald-400 font-bold' : 'text-amber-400 font-bold'}>
                  {checklist.controlled_risk ? 'SAFE' : 'OVEREXTENDED'}
                </span>
              </div>
            </div>
          </div>

          <p className="text-[10px] text-zinc-500 font-mono mt-3 pt-2 border-t border-zinc-800">
            {checklist.score >= 4
              ? '✓ Prime conditions for high-probability scalping.'
              : checklist.score >= 3
              ? '• Decent confluence. Keep stop tight and protect capital.'
              : '⚠ Low conviction zone. Stand aside or wait for 9/20 retest.'}
          </p>
        </div>

        {/* Column 3: Quant Scalp Risk & Target Levels */}
        <div className="bg-zinc-950/70 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 mb-2">
              <span>QUANT SL & TARGET ANCHORS</span>
              <span className="text-[10px] text-cyan-400 font-bold font-mono">
                R:R = 1 : {rr_ratio.toFixed(1)}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 mb-3 text-center">
              <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                <span className="text-[9px] font-mono text-zinc-500 block">CURRENT SPOT</span>
                <span className="text-xs font-mono font-black text-white tabular-nums">
                  ₹{spot.toFixed(1)}
                </span>
              </div>
              <div className="p-2 rounded-lg bg-rose-950/30 border border-rose-900/40">
                <span className="text-[9px] font-mono text-rose-400 block">SL ANCHOR</span>
                <span className="text-xs font-mono font-black text-rose-300 tabular-nums">
                  ₹{sl_anchor.toFixed(1)}
                </span>
                <span className="text-[9px] font-mono text-rose-400/80 block tabular-nums">
                  (-{sl_pts.toFixed(1)} pts)
                </span>
              </div>
              <div className="p-2 rounded-lg bg-emerald-950/30 border border-emerald-900/40">
                <span className="text-[9px] font-mono text-emerald-400 block">TARGET 1 (1.2R)</span>
                <span className="text-xs font-mono font-black text-emerald-300 tabular-nums">
                  ₹{target_1.toFixed(1)}
                </span>
                <span className="text-[9px] font-mono text-emerald-400/80 block tabular-nums">
                  (+{target_pts.toFixed(1)} pts)
                </span>
              </div>
            </div>

            <div className="p-2.5 rounded-lg bg-zinc-900/60 border border-zinc-800 text-[11px] font-mono space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-zinc-500">Runner Target 2 (2.2R):</span>
                <span className="text-emerald-400 font-bold tabular-nums">
                  ₹{target_2.toFixed(1)} (+{(target_pts * 1.8).toFixed(1)} pts)
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-500">SL Baseline Logic:</span>
                <span className="text-zinc-300 font-medium">
                  20 EMA ± 0.5 ATR
                </span>
              </div>
            </div>
          </div>

          {/* 1-Click Apply Button */}
          {onApplyLevels && (
            <button
              onClick={() => {
                cyberAudio.click();
                onApplyLevels(Math.round(target_pts), Math.round(sl_pts));
              }}
              className="mt-3 w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-mono font-bold transition-all shadow-md active:scale-95 flex items-center justify-center gap-1.5"
            >
              <Zap className="w-3.5 h-3.5" />
              <span>APPLY STRATEGY SL ({Math.round(sl_pts)} pts) & TP ({Math.round(target_pts)} pts) TO PAD</span>
            </button>
          )}
        </div>
      </div>

      {/* Expandable 9/20 EMA Scalp Playbook Rules */}
      {showPlaybook && (
        <div className="mt-4 pt-4 border-t border-zinc-800 animate-in fade-in duration-200">
          <div className="bg-zinc-950/80 border border-zinc-800 rounded-xl p-4">
            <h4 className="text-xs font-bold text-cyan-400 uppercase font-mono tracking-wider mb-3 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              <span>THE 4 GOLDEN RULES OF 9 & 20 EMA + VWAP SCALPING</span>
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono">
              <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800/80">
                <div className="text-emerald-400 font-bold mb-1 flex items-center gap-1">
                  <span>1. VWAP IS THE IRON WALL</span>
                </div>
                <p className="text-zinc-400 font-sans text-[11px] leading-relaxed">
                  Only buy CALLs / longs when price is strictly above Session VWAP. Only buy PUTs / shorts when price is below VWAP. Trading counter-VWAP kills scalpers.
                </p>
              </div>

              <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800/80">
                <div className="text-cyan-400 font-bold mb-1 flex items-center gap-1">
                  <span>2. BUY THE 9-20 POCKET</span>
                </div>
                <p className="text-zinc-400 font-sans text-[11px] leading-relaxed">
                  The highest R:R entries are NOT chasing green candles, but waiting for a pullback into the pocket between EMA 9 and EMA 20. Enter when price rejects the 20 EMA.
                </p>
              </div>

              <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800/80">
                <div className="text-purple-400 font-bold mb-1 flex items-center gap-1">
                  <span>3. SPREAD ACCELERATION</span>
                </div>
                <p className="text-zinc-400 font-sans text-[11px] leading-relaxed">
                  Look at the Spread (9 - 20) readout. When the spread is widening, momentum is accelerating. When the spread contracts towards 0, expect mean reversion.
                </p>
              </div>

              <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800/80">
                <div className="text-amber-400 font-bold mb-1 flex items-center gap-1">
                  <span>4. EXTENSION DANGER ZONE</span>
                </div>
                <p className="text-zinc-400 font-sans text-[11px] leading-relaxed">
                  When price stretches &gt; 2.0x ATR away from the 20 EMA, the elastic band is over-stretched. Never chase breakouts here; wait for snapback to the 20 EMA.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
