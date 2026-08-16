import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '@/lib/pyExec';

/**
 * The locally cached broker instrument master for one underlying, used to
 * recover strike / expiry / lot size for a position whose broker does not
 * report them (Kotak's positions payload carries none of the three).
 *
 * Files are written by scripts/tools/{kotak,zerodha}_instruments_cache.py.
 * A missing file is `available: false`, not an error — the caller falls back to
 * parsing the trading symbol.
 */

const ALLOWED_BROKERS = new Set(['kotak', 'zerodha']);

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const broker = (searchParams.get('broker') ?? '').toLowerCase();
  const underlying = (searchParams.get('underlying') ?? '').toLowerCase();

  // Both values land in a filesystem path, so they are matched against an
  // allow-list / strict pattern rather than sanitised.
  if (!ALLOWED_BROKERS.has(broker) || !/^[a-z0-9]+$/.test(underlying)) {
    return NextResponse.json({ success: false, error: 'unsupported broker or underlying' }, { status: 400 });
  }

  const file = path.join(PROJECT_ROOT, 'debug', `${broker}_${underlying}_instruments.json`);

  try {
    if (!fs.existsSync(file)) {
      return NextResponse.json({
        success: true,
        available: false,
        reason: `No ${broker} instrument cache for ${underlying.toUpperCase()} — run scripts/tools/${broker}_instruments_cache.py --underlying ${underlying.toUpperCase()}`,
        data: [],
      });
    }
    const rows = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return NextResponse.json(
      { success: true, available: true, data: Array.isArray(rows) ? rows : [] },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    console.error('[/api/options/instruments]', err);
    return NextResponse.json({ success: false, error: 'Could not read instrument cache' }, { status: 500 });
  }
}
