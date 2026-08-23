import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { isPidRunning } from '@/lib/processCheck';

const DEBUG_DIR    = path.join(PROJECT_ROOT, 'debug');
const PYTHON_EXE   = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const SCRIPT       = path.join(PROJECT_ROOT, 'scripts', 'tools', 'csp_scanner.py');
const STATUS_FILE  = path.join(DEBUG_DIR, 'csp_scan_status.json');
const RESULTS_FILE = path.join(DEBUG_DIR, 'csp_scan_results.json');
const STOP_FILE    = path.join(DEBUG_DIR, 'csp_scan_stop.trigger');

function readJson<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

interface ScanStatus {
  pid: number | null;
  message: string;
  current: number;
  total: number;
  done: boolean;
  error: string | null;
  log?: string[];
  updated_at?: string;
}

/** GET — last completed scan results plus current run status. */
export async function GET() {
  const status = readJson<ScanStatus>(STATUS_FILE);
  const results = readJson<{
    scannedAt: string; universe?: 'nifty50' | 'nifty500'; targetProb: number;
    minNoHit?: number; minOiLots?: number; expiryOffset?: number;
    symbolsScanned?: number; symbolsSkipped?: Record<string, string>;
    apiFailures?: number; rows: unknown[];
  }>(RESULTS_FILE);
  const running = Boolean(status && !status.done && status.pid && isPidRunning(status.pid));

  return NextResponse.json({
    success: true,
    running,
    status,
    scannedAt: results?.scannedAt ?? null,
    // Which universe the currently-displayed rows actually came from — not
    // necessarily what the client's toggle is set to for the *next* scan.
    universe: results?.universe ?? 'nifty500',
    targetProb: results?.targetProb ?? null,
    minNoHit: results?.minNoHit ?? null,
    minOiLots: results?.minOiLots ?? null,
    expiryOffset: results?.expiryOffset ?? 0,
    symbolsScanned: results?.symbolsScanned ?? null,
    // Symbols the scan produced nothing for, with the reason. A throttled chain
    // call and a name with no liquid puts are the same empty result otherwise.
    symbolsSkipped: results?.symbolsSkipped ?? {},
    apiFailures: results?.apiFailures ?? 0,
    rows: results?.rows ?? [],
  });
}

/** POST — start a scan in the background. */
export async function POST(req: NextRequest) {
  const existing = readJson<ScanStatus>(STATUS_FILE);
  if (existing && !existing.done && existing.pid && isPidRunning(existing.pid)) {
    return NextResponse.json({ success: false, error: 'Scan already running', pid: existing.pid }, { status: 409 });
  }

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE);

  const body = await req.json().catch(() => ({}));
  const targetProb = Number(body?.targetProb);
  const limit = Number(body?.limit);
  const minNoHit = Number(body?.minNoHit);
  const expiryOffset = Number(body?.expiryOffset);
  const universe = body?.universe === 'nifty50' ? 'nifty50' : 'nifty500';

  const args = [SCRIPT, '--universe', universe];
  if (Number.isFinite(targetProb) && targetProb > 0 && targetProb < 1) {
    args.push('--target-prob', String(targetProb));
  }
  if (Number.isFinite(minNoHit) && minNoHit >= 0 && minNoHit <= 100) {
    args.push('--min-no-hit', String(minNoHit));
  }
  if (Number.isFinite(expiryOffset) && expiryOffset >= 0 && expiryOffset <= 5) {
    args.push('--expiry-offset', String(Math.floor(expiryOffset)));
  }
  if (Number.isFinite(limit) && limit > 0) {
    args.push('--limit', String(Math.floor(limit)));
  }

  const child = spawn(PYTHON_EXE, args, {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  child.unref();

  // Seed the status with the real PID *after* spawning. Writing pid:null here
  // would make every poll during Python's multi-second startup read as "not
  // running" — the client would drop its poll, and the duplicate-start guard
  // would let a second scanner launch.
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      pid: child.pid ?? null, message: 'Starting…', current: 0, total: 0,
      done: false, error: null, log: [], updated_at: new Date().toISOString(),
    }));
  } catch { /* non-fatal */ }

  return NextResponse.json({ success: true, started: true, pid: child.pid });
}

/** DELETE — signal the running scan to stop. */
export async function DELETE() {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(STOP_FILE, '1');
  return NextResponse.json({ success: true, stopped: true });
}
