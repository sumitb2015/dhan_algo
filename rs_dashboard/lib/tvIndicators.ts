// Awesome Oscillator, MACD (Pine-exact), Bollinger %B, Bollinger Bands Width and Bollinger Bars zones for the shared
// chart indicator engine (lib/indexScalperIndicators.ts). Each follows the Pine built-in it is named after, as the
// tradingcharts.co terminal computes it (checked bar by bar against that terminal: lib/tvIndicators.test.ts). One entry
// per input bar; null = warm-up.

import { emaSmaSeeded, smaArray } from './indicators.ts';
import type { Bar } from './indexScalperIndicators.ts';

/** Pine `ta.ao` / TradingView "Awesome Oscillator": SMA(hl2, 5) − SMA(hl2, 34). */
export function awesomeOscillator(bars: Bar[], fast = 5, slow = 34): (number | null)[] {
  const hl2 = bars.map(b => (b.h + b.l) / 2);
  const f = smaArray(hl2, fast), s = smaArray(hl2, slow);
  return f.map((x, i) => (x === null || s[i] === null ? null : x - (s[i] as number)));
}

/**
 * Pine MACD (`ta.macd` with EMA / EMA): fast and slow `ta.ema` (SMA-seeded), MACD = fast − slow from the slow EMA's first
 * value, signal = `ta.ema` of the MACD line seeded with the SMA of its first `signal` values, histogram = MACD − signal.
 * The repo's older macdSeries seeds every EMA with the first close, which only agrees after the seed has decayed.
 */
export function macdPine(closes: number[], fast = 12, slow = 26, signal = 9): { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } {
  const ef = emaSmaSeeded(closes, fast), es = emaSmaSeeded(closes, slow);
  const macd = ef.map((x, i) => (x === null || es[i] === null ? null : x - (es[i] as number)));
  const start = macd.findIndex(x => x !== null);
  const sig: (number | null)[] = macd.map(() => null);
  if (start >= 0) {
    const tail = emaSmaSeeded(macd.slice(start) as number[], signal);
    tail.forEach((x, k) => { sig[start + k] = x; });
  }
  const hist = macd.map((x, i) => (x === null || sig[i] === null ? null : x - (sig[i] as number)));
  return { macd, signal: sig, hist };
}

/** Bollinger basis (SMA) and the population standard deviation (Pine `ta.stdev`) of the closes over `len`. */
function bbCore(closes: number[], len: number): { basis: (number | null)[]; sd: (number | null)[] } {
  const basis = smaArray(closes, len);
  const sd = basis.map((m, i) => {
    if (m === null) return null;
    let s = 0;
    for (let k = i - len + 1; k <= i; k++) s += (closes[k] - m) ** 2;
    return Math.sqrt(s / len);
  });
  return { basis, sd };
}

/** TradingView "Bollinger Bands %B": (close − lower) / (upper − lower). Null where the bands have no width. */
export function bbPercentB(closes: number[], len = 20, mult = 2): (number | null)[] {
  const { basis, sd } = bbCore(closes, len);
  return basis.map((m, i) => {
    if (m === null || !sd[i]) return null;
    const lo = m - mult * (sd[i] as number), up = m + mult * (sd[i] as number);
    return (closes[i] - lo) / (up - lo);
  });
}

/**
 * TradingView-style "Bollinger Bands Width": (upper − lower) / basis, with the bands built from the SAMPLE standard
 * deviation (divides by len − 1). That is what the tradingcharts.co terminal's BBW computes (all 197 bars checked on
 * 2026-11-28; the population stdev missed on the wider bars), even though its Bollinger Bands and %B use the population
 * stdev. So this width is ×sqrt(len / (len − 1)) the width of the plotted bands.
 */
export function bbWidth(closes: number[], len = 20, mult = 2): (number | null)[] {
  const { basis, sd } = bbCore(closes, len);
  const k = len > 1 ? Math.sqrt(len / (len - 1)) : 1;
  return basis.map((m, i) => (m === null || sd[i] === null || m === 0 ? null : (2 * mult * (sd[i] as number) * k) / m));
}

/**
 * TradingView "Bollinger Bars" zone of each close: 2 above the upper band, 1 above the basis, −1 at or below the basis,
 * −2 below the lower band (the value the terminal prints; it colours the candle by it).
 */
export function bbZones(closes: number[], len = 20, mult = 2): (2 | 1 | -1 | -2 | null)[] {
  const { basis, sd } = bbCore(closes, len);
  return basis.map((m, i) => {
    if (m === null || sd[i] === null) return null;
    const c = closes[i], d = mult * (sd[i] as number);
    return c > m + d ? 2 : c > m ? 1 : c < m - d ? -2 : -1;
  });
}

/** Histogram colour by sign and direction, as the terminal's MACD / RVOL: growing above, falling above, growing below,
 *  falling below the reference. "Growing" = higher than the bar before (the first bar counts as falling). */
export function fourColor(values: (number | null)[], ref: number, c: [string, string, string, string]): (string | null)[] {
  return values.map((v, i) => {
    if (v === null) return null;
    const prev = i > 0 ? values[i - 1] : null;
    const up = prev !== null && v > prev;
    return v >= ref ? (up ? c[0] : c[1]) : (up ? c[2] : c[3]);
  });
}

/** Rising / falling / flat of a line against its own previous value (TradingView's "Moving Average Colored": `ma >
 *  ma[1]` rising, `<` falling, else flat). The first value (no previous) is flat. */
export function slopeStates(values: (number | null)[]): ('up' | 'down' | 'flat' | null)[] {
  return values.map((v, i) => {
    if (v === null) return null;
    const prev = i > 0 ? values[i - 1] : null;
    if (prev === null) return 'flat';
    return v > prev ? 'up' : v < prev ? 'down' : 'flat';
  });
}

/** TradingView "Donchian Channels": highest high / lowest low over `len` bars, basis = their average. */
export function donchian(bars: Bar[], len = 20): { upper: (number | null)[]; basis: (number | null)[]; lower: (number | null)[] } {
  const upper: (number | null)[] = [], lower: (number | null)[] = [], basis: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < len - 1) { upper.push(null); lower.push(null); basis.push(null); continue; }
    let hi = -Infinity, lo = Infinity;
    for (let k = i - len + 1; k <= i; k++) { if (bars[k].h > hi) hi = bars[k].h; if (bars[k].l < lo) lo = bars[k].l; }
    upper.push(hi); lower.push(lo); basis.push((hi + lo) / 2);
  }
  return { upper, basis, lower };
}

/**
 * TradingView / tradingcharts.co "Williams Fractal":
 * Identifies local peaks (Up Fractal) and troughs (Down Fractal) across a 2*period + 1 bar window
 * (default period = 2, giving Bill Williams' classic 5-bar formation).
 *
 * A bar n is an Up Fractal if its high is strictly greater than the highs of the `period` bars before it AND after it.
 * A bar n is a Down Fractal if its low is strictly less than the lows of the `period` bars before it AND after it.
 * Formed only on closed bars that have at least `period` subsequent bars (period <= n < bars.length - period).
 * Exactly matches the tradingcharts.co terminal's built-in "Williams Fractal" values:
 * - up: 1 on an Up Fractal bar, else null (terminal prints 1.00)
 * - down: -1 on a Down Fractal bar, else null (terminal prints -1.00)
 */
export function williamsFractal(bars: { h: number; l: number }[], period = 2): { up: (number | null)[]; down: (number | null)[] } {
  const n = bars.length;
  const up: (number | null)[] = new Array(n).fill(null);
  const down: (number | null)[] = new Array(n).fill(null);
  for (let i = period; i < n - period; i++) {
    let isUp = true, isDown = true;
    for (let m = 1; m <= period; m++) {
      if (bars[i].h <= bars[i - m].h || bars[i].h <= bars[i + m].h) isUp = false;
      if (bars[i].l >= bars[i - m].l || bars[i].l >= bars[i + m].l) isDown = false;
    }
    if (isUp) up[i] = 1;
    if (isDown) down[i] = -1;
  }
  return { up, down };
}

