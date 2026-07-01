import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { execSync, spawn } from 'child_process';

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const DEBUG_DIR      = path.join(PROJECT_ROOT, 'debug');
const PYTHON_EXE     = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const BRIDGE_SCRIPT  = path.join(PROJECT_ROOT, 'scripts', 'tools', 'live_indices_ws.py');
const HISTORY_FILE   = path.join(DEBUG_DIR, 'live_indices_history.json');
const STATUS_FILE    = path.join(DEBUG_DIR, 'live_indices_status.json');
const STOP_TRIGGER   = path.join(DEBUG_DIR, 'live_indices_stop.trigger');
const SELECTION_FILE = path.join(DEBUG_DIR, 'live_indices_selection.json');

function readJson(file: string): any | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isPidRunning(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /FI "PID eq ${pid}"`, {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      });
      return out.includes(String(pid));
    }
    execSync(`ps -p ${pid}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** GET — return history + bridge status */
export async function GET() {
  const history = readJson(HISTORY_FILE);
  const status  = readJson(STATUS_FILE);

  if (status && status.pid && status.status === 'RUNNING') {
    if (!isPidRunning(Number(status.pid))) {
      status.status = 'STOPPED';
    }
  }

  return NextResponse.json({
    success: true,
    status:  status ?? { status: 'STOPPED', subscribed: 0 },
    history: history ?? null,
  });
}

/** POST — start or stop the WebSocket bridge */
export async function POST(request: NextRequest) {
  const body   = await request.json().catch(() => ({}));
  const action = (body.action ?? '') as string;

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  if (action === 'stop') {
    fs.writeFileSync(STOP_TRIGGER, '');
    return NextResponse.json({ success: true, message: 'Stop trigger written' });
  }

  if (action === 'select') {
    const symbols = Array.isArray(body.symbols) ? (body.symbols as string[]) : [];
    if (symbols.length === 0) {
      return NextResponse.json({ success: false, error: 'symbols must be non-empty' }, { status: 400 });
    }
    fs.writeFileSync(SELECTION_FILE, JSON.stringify({ selected: symbols }));
    return NextResponse.json({ success: true, message: 'Selection updated' });
  }

  if (action === 'start') {
    const status = readJson(STATUS_FILE);
    if (status?.pid && status.status === 'RUNNING' && isPidRunning(Number(status.pid))) {
      return NextResponse.json({ success: true, message: 'Bridge already running', pid: status.pid });
    }
    if (fs.existsSync(STOP_TRIGGER)) fs.unlinkSync(STOP_TRIGGER);

    const child = spawn(PYTHON_EXE, [BRIDGE_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    return NextResponse.json({ success: true, message: 'Bridge started', pid: child.pid });
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
