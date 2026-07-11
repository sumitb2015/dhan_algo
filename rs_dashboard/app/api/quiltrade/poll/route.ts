import { NextResponse } from 'next/server';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const PYTHON_EXE     = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const SCALPER_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'scalper_api.py');

const NIFTY_PREFIX = /^NIFTY-/i;

function isNiftyRow(row: Record<string, unknown>): boolean {
  const sym = String(row.tradingSymbol ?? '');
  return NIFTY_PREFIX.test(sym);
}

function filterToNifty(data: {
  success: boolean;
  positions?: Record<string, unknown>[];
  orders?: Record<string, unknown>[];
  trades?: Record<string, unknown>[];
}) {
  return {
    success: data.success,
    positions: (data.positions ?? []).filter(isNiftyRow),
    orders: (data.orders ?? []).filter(isNiftyRow),
    trades: (data.trades ?? []).filter(isNiftyRow),
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    const { stdout } = await execFileAsync(PYTHON_EXE, [SCALPER_SCRIPT, 'poll'], {
      cwd: PROJECT_ROOT,
      timeout: 20_000,
      windowsHide: true,
    });
    const lines = stdout.trim().split('\n').filter(Boolean);
    const data = JSON.parse(lines[lines.length - 1]);
    return NextResponse.json(filterToNifty(data));
  } catch (err: unknown) {
    const e = err as { stdout?: string; message?: string; stderr?: string };
    if (e.stdout) {
      try {
        const lines = String(e.stdout).trim().split('\n').filter(Boolean);
        return NextResponse.json(filterToNifty(JSON.parse(lines[lines.length - 1])));
      } catch {}
    }
    console.error('[/api/quiltrade/poll] error:', e.message, e.stderr ?? '');
    return NextResponse.json(
      { success: false, error: 'Failed to fetch positions', detail: String(e.message) },
      { status: 500 },
    );
  }
}
