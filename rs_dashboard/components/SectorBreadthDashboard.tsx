'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart2,
  Calendar,
  Check,
  CheckCircle2,
  ChevronRight,
  Compass,
  ExternalLink,
  Eye,
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
import type { SectorBreadthResponse, SectorMetrics, SectorConstituent } from '@/lib/sectorBreadth';
import NavBar from './NavBar';

export default function SectorBreadthDashboard() {
  const [data, setData] = useState<SectorBreadthResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSector, setSelectedSector] = useState<SectorMetrics | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');

  const fetchData = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/sector-breadth${force ? '?refresh=true' : ''}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as SectorBreadthResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch sector breadth data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filteredSectors = useMemo(() => {
    if (!data) return [];
    if (!searchQuery.trim()) return data.sectors;
    const q = searchQuery.toLowerCase().trim();
    return data.sectors.filter((s) => s.sector.toLowerCase().includes(q));
  }, [data, searchQuery]);

  const thrustCount = useMemo(() => {
    return data?.sectors.filter((s) => s.hasInternalThrust).length ?? 0;
  }, [data]);

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
                TOP-DOWN PARTICIPATION · SECTOR DEPTH
              </span>
              {data?.dataDate && (
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
                  DATA: {data.dataDate}
                </span>
              )}
            </div>
            <h1 className="text-sm font-bold text-white tracking-tight flex items-center gap-2">
              Sector Depth &amp; Participation Heatmap
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-400 font-medium">
                Moving Average Breadth &amp; Accumulation
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
        <section className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
          <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/60 flex flex-col justify-between font-mono">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              NSE SECTORS TRACKED
            </span>
            <div className="text-2xl font-black text-white mt-1 tabular-nums">
              {data?.totalSectors ?? '—'}
            </div>
            <span className="text-[10px] text-zinc-400 mt-1">Across {data?.totalStocks ?? 0} Stocks</span>
          </div>

          <div className="p-4 rounded-xl border border-emerald-500/30 bg-emerald-950/15 flex flex-col justify-between font-mono">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                INTERNAL THRUST ACTIVE
              </span>
              <Sparkles className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="text-2xl font-black text-emerald-400 mt-1 tabular-nums">
              {thrustCount}
            </div>
            <span className="text-[10px] text-emerald-500/80 mt-1">&gt;70% Above 20 DMA</span>
          </div>

          <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/60 flex flex-col justify-between font-mono">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
              TOP RS LEADING SECTOR
            </span>
            <div className="text-lg font-black text-white mt-1 truncate">
              {data?.sectors[0]?.sector ?? '—'}
            </div>
            <span className="text-[10px] text-emerald-400 mt-1 font-bold">
              RS Score: {data?.sectors[0]?.sectorRS !== undefined ? `${data.sectors[0].sectorRS > 0 ? '+' : ''}${data.sectors[0].sectorRS.toFixed(1)}%` : '—'}
            </span>
          </div>

          <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/60 flex flex-col justify-between font-mono">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
              ACCUMULATION DEPTH
            </span>
            <div className="text-2xl font-black text-white mt-1 tabular-nums">
              {data?.sectors.filter((s) => s.accDistScore >= 55).length ?? '—'} Sectors
            </div>
            <span className="text-[10px] text-zinc-500 mt-1">Net Inflow (&gt;55% Up-Volume)</span>
          </div>
        </section>

        {/* ─── Search Toolbar ──────────────────────────────────────────────── */}
        <section className="flex items-center justify-between gap-3 bg-zinc-900/70 border border-zinc-800 rounded-xl p-3">
          <span className="text-xs font-bold text-zinc-300 font-mono">
            SECTOR RANKINGS ({filteredSectors.length} Sectors)
          </span>

          <div className="relative w-64">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search sector name…"
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
        </section>

        {/* ─── Sector Depth Table ──────────────────────────────────────────── */}
        <section className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden flex flex-col">
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead className="bg-zinc-800 text-xs font-bold text-white">
                <tr>
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Sector</th>
                  <th className="px-4 py-3">Constituents</th>
                  <th className="px-4 py-3">% &gt; 20 DMA</th>
                  <th className="px-4 py-3">% &gt; 50 DMA</th>
                  <th className="px-4 py-3">% &gt; 200 DMA</th>
                  <th className="px-4 py-3">Acc/Dist Volume</th>
                  <th className="px-4 py-3">Sector RS</th>
                  <th className="px-4 py-3">1W Ret.</th>
                  <th className="px-4 py-3">1M Ret.</th>
                  <th className="px-4 py-3">Participation Signal</th>
                  <th className="px-4 py-3 text-right">Drill-down</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80 bg-zinc-950/60">
                {loading ? (
                  <tr>
                    <td colSpan={12} className="px-4 py-12 text-center text-zinc-500">
                      <div className="flex items-center justify-center gap-2">
                        <Activity className="w-4 h-4 animate-spin text-emerald-400" />
                        <span>Aggregating sector depth &amp; participation across Nifty 500…</span>
                      </div>
                    </td>
                  </tr>
                ) : filteredSectors.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-4 py-12 text-center text-zinc-500">
                      No sectors matched search.
                    </td>
                  </tr>
                ) : (
                  filteredSectors.map((sec, idx) => {
                    const isThrust = sec.hasInternalThrust;
                    return (
                      <tr
                        key={sec.sector}
                        className="hover:bg-zinc-900/70 transition-colors cursor-pointer"
                        onClick={() => setSelectedSector(sec)}
                      >
                        <td className="px-4 py-2.5 text-zinc-500 text-[11px]">{idx + 1}</td>
                        <td className="px-4 py-2.5 font-bold text-white flex items-center gap-2">
                          <span>{sec.sector}</span>
                          {isThrust && (
                            <span className="px-1.5 py-0.2 rounded text-[9px] font-black bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                              THRUST
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-zinc-400 tabular-nums">
                          {sec.stockCount} stocks
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <span
                              className={`tabular-nums font-bold ${
                                sec.pctAbove20 >= 60
                                  ? 'text-emerald-400'
                                  : sec.pctAbove20 <= 30
                                    ? 'text-red-400'
                                    : 'text-zinc-300'
                              }`}
                            >
                              {sec.pctAbove20.toFixed(0)}%
                            </span>
                            <div className="w-14 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                              <div
                                className={`h-full ${
                                  sec.pctAbove20 >= 60 ? 'bg-emerald-400' : 'bg-amber-400'
                                }`}
                                style={{ width: `${sec.pctAbove20}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <span
                              className={`tabular-nums font-bold ${
                                sec.pctAbove50 >= 55
                                  ? 'text-emerald-400'
                                  : sec.pctAbove50 <= 35
                                    ? 'text-red-400'
                                    : 'text-zinc-300'
                              }`}
                            >
                              {sec.pctAbove50.toFixed(0)}%
                            </span>
                            <div className="w-14 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                              <div
                                className={`h-full ${
                                  sec.pctAbove50 >= 55 ? 'bg-emerald-400' : 'bg-amber-400'
                                }`}
                                style={{ width: `${sec.pctAbove50}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <span
                              className={`tabular-nums font-bold ${
                                sec.pctAbove200 >= 60
                                  ? 'text-emerald-400'
                                  : sec.pctAbove200 <= 40
                                    ? 'text-red-400'
                                    : 'text-zinc-300'
                              }`}
                            >
                              {sec.pctAbove200.toFixed(0)}%
                            </span>
                            <div className="w-14 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                              <div
                                className={`h-full ${
                                  sec.pctAbove200 >= 60 ? 'bg-emerald-400' : 'bg-amber-400'
                                }`}
                                style={{ width: `${sec.pctAbove200}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">
                          <span
                            className={
                              sec.accDistScore >= 55
                                ? 'text-emerald-400 font-bold'
                                : sec.accDistScore <= 45
                                  ? 'text-red-400'
                                  : 'text-zinc-400'
                            }
                          >
                            {sec.accDistScore.toFixed(0)}% Up
                          </span>
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">
                          <span
                            className={
                              sec.sectorRS > 0 ? 'text-emerald-400 font-bold' : 'text-zinc-500'
                            }
                          >
                            {sec.sectorRS > 0 ? '+' : ''}
                            {sec.sectorRS.toFixed(1)}%
                          </span>
                        </td>
                        <td
                          className={`px-4 py-2.5 tabular-nums ${
                            sec.median1W >= 0 ? 'text-emerald-400' : 'text-red-400'
                          }`}
                        >
                          {sec.median1W >= 0 ? '+' : ''}
                          {sec.median1W.toFixed(1)}%
                        </td>
                        <td
                          className={`px-4 py-2.5 tabular-nums ${
                            sec.median1M >= 0 ? 'text-emerald-400' : 'text-red-400'
                          }`}
                        >
                          {sec.median1M >= 0 ? '+' : ''}
                          {sec.median1M.toFixed(1)}%
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                              isThrust
                                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                                : sec.pctAbove20 <= 25
                                  ? 'bg-red-500/20 text-red-300 border-red-500/30'
                                  : 'bg-zinc-800 text-zinc-300 border-zinc-700'
                            }`}
                          >
                            {sec.thrustLabel}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedSector(sec);
                            }}
                            className="p-1 rounded bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700 transition-colors"
                            title="Drill down constituents"
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

        {/* ─── Constituent Drilldown Modal / Drawer ─────────────────────────── */}
        {selectedSector && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/80 backdrop-blur-sm">
            <div className="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-4xl p-6 shadow-2xl flex flex-col gap-4 max-h-[90vh] overflow-y-auto font-mono text-xs">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xl font-black text-white">{selectedSector.sector}</span>
                    <span className="text-xs px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
                      {selectedSector.stockCount} Stocks
                    </span>
                    {selectedSector.hasInternalThrust && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                        INTERNAL THRUST
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 text-zinc-400 mt-1 text-[11px]">
                    <span>&gt;20 DMA: {selectedSector.pctAbove20}%</span>
                    <span>&gt;50 DMA: {selectedSector.pctAbove50}%</span>
                    <span>&gt;200 DMA: {selectedSector.pctAbove200}%</span>
                    <span>Acc/Dist: {selectedSector.accDistScore}% Up</span>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedSector(null)}
                  className="p-1 rounded-lg border border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-900 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Constituent Table */}
              <div className="overflow-x-auto border border-zinc-800 rounded-xl">
                <table className="w-full text-left">
                  <thead className="bg-zinc-800 text-xs font-bold text-white">
                    <tr>
                      <th className="px-3.5 py-2.5">Symbol</th>
                      <th className="px-3.5 py-2.5">LTP</th>
                      <th className="px-3.5 py-2.5">1D %</th>
                      <th className="px-3.5 py-2.5">1W %</th>
                      <th className="px-3.5 py-2.5">1M %</th>
                      <th className="px-3.5 py-2.5 text-center">&gt;20 DMA</th>
                      <th className="px-3.5 py-2.5 text-center">&gt;50 DMA</th>
                      <th className="px-3.5 py-2.5 text-center">&gt;200 DMA</th>
                      <th className="px-3.5 py-2.5">Mansfield RS</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/80 bg-zinc-950/60">
                    {selectedSector.constituents.map((c) => (
                      <tr key={c.symbol} className="hover:bg-zinc-900/60 transition-colors">
                        <td className="px-3.5 py-2 font-bold text-white">{c.symbol}</td>
                        <td className="px-3.5 py-2 text-zinc-200 tabular-nums">
                          ₹{c.price.toFixed(2)}
                        </td>
                        <td
                          className={`px-3.5 py-2 font-bold tabular-nums ${
                            c.change1D >= 0 ? 'text-emerald-400' : 'text-red-400'
                          }`}
                        >
                          {c.change1D >= 0 ? '+' : ''}
                          {c.change1D.toFixed(2)}%
                        </td>
                        <td
                          className={`px-3.5 py-2 tabular-nums ${
                            c.change1W >= 0 ? 'text-emerald-400' : 'text-red-400'
                          }`}
                        >
                          {c.change1W >= 0 ? '+' : ''}
                          {c.change1W.toFixed(1)}%
                        </td>
                        <td
                          className={`px-3.5 py-2 tabular-nums ${
                            c.change1M >= 0 ? 'text-emerald-400' : 'text-red-400'
                          }`}
                        >
                          {c.change1M >= 0 ? '+' : ''}
                          {c.change1M.toFixed(1)}%
                        </td>
                        <td className="px-3.5 py-2 text-center">
                          {c.above20 ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400 inline" />
                          ) : (
                            <X className="w-3.5 h-3.5 text-zinc-600 inline" />
                          )}
                        </td>
                        <td className="px-3.5 py-2 text-center">
                          {c.above50 ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400 inline" />
                          ) : (
                            <X className="w-3.5 h-3.5 text-zinc-600 inline" />
                          )}
                        </td>
                        <td className="px-3.5 py-2 text-center">
                          {c.above200 ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400 inline" />
                          ) : (
                            <X className="w-3.5 h-3.5 text-zinc-600 inline" />
                          )}
                        </td>
                        <td className="px-3.5 py-2 tabular-nums">
                          <span
                            className={
                              c.mansfieldRS > 0 ? 'text-emerald-400 font-bold' : 'text-zinc-500'
                            }
                          >
                            {c.mansfieldRS > 0 ? '+' : ''}
                            {c.mansfieldRS.toFixed(1)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-end pt-2">
                <button
                  onClick={() => setSelectedSector(null)}
                  className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold transition-colors"
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
