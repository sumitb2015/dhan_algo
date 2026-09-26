import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { PYTHON_EXE, PROJECT_ROOT } from '@/lib/pyExec';
import { isPidRunning } from '@/lib/processCheck';

// Spawns scripts/analysis/vectorbt_engine/run_backtest_cli.py and polls it the same
// way app/api/backtest/route.ts drives backtest_short_straddle.py — detached spawn,
// status JSON in debug/, stop via a trigger file. See dhan-dashboard-page skill.
//
// This CLI runs the SAME multi-leg options simulation as /api/backtest (identical
// LegConfig args below, deliberately kept in sync with that route's arg list) and
// additionally computes VectorBT's own Sharpe/Sortino/drawdown/tearsheet from the
// resulting trades, returned under the result JSON's "vbt" key — see
// scripts/analysis/vectorbt_engine/options_engine.py for exactly how.
const SCRIPT_PATH    = path.join(PROJECT_ROOT, 'scripts', 'analysis', 'vectorbt_engine', 'run_backtest_cli.py');
const DEBUG_DIR       = path.join(PROJECT_ROOT, 'debug');
const STATUS_FILE     = path.join(DEBUG_DIR, 'vectorbt_backtest_status.json');
const RESULT_FILE     = path.join(DEBUG_DIR, 'vectorbt_backtest_result.json');
// This CLI's simulation is backtest_short_straddle.run_backtest() itself (see
// run_backtest_cli.py), which only ever polls the hardcoded
// debug/backtest_stop.trigger path internally — the same file app/api/backtest's
// own STOP_FILE writes to. A separate vectorbt_backtest_stop.trigger would never
// be read by anything, so Stop must target this shared path.
const STOP_FILE       = path.join(DEBUG_DIR, 'backtest_stop.trigger');
// sb.run_backtest()'s own progress writes to STATUS_FILE never include "pid"
// (it fully overwrites the JSON each time), which would otherwise make
// isPidRunning(status.pid) below go blind mid-run. Track the spawned pid here
// instead, independent of whatever the Python side last wrote.
const PID_FILE        = path.join(DEBUG_DIR, 'vectorbt_backtest.pid');
// Kept in sync with app/api/backtest-vectorbt/report/route.ts, which serves this
// same fixed path — Next.js route files may only export HTTP method handlers, so
// the constant can't be shared via export.
const TEARSHEET_FILE = path.join(DEBUG_DIR, 'vectorbt_tearsheet.html');

const DEFAULT_LEGS = JSON.stringify([
  { option_type: 'CE', position: 'sell', lots: 1, strike: 'ATM', leg_sl_pct: 0, leg_target_pct: 0 },
  { option_type: 'PE', position: 'sell', lots: 1, strike: 'ATM', leg_sl_pct: 0, leg_target_pct: 0 },
]);

function readJson(file: string) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function readPid(): number | null {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const status = readJson(STATUS_FILE);
  if (!status) {
    return NextResponse.json({ running: false, done: false });
  }

  const pid = readPid() ?? status.pid ?? null;
  const running = !status.done && pid && isPidRunning(pid);
  if (!running && !status.done && pid) {
    status.done = true;
    status.running = false;
    status.error = status.error ?? 'Process exited unexpectedly';
    try { fs.writeFileSync(STATUS_FILE, JSON.stringify(status)); } catch { /* ignore */ }
  }

  let result = null;
  if (status.done) {
    result = readJson(RESULT_FILE);
  }

  return NextResponse.json({ ...status, pid, running: Boolean(running), result });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch { /* use defaults */ }

  const action = String(body.action ?? 'start');

  if (action === 'stop') {
    try { fs.writeFileSync(STOP_FILE, 'stop'); } catch { /* ignore */ }

    const status = readJson(STATUS_FILE);
    const pid = readPid() ?? status?.pid ?? null;
    if (pid && isPidRunning(pid)) {
      try { process.kill(pid); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    if (status) {
      status.running = false;
      status.done = true;
      status.stopped = true;
      try { fs.writeFileSync(STATUS_FILE, JSON.stringify(status)); } catch { /* ignore */ }
    }

    return NextResponse.json({ success: true, stopped: true });
  }

  if (!fs.existsSync(DEBUG_DIR)) {
    try { fs.mkdirSync(DEBUG_DIR, { recursive: true }); } catch { /* ignore */ }
  }
  if (fs.existsSync(STOP_FILE)) {
    try { fs.unlinkSync(STOP_FILE); } catch { /* ignore */ }
  }
  if (fs.existsSync(RESULT_FILE)) {
    try { fs.unlinkSync(RESULT_FILE); } catch { /* ignore */ }
  }

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
    '--adjustment-mode',    String(body.adjustment_mode     ?? 'none'),
    '--roll-buffer',        String(body.roll_buffer         ?? 35),
    '--roll-type',          String(body.roll_type           ?? 'points'),
    '--max-rolls',          String(body.max_rolls           ?? 5),
    '--scalp-floor-pct',    String(body.scalp_floor_pct     ?? 0),
    '--trail-sl-pct',       String(body.trail_sl_pct        ?? 0),
    '--square-off-mode',    String(body.square_off_mode     ?? 'one_leg'),
    '--max-diff-pct',       String(body.max_diff_pct        ?? 0),
    '--entry-cutoff-time',  String(body.entry_cutoff_time   ?? '15:00'),
    '--cost-profile',       String(body.cost_profile        ?? 'fno_options'),
    '--benchmark-symbol',   String(body.benchmark_symbol    ?? 'NIFTY'),
    '--status-file',        STATUS_FILE,
    '--output-file',        RESULT_FILE,
    '--tearsheet-file',     TEARSHEET_FILE,
  ];

  try {
    const child = spawn(PYTHON_EXE, args, {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    child.unref();

    const initialStatus = {
      running: true,
      done: false,
      percent: 0,
      current: 0,
      total: 0,
      pid: child.pid,
      started_at: new Date().toISOString(),
    };
    fs.writeFileSync(STATUS_FILE, JSON.stringify(initialStatus));
    if (child.pid) {
      try { fs.writeFileSync(PID_FILE, String(child.pid)); } catch { /* ignore */ }
    }

    return NextResponse.json({ success: true, started: true, pid: child.pid });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to spawn backtest: ${msg}` }, { status: 500 });
  }
}
