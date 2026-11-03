import { NextRequest, NextResponse } from 'next/server';
import { send, describe, type How } from '@/lib/pnfOrderExec';
import { slicesFor } from '@/lib/zerodhaContracts';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { dhanDelete, dhanPut } from '@/lib/dhanToken';
import { kotakPost, KOTAK_PATHS, KotakRejectedError } from '@/lib/kotakToken';
import { openBrokerOrders, ownedBrokerOrder } from '@/lib/pnfRestingServer';
import { parseScope, type PnfScope } from '@/lib/pnfScope';
import { readAutoLedger, reservedByAuto } from '@/lib/pnfAutoServer';
import { kiteDelete } from '@/lib/zerodhaToken';
import { modifyZerodhaLimitOrder } from '@/lib/zerodhaModifyOrder';
import { snapToTick } from '@/lib/pnfResting';
import { brokerPositionRows, brokerSessionOk } from '@/lib/priceLadderServer';
import { CloseGuard } from '@/lib/priceLadderClose';
import { parseTarget, isComplete, targetKey } from '@/lib/pnfTarget';
import { brokerLegs, resolvePnfLegs, type PnfBrokerLeg } from '@/lib/pnfOrderServer';
import {
  MAX_PNF_LOTS, brokerProduct, checkRestingPrices, lotCap, needsRollback, orderQty, parsePnfOrder, planLegClose, planLegCloseKeeping, planOwnExit, sendOutcome, mcxUnconfirmedCapError,
  type LegResult, type PnfBroker,
} from '@/lib/pnfOrderLogic';

// The Point & Figure trade bar's orders. Real money: the browser names only the chart's target, the side and the lots.
// Contracts, lot sizes and segments are resolved here (lib/pnfOrderServer.ts); a close is sized from the broker's own
// book read now (every non-flat row of the contract, its own product, opposite side), so it can only reduce a position; the other
// page's (P&F / Renko) live AUTO quantity on the contract is left in place.
// GET tells the trade bar what one lot is and whether the selected broker can trade the chart at all.

const NAME: Record<PnfBroker, string> = { dhan: 'Dhan', kotak: 'Kotak', zerodha: 'Zerodha' };
const bad = (error: string, status = 400) => NextResponse.json({ success: false, error }, { status });
type G = { __pnfOrderGuard?: CloseGuard; __pnfOrderBusy?: Set<string> };
const closeGuard: CloseGuard = ((globalThis as G).__pnfOrderGuard ??= new CloseGuard());
/** One order per broker + chart at a time: a second click while the first is on the wire is refused, not queued. */
const busy: Set<string> = ((globalThis as G).__pnfOrderBusy ??= new Set());

export async function GET(req: NextRequest): Promise<NextResponse> {
  const p = req.nextUrl.searchParams;
  const broker = p.get('broker');
  if (broker !== 'dhan' && broker !== 'kotak' && broker !== 'zerodha') return bad('broker must be dhan, kotak or zerodha');
  let raw: unknown = null;
  try { raw = JSON.parse(p.get('target') ?? 'null'); } catch { /* invalid */ }
  const target = parseTarget(raw);
  if (!target || !isComplete(target)) return bad('A complete chart target is required');
  if (target.kind === 'index') return NextResponse.json({ success: true, legs: [], unsupported: 'An index cannot be traded directly' });
  const legs = resolvePnfLegs(target);
  if (typeof legs === 'string') return bad(legs);
  const onBroker = await brokerLegs(broker, target, legs).catch((e: Error) => `Contract lookup failed: ${e.message}`);
  return NextResponse.json({
    success: true,
    legs: legs.map((l, i) => ({
      label: l.label, side: l.side, segment: l.segment, lot: l.lot, unitsPerLot: l.unitsPerLot, tick: l.tick,
      key: typeof onBroker === 'string' ? null : onBroker[i].key,
      lotUnits: typeof onBroker === 'string' ? null : onBroker[i].lotUnits,
    })),
    unsupported: typeof onBroker === 'string' ? onBroker : null,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try { body = await req.json(); } catch { return bad('Invalid JSON'); }
  const order = parsePnfOrder(body);
  if (typeof order === 'string') return bad(order);
  // Which page's resting-orders ledger owns this chart's broker orders (P&F or Renko): the ownership check and the close note read it.
  const scope = parseScope((body as { scope?: unknown } | null)?.scope);
  const { broker, mode, target, close, exitOwn } = order;
  const tag = order.source === 'auto' ? 'pnfa' : 'pnf';
  const legs = resolvePnfLegs(target);
  if (typeof legs === 'string') return bad(legs);

  // ── PAPER: nothing is sent; the trade bar keeps its own ledger. Sized with Dhan's master lot.
  if (mode === 'PAPER') {
    if (close) return bad('A paper close is sized by the trade bar ledger - send the lots to reverse');
    if (order.lots < 1) return bad('A paper order needs lots');
    return NextResponse.json({
      success: true, mode, outcome: 'placed',
      legs: legs.map(l => ({ label: l.label, side: order.action, qty: order.lots * l.lot, product: order.product, status: 'placed' })),
    });
  }

  if (!brokerSessionOk(broker)) return bad(`${NAME[broker]} session is not logged in - nothing was sent`, 403);
  const onBroker = await brokerLegs(broker, target, legs).catch((e: Error) => `Contract lookup failed: ${e.message}`);
  if (typeof onBroker === 'string') return bad(`${onBroker}. Nothing was sent.`);

  // ── Resting LIMIT / SL-limit orders from the chart's B / S rail (single leg, at the broker), and their modify / cancel.
  if (order.orderType !== 'MARKET' || order.brokerOp) return resting(order, onBroker, scope);

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
      if (!rows) return bad(`Could not read the ${NAME[broker]} positions - nothing was sent`, 502);
      const plans = onBroker.map((l, i) => ({ leg: l, ...planOwnExit(l.key, rows, exitOwn.side, exitOwn.units[i], broker) }));
      sent = plans.some(p => p.qty > 0);
      for (const p of plans) {
        results.push(p.qty > 0 ? await send(broker, p.leg, exitOwn.side, p.qty, p.product, false, tag)
          : { label: p.leg.label, side: exitOwn.side, qty: 0, product: p.product, status: 'flat' });
      }
    } else if (close) {
      const rows = await brokerPositionRows(broker);
      if (!rows) return bad(`Could not read the ${NAME[broker]} positions - nothing was sent`, 502);
      if (onBroker.every(l => planLegClose(l.key, rows).length === 0)) return bad(`No open ${NAME[broker]} position on this chart's contract - nothing was sent`);
      // The OTHER page's live AUTO rows on this contract keep their quantity: P&F and Renko share the broker's netted position,
      // and a square-off (or an MTM guard exit) on one page must not take the other page's AUTO position with it.
      const other = scope === 'renko' ? 'pnf' : 'renko';
      const reserved = reservedByAuto(readAutoLedger(other), broker, targetKey(target), onBroker.length);
      const plans = onBroker.map((l, i) => ({ leg: l, orders: planLegCloseKeeping(l.key, rows, reserved[i], broker) }));
      if (reserved.some(r => r !== 0)) keptNote = ` KEPT: ${reserved.map(Math.abs).join(' / ')} units on this contract belong to the ${other === 'renko' ? 'Renko' : 'Point & Figure'} page's AUTO and were not closed.`;
      if (plans.every(p => p.orders.length === 0)) {
        return NextResponse.json({
          success: true, mode, broker, outcome: 'kept', legs: [],
          message: `Nothing of this page's to close: the open quantity on this contract belongs to the ${other === 'renko' ? 'Renko' : 'Point & Figure'} page's AUTO and is kept`,
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
      const capped = mcxUnconfirmedCapError(broker, onBroker.some(l => l.segment === 'MCX_COMM'), order.lots);
      if (capped) return bad(`${capped} - nothing was sent`);
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
    return NextResponse.json({ success: outcome === 'placed' || outcome === 'flat', mode, broker, outcome, legs: results, message: describe(outcome, results) + note, stillResting },
      { status: outcome === 'unknown' ? 504 : 200 });
  } catch (err) {
    console.error('[straddle-pnf] order failed:', err);
    return bad(`${sent ? 'Order status unknown - check Orders/Positions before retrying' : 'Nothing was sent'}: ${(err as Error).message}`, sent ? 504 : 500);
  } finally {
    busy.delete(gkey);
    if (closing) closeGuard.finish(gkey, Date.now(), sent);
  }
}


/**
 * A resting order: placed at the broker on a single-leg chart (a straddle's level is held by the page and sent at MARKET),
 * or a modify / cancel of one this page placed. Prices are snapped to the contract tick, re-checked, and refused outside the
 * side rules (no distance limit: an order may rest anywhere; the broker's own price band still applies).
 */
async function resting(order: Exclude<ReturnType<typeof parsePnfOrder>, string>, legs: PnfBrokerLeg[], scope: PnfScope): Promise<NextResponse> {
  const { broker } = order;
  if (legs.length !== 1) return bad('A resting order goes on a single-leg chart: a straddle level is held by the page and sent at MARKET');
  const leg = legs[0];
  const gkey = `${broker}|${targetKey(order.target)}`;      // the MARKET orders' key too: a rail order and a close never overlap
  if (busy.has(gkey)) return bad('An order for this chart is already being sent - wait for it', 409);
  busy.add(gkey);
  try {
    const qty = orderQty(order.lots, leg.lotUnits);
    // Only an order this page placed for this chart, still working in its ledger: never an id the request merely names.
    if (order.brokerOp && !ownedBrokerOrder(scope, broker, targetKey(order.target), order.brokerOp.orderId)) {
      return bad('That order is not a working resting order of this chart - nothing was changed', 403);
    }
    if (order.brokerOp?.op === 'cancel') return cancelAt(broker, order.brokerOp.orderId);
    if (order.orderType === 'MARKET' || !(order.price && order.price > 0)) return bad('A resting order needs LIMIT / SL prices');
    if (!(order.lots >= 1 && order.lots <= lotCap(order.target)) || !(leg.lotUnits > 0)) return bad('Order size check failed - nothing was sent');
    const capped = mcxUnconfirmedCapError(broker, leg.segment === 'MCX_COMM', order.lots);
    if (capped) return bad(`${capped} - nothing was sent`);
    // One resting order per rail click: an order Kite would cut at the freeze quantity is refused, never sliced.
    if (broker === 'zerodha' && leg.segment !== 'NSE_EQ' && slicesFor(leg.key, qty).length > 1) return bad(`${qty} is above the exchange freeze quantity for one resting order - use fewer lots`);
    const tick = leg.tick && leg.tick > 0 ? leg.tick : 0.05;
    const price = snapToTick(order.price, tick, 'nearest');
    const trigger = order.trigger ? snapToTick(order.trigger, tick, 'nearest') : undefined;
    const checked = checkRestingPrices(order.action, order.orderType, price, trigger);
    if (typeof checked === 'string') return bad(`${checked} (after snapping to the ${tick} tick)`);
    const how: How = order.orderType === 'LIMIT' ? { type: 'LIMIT', price } : { type: 'SL', price, trigger: trigger! };
    if (order.brokerOp?.op === 'modify') return modifyAt(broker, order.brokerOp.orderId, qty, how);
    const r = await send(broker, leg, order.action, qty, brokerProduct(order.product, broker), true, order.source === 'auto' ? 'pnfa' : 'pnf', how);
    invalidateBrokerCache(broker);
    return NextResponse.json({
      success: r.status === 'placed', outcome: r.status, orderId: r.orderId, price, trigger, legs: [r],
      message: r.status === 'placed' ? `${order.action} ${order.orderType === 'LIMIT' ? 'LIMIT' : 'SL-limit'} ${qty} @ ${trigger ? `${trigger} → ` : ''}${price} placed` : r.error,
    }, { status: r.status === 'unknown' ? 504 : 200 });
  } finally {
    busy.delete(gkey);
  }
}

/** Modify a resting order. A throw after the request may have gone out is UNKNOWN (the order book tells the truth). */
async function modifyAt(broker: PnfBroker, orderId: string, qty: number, how: Exclude<How, { type: 'MARKET' }>): Promise<NextResponse> {
  const trigger = how.type === 'SL' ? how.trigger : 0;
  let applied = how.price;
  try {
    if (broker === 'dhan') {
      await dhanPut(`/orders/${orderId}`, {
        orderId, orderType: how.type === 'SL' ? 'STOP_LOSS' : 'LIMIT', legName: 'ENTRY_LEG', quantity: qty,
        price: Number(how.price.toFixed(2)), disclosedQuantity: 0, triggerPrice: trigger, validity: 'DAY',
      });
    } else if (broker === 'kotak') {
      await kotakPost(KOTAK_PATHS.modifyOrder, {
        no: orderId, pr: how.price.toFixed(2), pt: how.type === 'SL' ? 'SL' : 'L', qt: String(qty), vd: 'DAY', tp: String(trigger),
        dq: '0', mp: '0', am: 'NO', os: 'NEOTRADEAPI',
      });
    } else {
      // Kite's limit-modify helper only: an SL-limit is cancelled and placed again from the page.
      if (how.type === 'SL') return bad('Zerodha SL-limit orders cannot be moved here - cancel it and place a new one');
      const r = await modifyZerodhaLimitOrder({ orderId, price: how.price, quantity: qty });
      if (!r.ok) return NextResponse.json({ success: false, outcome: 'rejected', error: r.error }, { status: 200 });
      applied = r.price;                                      // the price Kite holds after snapping to the contract's own tick
    }
    invalidateBrokerCache(broker);
    return NextResponse.json({ success: true, outcome: 'placed', price: applied, trigger: how.type === 'SL' ? how.trigger : undefined });
  } catch (e) {
    if (e instanceof KotakRejectedError) return NextResponse.json({ success: false, outcome: 'rejected', error: `Kotak refused the modify: ${e.message}` });
    return NextResponse.json({ success: false, outcome: 'unknown', error: `Modify status unknown - check the order book: ${(e as Error).message}` }, { status: 504 });
  }
}

async function cancelAt(broker: PnfBroker, orderId: string): Promise<NextResponse> {
  try {
    if (broker === 'dhan') await dhanDelete(`/orders/${orderId}`);
    else if (broker === 'kotak') await kotakPost(KOTAK_PATHS.cancelOrder, { on: orderId, am: 'NO' });
    else await kiteDelete(`/orders/regular/${encodeURIComponent(orderId)}`);
    invalidateBrokerCache(broker);
    return NextResponse.json({ success: true, outcome: 'placed' });
  } catch (e) {
    if (e instanceof KotakRejectedError) return NextResponse.json({ success: false, outcome: 'rejected', error: `Kotak refused the cancel: ${e.message}` });
    return NextResponse.json({ success: false, outcome: 'unknown', error: `Cancel status unknown - check the order book: ${(e as Error).message}` }, { status: 504 });
  }
}

