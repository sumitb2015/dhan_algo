// Options Regime Score — deterministic (no LLM) three-layer scoring of the
// cumulative OI divergence into a bullish/bearish regime.
//
//   Layer 1 — OI Pressure:   OIScore       = Z(PE OI - CE OI)
//   Layer 2 — Momentum:      MomentumScore = Z(slope of D) + Z(accel of D)
//   Layer 3 — Confirmation:  Confirm       = Z(spot - session VWAP proxy)
//                                           + Z(NIFTY return)
//                                           + Z(PE/CE premium behavior)
//   FinalScore = 0.4*OIScore + 0.3*MomentumScore + 0.3*Confirm
//
// Classification: FinalScore > 1 => Bullish, < -1 => Bearish, |x| < 0.5 =>
// Neutral, 0.5-1 => Weak/Uncertain (not tradable per the spec).
//
// "NIFTY - VWAP" uses a session running-mean-of-spot proxy, not a literal
// VWAP: NIFTY spot has no traded volume, so VWAP is not well-defined for it
// (confirmed with the user). "PE/CE Premium Behavior" reuses the writing-
// vs-buying pressure index (OI change + premium change per side).
//
// Caution (per spec): these weights (0.4/0.3/0.3) are the spec's defaults,
// not backtested. Don't tune toward win rate — a high win rate with a few
// large losses can still have negative expected value
// (EV = P(win)*avgWin - P(loss)*avgLoss). Validate on historical data
// before sizing trades off this score.

export type RegimeLabel =
  | 'Bullish' | 'Weak Bullish' | 'Neutral' | 'Weak Bearish' | 'Bearish';

export interface RegimeInputPoint {
  spot: number;
  ceOI: number;
  peOI: number;
  ceLTP: number;
  peLTP: number;
  ceChgOI: number;
  peChgOI: number;
}

export interface RegimePoint {
  slope: number;
  accel: number;
  wpi: number;
}

export interface RegimeSnapshot {
  finalScore: number;
  oiScore: number;
  momentumScore: number;
  confirmScore: number;
  pBullish: number;
  label: RegimeLabel;
  strategy: string;
  tradable: boolean;
  transitionFlag: boolean;
  transitionDirection: 'bullish' | 'bearish' | null;
  warmingUp: boolean;
  sampleCount: number;
}

const EPS = 1;
const EPS_STD = 1e-6;
const MIN_SAMPLES = 10;       // ~5 min at 30s polling
const SLOPE_WINDOW = 10;      // samples (~5 min), for slope/accel of D
const RETURN_LOOKBACK = 30;   // samples (~15 min), for NIFTY return

const LAYER_WEIGHTS = { oi: 0.4, momentum: 0.3, confirm: 0.3 };
const THRESH_STRONG = 1;
const THRESH_NEUTRAL = 0.5;

export function rollingSlope(series: number[], i: number, window = SLOPE_WINDOW): number {
  const j = Math.max(0, i - window);
  return series[i] - series[j];
}

/** Signed writing/buying pressure contribution for one snapshot, normalized to [-1, 1]. */
export function classifyWritingPressure(
  ceOIChg: number, ceLtpChg: number, peOIChg: number, peLtpChg: number,
): number {
  // Put writing (OI up, premium down/flat) = bullish(+); put buying (OI up, premium up) = bearish(-)
  const peContribution = peOIChg > 0 ? (peLtpChg <= 0 ? 1 : -1) * Math.abs(peOIChg) : 0;
  // Call writing (OI up, premium down/flat) = bearish(-); call buying (OI up, premium up) = bullish(+)
  const ceContribution = ceOIChg > 0 ? (ceLtpChg <= 0 ? -1 : 1) * Math.abs(ceOIChg) : 0;
  const denom = Math.abs(peOIChg) + Math.abs(ceOIChg) + EPS;
  return (peContribution + ceContribution) / denom;
}

export function logReturn(spotNow: number, spotThen: number): number {
  if (spotNow <= 0 || spotThen <= 0) return 0;
  return Math.log(spotNow / spotThen);
}

/** Expanding-window z-score: uses only samples 0..i (no lookahead). */
export function zscore(series: number[], i: number): number {
  if (i < MIN_SAMPLES) return 0;
  const window = series.slice(0, i + 1);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
  const std = Math.sqrt(variance);
  if (std < EPS_STD) return 0;
  return (series[i] - mean) / std;
}

export function sigmoid(x: number, k = 1): number {
  return 1 / (1 + Math.exp(-k * x));
}

export function regimeLabelForScore(finalScore: number): RegimeLabel {
  if (finalScore > THRESH_STRONG) return 'Bullish';
  if (finalScore < -THRESH_STRONG) return 'Bearish';
  if (Math.abs(finalScore) < THRESH_NEUTRAL) return 'Neutral';
  return finalScore > 0 ? 'Weak Bullish' : 'Weak Bearish';
}

export function suggestedStrategyFor(label: RegimeLabel): string {
  switch (label) {
    case 'Bullish':      return 'Bull Put Spread';
    case 'Neutral':      return 'Iron Condor';
    case 'Bearish':      return 'Bear Call Spread';
    case 'Weak Bullish':
    case 'Weak Bearish': return 'No trade — signal weak/uncertain';
  }
}

function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/** Regime-transition flag: D crosses zero, confirmed by slope direction and spot move. */
function detectTransition(
  dSeries: number[], slopeSeries: number[], spots: number[], i: number, lookback = SLOPE_WINDOW,
): { flag: boolean; direction: 'bullish' | 'bearish' | null } {
  if (i < 1 || i < MIN_SAMPLES) return { flag: false, direction: null };
  const prevSign = sign(dSeries[i - 1]);
  const curSign = sign(dSeries[i]);
  if (prevSign === curSign || curSign === 0) return { flag: false, direction: null };
  const slopeSign = sign(slopeSeries[i]);
  if (slopeSign !== curSign) return { flag: false, direction: null };
  const j = Math.max(0, i - lookback);
  const priceSign = sign(spots[i] - spots[j]);
  if (priceSign !== curSign) return { flag: false, direction: null };
  return { flag: true, direction: curSign > 0 ? 'bullish' : 'bearish' };
}

export interface RegimeSeriesResult {
  points: RegimePoint[];
  latest: RegimeSnapshot;
}

/** Single entry point: computes the full augmented series plus the latest three-layer summary. */
export function computeRegimeSeries(input: RegimeInputPoint[]): RegimeSeriesResult {
  const n = input.length;
  const spots = input.map(p => p.spot);

  // Layer 1 — D = PE OI - CE OI (raw divergence, matches the existing 'diff' chart series)
  const dSeries: number[] = new Array(n);
  for (let i = 0; i < n; i++) dSeries[i] = input[i].peOI - input[i].ceOI;

  // Layer 2 — momentum of D
  const slopeSeries: number[] = new Array(n);
  const accelSeries: number[] = new Array(n);
  for (let i = 0; i < n; i++) slopeSeries[i] = rollingSlope(dSeries, i);
  for (let i = 0; i < n; i++) accelSeries[i] = rollingSlope(slopeSeries, i);

  // Layer 3 — confirmation: spot vs session VWAP proxy, NIFTY return, PE/CE premium behavior
  const sessionAvgSpot: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    sessionAvgSpot[i] = spots.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1);
  }
  const spotDeviationSeries: number[] = new Array(n);
  for (let i = 0; i < n; i++) spotDeviationSeries[i] = spots[i] - sessionAvgSpot[i];

  const niftyReturnSeries: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const j = Math.max(0, i - RETURN_LOOKBACK);
    niftyReturnSeries[i] = logReturn(spots[i], spots[j]);
  }

  const wpiSeries: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    wpiSeries[i] = classifyWritingPressure(
      input[i].ceChgOI, i > 0 ? input[i].ceLTP - input[i - 1].ceLTP : 0,
      input[i].peChgOI, i > 0 ? input[i].peLTP - input[i - 1].peLTP : 0,
    );
  }

  const points: RegimePoint[] = new Array(n);
  const oiScoreSeries: number[] = new Array(n);
  const momentumScoreSeries: number[] = new Array(n);
  const confirmScoreSeries: number[] = new Array(n);
  const finalScoreSeries: number[] = new Array(n);
  const pBullishSeries: number[] = new Array(n);

  for (let i = 0; i < n; i++) {
    points[i] = { slope: slopeSeries[i], accel: accelSeries[i], wpi: wpiSeries[i] };

    const oiScore = zscore(dSeries, i);
    const momentumScore = zscore(slopeSeries, i) + zscore(accelSeries, i);
    const confirmScore = zscore(spotDeviationSeries, i) + zscore(niftyReturnSeries, i) + zscore(wpiSeries, i);
    const finalScore = LAYER_WEIGHTS.oi * oiScore + LAYER_WEIGHTS.momentum * momentumScore + LAYER_WEIGHTS.confirm * confirmScore;

    oiScoreSeries[i] = oiScore;
    momentumScoreSeries[i] = momentumScore;
    confirmScoreSeries[i] = confirmScore;
    finalScoreSeries[i] = finalScore;
    pBullishSeries[i] = sigmoid(finalScore);
  }

  if (n === 0) {
    return {
      points: [],
      latest: {
        finalScore: 0, oiScore: 0, momentumScore: 0, confirmScore: 0, pBullish: 0.5,
        label: 'Neutral', strategy: suggestedStrategyFor('Neutral'), tradable: true,
        transitionFlag: false, transitionDirection: null, warmingUp: true, sampleCount: 0,
      },
    };
  }

  const last = n - 1;
  const warmingUp = n <= MIN_SAMPLES;
  const label = warmingUp ? 'Neutral' : regimeLabelForScore(finalScoreSeries[last]);
  const tradable = label === 'Bullish' || label === 'Bearish' || label === 'Neutral';
  const { flag, direction } = warmingUp
    ? { flag: false, direction: null as 'bullish' | 'bearish' | null }
    : detectTransition(dSeries, slopeSeries, spots, last);

  return {
    points,
    latest: {
      finalScore: warmingUp ? 0 : finalScoreSeries[last],
      oiScore: warmingUp ? 0 : oiScoreSeries[last],
      momentumScore: warmingUp ? 0 : momentumScoreSeries[last],
      confirmScore: warmingUp ? 0 : confirmScoreSeries[last],
      pBullish: warmingUp ? 0.5 : pBullishSeries[last],
      label,
      strategy: suggestedStrategyFor(label),
      tradable,
      transitionFlag: flag,
      transitionDirection: direction,
      warmingUp,
      sampleCount: n,
    },
  };
}
