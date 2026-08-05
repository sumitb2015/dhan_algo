// Underlyings selectable on the live options charts page. Mirrors the UNDERLYINGS table in
// scripts/tools/options_chart_fetch.py — keep the two in sync when adding one.
//
// Deliberately scoped to this page: Scalper/AdvancedScalper/Baskets keep their own lists because
// they gate on order placement (which brokers can trade what), not on chart data availability.
export const CHART_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL'] as const;
export type ChartUnderlying = (typeof CHART_UNDERLYINGS)[number];

export const DEFAULT_UNDERLYING: ChartUnderlying = 'NIFTY';

/** CRUDEOIL has no spot index — its overlay series is the nearest MCX FUTCOM contract, and it
 * trades the MCX session (09:00-23:30) rather than NSE's. */
export function isMcxUnderlying(underlying: string): boolean {
  return underlying === 'CRUDEOIL';
}

/** What the underlying's own price series actually is, for the Spot overlay label. */
export function spotLabel(underlying: string): string {
  return isMcxUnderlying(underlying) ? 'Futures' : 'Spot';
}
