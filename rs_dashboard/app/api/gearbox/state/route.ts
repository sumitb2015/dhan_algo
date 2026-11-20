import { NextRequest, NextResponse } from 'next/server';
import { gbClientOp, gbState } from '@/lib/gearboxServer';

// Gearbox Drive ledger: GET = ledger + the future and the option each button would trade now, server prices, caps, MCX session;
// POST = one client op (setConfig / setMode / resolve). Never a trade: orders go through ./trade.

export async function GET(): Promise<NextResponse> {
  const r = gbState();
  return NextResponse.json(r.body, { status: r.status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }); }
  const r = await gbClientOp(body);
  return NextResponse.json(r.body, { status: r.status });
}
