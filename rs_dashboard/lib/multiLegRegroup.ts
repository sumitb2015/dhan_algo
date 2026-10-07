import type { MultiLegBasket, MultiLegLeg } from './multiLegFocus.ts';

/**
 * Regrouping = moving legs between baskets in the ledger file. Pure (no I/O) so the
 * server route and the tests share one implementation.
 *
 * Rules that keep it safe:
 * - Only the grouping changes. A leg moves whole (fill ledger, orderRef, pendingOrders,
 *   closedFill all ride along); no order is placed and no quantity is touched.
 * - Legs in flight (PLACING / CLOSING) stay put: their order outcome is still being
 *   settled against the basket that sent it.
 * - One broker and one underlying per basket (orders route by basket.broker).
 * - A basket that lost legs is disarmed: its strategy SL/target was set for the old
 *   composition and must not fire on whatever is left.
 * - Every touched basket's rev goes up so a stale tab's older copy loses the merge.
 * - Draft (never placed) legs never share a group with traded ones: a row with any traded
 *   leg hides Place and locks its drafts, so a moved draft could never be placed or removed.
 * - Ungrouping a whole row splits only its live legs; CLOSED legs stay as that row's
 *   history so realized P&L is not scattered into one row per closed slice.
 */

export type RegroupRequest =
  | { op: 'group'; legIds: string[]; name?: string; targetBasketId?: string }
  | { op: 'ungroup'; basketId?: string; legIds?: string[] };

export interface RegroupResult {
  ok: boolean;
  error?: string;
  baskets: MultiLegBasket[];
  /** Plain-language summary for the toast. */
  message?: string;
  /** Ids of baskets that were disarmed because they lost legs. */
  disarmed: string[];
}

const IN_FLIGHT = new Set(['PLACING', 'CLOSING']);

function legLabel(l: MultiLegLeg): string {
  return `${l.strike} ${l.option}`;
}

function disarm(b: MultiLegBasket): MultiLegBasket {
  return b.riskConfig?.armed ? { ...b, riskConfig: { ...b.riskConfig, armed: false } } : b;
}

export function regroupBaskets(
  baskets: MultiLegBasket[], req: RegroupRequest, newId: () => string, nowIso: string,
): RegroupResult {
  const fail = (error: string): RegroupResult => ({ ok: false, error, baskets, disarmed: [] });

  // Resolve the legs being moved.
  let wanted: Set<string>;
  if (req.op === 'ungroup' && req.basketId) {
    const b = baskets.find(x => x.id === req.basketId);
    if (!b) return fail('Strategy not found');
    const live = b.legs.filter(l => l.status !== 'CLOSED');
    if (live.length < 2) return fail('Nothing to ungroup: this row has fewer than two live trades.');
    // Live legs each get a row; closed legs stay behind as this row's history.
    wanted = new Set(live.map(l => l.id));
  } else {
    wanted = new Set(req.legIds ?? []);
  }
  if (wanted.size === 0) return fail('No legs selected');

  const moving: { leg: MultiLegLeg; from: MultiLegBasket }[] = [];
  for (const b of baskets) for (const l of b.legs) if (wanted.has(l.id)) moving.push({ leg: l, from: b });
  if (moving.length > wanted.size) return fail('A selected leg id appears in more than one row. Fix the ledger file before regrouping.');
  if (moving.length !== wanted.size) return fail('Some selected legs are not saved yet or no longer exist. Reload and try again.');

  const busy = moving.find(m => IN_FLIGHT.has(m.leg.status));
  if (busy) return fail(`${legLabel(busy.leg)} has an order in flight. Wait for it to settle, then regroup.`);

  // Ungroup leaves a one-leg row alone: splitting it would only rename a group the user may have named.
  if (req.op === 'ungroup' && !req.basketId) {
    const alone = moving.filter(m => m.from.legs.length === 1);
    if (alone.length === moving.length) return fail('Those trades are already in separate rows.');
    for (const a of alone) { wanted.delete(a.leg.id); moving.splice(moving.indexOf(a), 1); }
  }

  const first = moving[0].from;
  if (moving.some(m => m.from.broker !== first.broker || m.from.underlying !== first.underlying)) {
    return fail('A group must be one broker and one underlying. Select legs from the same broker and underlying.');
  }

  let target: MultiLegBasket | undefined;
  if (req.op === 'group' && req.targetBasketId) {
    target = baskets.find(b => b.id === req.targetBasketId);
    if (!target) return fail('Target group not found');
    if (target.broker !== first.broker || target.underlying !== first.underlying) {
      return fail('That group is on a different broker or underlying.');
    }
    if (moving.every(m => m.from.id === target!.id)) return fail('Those trades are already in that group.');
  }

  // Never mix drafts with traded legs in the resulting group (see header).
  if (req.op === 'group') {
    const result = [...(target ? target.legs.filter(l => !wanted.has(l.id)) : []), ...moving.map(m => m.leg)];
    const drafts = result.filter(l => l.status === 'DRAFT').length;
    if (drafts > 0 && drafts < result.length) {
      return fail('Draft (unplaced) legs can only be grouped with other draft legs.');
    }
  }

  const movedIds = new Set(moving.map(m => m.leg.id));
  const touched = new Set<string>(moving.map(m => m.from.id));
  const disarmed: string[] = [];
  const bump = (b: MultiLegBasket): MultiLegBasket => ({ ...b, rev: (b.rev ?? 0) + 1, updatedAt: nowIso });

  // Remove the legs from their sources.
  let next = baskets.map(b => {
    if (!touched.has(b.id)) return b;
    const rest = b.legs.filter(l => !movedIds.has(l.id));
    let nb: MultiLegBasket = { ...b, legs: rest };
    if (b.riskConfig?.armed) { nb = disarm(nb); disarmed.push(b.id); }
    return bump(nb);
  });

  const legsOf = (ids: string[]) => moving.filter(m => ids.includes(m.leg.id)).map(m => m.leg);
  // A new group keeps the lot multiplier when every leg came from one row (Scale reads it).
  const sources = new Set(moving.map(m => m.from.id));
  const carriedMultiplier = sources.size === 1 ? first.multiplier : undefined;
  const born = (legs: MultiLegLeg[], name?: string, multiplier?: number): MultiLegBasket => {
    const expiries = legs.map(l => l.expiry || first.expiry).filter(Boolean).sort();
    const front = expiries[0] || first.expiry;
    const far = expiries.find(e => e !== front);
    return {
      id: newId(),
      ...(name ? { groupName: name } : {}),
      underlying: first.underlying,
      expiry: front,
      ...(far ? { farExpiry: far } : {}),
      broker: first.broker,
      ...(multiplier && multiplier > 1 ? { multiplier } : {}),
      legs,
      riskConfig: { targetUnit: 'pts', slUnit: 'pts', armed: false },
      createdAt: nowIso,
      updatedAt: nowIso,
      rev: 1,
    };
  };

  let message: string;
  if (req.op === 'group') {
    const name = req.name?.trim().slice(0, 40) || undefined;
    if (target) {
      const tid = target.id;
      next = next.map(b => {
        if (b.id !== tid) return b;
        let nb: MultiLegBasket = { ...b, legs: [...b.legs, ...legsOf([...movedIds])] };
        // The target's own SL/target was tuned for its old legs too.
        if (b.riskConfig?.armed && !touched.has(tid)) { nb = disarm(nb); disarmed.push(tid); }
        return touched.has(tid) ? { ...nb, rev: (nb.rev ?? 0) } : bump(nb);
      });
      message = `Moved ${moving.length} leg(s) into ${target.groupName || target.name || 'the group'}`;
    } else {
      next = [...next, born(moving.map(m => m.leg), name, carriedMultiplier)];
      message = `Grouped ${moving.length} leg(s)${name ? ` as "${name}"` : ''}`;
    }
  } else {
    // Ungroup: every leg becomes its own unnamed row, which the page lists as an ungrouped trade.
    const singles = moving.map(m => born([m.leg]));
    next = [...next, ...singles];
    message = `Ungrouped ${moving.length} leg(s) into separate rows`;
  }

  // A source emptied by the move has nothing left to track.
  const emptied = new Set(next.filter(b => b.legs.length === 0 && touched.has(b.id)).map(b => b.id));
  next = next.filter(b => !emptied.has(b.id));
  return { ok: true, baskets: next, message, disarmed: disarmed.filter(id => !emptied.has(id)) };
}
