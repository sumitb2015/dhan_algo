import { NextRequest, NextResponse } from 'next/server';
import { send, type How } from '@/lib/pnfOrderExec';
import { BROKER_NAME, paperReply, placePnfMarket, pnfOrderBusy, type OrderReply } from '@/lib/pnfAutoOrders';
import { slicesFor } from '@/lib/zerodhaContracts';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { dhanDelete, dhanPut } from '@/lib/dhanToken';
import { kotakPost, KOTAK_PATHS, KotakRejectedError } from '@/lib/kotakToken';
import { ownedBrokerOrder } from '@/lib/pnfRestingServer';
import { parseScope, type PnfScope } from '@/lib/pnfScope';
import { kiteDelete } from '@/lib/zerodhaToken';
import { modifyZerodhaLimitOrder } from '@/lib/zerodhaModifyOrder';
import { snapToTick } from '@/lib/pnfResting';
import { brokerSessionOk } from '@/lib/priceLadderServer';
import { parseTarget, isComplete, targetKey } from '@/lib/pnfTarget';
import { brokerLegs, resolvePnfLegs, type PnfBrokerLeg } from '@/lib/pnfOrderServer';
import { brokerProduct, checkRestingPrices, lotCap, orderQty, parsePnfOrder, type PnfBroker } from '@/lib/pnfOrderLogic';

// The Point & Figure trade bar's orders. Real money: the browser names only the chart's target, the side and the lots. MARKET orders
// (and their sizing / close rules) are lib/pnfAutoOrders.ts, shared with the server AUTO engine; the rail's resting orders are here.
// GET tells the trade bar what one lot is and whether the selected broker can trade the chart at all.

const bad = (error: string, status = 400) => NextResponse.json({ success: false, error }, { status });
const busy = pnfOrderBusy;

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
  // Which page's ledgers own this chart's orders (P&F or Renko): the ownership check and the close note read them.
  const scope = parseScope((body as { scope?: unknown } | null)?.scope);
  const out = (r: OrderReply) => NextResponse.json(r.body, { status: r.status });
  if (order.orderType === 'MARKET' && !order.brokerOp) return out(await placePnfMarket(order, scope));

  // ── Resting LIMIT / SL-limit orders from the chart's B / S rail (single leg, at the broker), and their modify / cancel.
  const { broker, mode, target } = order;
  const legs = resolvePnfLegs(target);
  if (typeof legs === 'string') return bad(legs);
  if (mode === 'PAPER') return out(paperReply(order, legs));
  if (!brokerSessionOk(broker)) return bad(`${BROKER_NAME[broker]} session is not logged in - nothing was sent`, 403);
  const onBroker = await brokerLegs(broker, target, legs).catch((e: Error) => `Contract lookup failed: ${e.message}`);
  if (typeof onBroker === 'string') return bad(`${onBroker}. Nothing was sent.`);
  return resting(order, onBroker, scope);
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

