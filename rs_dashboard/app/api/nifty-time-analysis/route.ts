import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { isPidRunning } from '@/lib/processCheck';
import { PYTHON_EXE } from '@/lib/pyExec';

const PROJECT_ROOT  = path.resolve(process.cwd(), '..');
const DEBUG_DIR      = path.join(PROJECT_ROOT, 'debug');
const COLLECTOR       = path.join(PROJECT_ROOT, 'scripts', 'tools', 'nifty_time_analysis_collector.py');
const STATUS_FILE    = path.join(DEBUG_DIR, 'nifty_time_analysis_status.json');
const STOP_TRIGGER   = path.join(DEBUG_DIR, 'nifty_time_analysis_stop.trigger');

const ALLOWED_INTERVALS = [1, 3, 5, 15, 30] as const;
type Interval = (typeof ALLOWED_INTERVALS)[number];

const LOCK_STALE_MS = 30_000;

export interface NiftyTimeAnalysisRow {
  time: string;
  spot: number; spot_dir: -1 | 0 | 1;
  fut: number; fut_dir: -1 | 0 | 1;
  fut_spot_diff: number; fut_spot_diff_dir: -1 | 0 | 1;
  avg_price: number; avg_price_dir: -1 | 0 | 1;
  max_pain: number; max_pain_dir: -1 | 0 | 1;
  pcr: number;
  atm: number; atm_dir: -1 | 0 | 1;
  vix: number; vix_dir: -1 | 0 | 1;
  fut_oi_chg_pct: number | null;
  highest_put_oi_strike: number;
  highest_put_oi_lakhs: number;
  highest_call_oi_strike: number;
  highest_call_oi_lakhs: number;
  straddle_delta: number | null;
  vol_bias: string;
  bias: string;
}

export interface NiftyTimeAnalysisResponse {
  success: boolean;
  status: { status: string; pid?: number; interval_min?: number; rows?: number; last_update?: string; error?: string; reason?: string };
  date: string | null;
  interval_min: number | null;
  nearest_expiry: string | null;
  rows: NiftyTimeAnalysisRow[];
  error?: string;
}

function readJson(file: string): any | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function dataPath(dateStr: string, interval: number): string {
  return path.join(DEBUG_DIR, `nifty_time_analysis_${dateStr}_${interval}m.json`);
}

function todayStr(): string {
  // IST date — server may run in any TZ, so build it from an IST-shifted UTC time.
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Reject anything that isn't a plain YYYY-MM-DD before it reaches a filesystem
 *  path — the raw query param must never flow into `path.join` unchecked. */
function safeDateParam(raw: string | null): string {
  return raw && DATE_RE.test(raw) ? raw : todayStr();
}

function acquireStartLock(lockPath: string): boolean {
  try {
    fs.writeFileSync(lockPath, String(Date.now()), { flag: 'wx' });
    return true;
  } catch {
    try {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age > LOCK_STALE_MS) {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, String(Date.now()), { flag: 'wx' });
        return true;
      }
    } catch { /* race lost to another starter */ }
    return false;
  }
}

function releaseStartLock(lockPath: string): void {
  try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
}

/** GET — rows for the requested (or today's) date + interval, plus collector status. */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const intervalParam = Number(searchParams.get('interval') ?? 15);
  const interval: Interval = (ALLOWED_INTERVALS as readonly number[]).includes(intervalParam)
    ? (intervalParam as Interval)
    : 15;
  const dateStr = safeDateParam(searchParams.get('date'));

  const status = readJson(STATUS_FILE) ?? { status: 'STOPPED' };
  if (status.pid && status.status === 'RUNNING' && !isPidRunning(Number(status.pid))) {
    status.status = 'STOPPED';
  }

  const fileData = readJson(dataPath(dateStr, interval));

  const body: NiftyTimeAnalysisResponse = {
    success: true,
    status,
    date: fileData?.date ?? null,
    interval_min: fileData?.interval_min ?? null,
    nearest_expiry: fileData?.nearest_expiry ?? null,
    rows: fileData?.rows ?? [],
  };
  return NextResponse.json(body);
}

/** POST — start or stop the background collector for a given interval. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const action: string = body.action ?? '';
  const intervalParam = Number(body.interval_min ?? 15);
  const interval: Interval = (ALLOWED_INTERVALS as readonly number[]).includes(intervalParam)
    ? (intervalParam as Interval)
    : 15;

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  if (action === 'stop') {
    fs.writeFileSync(STOP_TRIGGER, '');
    return NextResponse.json({ success: true, message: 'Stop trigger written' });
  }

  if (action === 'start') {
    const status = readJson(STATUS_FILE);
    if (status && status.pid && status.status === 'RUNNING' && isPidRunning(Number(status.pid))) {
      if (Number(status.interval_min) !== interval) {
        return NextResponse.json({
          success: false,
          error: `Collector already running at ${status.interval_min}m — stop it before starting a new interval`,
        }, { status: 409 });
      }
      return NextResponse.json({ success: true, message: 'Collector already running', pid: status.pid });
    }

    const lockPath = path.join(DEBUG_DIR, 'nifty_time_analysis_start.lock');
    if (!acquireStartLock(lockPath)) {
      return NextResponse.json({ success: false, error: 'Another start is already in progress' }, { status: 409 });
    }

    try {
      if (fs.existsSync(STOP_TRIGGER)) fs.unlinkSync(STOP_TRIGGER);

      const child = spawn(PYTHON_EXE, [COLLECTOR, '--interval-min', String(interval)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: PROJECT_ROOT,
      });
      child.unref();

      return NextResponse.json({ success: true, message: 'Collector started', pid: child.pid, interval_min: interval });
    } finally {
      releaseStartLock(lockPath);
    }
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
