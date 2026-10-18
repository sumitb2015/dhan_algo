/**
 * Breakdown Scalper Engine (/breakdown-scalper)
 *
 * Core pure module for the multi-strike option-premium breakdown selling strategy:
 *  1. Scans ATM ± N strikes (default ±6 strikes = 13 CE + 13 PE = 26 contracts).
 *  2. Evaluates option breakdown: price closes below Supertrend(10,2), session VWAP, and EMA20 on completed closed candles.
 *  3. Detects fresh breakdown: option candle closes below all three, while previous candle was NOT below all three.
 *  4. Evaluates underlying market direction (NIFTY):
 *     - Bullish trend (EMA fast > EMA slow, and index Supertrend up when enabled) -> Only PE eligible for selling.
 *     - Bearish trend (EMA fast < EMA slow, and index Supertrend down when enabled) -> Only CE eligible for selling.
 *     (No VWAP: the index has no volume, so its "VWAP" was only the day's average price.)
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
  stMult?: number;
  stMultiplier?: number;
  emaPeriod: number;
  useSupertrend?: boolean;
  useVwap?: boolean;
  useEma?: boolean;
}

export const DEFAULT_BREAKDOWN_PARAMS: BreakdownIndParams = {
  stPeriod: 10,
  stMult: 2,
  stMultiplier: 2,
  emaPeriod: 20,
  useSupertrend: true,
  useVwap: true,
  useEma: true,
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

  const stPeriod = params.stPeriod ?? 10;
  const stMult = params.stMultiplier ?? params.stMult ?? 2;
  const emaPeriod = params.emaPeriod ?? 20;

  const st = supertrendSeries(
    closedBars.map((b) => ({ high: b.h, low: b.l, close: b.c })),
    stPeriod,
    stMult,
  );
  const ema = emaSmaSeeded(closedBars.map((b) => b.c), emaPeriod);
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

  const useSt = params.useSupertrend !== false;
  const useVw = params.useVwap !== false;
  const useEm = params.useEma !== false;

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

    const activeChecks: boolean[] = [];
    if (useSt) activeChecks.push(bSt);
    if (useVw) activeChecks.push(bVw);
    if (useEm) activeChecks.push(bEm);
    const isBd = activeChecks.length > 0 ? activeChecks.every(Boolean) : (bSt && bVw && bEm);

    return {
      isBd,
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

  const validPcts = [
    useSt ? pctSt : null,
    useVw ? pctVw : null,
    useEm ? pctEm : null,
  ].filter((p): p is number => p != null && p > 0);
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
  emaFast: number | null;
  emaSlow: number | null;
  /** Index Supertrend line and direction (1 up, -1 down); null when disabled or still warming up. */
  stLine: number | null;
  stDir: 1 | -1 | null;
  spread: number | null;
  trend: TrendBias;
  eligibleSide: EligibleSide;
  headline: string;
  detail: string;
}

/** Index (NIFTY) trend settings: EMA fast/slow cross, optionally confirmed by a Supertrend on the same bars. */
export interface IndexTrendParams {
  useEma: boolean;
  emaFast: number;
  emaSlow: number;
  useSupertrend: boolean;
  stPeriod: number;
  stMultiplier: number;
}

/**
 * Defaults from the 2026-10-18 backtest: the EMA cross alone made the most (+₹4.10L over 124 sessions); every index
 * Supertrend variant cut profit (best, 7/3: +₹3.37L, though with lower drawdown), so it is off and starts at 7/3 when on.
 */
export const DEFAULT_INDEX_TREND: IndexTrendParams = { useEma: true, emaFast: 9, emaSlow: 20, useSupertrend: false, stPeriod: 7, stMultiplier: 3 };

/** Index trend settings from a config, with defaults for fields an older config does not have. */
export function indexTrendParamsOf(c: {
  trendUseEma?: boolean;
  trendEmaFast?: number;
  trendEmaSlow?: number;
  trendUseSupertrend?: boolean;
  trendStPeriod?: number;
  trendStMultiplier?: number;
}): IndexTrendParams {
  return {
    useEma: c.trendUseEma ?? DEFAULT_INDEX_TREND.useEma,
    emaFast: c.trendEmaFast ?? DEFAULT_INDEX_TREND.emaFast,
    emaSlow: c.trendEmaSlow ?? DEFAULT_INDEX_TREND.emaSlow,
    useSupertrend: c.trendUseSupertrend ?? DEFAULT_INDEX_TREND.useSupertrend,
    stPeriod: c.trendStPeriod ?? DEFAULT_INDEX_TREND.stPeriod,
    stMultiplier: c.trendStMultiplier ?? DEFAULT_INDEX_TREND.stMultiplier,
  };
}

/** EMA seeded on the first value (pandas ewm adjust=False, which the live feed used): the last value, or null. */
function ewmLastOf(values: number[], span: number): number | null {
  if (!values.length) return null;
  const a = 2 / (span + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = a * values[i] + (1 - a) * e;
  return e;
}

/**
 * The index trend inputs from the session's bar closes on the trend timeframe, oldest first (the last one may be the
 * forming bar). Shared by the live page (feed candles) and the backtest (spot closes), so both decide alike. The
 * Supertrend's ATR is close-to-close (high = low = close per bar): the backtest only stores index closes, so the live
 * page must not use the candle highs and lows either.
 */
export function indexTrendInputs(closes: number[], p: IndexTrendParams) {
  const emaFast = ewmLastOf(closes, p.emaFast);
  const emaSlow = ewmLastOf(closes, p.emaSlow);
  let stLine: number | null = null;
  let stDir: 1 | -1 | null = null;
  if (p.useSupertrend) {
    const st = supertrendSeries(closes.map((c) => ({ high: c, low: c, close: c })), p.stPeriod, p.stMultiplier);
    const last = st[st.length - 1];
    if (last) {
      stLine = last.line;
      stDir = last.dir;
    }
  }
  return { spot: closes[closes.length - 1] ?? 0, emaFast, emaSlow, stLine, stDir };
}

/**
 * Market bias and option-selling eligibility from the index trend inputs:
 *  - Bullish: EMA fast > EMA slow (if enabled) and Supertrend up (if enabled) -> PE selling eligible.
 *  - Bearish: EMA fast < EMA slow (if enabled) and Supertrend down (if enabled) -> CE selling eligible.
 *  - Both off -> no trend filter, both sides eligible in AUTO mode.
 *  - Disagreeing / still warming up -> neither (blocked) in AUTO mode.
 */
export function evaluateUnderlyingTrend(
  inputs: { spot: number; emaFast: number | null; emaSlow: number | null; stLine: number | null; stDir: 1 | -1 | null },
  p: IndexTrendParams,
  mode: TrendFilterMode = 'AUTO',
): UnderlyingTrend {
  const { spot, emaFast, emaSlow, stLine, stDir } = inputs;
  const forced: EligibleSide = mode === 'BYPASS' ? 'BOTH' : mode === 'CE_ONLY' ? 'CE' : mode === 'PE_ONLY' ? 'PE' : 'NONE';
  const emaActive = p.useEma !== false;
  const stActive = p.useSupertrend;

  const spread = emaFast != null && emaSlow != null ? emaFast - emaSlow : null;

  // If neither filter is active, allow both sides in AUTO mode
  if (!emaActive && !stActive) {
    return {
      spot,
      emaFast,
      emaSlow,
      stLine,
      stDir,
      spread,
      trend: 'SIDEWAYS',
      eligibleSide: mode === 'AUTO' ? 'BOTH' : forced,
      headline: 'TREND FILTER OFF',
      detail: 'Index EMA cross and Supertrend are both off. All breakdown signals are eligible.',
    };
  }

  if (spot <= 0 || (emaActive && (emaFast == null || emaSlow == null)) || (stActive && stDir == null)) {
    return {
      spot,
      emaFast,
      emaSlow,
      stLine,
      stDir,
      spread,
      trend: 'SIDEWAYS',
      eligibleSide: forced,
      headline: 'Awaiting Indicators',
      detail: 'Underlying telemetry warming up. Holding new trades.',
    };
  }

  const emaBull = emaActive ? (spread != null && spread > 0) : true;
  const emaBear = emaActive ? (spread != null && spread < 0) : true;
  const stBull = stActive ? (stDir === 1) : true;
  const stBear = stActive ? (stDir === -1) : true;

  const isBull = emaBull && stBull;
  const isBear = emaBear && stBear;
  const trend: TrendBias = isBull ? 'BULLISH' : isBear ? 'BEARISH' : 'SIDEWAYS';

  let eligibleSide: EligibleSide = forced;
  if (mode === 'AUTO') eligibleSide = trend === 'BULLISH' ? 'PE' : trend === 'BEARISH' ? 'CE' : 'NONE';

  const parts: string[] = [];
  if (emaActive && spread != null) {
    parts.push(`EMA${p.emaFast} ${spread > 0 ? '>' : spread < 0 ? '<' : '='} EMA${p.emaSlow} (${spread > 0 ? '+' : ''}${spread.toFixed(1)})`);
  }
  if (stActive) {
    parts.push(`Supertrend(${p.stPeriod}, ${p.stMultiplier}) ${stDir === 1 ? 'up' : 'down'}`);
  }
  const summary = parts.join(' and ');

  let headline: string;
  let detail: string;
  if (trend === 'BULLISH') {
    headline = 'BULLISH TREND CONFIRMED';
    detail = `${summary}. Only PUT (PE) selling permitted.`;
  } else if (trend === 'BEARISH') {
    headline = 'BEARISH TREND CONFIRMED';
    detail = `${summary}. Only CALL (CE) selling permitted.`;
  } else {
    headline = 'SIDEWAYS / RANGEBOUND CHOP';
    detail = `${summary}: the trend checks disagree. New selling is blocked to avoid whipsaw losses.`;
  }

  return { spot, emaFast, emaSlow, stLine, stDir, spread, trend, eligibleSide, headline, detail };
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
  trailStartPct?: number,
  trailStepPts?: number,
  trailByPts?: number,
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

  // Lock & Trail Stop-Loss:
  // Starts at initialSl and gives full breathing room before profit reaches the trigger threshold.
  // Once profit reaches trailStartPct (default 15%), SL locks to cost (entryPrice).
  // For every trailStepPts (x points) gain beyond the threshold, SL ratchets down by trailByPts (y points).
  const startPct = trailStartPct ?? (trailPct > 0 ? trailPct : 15);
  const stepPts = trailStepPts ?? 5;
  const byPts = trailByPts ?? 2;

  let trailingSl = initialSl;
  const profitPts = entryPrice - lowestPrice;
  const profitPct = entryPrice > 0 ? (profitPts / entryPrice) * 100 : 0;

  if (startPct > 0 && profitPct >= startPct - 1e-9) {
    const thresholdGainPts = entryPrice * (startPct / 100);
    const extraGainPts = Math.max(0, profitPts - thresholdGainPts);
    const steps = stepPts > 0 && byPts > 0 ? Math.floor(extraGainPts / stepPts + 1e-9) : 0;
    const ratchetedSl = Number((entryPrice - steps * byPts).toFixed(2));
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
