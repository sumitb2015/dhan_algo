'use client';

import React from 'react';
import { TrendingUp, TrendingDown, Activity, Flame } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BiasRadarProps {
  live: {
    close: number;
    ema9: number;
    ema20: number;
    vwap: number;
    spread: number;
    spread_pct: number;
    prev_spread: number;
    spread_status: string;
    spread_diff: number;
    bias: string;
    bias_label: string;
    recommendation: string;
    price_vs_vwap: number;
    price_vs_vwap_pct: number;
    bull_power: number;
    bear_power: number;
  } | null;
}

export default function CyberBiasRadar({ live }: BiasRadarProps) {
  if (!live) {
    return (
      <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 animate-pulse flex items-center justify-center min-h-[160px]">
        <div className="flex items-center gap-2 text-zinc-500 font-mono text-xs">
          <Activity className="w-4 h-4 animate-spin text-cyan-400" />
          <span>INITIALIZING QUANTUM TELEMETRY RADAR...</span>
        </div>
      </div>
    );
  }

  const isBullish = live.bias.includes('BULLISH');
  const isBearish = live.bias.includes('BEARISH');
  const isStrong = live.bias.startsWith('STRONG');

  // Format helper
  const fmt = (v: number) => (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2));

  // Determine status glow border & text
  const statusTheme = isBullish
    ? {
        border: isStrong ? 'border-emerald-500/50 shadow-emerald-500/10' : 'border-cyan-500/40 shadow-cyan-500/10',
        badgeBg: isStrong ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
        icon: TrendingUp,
      }
    : isBearish
    ? {
        border: isStrong ? 'border-rose-500/50 shadow-rose-500/10' : 'border-amber-500/40 shadow-amber-500/10',
        badgeBg: isStrong ? 'bg-rose-500/15 text-rose-400 border-rose-500/30' : 'bg-amber-500/15 text-amber-400 border-amber-500/30',
        icon: TrendingDown,
      }
    : {
        border: 'border-violet-500/30 shadow-violet-500/5',
        badgeBg: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
        icon: Activity,
      };

  const StatusIcon = statusTheme.icon;

  return (
    <div
      className={cn(
        'relative bg-zinc-900/70 border rounded-xl p-3 backdrop-blur-md shadow-lg transition-all duration-300',
        statusTheme.border
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        {/* Status Badge */}
        <div className="flex items-center gap-2 shrink-0">
          <div
            className={cn(
              'w-7 h-7 rounded-lg flex items-center justify-center border shrink-0',
              statusTheme.badgeBg
            )}
          >
            <StatusIcon className="w-3.5 h-3.5" />
          </div>
          <div>
            <span className="text-[9px] uppercase font-mono tracking-widest text-zinc-400 block">BIAS</span>
            <h3 className="text-sm font-black tracking-tight text-white leading-none">
              {live.bias_label}
            </h3>
          </div>
        </div>

        {/* Recommendation */}
        <div
          className={cn(
            'px-2.5 py-1 rounded-lg border text-[11px] font-mono font-bold tracking-wide uppercase flex items-center gap-1.5',
            isBullish
              ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
              : isBearish
              ? 'bg-rose-950/40 border-rose-500/40 text-rose-300'
              : 'bg-zinc-800/80 border-zinc-700/80 text-zinc-300'
          )}
        >
          <Flame className="w-3 h-3 shrink-0" />
          <span>{live.recommendation}</span>
        </div>

        <span className="text-zinc-700 hidden sm:inline">|</span>

        {/* Fast EMA 9 */}
        <div className="flex items-center gap-1.5 text-xs font-mono">
          <span className="text-cyan-400 font-bold">EMA9:</span>
          <span className="text-zinc-200 font-bold">{live.ema9.toFixed(2)}</span>
        </div>

        {/* Base EMA 20 */}
        <div className="flex items-center gap-1.5 text-xs font-mono">
          <span className="text-purple-400 font-bold">EMA20:</span>
          <span className="text-zinc-200 font-bold">{live.ema20.toFixed(2)}</span>
        </div>

        {/* Spread (9 - 20) */}
        <div className="flex items-center gap-1.5 text-xs font-mono">
          <span className="text-zinc-500">SPREAD:</span>
          <span className={cn('font-bold', live.spread >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
            {fmt(live.spread)} pts
          </span>
          <span
            className={cn(
              'text-[9px] px-1 py-0.2 rounded border font-semibold',
              live.spread >= 0
                ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/10'
                : 'border-rose-500/30 text-rose-400 bg-rose-500/10'
            )}
          >
            {live.spread_status.replace('_', ' ')}
          </span>
        </div>

        {/* VWAP — absolute level + distance */}
        <div className="flex items-center gap-1.5 text-xs font-mono">
          <span className="text-amber-400 font-bold">VWAP:</span>
          <span className="text-zinc-200 font-bold">{live.vwap.toFixed(2)}</span>
          <span className={cn('font-bold', live.price_vs_vwap >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
            {live.price_vs_vwap >= 0 ? 'ABOVE' : 'BELOW'} ({fmt(live.price_vs_vwap)} pts)
          </span>
        </div>
      </div>
    </div>
  );
}
