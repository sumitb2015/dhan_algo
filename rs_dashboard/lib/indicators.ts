/**
 * Pure time-series indicator functions.
 * All functions return parallel arrays aligned to the input length.
 * Null marks bars where there is insufficient warmup data.
 */

/** Simple Moving Average — null before period-1 bars. */
export function smaArray(values: number[], period: number): (number | null)[] {
  const n = values.length;
  const result: (number | null)[] = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) result[i] = sum / period;
  }
  return result;
}

/** Exponential Moving Average — seeded from first value, no nulls. */
export function emaArray(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result = new Array<number>(values.length);
  result[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

/**
 * Wilder's RSI — null before (period) bars.
 * First valid value at index `period` (needs period+1 closes).
 */
export function rsiArray(values: number[], period = 14): (number | null)[] {
  const n = values.length;
  const result: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return result;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < n; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

/**
 * MACD — EMA(fast) minus EMA(slow), plus signal EMA(signalP).
 * Both arrays are parallel to closes (length n).
 * Early values reflect EMA cold-start bias; no explicit nulls.
 */
export function macdSeries(
  closes: number[],
  fast = 12,
  slow = 26,
  signalP = 9,
): { macdLine: number[]; signalLine: number[] } {
  const n = closes.length;
  if (n === 0) return { macdLine: [], signalLine: [] };

  const ema12 = emaArray(closes, fast);
  const ema26 = emaArray(closes, slow);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = emaArray(macdLine, signalP);
  return { macdLine, signalLine };
}

/**
 * Wilder's ADX — null before 2*period bars.
 * Uses standard DM/TR smoothing.
 */
export function adxArray(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): (number | null)[] {
  const n = highs.length;
  const result: (number | null)[] = new Array(n).fill(null);
  if (n < period * 2 + 2) return result;

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < n; i++) {
    const h = highs[i], l = lows[i], pc = closes[i - 1];
    const ph = highs[i - 1], pl = lows[i - 1];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    plusDMs.push(up > dn && up > 0 ? up : 0);
    minusDMs.push(dn > up && dn > 0 ? dn : 0);
  }

  let sTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let sPlus = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let sMinus = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);

  const dxVals: number[] = [];
  for (let i = period; i < trs.length; i++) {
    sTR = sTR - sTR / period + trs[i];
    sPlus = sPlus - sPlus / period + plusDMs[i];
    sMinus = sMinus - sMinus / period + minusDMs[i];
    const pDI = sTR > 0 ? (sPlus / sTR) * 100 : 0;
    const mDI = sTR > 0 ? (sMinus / sTR) * 100 : 0;
    const s = pDI + mDI;
    dxVals.push(s > 0 ? (Math.abs(pDI - mDI) / s) * 100 : 0);
  }

  if (dxVals.length < period) return result;

  // ADX = Wilder-smooth of DX; first valid ADX at original index 2*period
  let adxVal = dxVals.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const adxStart = 2 * period;
  result[adxStart] = adxVal;
  for (let i = period; i < dxVals.length; i++) {
    adxVal = (adxVal * (period - 1) + dxVals[i]) / period;
    result[adxStart + (i - period) + 1] = adxVal;
  }
  return result;
}

/** N-period SMA smoothing of a numeric array. */
export function smoothArray(values: number[], period = 9): (number | null)[] {
  const n = values.length;
  const result: (number | null)[] = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) result[i] = sum / period;
  }
  return result;
}
