'use client';

import React from 'react';
import type { StrikeProfile } from '@/app/api/nifty-oi-profile/route';

interface Props {
  strikes: StrikeProfile[];
  atmStrike: number;
}

function formatOIChange(val: number): string {
  const sign = val > 0 ? '+' : val < 0 ? '-' : '';
  const absVal = Math.abs(val);
  if (absVal >= 1_00_000) {
    return `${sign}${(absVal / 1_00_000).toFixed(2)}L`;
  }
  if (absVal >= 1_000) {
    return `${sign}${(absVal / 1_000).toFixed(1)}K`;
  }
  return `${sign}${absVal}`;
}

export default function OIChangeProfileChart({ strikes, atmStrike }: Props) {
  // Net delta OI per strike: call OI change minus put OI change. Positive means
  // calls are building (or puts unwinding) faster than the reverse — net bullish
  // positioning pressure at that strike; negative is the mirror (net bearish).
  const netDeltas = strikes.map((s) => s.ce_oi_change - s.pe_oi_change);
  const maxAbsDelta = Math.max(...netDeltas.map((d) => Math.abs(d)), 1);

  return (
    <div className="w-full h-full flex flex-col bg-zinc-950/80 border border-zinc-800/80 rounded-xl p-3 shadow-inner overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between pb-2 border-b border-zinc-800/60 mb-2">
        <div className="flex items-center gap-2">
          <span className="font-bold text-zinc-100 text-xs tracking-wide">Net Delta OI</span>
          <span className="text-[10px] text-zinc-400 font-mono" title="Net Δ = Call OI Chg − Put OI Chg">
            CE Chg − PE Chg
          </span>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-semibold">
          <span className="flex items-center gap-1 text-emerald-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" /> Net Call Buildup
          </span>
          <span className="flex items-center gap-1 text-rose-400">
            <span className="w-2 h-2 rounded-full bg-rose-400 inline-block" /> Net Put Buildup
          </span>
        </div>
      </div>

      {/* Strike Rows Container */}
      <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 scrollbar-thin scrollbar-thumb-zinc-800">
        {strikes.map((row, idx) => {
          const isATM = row.strike === atmStrike;
          const netDelta = netDeltas[idx];
          const isPositive = netDelta >= 0;
          const pct = Math.min(100, (Math.abs(netDelta) / maxAbsDelta) * 100);

          return (
            <div
              key={row.strike}
              className={`grid grid-cols-12 items-center gap-1 py-0.5 px-1.5 rounded transition-colors text-xs font-mono ${
                isATM
                  ? 'bg-amber-950/40 border border-amber-500/50 text-amber-200'
                  : 'hover:bg-zinc-900/80 text-zinc-300'
              }`}
            >
              {/* LEFT COLUMN: Strike Price */}
              <div className="col-span-2 text-center font-bold text-[11px] relative flex items-center justify-center">
                <span
                  className={`px-1 rounded ${
                    isATM
                      ? 'bg-amber-500 text-zinc-950 font-extrabold shadow'
                      : 'text-zinc-100'
                  }`}
                >
                  {row.strike}
                </span>
              </div>

              {/* CENTER COLUMN: Bidirectional net delta bar, diverging from a center line */}
              <div className="col-span-7 h-3.5 relative">
                <div className="absolute inset-0 bg-zinc-900/60 rounded overflow-hidden">
                  <div className="absolute left-1/2 top-0 bottom-0 w-px bg-zinc-700" />
                  {isPositive ? (
                    <div
                      className="absolute top-0 bottom-0 left-1/2 rounded-r bg-emerald-500/90"
                      style={{ width: `${pct / 2}%` }}
                    />
                  ) : (
                    <div
                      className="absolute top-0 bottom-0 right-1/2 rounded-l bg-rose-500/90"
                      style={{ width: `${pct / 2}%` }}
                    />
                  )}
                </div>
              </div>

              {/* RIGHT COLUMN: Net delta value */}
              <div className="col-span-3 flex items-center justify-end">
                <span
                  className={`text-[10px] font-mono z-10 select-none font-semibold ${
                    isPositive ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {formatOIChange(netDelta)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
