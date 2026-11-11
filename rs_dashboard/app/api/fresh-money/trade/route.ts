import { NextRequest, NextResponse } from 'next/server';
import { dedupe } from '@/lib/pyExec';
import type { CloseResult } from '@/lib/freshMoneyExits';
import {
  buildState, closePositionCore, placeOrderCore, setExitCore, tradeStateVersion, type FreshMoneyTradeState, type OrderBody,
} from '@/lib/freshMoneyTradeServer';

/**
 * REAL MONEY. The Fresh Money board's B / S and × buttons. HTTP only: the rules (contract resolution, lot caps,
 * session gates, holds, close sizing, the ledger) live in lib/freshMoneyTradeServer.ts, shared with the target /
 * stop-loss watcher.
 */

export type { FreshMoneyTradeState };

const IDEMPOTENCY_TTL_MS = 60_000;

let stateCache: { at: number; version: number; body: FreshMoneyTradeState } | null = null;

export async function GET() {
  if (stateCache && Date.now() - stateCache.at < 900 && stateCache.version === tradeStateVersion()) return NextResponse.json(stateCache.body);
  const body = await dedupe('fm-trade-state', buildState);
  stateCache = { at: Date.now(), version: tradeStateVersion(), body };
  return NextResponse.json(body);
}

const idempotent = new Map<string, { at: number; result: Promise<NextResponse> }>();

type Reply =
  | { success: true; order_id: string; note?: string }
  | { success: false; error: string; unknown?: boolean; partial?: boolean };

function reply(r: Reply, status = 200) {
  return NextResponse.json(r, { status: !r.success && r.unknown ? 504 : status });
}

function replyFor(r: CloseResult): NextResponse {
  if (r.kind === 'placed') return reply({ success: true, order_id: r.orderId, ...(r.note ? { note: r.note } : {}) });
  if (r.kind === 'unknown') return reply({ success: false, unknown: true, ...(r.partial ? { partial: true } : {}), error: r.error });
  if (r.kind === 'partial') return reply({ success: false, partial: true, error: r.error });
  return reply({ success: false, error: r.error }, r.http);
}

export async function POST(req: NextRequest) {
  const b = (await req.json().catch(() => null)) as OrderBody | null;
  if (!b) return reply({ success: false, error: 'Invalid JSON body' }, 400);
  const run = async () => {
    if (b.action === 'close') return replyFor(await closePositionCore(typeof b.key === 'string' && b.key ? b.key : `dhan|${String(b.securityId ?? '')}`));
    if (b.action === 'order') return replyFor(await placeOrderCore(b));
    if (b.action === 'setExit') {
      const r = await setExitCore(b);
      return r.ok ? NextResponse.json({ success: true }) : reply({ success: false, error: r.error }, r.http);
    }
    return reply({ success: false, error: 'action must be order, close or setExit' }, 400);
  };

  const key = typeof b.idempotencyKey === 'string' && b.idempotencyKey.length >= 8 && b.idempotencyKey.length <= 64 ? b.idempotencyKey : null;
  if (!key) return run();
  const now = Date.now();
  for (const [k, v] of idempotent) if (now - v.at > IDEMPOTENCY_TTL_MS) idempotent.delete(k);
  const prior = idempotent.get(key);
  if (prior) {
    try { return (await prior.result).clone(); } catch (err) {
      return reply({ success: false, error: `Order route error: ${String((err as Error).message ?? err)}`, unknown: true });
    }
  }
  const result = run();
  idempotent.set(key, { at: now, result });
  try {
    return (await result).clone();
  } catch (err) {
    idempotent.delete(key);
    return reply({ success: false, error: `Order route error: ${String((err as Error).message ?? err)}`, unknown: true });
  }
}
