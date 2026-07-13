import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PYTHON_EXE   = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
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

  try {
    const { stdout } = await execFileAsync(
      PYTHON_EXE,
      [FETCH_SCRIPT, 'chain', '--underlying', underlying, '--expiry', expiry],
      { encoding: 'utf8', timeout: 45_000, windowsHide: true },
    );

    const jsonLine = (stdout ?? '').trim().split('\n').pop() ?? '{}';
    const parsed = JSON.parse(jsonLine) as { chain?: Record<string, unknown>; spot?: number; error?: string };

    if (parsed.error) {
      console.error('[/api/options/chain] script error:', parsed.error);
      return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    }

    const data: ChainResponse = { chain: parsed.chain ?? {}, spot: parsed.spot ?? 0 };
    cache.set(cacheKey, { data, ts: Date.now() });
    return NextResponse.json({ success: true, data });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    if (e.stdout) {
      try {
        const jsonLine = String(e.stdout).trim().split('\n').pop() ?? '{}';
        const parsed = JSON.parse(jsonLine) as { chain?: Record<string, unknown>; spot?: number; error?: string };
        if (!parsed.error) {
          const data: ChainResponse = { chain: parsed.chain ?? {}, spot: parsed.spot ?? 0 };
          cache.set(cacheKey, { data, ts: Date.now() });
          return NextResponse.json({ success: true, data });
        }
      } catch {}
    }
    console.error('[/api/options/chain] error:', e.message, e.stderr ?? '');
    return NextResponse.json({ success: false, error: `Script error: ${String(e.message)}` }, { status: 500 });
  }
}
