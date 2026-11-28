import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { readJsonFile } from '@/lib/lockedJsonFile';

// The /renko page's Backtest panel: the last Renko + Supertrend option-selling backtest, written by
// scripts/analysis/backtest_renko_st_options.py. Read-only; running a backtest stays a terminal command.

const LATEST = path.join(PROJECT_ROOT, 'debug', 'backtests', 'renko_st_options', 'latest.json');

export async function GET(): Promise<NextResponse> {
  if (!fs.existsSync(LATEST)) {
    return NextResponse.json({ result: null, command: 'venv/bin/python scripts/analysis/backtest_renko_st_options.py' });
  }
  const result = readJsonFile<Record<string, unknown>>(LATEST);
  if (!result) return NextResponse.json({ error: 'The saved backtest result could not be read (debug/backtests/renko_st_options/latest.json)' }, { status: 500 });
  return NextResponse.json({ result });
}
