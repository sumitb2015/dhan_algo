/**
 * Options Monitor Mathematical Engine
 * Computes Black-Scholes pricing, Greeks (Delta, Gamma, Theta, Vega),
 * portfolio Greeks attribution, 2D payoff curves (Expiry & T+0),
 * strike clearances, and breakevens for arbitrary option legs.
 */

export type OptType = 'CE' | 'PE';
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
    defaultSpot: 24812.30,
    strikeStep: 50,
    lotSize: 75,
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
}

// ── Black-Scholes Core ───────────────────────────────────────────────────────

function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export function computeBsGreeks(
  type: OptType,
  spot: number,
  strike: number,
  timeYears: number,
  iv: number,
  lotSize: number,
  r = 0.065
): { price: number; delta: number; gamma: number; theta: number; vega: number } {
  const t = Math.max(timeYears, 0.0001);
  const v = Math.max(iv, 0.01);
  const sqrtT = Math.sqrt(t);

  const d1 = (Math.log(spot / strike) + (r + 0.5 * v * v) * t) / (v * sqrtT);
  const d2 = d1 - v * sqrtT;

  let price = 0;
  let delta = 0;

  if (type === 'CE') {
    price = spot * normCdf(d1) - strike * Math.exp(-r * t) * normCdf(d2);
    delta = normCdf(d1);
  } else {
    price = strike * Math.exp(-r * t) * normCdf(-d2) - spot * normCdf(-d1);
    delta = normCdf(d1) - 1;
  }

  // Gamma (same for Call & Put)
  const gamma = normPdf(d1) / (spot * v * sqrtT);

  // Vega (derivative with respect to IV fraction; rupees per 1% change)
  const rawVega = spot * sqrtT * normPdf(d1);
  const vegaPerPercent = (rawVega * 0.01) * lotSize;

  // Theta (decay per day in rupees)
  let rawTheta = 0;
  const term1 = -(spot * normPdf(d1) * v) / (2 * sqrtT);
  if (type === 'CE') {
    const term2 = -r * strike * Math.exp(-r * t) * normCdf(d2);
    rawTheta = (term1 + term2) / 365;
  } else {
    const term2 = r * strike * Math.exp(-r * t) * normCdf(-d2);
    rawTheta = (term1 + term2) / 365;
  }
  const thetaPerDay = rawTheta * lotSize;

  return {
    price: Math.max(0.05, Math.round(price * 20) / 20),
    delta: Math.round(delta * 100) / 100,
    gamma: Math.round(gamma * 10000) / 10000,
    theta: Math.round(thetaPerDay),
    vega: Math.round(vegaPerPercent),
  };
}

// ── Payoff Curve Generation ──────────────────────────────────────────────────

export interface PayoffPoint {
  spot: number;
  pnlExpiry: number;
  pnlToday: number;
}

export function generatePayoffCurve(
  legs: OptionLegModel[],
  spot: number,
  lotSize: number,
  timeRemainingYears: number = 2 / 365,
  baseIv: number = 0.145,
  strikeStep: number = 50
): { points: PayoffPoint[]; minPnl: number; maxPnl: number; breakevens: number[] } {
  if (legs.length === 0) {
    return { points: [], minPnl: 0, maxPnl: 0, breakevens: [] };
  }

  const strikes = legs.map((l) => l.strike);
  const minStrike = Math.min(...strikes, spot);
  const maxStrike = Math.max(...strikes, spot);
  const span = Math.max(strikeStep * 10, spot * 0.035, (maxStrike - minStrike) * 0.8);

  const startSpot = Math.round((spot - span) / strikeStep) * strikeStep;
  const endSpot = Math.round((spot + span) / strikeStep) * strikeStep;
  const stepCount = 80;
  const stepSize = (endSpot - startSpot) / stepCount;

  const sampleSpots = new Set<number>();
  for (let i = 0; i <= stepCount; i++) {
    sampleSpots.add(Math.round(startSpot + i * stepSize));
  }
  sampleSpots.add(Math.round(spot));
  for (const s of strikes) sampleSpots.add(s);

  const sortedSpots = Array.from(sampleSpots).sort((a, b) => a - b);
  const points: PayoffPoint[] = [];

  let minPnl = Infinity;
  let maxPnl = -Infinity;

  for (const s of sortedSpots) {
    let pnlExp = 0;
    let pnlNow = 0;

    for (const leg of legs) {
      const qty = leg.lots * lotSize;
      const isSell = leg.side === 'SELL';

      // Payoff at Expiry
      const intrinsicAtExp = leg.type === 'CE' ? Math.max(0, s - leg.strike) : Math.max(0, leg.strike - s);
      const legPnlExp = isSell ? (leg.entryPrice - intrinsicAtExp) * qty : (intrinsicAtExp - leg.entryPrice) * qty;
      pnlExp += legPnlExp;

      // Payoff Today (T+0 via Black-Scholes)
      const g = computeBsGreeks(leg.type, s, leg.strike, timeRemainingYears, leg.iv || baseIv, lotSize);
      const legPnlNow = isSell ? (leg.entryPrice - g.price) * qty : (g.price - leg.entryPrice) * qty;
      pnlNow += legPnlNow;
    }

    const roundedExp = Math.round(pnlExp);
    const roundedNow = Math.round(pnlNow);

    if (roundedExp < minPnl) minPnl = roundedExp;
    if (roundedExp > maxPnl) maxPnl = roundedExp;

    points.push({
      spot: s,
      pnlExpiry: roundedExp,
      pnlToday: roundedNow,
    });
  }

  // Find Breakevens on Expiry curve
  const breakevens: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    if ((p0.pnlExpiry <= 0 && p1.pnlExpiry >= 0) || (p0.pnlExpiry >= 0 && p1.pnlExpiry <= 0)) {
      if (p1.pnlExpiry !== p0.pnlExpiry) {
        const be = p0.spot + ((0 - p0.pnlExpiry) * (p1.spot - p0.spot)) / (p1.pnlExpiry - p0.pnlExpiry);
        breakevens.push(Math.round(be));
      }
    }
  }

  return { points, minPnl, maxPnl, breakevens };
}

// ── Portfolio Greeks Aggregation ─────────────────────────────────────────────

export interface PortfolioGreeks {
  netDelta: number;
  rupeeDelta: number; // ₹ per 1% underlying move
  netGamma: number;
  gammaRiskLabel: 'Low' | 'Moderate' | 'High Acceleration';
  netTheta: number;   // ₹ / day
  thetaPerHour: number; // ₹ / trading hour (6.25 hrs)
  netVega: number;    // ₹ / 1% India VIX move
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
  lotSize: number
): PortfolioGreeks {
  if (legs.length === 0) {
    return {
      netDelta: 0,
      rupeeDelta: 0,
      netGamma: 0,
      gammaRiskLabel: 'Low',
      netTheta: 0,
      thetaPerHour: 0,
      netVega: 0,
      totalMtm: 0,
      mtmPct: 0,
      estimatedMargin: 0,
      maxProfit: 0,
      maxLoss: 0,
      popPct: 50,
    };
  }

  let totalDelta = 0;
  let totalGamma = 0;
  let totalTheta = 0;
  let totalVega = 0;
  let totalMtm = 0;
  let totalEntryValue = 0;
  let shortCount = 0;

  for (const leg of legs) {
    const qty = leg.lots * lotSize;
    const sign = leg.side === 'SELL' ? -1 : 1;

    // Delta of the position in share equivalents
    const legDelta = sign * leg.delta * qty;
    totalDelta += legDelta;

    // Gamma
    totalGamma += sign * leg.gamma * qty;

    // Theta (Selling options yields positive theta, buying yields negative)
    const legTheta = -sign * leg.theta * leg.lots;
    totalTheta += legTheta;

    // Vega (Selling options yields negative vega, buying yields positive)
    const legVega = sign * leg.vega * leg.lots;
    totalVega += legVega;

    // MTM
    const pnl = leg.side === 'SELL'
      ? (leg.entryPrice - leg.ltp) * qty
      : (leg.ltp - leg.entryPrice) * qty;
    totalMtm += pnl;

    totalEntryValue += leg.entryPrice * qty;
    if (leg.side === 'SELL') shortCount += leg.lots;
  }

  // Rupee Delta = Total share delta * 1% of spot price
  const rupeeDelta = Math.round(totalDelta * (spot * 0.01));

  // Gamma acceleration classification
  const absGamma = Math.abs(totalGamma);
  const gammaRiskLabel = absGamma > 0.35 ? 'High Acceleration' : absGamma > 0.15 ? 'Moderate' : 'Low';

  // Margin estimation (~₹1.84L per short index lot baseline in India)
  const estimatedMargin = Math.max(50000, shortCount * 184000);

  const mtmPct = estimatedMargin > 0 ? (totalMtm / estimatedMargin) * 100 : 0;
  const thetaPerHour = Math.round(totalTheta / 6.25);

  return {
    netDelta: Math.round(totalDelta * 100) / 100,
    rupeeDelta,
    netGamma: Math.round(totalGamma * 10000) / 10000,
    gammaRiskLabel,
    netTheta: Math.round(totalTheta),
    thetaPerHour,
    netVega: Math.round(totalVega),
    totalMtm: Math.round(totalMtm),
    mtmPct: Math.round(mtmPct * 100) / 100,
    estimatedMargin,
    maxProfit: Math.max(0, Math.round(totalEntryValue)),
    maxLoss: 'Unlimited',
    popPct: 68,
  };
}
