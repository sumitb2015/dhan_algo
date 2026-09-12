'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Calendar,
  Check,
  CheckCircle2,
  ChevronRight,
  Compass,
  ExternalLink,
  Flame,
  HelpCircle,
  Info,
  Layers,
  Percent,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  TrendingDown,
  TrendingUp,
  X,
  Zap,
} from 'lucide-react';
import type { TrendConfluenceResponse, StockConfluenceItem } from '@/lib/trendConfluence';
import NavBar from './NavBar';

type StarFilter = '5' | '4plus' | '3' | 'bearish' | 'all';

export default function TrendConfluenceBlotter() {
  const [data, setData] = useState<TrendConfluenceResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [starFilter, setStarFilter] = useState<StarFilter>('4plus');
  const [selectedSector, setSelectedSector] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const fetchData = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/trend-confluence${force ? '?refresh=true' : ''}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as TrendConfluenceResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch trend confluence data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const sectorsList = useMemo(() => {
    if (!data) return [];
    const set = new Set<string>();
    data.stocks.forEach((s) => {
      if (s.sector) set.add(s.sector);
    });
    return Array.from(set).sort();
  }, [data]);

  const filteredStocks = useMemo(() => {
    if (!data) return [];
    let list = [...data.stocks];

    if (starFilter === '5') {
      list = list.filter((s) => s.stars === 5);
    } else if (starFilter === '4plus') {
      list = list.filter((s) => s.stars >= 4);
    } else if (starFilter === '3') {
      list = list.filter((s) => s.stars === 3);
    } else if (starFilter === 'bearish') {
      list = list.filter((s) => s.stars <= 2);
    }

    if (selectedSector !== 'all') {
      list = list.filter((s) => s.sector === selectedSector);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (s) => s.symbol.toLowerCase().includes(q) || s.sector.toLowerCase().includes(q)
      );
    }

    return list;
  }, [data, starFilter, selectedSector, searchQuery]);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-zinc-100 selection:bg-emerald-500/30">
      {/* Sticky Header */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-4 px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center justify-center w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700 transition-colors"
            title="Return to Terminal Home"
          >
            <Compass className="w-4 h-4 text-amber-400" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-400">
                MULTI-TIMEFRAME CONFLUENCE · EXECUTION BLOTTER
              </span>
              {data?.dataDate && (
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
                  DATA: {data.dataDate}
                </span>
              )}
            </div>
            <h1 className="text-sm font-bold text-white tracking-tight flex items-center gap-2">
              Multi-Timeframe Trend Confluence
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-400 font-medium">
                Weekly · Daily · ADX · RS Matrix
              </span>
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => fetchData(true)}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white hover:border-zinc-700 disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-emerald-400' : ''}`} />
            <span>Recalculate</span>
          </button>
          <NavBar />
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 px-6 py-5 flex flex-col gap-5 max-w-[1700px] mx-auto w-full">
        {error && (
          <div className="p-3.5 rounded-xl border border-red-800/60 bg-red-950/40 text-red-300 text-xs">
            Failed to load data: {error}
          </div>
        )}

        {/* ─── Top KPI Metric Cards ─────────────────────────────────────────── */}
        <section className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
          <div className="p-4 rounded-xl border border-emerald-500/30 bg-emerald-950/15 flex flex-col justify-between font-mono">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                ELITE 5-STAR CONFLUENCE
              </span>
              <Sparkles className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="text-2xl font-black text-emerald-400 mt-1 tabular-nums">
              {data?.star5Count ?? '—'}
            </div>
            <span className="text-[10px] text-emerald-500/80 mt-1">
              Full Multi-Timeframe Alignment
            </span>
          </div>

          <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/60 flex flex-col justify-between font-mono">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
              HIGH CONFLUENCE (4★+)
            </span>
            <div className="text-2xl font-black text-white mt-1 tabular-nums">
              {data ? data.star5Count + data.star4Count : '—'}
            </div>
            <span className="text-[10px] text-zinc-500 mt-1">Eligible for Long Trades (≥4★)</span>
          </div>

          <div className="p-4 rounded-xl border border-amber-500/30 bg-amber-950/15 flex flex-col justify-between font-mono">
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400">
              NEUTRAL / CHOPPY (3★)
            </span>
            <div className="text-2xl font-black text-amber-400 mt-1 tabular-nums">
              {data?.star3Count ?? '—'}
            </div>
            <span className="text-[10px] text-amber-500/80 mt-1">Mixed Signals / Consolidation</span>
          </div>

          <div className="p-4 rounded-xl border border-red-500/30 bg-red-950/15 flex flex-col justify-between font-mono">
            <span className="text-[10px] font-bold uppercase tracking-wider text-red-400">
              BEARISH BREAKDOWN (1–2★)
            </span>
            <div className="text-2xl font-black text-red-400 mt-1 tabular-nums">
              {data?.bearishCount ?? '—'}
            </div>
            <span className="text-[10px] text-red-500/80 mt-1">Avoid Longs / Breakdown Risk</span>
          </div>
        </section>

        {/* ─── Institutional Guidance Banner ─────────────────────────────────── */}
        <section className="p-3 rounded-xl border border-zinc-800 bg-zinc-900/50 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs font-mono">
          <div className="flex items-center gap-2 text-zinc-300">
            <Info className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              <strong className="text-white">CONFLUENCE DISCIPLINE:</strong> Only take swing or momentum longs when a stock has <strong className="text-emerald-400">≥ 4 Stars</strong>. Weekly trend alignment prevents entering setups doomed by higher-timeframe resistance.
            </span>
          </div>
        </section>

        {/* ─── Filter & Search Toolbar ──────────────────────────────────────── */}
        <section className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 bg-zinc-900/70 border border-zinc-800 rounded-xl p-3">
          <div className="flex items-center gap-1 overflow-x-auto pb-1 md:pb-0">
            <button
              onClick={() => setStarFilter('4plus')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                starFilter === '4plus'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              Qualified Longs (≥4★) ({data ? data.star5Count + data.star4Count : 0})
            </button>
            <button
              onClick={() => setStarFilter('5')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                starFilter === '5'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              Elite 5★ ({data?.star5Count ?? 0})
            </button>
            <button
              onClick={() => setStarFilter('3')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                starFilter === '3'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              Neutral 3★ ({data?.star3Count ?? 0})
            </button>
            <button
              onClick={() => setStarFilter('bearish')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                starFilter === 'bearish'
                  ? 'bg-red-500/20 text-red-300 border border-red-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              Bearish Avoid (1–2★) ({data?.bearishCount ?? 0})
            </button>
            <button
              onClick={() => setStarFilter('all')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                starFilter === 'all'
                  ? 'bg-zinc-800 text-white border border-zinc-700 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              All Stocks ({data?.totalScanned ?? 0})
            </button>
          </div>

          <div className="flex items-center gap-2.5">
            <select
              value={selectedSector}
              onChange={(e) => setSelectedSector(e.target.value)}
              className="bg-zinc-950 border border-zinc-800 text-zinc-300 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500/50"
            >
              <option value="all">All Sectors ({sectorsList.length})</option>
              {sectorsList.map((sec) => (
                <option key={sec} value={sec}>
                  {sec}
                </option>
              ))}
            </select>

            <div className="relative w-48 sm:w-60">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search symbol or sector…"
                className="w-full bg-zinc-950 border border-zinc-800 text-zinc-200 text-xs rounded-lg pl-8 pr-3 py-1.5 focus:outline-none focus:border-emerald-500/50 font-mono"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </section>

        {/* ─── Traffic-Light Confluence Table ────────────────────────────────── */}
        <section className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden flex flex-col">
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead className="bg-zinc-800 text-xs font-bold text-white">
                <tr>
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Symbol</th>
                  <th className="px-4 py-3">Sector</th>
                  <th className="px-4 py-3">LTP</th>
                  <th className="px-4 py-3">1D %</th>
                  <th className="px-4 py-3 text-center">Confluence Score</th>
                  <th className="px-4 py-3 text-center">Weekly Trend (10/40)</th>
                  <th className="px-4 py-3 text-center">Daily Trend (50/200)</th>
                  <th className="px-4 py-3 text-center">Momentum (20 EMA)</th>
                  <th className="px-4 py-3 text-center">ADX Trend Strength</th>
                  <th className="px-4 py-3 text-center">Mansfield RS</th>
                  <th className="px-4 py-3 text-right">Verdict Signal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80 bg-zinc-950/60">
                {loading ? (
                  <tr>
                    <td colSpan={12} className="px-4 py-12 text-center text-zinc-500">
                      <div className="flex items-center justify-center gap-2">
                        <Activity className="w-4 h-4 animate-spin text-emerald-400" />
                        <span>Evaluating multi-timeframe confluence across Nifty 500…</span>
                      </div>
                    </td>
                  </tr>
                ) : filteredStocks.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-4 py-12 text-center text-zinc-500">
                      No stocks found matching the criteria.
                    </td>
                  </tr>
                ) : (
                  filteredStocks.map((s, idx) => {
                    const is5 = s.stars === 5;
                    const is4 = s.stars === 4;
                    const isBear = s.stars <= 2;

                    return (
                      <tr key={s.symbol} className="hover:bg-zinc-900/70 transition-colors">
                        <td className="px-4 py-2.5 text-zinc-500 text-[11px]">{idx + 1}</td>
                        <td className="px-4 py-2.5 font-bold text-white flex items-center gap-1.5">
                          <span>{s.symbol}</span>
                          {is5 && (
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" title="5★ Full Confluence" />
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-zinc-400 text-[11px] truncate max-w-[120px]">
                          {s.sector}
                        </td>
                        <td className="px-4 py-2.5 text-white font-bold tabular-nums">
                          ₹{s.price.toFixed(2)}
                        </td>
                        <td
                          className={`px-4 py-2.5 font-bold tabular-nums ${
                            s.change1D >= 0 ? 'text-emerald-400' : 'text-red-400'
                          }`}
                        >
                          {s.change1D >= 0 ? '+' : ''}
                          {s.change1D.toFixed(2)}%
                        </td>

                        {/* Visual Star Rating */}
                        <td className="px-4 py-2.5 text-center">
                          <div className="flex items-center justify-center gap-0.5">
                            {[1, 2, 3, 4, 5].map((st) => (
                              <Star
                                key={st}
                                className={`w-3.5 h-3.5 ${
                                  st <= s.stars
                                    ? s.stars >= 4
                                      ? 'text-amber-400 fill-amber-400'
                                      : 'text-zinc-400 fill-zinc-400'
                                    : 'text-zinc-700'
                                }`}
                              />
                            ))}
                          </div>
                        </td>

                        {/* Weekly Trend */}
                        <td className="px-4 py-2.5 text-center">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              s.signals.weeklyUptrend
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                : 'bg-red-500/10 text-red-400 border border-red-500/20'
                            }`}
                          >
                            {s.signals.weeklyUptrend ? 'BULLISH' : 'BEARISH'}
                          </span>
                        </td>

                        {/* Daily Trend */}
                        <td className="px-4 py-2.5 text-center">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              s.signals.dailyUptrend
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                : 'bg-red-500/10 text-red-400 border border-red-500/20'
                            }`}
                          >
                            {s.signals.dailyUptrend ? 'BULLISH' : 'BEARISH'}
                          </span>
                        </td>

                        {/* Momentum */}
                        <td className="px-4 py-2.5 text-center">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              s.signals.shortTermMomentum
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                            }`}
                          >
                            {s.signals.shortTermMomentum ? '&gt;20 EMA' : '&lt;20 EMA'}
                          </span>
                        </td>

                        {/* ADX Trend Strength */}
                        <td className="px-4 py-2.5 text-center tabular-nums">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              s.signals.adxStrong
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                            }`}
                          >
                            ADX {s.adx.toFixed(0)} {s.signals.adxStrong ? '🔥' : ''}
                          </span>
                        </td>

                        {/* Mansfield RS */}
                        <td className="px-4 py-2.5 text-center tabular-nums">
                          <span
                            className={
                              s.mansfieldRS > 0 ? 'text-emerald-400 font-bold' : 'text-zinc-500'
                            }
                          >
                            {s.mansfieldRS > 0 ? '+' : ''}
                            {s.mansfieldRS.toFixed(1)}%
                          </span>
                        </td>

                        {/* Verdict Signal */}
                        <td className="px-4 py-2.5 text-right">
                          <span
                            className={`px-2.5 py-0.5 rounded text-[10px] font-black border ${
                              is5
                                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                                : is4
                                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
                                  : isBear
                                    ? 'bg-red-500/20 text-red-400 border-red-500/30'
                                    : 'bg-zinc-800 text-zinc-300 border-zinc-700'
                            }`}
                          >
                            {s.actionSignal}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
