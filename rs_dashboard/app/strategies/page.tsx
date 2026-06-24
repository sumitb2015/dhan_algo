'use client';

import React, { useState, useEffect } from 'react';
import { Layers, RefreshCw } from 'lucide-react';
import StrategyCard from '@/components/StrategyCard';
import Link from 'next/link';

export default function StrategiesPage() {
  const [strategies, setStrategies] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStrategies = async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const res = await fetch('/api/strategies');
      const data = await res.json();
      if (data.success) {
        setStrategies(data.strategies);
        setError(null);
      } else {
        setError(data.error || 'Failed to retrieve strategies state');
      }
    } catch (err) {
      setError('Network error. Failed to communicate with local API.');
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  // Poll strategy states every 2 seconds
  useEffect(() => {
    fetchStrategies(true);
    const interval = setInterval(() => {
      fetchStrategies(false);
    }, 2000);
    return () => clearInterval(interval);
  }, []);



  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-150">
      {/* Header Panel */}
      <header className="relative w-full border-b border-zinc-900 bg-zinc-950/40 backdrop-blur-md px-5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 z-20">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-500/10">
            <Layers className="h-5 w-5 text-white animate-pulse" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white bg-gradient-to-r from-white via-zinc-200 to-zinc-500 bg-clip-text text-transparent">
              Relative Strength Trading Algo
            </h1>
            <p className="text-xs text-zinc-500 font-medium">Automated Options Strategies Control Center</p>
          </div>
        </div>

        {/* Global Action Navigation */}
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center bg-zinc-900/80 border border-zinc-850 p-1 rounded-xl">
            <Link
              href="/"
              className="px-4 py-1.5 text-xs font-semibold rounded-lg text-zinc-500 hover:text-zinc-300 transition-all"
            >
              Mansfield RS Scanner
            </Link>
            <button
              className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 transition-all"
            >
              Algo Strategies Control
            </button>
          </div>

          <button
            onClick={() => fetchStrategies(true)}
            className="p-2 border border-zinc-800 rounded-xl bg-zinc-900/40 text-zinc-400 hover:text-white transition-all duration-200 hover:border-zinc-700 active:scale-95"
            title="Refresh Strategies State"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 w-full max-w-[96%] mx-auto px-4 py-4 flex flex-col gap-4">

        {/* Strategies Cards list grid */}
        {loading && Object.keys(strategies).length === 0 ? (
          <div className="flex flex-col items-center justify-center p-20 rounded-2xl border border-zinc-900 bg-zinc-950/60 backdrop-blur-md min-h-[300px]">
            <RefreshCw className="h-8 w-8 text-emerald-500 animate-spin" />
            <span className="text-zinc-500 text-xs mt-3">Connecting to local strategy API gateway and loading state directories...</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center p-12 rounded-2xl border border-red-500/25 bg-red-950/10 text-center text-zinc-400 min-h-[300px]">
            <p className="text-sm font-semibold text-red-400">Connection Failed</p>
            <p className="text-xs text-zinc-600 mt-1">{error}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {Object.entries(strategies).map(([key, item]) => (
              <StrategyCard
                key={key}
                meta={item.meta}
                state={item.state}
                onRefresh={fetchStrategies}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
