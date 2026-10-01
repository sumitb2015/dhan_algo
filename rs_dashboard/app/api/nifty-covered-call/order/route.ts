import { NextRequest, NextResponse } from 'next/server';
import { dhanGet, dhanPost } from '@/lib/dhanToken';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { resolveLotSize } from '@/lib/lotSize';
import { reconstructCallLedger, reservedBuyUnits, TERMINAL_ORDER_STATUSES, type CallTrade } from '@/lib/coveredCallEngine';
import { mutateLedger, newId, fetchOrderStatus, bookOrderStatus, type OrderStatus } from '@/lib/coveredCallLedgerStore';

// Dhan-only order placement for the NIFTYBEES Covered Call desk — REAL MONEY.
// Only NIFTY index calls are ever traded here; NIFTYBEES itself is never
// bought or sold by this page.
//
//   SELL  — write a call (open). Units must be a whole number of lots, capped.
//   BUY   — buy back one ledger leg (`openLegId`). Clamped to that leg's own
//           open units minus buy-backs already in flight for it (so a second
//           tab can't close it twice and eat another strategy's short on the
//           same contract — the 2026-07-30 pattern), AND to what the broker
//           still shows short, read LIVE, so the account can never flip long.
//
// Product is MARGIN (NRML): covered calls are carried to expiry, an INTRADAY
// short would be auto-squared off at 15:20.
//
// The route books fills itself (dhan-terminal-position-ownership Invariant 3):
// a reservation goes into the ledger before the order is sent, the order is
// polled ~5 s, and the filled part is booked at the order's own average. A
// part that fills later is booked by the state route's sweep, at that same
// order's average — never an LTP, the pooled position average, or 0.

const MAX_LOTS_PER_ORDER = 20;
const FILL_POLL_MS = 5_000;

export interface CoveredCallOrderRequest {
  side: 'BUY' | 'SELL';
  securityId: string;
  units: number;
  orderType?: 'MARKET' | 'LIMIT';
  price?: number;
  /** SELL: the contract being written. */
  strike?: number;
  expiry?: string;
  tradingSymbol?: string;
  /** BUY: the ledger leg being bought back (required). */
  openLegId?: string;
  note?: string;
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
  /** Ledger rows this call booked. */
  booked?: CallTrade[];
  /** The order is still working at the broker; later fills are booked by the sweep. */
  pending?: boolean;
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

async function pollFill(orderId: string): Promise<OrderStatus> {
  const deadline = Date.now() + FILL_POLL_MS;
  let last: OrderStatus = { status: 'UNKNOWN', filled: 0, avg: 0, reason: '' };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600));
    try {
      const st = await fetchOrderStatus(orderId);
      if (!st) continue;
      last = st;
      // A TRADED order can briefly report avg 0; keep polling for the price.
      if (TERMINAL_ORDER_STATUSES.includes(last.status) && !(last.status === 'TRADED' && !(last.avg > 0))) break;
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
  let contract: { strike: number; expiry: string; tradingSymbol: string };
  if (side === 'BUY') {
    if (!body.openLegId) return NextResponse.json({ success: false, error: 'openLegId required for a buy-back' }, { status: 400 });
    let shortUnits: number;
    try {
      shortUnits = await liveShortUnits(securityId);
    } catch (err) {
      // Fail closed: without a live read we can't prove the buy only closes.
      return NextResponse.json({ success: false, error: `Positions unavailable, buy-back refused: ${(err as Error).message}` }, { status: 503 });
    }
    const brokerAllowed = Math.floor(shortUnits / lotSize) * lotSize;
    if (brokerAllowed <= 0) return NextResponse.json({ success: false, error: 'Broker shows no short position at this contract — nothing to buy back' }, { status: 409 });
    if (units > brokerAllowed) { clampedFrom = units; units = brokerAllowed; }
    contract = { strike: 0, expiry: '', tradingSymbol: '' };
  } else {
    if (!(Number(body.strike) > 0) || !body.expiry) return NextResponse.json({ success: false, error: 'strike and expiry required for a sell' }, { status: 400 });
    contract = {
      strike: Number(body.strike), expiry: String(body.expiry),
      tradingSymbol: body.tradingSymbol || `NIFTY-${body.expiry}-${body.strike}-CE`,
    };
  }

  // Reserve in the ledger BEFORE placing. For a BUY this is where the leg's own
  // open units cap is enforced, atomically with every other tab's reservations.
  const reservation = await mutateLedger<{ error: string } | { id: string; units: number }>((state) => {
    let u = units;
    let c = contract;
    if (side === 'BUY') {
      const leg = reconstructCallLedger(state.trades).open.find((o) => o.id === body.openLegId);
      if (!leg || leg.securityId !== securityId) return { result: { error: 'That leg is not open in this desk\'s ledger' }, write: false };
      const free = Math.floor((leg.units - reservedBuyUnits(state.pending, leg.id)) / lotSize) * lotSize;
      if (free <= 0) {
        const inFlight = reservedBuyUnits(state.pending, leg.id) > 0;
        return { result: { error: inFlight ? 'A buy-back for this leg is already in flight (another tab?) — nothing left to close' : `This leg has no whole ${lotSize}-unit lot left to buy back` }, write: false };
      }
      if (u > free) { clampedFrom = clampedFrom ?? u; u = free; }
      c = { strike: leg.strike, expiry: leg.expiry, tradingSymbol: leg.tradingSymbol };
    }
    const id = newId('po');
    state.pending.push({
      id, orderId: null, side, securityId, ...c, units: u, openLegId: side === 'BUY' ? body.openLegId : undefined,
      note: body.note, bookedUnits: 0, bookedValue: 0, createdAt: Date.now(),
    });
    return { result: { id, units: u }, write: true };
  });
  if ('error' in reservation) return NextResponse.json({ success: false, error: reservation.error }, { status: 409 });
  units = reservation.units;
  const dropReservation = () => mutateLedger((s) => {
    s.pending = s.pending.filter((p) => p.id !== reservation.id);
    return { result: null, write: true };
  });

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
    if (!orderId) {
      await dropReservation();
      return NextResponse.json({ success: false, error: String(json.remarks ?? json.errorMessage ?? json.message ?? JSON.stringify(json)) });
    }
  } catch (err) {
    // Unknown outcome: the order may or may not exist. The reservation has no
    // order id, so the sweep drops it after a minute; until then it keeps a
    // second buy-back on this leg out.
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) });
  }
  await mutateLedger((s) => {
    const p = s.pending.find((x) => x.id === reservation.id);
    if (p) p.orderId = orderId;
    return { result: null, write: Boolean(p) };
  });

  invalidateBrokerCache('dhan');
  const fill = await pollFill(orderId);
  invalidateBrokerCache('dhan');
  const booked = await bookOrderStatus(reservation.id, fill);
  const filledUnits = booked.reduce((s, t) => s + t.units, 0);
  const terminal = TERMINAL_ORDER_STATUSES.includes(fill.status);

  return NextResponse.json({
    // A cancelled order that part-filled still booked that part.
    success: filledUnits > 0 || (fill.status !== 'REJECTED' && fill.status !== 'CANCELLED'),
    orderId,
    status: fill.status,
    units,
    filledUnits,
    avgPrice: filledUnits > 0 ? booked.reduce((s, t) => s + t.price * t.units, 0) / filledUnits : undefined,
    clampedFrom,
    booked,
    pending: !terminal || filledUnits < Math.min(fill.filled, units),
    error: fill.status === 'REJECTED' ? fill.reason || 'Order rejected' : undefined,
  });
}
