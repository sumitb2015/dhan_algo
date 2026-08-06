// Lot-aware partial quantity math for the scalper terminals.
//
// Quantities on the wire are ABSOLUTE units everywhere (see CLAUDE.md
// "MCX quantity semantics" for the one exception, which doesn't apply to the
// index-option terminals). Lots exist only in the UI. A partial exit or a
// half strike-roll must therefore land on a whole-lot boundary, otherwise the
// broker is left holding an unroundable stub.
//
// The rule, agreed with the user: round DOWN to whole lots, and don't offer a
// percentage that maps to zero lots or to the same lot count as a smaller
// percentage already on offer.

export type ClosePct = 25 | 50 | 75 | 100;

export interface PartialChip {
  pct: ClosePct;
  /** Whole lots this chip closes. */
  lots: number;
  /** Absolute units to send on the wire. pct===100 carries |netQty| verbatim. */
  units: number;
  enabled: boolean;
  /** Always set — describes the action when enabled, the reason when not. */
  title: string;
}

export const DEFAULT_CLOSE_PCTS: readonly ClosePct[] = [25, 50, 75, 100];

/** Whole lots currently open. 0 when the lot size is unusable or the leg is flat. */
export function openLots(netQty: number, lotSize: number): number {
  const abs = Math.abs(Number(netQty) || 0);
  const ls = Number(lotSize);
  if (!Number.isFinite(ls) || ls <= 0 || abs <= 0) return 0;
  return Math.floor(abs / ls);
}

/**
 * Units to trade for an arbitrary fraction of an open position, rounded DOWN
 * to whole lots. `fraction >= 1` returns |netQty| verbatim so a non-lot
 * remainder left by an earlier partial is still fully closable. Returns 0 when
 * the fraction doesn't reach a single lot.
 */
export function fractionUnits(netQty: number, lotSize: number, fraction: number): number {
  const abs = Math.abs(Number(netQty) || 0);
  if (fraction >= 1) return abs;
  if (fraction <= 0) return 0;
  const lots = Math.floor(openLots(netQty, lotSize) * fraction);
  return lots > 0 ? lots * Number(lotSize) : 0;
}

/**
 * Chip model for the partial square-off row, ascending by percentage.
 *
 * A chip is disabled when it maps to less than one lot, or to the same lot
 * count as a smaller enabled chip (e.g. 75% of 2 lots floors to 1 lot, which
 * is what 50% already does), or when it would in fact close everything. 100%
 * is always enabled and always closes the whole position.
 */
export function partialCloseChips(
  netQty: number,
  lotSize: number,
  pcts: readonly ClosePct[] = DEFAULT_CLOSE_PCTS,
): PartialChip[] {
  const abs = Math.abs(Number(netQty) || 0);
  const ls = Number(lotSize);
  const usable = Number.isFinite(ls) && ls > 0;
  const total = openLots(netQty, lotSize);

  const out: PartialChip[] = [];
  // Watermark of the largest lot count already offered, so a bigger percentage
  // that floors to the same size is suppressed rather than shown as a duplicate.
  let prevEnabledLots = 0;
  let prevEnabledPct = 0;

  for (const pct of pcts) {
    const isFull = pct === 100;
    const lots = isFull ? total : Math.floor((total * pct) / 100);
    const units = isFull ? abs : lots * (usable ? ls : 0);

    let enabled = true;
    let title = '';

    if (abs <= 0) {
      enabled = false;
      title = 'No open quantity';
    } else if (isFull) {
      title = `Close entire position (${abs} qty)`;
    } else if (!usable) {
      enabled = false;
      title = 'Lot size unknown for this position';
    } else if (total < 1) {
      enabled = false;
      title = `Position is under one lot (${abs} qty) — use Close`;
    } else if (lots < 1) {
      enabled = false;
      title = `Needs ≥${Math.ceil(100 / pct)} lots — position is ${total} lot${total === 1 ? '' : 's'}`;
    } else if (lots <= prevEnabledLots) {
      enabled = false;
      title = `Same as ${prevEnabledPct}% (${lots} lot${lots === 1 ? '' : 's'}) at ${total} lots`;
    } else {
      // lots < total always holds below 100%, so `units` can never reach `abs` —
      // a fraction chip is never a disguised full close.
      title = `Close ${lots} lot${lots === 1 ? '' : 's'} (${units} qty) — ${pct}% of ${total} lots`;
    }

    if (enabled && !isFull) {
      prevEnabledLots = lots;
      prevEnabledPct = pct;
    }
    out.push({ pct, lots, units, enabled, title });
  }

  return out;
}
