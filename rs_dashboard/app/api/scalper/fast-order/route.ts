import { NextRequest, NextResponse } from 'next/server';
import { placeDhanOrder, type DhanOrderInput } from '@/lib/dhanPlaceOrder';

// Opt-in idempotency: a request carrying `idempotencyKey` that repeats within the
// TTL (duplicate HTTP delivery, client retry) gets the first request's result
// instead of booking a second order. Callers that omit the key are unaffected.
const IDEMPOTENCY_TTL_MS = 60_000;
const idempotent = new Map<string, { at: number; result: Promise<Response> }>();

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ready: true });
}

export async function POST(req: NextRequest): Promise<Response> {
  const raw = await req.json() as { idempotencyKey?: unknown };
  const key = typeof raw.idempotencyKey === 'string' && raw.idempotencyKey.length >= 8 && raw.idempotencyKey.length <= 64
    ? raw.idempotencyKey : null;
  if (!key) return placeOrderOnce(raw as never);
  const now = Date.now();
  for (const [k, v] of idempotent) if (now - v.at > IDEMPOTENCY_TTL_MS) idempotent.delete(k);
  const prior = idempotent.get(key);
  if (prior) return (await prior.result).clone();
  const result = placeOrderOnce(raw as never);
  idempotent.set(key, { at: now, result });
  let res: Response;
  try {
    res = await result;
  } catch (err) {
    idempotent.delete(key); // nothing was sent; let the caller retry
    throw err;
  }
  // Keep the entry for a booked order AND for a 504 "status unknown" — that order
  // may exist, so a replay must return the same answer, never place a second one.
  // Any other failure was rejected before booking and may be retried with the key.
  const booked = res.status < 400 && (await res.clone().json() as { success?: boolean }).success === true;
  if (!booked && res.status !== 504) idempotent.delete(key);
  return res.clone();
}

// Validation, per-source caps, pacing and correlationId reconcile live in lib/dhanPlaceOrder.ts (shared with the
// Price Ladder's server watcher); this route only maps its outcome onto the HTTP replies callers already read.
async function placeOrderOnce(body: DhanOrderInput): Promise<NextResponse> {
  const r = await placeDhanOrder(body);
  if (r.status === 'placed') return NextResponse.json({ success: true, order_id: r.orderId });
  if (r.status === 'invalid') return NextResponse.json({ success: false, error: r.error }, { status: r.http });
  if (r.status === 'rejected') return NextResponse.json({ success: false, error: r.error });
  // `unknown: true` says the same as the 504, explicitly (the Kotak route sends both): callers must not retry it.
  return NextResponse.json({ success: false, unknown: true, error: r.error }, { status: 504 });
}
