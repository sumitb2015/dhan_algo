'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Compass,
  Download,
  ExternalLink,
  Eye,
  Filter,
  Flame,
  HelpCircle,
  Info,
  Layers,
  Percent,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  TrendingDown,
  TrendingUp,
  X,
  Zap,
} from 'lucide-react';
import type {
  StageScreenerResponse,
  StageStockResult,
  MinerviniChecklist,
} from '@/lib/stageScreener';
import NavBar from './NavBar';

type FilterTab = 'stage2' | 'strict8' | 'vcp' | 'stage1' | 'all';
type SortField = 'score' | 'mansfieldRS' | 'pctFrom52WHigh' | 'change1D' | 'change1M' | 'price';

export default function StageScreenerPage() {
  const [data, setData] = useState<StageScreenerResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filters & State
  const [activeTab, setActiveTab] = useState<FilterTab>('stage2');
  const [selectedSector, setSelectedSector] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortField, setSortField] = useState<SortField>('score');
  const [sortAsc, setSortAsc] = useState<boolean>(false);
  const [selectedStock, setSelectedStock] = useState<StageStockResult | null>(null);

  const fetchData = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/stage-screener${force ? '?refresh=true' : ''}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as StageScreenerResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch screener data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Unique sectors
  const sectorsList = useMemo(() => {
    if (!data) return [];
    const set = new Set<string>();
    data.stocks.forEach((s) => {
      if (s.sector) set.add(s.sector);
    });
    return Array.from(set).sort();
  }, [data]);

  // Filtered & Sorted stocks
  const filteredStocks = useMemo(() => {
    if (!data) return [];
    let list = [...data.stocks];

    // Tab filter
    if (activeTab === 'stage2') {
      list = list.filter((s) => s.stage === 'Stage 2 (Markup)');
    } else if (activeTab === 'strict8') {
      list = list.filter((s) => s.score === 8);
    } else if (activeTab === 'vcp') {
      list = list.filter((s) => s.vcp.isVCP);
    } else if (activeTab === 'stage1') {
      list = list.filter((s) => s.stage === 'Stage 1 (Basing)');
    }

    // Sector filter
    if (selectedSector !== 'all') {
      list = list.filter((s) => s.sector === selectedSector);
    }

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (s) => s.symbol.toLowerCase().includes(q) || s.sector.toLowerCase().includes(q)
      );
    }

    // Sort
    list.sort((a, b) => {
      let vA = a[sortField];
      let vB = b[sortField];
      if (typeof vA === 'number' && typeof vB === 'number') {
        return sortAsc ? vA - vB : vB - vA;
      }
      return 0;
    });

    return list;
  }, [data, activeTab, selectedSector, searchQuery, sortField, sortAsc]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

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
                MARK MINERVINI · STAN WEINSTEIN
              </span>
              {data?.dataDate && (
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
                  DATA: {data.dataDate}
                </span>
              )}
            </div>
            <h1 className="text-sm font-bold text-white tracking-tight flex items-center gap-2">
              Minervini Stage 2 &amp; VCP Screener
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-400 font-medium">
                8-Point Trend Template
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

      {/* Main Container */}
      <main className="flex-1 px-6 py-5 flex flex-col gap-5 max-w-[1700px] mx-auto w-full">
        {error && (
          <div className="p-3.5 rounded-xl border border-red-800/60 bg-red-950/40 text-red-300 text-xs flex items-center gap-2">
            <span>Failed to run stage screener: {error}</span>
          </div>
        )}

        {/* ─── KPI Top Metric Cards ─────────────────────────────────────────── */}
        <section className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
          <div className="flex flex-col justify-between p-4 rounded-xl border border-zinc-800 bg-zinc-900/60 font-mono">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              UNIVERSE SCANNED
            </span>
            <div className="text-2xl font-black text-white mt-1 tabular-nums">
              {data?.totalScanned ?? '—'}
            </div>
            <span className="text-[10px] text-zinc-400 mt-1">Nifty 500 Constituents</span>
          </div>

          <div className="flex flex-col justify-between p-4 rounded-xl border border-emerald-500/30 bg-emerald-950/10 font-mono">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                STAGE 2 LEADERS (7-8/8)
              </span>
              <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
            </div>
            <div className="text-2xl font-black text-emerald-400 mt-1 tabular-nums">
              {data?.stage2Count ?? '—'}
            </div>
            <span className="text-[10px] text-emerald-500/80 mt-1">
              {data && data.totalScanned > 0
                ? `${((data.stage2Count / data.totalScanned) * 100).toFixed(1)}% of Universe`
                : '—'}
            </span>
          </div>

          <div className="flex flex-col justify-between p-4 rounded-xl border border-zinc-800 bg-zinc-900/60 font-mono">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                STRICT 8/8 QUALIFIERS
              </span>
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            </div>
            <div className="text-2xl font-black text-white mt-1 tabular-nums">
              {data?.strict8Count ?? '—'}
            </div>
            <span className="text-[10px] text-zinc-500 mt-1">All 8 Criteria Satisfied</span>
          </div>

          <div className="flex flex-col justify-between p-4 rounded-xl border border-amber-500/30 bg-amber-950/10 font-mono">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400">
                VCP COILING SETUPS
              </span>
              <Flame className="w-3.5 h-3.5 text-amber-400" />
            </div>
            <div className="text-2xl font-black text-amber-400 mt-1 tabular-nums">
              {data?.vcpCount ?? '—'}
            </div>
            <span className="text-[10px] text-amber-500/80 mt-1">Drying Volume &amp; Tight Range</span>
          </div>

          <div className="flex flex-col justify-between p-4 rounded-xl border border-zinc-800 bg-zinc-900/60 font-mono">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              STAGE 4 MARKDOWN
            </span>
            <div className="text-2xl font-black text-red-400 mt-1 tabular-nums">
              {data?.stageCounts.stage4 ?? '—'}
            </div>
            <span className="text-[10px] text-red-500/80 mt-1">Strict Avoid / Downtrend</span>
          </div>
        </section>

        {/* ─── Filters & Search Toolbar ─────────────────────────────────────── */}
        <section className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 bg-zinc-900/70 border border-zinc-800 rounded-xl p-3">
          {/* Tab buttons */}
          <div className="flex items-center gap-1 overflow-x-auto pb-1 md:pb-0">
            <button
              onClick={() => setActiveTab('stage2')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                activeTab === 'stage2'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              Stage 2 Leaders ({data?.stage2Count ?? 0})
            </button>
            <button
              onClick={() => setActiveTab('strict8')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                activeTab === 'strict8'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              Strict 8/8 Trend ({data?.strict8Count ?? 0})
            </button>
            <button
              onClick={() => setActiveTab('vcp')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                activeTab === 'vcp'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              VCP &amp; Drying Volume ({data?.vcpCount ?? 0})
            </button>
            <button
              onClick={() => setActiveTab('stage1')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                activeTab === 'stage1'
                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              Stage 1 Basing ({data?.stageCounts.stage1 ?? 0})
            </button>
            <button
              onClick={() => setActiveTab('all')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                activeTab === 'all'
                  ? 'bg-zinc-800 text-white border border-zinc-700 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              All Stocks ({data?.totalScanned ?? 0})
            </button>
          </div>

          {/* Right: Sector & Search Input */}
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

        {/* ─── Screener Data Table ─────────────────────────────────────────── */}
        <section className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden flex flex-col">
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead className="bg-zinc-800 text-xs font-bold text-white">
                <tr>
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Symbol</th>
                  <th className="px-4 py-3">Sector</th>
                  <th
                    className="px-4 py-3 cursor-pointer hover:text-emerald-300"
                    onClick={() => handleSort('price')}
                  >
                    Price {sortField === 'price' && (sortAsc ? '↑' : '↓')}
                  </th>
                  <th
                    className="px-4 py-3 cursor-pointer hover:text-emerald-300"
                    onClick={() => handleSort('change1D')}
                  >
                    1D % {sortField === 'change1D' && (sortAsc ? '↑' : '↓')}
                  </th>
                  <th
                    className="px-4 py-3 cursor-pointer hover:text-emerald-300"
                    onClick={() => handleSort('score')}
                  >
                    Template Score {sortField === 'score' && (sortAsc ? '↑' : '↓')}
                  </th>
                  <th className="px-4 py-3 text-center">8 Criteria Breakdown</th>
                  <th
                    className="px-4 py-3 cursor-pointer hover:text-emerald-300"
                    onClick={() => handleSort('pctFrom52WHigh')}
                  >
                    vs 52W High {sortField === 'pctFrom52WHigh' && (sortAsc ? '↑' : '↓')}
                  </th>
                  <th className="px-4 py-3">vs 52W Low</th>
                  <th
                    className="px-4 py-3 cursor-pointer hover:text-emerald-300"
                    onClick={() => handleSort('mansfieldRS')}
                  >
                    Mansfield RS {sortField === 'mansfieldRS' && (sortAsc ? '↑' : '↓')}
                  </th>
                  <th className="px-4 py-3">VCP Setup</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80 bg-zinc-950/60">
                {loading ? (
                  <tr>
                    <td colSpan={12} className="px-4 py-12 text-center text-zinc-500">
                      <div className="flex items-center justify-center gap-2">
                        <Activity className="w-4 h-4 animate-spin text-emerald-400" />
                        <span>Scanning Nifty 500 historical data &amp; calculating moving averages…</span>
                      </div>
                    </td>
                  </tr>
                ) : filteredStocks.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-4 py-12 text-center text-zinc-500">
                      No stocks matched the selected filter criteria.
                    </td>
                  </tr>
                ) : (
                  filteredStocks.map((stock, idx) => {
                    const isStrict8 = stock.score === 8;
                    const isStage2 = stock.stage === 'Stage 2 (Markup)';
                    const isVcp = stock.vcp.isVCP;

                    return (
                      <tr
                        key={stock.symbol}
                        className="hover:bg-zinc-900/70 transition-colors cursor-pointer"
                        onClick={() => setSelectedStock(stock)}
                      >
                        <td className="px-4 py-2.5 text-zinc-500 text-[11px]">{idx + 1}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-white hover:text-emerald-400 transition-colors">
                              {stock.symbol}
                            </span>
                            {isStrict8 && (
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" title="Strict 8/8 Leader" />
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-zinc-400 text-[11px] truncate max-w-[120px]">
                          {stock.sector}
                        </td>
                        <td className="px-4 py-2.5 text-white font-bold tabular-nums">
                          ₹{stock.price.toFixed(2)}
                        </td>
                        <td
                          className={`px-4 py-2.5 font-bold tabular-nums ${
                            stock.change1D >= 0 ? 'text-emerald-400' : 'text-red-400'
                          }`}
                        >
                          {stock.change1D >= 0 ? '+' : ''}
                          {stock.change1D.toFixed(2)}%
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-black border ${
                                isStrict8
                                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                                  : stock.score === 7
                                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                    : stock.score >= 5
                                      ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                                      : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                              }`}
                            >
                              {stock.score} / 8
                            </span>
                          </div>
                        </td>
                        {/* 8 Criteria Mini Checklist Bullets */}
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-center gap-1">
                            {Object.values(stock.checklist).map((passed, i) => (
                              <span
                                key={i}
                                className={`w-1.5 h-3 rounded-sm ${
                                  passed ? 'bg-emerald-500' : 'bg-zinc-800'
                                }`}
                                title={`Criterion #${i + 1}: ${passed ? 'Passed' : 'Failed'}`}
                              />
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-zinc-300 tabular-nums">
                          <span
                            className={
                              stock.pctFrom52WHigh >= -10
                                ? 'text-emerald-400 font-bold'
                                : stock.pctFrom52WHigh >= -20
                                  ? 'text-zinc-200'
                                  : 'text-zinc-500'
                            }
                          >
                            {stock.pctFrom52WHigh.toFixed(1)}%
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-zinc-400 tabular-nums">
                          +{stock.pctAbove52WLow.toFixed(0)}%
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">
                          <div className="flex items-center gap-1">
                            <span
                              className={
                                stock.mansfieldRS > 0 ? 'text-emerald-400 font-bold' : 'text-zinc-500'
                              }
                            >
                              {stock.mansfieldRS > 0 ? '+' : ''}
                              {stock.mansfieldRS.toFixed(1)}%
                            </span>
                            {stock.rsTrendingUp && (
                              <ArrowUpRight className="w-3 h-3 text-emerald-400" />
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          {isVcp ? (
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                                stock.vcp.vcpType === 'Classic VCP'
                                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                                  : stock.vcp.vcpType === 'Volume Dry-Up'
                                    ? 'bg-sky-500/20 text-sky-300 border-sky-500/40'
                                    : 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40'
                              }`}
                            >
                              {stock.vcp.vcpType}
                            </span>
                          ) : (
                            <span className="text-[10px] text-zinc-600">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedStock(stock);
                            }}
                            className="p-1 rounded bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700 transition-colors"
                            title="Inspect 8-Point Checklist"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* ─── Detail Modal / Drawer ────────────────────────────────────────── */}
        {selectedStock && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/80 backdrop-blur-sm">
            <div className="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-2xl p-6 shadow-2xl flex flex-col gap-5 max-h-[90vh] overflow-y-auto">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xl font-black text-white">{selectedStock.symbol}</span>
                    <span className="text-xs px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400 font-mono">
                      {selectedStock.sector}
                    </span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full font-bold border ${
                        selectedStock.stage === 'Stage 2 (Markup)'
                          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                          : selectedStock.stage === 'Stage 4 (Markdown)'
                            ? 'bg-red-500/20 text-red-400 border-red-500/40'
                            : 'bg-zinc-800 text-zinc-300 border-zinc-700'
                      }`}
                    >
                      {selectedStock.stage}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-3 mt-1 font-mono">
                    <span className="text-2xl font-bold text-white">
                      ₹{selectedStock.price.toFixed(2)}
                    </span>
                    <span
                      className={`text-sm font-bold ${
                        selectedStock.change1D >= 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {selectedStock.change1D >= 0 ? '+' : ''}
                      {selectedStock.change1D.toFixed(2)}% (1D)
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedStock(null)}
                  className="p-1 rounded-lg border border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-900 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* 8 Criteria Checklist Breakdown */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">
                    Minervini 8-Point Trend Template Audit
                  </span>
                  <span className="text-xs font-bold font-mono text-emerald-400">
                    {selectedStock.score} / 8 Criteria Satisfied
                  </span>
                </div>

                <div className="divide-y divide-zinc-800/80 border border-zinc-800 rounded-xl bg-zinc-900/40 text-xs font-mono">
                  <div className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {selectedStock.checklist.c1_priceAbove150and200 ? (
                        <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <X className="w-4 h-4 text-red-400 shrink-0" />
                      )}
                      <span>1. Price &gt; 150-day &amp; 200-day SMA</span>
                    </div>
                    <span className="text-zinc-400">
                      SMA150: ₹{selectedStock.sma150} | SMA200: ₹{selectedStock.sma200}
                    </span>
                  </div>

                  <div className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {selectedStock.checklist.c2_sma150Above200 ? (
                        <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <X className="w-4 h-4 text-red-400 shrink-0" />
                      )}
                      <span>2. 150-day SMA &gt; 200-day SMA</span>
                    </div>
                    <span className="text-zinc-400">
                      Diff: {(selectedStock.pctVsSma200 - selectedStock.pctVsSma150).toFixed(1)}%
                    </span>
                  </div>

                  <div className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {selectedStock.checklist.c3_sma200TrendingUp ? (
                        <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <X className="w-4 h-4 text-red-400 shrink-0" />
                      )}
                      <span>3. 200-day SMA trending up (≥22 sessions)</span>
                    </div>
                    <span className="text-zinc-400">
                      Slope: {selectedStock.sma200Slope22 >= 0 ? '+' : ''}
                      {selectedStock.sma200Slope22.toFixed(2)}%
                    </span>
                  </div>

                  <div className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {selectedStock.checklist.c4_sma50Above150and200 ? (
                        <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <X className="w-4 h-4 text-red-400 shrink-0" />
                      )}
                      <span>4. 50-day SMA &gt; 150-day &amp; 200-day SMA</span>
                    </div>
                    <span className="text-zinc-400">SMA50: ₹{selectedStock.sma50}</span>
                  </div>

                  <div className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {selectedStock.checklist.c5_priceAbove50 ? (
                        <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <X className="w-4 h-4 text-red-400 shrink-0" />
                      )}
                      <span>5. Current Price &gt; 50-day SMA</span>
                    </div>
                    <span className="text-zinc-400">
                      {selectedStock.pctVsSma50 >= 0 ? '+' : ''}
                      {selectedStock.pctVsSma50.toFixed(1)}% vs 50 SMA
                    </span>
                  </div>

                  <div className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {selectedStock.checklist.c6_price30PctAbove52WLow ? (
                        <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <X className="w-4 h-4 text-red-400 shrink-0" />
                      )}
                      <span>6. Price ≥ 30% above 52-Week Low</span>
                    </div>
                    <span className="text-zinc-400">
                      +{selectedStock.pctAbove52WLow.toFixed(1)}% above 52W Low (₹
                      {selectedStock.low52W})
                    </span>
                  </div>

                  <div className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {selectedStock.checklist.c7_priceWithin25PctOf52WHigh ? (
                        <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <X className="w-4 h-4 text-red-400 shrink-0" />
                      )}
                      <span>7. Price within 25% of 52-Week High</span>
                    </div>
                    <span className="text-zinc-400">
                      {selectedStock.pctFrom52WHigh.toFixed(1)}% from 52W High (₹
                      {selectedStock.high52W})
                    </span>
                  </div>

                  <div className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {selectedStock.checklist.c8_mansfieldRSPositiveAndTrending ? (
                        <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <X className="w-4 h-4 text-red-400 shrink-0" />
                      )}
                      <span>8. Mansfield RS ≥ 0 and trending upward</span>
                    </div>
                    <span className="text-zinc-400">
                      RS: {selectedStock.mansfieldRS.toFixed(1)}% ({selectedStock.rsTrendingUp ? 'Rising' : 'Falling'})
                    </span>
                  </div>
                </div>
              </div>

              {/* VCP Details */}
              {selectedStock.vcp.isVCP && (
                <div className="p-3.5 rounded-xl border border-amber-500/30 bg-amber-950/20 text-xs">
                  <div className="flex items-center gap-2 text-amber-400 font-bold mb-1">
                    <Flame className="w-4 h-4" />
                    <span>VOLATILITY CONTRACTION PATTERN (VCP) DETECTED</span>
                  </div>
                  <p className="text-zinc-300 font-mono text-[11px]">
                    {selectedStock.vcp.description}
                  </p>
                  <div className="flex items-center gap-4 text-zinc-400 font-mono text-[10px] mt-2 pt-2 border-t border-amber-500/20">
                    <span>ATR Ratio (10/50): {selectedStock.vcp.atrRatio}</span>
                    <span>Volume Ratio: {(selectedStock.vcp.volRatio20D * 100).toFixed(0)}%</span>
                    <span>7D Band: {selectedStock.vcp.consolidationBandPct}%</span>
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
                <Link
                  href={`/scanner?symbol=${selectedStock.symbol}`}
                  className="px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white text-xs font-medium transition-colors"
                >
                  View RS Scanner →
                </Link>
                <button
                  onClick={() => setSelectedStock(null)}
                  className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
