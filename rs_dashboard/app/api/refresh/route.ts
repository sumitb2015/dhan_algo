import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn, execSync } from 'child_process';
import { clearCache } from '@/lib/dataLoader';
import { clearIndicesCache } from '@/app/api/indices-performance/route';
import { clearMoversCache } from '@/app/api/movers/route';
import { clearBreadthCache } from '@/app/api/breadth/route';

const PROJECT_ROOT  = path.resolve(process.cwd(), '..');
const DEBUG_DIR     = path.join(PROJECT_ROOT, 'debug');
const PYTHON_EXE    = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const SCRIPT_PATH   = path.join(PROJECT_ROOT, 'scripts', 'downloader', 'refresh_dashboard_data.py');
const STATUS_FILE   = path.join(DEBUG_DIR, 'refresh_status.json');
const STOP_FILE     = path.join(DEBUG_DIR, 'refresh_stop.trigger');

const NIFTY50_CSV = path.join(PROJECT_ROOT, 'Historical Data', 'NIFTY_50_Daily_5Y.csv');

// NSE market holidays. Historical data is published the following day,
// so we never treat today as the reference â€” always work from yesterday back.
const NSE_HOLIDAYS = new Set([
  '2026-01-15', '2026-01-26', '2026-03-03', '2026-03-26',
  '2026-03-31', '2026-04-03', '2026-04-14', '2026-05-01',
  '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02',
  '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25',
]);

/** Most recent completed trading day as YYYY-MM-DD.
 *  Starts from yesterday (Dhan historical API does not publish same-day data)
 *  and steps back over weekends and NSE holidays. */
function getLastTradingDay(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1); // start from yesterday
  for (let i = 0; i < 14; i++) {
    const day = d.getDay(); // 0=Sun, 6=Sat
    const dateStr = d.toLocaleDateString('en-CA');
    if (day !== 0 && day !== 6 && !NSE_HOLIDAYS.has(dateStr)) return dateStr;
    d.setDate(d.getDate() - 1);
  }
  return d.toLocaleDateString('en-CA');
}

/** Read the date from the last data row of a CSV (first column, YYYY-MM-DD). */
function getLastCsvDate(csvPath: string): string | null {
  if (!fs.existsSync(csvPath)) return null;
  try {
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 1; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      const firstCol = line.split(',')[0].replace(/"/g, '').trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(firstCol)) return firstCol.slice(0, 10);
    }
    return null;
  } catch {
    return null;
  }
}

function isPidRunning(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /FI "PID eq ${pid}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
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

/** GET â€” return current refresh status + staleness check */
export async function GET() {
  const lastTradingDay = getLastTradingDay();
  const lastDate = getLastCsvDate(NIFTY50_CSV);
  const stale = lastDate !== null && lastDate < lastTradingDay;

  const status = readStatus();

  if (!status) {
    return NextResponse.json({ running: false, status: null, stale, lastDate, lastTradingDay });
  }

  // Cross-check: if the status says running but the PID is dead, mark it done
  const running = !status.done && status.pid && isPidRunning(status.pid);

  // If we just detected it finished, clear the data cache so next scan is fresh
  if (!running && !status.done && status.pid) {
    status.done = true;
    status.message = (status.message || '') + ' [process exited]';
    try { fs.writeFileSync(STATUS_FILE, JSON.stringify(status)); } catch { /* ignore */ }
    clearCache();
    clearIndicesCache();
    clearMoversCache();
    clearBreadthCache();
  }

  // If it finished cleanly, also clear cache once
  if (status.done && (status.phase === 'done' || status.phase === 'quotes')) {
    clearCache();
    clearIndicesCache();
    clearMoversCache();
    clearBreadthCache();
  }

  return NextResponse.json({ running, status, stale, lastDate, lastTradingDay });
}

/** POST â€” start the refresh process */
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

  // Reset status file so the poll doesn't see the previous run's done=true
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      pid: null, phase: target, message: 'Startingâ€¦',
      current: 0, total: 0, done: false, error: null,
      log: [], updated_at: new Date().toISOString(),
    }));
  } catch { /* non-fatal */ }

  const child = spawn(PYTHON_EXE, [SCRIPT_PATH, '--target', target], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  child.unref();

  return NextResponse.json({ started: true, pid: child.pid, target });
}

/** DELETE â€” stop the running refresh */
export async function DELETE() {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(STOP_FILE, '1');
  return NextResponse.json({ stopped: true });
}
