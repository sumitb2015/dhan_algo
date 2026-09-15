import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { runPythonJson, dedupe, PROJECT_ROOT } from '@/lib/pyExec';

const FUTURES_API_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'futures_api.py');

interface ExpiriesResponse {
  success: boolean;
  data?: { symbol: string; expiries: string[] };
  error?: string;
}

// ─── GET: List tradeable futures contract expiries (current + next 2 months) ──

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol')?.trim().toUpperCase();

  if (!symbol) {
    return NextResponse.json({ success: false, error: 'Missing required symbol param' }, { status: 400 });
  }

  try {
    const res = await dedupe(`futures-expiries:${symbol}`, () =>
      runPythonJson<ExpiriesResponse>(FUTURES_API_SCRIPT, ['list-expiries', '--underlying', symbol], 10_000)
    );
    return NextResponse.json(res);
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Failed to list expiries' },
      { status: 500 }
    );
  }
}
