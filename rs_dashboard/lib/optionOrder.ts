// Places a brand-new MARKET option order (as opposed to lib/legClose.ts, which
// reduces an existing one). Unlike Scalper's placeOrder() (which leaves
// productType unset and lets the order routes default to intraday), every
// order from this page is explicitly booked as a positional product —
// this page analyses a standing book, not an intraday scalp, so opening a
// fresh leg here as MIS/INTRADAY would (a) get force-squared-off same day
// and (b) get rejected outright by broker RMS after ~3:20pm, which is
// exactly the bug this fixes.

import { scalperRoute, type Broker } from '@/hooks/useBrokerSelector';

export interface PlaceOptionOrderParams {
  broker: Broker;
  underlying: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  /** Dhan only — the option's numeric security id. */
  dhanSecurityId?: string;
  /** Non-Dhan brokers only — the option's trading symbol. */
  tradingSymbol?: string;
}

export interface PlaceOptionOrderResult {
  ok: boolean;
  orderId?: string;
  error?: string;
}

export async function placeOptionOrder(params: PlaceOptionOrderParams): Promise<PlaceOptionOrderResult> {
  const { broker, underlying, side, quantity } = params;
  try {
    let res: Response;
    if (broker === 'dhan') {
      if (!params.dhanSecurityId) return { ok: false, error: 'Missing Dhan security id for this strike' };
      res = await fetch('/api/scalper/fast-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          securityId: params.dhanSecurityId,
          quantity,
          side,
          orderType: 'MARKET',
          exchangeSegment: underlying === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO',
          productType: 'MARGIN',
        }),
      });
    } else {
      if (!params.tradingSymbol) return { ok: false, error: `Missing ${broker} trading symbol for this strike` };
      res = await fetch(scalperRoute(broker, 'order'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tradingsymbol: params.tradingSymbol,
          quantity,
          side,
          orderType: 'MARKET',
          exchange: broker === 'kotak'
            ? (underlying === 'SENSEX' ? 'bse_fo' : 'nse_fo')
            : (underlying === 'SENSEX' ? 'BFO' : 'NFO'),
          product: 'NRML',
        }),
      });
    }

    const j = await res.json() as { success: boolean; order_id?: string; error?: string };
    if (!j.success) return { ok: false, error: j.error ?? 'Order rejected' };
    return { ok: true, orderId: j.order_id };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}
