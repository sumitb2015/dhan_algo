// Far-expiry strike rule and bid/ask spread assessment for Multi-leg Focus.
//
// Far expiries (3rd listed expiry onward) only trade liquidly on strikes that are
// multiples of 100; the 50-strikes there are thin and market orders fill badly.
// The current (1st) and next (2nd) expiries may use every listed strike.

/** Index underlyings the 100-multiple rule applies to. MCX crude keeps its own grid. */
const RULE_UNDERLYINGS = new Set(['NIFTY', 'BANKNIFTY', 'SENSEX']);
/** Expiries at index >= this (0-based, sorted) are "far". */
export const FIRST_FAR_EXPIRY_INDEX = 2;
export const FAR_STRIKE_MULTIPLE = 100;

/** Spread is "wide" when it exceeds BOTH this % of mid and the absolute floor (Rs). */
export const WIDE_SPREAD_PCT = 5;
export const WIDE_SPREAD_ABS = 0.5;

/** Whether the 100-multiple rule can apply to this underlying at all. */
export function strikeRuleApplies(underlying: string): boolean {
  return RULE_UNDERLYINGS.has(underlying);
}

/** True when `expiry` is the 3rd-or-later listed expiry. Unknown/unloaded => false. */
export function isFarExpiry(expiry: string, listedExpiries: string[]): boolean {
  if (!expiry || !listedExpiries.length) return false;
  const idx = [...listedExpiries].sort().indexOf(expiry);
  return idx >= FIRST_FAR_EXPIRY_INDEX;
}

export function strikeAllowed(underlying: string, expiry: string, listedExpiries: string[], strike: number): boolean {
  if (!RULE_UNDERLYINGS.has(underlying)) return true;
  if (!isFarExpiry(expiry, listedExpiries)) return true;
  return strike % FAR_STRIKE_MULTIPLE === 0;
}

export function allowedStrikes(underlying: string, expiry: string, listedExpiries: string[], strikes: number[]): number[] {
  if (!RULE_UNDERLYINGS.has(underlying) || !isFarExpiry(expiry, listedExpiries)) return strikes;
  return strikes.filter(s => s % FAR_STRIKE_MULTIPLE === 0);
}

/** Nearest allowed strike to `strike` (ties go to the lower strike); `strike` itself when allowed. */
export function snapToAllowed(underlying: string, expiry: string, listedExpiries: string[], strike: number, strikes: number[]): number {
  if (strikeAllowed(underlying, expiry, listedExpiries, strike)) return strike;
  const pool = allowedStrikes(underlying, expiry, listedExpiries, strikes);
  if (!pool.length) return strike;
  return pool.reduce((best, s) => {
    const d = Math.abs(s - strike), bd = Math.abs(best - strike);
    return d < bd || (d === bd && s < best) ? s : best;
  }, pool[0]);
}

export type SpreadStatus = 'ok' | 'wide' | 'no_market' | 'unknown';
export interface SpreadAssessment { status: SpreadStatus; bid: number; ask: number; spread: number; pct: number }

/**
 * `bid`/`ask` undefined or non-finite => 'unknown' (data unavailable — never blocks).
 * A present but zero/negative bid or ask => 'no_market' (a real one-sided book).
 */
export function assessSpread(q: { bid?: number | null; ask?: number | null } | undefined | null): SpreadAssessment {
  const raw = { bid: q?.bid, ask: q?.ask };
  if (!q || raw.bid == null || raw.ask == null || !Number.isFinite(Number(raw.bid)) || !Number.isFinite(Number(raw.ask))) {
    return { status: 'unknown', bid: 0, ask: 0, spread: 0, pct: 0 };
  }
  const bid = Number(raw.bid), ask = Number(raw.ask);
  if (bid <= 0 || ask <= 0) return { status: 'no_market', bid, ask, spread: 0, pct: 0 };
  const spread = ask - bid;
  const mid = (ask + bid) / 2;
  const pct = mid > 0 ? (spread / mid) * 100 : 0;
  const wide = pct > WIDE_SPREAD_PCT && spread >= WIDE_SPREAD_ABS;
  return { status: wide ? 'wide' : 'ok', bid, ask, spread, pct };
}
