import type { StrategyLeg } from './optionsChartTypes';

export type StrategyCategory = 'bullish' | 'bearish' | 'neutral';

export const STRATEGY_CATEGORIES: { id: StrategyCategory; label: string }[] = [
  { id: 'bullish', label: 'Bullish' },
  { id: 'bearish', label: 'Bearish' },
  { id: 'neutral', label: 'Neutral' },
];

export interface LegTemplate {
  option_type: 'CE' | 'PE';
  action: 'BUY' | 'SELL';
  /** Offset (in strike-chain positions, not price) from the ATM strike's index in the sorted
   * strikes list - resolved to a real strike by StrategyPanel once the chain loads, so presets
   * work regardless of NIFTY's actual strike spacing. */
  atmOffset: number;
  lots: number;
}

export interface StrategyPreset {
  id: string;
  label: string;
  category: StrategyCategory;
  legs: LegTemplate[];
}

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: 'bull_call_spread',
    label: 'Bull Call Spread',
    category: 'bullish',
    legs: [
      { option_type: 'CE', action: 'BUY', atmOffset: 0, lots: 1 },
      { option_type: 'CE', action: 'SELL', atmOffset: 2, lots: 1 },
    ],
  },
  {
    id: 'bull_put_spread',
    label: 'Bull Put Spread',
    category: 'bullish',
    legs: [
      { option_type: 'PE', action: 'SELL', atmOffset: 0, lots: 1 },
      { option_type: 'PE', action: 'BUY', atmOffset: -2, lots: 1 },
    ],
  },
  {
    id: 'bear_call_spread',
    label: 'Bear Call Spread',
    category: 'bearish',
    legs: [
      { option_type: 'CE', action: 'SELL', atmOffset: 0, lots: 1 },
      { option_type: 'CE', action: 'BUY', atmOffset: 2, lots: 1 },
    ],
  },
  {
    id: 'bear_put_spread',
    label: 'Bear Put Spread',
    category: 'bearish',
    legs: [
      { option_type: 'PE', action: 'BUY', atmOffset: 0, lots: 1 },
      { option_type: 'PE', action: 'SELL', atmOffset: -2, lots: 1 },
    ],
  },
  {
    id: 'straddle',
    label: 'Straddle',
    category: 'neutral',
    legs: [
      { option_type: 'CE', action: 'SELL', atmOffset: 0, lots: 1 },
      { option_type: 'PE', action: 'SELL', atmOffset: 0, lots: 1 },
    ],
  },
  {
    id: 'strangle',
    label: 'Strangle',
    category: 'neutral',
    legs: [
      { option_type: 'CE', action: 'SELL', atmOffset: 2, lots: 1 },
      { option_type: 'PE', action: 'SELL', atmOffset: -2, lots: 1 },
    ],
  },
  {
    id: 'iron_condor',
    label: 'Iron Condor',
    category: 'neutral',
    legs: [
      { option_type: 'CE', action: 'SELL', atmOffset: 2, lots: 1 },
      { option_type: 'CE', action: 'BUY', atmOffset: 4, lots: 1 },
      { option_type: 'PE', action: 'SELL', atmOffset: -2, lots: 1 },
      { option_type: 'PE', action: 'BUY', atmOffset: -4, lots: 1 },
    ],
  },
  {
    id: 'butterfly',
    label: 'Butterfly (Calls)',
    category: 'neutral',
    legs: [
      { option_type: 'CE', action: 'BUY', atmOffset: -2, lots: 1 },
      { option_type: 'CE', action: 'SELL', atmOffset: 0, lots: 2 },
      { option_type: 'CE', action: 'BUY', atmOffset: 2, lots: 1 },
    ],
  },
];

/** Resolves a preset's atmOffset-based leg templates to real strikes given a sorted strike
 * chain, clamping any offset that would fall off either end of the chain. */
export function resolvePresetLegs(preset: StrategyPreset, sortedStrikes: number[], atmIndex: number): StrategyLeg[] {
  return preset.legs.map((leg) => {
    const index = Math.min(sortedStrikes.length - 1, Math.max(0, atmIndex + leg.atmOffset));
    return { option_type: leg.option_type, action: leg.action, strike: sortedStrikes[index], lots: leg.lots };
  });
}
