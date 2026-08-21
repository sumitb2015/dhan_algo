import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { PROJECT_ROOT, PYTHON_EXE } from '@/lib/pyExec';
import { isPidRunning } from '@/lib/processCheck';
import {
  readConfig, writeConfig, sanitizeConfig, readStatus,
  STOP_TRIGGER, WORKER_LOG,
} from '@/lib/focusStore';

// Config + lifecycle for the Focus Tool worker.
//
// The page never places an order for an armed row — it saves config here and
// scripts/tools/focus_tool_worker.py acts on it. That indirection is the whole
// point: rules that live in a browser tab stop existing when the tab does.

const DEBUG_DIR     = path.join(PROJECT_ROOT, 'debug');
const WORKER_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'focus_tool_worker.py');

// The worker heartbeats every second; anything older than this is hung or dead
// and must not be shown as healthy while it is not evaluating a single rule.
const HEARTBEAT_STALE_MS = 10_000;

// Guards the window between spawn and the worker writing STARTING. The worker
// also holds its own lock file, so this is belt-and-braces against a
// double-click racing two trading processes onto the same config.
let startInFlight = false;

function withLiveness(status: ReturnType<typeof readStatus>) {
  if (!status) return { status: 'STOPPED' as const };

  if (status.pid && (status.status === 'RUNNING' || status.status === 'STARTING')) {
    if (!isPidRunning(Number(status.pid))) {
      return { ...status, status: 'STOPPED' as const };
    }
  }

  if (status.status === 'RUNNING') {
    const age = Date.now() - Number(status.last_update_ts ?? 0) * 1000;
    if (Number.isFinite(age) && age > HEARTBEAT_STALE_MS) {
      return { ...status, status: 'STALE' as const };
    }
  }

  return status;
}

/** GET — the saved config plus the worker's latest heartbeat. */
export async function GET() {
  const status = withLiveness(readStatus());
  return NextResponse.json({
    success: true,
    config: readConfig(),
    status,
    running: status.status === 'RUNNING' || status.status === 'STARTING',
  });
}

/** POST — save config, or start/stop the worker. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ success: false, error: 'Body must be JSON' }, { status: 400 });
  }
  const action = String(body.action ?? '');

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  if (action === 'save') {
    if (body.config === undefined) {
      return NextResponse.json({ success: false, error: 'save requires a config' }, { status: 400 });
    }
    // Sanitised, not trusted: this file drives real order placement.
    const cfg = sanitizeConfig(body.config);
    try {
      writeConfig(cfg);
    } catch (err) {
      return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
    }
    return NextResponse.json({ success: true, config: cfg });
  }

  if (action === 'stop') {
    try {
      fs.writeFileSync(STOP_TRIGGER, '');
    } catch (err) {
      return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
    }
    // The worker shuts itself down and deliberately closes nothing. Open
    // positions stay the user's to manage.
    return NextResponse.json({ success: true, message: 'Stop trigger written — open positions are left untouched' });
  }

  if (action === 'start') {
    if (!fs.existsSync(WORKER_SCRIPT)) {
      return NextResponse.json({ success: false, error: `Worker script missing: ${WORKER_SCRIPT}` }, { status: 500 });
    }

    const status = readStatus();
    if (status?.pid && (status.status === 'RUNNING' || status.status === 'STARTING') && isPidRunning(Number(status.pid))) {
      return NextResponse.json({ success: true, message: 'Worker already running', pid: status.pid });
    }

    if (startInFlight) {
      return NextResponse.json({ success: true, message: 'Worker start already in progress' });
    }
    startInFlight = true;
    setTimeout(() => { startInFlight = false; }, 10_000);

    if (fs.existsSync(STOP_TRIGGER)) fs.unlinkSync(STOP_TRIGGER);

    try {
      // Capture stdout/stderr: a crash traceback from a process that places
      // orders needs to be diagnosable after the fact, not discarded.
      const logFd = fs.openSync(WORKER_LOG, 'a');
      const child = spawn(PYTHON_EXE, [WORKER_SCRIPT], {
        detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true,
      });
      fs.closeSync(logFd);
      child.unref();
      return NextResponse.json({ success: true, message: 'Worker started', pid: child.pid });
    } catch (err) {
      startInFlight = false;
      return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
    }
  }

  return NextResponse.json({ success: false, error: `Unknown action: ${action || '(none)'}` }, { status: 400 });
}
