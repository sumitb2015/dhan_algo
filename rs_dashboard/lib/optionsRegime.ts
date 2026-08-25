// Options Regime Score — deterministic (no LLM) scoring of the cumulative OI
// divergence into a bullish/bearish regime.
//
// Every input is standardized to a z-score BEFORE combining or plotting —
// raw OI divergence (tens of millions), raw slope (thousands/sample), and
// raw writing-pressure (bounded [-1,1]) live on wildly different scales, so
// mixing or charting them unstandardized is not meaningful. Charted lines
// (OI_Z, Slope_Z, WPI_Z) and the signal weights below are only comparable
// because each is a z-score, not a raw quantity.
//
//   D            = PE OI - CE OI                          (raw divergence)
//   Slope        = rolling linear-regression slope of D over the last 15 min
//   Accel        = Slope_t - Slope_{t-k}
//   WPI          = PutWriting + CallBuying - PutBuying - CallWriting
//                  (OI change classified against premium change per side —
//                  NOT the divergence itself; see classifyWritingPressure)
//   PriceTrend   = avg(Z(spot - session VWAP proxy), Z(NIFTY return))
//
//   Signal = 0.25*OI_Z + 0.20*Slope_Z + 0.10*Accel_Z + 0.25*WPI_Z + 0.20*PriceTrend_Z
//
// Classification: >1.25 Strong Bullish, 0.5-1.25 Bullish, |x|<0.5 Neutral,
// -1.25..-0.5 Bearish, <-1.25 Strong Bearish.
//
// A directional label alone does NOT produce a strategy suggestion — a
// bullish/bearish label additionally requires "confirmation": OI_Z, Slope_Z,
// WPI_Z and PriceTrend_Z must all agree in direction (Accel_Z is excluded —
// it's a transition signal, not a confirmation input). Without confirmation
// the suggestion is "No trade" even if the label reads Bullish/Bearish — a
// sharp divergence-slope spike with no writing-pressure confirmation could be
// unwinding, expiry adjustment, or a single-strike move, not real directional
// pressure, and should not by itself suggest a trade.
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

export interface RegimeInputPoint {
  spot: number;
  ceOI: number;
  peOI: number;
  ceLTP: number;
  peLTP: number;
  ceChgOI: number;
  peChgOI: number;
}

/** Per-sample standardized values — what the chart plots, all on a comparable -3..+3 scale. */
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
  label: RegimeLabel;
  strategy: string;
  confirmed: boolean;
  transitionFlag: boolean;
  transitionDirection: 'bullish' | 'bearish' | null;
  warmingUp: boolean;
  sampleCount: number;
}

const EPS = 1;
const EPS_STD = 1e-6;
const MIN_SAMPLES = 10;          // ~5 min at 30s polling — z-score warmup gate
const REGRESSION_WINDOW = 30;    // samples (~15 min), for rolling-regression slope of D
const ACCEL_WINDOW = 10;         // samples (~5 min), for slope-of-slope
const RETURN_LOOKBACK = 30;      // samples (~15 min), for NIFTY return

const SIGNAL_WEIGHTS = { oi: 0.25, slope: 0.20, accel: 0.10, wpi: 0.25, priceTrend: 0.20 };
const THRESH_STRONG = 1.25;
const THRESH_DIRECTIONAL = 0.5;
const CONFIRM_OI_THRESH = 0.5;   // OI_Z confirmation bar is stricter than Slope/WPI/PriceTrend (just same-sign)

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

export function regimeLabelForSignal(signal: number): RegimeLabel {
  if (signal > THRESH_STRONG) return 'Strong Bullish';
  if (signal < -THRESH_STRONG) return 'Strong Bearish';
  if (Math.abs(signal) < THRESH_DIRECTIONAL) return 'Neutral';
  return signal > 0 ? 'Bullish' : 'Bearish';
}

function isBullishLabel(label: RegimeLabel): boolean {
  return label === 'Bullish' || label === 'Strong Bullish';
}
function isBearishLabel(label: RegimeLabel): boolean {
  return label === 'Bearish' || label === 'Strong Bearish';
}

/** Bullish/bearish confirmation requires OI_Z, Slope_Z, WPI_Z and PriceTrend_Z to all agree. */
export function isConfirmed(
  label: RegimeLabel, oiZ: number, slopeZ: number, wpiZ: number, priceTrendZ: number,
): boolean {
  if (label === 'Neutral') return true;
  if (isBullishLabel(label)) {
    return oiZ > CONFIRM_OI_THRESH && slopeZ > 0 && wpiZ > 0 && priceTrendZ > 0;
  }
  return oiZ < -CONFIRM_OI_THRESH && slopeZ < 0 && wpiZ < 0 && priceTrendZ < 0;
}

export function suggestedStrategyFor(label: RegimeLabel, confirmed: boolean): string {
  if (label === 'Neutral') return 'Iron Condor';
  if (!confirmed) return 'No trade — regime not confirmed';
  return isBullishLabel(label) ? 'Bull Put Spread' : 'Bear Call Spread';
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

  // WPI: writing-vs-buying classification (OI change x premium change per side) — NOT the raw divergence
  const wpiSeries: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    wpiSeries[i] = classifyWritingPressure(
      input[i].ceChgOI, i > 0 ? input[i].ceLTP - input[i - 1].ceLTP : 0,
      input[i].peChgOI, i > 0 ? input[i].peLTP - input[i - 1].peLTP : 0,
    );
  }

  const points: RegimePoint[] = new Array(n);
  const signalSeries: number[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const oiZ = zscore(dSeries, i);
    const slopeZ = zscore(slopeSeries, i);
    const accelZ = zscore(accelSeries, i);
    const wpiZ = zscore(wpiSeries, i);
    const priceTrendZ = (zscore(spotDeviationSeries, i) + zscore(niftyReturnSeries, i)) / 2;

    points[i] = { oiZ, slopeZ, accelZ, wpiZ, priceTrendZ };
    signalSeries[i] =
      SIGNAL_WEIGHTS.oi * oiZ + SIGNAL_WEIGHTS.slope * slopeZ + SIGNAL_WEIGHTS.accel * accelZ +
      SIGNAL_WEIGHTS.wpi * wpiZ + SIGNAL_WEIGHTS.priceTrend * priceTrendZ;
  }

  if (n === 0) {
    return {
      points: [],
      latest: {
        signal: 0, oiZ: 0, slopeZ: 0, accelZ: 0, wpiZ: 0, priceTrendZ: 0,
        label: 'Neutral', strategy: suggestedStrategyFor('Neutral', true), confirmed: true,
        transitionFlag: false, transitionDirection: null, warmingUp: true, sampleCount: 0,
      },
    };
  }

  const last = n - 1;
  const warmingUp = n <= MIN_SAMPLES;
  const p = points[last];
  const label = warmingUp ? 'Neutral' : regimeLabelForSignal(signalSeries[last]);
  const confirmed = warmingUp ? true : isConfirmed(label, p.oiZ, p.slopeZ, p.wpiZ, p.priceTrendZ);
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
      label,
      strategy: suggestedStrategyFor(label, confirmed),
      confirmed,
      transitionFlag: flag,
      transitionDirection: direction,
      warmingUp,
      sampleCount: n,
    },
  };
}
