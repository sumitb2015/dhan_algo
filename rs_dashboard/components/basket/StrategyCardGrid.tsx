'use client';

import React, { useMemo } from 'react';
import {
  STRATEGY_CATEGORIES, type StrategyCategory, type StrategyTemplate,
  type PayoffLeg, computePayoff,
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

/** Tiny payoff-shape glyph for a strategy card, using placeholder strikes/premiums
 *  purely to visualize the SHAPE of the payoff (bullish/bearish/wings/etc.) — not
 *  a real quote. */
function StrategyGlyph({ template }: { template: StrategyTemplate }) {
  const chrome = useChartChrome();
  const path = useMemo(() => {
    const legs: PayoffLeg[] = template.legs.map(l => ({
      side: l.side, option: l.option, strike: 100 + l.offset * 5, premium: 3 * l.ratio, qty: l.ratio,
    }));
    const { points } = computePayoff(legs, 60, 140, 48);
    const ys = points.map(p => p.y);
    const yLo = Math.min(...ys), yHi = Math.max(...ys);
    const span = yHi - yLo || 1;
    return points.map((p, i) => {
      const x = (i / (points.length - 1)) * 72 + 4;
      const y = 30 - ((p.y - yLo) / span) * 24;
      return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join('');
  }, [template]);
  return (
    <svg viewBox="0 0 80 36" className="w-full h-12" aria-label="Schematic expiry payoff shape" role="img">
      <title>Schematic expiry payoff shape, not live pricing</title>
      <line x1={4} x2={76} y1={18} y2={18} stroke={chrome.baseline} strokeWidth={1} strokeDasharray="2 2" />
      <path d={path} fill="none" stroke="#34d399" strokeWidth={1.75} />
    </svg>
  );
}

function legSummary(template: StrategyTemplate): string {
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
}

export default function StrategyCardGrid({
  category, onCategoryChange, selectedKey, onSelectTemplate, disabled,
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
          const composition = legSummary(tpl);
          return (
          <button key={tpl.key} onClick={() => onSelectTemplate(tpl)} aria-label={`${tpl.name}: ${composition}`}
            title={composition}
            disabled={disabled}
            className={`flex-none w-48 p-3 rounded-xl border transition-all text-left disabled:opacity-40 ${
              selectedKey === tpl.key
                ? 'border-emerald-500/50 bg-emerald-500/5'
                : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-600'
            }`}>
            <StrategyGlyph template={tpl} />
            <p className="text-xs font-bold text-zinc-300 mt-1.5 leading-tight">{tpl.name}</p>
            <p className="text-[10px] leading-snug text-zinc-500 mt-1.5 line-clamp-2">{composition}</p>
          </button>
          );
        })}
      </div>
    </div>
  );
}
