import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { isPidRunning } from '@/lib/processCheck';
import { PROJECT_ROOT, PYTHON_EXE } from '@/lib/pyExec';

const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');
const COLLECTOR = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_screener_collector.py');
const STATUS_FILE = path.join(DEBUG_DIR, 'options_screener_status.json');
const STOP_TRIGGER = path.join(DEBUG_DIR, 'options_screener_stop.trigger');
const START_LOCK = path.join(DEBUG_DIR, 'options_screener_start.lock');
const LOCK_STALE_MS = 30_000;

interface CollectorStatus {
  status: 'RUNNING' | 'STARTING' | 'STOPPED';
  pid?: number;
  reason?: string;
  error?: string;
  last_error?: string | null;
  last_scan?: string;
  scan_seconds?: number;
  contracts?: number;
  live?: string[];
  updated_at?: string;
}

function readStatus(): CollectorStatus | null {
  try {
    if (!fs.existsSync(STATUS_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')) as CollectorStatus;
  } catch {
    return null;
  }
}

/** A status file saying RUNNING is only true while its pid is alive. */
function currentStatus(): CollectorStatus {
  const s = readStatus();
  if (!s) return { status: 'STOPPED' };
  if ((s.status === 'RUNNING' || s.status === 'STARTING') && s.pid && !isPidRunning(Number(s.pid))) {
    return { ...s, status: 'STOPPED', reason: 'crashed' };
  }
  return s;
}

/** O_EXCL start lock — a status file is not a lock (dhan-polling-guards #1). */
function acquireStartLock(): boolean {
  try {
    fs.writeFileSync(START_LOCK, String(Date.now()), { flag: 'wx' });
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(START_LOCK).mtimeMs > LOCK_STALE_MS) {
        fs.unlinkSync(START_LOCK);
        fs.writeFileSync(START_LOCK, String(Date.now()), { flag: 'wx' });
        return true;
      }
    } catch { /* lost the steal race */ }
    return false;
  }
}

export async function GET() {
  return NextResponse.json({ success: true, status: currentStatus() });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { action?: string };
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  if (body.action === 'stop') {
    fs.writeFileSync(STOP_TRIGGER, '');
    return NextResponse.json({ success: true, message: 'Stop trigger written' });
  }

  if (body.action === 'start') {
    const s = currentStatus();
    if (s.status === 'RUNNING' || s.status === 'STARTING') {
      return NextResponse.json({ success: true, message: 'Collector already running', pid: s.pid });
    }
    if (!acquireStartLock()) {
      return NextResponse.json({ success: true, message: 'Collector start already in progress' });
    }
    try {
      if (fs.existsSync(STOP_TRIGGER)) fs.unlinkSync(STOP_TRIGGER);
      const child = spawn(PYTHON_EXE, [COLLECTOR], {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      // Write STARTING ourselves so a second click in the gap before the script's own
      // first status write sees a live pid instead of "STOPPED".
      fs.writeFileSync(STATUS_FILE, JSON.stringify({ status: 'STARTING', pid: child.pid, updated_at: new Date().toISOString() }));
      return NextResponse.json({ success: true, message: 'Collector started', pid: child.pid });
    } finally {
      try { fs.unlinkSync(START_LOCK); } catch { /* already gone */ }
    }
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
