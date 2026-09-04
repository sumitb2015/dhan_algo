'use client';

import React, { useMemo } from 'react';
import {
  STRATEGY_CATEGORIES, type StrategyCategory, type StrategyTemplate,
  type PayoffLeg, type OptionType, computePayoff, nearestStrike,
} from '@/lib/basketStrategies';
import { useChartChrome } from '@/lib/chartTheme';

const CATEGORIES = Object.keys(STRATEGY_CATEGORIES) as StrategyCategory[];

const CATEGORY_COLORS: Record<StrategyCategory, string> = {
  Bullish:       'bg-emerald-500/10 text-emerald-300 border-emerald-500/40',
  Bearish:       'bg-rose-500/10 text-rose-300 border-rose-500/40',
  'Range Bound': 'bg-amber-500/10 text-amber-300 border-amber-500/40',
  'Big Move':    'bg-sky-500/10 text-sky-300 border-sky-500/40',
  'Ratio Spreads': 'bg-violet-500/10 text-violet-300 border-violet-500/40',
  Lizard:          'bg-lime-500/10 text-lime-300 border-lime-500/40',
  Calendar:        'bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-500/40',
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
    <svg viewBox="0 0 80 36" className="w-full h-10" aria-label="Strategy payoff shape" role="img">
      <line x1={4} x2={76} y1={18} y2={18} stroke={chrome.baseline} strokeWidth={1} strokeDasharray="2 2" />
      <path d={path} fill="none" stroke="#34d399" strokeWidth={1.75} />
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
      const farStr = leg.expiryRole === 'far' ? ' far' : '';
      return `${leg.side === 'B' ? 'Buy' : 'Sell'} ${leg.strike} ${leg.option}${priceStr}${farStr}`;
    }).join(' · ');
  }

  return template.legs.map(leg => {
    const relativeStrike = leg.offset === 0 ? 'ATM' : `${leg.offset > 0 ? '+' : ''}${leg.offset}`;
    const expiry = leg.expiryRole === 'far' ? ' far' : '';
    return `${leg.side === 'B' ? 'Buy' : 'Sell'} ${leg.ratio} ${relativeStrike} ${leg.option}${expiry}`;
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
    <div className="flex items-start gap-3 flex-wrap">
      <div className="flex flex-col gap-1.5 flex-none pt-0.5">
        {CATEGORIES.map(cat => (
          <button key={cat} onClick={() => onCategoryChange(cat)}
            className={`px-4 py-1.5 text-xs font-bold rounded-lg border text-left transition-all ${
              category === cat ? CATEGORY_COLORS[cat] : 'border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:text-zinc-100'
            }`}>
            {cat}
          </button>
        ))}
      </div>

      <div className="flex-1 flex gap-2.5 overflow-x-auto pb-1 min-w-0">
        {STRATEGY_CATEGORIES[category].map(tpl => {
          const legsInfo = resolveTemplateLegs(
            tpl, atmStrike, step, allStrikes, autoPremium, frontExpiry, farExpiry,
          );
          const composition = formatLegSummary(tpl, legsInfo);

          return (
            <button key={tpl.key} onClick={() => onSelectTemplate(tpl)} aria-label={`${tpl.name}: ${composition}`}
              title={composition}
              disabled={disabled}
              className={`flex-none w-52 p-3 rounded-xl border transition-all text-left disabled:opacity-40 flex flex-col justify-between ${
                selectedKey === tpl.key
                  ? 'border-emerald-500/50 bg-emerald-500/5'
                  : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-600'
              }`}>
              <div>
                <StrategyGlyph template={tpl} legsInfo={legsInfo} />
                <div className="flex items-center justify-between gap-1 mt-1">
                  <p className="text-xs font-bold text-zinc-200 leading-tight truncate">{tpl.name}</p>
                  {legsInfo && legsInfo.allPriced && (
                    <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border whitespace-nowrap shrink-0 ${
                      legsInfo.netPremium >= 0
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                        : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                    }`}>
                      {legsInfo.netPremium >= 0 ? 'Cr' : 'Db'} ₹{Math.abs(legsInfo.netPremium).toFixed(1)}
                    </span>
                  )}
                </div>
              </div>
              <p className="text-[10px] leading-snug text-zinc-400 mt-2 line-clamp-2 font-mono">{composition}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
