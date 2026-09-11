'use client';

import React from 'react';
import {
  TrendingUp,
  TrendingDown,
  Activity,
  Zap,
  Clock,
  Radio,
  BarChart2,
  ShieldAlert,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { StrategyData } from './CyberStrategyIntelligence';

interface BloombergRibbonProps {
  symbol: string;
  spot: number;
  change: number;
  changePct: number;
  dataDate?: string;
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
    price_vs_vwap: number;
    atr14?: number;
  } | null;
  strategy: StrategyData | null;
  lastTickTime: string;
  broker: string;
  openMtm: number;
}

export default function CyberBloombergRibbon({
  symbol,
  spot,
  change,
  changePct,
  dataDate,
  live,
  strategy,
  lastTickTime,
  broker,
  openMtm,
}: BloombergRibbonProps) {
  if (!live) return null;

  const isUp = change >= 0;
  const isEmaBullish = live.spread >= 0;
  const isVwapBullish = live.price_vs_vwap >= 0;

  const fmtRupees = (v: number) => {
    const s = Math.abs(v).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return v >= 0 ? `+₹${s}` : `-₹${s}`;
  };

  return (
    <div className="w-full bg-zinc-950 border-b border-zinc-800 text-xs font-mono select-none overflow-x-auto scrollbar-none py-1.5 px-4 lg:px-6">
      <div className="flex items-center gap-4 lg:gap-6 min-w-max">
        {/* Item 1: Symbol & Spot */}
        <div className="flex items-center gap-2">
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span className="font-black text-white tracking-wider text-sm">{symbol}</span>
          <span className="font-mono font-bold text-white text-sm tabular-nums">
            ₹{spot.toFixed(2)}
          </span>
          <span
            className={cn(
              'text-[11px] font-bold tabular-nums flex items-center',
              isUp ? 'text-emerald-400' : 'text-rose-400'
            )}
          >
            {isUp ? <TrendingUp className="w-3 h-3 mr-0.5" /> : <TrendingDown className="w-3 h-3 mr-0.5" />}
            {isUp ? `+${change.toFixed(2)}` : change.toFixed(2)} ({isUp ? `+${changePct.toFixed(2)}%` : `${changePct.toFixed(2)}%`})
          </span>
        </div>

        <span className="text-zinc-700">|</span>

        {/* Item 2: Session VWAP */}
        <div className="flex items-center gap-1.5">
          <span className="text-zinc-500">VWAP:</span>
          <span className="text-zinc-200 font-bold tabular-nums">₹{live.vwap.toFixed(2)}</span>
          <span
            className={cn(
              'text-[10px] px-1 rounded font-bold tabular-nums',
              isVwapBullish ? 'text-emerald-400 bg-emerald-500/10' : 'text-rose-400 bg-rose-500/10'
            )}
          >
            {live.price_vs_vwap >= 0 ? `+${live.price_vs_vwap.toFixed(1)}` : live.price_vs_vwap.toFixed(1)} pts
          </span>
        </div>

        <span className="text-zinc-700">|</span>

        {/* Item 3: EMA 9 & EMA 20 */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <span className="text-cyan-400 font-bold">EMA 9:</span>
            <span className="text-zinc-200 font-bold tabular-nums">₹{live.ema9.toFixed(2)}</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-purple-400 font-bold">EMA 20:</span>
            <span className="text-zinc-200 font-bold tabular-nums">₹{live.ema20.toFixed(2)}</span>
          </div>
        </div>

        <span className="text-zinc-700">|</span>

        {/* Item 4: Spread (9 - 20) */}
        <div className="flex items-center gap-1.5">
          <span className="text-zinc-500">SPREAD:</span>
          <span
            className={cn(
              'font-bold tabular-nums',
              isEmaBullish ? 'text-emerald-400' : 'text-rose-400'
            )}
          >
            {live.spread >= 0 ? `+${live.spread.toFixed(2)}` : live.spread.toFixed(2)} pts
          </span>
          <span
            className={cn(
              'text-[9px] px-1.5 py-0.2 rounded font-bold uppercase border',
              isEmaBullish
                ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/10'
                : 'border-rose-500/30 text-rose-400 bg-rose-500/10'
            )}
          >
            {live.spread_status.replace('_', ' ')}
          </span>
        </div>

        {/* Item 5: ATR(14) */}
        {strategy?.atr14 && (
          <>
            <span className="text-zinc-700">|</span>
            <div className="flex items-center gap-1">
              <span className="text-zinc-500">ATR(14):</span>
              <span className="text-zinc-300 font-bold tabular-nums">{strategy.atr14.toFixed(1)} pts</span>
            </div>
          </>
        )}

        {/* Item 6: Active Strategy Signal */}
        {strategy?.setup_name && (
          <>
            <span className="text-zinc-700">|</span>
            <div className="flex items-center gap-1.5">
              <span className="text-zinc-500">SETUP:</span>
              <span
                className={cn(
                  'px-2 py-0.5 rounded text-[10px] font-bold border',
                  strategy.setup_quality === 'A+'
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                    : strategy.setup_quality === 'HIGH'
                    ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                    : strategy.setup_quality === 'CAUTION'
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-zinc-800 text-zinc-300 border-zinc-700'
                )}
              >
                {strategy.setup_name}
              </span>
            </div>
          </>
        )}

        {/* Item 7: Broker & Live MTM */}
        <span className="text-zinc-700 ml-auto">|</span>
        <div className="flex items-center gap-2">
          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-zinc-800 text-zinc-300 border border-zinc-700 uppercase">
            {broker}
          </span>
          <span className="text-zinc-500">MTM:</span>
          <span
            className={cn(
              'font-black tabular-nums',
              openMtm >= 0 ? 'text-emerald-400' : 'text-rose-400'
            )}
          >
            {fmtRupees(openMtm)}
          </span>
        </div>

        {/* Tick timestamp */}
        <div className="flex items-center gap-1 text-[10px] text-zinc-500">
          <Clock className="w-3 h-3" />
          <span>{lastTickTime || '--:--:--'}</span>
        </div>
      </div>
    </div>
  );
}
