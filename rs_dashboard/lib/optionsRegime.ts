// Options Regime Score — deterministic (no LLM) scoring of the cumulative OI
// divergence into a bullish/bearish regime.
//
// Every input is standardized to a z-score BEFORE combining or plotting —
// raw OI divergence (tens of millions), raw slope (thousands/sample), and
// raw writing-pressure live on wildly different scales, so mixing or
// charting them unstandardized is not meaningful.
//
//   D            = PE OI - CE OI                          (raw divergence)
//   Slope        = rolling linear-regression slope of D over the last 15 min
//   Accel        = Slope_t - Slope_{t-k}
//   WPI          = PutPressure + CallPressure, where
//                    PutPressure  = ΔPE_OI * (-ΔPE_Premium)
//                    CallPressure = ΔCE_OI * (ΔCE_Premium)
//                  Continuous, not a binary writing/buying classification —
//                  sign falls out of the product (put OI up + premium down
//                  = positive = bullish put writing; call OI up + premium
//                  up = positive = bullish call buying; etc.)
//   PriceTrend   = avg(Z(spot - session VWAP proxy), Z(NIFTY return))
//
//   Z*     = clip(Z, -3, +3)                      -- capped before combining,
//                                                     so one extreme reading
//                                                     (e.g. a PriceTrend_Z of
//                                                     3.6) can't single-handedly
//                                                     dominate the score
//   Signal = 0.25*OI_Z* + 0.20*Slope_Z* + 0.10*Accel_Z* + 0.25*WPI_Z* + 0.20*PriceTrend_Z*
//   Confidence = 0.30*|OI_Z*| + 0.20*|Slope_Z*| + 0.25*|WPI_Z*| + 0.25*|PriceTrend_Z*|
//
// Classification: >1.25 Strong Bullish, 0.5-1.25 Bullish, |x|<0.5 Neutral,
// -1.25..-0.5 Bearish, <-1.25 Strong Bearish.
//
// Per-factor zone: Z>0.5 => Bullish, Z<-0.5 => Bearish, else Neutral. A lone
// factor sitting near zero (e.g. Slope_Z=-0.14) is noise, not disagreement —
// it should read as "not yet confirming", not "bearish".
//
// Market bias (the label above) is a SEPARATE output from trade confirmation:
// a bullish/bearish label only becomes "Confirmed" when OI_Z, WPI_Z and
// PriceTrend_Z are ALL in the matching zone (>0.5 bullish / <-0.5 bearish).
// Slope is a preferred-but-not-required secondary confirmation (surfaced in
// `reason`, not gating `confirmed`) — a single noisy slope reading shouldn't
// veto an otherwise-aligned OI+WPI+PriceTrend read. Without confirmation the
// suggestion is "No trade" even when the bias reads Bullish/Bearish — that
// restraint is deliberate for an options-selling system.
//
// "NIFTY - VWAP" uses a session running-mean-of-spot proxy, not a literal
// VWAP: NIFTY spot has no traded volume, so VWAP is not well-defined for it
// (confirmed with the user).
//
// Caution: these weights are the spec's defaults, not backtested. Don't tune
// toward win rate — a high win rate with a few large losses can still have
// negative expected value (EV = P(win)*avgWin - P(loss)*avgLoss). Validate
// on historical data before sizing trades off this score.

export type RegimeLabel =
  | 'Strong Bullish' | 'Bullish' | 'Neutral' | 'Bearish' | 'Strong Bearish';

export type Zone = 'Bullish' | 'Neutral' | 'Bearish';
export type ConfidenceLabel = 'Low' | 'Moderate' | 'High';
export type ConfirmationState = 'Confirmed' | 'Pending' | 'N/A';

export interface RegimeInputPoint {
  spot: number;
  ceOI: number;
  peOI: number;
  ceLTP: number;
  peLTP: number;
  ceChgOI: number;
  peChgOI: number;
}

/** Per-sample standardized (uncapped) values — what the chart plots. */
export interface RegimePoint {
  oiZ: number;
  slopeZ: number;
  accelZ: number;
  wpiZ: number;
  priceTrendZ: number;
}

export interface RegimeSnapshot {
  signal: number;
  oiZ: number;
  slopeZ: number;
  accelZ: number;
  wpiZ: number;
  priceTrendZ: number;
  oiZone: Zone;
  slopeZone: Zone;
  wpiZone: Zone;
  priceTrendZone: Zone;
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  label: RegimeLabel;
  strategy: string;
  confirmed: boolean;
  confirmationState: ConfirmationState;
  reason: string;
  transitionFlag: boolean;
  transitionDirection: 'bullish' | 'bearish' | null;
  warmingUp: boolean;
  sampleCount: number;
}

const EPS_STD = 1e-6;
const MIN_SAMPLES = 10;          // ~5 min at 30s polling — z-score warmup gate
const REGRESSION_WINDOW = 30;    // samples (~15 min), for rolling-regression slope of D
const ACCEL_WINDOW = 10;         // samples (~5 min), for slope-of-slope
const RETURN_LOOKBACK = 30;      // samples (~15 min), for NIFTY return

const SIGNAL_WEIGHTS = { oi: 0.25, slope: 0.20, accel: 0.10, wpi: 0.25, priceTrend: 0.20 };
const CONFIDENCE_WEIGHTS = { oi: 0.30, slope: 0.20, wpi: 0.25, priceTrend: 0.25 };
const Z_CAP = 3;
const THRESH_STRONG = 1.25;
const THRESH_DIRECTIONAL = 0.5;
const ZONE_THRESH = 0.5;         // per-factor Bullish/Neutral/Bearish zone boundary
const CONFIDENCE_HIGH = 1.5;
const CONFIDENCE_MODERATE = 0.7;

export function clip(z: number, limit = Z_CAP): number {
  return Math.max(-limit, Math.min(limit, z));
}

export function zoneFor(z: number): Zone {
  if (z > ZONE_THRESH) return 'Bullish';
  if (z < -ZONE_THRESH) return 'Bearish';
  return 'Neutral';
}

/** Least-squares slope of `series` over the last `window` points ending at i (fewer early on). */
export function rollingRegressionSlope(series: number[], i: number, window = REGRESSION_WINDOW): number {
  const start = Math.max(0, i - window + 1);
  const m = i - start + 1;
  if (m < 2) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let k = 0; k < m; k++) {
    const x = k;
    const y = series[start + k];
    sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
  }
  const denom = m * sumXX - sumX * sumX;
  if (Math.abs(denom) < EPS_STD) return 0;
  return (m * sumXY - sumX * sumY) / denom;
}

export function rollingDelta(series: number[], i: number, window: number): number {
  const j = Math.max(0, i - window);
  return series[i] - series[j];
}

/** Continuous writing/buying pressure: sign and magnitude both fall out of the OI-change x premium-change product. */
export function writingPressure(ceOIChg: number, ceLtpChg: number, peOIChg: number, peLtpChg: number): number {
  const putPressure = peOIChg * -peLtpChg;
  const callPressure = ceOIChg * ceLtpChg;
  return putPressure + callPressure;
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

export function regimeLabelForSignal(signal: number): RegimeLabel {
  if (signal > THRESH_STRONG) return 'Strong Bullish';
  if (signal < -THRESH_STRONG) return 'Strong Bearish';
  if (Math.abs(signal) < THRESH_DIRECTIONAL) return 'Neutral';
  return signal > 0 ? 'Bullish' : 'Bearish';
}

export function confidenceLabelFor(confidence: number): ConfidenceLabel {
  if (confidence >= CONFIDENCE_HIGH) return 'High';
  if (confidence >= CONFIDENCE_MODERATE) return 'Moderate';
  return 'Low';
}

function isBullishLabel(label: RegimeLabel): boolean {
  return label === 'Bullish' || label === 'Strong Bullish';
}
function isBearishLabel(label: RegimeLabel): boolean {
  return label === 'Bearish' || label === 'Strong Bearish';
}

/**
 * Bullish/bearish confirmation requires OI, WPI and PriceTrend to all be in the
 * matching zone (>0.5 / <-0.5). Slope is a preferred-not-required secondary
 * signal — surfaced in `reason`, not part of this gate — so a single noisy
 * slope reading near zero can't veto an otherwise-aligned read.
 */
export function isConfirmed(label: RegimeLabel, oiZone: Zone, wpiZone: Zone, priceTrendZone: Zone): boolean {
  if (label === 'Neutral') return true;
  const dir: Zone = isBullishLabel(label) ? 'Bullish' : 'Bearish';
  return oiZone === dir && wpiZone === dir && priceTrendZone === dir;
}

export function suggestedStrategyFor(label: RegimeLabel, confirmed: boolean): string {
  if (label === 'Neutral') return 'Iron Condor';
  if (!confirmed) return 'No trade — regime not confirmed';
  return isBullishLabel(label) ? 'Bull Put Spread' : 'Bear Call Spread';
}

function buildReason(
  label: RegimeLabel, oiZone: Zone, slopeZone: Zone, wpiZone: Zone, priceTrendZone: Zone,
): string {
  if (label === 'Neutral') return 'OI, price trend and option flow are balanced — no clear directional bias.';
  const dir: Zone = isBullishLabel(label) ? 'Bullish' : 'Bearish';
  const dirWord = dir === 'Bullish' ? 'bullish' : 'bearish';
  const supporting: string[] = [];
  if (oiZone === dir) supporting.push('OI');
  if (priceTrendZone === dir) supporting.push('price trend');
  if (slopeZone === dir) supporting.push('slope');
  const notConfirming: string[] = [];
  if (wpiZone !== dir) notConfirming.push('option-flow (WPI)');
  if (oiZone !== dir) notConfirming.push('OI');
  if (priceTrendZone !== dir) notConfirming.push('price trend');

  const strongPart = supporting.length
    ? `Strong ${dirWord} ${supporting.join(' + ')}`
    : `Modest ${dirWord} bias`;
  const weakPart = notConfirming.length
    ? `, but ${notConfirming.join(' and ')} ${notConfirming.length > 1 ? 'are' : 'is'} not confirming`
    : ', with full option-flow confirmation';
  return strongPart + weakPart + '.';
}

function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/** Regime-transition flag: D crosses zero, confirmed by slope direction and spot move. */
function detectTransition(
  dSeries: number[], slopeSeries: number[], spots: number[], i: number, lookback = ACCEL_WINDOW,
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

/** Single entry point: computes the full standardized series plus the latest signal summary. */
export function computeRegimeSeries(input: RegimeInputPoint[]): RegimeSeriesResult {
  const n = input.length;
  const spots = input.map(p => p.spot);

  // D = PE OI - CE OI (raw divergence, matches the existing 'diff' chart series)
  const dSeries: number[] = new Array(n);
  for (let i = 0; i < n; i++) dSeries[i] = input[i].peOI - input[i].ceOI;

  // Slope: rolling linear-regression slope of D over the trailing ~15 min, not a raw 2-point delta
  const slopeSeries: number[] = new Array(n);
  for (let i = 0; i < n; i++) slopeSeries[i] = rollingRegressionSlope(dSeries, i);
  const accelSeries: number[] = new Array(n);
  for (let i = 0; i < n; i++) accelSeries[i] = rollingDelta(slopeSeries, i, ACCEL_WINDOW);

  // Price trend: spot vs session VWAP proxy (NIFTY has no traded volume, so no literal VWAP) + NIFTY return
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

  // WPI: continuous OI-change x premium-change pressure — NOT a binary writing/buying classification
  const wpiSeries: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    wpiSeries[i] = writingPressure(
      input[i].ceChgOI, i > 0 ? input[i].ceLTP - input[i - 1].ceLTP : 0,
      input[i].peChgOI, i > 0 ? input[i].peLTP - input[i - 1].peLTP : 0,
    );
  }

  const points: RegimePoint[] = new Array(n);
  const signalSeries: number[] = new Array(n);
  const confidenceSeries: number[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const oiZ = zscore(dSeries, i);
    const slopeZ = zscore(slopeSeries, i);
    const accelZ = zscore(accelSeries, i);
    const wpiZ = zscore(wpiSeries, i);
    const priceTrendZ = (zscore(spotDeviationSeries, i) + zscore(niftyReturnSeries, i)) / 2;

    points[i] = { oiZ, slopeZ, accelZ, wpiZ, priceTrendZ };

    // Capped before combining so one extreme reading can't dominate the score
    const oiZ_ = clip(oiZ), slopeZ_ = clip(slopeZ), accelZ_ = clip(accelZ), wpiZ_ = clip(wpiZ), priceTrendZ_ = clip(priceTrendZ);
    signalSeries[i] =
      SIGNAL_WEIGHTS.oi * oiZ_ + SIGNAL_WEIGHTS.slope * slopeZ_ + SIGNAL_WEIGHTS.accel * accelZ_ +
      SIGNAL_WEIGHTS.wpi * wpiZ_ + SIGNAL_WEIGHTS.priceTrend * priceTrendZ_;
    confidenceSeries[i] =
      CONFIDENCE_WEIGHTS.oi * Math.abs(oiZ_) + CONFIDENCE_WEIGHTS.slope * Math.abs(slopeZ_) +
      CONFIDENCE_WEIGHTS.wpi * Math.abs(wpiZ_) + CONFIDENCE_WEIGHTS.priceTrend * Math.abs(priceTrendZ_);
  }

  if (n === 0) {
    return {
      points: [],
      latest: {
        signal: 0, oiZ: 0, slopeZ: 0, accelZ: 0, wpiZ: 0, priceTrendZ: 0,
        oiZone: 'Neutral', slopeZone: 'Neutral', wpiZone: 'Neutral', priceTrendZone: 'Neutral',
        confidence: 0, confidenceLabel: 'Low',
        label: 'Neutral', strategy: suggestedStrategyFor('Neutral', true), confirmed: true, confirmationState: 'N/A',
        reason: 'Warming up.',
        transitionFlag: false, transitionDirection: null, warmingUp: true, sampleCount: 0,
      },
    };
  }

  const last = n - 1;
  const warmingUp = n <= MIN_SAMPLES;
  const p = points[last];
  const label = warmingUp ? 'Neutral' : regimeLabelForSignal(signalSeries[last]);

  const oiZone = zoneFor(p.oiZ), slopeZone = zoneFor(p.slopeZ), wpiZone = zoneFor(p.wpiZ), priceTrendZone = zoneFor(p.priceTrendZ);
  const confirmed = warmingUp ? true : isConfirmed(label, oiZone, wpiZone, priceTrendZone);
  const confirmationState: ConfirmationState = label === 'Neutral' ? 'N/A' : confirmed ? 'Confirmed' : 'Pending';
  const reason = warmingUp ? 'Warming up.' : buildReason(label, oiZone, slopeZone, wpiZone, priceTrendZone);

  const { flag, direction } = warmingUp
    ? { flag: false, direction: null as 'bullish' | 'bearish' | null }
    : detectTransition(dSeries, slopeSeries, spots, last);

  return {
    points,
    latest: {
      signal: warmingUp ? 0 : signalSeries[last],
      oiZ: warmingUp ? 0 : p.oiZ,
      slopeZ: warmingUp ? 0 : p.slopeZ,
      accelZ: warmingUp ? 0 : p.accelZ,
      wpiZ: warmingUp ? 0 : p.wpiZ,
      priceTrendZ: warmingUp ? 0 : p.priceTrendZ,
      oiZone, slopeZone, wpiZone, priceTrendZone,
      confidence: warmingUp ? 0 : confidenceSeries[last],
      confidenceLabel: warmingUp ? 'Low' : confidenceLabelFor(confidenceSeries[last]),
      label,
      strategy: suggestedStrategyFor(label, confirmed),
      confirmed,
      confirmationState,
      reason,
      transitionFlag: flag,
      transitionDirection: direction,
      warmingUp,
      sampleCount: n,
    },
  };
}
