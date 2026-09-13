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

type StarFilter = '5' | '4' | '4plus' | '3' | 'bearish' | 'all';
type SortField = 'symbol' | 'sector' | 'price' | 'change1D' | 'stars' | 'adx' | 'mansfieldRS';

export default function TrendConfluenceBlotter() {
  const [data, setData] = useState<TrendConfluenceResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [starFilter, setStarFilter] = useState<StarFilter>('4plus');
  const [selectedSector, setSelectedSector] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedStock, setSelectedStock] = useState<StockConfluenceItem | null>(null);

  const [sortField, setSortField] = useState<SortField>('stars');
  const [sortAsc, setSortAsc] = useState<boolean>(false);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc((prev) => !prev);
    } else {
      setSortField(field);
      setSortAsc(field === 'symbol' || field === 'sector');
    }
  };

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
    } else if (starFilter === '4') {
      list = list.filter((s) => s.stars === 4);
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

    list.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'symbol') cmp = a.symbol.localeCompare(b.symbol);
      else if (sortField === 'sector') cmp = a.sector.localeCompare(b.sector);
      else if (sortField === 'price') cmp = a.price - b.price;
      else if (sortField === 'change1D') cmp = a.change1D - b.change1D;
      else if (sortField === 'stars') {
        if (b.stars !== a.stars) cmp = a.stars - b.stars;
        else cmp = a.mansfieldRS - b.mansfieldRS;
      } else if (sortField === 'adx') cmp = a.adx - b.adx;
      else if (sortField === 'mansfieldRS') cmp = a.mansfieldRS - b.mansfieldRS;

      return sortAsc ? cmp : -cmp;
    });

    return list;
  }, [data, starFilter, selectedSector, searchQuery, sortField, sortAsc]);

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
              BEARISH AVOID (≤2★)
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
              <strong className="text-white">CONFLUENCE DISCIPLINE:</strong> Only take swing or momentum longs when a stock has <strong className="text-emerald-400">≥ 4 Stars</strong>. Weekly trend alignment prevents entering setups doomed by higher-timeframe resistance. Click any row to inspect full indicator math.
            </span>
          </div>
        </section>

        {/* ─── Filter & Search Toolbar ──────────────────────────────────────── */}
        <section className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 bg-zinc-900/70 border border-zinc-800 rounded-xl p-3">
          <div className="flex items-center gap-1 overflow-x-auto pb-1 md:pb-0">
            <button
              onClick={() => setStarFilter('4plus')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap cursor-pointer ${
                starFilter === '4plus'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              Qualified Longs (≥4★) ({data ? data.star5Count + data.star4Count : 0})
            </button>
            <button
              onClick={() => setStarFilter('5')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap cursor-pointer ${
                starFilter === '5'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              Elite 5★ ({data?.star5Count ?? 0})
            </button>
            <button
              onClick={() => setStarFilter('4')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap cursor-pointer ${
                starFilter === '4'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              Setup 4★ ({data?.star4Count ?? 0})
            </button>
            <button
              onClick={() => setStarFilter('3')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap cursor-pointer ${
                starFilter === '3'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              Neutral 3★ ({data?.star3Count ?? 0})
            </button>
            <button
              onClick={() => setStarFilter('bearish')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap cursor-pointer ${
                starFilter === 'bearish'
                  ? 'bg-red-500/20 text-red-300 border border-red-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              Bearish Avoid (≤2★) ({data?.bearishCount ?? 0})
            </button>
            <button
              onClick={() => setStarFilter('all')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap cursor-pointer ${
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
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 cursor-pointer"
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
                  <th
                    className="px-4 py-3 cursor-pointer hover:text-emerald-300 transition-colors select-none"
                    onClick={() => handleSort('symbol')}
                  >
                    Symbol {sortField === 'symbol' && (sortAsc ? '↑' : '↓')}
                  </th>
                  <th
                    className="px-4 py-3 cursor-pointer hover:text-emerald-300 transition-colors select-none"
                    onClick={() => handleSort('sector')}
                  >
                    Sector {sortField === 'sector' && (sortAsc ? '↑' : '↓')}
                  </th>
                  <th
                    className="px-4 py-3 cursor-pointer hover:text-emerald-300 transition-colors select-none"
                    onClick={() => handleSort('price')}
                  >
                    LTP {sortField === 'price' && (sortAsc ? '↑' : '↓')}
                  </th>
                  <th
                    className="px-4 py-3 cursor-pointer hover:text-emerald-300 transition-colors select-none"
                    onClick={() => handleSort('change1D')}
                  >
                    1D % {sortField === 'change1D' && (sortAsc ? '↑' : '↓')}
                  </th>
                  <th
                    className="px-4 py-3 text-center cursor-pointer hover:text-emerald-300 transition-colors select-none"
                    onClick={() => handleSort('stars')}
                  >
                    Confluence Score {sortField === 'stars' && (sortAsc ? '↑' : '↓')}
                  </th>
                  <th className="px-4 py-3 text-center">Weekly Trend (10/40)</th>
                  <th className="px-4 py-3 text-center">Daily Trend (50/200)</th>
                  <th className="px-4 py-3 text-center">Momentum (20 EMA Stack)</th>
                  <th
                    className="px-4 py-3 text-center cursor-pointer hover:text-emerald-300 transition-colors select-none"
                    onClick={() => handleSort('adx')}
                  >
                    ADX Trend {sortField === 'adx' && (sortAsc ? '↑' : '↓')}
                  </th>
                  <th
                    className="px-4 py-3 text-center cursor-pointer hover:text-emerald-300 transition-colors select-none"
                    onClick={() => handleSort('mansfieldRS')}
                  >
                    Mansfield RS {sortField === 'mansfieldRS' && (sortAsc ? '↑' : '↓')}
                  </th>
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
                      <tr
                        key={s.symbol}
                        onClick={() => setSelectedStock(s)}
                        className="hover:bg-zinc-900/70 transition-colors cursor-pointer"
                        title="Click to view detailed indicator audit"
                      >
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
                            title={`Weekly 10 EMA: ₹${s.weeklyEma10} | Weekly 40 EMA: ₹${s.weeklyEma40}`}
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
                            title={`Daily 50 EMA: ₹${s.dailyEma50} | Daily 200 EMA: ₹${s.dailyEma200}`}
                          >
                            {s.signals.dailyUptrend ? 'BULLISH' : 'BEARISH'}
                          </span>
                        </td>

                        {/* Momentum (Accurate status relative to 20 EMA and 50 EMA) */}
                        <td className="px-4 py-2.5 text-center">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              s.signals.shortTermMomentum
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                : s.signals.aboveEma20
                                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                  : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                            }`}
                            title={
                              s.signals.shortTermMomentum
                                ? `Bullish: Price (₹${s.price}) > 20 EMA (₹${s.dailyEma20}) & 20 EMA > 50 EMA (₹${s.dailyEma50})`
                                : s.signals.aboveEma20
                                  ? `Price (₹${s.price}) > 20 EMA (₹${s.dailyEma20}), but 20 EMA ≤ 50 EMA (₹${s.dailyEma50})`
                                  : `Price (₹${s.price}) < 20 EMA (₹${s.dailyEma20})`
                            }
                          >
                            {s.signals.shortTermMomentum
                              ? '>20 EMA (Aligned)'
                              : s.signals.aboveEma20
                                ? '>20 EMA (20≤50)'
                                : '<20 EMA'}
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

        {/* ─── Detailed Stock Audit Drawer ───────────────────────────────────── */}
        {selectedStock && (
          <div className="fixed inset-0 z-50 flex justify-end bg-oncolor-dark/70 backdrop-blur-sm transition-opacity">
            <div
              className="w-full max-w-lg bg-zinc-950 border-l border-zinc-800 h-full overflow-y-auto p-6 flex flex-col justify-between font-mono shadow-2xl animate-in slide-in-from-right duration-200"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex flex-col gap-5">
                {/* Header */}
                <div className="flex items-start justify-between pb-4 border-b border-zinc-800">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-xl font-black text-white">{selectedStock.symbol}</h2>
                      <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400 font-bold">
                        {selectedStock.sector}
                      </span>
                    </div>
                    <div className="flex items-baseline gap-3 mt-1.5">
                      <span className="text-2xl font-black text-white tabular-nums">
                        ₹{selectedStock.price.toFixed(2)}
                      </span>
                      <span
                        className={`text-xs font-bold tabular-nums ${
                          selectedStock.change1D >= 0 ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {selectedStock.change1D >= 0 ? '+' : ''}
                        {selectedStock.change1D.toFixed(2)}% (1D)
                      </span>
                      <span
                        className={`text-xs font-bold tabular-nums ${
                          selectedStock.change1W >= 0 ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {selectedStock.change1W >= 0 ? '+' : ''}
                        {selectedStock.change1W.toFixed(2)}% (1W)
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => setSelectedStock(null)}
                    className="p-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-900 transition-colors cursor-pointer"
                    title="Close"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {/* Score & Signal Banner */}
                <div className="p-3.5 rounded-xl border border-zinc-800 bg-zinc-900/60 flex items-center justify-between">
                  <div>
                    <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">
                      CONFLUENCE RATING
                    </span>
                    <div className="flex items-center gap-1 mt-1">
                      {[1, 2, 3, 4, 5].map((st) => (
                        <Star
                          key={st}
                          className={`w-4 h-4 ${
                            st <= selectedStock.stars
                              ? selectedStock.stars >= 4
                                ? 'text-amber-400 fill-amber-400'
                                : 'text-zinc-400 fill-zinc-400'
                              : 'text-zinc-700'
                          }`}
                        />
                      ))}
                      <span className="ml-1.5 text-xs font-bold text-white">
                        {selectedStock.stars} / 5 Criteria
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">
                      VERDICT
                    </span>
                    <div className="text-xs font-bold text-emerald-400 mt-1">
                      {selectedStock.actionSignal}
                    </div>
                  </div>
                </div>

                {/* 5-Criteria Audit Checklist */}
                <div className="flex flex-col gap-2.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                    5-Pillar Confluence Mathematical Audit
                  </span>

                  {/* 1. Weekly Uptrend */}
                  <div className="p-3 rounded-xl border border-zinc-800/80 bg-zinc-900/40 flex items-start justify-between gap-3 text-xs">
                    <div className="flex items-start gap-2.5">
                      {selectedStock.signals.weeklyUptrend ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      ) : (
                        <X className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                      )}
                      <div>
                        <div className="font-bold text-white">1. Weekly Trend (10 / 40 EMA)</div>
                        <div className="text-[11px] text-zinc-400 mt-0.5">
                          Weekly 10 EMA &gt; 40 EMA &amp; Close &gt; 10 EMA
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-1 tabular-nums">
                          Price: ₹{selectedStock.price.toFixed(1)} | W10: ₹{selectedStock.weeklyEma10.toFixed(1)} | W40: ₹{selectedStock.weeklyEma40.toFixed(1)}
                        </div>
                      </div>
                    </div>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                        selectedStock.signals.weeklyUptrend
                          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                          : 'bg-red-500/20 text-red-400 border-red-500/30'
                      }`}
                    >
                      {selectedStock.signals.weeklyUptrend ? 'PASS' : 'FAIL'}
                    </span>
                  </div>

                  {/* 2. Daily Uptrend */}
                  <div className="p-3 rounded-xl border border-zinc-800/80 bg-zinc-900/40 flex items-start justify-between gap-3 text-xs">
                    <div className="flex items-start gap-2.5">
                      {selectedStock.signals.dailyUptrend ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      ) : (
                        <X className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                      )}
                      <div>
                        <div className="font-bold text-white">2. Daily Major Trend (50 / 200 EMA)</div>
                        <div className="text-[11px] text-zinc-400 mt-0.5">
                          Daily Price &gt; 50 EMA &amp; 50 EMA &gt; 200 EMA
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-1 tabular-nums">
                          Price: ₹{selectedStock.price.toFixed(1)} | D50: ₹{selectedStock.dailyEma50.toFixed(1)} | D200: ₹{selectedStock.dailyEma200.toFixed(1)}
                        </div>
                      </div>
                    </div>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                        selectedStock.signals.dailyUptrend
                          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                          : 'bg-red-500/20 text-red-400 border-red-500/30'
                      }`}
                    >
                      {selectedStock.signals.dailyUptrend ? 'PASS' : 'FAIL'}
                    </span>
                  </div>

                  {/* 3. Short-Term Momentum */}
                  <div className="p-3 rounded-xl border border-zinc-800/80 bg-zinc-900/40 flex items-start justify-between gap-3 text-xs">
                    <div className="flex items-start gap-2.5">
                      {selectedStock.signals.shortTermMomentum ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      ) : (
                        <X className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                      )}
                      <div>
                        <div className="font-bold text-white">3. Short-Term Momentum (20 EMA Stack)</div>
                        <div className="text-[11px] text-zinc-400 mt-0.5">
                          Price &gt; 20 EMA &amp; 20 EMA &gt; 50 EMA
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-1 tabular-nums">
                          Price: ₹{selectedStock.price.toFixed(1)} | D20: ₹{selectedStock.dailyEma20.toFixed(1)} | D50: ₹{selectedStock.dailyEma50.toFixed(1)}
                        </div>
                      </div>
                    </div>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                        selectedStock.signals.shortTermMomentum
                          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                          : 'bg-red-500/20 text-red-400 border-red-500/30'
                      }`}
                    >
                      {selectedStock.signals.shortTermMomentum ? 'PASS' : 'FAIL'}
                    </span>
                  </div>

                  {/* 4. ADX Trend Strength */}
                  <div className="p-3 rounded-xl border border-zinc-800/80 bg-zinc-900/40 flex items-start justify-between gap-3 text-xs">
                    <div className="flex items-start gap-2.5">
                      {selectedStock.signals.adxStrong ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      ) : (
                        <X className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                      )}
                      <div>
                        <div className="font-bold text-white">4. Trend Strength (ADX 14)</div>
                        <div className="text-[11px] text-zinc-400 mt-0.5">
                          ADX(14) &ge; 25.0 (Wilder Strong Trend)
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-1 tabular-nums">
                          Current ADX: {selectedStock.adx.toFixed(1)}
                        </div>
                      </div>
                    </div>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                        selectedStock.signals.adxStrong
                          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                          : 'bg-red-500/20 text-red-400 border-red-500/30'
                      }`}
                    >
                      {selectedStock.signals.adxStrong ? 'PASS' : 'FAIL'}
                    </span>
                  </div>

                  {/* 5. Mansfield RS */}
                  <div className="p-3 rounded-xl border border-zinc-800/80 bg-zinc-900/40 flex items-start justify-between gap-3 text-xs">
                    <div className="flex items-start gap-2.5">
                      {selectedStock.signals.rsBullish ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      ) : (
                        <X className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                      )}
                      <div>
                        <div className="font-bold text-white">5. Mansfield Relative Strength</div>
                        <div className="text-[11px] text-zinc-400 mt-0.5">
                          52-Week RS vs Nifty 500 &ge; 0% (Outperforming)
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-1 tabular-nums">
                          Current Mansfield RS: {selectedStock.mansfieldRS > 0 ? '+' : ''}
                          {selectedStock.mansfieldRS.toFixed(1)}%
                        </div>
                      </div>
                    </div>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                        selectedStock.signals.rsBullish
                          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                          : 'bg-red-500/20 text-red-400 border-red-500/30'
                      }`}
                    >
                      {selectedStock.signals.rsBullish ? 'PASS' : 'FAIL'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className="pt-4 border-t border-zinc-800 flex items-center justify-between text-[11px] text-zinc-500">
                <span>Data Date: {selectedStock.dataDate}</span>
                <button
                  onClick={() => setSelectedStock(null)}
                  className="px-3 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 cursor-pointer"
                >
                  Close Audit
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
