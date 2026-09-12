'use client';

import React from 'react';
import { UNDERLYINGS } from '@/lib/optionsMonitorMath';
import { ChevronDown, RefreshCw, Keyboard, Briefcase, SlidersHorizontal, Activity, Zap } from 'lucide-react';

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
  lastUpdated?: string;
  onRefreshQuotes: () => void;
  onToggleHotkeysModal: () => void;
  viewMode: 'broker' | 'custom';
  onToggleViewMode: (mode: 'broker' | 'custom') => void;
  brokerLegsCount: number;
  onOpenTrade?: () => void;
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
  lastUpdated,
  onRefreshQuotes,
  onToggleHotkeysModal,
  viewMode,
  onToggleViewMode,
  brokerLegsCount,
  onOpenTrade,
}: TopMetricBarProps) {
  const isPositivePnl = totalMtm >= 0;
  const isSpotUp = change >= 0;

  // Format Margin (e.g. 368000 -> ₹3.68L)
  const marginStr = (estimatedMargin / 100000).toFixed(2);

  // Format Expiry display label e.g. 2026-09-15 -> 15-Sep
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
    <div className="w-full flex flex-col font-mono select-none">
      {/* ─── 1. TOP BLOOMBERG FUNCTION KEY COMMAND RIBBON ─────────────────── */}
      <div className="hidden border-b border-zinc-800 bg-zinc-950 px-4 py-1.5 md:block">
        <div className="flex items-center justify-between gap-2 overflow-x-auto text-[10px]">
          <div className="flex items-center gap-2">
            <span className="text-amber-400 font-bold uppercase tracking-wider">COMMANDS:</span>
            <button
              type="button"
              onClick={() => onToggleViewMode('custom')}
              className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 font-bold cursor-pointer transition-colors ${
                viewMode === 'custom'
                  ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                  : 'border-zinc-800 bg-zinc-900/80 text-zinc-300 hover:text-amber-400'
              }`}
            >
              <span className="text-amber-400 font-bold">[F1]</span>
              <span>DESK</span>
            </button>
            <button
              type="button"
              onClick={() => onToggleViewMode('broker')}
              className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 font-bold cursor-pointer transition-colors ${
                viewMode === 'broker'
                  ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                  : 'border-zinc-800 bg-zinc-900/80 text-zinc-300 hover:text-amber-400'
              }`}
            >
              <span className="text-amber-400 font-bold">[F2]</span>
              <span>BROKER</span>
              {brokerLegsCount > 0 && (
                <span className="px-1 py-0.2 rounded text-[9px] bg-indigo-500/20 text-indigo-300 font-bold">
                  {brokerLegsCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={onToggleHotkeysModal}
              className="inline-flex items-center gap-1 rounded border border-zinc-800 bg-zinc-900/80 px-2 py-0.5 text-zinc-300 hover:border-amber-500/50 hover:bg-amber-500/10 hover:text-amber-400 cursor-pointer font-bold transition-colors"
            >
              <span className="text-amber-400 font-bold">[F3]</span>
              <span>HOTKEYS (⌘K)</span>
            </button>
            <button
              type="button"
              onClick={onRefreshQuotes}
              disabled={isLiveLoading}
              className="inline-flex items-center gap-1 rounded border border-zinc-800 bg-zinc-900/80 px-2 py-0.5 text-zinc-300 hover:border-amber-500/50 hover:bg-amber-500/10 hover:text-amber-400 cursor-pointer font-bold transition-colors"
            >
              <span className="text-amber-400 font-bold">[F4]</span>
              <span>REFRESH</span>
            </button>
            {onOpenTrade && (
              <button
                type="button"
                onClick={onOpenTrade}
                className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-emerald-400 hover:border-emerald-500/60 hover:bg-emerald-500/20 cursor-pointer font-bold transition-colors"
              >
                <span className="text-emerald-400 font-bold">[F5]</span>
                <Zap className="w-3 h-3 fill-current" />
                <span>PLACE TRADE</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2.5 text-zinc-400">
            <span>OPTIONS MONITOR TERMINAL</span>
            <span className="text-zinc-700">|</span>
            <span className="text-amber-400 font-semibold">{isWsLive ? 'WS STREAM ACTIVE' : `${wsTransport.toUpperCase()} ${wsStatus}`}</span>
            <span className="text-zinc-700">|</span>
            <span className="font-bold text-zinc-300">DATA: {todayStr}</span>
          </div>
        </div>
      </div>

      {/* ─── 2. MAIN BLOOMBERG METRICS STRIP ──────────────────────────────── */}
      <div className="w-full border-b border-amber-500/25 bg-zinc-950/90 px-3 md:px-4 py-2 flex flex-wrap items-center justify-between gap-3 text-xs">
        {/* Left: Underlying + Expiry + Spot Quote + WS Status */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Underlying Selector */}
          <div className="relative">
            <select
              value={selectedUnderlying}
              onChange={(e) => onSelectUnderlying(e.target.value)}
              className="appearance-none bg-zinc-900 hover:bg-zinc-850 text-white font-bold px-2.5 py-1.5 pr-7 rounded-lg border border-zinc-800 cursor-pointer focus:outline-none focus:border-amber-500/50 transition-colors text-xs"
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
              className="appearance-none bg-zinc-900 hover:bg-zinc-850 text-amber-400 font-bold px-2.5 py-1.5 pr-7 rounded-lg border border-amber-500/40 cursor-pointer focus:outline-none focus:border-amber-400 transition-colors text-xs"
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
            <ChevronDown className="w-3 h-3 text-amber-400 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>

          {/* Spot Quote Badge */}
          <div className="flex items-center gap-2 bg-zinc-900/90 px-3 py-1.5 rounded-lg border border-zinc-800">
            <span className="text-zinc-400 font-semibold">{selectedUnderlying}</span>
            <span className="text-sm font-bold text-white tabular-nums">
              {spot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span className={`text-[11px] font-bold tabular-nums ${isSpotUp ? 'text-emerald-400' : 'text-red-400'}`}>
              {isSpotUp ? '+' : ''}{change.toFixed(2)} ({isSpotUp ? '+' : ''}{changePct.toFixed(2)}%)
            </span>
          </div>

          {/* WebSocket / Feed Connection Pill */}
          <div
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-bold border transition-colors ${
              isWsLive
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : isPollLive
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                : wsStatus === 'STARTING'
                ? 'bg-sky-500/10 text-sky-400 border-sky-500/30'
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
            {lastUpdated && isWsLive && (
              <span className="text-[9px] text-emerald-400 font-mono">[{lastUpdated}]</span>
            )}
          </div>
        </div>

        {/* Middle: Metrics Strip (IV | MTM | THETA | MARGIN) */}
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          {/* IV / VIX */}
          <div className="flex flex-col justify-between gap-0.5 rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1 min-w-[85px]">
            <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-400">IV / VIX</span>
            <div className="flex items-center gap-1 font-bold text-zinc-100 tabular-nums">
              <span>{ivPct.toFixed(1)}%</span>
              {vix && vix.ltp > 0 && (
                <span className="text-[10px] text-zinc-400 font-normal border-l border-zinc-800 pl-1">
                  VIX {vix.ltp.toFixed(1)}
                </span>
              )}
            </div>
          </div>

          {/* MTM P&L */}
          <div className="flex flex-col justify-between gap-0.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1 min-w-[110px]">
            <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-400">PORTFOLIO MTM</span>
            <div className="flex items-center gap-1 tabular-nums">
              <span className={`font-bold text-xs ${isPositivePnl ? 'text-emerald-400' : 'text-red-400'}`}>
                {isPositivePnl ? '+' : ''}₹{totalMtm.toLocaleString('en-IN')}
              </span>
              <span className={`text-[10px] font-semibold ${isPositivePnl ? 'text-emerald-400' : 'text-red-400'}`}>
                ({isPositivePnl ? '+' : ''}{mtmPct.toFixed(2)}%)
              </span>
            </div>
          </div>

          {/* THETA */}
          <div className="flex flex-col justify-between gap-0.5 rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1 min-w-[95px]">
            <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-400">THETA DECAY</span>
            <div className={`font-bold text-xs tabular-nums ${netTheta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {netTheta >= 0 ? '+' : ''}₹{netTheta.toLocaleString('en-IN')}/d
            </div>
          </div>

          {/* MARGIN */}
          <div className="flex flex-col justify-between gap-0.5 rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1 min-w-[85px]">
            <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-400">EST. MARGIN</span>
            <div className="font-bold text-xs text-zinc-100 tabular-nums">
              ₹{marginStr}L
            </div>
          </div>
        </div>

        {/* Right: View Mode Toggle + Refresh & Hotkeys */}
        <div className="flex items-center gap-2">
          {/* Broker vs Simulator Toggle */}
          <div className="flex items-center bg-zinc-900 p-0.5 rounded-lg border border-zinc-800 text-[11px] font-bold">
            <button
              onClick={() => onToggleViewMode('broker')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                viewMode === 'broker'
                  ? 'bg-emerald-600 text-white shadow'
                  : 'text-zinc-400 hover:text-white'
              }`}
              title="Live Positions from Dhan Broker Account"
            >
              <Briefcase className="w-3 h-3" />
              <span>BROKER</span>
              {brokerLegsCount > 0 && (
                <span className="ml-0.5 px-1 py-0.2 rounded text-[9px] bg-emerald-800 text-emerald-100 font-bold">
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

          {/* Place Trade Button */}
          {onOpenTrade && (
            <button
              type="button"
              onClick={onOpenTrade}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow transition-all cursor-pointer"
              title="Open Order Ticket / Place Trades [F5]"
            >
              <Zap className="w-3.5 h-3.5 fill-current" />
              <span>PLACE TRADE</span>
              <span className="text-[9px] bg-emerald-700/60 px-1 py-0.2 rounded font-mono">[F5]</span>
            </button>
          )}

          {/* Refresh Quotes */}
          <button
            onClick={onRefreshQuotes}
            disabled={isLiveLoading}
            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 hover:text-white transition-colors cursor-pointer"
            title="Refresh Option Chain & Quotes"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLiveLoading ? 'animate-spin text-amber-400' : ''}`} />
          </button>

          {/* Hotkeys Trigger */}
          <button
            onClick={onToggleHotkeysModal}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 font-bold text-[11px] transition-colors cursor-pointer"
            title="View Keyboard Hotkeys [C, P, H, W, X, ESC]"
          >
            <Keyboard className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">HOTKEYS</span>
          </button>
        </div>
      </div>
    </div>
  );
}

