import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'csp_watchlist.py');

interface StrikeRow {
  strike: number;
  ltp: number;
  oi: number;
  iv: number;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbol = (searchParams.get('symbol') ?? '').toUpperCase();
  const expiry = searchParams.get('expiry') ?? '';
  if (!symbol || !expiry) {
    return NextResponse.json({ success: false, error: 'symbol and expiry are required' }, { status: 400 });
  }

  try {
    const parsed = await dedupe(`csp-chain-${symbol}-${expiry}`, () =>
      runPythonJson<{ success: boolean; strikes?: StrikeRow[]; error?: string }>(
        SCRIPT,
        ['chain', '--symbol', symbol, '--expiry', expiry],
        30_000
      )
    );
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error ?? 'Unknown error' }, { status: 500 });
    }
    return NextResponse.json({ success: true, strikes: parsed.strikes ?? [] });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
