import { NextRequest, NextResponse } from 'next/server';
import { dhanGet, dhanPost, dhanPut, dhanDelete } from '@/lib/dhanToken';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { reserveOrderSlot, ORDER_WINDOW_MS } from '@/lib/dhanOrderPacer';
import {
  buildPlacePayload, validateModify, validateSuperOrder,
  type SuperLeg, type SuperModifyInput, type SuperOrderInput,
} from '@/lib/superOrder';

/**
 * Dhan Super Orders: entry + resting target + stop-loss (+ trailing jump) held at the broker.
 * REAL-MONEY endpoint (POST/PUT/DELETE). GET lists today's super orders.
 *
 * Conventions copied from scalper/fast-order: server-side validation (rejected, never
 * clamped), the shared account order pacer, a correlationId for unknown-outcome
 * reconciliation, and a REQUIRED idempotencyKey (new surface) so a retry can never
 * book a second bracket. A 504 means "status unknown", never a clean failure.
 *
 * Whoever calls this owns the position it opens: the exit legs live at the broker, so
 * do not also run a software stop or cancel_all_orders() on the same security, and size
 * any manual close off your own quantity (resolve_exit_qty), not the broker net.
 */

const LEGS = new Set<SuperLeg>(['ENTRY_LEG', 'TARGET_LEG', 'STOP_LOSS_LEG']);
const IDEMPOTENCY_TTL_MS = 60_000;
const RECONCILE_ATTEMPTS = 3;
const RECONCILE_GAP_MS = 2_000;

type Outcome = { status: number; body: Record<string, unknown> };
const idempotent = new Map<string, { at: number; result: Promise<Outcome> }>();

const asRows = (raw: unknown): Record<string, unknown>[] => {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  const d = (raw as { data?: unknown } | null)?.data;
  return Array.isArray(d) ? (d as Record<string, unknown>[]) : [];
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** dhanPost tags `.status` on a Dhan HTTP rejection; no status = no clean HTTP response (timeout/network). */
const httpStatus = (e: unknown) => (e as { status?: number } | null)?.status;

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ success: true, orders: asRows(await dhanGet('/super/orders')) });
  } catch (e) {
    return NextResponse.json({ success: false, error: errText(e) }, { status: 502 });
  }
}

async function reconcile(correlationId: string): Promise<string | null> {
  for (let a = 0; a < RECONCILE_ATTEMPTS; a++) {
    if (a > 0) await new Promise(r => setTimeout(r, RECONCILE_GAP_MS));
    try {
      const row = asRows(await dhanGet('/super/orders')).find(r => String(r.correlationId ?? '') === correlationId);
      const id = row ? String(row.orderId ?? '') : '';
      if (id) return id;
    } catch { /* Dhan may still be catching up */ }
  }
  return null;
}

async function place(raw: Record<string, unknown>): Promise<Outcome> {
  const input = raw as unknown as SuperOrderInput;
  const productType = String(raw.productType ?? '').toUpperCase();
  const exchangeSegment = String(raw.exchangeSegment ?? '').toUpperCase();
  const normalised: SuperOrderInput = { ...input, productType, exchangeSegment, securityId: String(raw.securityId ?? '') };
  const bad = validateSuperOrder(normalised);
  if (bad) return { status: 400, body: { success: false, error: bad } };

  const correlationId = `so${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const payload = buildPlacePayload(normalised, correlationId);

  const send = async () => { await reserveOrderSlot(); return dhanPost('/super/orders', payload) as Promise<Record<string, unknown>>; };
  try {
    let json: Record<string, unknown>;
    try {
      json = await send();
    } catch (e) {
      // 429 = rejected before booking, so ONE retry after the window cannot double-place.
      if (httpStatus(e) !== 429) throw e;
      await new Promise(r => setTimeout(r, ORDER_WINDOW_MS + 100));
      json = await send();
    }
    const orderId = String(json.orderId ?? (json.data as Record<string, unknown> | undefined)?.orderId ?? '');
    if (orderId) {
      invalidateBrokerCache('dhan');
      return { status: 200, body: { success: true, order_id: orderId, status: json.orderStatus ?? null, productType, correlationId } };
    }
    return { status: 200, body: { success: false, error: String(json.remarks ?? json.message ?? JSON.stringify(json)) } };
  } catch (e) {
    if (httpStatus(e) !== undefined) {
      return { status: 200, body: { success: false, error: errText(e) } };   // Dhan answered with a rejection
    }
    console.error('[super-order] place failed without a clean response, reconciling:', correlationId, e);
    const recovered = await reconcile(correlationId);
    if (recovered) {
      invalidateBrokerCache('dhan');
      return { status: 200, body: { success: true, order_id: recovered, productType, correlationId, reconciled: true } };
    }
    return { status: 504, body: { success: false, error: 'Super order status unknown - Dhan did not confirm in time. Check Orders/Positions before retrying.' } };
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  let raw: Record<string, unknown>;
  try { raw = await req.json() as Record<string, unknown>; } catch { return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }
  const key = typeof raw.idempotencyKey === 'string' && raw.idempotencyKey.length >= 8 && raw.idempotencyKey.length <= 64 ? raw.idempotencyKey : null;
  if (!key) return NextResponse.json({ success: false, error: 'idempotencyKey (8-64 chars) is required' }, { status: 400 });

  const now = Date.now();
  for (const [k, v] of idempotent) if (now - v.at > IDEMPOTENCY_TTL_MS) idempotent.delete(k);
  let entry = idempotent.get(key);
  if (!entry) {
    entry = { at: now, result: place(raw) };
    idempotent.set(key, entry);
  }
  const out = await entry.result;
  // Keep booked and status-unknown results (a replay must not place a second bracket);
  // a clean rejection may be retried with the same key.
  if (out.body.success !== true && out.status !== 504) idempotent.delete(key);
  return NextResponse.json(out.body, { status: out.status });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  let raw: Record<string, unknown>;
  try { raw = await req.json() as Record<string, unknown>; } catch { return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }
  const orderId = String(raw.orderId ?? '');
  if (!/^\d+$/.test(orderId)) return NextResponse.json({ success: false, error: 'orderId required' }, { status: 400 });
  const m = raw as unknown as SuperModifyInput;
  const bad = LEGS.has(m.legName) ? validateModify(m) : `Invalid legName: ${m.legName}`;
  if (bad) return NextResponse.json({ success: false, error: bad }, { status: 400 });
  try {
    await reserveOrderSlot();
    const body: Record<string, unknown> = { orderId, legName: m.legName, ...(m.legName === 'ENTRY_LEG' ? { orderType: m.orderType } : {}) };
    for (const k of ['quantity', 'price', 'targetPrice', 'stopLossPrice', 'trailingJump'] as const) if (m[k] !== undefined) body[k] = m[k];
    const json = await dhanPut(`/super/orders/${orderId}`, body) as Record<string, unknown>;
    invalidateBrokerCache('dhan');
    return NextResponse.json({ success: true, order_id: orderId, status: json.orderStatus ?? null });
  } catch (e) {
    return NextResponse.json({ success: false, error: errText(e) });
  }
}

/** DELETE ?orderId=…&leg=ENTRY_LEG|TARGET_LEG|STOP_LOSS_LEG. Cancelling ENTRY_LEG cancels the whole bracket. */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const orderId = req.nextUrl.searchParams.get('orderId') ?? '';
  const leg = req.nextUrl.searchParams.get('leg') ?? '';
  if (!/^\d+$/.test(orderId)) return NextResponse.json({ success: false, error: 'orderId required' }, { status: 400 });
  if (!LEGS.has(leg as SuperLeg)) return NextResponse.json({ success: false, error: `leg must be one of ${[...LEGS].join(' / ')}` }, { status: 400 });
  try {
    await reserveOrderSlot();
    await dhanDelete(`/super/orders/${orderId}/${leg}`);
    invalidateBrokerCache('dhan');
    return NextResponse.json({ success: true, order_id: orderId, leg });
  } catch (e) {
    return NextResponse.json({ success: false, error: errText(e) });
  }
}
