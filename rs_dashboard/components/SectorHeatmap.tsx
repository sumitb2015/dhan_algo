'use client';

import React, { useMemo, useState } from 'react';
import { RSResult } from '@/lib/rs';
import { Grid, Eye } from 'lucide-react';

interface SectorHeatmapProps {
  data: RSResult[];
  selectedSymbol: string | null;
  onSelectSymbol: (symbol: string) => void;
}

export default function SectorHeatmap({ data, selectedSymbol, onSelectSymbol }: SectorHeatmapProps) {
  const [minScore, setMinScore] = useState<number>(0);
  const [searchTerm, setSearchTerm] = useState<string>('');

  // Group and sort stocks by sector
  const groupedSectors = useMemo(() => {
    const groups: Record<string, RSResult[]> = {};

    data.forEach((item) => {
      // Apply filters
      if (item.rsScore < minScore) return;
      if (searchTerm && !item.symbol.toLowerCase().includes(searchTerm.toLowerCase())) return;

      const sec = item.sector || 'Unassigned';
      if (!groups[sec]) groups[sec] = [];
      groups[sec].push(item);
    });

    // Sort stocks within each sector by RS Score descending
    Object.keys(groups).forEach((sec) => {
      groups[sec].sort((a, b) => b.rsScore - a.rsScore);
    });

    // Remove empty sectors
    return Object.fromEntries(
      Object.entries(groups)
        .filter(([, stocks]) => stocks.length > 0)
        .sort((a, b) => b[1].length - a[1].length) // Sort sectors by number of stocks descending
    );
  }, [data, minScore, searchTerm]);

  const getTileClasses = (score: number, isSelected: boolean) => {
    let base = 'relative flex flex-col justify-between p-3 rounded-xl border text-center transition-all duration-200 select-none cursor-pointer ';
    if (isSelected) {
      base += 'ring-2 ring-white scale-[1.03] z-10 ';
    }

    if (score >= 80) {
      return base + 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/20 hover:shadow-[0_0_15px_rgba(16,185,129,0.25)]';
    } else if (score >= 60) {
      return base + 'bg-blue-500/10 text-blue-300 border-blue-500/25 hover:bg-blue-500/15 hover:shadow-[0_0_15px_rgba(59,130,246,0.2)]';
    } else if (score >= 40) {
      return base + 'bg-zinc-800/20 text-zinc-300 border-zinc-700/30 hover:bg-zinc-800/40';
    } else {
      return base + 'bg-red-500/10 text-red-300 border-red-500/25 hover:bg-red-500/15 hover:shadow-[0_0_15px_rgba(239,68,68,0.2)]';
    }
  };

  return (
    <div className="flex flex-col h-full rounded-2xl border border-zinc-800/80 bg-zinc-950/60 backdrop-blur-md p-6 overflow-hidden">
      {/* Controls Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-zinc-800/60 pb-5 mb-6">
        <div className="flex items-center gap-2">
          <Grid className="h-5 w-5 text-emerald-500" />
          <h2 className="text-lg font-bold text-white tracking-wide">Sector Heatmap</h2>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          {/* Search block */}
          <input
            type="text"
            placeholder="Search symbol..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="px-3 py-1.5 border border-zinc-850 rounded-xl bg-zinc-900/60 text-white placeholder-zinc-500 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
          />

          {/* Slider for RS score */}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-zinc-500">Min RS:</span>
            <input
              type="range"
              min="0"
              max="100"
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              className="w-24 accent-emerald-500 h-1 rounded-full cursor-pointer bg-zinc-800"
            />
            <span className="font-mono text-zinc-300 w-6 text-right">{minScore}</span>
          </div>
        </div>
      </div>

      {/* Heatmap Grid */}
      <div className="flex-1 overflow-y-auto max-h-[600px] pr-1 space-y-6">
        {Object.keys(groupedSectors).length === 0 ? (
          <div className="text-center py-12 text-zinc-500 text-sm">
            No stocks match the selected criteria.
          </div>
        ) : (
          Object.entries(groupedSectors).map(([sector, stocks]) => (
            <div key={sector} className="space-y-3">
              {/* Sector Title with Badge */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">
                  {sector}
                </span>
                <span className="text-[10px] font-semibold font-mono bg-zinc-900 border border-zinc-800 text-zinc-500 px-1.5 py-0.5 rounded-full">
                  {stocks.length}
                </span>
              </div>

              {/* Stock Tiles Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3">
                {stocks.map((stock) => {
                  const isSelected = selectedSymbol === stock.symbol;

                  return (
                    <div
                      key={stock.symbol}
                      onClick={() => onSelectSymbol(stock.symbol)}
                      className={getTileClasses(stock.rsScore, isSelected)}
                      title={`Grade: ${stock.rsRating} | RS Score: ${stock.rsScore} | 1D: ${stock.priceChange1D.toFixed(2)}%`}
                    >
                      <div className="flex items-center justify-between gap-1 w-full">
                        <span className="font-bold text-white text-xs tracking-wide">
                          {stock.symbol}
                        </span>
                        <span className="text-[9px] font-semibold opacity-75 font-mono px-1 rounded bg-black/35">
                          {stock.rsScore}
                        </span>
                      </div>
                      <div className="flex items-baseline justify-between mt-2.5 w-full">
                        <span className="text-[9px] text-zinc-500 font-mono">
                          ₹{Math.round(stock.latestClose).toLocaleString('en-IN')}
                        </span>
                        <span className={`text-[9px] font-mono font-medium ${stock.priceChange1D >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {stock.priceChange1D >= 0 ? '+' : ''}
                          {stock.priceChange1D.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Heatmap Legend */}
      <div className="border-t border-zinc-900 mt-5 pt-4 flex items-center justify-between text-[10px] text-zinc-500">
        <div className="flex items-center gap-1">
          <Eye className="h-3.5 w-3.5 text-zinc-500" />
          <span>Click a tile to display its detailed relative strength charts</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-semibold uppercase tracking-wider">Legend:</span>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 bg-emerald-500/20 border border-emerald-500/30 rounded" />
            <span>Leader (RS &gt;= 80)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 bg-blue-500/20 border border-blue-500/30 rounded" />
            <span>Strong (60-79)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 bg-zinc-800 border border-zinc-700 rounded" />
            <span>Neutral (40-59)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 bg-red-500/20 border border-red-500/30 rounded" />
            <span>Lagging (&lt; 40)</span>
          </div>
        </div>
      </div>
    </div>
  );
}
