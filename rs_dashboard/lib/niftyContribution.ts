// Nifty 50 index-point contribution per stock. Pure maths, no I/O, so it is unit-testable and a
// future intraday-history collector can call the same function on every snapshot.
//
// The index is free-float market-cap weighted, so index = sum(q_i * price_i) / divisor with q_i
// proportional to free-float shares. We never see the divisor or the share counts, only a weight
// snapshot (`weightPct` at `refPrice`), so q_i = weightPct_i / refPrice_i. Free-float shares only change
// at rebalances / corporate actions, which makes the snapshot valid until the next one: the weight
// drifts with price on its own. The residual against the live index change is the staleness alarm.
//
//   points_i = q_i * (ltp_i - prev_i) / sum_j(q_j * prev_j) * niftyPrevClose

export interface SeedRow {
  symbol: string;
  name: string;
  weightPct: number;
  refPrice: number;
}

export interface QuoteIn {
  ltp: number;
  prevClose: number;
}

export interface IndexIn {
  prevClose: number;
  ltp: number;
  change: number;
}

export interface ContributionRow {
  symbol: string;
  name: string;
  ltp: number;
  prevClose: number;
  changePct: number;
  /** Live weight, percent: drifts with price from the seed snapshot. */
  weightPct: number;
  /** Index points added (+) or removed (-). */
  points: number;
}

export type Concentration = 'narrow' | 'moderate' | 'broad';

export interface ContributionResult {
  /** Sorted by points, largest pull first. */
  rows: ContributionRow[];
  pullers: ContributionRow[];
  draggers: ContributionRow[];
  net: number;
  positiveSum: number;
  negativeSum: number;
  /** net - the index's own change; null when the index quote is missing (never 0). */
  residual: number | null;
  /** True when |residual| exceeds the tolerance: the weight seed no longer describes the index. */
  residualFlag: boolean;
  /** Symbols with no usable quote or prev close. Not counted as zero; their weight is held at the seed. */
  missing: string[];
  /** Effective number of contributors, (sum|p|)^2 / sum(p^2). 1 = one stock does everything. */
  effectiveContributors: number | null;
  concentration: Concentration | null;
}

/**
 * Residual tolerance = this many points plus RESIDUAL_TOL_REL of the day's index move. Replaying 8 sessions
 * of Daily CSVs against the seed left -0.5..-18 points on moves of 78..375 (rounded third-party weights
 * undershoot a few percent), so a flat band would flag every big day while a stale seed after a rebalance
 * misses by far more.
 */
export const DEFAULT_RESIDUAL_TOL_PTS = 10;
export const RESIDUAL_TOL_REL = 0.1;

const NARROW_BELOW = 0.2; // effective contributors / stocks counted
const BROAD_FROM = 0.4;

export function computeContributions(
  seed: SeedRow[],
  quotes: Record<string, QuoteIn | undefined>,
  nifty: IndexIn | null,
  tolPts: number = DEFAULT_RESIDUAL_TOL_PTS,
): ContributionResult {
  const empty: ContributionResult = {
    rows: [], pullers: [], draggers: [], net: 0, positiveSum: 0, negativeSum: 0,
    residual: null, residualFlag: false, missing: [], effectiveContributors: null, concentration: null,
  };
  if (!nifty || !(nifty.prevClose > 0)) return empty;

  const usable: { s: SeedRow; q: number; ltp: number; prev: number }[] = [];
  const missing: string[] = [];
  // Seed-priced stand-in for stocks we cannot quote, so one dead feed does not inflate everyone else.
  let missingBase = 0;
  for (const s of seed) {
    const q = s.weightPct / s.refPrice;
    const k = quotes[s.symbol];
    if (!k || !(k.ltp > 0) || !(k.prevClose > 0)) {
      missing.push(s.symbol);
      missingBase += q * s.refPrice;
      continue;
    }
    usable.push({ s, q, ltp: k.ltp, prev: k.prevClose });
  }
  if (usable.length === 0) return { ...empty, missing };

  const denomPrev = usable.reduce((a, u) => a + u.q * u.prev, 0) + missingBase;
  const denomLive = usable.reduce((a, u) => a + u.q * u.ltp, 0) + missingBase;

  const rows: ContributionRow[] = usable.map((u) => ({
    symbol: u.s.symbol,
    name: u.s.name,
    ltp: u.ltp,
    prevClose: u.prev,
    changePct: ((u.ltp - u.prev) / u.prev) * 100,
    weightPct: ((u.q * u.ltp) / denomLive) * 100,
    points: ((u.q * (u.ltp - u.prev)) / denomPrev) * nifty.prevClose,
  }));
  rows.sort((a, b) => b.points - a.points);

  const pullers = rows.filter((r) => r.points > 0);
  const draggers = rows.filter((r) => r.points < 0).sort((a, b) => a.points - b.points);
  const positiveSum = pullers.reduce((a, r) => a + r.points, 0);
  const negativeSum = draggers.reduce((a, r) => a + r.points, 0);
  const net = positiveSum + negativeSum;
  const residual = Number.isFinite(nifty.change) ? net - nifty.change : null;

  const gross = positiveSum - negativeSum;
  const sq = rows.reduce((a, r) => a + r.points * r.points, 0);
  const effectiveContributors = gross > 0 && sq > 0 ? (gross * gross) / sq : null;
  let concentration: Concentration | null = null;
  if (effectiveContributors !== null) {
    const ratio = effectiveContributors / rows.length;
    concentration = ratio < NARROW_BELOW ? 'narrow' : ratio >= BROAD_FROM ? 'broad' : 'moderate';
  }

  return {
    rows, pullers, draggers, net, positiveSum, negativeSum,
    residual, residualFlag: residual !== null && Math.abs(residual) > tolPts + RESIDUAL_TOL_REL * Math.abs(nifty.change),
    missing, effectiveContributors, concentration,
  };
}

export interface TotalBar {
  kind: 'pull' | 'drag' | 'net';
  label: string;
  /** Points: total pulled (+), total dragged (-) or the net. */
  value: number;
  /** Stocks on this side (all priced stocks for the net bar). */
  count: number;
  /** Biggest names on this side, largest first; empty for the net bar. */
  top: { symbol: string; points: number }[];
}

const TOP_NAMES = 5;

/**
 * The cumulative view: what the green side added, what the red side took away, and the net. Built from the same
 * result as the headline tiles, so the three bars can never disagree with them.
 */
export function buildTotals(r: ContributionResult): TotalBar[] {
  if (r.rows.length === 0) return [];
  const names = (rows: ContributionRow[]) => rows.slice(0, TOP_NAMES).map((x) => ({ symbol: x.symbol, points: x.points }));
  return [
    { kind: 'pull', label: 'Pullers', value: r.positiveSum, count: r.pullers.length, top: names(r.pullers) },
    { kind: 'drag', label: 'Draggers', value: r.negativeSum, count: r.draggers.length, top: names(r.draggers) },
    { kind: 'net', label: 'Net', value: r.net, count: r.rows.length, top: [] },
  ];
}

/** Seed file: `symbol,name,weight_pct,ref_price,as_of`. Rows that do not parse to positive numbers are dropped. */
export function parseWeightsCsv(text: string): { rows: SeedRow[]; asOf: string | null } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const rows: SeedRow[] = [];
  let asOf: string | null = null;
  for (const line of lines.slice(1)) {
    const [symbol, name, w, p, date] = line.split(',').map((c) => c.trim());
    const weightPct = Number(w);
    const refPrice = Number(p);
    if (!symbol || !(weightPct > 0) || !(refPrice > 0)) continue;
    rows.push({ symbol, name: name || symbol, weightPct, refPrice });
    if (date && (asOf === null || date > asOf)) asOf = date;
  }
  return { rows, asOf };
}
