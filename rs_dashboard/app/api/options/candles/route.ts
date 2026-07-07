import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT  = path.resolve(process.cwd(), '..');
const PYTHON_EXE    = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
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

  const result = spawnSync(
    PYTHON_EXE,
    [CANDLE_SCRIPT, '--expiry', expiry, '--strike', strike, '--interval', interval],
    { encoding: 'utf8', timeout: 45_000, windowsHide: true },
  );

  if (result.error) {
    console.error('[/api/options/candles] spawn error:', result.error);
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }

  try {
    const stdout   = result.stdout ?? '';
    const jsonLine = stdout.trim().split('\n').pop() ?? '{}';
    const parsed   = JSON.parse(jsonLine) as {
      candles?: CandleRow[];
      error?: string;
      data_date?: string;
      is_today?: boolean;
      ce_prev_close?: number;
      pe_prev_close?: number;
    };

    if (parsed.error) {
      console.error('[/api/options/candles]', parsed.error, (result.stderr ?? '').slice(0, 400));
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
    console.error('[/api/options/candles] parse error:', err, '\nstdout:', result.stdout);
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}
