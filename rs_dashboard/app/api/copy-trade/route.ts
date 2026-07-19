import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { isPidRunning } from '@/lib/processCheck';

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const DEBUG_DIR      = path.join(PROJECT_ROOT, 'debug');
const PYTHON_EXE     = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const BRIDGE_SCRIPT  = path.join(PROJECT_ROOT, 'scripts', 'tools', 'copy_trade_bridge.py');
const STATUS_FILE    = path.join(DEBUG_DIR, 'copy_trade_status.json');
const LOG_FILE       = path.join(DEBUG_DIR, 'copy_trade_log.json');
const STOP_TRIGGER   = path.join(DEBUG_DIR, 'copy_trade_stop.trigger');

function readJson(file: string): unknown {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** GET — bridge status + recent replication activity log. */
export async function GET(request: NextRequest) {
  const checkPid = request.nextUrl.searchParams.get('checkPid') === '1';

  const status = readJson(STATUS_FILE) as Record<string, unknown> | null;
  const log    = readJson(LOG_FILE) as { entries?: unknown[] } | null;

  if (checkPid && status && status.pid && (status.status === 'RUNNING' || status.status === 'STARTING')) {
    if (!isPidRunning(Number(status.pid))) {
      (status as Record<string, unknown>).status = 'STOPPED';
    }
  }

  return NextResponse.json({
    success: true,
    status: status ?? { status: 'STOPPED' },
    entries: log?.entries ?? [],
  });
}

/** POST — start or stop the copy-trade bridge process. */
export async function POST(request: NextRequest) {
  const body   = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action ?? '');

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  if (action === 'stop') {
    fs.writeFileSync(STOP_TRIGGER, '');
    return NextResponse.json({ success: true, message: 'Stop trigger written' });
  }

  if (action === 'start') {
    const status = readJson(STATUS_FILE) as Record<string, unknown> | null;
    if (status && status.pid && (status.status === 'RUNNING' || status.status === 'STARTING') && isPidRunning(Number(status.pid))) {
      return NextResponse.json({ success: true, message: 'Bridge already running', pid: status.pid });
    }

    if (fs.existsSync(STOP_TRIGGER)) fs.unlinkSync(STOP_TRIGGER);

    const child = spawn(PYTHON_EXE, [BRIDGE_SCRIPT], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();

    return NextResponse.json({ success: true, message: 'Bridge started', pid: child.pid });
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
