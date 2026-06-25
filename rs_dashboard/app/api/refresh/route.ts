import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn, execSync } from 'child_process';
import { clearCache } from '@/lib/dataLoader';

const PROJECT_ROOT  = path.resolve(process.cwd(), '..');
const DEBUG_DIR     = path.join(PROJECT_ROOT, 'debug');
const PYTHON_EXE    = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe');
const SCRIPT_PATH   = path.join(PROJECT_ROOT, 'scripts', 'downloader', 'refresh_dashboard_data.py');
const STATUS_FILE   = path.join(DEBUG_DIR, 'refresh_status.json');
const STOP_FILE     = path.join(DEBUG_DIR, 'refresh_stop.trigger');

function isPidRunning(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /FI "PID eq ${pid}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      return out.includes(pid.toString());
    }
    execSync(`ps -p ${pid}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readStatus() {
  try {
    if (!fs.existsSync(STATUS_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

/** GET — return current refresh status */
export async function GET() {
  const status = readStatus();

  if (!status) {
    return NextResponse.json({ running: false, status: null });
  }

  // Cross-check: if the status says running but the PID is dead, mark it done
  const running = !status.done && status.pid && isPidRunning(status.pid);

  // If we just detected it finished, clear the data cache so next scan is fresh
  if (!running && !status.done && status.pid) {
    status.done = true;
    status.message = (status.message || '') + ' [process exited]';
    try { fs.writeFileSync(STATUS_FILE, JSON.stringify(status)); } catch { /* ignore */ }
    clearCache();
  }

  // If it finished cleanly, also clear cache once
  if (status.done && status.phase === 'done') {
    clearCache();
  }

  return NextResponse.json({ running, status });
}

/** POST — start the refresh process */
export async function POST(req: NextRequest) {
  // Check if already running
  const existing = readStatus();
  if (existing && !existing.done && existing.pid && isPidRunning(existing.pid)) {
    return NextResponse.json({ error: 'Refresh already running', pid: existing.pid }, { status: 409 });
  }

  // Remove stale stop trigger
  if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE);
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  // Read optional target from body
  let target = 'all';
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.target) target = body.target;
  } catch { /* no body */ }

  const child = spawn(PYTHON_EXE, [SCRIPT_PATH, '--target', target], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  child.unref();

  return NextResponse.json({ started: true, pid: child.pid, target });
}

/** DELETE — stop the running refresh */
export async function DELETE() {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(STOP_FILE, '1');
  return NextResponse.json({ stopped: true });
}
