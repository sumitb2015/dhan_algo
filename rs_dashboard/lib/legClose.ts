// Close/reduce a payoff-engine leg (lib/positionLegs.ts) via a real broker order.
//
// Mirrors components/Scalper.tsx's closePosition(): re-fetch live positions
// (a PositionLeg can be a poll cycle stale), match by (symbol, product) via
// lib/positionProduct.ts, and book the close under the SAME product — never
// omit it, since every order route defaults a missing product to intraday,
// which opens a fresh position on the other side of a MARGIN/NRML leg instead
// of reducing it. See the dhan-broker-positions skill for the full rationale.

import type { Broker } from '@/hooks/useBrokerSelector';
import { scalperRoute } from '@/hooks/useBrokerSelector';
import { positionProduct, findLivePosition, closeOrderProduct } from './positionProduct';
import { fractionUnits } from './partialQty';
import type { PositionLeg } from './positionLegs';

export interface CloseLegResult {
  ok: boolean;
  error?: string;
  orderId?: string;
  /** Absolute units actually sent, so the caller can report what was closed. */
  units: number;
}

/**
 * Close `fraction` of one leg's open quantity (1 = full exit) at market.
 *
 * Fetches the broker's live positions first rather than trusting the leg's
 * (possibly stale) `display.netQty` — the same safeguard closePosition() uses
 * — so an order never sizes off a quantity the book has already moved past.
 */
export async function closeLeg(
  broker: Broker,
  leg: PositionLeg,
  lotSize: number,
  fraction: number,
): Promise<CloseLegResult> {
  const sym = leg.display.tradingSymbol;
  const declaredProduct = leg.display.productType;

  try {
    const posRes = await fetch(scalperRoute(broker, 'positions'));
    const posJson = await posRes.json() as { success: boolean; data?: Record<string, unknown>[] };
    if (!posJson.success || !posJson.data) {
      return { ok: false, error: 'Could not fetch live positions to size the close', units: 0 };
    }

    const found = findLivePosition(posJson.data, { tradingSymbol: sym, productType: declaredProduct });
    if (found.kind === 'ambiguous') {
      return { ok: false, error: `${found.count} rows share this symbol with no product — close it from the broker terminal`, units: 0 };
    }
    if (found.kind === 'flat') {
      return { ok: true, units: 0, error: 'Already flat' };
    }

    const row = found.row;
    const liveNetQty = Number(row.netQty);
    if (liveNetQty === 0) return { ok: true, units: 0, error: 'Already flat' };

    const product = positionProduct(row);
    const productPayload = closeOrderProduct(broker, product);
    if (!productPayload) {
      return { ok: false, error: `Unsupported product "${product}" — square this leg off at the broker`, units: 0 };
    }

    const units = fractionUnits(liveNetQty, lotSize, fraction);
    if (units <= 0) {
      return { ok: false, error: 'Fraction rounds down to under one lot', units: 0 };
    }

    const side = liveNetQty > 0 ? 'SELL' : 'BUY';
    const securityId = String(row.securityId ?? row.security_id ?? leg.securityId ?? '');
    const exchange = String(row.exchangeSegment ?? row.exchange ?? '');

    const orderUrl = broker === 'dhan' ? '/api/scalper/fast-order' : scalperRoute(broker, 'order');
    const body = broker === 'dhan'
      ? { securityId, quantity: units, side, orderType: 'MARKET', exchangeSegment: exchange || 'NSE_FNO', ...productPayload.fields }
      : { tradingsymbol: sym, quantity: units, side, orderType: 'MARKET', exchange: exchange || 'nse_fo', ...productPayload.fields };

    const res = await fetch(orderUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json() as { success: boolean; order_id?: string; error?: string };
    if (!j.success) return { ok: false, error: j.error ?? 'Order rejected', units: 0 };
    return { ok: true, orderId: j.order_id, units };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err), units: 0 };
  }
}
