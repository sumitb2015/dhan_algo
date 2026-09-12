'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart2,
  Calendar,
  CheckCircle2,
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
  TrendingDown,
  TrendingUp,
  X,
  Zap,
} from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import type { HighsLowsResponse, HighLowStockItem, ProximityTier } from '@/lib/highsLows';
import NavBar from './NavBar';

export default function HighsLowsDashboard() {
  const [data, setData] = useState<HighsLowsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [selectedTier, setSelectedTier] = useState<ProximityTier | 'all'>('AT_HIGH');
  const [selectedSector, setSelectedSector] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortAsc, setSortAsc] = useState<boolean>(false);

  const fetchData = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/highs-lows${force ? '?refresh=true' : ''}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as HighsLowsResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch highs/lows data');
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

    if (selectedTier !== 'all') {
      list = list.filter((s) => s.tier === selectedTier);
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
  }, [data, selectedTier, selectedSector, searchQuery]);

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
                PRICE EXPLORATION · MILESTONE TRACKER
              </span>
              {data?.dataDate && (
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
                  DATA: {data.dataDate}
                </span>
              )}
            </div>
            <h1 className="text-sm font-bold text-white tracking-tight flex items-center gap-2">
              52-Week High/Low &amp; Base Proximity
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-400 font-medium">
                Nifty 500 Peak Milestone Matrix
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
            <span>Refresh</span>
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
        <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
          <div className="p-4 rounded-xl border border-emerald-500/30 bg-emerald-950/15 flex flex-col justify-between font-mono">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                AT 52W HIGH / ATH (0–2%)
              </span>
              <Flame className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="text-2xl font-black text-emerald-400 mt-1 tabular-nums">
              {data?.tierCounts.atHigh ?? '—'}
            </div>
            <span className="text-[10px] text-emerald-500/80 mt-1">Leading Active Breakouts</span>
          </div>

          <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/60 flex flex-col justify-between font-mono">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
              IN BASE / HANDLE (2–8%)
            </span>
            <div className="text-2xl font-black text-white mt-1 tabular-nums">
              {data?.tierCounts.inBase ?? '—'}
            </div>
            <span className="text-[10px] text-zinc-500 mt-1">Coiling Breakout Watchlist</span>
          </div>

          <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/60 flex flex-col justify-between font-mono">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
              CONSOLIDATING (8–15%)
            </span>
            <div className="text-2xl font-black text-white mt-1 tabular-nums">
              {data?.tierCounts.consolidating ?? '—'}
            </div>
            <span className="text-[10px] text-zinc-500 mt-1">Pullbacks to 50 DMA</span>
          </div>

          <div className="p-4 rounded-xl border border-amber-500/30 bg-amber-950/15 flex flex-col justify-between font-mono">
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400">
              SECONDARY BASE (15–25%)
            </span>
            <div className="text-2xl font-black text-amber-400 mt-1 tabular-nums">
              {data?.tierCounts.correcting ?? '—'}
            </div>
            <span className="text-[10px] text-amber-500/80 mt-1">Deep Retracement Base</span>
          </div>

          <div className="p-4 rounded-xl border border-red-500/30 bg-red-950/15 flex flex-col justify-between font-mono">
            <span className="text-[10px] font-bold uppercase tracking-wider text-red-400">
              BROKEN STAGE 4 (&gt;25%)
            </span>
            <div className="text-2xl font-black text-red-400 mt-1 tabular-nums">
              {data?.tierCounts.broken ?? '—'}
            </div>
            <span className="text-[10px] text-red-500/80 mt-1">Markdown / Strict Avoid</span>
          </div>
        </section>

        {/* ─── Market-Level Net New Highs Chart ─────────────────────────────── */}
        <section className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <span>Market Net New Highs (60-Session Breadth Momentum)</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">
                  New Highs minus New Lows
                </span>
              </h3>
              <p className="text-[11px] text-zinc-500">
                Expansion in Net New Highs confirms broad bull market momentum before indices break out.
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs font-mono">
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />
                <span className="text-zinc-400">Net Positive (NH &gt; NL)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-red-500" />
                <span className="text-zinc-400">Net Negative (NL &gt; NH)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-indigo-400" />
                <span className="text-zinc-400">Cumulative Net Highs Line</span>
              </div>
            </div>
          </div>

          <div className="h-[260px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={data?.netNewHighsHistory || []}
                margin={{ top: 10, right: 10, left: 10, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 6" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  minTickGap={30}
                />
                <YAxis
                  yAxisId="bars"
                  orientation="left"
                  tickLine={false}
                />
                <YAxis
                  yAxisId="line"
                  orientation="right"
                  tickLine={false}
                />
                <ReferenceLine yAxisId="bars" y={0} />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload || !payload.length) return null;
                    const item = payload[0].payload;
                    return (
                      <div className="bg-zinc-950/98 border border-zinc-700 rounded-xl px-3.5 py-2.5 text-xs shadow-2xl backdrop-blur font-mono">
                        <div className="font-bold text-white mb-1">{item.date}</div>
                        <div className="flex justify-between gap-4 text-emerald-400">
                          <span>52W Highs:</span>
                          <span className="font-bold">+{item.newHighs}</span>
                        </div>
                        <div className="flex justify-between gap-4 text-red-400">
                          <span>52W Lows:</span>
                          <span className="font-bold">-{item.newLows}</span>
                        </div>
                        <div className="flex justify-between gap-4 text-zinc-300 font-bold border-t border-zinc-800 pt-1 mt-1">
                          <span>Net (NH - NL):</span>
                          <span className={item.netNewHighs >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                            {item.netNewHighs >= 0 ? '+' : ''}
                            {item.netNewHighs}
                          </span>
                        </div>
                        <div className="flex justify-between gap-4 text-indigo-400">
                          <span>Cumulative Net:</span>
                          <span className="font-bold">{item.cumulativeNet}</span>
                        </div>
                      </div>
                    );
                  }}
                />
                <Bar
                  yAxisId="bars"
                  dataKey="netNewHighs"
                  fill="#10b981"
                  radius={[2, 2, 0, 0]}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="line"
                  type="monotone"
                  dataKey="cumulativeNet"
                  stroke="#818cf8"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>

        {/* ─── Filter & Search Toolbar ──────────────────────────────────────── */}
        <section className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 bg-zinc-900/70 border border-zinc-800 rounded-xl p-3">
          <div className="flex items-center gap-1 overflow-x-auto pb-1 md:pb-0">
            <button
              onClick={() => setSelectedTier('AT_HIGH')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                selectedTier === 'AT_HIGH'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              At 52W High (0–2%) ({data?.tierCounts.atHigh ?? 0})
            </button>
            <button
              onClick={() => setSelectedTier('IN_BASE')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                selectedTier === 'IN_BASE'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              In Base (2–8%) ({data?.tierCounts.inBase ?? 0})
            </button>
            <button
              onClick={() => setSelectedTier('CONSOLIDATING')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                selectedTier === 'CONSOLIDATING'
                  ? 'bg-zinc-800 text-white border border-zinc-700 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              Consolidating (8–15%) ({data?.tierCounts.consolidating ?? 0})
            </button>
            <button
              onClick={() => setSelectedTier('CORRECTING')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                selectedTier === 'CORRECTING'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              Secondary Base (15–25%) ({data?.tierCounts.correcting ?? 0})
            </button>
            <button
              onClick={() => setSelectedTier('BROKEN_STAGE4')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                selectedTier === 'BROKEN_STAGE4'
                  ? 'bg-red-500/20 text-red-300 border border-red-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              Broken (&gt;25%) ({data?.tierCounts.broken ?? 0})
            </button>
            <button
              onClick={() => setSelectedTier('all')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                selectedTier === 'all'
                  ? 'bg-zinc-800 text-white border border-zinc-700 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              All ({data?.totalScanned ?? 0})
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

        {/* ─── Data Table ──────────────────────────────────────────────────── */}
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
                  <th className="px-4 py-3">52W High</th>
                  <th className="px-4 py-3">Proximity to Peak</th>
                  <th className="px-4 py-3">52W Low</th>
                  <th className="px-4 py-3">Above 52W Low</th>
                  <th className="px-4 py-3">SMA 50</th>
                  <th className="px-4 py-3">SMA 200</th>
                  <th className="px-4 py-3">Milestone Tier</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80 bg-zinc-950/60">
                {loading ? (
                  <tr>
                    <td colSpan={12} className="px-4 py-12 text-center text-zinc-500">
                      <div className="flex items-center justify-center gap-2">
                        <Activity className="w-4 h-4 animate-spin text-emerald-400" />
                        <span>Scanning Nifty 500 constituents for 52W highs and proximity…</span>
                      </div>
                    </td>
                  </tr>
                ) : filteredStocks.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-4 py-12 text-center text-zinc-500">
                      No stocks found for the selected filter.
                    </td>
                  </tr>
                ) : (
                  filteredStocks.map((s, idx) => {
                    const isAtHigh = s.tier === 'AT_HIGH';
                    const isInBase = s.tier === 'IN_BASE';
                    const isBroken = s.tier === 'BROKEN_STAGE4';

                    return (
                      <tr key={s.symbol} className="hover:bg-zinc-900/70 transition-colors">
                        <td className="px-4 py-2.5 text-zinc-500 text-[11px]">{idx + 1}</td>
                        <td className="px-4 py-2.5 font-bold text-white flex items-center gap-1.5">
                          <span>{s.symbol}</span>
                          {s.isNew52WHighToday && (
                            <span className="px-1.5 py-0.2 rounded text-[9px] font-black bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                              NEW HIGH
                            </span>
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
                        <td className="px-4 py-2.5 text-zinc-200 tabular-nums">
                          ₹{s.high52W.toFixed(2)}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <span
                              className={`font-bold tabular-nums ${
                                isAtHigh
                                  ? 'text-emerald-400'
                                  : isInBase
                                    ? 'text-emerald-300'
                                    : isBroken
                                      ? 'text-red-400'
                                      : 'text-zinc-300'
                              }`}
                            >
                              {s.pctFrom52WHigh.toFixed(1)}%
                            </span>
                            {/* Proximity visual meter */}
                            <div className="w-16 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                              <div
                                className={`h-full ${
                                  isAtHigh
                                    ? 'bg-emerald-400'
                                    : isInBase
                                      ? 'bg-emerald-500'
                                      : isBroken
                                        ? 'bg-red-500'
                                        : 'bg-amber-400'
                                }`}
                                style={{
                                  width: `${Math.max(5, 100 + s.pctFrom52WHigh * 2)}%`,
                                }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-zinc-400 tabular-nums">
                          ₹{s.low52W.toFixed(2)}
                        </td>
                        <td className="px-4 py-2.5 text-zinc-300 tabular-nums">
                          +{s.pctAbove52WLow.toFixed(0)}%
                        </td>
                        <td className="px-4 py-2.5 text-zinc-400 tabular-nums">
                          ₹{s.sma50.toFixed(1)}
                        </td>
                        <td className="px-4 py-2.5 text-zinc-400 tabular-nums">
                          ₹{s.sma200.toFixed(1)}
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                              isAtHigh
                                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                                : isInBase
                                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
                                  : isBroken
                                    ? 'bg-red-500/20 text-red-400 border-red-500/30'
                                    : 'bg-zinc-800 text-zinc-300 border-zinc-700'
                            }`}
                          >
                            {s.tierLabel.split(' ')[0]}
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
