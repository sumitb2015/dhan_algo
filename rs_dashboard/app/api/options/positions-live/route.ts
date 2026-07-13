import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { isPidRunning } from '@/lib/processCheck';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const DEBUG_DIR      = path.join(PROJECT_ROOT, 'debug');
const DATA_FILE      = path.join(DEBUG_DIR, 'live_positions_data.json');
const STATUS_FILE    = path.join(DEBUG_DIR, 'live_positions_status.json');
const STOP_TRIGGER   = path.join(DEBUG_DIR, 'live_positions_stop.trigger');
const PYTHON_EXE      = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const PYTHON_SYNC     = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe');
const BRIDGE_SCRIPT   = path.join(PROJECT_ROOT, 'scripts', 'tools', 'live_positions_ws.py');
const HISTORY_SCRIPT  = path.join(PROJECT_ROOT, 'scripts', 'tools', 'positions_history.py');
const LIVE_SCRIPT     = path.join(PROJECT_ROOT, 'scripts', 'tools', 'positions_live_data.py');

// positions_live_data.py takes a couple seconds (master-list load + Dhan REST calls).
// OptionsPositionsTab polls this every `pollMs` (default 30s, adjustable down to 2s)
// without a `mode` param, so it always lands on the REST branch below — cache briefly
// so back-to-back polls (or multiple open tabs) don't each pay for a fresh spawn.
const REST_CACHE_TTL = 3000;
let restCache: { data: Record<string, unknown>; ts: number } | null = null;

function getBridgeStatus() {
  let bridge_status = { status: 'STOPPED', subscribed: 0, pid: 0 };
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')) as { status?: string; pid?: number; subscribed?: number };
      if (status && status.pid && (status.status === 'RUNNING' || status.status === 'STARTING' || status.status === 'ERROR')) {
        if (isPidRunning(status.pid)) {
          bridge_status = {
            status: status.status,
            subscribed: status.subscribed || 0,
            pid: status.pid
          };
        }
      }
    }
  } catch {}
  return bridge_status;
}

function ensureBridgeRunning() {
  try {
    if (!fs.existsSync(DEBUG_DIR)) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
    }
    
    const status = getBridgeStatus();
    if (status.status !== 'RUNNING' && status.status !== 'STARTING') {
      console.log('[positions-live API] Spawning live_positions_ws.py WebSocket bridge...');
      if (fs.existsSync(STOP_TRIGGER)) {
        fs.unlinkSync(STOP_TRIGGER);
      }
      
      const child = spawn(
        PYTHON_EXE,
        [BRIDGE_SCRIPT],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      child.unref();
    }
  } catch (err) {
    console.error('[positions-live API] Failed to start/verify positions WebSocket bridge:', err);
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode        = searchParams.get('mode') || 'rest';
  const wantHistory = searchParams.get('history') === 'true';

  // ── History seed mode: spawn Python script for full intraday candle history ──
  if (wantHistory) {
    try {
      const { stdout } = await execFileAsync(PYTHON_SYNC, [HISTORY_SCRIPT], {
        timeout: 45000,
        encoding: 'utf8',
        cwd: PROJECT_ROOT,
      });
      const lastLine = (stdout || '').trim().split('\n').pop() ?? '{}';
      const parsed = JSON.parse(lastLine) as { history?: unknown[]; error?: string };
      return NextResponse.json({ history: parsed.history ?? [], error: parsed.error });
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string };
      if (e.stdout) {
        try {
          const lastLine = String(e.stdout).trim().split('\n').pop() ?? '{}';
          const parsed = JSON.parse(lastLine) as { history?: unknown[]; error?: string };
          return NextResponse.json({ history: parsed.history ?? [], error: parsed.error });
        } catch {}
      }
      if (e.stderr) console.error('[positions-live] positions_history.py stderr:', e.stderr);
      return NextResponse.json({ history: [], error: 'script_error' });
    }
  }

  const bridge_status = getBridgeStatus();

  if (mode === 'live') {
    // 1. Ensure the WebSocket bridge is active in the background
    ensureBridgeRunning();

    // 2. Try to read from the WebSocket output JSON file
    try {
      if (fs.existsSync(DATA_FILE)) {
        const mtime = fs.statSync(DATA_FILE).mtimeMs;
        // If the file is fresh (less than 6 seconds old), serve it!
        if (Date.now() - mtime < 6000) {
          const payload = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) as Record<string, unknown>;
          const HISTORY_FILE = path.join(DEBUG_DIR, 'live_positions_history.json');
          if (fs.existsSync(HISTORY_FILE)) {
            try {
              const hist = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) as { history: unknown[] };
              payload.history = hist.history || [];
            } catch {}
          }
          payload.bridge_status = bridge_status;
          return NextResponse.json(payload);
        }
      }
    } catch (err) {
      console.warn('[positions-live API] Failed to read live_positions_data.json, falling back to REST:', err);
    }
  }

  // ── Python script: positions + LTPs + VIX via DhanHelper SDK ────────
  if (restCache && Date.now() - restCache.ts < REST_CACHE_TTL) {
    return NextResponse.json({ ...restCache.data, bridge_status });
  }

  const fallback = { has_positions: false, net_premium: 0, vix: 0, legs: [], timestamp: new Date().toISOString() };
  try {
    const { stdout } = await execFileAsync(PYTHON_SYNC, [LIVE_SCRIPT], {
      timeout: 20000,
      encoding: 'utf8',
      cwd: PROJECT_ROOT,
    });
    const lastLine = (stdout || '').trim().split('\n').pop() ?? '{}';
    const parsed = JSON.parse(lastLine) as Record<string, unknown>;
    restCache = { data: parsed, ts: Date.now() };
    return NextResponse.json({ ...parsed, bridge_status });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    if (e.stdout) {
      try {
        const lastLine = String(e.stdout).trim().split('\n').pop() ?? '{}';
        const parsed = JSON.parse(lastLine) as Record<string, unknown>;
        restCache = { data: parsed, ts: Date.now() };
        return NextResponse.json({ ...parsed, bridge_status });
      } catch {}
    }
    if (e.stderr) console.error('[positions-live] positions_live_data.py stderr:', e.stderr);
    return NextResponse.json({ ...fallback, error: 'script_error', bridge_status });
  }
}

// ── POST — start or stop the WebSocket bridge manually ────────────
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action ?? '');

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  if (action === 'stop') {
    fs.writeFileSync(STOP_TRIGGER, '');
    return NextResponse.json({ success: true, message: 'Stop trigger written' });
  }

  if (action === 'start') {
    if (fs.existsSync(STOP_TRIGGER)) fs.unlinkSync(STOP_TRIGGER);
    const child = spawn(
      PYTHON_EXE,
      [BRIDGE_SCRIPT],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
    return NextResponse.json({ success: true, message: 'Positions bridge started', pid: child.pid });
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}

