'use client';

import React from 'react';
import { UnderlyingConfig, UNDERLYINGS } from '@/lib/optionsMonitorMath';
import { ChevronDown, RefreshCw, Keyboard, ShieldCheck, Activity } from 'lucide-react';

interface TopMetricBarProps {
  selectedUnderlying: string;
  onSelectUnderlying: (symbol: string) => void;
  spot: number;
  prevClose: number;
  change: number;
  changePct: number;
  ivPct: number;
  totalMtm: number;
  mtmPct: number;
  netTheta: number;
  estimatedMargin: number;
  isLiveLoading: boolean;
  onRefreshQuotes: () => void;
  onToggleHotkeysModal: () => void;
}

export default function TopMetricBar({
  selectedUnderlying,
  onSelectUnderlying,
  spot,
  change,
  changePct,
  ivPct,
  totalMtm,
  mtmPct,
  netTheta,
  estimatedMargin,
  isLiveLoading,
  onRefreshQuotes,
  onToggleHotkeysModal,
}: TopMetricBarProps) {
  const isPositivePnl = totalMtm >= 0;
  const isSpotUp = change >= 0;

  // Format Margin (e.g. 368000 -> ₹3.68L)
  const marginStr = (estimatedMargin / 100000).toFixed(2);

  // Today's date string YYYY-MM-DD for header data currency compliance
  const todayStr = new Date().toISOString().split('T')[0];

  return (
    <header className="sticky top-0 z-30 w-full border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs font-mono select-none shadow-lg">
      {/* Left: Underlying Selector + Spot Quote */}
      <div className="flex items-center gap-3">
        <div className="relative group">
          <select
            value={selectedUnderlying}
            onChange={(e) => onSelectUnderlying(e.target.value)}
            className="appearance-none bg-zinc-900 hover:bg-zinc-850 text-white font-bold px-3 py-1.5 pr-8 rounded-lg border border-zinc-700 cursor-pointer focus:outline-none focus:border-indigo-500 transition-colors text-xs"
          >
            {Object.keys(UNDERLYINGS).map((sym) => (
              <option key={sym} value={sym}>
                {UNDERLYINGS[sym].name}
              </option>
            ))}
          </select>
          <ChevronDown className="w-3.5 h-3.5 text-zinc-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        </div>

        {/* Spot Quote Badge */}
        <div className="flex items-center gap-2 bg-zinc-900 px-3 py-1.5 rounded-lg border border-zinc-800">
          <span className="text-zinc-400 font-semibold">{selectedUnderlying}</span>
          <span className="text-sm font-black text-white">
            {spot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <span className={`text-[11px] font-bold ${isSpotUp ? 'text-emerald-400' : 'text-rose-400'}`}>
            {isSpotUp ? '+' : ''}{change.toFixed(2)} ({isSpotUp ? '+' : ''}{changePct.toFixed(2)}%)
          </span>
        </div>

        {/* DATA Currency Chip */}
        <span className="hidden md:inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded bg-zinc-850 border border-zinc-750 text-zinc-400">
          DATA: {todayStr}
        </span>
      </div>

      {/* Middle Metrics Strip (Matching the diagram: IV | MTM | THETA | MARGIN) */}
      <div className="flex items-center gap-4 flex-wrap">
        {/* IV */}
        <div className="flex items-center gap-1.5 bg-zinc-900/90 px-2.5 py-1 rounded-lg border border-zinc-800">
          <span className="text-[10px] text-zinc-400 uppercase font-semibold">IV:</span>
          <span className="font-bold text-zinc-100">{ivPct.toFixed(1)}%</span>
        </div>

        {/* MTM P&L */}
        <div className="flex items-center gap-1.5 bg-zinc-900/90 px-3 py-1 rounded-lg border border-zinc-800">
          <span className="text-[10px] text-zinc-400 uppercase font-semibold">MTM:</span>
          <span className={`font-black text-xs ${isPositivePnl ? 'text-emerald-400' : 'text-rose-400'}`}>
            {isPositivePnl ? '+' : ''}₹{totalMtm.toLocaleString('en-IN')}
          </span>
          <span className={`text-[10px] font-bold ${isPositivePnl ? 'text-emerald-400' : 'text-rose-400'}`}>
            ({isPositivePnl ? '+' : ''}{mtmPct.toFixed(2)}%)
          </span>
        </div>

        {/* THETA */}
        <div className="flex items-center gap-1.5 bg-zinc-900/90 px-2.5 py-1 rounded-lg border border-zinc-800">
          <span className="text-[10px] text-zinc-400 uppercase font-semibold">THETA:</span>
          <span className={`font-bold ${netTheta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {netTheta >= 0 ? '+' : ''}₹{netTheta.toLocaleString('en-IN')}/d
          </span>
        </div>

        {/* MARGIN */}
        <div className="flex items-center gap-1.5 bg-zinc-900/90 px-2.5 py-1 rounded-lg border border-zinc-800">
          <span className="text-[10px] text-zinc-400 uppercase font-semibold">MARGIN:</span>
          <span className="font-bold text-zinc-100">₹{marginStr}L</span>
        </div>
      </div>

      {/* Right Controls: Refresh & Hotkeys Guide */}
      <div className="flex items-center gap-2">
        <button
          onClick={onRefreshQuotes}
          disabled={isLiveLoading}
          className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 hover:text-white transition-colors cursor-pointer"
          title="Refresh Market Quotes"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLiveLoading ? 'animate-spin text-indigo-400' : ''}`} />
        </button>

        <button
          onClick={onToggleHotkeysModal}
          className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-950/60 hover:bg-indigo-900/80 border border-indigo-500/50 text-indigo-300 font-bold text-[11px] transition-colors cursor-pointer"
          title="View Keyboard Hotkeys [C, P, H, W, X, ESC]"
        >
          <Keyboard className="w-3.5 h-3.5" />
          <span>HOTKEYS</span>
        </button>
      </div>
    </header>
  );
}
