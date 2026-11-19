import { NextRequest, NextResponse } from 'next/server';
import { orbTrade, parseTrade } from '@/lib/signalOrbServer';

// Signal Orb orders. REAL MONEY. The browser names only the action (enter / exit / reverse), the side and the decision price;
// contract, lots, broker quantity and the exit size come from the ledger and the broker's own lot (lib/signalOrbServer.ts).

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }); }
  const t = parseTrade(body);
  if (typeof t === 'string') return NextResponse.json({ success: false, error: t }, { status: 400 });
  const r = await orbTrade(t);
  return NextResponse.json(r.body, { status: r.status });
}
