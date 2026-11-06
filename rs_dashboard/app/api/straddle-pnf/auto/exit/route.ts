import { NextRequest, NextResponse } from 'next/server';
import { parseScope } from '@/lib/pnfScope';
import { requestExit } from '@/lib/pnfAutoEngine';

// A manual (or the page's MTM guard) exit of one chart's open AUTO position, sent by the server AUTO engine (lib/pnfAutoEngine.ts) at
// its live price, through the same reserved exit as a rule exit. Real money for a REAL row. It also switches that chart's AUTO off.
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { chart?: unknown; why?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }); }
  const chart = body.chart === 1 || body.chart === 2 ? body.chart : null;
  if (!chart) return NextResponse.json({ success: false, error: 'chart must be 1 or 2' }, { status: 400 });
  const why = typeof body.why === 'string' && /^[a-z ]{1,30}$/.test(body.why) ? body.why : 'manual';
  const r = await requestExit(parseScope(req.nextUrl.searchParams.get('scope')), chart, why);
  return NextResponse.json({ success: r.ok, error: r.error, ...(r.fallback ? { fallback: true } : {}) }, { status: r.ok ? 200 : 409 });
}
