'use client';

import React from 'react';
import { Crosshair, Zap } from 'lucide-react';
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
  strategy: StrategyData | null;
  onApplyLevels?: (targetPts: number, slPts: number) => void;
}

export default function CyberStrategyIntelligence({
  strategy,
  onApplyLevels,
}: StrategyIntelligenceProps) {
  if (!strategy) {
    return null;
  }

  const {
    setup_quality,
    setup_name,
    badge_text,
    action_headline,
    action_detail,
    sl_pts,
    target_pts,
    rr_ratio,
  } = strategy;

  const isAplus = setup_quality === 'A+';
  const isHigh = setup_quality === 'HIGH';
  const isCaution = setup_quality === 'CAUTION';
  const isLow = setup_quality === 'LOW';

  // Quality badge theme
  const qualityTheme = isAplus
    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
    : isHigh
    ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
    : isCaution
    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
    : isLow
    ? 'bg-zinc-800 text-zinc-400 border-zinc-700'
    : 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40';

  return (
    <div className="relative bg-zinc-900/60 border border-zinc-800 rounded-xl p-3 backdrop-blur-md shadow-lg transition-all">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        {/* Setup badge + tactical action */}
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/25 shrink-0 mt-0.5">
            <Crosshair className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-bold text-white">{setup_name}</span>
              <span className={cn('px-1.5 py-0.2 rounded text-[9px] font-mono font-bold border', qualityTheme)}>
                {badge_text}
              </span>
            </div>
            <p
              className={cn(
                'text-[11px] font-medium truncate',
                isAplus || isHigh ? 'text-emerald-400' : isCaution ? 'text-amber-400' : 'text-zinc-400'
              )}
              title={action_detail}
            >
              {action_headline}
            </p>
          </div>
        </div>

        {/* SL / Target anchors */}
        <div className="flex items-center gap-2 shrink-0 text-[11px] font-mono">
          <div className="px-2 py-1 rounded-lg bg-rose-950/30 border border-rose-900/40 text-center">
            <span className="text-rose-400 text-[9px] block">SL</span>
            <span className="text-rose-300 font-bold tabular-nums">-{sl_pts.toFixed(0)} pts</span>
          </div>
          <div className="px-2 py-1 rounded-lg bg-emerald-950/30 border border-emerald-900/40 text-center">
            <span className="text-emerald-400 text-[9px] block">TP</span>
            <span className="text-emerald-300 font-bold tabular-nums">+{target_pts.toFixed(0)} pts</span>
          </div>
          <span className="text-zinc-500">R:R 1:{rr_ratio.toFixed(1)}</span>

          {onApplyLevels && (
            <button
              onClick={() => {
                cyberAudio.click();
                onApplyLevels(Math.round(target_pts), Math.round(sl_pts));
              }}
              className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold transition-all active:scale-95 flex items-center gap-1"
            >
              <Zap className="w-3 h-3" />
              <span>APPLY TO PAD</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
