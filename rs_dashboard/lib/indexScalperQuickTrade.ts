// Quick Trade on the /index-scalper chart (Upstox "Chart 360" style): every strike in view gets a line with its live
// Call / Put premium chips; a click on a chip offers Buy / Sell with preset lots. Pure: no React. Tested in
// indexScalperQuickTrade.test.ts. Orders go through the terminal's placeContract (caps, live price, session, isx tag).

import { MAX_LOTS } from './indexScalperPositions.ts';

export interface QuickSettings {
  /** Lots per click on Buy / on Sell (an option buyer and seller often size differently). */
  buyLots: number;
  sellLots: number;
  product: 'INTRADAY' | 'MARGIN';
}

export const QUICK_SETTINGS_KEY = 'indexScalper.quick.v1';
export const QUICK_ON_KEY = 'indexScalper.quickTrade';
export const DEFAULT_QUICK: QuickSettings = { buyLots: 1, sellLots: 1, product: 'INTRADAY' };

const lots = (v: unknown, d: number): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return d;
  return Math.min(MAX_LOTS, Math.max(1, Math.floor(n)));
};

/** Whole lots within 1..MAX_LOTS (a fraction rounds DOWN: never a bigger order than asked); anything else -> default. */
export function clampQuickSettings(x: unknown): QuickSettings {
  const o = (x && typeof x === 'object' ? x : {}) as Partial<Record<keyof QuickSettings, unknown>>;
  return {
    buyLots: lots(o.buyLots, DEFAULT_QUICK.buyLots),
    sellLots: lots(o.sellLots, DEFAULT_QUICK.sellLots),
    product: o.product === 'MARGIN' ? 'MARGIN' : 'INTRADAY',
  };
}

export interface StrikeRow { strike: number; y: number; atm: boolean }

/**
 * The strikes to draw: every listed strike whose level is inside the plot. When strikes sit closer than `minGapPx`
 * (zoomed out), keep every 2nd / 4th / ... strike counted from ATM (ATM always kept), so chips never overlap and stay
 * clickable; `step` says how many were skipped (1 = all).
 */
export function visibleStrikeRows(
  strikes: number[],
  yOf: (price: number) => number | null,
  plotH: number,
  atm: number | null,
  minGapPx = 24,
): { rows: StrikeRow[]; step: number } {
  const sorted = [...strikes].sort((a, b) => a - b);
  const all: { strike: number; y: number }[] = [];
  for (const s of sorted) {
    const y = yOf(s);
    if (y === null || !Number.isFinite(y) || y < 0 || y > plotH) continue;
    all.push({ strike: s, y });
  }
  if (all.length === 0) return { rows: [], step: 1 };
  // Pixel gap between neighbouring listed strikes (median: the price scale is linear, a gap at the edge can be odd).
  const gaps: number[] = [];
  for (let i = 1; i < all.length; i++) gaps.push(Math.abs(all[i].y - all[i - 1].y));
  gaps.sort((a, b) => a - b);
  const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : Infinity;
  let step = 1;
  while (gap * step < minGapPx && step < 64) step *= 2;
  // Count from ATM (else the middle strike in view) so ATM is always one of the kept strikes.
  const center = atm !== null && sorted.includes(atm) ? sorted.indexOf(atm) : sorted.indexOf(all[Math.floor(all.length / 2)].strike);
  const rows: StrikeRow[] = [];
  for (const r of all) {
    const i = sorted.indexOf(r.strike);
    if ((i - center) % step !== 0) continue;
    rows.push({ strike: r.strike, y: r.y, atm: r.strike === atm });
  }
  return { rows, step };
}
