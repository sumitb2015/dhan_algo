import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const CANDLE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_straddle_candles.py');

interface CandleRow { time: string; 'CE LTP': number; 'PE LTP': number; Straddle: number; 'CE Vol'?: number; 'PE Vol'?: number; 'CE OI'?: number; 'PE OI'?: number }
interface CacheEntry {
  data: CandleRow[];
  ts: number;
  dataDate?: string;
  isToday?: boolean;
  ce_prev_close?: number;
  pe_prev_close?: number;
}

// Short TTL: stale after 60 s during market hours
const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 60_000;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const expiry   = searchParams.get('expiry')   ?? '';
  const strike   = searchParams.get('strike')   ?? '';
  const interval = searchParams.get('interval') ?? '1';

  if (!expiry || !strike) {
    return NextResponse.json({ success: false, error: 'expiry and strike required' }, { status: 400 });
  }

  const cacheKey = `${expiry}:${strike}:${interval}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    return NextResponse.json({
      success: true,
      data: hit.data,
      dataDate: hit.dataDate,
      isToday: hit.isToday,
      ce_prev_close: hit.ce_prev_close,
      pe_prev_close: hit.pe_prev_close
    });
  }

  try {
    const parsed = await dedupe(`candles:${cacheKey}`, () =>
      runPythonJson<{
        candles?: CandleRow[];
        error?: string;
        data_date?: string;
        is_today?: boolean;
        ce_prev_close?: number;
        pe_prev_close?: number;
      }>(CANDLE_SCRIPT, ['--expiry', expiry, '--strike', strike, '--interval', interval], 45_000)
    );

    if (parsed.error) {
      console.error('[/api/options/candles]', parsed.error);
      return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    }

    const candles  = parsed.candles ?? [];
    const dataDate = parsed.data_date;
    const isToday  = parsed.is_today ?? false;

    if (candles.length) {
      cache.set(cacheKey, {
        data: candles,
        ts: Date.now(),
        dataDate,
        isToday,
        ce_prev_close: parsed.ce_prev_close,
        pe_prev_close: parsed.pe_prev_close
      });
    }
    return NextResponse.json({
      success: true,
      data: candles,
      dataDate,
      isToday,
      ce_prev_close: parsed.ce_prev_close,
      pe_prev_close: parsed.pe_prev_close
    });
  } catch (err) {
    console.error('[/api/options/candles] error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
