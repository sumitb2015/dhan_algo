import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { spawn } from 'child_process';
import { isPidRunning } from '@/lib/processCheck';

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const DEBUG_DIR      = path.join(PROJECT_ROOT, 'debug');
const PYTHON_EXE     = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const BRIDGE_SCRIPT  = path.join(PROJECT_ROOT, 'scripts', 'tools', 'live_options_ws.py');
const ZERODHA_BRIDGE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'live_options_ws_zerodha.py');
const QUOTES_FILE    = path.join(DEBUG_DIR, 'live_options_quotes.json');
const HISTORY_FILE   = path.join(DEBUG_DIR, 'live_options_history.json');
const STATUS_FILE    = path.join(DEBUG_DIR, 'live_options_status.json');
const STOP_TRIGGER   = path.join(DEBUG_DIR, 'live_options_stop.trigger');

async function findFreePort(startPort: number): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => {
      resolve(findFreePort(startPort + 1));
    });
    server.listen(startPort, '127.0.0.1', () => {
      server.close(() => {
        resolve(startPort);
      });
    });
  });
}

function readJson(file: string): unknown {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** GET — return live quotes + bridge status (+ history when explicitly requested).
 *  live_options_history.json holds 300 full-chain snapshots (~6MB) — reading and
 *  JSON.parse-ing it synchronously on every request blocks the event loop. Scalper
 *  polls this endpoint every 100ms and never uses `history`, so only pay that cost
 *  for callers (OptionsCharts) that ask for it via ?history=1. */
export async function GET(request: NextRequest) {
  const includeHistory = request.nextUrl.searchParams.get('history') === '1';
  const checkPid       = request.nextUrl.searchParams.get('checkPid') === '1';

  const quotes  = readJson(QUOTES_FILE)  as Record<string, unknown> | null;
  const history = includeHistory ? (readJson(HISTORY_FILE) as Record<string, unknown> | null) : null;
  const status  = readJson(STATUS_FILE)  as Record<string, unknown> | null;

  // If the process is dead, reset both RUNNING and ERROR to STOPPED so stale
  // error state from a previous crash doesn't persist across page loads.
  // Only when ?checkPid=1 — isPidRunning spawns a blocking `tasklist` on cache
  // miss (~50-200ms event-loop stall), so fast poll loops must not trigger it.
  // The scalper's 5s status poll passes it; the 100ms fallback poll does not.
  if (checkPid && status && status.pid && (status.status === 'RUNNING' || status.status === 'ERROR')) {
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
    const broker     = String(body.broker ?? 'dhan').toLowerCase();

    if (!expiry) {
      return NextResponse.json({ success: false, error: 'expiry required' }, { status: 400 });
    }

    // Prevent duplicate bridge
    const status = readJson(STATUS_FILE) as Record<string, unknown> | null;
    const runningBroker = String(status?.broker ?? 'dhan').toLowerCase();
    if (
      status &&
      status.pid &&
      status.status === 'RUNNING' &&
      status.underlying === underlying &&
      status.expiry === expiry &&
      runningBroker === broker &&
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

    const freePort = await findFreePort(8765);
    const scriptPath = broker === 'zerodha' ? ZERODHA_BRIDGE_SCRIPT : BRIDGE_SCRIPT;
    const child = spawn(
      PYTHON_EXE,
      [scriptPath, '--underlying', underlying, '--expiry', expiry,
       '--num-strikes', String(numStrikes), '--ws-port', String(freePort)],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();

    return NextResponse.json({ success: true, message: 'Bridge started', pid: child.pid });
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
