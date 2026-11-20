import { NextRequest, NextResponse } from 'next/server';
import { gbTrade, parseTrade } from '@/lib/gearboxServer';

// Gearbox Drive orders. REAL MONEY. The browser names only the action (open / exit / reverse), the direction and the decision
// price; contract, strike, lots, broker quantity and the exit size come from the server and the ledger (lib/gearboxCore.ts).

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }); }
  const t = parseTrade(body);
  if (typeof t === 'string') return NextResponse.json({ success: false, error: t }, { status: 400 });
  const r = await gbTrade(t);
  return NextResponse.json(r.body, { status: r.status });
}
