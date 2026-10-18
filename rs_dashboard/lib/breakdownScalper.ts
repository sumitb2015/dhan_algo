/**
 * Breakdown Scalper Engine (/breakdown-scalper)
 *
 * Core pure module for the multi-strike option-premium breakdown selling strategy:
 *  1. Scans ATM ± N strikes (default ±6 strikes = 13 CE + 13 PE = 26 contracts).
 *  2. Evaluates option breakdown: price closes below Supertrend(10,2), session VWAP, and EMA20 on completed closed candles.
 *  3. Detects fresh breakdown: option candle closes below all three, while previous candle was NOT below all three.
 *  4. Evaluates underlying market direction (NIFTY):
 *     - Bullish trend (Spot > VWAP, EMA9 > EMA20, Spread >= 0) -> Only PE eligible for selling.
 *     - Bearish trend (Spot < VWAP, EMA9 < EMA20, Spread <= 0) -> Only CE eligible for selling.
 *     - Sideways / unclear -> No new trades (or user can bypass).
 *  5. Ranks qualifying signals when multiple strikes trigger simultaneously:
 *     - Freshness (highest rank for 1 bar ago)
 *     - Delta / ATM proximity (ATM or 1-3 OTM strikes preferred)
 *     - Traded volume and open interest liquidity
 *     - Breakdown depth (% below indicators)
 *  6. Position risk & trailing stop-loss:
 *     - Initial SL (% of entry premium)
 *     - Trailing SL (ratchets down as premium falls, never loosens)
 *     - Scalp target profit (% decay floor)
 *     - Indicator recovery exit (closes if price recovers above ST / EMA)
 *     - Daily loss limit & mandatory EOD cutoff (15:15 IST).
 */

import { emaSmaSeeded, supertrendSeries } from './indicators.ts';
import { resampleBars, type Bar } from './volumeProfile.ts';
import { closedBarsOnly, sessionVwap, type Timeframe } from './bearishStrikes.ts';

export interface BreakdownIndParams {
  stPeriod: number;
  stMult: number;
  emaPeriod: number;
}

export const DEFAULT_BREAKDOWN_PARAMS: BreakdownIndParams = {
  stPeriod: 10,
  stMult: 2,
  emaPeriod: 20,
};

export interface OptionIndicators {
  close: number | null;
  stLine: number | null;
  stDir: 1 | -1 | null;
  vwap: number | null;
  ema: number | null;
  barTime: string | null;
  barsUsed: number;
}

export interface OptionBreakdownState {
  indicators: OptionIndicators;
  belowSt: boolean;
  belowVwap: boolean;
  belowEma: boolean;
  isBreakdown: boolean;
  wasBreakdownPrev: boolean;
  isFreshBreakdown: boolean;
  barsSinceBreakdown: number;
  pctBelowSt: number | null;
  pctBelowVwap: number | null;
  pctBelowEma: number | null;
  avgPctBelow: number | null;
}

/**
 * Computes breakdown indicators and crossover freshness on closed bars of timeframe `tf`.
 */
export function evaluateOptionBreakdown(
  bars1m: Bar[],
  tf: Timeframe,
  nowIstMs: number,
  params: BreakdownIndParams = DEFAULT_BREAKDOWN_PARAMS,
): OptionBreakdownState {
  const emptyIndicators: OptionIndicators = {
    close: null,
    stLine: null,
    stDir: null,
    vwap: null,
    ema: null,
    barTime: null,
    barsUsed: 0,
  };

  const defaultState: OptionBreakdownState = {
    indicators: emptyIndicators,
    belowSt: false,
    belowVwap: false,
    belowEma: false,
    isBreakdown: false,
    wasBreakdownPrev: false,
    isFreshBreakdown: false,
    barsSinceBreakdown: 0,
    pctBelowSt: null,
    pctBelowVwap: null,
    pctBelowEma: null,
    avgPctBelow: null,
  };

  if (!bars1m || bars1m.length === 0) return defaultState;

  const resampled = resampleBars(bars1m, tf);
  const closedBars = closedBarsOnly(resampled, tf, nowIstMs);

  if (closedBars.length === 0) return defaultState;

  const st = supertrendSeries(
    closedBars.map((b) => ({ high: b.h, low: b.l, close: b.c })),
    params.stPeriod,
    params.stMult,
  );
  const ema = emaSmaSeeded(closedBars.map((b) => b.c), params.emaPeriod);
  const vwapSeries = sessionVwap(closedBars);

  const n = closedBars.length;
  const lastIdx = n - 1;

  const close = closedBars[lastIdx].c;
  const stLine = st[lastIdx].line;
  const stDir = st[lastIdx].dir;
  const vwapVal = vwapSeries[lastIdx];
  const emaVal = ema[lastIdx];

  const indicators: OptionIndicators = {
    close,
    stLine,
    stDir,
    vwap: vwapVal,
    ema: emaVal,
    barTime: closedBars[lastIdx].t,
    barsUsed: n,
  };

  const checkBarBreakdown = (idx: number): { isBd: boolean; belowSt: boolean; belowVw: boolean; belowEma: boolean } => {
    if (idx < 0 || idx >= n) return { isBd: false, belowSt: false, belowVw: false, belowEma: false };
    const c = closedBars[idx].c;
    const sLine = st[idx]?.line;
    const sDir = st[idx]?.dir;
    const vw = vwapSeries[idx];
    const em = ema[idx];

    const bSt = c != null && sLine != null && sDir === -1 && c < sLine;
    const bVw = c != null && vw != null && c < vw;
    const bEm = c != null && em != null && c < em;

    return {
      isBd: bSt && bVw && bEm,
      belowSt: bSt,
      belowVw: bVw,
      belowEma: bEm,
    };
  };

  const curr = checkBarBreakdown(lastIdx);
  const prev = checkBarBreakdown(lastIdx - 1);

  let barsSinceBreakdown = 0;
  if (curr.isBd) {
    for (let k = lastIdx; k >= 0; k--) {
      if (checkBarBreakdown(k).isBd) {
        barsSinceBreakdown++;
      } else {
        break;
      }
    }
  }

  const calcPctBelow = (lvl: number | null, pr: number): number | null => {
    if (lvl == null || lvl <= 0 || pr <= 0) return null;
    return ((lvl - pr) / lvl) * 100;
  };

  const pctSt = calcPctBelow(stLine, close);
  const pctVw = calcPctBelow(vwapVal, close);
  const pctEm = calcPctBelow(emaVal, close);

  const validPcts = [pctSt, pctVw, pctEm].filter((p): p is number => p != null && p > 0);
  const avgPct = validPcts.length > 0 ? validPcts.reduce((a, b) => a + b, 0) / validPcts.length : null;

  return {
    indicators,
    belowSt: curr.belowSt,
    belowVwap: curr.belowVw,
    belowEma: curr.belowEma,
    isBreakdown: curr.isBd,
    wasBreakdownPrev: prev.isBd,
    isFreshBreakdown: curr.isBd && !prev.isBd,
    barsSinceBreakdown,
    pctBelowSt: pctSt,
    pctBelowVwap: pctVw,
    pctBelowEma: pctEm,
    avgPctBelow: avgPct,
  };
}

export type TrendBias = 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
export type EligibleSide = 'PE' | 'CE' | 'NONE' | 'BOTH';
export type TrendFilterMode = 'AUTO' | 'BYPASS' | 'CE_ONLY' | 'PE_ONLY';

export interface UnderlyingTrend {
  spot: number;
  vwap: number | null;
  ema9: number | null;
  ema20: number | null;
  spread: number | null;
  trend: TrendBias;
  eligibleSide: EligibleSide;
  headline: string;
  detail: string;
}

/**
 * Determines market bias and option selling eligibility based on underlying (NIFTY) price vs indicators.
 *  - Bullish: Spot > VWAP, EMA9 > EMA20, positive spread -> PE selling eligible.
 *  - Bearish: Spot < VWAP, EMA9 < EMA20, negative spread -> CE selling eligible.
 *  - Sideways / Unclear -> Neither eligible (blocked).
 */
export function evaluateUnderlyingTrend(
  spot: number,
  vwap: number | null,
  ema9: number | null,
  ema20: number | null,
  mode: TrendFilterMode = 'AUTO',
): UnderlyingTrend {
  if (spot <= 0 || vwap == null || ema9 == null || ema20 == null) {
    return {
      spot,
      vwap,
      ema9,
      ema20,
      spread: null,
      trend: 'SIDEWAYS',
      eligibleSide: mode === 'BYPASS' ? 'BOTH' : mode === 'CE_ONLY' ? 'CE' : mode === 'PE_ONLY' ? 'PE' : 'NONE',
      headline: 'Awaiting Indicators',
      detail: 'Underlying telemetry warming up. Holding new trades.',
    };
  }

  const spread = ema9 - ema20;
  const isBull = spot > vwap && ema9 > ema20 && spread > 0;
  const isBear = spot < vwap && ema9 < ema20 && spread < 0;

  let trend: TrendBias = 'SIDEWAYS';
  if (isBull) trend = 'BULLISH';
  else if (isBear) trend = 'BEARISH';

  let eligibleSide: EligibleSide = 'NONE';
  if (mode === 'BYPASS') {
    eligibleSide = 'BOTH';
  } else if (mode === 'CE_ONLY') {
    eligibleSide = 'CE';
  } else if (mode === 'PE_ONLY') {
    eligibleSide = 'PE';
  } else {
    // AUTO mode: follow market trend
    if (trend === 'BULLISH') eligibleSide = 'PE';
    else if (trend === 'BEARISH') eligibleSide = 'CE';
    else eligibleSide = 'NONE';
  }

  let headline = '';
  let detail = '';

  if (trend === 'BULLISH') {
    headline = 'BULLISH TREND CONFIRMED';
    detail = `Spot (${spot.toFixed(1)}) > VWAP (${vwap.toFixed(1)}) and EMA9 > EMA20 (+${spread.toFixed(1)} spread). Only PUT (PE) selling permitted.`;
  } else if (trend === 'BEARISH') {
    headline = 'BEARISH TREND CONFIRMED';
    detail = `Spot (${spot.toFixed(1)}) < VWAP (${vwap.toFixed(1)}) and EMA9 < EMA20 (${spread.toFixed(1)} spread). Only CALL (CE) selling permitted.`;
  } else {
    headline = 'SIDEWAYS / RANGEBOUND CHOP';
    detail = `Underlying is consolidating without clean alignment. New selling is blocked to avoid whipsaw losses.`;
  }

  return {
    spot,
    vwap,
    ema9,
    ema20,
    spread,
    trend,
    eligibleSide,
    headline,
    detail,
  };
}

export interface CandidateSignal {
  strike: number;
  option: 'CE' | 'PE';
  contractKey: string;
  securityId?: string;
  ltp: number;
  volume: number;
  oi: number;
  buildup?: string;
  oiView?: 'confirm' | 'conflict' | null;
  distFromAtmPts: number;
  distFromAtmSteps: number;
  state: OptionBreakdownState;
  rankScore: number;
  isEligible: boolean;
  blockReason?: string;
}

export interface RankingWeights {
  freshness: number; // weight for fresh 1-bar breakdown
  atmProximity: number; // weight for ATM / near-OTM
  liquidity: number; // weight for volume & OI
  depth: number; // weight for breakdown depth (% below)
  oiBuildup: number; // weight for Short Buildup confirmation
}

export const DEFAULT_WEIGHTS: RankingWeights = {
  freshness: 35,
  atmProximity: 25,
  liquidity: 15,
  depth: 15,
  oiBuildup: 10,
};

/** A breakdown older than this many closed bars is not a fresh entry (it only scores, never trades). */
export const DEFAULT_MAX_BREAKDOWN_AGE = 3;

/**
 * Evaluates and ranks breakdown signals across all scanned strikes.
 * Highest scoring eligible strike is the top candidate to short.
 */
export function rankBreakdownSignals(
  candidates: {
    strike: number;
    option: 'CE' | 'PE';
    contractKey: string;
    securityId?: string;
    ltp: number;
    volume: number;
    oi: number;
    buildup?: string;
    state: OptionBreakdownState;
  }[],
  spot: number,
  atm: number,
  step: number,
  underlyingTrend: UnderlyingTrend,
  activeHeldKeys: Set<string>,
  minVolume = 1000,
  minOi = 5000,
  weights = DEFAULT_WEIGHTS,
  maxBarsSinceBreakdown = DEFAULT_MAX_BREAKDOWN_AGE,
): CandidateSignal[] {
  const maxVol = Math.max(1, ...candidates.map((c) => c.volume));
  const maxOi = Math.max(1, ...candidates.map((c) => c.oi));

  const scored: CandidateSignal[] = candidates.map((cand) => {
    const distPts = Math.abs(cand.strike - atm);
    const distSteps = step > 0 ? Math.round(distPts / step) : 0;

    let isEligible = true;
    let blockReason: string | undefined;

    // Filter 1: Must be in full breakdown (below ST, VWAP, EMA20)
    if (!cand.state.isBreakdown) {
      isEligible = false;
      blockReason = 'No breakdown: trading above indicator(s)';
    }

    // Filter 1b: the breakdown must be recent. Without this, a contract that stays below all three
    // indicators is re-shorted over and over after every stop-out.
    if (isEligible && cand.state.barsSinceBreakdown > maxBarsSinceBreakdown) {
      isEligible = false;
      blockReason = `Stale breakdown (${cand.state.barsSinceBreakdown} bars old, max ${maxBarsSinceBreakdown})`;
    }

    // Filter 2: Underlying market direction
    if (isEligible) {
      if (underlyingTrend.eligibleSide === 'NONE') {
        isEligible = false;
        blockReason = 'Market trend is SIDEWAYS (new entries blocked)';
      } else if (underlyingTrend.eligibleSide !== 'BOTH' && cand.option !== underlyingTrend.eligibleSide) {
        isEligible = false;
        blockReason = `Trend is ${underlyingTrend.trend}: only ${underlyingTrend.eligibleSide} selling allowed`;
      }
    }

    // Filter 3: Liquidity check
    if (isEligible) {
      if (cand.volume < minVolume) {
        isEligible = false;
        blockReason = `Low volume (${cand.volume} < ${minVolume})`;
      } else if (cand.oi < minOi) {
        isEligible = false;
        blockReason = `Low OI (${cand.oi} < ${minOi})`;
      }
    }

    // Filter 4: Already held in open positions
    if (isEligible && activeHeldKeys.has(cand.contractKey)) {
      isEligible = false;
      blockReason = 'Already open in active portfolio';
    }

    // Scoring components (0 to 100 scale)
    // 1. Freshness score: 100 for 1 bar ago, 75 for 2 bars ago, 50 for 3, decaying
    let freshnessScore = 0;
    if (cand.state.isFreshBreakdown || cand.state.barsSinceBreakdown === 1) {
      freshnessScore = 100;
    } else if (cand.state.barsSinceBreakdown === 2) {
      freshnessScore = 75;
    } else if (cand.state.barsSinceBreakdown === 3) {
      freshnessScore = 50;
    } else if (cand.state.barsSinceBreakdown > 3) {
      freshnessScore = Math.max(10, 40 - cand.state.barsSinceBreakdown * 5);
    }

    // 2. ATM proximity score: 100 at ATM or 1-2 strikes OTM, decaying as it gets further
    let proxScore = 100;
    if (distSteps > 1) {
      proxScore = Math.max(20, 100 - (distSteps - 1) * 15);
    }

    // 3. Liquidity score: relative volume & OI
    const volRatio = cand.volume / maxVol;
    const oiRatio = cand.oi / maxOi;
    const liqScore = Math.min(100, (volRatio * 50 + oiRatio * 50));

    // 4. Breakdown depth score: deeper below indicators = cleaner breakdown momentum
    const depthPct = cand.state.avgPctBelow ?? 0;
    const depthScore = Math.min(100, Math.max(0, depthPct * 10));

    // 5. OI Buildup confirmation score (from Bearish Strikes pattern)
    let oiScore = 50;
    let oiView: 'confirm' | 'conflict' | null = null;
    if (cand.buildup === 'SB' || cand.buildup === 'LU') {
      oiScore = 100;
      oiView = 'confirm';
    } else if (cand.buildup === 'LB') {
      oiScore = 10;
      oiView = 'conflict';
    }

    // Weighted composite
    const totalWeight =
      weights.freshness +
      weights.atmProximity +
      weights.liquidity +
      weights.depth +
      weights.oiBuildup;

    const rankScore = Math.round(
      (freshnessScore * weights.freshness +
        proxScore * weights.atmProximity +
        liqScore * weights.liquidity +
        depthScore * weights.depth +
        oiScore * weights.oiBuildup) /
        totalWeight,
    );

    return {
      strike: cand.strike,
      option: cand.option,
      contractKey: cand.contractKey,
      securityId: cand.securityId,
      ltp: cand.ltp,
      volume: cand.volume,
      oi: cand.oi,
      buildup: cand.buildup,
      oiView,
      distFromAtmPts: distPts,
      distFromAtmSteps: distSteps,
      state: cand.state,
      rankScore,
      isEligible,
      blockReason,
    };
  });

  // Sort eligible candidates first by rankScore descending, then ineligible
  return scored.sort((a, b) => {
    if (a.isEligible && !b.isEligible) return -1;
    if (!a.isEligible && b.isEligible) return 1;
    return b.rankScore - a.rankScore;
  });
}

/**
 * Calculates stop-loss, trailing stop-loss, and exit conditions for an active short position.
 */
export function evaluatePositionRisk(
  entryPrice: number,
  currentLtp: number,
  lowestPriceSeen: number,
  slPct: number,
  trailPct: number,
  targetDecayPct: number,
  stLine: number | null,
  emaLine: number | null,
  recoveryExitEnabled = false,
  previousTrailingSl?: number,
): {
  lowestPrice: number;
  initialSl: number;
  trailingSl: number;
  targetPrice: number | null;
  unrealizedPnlPct: number;
  isInitialSlHit: boolean;
  isTrailingSlHit: boolean;
  isTargetHit: boolean;
  isRecoveryExitHit: boolean;
  shouldExit: boolean;
  exitReason?: string;
} {
  const lowestPrice = Math.min(lowestPriceSeen, currentLtp);

  // For a short position: profit occurs when price falls.
  // Initial SL is above entry: entry * (1 + slPct / 100)
  const initialSl = Number((entryPrice * (1 + slPct / 100)).toFixed(2));

  // Trailing SL: starts at initialSl.
  // Only begins ratcheting down once price drops below entry in our favor!
  let trailingSl = initialSl;
  if (lowestPrice < entryPrice) {
    const ratchetedSl = Number((lowestPrice * (1 + trailPct / 100)).toFixed(2));
    trailingSl = Math.min(initialSl, ratchetedSl);
  }

  // Strictly enforce downward ratchet: Trailing SL can NEVER move up / loosen
  if (previousTrailingSl != null && previousTrailingSl > 0) {
    trailingSl = Math.min(trailingSl, previousTrailingSl);
  }

  // Scalp floor target: entry * (1 - targetDecayPct / 100)
  const targetPrice = targetDecayPct > 0 ? Number((entryPrice * (1 - targetDecayPct / 100)).toFixed(2)) : null;

  // Short P&L %: (entry - ltp) / entry * 100
  const unrealizedPnlPct = entryPrice > 0 ? ((entryPrice - currentLtp) / entryPrice) * 100 : 0;

  const isInitialSlHit = currentLtp >= initialSl;
  const isTrailingSlHit = currentLtp >= trailingSl;
  const isTargetHit = targetPrice != null && currentLtp <= targetPrice;

  // Indicator recovery exit: if option premium closes/recovers back above Supertrend or EMA
  const isRecoveryExitHit =
    recoveryExitEnabled &&
    ((stLine != null && currentLtp > stLine) || (emaLine != null && currentLtp > emaLine));

  let shouldExit = false;
  let exitReason: string | undefined;

  if (isTargetHit) {
    shouldExit = true;
    exitReason = `TARGET HIT: Captured ${targetDecayPct}% decay (LTP ₹${currentLtp.toFixed(1)} <= Target ₹${targetPrice})`;
  } else if (isTrailingSlHit && trailingSl < initialSl) {
    shouldExit = true;
    exitReason = `TRAILING SL HIT: Trailing stop at ₹${trailingSl.toFixed(1)} hit (Lowest was ₹${lowestPrice.toFixed(1)})`;
  } else if (isInitialSlHit) {
    shouldExit = true;
    exitReason = `INITIAL SL HIT: Loss reached ${slPct}% (LTP ₹${currentLtp.toFixed(1)} >= Initial SL ₹${initialSl.toFixed(1)})`;
  } else if (isRecoveryExitHit) {
    shouldExit = true;
    exitReason = `RECOVERY EXIT: Price recovered above indicator (ST: ₹${stLine?.toFixed(1) ?? '—'}, EMA: ₹${emaLine?.toFixed(1) ?? '—'})`;
  }

  return {
    lowestPrice,
    initialSl,
    trailingSl,
    targetPrice,
    unrealizedPnlPct,
    isInitialSlHit,
    isTrailingSlHit,
    isTargetHit,
    isRecoveryExitHit,
    shouldExit,
    exitReason,
  };
}
