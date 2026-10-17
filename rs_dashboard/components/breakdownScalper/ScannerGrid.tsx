'use client';

import { useState } from 'react';
import { Sparkles, Shield, ArrowDown, Check, AlertCircle, ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CandidateSignal } from '@/lib/breakdownScalper';

interface ScannerGridProps {
  candidates: CandidateSignal[];
  atm: number;
  spot: number;
  onManualShort: (candidate: CandidateSignal) => void;
  isEngineActive: boolean;
}

export function ScannerGrid({
  candidates,
  atm,
  spot,
  onManualShort,
  isEngineActive,
}: ScannerGridProps) {
  const [filterSide, setFilterSide] = useState<'ALL' | 'PE' | 'CE' | 'ELIGIBLE'>('ALL');

  const filtered = candidates.filter((c) => {
    if (filterSide === 'ELIGIBLE') return c.isEligible;
    if (filterSide === 'CE') return c.option === 'CE';
    if (filterSide === 'PE') return c.option === 'PE';
    return true;
  });

  const eligibleCount = candidates.filter((c) => c.isEligible).length;

  return (
    <div className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-950/70 backdrop-blur">
      {/* Strip Header */}
      <div className="flex flex-wrap items-center justify-between border-b border-zinc-800 px-4 py-3 gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-bold uppercase tracking-wider text-white">
              Multi-Strike Breakdown Scanner
            </h2>
            <span className="rounded bg-zinc-900 border border-zinc-800 px-2 py-0.5 text-[10px] font-mono text-zinc-400">
              ATM: <strong className="text-white">{atm || '—'}</strong>
            </span>
            <span className="rounded bg-zinc-900 border border-zinc-800 px-2 py-0.5 text-[10px] font-mono text-zinc-400">
              Universe: <strong className="text-zinc-200">{candidates.length} Contracts</strong>
            </span>
          </div>
        </div>

        {/* View Filter Pill */}
        <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
          <button
            type="button"
            onClick={() => setFilterSide('ALL')}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-bold transition-all',
              filterSide === 'ALL'
                ? 'bg-zinc-800 text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200',
            )}
          >
            ALL ({candidates.length})
          </button>
          <button
            type="button"
            onClick={() => setFilterSide('ELIGIBLE')}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-bold transition-all',
              filterSide === 'ELIGIBLE'
                ? 'bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 shadow-sm'
                : 'text-emerald-400/80 hover:text-emerald-300',
            )}
          >
            QUALIFIED ({eligibleCount})
          </button>
          <button
            type="button"
            onClick={() => setFilterSide('PE')}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-bold transition-all',
              filterSide === 'PE'
                ? 'bg-zinc-800 text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200',
            )}
          >
            PUTS (PE)
          </button>
          <button
            type="button"
            onClick={() => setFilterSide('CE')}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-bold transition-all',
              filterSide === 'CE'
                ? 'bg-zinc-800 text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200',
            )}
          >
            CALLS (CE)
          </button>
        </div>
      </div>

      {/* Grid / Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-zinc-800 bg-zinc-900/80 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
            <tr>
              <th className="px-4 py-2.5">Strike</th>
              <th className="px-3 py-2.5">Option</th>
              <th className="px-3 py-2.5 text-right">LTP</th>
              <th className="px-3 py-2.5 text-right">Supertrend</th>
              <th className="px-3 py-2.5 text-right">VWAP</th>
              <th className="px-3 py-2.5 text-right">EMA 20</th>
              <th className="px-3 py-2.5 text-center">Breakdown Condition</th>
              <th className="px-3 py-2.5 text-right">Depth (% Below)</th>
              <th className="px-3 py-2.5 text-center">Rank Score</th>
              <th className="px-4 py-2.5">Eligibility / Status</th>
              <th className="px-4 py-2.5 text-center">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60 font-medium text-zinc-300">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={11} className="p-8 text-center text-xs text-zinc-500">
                  No contracts match the current filter.
                </td>
              </tr>
            ) : (
              filtered.map((cand, idx) => {
                const isTopPick = cand.isEligible && idx === 0;
                const state = cand.state;
                const ind = state.indicators;

                return (
                  <tr
                    key={cand.contractKey}
                    className={cn(
                      'transition-colors hover:bg-zinc-900/40',
                      isTopPick && 'bg-emerald-950/20 border-l-2 border-l-emerald-500',
                    )}
                  >
                    {/* Strike */}
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-white text-sm">{cand.strike}</span>
                        <span className="text-[10px] text-zinc-500">
                          {cand.distFromAtmSteps === 0
                            ? 'ATM'
                            : cand.strike > atm
                            ? `+${cand.distFromAtmSteps} OTM`
                            : `-${cand.distFromAtmSteps} OTM`}
                        </span>
                      </div>
                    </td>

                    {/* Option Type & OI Buildup */}
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[10px] font-extrabold',
                            cand.option === 'PE'
                              ? 'bg-emerald-500/20 text-emerald-400'
                              : 'bg-red-500/20 text-red-400',
                          )}
                        >
                          {cand.option}
                        </span>
                        {cand.buildup && (
                          <span
                            className={cn(
                              'rounded px-1 py-0.2 text-[9px] font-mono font-bold uppercase',
                              cand.oiView === 'confirm'
                                ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
                                : cand.oiView === 'conflict'
                                ? 'bg-red-500/10 text-red-300 border border-red-500/30'
                                : 'bg-zinc-800 text-zinc-400',
                            )}
                            title={
                              cand.oiView === 'confirm'
                                ? `${cand.buildup}: Positioning confirms breakdown`
                                : cand.oiView === 'conflict'
                                ? `${cand.buildup}: Long buildup conflicts with breakdown`
                                : cand.buildup
                            }
                          >
                            {cand.buildup}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* LTP */}
                    <td className="px-3 py-2.5 text-right font-mono font-bold text-white tabular-nums whitespace-nowrap">
                      ₹{cand.ltp > 0 ? cand.ltp.toFixed(1) : '—'}
                    </td>

                    {/* Supertrend */}
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums whitespace-nowrap text-zinc-400">
                      {ind.stLine ? (
                        <span className={state.belowSt ? 'text-emerald-400' : 'text-zinc-500'}>
                          ₹{ind.stLine.toFixed(1)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>

                    {/* VWAP */}
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums whitespace-nowrap text-zinc-400">
                      {ind.vwap ? (
                        <span className={state.belowVwap ? 'text-emerald-400' : 'text-zinc-500'}>
                          ₹{ind.vwap.toFixed(1)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>

                    {/* EMA 20 */}
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums whitespace-nowrap text-zinc-400">
                      {ind.ema ? (
                        <span className={state.belowEma ? 'text-emerald-400' : 'text-zinc-500'}>
                          ₹{ind.ema.toFixed(1)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>

                    {/* Breakdown Condition */}
                    <td className="px-3 py-2.5 text-center whitespace-nowrap">
                      {state.isFreshBreakdown ? (
                        <span className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-extrabold text-emerald-300 border border-emerald-500/40">
                          <Sparkles className="h-3 w-3" /> FRESH (1 bar)
                        </span>
                      ) : state.isBreakdown ? (
                        <span className="rounded bg-teal-500/10 px-2 py-0.5 text-[10px] font-bold text-teal-400 border border-teal-500/20">
                          {state.barsSinceBreakdown} bars ago
                        </span>
                      ) : (
                        <span className="rounded bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-500">
                          Above Indicator(s)
                        </span>
                      )}
                    </td>

                    {/* Depth */}
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums whitespace-nowrap">
                      {state.avgPctBelow != null && state.avgPctBelow > 0 ? (
                        <span className="text-emerald-400 font-bold">-{state.avgPctBelow.toFixed(1)}%</span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>

                    {/* Rank Score */}
                    <td className="px-3 py-2.5 text-center whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <span
                          className={cn(
                            'font-mono font-bold text-xs',
                            cand.rankScore >= 70
                              ? 'text-emerald-400'
                              : cand.rankScore >= 40
                              ? 'text-amber-400'
                              : 'text-zinc-500',
                          )}
                        >
                          {cand.rankScore}
                        </span>
                        <div className="w-10 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                          <div
                            className={cn(
                              'h-full rounded-full',
                              cand.rankScore >= 70
                                ? 'bg-emerald-500'
                                : cand.rankScore >= 40
                                ? 'bg-amber-500'
                                : 'bg-zinc-600',
                            )}
                            style={{ width: `${cand.rankScore}%` }}
                          />
                        </div>
                      </div>
                    </td>

                    {/* Eligibility / Status */}
                    <td className="px-4 py-2.5 text-xs whitespace-nowrap">
                      {isTopPick ? (
                        <span className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-extrabold text-emerald-300 border border-emerald-500/40 animate-pulse">
                          TOP CANDIDATE
                        </span>
                      ) : cand.isEligible ? (
                        <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                          <Check className="h-3 w-3" /> QUALIFIED
                        </span>
                      ) : (
                        <span className="text-[10px] text-zinc-500 truncate max-w-[200px] inline-block" title={cand.blockReason}>
                          {cand.blockReason}
                        </span>
                      )}
                    </td>

                    {/* Action button */}
                    <td className="px-4 py-2.5 text-center whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => onManualShort(cand)}
                        className={cn(
                          'inline-flex items-center gap-1 rounded px-2.5 py-1 text-[10px] font-bold transition',
                          cand.isEligible
                            ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-600/30'
                            : 'bg-zinc-800 text-zinc-400 border border-zinc-700 hover:text-zinc-200 hover:bg-zinc-700',
                        )}
                        title="Short this option strike immediately"
                      >
                        <ArrowDown className="h-3 w-3" />
                        <span>SHORT</span>
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
