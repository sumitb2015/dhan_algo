import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PYTHON_EXE   = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
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

  const result = spawnSync(
    PYTHON_EXE,
    [
      ANALYZER_SCRIPT, 
      '--underlying', underlying, 
      '--expiry', expiry, 
      '--interval', interval,
      '--supertrend-period', supertrendPeriod,
      '--supertrend-multiplier', supertrendMultiplier,
      '--rsi-period', rsiPeriod,
      '--ema20-period', ema20Period,
      '--ema50-period', ema50Period
    ],
    { encoding: 'utf8', timeout: 45_000, windowsHide: true },
  );

  if (result.error) {
    console.error('[/api/options/analyzer] spawn error:', result.error);
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }

  try {
    const stdout = result.stdout ?? '';
    const jsonLine = stdout.trim().split('\n').pop() ?? '{}';
    const parsed = JSON.parse(jsonLine);

    if (parsed.error) {
      console.error('[/api/options/analyzer] script error:', parsed.error);
      return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    }

    cache.set(cacheKey, { data: parsed, ts: Date.now() });
    return NextResponse.json({ success: true, data: parsed });
  } catch (err) {
    const stderr = (result.stderr ?? '').slice(0, 500);
    console.error('[/api/options/analyzer] parse error:', err, '\nstdout:', result.stdout, '\nstderr:', stderr);
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}
