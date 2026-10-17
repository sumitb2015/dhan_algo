import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { writeJsonAtomic } from '@/lib/focusToolRows';
import { isStoredTradeLeg, mergeStoredTrades, type StoredTradeLeg, type TradeRemoval } from '@/lib/optionsMonitorOrders';

// Options Monitor's own placed legs (each with its order record: broker, units placed, product, contract), so the
// page's Exit still knows what it placed after a reload or in another tab. Merged per leg by version
// (lib/optionsMonitorOrders.ts mergeStoredTrades): a stale tab can never roll a leg back. Every write goes through one
// in-process lock, then a temp-file rename (dhan-polling-guards).

const FILE = path.join(PROJECT_ROOT, 'debug', 'options_monitor_trades.json');

function readTrades(): StoredTradeLeg[] {
  try {
    if (!fs.existsSync(FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { legs?: unknown[] };
    return Array.isArray(raw.legs) ? raw.legs.filter(isStoredTradeLeg) : [];
  } catch {
    return [];
  }
}

let lock: Promise<unknown> = Promise.resolve();

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ success: true, legs: readTrades() });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null) as { legs?: unknown[]; removed?: unknown[] } | null;
  if (!body || (!Array.isArray(body.legs) && !Array.isArray(body.removed))) {
    return NextResponse.json({ success: false, error: 'legs or removed array required' }, { status: 400 });
  }
  const incoming = (body.legs ?? []).filter(isStoredTradeLeg);
  const removed = (body.removed ?? []).filter((r): r is TradeRemoval =>
    !!r && typeof (r as TradeRemoval).id === 'string' && typeof (r as TradeRemoval).at === 'number');
  const run = lock.then(() => {
    const next = mergeStoredTrades(readTrades(), incoming, removed);
    writeJsonAtomic(FILE, { legs: next, updatedAt: new Date().toISOString() });
    return next;
  });
  lock = run.catch(() => undefined);
  try {
    return NextResponse.json({ success: true, legs: await run });
  } catch (err) {
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
