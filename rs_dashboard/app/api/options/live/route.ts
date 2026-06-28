import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { execSync, spawn } from 'child_process';

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const DEBUG_DIR      = path.join(PROJECT_ROOT, 'debug');
const PYTHON_EXE     = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe');
const BRIDGE_SCRIPT  = path.join(PROJECT_ROOT, 'scripts', 'tools', 'live_options_ws.py');
const QUOTES_FILE    = path.join(DEBUG_DIR, 'live_options_quotes.json');
const HISTORY_FILE   = path.join(DEBUG_DIR, 'live_options_history.json');
const STATUS_FILE    = path.join(DEBUG_DIR, 'live_options_status.json');
const STOP_TRIGGER   = path.join(DEBUG_DIR, 'live_options_stop.trigger');

function readJson(file: string): unknown {
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

/** GET — return live quotes + history + bridge status */
export async function GET() {
  const quotes  = readJson(QUOTES_FILE)  as Record<string, unknown> | null;
  const history = readJson(HISTORY_FILE) as Record<string, unknown> | null;
  const status  = readJson(STATUS_FILE)  as Record<string, unknown> | null;

  // If the process is dead, reset both RUNNING and ERROR to STOPPED so stale
  // error state from a previous crash doesn't persist across page loads.
  if (status && status.pid && (status.status === 'RUNNING' || status.status === 'ERROR')) {
    if (!isPidRunning(Number(status.pid))) {
      (status as Record<string, unknown>).status = 'STOPPED';
    }
  }

  return NextResponse.json({
    success: true,
    status:  status  ?? { status: 'STOPPED', subscribed: 0 },
    quotes:  quotes  ?? { updated_at: null, strikes: {} },
    history: history ?? { history: [] },
  });
}

/** POST — start or stop the WebSocket bridge */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action ?? '');

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  // ── Stop ─────────────────────────────────────────────────────────────────
  if (action === 'stop') {
    fs.writeFileSync(STOP_TRIGGER, '');
    return NextResponse.json({ success: true, message: 'Stop trigger written' });
  }

  // ── Start ────────────────────────────────────────────────────────────────
  if (action === 'start') {
    const underlying = String(body.underlying ?? 'NIFTY').toUpperCase();
    const expiry     = String(body.expiry ?? '');
    const numStrikes = Number(body.numStrikes ?? 10);

    if (!expiry) {
      return NextResponse.json({ success: false, error: 'expiry required' }, { status: 400 });
    }

    // Prevent duplicate bridge
    const status = readJson(STATUS_FILE) as Record<string, unknown> | null;
    if (
      status &&
      status.pid &&
      status.status === 'RUNNING' &&
      status.underlying === underlying &&
      status.expiry === expiry &&
      isPidRunning(Number(status.pid))
    ) {
      return NextResponse.json({ success: true, message: 'Bridge already running', pid: status.pid });
    }

    // Stop any existing bridge first
    if (status && status.pid && status.status === 'RUNNING' && isPidRunning(Number(status.pid))) {
      fs.writeFileSync(STOP_TRIGGER, '');
      await new Promise(r => setTimeout(r, 1500));
    }

    if (fs.existsSync(STOP_TRIGGER)) fs.unlinkSync(STOP_TRIGGER);

    const child = spawn(
      PYTHON_EXE,
      [BRIDGE_SCRIPT, '--underlying', underlying, '--expiry', expiry, '--num-strikes', String(numStrikes)],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();

    return NextResponse.json({ success: true, message: 'Bridge started', pid: child.pid });
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
