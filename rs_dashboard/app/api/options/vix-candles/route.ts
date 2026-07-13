import { NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const VIX_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'india_vix_candles.py');

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

  try {
    const parsed = await dedupe('vix-candles', () =>
      runPythonJson<VixPayload & { error?: string }>(VIX_SCRIPT, [], 45_000)
    );

    if (parsed.error) {
      console.error('[/api/options/vix-candles]', parsed.error);
      return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    }

    cache = { data: parsed, ts: Date.now() };
    return NextResponse.json({ success: true, ...parsed });
  } catch (err) {
    console.error('[/api/options/vix-candles] error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
