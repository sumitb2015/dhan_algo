import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { isPidRunning } from '@/lib/processCheck';

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const DEBUG_DIR      = path.join(PROJECT_ROOT, 'debug');
const PYTHON_EXE     = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const BRIDGE_SCRIPT  = path.join(PROJECT_ROOT, 'scripts', 'tools', 'live_indices_ws.py');
const HISTORY_FILE   = path.join(DEBUG_DIR, 'live_indices_history.json');
const STATUS_FILE    = path.join(DEBUG_DIR, 'live_indices_status.json');
const STOP_TRIGGER   = path.join(DEBUG_DIR, 'live_indices_stop.trigger');
const SELECTION_FILE = path.join(DEBUG_DIR, 'live_indices_selection.json');
const SETTINGS_FILE  = path.join(DEBUG_DIR, 'live_indices_settings.json');

const DEFAULT_INTERVAL = 20; // seconds

function readJson(file: string): any | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** GET — return history + bridge status + settings */
export async function GET() {
  const history  = readJson(HISTORY_FILE);
  const status   = readJson(STATUS_FILE);
  const settings = readJson(SETTINGS_FILE) ?? { interval: DEFAULT_INTERVAL };

  if (status && status.pid && status.status === 'RUNNING') {
    if (!isPidRunning(Number(status.pid))) {
      status.status = 'STOPPED';
    }
  }

  return NextResponse.json({
    success: true,
    status:   status ?? { status: 'STOPPED', subscribed: 0 },
    history:  history ?? null,
    settings: { interval: settings.interval ?? DEFAULT_INTERVAL },
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

  if (action === 'settings') {
    const interval = Number(body.interval);
    if (!isFinite(interval) || interval < 1 || interval > 300) {
      return NextResponse.json({ success: false, error: 'interval must be 1–300 seconds' }, { status: 400 });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ interval }));
    return NextResponse.json({ success: true, message: 'Settings saved', interval });
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
