'use client';

import React from 'react';
import { TrendingUp, TrendingDown, Activity, Heart } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

interface IndexData {
  close: number;
  change: number;
  changePercent: number;
  date: string;
}

interface IndexSummaryProps {
  nifty50: IndexData | null;
  nifty500: IndexData | null;
  loading: boolean;
  advances: number;
  declines: number;
  ratingCounts: { A: number; B: number; C: number; D: number };
}

export default function IndexSummary({
  nifty50,
  nifty500,
  loading,
  advances,
  declines,
  ratingCounts,
}: IndexSummaryProps) {
  const totalStocks = advances + declines;
  const advancePercent = totalStocks > 0 ? (advances / totalStocks) * 100 : 0;

  const totalRated = ratingCounts.A + ratingCounts.B + ratingCounts.C + ratingCounts.D;
  const leaders = ratingCounts.A + ratingCounts.B;
  const healthScore = totalRated > 0 ? Math.round((leaders / totalRated) * 100) : 0;
  const healthLabel =
    healthScore >= 60 ? { text: 'Bullish', color: 'text-emerald-400' }
    : healthScore >= 40 ? { text: 'Neutral', color: 'text-amber-400' }
    : { text: 'Bearish', color: 'text-red-400' };

  const gradeWidths = totalRated > 0 ? {
    A: (ratingCounts.A / totalRated) * 100,
    B: (ratingCounts.B / totalRated) * 100,
    C: (ratingCounts.C / totalRated) * 100,
    D: (ratingCounts.D / totalRated) * 100,
  } : { A: 25, B: 25, C: 25, D: 25 };

  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 w-full">
      {/* Nifty 50 */}
      <Card className="relative overflow-hidden border-zinc-800/80 bg-zinc-950/60 backdrop-blur-md hover:border-zinc-700/60 transition-all ring-0 before:absolute before:inset-x-0 before:top-0 before:h-[2px] before:bg-gradient-to-r before:from-emerald-500 before:to-teal-400">
        <div className="absolute top-0 right-0 w-20 h-20 bg-emerald-500/6 rounded-full blur-xl pointer-events-none" />
        <CardContent className="px-4 py-3">
          <p className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">Nifty 50</p>
          {loading ? (
            <div className="mt-1.5 space-y-1.5">
              <div className="h-6 w-24 animate-pulse bg-zinc-800 rounded" />
              <div className="h-3 w-16 animate-pulse bg-zinc-800/60 rounded" />
            </div>
          ) : nifty50 ? (
            <div className="mt-1">
              <div className="text-xl font-black tracking-tight text-white tabular-nums leading-none">
                {nifty50.close.toLocaleString('en-IN')}
              </div>
              <div className={`mt-1 flex items-center gap-1 text-xs font-semibold ${nifty50.change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {nifty50.change >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                <span className="font-mono">{nifty50.changePercent >= 0 ? '+' : ''}{nifty50.changePercent.toFixed(2)}%</span>
                <span className="text-zinc-600 text-[10px]">{nifty50.change >= 0 ? '+' : ''}{nifty50.change.toFixed(0)}</span>
              </div>
            </div>
          ) : (
            <div className="text-xs text-zinc-500 mt-1.5">Unavailable</div>
          )}
        </CardContent>
      </Card>

      {/* Nifty 500 */}
      <Card className="relative overflow-hidden border-zinc-800/80 bg-zinc-950/60 backdrop-blur-md hover:border-zinc-700/60 transition-all ring-0 before:absolute before:inset-x-0 before:top-0 before:h-[2px] before:bg-gradient-to-r before:from-blue-500 before:to-indigo-400">
        <div className="absolute top-0 right-0 w-20 h-20 bg-blue-500/6 rounded-full blur-xl pointer-events-none" />
        <CardContent className="px-4 py-3">
          <p className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">Nifty 500</p>
          {loading ? (
            <div className="mt-1.5 space-y-1.5">
              <div className="h-6 w-24 animate-pulse bg-zinc-800 rounded" />
              <div className="h-3 w-16 animate-pulse bg-zinc-800/60 rounded" />
            </div>
          ) : nifty500 ? (
            <div className="mt-1">
              <div className="text-xl font-black tracking-tight text-white tabular-nums leading-none">
                {nifty500.close.toLocaleString('en-IN')}
              </div>
              <div className={`mt-1 flex items-center gap-1 text-xs font-semibold ${nifty500.change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {nifty500.change >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                <span className="font-mono">{nifty500.changePercent >= 0 ? '+' : ''}{nifty500.changePercent.toFixed(2)}%</span>
                <span className="text-zinc-600 text-[10px]">{nifty500.change >= 0 ? '+' : ''}{nifty500.change.toFixed(0)}</span>
              </div>
            </div>
          ) : (
            <div className="text-xs text-zinc-500 mt-1.5">Unavailable</div>
          )}
        </CardContent>
      </Card>

      {/* Market Breadth */}
      <Card className="relative overflow-hidden border-zinc-800/80 bg-zinc-950/60 backdrop-blur-md hover:border-zinc-700/60 transition-all ring-0 before:absolute before:inset-x-0 before:top-0 before:h-[2px] before:bg-gradient-to-r before:from-violet-500 before:to-purple-400">
        <div className="absolute top-0 right-0 w-20 h-20 bg-violet-500/6 rounded-full blur-xl pointer-events-none" />
        <CardContent className="px-4 py-3">
          <div className="flex items-center justify-between">
            <p className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">Daily Breadth</p>
            <Activity className="h-3 w-3 text-violet-400" />
          </div>
          {loading ? (
            <div className="mt-1.5 space-y-1.5">
              <div className="h-5 w-28 animate-pulse bg-zinc-800 rounded" />
              <div className="h-1.5 w-full animate-pulse bg-zinc-800/60 rounded-full" />
            </div>
          ) : (
            <div className="mt-1">
              <div className="flex items-baseline justify-between">
                <div>
                  <span className="text-lg font-black text-emerald-400 tabular-nums">{advances}</span>
                  <span className="text-[10px] text-zinc-600 ml-1">up</span>
                </div>
                <span className="text-[11px] text-zinc-500 font-mono">{advancePercent.toFixed(0)}%</span>
                <div>
                  <span className="text-lg font-black text-red-400 tabular-nums">{declines}</span>
                  <span className="text-[10px] text-zinc-600 ml-1">dn</span>
                </div>
              </div>
              <div className="mt-2 h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden flex">
                <div className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-700" style={{ width: `${advancePercent}%` }} />
                <div className="h-full bg-gradient-to-r from-red-600 to-red-400 transition-all duration-700" style={{ width: `${100 - advancePercent}%` }} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Market Health */}
      <Card className="relative overflow-hidden border-zinc-800/80 bg-zinc-950/60 backdrop-blur-md hover:border-zinc-700/60 transition-all ring-0 before:absolute before:inset-x-0 before:top-0 before:h-[2px] before:bg-gradient-to-r before:from-amber-500 before:to-orange-400">
        <div className="absolute top-0 right-0 w-20 h-20 bg-amber-500/6 rounded-full blur-xl pointer-events-none" />
        <CardContent className="px-4 py-3">
          <div className="flex items-center justify-between">
            <p className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">Market Health</p>
            <Heart className="h-3 w-3 text-amber-400" />
          </div>
          {loading ? (
            <div className="mt-1.5 space-y-1.5">
              <div className="h-5 w-20 animate-pulse bg-zinc-800 rounded" />
              <div className="h-1.5 w-full animate-pulse bg-zinc-800/60 rounded-full" />
            </div>
          ) : (
            <div className="mt-1">
              <div className="flex items-baseline gap-2">
                <span className={`text-xl font-black tabular-nums leading-none ${healthLabel.color}`}>{healthScore}%</span>
                <span className={`text-[11px] font-semibold ${healthLabel.color}`}>{healthLabel.text}</span>
              </div>
              <div className="mt-2 h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden flex">
                <div className="h-full bg-emerald-500 transition-all duration-700" style={{ width: `${gradeWidths.A}%` }} title={`A: ${ratingCounts.A}`} />
                <div className="h-full bg-blue-500 transition-all duration-700" style={{ width: `${gradeWidths.B}%` }} title={`B: ${ratingCounts.B}`} />
                <div className="h-full bg-zinc-500 transition-all duration-700" style={{ width: `${gradeWidths.C}%` }} title={`C: ${ratingCounts.C}`} />
                <div className="h-full bg-red-600 transition-all duration-700" style={{ width: `${gradeWidths.D}%` }} title={`D: ${ratingCounts.D}`} />
              </div>
              <div className="mt-1.5 flex items-center gap-2.5 text-[10px] font-mono">
                <span className="text-emerald-400">A:{ratingCounts.A}</span>
                <span className="text-blue-400">B:{ratingCounts.B}</span>
                <span className="text-zinc-400">C:{ratingCounts.C}</span>
                <span className="text-red-400">D:{ratingCounts.D}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
