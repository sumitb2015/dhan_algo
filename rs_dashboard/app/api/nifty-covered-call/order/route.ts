import { NextRequest, NextResponse } from 'next/server';
import { dhanGet, dhanPost } from '@/lib/dhanToken';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { resolveLotSize } from '@/lib/lotSize';

// Dhan-only order placement for the NIFTYBEES Covered Call desk — REAL MONEY.
// Only NIFTY index calls are ever traded here; NIFTYBEES itself is never
// bought or sold by this page.
//
//   SELL  — write a call (open). Units must be a whole number of lots, capped.
//   BUY   — buy a call back (close). Clamped server-side to what the broker
//           still shows short at that security id, read LIVE (never cached),
//           so a stale ledger can never flip the account long.
//
// Product is MARGIN (NRML): covered calls are carried to expiry, an INTRADAY
// short would be auto-squared off at 15:20.
//
// After placement the route polls the order for up to ~5 s and returns the
// filled quantity and average price, so the ledger books real fills rather
// than an LTP guess (dhan-terminal-position-ownership Invariant 3).

const MAX_LOTS_PER_ORDER = 20;
const FILL_POLL_MS = 5_000;

export interface CoveredCallOrderRequest {
  side: 'BUY' | 'SELL';
  securityId: string;
  units: number;
  orderType?: 'MARKET' | 'LIMIT';
  price?: number;
}

export interface CoveredCallOrderResult {
  success: boolean;
  orderId?: string;
  status?: string;
  /** Units the order actually requested (after any clamp). */
  units?: number;
  filledUnits?: number;
  avgPrice?: number;
  clampedFrom?: number;
  error?: string;
}

type Row = Record<string, unknown>;

async function liveShortUnits(securityId: string): Promise<number> {
  const rows = (await dhanGet('/positions')) as Row[];
  if (!Array.isArray(rows)) throw new Error('Unexpected /positions payload');
  return rows
    .filter((r) => String(r.securityId) === securityId && String(r.exchangeSegment) === 'NSE_FNO')
    .reduce((s, r) => s + Math.max(0, -Number(r.netQty || 0)), 0);
}

async function pollFill(orderId: string): Promise<{ status: string; filled: number; avg: number; reason: string }> {
  const deadline = Date.now() + FILL_POLL_MS;
  let last = { status: 'UNKNOWN', filled: 0, avg: 0, reason: '' };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600));
    try {
      const raw = await dhanGet(`/orders/${orderId}`, 4_000);
      const o = (Array.isArray(raw) ? raw[0] : raw) as Row | undefined;
      if (!o) continue;
      last = {
        status: String(o.orderStatus ?? '').toUpperCase(),
        filled: Number(o.filledQty) || 0,
        avg: Number(o.averageTradedPrice) || 0,
        reason: String(o.omsErrorDescription ?? ''),
      };
      if (['TRADED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(last.status)) break;
    } catch { /* transient — keep polling until the deadline */ }
  }
  return last;
}

export async function POST(req: NextRequest): Promise<NextResponse<CoveredCallOrderResult>> {
  let body: CoveredCallOrderRequest;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }); }

  const side = body.side;
  const securityId = String(body.securityId ?? '');
  let units = Math.floor(Number(body.units));
  const orderType = body.orderType === 'LIMIT' ? 'LIMIT' : 'MARKET';

  if (side !== 'BUY' && side !== 'SELL') return NextResponse.json({ success: false, error: 'side must be BUY or SELL' }, { status: 400 });
  if (!/^\d+$/.test(securityId)) return NextResponse.json({ success: false, error: 'Invalid securityId' }, { status: 400 });
  if (!(units > 0)) return NextResponse.json({ success: false, error: 'units must be > 0' }, { status: 400 });
  if (orderType === 'LIMIT' && !(Number(body.price) > 0)) return NextResponse.json({ success: false, error: 'LIMIT needs a price' }, { status: 400 });

  let lotSize: number | null;
  try {
    lotSize = await resolveLotSize('NIFTY');
  } catch (err) {
    return NextResponse.json({ success: false, error: `Lot size unavailable: ${(err as Error).message}` }, { status: 503 });
  }
  if (!lotSize || !(lotSize > 0) || units % lotSize !== 0) {
    return NextResponse.json({ success: false, error: `units ${units} is not a whole number of ${lotSize}-unit lots` }, { status: 400 });
  }
  if (units / lotSize > MAX_LOTS_PER_ORDER) {
    return NextResponse.json({ success: false, error: `Exceeds ${MAX_LOTS_PER_ORDER} lots per order` }, { status: 400 });
  }

  let clampedFrom: number | undefined;
  if (side === 'BUY') {
    let shortUnits: number;
    try {
      shortUnits = await liveShortUnits(securityId);
    } catch (err) {
      // Fail closed: without a live read we can't prove the buy only closes.
      return NextResponse.json({ success: false, error: `Positions unavailable, buy-back refused: ${(err as Error).message}` }, { status: 503 });
    }
    const allowed = Math.floor(shortUnits / lotSize) * lotSize;
    if (allowed <= 0) return NextResponse.json({ success: false, error: 'Broker shows no short position at this contract — nothing to buy back' }, { status: 409 });
    if (units > allowed) { clampedFrom = units; units = allowed; }
  }

  const payload = {
    transactionType: side,
    exchangeSegment: 'NSE_FNO',
    productType: 'MARGIN',
    orderType,
    validity: 'DAY',
    securityId,
    quantity: units,
    disclosedQuantity: 0,
    price: orderType === 'LIMIT' ? Number(body.price) : 0,
    afterMarketOrder: false,
    triggerPrice: 0,
  };

  let orderId = '';
  try {
    const json = (await dhanPost('/orders', payload)) as Row;
    orderId = String(json.orderId ?? (json.data as Row | undefined)?.orderId ?? '');
    if (!orderId) return NextResponse.json({ success: false, error: String(json.remarks ?? json.errorMessage ?? json.message ?? JSON.stringify(json)) });
  } catch (err) {
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) });
  }

  invalidateBrokerCache('dhan');
  const fill = await pollFill(orderId);
  invalidateBrokerCache('dhan');

  return NextResponse.json({
    success: fill.status !== 'REJECTED' && fill.status !== 'CANCELLED',
    orderId,
    status: fill.status,
    units,
    filledUnits: fill.filled,
    avgPrice: fill.avg,
    clampedFrom,
    error: fill.status === 'REJECTED' ? fill.reason || 'Order rejected' : undefined,
  });
}
