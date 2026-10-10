import type { MultiLegBasket, MultiLegLeg } from './multiLegFocus.ts';

/**
 * Group / ungroup trades by moving legs between baskets in the ledger file. Pure (no I/O):
 * the server route and the tests share it.
 *
 * - group:   the picked legs go into a new named basket, or into an existing one.
 * - ungroup: each picked leg becomes an ungrouped trade (a one-leg basket with no name,
 *            see isLooseTrade). A leg already alone in its basket just loses the name.
 *
 * Safety rules:
 * - A leg moves whole (fill ledger, orderRef, pendingOrders, closedFill ride along). No order is placed.
 * - Legs with an order in flight (PLACING / CLOSING) are refused.
 * - One broker and one underlying per basket (orders route by basket.broker).
 * - Drafts never share a group with traded legs (a row with a traded leg hides Place).
 * - A basket whose legs change is disarmed: its strategy SL/target was set for the old legs.
 * - Every changed basket's rev goes up so a stale tab's older copy loses the merge.
 */

export type RegroupRequest =
  | { op: 'group'; legIds: string[]; name?: string; targetBasketId?: string }
  | { op: 'ungroup'; legIds: string[] };

export interface RegroupResult {
  ok: boolean;
  error?: string;
  baskets: MultiLegBasket[];
  message?: string;
  /** Baskets whose strategy SL/target was disarmed because their legs changed. */
  disarmed: string[];
}

export function regroupBaskets(
  baskets: MultiLegBasket[], req: RegroupRequest, newId: () => string, nowIso: string,
): RegroupResult {
  const fail = (error: string): RegroupResult => ({ ok: false, error, baskets, disarmed: [] });

  // 1. Find the picked legs and where they live.
  const ids = new Set(req.legIds ?? []);
  if (ids.size === 0) return fail('No trades selected');
  const picked = baskets.flatMap(b => b.legs.filter(l => ids.has(l.id)).map(leg => ({ leg, from: b })));
  if (picked.length > ids.size) return fail('A selected trade id appears in more than one row. Fix the ledger file first.');
  if (picked.length < ids.size) return fail('Some selected trades are not saved yet or no longer exist. Reload and try again.');

  // 2. Validate.
  const busy = picked.find(p => p.leg.status === 'PLACING' || p.leg.status === 'CLOSING');
  if (busy) return fail(`${busy.leg.strike} ${busy.leg.option} has an order in flight. Wait for it to settle.`);
  const first = picked[0].from;
  if (picked.some(p => p.from.broker !== first.broker || p.from.underlying !== first.underlying)) {
    return fail('A group must be one broker and one underlying.');
  }
  const target = req.op === 'group' && req.targetBasketId ? baskets.find(b => b.id === req.targetBasketId) : undefined;
  if (req.op === 'group' && req.targetBasketId) {
    if (!target) return fail('Target group not found');
    if (target.broker !== first.broker || target.underlying !== first.underlying) return fail('That group is on a different broker or underlying.');
    if (picked.every(p => p.from.id === target.id)) return fail('Those trades are already in that group.');
  }
  if (req.op === 'group') {
    const result = [...(target?.legs.filter(l => !ids.has(l.id)) ?? []), ...picked.map(p => p.leg)];
    const drafts = result.filter(l => l.status === 'DRAFT').length;
    if (drafts > 0 && drafts < result.length) return fail('Draft (unplaced) legs can only be grouped with other draft legs.');
  }

  // 3. Apply.
  const disarmed: string[] = [];
  const changed = (b: MultiLegBasket, legs: MultiLegLeg[], extra: Partial<MultiLegBasket> = {}): MultiLegBasket => {
    if (b.riskConfig?.armed) disarmed.push(b.id);
    return {
      ...b, ...extra, legs, rev: (b.rev ?? 0) + 1, updatedAt: nowIso,
      ...(b.riskConfig?.armed ? { riskConfig: { ...b.riskConfig, armed: false } } : {}),
    };
  };
  const newBasket = (legs: MultiLegLeg[], name?: string, multiplier?: number, autoLegRule?: MultiLegBasket['autoLegRule']): MultiLegBasket => {
    const expiries = legs.map(l => l.expiry || first.expiry).sort();
    const far = expiries.find(e => e !== expiries[0]);
    return {
      id: newId(),
      ...(name ? { groupName: name } : {}),
      underlying: first.underlying,
      expiry: expiries[0] || first.expiry,
      ...(far ? { farExpiry: far } : {}),
      broker: first.broker,
      ...(multiplier && multiplier > 1 ? { multiplier } : {}),
      legs,
      riskConfig: { targetUnit: 'pts', slUnit: 'pts', armed: false },
      // The default SL/target rule stays on until the user unticks it, so a leg moved out keeps it.
      ...(autoLegRule ? { autoLegRule } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
      rev: 1,
    };
  };

  let next: MultiLegBasket[];
  let message: string;
  if (req.op === 'ungroup') {
    // Alone in its basket: drop the name in place. Otherwise move the leg out to its own basket.
    const alone = new Set(picked.filter(p => p.from.legs.length === 1).map(p => p.leg.id));
    const moving = picked.filter(p => !alone.has(p.leg.id));
    next = baskets.map(b => {
      if (b.legs.length === 1 && alone.has(b.legs[0].id)) {
        return { ...b, groupName: '', rev: (b.rev ?? 0) + 1, updatedAt: nowIso };
      }
      return b.legs.some(l => ids.has(l.id)) ? changed(b, b.legs.filter(l => !ids.has(l.id))) : b;
    });
    next.push(...moving.map(p => newBasket([p.leg], undefined, undefined, p.from.autoLegRule)));
    message = `Ungrouped ${picked.length} trade(s)`;
  } else {
    const legs = picked.map(p => p.leg);
    next = baskets.map(b => (b.legs.some(l => ids.has(l.id)) ? changed(b, b.legs.filter(l => !ids.has(l.id))) : b));
    if (target) {
      next = next.map(b => (b.id === target.id ? changed(b, [...b.legs, ...legs]) : b));
      message = `Moved ${legs.length} trade(s) into ${target.groupName || target.name || 'the group'}`;
    } else {
      const name = req.name?.trim().slice(0, 40) || undefined;
      // A group made from one row keeps that row's lot multiplier (Scale reads it).
      const oneSource = new Set(picked.map(p => p.from.id)).size === 1;
      next.push(newBasket(legs, name, oneSource ? first.multiplier : undefined, oneSource ? first.autoLegRule : undefined));
      message = `Grouped ${legs.length} trade(s)${name ? ` as "${name}"` : ''}`;
    }
  }

  // A basket the move emptied has nothing left to track.
  const emptied = new Set(next.filter(b => b.legs.length === 0 && baskets.some(o => o.id === b.id && o.legs.length > 0)).map(b => b.id));
  return {
    ok: true,
    baskets: next.filter(b => !emptied.has(b.id)),
    message,
    disarmed: [...new Set(disarmed)].filter(id => !emptied.has(id)),
  };
}
