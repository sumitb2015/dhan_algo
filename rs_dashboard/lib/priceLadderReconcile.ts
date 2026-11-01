import type { LadderBroker, LadderContract, LadderProduct, LadderState } from './priceLadder.ts';

// Which broker book rows the down-only reconcile must leave alone this pass. Pure; lib/priceLadderServer.ts does the IO.
//
// The reconcile compares what the ladder holds on a row (open slices, pair and basket legs) with the broker's net. An
// ENTRY still on the wire on that row (placing, working, UNKNOWN) can fill at any moment, and when it is on the opposite
// side the broker nets it at once: the row shrinks before the order's own settle has booked it. A reconcile in that gap
// cut the open slice as "closed outside the ladder", and the settle then found nothing left to net against and opened the
// fill as a new position the broker did not have (one exit of it inside the fill grace would open a real one). A partly
// filled resting close did the same deterministically. So a row with an entry in flight is skipped until it settles.

/** The broker book key of a contract + product (Dhan: security id | MARGIN/INTRADAY; others: trading symbol | product). */
export type RowKeyOf = (broker: LadderBroker, contract: LadderContract, product: LadderProduct) => string;

/** `${broker}|${rowKey}` of every REAL row with an entry order that may still fill. */
export function rowsWithEntryInFlight(s: LadderState, keyOf: RowKeyOf): Set<string> {
  const out = new Set<string>();
  const add = (broker: LadderBroker, c: LadderContract | undefined, product: LadderProduct) => { if (c) out.add(`${broker}|${keyOf(broker, c, product)}`); };
  for (const x of s.slices) {
    if (x.mode === 'real' && (x.state === 'placing' || x.state === 'working' || x.state === 'unknown')) add(x.broker, x.contract, x.product);
  }
  for (const p of s.pairs ?? []) {
    if (p.mode !== 'real') continue;
    for (const k of ['ce', 'pe'] as const) {
      const l = p.legs[k];
      if (l.entry === 'sent' || l.entry === 'unknown' || (p.state === 'placing' && !l.entry)) add(p.broker, l.contract, p.product);
    }
    // A roll's new strikes are entries too.
    if (p.state === 'rolling') { add(p.broker, p.rollTo?.ce, p.product); add(p.broker, p.rollTo?.pe, p.product); }
  }
  for (const b of s.baskets ?? []) {
    if (b.mode !== 'real') continue;
    for (const l of b.legs) {
      if (l.entry === 'sent' || l.entry === 'unknown' || (b.state === 'placing' && !l.entry)) add(b.broker, l.contract, b.product);
    }
  }
  return out;
}
