'use client';

import React, { useState, useMemo } from 'react';
import { Search, ChevronDown, ChevronUp, Star, Filter } from 'lucide-react';
import { RSResult } from '@/lib/rs';

interface LeaderboardProps {
  data: RSResult[];
  selectedSymbol: string | null;
  onSelectSymbol: (symbol: string) => void;
  favorites: string[];
  onToggleFavorite: (symbol: string) => void;
}

type SortField = 'symbol' | 'rsScore' | 'rsRatio' | 'priceChange1D' | 'priceChange1W' | 'priceChange1M' | 'priceChange3M' | 'priceChange1Y' | 'latestClose';
type SortOrder = 'asc' | 'desc';

function Sparkline({ data }: { data: number[] }) {
  if (!data || data.length === 0) return <div className="text-zinc-600 text-xs">-</div>;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min === 0 ? 1 : max - min;
  const width = 80;
  const height = 24;
  const padding = 2;
  const points = data
    .map((val, idx) => {
      const x = padding + (idx / (data.length - 1)) * (width - padding * 2);
      const y = padding + (1 - (val - min) / range) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const isUp = data[data.length - 1] >= data[0];
  const strokeColor = isUp ? '#10b981' : '#ef4444'; // Emerald-500 / Red-500

  return (
    <div className="flex items-center justify-center">
      <svg width={width} height={height} className="overflow-visible">
        {/* Subtle gradient fill below the line */}
        <polyline
          fill="none"
          stroke={strokeColor}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={points}
        />
      </svg>
    </div>
  );
}

export default function Leaderboard({
  data,
  selectedSymbol,
  onSelectSymbol,
  favorites,
  onToggleFavorite,
}: LeaderboardProps) {
  const [search, setSearch] = useState('');
  const [selectedSector, setSelectedSector] = useState('All');
  const [selectedRating, setSelectedRating] = useState('All');
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);

  const [sortField, setSortField] = useState<SortField>('rsScore');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  const [page, setPage] = useState(1);
  const pageSize = 15;

  // Extract sectors dynamically
  const sectors = useMemo(() => {
    const set = new Set<string>();
    data.forEach((item) => {
      if (item.sector) set.add(item.sector);
    });
    return ['All', ...Array.from(set).sort()];
  }, [data]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
    setPage(1);
  };

  // Filter and Sort Data
  const processedData = useMemo(() => {
    let filtered = data.filter((item) => {
      const matchesSearch = item.symbol.toLowerCase().includes(search.toLowerCase());
      const matchesSector = selectedSector === 'All' || item.sector === selectedSector;
      const matchesRating = selectedRating === 'All' || item.rsRating === selectedRating;
      const matchesFav = !showFavoritesOnly || favorites.includes(item.symbol);
      return matchesSearch && matchesSector && matchesRating && matchesFav;
    });

    filtered.sort((a, b) => {
      let aVal = a[sortField];
      let bVal = b[sortField];

      // Handle undefined/null gracefully
      if (aVal === undefined) return 1;
      if (bVal === undefined) return -1;

      if (typeof aVal === 'string') {
        return sortOrder === 'asc'
          ? (aVal as string).localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal as string);
      } else {
        return sortOrder === 'asc'
          ? (aVal as number) - (bVal as number)
          : (bVal as number) - (aVal as number);
      }
    });

    return filtered;
  }, [data, search, selectedSector, selectedRating, showFavoritesOnly, favorites, sortField, sortOrder]);

  const paginatedData = useMemo(() => {
    const startIndex = (page - 1) * pageSize;
    return processedData.slice(startIndex, startIndex + pageSize);
  }, [processedData, page]);

  const totalPages = Math.max(1, Math.ceil(processedData.length / pageSize));

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortOrder === 'asc' ? <ChevronUp className="inline h-4 w-4 ml-0.5" /> : <ChevronDown className="inline h-4 w-4 ml-0.5" />;
  };

  return (
    <div className="flex flex-col h-full rounded-2xl border border-zinc-800/80 bg-zinc-950/60 backdrop-blur-md overflow-hidden">
      {/* Table Controls */}
      <div className="p-4 border-b border-zinc-800/80 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between bg-zinc-900/20">
        <div className="relative flex-1 max-w-sm">
          <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Search className="h-4 w-4 text-zinc-500" />
          </span>
          <input
            type="text"
            placeholder="Search stock symbol..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="block w-full pl-9 pr-3 py-2 border border-zinc-850 rounded-xl bg-zinc-900/60 text-white placeholder-zinc-500 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500/50 focus:border-emerald-500/50"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Sector Filter */}
          <div className="relative">
            <select
              value={selectedSector}
              onChange={(e) => {
                setSelectedSector(e.target.value);
                setPage(1);
              }}
              className="appearance-none bg-zinc-900/60 text-zinc-300 text-xs px-3 py-2 pr-8 border border-zinc-850 rounded-xl focus:outline-none focus:ring-1 focus:ring-emerald-500/50 cursor-pointer"
            >
              <option value="All">All Sectors</option>
              {sectors.filter((s) => s !== 'All').map((sec) => (
                <option key={sec} value={sec}>{sec}</option>
              ))}
            </select>
            <Filter className="absolute right-2.5 top-2.5 h-3 w-3 text-zinc-500 pointer-events-none" />
          </div>

          {/* Rating Filter */}
          <div className="relative">
            <select
              value={selectedRating}
              onChange={(e) => {
                setSelectedRating(e.target.value);
                setPage(1);
              }}
              className="appearance-none bg-zinc-900/60 text-zinc-300 text-xs px-3 py-2 pr-8 border border-zinc-850 rounded-xl focus:outline-none focus:ring-1 focus:ring-emerald-500/50 cursor-pointer"
            >
              <option value="All">All Grades</option>
              <option value="A">Grade A (Leader)</option>
              <option value="B">Grade B (Strong)</option>
              <option value="C">Grade C (Neutral)</option>
              <option value="D">Grade D (Lagging)</option>
            </select>
            <Filter className="absolute right-2.5 top-2.5 h-3 w-3 text-zinc-500 pointer-events-none" />
          </div>

          {/* Favorites Toggle */}
          <button
            onClick={() => {
              setShowFavoritesOnly(!showFavoritesOnly);
              setPage(1);
            }}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs border transition-all ${
              showFavoritesOnly
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-400 font-semibold'
                : 'bg-zinc-900/60 border-zinc-850 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Star className={`h-3.5 w-3.5 ${showFavoritesOnly ? 'fill-amber-400' : ''}`} />
            <span>Watchlist</span>
          </button>
        </div>
      </div>

      {/* Table Contents */}
      <div className="flex-1 overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-zinc-800/80 bg-zinc-900/40 text-xs font-semibold uppercase tracking-wider text-zinc-400 select-none">
              <th className="py-3 px-4 w-12 text-center">Fav</th>
              <th className="py-3 px-4 cursor-pointer hover:text-white transition-colors" onClick={() => handleSort('symbol')}>
                Symbol <SortIcon field="symbol" />
              </th>
              <th className="py-3 px-3 cursor-pointer text-center hover:text-white transition-colors" onClick={() => handleSort('rsScore')}>
                RS Score <SortIcon field="rsScore" />
              </th>
              <th className="py-3 px-2 text-center">Grade</th>
              <th className="py-3 px-3 cursor-pointer text-right hover:text-white transition-colors" onClick={() => handleSort('latestClose')}>
                Close <SortIcon field="latestClose" />
              </th>
              <th className="py-3 px-3 cursor-pointer text-right hover:text-white transition-colors" onClick={() => handleSort('priceChange1D')}>
                1D % <SortIcon field="priceChange1D" />
              </th>
              <th className="py-3 px-3 cursor-pointer text-right hover:text-white transition-colors" onClick={() => handleSort('priceChange1W')}>
                1W % <SortIcon field="priceChange1W" />
              </th>
              <th className="py-3 px-3 cursor-pointer text-right hover:text-white transition-colors" onClick={() => handleSort('priceChange3M')}>
                3M % <SortIcon field="priceChange3M" />
              </th>
              <th className="py-3 px-4 text-center w-28">Trend (20d)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900/60 text-sm">
            {paginatedData.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-8 text-center text-zinc-500">
                  No matching stocks found.
                </td>
              </tr>
            ) : (
              paginatedData.map((item) => {
                const isSelected = selectedSymbol === item.symbol;
                const isFavorite = favorites.includes(item.symbol);

                // Styling for Grade
                let gradeClass = '';
                if (item.rsRating === 'A') gradeClass = 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
                else if (item.rsRating === 'B') gradeClass = 'bg-blue-500/10 text-blue-400 border border-blue-500/20';
                else if (item.rsRating === 'C') gradeClass = 'bg-zinc-500/10 text-zinc-400 border border-zinc-550';
                else gradeClass = 'bg-red-500/10 text-red-400 border border-red-500/20';

                // Score bar color
                let scoreBg = 'bg-zinc-700';
                if (item.rsScore >= 80) scoreBg = 'bg-gradient-to-r from-emerald-500 to-teal-400';
                else if (item.rsScore >= 60) scoreBg = 'bg-gradient-to-r from-blue-500 to-indigo-400';
                else if (item.rsScore >= 40) scoreBg = 'bg-zinc-500';
                else scoreBg = 'bg-gradient-to-r from-red-600 to-orange-500';

                return (
                  <tr
                    key={item.symbol}
                    onClick={() => onSelectSymbol(item.symbol)}
                    className={`cursor-pointer hover:bg-zinc-900/30 transition-all select-none duration-150 ${
                      isSelected ? 'bg-emerald-950/20 border-l-2 border-l-emerald-500' : ''
                    }`}
                  >
                    {/* Favorite Button */}
                    <td
                      className="py-3 px-4 text-center"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleFavorite(item.symbol);
                      }}
                    >
                      <button className="text-zinc-600 hover:text-amber-400 transition-colors">
                        <Star className={`h-4 w-4 ${isFavorite ? 'fill-amber-400 text-amber-400' : ''}`} />
                      </button>
                    </td>

                    {/* Symbol & Sector */}
                    <td className="py-3 px-4">
                      <div className="font-semibold text-white tracking-wide">{item.symbol}</div>
                      <div className="text-xs text-zinc-500 truncate max-w-[120px]">{item.sector || 'Unassigned'}</div>
                    </td>

                    {/* RS Score with visual bar */}
                    <td className="py-3 px-3">
                      <div className="flex flex-col items-center justify-center gap-1 min-w-[70px]">
                        <span className="font-bold text-white text-base">{item.rsScore}</span>
                        <div className="w-full h-1 bg-zinc-800 rounded-full overflow-hidden">
                          <div className={`h-full ${scoreBg}`} style={{ width: `${item.rsScore}%` }} />
                        </div>
                      </div>
                    </td>

                    {/* Grade */}
                    <td className="py-3 px-2 text-center">
                      <span className={`inline-block text-xs font-bold px-2 py-0.5 rounded-full ${gradeClass}`}>
                        {item.rsRating}
                      </span>
                    </td>

                    {/* Closing Price */}
                    <td className="py-3 px-3 text-right font-mono font-medium text-zinc-300">
                      ₹{item.latestClose.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>

                    {/* 1D Change */}
                    <td className={`py-3 px-3 text-right font-mono font-medium ${item.priceChange1D >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {item.priceChange1D >= 0 ? '+' : ''}
                      {item.priceChange1D.toFixed(2)}%
                    </td>

                    {/* 1W Change */}
                    <td className={`py-3 px-3 text-right font-mono text-xs font-medium ${item.priceChange1W >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {item.priceChange1W >= 0 ? '+' : ''}
                      {item.priceChange1W.toFixed(2)}%
                    </td>

                    {/* 3M Change */}
                    <td className={`py-3 px-3 text-right font-mono text-xs font-medium ${item.priceChange3M >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {item.priceChange3M >= 0 ? '+' : ''}
                      {item.priceChange3M.toFixed(2)}%
                    </td>

                    {/* Trend Sparkline */}
                    <td className="py-3 px-4 text-center">
                      <Sparkline data={item.trend} />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Controls */}
      <div className="p-4 border-t border-zinc-800/80 flex items-center justify-between bg-zinc-900/20 text-xs text-zinc-400">
        <div>
          Showing {Math.min(processedData.length, (page - 1) * pageSize + 1)} to{' '}
          {Math.min(processedData.length, page * pageSize)} of {processedData.length} stocks
        </div>
        <div className="flex items-center gap-2">
          <button
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
            className="px-3 py-1.5 border border-zinc-800 rounded-lg hover:border-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-zinc-900/50"
          >
            Prev
          </button>
          <span className="font-medium text-zinc-300">
            Page {page} of {totalPages}
          </span>
          <button
            disabled={page === totalPages}
            onClick={() => setPage(page + 1)}
            className="px-3 py-1.5 border border-zinc-800 rounded-lg hover:border-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-zinc-900/50"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
