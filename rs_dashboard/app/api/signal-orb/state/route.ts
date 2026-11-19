import { NextRequest, NextResponse } from 'next/server';
import { orbClientOp, orbState } from '@/lib/signalOrbServer';

// Signal Orb ledger: GET = ledger + the contract it trades; POST = one client op (config / mode / engine / log / resetSim / resolve).
// Never a trade: orders go through ./trade. Real-money page: see strategies/signal_orb/strategy.md.

export async function GET(): Promise<NextResponse> {
  const r = orbState();
  return NextResponse.json(r.body, { status: r.status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }); }
  const r = await orbClientOp(body);
  return NextResponse.json(r.body, { status: r.status });
}
