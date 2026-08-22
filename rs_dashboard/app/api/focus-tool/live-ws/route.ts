import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { spawn } from 'child_process';
import { PROJECT_ROOT, PYTHON_EXE } from '@/lib/pyExec';
import { isPidRunning } from '@/lib/processCheck';

// Lifecycle for the Focus Tool's own live-quotes bridge (scripts/tools/focus_tool_ws.py).
//
// Deliberately standalone from app/api/options/live/route.ts, which AdvancedScalper/
// Scalper/Baskets use — that bridge is one-per-broker and only ever watches ONE
// underlying at a time, which doesn't fit Focus Tool's all-three-at-once row view.
// This route's files, port and process are entirely separate, so nothing here can
// affect that bridge or its consumers.
//
// Always Dhan-sourced regardless of Focus Tool's selected order-routing broker — an
// option's LTP is the exchange's, not the broker's (same reasoning as
// live_options_ws_zerodha.py, which also sources market data from Dhan).

const DEBUG_DIR     = path.join(PROJECT_ROOT, 'debug');
const BRIDGE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'focus_tool_ws.py');

const QUOTES_FILE = path.join(DEBUG_DIR, 'focus_tool_ws_quotes_dhan.json');
const STATUS_FILE = path.join(DEBUG_DIR, 'focus_tool_ws_status_dhan.json');
const STOP_TRIGGER = path.join(DEBUG_DIR, 'focus_tool_ws_stop_dhan.trigger');
const LOG_FILE = path.join(DEBUG_DIR, 'focus_tool_ws_log_dhan.log');
const LOCK_FILE = path.join(DEBUG_DIR, 'focus_tool_ws_start.lock');

const LOCK_STALE_MS = 30_000;

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
    } catch { /* lost the steal race to another caller — treat as not acquired */ }
    return false;
  }
}

function releaseStartLock(): void {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
}

function readJson(file: string): unknown {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function findFreePort(startPort: number): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => {
      resolve(findFreePort(startPort + 1));
    });
    server.listen(startPort, '127.0.0.1', () => {
      server.close(() => resolve(startPort));
    });
  });
}

async function stopAndWait(pid: number, maxWaitMs = 3000): Promise<void> {
  fs.writeFileSync(STOP_TRIGGER, '');
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid, true)) return;
    await new Promise(r => setTimeout(r, 300));
  }
}

/** GET — live quotes + bridge status. */
export async function GET() {
  const quotes = readJson(QUOTES_FILE) as Record<string, unknown> | null;
  const status = readJson(STATUS_FILE) as Record<string, unknown> | null;

  if (status && status.pid && (status.status === 'RUNNING' || status.status === 'STARTING')) {
    if (!isPidRunning(Number(status.pid))) {
      (status as Record<string, unknown>).status = 'STOPPED';
    }
  }

  return NextResponse.json({
    success: true,
    status: status ?? { status: 'STOPPED', subscribed: 0 },
    quotes: quotes ?? { updated_at: null },
  });
}

/** POST — start or stop the bridge. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action ?? '');

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  if (action === 'stop') {
    if (fs.existsSync(STATUS_FILE)) {
      fs.writeFileSync(STOP_TRIGGER, '');
    }
    return NextResponse.json({ success: true, message: 'Stop trigger written' });
  }

  if (action === 'start') {
    const expiries = (body.expiries ?? {}) as Record<string, unknown>;
    const niftyExpiry = String(expiries.NIFTY ?? '');
    const bankniftyExpiry = String(expiries.BANKNIFTY ?? '');
    const sensexExpiry = String(expiries.SENSEX ?? '');
    const numStrikes = Number(body.numStrikes ?? 12);

    if (!niftyExpiry || !bankniftyExpiry || !sensexExpiry) {
      return NextResponse.json(
        { success: false, error: 'expiries.NIFTY / BANKNIFTY / SENSEX all required' },
        { status: 400 },
      );
    }

    if (!fs.existsSync(BRIDGE_SCRIPT)) {
      return NextResponse.json({ success: false, error: `Bridge script missing: ${BRIDGE_SCRIPT}` }, { status: 500 });
    }

    // See app/api/options/live/route.ts for why this lock exists: concurrent
    // starts (StrictMode double-mount, a second tab) each see "not running" and
    // each spawn a bridge without it.
    if (!acquireStartLock()) {
      return NextResponse.json({ success: true, message: 'Bridge start already in progress' });
    }

    try {
      const status = readJson(STATUS_FILE) as Record<string, unknown> | null;
      const active = status && status.pid &&
        (status.status === 'RUNNING' || status.status === 'STARTING') &&
        isPidRunning(Number(status.pid));
      const sameExpiries = active && (() => {
        const e = (status!.expiries ?? {}) as Record<string, unknown>;
        return e.NIFTY === niftyExpiry && e.BANKNIFTY === bankniftyExpiry && e.SENSEX === sensexExpiry;
      })();

      if (active && sameExpiries) {
        return NextResponse.json({ success: true, message: 'Bridge already running', pid: status!.pid });
      }

      if (active) {
        await stopAndWait(Number(status!.pid));
      }

      if (fs.existsSync(STOP_TRIGGER)) fs.unlinkSync(STOP_TRIGGER);

      const freePort = await findFreePort(8965);

      const logFd = fs.openSync(LOG_FILE, 'w');
      const child = spawn(
        PYTHON_EXE,
        [
          BRIDGE_SCRIPT,
          '--nifty-expiry', niftyExpiry,
          '--banknifty-expiry', bankniftyExpiry,
          '--sensex-expiry', sensexExpiry,
          '--num-strikes', String(numStrikes),
          '--ws-port', String(freePort),
        ],
        { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true },
      );
      fs.closeSync(logFd);
      child.unref();

      try {
        fs.writeFileSync(STATUS_FILE, JSON.stringify({
          status: 'STARTING',
          broker: 'dhan',
          pid: child.pid,
          expiries: { NIFTY: niftyExpiry, BANKNIFTY: bankniftyExpiry, SENSEX: sensexExpiry },
          subscribed: 0,
          ws_port: freePort,
          started_at: new Date().toISOString(),
          last_update: new Date().toISOString(),
        }));
      } catch { /* Python writes the real record moments later */ }

      return NextResponse.json({ success: true, message: 'Bridge started', pid: child.pid });
    } finally {
      releaseStartLock();
    }
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
