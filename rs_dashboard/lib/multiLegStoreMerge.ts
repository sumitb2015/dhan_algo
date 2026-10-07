import type { MultiLegBasket, MultiLegLeg } from './multiLegFocus.ts';
import { canon } from './revMerge.ts';

/**
 * Server-side merge of one basket save into the stored copy, so a tab holding
 * an old copy can't write it back over newer data (2026-10-01: ledger repairs
 * had to be applied with the page closed, because any open tab would save its
 * whole stale basket over them).
 *
 * Every basket and leg carries a `rev` the saving tab bumps when it changes
 * that item (withRevs). The merge keeps, per item, whichever side has the
 * higher rev; on a tie with different content the stored copy wins (it was
 * saved first) and the leg is reported as a conflict for the tab to surface.
 * Two more rules hold whatever the revs say:
 * - a leg that ever traded (status other than DRAFT) is never dropped by a
 *   save — only a newer save may drop a DRAFT leg (removeLeg, preset swap);
 * - the append-only identity lists (orderIds, outsideTradeKeys) are unioned,
 *   so a lost write can't make this tool's own order look like an outside
 *   trade, or let one outside trade price two closes.
 */

type Revved = { rev?: number };

/** Content of a leg or basket for change detection: no rev, no updatedAt. */
export function stableBody(x: (MultiLegLeg | MultiLegBasket) & Revved, withLegs = true): string {
  const { rev: _rev, ...rest } = x as unknown as Record<string, unknown> & Revved;
  void _rev;
  delete (rest as Record<string, unknown>).updatedAt;
  if ('legs' in rest && Array.isArray(rest.legs)) {
    rest.legs = withLegs ? (rest.legs as MultiLegLeg[]).map(l => stableBody(l)) : (rest.legs as MultiLegLeg[]).map(l => l.id);
  }
  return canon(rest);
}

function union(a?: string[], b?: string[]): string[] | undefined {
  if (!a?.length) return b?.length ? b : a;
  if (!b?.length) return a;
  const out = Array.from(new Set([...a, ...b]));
  return out.length === a.length ? a : out;
}

function withIdentity(l: MultiLegLeg, other: MultiLegLeg): MultiLegLeg {
  const orderIds = union(l.orderIds, other.orderIds);
  const outsideTradeKeys = union(l.outsideTradeKeys, other.outsideTradeKeys);
  if (orderIds === l.orderIds && outsideTradeKeys === l.outsideTradeKeys) return l;
  return { ...l, ...(orderIds ? { orderIds } : {}), ...(outsideTradeKeys ? { outsideTradeKeys } : {}) };
}

export interface BasketMergeResult {
  basket: MultiLegBasket;
  /** Legs whose incoming change lost to a different stored change at the same rev. */
  conflicts: string[];
}

export function mergeBasketWrite(
  stored: (MultiLegBasket & Revved) | undefined,
  incoming: MultiLegBasket & Revved,
): BasketMergeResult {
  if (!stored) return { basket: incoming, conflicts: [] };
  const conflicts: string[] = [];
  const inRev = incoming.rev ?? 0;
  const stRev = stored.rev ?? 0;
  const basketNewer = inRev > stRev;

  const storedById = new Map(stored.legs.map(l => [l.id, l as MultiLegLeg & Revved]));
  const incomingIds = new Set(incoming.legs.map(l => l.id));
  const legs: MultiLegLeg[] = [];
  for (const inc of incoming.legs as (MultiLegLeg & Revved)[]) {
    const st = storedById.get(inc.id);
    if (!st) { legs.push(inc); continue; }
    if ((inc.rev ?? 0) > (st.rev ?? 0)) { legs.push(withIdentity(inc, st)); continue; }
    if ((inc.rev ?? 0) === (st.rev ?? 0) && stableBody(inc) !== stableBody(st)) conflicts.push(inc.id);
    legs.push(withIdentity(st, inc));
  }
  for (const st of stored.legs) {
    if (incomingIds.has(st.id)) continue;
    if (st.status === 'DRAFT' && basketNewer) continue;
    legs.push(st);
  }

  const fields = basketNewer ? incoming : stored;
  return {
    basket: { ...fields, legs, rev: Math.max(inRev, stRev), updatedAt: incoming.updatedAt ?? stored.updatedAt } as MultiLegBasket,
    conflicts,
  };
}

/** Client side: last saved rev + body per basket ('b:id') and leg ('l:id'). */
export type RevBook = Map<string, { rev: number; body: string }>;

/** Records a basket as the server now holds it (on load, or after a save's response). */
export function noteSaved(book: RevBook, basket: MultiLegBasket & Revved): void {
  book.set(`b:${basket.id}`, { rev: basket.rev ?? 0, body: stableBody(basket, false) });
  for (const l of basket.legs as (MultiLegLeg & Revved)[]) book.set(`l:${l.id}`, { rev: l.rev ?? 0, body: stableBody(l) });
}

/** Stamps the rev to send: unchanged items keep theirs, changed ones go up by one. */
export function withRevs(book: RevBook, basket: MultiLegBasket & Revved): MultiLegBasket & Revved {
  const bump = (key: string, body: string, own?: number): number => {
    const prev = book.get(key);
    const rev = prev ? (prev.body === body ? prev.rev : prev.rev + 1) : (own ?? 0) + 1;
    book.set(key, { rev, body });
    return rev;
  };
  const legs = (basket.legs as (MultiLegLeg & Revved)[]).map(l => ({ ...l, rev: bump(`l:${l.id}`, stableBody(l), l.rev) }));
  return { ...basket, legs, rev: bump(`b:${basket.id}`, stableBody(basket, false), basket.rev) };
}

/**
 * Takes the server's merged copy into local state for every leg (and the
 * basket's own fields) that this tab has NOT changed since it sent `sent` —
 * a change made locally while the save was in flight goes out with its own
 * save and must not be reverted here. Legs only the server has are added
 * (another tab added them). Returns `local` itself when nothing differs.
 */
export function adoptServerBasket(
  local: MultiLegBasket,
  sent: MultiLegBasket & Revved,
  server: MultiLegBasket & Revved,
): MultiLegBasket {
  const sentById = new Map(sent.legs.map(l => [l.id, stableBody(l)]));
  const serverById = new Map(server.legs.map(l => [l.id, l]));
  let changed = false;
  const legs = local.legs.map(l => {
    const sv = serverById.get(l.id);
    if (!sv || sentById.get(l.id) !== stableBody(l)) return l;
    if (stableBody(sv) === stableBody(l)) return l;
    changed = true;
    return sv;
  });
  const localIds = new Set(local.legs.map(l => l.id));
  for (const sv of server.legs) {
    if (!localIds.has(sv.id) && !sentById.has(sv.id)) { legs.push(sv); changed = true; }
  }
  const fieldsUnchanged = stableBody({ ...local, legs: [] }, false) === stableBody({ ...sent, legs: [] }, false);
  const takeFields = fieldsUnchanged && stableBody({ ...server, legs: [] }, false) !== stableBody({ ...local, legs: [] }, false);
  if (!changed && !takeFields) return local;
  const base = takeFields ? { ...server } : { ...local };
  return { ...base, legs } as MultiLegBasket;
}

/**
 * A leg lives in exactly one basket. A stale tab's save of an old group must not bring
 * back a leg that regroup moved elsewhere. Only legs the save ADDED (not in `storedLegIds`,
 * the basket's legs on disk before the merge) are considered; a leg already stored here is
 * never touched by this rule. Such a leg is removed from this basket, and its change is
 * applied where the leg lives now under the normal per-leg rev rule: a stale tab's exit
 * or fill that happened after the regroup still reaches the ledger. A basket left with
 * no legs is removed. Mutates `baskets`; returns the ids of baskets that took a change.
 */
export function relocateResurrectedLegs(
  baskets: MultiLegBasket[], basketId: string, storedLegIds: Set<string>, nowIso: string,
): string[] {
  const i = baskets.findIndex(b => b.id === basketId);
  if (i < 0) return [];
  const owner = new Map<string, number>();
  baskets.forEach((b, j) => { if (j !== i) for (const l of b.legs) owner.set(l.id, j); });
  const moved = baskets[i].legs.filter(l => !storedLegIds.has(l.id) && owner.has(l.id)) as (MultiLegLeg & Revved)[];
  if (moved.length === 0) return [];
  const changed = new Set<string>();
  for (const inc of moved) {
    const j = owner.get(inc.id)!;
    const legs = baskets[j].legs.map(st => {
      if (st.id !== inc.id) return st;
      const next = (inc.rev ?? 0) > ((st as MultiLegLeg & Revved).rev ?? 0) ? withIdentity(inc, st) : withIdentity(st, inc);
      if (next !== st) changed.add(baskets[j].id);
      return next;
    });
    if (changed.has(baskets[j].id)) baskets[j] = { ...baskets[j], legs, updatedAt: nowIso };
  }
  const gone = new Set(moved.map(l => l.id));
  const kept = baskets[i].legs.filter(l => !gone.has(l.id));
  if (kept.length === 0) baskets.splice(i, 1);
  else baskets[i] = { ...baskets[i], legs: kept };
  return [...changed];
}
