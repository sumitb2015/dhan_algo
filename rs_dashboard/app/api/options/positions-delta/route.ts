import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PYTHON_SYNC  = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe');
const SCRIPT_PATH  = path.join(PROJECT_ROOT, 'scripts', 'tools', 'positions_delta_data.py');

interface PositionDeltaResponse {
  has_positions: boolean;
  net_delta: number;
  net_lot_delta: number;
  legs: Array<any>;
  timestamp: string;
  error?: string;
}

interface CacheEntry {
  data: PositionDeltaResponse;
  ts: number;
}

let cacheEntry: CacheEntry | null = null;
const CACHE_TTL = 2000; // 2 seconds

export async function GET(request: NextRequest) {
  // Respect API rate limits using a simple 2-second cache
  if (cacheEntry && Date.now() - cacheEntry.ts < CACHE_TTL) {
    return NextResponse.json(cacheEntry.data);
  }

  try {
    const result = spawnSync(PYTHON_SYNC, [SCRIPT_PATH], {
      timeout: 25000,
      encoding: 'utf8',
      cwd: PROJECT_ROOT,
    });

    if (result.error || result.status !== 0) {
      if (result.stderr) console.error('[positions-delta] positions_delta_data.py stderr:', result.stderr);
      return NextResponse.json({
        has_positions: false,
        net_delta: 0,
        net_lot_delta: 0,
        legs: [],
        timestamp: new Date().toISOString(),
        error: 'script_error'
      }, { status: 500 });
    }

    const lastLine = (result.stdout || '').trim().split('\n').pop() ?? '{}';
    const parsed = JSON.parse(lastLine) as PositionDeltaResponse;

    cacheEntry = {
      data: parsed,
      ts: Date.now()
    };

    return NextResponse.json(parsed);
  } catch (err) {
    console.error('[positions-delta] Exception in API route:', err);
    return NextResponse.json({
      has_positions: false,
      net_delta: 0,
      net_lot_delta: 0,
      legs: [],
      timestamp: new Date().toISOString(),
      error: 'parse_error'
    }, { status: 500 });
  }
}
