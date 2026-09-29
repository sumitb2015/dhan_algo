// Pure rules for retiring finished Multi-Leg Focus strategies from the live
// store into an archive — kept apart from multiLegFocusStore.ts (which does
// the file I/O) so `node --test` can exercise them.

import type { MultiLegBasket } from './multiLegFocus.ts';

export type ArchivedBasket = MultiLegBasket & { archivedAt: string };

export function istDateOf(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export function isFullyClosed(basket: MultiLegBasket): boolean {
  return basket.legs.length > 0 && basket.legs.every(l => l.status === 'CLOSED');
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
