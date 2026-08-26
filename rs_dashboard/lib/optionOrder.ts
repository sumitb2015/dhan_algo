// Places a brand-new MARKET option order (as opposed to lib/legClose.ts, which
// reduces an existing one). No productType is sent — the Dhan fast-order route
// and the non-Dhan order routes both default a missing product to INTRADAY,
// same as components/Scalper.tsx's placeOrder(), which this mirrors.

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
