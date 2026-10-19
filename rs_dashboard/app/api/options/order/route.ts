import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { placeKotakOrder } from '@/lib/kotakPlaceOrder';
import { buildKotakOrderPayload } from '@/lib/kotakOrderPayload';
import { kotakDerivativeBySymbol } from '@/lib/kotakContracts';
import { kotakUnderlyingOf } from '@/lib/kotakPositionContracts';
import { isKotakTokenValid } from '@/lib/kotakToken';
import { placeZerodhaOrder } from '@/lib/zerodhaPlaceOrder';
import { isZerodhaTokenValid } from '@/lib/zerodhaToken';
import { zerodhaSnapPrice } from '@/lib/zerodhaOrderRules';
import { cachedZerodhaContract, slicesFor } from '@/lib/zerodhaContracts';

// A basket of option legs (Live Options Charts' order modal and trading desk), every leg sent concurrently.
// broker 'dhan' (default): straight to Dhan's order API by securityId. broker 'kotak': by trading symbol through the
// same payload builder and placement as /api/scalper/kotak/order (lib/kotakOrderPayload.ts, lib/kotakPlaceOrder.ts).
// broker 'zerodha': by trading symbol through lib/zerodhaPlaceOrder.ts (placed / rejected / unknown, same as
// /api/scalper/zerodha/order). Kite's API places no resting stop entries, so STOP_LOSS legs are refused for Zerodha.
// Each leg's result says placed / failed / UNKNOWN (`unknown: true`: no clean reply — it may be live; the caller must
// not retry it). Market data never comes from here.

/** One leg's outcome, in leg order. `securityId` (Dhan) or `tradingSymbol` (Kotak, Zerodha) echoes the leg. */
interface LegResult { success: boolean; orderId?: string; securityId?: string; tradingSymbol?: string; error?: string; unknown?: boolean }

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const TOKEN_FILE   = path.join(PROJECT_ROOT, 'access_token.json');
const DHAN_ORDERS  = 'https://api.dhan.co/v2/orders';

interface TokenCache { clientId: string; token: string; ts: number }
let tokenCache: TokenCache | null = null;
const TOKEN_TTL = 5 * 60 * 1000;

function getToken(): { clientId: string; token: string } {
  if (tokenCache && Date.now() - tokenCache.ts < TOKEN_TTL) {
    return { clientId: tokenCache.clientId, token: tokenCache.token };
  }
  
  let envClientId = '';
  const envFile = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf8');
    const match = content.match(/^client_id\s*=\s*["']?([^"'\r\n]+)["']?/m);
    if (match) {
      envClientId = match[1].trim();
    }
  }

  const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as {
    dhanClientId?: string;
    clientId?: string;
    accessToken: string;
  };

  // Prefer .env > process.env > JWT-embedded dhanClientId > file clientId
  // NOTE: access_token.json 'clientId' field may contain a phone number, not the Dhan client ID
  // Always prefer dhanClientId (which is the actual Dhan account ID embedded in the JWT)
  const clientId = envClientId || process.env.client_id || raw.dhanClientId || raw.clientId || '';
  tokenCache = { clientId, token: raw.accessToken, ts: Date.now() };
  return { clientId, token: raw.accessToken };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null) as {
    broker?: 'dhan' | 'kotak' | 'zerodha';
    legs?: {
      securityId?: string;
      /** Kotak / Zerodha: the contract's trading symbol (neither has a Dhan security id). */
      tradingSymbol?: string;
      /** Kotak: nse_fo / bse_fo / mcx_fo. Zerodha: NFO / BFO / MCX. */
      exchange?: string;
      quantity: number;
      side: 'BUY' | 'SELL';
      exchangeSegment?: string;
      orderType?: 'MARKET' | 'LIMIT' | 'STOP_LOSS_MARKET' | 'STOP_LOSS';
      price?: number;        // limit price (for LIMIT and STOP_LOSS orders)
      triggerPrice?: number; // trigger price (for STOP_LOSS_MARKET and STOP_LOSS orders)
    }[];
    mode?: 'intraday' | 'positional';
  } | null;

  if (!body || !body.legs || !Array.isArray(body.legs) || body.legs.length === 0) {
    return NextResponse.json({ success: false, error: 'legs array is required' }, { status: 400 });
  }

  const { legs, mode = 'intraday' } = body;
  const broker = body.broker ?? 'dhan';
  if (broker !== 'dhan' && broker !== 'kotak' && broker !== 'zerodha') {
    return NextResponse.json({ success: false, error: `Unsupported broker: ${broker}` }, { status: 400 });
  }
  const identOf = (leg: { securityId?: string; tradingSymbol?: string }) => (broker !== 'dhan' ? leg.tradingSymbol : leg.securityId);

  // Maximum quantity ceiling per leg (e.g. 5,000 units = ~76 lots of Nifty)
  // Enforces Invariant #1 of dhan-order-tickets skill against uncapped API calls
  const MAX_QTY_PER_LEG = 5000;

  // Validate every leg before touching the broker — fail fast with a clear message
  const invalidLegs: string[] = [];
  for (const leg of legs) {
    const ident = identOf(leg);
    if (!ident || String(ident) === 'null' || String(ident).trim() === '') {
      invalidLegs.push(`leg ${ident ?? 'unknown'}: missing ${broker === 'kotak' ? 'Kotak trading symbol' : broker === 'zerodha' ? 'Zerodha trading symbol' : 'securityId'} (option chain data may not have loaded yet)`);
    }
    if (!Number.isFinite(leg.quantity) || leg.quantity <= 0) {
      invalidLegs.push(`leg ${leg.securityId}: invalid quantity=${leg.quantity}`);
    }
    if (leg.quantity > MAX_QTY_PER_LEG) {
      invalidLegs.push(`leg ${leg.securityId}: quantity ${leg.quantity} exceeds safety limit (${MAX_QTY_PER_LEG})`);
    }
    const ot = leg.orderType ?? 'MARKET';
    if ((ot === 'STOP_LOSS_MARKET' || ot === 'STOP_LOSS') && (!leg.triggerPrice || leg.triggerPrice <= 0)) {
      invalidLegs.push(`leg ${leg.securityId}: SL/trigger order requires a valid triggerPrice`);
    }
    if (ot === 'LIMIT' && (!leg.price || leg.price <= 0)) {
      invalidLegs.push(`leg ${leg.securityId}: LIMIT order requires a valid price`);
    }
  }
  if (invalidLegs.length > 0) {
    return NextResponse.json({
      success: false,
      error: `Cannot place order — invalid leg(s): ${invalidLegs.join('; ')}`,
    }, { status: 400 });
  }

  if (broker === 'zerodha') {
    if (!isZerodhaTokenValid()) return NextResponse.json({ success: false, error: 'Zerodha not connected — run scripts/tools/zerodha_autologin.py' }, { status: 401 });
    // Validate every leg before anything is sent. One order per leg: a leg over the exchange freeze would be cut into
    // several orders whose ids the caller cannot track, so it is refused instead.
    const refused: string[] = [];
    for (const leg of legs) {
      const symbol = String(leg.tradingSymbol);
      const ot = leg.orderType ?? 'MARKET';
      if (ot !== 'MARKET' && ot !== 'LIMIT') refused.push(`${symbol}: Zerodha places MARKET and LIMIT orders only (no resting stop entries)`);
      else if (slicesFor(symbol, Number(leg.quantity)).length > 1) refused.push(`${symbol}: ${leg.quantity} is above the exchange freeze quantity - use fewer lots per order`);
    }
    if (refused.length) {
      return NextResponse.json({ success: false, error: `Cannot place order — invalid leg(s): ${refused.join('; ')}` }, { status: 400 });
    }
    const results: LegResult[] = await Promise.all(legs.map(async (leg): Promise<LegResult> => {
      const symbol = String(leg.tradingSymbol);
      const isLimit = leg.orderType === 'LIMIT';
      const params: Record<string, string | number> = {
        tradingsymbol: symbol, exchange: leg.exchange ?? 'NFO', transaction_type: leg.side, quantity: Number(leg.quantity),
        order_type: isLimit ? 'LIMIT' : 'MARKET', product: mode === 'positional' ? 'NRML' : 'MIS', validity: 'DAY',
      };
      if (isLimit) params.price = zerodhaSnapPrice(Number(leg.price), cachedZerodhaContract(symbol));
      else params.market_protection = -1;   // Kite refuses API market orders on options without protection
      const r = await placeZerodhaOrder(params);
      if (r.status === 'placed') return { success: true, orderId: r.orderId, tradingSymbol: symbol };
      return { success: false, error: r.error, tradingSymbol: symbol, ...(r.status === 'unknown' ? { unknown: true } : {}) };
    }));
    return basketReply('zerodha', results);
  }

  if (broker === 'kotak') {
    if (!isKotakTokenValid()) return NextResponse.json({ success: false, error: 'Kotak not connected — run kotak_autologin.py' }, { status: 401 });
    // Build every payload first: a leg the builder refuses fails the whole basket before anything is sent.
    const built = legs.map(leg => {
      const symbol = String(leg.tradingSymbol);
      const exchange = leg.exchange ?? 'nse_fo';
      const underlying = /_fo$/i.test(exchange) ? kotakUnderlyingOf(symbol) : null;
      return buildKotakOrderPayload({
        tradingsymbol: symbol, quantity: Number(leg.quantity), side: leg.side, orderType: leg.orderType ?? 'MARKET',
        price: leg.price, triggerPrice: leg.triggerPrice, exchange, product: mode === 'positional' ? 'NRML' : 'MIS',
      }, underlying ? kotakDerivativeBySymbol(symbol, underlying) : null);
    });
    const refused = built.flatMap((b, i) => ('error' in b ? [`${legs[i].tradingSymbol}: ${b.error}`] : []));
    if (refused.length) {
      return NextResponse.json({ success: false, error: `Cannot place order — invalid leg(s): ${refused.join('; ')}` }, { status: 400 });
    }
    const results: LegResult[] = await Promise.all(built.map(async (b, i): Promise<LegResult> => {
      const r = await placeKotakOrder((b as { payload: Record<string, string> }).payload);
      const tradingSymbol = String(legs[i].tradingSymbol);
      if (r.status === 'placed') return { success: true, orderId: r.orderId, tradingSymbol };
      return { success: false, error: r.error, tradingSymbol, ...(r.status === 'unknown' ? { unknown: true } : {}) };
    }));
    return basketReply('kotak', results);
  }

  try {
    const { clientId, token } = getToken();
    const productType = mode === 'positional' ? 'MARGIN' : 'INTRADAY';

    const orderPromises = legs.map(async (leg): Promise<LegResult> => {
      const orderType = leg.orderType ?? 'MARKET';
      // For STOP_LOSS_MARKET: price=0, triggerPrice=trigger
      // For STOP_LOSS (limit): price=leg.price, triggerPrice=trigger
      // For LIMIT: price=leg.price, triggerPrice=0
      // For MARKET: price=0, triggerPrice=0
      const payload = {
        dhanClientId:     clientId,
        transactionType:  leg.side,
        exchangeSegment:  leg.exchangeSegment || 'NSE_FNO',
        productType,
        orderType,
        validity:         'DAY',
        securityId:       String(leg.securityId),
        quantity:         Number(leg.quantity),
        disclosedQuantity: 0,
        price:            leg.price ?? 0,
        afterMarketOrder: false,
        boProfitValue:    0,
        boStopLossValue:  0,
        triggerPrice:     leg.triggerPrice ?? 0,
      };

      try {
        const res = await fetch(DHAN_ORDERS, {
          method:  'POST',
          headers: {
            'access-token':  token,
            'client-id':     clientId,
            'Content-Type':  'application/json',
            'Accept':        'application/json',
          },
          body: JSON.stringify(payload),
        });

        // No readable reply (or a 5xx without one): Dhan may still have booked it.
        const json = await res.json().catch(() => null) as Record<string, any> | null;
        if (!json) return { success: false, error: `Dhan answered HTTP ${res.status} with no readable body — the order may be live`, securityId: leg.securityId, unknown: true };
        const orderId = String(json.orderId ?? json.data?.orderId ?? '');
        if (orderId) {
          return { success: true, orderId, securityId: leg.securityId };
        }
        return { success: false, error: json.remarks ?? json.message ?? JSON.stringify(json), securityId: leg.securityId };
      } catch (e) {
        // The request may have reached Dhan before it failed.
        return { success: false, error: String(e), securityId: leg.securityId, unknown: true };
      }
    });

    return basketReply('dhan', await Promise.all(orderPromises));

  } catch (err) {
    console.error('[options/order] error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

/** The basket's reply: per-leg `data` always (a partial basket still placed what it placed), `unknown: true` when any
 *  leg's outcome is unknown. */
function basketReply(broker: 'dhan' | 'kotak' | 'zerodha', results: LegResult[]): NextResponse {
  // Invalidate even on a partial failure — a basket can place some legs and reject others, and any placed (or
  // possibly placed) leg still means positions moved.
  if (results.some(r => r.success || r.unknown)) invalidateBrokerCache(broker);
  const failures = results.filter(r => !r.success);
  if (failures.length > 0) {
    const anyUnknown = failures.some(f => f.unknown);
    return NextResponse.json({
      success: false,
      ...(anyUnknown ? { unknown: true } : {}),
      error: `${anyUnknown ? 'Some orders have an UNKNOWN status' : 'Failed to place some orders'}: ${failures.map(f => `${f.securityId ?? f.tradingSymbol}: ${f.unknown ? 'UNKNOWN — ' : ''}${f.error}`).join(', ')}`,
      data: results,
    });
  }
  return NextResponse.json({ success: true, data: results });
}
