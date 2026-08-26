'use client';

import React, { useState } from 'react';
import type { LevelConfluenceAnalysis } from '@/app/api/level-chart/route';

interface Props {
  confluence?: LevelConfluenceAnalysis | null;
  symbol: string;
}

export default function LevelScoreCard({ confluence, symbol }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!confluence) return null;

  const {
    totalScore,
    regime,
    regimeLabel,
    bias,
    actionText,
    nearestSupport,
    nearestResistance,
    suggestedPeStrike,
    suggestedCeStrike,
    suggestedPeHedge,
    suggestedCeHedge,
    atr,
    distSupportAtr,
    distResistAtr,
    breakdown,
  } = confluence;

  // Theme color mapping based on regime
  const isBullish = regime === 'STRONG_BULLISH' || regime === 'BULLISH';
  const isBearish = regime === 'STRONG_BEARISH' || regime === 'BEARISH';
  const isNeutral = regime === 'NEUTRAL_RANGE';

  const regimeBadgeColor = isBullish
    ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
    : isBearish
    ? 'bg-rose-500/15 border-rose-500/30 text-rose-400'
    : 'bg-amber-500/15 border-amber-500/30 text-amber-400';

  const scoreTextColor = isBullish
    ? 'text-emerald-400'
    : isBearish
    ? 'text-rose-400'
    : 'text-amber-400';

  const strokeColor = isBullish
    ? '#10b981'
    : isBearish
    ? '#f43f5e'
    : '#f59e0b';

  // SVG Gauge calculations (radius = 18, circumference = 2 * PI * 18 ≈ 113.1)
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (totalScore / 100) * circumference;

  return (
    <div className="mx-6 my-2 rounded-xl border border-zinc-800 bg-zinc-900/90 shadow-lg backdrop-blur overflow-hidden transition-all duration-200">
      {/* Top Banner Summary */}
      <div className="flex items-center justify-between gap-4 px-4 py-2.5 flex-wrap">
        {/* Left: Score Meter & Regime */}
        <div className="flex items-center gap-3">
          {/* Circular SVG Gauge */}
          <div className="relative flex items-center justify-center w-11 h-11 shrink-0">
            <svg className="w-11 h-11 -rotate-90" viewBox="0 0 44 44">
              <circle
                cx="22"
                cy="22"
                r={radius}
                className="stroke-zinc-800"
                strokeWidth="3.5"
                fill="none"
              />
              <circle
                cx="22"
                cy="22"
                r={radius}
                stroke={strokeColor}
                strokeWidth="3.5"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
                fill="none"
                style={{ transition: 'stroke-dashoffset 0.5s ease-in-out' }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className={`font-mono text-xs font-black leading-none ${scoreTextColor}`}>
                {Math.round(totalScore)}
              </span>
              <span className="text-[8px] text-zinc-500 font-bold leading-none scale-90">/100</span>
            </div>
          </div>

          {/* Regime Badge & Strategy Action */}
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wider ${regimeBadgeColor}`}>
                {regimeLabel}
              </span>
              <span className="text-xs font-semibold text-zinc-200">
                {actionText}
              </span>
            </div>
            <p className="text-[11px] text-zinc-400 flex items-center gap-2">
              <span>Support: <strong className="font-mono text-zinc-200">{nearestSupport}</strong> {distSupportAtr !== undefined && `(${distSupportAtr}x ATR)`}</span>
              <span className="text-zinc-600">|</span>
              <span>Resist: <strong className="font-mono text-zinc-200">{nearestResistance}</strong> {distResistAtr !== undefined && `(${distResistAtr}x ATR)`}</span>
              <span className="text-zinc-600">|</span>
              <span>ATR: <strong className="font-mono text-zinc-200">{atr}</strong></span>
            </p>
          </div>
        </div>

        {/* Right: Suggested Strikes & Toggle Details */}
        <div className="flex items-center gap-3">
          <div className="hidden md:flex items-center gap-2">
            {/* Bullish: Sell PE + Buy PE Hedge */}
            {bias === 'PE_SELL' && (
              <>
                {suggestedPeStrike && (
                  <div className="px-2.5 py-1 rounded-lg border border-emerald-500/20 bg-emerald-500/5 text-right">
                    <div className="text-[9px] uppercase font-bold text-emerald-400">Sell PE (Short)</div>
                    <div className="font-mono text-xs font-bold text-emerald-300">{suggestedPeStrike} PE</div>
                  </div>
                )}
                {suggestedPeHedge && (
                  <div className="px-2.5 py-1 rounded-lg border border-sky-500/20 bg-sky-500/5 text-right">
                    <div className="text-[9px] uppercase font-bold text-sky-400">Buy PE (Hedge)</div>
                    <div className="font-mono text-xs font-bold text-sky-300">{suggestedPeHedge} PE</div>
                  </div>
                )}
              </>
            )}

            {/* Bearish: Sell CE + Buy CE Hedge */}
            {bias === 'CE_SELL' && (
              <>
                {suggestedCeStrike && (
                  <div className="px-2.5 py-1 rounded-lg border border-rose-500/20 bg-rose-500/5 text-right">
                    <div className="text-[9px] uppercase font-bold text-rose-400">Sell CE (Short)</div>
                    <div className="font-mono text-xs font-bold text-rose-300">{suggestedCeStrike} CE</div>
                  </div>
                )}
                {suggestedCeHedge && (
                  <div className="px-2.5 py-1 rounded-lg border border-sky-500/20 bg-sky-500/5 text-right">
                    <div className="text-[9px] uppercase font-bold text-sky-400">Buy CE (Hedge)</div>
                    <div className="font-mono text-xs font-bold text-sky-300">{suggestedCeHedge} CE</div>
                  </div>
                )}
              </>
            )}

            {/* Neutral / Range-Bound: Strangle / Iron Condor (Both Short Legs) */}
            {bias === 'STRANGLE' && (
              <>
                {suggestedPeStrike && (
                  <div className="px-2.5 py-1 rounded-lg border border-emerald-500/20 bg-emerald-500/5 text-right">
                    <div className="text-[9px] uppercase font-bold text-emerald-400">Sell PE</div>
                    <div className="font-mono text-xs font-bold text-emerald-300">{suggestedPeStrike} PE</div>
                  </div>
                )}
                {suggestedCeStrike && (
                  <div className="px-2.5 py-1 rounded-lg border border-rose-500/20 bg-rose-500/5 text-right">
                    <div className="text-[9px] uppercase font-bold text-rose-400">Sell CE</div>
                    <div className="font-mono text-xs font-bold text-rose-300">{suggestedCeStrike} CE</div>
                  </div>
                )}
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-300 hover:text-white text-xs font-medium transition-colors"
          >
            <span>{expanded ? 'Hide Confluence' : 'View Confluence'}</span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className={`transform transition-transform ${expanded ? 'rotate-180' : ''}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      </div>

      {/* Expandable Breakdown Drawer */}
      {expanded && breakdown && (
        <div className="border-t border-zinc-800/80 bg-zinc-950/60 p-3.5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
          {Object.entries(breakdown).map(([key, item]) => {
            const pct = item.max > 0 ? Math.min(100, Math.max(0, (item.score / item.max) * 100)) : 0;
            const barColor = pct >= 70 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-rose-500';
            const badgeBg = pct >= 70 ? 'text-emerald-400' : pct >= 40 ? 'text-amber-400' : 'text-rose-400';

            return (
              <div key={key} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5 flex flex-col justify-between gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{item.label}</span>
                  <span className={`text-xs font-mono font-bold ${badgeBg}`}>
                    {item.score} <span className="text-zinc-500 text-[10px]">/{item.max}</span>
                  </span>
                </div>

                {/* Progress Bar */}
                <div className="w-full h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                  <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
                </div>

                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-semibold text-zinc-300">{item.status}</span>
                  <p className="text-[9px] text-zinc-500 truncate" title={item.detail}>
                    {item.detail}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
