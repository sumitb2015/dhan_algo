'use client';

import React, { useMemo } from 'react';
import {
  STRATEGY_CATEGORIES, type StrategyCategory, type StrategyTemplate,
  type PayoffLeg, type OptionType, computePayoff, nearestStrike,
} from '@/lib/basketStrategies';
import { useChartChrome } from '@/lib/chartTheme';

const CATEGORIES = Object.keys(STRATEGY_CATEGORIES) as StrategyCategory[];

// Strict Bloomberg skill: accent text colors stop at -400, never -500+
const CATEGORY_STYLES: Record<StrategyCategory, { active: string; dot: string }> = {
  Bullish:       { active: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400', dot: 'bg-emerald-400' },
  Bearish:       { active: 'border-red-500/40 bg-red-500/15 text-red-400',       dot: 'bg-red-400' },
  'Range Bound': { active: 'border-amber-500/40 bg-amber-500/15 text-amber-400',     dot: 'bg-amber-400' },
  'Big Move':    { active: 'border-sky-500/40 bg-sky-500/15 text-sky-400',         dot: 'bg-sky-400' },
  'Ratio Spreads': { active: 'border-violet-500/40 bg-violet-500/15 text-violet-400', dot: 'bg-violet-400' },
  Lizard:        { active: 'border-lime-500/40 bg-lime-500/15 text-lime-400',       dot: 'bg-lime-400' },
  Calendar:      { active: 'border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-400', dot: 'bg-fuchsia-400' },
};

interface LegLiveInfo {
  side: 'B' | 'S';
  option: OptionType;
  strike: number;
  ratio: number;
  ltp: number;
  expiryRole?: 'front' | 'far';
}

function resolveTemplateLegs(
  template: StrategyTemplate,
  atmStrike: number | null | undefined,
  step: number | undefined,
  allStrikes: number[] | undefined,
  autoPremium?: (strike: number, option: OptionType, legExpiry?: string) => number,
  frontExpiry?: string,
  farExpiry?: string,
): { legs: LegLiveInfo[]; allPriced: boolean; netPremium: number } | null {
  if (atmStrike == null || !allStrikes || !allStrikes.length || !step) return null;

  const legs: LegLiveInfo[] = template.legs.map(l => {
    const target = atmStrike + l.offset * step;
    const strike = nearestStrike(allStrikes, target) ?? target;
    const legExpiry = l.expiryRole === 'far' ? (farExpiry || frontExpiry) : frontExpiry;
    const ltp = autoPremium ? autoPremium(strike, l.option, legExpiry) : 0;
    return {
      side: l.side,
      option: l.option,
      strike,
      ratio: l.ratio,
      ltp,
      expiryRole: l.expiryRole,
    };
  });

  const allPriced = legs.every(l => l.ltp > 0);
  const netPremium = legs.reduce((sum, l) => sum + (l.side === 'S' ? l.ltp : -l.ltp) * l.ratio, 0);
  return { legs, allPriced, netPremium };
}

/** Payoff-shape glyph for a strategy card — uses live quotes when available,
 *  falling back to a schematic curve if quotes are not yet loaded. */
function StrategyGlyph({
  template,
  legsInfo,
}: {
  template: StrategyTemplate;
  legsInfo: { legs: LegLiveInfo[]; allPriced: boolean; netPremium: number } | null;
}) {
  const chrome = useChartChrome();
  const path = useMemo(() => {
    // If live prices are available and not mixed expiry, compute payoff on real strikes
    const hasMixed = template.legs.some(l => l.expiryRole === 'far');
    if (legsInfo && legsInfo.allPriced && !hasMixed) {
      const payoffLegs: PayoffLeg[] = legsInfo.legs.map(l => ({
        side: l.side,
        option: l.option,
        strike: l.strike,
        premium: l.ltp,
        qty: l.ratio,
      }));
      const strikes = payoffLegs.map(l => l.strike);
      const minS = Math.min(...strikes);
      const maxS = Math.max(...strikes);
      const spanS = maxS - minS || 200;
      const lo = minS - spanS * 0.6;
      const hi = maxS + spanS * 0.6;
      const { points } = computePayoff(payoffLegs, lo, hi, 48);
      const ys = points.map(p => p.y);
      const yLo = Math.min(...ys), yHi = Math.max(...ys);
      const span = yHi - yLo || 1;
      return points.map((p, i) => {
        const x = (i / (points.length - 1)) * 72 + 4;
        const y = 30 - ((p.y - yLo) / span) * 24;
        return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join('');
    }

    // Schematic fallback
    const fallbackLegs: PayoffLeg[] = template.legs.map(l => ({
      side: l.side, option: l.option, strike: 100 + l.offset * 5, premium: 3 * l.ratio, qty: l.ratio,
    }));
    const { points } = computePayoff(fallbackLegs, 60, 140, 48);
    const ys = points.map(p => p.y);
    const yLo = Math.min(...ys), yHi = Math.max(...ys);
    const span = yHi - yLo || 1;
    return points.map((p, i) => {
      const x = (i / (points.length - 1)) * 72 + 4;
      const y = 30 - ((p.y - yLo) / span) * 24;
      return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join('');
  }, [template, legsInfo]);

  return (
    <svg viewBox="0 0 80 36" className="w-full h-9" aria-label="Strategy payoff shape" role="img">
      <line x1={4} x2={76} y1={18} y2={18} stroke={chrome.baseline} strokeWidth={1} strokeDasharray="2 2" />
      <path d={path} fill="none" stroke="#34d399" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function formatLegSummary(
  template: StrategyTemplate,
  legsInfo: { legs: LegLiveInfo[]; allPriced: boolean; netPremium: number } | null,
): string {
  if (legsInfo) {
    return legsInfo.legs.map(leg => {
      const priceStr = leg.ltp > 0 ? ` ₹${leg.ltp.toFixed(1)}` : '';
      const farStr = leg.expiryRole === 'far' ? ' FAR' : '';
      return `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}${priceStr}${farStr}`;
    }).join(' · ');
  }

  return template.legs.map(leg => {
    const relativeStrike = leg.offset === 0 ? 'ATM' : `${leg.offset > 0 ? '+' : ''}${leg.offset}`;
    const expiry = leg.expiryRole === 'far' ? ' FAR' : '';
    return `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.ratio} ${relativeStrike} ${leg.option}${expiry}`;
  }).join(' · ');
}

interface StrategyCardGridProps {
  category: StrategyCategory;
  onCategoryChange: (c: StrategyCategory) => void;
  selectedKey: string | null;
  onSelectTemplate: (tpl: StrategyTemplate) => void;
  disabled: boolean;
  atmStrike?: number | null;
  step?: number;
  allStrikes?: number[];
  autoPremium?: (strike: number, option: OptionType, legExpiry?: string) => number;
  frontExpiry?: string;
  farExpiry?: string;
}

export default function StrategyCardGrid({
  category, onCategoryChange, selectedKey, onSelectTemplate, disabled,
  atmStrike, step, allStrikes, autoPremium, frontExpiry, farExpiry,
}: StrategyCardGridProps) {
  return (
    <div className="flex flex-col gap-2.5">
      {/* Category Pills Bar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-lg border border-zinc-800/80 bg-zinc-950/80 shadow-inner">
          {CATEGORIES.map(cat => {
            const isCatActive = category === cat;
            const style = CATEGORY_STYLES[cat];
            return (
              <button
                key={cat}
                type="button"
                onClick={() => onCategoryChange(cat)}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-mono font-bold uppercase tracking-wider rounded-md border transition-all ${
                  isCatActive
                    ? `${style.active} shadow-sm`
                    : 'border-transparent bg-transparent text-zinc-400 hover:text-zinc-200 hover:border-zinc-800 hover:bg-zinc-900/50'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${isCatActive ? style.dot : 'bg-zinc-600'}`} />
                {cat}
                <span className="text-[9px] opacity-70 font-mono">({STRATEGY_CATEGORIES[cat].length})</span>
              </button>
            );
          })}
        </div>

        <div className="font-mono text-[10px] text-zinc-400 hidden sm:flex items-center gap-2">
          <span>ATM: <strong className="text-amber-400">{atmStrike ?? '—'}</strong></span>
          <span className="text-zinc-700">|</span>
          <span>STEP: <strong className="text-zinc-300">{step ?? '—'}</strong></span>
        </div>
      </div>

      {/* Horizontal Scroll Strategy Cards */}
      <div className="flex gap-2.5 overflow-x-auto pb-1.5 min-w-0 scrollbar-thin">
        {STRATEGY_CATEGORIES[category].map(tpl => {
          const legsInfo = resolveTemplateLegs(
            tpl, atmStrike, step, allStrikes, autoPremium, frontExpiry, farExpiry,
          );
          const composition = formatLegSummary(tpl, legsInfo);
          const isSelected = selectedKey === tpl.key;

          return (
            <button
              key={tpl.key}
              type="button"
              onClick={() => onSelectTemplate(tpl)}
              aria-label={`${tpl.name}: ${composition}`}
              title={composition}
              disabled={disabled}
              className={`flex-none w-56 p-3 rounded-xl border transition-all text-left disabled:opacity-40 flex flex-col justify-between group ${
                isSelected
                  ? 'border-amber-500/60 bg-amber-500/10 shadow-sm shadow-amber-500/10 ring-1 ring-amber-500/30'
                  : 'border-zinc-800 bg-zinc-950/80 hover:border-zinc-700 hover:bg-zinc-900/60'
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-1.5 mb-1.5">
                  <p className="text-xs font-bold text-zinc-200 font-mono tracking-tight leading-tight truncate group-hover:text-amber-300 transition-colors">
                    {tpl.name}
                  </p>
                  {legsInfo && legsInfo.allPriced ? (
                    <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border whitespace-nowrap shrink-0 tabular-nums ${
                      legsInfo.netPremium >= 0
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                        : 'bg-red-500/10 text-red-400 border-red-500/30'
                    }`}>
                      {legsInfo.netPremium >= 0 ? 'CR' : 'DB'} ₹{Math.abs(legsInfo.netPremium).toFixed(1)}
                    </span>
                  ) : (
                    <span className="text-[9px] font-mono text-zinc-500 border border-zinc-800 px-1 py-0.5 rounded">
                      {tpl.legs.length}L
                    </span>
                  )}
                </div>

                <div className="bg-zinc-900/40 rounded-lg p-1 border border-zinc-800/40 my-1">
                  <StrategyGlyph template={tpl} legsInfo={legsInfo} />
                </div>
              </div>

              <div className="mt-2 pt-2 border-t border-zinc-800/60">
                <p className="text-[10px] leading-snug text-zinc-400 font-mono line-clamp-2">
                  {composition}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
