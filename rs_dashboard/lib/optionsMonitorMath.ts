/**
 * Options Monitor Mathematical Engine
 * Computes Black-Scholes pricing, Greeks (Delta, Gamma, Theta, Vega),
 * portfolio Greeks attribution, 2D payoff curves (Expiry & T+0),
 * strike clearances, and breakevens for arbitrary option legs.
 */

import { buildPayoffModel, payoffAt } from './optionsPayoff.ts';
import {
  type OptType,
  CALENDAR_DAYS_PER_YEAR,
  riskNeutralProbAbove,
  calculateTimeToExpiryYears,
  computeBsGreeks,
  computeBsGreeksExact,
  computeGreeksTickPrice,
  rollForward,
  futureQuote,
  isIsoDate,
  type FutureQuote,
} from './optionsPricing.ts';

// The pricing core lives in optionsPricing.ts. Re-exported so existing imports from this module keep working.
export { computeBsGreeks, computeBsGreeksExact, computeGreeksTickPrice, calculateTimeToExpiryYears, type FutureQuote };
export type { OptType, BsGreeksExact } from './optionsPricing.ts';


export type Side = 'BUY' | 'SELL';

export interface UnderlyingConfig {
  symbol: string;
  name: string;
  defaultSpot: number;
  strikeStep: number;
  lotSize: number;
  exchange: string;
}

export const UNDERLYINGS: Record<string, UnderlyingConfig> = {
  NIFTY: {
    symbol: 'NIFTY',
    name: 'NIFTY 50',
    defaultSpot: 23400.00,
    strikeStep: 50,
    lotSize: 65,
    exchange: 'NSE',
  },
  BANKNIFTY: {
    symbol: 'BANKNIFTY',
    name: 'BANK NIFTY',
    defaultSpot: 51240.00,
    strikeStep: 100,
    lotSize: 30,
    exchange: 'NSE',
  },
  FINNIFTY: {
    symbol: 'FINNIFTY',
    name: 'FIN NIFTY',
    defaultSpot: 23650.00,
    strikeStep: 50,
    lotSize: 65,
    exchange: 'NSE',
  },
  SENSEX: {
    symbol: 'SENSEX',
    name: 'BSE SENSEX',
    defaultSpot: 81450.00,
    strikeStep: 100,
    lotSize: 20,
    exchange: 'BSE',
  },
};

export interface PositionGuard {
  target: string;        // take-profit price (₹)
  sl: string;            // stop-loss price (₹); also the anchor for trailing SL
  trailEnabled: boolean; // checkbox: trail SL 1:1 with profit from the configured SL level
  bestPrice: number;     // best price achieved (max LTP for long, min LTP for short); 0 = not yet set
  triggered: boolean;    // prevents double-fire while order is in flight
  triggerReason?: string;// 'Target hit' | 'SL hit' | 'Trail SL hit'
}

export interface OptionLegModel {
  id: string;
  type: OptType;
  side: Side;
  strike: number;
  lots: number;
  qty: number;
  entryPrice: number;
  ltp: number;
  delta: number;
  gamma: number;
  theta: number; // ₹ / day
  vega: number;  // ₹ / 1% IV
  iv: number;    // fraction e.g. 0.145
  expiry?: string; // e.g. '2026-09-15'
  symbol?: string; // contract symbol
  underlying?: string; // e.g. 'NIFTY' — the underlying this leg's strike/expiry/securityId resolve against
  securityId?: string; // Dhan security id captured from the chain at leg-creation time
  isEntered?: boolean; // true if position has been entered/executed
  guard?: PositionGuard;
}

/**
 * Formats full expiry date (e.g. "2026-09-15") into compact short-form (e.g. "15-Sep").
 */
export function formatShortExpiry(expiryStr?: string): string {
  if (!expiryStr) return '—';
  try {
    const s = expiryStr.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const parts = s.split('-').map(Number);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const d = parts[2];
      const m = parts[1];
      return `${d < 10 ? '0' + d : d}-${months[m - 1]}`;
    }
    const dt = new Date(s);
    if (!isNaN(dt.getTime())) {
      const day = dt.getDate();
      const mon = dt.toLocaleString('en-US', { month: 'short' });
      return `${day < 10 ? '0' + day : day}-${mon}`;
    }
    return s;
  } catch {
    return expiryStr;
  }
}

// ── Payoff Curve Generation ──────────────────────────────────────────────────

export interface PayoffPoint {
  spot: number;
  pnlExpiry: number;
  pnlToday: number;
}

/** Mean IV across legs that carry a usable (positive) IV, falling back to `fallback` when none do. */
function computeAvgIv(legs: OptionLegModel[], fallback: number): number {
  const ivs = legs.map((l) => l.iv).filter((iv): iv is number => typeof iv === 'number' && iv > 0);
  return ivs.length > 0 ? ivs.reduce((s, iv) => s + iv, 0) / ivs.length : fallback;
}

export interface SdLevels {
  lo2: number;
  lo1: number;
  hi1: number;
  hi2: number;
  exactLo2: number;
  exactLo1: number;
  exactHi1: number;
  exactHi2: number;
  /** Provenance of the bands above, so the UI can show *why* they sit where they do rather
   *  than rendering unexplained gridlines. An SD band is just `spot * vol * sqrt(t)`, so it
   *  moves whenever the underlying's vol or the days-to-expiry move — without these on
   *  screen, a band that looks "wrong" against another tool is impossible to diagnose. */
  points1: number;
  points2: number;
  vol: number;   // underlying-level vol used, as a fraction (e.g. 0.1313)
  days: number;  // calendar days to expiry
}

/**
 * Multi-expiry books (calendar / diagonal / flyagonal): "expiry" means the FRONT (earliest) expiry.
 * A leg that expires later still has time value then, so it is priced with Black-Scholes over its
 * residual life instead of intrinsic. Returns years of life each leg has left AT the front expiry;
 * 0 for legs on the front expiry (or with no expiry), which keeps single-expiry books unchanged.
 */
function legExtraYears(legs: OptionLegModel[]): number[] {
  const exps = legs.map((l) => l.expiry).filter((e): e is string => !!e);
  const front = exps.length ? [...exps].sort()[0] : '';
  const frontYears = front ? calculateTimeToExpiryYears(front) : 0;
  return legs.map((l) =>
    l.expiry && l.expiry !== front ? Math.max(0, calculateTimeToExpiryYears(l.expiry) - frontYears) : 0,
  );
}

export function generatePayoffCurve(
  legs: OptionLegModel[],
  spot: number,
  lotSize: number,
  timeRemainingYears: number = 2 / CALENDAR_DAYS_PER_YEAR,
  baseIv: number = 0.145,
  strikeStep: number = 50,
  futurePrice?: number,
  targetTimeRemainingYears?: number,
  /** ISO expiry of `futurePrice`. Each leg's forward is the future rolled to ITS expiry; without it the legs price off spot·e^{rT}. */
  futureExpiry?: string,
): { points: PayoffPoint[]; minPnl: number; maxPnl: number; breakevens: number[]; sdLevels: SdLevels | null } {
  if (legs.length === 0) {
    return { points: [], minPnl: 0, maxPnl: 0, breakevens: [], sdLevels: null };
  }

  const strikes = legs.map((l) => l.strike);
  const minStrike = strikes.length > 0 ? Math.min(...strikes, spot) : spot;
  const maxStrike = strikes.length > 0 ? Math.max(...strikes, spot) : spot;

  // Pad wings symmetrically so strikes, breakevens and tails are cleanly visible
  const wingPad = strikeStep * 6;
  const pctSpan = spot * 0.04;
  const lo = Math.min(spot - pctSpan, minStrike - wingPad);
  const hi = Math.max(spot + pctSpan, maxStrike + wingPad);

  // Symmetrize bounds around current spot so spot sits in the center
  const maxDiff = Math.max(spot - lo, hi - spot);
  const symLo = Math.round((spot - maxDiff) / strikeStep) * strikeStep;
  const symHi = Math.round((spot + maxDiff) / strikeStep) * strikeStep;

  // 1SD / 2SD expected-move levels, centred on spot. The chart's x-axis is numeric, so these
  // are kept exact — never snapped to a strike or a sample point.
  //
  // The vol here is `baseIv` — the ATM IV of the selected expiry (or India VIX as fallback).
  // Sensibull uses the selected expiry's ATM IV (e.g. 13.13% on 4d out), yielding exactly
  // ±321.7 pts (1.4%) 1SD and ±643.3 pts (2.7%) 2SD.
  const t = Math.max(timeRemainingYears, 0.0001);
  const sd1Move = spot * baseIv * Math.sqrt(t);
  const sd2Move = 2 * sd1Move;
  const p1 = Math.round(sd1Move * 10) / 10;
  const p2 = Math.round(sd2Move * 10) / 10;
  const sdLevels: SdLevels = {
    lo2: Math.round(spot - sd2Move),
    lo1: Math.round(spot - sd1Move),
    hi1: Math.round(spot + sd1Move),
    hi2: Math.round(spot + sd2Move),
    exactLo2: Math.round((spot - sd2Move) * 10) / 10,
    exactLo1: Math.round((spot - sd1Move) * 10) / 10,
    exactHi1: Math.round((spot + sd1Move) * 10) / 10,
    exactHi2: Math.round((spot + sd2Move) * 10) / 10,
    points1: p1,
    points2: p2,
    vol: baseIv,
    days: Math.round(t * CALENDAR_DAYS_PER_YEAR * 100) / 100,
  };

  const sampleSpots = new Set<number>();
  const stepCount = 120;
  for (let i = 0; i <= stepCount; i++) {
    sampleSpots.add(Math.round(symLo + ((symHi - symLo) * i) / stepCount));
  }
  // Guarantee exact evaluation at current spot and every strike kink, so the expiry curve
  // keeps a crisp vertex at each strike instead of a sampled-over corner.
  sampleSpots.add(Math.round(spot));
  for (const s of strikes) sampleSpots.add(s);

  const sortedSpots = Array.from(sampleSpots).sort((a, b) => a - b);

  const future = futureQuote(futurePrice, futureExpiry);
  const evalTime = typeof targetTimeRemainingYears === 'number' ? targetTimeRemainingYears : timeRemainingYears;
  const frontYears = Math.max(timeRemainingYears, 0.0001);

  // The pricing is the central payoff library's (lib/optionsPayoff.ts): each leg at its own expiry and IV, Black-76 on the futures,
  // the futures basis decaying to zero at expiry. This function only keeps its legacy grid (the sampled spots above) and rounding.
  const model = buildPayoffModel({
    spot,
    samples: sortedSpots,
    legs: toLibraryLegs(legs, lotSize, baseIv, frontYears, future),
    daysForward: Math.max(0, (frontYears - Math.max(evalTime, 0.0001)) * CALENDAR_DAYS_PER_YEAR),
    atmIv: baseIv,
    fallbackIv: baseIv,
  });
  if (!model) return { points: [], minPnl: 0, maxPnl: 0, breakevens: [], sdLevels };

  const points: PayoffPoint[] = model.points.map((p, i) => ({
    spot: p.spot,
    pnlExpiry: Math.round(p.pnl),
    pnlToday: Math.round(model.today[i].pnl),
  }));
  const minPnl = Math.min(...points.map(p => p.pnlExpiry));
  const maxPnl = Math.max(...points.map(p => p.pnlExpiry));
  // Break-evens inside the sampled window only (as before), solved on the model rather than interpolated between rounded samples.
  const lo0 = points[0].spot;
  const hi0 = points[points.length - 1].spot;
  const breakevens = Array.from(new Set(model.breakevens.filter(b => b >= lo0 && b <= hi0).map(b => Math.round(b)))).sort((a, b) => a - b);

  return { points, minPnl, maxPnl, breakevens, sdLevels };
}

/**
 * Option legs → the central payoff library's input. `years` is the time to the FRONT expiry (when known); a later leg gets its residual
 * from `legExtraYears`, so the book is valued as of the front expiry exactly as the library does everywhere else.
 */
function toLibraryLegs(legs: OptionLegModel[], lotSize: number, baseIv: number, frontYears: number, future?: FutureQuote | null) {
  const extra = legExtraYears(legs);
  return legs.map((leg, li) => ({
    type: leg.type,
    strike: leg.strike,
    expiry: leg.expiry ?? '',
    qty: (leg.side === 'SELL' ? -1 : 1) * (leg.qty || leg.lots * lotSize),
    entryPrice: Math.max(leg.entryPrice, 1e-9),
    iv: leg.iv || baseIv,
    years: Math.max(frontYears, 0.0001) + extra[li],
    forward: future && leg.expiry && isIsoDate(leg.expiry) ? rollForward(future.price, future.expiry, leg.expiry) : undefined,
  }));
}

/**
 * P&L of the whole leg set at a single spot on the front expiry: intrinsic value, plus residual
 * time value for any leg that expires later (see legExtraYears).
 */
export function computeExpiryPnlAtSpot(legs: OptionLegModel[], spot: number, lotSize: number, future?: FutureQuote | null): number {
  if (legs.length === 0 || !(spot > 0)) return 0;
  return payoffAt({ spot, legs: toLibraryLegs(legs, lotSize, 0.15, 0.01, future), fallbackIv: 0.15 }, [spot], 'expiry')[0];
}

/**
 * Risk-panel stats for a book on several expiries, measured on the front-expiry curve: net premium,
 * breakevens, max profit / loss. Same shape as basketStrategies.computePayoff so the Baskets page
 * can substitute it. The curve is no longer piecewise linear (a later leg is curved), so extremes
 * come from a dense grid, not just the strikes. "Unlimited" is a position fact (net signed qty).
 * The pricing is the central payoff library's.
 */
export function computeMultiExpiryStats(legs: OptionLegModel[], spot: number, lotSize: number, future?: FutureQuote | null) {
  const strikes = legs.map((l) => l.strike);
  const centre = spot > 0 ? spot : (Math.min(...strikes) + Math.max(...strikes)) / 2;
  const lo = Math.min(centre * 0.6, Math.min(...strikes) * 0.9);
  const hi = Math.max(centre * 1.4, Math.max(...strikes) * 1.1);
  const xs = new Set<number>([1, ...strikes]);
  const n = 1200;
  for (let i = 0; i <= n; i++) xs.add(lo + ((hi - lo) * i) / n);
  const grid = [...xs].sort((a, b) => a - b);
  const ys0 = payoffAt({ spot: centre, legs: toLibraryLegs(legs, lotSize, 0.15, 0.01, future), fallbackIv: 0.15 }, grid, 'expiry');
  const points = grid.map((x, i) => ({ x, y: ys0[i] }));

  const breakevens: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if ((a.y < 0 && b.y >= 0) || (a.y >= 0 && b.y < 0)) {
      breakevens.push(a.x + (a.y === b.y ? 0 : -a.y / (b.y - a.y)) * (b.x - a.x));
    }
  }

  const q = (l: OptionLegModel) => l.qty || l.lots * lotSize;
  const netShort = (t: 'CE' | 'PE') => legs.filter((l) => l.type === t)
    .reduce((s, l) => s + (l.side === 'SELL' ? q(l) : -q(l)), 0);
  const netCall = netShort('CE'), netPut = netShort('PE');
  const maxProfitUnlimited = netCall < 0;
  const maxLossUnlimited = netCall > 0 || netPut > 0;
  const ys = points.map((p) => p.y);
  return {
    points, breakevens,
    maxProfit: maxProfitUnlimited ? Infinity : Math.max(...ys),
    maxLoss: maxLossUnlimited ? -Infinity : Math.min(...ys),
    maxProfitUnlimited, maxLossUnlimited,
    rightWing: (maxProfitUnlimited ? 'profit' : netCall > 0 ? 'loss' : null) as 'profit' | 'loss' | null,
    leftWing: (netPut > 0 ? 'loss' : null) as 'loss' | null,
    netPremium: legs.reduce((s, l) => s + (l.side === 'SELL' ? 1 : -1) * l.entryPrice * q(l), 0),
  };
}

/**
 * Exact max profit / max loss for a bounded-risk leg combination, found by evaluating the
 * piecewise-linear expiry payoff at its only possible extrema: spot=0, every strike (kink), and
 * a point far beyond the widest strike (surrogate for the flat asymptote as spot -> infinity).
 * Caller must already know the structure is bounded in both directions (see hasUnlimitedLoss /
 * hasUnlimitedProfit in computePortfolioMetrics) — this does not itself detect unbounded risk.
 */
function computeBoundedPnlExtremes(legs: OptionLegModel[], lotSize: number): { maxProfit: number; maxLoss: number } {
  const strikes = legs.map((l) => l.strike);
  const maxStrike = strikes.length > 0 ? Math.max(...strikes) : 0;
  const evalPoints = [0, maxStrike * 3 + 10000, ...strikes];
  // A later-expiry leg curves the payoff, so extrema can sit between strikes: sample densely.
  if (legExtraYears(legs).some((y) => y > 0)) {
    const lo = Math.max(1, Math.min(...strikes) * 0.6), hi = maxStrike * 1.4;
    for (let i = 0; i <= 1200; i++) evalPoints.push(lo + ((hi - lo) * i) / 1200);
  }

  let min = Infinity;
  let max = -Infinity;
  for (const s of evalPoints) {
    const pnl = computeExpiryPnlAtSpot(legs, s, lotSize);
    if (pnl < min) min = pnl;
    if (pnl > max) max = pnl;
  }
  return { maxProfit: Math.round(max), maxLoss: Math.round(min) };
}

// ── Portfolio Greeks Aggregation ─────────────────────────────────────────────

export interface PortfolioGreeks {
  netDelta: number;     // in lot units (e.g. -0.17)
  shareDelta: number;   // in share units (multiplied by lot size, e.g. -11)
  rupeeDelta: number;   // ₹ per 1% underlying move
  netGamma: number;     // in lot units
  shareGamma: number;   // in share units (multiplied by lot size, e.g. -0.19)
  gammaRiskLabel: 'Low' | 'Moderate' | 'High Acceleration';
  netTheta: number;     // ₹ / day
  thetaPerHour: number; // ₹ / trading hour (6.25 hrs)
  netVega: number;    // ₹ / 1% India VIX move
  totalDecay: number; // ₹ total extrinsic value / decay to expiry
  totalMtm: number;
  mtmPct: number;
  estimatedMargin: number;
  maxProfit: number | 'Unlimited';
  maxLoss: number | 'Unlimited';
  popPct: number;
}

export function computePortfolioMetrics(
  legs: OptionLegModel[],
  spot: number,
  lotSize: number,
  timeYears: number = 2 / CALENDAR_DAYS_PER_YEAR,
  breakevens: number[] = [],
  strikeStep: number = 50
): PortfolioGreeks {
  if (legs.length === 0) {
    return {
      netDelta: 0,
      shareDelta: 0,
      rupeeDelta: 0,
      netGamma: 0,
      shareGamma: 0,
      gammaRiskLabel: 'Low',
      netTheta: 0,
      thetaPerHour: 0,
      netVega: 0,
      totalDecay: 0,
      totalMtm: 0,
      mtmPct: 0,
      estimatedMargin: 0,
      maxProfit: 0,
      maxLoss: 0,
      popPct: 50,
    };
  }

  let totalLotDelta = 0;
  let totalGamma = 0;
  let totalTheta = 0;
  let totalVega = 0;
  let totalDecay = 0;
  let totalMtm = 0;
  let shortCount = 0;

  for (const leg of legs) {
    const qty = leg.qty || leg.lots * lotSize;
    const sign = leg.side === 'SELL' ? -1 : 1;
    const effectiveLots = leg.lots || Math.max(1, Math.round(qty / (lotSize || 1)));

    // Net Delta in lot delta units
    const legDeltaLots = sign * effectiveLots * leg.delta;
    totalLotDelta += legDeltaLots;

    // Gamma in lot units
    const legGammaLots = sign * effectiveLots * leg.gamma;
    totalGamma += legGammaLots;

    // Theta (₹ / day): Selling options collects decay (+), buying pays decay (-)
    const legThetaRupees = (leg.side === 'SELL' ? 1 : -1) * qty * Math.abs(leg.theta);
    totalTheta += legThetaRupees;

    // Vega (₹ / 1% IV move): Selling options is short vega (-), buying is long vega (+)
    const legVegaRupees = (leg.side === 'SELL' ? -1 : 1) * qty * Math.abs(leg.vega);
    totalVega += legVegaRupees;

    // Extrinsic decay remaining to expiry (₹)
    const intrinsic = leg.type === 'CE' ? Math.max(0, spot - leg.strike) : Math.max(0, leg.strike - spot);
    const extrinsicPerShare = Math.max(0, leg.ltp - intrinsic);
    totalDecay += (leg.side === 'SELL' ? 1 : -1) * extrinsicPerShare * qty;

    // MTM
    const pnl = leg.side === 'SELL'
      ? (leg.entryPrice - leg.ltp) * qty
      : (leg.ltp - leg.entryPrice) * qty;
    totalMtm += pnl;

    if (leg.side === 'SELL') shortCount += effectiveLots;
  }

  // Net quantity per side: >0 means net short -> unbounded risk on that tail
  const netCallQty = legs.filter(l => l.type === 'CE').reduce((s, l) => s + (l.side === 'SELL' ? (l.qty || l.lots * lotSize) : -(l.qty || l.lots * lotSize)), 0);
  const netPutQty  = legs.filter(l => l.type === 'PE').reduce((s, l) => s + (l.side === 'SELL' ? (l.qty || l.lots * lotSize) : -(l.qty || l.lots * lotSize)), 0);
  const hasUnlimitedLoss = netCallQty > 0 || netPutQty > 0;
  const hasUnlimitedProfit = netCallQty < 0;

  // Rupee Delta = Net lot delta * lotSize * 1% of spot price
  const rupeeDelta = Math.round(totalLotDelta * lotSize * (spot * 0.01));

  // Gamma acceleration classification based on lot gamma
  const absGamma = Math.abs(totalGamma);
  const gammaRiskLabel = absGamma > 0.01 ? 'High Acceleration' : absGamma > 0.003 ? 'Moderate' : 'Low';

  // Margin estimation (~₹1.84L per short index lot baseline in India)
  const estimatedMargin = Math.max(50000, shortCount * 184000);

  const mtmPct = estimatedMargin > 0 ? (totalMtm / estimatedMargin) * 100 : 0;
  const thetaPerHour = Math.round(totalTheta / 6.25);

  const boundedExtremes = (!hasUnlimitedProfit || !hasUnlimitedLoss)
    ? computeBoundedPnlExtremes(legs, lotSize)
    : { maxProfit: 0, maxLoss: 0 };

  // POP: probability the strategy finishes in a profit zone at expiry, computed by
  // integrating the risk-neutral lognormal distribution (same N(d2) term the BS
  // pricer uses) over each zone bounded by the actual breakevens — not a delta-sum
  // heuristic, which collapses to ~0% for ATM straddles even though such positions
  // plainly have a real chance of profit. Each zone's profit/loss sign is checked
  // via the exact intrinsic payoff at a point safely inside it.
  const hasIv = legs.some((l) => typeof l.iv === 'number' && l.iv > 0);
  let popPct = 50;
  if (hasIv) {
    const avgIv = computeAvgIv(legs, 0);
    const t = Math.max(timeYears, 0.0001);
    const sorted = [...breakevens].sort((a, b) => a - b);
    const offset = Math.max(strikeStep, spot * 0.05);
    let pop = 0;
    for (let i = 0; i <= sorted.length; i++) {
      const lo = i === 0 ? -Infinity : sorted[i - 1];
      const hi = i === sorted.length ? Infinity : sorted[i];
      const testSpot = lo === -Infinity && hi === Infinity ? spot
        : lo === -Infinity ? hi - offset
        : hi === Infinity ? lo + offset
        : (lo + hi) / 2;
      if (testSpot <= 0) continue;
      if (computeExpiryPnlAtSpot(legs, testSpot, lotSize) <= 0) continue;
      const probAboveLo = lo === -Infinity ? 1 : riskNeutralProbAbove(spot, lo, t, avgIv);
      const probAboveHi = hi === Infinity ? 0 : riskNeutralProbAbove(spot, hi, t, avgIv);
      pop += probAboveLo - probAboveHi;
    }
    popPct = Math.round(Math.min(1, Math.max(0, pop)) * 100);
  }

  const netLotDelta = Math.round(totalLotDelta * 100) / 100;
  const shareDelta = Math.round(totalLotDelta * lotSize * 10) / 10;
  const netGamma = Math.round(totalGamma * 10000) / 10000;
  const shareGamma = Math.round(totalGamma * lotSize * 100) / 100;

  return {
    netDelta: netLotDelta,
    shareDelta,
    rupeeDelta,
    netGamma,
    shareGamma,
    gammaRiskLabel,
    netTheta: Math.round(totalTheta),
    thetaPerHour,
    netVega: Math.round(totalVega),
    totalDecay: Math.round(totalDecay),
    totalMtm: Math.round(totalMtm),
    mtmPct: Math.round(mtmPct * 100) / 100,
    estimatedMargin,
    maxProfit: hasUnlimitedProfit ? 'Unlimited' : boundedExtremes.maxProfit,
    maxLoss: hasUnlimitedLoss ? 'Unlimited' : boundedExtremes.maxLoss,
    popPct,
  };
}

/**
 * Normalizes raw option chain output into sorted numerical strikes and indexed lookup.
 */
export function extractChainStrikes(oc: Record<string, any> | undefined): {
  strikes: number[];
  normalized: Record<number, { ce?: any; pe?: any }>;
} {
  if (!oc || typeof oc !== 'object') return { strikes: [], normalized: {} };
  const normalized: Record<number, { ce?: any; pe?: any }> = {};
  const strikeSet = new Set<number>();

  for (const [k, v] of Object.entries(oc)) {
    const s = Math.round(parseFloat(k));
    if (!isNaN(s) && s > 0) {
      strikeSet.add(s);
      normalized[s] = v;
    }
  }

  const strikes = Array.from(strikeSet).sort((a, b) => a - b);
  return { strikes, normalized };
}

