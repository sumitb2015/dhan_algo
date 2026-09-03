import type {
  StrategyType,
  UnderlyingType,
  ScannedLeg,
  ScannedStrategy,
  ScanFilters,
} from './ultimateScannerTypes';
import { computeStrangleAtOffset, type ChainStrikeQuote, type StrangleCell } from './strangleMath';

export const LOT_SIZES: Record<UnderlyingType, number> = {
  NIFTY: 65,
  SENSEX: 10,
  BANKNIFTY: 15,
};

export const STRIKE_STEPS: Record<UnderlyingType, number> = {
  NIFTY: 50,
  SENSEX: 100,
  BANKNIFTY: 100,
};

export function parseChainQuotes(
  rawChain: Record<string, unknown>,
): { quotes: Record<number, ChainStrikeQuote>; strikes: number[] } {
  const oc = (rawChain.oc as Record<string, unknown> | undefined) ?? rawChain;
  const quotes: Record<number, ChainStrikeQuote> = {};
  const strikes: number[] = [];

  if (!oc || typeof oc !== 'object') {
    return { quotes, strikes };
  }

  for (const [sk, entryRaw] of Object.entries(oc)) {
    const strike = Math.round(parseFloat(sk));
    if (isNaN(strike) || strike <= 0) continue;

    const entry = entryRaw as {
      ce?: {
        last_price?: number;
        ltp?: number;
        oi?: number;
        open_interest?: number;
        oi_change?: number;
        implied_volatility?: number;
        iv?: number;
        delta?: number;
        security_id?: string | number;
      };
      pe?: {
        last_price?: number;
        ltp?: number;
        oi?: number;
        open_interest?: number;
        oi_change?: number;
        implied_volatility?: number;
        iv?: number;
        delta?: number;
        security_id?: string | number;
      };
    };

    const ceLtp = Number(entry?.ce?.last_price || entry?.ce?.ltp || 0);
    const peLtp = Number(entry?.pe?.last_price || entry?.pe?.ltp || 0);

    quotes[strike] = {
      strike,
      ce: {
        ltp: ceLtp,
        oi: Number(entry?.ce?.oi || entry?.ce?.open_interest || 0),
        oiChange: Number(entry?.ce?.oi_change || 0),
        iv: Number(entry?.ce?.iv || entry?.ce?.implied_volatility || 0),
        delta: entry?.ce?.delta !== undefined ? Number(entry.ce.delta) : undefined,
        securityId: entry?.ce?.security_id ? String(entry.ce.security_id) : undefined,
      },
      pe: {
        ltp: peLtp,
        oi: Number(entry?.pe?.oi || entry?.pe?.open_interest || 0),
        oiChange: Number(entry?.pe?.oi_change || 0),
        iv: Number(entry?.pe?.iv || entry?.pe?.implied_volatility || 0),
        delta: entry?.pe?.delta !== undefined ? Number(entry.pe.delta) : undefined,
        securityId: entry?.pe?.security_id ? String(entry.pe.security_id) : undefined,
      },
    };
    strikes.push(strike);
  }

  strikes.sort((a, b) => a - b);
  return { quotes, strikes };
}

export function calculateDte(expiryStr: string): number {
  if (!expiryStr) return 1;
  const iso = expiryStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dmy = expiryStr.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  let targetDate: Date | null = null;

  if (iso) {
    targetDate = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  } else if (dmy) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const mi = months.indexOf(dmy[2].toLowerCase());
    if (mi >= 0) {
      targetDate = new Date(Number(dmy[3]), mi, Number(dmy[1]));
    }
  }

  if (!targetDate) return 1;
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((targetDate.getTime() - startToday.getTime()) / 86_400_000);
  return Math.max(0.2, diffDays);
}

/**
 * Approximate Black-Scholes Delta / POP when exact Delta is not populated.
 */
export function estimatePopAndDelta(
  spot: number,
  strike: number,
  dte: number,
  ivPct: number,
  isCall: boolean,
): { delta: number; popOtm: number } {
  const iv = (ivPct > 0 ? ivPct : 12) / 100;
  const t = Math.max(0.01, dte / 365);
  const sigmaRootT = iv * Math.sqrt(t);
  
  if (sigmaRootT <= 0.0001 || spot <= 0 || strike <= 0) {
    const otm = isCall ? strike > spot : strike < spot;
    return { delta: otm ? 0.2 : 0.8, popOtm: otm ? 80 : 20 };
  }

  const d1 = (Math.log(spot / strike) + (0.065 + 0.5 * iv * iv) * t) / sigmaRootT;
  const d2 = d1 - sigmaRootT;

  const normalCdf = (x: number) => {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
    const p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const z = Math.abs(x) / Math.SQRT2;
    const tVal = 1.0 / (1.0 + p * z);
    const y = 1.0 - (((((a5 * tVal + a4) * tVal) + a3) * tVal + a2) * tVal + a1) * tVal * Math.exp(-z * z);
    return 0.5 * (1.0 + sign * y);
  };

  if (isCall) {
    const delta = normalCdf(d1);
    const popOtm = (1 - normalCdf(d2)) * 100;
    return { delta, popOtm: Math.min(99, Math.max(1, popOtm)) };
  } else {
    const delta = normalCdf(d1) - 1;
    const popOtm = normalCdf(d2) * 100;
    return { delta, popOtm: Math.min(99, Math.max(1, popOtm)) };
  }
}

/**
 * Scans an option chain and generates shortlisted profitable option strategy candidates.
 */
export function scanOptionChain(
  underlying: UnderlyingType,
  expiry: string,
  spot: number,
  chainQuotes: Record<number, ChainStrikeQuote>,
  strikes: number[],
  filters: ScanFilters,
  vix = 11.34,
): ScannedStrategy[] {
  if (!spot || spot <= 0 || strikes.length < 5) return [];

  const candidates: ScannedStrategy[] = [];
  const lotSize = LOT_SIZES[underlying] || 65;
  const step = STRIKE_STEPS[underlying] || 50;
  const dte = calculateDte(expiry);
  const atmStrike = strikes.reduce((prev, curr) =>
    Math.abs(curr - spot) < Math.abs(prev - spot) ? curr : prev
  );

  const selectedStrats = new Set(filters.strategyTypes);
  const scanAll = selectedStrats.size === 0 || selectedStrats.has('all' as StrategyType);

  // Wing width configurations based on underlying
  const spreadWings = underlying === 'NIFTY' ? [50, 100, 150, 200] : [100, 200, 300, 400];

  // Helper to push valid candidates that match RoM, Distance, Risk constraints
  const evaluateCandidate = (strat: ScannedStrategy) => {
    if (strat.netPremium <= 0) return;
    if (strat.romPct < filters.minRom) return;
    if (strat.distancePct < filters.minDistancePct || strat.distancePct > filters.maxDistancePct) return;

    // Filter by risk profile
    if (filters.riskProfile === 'conservative' && (strat.popPct < 75 || strat.riskTier === 'Aggressive')) return;
    if (filters.riskProfile === 'moderate' && (strat.popPct < 60 || strat.riskTier === 'Aggressive')) return;
    if (filters.riskProfile === 'aggressive' && strat.riskTier === 'Conservative') return;

    candidates.push(strat);
  };

  // ─────────────────────────────────────────────────────────────────
  // 1. BULL PUT SPREAD (Credit Put Spread)
  // ─────────────────────────────────────────────────────────────────
  if (scanAll || selectedStrats.has('bull_put_spread')) {
    const putStrikes = strikes.filter(s => s < spot && s <= atmStrike);

    for (const shortStrike of putStrikes) {
      const shortQuote = chainQuotes[shortStrike]?.pe;
      if (!shortQuote || shortQuote.ltp <= 0.8) continue;

      const distPts = spot - shortStrike;
      const distPct = (distPts / spot) * 100;

      for (const wing of spreadWings) {
        const longStrike = shortStrike - wing;
        const longQuote = chainQuotes[longStrike]?.pe;
        if (!longQuote || longQuote.ltp <= 0.05) continue;

        const netCreditPts = shortQuote.ltp - longQuote.ltp;
        if (netCreditPts <= 0.4) continue;

        const netPremiumTotal = netCreditPts * lotSize;
        const maxLossPts = wing - netCreditPts;
        const maxLossTotal = maxLossPts * lotSize;
        
        const estMargin = Math.max(18000, wing * lotSize * 0.95 + 4000);
        const romPct = (netPremiumTotal / estMargin) * 100;
        const romAnnualizedPct = (romPct / Math.max(1, dte)) * 365;

        const { delta, popOtm } = estimatePopAndDelta(spot, shortStrike, dte, shortQuote.iv || vix, false);
        const pop = Math.min(96, Math.max(50, popOtm));
        const riskTier = pop >= 78 ? 'Conservative' : pop >= 65 ? 'Moderate' : 'Aggressive';
        const score = Math.round(Math.min(100, (romPct * 5.0) + (pop * 0.4) + (distPct * 3)));

        evaluateCandidate({
          id: `bps_${underlying}_${shortStrike}_${longStrike}_${expiry}`,
          name: `Bull Put Spread (${shortStrike}/${longStrike} PE)`,
          type: 'bull_put_spread',
          underlying,
          expiry,
          dte,
          spot,
          legs: [
            { strike: shortStrike, option: 'PE', side: 'SELL', ltp: shortQuote.ltp, lots: 1, lotSize, delta, oi: shortQuote.oi, oiChange: shortQuote.oiChange, securityId: shortQuote.securityId },
            { strike: longStrike, option: 'PE', side: 'BUY', ltp: longQuote.ltp, lots: 1, lotSize, securityId: longQuote.securityId },
          ],
          netPremium: Math.round(netPremiumTotal),
          netPremiumPoints: Math.round(netCreditPts * 100) / 100,
          estMargin: Math.round(estMargin),
          romPct: Math.round(romPct * 100) / 100,
          romAnnualizedPct: Math.round(romAnnualizedPct),
          distancePct: Math.round(distPct * 100) / 100,
          distancePoints: Math.round(distPts),
          popPct: Math.round(pop),
          maxProfit: Math.round(netPremiumTotal),
          maxLoss: Math.round(-maxLossTotal),
          maxLossUnlimited: false,
          riskRewardRatio: Math.round((maxLossTotal / netPremiumTotal) * 10) / 10,
          breakevens: [shortStrike - netCreditPts],
          deltaNet: Math.round((Math.abs(delta) - 0.05) * 100) / 100,
          sentiment: 'Bullish',
          riskTier,
          score,
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 2. BEAR CALL SPREAD (Credit Call Spread)
  // ─────────────────────────────────────────────────────────────────
  if (scanAll || selectedStrats.has('bear_call_spread')) {
    const callStrikes = strikes.filter(s => s > spot && s >= atmStrike);

    for (const shortStrike of callStrikes) {
      const shortQuote = chainQuotes[shortStrike]?.ce;
      if (!shortQuote || shortQuote.ltp <= 0.8) continue;

      const distPts = shortStrike - spot;
      const distPct = (distPts / spot) * 100;

      for (const wing of spreadWings) {
        const longStrike = shortStrike + wing;
        const longQuote = chainQuotes[longStrike]?.ce;
        if (!longQuote || longQuote.ltp <= 0.05) continue;

        const netCreditPts = shortQuote.ltp - longQuote.ltp;
        if (netCreditPts <= 0.4) continue;

        const netPremiumTotal = netCreditPts * lotSize;
        const maxLossPts = wing - netCreditPts;
        const maxLossTotal = maxLossPts * lotSize;
        
        const estMargin = Math.max(18000, wing * lotSize * 0.95 + 4000);
        const romPct = (netPremiumTotal / estMargin) * 100;
        const romAnnualizedPct = (romPct / Math.max(1, dte)) * 365;

        const { delta, popOtm } = estimatePopAndDelta(spot, shortStrike, dte, shortQuote.iv || vix, true);
        const pop = Math.min(96, Math.max(50, popOtm));
        const riskTier = pop >= 78 ? 'Conservative' : pop >= 65 ? 'Moderate' : 'Aggressive';
        const score = Math.round(Math.min(100, (romPct * 5.0) + (pop * 0.4) + (distPct * 3)));

        evaluateCandidate({
          id: `bcs_${underlying}_${shortStrike}_${longStrike}_${expiry}`,
          name: `Bear Call Spread (${shortStrike}/${longStrike} CE)`,
          type: 'bear_call_spread',
          underlying,
          expiry,
          dte,
          spot,
          legs: [
            { strike: shortStrike, option: 'CE', side: 'SELL', ltp: shortQuote.ltp, lots: 1, lotSize, delta, oi: shortQuote.oi, oiChange: shortQuote.oiChange, securityId: shortQuote.securityId },
            { strike: longStrike, option: 'CE', side: 'BUY', ltp: longQuote.ltp, lots: 1, lotSize, securityId: longQuote.securityId },
          ],
          netPremium: Math.round(netPremiumTotal),
          netPremiumPoints: Math.round(netCreditPts * 100) / 100,
          estMargin: Math.round(estMargin),
          romPct: Math.round(romPct * 100) / 100,
          romAnnualizedPct: Math.round(romAnnualizedPct),
          distancePct: Math.round(distPct * 100) / 100,
          distancePoints: Math.round(distPts),
          popPct: Math.round(pop),
          maxProfit: Math.round(netPremiumTotal),
          maxLoss: Math.round(-maxLossTotal),
          maxLossUnlimited: false,
          riskRewardRatio: Math.round((maxLossTotal / netPremiumTotal) * 10) / 10,
          breakevens: [shortStrike + netCreditPts],
          deltaNet: -Math.round((Math.abs(delta) - 0.05) * 100) / 100,
          sentiment: 'Bearish',
          riskTier,
          score,
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 3. IRON CONDOR (Range-Bound Hedged Credit)
  // ─────────────────────────────────────────────────────────────────
  if (scanAll || selectedStrats.has('iron_condor')) {
    const putCandidates = strikes.filter(s => s < spot && s <= atmStrike - step);
    const callCandidates = strikes.filter(s => s > spot && s >= atmStrike + step);

    for (const shortPut of putCandidates) {
      const shortPutQuote = chainQuotes[shortPut]?.pe;
      if (!shortPutQuote || shortPutQuote.ltp <= 1.0) continue;

      for (const shortCall of callCandidates) {
        const shortCallQuote = chainQuotes[shortCall]?.ce;
        if (!shortCallQuote || shortCallQuote.ltp <= 1.0) continue;

        const putDistPct = ((spot - shortPut) / spot) * 100;
        const callDistPct = ((shortCall - spot) / spot) * 100;
        const minDistPct = Math.min(putDistPct, callDistPct);

        for (const wing of spreadWings.slice(0, 3)) {
          const longPut = shortPut - wing;
          const longCall = shortCall + wing;
          const longPutQuote = chainQuotes[longPut]?.pe;
          const longCallQuote = chainQuotes[longCall]?.ce;

          if (!longPutQuote || !longCallQuote) continue;

          const putCredit = shortPutQuote.ltp - longPutQuote.ltp;
          const callCredit = shortCallQuote.ltp - longCallQuote.ltp;
          const totalCreditPts = putCredit + callCredit;

          if (totalCreditPts <= 0.8) continue;

          const netPremiumTotal = totalCreditPts * lotSize;
          const maxLossTotal = (wing - totalCreditPts) * lotSize;
          const estMargin = Math.max(28000, wing * lotSize * 1.05 + 6000);
          const romPct = (netPremiumTotal / estMargin) * 100;
          const romAnnualizedPct = (romPct / Math.max(1, dte)) * 365;

          const pop = Math.min(94, Math.max(50, 100 - (totalCreditPts / wing) * 90));
          const riskTier = pop >= 75 ? 'Conservative' : pop >= 62 ? 'Moderate' : 'Aggressive';
          const score = Math.round(Math.min(100, (romPct * 5.0) + (pop * 0.4) + (minDistPct * 4)));

          evaluateCandidate({
            id: `ic_${underlying}_${shortPut}_${shortCall}_${wing}_${expiry}`,
            name: `Iron Condor (${shortPut}P/${shortCall}C ±${wing})`,
            type: 'iron_condor',
            underlying,
            expiry,
            dte,
            spot,
            legs: [
              { strike: shortPut, option: 'PE', side: 'SELL', ltp: shortPutQuote.ltp, lots: 1, lotSize, securityId: shortPutQuote.securityId },
              { strike: longPut, option: 'PE', side: 'BUY', ltp: longPutQuote.ltp, lots: 1, lotSize, securityId: longPutQuote.securityId },
              { strike: shortCall, option: 'CE', side: 'SELL', ltp: shortCallQuote.ltp, lots: 1, lotSize, securityId: shortCallQuote.securityId },
              { strike: longCall, option: 'CE', side: 'BUY', ltp: longCallQuote.ltp, lots: 1, lotSize, securityId: longCallQuote.securityId },
            ],
            netPremium: Math.round(netPremiumTotal),
            netPremiumPoints: Math.round(totalCreditPts * 100) / 100,
            estMargin: Math.round(estMargin),
            romPct: Math.round(romPct * 100) / 100,
            romAnnualizedPct: Math.round(romAnnualizedPct),
            distancePct: Math.round(minDistPct * 100) / 100,
            distancePoints: Math.round(Math.min(spot - shortPut, shortCall - spot)),
            popPct: Math.round(pop),
            maxProfit: Math.round(netPremiumTotal),
            maxLoss: Math.round(-maxLossTotal),
            maxLossUnlimited: false,
            riskRewardRatio: Math.round((maxLossTotal / netPremiumTotal) * 10) / 10,
            breakevens: [shortPut - totalCreditPts, shortCall + totalCreditPts],
            deltaNet: 0.0,
            sentiment: 'Range-Bound',
            riskTier,
            score,
            createdAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 4. SHORT STRANGLE (OTM Naked Sell Both Sides)
  // ─────────────────────────────────────────────────────────────────
  if (scanAll || selectedStrats.has('short_strangle')) {
    // Search radius must track the user's actual maxDistancePct — a hardcoded
    // step cap here silently made distances beyond it unreachable regardless
    // of what the UI's Distance Threshold slider allowed the user to request.
    const maxOffsetSteps = Math.max(10, Math.ceil((spot * filters.maxDistancePct / 100) / step) + 1);

    // 1) Systematic symmetric & near-symmetric strangles (1 strike step out to maxOffsetSteps)
    for (let offset = 1; offset <= maxOffsetSteps; offset++) {
      const cell: StrangleCell | null = computeStrangleAtOffset({
        underlying,
        atmStrike,
        offset,
        step,
        spot,
        dte,
        lotSize,
        chainQuotes,
      });
      if (!cell) continue;

      const score = Math.round(Math.min(100, (cell.romPct * 6.0) + (cell.popPct * 0.4) + (cell.distancePct * 5)));

      evaluateCandidate({
        id: `strangle_${underlying}_${cell.putStrike}_${cell.callStrike}_${expiry}`,
        name: `Short Strangle (${cell.putStrike} PE / ${cell.callStrike} CE [±${offset * step}pts])`,
        type: 'short_strangle',
        underlying,
        expiry,
        dte,
        spot,
        legs: [
          { strike: cell.putStrike, option: 'PE', side: 'SELL', ltp: cell.putLtp, lots: 1, lotSize, securityId: cell.putSecurityId },
          { strike: cell.callStrike, option: 'CE', side: 'SELL', ltp: cell.callLtp, lots: 1, lotSize, securityId: cell.callSecurityId },
        ],
        netPremium: cell.netPremium,
        netPremiumPoints: cell.netPremiumPoints,
        estMargin: cell.estMargin,
        romPct: cell.romPct,
        romAnnualizedPct: cell.romAnnualizedPct,
        distancePct: cell.distancePct,
        distancePoints: cell.distancePoints,
        popPct: cell.popPct,
        maxProfit: cell.netPremium,
        maxLoss: 0,
        maxLossUnlimited: true,
        riskRewardRatio: 0,
        breakevens: cell.breakevens,
        deltaNet: 0.0,
        sentiment: 'Range-Bound',
        riskTier: cell.riskTier,
        score,
        createdAt: new Date().toISOString(),
      });
    }

    // 2) Also scan cross-strike OTM combinations
    const putCandidates = strikes.filter(s => s < spot && s <= atmStrike - step && s >= atmStrike - maxOffsetSteps * step);
    const callCandidates = strikes.filter(s => s > spot && s >= atmStrike + step && s <= atmStrike + maxOffsetSteps * step);

    for (const shortPut of putCandidates) {
      const shortPutQuote = chainQuotes[shortPut]?.pe;
      if (!shortPutQuote || shortPutQuote.ltp <= 1.5) continue;

      for (const shortCall of callCandidates) {
        if (Math.abs((spot - shortPut) - (shortCall - spot)) > 3 * step) continue; // Keep relatively balanced

        const shortCallQuote = chainQuotes[shortCall]?.ce;
        if (!shortCallQuote || shortCallQuote.ltp <= 1.5) continue;

        const putDistPct = ((spot - shortPut) / spot) * 100;
        const callDistPct = ((shortCall - spot) / spot) * 100;
        const minDistPct = Math.min(putDistPct, callDistPct);

        const totalCreditPts = shortPutQuote.ltp + shortCallQuote.ltp;
        const netPremiumTotal = totalCreditPts * lotSize;
        const estMargin = underlying === 'NIFTY' ? 120000 : underlying === 'SENSEX' ? 95000 : 130000;
        const romPct = (netPremiumTotal / estMargin) * 100;
        const romAnnualizedPct = (romPct / Math.max(1, dte)) * 365;

        const pop = Math.min(92, Math.max(50, 85 - (1.0 / (minDistPct + 0.1)) * 10));
        const riskTier = minDistPct >= 2.5 ? 'Conservative' : minDistPct >= 1.2 ? 'Moderate' : 'Aggressive';
        const score = Math.round(Math.min(100, (romPct * 5.0) + (pop * 0.3) + (minDistPct * 5)));

        evaluateCandidate({
          id: `strangle_${underlying}_${shortPut}_${shortCall}_${expiry}`,
          name: `Short Strangle (${shortPut} PE / ${shortCall} CE)`,
          type: 'short_strangle',
          underlying,
          expiry,
          dte,
          spot,
          legs: [
            { strike: shortPut, option: 'PE', side: 'SELL', ltp: shortPutQuote.ltp, lots: 1, lotSize, securityId: shortPutQuote.securityId },
            { strike: shortCall, option: 'CE', side: 'SELL', ltp: shortCallQuote.ltp, lots: 1, lotSize, securityId: shortCallQuote.securityId },
          ],
          netPremium: Math.round(netPremiumTotal),
          netPremiumPoints: Math.round(totalCreditPts * 100) / 100,
          estMargin: Math.round(estMargin),
          romPct: Math.round(romPct * 100) / 100,
          romAnnualizedPct: Math.round(romAnnualizedPct),
          distancePct: Math.round(minDistPct * 100) / 100,
          distancePoints: Math.round(Math.min(spot - shortPut, shortCall - spot)),
          popPct: Math.round(pop),
          maxProfit: Math.round(netPremiumTotal),
          maxLoss: 0,
          maxLossUnlimited: true,
          riskRewardRatio: 0,
          breakevens: [shortPut - totalCreditPts, shortCall + totalCreditPts],
          deltaNet: 0.0,
          sentiment: 'Range-Bound',
          riskTier,
          score,
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 5. SHORT STRADDLE (ATM Naked Sell)
  // ─────────────────────────────────────────────────────────────────
  if (scanAll || selectedStrats.has('short_straddle')) {
    const atmCandidates = [atmStrike - step, atmStrike, atmStrike + step].filter(s => chainQuotes[s]);
    for (const straddleStrike of atmCandidates) {
      const q = chainQuotes[straddleStrike];
      if (!q || !q.ce?.ltp || !q.pe?.ltp) continue;

      const totalCreditPts = q.ce.ltp + q.pe.ltp;
      const netPremiumTotal = totalCreditPts * lotSize;
      const estMargin = underlying === 'NIFTY' ? 125000 : 98000;
      const romPct = (netPremiumTotal / estMargin) * 100;
      const romAnnualizedPct = (romPct / Math.max(1, dte)) * 365;
      const distPct = (Math.abs(spot - straddleStrike) / spot) * 100;

      const pop = 58;
      const score = Math.round(Math.min(100, (romPct * 4.0) + 40));

      evaluateCandidate({
        id: `straddle_${underlying}_${straddleStrike}_${expiry}`,
        name: `Short Straddle (${straddleStrike} CE + PE)`,
        type: 'short_straddle',
        underlying,
        expiry,
        dte,
        spot,
        legs: [
          { strike: straddleStrike, option: 'PE', side: 'SELL', ltp: q.pe.ltp, lots: 1, lotSize, securityId: q.pe.securityId },
          { strike: straddleStrike, option: 'CE', side: 'SELL', ltp: q.ce.ltp, lots: 1, lotSize, securityId: q.ce.securityId },
        ],
        netPremium: Math.round(netPremiumTotal),
        netPremiumPoints: Math.round(totalCreditPts * 100) / 100,
        estMargin: Math.round(estMargin),
        romPct: Math.round(romPct * 100) / 100,
        romAnnualizedPct: Math.round(romAnnualizedPct),
        distancePct: Math.round(distPct * 100) / 100,
        distancePoints: Math.round(Math.abs(spot - straddleStrike)),
        popPct: pop,
        maxProfit: Math.round(netPremiumTotal),
        maxLoss: 0,
        maxLossUnlimited: true,
        riskRewardRatio: 0,
        breakevens: [straddleStrike - totalCreditPts, straddleStrike + totalCreditPts],
        deltaNet: 0.0,
        sentiment: 'Range-Bound',
        riskTier: 'Aggressive',
        score,
        createdAt: new Date().toISOString(),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 6. NAKED PUT / CASH SECURED PUT (CSP)
  // ─────────────────────────────────────────────────────────────────
  if (scanAll || selectedStrats.has('naked_put')) {
    const putStrikes = strikes.filter(s => s < spot && s <= atmStrike);

    for (const strike of putStrikes) {
      const quote = chainQuotes[strike]?.pe;
      if (!quote || quote.ltp <= 1.5) continue;

      const distPts = spot - strike;
      const distPct = (distPts / spot) * 100;
      const netPremiumTotal = quote.ltp * lotSize;
      const estMargin = underlying === 'NIFTY' ? 110000 : underlying === 'SENSEX' ? 88000 : 120000;
      const romPct = (netPremiumTotal / estMargin) * 100;
      const romAnnualizedPct = (romPct / Math.max(1, dte)) * 365;

      const { delta, popOtm } = estimatePopAndDelta(spot, strike, dte, quote.iv || vix, false);
      const pop = Math.min(96, Math.max(50, popOtm));
      const riskTier = distPct >= 3.0 ? 'Conservative' : distPct >= 1.5 ? 'Moderate' : 'Aggressive';
      const score = Math.round(Math.min(100, (romPct * 4.2) + (pop * 0.4) + (distPct * 4)));

      evaluateCandidate({
        id: `np_${underlying}_${strike}_${expiry}`,
        name: `Naked Put / CSP (${strike} PE)`,
        type: 'naked_put',
        underlying,
        expiry,
        dte,
        spot,
        legs: [
          { strike, option: 'PE', side: 'SELL', ltp: quote.ltp, lots: 1, lotSize, delta, oi: quote.oi, oiChange: quote.oiChange, securityId: quote.securityId },
        ],
        netPremium: Math.round(netPremiumTotal),
        netPremiumPoints: Math.round(quote.ltp * 100) / 100,
        estMargin: Math.round(estMargin),
        romPct: Math.round(romPct * 100) / 100,
        romAnnualizedPct: Math.round(romAnnualizedPct),
        distancePct: Math.round(distPct * 100) / 100,
        distancePoints: Math.round(distPts),
        popPct: Math.round(pop),
        maxProfit: Math.round(netPremiumTotal),
        maxLoss: Math.round(-((strike - quote.ltp) * lotSize)),
        maxLossUnlimited: false,
        riskRewardRatio: Math.round(((strike - quote.ltp) / quote.ltp) * 10) / 10,
        breakevens: [strike - quote.ltp],
        deltaNet: Math.round(Math.abs(delta) * 100) / 100,
        sentiment: 'Bullish',
        riskTier,
        score,
        createdAt: new Date().toISOString(),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 7. JADE LIZARD
  // ─────────────────────────────────────────────────────────────────
  if (scanAll || selectedStrats.has('jade_lizard')) {
    const putStrikes = strikes.filter(s => s < spot && s <= atmStrike - step);
    const callStrikes = strikes.filter(s => s > spot && s >= atmStrike + step);

    for (const shortPut of putStrikes) {
      const shortPutQuote = chainQuotes[shortPut]?.pe;
      if (!shortPutQuote || shortPutQuote.ltp <= 1.5) continue;

      for (const shortCall of callStrikes) {
        const shortCallQuote = chainQuotes[shortCall]?.ce;
        if (!shortCallQuote || shortCallQuote.ltp <= 1.5) continue;

        for (const wing of spreadWings.slice(0, 2)) {
          const longCall = shortCall + wing;
          const longCallQuote = chainQuotes[longCall]?.ce;
          if (!longCallQuote) continue;

          const totalCreditPts = shortPutQuote.ltp + (shortCallQuote.ltp - longCallQuote.ltp);
          if (totalCreditPts <= 1.0) continue;

          const netPremiumTotal = totalCreditPts * lotSize;
          const estMargin = underlying === 'NIFTY' ? 115000 : 92000;
          const romPct = (netPremiumTotal / estMargin) * 100;
          const romAnnualizedPct = (romPct / Math.max(1, dte)) * 365;

          const minDistPct = Math.min(((spot - shortPut) / spot) * 100, ((shortCall - spot) / spot) * 100);
          const pop = Math.min(90, Math.max(55, 80 + (totalCreditPts >= wing ? 10 : 0)));
          const riskTier = minDistPct >= 2.5 ? 'Moderate' : 'Aggressive';
          const score = Math.round(Math.min(100, (romPct * 4.5) + (pop * 0.3) + (minDistPct * 4)));

          evaluateCandidate({
            id: `jl_${underlying}_${shortPut}_${shortCall}_${longCall}_${expiry}`,
            name: `Jade Lizard (${shortPut}P / ${shortCall}C / ${longCall}C)`,
            type: 'jade_lizard',
            underlying,
            expiry,
            dte,
            spot,
            legs: [
              { strike: shortPut, option: 'PE', side: 'SELL', ltp: shortPutQuote.ltp, lots: 1, lotSize, securityId: shortPutQuote.securityId },
              { strike: shortCall, option: 'CE', side: 'SELL', ltp: shortCallQuote.ltp, lots: 1, lotSize, securityId: shortCallQuote.securityId },
              { strike: longCall, option: 'CE', side: 'BUY', ltp: longCallQuote.ltp, lots: 1, lotSize, securityId: longCallQuote.securityId },
            ],
            netPremium: Math.round(netPremiumTotal),
            netPremiumPoints: Math.round(totalCreditPts * 100) / 100,
            estMargin: Math.round(estMargin),
            romPct: Math.round(romPct * 100) / 100,
            romAnnualizedPct: Math.round(romAnnualizedPct),
            distancePct: Math.round(minDistPct * 100) / 100,
            distancePoints: Math.round(Math.min(spot - shortPut, shortCall - spot)),
            popPct: Math.round(pop),
            maxProfit: Math.round(netPremiumTotal),
            maxLoss: 0,
            maxLossUnlimited: true,
            riskRewardRatio: 0,
            breakevens: [shortPut - totalCreditPts, shortCall + totalCreditPts],
            deltaNet: 0.1,
            sentiment: 'Neutral',
            riskTier,
            score,
            createdAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  // Sort candidates by chosen criterion
  candidates.sort((a, b) => {
    if (filters.sortBy === 'rom') return b.romPct - a.romPct;
    if (filters.sortBy === 'pop') return b.popPct - a.popPct;
    if (filters.sortBy === 'premium') return b.netPremium - a.netPremium;
    if (filters.sortBy === 'distance') return b.distancePct - a.distancePct;
    return b.score - a.score;
  });

  return candidates.slice(0, filters.maxResults || 50);
}
