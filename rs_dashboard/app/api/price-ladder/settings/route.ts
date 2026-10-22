import { NextRequest, NextResponse } from 'next/server';
import { readLadderSettings } from '@/lib/priceLadderSettings';
import { setMcxCutoff } from '@/lib/priceLadderCutoff';

export async function GET() {
  const settings = readLadderSettings();
  return NextResponse.json({ success: true, settings });
}

/** The MCX trading cutoff (lib/priceLadderCutoff.ts: range check; a time already passed needs `confirmPast`). */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }
  const r = await setMcxCutoff(body.mcxAutoExitTime, body.confirmPast === true);
  if (!r.ok) return NextResponse.json({ success: false, error: r.error, ...(r.needsConfirm ? { needsConfirm: true } : {}) }, { status: r.status });
  return NextResponse.json({ success: true, settings: r.settings });
}
