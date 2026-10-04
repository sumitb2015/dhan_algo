'use client';

import React, { useMemo } from 'react';
import { Target, Zap, ShieldCheck, AlertTriangle, ArrowRight, Sparkles } from 'lucide-react';
import {
  recommendDiagonalStrikes,
  type CandidateStrike,
  type DiagonalAdvisorRecommendation,
} from '@/lib/diagonalStrikeAdvisor';

interface DiagonalStrikeAdvisorCardProps {
  spot: number;
  lotSize: number;
  frontExpiry: string;
  frontDte: number;
  farExpiry?: string;
  farDte?: number;
  allStrikes: number[];
  listedExpiries?: string[];
  autoPremium: (strike: number, option: 'CE' | 'PE', expiry?: string) => number;
  chainOc?: Record<string, any>;
  atmIv?: number;
  currentShortLeg?: { strike: number; lots: number };
  currentLongLeg?: { strike: number; lots: number };
  onApplyCandidate: (candidate: CandidateStrike) => void;
}

export default function DiagonalStrikeAdvisorCard({
  spot,
  lotSize,
  frontExpiry,
  frontDte,
  farExpiry,
  farDte,
  allStrikes,
  listedExpiries,
  autoPremium,
  chainOc,
  atmIv,
  currentShortLeg,
  currentLongLeg,
  onApplyCandidate,
}: DiagonalStrikeAdvisorCardProps) {
  const quoteData = useMemo(() => {
    const q: Record<number, { ceLtp?: number; ceIv?: number }> = {};
    for (const s of allStrikes) {
      const price = autoPremium(s, 'CE', frontExpiry);
      const ivRaw = chainOc?.[s]?.ce?.implied_volatility ?? chainOc?.[s]?.ce?.iv ?? chainOc?.[String(s)]?.ce?.implied_volatility;
      const iv = typeof ivRaw === 'number' && ivRaw > 0 ? (ivRaw > 1 ? ivRaw / 100 : ivRaw) : (atmIv ? atmIv / 100 : 0.14);
      q[s] = { ceLtp: price, ceIv: iv };
    }
    return q;
  }, [allStrikes, autoPremium, chainOc, frontExpiry, atmIv]);

  const advisorData: DiagonalAdvisorRecommendation = useMemo(() => {
    const longIvRaw = currentLongLeg ? (chainOc?.[currentLongLeg.strike]?.ce?.implied_volatility ?? chainOc?.[String(currentLongLeg.strike)]?.ce?.implied_volatility) : undefined;
    const longIv = typeof longIvRaw === 'number' && longIvRaw > 0 ? (longIvRaw > 1 ? longIvRaw / 100 : longIvRaw) : (atmIv ? atmIv / 100 : 0.14);

    const longLegParam = currentLongLeg ? {
      strike: currentLongLeg.strike,
      expiry: farExpiry || '',
      dte: farDte ?? 85,
      lots: currentLongLeg.lots,
      iv: longIv,
    } : undefined;

    return recommendDiagonalStrikes({
      spot,
      lotSize,
      frontExpiry,
      frontDte: Math.max(1, frontDte),
      strikes: allStrikes,
      quotes: quoteData,
      longLeg: longLegParam,
      listedExpiries,
    });
  }, [spot, lotSize, frontExpiry, frontDte, farExpiry, farDte, allStrikes, listedExpiries, quoteData, currentLongLeg, chainOc, atmIv]);

  const candidates = advisorData.candidates.slice(0, 5);
  const best = advisorData.bestCandidate;

  return (
    <div className="rounded-lg border border-indigo-500/30 bg-indigo-950/10 p-3.5 flex flex-col gap-3">
      {/* Header Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-indigo-500/20 text-indigo-400">
            <Zap className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-white">
                Diagonal Strike & Dynamic Sizing Advisor
              </span>
              <span className="rounded bg-indigo-500/20 px-1.5 py-0.2 font-mono text-[9px] font-bold text-indigo-300 border border-indigo-500/30">
                Score = Theta / |Gamma|
              </span>
            </div>
            <p className="text-[11px] text-zinc-400">
              Evaluates 25–45 DTE short call strikes to maximize daily decay while clamping gamma risk.
            </p>
          </div>
        </div>

        {/* Long Leg Context Pill */}
        <div className="flex items-center gap-2 text-xs font-mono bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1">
          <span className="text-zinc-500">Long Anchor:</span>
          <span className="text-emerald-400 font-bold">{advisorData.longLeg.strike} CE</span>
          <span className="text-zinc-500">({advisorData.longLeg.lots}L · Δ {advisorData.longLeg.delta})</span>
        </div>
      </div>

      {/* Best Pick Highlight Banner */}
      {best && (
        <div className="rounded border border-emerald-500/30 bg-emerald-950/20 p-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-emerald-400 shrink-0" />
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-white">Recommended Optimal Strike:</span>
                <span className="font-mono text-sm font-bold text-emerald-400">{best.strike} CE</span>
                <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-emerald-300">
                  {best.recommendedLots} Lots ({best.recommendedLots * lotSize} Qty)
                </span>
                <span className="font-mono text-[11px] text-zinc-400">
                  LTP: ₹{best.ltp > 0 ? best.ltp.toFixed(2) : '—'} · Δ {best.delta.toFixed(2)}
                </span>
              </div>
              <p className="text-[10px] text-zinc-300 mt-0.5">
                Efficiency Score: <strong className="text-emerald-300">{best.score}</strong> · Resulting Net Δ: <strong className="text-white">+{best.resultingNetDeltaShares}</strong> · Net Γ: <strong className="text-zinc-200">{best.resultingNetGamma}</strong> (Safe)
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onApplyCandidate(best)}
            className="flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-bold text-oncolor hover:bg-emerald-500 transition-colors shadow-sm"
          >
            <span>Apply Optimal ({best.strike} CE)</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Candidates Ranked Table */}
      <div className="overflow-x-auto rounded border border-zinc-800">
        <table className="w-full text-left font-mono text-xs">
          <thead className="bg-zinc-800 text-white font-bold text-xs">
            <tr>
              <th className="px-2.5 py-1.5">STRIKE</th>
              <th className="px-2 py-1.5">LTP</th>
              <th className="px-2 py-1.5">DELTA (Δ)</th>
              <th className="px-2 py-1.5">GAMMA (Γ)</th>
              <th className="px-2 py-1.5">EFFICIENCY SCORE</th>
              <th className="px-2 py-1.5">REC. SIZING</th>
              <th className="px-2 py-1.5">RESULTING NET Δ / Γ</th>
              <th className="px-2.5 py-1.5 text-right">ACTION</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60 bg-zinc-950">
            {candidates.map(c => {
              const isSelected = currentShortLeg?.strike === c.strike;
              const isTopPick = best?.strike === c.strike;

              return (
                <tr
                  key={c.strike}
                  className={`hover:bg-zinc-900/60 transition-colors ${
                    isSelected ? 'bg-indigo-500/10' : isTopPick ? 'bg-emerald-500/5' : ''
                  }`}
                >
                  <td className="px-2.5 py-2 font-bold text-white flex items-center gap-1.5">
                    <span>{c.strike} CE</span>
                    {isTopPick && (
                      <span className="rounded bg-emerald-500/20 px-1 py-0.2 text-[9px] font-bold text-emerald-300">
                        BEST
                      </span>
                    )}
                    {isSelected && (
                      <span className="rounded bg-indigo-500/20 px-1 py-0.2 text-[9px] font-bold text-indigo-300">
                        ACTIVE
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-zinc-300">
                    {c.ltp > 0 ? `₹${c.ltp.toFixed(2)}` : '—'}
                  </td>
                  <td className="px-2 py-2 font-bold text-amber-400">
                    {c.delta.toFixed(3)}
                  </td>
                  <td className="px-2 py-2 text-zinc-400 text-[11px]">
                    {c.gamma.toFixed(6)}
                  </td>
                  <td className="px-2 py-2">
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-bold text-indigo-300">
                      {c.score}
                    </span>
                  </td>
                  <td className="px-2 py-2 font-bold text-white">
                    {c.recommendedLots} Lots ({c.recommendedLots * lotSize} Qty)
                  </td>
                  <td className="px-2 py-2 text-[11px]">
                    <span className="text-emerald-400 font-bold">+{c.resultingNetDeltaShares}Δ</span>
                    <span className="text-zinc-500 mx-1">·</span>
                    <span className={c.resultingNetGamma < -0.15 ? 'text-red-400' : 'text-zinc-300'}>
                      {c.resultingNetGamma}Γ
                    </span>
                  </td>
                  <td className="px-2.5 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => onApplyCandidate(c)}
                      disabled={isSelected}
                      className={`rounded px-2.5 py-1 text-[11px] font-bold transition-colors ${
                        isSelected
                          ? 'border border-zinc-700 bg-zinc-800 text-zinc-500 cursor-default'
                          : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700 hover:text-white border border-zinc-700'
                      }`}
                    >
                      {isSelected ? 'Applied' : 'Select'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {advisorData.summary.warnings.length > 0 && (
        <div className="flex items-start gap-1.5 text-[11px] text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{advisorData.summary.warnings.join(' ')}</span>
        </div>
      )}

      {/* Rules & Risk Guard Footer */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] text-zinc-400 pt-1">
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
          <span>
            Target Net Delta: <strong className="text-zinc-200">+{advisorData.summary.targetNetDelta} units</strong> · Max Short Ratio: <strong className="text-zinc-200">1.25x</strong> · Gamma Floor: <strong className="text-zinc-200">&gt; -0.15</strong>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
          <span>Roll Triggers: Short Delta &ge; 0.35, DTE &le; 14, or Net Gamma &lt; -0.20</span>
        </div>
      </div>
    </div>
  );
}
