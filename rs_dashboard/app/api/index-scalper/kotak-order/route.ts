import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { placeKotakOrder } from '@/lib/kotakPlaceOrder';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { kotakDerivativeBySymbol } from '@/lib/kotakContracts';
import { kotakUnderlyingOf } from '@/lib/kotakPositionContracts';
import { buildKotakOrderPayload } from '@/lib/kotakOrderPayload';
import { readJsonFile, withFileLock, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { istDateIso } from '@/lib/nseHolidays';
import { appendRecord, kotakProduct, todaysRecords, type KotakDayFile, type KotakRecord } from '@/lib/indexScalperKotak';

// REAL-MONEY route: /index-scalper's Kotak orders (NIFTY options only). Places through lib/kotakPlaceOrder.ts (placed /
// rejected / unknown, order-book reconcile on an unclean reply) and RECORDS every placed or unknown order in the page's
// day file, so the page can tell its own Kotak fills from a strategy's or another terminal's on the same contract
// (Kotak has no order tag the repo can read back). GET returns today's records.
//
// Opening orders carry source 'isx' (20-lot cap, lib/kotakOrderRules.ts); closes are uncapped, as on every Kotak desk
// (a close must never be refused for its size; its size comes from what this page owns, clamped by the broker row).
// An idempotency key replays the first answer for 60 s; an unknown outcome is kept so a replay never sends twice.

const FILE = path.join(PROJECT_ROOT, 'debug', 'index_scalper_kotak_orders.json');
const LOCK = `${FILE}.lock`;
const IDEMPOTENCY_TTL_MS = 60_000;
const idempotent = new Map<string, { at: number; result: Promise<{ status: number; body: Record<string, unknown> }> }>();

const today = () => istDateIso(Date.now());

async function record(rec: KotakRecord): Promise<void> {
  await withFileLock(LOCK, 5_000, 'index-scalper kotak orders', () => {
    writeJsonAtomic(FILE, appendRecord(readJsonFile<KotakDayFile>(FILE), today(), rec), { pretty: true });
  });
}

export async function GET(): Promise<NextResponse> {
  const day = today();
  return NextResponse.json({ success: true, day, records: todaysRecords(readJsonFile<KotakDayFile>(FILE), day) }, { headers: { 'Cache-Control': 'no-store' } });
}

interface Body {
  tradingSymbol?: unknown; quantity?: unknown; side?: unknown; orderType?: unknown; price?: unknown; triggerPrice?: unknown;
  product?: unknown; intent?: unknown; idempotencyKey?: unknown;
}

async function placeOnce(b: Body): Promise<{ status: number; body: Record<string, unknown> }> {
  const symbol = String(b.tradingSymbol ?? '');
  const underlying = kotakUnderlyingOf(symbol);
  if (!symbol || (underlying !== 'NIFTY' && underlying !== 'CRUDEOILM')) {
    return { status: 400, body: { success: false, error: 'tradingSymbol must be a NIFTY or CRUDEOILM contract' } };
  }
  const product = kotakProduct(b.product);
  if (!product) return { status: 400, body: { success: false, error: `Unsupported product: ${String(b.product)} (expected INTRADAY or MARGIN)` } };
  const intent = b.intent === 'close' ? 'close' : b.intent === 'open' ? 'open' : null;
  if (!intent) return { status: 400, body: { success: false, error: 'intent must be open or close' } };
  const side = String(b.side ?? '').toUpperCase();

  const contract = kotakDerivativeBySymbol(symbol, underlying);
  if (!contract) return { status: 400, body: { success: false, error: `${symbol} is not in the Kotak instrument cache` } };
  // Above the exchange freeze quantity the exchange rejects the order: refuse here with the limit (the page slices).
  const qty = Number(b.quantity);
  if (contract.freezeQty && qty > contract.freezeQty) {
    return { status: 400, body: { success: false, error: `Quantity ${qty} exceeds the exchange freeze quantity ${contract.freezeQty} for ${symbol}: send it in parts` } };
  }
  const exchange = contract.segment || (underlying === 'CRUDEOILM' ? 'mcx_fo' : 'nse_fo');
  const built = buildKotakOrderPayload({
    tradingsymbol: symbol, quantity: Number(b.quantity), side, orderType: String(b.orderType ?? 'MARKET'),
    price: Number(b.price) || 0, triggerPrice: Number(b.triggerPrice) || 0, exchange, product,
    ...(intent === 'open' ? { source: 'isx' } : {}),
  }, contract);
  if ('error' in built) return { status: 400, body: { success: false, error: built.error } };

  const r = await placeKotakOrder(built.payload);
  const now = Date.now();
  if (r.status === 'placed') {
    invalidateBrokerCache('kotak');
    let recorded = true;
    try { await record({ orderId: r.orderId, symbol, side: side as 'BUY' | 'SELL', product, at: now }); } catch { recorded = false; }
    // The order is live either way; an unrecorded one is still at the broker, just not counted as this page's.
    return { status: 200, body: { success: true, order_id: r.orderId, ...(r.reconciled ? { reconciled: true } : {}), ...(recorded ? {} : { warning: 'Placed, but could not be recorded as this page\'s order: Exit will not size it' }) } };
  }
  if (r.status === 'unknown') {
    try { await record({ unknown: true, symbol, side: side as 'BUY' | 'SELL', qty: Number(b.quantity) || 0, at: now }); } catch { /* still reported unknown */ }
    return { status: 504, body: { success: false, unknown: true, error: r.error } };
  }
  return { status: 200, body: { success: false, error: r.error } };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const b = await req.json().catch(() => ({})) as Body;
  const key = typeof b.idempotencyKey === 'string' && b.idempotencyKey.length >= 8 && b.idempotencyKey.length <= 64 ? b.idempotencyKey : null;
  if (!key) return NextResponse.json({ success: false, error: 'idempotencyKey required' }, { status: 400 });
  const now = Date.now();
  for (const [k, v] of idempotent) if (now - v.at > IDEMPOTENCY_TTL_MS) idempotent.delete(k);
  const prior = idempotent.get(key);
  const result = prior ? prior.result : placeOnce(b);
  if (!prior) idempotent.set(key, { at: now, result });
  let out: { status: number; body: Record<string, unknown> };
  try {
    out = await result;
  } catch (err) {
    // A throw may come after the order reached Kotak: keep the key (a replay must not send again) and hold the symbol.
    const symbol = String(b.tradingSymbol ?? '');
    if (symbol) {
      try { await record({ unknown: true, symbol, side: String(b.side ?? '').toUpperCase() as 'BUY' | 'SELL', qty: Number(b.quantity) || 0, at: Date.now() }); } catch { /* still unknown */ }
    }
    return NextResponse.json({ success: false, unknown: true, error: `Order status unknown: ${String((err as Error).message ?? err)}` }, { status: 504 });
  }
  // Keep a booked order and an unknown one (a replay must not send a second); drop a refusal so it may be retried.
  if (out.body.success !== true && out.status !== 504) idempotent.delete(key);
  return NextResponse.json(out.body, { status: out.status });
}
