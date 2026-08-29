import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { isPidRunning } from '@/lib/processCheck';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR    = path.join(PROJECT_ROOT, 'debug');
const SCRIPT_PATH  = path.join(PROJECT_ROOT, 'scripts', 'downloader', 'download_expired_options.py');
const STATUS_FILE  = path.join(DEBUG_DIR, 'options_refresh_status.json');
const STOP_FILE    = path.join(DEBUG_DIR, 'options_refresh_stop.trigger');

function getPythonExe(): string {
  const candidates = [
    path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe'),
    path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe'),
    path.join(PROJECT_ROOT, 'venv', 'bin', 'python3'),
    path.join(PROJECT_ROOT, 'venv', 'bin', 'python'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function readStatus() {
  try {
    if (!fs.existsSync(STATUS_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export interface OptionsRefreshStatus {
  running: boolean;
  done: boolean;
  message: string;
  error: string | null;
}

export async function GET(): Promise<NextResponse<OptionsRefreshStatus>> {
  const status = readStatus();
  if (!status) return NextResponse.json({ running: false, done: false, message: '', error: null });
  const running = !status.done && !!status.pid && isPidRunning(status.pid);
  return NextResponse.json({
    running,
    done: status.done ?? false,
    message: status.message ?? '',
    error: status.error ?? null,
  });
}

export async function POST(): Promise<NextResponse> {
  const existing = readStatus();
  if (existing && !existing.done && existing.pid && isPidRunning(existing.pid)) {
    return NextResponse.json({ error: 'Already running', pid: existing.pid }, { status: 409 });
  }

  if (fs.existsSync(STOP_FILE)) {
    try { fs.unlinkSync(STOP_FILE); } catch { /* ignore */ }
  }
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  const pythonExe = getPythonExe();
  const child = spawn(pythonExe, [SCRIPT_PATH], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  child.unref();

  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      pid: child.pid, done: false, message: 'Starting…', error: null,
      updated_at: new Date().toISOString(),
    }));
  } catch { /* non-fatal */ }

  return NextResponse.json({ started: true, pid: child.pid });
}

export async function DELETE(): Promise<NextResponse> {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(STOP_FILE, '1');
  return NextResponse.json({ stopped: true });
}
