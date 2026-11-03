import { placeDhanOrder } from '@/lib/dhanPlaceOrder';
import { placeKotakOrder } from '@/lib/kotakPlaceOrder';
import { buildKotakOrderPayload } from '@/lib/kotakOrderPayload';
import { placeZerodhaOrderSliced } from '@/lib/zerodhaPlaceOrder';
import { slicesFor } from '@/lib/zerodhaContracts';
import type { PnfBrokerLeg } from '@/lib/pnfOrderServer';
import type { LegResult, PnfAction, PnfBroker } from '@/lib/pnfOrderLogic';

// One broker order of the P&F / Renko trade bar, shared by the order route and the server-side AUTO watcher (lib/autoServerWatcher.ts),
// so a watcher exit is sent exactly as a page exit is: same contract keys, same slicing, same unknown-outcome rule.

export type How = { type: 'MARKET' } | { type: 'LIMIT'; price: number } | { type: 'SL'; price: number; trigger: number };

/** One order, never throwing: a throw after the request may have gone out is UNKNOWN, not a clean failure. */
export async function send(broker: PnfBroker, leg: PnfBrokerLeg, side: PnfAction, qty: number, product: string, open: boolean, tag: string, how: How = { type: 'MARKET' }): Promise<LegResult> {
  const base = { label: leg.label, side, qty, product };
  try {
    if (broker === 'dhan') {
      const r = await placeDhanOrder({
        securityId: leg.key, quantity: qty, side, exchangeSegment: leg.exchange, productType: product, source: tag,
        orderType: how.type === 'MARKET' ? 'MARKET' : how.type === 'LIMIT' ? 'LIMIT' : 'STOP_LOSS',
        ...(how.type !== 'MARKET' ? { price: how.price } : {}), ...(how.type === 'SL' ? { triggerPrice: how.trigger } : {}),
      });
      if (r.status === 'placed') return { ...base, status: 'placed', orderId: r.orderId };
      return { ...base, status: r.status === 'unknown' ? 'unknown' : 'rejected', error: r.error };
    }
    if (broker === 'kotak') {
      const built = buildKotakOrderPayload(
        {
          tradingsymbol: leg.key, quantity: qty, side, exchange: leg.exchange, product, source: open && leg.capLot ? tag : undefined,
          orderType: how.type === 'MARKET' ? 'MARKET' : how.type === 'LIMIT' ? 'LIMIT' : 'SL',
          ...(how.type !== 'MARKET' ? { price: how.price } : {}), ...(how.type === 'SL' ? { triggerPrice: how.trigger } : {}),
        },
        { lotSize: leg.capLot, tick: how.type === 'MARKET' ? null : leg.tick },
      );
      if ('error' in built) return { ...base, status: 'rejected', error: built.error };
      const r = await placeKotakOrder(built.payload);
      return r.status === 'placed' ? { ...base, status: 'placed', orderId: r.orderId } : { ...base, status: r.status, error: r.error };
    }
    const r = await placeZerodhaOrderSliced({
      tradingsymbol: leg.key, exchange: leg.exchange, transaction_type: side, quantity: qty, product, validity: 'DAY',
      ...(how.type === 'MARKET' ? { order_type: 'MARKET', market_protection: -1 }
        : how.type === 'LIMIT' ? { order_type: 'LIMIT', price: how.price } : { order_type: 'SL', price: how.price, trigger_price: how.trigger }),
    }, leg.segment === 'NSE_EQ' ? [qty] : slicesFor(leg.key, qty));
    return r.status === 'placed' ? { ...base, status: 'placed', orderId: r.orderId } : { ...base, status: r.status, error: r.error };
  } catch (err) {
    return { ...base, status: 'unknown', error: `No clean reply: ${(err as Error).message}` };
  }
}

export function describe(outcome: string, results: LegResult[]): string {
  const line = (r: LegResult) => `${r.label} ${r.side} ${r.qty} ${r.product}: ${r.status}${r.error ? ` (${r.error})` : ''}`;
  const head = outcome === 'placed' ? 'Sent'
    : outcome === 'unknown' ? 'Status unknown - check Orders/Positions before retrying'
    : outcome === 'partial' ? 'PARTIAL - a leg is open alone, check Positions'
    : outcome === 'reversed' ? 'Second leg refused - the first leg was reversed, nothing is left open'
    : outcome === 'flat' ? 'Nothing of this position is left at the broker - nothing was sent'
    : 'Not sent';
  return `${head}. ${results.map(line).join('; ')}`;
}

