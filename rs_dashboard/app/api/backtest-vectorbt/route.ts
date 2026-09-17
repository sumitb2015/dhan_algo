import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { PYTHON_EXE, PROJECT_ROOT } from '@/lib/pyExec';
import { isPidRunning } from '@/lib/processCheck';

// Spawns scripts/analysis/vectorbt_engine/run_backtest_cli.py and polls it the same
// way app/api/backtest/route.ts drives backtest_short_straddle.py — detached spawn,
// status JSON in debug/, stop via a trigger file. See dhan-dashboard-page skill.
const SCRIPT_PATH    = path.join(PROJECT_ROOT, 'scripts', 'analysis', 'vectorbt_engine', 'run_backtest_cli.py');
const DEBUG_DIR       = path.join(PROJECT_ROOT, 'debug');
const STATUS_FILE     = path.join(DEBUG_DIR, 'vectorbt_backtest_status.json');
const RESULT_FILE     = path.join(DEBUG_DIR, 'vectorbt_backtest_result.json');
const STOP_FILE       = path.join(DEBUG_DIR, 'vectorbt_backtest_stop.trigger');
// Kept in sync with app/api/backtest-vectorbt/report/route.ts, which serves this
// same fixed path — Next.js route files may only export HTTP method handlers, so
// the constant can't be shared via export.
const TEARSHEET_FILE = path.join(DEBUG_DIR, 'vectorbt_tearsheet.html');

const STRATEGIES = ['ema-crossover', 'rsi', 'donchian', 'supertrend', 'macd'];
const COST_PROFILES = ['intraday_equity', 'delivery_equity', 'fno_futures', 'fno_options'];

function readJson(file: string) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export async function GET() {
  const status = readJson(STATUS_FILE);
  if (!status) {
    return NextResponse.json({ running: false, done: false });
  }

  const running = !status.done && status.pid && isPidRunning(status.pid);
  if (!running && !status.done && status.pid) {
    status.done = true;
    status.running = false;
    status.error = status.error ?? 'Process exited unexpectedly';
    try { fs.writeFileSync(STATUS_FILE, JSON.stringify(status)); } catch { /* ignore */ }
  }

  let result = null;
  if (status.done && !status.error) {
    result = readJson(RESULT_FILE);
  }

  return NextResponse.json({ ...status, running: Boolean(running), result });
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

  const strategy = String(body.strategy ?? 'ema-crossover');
  if (!STRATEGIES.includes(strategy)) {
    return NextResponse.json({ error: `Unknown strategy. Expected one of: ${STRATEGIES.join(', ')}` }, { status: 400 });
  }
  const costProfile = String(body.cost_profile ?? 'delivery_equity');
  if (!COST_PROFILES.includes(costProfile)) {
    return NextResponse.json({ error: `Unknown cost profile. Expected one of: ${COST_PROFILES.join(', ')}` }, { status: 400 });
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

  const args = [
    SCRIPT_PATH,
    '--strategy',    strategy,
    '--symbol',      String(body.symbol ?? 'NIFTY'),
    '--asset-type',  String(body.asset_type ?? 'index'),
    '--start-date',  String(body.start_date ?? '2021-01-01'),
    '--cost-profile', costProfile,
    '--benchmark-symbol', String(body.benchmark_symbol ?? 'NIFTY'),
    '--status-file', STATUS_FILE,
    '--output-file', RESULT_FILE,
    '--tearsheet-file', TEARSHEET_FILE,
    '--stop-file',   STOP_FILE,
  ];

  if (body.end_date) args.push('--end-date', String(body.end_date));

  // Strategy-specific params — only pass the ones the CLI reads for this strategy,
  // but it accepts all of them regardless (each has a sane default).
  const paramArgs: Record<string, string[]> = {
    fast: ['--fast'], slow: ['--slow'],
    rsi_length: ['--rsi-length'], rsi_buy: ['--rsi-buy'], rsi_sell: ['--rsi-sell'],
    donchian_length: ['--donchian-length'],
    supertrend_length: ['--supertrend-length'], supertrend_multiplier: ['--supertrend-multiplier'],
    macd_fast: ['--macd-fast'], macd_slow: ['--macd-slow'], macd_signal: ['--macd-signal'],
  };
  for (const [key, flag] of Object.entries(paramArgs)) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
      args.push(flag[0], String(body[key]));
    }
  }

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
      stage: 'starting',
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
