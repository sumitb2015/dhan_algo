// Quick Trade on the /index-scalper chart (Upstox "Chart 360" style): every strike in view gets a line with its live
// Call / Put premium chips; a click on a chip offers Buy / Sell with preset lots. Pure: no React. Tested in
// indexScalperQuickTrade.test.ts. Orders go through the terminal's placeContract (caps, live price, session, isx tag).

import { MAX_LOTS } from './indexScalperPositions.ts';
import { classifyBuildup } from './breakdownBacktest.ts';

export interface QuickSettings {
  /** Lots per click on Buy / on Sell (an option buyer and seller often size differently). */
  buyLots: number;
  sellLots: number;
  product: 'INTRADAY' | 'MARGIN';
  /** Chips only on ATM ± this many listed strikes (the far ones are illiquid and clutter the chart). */
  range: number;
  /** Lots one click of a position chip's + adds, or its - takes off. */
  stepLots: number;
  /** Price % and OI % (vs the previous day) above each C / P chip. Display only. */
  showStats: boolean;
}

export const QUICK_SETTINGS_KEY = 'indexScalper.quick.v1';
export const QUICK_ON_KEY = 'indexScalper.quickTrade';
export const DEFAULT_QUICK: QuickSettings = { buyLots: 1, sellLots: 1, product: 'INTRADAY', range: 10, stepLots: 1, showStats: true };
export const MAX_QUICK_RANGE = 50;

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
    range: (() => {
      const n = typeof o.range === 'string' ? Number(o.range) : o.range;
      return typeof n === 'number' && Number.isFinite(n) ? Math.min(MAX_QUICK_RANGE, Math.max(1, Math.floor(n))) : DEFAULT_QUICK.range;
    })(),
    stepLots: lots(o.stepLots, DEFAULT_QUICK.stepLots),
    showStats: o.showStats !== false, // on unless switched off (settings saved before it existed keep it on)
  };
}

/** Lots a position chip's "-" takes off: the step, but never the last lot (Exit closes a leg), so at most held - 1.
 *  0 = nothing to take off (one lot or less held, or an unknown size). */
export function lotsToRemove(step: number, heldLots: number): number {
  if (!Number.isFinite(step) || !Number.isFinite(heldLots)) return 0;
  return Math.max(0, Math.min(Math.floor(step), Math.floor(heldLots) - 1));
}

/** The listed strikes from `n` below ATM to `n` above it (counted in listed strikes, not points), sorted. No ATM: all. */
export function strikesAroundAtm(strikes: number[], atm: number | null, n: number): number[] {
  const sorted = [...strikes].sort((a, b) => a - b);
  const i = atm === null ? -1 : sorted.indexOf(atm);
  if (i < 0) return sorted;
  return sorted.slice(Math.max(0, i - n), i + n + 1);
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

/** OI buildup codes -> label and text colour (theme-safe data accents). Shared by the chain panel's Buildup column and
 *  the Quick Trade chips, so a strike reads the same in both places. */
export const BUILDUP_STYLE: Record<string, { label: string; text: string; border: string }> = {
  LB: { label: 'Long Buildup', text: 'text-emerald-400', border: 'border-emerald-500/40' },
  SB: { label: 'Short Buildup', text: 'text-rose-400', border: 'border-rose-500/40' },
  SC: { label: 'Short Covering', text: 'text-sky-400', border: 'border-sky-500/40' },
  LU: { label: 'Long Unwinding', text: 'text-amber-400', border: 'border-amber-500/40' },
};

/** Compact signed percent for a chip: +12.3% under 100, +250% up to 999, then >999% / <-999%. null -> '—'. */
export function compactPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a > 999) return `${n > 0 ? '>' : '<-'}999%`;
  return `${sign}${a < 100 ? a.toFixed(1) : Math.round(a).toString()}%`;
}

export interface ChipSide { oi?: number; prev_oi?: number; oi_chg_pct?: number; prev_close?: number; change_pct?: number; volume?: number }
export interface ChipStats { pricePct: number | null; oiPct: number | null; buildup: string | null }

/**
 * Price % and OI % (vs the previous day) for one Quick Trade chip, plus its buildup code. null = unknown, shown as a dash.
 * - Price %: the price the chip shows (`shown`, the live tick when there is one) against the previous close, so it never
 *   lags a stale chain value; without a previous close, the chain's change_pct. `noTradeToday` (the chip shows the
 *   previous close itself) and a -100% with no volume are unknown, not a 0% or a crash.
 * - OI %: unknown while the side's OI is 0 (the bridge fills a side only when its own tick arrives) or when it reads 0%
 *   with no previous-day OI (the bridge writes 0.0 for "no baseline" too; same rule as oiChange in indexScalperOiProfile).
 * - Buildup: only when both are known (the same dead-bands as the bridge and the chain snapshot).
 */
export function chipStats(side: ChipSide | undefined | null, shown: number | null, noTradeToday = false): ChipStats {
  if (!side) return { pricePct: null, oiPct: null, buildup: null };
  const pc = side.prev_close;
  let pricePct: number | null = null;
  if (noTradeToday) pricePct = null;
  else if (pc !== undefined && pc > 0 && shown !== null && shown > 0) pricePct = ((shown - pc) / pc) * 100;
  else if (typeof side.change_pct === 'number' && Number.isFinite(side.change_pct)) {
    pricePct = side.change_pct === -100 && !(side.volume && side.volume > 0) ? null : side.change_pct;
  }
  const raw = side.oi_chg_pct;
  const hasBaseline = typeof side.prev_oi === 'number' && side.prev_oi > 0;
  const oiPct = !(typeof side.oi === 'number' && side.oi > 0) || typeof raw !== 'number' || !Number.isFinite(raw) || (raw === 0 && !hasBaseline)
    ? null : raw;
  const buildup = pricePct !== null && oiPct !== null ? classifyBuildup(pricePct, oiPct) ?? null : null;
  return { pricePct, oiPct, buildup };
}
