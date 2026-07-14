import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { clearCache } from '@/lib/dataLoader';
import { clearIndicesCache } from '@/app/api/indices-performance/route';
import { clearMoversCache } from '@/app/api/movers/route';
import { clearBreadthCache } from '@/app/api/breadth/route';
import { isPidRunning } from '@/lib/processCheck';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR    = path.join(PROJECT_ROOT, 'debug');
const PYTHON_EXE   = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');

type Target = 'stocks' | 'indices';

const TARGETS: Record<Target, { script: string; statusFile: string; stopFile: string }> = {
  stocks: {
    script:     path.join(PROJECT_ROOT, 'scripts', 'downloader', 'backfill_stocks_history.py'),
    statusFile: path.join(DEBUG_DIR, 'backfill_status.json'),
    stopFile:   path.join(DEBUG_DIR, 'backfill_stop.trigger'),
  },
  indices: {
    script:     path.join(PROJECT_ROOT, 'scripts', 'downloader', 'backfill_indices_history.py'),
    statusFile: path.join(DEBUG_DIR, 'backfill_indices_status.json'),
    stopFile:   path.join(DEBUG_DIR, 'backfill_indices_stop.trigger'),
  },
};

function parseTarget(value: string | null): Target | null {
  return value === 'stocks' || value === 'indices' ? value : null;
}

function readStatus(statusFile: string) {
  try {
    if (!fs.existsSync(statusFile)) return null;
    return JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
  } catch {
    return null;
  }
}

/** GET ?target=stocks|indices — current backfill status for that target */
export async function GET(req: NextRequest) {
  const target = parseTarget(req.nextUrl.searchParams.get('target'));
  if (!target) {
    return NextResponse.json({ error: 'target must be "stocks" or "indices"' }, { status: 400 });
  }

  const { statusFile } = TARGETS[target];
  const status = readStatus(statusFile);

  if (!status) {
    return NextResponse.json({ running: false, status: null });
  }

  const running = !status.done && status.pid && isPidRunning(status.pid);

  if (!running && !status.done && status.pid) {
    status.done = true;
    status.message = (status.message || '') + ' [process exited]';
    try { fs.writeFileSync(statusFile, JSON.stringify(status)); } catch { /* ignore */ }
  }

  if (!running && status.done) {
    clearCache();
    clearIndicesCache();
    clearMoversCache();
    clearBreadthCache();
  }

  return NextResponse.json({ running, status });
}

/** POST { target: 'stocks' | 'indices', startDate?: 'YYYY-MM-DD' } — start a one-time deep backfill */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const target = parseTarget(body?.target ?? null);
  if (!target) {
    return NextResponse.json({ error: 'target must be "stocks" or "indices"' }, { status: 400 });
  }
  const startDate = typeof body?.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.startDate)
    ? body.startDate
    : '2019-01-01';

  const { script, statusFile, stopFile } = TARGETS[target];

  const existing = readStatus(statusFile);
  if (existing && !existing.done && existing.pid && isPidRunning(existing.pid)) {
    return NextResponse.json({ error: 'Backfill already running', pid: existing.pid }, { status: 409 });
  }

  if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile);
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  try {
    fs.writeFileSync(statusFile, JSON.stringify({
      pid: null, message: 'Starting…', current: 0, total: 0, done: false, error: null,
      log: [], updated_at: new Date().toISOString(),
    }));
  } catch { /* non-fatal */ }

  const child = spawn(PYTHON_EXE, [script, '--start-date', startDate], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  child.unref();

  return NextResponse.json({ started: true, pid: child.pid, target, startDate });
}

/** DELETE ?target=stocks|indices — stop a running backfill */
export async function DELETE(req: NextRequest) {
  const target = parseTarget(req.nextUrl.searchParams.get('target'));
  if (!target) {
    return NextResponse.json({ error: 'target must be "stocks" or "indices"' }, { status: 400 });
  }
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(TARGETS[target].stopFile, '1');
  return NextResponse.json({ stopped: true });
}
