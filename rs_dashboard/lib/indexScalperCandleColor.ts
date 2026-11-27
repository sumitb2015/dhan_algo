// Trend-coloured candles for the /index-scalper chart: a viewer setting that paints each candle by a trend rule instead
// of by open vs close, so the chart shows at a glance which side the trend is on ("only trade with the trend").
// Pure: given candles and a rule it returns one state per bar. New rules are added to CANDLE_COLOR_RULES + trendStates.

import { emaSmaSeeded } from './indicators.ts';
import type { Bar } from './indexScalperIndicators.ts';

export type CandleColorRule = 'off' | 'ema9_20';
/** Per bar: with the trend up, down, mixed (price between the averages), or null = rule not ready yet (warm-up). */
export type TrendState = 'bull' | 'bear' | 'neutral' | null;

export const CANDLE_COLOR_RULES: { id: CandleColorRule; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'Normal candles: green when close ≥ open, red otherwise' },
  { id: 'ema9_20', label: 'EMA 9 & 20', hint: 'Green: close above EMA 9 and EMA 20 · Red: close below both · Grey: between them' },
];

export const CANDLE_COLOR_KEY = 'indexScalper.candleColorRule';

export function parseCandleColorRule(raw: unknown): CandleColorRule {
  return CANDLE_COLOR_RULES.some(r => r.id === raw) ? (raw as CandleColorRule) : 'off';
}

/** Above both = bull, below both = bear, anything else (between, or touching one) = neutral. */
function vsAverages(close: number, avgs: (number | null)[]): TrendState {
  if (avgs.some(a => a === null)) return null;
  if (avgs.every(a => close > (a as number))) return 'bull';
  if (avgs.every(a => close < (a as number))) return 'bear';
  return 'neutral';
}

/** One state per bar, or null when the rule is off. EMAs are TradingView's ta.ema on closes (as the EMA indicator). */
export function trendStates(bars: Bar[], rule: CandleColorRule): TrendState[] | null {
  if (rule === 'off') return null;
  const closes = bars.map(b => b.c);
  const e9 = emaSmaSeeded(closes, 9);
  const e20 = emaSmaSeeded(closes, 20);
  return bars.map((b, i) => vsAverages(b.c, [e9[i], e20[i]]));
}
