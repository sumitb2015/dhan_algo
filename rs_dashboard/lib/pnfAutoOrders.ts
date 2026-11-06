import { send, describe } from '@/lib/pnfOrderExec';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { openBrokerOrders } from '@/lib/pnfRestingServer';
import type { PnfScope } from '@/lib/pnfScope';
import { exitingAutoProduct, readAutoLedger, reservedByAuto } from '@/lib/pnfAutoServer';
import { brokerPositionRows, brokerSessionOk } from '@/lib/priceLadderServer';
import { CloseGuard } from '@/lib/priceLadderClose';
import { targetKey } from '@/lib/pnfTarget';
import { brokerLegs, resolvePnfLegs, type PnfLeg } from '@/lib/pnfOrderServer';
import {
  MAX_PNF_LOTS, brokerProduct, needsRollback, orderQty, parsePnfOrder, planLegClose, planLegCloseKeeping, planOwnExit, sendOutcome, type AutoProduct,
  type LegResult, type PnfBroker,
} from '@/lib/pnfOrderLogic';

// The Point & Figure / Renko MARKET orders (trade bar, square-off, AUTO entry / add / own exit), shared by the order route and the
// server AUTO engine (lib/pnfAutoEngine.ts), so both size, guard and send in exactly one place. Real money. The caller names only the
// chart's target, the side and the lots (parsePnfOrder); contracts, lot sizes and segments are resolved here (lib/pnfOrderServer.ts).
// A close is sized from the broker's own book read now (every non-flat row of the contract, its own product, opposite side), so it can
// only reduce a position; the other page's (P&F / Renko) live AUTO quantity on the contract is left in place.

export type PnfOrder = Exclude<ReturnType<typeof parsePnfOrder>, string>;
export interface OrderReply { status: number; body: Record<string, unknown> }

export const BROKER_NAME: Record<PnfBroker, string> = { dhan: 'Dhan', kotak: 'Kotak', zerodha: 'Zerodha' };
const bad = (error: string, status = 400): OrderReply => ({ status, body: { success: false, error } });
const reply = (body: Record<string, unknown>, init?: { status: number }): OrderReply => ({ status: init?.status ?? 200, body });
type G = { __pnfOrderGuard?: CloseGuard; __pnfOrderBusy?: Set<string> };
/** On globalThis: the order route, the server guard (lib/autoServerWatcher.ts) and the AUTO engine share one guard and one busy set. */
export const pnfCloseGuard: CloseGuard = ((globalThis as G).__pnfOrderGuard ??= new CloseGuard());
/** One order per broker + chart at a time: a second order while the first is on the wire is refused, not queued. */
export const pnfOrderBusy: Set<string> = ((globalThis as G).__pnfOrderBusy ??= new Set());

/** PAPER: nothing is sent (the caller's ledger books it), sized with Dhan's master lot. */
export function paperReply(order: PnfOrder, legs: PnfLeg[]): OrderReply {
  if (order.close) return bad('A paper close is sized by the trade bar ledger - send the lots to reverse');
  if (order.lots < 1) return bad('A paper order needs lots');
  return reply({
    success: true, mode: order.mode, outcome: 'placed',
    legs: legs.map(l => ({ label: l.label, side: order.action, qty: order.lots * l.lot, product: order.product, status: 'placed' })),
  });
}

/** A MARKET order (not a resting one: the route handles those). `scope`: whose ledgers (P&F or Renko) the close keeps out. */
export async function placePnfMarket(order: PnfOrder, scope: PnfScope): Promise<OrderReply> {
  const { broker, mode, target, close, exitOwn } = order;
  const tag = order.source === 'auto' ? 'pnfa' : 'pnf';
  if (order.orderType !== 'MARKET' || order.brokerOp) return bad('Not a MARKET order');
  const legs = resolvePnfLegs(target);
  if (typeof legs === 'string') return bad(legs);
  if (mode === 'PAPER') return paperReply(order, legs);
  if (!brokerSessionOk(broker)) return bad(`${BROKER_NAME[broker]} session is not logged in - nothing was sent`, 403);
  const onBroker = await brokerLegs(broker, target, legs).catch((e: Error) => `Contract lookup failed: ${e.message}`);
  if (typeof onBroker === 'string') return bad(`${onBroker}. Nothing was sent.`);
  const busy = pnfOrderBusy, closeGuard = pnfCloseGuard;
  const gkey = `${broker}|${targetKey(target)}`;
  if (busy.has(gkey)) return bad('An order for this chart is already being sent - wait for it', 409);
  const closing = close || exitOwn !== null;
  if (closing && !closeGuard.tryStart(gkey, Date.now())) return bad('A close for this chart was just sent - wait a few seconds for the broker book to update', 409);
  busy.add(gkey);
  let sent = false;
  let keptNote = '';
  try {
    const results: LegResult[] = [];
    if (exitOwn) {
      // AUTO's exit: only what AUTO opened (the ledger's units), capped by the broker's intraday row in that direction.
      if (exitOwn.units.length !== onBroker.length) return bad('exitOwn.units must name every leg of this chart - nothing was sent');
      const rows = await brokerPositionRows(broker);
      if (!rows) return bad(`Could not read the ${BROKER_NAME[broker]} positions - nothing was sent`, 502);
      // AUTO: the product of the row being exited comes from the ledger (a tab on an older bundle sends none and would exit NRML as MIS)
      const own = (order.source === 'auto' ? exitingAutoProduct(readAutoLedger(scope), broker, targetKey(target), exitOwn.side) : null) ?? exitOwn.product;
      const plans = onBroker.map((l, i) => ({ leg: l, ...planOwnExit(l.key, rows, exitOwn.side, exitOwn.units[i], broker, own) }));
      sent = plans.some(p => p.qty > 0);
      for (const p of plans) {
        results.push(p.qty > 0 ? await send(broker, p.leg, exitOwn.side, p.qty, p.product, false, tag)
          : { label: p.leg.label, side: exitOwn.side, qty: 0, product: p.product, status: 'flat' });
      }
    } else if (close) {
      const rows = await brokerPositionRows(broker);
      if (!rows) return bad(`Could not read the ${BROKER_NAME[broker]} positions - nothing was sent`, 502);
      if (onBroker.every(l => planLegClose(l.key, rows).length === 0)) return bad(`No open ${BROKER_NAME[broker]} position on this chart's contract - nothing was sent`);
      // The OTHER page's live AUTO rows on this contract keep their quantity: P&F and Renko share the broker's netted position,
      // and a square-off (or an MTM guard exit) on one page must not take the other page's AUTO position with it.
      const other = scope === 'renko' ? 'pnf' : 'renko';
      const otherName = other === 'renko' ? 'Renko' : 'Point & Figure';
      // Per product: MIS AUTO rows are kept out of the broker's MIS row, NRML AUTO rows out of its NRML row.
      const otherLed = readAutoLedger(other), ownLed = readAutoLedger(scope);
      const keep = (p: AutoProduct) => {
        const fromOther = reservedByAuto(otherLed, broker, targetKey(target), onBroker.length, undefined, p);
        // Chart N's MTM guard: this page's OTHER chart's AUTO on the same contract is kept too (each chart guards its own trade).
        const fromSibling = order.guardChart ? reservedByAuto(ownLed, broker, targetKey(target), onBroker.length, order.guardChart, p) : onBroker.map(() => 0);
        return { fromOther, fromSibling, reserved: fromOther.map((r, i) => r + fromSibling[i]) };
      };
      const mis = keep('INTRADAY'), nrml = keep('MARGIN');
      const sibling = order.guardChart ? (order.guardChart === 1 ? 2 : 1) : null;
      const plans = onBroker.map((l, i) => ({ leg: l, orders: planLegCloseKeeping(l.key, rows, mis.reserved[i], broker, nrml.reserved[i]) }));
      // What was actually held back per leg: the full close minus the planned one (a reservation against the book row's direction keeps nothing)
      const sumQty = (os: { qty: number }[]) => os.reduce((n, o) => n + o.qty, 0);
      const kept = plans.map(p => sumQty(planLegClose(p.leg.key, rows)) - sumQty(p.orders));
      const anyKept = kept.some(k => k > 0);
      const fromOther = mis.fromOther.some(r => r !== 0) || nrml.fromOther.some(r => r !== 0);
      const fromSibling = mis.fromSibling.some(r => r !== 0) || nrml.fromSibling.some(r => r !== 0);
      const whose = anyKept ? [fromOther ? `the ${otherName} page's AUTO` : '', fromSibling ? `chart ${sibling}'s AUTO` : ''].filter(Boolean).join(' and ') : '';
      if (whose) keptNote = ` KEPT: ${kept.join(' / ')} units on this contract belong to ${whose} and were not closed.`;
      if (plans.every(p => p.orders.length === 0)) {
        return reply({
          success: true, mode, broker, outcome: 'kept', legs: [],
          message: `Nothing of this chart's to close: the open quantity on this contract belongs to ${whose} and is kept`,
        });
      }
      sent = true;
      for (const { leg, orders } of plans) {
        for (const o of orders) results.push(await send(broker, leg, o.side, o.qty, o.product, false, tag));
      }
    } else {
      const product = brokerProduct(order.product, broker);
      // Sized here from the server's own lot, so this only guards a lot lookup gone wrong. Checked for every leg before any is sent.
      if (onBroker.some(l => !(l.lotUnits > 0) || (l.segment !== 'NSE_EQ' && order.lots > MAX_PNF_LOTS))) return bad('Order size check failed - nothing was sent', 500);
      sent = true;
      for (const leg of onBroker) {
        const qty = orderQty(order.lots, leg.lotUnits);
        const r = await send(broker, leg, order.action, qty, product, true, tag);
        results.push(r);
        if (r.status !== 'placed') break;                     // never send PE after CE failed or went unknown
      }
      for (let i = results.length; i < onBroker.length; i++) {
        results.push({ label: onBroker[i].label, side: order.action, qty: orderQty(order.lots, onBroker[i].lotUnits), product, status: 'skipped' });
      }
      if (needsRollback(results.slice(0, 2), false)) {
        const first = results[0];
        const back = await send(broker, onBroker[0], first.side === 'BUY' ? 'SELL' : 'BUY', first.qty, first.product, false, tag);
        results.push({ ...back, label: `${back.label} (reversal)` });
      }
    }
    invalidateBrokerCache(broker);
    const reversal = results.find(r => r.label.endsWith('(reversal)'));
    // CE went in, PE was refused and CE was taken back out: nothing is left open (two fills were paid for).
    const outcome = reversal?.status === 'placed' ? 'reversed' : sendOutcome(results.filter(r => r !== reversal));
    // Both pages' resting broker orders on this contract (P&F and Renko keep separate ledgers but share the broker position):
    // any of them can re-open the position just closed.
    const stillResting = closing ? openBrokerOrders('pnf', broker, targetKey(target)) + openBrokerOrders('renko', broker, targetKey(target)) : 0;
    const note = (stillResting > 0 ? ` NOTE: ${stillResting} resting order(s) still open on this chart - cancel them or they can re-open the position.` : '') + keptNote;
    return reply({ success: outcome === 'placed' || outcome === 'flat', mode, broker, outcome, legs: results, message: describe(outcome, results) + note, stillResting },
      { status: outcome === 'unknown' ? 504 : 200 });
  } catch (err) {
    console.error('[straddle-pnf] order failed:', err);
    return bad(`${sent ? 'Order status unknown - check Orders/Positions before retrying' : 'Nothing was sent'}: ${(err as Error).message}`, sent ? 504 : 500);
  } finally {
    busy.delete(gkey);
    if (closing) closeGuard.finish(gkey, Date.now(), sent);
  }
}
