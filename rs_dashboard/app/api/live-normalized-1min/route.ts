import { NextResponse } from 'next/server';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PYTHON_EXE    = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const SCRIPT_PATH   = path.join(PROJECT_ROOT, 'scripts', 'tools', 'normalized_1min_candles.py');

interface CandlePoint { time: string; close: number; pct: number }
interface ApiPayload {
  success: boolean;
  data_date?: string;
  is_today?: boolean;
  series?: Record<string, CandlePoint[]>;
  errors?: Record<string, string>;
  error?: string;
}
interface CacheEntry {
  data: ApiPayload;
  ts: number;
}

const cacheHolder: { entry: CacheEntry | null } = { entry: null };
const CACHE_TTL = 45_000;

export async function GET() {
  if (cacheHolder.entry && Date.now() - cacheHolder.entry.ts < CACHE_TTL) {
    return NextResponse.json(cacheHolder.entry.data);
  }

  const result = spawnSync(PYTHON_EXE, [SCRIPT_PATH], {
    encoding: 'utf8',
    timeout: 45_000,
    windowsHide: true,
  });

  if (result.error) {
    console.error('[/api/live-normalized-1min] spawn error:', result.error);
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }

  try {
    const stdout   = result.stdout ?? '';
    const jsonLine = stdout.trim().split('\n').pop() ?? '{}';
    const parsed   = JSON.parse(jsonLine) as ApiPayload;

    if (!parsed.success) {
      console.error('[/api/live-normalized-1min]', parsed.error, (result.stderr ?? '').slice(0, 400));
      return NextResponse.json(parsed, { status: 500 });
    }

    cacheHolder.entry = { data: parsed, ts: Date.now() };
    return NextResponse.json(parsed);
  } catch (err) {
    console.error('[/api/live-normalized-1min] parse error:', err, '\nstdout:', result.stdout);
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}
