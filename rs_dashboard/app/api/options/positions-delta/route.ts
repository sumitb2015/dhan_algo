import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { PROJECT_ROOT, PYTHON_EXE } from '@/lib/pyExec';

const execFileAsync = promisify(execFile);

const PYTHON_SYNC  = PYTHON_EXE;
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
    const { stdout } = await execFileAsync(PYTHON_SYNC, [SCRIPT_PATH], {
      timeout: 25000,
      encoding: 'utf8',
      cwd: PROJECT_ROOT,
    });

    const lastLine = (stdout || '').trim().split('\n').pop() ?? '{}';
    const parsed = JSON.parse(lastLine) as PositionDeltaResponse;

    cacheEntry = {
      data: parsed,
      ts: Date.now()
    };

    return NextResponse.json(parsed);
  } catch (err: unknown) {
    const e = err as { stdout?: string; message?: string; stderr?: string };
    if (e.stdout) {
      try {
        const lastLine = String(e.stdout).trim().split('\n').pop() ?? '{}';
        const parsed = JSON.parse(lastLine) as PositionDeltaResponse;
        cacheEntry = { data: parsed, ts: Date.now() };
        return NextResponse.json(parsed);
      } catch {}
    }
    console.error('[positions-delta] positions_delta_data.py error:', e.message, e.stderr ?? '');
    return NextResponse.json({
      has_positions: false,
      net_delta: 0,
      net_lot_delta: 0,
      legs: [],
      timestamp: new Date().toISOString(),
      error: 'script_error'
    }, { status: 500 });
  }
}
