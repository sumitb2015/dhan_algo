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

  // Vega (derivative with respect to IV fraction; rupees per share per 1% IV change)
  const rawVega = spot * sqrtT * normPdf(d1);
  const vegaPerPercent = rawVega * 0.01;

  // Theta (decay per day in rupees per share, negative)
  let rawTheta = 0;
  const term1 = -(spot * normPdf(d1) * v) / (2 * sqrtT);
  if (type === 'CE') {
    const term2 = -r * strike * Math.exp(-r * t) * normCdf(d2);
    rawTheta = (term1 + term2) / 365;
  } else {
    const term2 = r * strike * Math.exp(-r * t) * normCdf(-d2);
    rawTheta = (term1 + term2) / 365;
  }
  const thetaPerDay = rawTheta;

  return {
    price: Math.max(0.05, Math.round(price * 20) / 20),
    delta: Math.round(delta * 100) / 100,
    gamma: Math.round(gamma * 10000) / 10000,
    theta: Math.round(thetaPerDay * 100) / 100,
    vega: Math.round(vegaPerPercent * 100) / 100,
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

  const sampleSpots = new Set<number>();
  const stepCount = 120;
  for (let i = 0; i <= stepCount; i++) {
    sampleSpots.add(Math.round(symLo + ((symHi - symLo) * i) / stepCount));
  }
  // Guarantee exact evaluation at current spot and every strike kink
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
      const qty = leg.qty || leg.lots * lotSize;
      const isSell = leg.side === 'SELL';

      // Payoff at Expiry (strict piecewise linear intrinsic value)
      const intrinsicAtExp = leg.type === 'CE' ? Math.max(0, s - leg.strike) : Math.max(0, leg.strike - s);
      const legPnlExp = isSell ? (leg.entryPrice - intrinsicAtExp) * qty : (intrinsicAtExp - leg.entryPrice) * qty;
      pnlExp += legPnlExp;

      // Payoff Today (T+0 via Black-Scholes theoretical price)
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

  // Find Breakevens on Expiry curve via linear interpolation of zero crossings
  const rawBreakevens: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    if (p0.pnlExpiry === 0) {
      rawBreakevens.push(p0.spot);
      continue;
    }
    if ((p0.pnlExpiry < 0 && p1.pnlExpiry > 0) || (p0.pnlExpiry > 0 && p1.pnlExpiry < 0)) {
      const be = p0.spot + ((0 - p0.pnlExpiry) * (p1.spot - p0.spot)) / (p1.pnlExpiry - p0.pnlExpiry);
      rawBreakevens.push(Math.round(be));
    }
  }

  const breakevens = Array.from(new Set(rawBreakevens)).sort((a, b) => a - b);

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

  let totalLotDelta = 0;
  let totalGamma = 0;
  let totalTheta = 0;
  let totalVega = 0;
  let totalMtm = 0;
  let totalEntryValue = 0;
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

    // MTM
    const pnl = leg.side === 'SELL'
      ? (leg.entryPrice - leg.ltp) * qty
      : (leg.ltp - leg.entryPrice) * qty;
    totalMtm += pnl;

    totalEntryValue += leg.entryPrice * qty;
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

  return {
    netDelta: Math.round(totalLotDelta * 100) / 100,
    rupeeDelta,
    netGamma: Math.round(totalGamma * 10000) / 10000,
    gammaRiskLabel,
    netTheta: Math.round(totalTheta),
    thetaPerHour,
    netVega: Math.round(totalVega),
    totalMtm: Math.round(totalMtm),
    mtmPct: Math.round(mtmPct * 100) / 100,
    estimatedMargin,
    maxProfit: hasUnlimitedProfit ? 'Unlimited' : Math.max(0, Math.round(totalEntryValue)),
    maxLoss: hasUnlimitedLoss ? 'Unlimited' : Math.round(totalEntryValue * -1.5),
    popPct: 68,
  };
}

/**
 * Calculates remaining time to expiry in years.
 * Adds market close 15:30 IST to expiry date.
 */
export function calculateTimeToExpiryYears(expiryDateStr: string): number {
  if (!expiryDateStr) return 2 / 365;
  try {
    const [y, m, d] = expiryDateStr.split('-').map(Number);
    // 15:30 IST is 10:00 UTC
    const expiryTime = new Date(Date.UTC(y, m - 1, d, 10, 0, 0)).getTime();
    const now = Date.now();
    const diffMs = expiryTime - now;
    if (diffMs <= 0) return 0.25 / 365; // At least a few hours on expiry day
    return Math.max(0.25 / 365, diffMs / (365.25 * 24 * 3600 * 1000));
  } catch {
    return 2 / 365;
  }
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

