import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const FEED_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'cyber_scalper_feed.py');
const TIMEOUT_MS = 25_000;

const ALLOWED_SYMBOLS = new Set([
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX',
  'CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'GOLD', 'SILVER',
  'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'SBIN', 'TATAMOTORS', 'BHARTIARTL', 'KOTAKBANK', 'ITC'
]);

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const rawSymbol = (searchParams.get('symbol') ?? 'NIFTY').trim().toUpperCase();
  const rawInterval = searchParams.get('interval') ?? '1';
  const expiry = searchParams.get('expiry') ?? '';

  // Basic validation
  const symbol = ALLOWED_SYMBOLS.has(rawSymbol) || /^[A-Z0-9&-]{1,15}$/.test(rawSymbol) ? rawSymbol : 'NIFTY';
  const interval = ['1', '3', '5'].includes(rawInterval) ? rawInterval : '1';

  const args = ['--symbol', symbol, '--interval', interval];
  if (expiry && /^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    args.push('--expiry', expiry);
  }

  const dedupeKey = `cyber-scalper-feed:${symbol}:${interval}:${expiry || 'nearest'}`;

  try {
    const data = await dedupe(dedupeKey, () =>
      runPythonJson<Record<string, unknown>>(FEED_SCRIPT, args, TIMEOUT_MS)
    );

    if (data.error && !data.success) {
      return NextResponse.json({ success: false, error: String(data.error) }, { status: 502 });
    }

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string };
    console.error('[/api/cyber-scalper/feed] error:', e.message, e.stderr ?? '');
    return NextResponse.json(
      { success: false, error: `Feed engine error: ${String(e.message ?? err)}` },
      { status: 500 }
    );
  }
}
