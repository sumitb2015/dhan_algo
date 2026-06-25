'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Layers, RefreshCw, TrendingUp, TrendingDown, LogOut, AlertTriangle } from 'lucide-react';
import StrategyCard from '@/components/StrategyCard';
import Link from 'next/link';

interface PortfolioData {
  success: boolean;
  available_funds: number;
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  total_pnl: number;
  positions: any[];
  error?: string;
}

export default function StrategiesPage() {
  const [strategies, setStrategies] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [portfolio, setPortfolio] = useState<PortfolioData | null>(null);
  const [portfolioLoading, setPortfolioLoading] = useState<boolean>(false);

  const [confirmGlobalExit, setConfirmGlobalExit] = useState<boolean>(false);
  const [globalExiting, setGlobalExiting] = useState<boolean>(false);

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
    } catch {
      setError('Network error. Failed to communicate with local API.');
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  const fetchPortfolio = useCallback(async () => {
    setPortfolioLoading(true);
    try {
      const res = await fetch('/api/portfolio');
      const data = await res.json();
      setPortfolio(data);
    } catch {
      setPortfolio(null);
    } finally {
      setPortfolioLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStrategies(true);
    const interval = setInterval(() => fetchStrategies(false), 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    fetchPortfolio();
    const interval = setInterval(fetchPortfolio, 20000);
    return () => clearInterval(interval);
  }, [fetchPortfolio]);

  const runningCount = Object.values(strategies).filter(
    (s: any) => s.state?.status !== 'STOPPED'
  ).length;

  const handleGlobalExit = async () => {
    if (!confirmGlobalExit) {
      setConfirmGlobalExit(true);
      setTimeout(() => setConfirmGlobalExit(false), 3000);
      return;
    }
    setGlobalExiting(true);
    setConfirmGlobalExit(false);
    try {
      await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop_all' }),
      });
    } finally {
      setGlobalExiting(false);
      setTimeout(() => fetchStrategies(false), 500);
    }
  };

  const pnl = portfolio?.total_pnl ?? 0;
  const pnlPositive = pnl >= 0;

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-150">

      {/* Header */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/60 backdrop-blur-md px-4 py-2.5 flex items-center justify-between gap-4 z-20">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center shadow-md shadow-emerald-500/10 shrink-0">
            <Layers className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-white leading-none">
              Dhan Algo — Strategies
            </h1>
            <p className="text-[10px] text-zinc-500 mt-0.5">Automated Options Control Center</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Nav tabs */}
          <nav className="flex items-center bg-zinc-900/70 border border-zinc-800/60 p-0.5 rounded-lg gap-0.5">
            {[
              { href: '/', label: 'RS Scanner' },
              { href: '/movers', label: 'Market Movers' },
              { label: 'Strategies', active: true },
              { href: '/portfolio', label: 'Portfolio' },
              { href: '/reports', label: 'Reports' },
            ].map((item) =>
              item.href ? (
                <Link
                  key={item.label}
                  href={item.href}
                  className="px-3 py-1 text-[11px] font-semibold rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 transition-all"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  key={item.label}
                  className="px-3 py-1 text-[11px] font-semibold rounded-md bg-emerald-500/10 text-emerald-400"
                >
                  {item.label}
                </span>
              )
            )}
          </nav>

          <button
            onClick={() => fetchStrategies(true)}
            className="p-1.5 border border-zinc-800 rounded-lg bg-zinc-900/40 text-zinc-500 hover:text-white hover:border-zinc-700 transition-all active:scale-95"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* Portfolio P&L + Global Exit bar */}
      <div className="w-full border-b border-zinc-900 bg-zinc-950/80 px-4 py-2 flex items-center justify-between gap-4">
        {/* P&L summary */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            {portfolioLoading && !portfolio ? (
              <RefreshCw className="h-3 w-3 text-zinc-600 animate-spin" />
            ) : pnlPositive ? (
              <TrendingUp className="h-4 w-4 text-emerald-400" />
            ) : (
              <TrendingDown className="h-4 w-4 text-red-400" />
            )}
            <span className="text-[11px] text-zinc-500 font-medium">Dhan P&L</span>
            <span
              className={`text-sm font-bold tabular-nums ${
                portfolio
                  ? pnlPositive
                    ? 'text-emerald-400'
                    : 'text-red-400'
                  : 'text-zinc-600'
              }`}
            >
              {portfolio
                ? `${pnlPositive ? '+' : ''}₹${pnl.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : '—'}
            </span>
          </div>

          {portfolio && (
            <>
              <div className="h-3.5 w-px bg-zinc-800" />
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-zinc-600">Realized</span>
                <span className={`text-[10px] font-semibold tabular-nums ${portfolio.total_realized_pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                  {portfolio.total_realized_pnl >= 0 ? '+' : ''}₹{portfolio.total_realized_pnl.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
              <div className="h-3.5 w-px bg-zinc-800" />
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-zinc-600">Unrealized</span>
                <span className={`text-[10px] font-semibold tabular-nums ${portfolio.total_unrealized_pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                  {portfolio.total_unrealized_pnl >= 0 ? '+' : ''}₹{portfolio.total_unrealized_pnl.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
              <div className="h-3.5 w-px bg-zinc-800" />
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-zinc-600">Margin</span>
                <span className="text-[10px] font-semibold text-zinc-400 tabular-nums">
                  ₹{portfolio.available_funds.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </span>
              </div>
              <div className="h-3.5 w-px bg-zinc-800" />
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-zinc-600">Positions</span>
                <span className="text-[10px] font-semibold text-zinc-400">{portfolio.positions.length}</span>
              </div>
            </>
          )}

          <button
            onClick={fetchPortfolio}
            disabled={portfolioLoading}
            className="p-1 rounded text-zinc-600 hover:text-zinc-400 transition-colors disabled:opacity-40"
            title="Refresh P&L"
          >
            <RefreshCw className={`h-2.5 w-2.5 ${portfolioLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Global Exit */}
        <div className="flex items-center gap-2">
          {runningCount > 0 && (
            <span className="text-[10px] text-zinc-500">{runningCount} running</span>
          )}
          <button
            onClick={handleGlobalExit}
            disabled={globalExiting || runningCount === 0}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed ${
              confirmGlobalExit
                ? 'bg-red-600 border-red-500 text-white animate-pulse'
                : globalExiting
                ? 'bg-red-900/40 border-red-800 text-red-400'
                : 'bg-red-950/60 border-red-900/60 text-red-400 hover:bg-red-900/40 hover:border-red-700 hover:text-red-300'
            }`}
            title={runningCount === 0 ? 'No strategies running' : confirmGlobalExit ? 'Click again to confirm' : 'Stop all running strategies'}
          >
            {globalExiting ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : confirmGlobalExit ? (
              <AlertTriangle className="h-3 w-3" />
            ) : (
              <LogOut className="h-3 w-3" />
            )}
            {globalExiting ? 'Stopping…' : confirmGlobalExit ? 'Confirm Exit All?' : 'Global Exit'}
          </button>
        </div>
      </div>

      {/* Main */}
      <main className="flex-1 w-full max-w-[1400px] mx-auto px-4 py-4">
        {loading && Object.keys(strategies).length === 0 ? (
          <div className="flex flex-col items-center justify-center p-16 rounded-xl border border-zinc-900 bg-zinc-950/60 min-h-[260px]">
            <RefreshCw className="h-6 w-6 text-emerald-500 animate-spin" />
            <span className="text-zinc-600 text-xs mt-3">Connecting to strategy API…</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center p-12 rounded-xl border border-red-500/20 bg-red-950/10 text-center min-h-[260px]">
            <p className="text-sm font-semibold text-red-400">Connection Failed</p>
            <p className="text-xs text-zinc-600 mt-1">{error}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
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
