import { NextRequest, NextResponse } from 'next/server';
import { MCX_LOT_MULTIPLIER } from '@/lib/positionPnl';
import { spotInstrument, wsPrice, wsSync, wsWant } from '@/lib/freshMoneyWs';

// The board's live spot from Dhan's WebSocket (lib/freshMoneyWs.ts): an MCX option month's own futures, or the index.
// Polled every ~2 s by the page; each call keeps the subscription asked for. Read-only. `spot` null = no fresh WebSocket
// price yet (bridge starting, hub down, market shut): the page keeps the snapshot's spot and says so.

const UNDERLYINGS = new Set(['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'CRUDEOILM']);

export interface FreshMoneyLive {
  underlying: string;
  spot: number | null;
  /** When the price last changed (ms), null when it has not changed since we subscribed. */
  changedMs: number | null;
  instrument: string | null;
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const underlying = (sp.get('underlying') ?? '').toUpperCase();
  const expiry = sp.get('expiry') ?? '';
  if (!UNDERLYINGS.has(underlying) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    return NextResponse.json({ error: 'underlying and expiry (YYYY-MM-DD) are required' }, { status: 400 });
  }
  const inst = spotInstrument(underlying, expiry, MCX_LOT_MULTIPLIER[underlying] !== undefined);
  if (!inst) return NextResponse.json({ underlying, spot: null, changedMs: null, instrument: null } satisfies FreshMoneyLive);
  const key = wsWant(inst.segment, inst.securityId);
  wsSync();
  const q = wsPrice(key);
  return NextResponse.json({ underlying, spot: q?.ltp ?? null, changedMs: q?.changedMs ?? null, instrument: key } satisfies FreshMoneyLive);
}
