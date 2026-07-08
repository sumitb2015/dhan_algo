import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PYTHON_EXE   = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const FETCH_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_data_fetch.py');

const cache = new Map<string, { data: string[]; ts: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Today's date in IST, as YYYY-MM-DD — used to both scope the cache key
// (so a stale entry can never survive a day rollover) and to filter out
// any already-lapsed expiry dates the broker/cache might still hand back.
function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const underlying = (searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
  const today = todayIST();
  const cacheKey = `${underlying}:${today}`;

  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    return NextResponse.json({ success: true, data: hit.data });
  }

  const result = spawnSync(
    PYTHON_EXE,
    [FETCH_SCRIPT, 'expiries', '--underlying', underlying],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true },
  );

  if (result.error) {
    console.error('[/api/options/expiries] spawn error:', result.error);
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }

  try {
    // Script prints one JSON line to stdout; Python/DhanHelper logs go to stderr.
    const stdout = result.stdout ?? '';
    const jsonLine = stdout.trim().split('\n').pop() ?? '{}';
    const parsed = JSON.parse(jsonLine) as { expiries?: string[]; error?: string };

    if (parsed.error) {
      const stderr = (result.stderr ?? '').slice(0, 500);
      console.error('[/api/options/expiries] script error:', parsed.error, stderr);
      return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    }

    const expiries = (parsed.expiries ?? []).filter((d) => d >= today);
    if (expiries.length) cache.set(cacheKey, { data: expiries, ts: Date.now() });
    return NextResponse.json({ success: true, data: expiries });
  } catch (err) {
    const stderr = (result.stderr ?? '').slice(0, 500);
    console.error('[/api/options/expiries] parse error:', err, '\nstdout:', result.stdout, '\nstderr:', stderr);
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}
