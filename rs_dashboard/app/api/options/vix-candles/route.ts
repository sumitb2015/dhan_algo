import { NextResponse } from 'next/server';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PYTHON_EXE   = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const VIX_SCRIPT   = path.join(PROJECT_ROOT, 'scripts', 'tools', 'india_vix_candles.py');

export interface VixCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  roc5: number | null;
  nifty: number | null;
}

interface VixPayload {
  candles: VixCandle[];
  spot: number;
  day_open: number;
  day_high: number;
  day_low: number;
  prev_close: number;
  data_date: string;
  is_today: boolean;
  nifty_spot?: number;
  nifty_prev_close?: number;
  nifty_change?: number;
  nifty_change_pct?: number;
}

interface CacheEntry { data: VixPayload; ts: number }
let cache: CacheEntry | null = null;
const CACHE_TTL = 55_000; // 55 s — ensures 60s client polls always get a fresh candle

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json({ success: true, ...cache.data });
  }

  const result = spawnSync(
    PYTHON_EXE,
    [VIX_SCRIPT],
    { encoding: 'utf8', timeout: 45_000, windowsHide: true },
  );

  if (result.error) {
    console.error('[/api/options/vix-candles] spawn error:', result.error);
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }

  try {
    const stdout   = result.stdout ?? '';
    const jsonLine = stdout.trim().split('\n').pop() ?? '{}';
    const parsed   = JSON.parse(jsonLine) as VixPayload & { error?: string };

    if (parsed.error) {
      console.error('[/api/options/vix-candles]', parsed.error, (result.stderr ?? '').slice(0, 400));
      return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    }

    cache = { data: parsed, ts: Date.now() };
    return NextResponse.json({ success: true, ...parsed });
  } catch (err) {
    console.error('[/api/options/vix-candles] parse error:', err, '\nstdout:', result.stdout);
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}
