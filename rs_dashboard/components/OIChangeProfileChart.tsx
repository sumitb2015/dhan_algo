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
  // Find maximum absolute OI change across strikes for scaling
  const maxAbsChange = Math.max(
    ...strikes.flatMap((s) => [Math.abs(s.ce_oi_change), Math.abs(s.pe_oi_change)]),
    1
  );

  return (
    <div className="w-full h-full flex flex-col bg-zinc-950/80 border border-zinc-800/80 rounded-xl p-3 shadow-inner overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between pb-2 border-b border-zinc-800/60 mb-2">
        <div className="flex items-center gap-2">
          <span className="font-bold text-zinc-100 text-xs tracking-wide">Daily OI Change</span>
          <span className="text-[10px] text-zinc-400 font-mono">Positioning</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-semibold">
          <span className="flex items-center gap-1 text-emerald-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" /> CE Chg (Left)
          </span>
          <span className="flex items-center gap-1 text-rose-400">
            <span className="w-2 h-2 rounded-full bg-rose-400 inline-block" /> PE Chg (Right)
          </span>
        </div>
      </div>

      {/* Strike Rows Container */}
      <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 scrollbar-thin scrollbar-thumb-zinc-800">
        {strikes.map((row) => {
          const isATM = row.strike === atmStrike;

          const cePct = Math.min(100, Math.max(0, (Math.abs(row.ce_oi_change) / maxAbsChange) * 100));
          const pePct = Math.min(100, Math.max(0, (Math.abs(row.pe_oi_change) / maxAbsChange) * 100));

          const ceIsPositive = row.ce_oi_change >= 0;
          const peIsPositive = row.pe_oi_change >= 0;

          return (
            <div
              key={row.strike}
              className={`grid grid-cols-12 items-center gap-1 py-0.5 px-1.5 rounded transition-colors text-xs font-mono ${
                isATM
                  ? 'bg-amber-950/40 border border-amber-500/50 text-amber-200'
                  : 'hover:bg-zinc-900/80 text-zinc-300'
              }`}
            >
              {/* LEFT COLUMN: Call OI Change (Green / Unwinding Slate) */}
              <div className="col-span-5 flex items-center justify-end gap-1.5 h-5 relative">
                <span
                  className={`text-[10px] font-mono z-10 select-none ${
                    ceIsPositive ? 'text-emerald-400' : 'text-slate-400'
                  }`}
                >
                  {formatOIChange(row.ce_oi_change)}
                </span>
                <div className="w-full bg-zinc-900/60 rounded h-3.5 flex justify-end overflow-hidden relative">
                  <div
                    className={`h-full rounded-l transition-all duration-300 ${
                      ceIsPositive
                        ? 'bg-emerald-500/90'
                        : 'bg-slate-500/60 opacity-80 border-r border-emerald-400/40'
                    }`}
                    style={{ width: `${cePct}%` }}
                  />
                </div>
              </div>

              {/* CENTER COLUMN: Strike Price */}
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

              {/* RIGHT COLUMN: Put OI Change (Red / Unwinding Slate) */}
              <div className="col-span-5 flex items-center justify-start gap-1.5 h-5 relative">
                <div className="w-full bg-zinc-900/60 rounded h-3.5 flex justify-start overflow-hidden relative">
                  <div
                    className={`h-full rounded-r transition-all duration-300 ${
                      peIsPositive
                        ? 'bg-rose-500/90'
                        : 'bg-slate-500/60 opacity-80 border-l border-rose-400/40'
                    }`}
                    style={{ width: `${pePct}%` }}
                  />
                </div>
                <span
                  className={`text-[10px] font-mono z-10 select-none ${
                    peIsPositive ? 'text-rose-400' : 'text-slate-400'
                  }`}
                >
                  {formatOIChange(row.pe_oi_change)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
