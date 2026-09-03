import type { UnderlyingType } from './ultimateScannerTypes';
import { estimatePopAndDelta, LOT_SIZES, STRIKE_STEPS } from './ultimateScannerEngine.ts';

export interface ChainStrikeQuote {
  strike: number;
  ce: {
    ltp: number;
    oi?: number;
    oiChange?: number;
    iv?: number;
    delta?: number;
    securityId?: string;
  };
  pe: {
    ltp: number;
    oi?: number;
    oiChange?: number;
    iv?: number;
    delta?: number;
    securityId?: string;
  };
}

export interface StrangleCell {
  offset: number;
  putStrike: number;
  callStrike: number;
  putLtp: number;
  callLtp: number;
  netPremium: number;         // Total net credit in ₹ for 1 lot
  netPremiumPoints: number;   // Net premium in index points
  estMargin: number;          // Margin in ₹ — a flat per-strategy estimate
                               // unless marginSource is 'live'
  marginSource?: 'live' | 'estimate'; // 'live' = priced via Dhan's multi-leg
                               // margin calculator for this exact strike pair;
                               // absent/'estimate' = flat formula, not the real
                               // netted SPAN+exposure figure
  romPct: number;             // Return on Margin % per expiry cycle
  romAnnualizedPct: number;   // Annualized RoM %
  distancePct: number;        // Nearer leg's distance from spot, % OTM
  distancePoints: number;     // Nearer leg's distance from spot, in points
  strikeDistancePoints: number; // Offset * step distance
  popPct: number;             // Probability of Profit % (0-100)
  riskTier: 'Conservative' | 'Moderate' | 'Aggressive';
  breakevens: [number, number]; // [lower, upper]
  breakevenWidth: number;     // Upper BE - Lower BE in points
  deltaNet: number;           // Net position Delta
  putDelta?: number;
  callDelta?: number;
  putIv?: number;
  callIv?: number;
  putOi?: number;
  callOi?: number;
  putSecurityId?: string;
  callSecurityId?: string;
}

const BASE_MARGINS: Record<UnderlyingType, number> = {
  NIFTY: 120000,
  BANKNIFTY: 130000,
  SENSEX: 95000,
};

/**
 * Premium, RoM, POP, and breakevens for a symmetric short strangle at `offset` strike-steps
 * out from ATM (e.g. offset=2 sells ATM - 2*step PE and ATM + 2*step CE).
 * Returns null when either leg's quote is missing or zero (ltp <= 0.05).
 */
export function computeStrangleAtOffset(params: {
  underlying: UnderlyingType;
  atmStrike: number;
  offset: number;
  step: number;
  spot: number;
  dte: number;
  chainQuotes: Record<number, ChainStrikeQuote>;
  lotSize?: number;
  vix?: number;
}): StrangleCell | null {
  const { underlying, atmStrike, offset, step, spot, dte, chainQuotes } = params;
  const lotSize = params.lotSize ?? LOT_SIZES[underlying] ?? 65;

  const putStrike = atmStrike - offset * step;
  const callStrike = atmStrike + offset * step;

  const putQuote = chainQuotes[putStrike]?.pe;
  const callQuote = chainQuotes[callStrike]?.ce;

  if (!putQuote || !callQuote || putQuote.ltp <= 0.05 || callQuote.ltp <= 0.05) {
    return null;
  }

  const putDistPct = ((spot - putStrike) / spot) * 100;
  const callDistPct = ((callStrike - spot) / spot) * 100;
  const distancePct = Math.min(putDistPct, callDistPct);
  const distancePoints = Math.round(Math.min(spot - putStrike, callStrike - spot));
  const strikeDistancePoints = offset * step;

  const totalCreditPts = putQuote.ltp + callQuote.ltp;
  const netPremium = totalCreditPts * lotSize;
  const estMargin = BASE_MARGINS[underlying] ?? 120000;
  const romPct = (netPremium / estMargin) * 100;
  const romAnnualizedPct = (romPct / Math.max(0.5, dte)) * 365;

  // Resolve Delta
  let putDelta = putQuote.delta;
  let callDelta = callQuote.delta;
  const avgIv = (putQuote.iv && callQuote.iv) ? (putQuote.iv + callQuote.iv) / 2 : (params.vix || 12.0);

  if (putDelta === undefined || Math.abs(putDelta) === 0) {
    const estPut = estimatePopAndDelta(spot, putStrike, dte, putQuote.iv || avgIv, false);
    putDelta = estPut.delta;
  }
  if (callDelta === undefined || Math.abs(callDelta) === 0) {
    const estCall = estimatePopAndDelta(spot, callStrike, dte, callQuote.iv || avgIv, true);
    callDelta = estCall.delta;
  }

  // Net delta of short strangle: short PE (+delta) and short CE (-delta)
  const deltaNet = Math.round((Math.abs(putDelta) - Math.abs(callDelta)) * 100) / 100;

  // Standard POP computation: probability that spot finishes between lower and upper breakevens
  const lowerBe = Math.round((putStrike - totalCreditPts) * 100) / 100;
  const upperBe = Math.round((callStrike + totalCreditPts) * 100) / 100;
  const beWidth = Math.round((upperBe - lowerBe) * 100) / 100;

  let popPct: number;
  if (Math.abs(putDelta) > 0 && Math.abs(callDelta) > 0) {
    const rawPop = (1 - Math.abs(putDelta) - Math.abs(callDelta)) * 100;
    const creditBufferFactor = 1 + (totalCreditPts / (callStrike - putStrike)) * 0.4;
    popPct = Math.min(97, Math.max(35, rawPop * creditBufferFactor));
  } else {
    popPct = Math.min(94, Math.max(50, 88 - (1.0 / (Math.max(0.1, distancePct) + 0.1)) * 10));
  }

  const riskTier: 'Conservative' | 'Moderate' | 'Aggressive' =
    distancePct >= 2.5 && popPct >= 72
      ? 'Conservative'
      : distancePct >= 1.2 && popPct >= 58
      ? 'Moderate'
      : 'Aggressive';

  return {
    offset,
    putStrike,
    callStrike,
    putLtp: putQuote.ltp,
    callLtp: callQuote.ltp,
    netPremium: Math.round(netPremium),
    netPremiumPoints: Math.round(totalCreditPts * 100) / 100,
    estMargin: Math.round(estMargin),
    romPct: Math.round(romPct * 100) / 100,
    romAnnualizedPct: Math.round(romAnnualizedPct),
    distancePct: Math.round(distancePct * 100) / 100,
    distancePoints,
    strikeDistancePoints,
    popPct: Math.round(popPct),
    riskTier,
    breakevens: [lowerBe, upperBe],
    breakevenWidth: beWidth,
    deltaNet,
    putDelta: Math.round(putDelta * 100) / 100,
    callDelta: Math.round(callDelta * 100) / 100,
    putIv: putQuote.iv ? Math.round(putQuote.iv * 10) / 10 : undefined,
    callIv: callQuote.iv ? Math.round(callQuote.iv * 10) / 10 : undefined,
    putOi: putQuote.oi,
    callOi: callQuote.oi,
    putSecurityId: putQuote.securityId,
    callSecurityId: callQuote.securityId,
  };
}
