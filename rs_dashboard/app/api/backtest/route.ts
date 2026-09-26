import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { PYTHON_EXE } from '@/lib/pyExec';
import { isPidRunning } from '@/lib/processCheck';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT  = path.resolve(process.cwd(), '..');
const DEBUG_DIR     = path.join(PROJECT_ROOT, 'debug');
const SCRIPT_PATH   = path.join(PROJECT_ROOT, 'scripts', 'analysis', 'backtest_short_straddle.py');
const STATUS_FILE   = path.join(DEBUG_DIR, 'backtest_status.json');
const RESULT_FILE   = path.join(DEBUG_DIR, 'backtest_result.json');
const STOP_FILE     = path.join(DEBUG_DIR, 'backtest_stop.trigger');
const PID_FILE      = path.join(DEBUG_DIR, 'backtest.pid');

const DEFAULT_LEGS = JSON.stringify([
  { option_type: 'CE', position: 'sell', lots: 1, strike: 'ATM', leg_sl_pct: 0, leg_target_pct: 0 },
  { option_type: 'PE', position: 'sell', lots: 1, strike: 'ATM', leg_sl_pct: 0, leg_target_pct: 0 },
]);

function readStatus() {
  try {
    if (!fs.existsSync(STATUS_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function readResult() {
  try {
    if (!fs.existsSync(RESULT_FILE)) return null;
    return JSON.parse(fs.readFileSync(RESULT_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function readPid(): number | null {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const raw = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const status = readStatus();
  if (!status) {
    return NextResponse.json({ running: false, done: false });
  }

  // Cross-check PID
  const pid = (status.pid && Number.isFinite(Number(status.pid))) ? Number(status.pid) : readPid();
  const running = !status.done && ((pid && isPidRunning(pid)) || status.running === true);
  if (!running && !status.done && pid && !isPidRunning(pid)) {
    status.done = true;
    status.running = false;
    try { fs.writeFileSync(STATUS_FILE, JSON.stringify(status)); } catch { /* ignore */ }
  }

  let result = null;
  if (status.done) {
    result = readResult();
    if (result && !status.archived) {
      autoArchiveBacktest(result);
      status.archived = true;
      try { fs.writeFileSync(STATUS_FILE, JSON.stringify(status)); } catch { /* ignore */ }
    }
  }

  return NextResponse.json({
    ...status,
    pid,
    running: Boolean(running),
    result,
  });
}

function autoArchiveBacktest(result: Record<string, unknown>) {
  try {
    const BACKTESTS_DIR = path.join(DEBUG_DIR, 'backtests', 'options');
    if (!fs.existsSync(BACKTESTS_DIR)) {
      fs.mkdirSync(BACKTESTS_DIR, { recursive: true });
    }
    const params = (result.params as Record<string, unknown>) || {};
    const summary = (result.summary as Record<string, unknown>) || {};
    const timestamp = new Date().toISOString();
    const dateStr = timestamp.slice(0, 10).replace(/-/g, '');
    const timeStr = timestamp.slice(11, 19).replace(/:/g, '');
    const rawName = String(params.strategy_name || 'backtest');
    const slug = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
    const id = `${slug}_${dateStr}_${timeStr}`;

    const destDir = path.join(BACKTESTS_DIR, id);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    fs.writeFileSync(path.join(destDir, 'result.json'), JSON.stringify(result, null, 2));

    const metadata = {
      id,
      name: params.strategy_name || id,
      timestamp,
      strategy_type: params.strategy_type || 'intraday',
      start_date: params.start_date,
      end_date: params.end_date,
      trades: summary.traded_cycles ?? summary.total_cycles ?? 0,
      win_rate: summary.win_rate ?? 0,
      total_pnl: summary.total_pnl ?? 0,
      max_drawdown: summary.max_drawdown ?? 0,
      has_tearsheet: false,
      has_trades_csv: false,
      tags: [params.strategy_type || 'intraday', 'options'],
    };

    fs.writeFileSync(path.join(destDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  } catch (e) {
    console.error('Failed to auto-archive backtest:', e);
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch { /* use defaults */ }

  const action = String(body.action ?? 'start');

  // Handle Stop Action
  if (action === 'stop') {
    try {
      fs.writeFileSync(STOP_FILE, 'stop');
    } catch { /* ignore */ }

    const status = readStatus();
    if (status && status.pid && isPidRunning(status.pid)) {
      try { process.kill(status.pid); } catch { /* ignore */ }
    }

    if (status) {
      status.running = false;
      status.done = true;
      status.stopped = true;
      try { fs.writeFileSync(STATUS_FILE, JSON.stringify(status)); } catch { /* ignore */ }
    }

    return NextResponse.json({ success: true, stopped: true });
  }

  // Handle Start / Run Action
  if (!fs.existsSync(DEBUG_DIR)) {
    try { fs.mkdirSync(DEBUG_DIR, { recursive: true }); } catch { /* ignore */ }
  }

  // Clean up previous triggers & results
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
    '--status-file',        STATUS_FILE,
    '--output-file',        RESULT_FILE,
  ];

  // Optional synchronous fallback mode
  if (body.sync === true) {
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
      autoArchiveBacktest(result);
      return NextResponse.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stderr = (err as { stderr?: string }).stderr ?? '';
      return NextResponse.json({ error: msg, stderr }, { status: 500 });
    }
  }

  // Default: Asynchronous detached spawn with live status polling
  try {
    const child = spawn(PYTHON_EXE, args, {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    child.unref();

    if (child.pid) {
      try { fs.writeFileSync(PID_FILE, String(child.pid)); } catch { /* ignore */ }
    }

    const initialStatus = {
      running: true,
      done: false,
      percent: 0.0,
      current: 0,
      total: 0,
      pid: child.pid,
      started_at: new Date().toISOString(),
    };
    fs.writeFileSync(STATUS_FILE, JSON.stringify(initialStatus));

    return NextResponse.json({ success: true, started: true, pid: child.pid });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to spawn backtest: ${msg}` }, { status: 500 });
  }
}
