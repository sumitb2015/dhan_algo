'use client';

import React from 'react';
import {
  TrendingUp,
  TrendingDown,
  Activity,
  Zap,
  Gauge,
  Compass,
  ArrowUpRight,
  ArrowDownRight,
  ShieldAlert,
  Radio,
  Flame,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface BiasRadarProps {
  spot: number;
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

export default function CyberBiasRadar({ spot, live }: BiasRadarProps) {
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
  const isNeutral = live.bias === 'NEUTRAL';

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

  // Spread bar calculation (-20 to +20 clamped for gauge)
  const spreadNormalized = Math.max(-100, Math.min(100, (live.spread / (spot * 0.002 || 50)) * 100));

  return (
    <div
      className={cn(
        'relative bg-zinc-900/70 border rounded-2xl p-4 lg:p-5 backdrop-blur-md shadow-2xl transition-all duration-300 overflow-hidden',
        statusTheme.border
      )}
    >
      {/* Subtle background ambient cyber grid glow */}
      <div
        className={cn(
          'absolute -top-24 -right-24 w-60 h-60 rounded-full blur-3xl pointer-events-none opacity-20',
          isBullish ? 'bg-emerald-500' : isBearish ? 'bg-rose-500' : 'bg-violet-500'
        )}
      />

      {/* Top row: Status Badge & Signal Recommendation */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div
            className={cn(
              'w-8 h-8 rounded-xl flex items-center justify-center border shrink-0',
              statusTheme.badgeBg
            )}
          >
            <StatusIcon className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase font-mono tracking-widest text-zinc-400">
                BIAS MATRIX
              </span>
              <span className="flex h-1.5 w-1.5 relative">
                <span
                  className={cn(
                    'animate-ping absolute inline-flex h-full w-full rounded-full opacity-75',
                    isBullish ? 'bg-emerald-400' : isBearish ? 'bg-rose-400' : 'bg-violet-400'
                  )}
                />
                <span
                  className={cn(
                    'relative inline-flex rounded-full h-1.5 w-1.5',
                    isBullish ? 'bg-emerald-500' : isBearish ? 'bg-rose-500' : 'bg-violet-500'
                  )}
                />
              </span>
            </div>
            <h3 className="text-sm lg:text-base font-black tracking-tight text-white flex items-center gap-1.5">
              {live.bias_label}
            </h3>
          </div>
        </div>

        {/* Tactical Recommendation Badge */}
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'px-3 py-1.5 rounded-lg border text-xs font-mono font-bold tracking-wider uppercase flex items-center gap-1.5 shadow-sm',
              isBullish
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                : isBearish
                ? 'bg-rose-950/40 border-rose-500/40 text-rose-300'
                : 'bg-zinc-800/80 border-zinc-700/80 text-zinc-300'
            )}
          >
            <Flame className="w-3.5 h-3.5 shrink-0" />
            <span>{live.recommendation}</span>
          </div>
        </div>
      </div>

      {/* Grid of 4 Key Telemetry Modules */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {/* Module 1: EMA 9 vs 20 Difference (Spread) */}
        <div className="bg-zinc-950/70 border border-zinc-800/90 rounded-xl p-3 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 mb-1">
            <span>EMA (9 - 20) SPREAD</span>
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
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                'text-lg lg:text-xl font-mono font-black',
                live.spread >= 0 ? 'text-emerald-400' : 'text-rose-400'
              )}
            >
              {fmt(live.spread)}
            </span>
            <span className="text-[11px] font-mono text-zinc-400">pts</span>
            <span
              className={cn(
                'text-[10px] font-mono font-bold ml-auto',
                live.spread_pct >= 0 ? 'text-emerald-400' : 'text-rose-400'
              )}
            >
              ({fmt(live.spread_pct)}%)
            </span>
          </div>
          <p className="text-[10px] text-zinc-500 mt-1 font-mono">
            {live.spread_diff > 0
              ? '▲ Expanding momentum'
              : live.spread_diff < 0
              ? '▼ Contracting spread'
              : '◼ Steady spread'}
          </p>
        </div>

        {/* Module 2: VWAP Distance */}
        <div className="bg-zinc-950/70 border border-zinc-800/90 rounded-xl p-3 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 mb-1">
            <span>PRICE VS VWAP</span>
            <span
              className={cn(
                'text-[9px] px-1 py-0.2 rounded border font-semibold',
                live.price_vs_vwap >= 0
                  ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/10'
                  : 'border-rose-500/30 text-rose-400 bg-rose-500/10'
              )}
            >
              {live.price_vs_vwap >= 0 ? 'ABOVE VWAP' : 'BELOW VWAP'}
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                'text-lg lg:text-xl font-mono font-black',
                live.price_vs_vwap >= 0 ? 'text-emerald-400' : 'text-rose-400'
              )}
            >
              {fmt(live.price_vs_vwap)}
            </span>
            <span className="text-[11px] font-mono text-zinc-400">pts</span>
            <span
              className={cn(
                'text-[10px] font-mono font-bold ml-auto',
                live.price_vs_vwap_pct >= 0 ? 'text-emerald-400' : 'text-rose-400'
              )}
            >
              ({fmt(live.price_vs_vwap_pct)}%)
            </span>
          </div>
          <p className="text-[10px] text-zinc-500 mt-1 font-mono">
            Session VWAP: <span className="text-zinc-300">{live.vwap.toFixed(2)}</span>
          </p>
        </div>

        {/* Module 3: Fast EMA 9 Readout */}
        <div className="bg-zinc-950/70 border border-zinc-800/90 rounded-xl p-3 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 mb-1">
            <span>FAST EMA 9</span>
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-lg lg:text-xl font-mono font-black text-cyan-400">
              {live.ema9.toFixed(2)}
            </span>
          </div>
          <p className="text-[10px] text-zinc-500 mt-1 font-mono">
            Distance to Spot: {fmt(spot - live.ema9)} pts
          </p>
        </div>

        {/* Module 4: Base EMA 20 Readout */}
        <div className="bg-zinc-950/70 border border-zinc-800/90 rounded-xl p-3 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 mb-1">
            <span>BASE EMA 20</span>
            <span className="h-1.5 w-1.5 rounded-full bg-purple-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-lg lg:text-xl font-mono font-black text-purple-400">
              {live.ema20.toFixed(2)}
            </span>
          </div>
          <p className="text-[10px] text-zinc-500 mt-1 font-mono">
            Distance to Spot: {fmt(spot - live.ema20)} pts
          </p>
        </div>
      </div>

      {/* Bull / Bear Power Duel Gauge */}
      <div className="bg-zinc-950/80 border border-zinc-800/80 rounded-xl px-4 py-2.5">
        <div className="flex items-center justify-between text-xs font-mono mb-1.5">
          <div className="flex items-center gap-1.5 text-emerald-400 font-bold">
            <ArrowUpRight className="w-3.5 h-3.5" />
            <span>BULL POWER {live.bull_power}%</span>
          </div>
          <div className="text-[10px] font-mono text-zinc-500">MOMENTUM CONFLICT RADAR</div>
          <div className="flex items-center gap-1.5 text-rose-400 font-bold">
            <span>BEAR POWER {live.bear_power}%</span>
            <ArrowDownRight className="w-3.5 h-3.5" />
          </div>
        </div>

        {/* Dual dynamic laser bar */}
        <div className="h-2 w-full bg-zinc-800 rounded-full overflow-hidden flex relative">
          <div
            className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-500"
            style={{ width: `${live.bull_power}%` }}
          />
          <div
            className="h-full bg-gradient-to-l from-rose-600 to-rose-400 transition-all duration-500"
            style={{ width: `${live.bear_power}%` }}
          />
          <div className="absolute inset-y-0 left-1/2 w-0.5 bg-zinc-950 -translate-x-1/2" />
        </div>
      </div>
    </div>
  );
}
