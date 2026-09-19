/**
 * Gap-move stress for option books, priced at EXPIRY.
 *
 * Expiry intrinsic value is exact and needs no vol model, which is why it is
 * used here: it is the honest worst-case-if-held-to-expiry number. A pre-expiry
 * gap is usually milder for short premium (time value still cushions it), so
 * treat these figures as a conservative bound, not a forecast.
 */

export interface StressLeg {
  strike: number;
  option: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  /** Entry / current premium per share, ₹. */
  price: number;
  /** Shares (lots × lot size × units), always positive. */
  qty: number;
}

export const STRESS_MOVES_PCT = [-8, -5, -3, -2, 2, 3, 5, 8] as const;

function intrinsic(option: 'CE' | 'PE', strike: number, spot: number): number {
  return option === 'CE' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
}

/** P&L in ₹ of one leg if the underlying settles at `spot` on expiry. */
export function legExpiryPnl(leg: StressLeg, spot: number): number {
  const payoff = intrinsic(leg.option, leg.strike, spot);
  const perShare = leg.side === 'SELL' ? leg.price - payoff : payoff - leg.price;
  return perShare * leg.qty;
}

export function bookExpiryPnl(legs: StressLeg[], spot: number): number {
  return legs.reduce((sum, l) => sum + legExpiryPnl(l, spot), 0);
}
