// Pure rules for retiring finished Multi-Leg Focus strategies from the live
// store into an archive — kept apart from multiLegFocusStore.ts (which does
// the file I/O) so `node --test` can exercise them.

import { legCountsToday, legPnl, type MultiLegBasket, type MultiLegLeg } from './multiLegFocus.ts';

/** `retiredFrom` marks a history record split off a still-live basket (see splitEarlierDayLegs). */
export type ArchivedBasket = MultiLegBasket & { archivedAt: string; retiredFrom?: string };

export function istDateOf(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export function isFullyClosed(basket: MultiLegBasket): boolean {
  // A resting stop entry can still open a leg, so a row holding one is not finished.
  return basket.legs.length > 0 && basket.legs.every(l => l.status === 'CLOSED') && !(basket.waitingEntries?.length);
}

/** A basket that never had an order acknowledged has no trade history worth keeping. */
export function hasTradeHistory(basket: MultiLegBasket): boolean {
  return basket.legs.some(l => l.orderRef != null || l.closedFill != null || (l.fill?.qty ?? 0) > 0);
}

/** Fully closed baskets last updated before `today` (IST 'YYYY-MM-DD') retire; the rest stay live. */
export function splitStaleClosed(
  baskets: MultiLegBasket[],
  today: string,
): { keep: MultiLegBasket[]; retire: MultiLegBasket[] } {
  const keep: MultiLegBasket[] = [];
  const retire: MultiLegBasket[] = [];
  for (const b of baskets) (isFullyClosed(b) && istDateOf(b.updatedAt) < today ? retire : keep).push(b);
  return { keep, retire };
}

/**
 * Appends retired baskets to the archive. Idempotent by id — the archive is
 * written before the live store drops them, so a crash between the two writes
 * retries the same baskets next time; the later copy replaces the earlier one.
 */
export function appendToArchive(archive: ArchivedBasket[], retired: MultiLegBasket[], nowIso: string): ArchivedBasket[] {
  const incoming = retired.filter(hasTradeHistory);
  if (incoming.length === 0) return archive;
  const ids = new Set(incoming.map(b => b.id));
  return [...archive.filter(a => !ids.has(a.id)), ...incoming.map(b => ({ ...b, archivedAt: nowIso }))];
}

/** Dhan quotes MCX crude in lots, so its per-point value needs the contract multiplier (same rule as the live page). */
export function pnlMultiplier(basket: Pick<MultiLegBasket, 'broker' | 'underlying'>): number {
  if (basket.broker !== 'dhan') return 1;
  return basket.underlying === 'CRUDEOIL' ? 100 : basket.underlying === 'CRUDEOILM' ? 10 : 1;
}

export interface ArchiveSummary {
  /** Epoch ms of the last leg close, else the basket's last update. */
  closedAt: number;
  realized: number;
  /** Closed legs with no recorded exit fill — their P&L is unknown, not zero. */
  unpricedLegs: number;
}

export function summarizeArchived(b: MultiLegBasket): ArchiveSummary {
  const mult = pnlMultiplier(b);
  let realized = 0;
  let unpricedLegs = 0;
  let closedAt = 0;
  for (const l of b.legs) {
    if (l.status !== 'CLOSED') continue;
    if (l.closedAt != null && l.closedAt > closedAt) closedAt = l.closedAt;
    if (!l.closedFill) { if ((l.fill?.avgPrice ?? 0) > 0) unpricedLegs += 1; continue; }
    realized += legPnl(l, 0, mult);
  }
  return { closedAt: closedAt || Date.parse(b.updatedAt), realized, unpricedLegs };
}

/** Archive id of the history record that holds a live basket's earlier-day closed legs. */
export function historyIdFor(basketId: string): string {
  return `${basketId}__history`;
}

/**
 * A live basket accumulates every roll and adjustment, so after a conversion
 * (iron condor -> short straddle) its row would keep the old structure's legs
 * and their P&L. Legs closed on an EARLIER IST day are split out; legs closed
 * today stay (they are today's P&L, the conversion itself). Only baskets that
 * still have a non-closed leg are split — a fully closed one retires whole via
 * splitStaleClosed. A CLOSED leg without `closedAt` counts as earlier-day,
 * the same rule as legCountsToday.
 */
export function splitEarlierDayLegs(
  basket: MultiLegBasket,
  now: number = Date.now(),
): { keep: MultiLegBasket; retired: MultiLegLeg[] } {
  const live = basket.legs.some(l => l.status !== 'CLOSED');
  if (!live) return { keep: basket, retired: [] };
  const retired = basket.legs.filter(l => l.status === 'CLOSED' && !legCountsToday(l, now));
  if (retired.length === 0) return { keep: basket, retired };
  const gone = new Set(retired.map(l => l.id));
  return { keep: { ...basket, legs: basket.legs.filter(l => !gone.has(l.id)) }, retired };
}

/** Folds newly retired legs into the basket's history record (created on first use), idempotent by leg id. */
export function mergeHistoryRecord(
  existing: ArchivedBasket | undefined,
  source: MultiLegBasket,
  retired: MultiLegLeg[],
  nowIso: string,
): ArchivedBasket {
  const have = new Set((existing?.legs ?? []).map(l => l.id));
  const legs = [...(existing?.legs ?? []), ...retired.filter(l => !have.has(l.id))];
  return {
    ...(existing ?? source),
    id: historyIdFor(source.id),
    name: `${source.name ?? 'Strategy'} (earlier legs)`,
    retiredFrom: source.id,
    legs,
    archivedAt: nowIso,
  };
}
