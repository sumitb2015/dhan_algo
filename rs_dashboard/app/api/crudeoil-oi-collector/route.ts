import { NextRequest, NextResponse } from 'next/server';
import { collectorStatus, parseCrudeUnderlying, startCollector, stopCollector } from '@/lib/crudeCollector';

// Start / stop / status of the MCX OI collector, one per underlying (CRUDEOIL, CRUDEOILM; absent = CRUDEOIL, the original
// behaviour). The logic lives in lib/crudeCollector.ts, shared with the server's auto-start scheduler: the dashboard
// starts both collectors for the MCX session by itself; Stop keeps one off for the rest of the day, Start brings it back.

/** GET — collector status (PID cross-checked to detect crashes) */
export async function GET(request: NextRequest) {
  const u = parseCrudeUnderlying(new URL(request.url).searchParams.get('underlying'));
  if (!u) return NextResponse.json({ success: false, error: 'underlying must be CRUDEOIL or CRUDEOILM' }, { status: 400 });
  return NextResponse.json({ success: true, status: collectorStatus(u) });
}

/** POST — {action: 'start' | 'stop', underlying} */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as { action?: string; underlying?: string };
  const u = parseCrudeUnderlying(body.underlying);
  if (!u) return NextResponse.json({ success: false, error: 'underlying must be CRUDEOIL or CRUDEOILM' }, { status: 400 });
  if (body.action === 'stop') {
    stopCollector(u);
    return NextResponse.json({ success: true, message: 'Stop trigger written — it stays off for today unless started again' });
  }
  if (body.action === 'start') {
    const r = startCollector(u, true);
    return NextResponse.json({ success: true, message: r.message, ...(r.pid ? { pid: r.pid } : {}) });
  }
  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
