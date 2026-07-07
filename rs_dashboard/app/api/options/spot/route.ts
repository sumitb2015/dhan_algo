import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PYTHON_EXE   = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const FETCH_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_data_fetch.py');
const NIFTY_CSV    = path.join(PROJECT_ROOT, 'Historical Data', 'NIFTY_50_Daily_5Y.csv');

let cache: { spot: number; prev_close: number; change: number; change_pct: number; ts: number } | null = null;
const CACHE_TTL = 5_000; // 5 s

function lastCsvClose(): number {
  try {
    const buf = Buffer.alloc(512);
    const fd  = fs.openSync(NIFTY_CSV, 'r');
    const size = fs.fstatSync(fd).size;
    fs.readSync(fd, buf, 0, 512, Math.max(0, size - 512));
    fs.closeSync(fd);
    const lines = buf.toString('utf8').trim().split('\n');
    const last  = lines[lines.length - 1].split(',');
    // CSV: date,open,high,low,close,volume  — close is index 4
    const close = parseFloat(last[4]);
    return isNaN(close) ? 0 : close;
  } catch {
    return 0;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const underlying = (searchParams.get('underlying') ?? 'NIFTY').toUpperCase();

  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json({
      success: true,
      spot: cache.spot,
      prev_close: cache.prev_close,
      change: cache.change,
      change_pct: cache.change_pct
    });
  }

  // Try live LTP first
  const result = spawnSync(
    PYTHON_EXE,
    [FETCH_SCRIPT, 'ltp', '--underlying', underlying],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true },
  );

  let spot = 0;
  let prev_close = 0;
  let change = 0;
  let change_pct = 0;
  if (!result.error) {
    try {
      const jsonLine = (result.stdout ?? '').trim().split('\n').pop() ?? '{}';
      const parsed = JSON.parse(jsonLine) as {
        spot?: number;
        prev_close?: number;
        change?: number;
        change_pct?: number;
        error?: string;
      };
      if (!parsed.error) {
        spot = parsed.spot ?? 0;
        prev_close = parsed.prev_close ?? 0;
        change = parsed.change ?? 0;
        change_pct = parsed.change_pct ?? 0;
      }
    } catch { /* ignore */ }
  }

  // Fall back to last daily close from NIFTY CSV
  if (spot === 0 && underlying === 'NIFTY') {
    spot = lastCsvClose();
  }

  if (spot === 0) {
    return NextResponse.json({ success: false, error: 'Could not determine spot price' }, { status: 500 });
  }

  cache = { spot, prev_close, change, change_pct, ts: Date.now() };
  return NextResponse.json({
    success: true,
    spot,
    prev_close,
    change,
    change_pct
  });
}
