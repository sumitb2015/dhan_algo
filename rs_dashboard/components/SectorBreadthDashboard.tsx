'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import {
  Activity,
  Check,
  Compass,
  Eye,
  Flame,
  Layers,
  RefreshCw,
  Search,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import type { SectorBreadthResponse, SectorMetrics } from '@/lib/sectorBreadth';
import NavBar from './NavBar';

type FilterType =
  | 'all'
  | 'thrust'
  | 'accumulation'
  | 'distribution'
  | 'oversold'
  | 'bullish50'
  | 'positive_rs';

type SortField =
  | 'rank'
  | 'sector'
  | 'stockCount'
  | 'pctAbove20'
  | 'pctAbove50'
  | 'pctAbove200'
  | 'accDistScore'
  | 'sectorRS'
  | 'median1W'
  | 'median1M'
  | 'thrustLabel';

type SortDir = 'asc' | 'desc';

type ConstituentFilter = 'all' | 'above20' | 'above50' | 'above200' | 'gainers' | 'positive_rs';
type ConstituentSortField = 'symbol' | 'price' | 'change1D' | 'change1W' | 'change1M' | 'mansfieldRS';

export default function SectorBreadthDashboard() {
  const [data, setData] = useState<SectorBreadthResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSector, setSelectedSector] = useState<SectorMetrics | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [activeFilter, setActiveFilter] = useState<FilterType>('all');
  const [sortField, setSortField] = useState<SortField>('rank');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // Modal drilldown filters and sorting
  const [constituentSearch, setConstituentSearch] = useState<string>('');
  const [constituentFilter, setConstituentFilter] = useState<ConstituentFilter>('all');
  const [constituentSortField, setConstituentSortField] = useState<ConstituentSortField>('mansfieldRS');
  const [constituentSortDir, setConstituentSortDir] = useState<SortDir>('desc');

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

  // Dynamic filter counts
  const filterCounts = useMemo(() => {
    if (!data) {
      return {
        all: 0,
        thrust: 0,
        accumulation: 0,
        distribution: 0,
        oversold: 0,
        bullish50: 0,
        positive_rs: 0,
      };
    }
    return {
      all: data.sectors.length,
      thrust: data.sectors.filter((s) => s.hasInternalThrust).length,
      accumulation: data.sectors.filter((s) => s.accDistScore >= 55).length,
      distribution: data.sectors.filter((s) => s.accDistScore <= 45).length,
      oversold: data.sectors.filter((s) => s.pctAbove20 <= 25).length,
      bullish50: data.sectors.filter((s) => s.pctAbove50 >= 50).length,
      positive_rs: data.sectors.filter((s) => s.sectorRS > 0).length,
    };
  }, [data]);

  const filteredSectors = useMemo(() => {
    if (!data) return [];
    let list = data.sectors;

    // Apply active filter pill
    if (activeFilter === 'thrust') {
      list = list.filter((s) => s.hasInternalThrust);
    } else if (activeFilter === 'accumulation') {
      list = list.filter((s) => s.accDistScore >= 55);
    } else if (activeFilter === 'distribution') {
      list = list.filter((s) => s.accDistScore <= 45);
    } else if (activeFilter === 'oversold') {
      list = list.filter((s) => s.pctAbove20 <= 25);
    } else if (activeFilter === 'bullish50') {
      list = list.filter((s) => s.pctAbove50 >= 50);
    } else if (activeFilter === 'positive_rs') {
      list = list.filter((s) => s.sectorRS > 0);
    }

    // Apply search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((s) => s.sector.toLowerCase().includes(q));
    }

    // Apply sorting
    return [...list].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'rank') {
        const idxA = data.sectors.indexOf(a);
        const idxB = data.sectors.indexOf(b);
        cmp = idxA - idxB;
      } else if (sortField === 'sector') {
        cmp = a.sector.localeCompare(b.sector);
      } else if (sortField === 'stockCount') {
        cmp = a.stockCount - b.stockCount;
      } else if (sortField === 'pctAbove20') {
        cmp = a.pctAbove20 - b.pctAbove20;
      } else if (sortField === 'pctAbove50') {
        cmp = a.pctAbove50 - b.pctAbove50;
      } else if (sortField === 'pctAbove200') {
        cmp = a.pctAbove200 - b.pctAbove200;
      } else if (sortField === 'accDistScore') {
        cmp = a.accDistScore - b.accDistScore;
      } else if (sortField === 'sectorRS') {
        cmp = a.sectorRS - b.sectorRS;
      } else if (sortField === 'median1W') {
        cmp = a.median1W - b.median1W;
      } else if (sortField === 'median1M') {
        cmp = a.median1M - b.median1M;
      } else if (sortField === 'thrustLabel') {
        cmp = a.thrustLabel.localeCompare(b.thrustLabel);
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [data, activeFilter, searchQuery, sortField, sortDir]);

  // Constituent modal filtering and sorting
  const filteredConstituents = useMemo(() => {
    if (!selectedSector) return [];
    let list = selectedSector.constituents;

    if (constituentSearch.trim()) {
      const q = constituentSearch.toUpperCase().trim();
      list = list.filter((c) => c.symbol.toUpperCase().includes(q));
    }

    if (constituentFilter === 'above20') {
      list = list.filter((c) => c.above20);
    } else if (constituentFilter === 'above50') {
      list = list.filter((c) => c.above50);
    } else if (constituentFilter === 'above200') {
      list = list.filter((c) => c.above200);
    } else if (constituentFilter === 'gainers') {
      list = list.filter((c) => c.change1D > 0);
    } else if (constituentFilter === 'positive_rs') {
      list = list.filter((c) => c.mansfieldRS > 0);
    }

    return [...list].sort((a, b) => {
      let cmp = 0;
      if (constituentSortField === 'symbol') {
        cmp = a.symbol.localeCompare(b.symbol);
      } else if (constituentSortField === 'price') {
        cmp = a.price - b.price;
      } else if (constituentSortField === 'change1D') {
        cmp = a.change1D - b.change1D;
      } else if (constituentSortField === 'change1W') {
        cmp = a.change1W - b.change1W;
      } else if (constituentSortField === 'change1M') {
        cmp = a.change1M - b.change1M;
      } else if (constituentSortField === 'mansfieldRS') {
        cmp = a.mansfieldRS - b.mansfieldRS;
      }
      return constituentSortDir === 'asc' ? cmp : -cmp;
    });
  }, [
    selectedSector,
    constituentSearch,
    constituentFilter,
    constituentSortField,
    constituentSortDir,
  ]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir(field === 'sector' || field === 'rank' ? 'asc' : 'desc');
    }
  };

  const handleConstituentSort = (field: ConstituentSortField) => {
    if (constituentSortField === field) {
      setConstituentSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setConstituentSortField(field);
      setConstituentSortDir(field === 'symbol' ? 'asc' : 'desc');
    }
  };

  const renderSortIndicator = (field: SortField) => {
    if (sortField !== field) return null;
    return (
      <span className="ml-1 text-[10px] text-emerald-400">
        {sortDir === 'asc' ? '▲' : '▼'}
      </span>
    );
  };

  const renderConstituentSortIndicator = (field: ConstituentSortField) => {
    if (constituentSortField !== field) return null;
    return (
      <span className="ml-1 text-[10px] text-emerald-400">
        {constituentSortDir === 'asc' ? '▲' : '▼'}
      </span>
    );
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
            className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white hover:border-zinc-700 disabled:opacity-50 transition-colors cursor-pointer"
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

        {/* ─── Top KPI Metric Cards (Interactive Filters) ────────────────────── */}
        <section className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
          {/* Card 1: All Sectors */}
          <button
            type="button"
            onClick={() => {
              setActiveFilter('all');
              setSearchQuery('');
            }}
            className={`p-4 rounded-xl border text-left flex flex-col justify-between font-mono transition-all cursor-pointer ${
              activeFilter === 'all' && !searchQuery
                ? 'border-zinc-500 bg-zinc-800/80 ring-1 ring-zinc-400 shadow-sm'
                : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700'
            }`}
          >
            <div className="flex items-center justify-between w-full">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                NSE SECTORS TRACKED
              </span>
              <Layers className="w-3.5 h-3.5 text-zinc-500" />
            </div>
            <div className="text-2xl font-black text-white mt-1 tabular-nums">
              {data?.totalSectors ?? '—'}
            </div>
            <span className="text-[10px] text-zinc-400 mt-1">Across {data?.totalStocks ?? 0} Stocks (Click to view all)</span>
          </button>

          {/* Card 2: Internal Thrust */}
          <button
            type="button"
            onClick={() => {
              setActiveFilter((prev) => (prev === 'thrust' ? 'all' : 'thrust'));
            }}
            className={`p-4 rounded-xl border text-left flex flex-col justify-between font-mono transition-all cursor-pointer ${
              activeFilter === 'thrust'
                ? 'border-emerald-400 bg-emerald-950/40 ring-1 ring-emerald-400 shadow-sm'
                : 'border-emerald-500/30 bg-emerald-950/15 hover:border-emerald-500/50'
            }`}
          >
            <div className="flex items-center justify-between w-full">
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                INTERNAL THRUST ACTIVE
              </span>
              <Sparkles className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="text-2xl font-black text-emerald-400 mt-1 tabular-nums">
              {filterCounts.thrust}
            </div>
            <span className="text-[10px] text-emerald-400 mt-1">&ge;70% Above 20 DMA (Click to filter)</span>
          </button>

          {/* Card 3: Top RS Leader */}
          <button
            type="button"
            onClick={() => {
              const topSec = data?.sectors[0]?.sector;
              if (topSec) {
                setSearchQuery((prev) => (prev === topSec ? '' : topSec));
                setActiveFilter('all');
              }
            }}
            className={`p-4 rounded-xl border text-left flex flex-col justify-between font-mono transition-all cursor-pointer ${
              searchQuery && data?.sectors[0]?.sector && searchQuery.toLowerCase() === data.sectors[0].sector.toLowerCase()
                ? 'border-amber-400 bg-amber-950/30 ring-1 ring-amber-400 shadow-sm'
                : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700'
            }`}
          >
            <div className="flex items-center justify-between w-full">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                TOP RS LEADING SECTOR
              </span>
              <Flame className="w-3.5 h-3.5 text-amber-400" />
            </div>
            <div className="text-lg font-black text-white mt-1 truncate">
              {data?.sectors[0]?.sector ?? '—'}
            </div>
            <span className="text-[10px] text-emerald-400 mt-1 font-bold">
              RS Score: {data?.sectors[0]?.sectorRS !== undefined ? `${data.sectors[0].sectorRS > 0 ? '+' : ''}${data.sectors[0].sectorRS.toFixed(1)}%` : '—'} (Click to isolate)
            </span>
          </button>

          {/* Card 4: Accumulation Depth */}
          <button
            type="button"
            onClick={() => {
              setActiveFilter((prev) => (prev === 'accumulation' ? 'all' : 'accumulation'));
            }}
            className={`p-4 rounded-xl border text-left flex flex-col justify-between font-mono transition-all cursor-pointer ${
              activeFilter === 'accumulation'
                ? 'border-emerald-400 bg-emerald-950/40 ring-1 ring-emerald-400 shadow-sm'
                : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700'
            }`}
          >
            <div className="flex items-center justify-between w-full">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                ACCUMULATION DEPTH
              </span>
              <Zap className="w-3.5 h-3.5 text-emerald-400" />
            </div>
            <div className="text-2xl font-black text-white mt-1 tabular-nums">
              {filterCounts.accumulation} Sectors
            </div>
            <span className="text-[10px] text-zinc-400 mt-1">Net Inflow (&ge;55% Up-Volume, click to filter)</span>
          </button>
        </section>

        {/* ─── Search & Quick Filter Toolbar ───────────────────────────────── */}
        <section className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 bg-zinc-900/70 border border-zinc-800 rounded-xl p-3">
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
            <button
              onClick={() => setActiveFilter('all')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors cursor-pointer ${
                activeFilter === 'all'
                  ? 'bg-zinc-100 text-zinc-950 font-black'
                  : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700'
              }`}
            >
              All ({filterCounts.all})
            </button>
            <button
              onClick={() => setActiveFilter('thrust')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors cursor-pointer ${
                activeFilter === 'thrust'
                  ? 'bg-emerald-500 text-zinc-950 font-black'
                  : 'bg-zinc-900 border border-zinc-800 text-emerald-400 hover:border-emerald-500/40'
              }`}
            >
              Thrust Active ({filterCounts.thrust})
            </button>
            <button
              onClick={() => setActiveFilter('accumulation')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors cursor-pointer ${
                activeFilter === 'accumulation'
                  ? 'bg-emerald-600 text-white font-black'
                  : 'bg-zinc-900 border border-zinc-800 text-zinc-300 hover:border-zinc-700'
              }`}
            >
              Accumulation ({filterCounts.accumulation})
            </button>
            <button
              onClick={() => setActiveFilter('distribution')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors cursor-pointer ${
                activeFilter === 'distribution'
                  ? 'bg-red-600 text-white font-black'
                  : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:border-zinc-700'
              }`}
            >
              Distribution ({filterCounts.distribution})
            </button>
            <button
              onClick={() => setActiveFilter('oversold')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors cursor-pointer ${
                activeFilter === 'oversold'
                  ? 'bg-red-500 text-white font-black'
                  : 'bg-zinc-900 border border-zinc-800 text-red-400 hover:border-red-500/40'
              }`}
            >
              Oversold &lt;25% ({filterCounts.oversold})
            </button>
            <button
              onClick={() => setActiveFilter('bullish50')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors cursor-pointer ${
                activeFilter === 'bullish50'
                  ? 'bg-emerald-600 text-white font-black'
                  : 'bg-zinc-900 border border-zinc-800 text-zinc-300 hover:border-zinc-700'
              }`}
            >
              &gt;50% &gt;50D ({filterCounts.bullish50})
            </button>
            <button
              onClick={() => setActiveFilter('positive_rs')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors cursor-pointer ${
                activeFilter === 'positive_rs'
                  ? 'bg-amber-500 text-zinc-950 font-black'
                  : 'bg-zinc-900 border border-zinc-800 text-amber-300 hover:border-amber-500/40'
              }`}
            >
              Positive RS ({filterCounts.positive_rs})
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] text-zinc-400 font-mono hidden sm:inline">
              Showing {filteredSectors.length} of {data?.totalSectors ?? 0}
            </span>
            <div className="relative w-full sm:w-64">
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
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </section>

        {/* ─── Sector Depth Table with Interactive Column Sorting ─────────── */}
        <section className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden flex flex-col">
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead className="bg-zinc-800 text-xs font-bold text-white select-none">
                <tr>
                  <th
                    onClick={() => handleSort('rank')}
                    className="px-4 py-3 cursor-pointer hover:bg-zinc-700 transition-colors"
                  >
                    # {renderSortIndicator('rank')}
                  </th>
                  <th
                    onClick={() => handleSort('sector')}
                    className="px-4 py-3 cursor-pointer hover:bg-zinc-700 transition-colors"
                  >
                    Sector {renderSortIndicator('sector')}
                  </th>
                  <th
                    onClick={() => handleSort('stockCount')}
                    className="px-4 py-3 cursor-pointer hover:bg-zinc-700 transition-colors"
                  >
                    Constituents {renderSortIndicator('stockCount')}
                  </th>
                  <th
                    onClick={() => handleSort('pctAbove20')}
                    className="px-4 py-3 cursor-pointer hover:bg-zinc-700 transition-colors"
                  >
                    % &gt; 20 DMA {renderSortIndicator('pctAbove20')}
                  </th>
                  <th
                    onClick={() => handleSort('pctAbove50')}
                    className="px-4 py-3 cursor-pointer hover:bg-zinc-700 transition-colors"
                  >
                    % &gt; 50 DMA {renderSortIndicator('pctAbove50')}
                  </th>
                  <th
                    onClick={() => handleSort('pctAbove200')}
                    className="px-4 py-3 cursor-pointer hover:bg-zinc-700 transition-colors"
                  >
                    % &gt; 200 DMA {renderSortIndicator('pctAbove200')}
                  </th>
                  <th
                    onClick={() => handleSort('accDistScore')}
                    className="px-4 py-3 cursor-pointer hover:bg-zinc-700 transition-colors"
                  >
                    Acc/Dist Volume {renderSortIndicator('accDistScore')}
                  </th>
                  <th
                    onClick={() => handleSort('sectorRS')}
                    className="px-4 py-3 cursor-pointer hover:bg-zinc-700 transition-colors"
                  >
                    Sector RS {renderSortIndicator('sectorRS')}
                  </th>
                  <th
                    onClick={() => handleSort('median1W')}
                    className="px-4 py-3 cursor-pointer hover:bg-zinc-700 transition-colors"
                  >
                    1W Ret. {renderSortIndicator('median1W')}
                  </th>
                  <th
                    onClick={() => handleSort('median1M')}
                    className="px-4 py-3 cursor-pointer hover:bg-zinc-700 transition-colors"
                  >
                    1M Ret. {renderSortIndicator('median1M')}
                  </th>
                  <th
                    onClick={() => handleSort('thrustLabel')}
                    className="px-4 py-3 cursor-pointer hover:bg-zinc-700 transition-colors"
                  >
                    Participation Signal {renderSortIndicator('thrustLabel')}
                  </th>
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
                      No sectors matched the current filter or search criteria.
                    </td>
                  </tr>
                ) : (
                  filteredSectors.map((sec, idx) => {
                    const isThrust = sec.hasInternalThrust;
                    return (
                      <tr
                        key={sec.sector}
                        className="hover:bg-zinc-900/70 transition-colors cursor-pointer"
                        onClick={() => {
                          setSelectedSector(sec);
                          setConstituentFilter('all');
                          setConstituentSearch('');
                          setConstituentSortField('mansfieldRS');
                          setConstituentSortDir('desc');
                        }}
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
                                  : sec.pctAbove20 <= 25
                                    ? 'text-red-400'
                                    : 'text-zinc-300'
                              }`}
                            >
                              {sec.pctAbove20.toFixed(0)}%
                            </span>
                            <div className="w-14 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                              <div
                                className={`h-full ${
                                  sec.pctAbove20 >= 60
                                    ? 'bg-emerald-400'
                                    : sec.pctAbove20 <= 25
                                      ? 'bg-red-400'
                                      : 'bg-amber-400'
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
                                  sec.pctAbove50 >= 55
                                    ? 'bg-emerald-400'
                                    : sec.pctAbove50 <= 35
                                      ? 'bg-red-400'
                                      : 'bg-amber-400'
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
                                  sec.pctAbove200 >= 60
                                    ? 'bg-emerald-400'
                                    : sec.pctAbove200 <= 40
                                      ? 'bg-red-400'
                                      : 'bg-amber-400'
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
                                  : sec.pctAbove50 >= 60
                                    ? 'bg-emerald-950/40 text-emerald-400 border-emerald-800'
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
                              setConstituentFilter('all');
                              setConstituentSearch('');
                              setConstituentSortField('mansfieldRS');
                              setConstituentSortDir('desc');
                            }}
                            className="p-1 rounded bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700 transition-colors cursor-pointer"
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

        {/* ─── Constituent Drilldown Modal with Advanced Filters ─────────────── */}
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
                    <span>&gt;20 DMA: <strong className="text-zinc-200">{selectedSector.pctAbove20}%</strong></span>
                    <span>&gt;50 DMA: <strong className="text-zinc-200">{selectedSector.pctAbove50}%</strong></span>
                    <span>&gt;200 DMA: <strong className="text-zinc-200">{selectedSector.pctAbove200}%</strong></span>
                    <span>Acc/Dist: <strong className="text-zinc-200">{selectedSector.accDistScore}% Up</strong></span>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedSector(null)}
                  className="p-1 rounded-lg border border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-900 transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Modal Filter Toolbar */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 bg-zinc-900/60 p-2.5 rounded-xl border border-zinc-800">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => setConstituentFilter('all')}
                    className={`px-2 py-1 rounded text-[10px] font-bold cursor-pointer transition-colors ${
                      constituentFilter === 'all'
                        ? 'bg-zinc-100 text-zinc-950 font-black'
                        : 'bg-zinc-950 border border-zinc-800 text-zinc-400 hover:text-white'
                    }`}
                  >
                    All ({selectedSector.constituents.length})
                  </button>
                  <button
                    onClick={() => setConstituentFilter('above20')}
                    className={`px-2 py-1 rounded text-[10px] font-bold cursor-pointer transition-colors ${
                      constituentFilter === 'above20'
                        ? 'bg-emerald-500 text-zinc-950 font-black'
                        : 'bg-zinc-950 border border-zinc-800 text-emerald-400 hover:border-emerald-500/40'
                    }`}
                  >
                    &gt;20 DMA ({selectedSector.constituents.filter((c) => c.above20).length})
                  </button>
                  <button
                    onClick={() => setConstituentFilter('above50')}
                    className={`px-2 py-1 rounded text-[10px] font-bold cursor-pointer transition-colors ${
                      constituentFilter === 'above50'
                        ? 'bg-emerald-500 text-zinc-950 font-black'
                        : 'bg-zinc-950 border border-zinc-800 text-emerald-400 hover:border-emerald-500/40'
                    }`}
                  >
                    &gt;50 DMA ({selectedSector.constituents.filter((c) => c.above50).length})
                  </button>
                  <button
                    onClick={() => setConstituentFilter('above200')}
                    className={`px-2 py-1 rounded text-[10px] font-bold cursor-pointer transition-colors ${
                      constituentFilter === 'above200'
                        ? 'bg-emerald-500 text-zinc-950 font-black'
                        : 'bg-zinc-950 border border-zinc-800 text-emerald-400 hover:border-emerald-500/40'
                    }`}
                  >
                    &gt;200 DMA ({selectedSector.constituents.filter((c) => c.above200).length})
                  </button>
                  <button
                    onClick={() => setConstituentFilter('gainers')}
                    className={`px-2 py-1 rounded text-[10px] font-bold cursor-pointer transition-colors ${
                      constituentFilter === 'gainers'
                        ? 'bg-emerald-600 text-white font-black'
                        : 'bg-zinc-950 border border-zinc-800 text-zinc-300 hover:border-zinc-700'
                    }`}
                  >
                    Gainers ({selectedSector.constituents.filter((c) => c.change1D > 0).length})
                  </button>
                  <button
                    onClick={() => setConstituentFilter('positive_rs')}
                    className={`px-2 py-1 rounded text-[10px] font-bold cursor-pointer transition-colors ${
                      constituentFilter === 'positive_rs'
                        ? 'bg-amber-500 text-zinc-950 font-black'
                        : 'bg-zinc-950 border border-zinc-800 text-amber-300 hover:border-amber-500/40'
                    }`}
                  >
                    RS &gt; 0 ({selectedSector.constituents.filter((c) => c.mansfieldRS > 0).length})
                  </button>
                </div>

                <div className="relative w-full sm:w-48">
                  <Search className="w-3 h-3 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={constituentSearch}
                    onChange={(e) => setConstituentSearch(e.target.value)}
                    placeholder="Filter symbol…"
                    className="w-full bg-zinc-950 border border-zinc-800 text-zinc-200 text-xs rounded-lg pl-7 pr-3 py-1 focus:outline-none focus:border-emerald-500/50"
                  />
                  {constituentSearch && (
                    <button
                      onClick={() => setConstituentSearch('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>

              {/* Constituent Table */}
              <div className="overflow-x-auto border border-zinc-800 rounded-xl">
                <table className="w-full text-left">
                  <thead className="bg-zinc-800 text-xs font-bold text-white select-none">
                    <tr>
                      <th
                        onClick={() => handleConstituentSort('symbol')}
                        className="px-3.5 py-2.5 cursor-pointer hover:bg-zinc-700 transition-colors"
                      >
                        Symbol {renderConstituentSortIndicator('symbol')}
                      </th>
                      <th
                        onClick={() => handleConstituentSort('price')}
                        className="px-3.5 py-2.5 cursor-pointer hover:bg-zinc-700 transition-colors"
                      >
                        LTP {renderConstituentSortIndicator('price')}
                      </th>
                      <th
                        onClick={() => handleConstituentSort('change1D')}
                        className="px-3.5 py-2.5 cursor-pointer hover:bg-zinc-700 transition-colors"
                      >
                        1D % {renderConstituentSortIndicator('change1D')}
                      </th>
                      <th
                        onClick={() => handleConstituentSort('change1W')}
                        className="px-3.5 py-2.5 cursor-pointer hover:bg-zinc-700 transition-colors"
                      >
                        1W % {renderConstituentSortIndicator('change1W')}
                      </th>
                      <th
                        onClick={() => handleConstituentSort('change1M')}
                        className="px-3.5 py-2.5 cursor-pointer hover:bg-zinc-700 transition-colors"
                      >
                        1M % {renderConstituentSortIndicator('change1M')}
                      </th>
                      <th className="px-3.5 py-2.5 text-center">&gt;20 DMA</th>
                      <th className="px-3.5 py-2.5 text-center">&gt;50 DMA</th>
                      <th className="px-3.5 py-2.5 text-center">&gt;200 DMA</th>
                      <th
                        onClick={() => handleConstituentSort('mansfieldRS')}
                        className="px-3.5 py-2.5 cursor-pointer hover:bg-zinc-700 transition-colors"
                      >
                        Mansfield RS {renderConstituentSortIndicator('mansfieldRS')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/80 bg-zinc-950/60">
                    {filteredConstituents.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-4 py-8 text-center text-zinc-500">
                          No constituents matched the filter.
                        </td>
                      </tr>
                    ) : (
                      filteredConstituents.map((c) => (
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
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-end pt-2">
                <button
                  onClick={() => setSelectedSector(null)}
                  className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold transition-colors cursor-pointer"
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

