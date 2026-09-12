'use client';

import React from 'react';
import { UNDERLYINGS } from '@/lib/optionsMonitorMath';
import { ChevronDown, RefreshCw, Keyboard, Radio, Briefcase, SlidersHorizontal, Wifi } from 'lucide-react';

interface TopMetricBarProps {
  selectedUnderlying: string;
  onSelectUnderlying: (symbol: string) => void;
  expiries: string[];
  selectedExpiry: string;
  onSelectExpiry: (exp: string) => void;
  spot: number;
  prevClose: number;
  change: number;
  changePct: number;
  ivPct: number;
  vix?: { ltp: number; change?: number; change_pct?: number } | null;
  totalMtm: number;
  mtmPct: number;
  netTheta: number;
  estimatedMargin: number;
  isLiveLoading: boolean;
  wsTransport?: 'ws' | 'poll';
  wsStatus?: 'RUNNING' | 'STOPPED' | 'STARTING' | 'ERROR';
  onRefreshQuotes: () => void;
  onToggleHotkeysModal: () => void;
  viewMode: 'broker' | 'custom';
  onToggleViewMode: (mode: 'broker' | 'custom') => void;
  brokerLegsCount: number;
}

export default function TopMetricBar({
  selectedUnderlying,
  onSelectUnderlying,
  expiries,
  selectedExpiry,
  onSelectExpiry,
  spot,
  change,
  changePct,
  ivPct,
  vix,
  totalMtm,
  mtmPct,
  netTheta,
  estimatedMargin,
  isLiveLoading,
  wsTransport = 'poll',
  wsStatus = 'STOPPED',
  onRefreshQuotes,
  onToggleHotkeysModal,
  viewMode,
  onToggleViewMode,
  brokerLegsCount,
}: TopMetricBarProps) {
  const isPositivePnl = totalMtm >= 0;
  const isSpotUp = change >= 0;

  // Format Margin (e.g. 368000 -> ₹3.68L)
  const marginStr = (estimatedMargin / 100000).toFixed(2);

  // Format Expiry display label e.g. 2026-09-15 -> 15 Sep 26
  const formatExpiryLabel = (exp: string) => {
    if (!exp) return 'Expiry';
    try {
      const parts = exp.split('-');
      if (parts.length === 3) {
        const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
        return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
      }
    } catch {}
    return exp;
  };

  // Today's date string YYYY-MM-DD for header data currency compliance
  const todayStr = new Date().toISOString().split('T')[0];

  const isWsLive = wsStatus === 'RUNNING' && wsTransport === 'ws';
  const isPollLive = wsStatus === 'RUNNING' && wsTransport === 'poll';

  return (
    <div className="w-full border-b border-zinc-800 bg-zinc-950/90 px-3 md:px-4 py-2 flex flex-wrap items-center justify-between gap-2.5 text-xs font-mono select-none">
      {/* ── Left: Underlying + Expiry + Spot Quote + WS Status ─────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Underlying Selector */}
        <div className="relative">
          <select
            value={selectedUnderlying}
            onChange={(e) => onSelectUnderlying(e.target.value)}
            className="appearance-none bg-zinc-900 hover:bg-zinc-850 text-white font-bold px-2.5 py-1.5 pr-7 rounded-lg border border-zinc-700 cursor-pointer focus:outline-none focus:border-indigo-500 transition-colors text-xs"
          >
            {Object.keys(UNDERLYINGS).map((sym) => (
              <option key={sym} value={sym}>
                {UNDERLYINGS[sym].name}
              </option>
            ))}
          </select>
          <ChevronDown className="w-3 h-3 text-zinc-400 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
        </div>

        {/* Expiry Selector */}
        <div className="relative">
          <select
            value={selectedExpiry}
            onChange={(e) => onSelectExpiry(e.target.value)}
            className="appearance-none bg-zinc-900 hover:bg-zinc-850 text-indigo-300 font-bold px-2.5 py-1.5 pr-7 rounded-lg border border-indigo-700/50 cursor-pointer focus:outline-none focus:border-indigo-400 transition-colors text-xs"
          >
            {expiries.length === 0 ? (
              <option value="">Loading Expiries...</option>
            ) : (
              expiries.map((exp) => (
                <option key={exp} value={exp}>
                  {exp} ({formatExpiryLabel(exp)})
                </option>
              ))
            )}
          </select>
          <ChevronDown className="w-3 h-3 text-indigo-400 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
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

        {/* WebSocket / Feed Connection Pill */}
        <div
          className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold border transition-colors ${
            isWsLive
              ? 'bg-emerald-950/60 text-emerald-400 border-emerald-500/40'
              : isPollLive
              ? 'bg-amber-950/60 text-amber-300 border-amber-500/40'
              : wsStatus === 'STARTING'
              ? 'bg-sky-950/60 text-sky-300 border-sky-500/40'
              : 'bg-zinc-900 text-zinc-500 border-zinc-800'
          }`}
          title={`Feed Status: ${wsStatus} (${wsTransport.toUpperCase()})`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              isWsLive ? 'bg-emerald-400 animate-pulse' : isPollLive ? 'bg-amber-400' : 'bg-zinc-600'
            }`}
          />
          <span>{isWsLive ? 'WS LIVE' : isPollLive ? '100ms POLL' : wsStatus}</span>
        </div>

        {/* DATA Currency Chip */}
        <span className="hidden xl:inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
          DATA: {todayStr}
        </span>
      </div>

      {/* ── Middle: Metrics Strip (IV | MTM | THETA | MARGIN) ─────────────── */}
      <div className="flex items-center gap-2.5 sm:gap-3.5 flex-wrap">
        {/* IV / VIX */}
        <div className="flex items-center gap-1.5 bg-zinc-900/90 px-2.5 py-1 rounded-lg border border-zinc-800">
          <span className="text-[10px] text-zinc-400 uppercase font-semibold">IV:</span>
          <span className="font-bold text-zinc-100">{ivPct.toFixed(1)}%</span>
          {vix && vix.ltp > 0 && (
            <span className="text-[10px] text-zinc-400 border-l border-zinc-750 pl-1.5">
              VIX <span className="text-zinc-200 font-bold">{vix.ltp.toFixed(2)}</span>
            </span>
          )}
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

      {/* ── Right: View Mode Toggle + Refresh & Hotkeys ──────────────────── */}
      <div className="flex items-center gap-2">
        {/* Broker vs Simulator Toggle */}
        <div className="flex items-center bg-zinc-900 p-0.5 rounded-lg border border-zinc-800 text-[11px] font-bold">
          <button
            onClick={() => onToggleViewMode('broker')}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
              viewMode === 'broker'
                ? 'bg-indigo-600 text-white shadow'
                : 'text-zinc-400 hover:text-white'
            }`}
            title="Live Positions from Dhan Broker Account"
          >
            <Briefcase className="w-3 h-3" />
            <span>BROKER</span>
            {brokerLegsCount > 0 && (
              <span className="ml-0.5 px-1 py-0.2 rounded-full text-[9px] bg-indigo-800 text-indigo-100 font-extrabold">
                {brokerLegsCount}
              </span>
            )}
          </button>
          <button
            onClick={() => onToggleViewMode('custom')}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
              viewMode === 'custom'
                ? 'bg-zinc-800 text-white shadow'
                : 'text-zinc-400 hover:text-white'
            }`}
            title="Custom Strike Desk & What-If Simulator"
          >
            <SlidersHorizontal className="w-3 h-3" />
            <span>DESK</span>
          </button>
        </div>

        {/* Refresh Quotes */}
        <button
          onClick={onRefreshQuotes}
          disabled={isLiveLoading}
          className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 hover:text-white transition-colors cursor-pointer"
          title="Refresh Option Chain & Quotes"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLiveLoading ? 'animate-spin text-indigo-400' : ''}`} />
        </button>

        {/* Hotkeys Modal Trigger */}
        <button
          onClick={onToggleHotkeysModal}
          className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-950/60 hover:bg-indigo-900/80 border border-indigo-500/50 text-indigo-300 font-bold text-[11px] transition-colors cursor-pointer"
          title="View Keyboard Hotkeys [C, P, H, W, X, ESC]"
        >
          <Keyboard className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">HOTKEYS</span>
        </button>
      </div>
    </div>
  );
}
