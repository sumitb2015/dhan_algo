/**
 * Diagonal Strike Advisor & Greek Intelligence Engine
 * 
 * Implements strike selection, Greek computations, and dynamic sizing
 * for the Delta-Controlled Low-Gamma Diagonal Covered Call Strategy.
 * 
 * Rules:
 *  - Long leg: 60-120 DTE, ATM/ITM (Delta ~0.55 - 0.65).
 *  - Short leg: weekly or monthly expiry, 25-45 DTE, expiring before the long, OTM (Delta ~0.15 - 0.22).
 *    Ranked by closeness to the 0.18 target delta; Theta/|Gamma| only breaks ties within 0.02 delta
 *    (it is ~0.5*sigma^2*S^2 for every strike, so as the primary key it always picked the highest-delta edge).
 *    Mirrors strategies/diagonal_call/nifty_diagonal_call.py::select_short_call.
 *  - Target Net Delta: +10 to +20 units (or +30 to +45 units for 3 lots long).
 *  - Net Gamma Floor: > -0.15 (emergency halt at -0.20).
 *  - Dynamic Sizing: Sized from long delta and target net delta, clamped by max-short-ratio (1.25),
 *    then trimmed until projected gamma is within 75% of the emergency floor (same as Python).
 */

export interface BsGreeks {
  delta: number;
  gamma: number;
  thetaDay: number; // points decay per day (negative for long options)
  vega: number;     // points per 1% IV change
}

export interface PortfolioGreeksResult {
  longDeltaShares: number;
  shortDeltaShares: number;
  netDeltaShares: number;
  netDeltaLots: number;
  portfolioGamma: number;
  portfolioThetaDayRs: number; // Daily net decay in ₹ (positive means earning decay)
  portfolioVegaRs: number;     // ₹ change per 1% IV shift
  deltaZone: 'DEFENSIVE' | 'SLIGHTLY_BEARISH' | 'NORMAL_HOLD' | 'MILD_BULLISH' | 'TOO_BULLISH';
  gammaStatus: 'EXCELLENT' | 'ACCEPTABLE' | 'CAUTION' | 'DEFENSIVE';
}

export interface CandidateStrike {
  strike: number;
  expiry: string;
  dte: number;
  ltp: number;
  iv: number;
  delta: number;
  gamma: number;
  thetaDay: number;
  score: number;
  recommendedLots: number;
  resultingNetDeltaShares: number;
  resultingNetGamma: number;
  resultingNetThetaRs: number;
  classification: 'optimal' | 'conservative' | 'aggressive' | 'out_of_bounds';
  reason: string;
  bid: number | null;
  ask: number | null;
  /** (ask - bid) / mid in percent; null when there is no two-sided quote. */
  spreadPct: number | null;
  /** Fail closed, as in the live strategy: true only when a two-sided quote's spread is within the limit. */
  liquid: boolean;
}

export const SHORT_TARGET_DELTA = 0.18;
export const GAMMA_FIT_FRACTION = 0.75;
export const TIE_BREAK_DELTA_BAND = 0.02;
/** A strike is liquid only if (ask - bid) / mid <= this many percent. Mirrors MAX_SPREAD_PCT_DEFAULT in the Python strategy. */
export const MAX_SPREAD_PCT = 5;

/** (ask - bid) / mid in percent, or null when bid/ask are missing, non-positive or crossed. */
export function bidAskSpreadPct(bid: number | null | undefined, ask: number | null | undefined): number | null {
  if (typeof bid !== 'number' || typeof ask !== 'number' || !(bid > 0) || !(ask > 0) || ask < bid) return null;
  return ((ask - bid) / ((ask + bid) / 2)) * 100;
}

/** Weekday heuristic fallback: last occurrence of its weekday in its month. Misreads a holiday-shifted monthly. */
export function isMonthlyExpiry(expiry: string): boolean {
  const d = new Date(`${expiry}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const next = new Date(d.getTime() + 7 * 86400000);
  return next.getUTCMonth() !== d.getUTCMonth();
}

/**
 * The monthly series = the latest listed expiry in each calendar month. Preferred over the weekday
 * heuristic because it survives holiday-shifted expiries. Mirrors monthly_expiries() in the Python strategy.
 */
export function monthlyExpiries(expiries: string[]): Set<string> {
  const last = new Map<string, string>();
  for (const e of expiries) {
    const key = e.slice(0, 7);
    const cur = last.get(key);
    if (!cur || e > cur) last.set(key, e);
  }
  return new Set(last.values());
}

export interface DiagonalAdvisorRecommendation {
  spot: number;
  lotSize: number;
  longLeg: {
    strike: number;
    expiry: string;
    dte: number;
    lots: number;
    delta: number;
    gamma: number;
  };
  bestCandidate: CandidateStrike | null;
  candidates: CandidateStrike[];
  summary: {
    targetNetDelta: number;
    maxShortRatio: number;
    regime: string;
    /** Rule violations in the chosen front expiry (not before the long). Empty when clean. */
    warnings: string[];
  };
}

export interface AdjustmentAction {
  action: 'CLOSE' | 'ROLL' | 'HOLD' | 'ADD_HEDGE';
  symbol: string;
  strike: number;
  expiry: string;
  lots: number;
  side: 'B' | 'S';
  reason: string;
  targetStrike?: number;
  targetLots?: number;
  urgency: 'HIGH' | 'MEDIUM' | 'LOW';
}

/** Error function approximation for normal CDF */
function erf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));
  return sign * y;
}

/** Cumulative standard normal distribution function */
export function normalCdf(x: number): number {
  return 0.5 * (1.0 + erf(x / Math.SQRT2));
}

/** Standard normal probability density function */
export function normalPdf(x: number): number {
  return (1.0 / Math.sqrt(2.0 * Math.PI)) * Math.exp(-0.5 * x * x);
}

/**
 * Computes Black-Scholes Greeks for European/Indian index options.
 *
 * @param spot Current spot underlying price
 * @param strike Strike price
 * @param dte Days to expiry (minimum 0.1)
 * @param iv Implied volatility as a decimal (e.g. 0.15 for 15%)
 * @param r Risk-free interest rate (default 0.07 / 7% annual)
 * @param optType 'CE' or 'PE'
 */
export function computeBsGreeks(
  spot: number,
  strike: number,
  dte: number,
  iv: number = 0.15,
  r: number = 0.07,
  optType: 'CE' | 'PE' = 'CE',
): BsGreeks {
  if (spot <= 0 || strike <= 0) {
    return { delta: 0, gamma: 0, thetaDay: 0, vega: 0 };
  }

  const vol = Math.max(0.01, iv > 1 ? iv / 100 : iv);
  const t = Math.max(0.1, dte) / 365.0;
  const sqrtT = Math.sqrt(t);

  const d1 = (Math.log(spot / strike) + (r + 0.5 * vol * vol) * t) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;

  const nd1 = normalCdf(d1);
  const npD1 = normalPdf(d1);
  const nd2 = normalCdf(d2);

  const isCall = optType.toUpperCase() === 'CE';
  const delta = isCall ? nd1 : nd1 - 1.0;
  const gamma = npD1 / (spot * vol * sqrtT);

  const thetaAnnual = -(spot * npD1 * vol) / (2.0 * sqrtT) - r * strike * Math.exp(-r * t) * (isCall ? nd2 : 1.0 - nd2);
  const thetaDay = thetaAnnual / 365.0;
  const vega = (spot * sqrtT * npD1) / 100.0;

  return { delta, gamma, thetaDay, vega };
}

/**
 * Short Call Efficiency Score = Theta Decay per Day / |Gamma|.
 * Captured decay is -thetaDay.
 */
export function scoreShortCall(thetaDay: number, gamma: number): number {
  const decay = -thetaDay;
  if (decay <= 0 || gamma <= 0) return 0;
  return decay / gamma;
}

/**
 * Calculates required short call lots based on delta balance and risk caps.
 */
export function calculateRequiredShortLots(
  longDeltaShares: number,
  targetNetDeltaShares: number,
  shortCallDelta: number,
  lotSize: number,
  maxShortRatio: number = 1.25,
  maxShortLots: number = 6,
): number {
  if (shortCallDelta <= 0.001 || lotSize <= 0) return 0;

  const targetShortDelta = Math.max(0, longDeltaShares - targetNetDeltaShares);
  const rawLots = Math.round(targetShortDelta / (shortCallDelta * lotSize));

  // Risk limits: Short Delta <= maxShortRatio * Long Delta
  const maxShortDelta = longDeltaShares * maxShortRatio;
  const deltaCappedLots = Math.max(1, Math.floor(maxShortDelta / (shortCallDelta * lotSize)));

  // Ceiling cap
  const ceiling = Math.max(1, maxShortLots);
  return Math.max(1, Math.min(rawLots, deltaCappedLots, ceiling));
}

/**
 * Calculates aggregate portfolio Greeks across long and short positions.
 */
export function calculatePortfolioGreeks(
  longLeg: { strike: number; dte: number; lots: number; iv?: number } | null,
  shortLeg: { strike: number; dte: number; lots: number; iv?: number } | null,
  spot: number,
  lotSize: number,
  r: number = 0.07,
): PortfolioGreeksResult {
  let longDeltaShares = 0;
  let shortDeltaShares = 0;
  let portGamma = 0;
  let portThetaDayRs = 0;
  let portVegaRs = 0;

  if (longLeg && longLeg.lots > 0) {
    const lQty = longLeg.lots * lotSize;
    const g = computeBsGreeks(spot, longLeg.strike, longLeg.dte, longLeg.iv ?? 0.15, r, 'CE');
    longDeltaShares = lQty * g.delta;
    portGamma += lQty * g.gamma;
    portThetaDayRs += lQty * g.thetaDay; // Long option theta is cost
    portVegaRs += lQty * g.vega;
  }

  if (shortLeg && shortLeg.lots > 0) {
    const sQty = shortLeg.lots * lotSize;
    const g = computeBsGreeks(spot, shortLeg.strike, shortLeg.dte, shortLeg.iv ?? 0.15, r, 'CE');
    shortDeltaShares = sQty * g.delta;
    portGamma -= sQty * g.gamma;          // Short gamma is negative
    portThetaDayRs -= sQty * g.thetaDay;  // Short option theta is positive income
    portVegaRs -= sQty * g.vega;
  }

  const netDeltaShares = longDeltaShares - shortDeltaShares;
  const netDeltaLots = lotSize > 0 ? netDeltaShares / lotSize : 0;

  let deltaZone: PortfolioGreeksResult['deltaZone'] = 'NORMAL_HOLD';
  if (netDeltaShares >= 0 && netDeltaShares <= 20) {
    deltaZone = 'NORMAL_HOLD';
  } else if (netDeltaShares >= -40 && netDeltaShares < 0) {
    deltaZone = 'SLIGHTLY_BEARISH';
  } else if (netDeltaShares < -40) {
    deltaZone = 'DEFENSIVE';
  } else if (netDeltaShares > 30) {
    deltaZone = 'TOO_BULLISH';
  } else {
    deltaZone = 'MILD_BULLISH';
  }

  let gammaStatus: PortfolioGreeksResult['gammaStatus'] = 'EXCELLENT';
  if (portGamma > -0.10) {
    gammaStatus = 'EXCELLENT';
  } else if (portGamma >= -0.15) {
    gammaStatus = 'ACCEPTABLE';
  } else if (portGamma >= -0.20) {
    gammaStatus = 'CAUTION';
  } else {
    gammaStatus = 'DEFENSIVE';
  }

  return {
    longDeltaShares: Number(longDeltaShares.toFixed(2)),
    shortDeltaShares: Number(shortDeltaShares.toFixed(2)),
    netDeltaShares: Number(netDeltaShares.toFixed(2)),
    netDeltaLots: Number(netDeltaLots.toFixed(2)),
    portfolioGamma: Number(portGamma.toFixed(4)),
    portfolioThetaDayRs: Number(portThetaDayRs.toFixed(2)),
    portfolioVegaRs: Number(portVegaRs.toFixed(2)),
    deltaZone,
    gammaStatus,
  };
}

/**
 * Recommends optimal short strikes for a low-gamma diagonal call strategy
 * by filtering candidates, calculating Greeks, scoring by Theta/|Gamma|,
 * and dynamically sizing the short leg.
 */
export function recommendDiagonalStrikes(params: {
  spot: number;
  lotSize?: number;
  frontExpiry: string;
  frontDte: number;
  strikes: number[];
  quotes?: Record<number, { ceLtp?: number; ceIv?: number; ceBid?: number; ceAsk?: number }>;
  longLeg?: { strike: number; expiry: string; dte: number; lots: number; iv?: number; bid?: number; ask?: number };
  /** Max bid/ask spread (% of mid) for a strike to count as liquid. Default MAX_SPREAD_PCT. */
  maxSpreadPct?: number;
  targetNetDelta?: number;
  maxShortRatio?: number;
  maxShortLots?: number;
  minGammaLimit?: number;
  /** All listed expiries for the underlying; when given, "monthly" is judged against this list. */
  listedExpiries?: string[];
}): DiagonalAdvisorRecommendation {
  const spot = params.spot;
  const lotSize = params.lotSize ?? 65;
  const targetNetDelta = params.targetNetDelta ?? 13 * (params.longLeg?.lots ?? 3) / 3;
  const maxShortRatio = params.maxShortRatio ?? 1.25;
  const maxShortLots = params.maxShortLots ?? 6;
  const minGammaLimit = params.minGammaLimit ?? -0.20;
  const maxSpreadPct = params.maxSpreadPct ?? MAX_SPREAD_PCT;

  // Default long leg if none provided (ATM 90 DTE, 3 lots)
  const defaultLongStrike = Math.round(spot / 50) * 50;
  const longLeg = params.longLeg ?? {
    strike: defaultLongStrike,
    expiry: '2026-12-31',
    dte: 85,
    lots: 3,
    iv: 0.15,
  };

  const longGreeks = computeBsGreeks(spot, longLeg.strike, longLeg.dte, longLeg.iv ?? 0.15, 0.07, 'CE');
  const totalLongDeltaShares = longLeg.lots * lotSize * longGreeks.delta;

  const candidates: CandidateStrike[] = [];

  for (const strike of params.strikes) {
    if (strike <= spot) continue; // Only OTM strikes for short leg

    const quote = params.quotes?.[strike];
    const ltp = quote?.ceLtp ?? 0;
    const iv = (quote?.ceIv && quote.ceIv > 0) ? quote.ceIv : 0.14;

    const greeks = computeBsGreeks(spot, strike, params.frontDte, iv, 0.07, 'CE');
    const delta = greeks.delta;

    // Filter out extreme delta
    if (delta < 0.05 || delta > 0.40) continue;

    const score = scoreShortCall(greeks.thetaDay, greeks.gamma);
    let recommendedLots = calculateRequiredShortLots(
      totalLongDeltaShares,
      targetNetDelta,
      delta,
      lotSize,
      maxShortRatio,
      maxShortLots,
    );
    // Gamma budget: trim until projected gamma sits inside 75% of the emergency floor.
    const gammaBudget = minGammaLimit * GAMMA_FIT_FRACTION;
    while (
      recommendedLots > 1 &&
      calculatePortfolioGreeks(longLeg, { strike, dte: params.frontDte, lots: recommendedLots, iv }, spot, lotSize)
        .portfolioGamma < gammaBudget
    ) {
      recommendedLots -= 1;
    }

    // Simulated resulting position Greeks
    const simPort = calculatePortfolioGreeks(
      longLeg,
      { strike, dte: params.frontDte, lots: recommendedLots, iv },
      spot,
      lotSize,
    );

    let classification: CandidateStrike['classification'] = 'out_of_bounds';
    let reason = '';

    if (delta >= 0.15 && delta <= 0.22) {
      classification = 'optimal';
      reason = `Target 0.15-0.22Δ band. Ranked by closeness to ${SHORT_TARGET_DELTA}Δ; score ${score.toFixed(0)} (theta/|gamma|) breaks ties.`;
    } else if (delta >= 0.12 && delta < 0.15) {
      classification = 'conservative';
      reason = 'Safer upside buffer, lower gamma risk, but collects less premium/theta.';
    } else if (delta > 0.22 && delta <= 0.28) {
      classification = 'aggressive';
      reason = 'Higher theta income, but increased negative gamma risk on bullish rally.';
    } else {
      classification = 'out_of_bounds';
      reason = delta < 0.12 ? 'Delta too low (<0.12); insufficient premium.' : 'Delta too high (>0.28); high gamma danger.';
    }

    const bid = quote?.ceBid && quote.ceBid > 0 ? quote.ceBid : null;
    const ask = quote?.ceAsk && quote.ceAsk > 0 ? quote.ceAsk : null;
    const spreadPct = bidAskSpreadPct(bid, ask);
    const liquid = spreadPct != null && spreadPct <= maxSpreadPct;
    if (!liquid) {
      reason = (spreadPct == null ? 'No two-sided quote - not tradable.' : `Bid/ask spread ${spreadPct.toFixed(1)}% > ${maxSpreadPct}% - illiquid.`) + ' ' + reason;
    }

    candidates.push({
      bid, ask, spreadPct: spreadPct == null ? null : Number(spreadPct.toFixed(2)), liquid,
      strike,
      expiry: params.frontExpiry,
      dte: params.frontDte,
      ltp,
      iv: Number((iv * (iv <= 1 ? 100 : 1)).toFixed(1)),
      delta: Number(delta.toFixed(3)),
      gamma: Number(greeks.gamma.toFixed(6)),
      thetaDay: Number(greeks.thetaDay.toFixed(2)),
      score: Number(score.toFixed(0)),
      recommendedLots,
      resultingNetDeltaShares: simPort.netDeltaShares,
      resultingNetGamma: simPort.portfolioGamma,
      resultingNetThetaRs: simPort.portfolioThetaDayRs,
      classification,
      reason,
    });
  }

  // Rank like the live strategy: optimal first; within a class, closest to the target delta wins and
  // Theta/|Gamma| only orders strikes within TIE_BREAK_DELTA_BAND of the closest one.
  const diffOf = (c: CandidateStrike) => Math.abs(c.delta - SHORT_TARGET_DELTA);
  const closestOptimal = Math.min(
    ...candidates.filter((c) => c.liquid && c.classification === 'optimal').map(diffOf),
    Infinity,
  );
  const tier = (c: CandidateStrike) =>
    c.classification === 'optimal' && diffOf(c) <= closestOptimal + TIE_BREAK_DELTA_BAND ? 0 : 1;
  candidates.sort((a, b) => {
    if (a.liquid !== b.liquid) return a.liquid ? -1 : 1;   // illiquid strikes are never ranked above a liquid one
    if (a.classification === 'optimal' && b.classification !== 'optimal') return -1;
    if (b.classification === 'optimal' && a.classification !== 'optimal') return 1;
    if (tier(a) !== tier(b)) return tier(a) - tier(b);
    if (tier(a) === 0) return b.score - a.score;
    return diffOf(a) - diffOf(b);
  });

  const warnings: string[] = [];
  if (params.frontExpiry >= longLeg.expiry) {
    warnings.push(`Front expiry ${params.frontExpiry} is not before the long expiry ${longLeg.expiry}; the short would outlive the long.`);
  }

  const longSpread = bidAskSpreadPct(longLeg.bid, longLeg.ask);
  if (params.longLeg && longSpread != null && longSpread > maxSpreadPct) {
    warnings.push(`Long ${longLeg.strike} CE bid/ask spread is ${longSpread.toFixed(1)}% (> ${maxSpreadPct}%) - exiting or rolling it will cost slippage.`);
  }
  if (candidates.length > 0 && !candidates.some(c => c.liquid)) {
    warnings.push(`No short strike has a two-sided quote within a ${maxSpreadPct}% bid/ask spread.`);
  }

  const bestCandidate = candidates.length > 0 && candidates[0].liquid ? candidates[0] : null;

  return {
    spot,
    lotSize,
    longLeg: {
      strike: longLeg.strike,
      expiry: longLeg.expiry,
      dte: longLeg.dte,
      lots: longLeg.lots,
      delta: Number(longGreeks.delta.toFixed(3)),
      gamma: Number(longGreeks.gamma.toFixed(6)),
    },
    bestCandidate,
    candidates,
    summary: {
      targetNetDelta,
      maxShortRatio,
      regime: totalLongDeltaShares > 0 ? 'ACTIVE_DIAGONAL' : 'INITIAL_SETUP',
      warnings,
    },
  };
}
