import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PROJECT_ROOT, PYTHON_EXE, dedupe, spaced } from '@/lib/pyExec';

const execFileAsync = promisify(execFile);
const FETCH_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_data_fetch.py');

export interface VolSurfaceExpiryMeta {
  expiry: string;
  dte: number;
  atm_strike: number;
  atm_iv: number;
  // null when no strike in the fetched window landed close enough to ±0.25 delta
  // to be a genuine 25-delta point (see DELTA_TOLERANCE in options_data_fetch.py).
  rr_25d: number | null;
  p25_iv: number | null;
  c25_iv: number | null;
  pcr: number;
  total_oi: number;
  synthetic_points: number;
}

export interface VolSurfaceData {
  underlying: string;
  spot: number;
  prev_close: number;
  change: number;
  change_pct: number;
  strikes: number[];
  expiries: VolSurfaceExpiryMeta[];
  surface: number[][];       // rows = expiries, cols = strikes (composite OTM IV %)
  ce_surface: number[][];    // call IVs
  pe_surface: number[][];    // put IVs
  delta_surface: number[][]; // normalized delta (-1 to +1)
  has_synthetic_data: boolean; // true if any surface point had no real IV and was filled in
  term_structure: {
    front_iv: number;
    back_iv: number;
    spread: number;
    regime: 'BACKWARDATION' | 'CONTANGO' | 'FLAT';
    regime_label: string;
    regime_desc: string;
    calendar_play: string;
  };
  cached_at?: number;
  requested_count?: number;
  requested_window_pct?: number;
}

interface CacheEntry {
  data: VolSurfaceData;
  ts: number;
}

/** Reads the on-disk fallback snapshot and flags whether it matches the params just requested. */
function readFallback(
  debugFile: string,
  count: number,
  windowPct: number,
): { data: VolSurfaceData; paramsMismatch: boolean } | null {
  if (!fs.existsSync(debugFile)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(debugFile, 'utf8')) as VolSurfaceData;
    const paramsMismatch =
      data.requested_count !== count || data.requested_window_pct !== windowPct;
    return { data, paramsMismatch };
  } catch {
    return null;
  }
}

const memCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000; // 30 seconds memory cache

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const underlying = (searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
  const countStr = searchParams.get('count') ?? '5';
  const count = Math.max(2, Math.min(parseInt(countStr, 10) || 5, 8));
  const windowPctStr = searchParams.get('window_pct') ?? '8.0';
  const windowPct = Math.max(3, Math.min(parseFloat(windowPctStr) || 8.0, 20.0));

  const cacheKey = `${underlying}:${count}:${windowPct}`;
  const hit = memCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    return NextResponse.json({ success: true, data: hit.data }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const debugFile = path.join(PROJECT_ROOT, 'debug', `volsurface_${underlying.toLowerCase()}.json`);

  try {
    const { stdout } = await dedupe(`volsurface:${cacheKey}`, () =>
      spaced(`dhan-spawn:${underlying}`, () =>
        execFileAsync(
          PYTHON_EXE,
          [
            FETCH_SCRIPT,
            'volsurface',
            '--underlying', underlying,
            '--count', String(count),
            '--window-pct', String(windowPct),
          ],
          { encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
        ),
      ),
    );

    const jsonLine = (stdout ?? '').trim().split('\n').pop() ?? '{}';
    const parsed = JSON.parse(jsonLine) as (VolSurfaceData & { error?: string });

    if (parsed.error) {
      console.error('[/api/options/volatility-surface] Python error:', parsed.error);
      // Fall back to disk snapshot if available
      const fallback = readFallback(debugFile, count, windowPct);
      if (fallback) {
        return NextResponse.json({
          success: true,
          data: fallback.data,
          fallback: true,
          paramsMismatch: fallback.paramsMismatch,
        });
      }
      return NextResponse.json({ success: false, error: parsed.error }, { status: 502 });
    }

    if (!parsed.surface || !parsed.surface.length || !parsed.strikes || !parsed.strikes.length) {
      const fallback = readFallback(debugFile, count, windowPct);
      if (fallback) {
        return NextResponse.json({
          success: true,
          data: fallback.data,
          fallback: true,
          paramsMismatch: fallback.paramsMismatch,
        });
      }
      return NextResponse.json(
        { success: false, error: 'Empty volatility surface from Dhan API' },
        { status: 502 },
      );
    }

    const resultData: VolSurfaceData = {
      ...parsed,
      cached_at: Date.now(),
      requested_count: count,
      requested_window_pct: windowPct,
    };

    memCache.set(cacheKey, { data: resultData, ts: Date.now() });

    // Persist snapshot to debug folder
    try {
      fs.writeFileSync(debugFile, JSON.stringify(resultData, null, 2), 'utf8');
    } catch (e) {
      console.warn('[/api/options/volatility-surface] Could not write debug cache file:', e);
    }

    return NextResponse.json({ success: true, data: resultData }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    console.error('[/api/options/volatility-surface] Execution error:', e.message);

    // Fall back to debug snapshot if exists
    const fallback = readFallback(debugFile, count, windowPct);
    if (fallback) {
      return NextResponse.json({
        success: true,
        data: fallback.data,
        fallback: true,
        paramsMismatch: fallback.paramsMismatch,
      });
    }

    return NextResponse.json(
      { success: false, error: `Vol surface error: ${String(e.message)}` },
      { status: 500 },
    );
  }
}
