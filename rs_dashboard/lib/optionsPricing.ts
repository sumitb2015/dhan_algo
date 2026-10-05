/**
 * Options pricing library — the ONE place option maths lives in the dashboard.
 *
 * Every page (Options Monitor, Baskets, Multi-Leg Focus, Positions Analysis, Portfolio Greeks, scanners) prices options and
 * computes Greeks through this module, so a number can only be wrong in one place. Pure functions, no React, no I/O.
 *
 *   model        Black-76 on a futures/forward price (isFutures = true) or Black-Scholes on spot (isFutures = false;
 *                the documented fallback when no futures price is available).
 *   units        delta per unit of underlying; gamma per index point; theta ₹ per calendar day; vega ₹ per 1% IV;
 *                rho ₹ per 1% rate; vanna = Δdelta per 1% IV; vomma = Δvega per 1% IV; charm = Δdelta per calendar day.
 *                IV is always a FRACTION (0.14).
 *   clock        time to 15:40 IST on the expiry date (SEBI close auction), /365 calendar days, floored at 0.25 day.
 *   rate         RISK_FREE_RATE = 6.5% everywhere.
 *
 * Guarded by lib/optionsPricing.test.ts: finite differences of the price itself, plus fixed reference values from two
 * independent libraries (py_vollib, blackscholes). Change a formula here and those tests tell you immediately.
 * What no test can prove: the rate, the 365-day year, the 15:40 close and "futures as the forward" are choices.
 *
 * Rounded vs exact: `computeBsGreeks` is the display view (₹0.05 price tick, 2 dp / 4 dp). Anything multiplied by a
 * quantity, summed across legs or used to build a curve must use `computeBsGreeksExact`.
 */

export type OptType = 'CE' | 'PE';

/** Default risk-free rate for every model in the dashboard. */
export const RISK_FREE_RATE = 0.065;

/** Calendar days per year — the annualization base for every `timeYears`.
 *  Do NOT "correct" this to 252 trading days. Reverse-engineering Sensibull's published Greeks for a known NIFTY strangle
 *  (23500 CE @ 9.5% IV, 23300 PE @ 11% IV, 4 days to expiry) reproduces its deltas ONLY with 4/365; 4/252 misses both legs. */
export const CALENDAR_DAYS_PER_YEAR = 365;

// ── Normal distribution ──────────────────────────────────────────────────────

/** Standard normal CDF, Abramowitz-Stegun 7.1.26 (|error| < 1.5e-7). The only copy in the dashboard. */
export function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// ── Expiry clock ─────────────────────────────────────────────────────────────

/** F&O close is 15:40 IST = 10:10 UTC (SEBI's Close Auction Session moved it from 15:30; cash/equity is unaffected). */
export const FNO_CLOSE_UTC = { hour: 10, minute: 10 } as const;

/** Epoch ms of the F&O close on an expiry date ("YYYY-MM-DD"). */
export function expiryEpochMs(expiryDateStr: string): number {
  const [y, m, d] = expiryDateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, FNO_CLOSE_UTC.hour, FNO_CLOSE_UTC.minute, 0);
}

/**
 * Remaining time to expiry in years (calendar/365) — the `t` every model here consumes. Intraday precision, floored at
 * 0.25 day so Black-76 never divides by zero. Do not write a second "days to expiry" helper for anything that feeds a price,
 * Greek, SD band or payoff curve: calendar-day granularity is exactly what made Baskets and Options Monitor disagree.
 * `now` is injectable for tests.
 */
export function calculateTimeToExpiryYears(expiryDateStr: string, now: number = Date.now()): number {
  if (!expiryDateStr) return 2 / CALENDAR_DAYS_PER_YEAR;
  try {
    const diffMs = expiryEpochMs(expiryDateStr) - now;
    if (diffMs <= 0) return 0.25 / CALENDAR_DAYS_PER_YEAR; // at least a few hours on expiry day
    return Math.max(0.25 / CALENDAR_DAYS_PER_YEAR, diffMs / (CALENDAR_DAYS_PER_YEAR * 24 * 3600 * 1000));
  } catch {
    return 2 / CALENDAR_DAYS_PER_YEAR;
  }
}

/** Forward for `toExpiry` implied by a futures price on `fromExpiry` (same cost of carry): F·e^{−r(T_from − T_to)}. */
export function rollForward(F: number, fromExpiry: string, toExpiry: string, r = RISK_FREE_RATE, now: number = Date.now()): number {
  return F * Math.exp(-r * (calculateTimeToExpiryYears(fromExpiry, now) - calculateTimeToExpiryYears(toExpiry, now)));
}

/** Spot implied by a futures price when no live index quote is available: F·e^{−rT}. An estimate — say so on screen. */
export function spotFromFutures(F: number, futuresExpiry: string, r = RISK_FREE_RATE, now: number = Date.now()): number {
  return F * Math.exp(-r * calculateTimeToExpiryYears(futuresExpiry, now));
}

// ── Pricing core ─────────────────────────────────────────────────────────────

/** Unrounded price and Greeks. See the units table at the top of this file. */
export interface BsGreeksExact {
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  vanna: number;
  vomma: number;
  charm: number;
}

/** Delta only — used for charm so the full core is not evaluated recursively. */
function deltaCore(type: OptType, F: number, strike: number, t: number, v: number, r: number, isFutures: boolean): number {
  const d1 = (Math.log(F / strike) + (isFutures ? 0 : r * t) + 0.5 * v * v * t) / (v * Math.sqrt(t));
  const carry = isFutures ? Math.exp(-r * t) : 1;
  return type === 'CE' ? carry * normCdf(d1) : isFutures ? -carry * normCdf(-d1) : normCdf(d1) - 1;
}

/** The single implementation of the formulas. Callers pass already-valid t > 0 and v > 0. */
function blackCore(type: OptType, F: number, strike: number, t: number, v: number, r: number, isFutures: boolean): BsGreeksExact {
  const sqrtT = Math.sqrt(t);
  // In Black-76 (options on a forward) cost-of-carry is already embedded in F; Black-Scholes on spot adds r·t drift.
  const drift = isFutures ? 0 : r * t;
  const d1 = (Math.log(F / strike) + drift + 0.5 * v * v * t) / (v * sqrtT);
  const d2 = d1 - v * sqrtT;
  const discount = Math.exp(-r * t);
  // The e^{-rt} factor on the underlying belongs to Black-76 only (discounted forward); plain Black-Scholes has none.
  const carry = isFutures ? discount : 1;
  const pdf = normPdf(d1);

  let price: number;
  let delta: number;
  let rho: number;
  if (isFutures) {
    // Delta is the derivative with respect to the FUTURES price, so it carries e^{-rt}: Δc = e^{-rt}N(d1), Δp = −e^{-rt}N(−d1).
    // (Some vendors print the undiscounted forward delta N(d1); the difference is ~0.4% at 22 days.)
    if (type === 'CE') {
      price = discount * (F * normCdf(d1) - strike * normCdf(d2));
      delta = discount * normCdf(d1);
    } else {
      price = discount * (strike * normCdf(-d2) - F * normCdf(-d1));
      delta = -discount * normCdf(-d1);
    }
    rho = (-t * price) / 100; // the forward is fixed, so the rate only discounts
  } else if (type === 'CE') {
    price = F * normCdf(d1) - strike * discount * normCdf(d2);
    delta = normCdf(d1);
    rho = (strike * t * discount * normCdf(d2)) / 100;
  } else {
    price = strike * discount * normCdf(-d2) - F * normCdf(-d1);
    delta = normCdf(d1) - 1;
    rho = (-strike * t * discount * normCdf(-d2)) / 100;
  }

  const gamma = (carry * pdf) / (F * v * sqrtT);
  const rawVega = F * carry * sqrtT * pdf; // per 1.00 of IV
  const vega = rawVega * 0.01;
  const vanna = (-carry * pdf * d2) / v / 100;
  const vomma = (rawVega * d1 * d2) / v / 10000;

  // Theta per calendar day. Black-76: Θ = −F·e^{−rt}·n(d1)·σ/(2√t) + r·C (the carry term is ADDED; fixed 2026-10-05).
  // Black-Scholes on spot: the volatility term has NO discount factor.
  const term1 = -(F * carry * pdf * v) / (2 * sqrtT);
  let rawTheta: number;
  if (isFutures) rawTheta = term1 + r * price;
  else if (type === 'CE') rawTheta = term1 - r * strike * discount * normCdf(d2);
  else rawTheta = term1 + r * strike * discount * normCdf(-d2);

  // Charm: change in delta over one calendar day of decay (no move in the underlying, IV unchanged).
  const charm = deltaCore(type, F, strike, Math.max(t - 1 / CALENDAR_DAYS_PER_YEAR, 1e-6), v, r, isFutures) - delta;

  return { price, delta, gamma, theta: rawTheta / CALENDAR_DAYS_PER_YEAR, vega, rho, vanna, vomma, charm };
}

/**
 * Unrounded price + Greeks. Use this wherever a value is multiplied by a quantity, summed across legs, or used to build a curve.
 * Inputs are clamped for numerical safety (t ≥ 0.0001 years, iv ≥ 1%).
 */
export function computeBsGreeksExact(
  type: OptType,
  spotOrFuture: number,
  strike: number,
  timeYears: number,
  iv: number,
  r = RISK_FREE_RATE,
  isFutures = false,
): BsGreeksExact {
  return blackCore(type, spotOrFuture, strike, Math.max(timeYears, 0.0001), Math.max(iv, 0.01), r, isFutures);
}

/**
 * Display-rounded view of the same numbers: price to the ₹0.05 tick (floored at 0.05), delta/theta/vega 2 dp, gamma 4 dp.
 * Fine for one cell. Do NOT multiply by a quantity or sum across legs: a 2 dp delta is ±0.005 per unit (±2 on 390 units) and a
 * 4 dp gamma of ~0.0004 is up to 12% off. `lotSize` is ignored (Greeks are per unit); kept so existing callers compile.
 */
export function computeBsGreeks(
  type: OptType,
  spotOrFuture: number,
  strike: number,
  timeYears: number,
  iv: number,
  lotSize: number,
  r = RISK_FREE_RATE,
  isFutures = false,
): { price: number; delta: number; gamma: number; theta: number; vega: number } {
  void lotSize;
  const g = computeBsGreeksExact(type, spotOrFuture, strike, timeYears, iv, r, isFutures);
  return {
    price: Math.max(0.05, Math.round(g.price * 20) / 20),
    delta: Math.round(g.delta * 100) / 100,
    gamma: Math.round(g.gamma * 10000) / 10000,
    theta: Math.round(g.theta * 100) / 100,
    vega: Math.round(g.vega * 100) / 100,
  };
}

/**
 * Exact Greeks with the price on the ₹0.05 tick: for a page that shows an ESTIMATED LTP (which must sit on the exchange tick) and also
 * feeds the same Greeks into quantity-weighted sums. Use this instead of `computeBsGreeks` there. `lotSize` is ignored.
 */
export function computeGreeksTickPrice(
  type: OptType,
  spotOrFuture: number,
  strike: number,
  timeYears: number,
  iv: number,
  lotSize: number,
  r = RISK_FREE_RATE,
  isFutures = false,
): { price: number; delta: number; gamma: number; theta: number; vega: number } {
  void lotSize;
  const g = computeBsGreeksExact(type, spotOrFuture, strike, timeYears, iv, r, isFutures);
  return { price: Math.max(0.05, Math.round(g.price * 20) / 20), delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega };
}

/** Unrounded, unclamped price; intrinsic when t ≤ 0 or iv ≤ 0. */
export function priceOption(type: OptType, U: number, K: number, t: number, iv: number, r = RISK_FREE_RATE, isFutures = false): number {
  if (!(t > 0) || !(iv > 0)) return type === 'CE' ? Math.max(U - K, 0) : Math.max(K - U, 0);
  return blackCore(type, U, K, t, iv, r, isFutures).price;
}

/** Black-Scholes on spot. Same formula and normal CDF as the spot branch of computeBsGreeksExact. */
export function bsPrice(type: OptType, S: number, K: number, t: number, iv: number, r = RISK_FREE_RATE): number {
  return priceOption(type, S, K, t, iv, r, false);
}

/** Risk-neutral P(S_T > K) under lognormal GBM — the same N(d2) term the Black-Scholes call price uses. */
export function riskNeutralProbAbove(S: number, K: number, t: number, iv: number, r = RISK_FREE_RATE): number {
  if (t <= 0 || iv <= 0) return S > K ? 1 : 0;
  const d2 = (Math.log(S / K) + (r - (iv * iv) / 2) * t) / (iv * Math.sqrt(t));
  return normCdf(d2);
}

// ── Implied volatility ───────────────────────────────────────────────────────

/**
 * Invert the model for sigma by bisection. Returns null when no solution exists rather than a clamped bound: a price at or below
 * the no-arbitrage floor has no positive-vol solution, and a price above a 500% vol is bad data. Callers must treat null as "IV unavailable".
 * Needed because Dhan's chain often returns one-sided or zero IV/Greeks; a leg without IV would otherwise silently price intrinsic.
 */
export function impliedVol(
  type: OptType,
  U: number,
  K: number,
  t: number,
  price: number,
  opts: { r?: number; isFutures?: boolean } = {},
): number | null {
  const r = opts.r ?? RISK_FREE_RATE;
  const isFutures = opts.isFutures ?? false;
  if (!(t > 0) || !(price > 0) || !(U > 0) || !(K > 0)) return null;

  // No-arbitrage lower bound of a European option. It is below plain intrinsic because the strike is discounted (spot) or the
  // forward is (Black-76), so a deep-ITM European put can legitimately trade under K - S. Below this bound no sigma > 0 fits.
  const df = Math.exp(-r * t);
  const floor = isFutures
    ? df * (type === 'CE' ? Math.max(U - K, 0) : Math.max(K - U, 0))
    : type === 'CE' ? Math.max(U - K * df, 0) : Math.max(K * df - U, 0);
  if (price <= floor + 1e-8) return null;

  let lo = 1e-4;
  let hi = 5;
  if (priceOption(type, U, K, t, hi, r, isFutures) < price) return null; // beyond a 500% vol

  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (priceOption(type, U, K, t, mid, r, isFutures) < price) lo = mid; else hi = mid;
    if (hi - lo < 1e-7) break;
  }
  return (lo + hi) / 2;
}

/** Spot Black-Scholes IV. Kept under its historical name for existing callers. */
export function impliedVolFromPrice(type: OptType, S: number, K: number, t: number, price: number, r = RISK_FREE_RATE): number | null {
  return impliedVol(type, S, K, t, price, { r, isFutures: false });
}

// ── Mark → IV → Greeks ───────────────────────────────────────────────────────

export interface MarkInput {
  type: OptType;
  strike: number;
  expiry: string;            // YYYY-MM-DD
  mark: number;              // the premium the model must reproduce (live LTP, or an average fill for a P&L curve)
  underlying: number;        // futures/forward price when isFutures, else spot
  isFutures: boolean;
  fallbackIv?: number;       // fraction; used only if the mark cannot be inverted
}

export interface MarkedGreeks extends BsGreeksExact {
  iv: number;                // fraction
  ivSource: 'mark' | 'fallback';
  timeYears: number;
}

/**
 * The standard "solve IV from the premium, then take Greeks at that IV" step that every surface needs. Solving from the mark (not
 * trusting a chain IV) makes the model reproduce the leg's own price, so a T+0 curve starts at the leg's P&L and the Greeks agree
 * with it. Returns null when there is neither a solvable mark nor a fallback IV.
 */
export function greeksFromMark(input: MarkInput, opts: { r?: number; timeYears?: number } = {}): MarkedGreeks | null {
  const r = opts.r ?? RISK_FREE_RATE;
  const timeYears = opts.timeYears ?? calculateTimeToExpiryYears(input.expiry);
  const solved = impliedVol(input.type, input.underlying, input.strike, timeYears, input.mark, { r, isFutures: input.isFutures });
  const iv = solved ?? (input.fallbackIv && input.fallbackIv > 0 ? input.fallbackIv : null);
  if (iv === null) return null;
  const g = computeBsGreeksExact(input.type, input.underlying, input.strike, timeYears, iv, r, input.isFutures);
  return { ...g, iv, ivSource: solved !== null ? 'mark' : 'fallback', timeYears };
}
