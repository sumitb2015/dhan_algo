/**
 * Cumulative OI — spot-centred PCR and recorded-window width (pure, no I/O).
 *
 * The cumulative OI chart and its regime maths run on a FIXED strike window (ATM locked at the first snapshot): the
 * regime treats the CE/PE sums as one constant-membership series, so a moving window would make them jump. The PCR
 * number is a single point-in-time ratio, so it can be centred on the latest spot instead, limited to the strikes the
 * collector actually recorded.
 */

export interface OiRow { strike: number; ceOI: number; peOI: number }

export interface SpotPcr {
  /** Put OI ÷ call OI over the window; null when call OI is zero. */
  value: number | null;
  /** Centre strike of the window used. */
  centre: number;
  /** Strikes each side of the centre. */
  wings: number;
  /** True when the window could not be centred on spot (it hit the recorded edge) and was shifted or narrowed. */
  clipped: boolean;
}

export interface BandRow { timestamp: string; strike: number }
export interface StrikeBand { lo: number; hi: number }

/** Lowest and highest strike of one snapshot (`timestamp`); null when it has no rows. */
export function snapshotBand(rows: BandRow[], timestamp: string): StrikeBand | null {
  let lo = Infinity, hi = -Infinity;
  for (const r of rows) {
    if (r.timestamp !== timestamp) continue;
    if (r.strike < lo) lo = r.strike;
    if (r.strike > hi) hi = r.strike;
  }
  return lo <= hi ? { lo, hi } : null;
}

/** The strike range EVERY snapshot in the file covers (highest per-snapshot low, lowest per-snapshot high). A
 *  collector restart re-locks ATM and appends to the same day's file (possibly with a different ±N), so the union of
 *  all rows overstates what the early snapshots hold. Null when there are no rows or the snapshots share no strike. */
export function commonStrikeBand(rows: BandRow[]): StrikeBand | null {
  const per = new Map<string, StrikeBand>();
  for (const r of rows) {
    const b = per.get(r.timestamp);
    if (!b) per.set(r.timestamp, { lo: r.strike, hi: r.strike });
    else { if (r.strike < b.lo) b.lo = r.strike; if (r.strike > b.hi) b.hi = r.strike; }
  }
  if (!per.size) return null;
  let lo = -Infinity, hi = Infinity;
  for (const b of per.values()) { if (b.lo > lo) lo = b.lo; if (b.hi < hi) hi = b.hi; }
  return lo <= hi ? { lo, hi } : null;
}

/** The collector's locked ATM: it records ATM ±N, so the centre of the first snapshot's strikes, snapped to the
 *  step. Rounding the first row's spot can land one step off (the collector locked on an earlier spot read). Null
 *  when the first snapshot has no rows. */
export function lockedAtm(rows: BandRow[], firstTimestamp: string, step: number): number | null {
  const b = snapshotBand(rows, firstTimestamp);
  return b ? Math.round((b.lo + b.hi) / 2 / step) * step : null;
}

/** Widest symmetric window (strikes each side of `atm`) the recorded strike set supports; at least 1. */
export function recordedWings(minStrike: number, maxStrike: number, atm: number, step: number): number {
  const w = Math.floor(Math.min(atm - minStrike, maxStrike - atm) / step);
  return Number.isFinite(w) && w >= 1 ? w : 1;
}

/** PCR over `wings` strikes either side of the strike nearest `spot`, kept inside [minStrike, maxStrike]: a window
 *  that would overhang an edge is shifted inward (same width) and, if the recorded band is narrower than the
 *  window, narrowed. `rows` are one snapshot's strikes. */
export function spotCentredPcr(
  rows: OiRow[], spot: number, step: number, wings: number, minStrike: number, maxStrike: number,
): SpotPcr {
  let centre = Math.round(spot / step) * step;
  let lo = centre - wings * step, hi = centre + wings * step;
  let clipped = false;
  if (lo < minStrike) { const d = minStrike - lo; lo += d; hi += d; clipped = true; }
  if (hi > maxStrike) { const d = hi - maxStrike; lo -= d; hi -= d; clipped = true; }
  if (lo < minStrike) { lo = minStrike; clipped = true; }     // band narrower than the window
  if (hi > maxStrike) { hi = maxStrike; clipped = true; }
  centre = Math.round((lo + hi) / 2 / step) * step;
  let ce = 0, pe = 0;
  for (const r of rows) {
    if (r.strike < lo || r.strike > hi) continue;
    ce += r.ceOI; pe += r.peOI;
  }
  return { value: ce > 0 ? pe / ce : null, centre, wings: Math.round((hi - lo) / 2 / step), clipped };
}

// ── The series' own strike window ─────────────────────────────────────────────────────────────────────────────────────

/** The newest run of snapshots that still share at least one strike, and the strikes ALL of them hold. Normally the
 *  whole day. A collector restart re-locks ATM; if it ever lands so far away that the snapshots before it share no
 *  strike with those after, the earlier ones cannot be part of one constant-membership series, so the run starts at
 *  the restart (`from` = its first timestamp) instead of the window collapsing onto strikes later snapshots lack.
 *  Null when there are no rows. Timestamps are "YYYY-MM-DD HH:MM:SS", so they sort as text. */
export function sharedRun(rows: BandRow[]): { from: string; band: StrikeBand; whole: boolean } | null {
  const per = new Map<string, StrikeBand>();
  for (const r of rows) {
    const b = per.get(r.timestamp);
    if (!b) per.set(r.timestamp, { lo: r.strike, hi: r.strike });
    else { if (r.strike < b.lo) b.lo = r.strike; if (r.strike > b.hi) b.hi = r.strike; }
  }
  const order = [...per.keys()].sort();
  if (!order.length) return null;
  let i = order.length - 1;
  let { lo, hi } = per.get(order[i])!;
  for (let j = i - 1; j >= 0; j--) {
    const b = per.get(order[j])!;
    const nlo = Math.max(lo, b.lo), nhi = Math.min(hi, b.hi);
    if (nlo > nhi) break;
    lo = nlo; hi = nhi; i = j;
  }
  return { from: order[i], band: { lo, hi }, whole: i === 0 };
}

/** One strike of one snapshot; an OI the file did not record is null (never 0: a blank must not read as a dip). */
export interface OiSnapRow extends BandRow { ceOI: number | null; peOI: number | null }

/** Timestamps (from `from` on) whose snapshot holds EVERY strike of [lo, hi] (`expected` of them) with both OIs known.
 *  The rest are left out of the series: a snapshot the collector is still writing, or one with a blank OI, would
 *  otherwise sum fewer strikes and plot as a sudden OI drop (and feed that drop to the regime). */
export function completeSnapshots(rows: OiSnapRow[], from: string, lo: number, hi: number, expected: number): Set<string> {
  const seen = new Map<string, Set<number>>();
  for (const r of rows) {
    if (r.timestamp < from || r.strike < lo || r.strike > hi || r.ceOI === null || r.peOI === null) continue;
    let s = seen.get(r.timestamp);
    if (!s) seen.set(r.timestamp, s = new Set());
    s.add(r.strike);
  }
  const out = new Set<string>();
  for (const [ts, s] of seen) if (s.size === expected) out.add(ts);
  return out;
}

/** Replace a one-snapshot bad spot read (it jumps away from BOTH neighbours while they stay close to each other) by the
 *  neighbours' average. Thresholds are a share of the price, so they fit every underlying: 0.05 % / 0.04 % is the
 *  12 / 10 points this was tuned at on NIFTY near 25,000, about 28 / 22 on BANKNIFTY, 4 / 3 on crude. */
export function despikeSpots(spots: number[], jumpRel = 0.0005, closeRel = 0.0004): number[] {
  const out = [...spots];
  for (let i = 1; i < spots.length - 1; i++) {
    const prev = spots[i - 1], cur = spots[i], next = spots[i + 1];
    const ref = (prev + next) / 2;
    if (!(ref > 0)) continue;
    if (Math.abs(cur - prev) > jumpRel * ref && Math.abs(cur - next) > jumpRel * ref && Math.abs(prev - next) < closeRel * ref) out[i] = ref;
  }
  return out;
}

/** How far the latest spot is from the centre of the fixed window, in strikes (signed), and whether it has left the
 *  window: the series stays on the opening ATM by design, so on a trending day it describes strikes the price has
 *  moved away from, and the chart must say so. */
export function windowDrift(spot: number, atm: number, step: number, wings: number): { strikes: number; outside: boolean } {
  const strikes = Math.round((spot - atm) / step);
  return { strikes: strikes === 0 ? 0 : strikes, outside: Math.abs(spot - atm) > wings * step };
}
