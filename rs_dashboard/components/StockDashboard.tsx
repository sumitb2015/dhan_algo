'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { LayoutGrid, List, RefreshCw, Layers } from 'lucide-react';
import { RSResult } from '@/lib/rs';
import IndexSummary from './IndexSummary';
import Leaderboard from './Leaderboard';
import RSChart from './RSChart';
import SectorHeatmap from './SectorHeatmap';

export default function StockDashboard() {
  const [indexType, setIndexType] = useState<'nifty50' | 'nifty500'>('nifty50');
  const [lookback, setLookback] = useState<50 | 100 | 252>(252);
  const [activeTab, setActiveTab] = useState<'leaderboard' | 'heatmap'>('leaderboard');
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);

  // API Data States
  const [stocks, setStocks] = useState<RSResult[]>([]);
  const [loadingStocks, setLoadingStocks] = useState(true);
  const [stocksError, setStocksError] = useState<string | null>(null);

  const [nifty50Stats, setNifty50Stats] = useState<any>(null);
  const [nifty500Stats, setNifty500Stats] = useState<any>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);

  // Load Watchlist/Favorites from LocalStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('rs_watchlist');
      if (stored) {
        setFavorites(JSON.parse(stored));
      }
    } catch (e) {
      console.error('Failed to load watchlist from localStorage', e);
    }
  }, []);

  // Save Watchlist to LocalStorage
  const handleToggleFavorite = (symbol: string) => {
    setFavorites((prev) => {
      const updated = prev.includes(symbol)
        ? prev.filter((s) => s !== symbol)
        : [...prev, symbol];
      try {
        localStorage.setItem('rs_watchlist', JSON.stringify(updated));
      } catch (e) {
        console.error('Failed to save watchlist to localStorage', e);
      }
      return updated;
    });
  };

  // Fetch stocks when indexType changes
  const fetchStocks = async () => {
    setLoadingStocks(true);
    setStocksError(null);
    try {
      const res = await fetch(`/api/stocks?index=${indexType}&lookback=${lookback}`);
      const json = await res.json();
      if (json.success) {
        setStocks(json.data);
        // Default select first symbol in list if nothing selected yet or symbol isn't in current list
        const symbolExists = json.data.some((item: any) => item.symbol === selectedSymbol);
        if (json.data.length > 0 && (!selectedSymbol || !symbolExists)) {
          setSelectedSymbol(json.data[0].symbol);
        }
      } else {
        setStocksError(json.error || 'Failed to retrieve stocks list');
      }
    } catch (err) {
      setStocksError('Network error. Failed to retrieve stocks list.');
    } finally {
      setLoadingStocks(false);
    }
  };

  // Fetch index summary
  const fetchSummary = async () => {
    setLoadingSummary(true);
    try {
      const res = await fetch('/api/summary');
      const json = await res.json();
      if (json.success) {
        setNifty50Stats(json.nifty50);
        setNifty500Stats(json.nifty500);
      }
    } catch (err) {
      console.error('Failed to load index summary', err);
    } finally {
      setLoadingSummary(false);
    }
  };

  useEffect(() => {
    fetchStocks();
  }, [indexType, lookback]);

  useEffect(() => {
    fetchSummary();
  }, []);

  // Compute stats for current stocks list
  const summaryStats = useMemo(() => {
    let advances = 0;
    let declines = 0;
    const ratingCounts = { A: 0, B: 0, C: 0, D: 0 };

    stocks.forEach((s) => {
      if (s.priceChange1D >= 0) advances++;
      else declines++;

      if (s.rsRating in ratingCounts) {
        ratingCounts[s.rsRating]++;
      }
    });

    return { advances, declines, ratingCounts };
  }, [stocks]);

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-150">
      {/* Dynamic Header */}
      <header className="relative w-full border-b border-zinc-900 bg-zinc-950/40 backdrop-blur-md px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 z-20">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-500/10">
            <Layers className="h-5 w-5 text-white animate-pulse" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white bg-gradient-to-r from-white via-zinc-200 to-zinc-500 bg-clip-text text-transparent">
              Relative Strength Trading Algo
            </h1>
            <p className="text-xs text-zinc-500 font-medium">Mansfield RS Line Scanner &amp; Sector Heatmap</p>
          </div>
        </div>

        {/* Global Controls */}
        <div className="flex flex-wrap items-center gap-4">
          {/* Lookback Selector */}
          <div className="flex items-center bg-zinc-900/80 border border-zinc-850 p-1 rounded-xl">
            {([50, 100, 252] as const).map((lb) => (
              <button
                key={lb}
                onClick={() => setLookback(lb)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  lookback === lb
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
                title={`RS Lookback: ${lb} trading days`}
              >
                {lb === 252 ? '252d (52w)' : `${lb}d`}
              </button>
            ))}
          </div>

          {/* Index Selector Tab */}
          <div className="flex items-center bg-zinc-900/80 border border-zinc-850 p-1 rounded-xl">
            <button
              onClick={() => setIndexType('nifty50')}
              className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                indexType === 'nifty50'
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Nifty 50
            </button>
            <button
              onClick={() => setIndexType('nifty500')}
              className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                indexType === 'nifty500'
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Nifty 500
            </button>
          </div>

          {/* Refresh Action */}
          <button
            onClick={() => {
              fetchStocks();
              fetchSummary();
            }}
            className="p-2 border border-zinc-800 rounded-xl bg-zinc-900/40 text-zinc-400 hover:text-white transition-all duration-200 hover:border-zinc-700 active:scale-95"
            title="Refresh Dashboard Data"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Main Workspace Layout */}
      <main className="flex-1 w-full max-w-[96%] mx-auto px-6 py-6 flex flex-col gap-6">
        {/* Index Summary Section */}
        <IndexSummary
          nifty50={nifty50Stats}
          nifty500={nifty500Stats}
          loading={loadingSummary}
          advances={summaryStats.advances}
          declines={summaryStats.declines}
          ratingCounts={summaryStats.ratingCounts}
        />

        {/* Full-width Charts Panel */}
        <div className="w-full">
          <RSChart symbol={selectedSymbol} indexType={indexType} lookback={lookback} />
        </div>

        {/* Workspaces Panel: Switcher + Scanner */}
        <div className="w-full flex flex-col gap-4">
          {/* View Switcher Bar */}
          <div className="flex items-center justify-between border border-zinc-900 bg-zinc-950/40 backdrop-blur-md p-1.5 rounded-xl">
            <div className="flex items-center gap-1">
              <button
                onClick={() => setActiveTab('leaderboard')}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all ${
                  activeTab === 'leaderboard'
                    ? 'bg-zinc-850 text-white shadow-sm border border-zinc-800'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <List className="h-3.5 w-3.5" />
                <span>Leaderboard Table</span>
              </button>
              <button
                onClick={() => setActiveTab('heatmap')}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all ${
                  activeTab === 'heatmap'
                    ? 'bg-zinc-850 text-white shadow-sm border border-zinc-800'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                <span>Sector Heatmap</span>
              </button>
            </div>

            <div className="text-[10px] text-zinc-500 font-mono pr-2">
              Scan count: {stocks.length} assets
            </div>
          </div>

          {/* Tab Panels */}
          {loadingStocks ? (
            <div className="flex flex-col items-center justify-center p-20 rounded-2xl border border-zinc-850 bg-zinc-950/60 backdrop-blur-md min-h-[450px]">
              <RefreshCw className="h-8 w-8 text-emerald-500 animate-spin" />
              <span className="text-zinc-500 text-xs mt-3">Analyzing daily historical charts and compiling Mansfield index relative strength ratios...</span>
            </div>
          ) : stocksError ? (
            <div className="flex flex-col items-center justify-center p-12 rounded-2xl border border-red-500/25 bg-red-950/10 text-center text-zinc-400 min-h-[450px]">
              <p className="text-sm font-semibold text-red-400">Failed to render workspace</p>
              <p className="text-xs text-zinc-600 mt-1">{stocksError}</p>
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
      </main>
    </div>
  );
}
