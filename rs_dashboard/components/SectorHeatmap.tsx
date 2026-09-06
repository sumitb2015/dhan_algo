'use client';

import React, { useMemo, useState } from 'react';
import { RSResult } from '@/lib/rs';
import { Grid, Eye, TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface SectorHeatmapProps {
  data: RSResult[];
  selectedSymbol: string | null;
  onSelectSymbol: (symbol: string) => void;
}

function sectorHealthColor(avgScore: number): string {
  if (avgScore >= 70) return 'text-emerald-400';
  if (avgScore >= 50) return 'text-blue-400';
  if (avgScore >= 30) return 'text-zinc-400';
  return 'text-red-400';
}

// Flat fills, not gradients — the Bloomberg style has no gradients anywhere.
function sectorBarColor(avgScore: number): string {
  if (avgScore >= 70) return 'bg-emerald-500';
  if (avgScore >= 50) return 'bg-blue-500';
  if (avgScore >= 30) return 'bg-zinc-600';
  return 'bg-red-500';
}

export default function SectorHeatmap({ data, selectedSymbol, onSelectSymbol }: SectorHeatmapProps) {
  const [minScore, setMinScore] = useState<number>(0);
  const [searchTerm, setSearchTerm] = useState<string>('');

  const groupedSectors = useMemo(() => {
    const groups: Record<string, RSResult[]> = {};

    data.forEach((item) => {
      if (item.rsScore < minScore) return;
      if (searchTerm && !item.symbol.toLowerCase().includes(searchTerm.toLowerCase())) return;

      const sec = item.sector || 'Unassigned';
      if (!groups[sec]) groups[sec] = [];
      groups[sec].push(item);
    });

    Object.keys(groups).forEach((sec) => {
      groups[sec].sort((a, b) => b.rsScore - a.rsScore);
    });

    // Sort sectors by average RS score descending (strongest sector first)
    return Object.fromEntries(
      Object.entries(groups)
        .filter(([, stocks]) => stocks.length > 0)
        .sort((a, b) => {
          const avgA = a[1].reduce((sum, s) => sum + s.rsScore, 0) / a[1].length;
          const avgB = b[1].reduce((sum, s) => sum + s.rsScore, 0) / b[1].length;
          return avgB - avgA;
        })
    );
  }, [data, minScore, searchTerm]);

  const getTileClasses = (score: number, isSelected: boolean) => {
    let base = 'relative flex flex-col justify-between p-2.5 rounded-xl border text-center transition-all duration-150 select-none cursor-pointer ';
    // ring-oncolor, not ring-white: "white" is the flipping brightest-text
    // token (near-black in light mode per CLAUDE.md), which would turn a
    // selection glow into a dark ring. oncolor is genuinely fixed white.
    if (isSelected) base += 'ring-2 ring-oncolor/70 scale-[1.04] z-10 shadow-lg ';

    if (score >= 80) return base + 'bg-emerald-500/12 text-emerald-300 border-emerald-500/35 hover:bg-emerald-500/22 hover:shadow-emerald-500/15 hover:shadow-lg';
    if (score >= 60) return base + 'bg-blue-500/12 text-blue-300 border-blue-500/30 hover:bg-blue-500/18 hover:shadow-blue-500/12 hover:shadow-lg';
    if (score >= 40) return base + 'bg-zinc-800/25 text-zinc-300 border-zinc-700/35 hover:bg-zinc-800/45';
    return base + 'bg-red-500/8 text-red-300 border-red-500/25 hover:bg-red-500/14 hover:shadow-red-500/10 hover:shadow-lg';
  };

  return (
    <div className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/70 overflow-hidden">
      {/* Header (dhan-bloomberg-dashboard-page panel formula) */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-amber-500/25 bg-zinc-950/60 px-5 py-3">
        <div className="flex items-center gap-2">
          <Grid className="h-3.5 w-3.5 text-amber-400" />
          <h2 className="text-[11px] font-bold uppercase tracking-[0.16em] text-amber-400">Sector Heatmap</h2>
          <span className="text-[10px] text-zinc-500 bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 rounded font-mono">
            Sorted by avg RS strength
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="text"
            placeholder="Search symbol..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="px-3 py-1.5 border border-zinc-800 rounded-lg bg-zinc-900 text-white placeholder-zinc-500 text-xs focus:outline-none focus:ring-1 focus:ring-amber-500/50"
          />

          <div className="flex items-center gap-2 text-xs">
            <span className="text-zinc-500">Min RS:</span>
            <input
              type="range"
              min="0"
              max="100"
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              className="w-20 accent-amber-500 cursor-pointer"
            />
            <span className="font-mono text-zinc-300 w-6 text-right">{minScore}</span>
          </div>
        </div>
      </div>

      {/* Heatmap Grid */}
      <div className="flex-1 overflow-y-auto max-h-[620px] px-5 pt-5 pr-4 space-y-5">
        {Object.keys(groupedSectors).length === 0 ? (
          <div className="text-center py-12 text-zinc-500 text-sm">No stocks match the selected criteria.</div>
        ) : (
          Object.entries(groupedSectors).map(([sector, stocks]) => {
            const avgScore = Math.round(stocks.reduce((s, x) => s + x.rsScore, 0) / stocks.length);
            const risingCount = stocks.filter((s) => s.rsMomentum === 'rising').length;
            const fallingCount = stocks.filter((s) => s.rsMomentum === 'falling').length;

            return (
              <div key={sector} className="space-y-2.5">
                {/* Sector Header */}
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-xs font-bold uppercase tracking-widest text-zinc-300">
                    {sector}
                  </span>
                  <span className="text-[10px] font-semibold font-mono bg-zinc-900 border border-zinc-800 text-zinc-500 px-1.5 py-0.5 rounded-full">
                    {stocks.length} stocks
                  </span>

                  {/* Avg RS Score */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-zinc-600">Avg RS:</span>
                    <span className={`text-xs font-bold font-mono ${sectorHealthColor(avgScore)}`}>{avgScore}</span>
                    <div className="w-20 h-1 bg-zinc-800 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${sectorBarColor(avgScore)}`} style={{ width: `${avgScore}%` }} />
                    </div>
                  </div>

                  {/* Momentum mini stats */}
                  {risingCount > 0 && (
                    <div className="flex items-center gap-0.5 text-[10px] text-emerald-400">
                      <TrendingUp className="h-3 w-3" />
                      <span>{risingCount} rising</span>
                    </div>
                  )}
                  {fallingCount > 0 && (
                    <div className="flex items-center gap-0.5 text-[10px] text-red-400">
                      <TrendingDown className="h-3 w-3" />
                      <span>{fallingCount} falling</span>
                    </div>
                  )}
                </div>

                {/* Stock Tiles */}
                <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-9 gap-2">
                  {stocks.map((stock) => {
                    const isSelected = selectedSymbol === stock.symbol;
                    return (
                      <div
                        key={stock.symbol}
                        onClick={() => onSelectSymbol(stock.symbol)}
                        className={getTileClasses(stock.rsScore, isSelected)}
                        title={`Grade: ${stock.rsRating} | RS Score: ${stock.rsScore} | RS Mom: ${stock.rsMomentum} | 1D: ${stock.priceChange1D.toFixed(2)}%`}
                      >
                        {/* Symbol + Score */}
                        <div className="flex items-start justify-between gap-1">
                          <span className="font-bold text-white text-[11px] tracking-wide leading-none">{stock.symbol}</span>
                          {/* bg-oncolor-dark, not bg-black: this scrim sits on
                              a saturated tile fill and must stay dark in both
                              themes to keep the score legible — bg-black
                              flips to near-white in light mode and would wash
                              out instead of darkening. */}
                          <span className="text-[9px] font-bold font-mono px-1 py-0.5 rounded bg-oncolor-dark/40 leading-none">
                            {stock.rsScore}
                          </span>
                        </div>

                        {/* Price + 1D change */}
                        <div className="flex items-baseline justify-between mt-2 gap-1">
                          <span className="text-[9px] text-zinc-500 font-mono leading-none">
                            ₹{Math.round(stock.latestClose).toLocaleString('en-IN')}
                          </span>
                          <span className={`text-[9px] font-bold font-mono leading-none ${stock.priceChange1D >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {stock.priceChange1D >= 0 ? '+' : ''}{stock.priceChange1D.toFixed(1)}%
                          </span>
                        </div>

                        {/* Momentum indicator dot */}
                        <div className="absolute top-1.5 right-1.5">
                          {stock.rsMomentum === 'rising' && <span className="block w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(16,185,129,0.7)]" />}
                          {stock.rsMomentum === 'falling' && <span className="block w-1.5 h-1.5 rounded-full bg-red-500 shadow-[0_0_4px_rgba(239,68,68,0.7)]" />}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Legend */}
      <div className="border-t border-zinc-800 mt-5 px-5 pt-4 pb-5 flex flex-wrap items-center justify-between gap-3 text-[10px] text-zinc-500">
        <div className="flex items-center gap-1.5">
          <Eye className="h-3.5 w-3.5" />
          <span>Click a tile to view its RS chart. Sectors sorted strongest first.</span>
        </div>
        <div className="flex items-center flex-wrap gap-x-4 gap-y-1.5">
          <span className="font-semibold uppercase tracking-wider text-zinc-600">Tile color:</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-emerald-500/20 border border-emerald-500/30 rounded" />Leader ≥80</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-blue-500/20 border border-blue-500/30 rounded" />Strong 60–79</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-zinc-700 border border-zinc-600 rounded" />Neutral 40–59</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-red-500/20 border border-red-500/30 rounded" />Lagging &lt;40</span>
          <span className="flex items-center gap-1 ml-2"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />Rising RS</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />Falling RS</span>
        </div>
      </div>
    </div>
  );
}
