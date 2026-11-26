// Index Scalper one-cancels-other for REAL target / stop orders: when a position on a contract goes FLAT (its target or
// stop filled, an Exit / Exit All / trailing-stop exit, the mobile app closed it), this page's leftover target / stop
// orders on that contract are cancelled; a working stop on a flat position would otherwise OPEN a new one when it
// triggers. When a position is REDUCED (a target filled in part), this page's untouched target / stop orders bigger than
// what is left are cut down to it, so the other one can never flip the position. When a position is INCREASED (lots added
// on the same side), this page's one untouched target and one untouched stop are grown to the whole position, so the
// added lots are covered too (2026-11-26: a 1-lot target and no stop on a 4-lot short). Two orders of one kind are left
// alone and reported: growing both would close more than is held.
//
// Only this page's own LIMIT / SL / SL-M orders on the old position's closing side count as its target / stop: a market
// order is never one (it may be a Reverse's opening order in flight), and another placer's order is never touched.
// Pure (no React, no fetch); the terminal confirms a flat with a fresh positions read, re-reads the order book, and
// sends the cancels / modifies. Tested in indexScalperOco.test.ts.

export interface OcoEvent {
  securityId: string;
  kind: 'flat' | 'reduced' | 'increased';
  /** The closing side of the position before the change (a long's SELL). */
  closeSide: 'BUY' | 'SELL';
  /** Open quantity now, in the broker's own unit (0 when flat). */
  left: number;
}

export interface OcoOrderLike {
  id: string; securityId: string; side: string; own: boolean; cancellable: boolean; rawType: string;
  qty: number | null; tradedQty: number | null;
}

const BRACKET_TYPES = new Set(['LIMIT', 'STOP_LOSS', 'STOP_LOSS_MARKET']);

/** Signed open quantity per contract (a security can carry an INTRADAY and a MARGIN row: they are summed). */
export function netBySecurity(legs: readonly { securityId: string; netQty: number }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of legs) if (l.securityId && Number.isFinite(l.netQty) && l.netQty !== 0) m.set(l.securityId, (m.get(l.securityId) ?? 0) + l.netQty);
  for (const [k, v] of m) if (v === 0) m.delete(k);
  return m;
}

/** Contracts that went flat, or were reduced / increased on the same side, between two reads. Opening and flipping are
 *  not events (a flip is a Reverse or a deliberate order: its orders are the user's to keep). */
export function ocoEvents(prev: ReadonlyMap<string, number>, cur: ReadonlyMap<string, number>): OcoEvent[] {
  const out: OcoEvent[] = [];
  for (const [id, p] of prev) {
    if (p === 0) continue;
    const q = cur.get(id) ?? 0;
    const closeSide = p > 0 ? 'SELL' : 'BUY';
    if (q === 0) out.push({ securityId: id, kind: 'flat', closeSide, left: 0 });
    else if (Math.sign(q) === Math.sign(p) && Math.abs(q) < Math.abs(p)) out.push({ securityId: id, kind: 'reduced', closeSide, left: Math.abs(q) });
    else if (Math.sign(q) === Math.sign(p) && Math.abs(q) > Math.abs(p)) out.push({ securityId: id, kind: 'increased', closeSide, left: Math.abs(q) });
  }
  return out;
}

/** What to send for these events against a FRESH order book. */
export function ocoActions(events: readonly OcoEvent[], orders: readonly OcoOrderLike[]): {
  cancel: OcoOrderLike[]; resize: { order: OcoOrderLike; qty: number }[]; ambiguous: OcoOrderLike[];
} {
  const cancel: OcoOrderLike[] = [];
  const resize: { order: OcoOrderLike; qty: number }[] = [];
  const ambiguous: OcoOrderLike[] = [];
  for (const ev of events) {
    if (ev.kind === 'increased') {
      const mine = orders.filter(o => o.own && o.cancellable && o.securityId === ev.securityId && o.side === ev.closeSide
        && BRACKET_TYPES.has((o.rawType || '').toUpperCase()));
      for (const group of [mine.filter(o => o.rawType.toUpperCase() === 'LIMIT'), mine.filter(o => o.rawType.toUpperCase() !== 'LIMIT')]) {
        if (group.length > 1) { ambiguous.push(...group); continue; }
        const o = group[0];
        // Grow an untouched one only (a part-filled order's remaining size is not the position's).
        if (o && (o.tradedQty ?? 0) === 0 && o.qty !== null && o.qty < ev.left) resize.push({ order: o, qty: ev.left });
      }
      continue;
    }
    for (const o of orders) {
      if (!o.own || !o.cancellable || o.securityId !== ev.securityId || o.side !== ev.closeSide) continue;
      if (!BRACKET_TYPES.has((o.rawType || '').toUpperCase())) continue;
      if (ev.kind === 'flat') { cancel.push(o); continue; }
      // Reduced: cut an untouched order that is bigger than what is left. A part-filled one is itself the reducer.
      if ((o.tradedQty ?? 0) === 0 && o.qty !== null && o.qty > ev.left) resize.push({ order: o, qty: ev.left });
    }
  }
  return { cancel, resize, ambiguous };
}
