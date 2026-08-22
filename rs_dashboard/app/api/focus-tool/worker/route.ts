import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { PROJECT_ROOT, PYTHON_EXE } from '@/lib/pyExec';
import { isPidRunning } from '@/lib/processCheck';

// Lifecycle for the Focus Tool's server-side rule engine
// (scripts/tools/focus_tool_rows_worker.py).
//
// Distinct from app/api/focus-tool/route.ts, which drives the OTHER, unwired
// Focus Tool rewrite's worker (focus_tool_worker.py) against a different config
// file and row schema. Separate script, separate status/state/stop files,
// separate singleton mutex — neither can disturb the other.
//
// The worker is what makes scheduled entries and level exits survive the
// browser tab closing. While it reports RUNNING the page stands its own
// in-tab scheduler down, so exactly one of the two is ever placing orders.

const DEBUG_DIR     = path.join(PROJECT_ROOT, 'debug');
const WORKER_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'focus_tool_rows_worker.py');

const STATUS_FILE  = path.join(DEBUG_DIR, 'focus_tool_rows_worker_status.json');
const STOP_TRIGGER = path.join(DEBUG_DIR, 'focus_tool_rows_worker_stop.trigger');
const LOG_FILE     = path.join(DEBUG_DIR, 'focus_tool_rows_worker_spawn.log');
const LOCK_FILE    = path.join(DEBUG_DIR, 'focus_tool_rows_worker_start.lock');

const LOCK_STALE_MS = 30_000;
// The worker heartbeats every tick (1s). Anything older than this means the
// process is wedged or gone even if its PID still resolves.
const HEARTBEAT_STALE_MS = 15_000;

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function acquireStartLock(): boolean {
  try {
    fs.writeFileSync(LOCK_FILE, String(Date.now()), { flag: 'wx' });
    return true;
  } catch {
    try {
      const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (age > LOCK_STALE_MS) {
        fs.unlinkSync(LOCK_FILE);
        fs.writeFileSync(LOCK_FILE, String(Date.now()), { flag: 'wx' });
        return true;
      }
    } catch { /* lost the steal race — treat as not acquired */ }
    return false;
  }
}

function releaseStartLock(): void {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
}

/**
 * The worker's status, corrected against reality. A status file saying RUNNING
 * proves nothing on its own — the process may have been killed without ever
 * writing STOPPED — so the PID and the heartbeat age both have to agree.
 */
function currentStatus(): Record<string, unknown> {
  const st = readJson(STATUS_FILE);
  if (!st) return { status: 'STOPPED' };

  if (st.status === 'RUNNING') {
    const pid = Number(st.pid);
    if (!pid || !isPidRunning(pid)) {
      return { ...st, status: 'STOPPED', note: 'process is gone' };
    }
    const beat = Date.parse(String(st.lastUpdate ?? ''));
    if (Number.isFinite(beat) && Date.now() - beat > HEARTBEAT_STALE_MS) {
      return { ...st, status: 'STALE', note: 'no heartbeat' };
    }
  }
  return st;
}

export async function GET() {
  return NextResponse.json({ success: true, status: currentStatus() });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action ?? '');

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  if (action === 'stop') {
    // The worker deletes the trigger itself and exits. It deliberately does NOT
    // close open positions on the way out — stopping the scheduler is not a
    // decision to trade.
    fs.writeFileSync(STOP_TRIGGER, '');
    return NextResponse.json({ success: true, message: 'Stop trigger written' });
  }

  if (action === 'start') {
    const broker = String(body.broker ?? 'dhan');
    if (!['dhan', 'zerodha', 'kotak'].includes(broker)) {
      return NextResponse.json({ success: false, error: 'Unknown broker' }, { status: 400 });
    }
    const dryRun = body.dryRun === true;

    if (!fs.existsSync(WORKER_SCRIPT)) {
      return NextResponse.json({ success: false, error: `Worker script missing: ${WORKER_SCRIPT}` }, { status: 500 });
    }

    if (!acquireStartLock()) {
      return NextResponse.json({ success: true, message: 'Worker start already in progress' });
    }

    try {
      const st = currentStatus();
      if (st.status === 'RUNNING') {
        return NextResponse.json({ success: true, message: 'Worker already running', pid: st.pid });
      }

      // Clear a stale trigger, or the fresh process would read it and exit at once.
      if (fs.existsSync(STOP_TRIGGER)) fs.unlinkSync(STOP_TRIGGER);

      const args = [WORKER_SCRIPT, '--broker', broker];
      if (dryRun) args.push('--dry-run');

      const logFd = fs.openSync(LOG_FILE, 'w');
      const child = spawn(PYTHON_EXE, args, {
        detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true,
      });
      fs.closeSync(logFd);
      child.unref();

      try {
        fs.writeFileSync(STATUS_FILE, JSON.stringify({
          status: 'RUNNING',
          pid: child.pid,
          broker,
          dryRun,
          startedAt: new Date().toISOString(),
          lastUpdate: new Date().toISOString(),
          openRows: 0,
          rows: [],
          note: 'starting — Python writes the real record on its first tick',
        }));
      } catch { /* the worker writes the real record moments later */ }

      return NextResponse.json({ success: true, message: 'Worker started', pid: child.pid });
    } finally {
      releaseStartLock();
    }
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
