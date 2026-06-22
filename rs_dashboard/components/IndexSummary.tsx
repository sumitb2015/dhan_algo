'use client';

import React from 'react';
import { TrendingUp, TrendingDown, Activity, Award } from 'lucide-react';

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

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 w-full mb-6">
      {/* Nifty 50 Card */}
      <div className="relative overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-5 backdrop-blur-md transition-all hover:border-zinc-700/80">
        <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/10 rounded-full blur-2xl" />
        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Nifty 50 Index</p>
        {loading ? (
          <div className="h-12 flex items-center justify-start">
            <div className="h-6 w-24 animate-pulse bg-zinc-800 rounded" />
          </div>
        ) : nifty50 ? (
          <div className="mt-2">
            <div className="text-2xl font-bold tracking-tight text-white">
              {nifty50.close.toLocaleString('en-IN')}
            </div>
            <div className={`mt-1 flex items-center text-xs font-medium ${nifty50.change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {nifty50.change >= 0 ? <TrendingUp className="mr-1 h-3.5 w-3.5" /> : <TrendingDown className="mr-1 h-3.5 w-3.5" />}
              <span>
                {nifty50.change >= 0 ? '+' : ''}
                {nifty50.change.toFixed(2)} ({nifty50.changePercent.toFixed(2)}%)
              </span>
              <span className="ml-2 text-zinc-500">today</span>
            </div>
          </div>
        ) : (
          <div className="text-sm text-zinc-400 mt-2">Data unavailable</div>
        )}
      </div>

      {/* Nifty 500 Card */}
      <div className="relative overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-5 backdrop-blur-md transition-all hover:border-zinc-700/80">
        <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/10 rounded-full blur-2xl" />
        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Nifty 500 Index</p>
        {loading ? (
          <div className="h-12 flex items-center justify-start">
            <div className="h-6 w-24 animate-pulse bg-zinc-800 rounded" />
          </div>
        ) : nifty500 ? (
          <div className="mt-2">
            <div className="text-2xl font-bold tracking-tight text-white">
              {nifty500.close.toLocaleString('en-IN')}
            </div>
            <div className={`mt-1 flex items-center text-xs font-medium ${nifty500.change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {nifty500.change >= 0 ? <TrendingUp className="mr-1 h-3.5 w-3.5" /> : <TrendingDown className="mr-1 h-3.5 w-3.5" />}
              <span>
                {nifty500.change >= 0 ? '+' : ''}
                {nifty500.change.toFixed(2)} ({nifty500.changePercent.toFixed(2)}%)
              </span>
              <span className="ml-2 text-zinc-500">today</span>
            </div>
          </div>
        ) : (
          <div className="text-sm text-zinc-400 mt-2">Data unavailable</div>
        )}
      </div>

      {/* Market Breadth (Advances/Declines) */}
      <div className="relative overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-5 backdrop-blur-md transition-all hover:border-zinc-700/80">
        <div className="absolute top-0 right-0 w-24 h-24 bg-violet-500/10 rounded-full blur-2xl" />
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Daily Breadth</p>
          <Activity className="h-4 w-4 text-violet-400" />
        </div>
        {loading ? (
          <div className="h-12 flex flex-col justify-end gap-1">
            <div className="h-4 w-32 animate-pulse bg-zinc-800 rounded" />
            <div className="h-2 w-full animate-pulse bg-zinc-800 rounded" />
          </div>
        ) : (
          <div className="mt-2">
            <div className="flex items-baseline justify-between">
              <span className="text-lg font-bold text-emerald-400">{advances} Adv</span>
              <span className="text-xs text-zinc-500">vs</span>
              <span className="text-lg font-bold text-red-400">{declines} Decl</span>
            </div>
            {/* Custom Progress Bar */}
            <div className="mt-2.5 h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden flex">
              <div
                className="h-full bg-emerald-500 transition-all duration-500"
                style={{ width: `${advancePercent}%` }}
              />
              <div
                className="h-full bg-red-500 transition-all duration-500"
                style={{ width: `${100 - advancePercent}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* RS Ratings Distribution */}
      <div className="relative overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-5 backdrop-blur-md transition-all hover:border-zinc-700/80">
        <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/10 rounded-full blur-2xl" />
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">RS Grade Profile</p>
          <Award className="h-4 w-4 text-amber-400" />
        </div>
        {loading ? (
          <div className="mt-4 flex items-center justify-between gap-1">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-8 w-8 animate-pulse bg-zinc-800 rounded-full" />
            ))}
          </div>
        ) : (
          <div className="mt-2 flex items-center justify-between text-center">
            <div>
              <div className="text-xs font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">A</div>
              <div className="text-sm font-semibold text-zinc-300 mt-1">{ratingCounts.A}</div>
            </div>
            <div>
              <div className="text-xs font-bold text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full border border-blue-500/20">B</div>
              <div className="text-sm font-semibold text-zinc-300 mt-1">{ratingCounts.B}</div>
            </div>
            <div>
              <div className="text-xs font-bold text-zinc-400 bg-zinc-500/10 px-2 py-0.5 rounded-full border border-zinc-500/20">C</div>
              <div className="text-sm font-semibold text-zinc-300 mt-1">{ratingCounts.C}</div>
            </div>
            <div>
              <div className="text-xs font-bold text-red-400 bg-red-500/10 px-2 py-0.5 rounded-full border border-red-500/20">D</div>
              <div className="text-sm font-semibold text-zinc-300 mt-1">{ratingCounts.D}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
