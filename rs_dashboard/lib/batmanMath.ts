import type { UnderlyingType } from './ultimateScannerTypes.ts';
import { estimatePopAndDelta, LOT_SIZES, STRIKE_STEPS } from './ultimateScannerEngine.ts';
import type { ChainStrikeQuote } from './strangleMath.ts';

export interface BatmanCell {
  offset: number;              // Inner strike offset N from ATM
  wing: number;                // Spread width W (in strikes)
  wingPoints: number;          // W * step (in index points)

  // 4 Strike levels
  shortPutStrike: number;      // longPut - wingPoints (Outer Put, 2 lots)
  longPutStrike: number;       // atmStrike - offset * step (Inner Put, 1 lot)
  longCallStrike: number;      // atmStrike + offset * step (Inner Call, 1 lot)
  shortCallStrike: number;     // longCall + wingPoints (Outer Call, 2 lots)

  // Quotes (LTPs)
  shortPutLtp: number;
  longPutLtp: number;
  longCallLtp: number;
  shortCallLtp: number;

  // Credits
  putCredit: number;           // (2 * shortPutLtp) - longPutLtp
  callCredit: number;          // (2 * shortCallLtp) - longCallLtp
  netPremiumPoints: number;    // putCredit + callCredit (Points)
  netPremium: number;          // netPremiumPoints * lotSize (₹ for 1 lot default)

  // Ear Peaks Max Profit (at short strikes)
  maxProfitPoints: number;     // wingPoints + netPremiumPoints
  maxProfit: number;           // maxProfitPoints * lotSize

  // Margin & Yield
  estMargin: number;           // Margin in ₹ — flat estimate or live SPAN
  marginSource?: 'live' | 'estimate';
  romPct: number;              // Return on Margin % per expiry cycle
  romAnnualizedPct: number;    // Annualized RoM %

  // Distance & Safety
  distancePct: number;         // Short strike distance from spot (% OTM)
  distancePoints: number;      // Short strike distance from spot in points
  strikeDistancePoints: number;// Inner strike offset * step

  // Probability of Profit & Risk
  popPct: number;              // Probability of profit between breakevens (0-100)
  riskTier: 'Conservative' | 'Moderate' | 'Aggressive';
  breakevens: [number, number];// [Lower BE, Upper BE]
  breakevenWidth: number;      // Upper BE - Lower BE in points
  deltaNet: number;            // Net position Delta

  // Leg Greeks & Depth
  shortPutDelta?: number;
  longPutDelta?: number;
  longCallDelta?: number;
  shortCallDelta?: number;
  putIv?: number;
  callIv?: number;
  shortPutOi?: number;
  shortCallOi?: number;

  // Security IDs for live Dhan execution & margin pricing
  shortPutSecurityId?: string;
  longPutSecurityId?: string;
  longCallSecurityId?: string;
  shortCallSecurityId?: string;
}

const BASE_MARGINS: Record<UnderlyingType, number> = {
  NIFTY: 130000,
  BANKNIFTY: 140000,
  SENSEX: 105000,
};

/**
 * Computes metrics for a symmetric Batman spread (4-leg double ratio spread):
 *   - Long 1 PE at ATM - offset * step
 *   - Short 2 PE at (ATM - offset * step) - wing * step
 *   - Long 1 CE at ATM + offset * step
 *   - Short 2 CE at (ATM + offset * step) + wing * step
 *
 * Returns null if quotes are missing or illiquid (LTP <= 0.05).
 */
export function computeBatmanAtOffset(params: {
  underlying: UnderlyingType;
  atmStrike: number;
  offset: number;
  wing?: number;
  step: number;
  spot: number;
  dte: number;
  chainQuotes: Record<number, ChainStrikeQuote>;
  lotSize?: number;
  vix?: number;
}): BatmanCell | null {
  const { underlying, atmStrike, offset, step, spot, dte, chainQuotes } = params;
  const wing = params.wing ?? 2;
  const lotSize = params.lotSize ?? LOT_SIZES[underlying] ?? 65;
  const wingPoints = wing * step;

  const longPutStrike = atmStrike - offset * step;
  const shortPutStrike = longPutStrike - wingPoints;

  const longCallStrike = atmStrike + offset * step;
  const shortCallStrike = longCallStrike + wingPoints;

  const longPutQuote = chainQuotes[longPutStrike]?.pe;
  const shortPutQuote = chainQuotes[shortPutStrike]?.pe;
  const longCallQuote = chainQuotes[longCallStrike]?.ce;
  const shortCallQuote = chainQuotes[shortCallStrike]?.ce;

  if (
    !longPutQuote || !shortPutQuote || !longCallQuote || !shortCallQuote ||
    longPutQuote.ltp <= 0.05 || shortPutQuote.ltp <= 0.05 ||
    longCallQuote.ltp <= 0.05 || shortCallQuote.ltp <= 0.05
  ) {
    return null;
  }

  // Ratio Credits: Buy 1 inner, Sell 2 outer
  const putCredit = (2 * shortPutQuote.ltp) - longPutQuote.ltp;
  const callCredit = (2 * shortCallQuote.ltp) - longCallQuote.ltp;
  const totalCreditPts = Math.round((putCredit + callCredit) * 100) / 100;
  const netPremium = Math.round(totalCreditPts * lotSize);

  // Peak profit at the short strikes ("ears")
  const maxProfitPoints = Math.round((wingPoints + totalCreditPts) * 100) / 100;
  const maxProfit = Math.round(maxProfitPoints * lotSize);

  // Margin & Yield
  const estMargin = BASE_MARGINS[underlying] ?? 130000;
  const romPct = (netPremium / estMargin) * 100;
  const romAnnualizedPct = (romPct / Math.max(0.5, dte)) * 365;

  // Distances to danger zone (the short strikes / ears where ratio risk starts)
  const putDistPct = ((spot - shortPutStrike) / spot) * 100;
  const callDistPct = ((shortCallStrike - spot) / spot) * 100;
  const distancePct = Math.min(putDistPct, callDistPct);
  const distancePoints = Math.round(Math.min(spot - shortPutStrike, shortCallStrike - spot));
  const strikeDistancePoints = offset * step;

  // Breakevens: lower = shortPut - maxProfitPoints, upper = shortCall + maxProfitPoints
  const lowerBe = Math.round((shortPutStrike - maxProfitPoints) * 100) / 100;
  const upperBe = Math.round((shortCallStrike + maxProfitPoints) * 100) / 100;
  const beWidth = Math.round((upperBe - lowerBe) * 100) / 100;

  // Deltas
  const avgIv = (shortPutQuote.iv && shortCallQuote.iv)
    ? (shortPutQuote.iv + shortCallQuote.iv) / 2
    : (params.vix || 12.0);

  let shortPutDelta = shortPutQuote.delta;
  let shortCallDelta = shortCallQuote.delta;
  if (shortPutDelta === undefined || Math.abs(shortPutDelta) === 0) {
    shortPutDelta = estimatePopAndDelta(spot, shortPutStrike, dte, shortPutQuote.iv || avgIv, false).delta;
  }
  if (shortCallDelta === undefined || Math.abs(shortCallDelta) === 0) {
    shortCallDelta = estimatePopAndDelta(spot, shortCallStrike, dte, shortCallQuote.iv || avgIv, true).delta;
  }

  let longPutDelta = longPutQuote.delta;
  let longCallDelta = longCallQuote.delta;
  if (longPutDelta === undefined || Math.abs(longPutDelta) === 0) {
    longPutDelta = estimatePopAndDelta(spot, longPutStrike, dte, longPutQuote.iv || avgIv, false).delta;
  }
  if (longCallDelta === undefined || Math.abs(longCallDelta) === 0) {
    longCallDelta = estimatePopAndDelta(spot, longCallStrike, dte, longCallQuote.iv || avgIv, true).delta;
  }

  // Net delta: Long PE (negative delta) + 2*Short PE (positive delta) + Long CE (positive delta) + 2*Short CE (negative delta)
  const deltaNet = Math.round(
    ((longPutDelta ?? 0) + (-2 * (shortPutDelta ?? 0)) + (longCallDelta ?? 0) + (-2 * (shortCallDelta ?? 0))) * 100
  ) / 100;

  // Probability of Profit
  let popPct: number;
  if (Math.abs(shortPutDelta ?? 0) > 0 && Math.abs(shortCallDelta ?? 0) > 0) {
    const rawPop = (1 - Math.abs(shortPutDelta ?? 0) - Math.abs(shortCallDelta ?? 0)) * 100;
    const bufferFactor = 1 + (maxProfitPoints / (shortCallStrike - shortPutStrike)) * 0.5;
    popPct = Math.min(97, Math.max(35, Math.round(rawPop * bufferFactor)));
  } else {
    popPct = Math.min(94, Math.max(50, Math.round(84 - (1.0 / (Math.max(0.1, distancePct) + 0.1)) * 8)));
  }

  const riskTier: 'Conservative' | 'Moderate' | 'Aggressive' =
    distancePct >= 2.5 && popPct >= 72
      ? 'Conservative'
      : distancePct >= 1.2 && popPct >= 58
      ? 'Moderate'
      : 'Aggressive';

  return {
    offset,
    wing,
    wingPoints,
    shortPutStrike,
    longPutStrike,
    longCallStrike,
    shortCallStrike,
    shortPutLtp: shortPutQuote.ltp,
    longPutLtp: longPutQuote.ltp,
    longCallLtp: longCallQuote.ltp,
    shortCallLtp: shortCallQuote.ltp,
    putCredit: Math.round(putCredit * 100) / 100,
    callCredit: Math.round(callCredit * 100) / 100,
    netPremiumPoints: totalCreditPts,
    netPremium,
    maxProfitPoints,
    maxProfit,
    estMargin,
    romPct: Math.round(romPct * 100) / 100,
    romAnnualizedPct: Math.round(romAnnualizedPct),
    distancePct: Math.round(distancePct * 100) / 100,
    distancePoints,
    strikeDistancePoints,
    popPct,
    riskTier,
    breakevens: [lowerBe, upperBe],
    breakevenWidth: beWidth,
    deltaNet,
    shortPutDelta: shortPutDelta ? Math.round(shortPutDelta * 100) / 100 : undefined,
    longPutDelta: longPutDelta ? Math.round(longPutDelta * 100) / 100 : undefined,
    longCallDelta: longCallDelta ? Math.round(longCallDelta * 100) / 100 : undefined,
    shortCallDelta: shortCallDelta ? Math.round(shortCallDelta * 100) / 100 : undefined,
    putIv: shortPutQuote.iv ? Math.round(shortPutQuote.iv * 10) / 10 : undefined,
    callIv: shortCallQuote.iv ? Math.round(shortCallQuote.iv * 10) / 10 : undefined,
    shortPutOi: shortPutQuote.oi,
    shortCallOi: shortCallQuote.oi,
    shortPutSecurityId: shortPutQuote.securityId,
    longPutSecurityId: longPutQuote.securityId,
    longCallSecurityId: longCallQuote.securityId,
    shortCallSecurityId: shortCallQuote.securityId,
  };
}
