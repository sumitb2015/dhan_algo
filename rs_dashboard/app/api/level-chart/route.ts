import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'tools', 'level_chart_fetch.py');

export type SymbolType = 'equity' | 'index' | 'crudeoil' | 'crudeoilm';

export interface LevelCandle { time: string; open: number; high: number; low: number; close: number }
export interface LevelBucket { start: string; end: string; high: number; low: number; mid: number; closed: boolean }
export type IndicatorSeries = { time: string; value: number }[];
// One point per bar with its trend direction — the frontend splits this into one LineSeries per
// contiguous same-direction run (see LevelChart.tsx) rather than two up/down series sharing a
// time axis, because lightweight-charts' LineSeries does not actually break at a whitespace
// (value-omitted) point; it just skips it and connects the surrounding real points directly.
export type SupertrendSeries = { time: string; value: number; direction: 1 | -1 }[];
export interface LevelChartIndicators {
  vwap: IndicatorSeries;
  ema20: IndicatorSeries;
  ema50: IndicatorSeries;
  supertrend: SupertrendSeries;
}
export interface PrevDayLevels { high: number; low: number; close: number }

interface ScriptPayload {
  dataDate?: string;
  candles?: LevelCandle[];
  levelBuckets?: LevelBucket[];
  indicators?: LevelChartIndicators;
  prevDayLevels?: PrevDayLevels | null;
  error?: string;
}
interface CacheEntry {
  dataDate?: string;
  candles: LevelCandle[];
  levelBuckets: LevelBucket[];
  indicators?: LevelChartIndicators;
  prevDayLevels?: PrevDayLevels | null;
  ts: number;
}

// Short TTL, matched to the fastest selectable poll interval (see LevelChartPage.tsx's
// POLL_OPTIONS) — a longer cache would mean a 5s poll keeps re-showing the same stale response.
const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 5_000;

const SYMBOL_TYPES: SymbolType[] = ['equity', 'index', 'crudeoil', 'crudeoilm'];

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbolType = searchParams.get('symbolType') ?? '';
  const symbol = searchParams.get('symbol') ?? '';
  const chartInterval = searchParams.get('chartInterval') ?? '';
  const levelInterval = searchParams.get('levelInterval') ?? '';
  const emaFast = searchParams.get('emaFast') ?? '20';
  const emaSlow = searchParams.get('emaSlow') ?? '50';
  const stLength = searchParams.get('stLength') ?? '10';
  const stMultiplier = searchParams.get('stMultiplier') ?? '3';

  if (!SYMBOL_TYPES.includes(symbolType as SymbolType) || !symbol || !chartInterval || !levelInterval) {
    return NextResponse.json({ success: false, error: 'symbolType, symbol, chartInterval and levelInterval are required' }, { status: 400 });
  }

  const cacheKey = `${symbolType}:${symbol}:${chartInterval}:${levelInterval}:${emaFast}:${emaSlow}:${stLength}:${stMultiplier}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    return NextResponse.json({
      success: true, dataDate: hit.dataDate, candles: hit.candles, levelBuckets: hit.levelBuckets,
      indicators: hit.indicators, prevDayLevels: hit.prevDayLevels,
    });
  }

  try {
    const parsed = await dedupe(`level-chart:${cacheKey}`, () =>
      runPythonJson<ScriptPayload>(
        SCRIPT_PATH,
        [
          '--symbol-type', symbolType,
          '--symbol', symbol,
          '--chart-interval', chartInterval,
          '--level-interval', levelInterval,
          '--ema-fast', emaFast,
          '--ema-slow', emaSlow,
          '--st-length', stLength,
          '--st-multiplier', stMultiplier,
        ],
        30_000,
      ),
    );

    if (parsed.error) {
      console.error('[/api/level-chart]', parsed.error);
      return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    }

    const candles = parsed.candles ?? [];
    const levelBuckets = parsed.levelBuckets ?? [];
    const dataDate = parsed.dataDate;
    const indicators = parsed.indicators;
    const prevDayLevels = parsed.prevDayLevels ?? null;

    if (candles.length) {
      cache.set(cacheKey, { dataDate, candles, levelBuckets, indicators, prevDayLevels, ts: Date.now() });
    }
    return NextResponse.json({ success: true, dataDate, candles, levelBuckets, indicators, prevDayLevels });
  } catch (err) {
    console.error('[/api/level-chart] error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
