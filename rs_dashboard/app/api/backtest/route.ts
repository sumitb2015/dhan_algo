import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PYTHON_EXE } from '@/lib/pyExec';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'analysis', 'backtest_short_straddle.py');

const DEFAULT_LEGS = JSON.stringify([
  { option_type: 'CE', position: 'sell', lots: 1, strike: 'ATM', leg_sl_pct: 0, leg_target_pct: 0 },
  { option_type: 'PE', position: 'sell', lots: 1, strike: 'ATM', leg_sl_pct: 0, leg_target_pct: 0 },
]);

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch { /* use defaults */ }

  const legs = body.legs != null ? JSON.stringify(body.legs) : DEFAULT_LEGS;

  const strategyType = String(body.strategy_type ?? 'intraday');

  const args = [
    SCRIPT_PATH,
    '--start-date',          String(body.start_date          ?? '2021-01-01'),
    '--end-date',            String(body.end_date            ?? '2026-06-30'),
    '--lot-size',            String(body.lot_size            ?? 65),
    '--entry-time',          String(body.entry_time          ?? '09:20'),
    '--eod-time',            String(body.eod_time            ?? '15:15'),
    '--profit-target-pct',   String(body.profit_target_pct   ?? 50),
    '--overall-sl-pct',      String(body.overall_sl_pct      ?? 0),
    '--commission-per-lot',  String(body.commission_per_lot  ?? 40),
    '--slippage-pct',        String(body.slippage_pct        ?? 0),
    '--strategy-type',       strategyType,
    '--legs',                legs,
    '--use-db',
  ];

  try {
    const { stdout } = await execFileAsync(PYTHON_EXE, args, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
    const result = JSON.parse(stdout);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string }).stderr ?? '';
    return NextResponse.json({ error: msg, stderr }, { status: 500 });
  }
}
