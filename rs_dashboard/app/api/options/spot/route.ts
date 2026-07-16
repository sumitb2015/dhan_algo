import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const FETCH_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_data_fetch.py');
const NIFTY_CSV    = path.join(PROJECT_ROOT, 'Historical Data', 'NIFTY_50_Daily_5Y.csv');

interface CacheEntry { spot: number; prev_close: number; change: number; change_pct: number; ts: number }
const cacheMap = new Map<string, CacheEntry>();
const CACHE_TTL = 12_000; // 12 s — client polls every 15 s, so each poll gets a fresh Python spawn

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

  const cached = cacheMap.get(underlying);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json({
      success: true,
      spot: cached.spot,
      prev_close: cached.prev_close,
      change: cached.change,
      change_pct: cached.change_pct
    }, {
      headers: { 'Cache-Control': 'no-store' }
    });
  }

  // Try live LTP first
  let spot = 0;
  let prev_close = 0;
  let change = 0;
  let change_pct = 0;
  try {
    const parsed = await dedupe(`spot:${underlying}`, () =>
      runPythonJson<{
        spot?: number;
        prev_close?: number;
        change?: number;
        change_pct?: number;
        error?: string;
      }>(FETCH_SCRIPT, ['ltp', '--underlying', underlying], 15_000)
    );
    if (!parsed.error) {
      spot = parsed.spot ?? 0;
      prev_close = parsed.prev_close ?? 0;
      change = parsed.change ?? 0;
      change_pct = parsed.change_pct ?? 0;
    }
  } catch { /* fall through to CSV fallback */ }

  // Fall back to last daily close from NIFTY CSV
  if (spot === 0 && underlying === 'NIFTY') {
    spot = lastCsvClose();
  }

  if (spot === 0) {
    return NextResponse.json({ success: false, error: 'Could not determine spot price' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }

  cacheMap.set(underlying, { spot, prev_close, change, change_pct, ts: Date.now() });
  return NextResponse.json({
    success: true,
    spot,
    prev_close,
    change,
    change_pct
  }, {
    headers: { 'Cache-Control': 'no-store' }
  });
}
