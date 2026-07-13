import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const ANALYZER_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_analyzer.py');

interface CacheEntry { data: any; ts: number }

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 15_000; // 15 seconds cache

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const underlying = (searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
  const expiry     = searchParams.get('expiry') ?? '';
  const interval   = searchParams.get('interval') ?? '15';

  const supertrendPeriod     = searchParams.get('supertrendPeriod') ?? '7';
  const supertrendMultiplier = searchParams.get('supertrendMultiplier') ?? '3.0';
  const rsiPeriod            = searchParams.get('rsiPeriod') ?? '14';
  const ema20Period          = searchParams.get('ema20Period') ?? '20';
  const ema50Period          = searchParams.get('ema50Period') ?? '50';

  if (!expiry) {
    return NextResponse.json({ success: false, error: 'expiry required' }, { status: 400 });
  }

  const cacheKey = `${underlying}:${expiry}:${interval}:${supertrendPeriod}:${supertrendMultiplier}:${rsiPeriod}:${ema20Period}:${ema50Period}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    return NextResponse.json({ success: true, data: hit.data });
  }

  try {
    const parsed = await dedupe(`analyzer:${cacheKey}`, () =>
      runPythonJson<{ error?: string } & Record<string, unknown>>(
        ANALYZER_SCRIPT,
        [
          '--underlying', underlying,
          '--expiry', expiry,
          '--interval', interval,
          '--supertrend-period', supertrendPeriod,
          '--supertrend-multiplier', supertrendMultiplier,
          '--rsi-period', rsiPeriod,
          '--ema20-period', ema20Period,
          '--ema50-period', ema50Period
        ],
        45_000
      )
    );

    if (parsed.error) {
      console.error('[/api/options/analyzer] script error:', parsed.error);
      return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    }

    cache.set(cacheKey, { data: parsed, ts: Date.now() });
    return NextResponse.json({ success: true, data: parsed });
  } catch (err) {
    console.error('[/api/options/analyzer] error:', err);
    return NextResponse.json({ success: false, error: `${String(err)}` }, { status: 500 });
  }
}
