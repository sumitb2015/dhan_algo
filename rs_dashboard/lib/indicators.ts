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

/**
 * Stochastic RSI (TradingView `ta.stoch(rsi, rsi, rsi, stochPeriod)` smoothed): stoch = (RSI - lowest RSI) / (highest - lowest) x 100
 * over `stochPeriod` RSI values, K = SMA(stoch, k), D = SMA(K, d). A flat RSI window (highest = lowest) is null: Pine divides by
 * zero there, which is na, and the K / D SMAs over it are na too (TradingView draws a gap).
 * Null until every input of a value exists.
 */
export function stochRsiArray(values: number[], rsiPeriod = 14, stochPeriod = 14, k = 3, d = 3): { k: (number | null)[]; d: (number | null)[] } {
  const n = values.length;
  const rsi = rsiArray(values, rsiPeriod);
  const stoch: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i - stochPeriod + 1 < 0) continue;
    let lo = Infinity, hi = -Infinity, ok = true;
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      const r = rsi[j];
      if (r === null) { ok = false; break; }
      if (r < lo) lo = r;
      if (r > hi) hi = r;
    }
    if (ok && hi !== lo) stoch[i] = ((rsi[i] as number) - lo) / (hi - lo) * 100;   // flat window: Pine's x / 0 is na
  }
  const smaNullable = (xs: (number | null)[], p: number) => xs.map((_, i) => {
    if (i - p + 1 < 0) return null;
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) { const x = xs[j]; if (x === null) return null; s += x; }
    return s / p;
  });
  const K = smaNullable(stoch, k);
  return { k: K, d: smaNullable(K, d) };
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
 * EMA seeded with the SMA of the first `period` values, null before that — TradingView `ta.ema`
 * semantics, so a value here equals the chart's. (`emaArray` above seeds from the first value
 * instead; the two converge but differ on short histories.)
 */
export function emaSmaSeeded(values: number[], period: number): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (period < 1 || n < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
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

/**
 * Supertrend with Wilder (RMA) ATR seeded by the SMA of the first `period`
 * true ranges — TradingView `ta.supertrend(mult, period)` semantics, same
 * algorithm as the boolean-only copy in app/api/scanner/route.ts (see the
 * dhan-indicators skill; this is not an independent algorithm).
 * `dir` is 1 (bullish, line below price) or -1 (bearish); null during warmup.
 */
export function supertrendSeries(
  rows: { high: number; low: number; close: number }[],
  period = 10,
  mult = 3,
  opts: { pine?: boolean } = {},
): { line: number | null; dir: 1 | -1 | null }[] {
  if (opts.pine) return supertrendPine(rows, period, mult);
  return supertrendResume(rows.length, i => rows[i], period, mult, null).out;
}

/**
 * Supertrend exactly as TradingView's Pine `ta.supertrend(factor, atrPeriod)` computes it (opt-in: `supertrendSeries(..., { pine: true })`).
 * It differs from the default path in three places, and it only matters near the start of a series or in a flat, quiet stretch:
 *  - ATR is `ta.atr` = `ta.rma(ta.tr(true), n)`: TR on bar 0 is high - low, and the RMA is seeded with the SMA of TR[0..n-1], so the
 *    first value is on bar n-1 (the default seeds from TR[1..n], first value on bar n);
 *  - the first bar starts DOWN (Pine: `na(atr[1]) => direction := 1`);
 *  - the flip asks which band the previous line was on: from the upper band (down) it turns up only when close > upper; from the lower
 *    band (up) it turns down only when close < lower. When the ratcheted bands have CROSSED (upper < lower: seen in flat CRUDEOILM
 *    minutes) a close between them flips in Pine; the default path checks `close > upper` first and stays up.
 * Direction here is 1 = up, -1 = down (Pine's own is the reverse). Measured against a literal Pine port on 51,969 CRUDEOILM
 * 1-minute bars (2026-11-19): identical on every bar.
 */
function supertrendPine(rows: { high: number; low: number; close: number }[], period: number, mult: number): { line: number | null; dir: 1 | -1 | null }[] {
  const n = rows.length;
  const out: { line: number | null; dir: 1 | -1 | null }[] = [];
  if (period < 1) return rows.map(() => ({ line: null, dir: null }));
  const tr = (i: number) => {
    const r = rows[i];
    if (i === 0) return r.high - r.low;
    const pc = rows[i - 1].close;
    return Math.max(r.high - r.low, Math.abs(r.high - pc), Math.abs(r.low - pc));
  };
  let atr = 0, sum = 0, upper = 0, lower = 0, line = 0;
  let dir: 1 | -1 = -1;
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    if (i < period - 1) { sum += tr(i); out.push({ line: null, dir: null }); continue; }
    if (i === period - 1) { sum += tr(i); atr = sum / period; } else atr = (1 / period) * tr(i) + (1 - 1 / period) * atr;
    const hl2 = (r.high + r.low) / 2;
    const bu = hl2 + mult * atr, bl = hl2 - mult * atr;
    const pc = i > 0 ? rows[i - 1].close : NaN;           // Pine: close[1] is na on bar 0, and na comparisons are false
    const first = i === period - 1;
    const prevUpper = first ? 0 : upper, prevLower = first ? 0 : lower;   // nz(band[1]): the band is na before the first ATR
    const prevLine = line;
    lower = bl > prevLower || pc < prevLower ? bl : prevLower;
    upper = bu < prevUpper || pc > prevUpper ? bu : prevUpper;
    if (first) dir = -1;
    else if (prevLine === prevUpper) dir = r.close > upper ? 1 : -1;
    else dir = r.close < lower ? -1 : 1;
    line = dir === 1 ? lower : upper;
    out.push({ line, dir });
  }
  return out;
}

/** Where a Supertrend run stopped: `next` is the first row not yet read; the RMA ATR, the trailing bands and the direction. */
export type SupertrendState = { next: number; atr: number; upper: number; lower: number; dir: 1 | -1 };

/**
 * supertrendSeries over rows 0..n-1 read through `at`, carried on from `prev` (an earlier run over a prefix of the same rows) so
 * only the rows after it are read. Same arithmetic in the same order, so the result equals a run from scratch exactly.
 */
export function supertrendResume(
  n: number,
  at: (i: number) => { high: number; low: number; close: number },
  period: number,
  mult: number,
  prev: { out: { line: number | null; dir: 1 | -1 | null }[]; state: SupertrendState | null } | null,
): { out: { line: number | null; dir: 1 | -1 | null }[]; state: SupertrendState | null } {
  const carry = prev !== null && prev.state !== null && prev.out.length === prev.state.next && prev.state.next <= n;
  const out: { line: number | null; dir: 1 | -1 | null }[] = carry ? prev!.out.slice() : [];
  const from = carry ? prev!.state!.next : 0;
  if (!carry) for (let i = 0; i < Math.min(n, period); i++) out.push({ line: null, dir: null });
  if (n < period + 1) {
    for (let i = out.length; i < n; i++) out.push({ line: null, dir: null });
    return { out, state: null };
  }
  const tr = (i: number) => {
    const r = at(i), pr = at(i - 1);
    return Math.max(r.high - r.low, Math.abs(r.high - pr.close), Math.abs(r.low - pr.close));
  };
  let atr = 0, upper = 0, lower = 0, dir: 1 | -1 = 1;
  if (carry) ({ atr, upper, lower, dir } = prev!.state!);
  else {
    for (let i = 1; i <= period; i++) atr += tr(i);
    atr /= period;
  }
  for (let i = Math.max(from, period); i < n; i++) {
    if (i > period) atr = (atr * (period - 1) + tr(i)) / period;
    const r = at(i);
    const hl2 = (r.high + r.low) / 2;
    const bu = hl2 + mult * atr;
    const bl = hl2 - mult * atr;
    if (i === period) {
      upper = bu;
      lower = bl;
    } else {
      const pc = at(i - 1).close;
      upper = bu < upper || pc > upper ? bu : upper;
      lower = bl > lower || pc < lower ? bl : lower;
    }
    if (r.close > upper) dir = 1;
    else if (r.close < lower) dir = -1;
    out.push({ line: dir === 1 ? lower : upper, dir });
  }
  return { out, state: { next: n, atr, upper, lower, dir } };
}
