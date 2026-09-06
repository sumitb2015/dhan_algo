'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { LayoutGrid, List, RefreshCw, Layers, Clock, ChevronDown, Wifi, WifiOff } from 'lucide-react';
import { RSResult } from '@/lib/rs';
import IndexSummary from './IndexSummary';
import Leaderboard from './Leaderboard';
import RSChart from './RSChart';
import SectorHeatmap from './SectorHeatmap';
import Link from 'next/link';
import NavBar from './NavBar';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel
} from '@/components/ui/dropdown-menu';
import { useRefreshStatus } from '@/lib/useRefreshStatus';

const AUTO_REFRESH_OPTIONS = [5, 15, 30] as const;
type AutoRefreshInterval = typeof AUTO_REFRESH_OPTIONS[number] | null;

export default function StockDashboard() {
  const [indexType, setIndexType] = useState<'nifty50' | 'nifty500'>('nifty50');
  const [lookback, setLookback] = useState<50 | 100 | 252>(252);
  const [activeTab, setActiveTab] = useState<'leaderboard' | 'heatmap'>('leaderboard');
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);

  const [stocks, setStocks] = useState<RSResult[]>([]);
  const [loadingStocks, setLoadingStocks] = useState(true);
  const [stocksError, setStocksError] = useState<string | null>(null);
  const [nifty50Stats, setNifty50Stats] = useState<any>(null);
  const [nifty500Stats, setNifty500Stats] = useState<any>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);

  const [autoRefresh, setAutoRefresh] = useState<AutoRefreshInterval>(null);
  const [countdown, setCountdown] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [istTime, setISTTime] = useState('');
  const [marketOpen, setMarketOpen] = useState(false);

  const refreshStatus = useRefreshStatus();
  const [syncing, setSyncing] = useState(false);
  const wasRunningRef = useRef(false);

  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      const istStr = now.toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      setISTTime(istStr);
      const istDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const day = istDate.getDay();
      const totalMins = istDate.getHours() * 60 + istDate.getMinutes();
      setMarketOpen(day >= 1 && day <= 5 && totalMins >= 555 && totalMins < 930);
    };
    updateClock();
    const id = setInterval(updateClock, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('rs_watchlist');
      if (stored) setFavorites(JSON.parse(stored));
    } catch { /* ignore */ }
  }, []);

  const handleToggleFavorite = (symbol: string) => {
    setFavorites((prev) => {
      const updated = prev.includes(symbol)
        ? prev.filter((s) => s !== symbol)
        : [...prev, symbol];
      try { localStorage.setItem('rs_watchlist', JSON.stringify(updated)); } catch { /* ignore */ }
      return updated;
    });
  };

  const fetchStocks = useCallback(async () => {
    setLoadingStocks(true);
    setStocksError(null);
    try {
      const res = await fetch(`/api/stocks?index=${indexType}&lookback=${lookback}`);
      const json = await res.json();
      if (json.success) {
        setStocks(json.data);
        const symbolExists = json.data.some((item: any) => item.symbol === selectedSymbol);
        if (json.data.length > 0 && (!selectedSymbol || !symbolExists)) {
          setSelectedSymbol(json.data[0].symbol);
        }
      } else {
        setStocksError(json.error || 'Failed to retrieve stocks list');
      }
    } catch {
      setStocksError('Network error. Failed to retrieve stocks list.');
    } finally {
      setLoadingStocks(false);
      setLastUpdated(new Date());
    }
  }, [indexType, lookback, selectedSymbol]);

  const fetchSummary = useCallback(async () => {
    setLoadingSummary(true);
    try {
      const res = await fetch('/api/summary');
      const json = await res.json();
      if (json.success) {
        setNifty50Stats(json.nifty50);
        setNifty500Stats(json.nifty500);
      }
    } catch { /* ignore */ }
    finally { setLoadingSummary(false); }
  }, []);

  const handleRefresh = useCallback(async () => {
    // Trigger a real data sync (fetches today's quotes from Dhan), then refetch once it lands.
    // If a sync is already running elsewhere, just fall through to a plain re-fetch of cached data.
    try {
      setSyncing(true);
      const res = await fetch('/api/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'all' }),
      });
      if (res.status === 409) {
        // Already running — the refreshStatus poll below will pick up completion.
      }
    } catch { /* network error — fall back to re-fetching cached data */ }

    fetchStocks();
    fetchSummary();
    if (autoRefresh && countdownRef.current) {
      clearInterval(countdownRef.current);
      setCountdown(autoRefresh * 60);
      countdownRef.current = setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) { fetchStocks(); fetchSummary(); return autoRefresh * 60; }
          return c - 1;
        });
      }, 1000);
    }
  }, [fetchStocks, fetchSummary, autoRefresh]);

  // When the background sync (triggered by the button above, or auto-sync-on-mount below)
  // transitions from running -> done, refetch so the page picks up the freshly synced data.
  useEffect(() => {
    if (refreshStatus.running) {
      wasRunningRef.current = true;
    } else if (wasRunningRef.current) {
      wasRunningRef.current = false;
      setSyncing(false);
      fetchStocks();
      fetchSummary();
    }
  }, [refreshStatus.running, fetchStocks, fetchSummary]);

  // Auto-sync on mount: if CSV data is behind the last trading day, start refresh in background
  useEffect(() => {
    const autoSyncIfStale = async () => {
      try {
        const res = await fetch('/api/refresh');
        const json = await res.json();
        if (json.running || !json.stale) return;
        await fetch('/api/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 'all' }),
        });
      } catch { /* ignore network errors */ }
    };
    autoSyncIfStale();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchStocks(); }, [indexType, lookback]);
  useEffect(() => { fetchSummary(); }, []);

  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    if (!autoRefresh) { setCountdown(0); return; }
    setCountdown(autoRefresh * 60);
    countdownRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { fetchStocks(); fetchSummary(); return autoRefresh * 60; }
        return c - 1;
      });
    }, 1000);
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [autoRefresh]);

  const summaryStats = useMemo(() => {
    let advances = 0, declines = 0;
    const ratingCounts = { A: 0, B: 0, C: 0, D: 0 };
    stocks.forEach((s) => {
      if (s.priceChange1D >= 0) advances++; else declines++;
      if (s.rsRating in ratingCounts) ratingCounts[s.rsRating]++;
    });
    return { advances, declines, ratingCounts };
  }, [stocks]);

  const countdownDisplay = autoRefresh
    ? `${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, '0')}`
    : null;

  const lastUpdatedDisplay = lastUpdated
    ? lastUpdated.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    : null;

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-zinc-950 text-white">
      {/* ── Sticky Header (dhan-bloomberg-dashboard-page formula) ── */}
      <header className="flex-none w-full border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-5 py-2.5 flex items-center gap-4 z-20 flex-wrap">
        {/* Brand */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="h-8 w-8 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-center shrink-0">
            <Layers className="h-4 w-4 text-amber-400" />
          </div>
          <div>
            <p className="text-[9px] font-bold text-amber-400 uppercase tracking-[0.18em] mb-0.5">
              Analytics · Relative Strength
            </p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">
              Relative Strength Scanner
            </h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">Mansfield RS Line · NSE Equities</p>
          </div>
        </div>

        {/* Page Switcher */}
        <NavBar />

        {/* Controls */}
        <div className="flex items-center gap-2 flex-wrap ml-auto">

          {/* Lookback */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            {([50, 100, 252] as const).map((lb) => (
              <button
                key={lb}
                onClick={() => setLookback(lb)}
                className={`px-2.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  lookback === lb ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30' : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
                }`}
                title={`RS Lookback: ${lb} trading days`}
              >
                {lb === 252 ? '52w' : `${lb}d`}
              </button>
            ))}
          </div>

          {/* Index Selector */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            {(['nifty50', 'nifty500'] as const).map((idx) => (
              <button
                key={idx}
                onClick={() => setIndexType(idx)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  indexType === idx ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30' : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
                }`}
              >
                {idx === 'nifty50' ? 'Nifty 50' : 'Nifty 500'}
              </button>
            ))}
          </div>

          {/* Auto-refresh dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<button className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5 rounded-lg text-xs h-8', autoRefresh ? 'bg-amber-500/15 border-amber-500/30 text-amber-400 hover:bg-amber-500/20' : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200')} />}
            >
              {autoRefresh ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              <span>{autoRefresh ? `${autoRefresh}m` : 'Auto'}</span>
              {countdownDisplay && <span className="font-mono text-[10px] text-zinc-400 tabular-nums">{countdownDisplay}</span>}
              <ChevronDown className="h-3 w-3 text-zinc-500" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[160px]">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider">Auto-Refresh</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setAutoRefresh(null)}
                className={!autoRefresh ? 'text-amber-400' : ''}
              >
                Off
              </DropdownMenuItem>
              {AUTO_REFRESH_OPTIONS.map((min) => (
                <DropdownMenuItem
                  key={min}
                  onClick={() => setAutoRefresh(min)}
                  className={autoRefresh === min ? 'text-amber-400' : ''}
                >
                  Every {min} minutes
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Refresh + last updated */}
          <div className="flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger
                onClick={handleRefresh}
                render={<button className={cn(buttonVariants({ variant: 'outline', size: 'icon' }), 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-amber-400 hover:border-amber-500/40 rounded-lg h-8 w-8')} />}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${(syncing || refreshStatus.running || loadingStocks) ? 'animate-spin text-amber-400' : ''}`} />
              </TooltipTrigger>
              <TooltipContent>Refresh dashboard data</TooltipContent>
            </Tooltip>
            {lastUpdatedDisplay && (
              <span className="text-[10px] text-zinc-500 font-mono hidden sm:block tabular-nums">
                {lastUpdatedDisplay}
              </span>
            )}
          </div>

          {/* IST Clock + Market Status */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900">
            <div className={`w-1.5 h-1.5 rounded-full ${marketOpen ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`} />
            <Clock className="h-3 w-3 text-zinc-500" />
            <span className="font-mono text-xs text-zinc-300 tabular-nums">{istTime || '--:--:--'}</span>
            <Badge
              className={`text-[9px] h-4 px-1.5 font-bold uppercase tracking-wide border-0 ${
                marketOpen
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : 'bg-zinc-800 text-zinc-500'
              }`}
            >
              {marketOpen ? 'LIVE' : 'CLOSED'}
            </Badge>
          </div>
        </div>
      </header>

      {/* ── Index Summary ── */}
      <div className="flex-none px-5 pt-3 pb-1">
        <IndexSummary
          nifty50={nifty50Stats}
          nifty500={nifty500Stats}
          loading={loadingSummary}
          advances={summaryStats.advances}
          declines={summaryStats.declines}
          ratingCounts={summaryStats.ratingCounts}
        />
      </div>

      {/* ── Main Split-Pane ── */}
      <main className="flex-1 flex gap-3 px-5 pb-4 pt-3 min-h-0 overflow-hidden">
        {/* Left Panel */}
        <div className="flex flex-col min-h-0 w-[42%] shrink-0">
          <div className="flex-none flex items-center justify-between mb-2">
            <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg gap-0.5">
              <button
                onClick={() => setActiveTab('leaderboard')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                  activeTab === 'leaderboard' ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30' : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
                }`}
              >
                <List className="h-3.5 w-3.5" />
                Leaderboard
              </button>
              <button
                onClick={() => setActiveTab('heatmap')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                  activeTab === 'heatmap' ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30' : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
                }`}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                Sectors
              </button>
            </div>
            <div className="text-[10px] text-zinc-500 font-mono">{stocks.length} assets</div>
          </div>

          <div className="flex-1 min-h-0 overflow-hidden">
            {loadingStocks ? (
              <div className="flex flex-col items-center justify-center h-full rounded-xl border border-zinc-800 bg-zinc-900/70">
                <RefreshCw className="h-7 w-7 text-amber-400 animate-spin" />
                <span className="text-zinc-500 text-xs mt-3 text-center px-4">Computing Mansfield RS ratios...</span>
              </div>
            ) : stocksError ? (
              <div className="flex flex-col items-center justify-center h-full rounded-xl border border-red-500/20 bg-red-950/20 text-center">
                <p className="text-sm font-semibold text-red-400">Failed to load</p>
                <p className="text-xs text-zinc-500 mt-1 px-4">{stocksError}</p>
              </div>
            ) : activeTab === 'leaderboard' ? (
              <Leaderboard
                data={stocks}
                selectedSymbol={selectedSymbol}
                onSelectSymbol={setSelectedSymbol}
                favorites={favorites}
                onToggleFavorite={handleToggleFavorite}
              />
            ) : (
              <SectorHeatmap
                data={stocks}
                selectedSymbol={selectedSymbol}
                onSelectSymbol={setSelectedSymbol}
              />
            )}
          </div>
        </div>

        {/* Right Panel */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <RSChart symbol={selectedSymbol} indexType={indexType} lookback={lookback} />
        </div>
      </main>

    </div>
  );
}
