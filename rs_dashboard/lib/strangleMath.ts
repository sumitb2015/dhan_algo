import type { UnderlyingType } from './ultimateScannerTypes';

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
  estMargin: number;          // Flat per-strategy margin estimate in ₹
  romPct: number;             // Return on Margin % per expiry cycle
  romAnnualizedPct: number;   // Annualized RoM %
  distancePct: number;        // Nearer leg's distance from spot, % OTM
  distancePoints: number;     // Nearer leg's distance from spot, in points
  popPct: number;             // Probability of Profit % (0-100)
  riskTier: 'Conservative' | 'Moderate' | 'Aggressive';
  breakevens: [number, number]; // [lower, upper]
  putSecurityId?: string;
  callSecurityId?: string;
}

const LOT_SIZES: Record<UnderlyingType, number> = {
  NIFTY: 65,
  SENSEX: 10,
  BANKNIFTY: 15,
};

/**
 * Premium/RoM/POP for a symmetric short strangle at `offset` strike-steps
 * out from ATM (e.g. offset=2 sells ATM-2*step PE and ATM+2*step CE).
 * Returns null when either leg's quote is missing or too illiquid
 * (ltp <= 1.0) to be a real fill.
 */
export function computeStrangleAtOffset(params: {
  underlying: UnderlyingType;
  atmStrike: number;
  offset: number;
  step: number;
  spot: number;
  dte: number;
  chainQuotes: Record<number, ChainStrikeQuote>;
  lotSize?: number; // defaults to LOT_SIZES[underlying]
}): StrangleCell | null {
  const { underlying, atmStrike, offset, step, spot, dte, chainQuotes } = params;
  const lotSize = params.lotSize ?? LOT_SIZES[underlying] ?? 65;

  const putStrike = atmStrike - offset * step;
  const callStrike = atmStrike + offset * step;

  const putQuote = chainQuotes[putStrike]?.pe;
  const callQuote = chainQuotes[callStrike]?.ce;
  if (!putQuote || !callQuote || putQuote.ltp <= 1.0 || callQuote.ltp <= 1.0) return null;

  const putDistPct = ((spot - putStrike) / spot) * 100;
  const callDistPct = ((callStrike - spot) / spot) * 100;
  const distancePct = Math.min(putDistPct, callDistPct);

  const totalCreditPts = putQuote.ltp + callQuote.ltp;
  const netPremium = totalCreditPts * lotSize;
  const estMargin = underlying === 'NIFTY' ? 120000 : underlying === 'SENSEX' ? 95000 : 130000;
  const romPct = (netPremium / estMargin) * 100;
  const romAnnualizedPct = (romPct / Math.max(1, dte)) * 365;

  const popPct = Math.min(94, Math.max(50, 88 - (1.0 / (distancePct + 0.1)) * 10));
  const riskTier = distancePct >= 2.5 ? 'Conservative' : distancePct >= 1.2 ? 'Moderate' : 'Aggressive';

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
    distancePoints: Math.round(Math.min(spot - putStrike, callStrike - spot)),
    popPct: Math.round(popPct),
    riskTier,
    breakevens: [
      Math.round((putStrike - totalCreditPts) * 100) / 100,
      Math.round((callStrike + totalCreditPts) * 100) / 100,
    ],
    putSecurityId: putQuote.securityId,
    callSecurityId: callQuote.securityId,
  };
}
