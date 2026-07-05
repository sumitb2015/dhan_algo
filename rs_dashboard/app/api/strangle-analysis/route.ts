import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR    = path.join(PROJECT_ROOT, 'debug');
const PYTHON_EXE   = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const SCRIPT_PATH  = path.join(PROJECT_ROOT, 'scripts', 'analysis', 'strangle_premium_analysis.py');
const DATA_FILE    = path.join(DEBUG_DIR, 'strangle_premium_analysis.json');
const STATUS_FILE  = path.join(DEBUG_DIR, 'strangle_analysis_status.json');

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const getStatus = searchParams.get('status') === 'true';

  if (getStatus) {
    if (!fs.existsSync(STATUS_FILE)) {
      return NextResponse.json({ status: 'idle', pct: 0, message: '' });
    }
    try {
      return NextResponse.json(JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')));
    } catch {
      return NextResponse.json({ status: 'idle', pct: 0, message: '' });
    }
  }

  if (!fs.existsSync(DATA_FILE)) {
    return NextResponse.json({ error: 'not_generated' }, { status: 404 });
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: 'read_error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let action = 'regenerate';
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.action) action = body.action;
  } catch { /* no body */ }

  if (action !== 'regenerate') {
    return NextResponse.json({ error: 'unknown_action' }, { status: 400 });
  }

  if (fs.existsSync(STATUS_FILE)) {
    try {
      const s = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
      if (s.status === 'running') {
        return NextResponse.json({ error: 'already_running' }, { status: 409 });
      }
    } catch { /* ignore */ }
  }

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  fs.writeFileSync(STATUS_FILE, JSON.stringify({
    status: 'running', pct: 0, message: 'Starting…',
  }));

  const child = spawn(PYTHON_EXE, [SCRIPT_PATH], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  child.unref();

  return NextResponse.json({ status: 'started', pid: child.pid });
}
