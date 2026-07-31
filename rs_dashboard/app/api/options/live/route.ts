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

// Only brokers that actually run a tick bridge appear here. Kotak deliberately
// does not: an option's LTP comes from the exchange, not the broker, so it
// shares Dhan's feed (see QUOTE_CHANNEL in lib/useLiveOptionsWS.ts) and
// normalizes to 'dhan' below. Starting a second identical NIFTY feed for it
// would only duplicate the subscription.
type Broker = 'dhan' | 'zerodha';

function normalizeBroker(value: unknown): Broker {
  return String(value ?? 'dhan').toLowerCase() === 'zerodha' ? 'zerodha' : 'dhan';
}

/** Each broker's bridge is fully independent — its own quotes/status/history
 *  files and stop trigger — so starting/stopping one never touches the other. */
function filesFor(broker: Broker) {
  return {
    quotes:  path.join(DEBUG_DIR, `live_options_quotes_${broker}.json`),
    history: path.join(DEBUG_DIR, `live_options_history_${broker}.json`),
    status:  path.join(DEBUG_DIR, `live_options_status_${broker}.json`),
    stop:    path.join(DEBUG_DIR, `live_options_stop_${broker}.trigger`),
  };
}

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

/** Writes the stop trigger and waits (bounded, polling with a fresh PID check
 *  each time) for the process to actually exit, instead of a blind fixed sleep. */
async function stopAndWait(broker: Broker, pid: number, maxWaitMs = 3000): Promise<void> {
  fs.writeFileSync(filesFor(broker).stop, '');
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid, true)) return;
    await new Promise(r => setTimeout(r, 300));
  }
}

/** GET — return live quotes + bridge status (+ history when explicitly requested)
 *  for one broker. live_options_history_*.json holds 300 full-chain snapshots
 *  (~6MB) — reading and JSON.parse-ing it synchronously on every request blocks
 *  the event loop. Scalper polls this endpoint every 100ms and never uses
 *  `history`, so only pay that cost for callers (OptionsCharts) that ask via
 *  ?history=1. */
export async function GET(request: NextRequest) {
  const broker         = normalizeBroker(request.nextUrl.searchParams.get('broker'));
  const includeHistory = request.nextUrl.searchParams.get('history') === '1';
  const checkPid       = request.nextUrl.searchParams.get('checkPid') === '1';
  const files = filesFor(broker);

  const quotes  = readJson(files.quotes)  as Record<string, unknown> | null;
  const history = includeHistory ? (readJson(files.history) as Record<string, unknown> | null) : null;
  const status  = readJson(files.status)  as Record<string, unknown> | null;

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

/** POST — start or stop a broker's WebSocket bridge. Each broker's bridge is
 *  independent: starting/stopping one never affects the other's running
 *  process, so a broker switch in the UI never spawns/kills anything. */
export async function POST(request: NextRequest) {
  const body   = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action ?? '');

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  // ── Stop ─────────────────────────────────────────────────────────────────
  if (action === 'stop') {
    const brokers: Broker[] = Array.isArray(body.brokers)
      ? (body.brokers as unknown[]).map(normalizeBroker)
      : [normalizeBroker(body.broker)];
    for (const broker of brokers) {
      fs.writeFileSync(filesFor(broker).stop, '');
    }
    return NextResponse.json({ success: true, message: 'Stop trigger written', brokers });
  }

  // ── Start ────────────────────────────────────────────────────────────────
  if (action === 'start') {
    const underlying = String(body.underlying ?? 'NIFTY').toUpperCase();
    const expiry     = String(body.expiry ?? '');
    const numStrikes = Number(body.numStrikes ?? 10);
    const broker     = normalizeBroker(body.broker);
    const files      = filesFor(broker);

    if (!expiry) {
      return NextResponse.json({ success: false, error: 'expiry required' }, { status: 400 });
    }

    // Prevent duplicate bridge for this broker
    const status = readJson(files.status) as Record<string, unknown> | null;
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

    // Stop this broker's existing bridge first (different underlying/expiry) —
    // the OTHER broker's bridge, if any, is never touched.
    if (status && status.pid && status.status === 'RUNNING' && isPidRunning(Number(status.pid))) {
      await stopAndWait(broker, Number(status.pid));
    }

    if (fs.existsSync(files.stop)) fs.unlinkSync(files.stop);

    const freePort = await findFreePort(broker === 'zerodha' ? 8865 : 8765);
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
