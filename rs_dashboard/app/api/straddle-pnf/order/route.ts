import { NextRequest, NextResponse } from 'next/server';
import { placeDhanOrder } from '@/lib/dhanPlaceOrder';
import { placeKotakOrder } from '@/lib/kotakPlaceOrder';
import { buildKotakOrderPayload } from '@/lib/kotakOrderPayload';
import { placeZerodhaOrderSliced } from '@/lib/zerodhaPlaceOrder';
import { slicesFor } from '@/lib/zerodhaContracts';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { brokerPositionRows, brokerSessionOk } from '@/lib/priceLadderServer';
import { CloseGuard } from '@/lib/priceLadderClose';
import { parseTarget, isComplete, targetKey } from '@/lib/pnfTarget';
import { brokerLegs, resolvePnfLegs, type PnfBrokerLeg } from '@/lib/pnfOrderServer';
import {
  MAX_PNF_LOTS, brokerProduct, needsRollback, orderQty, parsePnfOrder, planLegClose, planOwnExit, sendOutcome,
  type LegResult, type PnfAction, type PnfBroker,
} from '@/lib/pnfOrderLogic';

// The Point & Figure trade bar's orders. Real money: the browser names only the chart's target, the side and the lots.
// Contracts, lot sizes and segments are resolved here (lib/pnfOrderServer.ts); a close is sized from the broker's own
// book read now (every non-flat row of the contract, its own product, opposite side), so it can only reduce a position.
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
      label: l.label, side: l.side, segment: l.segment, lot: l.lot, unitsPerLot: l.unitsPerLot,
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

  const gkey = `${broker}|${targetKey(target)}`;
  if (busy.has(gkey)) return bad('An order for this chart is already being sent - wait for it', 409);
  const closing = close || exitOwn !== null;
  if (closing && !closeGuard.tryStart(gkey, Date.now())) return bad('A close for this chart was just sent - wait a few seconds for the broker book to update', 409);
  busy.add(gkey);
  let sent = false;
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
      const plans = onBroker.map(l => ({ leg: l, orders: planLegClose(l.key, rows) }));
      if (plans.every(p => p.orders.length === 0)) return bad(`No open ${NAME[broker]} position on this chart's contract - nothing was sent`);
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
    return NextResponse.json({ success: outcome === 'placed' || outcome === 'flat', mode, broker, outcome, legs: results, message: describe(outcome, results) },
      { status: outcome === 'unknown' ? 504 : 200 });
  } catch (err) {
    console.error('[straddle-pnf] order failed:', err);
    return bad(`${sent ? 'Order status unknown - check Orders/Positions before retrying' : 'Nothing was sent'}: ${(err as Error).message}`, sent ? 504 : 500);
  } finally {
    busy.delete(gkey);
    if (closing) closeGuard.finish(gkey, Date.now(), sent);
  }
}

/** One order, never throwing: a throw after the request may have gone out is UNKNOWN, not a clean failure. */
async function send(broker: PnfBroker, leg: PnfBrokerLeg, side: PnfAction, qty: number, product: string, open: boolean, tag: string): Promise<LegResult> {
  const base = { label: leg.label, side, qty, product };
  try {
    if (broker === 'dhan') {
      const r = await placeDhanOrder({ securityId: leg.key, quantity: qty, side, orderType: 'MARKET', exchangeSegment: leg.exchange, productType: product, source: tag });
      if (r.status === 'placed') return { ...base, status: 'placed', orderId: r.orderId };
      return { ...base, status: r.status === 'unknown' ? 'unknown' : 'rejected', error: r.error };
    }
    if (broker === 'kotak') {
      const built = buildKotakOrderPayload(
        { tradingsymbol: leg.key, quantity: qty, side, exchange: leg.exchange, product, orderType: 'MARKET', source: open && leg.capLot ? tag : undefined },
        { lotSize: leg.capLot, tick: null },
      );
      if ('error' in built) return { ...base, status: 'rejected', error: built.error };
      const r = await placeKotakOrder(built.payload);
      return r.status === 'placed' ? { ...base, status: 'placed', orderId: r.orderId } : { ...base, status: r.status, error: r.error };
    }
    const r = await placeZerodhaOrderSliced({
      tradingsymbol: leg.key, exchange: leg.exchange, transaction_type: side, order_type: 'MARKET', quantity: qty,
      product, validity: 'DAY', market_protection: -1,
    }, leg.segment === 'NSE_EQ' ? [qty] : slicesFor(leg.key, qty));
    return r.status === 'placed' ? { ...base, status: 'placed', orderId: r.orderId } : { ...base, status: r.status, error: r.error };
  } catch (err) {
    return { ...base, status: 'unknown', error: `No clean reply: ${(err as Error).message}` };
  }
}

function describe(outcome: string, results: LegResult[]): string {
  const line = (r: LegResult) => `${r.label} ${r.side} ${r.qty} ${r.product}: ${r.status}${r.error ? ` (${r.error})` : ''}`;
  const head = outcome === 'placed' ? 'Sent'
    : outcome === 'unknown' ? 'Status unknown - check Orders/Positions before retrying'
    : outcome === 'partial' ? 'PARTIAL - a leg is open alone, check Positions'
    : outcome === 'reversed' ? 'Second leg refused - the first leg was reversed, nothing is left open'
    : outcome === 'flat' ? 'Nothing of this position is left at the broker - nothing was sent'
    : 'Not sent';
  return `${head}. ${results.map(line).join('; ')}`;
}
