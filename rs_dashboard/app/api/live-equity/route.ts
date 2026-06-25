import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { execSync, spawn } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR    = path.join(PROJECT_ROOT, 'debug');
const PYTHON_EXE   = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe');
const BRIDGE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'live_equity_ws.py');
const QUOTES_FILE  = path.join(DEBUG_DIR, 'live_equity_quotes.json');
const STATUS_FILE  = path.join(DEBUG_DIR, 'live_equity_status.json');
const STOP_TRIGGER = path.join(DEBUG_DIR, 'live_equity_stop.trigger');

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
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
      });
      return out.includes(String(pid));
    }
    execSync(`ps -p ${pid}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** GET — return live quotes + bridge status */
export async function GET() {
  const quotes = readJson(QUOTES_FILE);
  const status = readJson(STATUS_FILE);

  // Cross-check PID to detect crashed bridges
  if (status && status.pid && status.status === 'RUNNING') {
    if (!isPidRunning(Number(status.pid))) {
      status.status = 'STOPPED';
    }
  }

  return NextResponse.json({
    success: true,
    status: status ?? { status: 'STOPPED', subscribed: 0 },
    quotes: quotes ?? { updated_at: null, count: 0, quotes: {} },
  });
}

/** POST — start or stop the WebSocket bridge */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const action: string = body.action ?? '';

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  // ── Stop ────────────────────────────────────────────────────────────────
  if (action === 'stop') {
    fs.writeFileSync(STOP_TRIGGER, '');
    return NextResponse.json({ success: true, message: 'Stop trigger written' });
  }

  // ── Start ────────────────────────────────────────────────────────────────
  if (action === 'start') {
    // Prevent duplicate bridge
    const status = readJson(STATUS_FILE);
    if (status && status.pid && status.status === 'RUNNING' && isPidRunning(Number(status.pid))) {
      return NextResponse.json({ success: true, message: 'Bridge already running', pid: status.pid });
    }

    // Remove stale stop trigger if present
    if (fs.existsSync(STOP_TRIGGER)) fs.unlinkSync(STOP_TRIGGER);

    const child = spawn(PYTHON_EXE, [BRIDGE_SCRIPT, '--index', 'nifty50'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    return NextResponse.json({ success: true, message: 'Bridge started', pid: child.pid });
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
