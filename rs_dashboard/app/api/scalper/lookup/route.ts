import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const SCALPER_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'scalper_api.py');

interface StrikeLookup { ceId?: string; peId?: string }
interface LookupData   { lotSize: number; strikes: Record<string, StrikeLookup> }
interface CacheEntry   { data: LookupData; ts: number }

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours — strike IDs don't change intraday

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const underlying = (searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
  const expiry     = searchParams.get('expiry') ?? '';

  if (!expiry) {
    return NextResponse.json({ success: false, error: 'expiry required' }, { status: 400 });
  }

  const key = `${underlying}:${expiry}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    return NextResponse.json({ success: true, data: hit.data });
  }

  try {
    const parsed = await dedupe(`scalper-lookup:${key}`, () =>
      runPythonJson<{ success: boolean; data?: LookupData; error?: string }>(
        SCALPER_SCRIPT,
        ['lookup', '--underlying', underlying, '--expiry', expiry],
        30_000,
      ),
    );
    if (parsed.success && parsed.data) {
      cache.set(key, { data: parsed.data, ts: Date.now() });
    }
    return NextResponse.json(parsed);
  } catch (err) {
    console.error('[scalper/lookup] error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
