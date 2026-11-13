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
