import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { isPidRunning } from '@/lib/processCheck';
import { ANALYTICS_UNDERLYINGS, type AnalyticsUnderlying } from '@/lib/analyticsUnderlyings';

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const DEBUG_DIR      = path.join(PROJECT_ROOT, 'debug');
const PYTHON_EXE     = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const SCRIPT_PATH    = path.join(PROJECT_ROOT, 'scripts', 'tools', 'antigravity_options_analyzer.py');
const STATUS_FILE    = path.join(DEBUG_DIR, 'options_analyzer_status.json');
const STOP_TRIGGER   = path.join(DEBUG_DIR, 'options_analyzer_stop.trigger');

interface DaemonStatus {
  pid?: number;
  status: 'RUNNING' | 'STOPPED';
  underlying?: string;
  broker?: string;
  interval?: number;
  lastHeartbeat?: string;
  lastSummary?: string;
  activeSuggestionsCount?: number;
  reason?: string;
}

function readJson<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** GET — return daemon status, cross-checked with process table */
export async function GET() {
  const status = readJson<DaemonStatus>(STATUS_FILE);

  if (status && status.pid && status.status === 'RUNNING') {
    if (!isPidRunning(Number(status.pid))) {
      status.status = 'STOPPED';
      status.reason = 'crashed or terminated';
    }
  }

  return NextResponse.json({
    success: true,
    status: status ?? { status: 'STOPPED' },
  });
}

/** POST — start or stop the Antigravity background sentinel daemon */
export async function POST(request: NextRequest) {
  let body: { action?: string; underlying?: string; broker?: string; interval?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const action = body.action ?? '';
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  if (action === 'stop') {
    fs.writeFileSync(STOP_TRIGGER, '');
    return NextResponse.json({ success: true, message: 'Stop trigger written' });
  }

  if (action === 'start') {
    const underlyingRaw = (body.underlying ?? 'NIFTY').toUpperCase();
    if (!ANALYTICS_UNDERLYINGS.includes(underlyingRaw as AnalyticsUnderlying)) {
      return NextResponse.json({ success: false, error: `Invalid underlying: ${underlyingRaw}` }, { status: 400 });
    }
    const underlying = underlyingRaw as AnalyticsUnderlying;
    const broker = body.broker === 'kotak' ? 'kotak' : 'dhan';
    const interval = Math.max(30, Number(body.interval) || 180);

    // Prevent duplicate spawns
    const status = readJson<DaemonStatus>(STATUS_FILE);
    if (status && status.pid && status.status === 'RUNNING' && isPidRunning(Number(status.pid))) {
      return NextResponse.json({
        success: true,
        message: 'Sentinel daemon is already running',
        pid: status.pid,
        underlying: status.underlying,
      });
    }

    // Clear stale stop trigger
    if (fs.existsSync(STOP_TRIGGER)) {
      try { fs.unlinkSync(STOP_TRIGGER); } catch {}
    }

    const args = [
      SCRIPT_PATH,
      '--underlying', underlying,
      '--broker', broker,
      '--daemon',
      '--interval', String(interval),
    ];

    const child = spawn(PYTHON_EXE, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    return NextResponse.json({
      success: true,
      message: `Antigravity Sentinel daemon started for ${underlying}`,
      pid: child.pid,
      underlying,
      interval,
    });
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
