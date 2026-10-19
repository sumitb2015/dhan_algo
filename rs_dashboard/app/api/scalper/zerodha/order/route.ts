import { NextRequest, NextResponse } from 'next/server';
import { placeZerodhaOrder } from '@/lib/zerodhaPlaceOrder';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { zerodhaContractFromRows, zerodhaLotCapError, zerodhaSnapPrice, zerodhaUnderlyingOf, type ZerodhaCachedContract } from '@/lib/zerodhaOrderRules';
import fs from 'fs';
import path from 'path';

/** The cached contract for a symbol, read from disk only (never spawns the cache script on the order path). */
function cachedContract(symbol: string) {
  const underlying = zerodhaUnderlyingOf(symbol);
  if (!underlying) return null;
  try {
    const file = path.join(path.resolve(process.cwd(), '..'), 'debug', `zerodha_${underlying.toLowerCase()}_instruments.json`);
    return zerodhaContractFromRows(JSON.parse(fs.readFileSync(file, 'utf8')) as ZerodhaCachedContract[], symbol);
  } catch { return null; }
}

/** Products this route will book. CO/BO are excluded — Kite holds its own exit
 *  order against them, which a plain market order would leave dangling. */
const KITE_PRODUCTS = new Set(['MIS', 'NRML', 'CNC']);

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ready: true });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json() as {
    tradingsymbol: string;
    quantity: number;
    side: string;
    orderType?: string;
    price?: number;
    exchange?: string;
    product?: string;
    /** Calling terminal, for the per-source lot cap (lib/kotakOrderRules SOURCE_LOT_CAPS). Absent = uncapped (closes). */
    source?: string;
  };

  const { tradingsymbol, quantity, side, orderType = 'MARKET', price = 0, exchange = 'NFO', product: productRaw, source } = body;

  // Reject an unrecognised product rather than coercing it to MIS. A close order
  // booked under the wrong product does not reduce the position — Kite opens a
  // fresh intraday one on the other side instead. Absent still defaults to MIS
  // so callers that never sent the field are unaffected.
  const product = productRaw === undefined ? 'MIS' : String(productRaw).toUpperCase();
  if (!KITE_PRODUCTS.has(product)) {
    return NextResponse.json(
      { success: false, error: `Unsupported product: ${productRaw} (expected ${[...KITE_PRODUCTS].join(' / ')})` },
      { status: 400 },
    );
  }

  if (!tradingsymbol || !quantity || !side) {
    return NextResponse.json({ success: false, error: 'Missing required fields: tradingsymbol, quantity, side' }, { status: 400 });
  }

  const qtyNum = Number(quantity);
  if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
    return NextResponse.json({ success: false, error: `Invalid quantity: ${quantity} (must be a positive integer)` }, { status: 400 });
  }

  const sideUpper = String(side).toUpperCase();
  if (sideUpper !== 'BUY' && sideUpper !== 'SELL') {
    return NextResponse.json({ success: false, error: `Invalid side: ${side} (must be BUY or SELL)` }, { status: 400 });
  }

  const isLimitOrder = String(orderType).toUpperCase() === 'LIMIT';
  if (isLimitOrder && !(Number(price) > 0)) {
    return NextResponse.json({ success: false, error: `Invalid price for LIMIT order: ${price}` }, { status: 400 });
  }

  const contract = source || isLimitOrder ? cachedContract(String(tradingsymbol)) : null;
  const capError = zerodhaLotCapError(qtyNum, source, String(tradingsymbol), contract);
  if (capError) return NextResponse.json({ success: false, error: capError }, { status: 400 });

  const params: Record<string, string | number> = {
    tradingsymbol,
    exchange,
    transaction_type: sideUpper,
    order_type: isLimitOrder ? 'LIMIT' : 'MARKET',
    quantity: qtyNum,
    product,
    validity: 'DAY',
  };
  if (isLimitOrder) {
    params.price = zerodhaSnapPrice(Number(price), contract);
  } else {
    // Zerodha rejects API market orders on options without market
    // protection; -1 = automatic system-managed protection band.
    params.market_protection = -1;
  }

  const r = await placeZerodhaOrder(params);
  if (r.status === 'placed') {
    invalidateBrokerCache('zerodha');
    return NextResponse.json({ success: true, order_id: r.orderId, ...(r.reconciled ? { reconciled: true } : {}) });
  }
  if (r.status === 'unknown') return NextResponse.json({ success: false, unknown: true, error: r.error }, { status: 504 });
  return NextResponse.json({ success: false, error: r.error });
}
