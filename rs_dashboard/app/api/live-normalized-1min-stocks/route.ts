import { NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'tools', 'normalized_1min_stocks.py');

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

  try {
    const parsed = await dedupe('live-normalized-1min-stocks', () =>
      runPythonJson<ApiPayload>(SCRIPT_PATH, [], 45_000),
    );

    if (!parsed.success) {
      console.error('[/api/live-normalized-1min-stocks]', parsed.error);
      return NextResponse.json(parsed, { status: 500 });
    }

    cacheHolder.entry = { data: parsed, ts: Date.now() };
    return NextResponse.json(parsed);
  } catch (err) {
    console.error('[/api/live-normalized-1min-stocks] error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
