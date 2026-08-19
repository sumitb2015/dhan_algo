import { MCX_LOT_MULTIPLIER } from './positionPnl';

/**
 * Underlyings the positions-analytics page supports.
 *
 * Strike steps match STRIKE_STEP in components/Scalper.tsx. Lot sizes are NOT
 * hardcoded — they are fetched per symbol via lib/lotSize.ts, which deliberately
 * has no fallback default (a guessed lot size silently scales every rupee figure
 * on the page). The values below are only what the payoff sampler needs.
 *
 * CRUDEOIL is the exception: /api/lotsize resolves through DhanHelper.get_lot_size(),
 * which reports 1 for MCX (Dhan's own order-quantity convention — see
 * positionPnl.ts's header comment). This page's margin sizing and "Lot N" display
 * need the real barrels-per-lot instead, since buildPositionLegs() now scales
 * qtyLots up to real units for CRUDEOIL legs.
 */

export const ANALYTICS_UNDERLYINGS = ['NIFTY', 'SENSEX', 'CRUDEOIL'] as const;
export type AnalyticsUnderlying = (typeof ANALYTICS_UNDERLYINGS)[number];

export const STRIKE_STEP: Record<AnalyticsUnderlying, number> = {
  NIFTY: 50,
  SENSEX: 100,
  CRUDEOIL: 100,
};

/** Exchange segment each underlying's options trade on. */
export const OPTION_SEGMENT: Record<AnalyticsUnderlying, string> = {
  NIFTY: 'NSE_FNO',
  SENSEX: 'BSE_FNO',
  CRUDEOIL: 'MCX_COMM',
};

/**
 * Trading-symbol root(s) each underlying's contracts actually appear under.
 * Almost always just the underlying's own name — CRUDEOIL is the exception:
 * Dhan positions carry the bare hyphenated form (`CRUDEOIL-17Sep2026-9000-CE`,
 * confirmed against a live position), but Kotak's compact symbol form is for
 * the Mini contract, prefixed `CRUDEOILM` (`CRUDEOILM17AUG264150CE`). Both
 * roots must match. Longest first so `CRUDEOILM…` matches its own root before
 * the bare `CRUDEOIL` root gets a chance to reject it (see the digit/hyphen
 * guard below — `M` immediately after `CRUDEOIL` would otherwise fail as
 * spurious).
 */
const SYMBOL_ROOTS: Record<AnalyticsUnderlying, string[]> = {
  NIFTY: ['NIFTY'],
  SENSEX: ['SENSEX'],
  CRUDEOIL: ['CRUDEOILM', 'CRUDEOIL'],
};

export function isAnalyticsUnderlying(v: string): v is AnalyticsUnderlying {
  return (ANALYTICS_UNDERLYINGS as readonly string[]).includes(v.toUpperCase());
}

/**
 * Lot size to use for margin sizing / the "Lot N" chip, overriding the fetched
 * /api/lotsize value where it does not mean "units per lot" (see the module
 * comment above). Null means "trust the fetched value" — every underlying
 * except CRUDEOIL.
 */
export function lotSizeOverride(underlying: AnalyticsUnderlying): number | null {
  return underlying === 'CRUDEOIL' ? MCX_LOT_MULTIPLIER.CRUDEOIL : null;
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
  const roots = ANALYTICS_UNDERLYINGS.flatMap((u) => SYMBOL_ROOTS[u].map((root) => ({ root, u })));
  // Longest root first: a prefix match would otherwise misfile a longer root's
  // symbol (e.g. CRUDEOILM…) under a shorter one that also matches.
  roots.sort((a, b) => b.root.length - a.root.length);
  for (const { root, u } of roots) {
    if (s.startsWith(root)) {
      const rest = s.slice(root.length);
      if (rest === '' || /^[-0-9]/.test(rest)) return u;
    }
  }
  return null;
}
