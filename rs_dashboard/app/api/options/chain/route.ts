import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PYTHON_EXE   = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe');
const FETCH_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_data_fetch.py');

interface CacheEntry { data: ChainResponse; ts: number }
interface ChainResponse { chain: Record<string, unknown>; spot: number }

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 10_000; // 10 s

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const underlying = (searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
  const expiry     = searchParams.get('expiry') ?? '';

  if (!expiry) {
    return NextResponse.json({ success: false, error: 'expiry required' }, { status: 400 });
  }

  const cacheKey = `${underlying}:${expiry}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    return NextResponse.json({ success: true, data: hit.data });
  }

  const result = spawnSync(
    PYTHON_EXE,
    [FETCH_SCRIPT, 'chain', '--underlying', underlying, '--expiry', expiry],
    { encoding: 'utf8', timeout: 45_000 },
  );

  if (result.error) {
    console.error('[/api/options/chain] spawn error:', result.error);
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }

  try {
    const stdout = result.stdout ?? '';
    const jsonLine = stdout.trim().split('\n').pop() ?? '{}';
    const parsed = JSON.parse(jsonLine) as { chain?: Record<string, unknown>; spot?: number; error?: string };

    if (parsed.error) {
      const stderr = (result.stderr ?? '').slice(0, 500);
      console.error('[/api/options/chain] script error:', parsed.error, stderr);
      return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    }

    const data: ChainResponse = { chain: parsed.chain ?? {}, spot: parsed.spot ?? 0 };
    cache.set(cacheKey, { data, ts: Date.now() });
    return NextResponse.json({ success: true, data });
  } catch (err) {
    const stderr = (result.stderr ?? '').slice(0, 500);
    console.error('[/api/options/chain] parse error:', err, '\nstdout:', result.stdout, '\nstderr:', stderr);
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}
