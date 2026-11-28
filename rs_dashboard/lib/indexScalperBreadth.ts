// Pure rules for the Index Scalper's Nifty breadth windows (Advance / Decline and Contribution).
//
// Both read GET /api/nifty-contribution (watch-only): its result rows carry every PRICED Nifty 50 stock with its
// % change and live weight, and `missing` lists the stocks with no usable quote. A missing stock is counted on its
// own, never as unchanged: an unknown move is not a flat one.
//
// Relative imports only: node --test runs this file without the '@/' alias.

import { buildTotals, type ContributionResult, type ContributionRow, type TotalBar } from './niftyContribution.ts';

/** |change%| below this counts as unchanged: well under one price tick for any Nifty 50 stock. */
export const UNCHANGED_PCT = 0.005;

export interface NiftyBreadth {
  advances: number;
  declines: number;
  unchanged: number;
  /** Stocks with no usable quote (not counted on either side). */
  missing: number;
  /** advances / declines; null when there are no decliners (shown as a dash, never as a huge number). */
  ratio: number | null;
  /** Share of PRICED stocks that are up, percent; null when nothing is priced. */
  advPct: number | null;
  /** Live index weight sitting in advancing / declining stocks, percent. */
  advWeightPct: number;
  decWeightPct: number;
}

export function niftyBreadth(result: Pick<ContributionResult, 'rows' | 'missing'> | null | undefined): NiftyBreadth {
  let advances = 0, declines = 0, unchanged = 0, advWeightPct = 0, decWeightPct = 0;
  for (const r of result?.rows ?? []) {
    if (!Number.isFinite(r.changePct)) continue;
    if (r.changePct >= UNCHANGED_PCT) { advances += 1; advWeightPct += r.weightPct; }
    else if (r.changePct <= -UNCHANGED_PCT) { declines += 1; decWeightPct += r.weightPct; }
    else unchanged += 1;
  }
  const priced = advances + declines + unchanged;
  return {
    advances, declines, unchanged,
    missing: result?.missing?.length ?? 0,
    ratio: declines > 0 ? advances / declines : null,
    advPct: priced > 0 ? (advances / priced) * 100 : null,
    advWeightPct, decWeightPct,
  };
}

/** One point of the intraday A/D line: advances minus declines at time t (ms). */
export interface BreadthSample { t: number; adv: number; dec: number }

export const BREADTH_SAMPLE_MS = 30_000;

/** Append a sample when at least minGapMs has passed since the last one; a different IST day starts a fresh line. */
export function appendSample(
  history: BreadthSample[], sample: BreadthSample, dayOf: (t: number) => string, minGapMs = BREADTH_SAMPLE_MS,
): BreadthSample[] {
  const last = history[history.length - 1];
  if (last && dayOf(last.t) !== dayOf(sample.t)) return [sample];
  if (last && sample.t - last.t < minGapMs) return history;
  return [...history, sample];
}

/** Keep only well-formed samples from storage (it may hold anything). */
export function validSamples(raw: unknown): BreadthSample[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is BreadthSample =>
    !!s && typeof s === 'object'
    && Number.isFinite((s as BreadthSample).t) && Number.isFinite((s as BreadthSample).adv) && Number.isFinite((s as BreadthSample).dec));
}

export interface ContributionSummary {
  /** Pull / drag / net bars, the same numbers the full /nifty-contribution page shows. */
  totals: TotalBar[];
  pullers: ContributionRow[];
  draggers: ContributionRow[];
  /** Largest |points| among the shown rows, for scaling the mini bars; 0 when none. */
  maxAbs: number;
}

/** The compact contribution view: top n pullers and draggers (largest first) plus the totals. */
export function contributionSummary(result: ContributionResult | null | undefined, n = 5): ContributionSummary {
  if (!result || result.rows.length === 0) return { totals: [], pullers: [], draggers: [], maxAbs: 0 };
  const pullers = result.pullers.slice(0, n);
  const draggers = result.draggers.slice(0, n);
  const maxAbs = Math.max(0, ...pullers.map(r => Math.abs(r.points)), ...draggers.map(r => Math.abs(r.points)));
  return { totals: buildTotals(result), pullers, draggers, maxAbs };
}
