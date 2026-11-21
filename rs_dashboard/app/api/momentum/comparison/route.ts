import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { DEBUG_DIR, PROJECT_ROOT } from '@/lib/strategyRegistry';
import { PYTHON_EXE } from '@/lib/pyExec';
import { readJsonFile } from '@/lib/lockedJsonFile';

const execFileAsync = promisify(execFile);
const RESULTS_FILE = path.join(DEBUG_DIR, 'strategy_comparison_results.json');

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const force = sp.get('force') === 'true';

    if (!force && fs.existsSync(RESULTS_FILE)) {
      const data = readJsonFile(RESULTS_FILE);
      if (data && Array.isArray(data) && data.length > 0) {
        return NextResponse.json({ success: true, results: data });
      }
    }

    // Run benchmark if not cached or forced
    const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'analysis', 'backtest_strategy_comparison.py');
    await execFileAsync(PYTHON_EXE, [scriptPath], {
      cwd: PROJECT_ROOT,
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
    });

    if (fs.existsSync(RESULTS_FILE)) {
      const data = readJsonFile(RESULTS_FILE);
      if (data) return NextResponse.json({ success: true, results: data });
    }

    return NextResponse.json(
      { success: false, error: 'Benchmark comparison was not generated.' },
      { status: 500 }
    );
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
