/**
 * Underlyings the positions-analytics page supports.
 *
 * Strike steps match STRIKE_STEP in components/Scalper.tsx. Lot sizes are NOT
 * hardcoded — they are fetched per symbol via lib/lotSize.ts, which deliberately
 * has no fallback default (a guessed lot size silently scales every rupee figure
 * on the page). The values below are only what the payoff sampler needs.
 */

export const ANALYTICS_UNDERLYINGS = ['NIFTY', 'SENSEX'] as const;
export type AnalyticsUnderlying = (typeof ANALYTICS_UNDERLYINGS)[number];

export const STRIKE_STEP: Record<AnalyticsUnderlying, number> = {
  NIFTY: 50,
  SENSEX: 100,
};

/** Exchange segment each underlying's options trade on. */
export const OPTION_SEGMENT: Record<AnalyticsUnderlying, string> = {
  NIFTY: 'NSE_FNO',
  SENSEX: 'BSE_FNO',
};

export function isAnalyticsUnderlying(v: string): v is AnalyticsUnderlying {
  return (ANALYTICS_UNDERLYINGS as readonly string[]).includes(v.toUpperCase());
}

/**
 * Underlying a trading symbol belongs to, or null if it is not one we handle.
 *
 * Requires a digit or hyphen immediately after the root name, not just a
 * prefix match — `startsWith('NIFTY')` also matches `NIFTYNXT50…`, which would
 * file a different instrument's leg into the NIFTY book with its strike
 * evaluated against the wrong spot, and no unparseable warning to flag it.
 * Every real derivative symbol continues immediately with a digit or hyphen
 * (`NIFTY-Aug2026-…`, `NIFTY18AUG26…`); a following letter means the match is
 * spurious. Same rule as `symbolMatchesUnderlying` in lib/positionLegs.ts.
 */
export function underlyingOfSymbol(tradingSymbol: string): AnalyticsUnderlying | null {
  const s = tradingSymbol.trim().toUpperCase();
  // Longest first: nothing here is a prefix of another today, but BANKNIFTY-style
  // additions would be, and a prefix match would then misfile every leg.
  for (const u of [...ANALYTICS_UNDERLYINGS].sort((a, b) => b.length - a.length)) {
    if (s.startsWith(u)) {
      const rest = s.slice(u.length);
      if (rest === '' || /^[-0-9]/.test(rest)) return u;
    }
  }
  return null;
}
