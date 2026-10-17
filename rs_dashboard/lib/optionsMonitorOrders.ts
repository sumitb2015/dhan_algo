/**
 * Options Monitor: what a leg's own order placed, and how its Exit is sized. Pure (tested); the page owns the fetches.
 *
 * The page's legs are a strategy model; `isEntered` alone says nothing about the broker. A leg the order ticket
 * actually placed carries a LegOrder: the account, the quantity THIS page placed, its product and the contract's
 * identifier on that broker. Exit closes min(that quantity, what the broker still shows in the leg's direction) on the
 * same product — never the leg's lot count (it could over-close a shared contract or flip it), never another account.
 */
import { normProduct, rowIdent, type BrokerPositionRow } from './liveChartsLedger.ts';

export type OrderBroker = 'dhan' | 'kotak';

export interface LegOrder {
  broker: OrderBroker;
  /** Units this page placed on this leg and has not exited (already lot-multiplied). */
  qty: number;
  productType: 'INTRADAY' | 'MARGIN';
  /** Dhan's security id or Kotak's trading symbol — see rowIdent. */
  ident: string;
  /** Order segment / exchange for that broker (NSE_FNO … / nse_fo …). */
  exchange: string;
  /** When the last order on this leg went out: a flat book within the grace is lag, not a close. */
  at: number;
}

/** A broker's position book can lag a fresh fill by seconds (Kotak / Zerodha have no fill socket). */
export const EXIT_FLAT_GRACE_MS = 20_000;

interface PlacedLeg {
  strike: number; optionType: 'CE' | 'PE'; action: 'BUY' | 'SELL'; qty: number;
  productType: 'INTRADAY' | 'MARGIN'; securityId: string; tradingSymbol?: string; exchangeSegment: string;
}
interface LegLike {
  strike: number; type: 'CE' | 'PE'; side: 'BUY' | 'SELL'; underlying?: string; expiry?: string;
  isEntered?: boolean; order?: LegOrder;
}

/**
 * Stamp the legs the ticket placed (by contract: strike, type, side, and the basket's underlying / expiry). A leg
 * already holding an order on the same broker and product grows by the new quantity (an add); otherwise it gets a
 * fresh record. Legs the ticket did not place are left exactly as they are.
 */
export function stampPlacedLegs<T extends LegLike>(
  legs: T[], placed: PlacedLeg[], broker: OrderBroker,
  basket: { underlying: string; expiry: string }, pageDefaults: { underlying: string; expiry: string }, now: number,
): T[] {
  return legs.map((l) => {
    if ((l.underlying ?? pageDefaults.underlying) !== basket.underlying || (l.expiry ?? pageDefaults.expiry) !== basket.expiry) return l;
    const p = placed.find((x) => x.strike === l.strike && x.optionType === l.type && x.action === l.side);
    if (!p) return l;
    const ident = broker === 'kotak' ? String(p.tradingSymbol ?? '') : String(p.securityId ?? '');
    const prev = l.order;
    const same = prev && prev.broker === broker && prev.productType === p.productType && prev.ident === ident;
    return {
      ...l,
      isEntered: true,
      order: { broker, qty: (same ? prev!.qty : 0) + p.qty, productType: p.productType, ident, exchange: p.exchangeSegment, at: now },
    };
  });
}

export type ExitPlan =
  | { kind: 'send'; qty: number; side: 'BUY' | 'SELL' }
  /** The broker shows nothing of this leg. `lag` = within EXIT_FLAT_GRACE_MS of its order: try again, do not clear. */
  | { kind: 'flat'; lag: boolean }
  /** The broker's position on this contract is on the other side: nothing of this leg survives; never send. */
  | { kind: 'opposite' };

export function exitPlan(order: LegOrder, legSide: 'BUY' | 'SELL', rows: BrokerPositionRow[], now: number): ExitPlan {
  const row = rows.find((r) => rowIdent(r, order.broker) === order.ident && normProduct(r.productType ?? r.product) === order.productType);
  const net = Number(row?.netQty ?? 0);
  if (!Number.isFinite(net) || net === 0) return { kind: 'flat', lag: now - order.at < EXIT_FLAT_GRACE_MS };
  const legShort = legSide === 'SELL';
  if ((net < 0) !== legShort) return { kind: 'opposite' };
  return { kind: 'send', qty: Math.min(order.qty, Math.abs(net)), side: legShort ? 'BUY' : 'SELL' };
}

/** The leg after `sent` units of its exit went through: the remainder stays tracked; fully closed = not entered. */
export function afterExit<T extends LegLike>(leg: T, sent: number, now: number): T {
  const o = leg.order;
  if (!o) return leg;
  const left = Math.max(0, o.qty - sent);
  return left > 0 ? { ...leg, order: { ...o, qty: left, at: now } } : { ...leg, order: undefined, isEntered: false };
}

/** One leg's order through /api/options/order: placed, rejected, or UNKNOWN (may be live — never retried). */
export async function sendSingleLegOrder(
  broker: OrderBroker, leg: { ident: string; exchange: string }, qty: number, side: 'BUY' | 'SELL', productType: string,
): Promise<{ kind: 'placed'; orderId: string } | { kind: 'rejected'; error: string } | { kind: 'unknown'; error: string }> {
  let json: { success?: boolean; unknown?: boolean; error?: string; data?: { success?: boolean; orderId?: string; error?: string; unknown?: boolean }[] } | null = null;
  let status: number | null = null;
  try {
    const res = await fetch('/api/options/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        broker,
        legs: [{
          ...(broker === 'kotak' ? { tradingSymbol: leg.ident, exchange: leg.exchange } : { securityId: leg.ident, exchangeSegment: leg.exchange }),
          quantity: qty, side, orderType: 'MARKET',
        }],
        mode: normProduct(productType) === 'MARGIN' ? 'positional' : 'intraday',
      }),
    });
    status = res.status;
    json = await res.json().catch(() => null);
  } catch { /* no reply */ }
  if (!json) {
    return status != null && status < 500
      ? { kind: 'rejected', error: `Order route answered HTTP ${status}` }
      : { kind: 'unknown', error: 'No reply from the order route' };
  }
  const r = json.data?.[0];
  if (json.success && r?.orderId) return { kind: 'placed', orderId: String(r.orderId) };
  if (r?.unknown || json.unknown) return { kind: 'unknown', error: r?.error ?? json.error ?? 'status unknown' };
  return { kind: 'rejected', error: r?.error ?? json.error ?? 'rejected' };
}
