'use client';

import React from 'react';
import type { StrikeProfile } from '@/app/api/nifty-oi-profile/route';

interface Props {
  strikes: StrikeProfile[];
  atmStrike: number;
  maxCallOiStrike?: number;
  maxPutOiStrike?: number;
}

function formatOI(val: number): string {
  if (Math.abs(val) >= 1_00_000) {
    return `${(val / 1_00_000).toFixed(2)}L`;
  }
  if (Math.abs(val) >= 1_000) {
    return `${(val / 1_000).toFixed(1)}K`;
  }
  return String(val);
}

export default function OIProfileChart({
  strikes,
  atmStrike,
  maxCallOiStrike,
  maxPutOiStrike,
}: Props) {
  // Find maximum OI across all strikes for scale calculation
  const maxOI = Math.max(
    ...strikes.flatMap((s) => [s.ce_oi, s.pe_oi]),
    1
  );

  return (
    <div className="w-full h-full flex flex-col bg-zinc-950/80 border border-zinc-800/80 rounded-xl p-3 shadow-inner overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between pb-2 border-b border-zinc-800/60 mb-2">
        <div className="flex items-center gap-2">
          <span className="font-bold text-zinc-100 text-xs tracking-wide">Current Open Interest</span>
          <span className="text-[10px] text-zinc-400 font-mono">CE vs PE</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-semibold">
          <span className="flex items-center gap-1 text-emerald-400">
            <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> Call OI (Left)
          </span>
          <span className="flex items-center gap-1 text-rose-400">
            <span className="w-2 h-2 rounded-full bg-rose-500 inline-block" /> Put OI (Right)
          </span>
        </div>
      </div>

      {/* Strike Rows Container */}
      <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 scrollbar-thin scrollbar-thumb-zinc-800">
        {strikes.map((row) => {
          const isATM = row.strike === atmStrike;
          const isResistance = row.strike === maxCallOiStrike;
          const isSupport = row.strike === maxPutOiStrike;

          const cePct = Math.min(100, Math.max(0, (row.ce_oi / maxOI) * 100));
          const pePct = Math.min(100, Math.max(0, (row.pe_oi / maxOI) * 100));

          return (
            <div
              key={row.strike}
              className={`grid grid-cols-12 items-center gap-1 py-0.5 px-1.5 rounded transition-colors text-xs font-mono ${
                isATM
                  ? 'bg-amber-950/40 border border-amber-500/50 text-amber-200'
                  : 'hover:bg-zinc-900/80 text-zinc-300'
              }`}
            >
              {/* LEFT COLUMN: Call OI (Green) */}
              <div className="col-span-5 flex items-center justify-end gap-1.5 h-5 relative">
                <span className="text-[10px] text-zinc-400 font-mono z-10 select-none">
                  {formatOI(row.ce_oi)}
                </span>
                <div className="w-full bg-zinc-900/60 rounded h-3.5 flex justify-end overflow-hidden relative">
                  <div
                    className={`h-full rounded-l transition-all duration-300 ${
                      isResistance
                        ? 'bg-gradient-to-l from-emerald-500 to-emerald-700 shadow-sm shadow-emerald-500/50'
                        : 'bg-emerald-500/80'
                    }`}
                    style={{ width: `${cePct}%` }}
                  />
                </div>
              </div>

              {/* CENTER COLUMN: Strike Price */}
              <div className="col-span-2 text-center font-bold text-[11px] relative flex items-center justify-center gap-1">
                {isResistance && (
                  <span className="hidden xl:inline-block text-[9px] px-1 bg-emerald-950 text-emerald-300 border border-emerald-800 rounded font-sans">
                    RES
                  </span>
                )}

                <span
                  className={`px-1 rounded ${
                    isATM
                      ? 'bg-amber-500 text-zinc-950 font-extrabold shadow'
                      : 'text-zinc-100'
                  }`}
                >
                  {row.strike}
                </span>

                {isSupport && (
                  <span className="hidden xl:inline-block text-[9px] px-1 bg-rose-950 text-rose-300 border border-rose-800 rounded font-sans">
                    SUP
                  </span>
                )}
              </div>

              {/* RIGHT COLUMN: Put OI (Red) */}
              <div className="col-span-5 flex items-center justify-start gap-1.5 h-5 relative">
                <div className="w-full bg-zinc-900/60 rounded h-3.5 flex justify-start overflow-hidden relative">
                  <div
                    className={`h-full rounded-r transition-all duration-300 ${
                      isSupport
                        ? 'bg-gradient-to-r from-rose-500 to-rose-700 shadow-sm shadow-rose-500/50'
                        : 'bg-rose-500/80'
                    }`}
                    style={{ width: `${pePct}%` }}
                  />
                </div>
                <span className="text-[10px] text-zinc-400 font-mono z-10 select-none">
                  {formatOI(row.pe_oi)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
