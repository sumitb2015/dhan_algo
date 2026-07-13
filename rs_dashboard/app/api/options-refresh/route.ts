import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { isPidRunning } from '@/lib/processCheck';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR    = path.join(PROJECT_ROOT, 'debug');
const PYTHON_EXE   = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const SCRIPT_PATH  = path.join(PROJECT_ROOT, 'scripts', 'downloader', 'download_expired_options.py');
const STATUS_FILE  = path.join(DEBUG_DIR, 'options_refresh_status.json');

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

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  const child = spawn(PYTHON_EXE, [SCRIPT_PATH], {
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
