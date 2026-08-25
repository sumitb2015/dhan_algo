// Options Regime Score — deterministic (no LLM) scoring of the cumulative
// OI divergence into a bullish/bearish regime, with writing-vs-buying
// pressure and a volatility-normalized price-trend confirmation term.
// See plan: normalized divergence + slope + acceleration + writing pressure
// + multi-horizon volatility-normalized price trend, combined via z-scores
// into a sigmoid-mapped P(bullish).

export type RegimeLabel =
  | 'Strong Bullish' | 'Bullish' | 'Neutral' | 'Bearish' | 'Strong Bearish';

export interface RegimeInputPoint {
  ts:   number;
  spot: number;
  ceOI: number;
  peOI: number;
  ceLTP: number;
  peLTP: number;
  ceChgOI: number;
  peChgOI: number;
}

export interface RegimePoint {
  dNorm: number;
  slope: number;
  accel: number;
  wpi: number;
  priceTrend: number;
}

export interface RegimeSnapshot {
  score: number;
  pBullish: number;
  label: RegimeLabel;
  strategy: string;
  transitionFlag: boolean;
  transitionDirection: 'bullish' | 'bearish' | null;
  warmingUp: boolean;
  sampleCount: number;
}

const EPS = 1;
const EPS_STD = 1e-6;
const MIN_SAMPLES = 10;      // ~5 min at 30s polling
const SLOPE_WINDOW = 10;     // samples (~5 min)

const REGIME_WEIGHTS = {
  divergence: 0.30,
  slope: 0.20,
  acceleration: 0.15,
  writingPressure: 0.20,
  priceTrend: 0.15,
};

// Price-trend horizons, in samples at the 30s collector cadence.
// 15/30/60-minute log returns, each normalized by realized vol over a
// matching lookback window — a volume-independent substitute for VWAP/ATR
// (NIFTY spot has no traded volume, so a literal VWAP is not meaningful).
const PRICE_TREND_HORIZONS = [
  { k: 30,  n: 120, weight: 0.5 },  // 15 min return / ~1hr vol
  { k: 60,  n: 120, weight: 0.3 },  // 30 min return / ~1hr vol
  { k: 120, n: 240, weight: 0.2 },  // 60 min return / ~2hr vol
];

export function computeDNorm(peOI: number, ceOI: number): number {
  return (peOI - ceOI) / (Math.abs(peOI) + Math.abs(ceOI) + EPS);
}

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

/** Stdev of consecutive log returns over the last `n` samples ending at i. */
export function rollingStdevLogReturn(spots: number[], i: number, n: number): number {
  const start = Math.max(1, i - n + 1);
  const returns: number[] = [];
  for (let k = start; k <= i; k++) {
    if (spots[k] > 0 && spots[k - 1] > 0) returns.push(Math.log(spots[k] / spots[k - 1]));
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

/** Volatility-normalized, multi-horizon log-return price trend (no VWAP/ATR). */
export function priceTrend(spots: number[], i: number): number {
  let total = 0;
  let weightUsed = 0;
  for (const { k, n, weight } of PRICE_TREND_HORIZONS) {
    if (i < MIN_SAMPLES) continue;
    const kEff = Math.min(k, i);
    const nEff = Math.min(n, i);
    const sigma = rollingStdevLogReturn(spots, i, nEff);
    if (sigma < EPS_STD) continue;
    const r = logReturn(spots[i], spots[i - kEff]);
    total += weight * (r / (sigma * Math.sqrt(kEff)));
    weightUsed += weight;
  }
  return weightUsed > 0 ? total / weightUsed : 0;
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

export function regimeLabelForP(p: number): RegimeLabel {
  if (p > 0.75) return 'Strong Bullish';
  if (p > 0.58) return 'Bullish';
  if (p > 0.42) return 'Neutral';
  if (p > 0.25) return 'Bearish';
  return 'Strong Bearish';
}

export function suggestedStrategyFor(label: RegimeLabel): string {
  switch (label) {
    case 'Strong Bullish': return 'Bull Put Spread / long call debit spread';
    case 'Bullish':        return 'Bull Put Spread';
    case 'Neutral':        return 'Iron Condor / Iron Fly';
    case 'Bearish':        return 'Bear Call Spread';
    case 'Strong Bearish': return 'Bear Call Spread / long put debit spread';
  }
}

function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/** Regime-transition flag: dNorm crosses zero, confirmed by slope direction and spot move. */
function detectTransition(
  dNormSeries: number[], slopeSeries: number[], spots: number[], i: number, lookback = SLOPE_WINDOW,
): { flag: boolean; direction: 'bullish' | 'bearish' | null } {
  if (i < 1 || i < MIN_SAMPLES) return { flag: false, direction: null };
  const prevSign = sign(dNormSeries[i - 1]);
  const curSign = sign(dNormSeries[i]);
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

/** Single entry point: computes the full augmented series plus the latest summary. */
export function computeRegimeSeries(input: RegimeInputPoint[]): RegimeSeriesResult {
  const n = input.length;
  const spots = input.map(p => p.spot);

  const dNormSeries: number[] = new Array(n);
  const slopeSeries: number[] = new Array(n);
  const accelSeries: number[] = new Array(n);
  const wpiSeries: number[] = new Array(n);
  const priceTrendSeries: number[] = new Array(n);

  for (let i = 0; i < n; i++) {
    dNormSeries[i] = computeDNorm(input[i].peOI, input[i].ceOI);
  }
  for (let i = 0; i < n; i++) {
    slopeSeries[i] = rollingSlope(dNormSeries, i);
  }
  for (let i = 0; i < n; i++) {
    accelSeries[i] = rollingSlope(slopeSeries, i);
  }
  for (let i = 0; i < n; i++) {
    wpiSeries[i] = classifyWritingPressure(
      input[i].ceChgOI, i > 0 ? input[i].ceLTP - input[i - 1].ceLTP : 0,
      input[i].peChgOI, i > 0 ? input[i].peLTP - input[i - 1].peLTP : 0,
    );
  }
  for (let i = 0; i < n; i++) {
    priceTrendSeries[i] = priceTrend(spots, i);
  }

  const points: RegimePoint[] = new Array(n);
  const scoreSeries: number[] = new Array(n);
  const pBullishSeries: number[] = new Array(n);

  for (let i = 0; i < n; i++) {
    points[i] = {
      dNorm: dNormSeries[i],
      slope: slopeSeries[i],
      accel: accelSeries[i],
      wpi: wpiSeries[i],
      priceTrend: priceTrendSeries[i],
    };
    const score =
      REGIME_WEIGHTS.divergence * zscore(dNormSeries, i) +
      REGIME_WEIGHTS.slope * zscore(slopeSeries, i) +
      REGIME_WEIGHTS.acceleration * zscore(accelSeries, i) +
      REGIME_WEIGHTS.writingPressure * zscore(wpiSeries, i) +
      REGIME_WEIGHTS.priceTrend * zscore(priceTrendSeries, i);
    scoreSeries[i] = score;
    pBullishSeries[i] = sigmoid(score);
  }

  if (n === 0) {
    return {
      points: [],
      latest: {
        score: 0, pBullish: 0.5, label: 'Neutral', strategy: suggestedStrategyFor('Neutral'),
        transitionFlag: false, transitionDirection: null, warmingUp: true, sampleCount: 0,
      },
    };
  }

  const last = n - 1;
  const warmingUp = n <= MIN_SAMPLES;
  const label = warmingUp ? 'Neutral' : regimeLabelForP(pBullishSeries[last]);
  const { flag, direction } = warmingUp
    ? { flag: false, direction: null as 'bullish' | 'bearish' | null }
    : detectTransition(dNormSeries, slopeSeries, spots, last);

  return {
    points,
    latest: {
      score: warmingUp ? 0 : scoreSeries[last],
      pBullish: warmingUp ? 0.5 : pBullishSeries[last],
      label,
      strategy: suggestedStrategyFor(label),
      transitionFlag: flag,
      transitionDirection: direction,
      warmingUp,
      sampleCount: n,
    },
  };
}
