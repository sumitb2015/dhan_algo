import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { spawn } from 'child_process';
import { PROJECT_ROOT, PYTHON_EXE } from '@/lib/pyExec';
import { isPidRunning } from '@/lib/processCheck';
import { NIFTY50_SYMBOLS } from '@/lib/nifty50';
import { parseConstituentSymbols, readNifty500List } from '@/lib/dataLoader';

export const dynamic = 'force-dynamic';

const DEBUG_DIR     = path.join(PROJECT_ROOT, 'debug');
const BRIDGE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'daily_market_ws.py');
const QUOTES_FILE   = path.join(DEBUG_DIR, 'daily_market_quotes.json');
const STATUS_FILE   = path.join(DEBUG_DIR, 'daily_market_status.json');
const BASELINE_FILE = path.join(DEBUG_DIR, 'daily_market_baseline.json');
const STOP_TRIGGER  = path.join(DEBUG_DIR, 'daily_market_stop.trigger');
const LOCK_FILE     = path.join(DEBUG_DIR, 'daily_market_start.lock');
const INDEX_DIR     = path.join(PROJECT_ROOT, 'index_constituents');
const BANKNIFTY_CSV = path.join(PROJECT_ROOT, 'index_constituents', 'niftybank.csv');

const LOCK_STALE_MS = 25_000;

function acquireStartLock(): boolean {
  try {
    fs.writeFileSync(LOCK_FILE, String(Date.now()), { flag: 'wx' });
    return true;
  } catch {
    try {
      const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (age > LOCK_STALE_MS) {
        fs.unlinkSync(LOCK_FILE);
        fs.writeFileSync(LOCK_FILE, String(Date.now()), { flag: 'wx' });
        return true;
      }
    } catch {
      // lost race
    }
    return false;
  }
}

function releaseStartLock(): void {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

function readJson<T = unknown>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function findFreePort(startPort: number): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => {
      resolve(findFreePort(startPort + 1));
    });
    server.listen(startPort, '127.0.0.1', () => {
      server.close(() => resolve(startPort));
    });
  });
}

function getBankNiftySymbols(): string[] {
  try {
    if (fs.existsSync(BANKNIFTY_CSV)) {
      const content = fs.readFileSync(BANKNIFTY_CSV, 'utf8');
      const syms = parseConstituentSymbols(content);
      if (syms.length > 0) return syms;
    }
  } catch { /* fallback */ }
  return [
    'AUBANK', 'AXISBANK', 'BANKBARODA', 'CANBK', 'FEDERALBNK',
    'HDFCBANK', 'ICICIBANK', 'IDFCFIRSTB', 'INDUSINDBK',
    'KOTAKBANK', 'PNB', 'SBIN', 'UNIONBANK', 'YESBANK',
  ];
}

function readIndexSymbols(file: string): string[] {
  try {
    return parseConstituentSymbols(fs.readFileSync(path.join(INDEX_DIR, file), 'utf8'));
  } catch {
    return [];
  }
}

interface StatusPayload {
  status: string;
  pid?: number;
  ws_port?: number;
  subscribed?: number;
  started_at?: string;
  last_update?: string;
}

/** GET — live quotes, status, baseline, and index constituent lists */
export async function GET() {
  const quotes = readJson<Record<string, unknown>>(QUOTES_FILE);
  const status = readJson<StatusPayload>(STATUS_FILE);
  const baseline = readJson<Record<string, unknown>>(BASELINE_FILE);

  let activeStatus: StatusPayload = status ?? { status: 'STOPPED', subscribed: 0 };
  if (activeStatus && activeStatus.pid && (activeStatus.status === 'RUNNING' || activeStatus.status === 'STARTING')) {
    if (!isPidRunning(Number(activeStatus.pid))) {
      activeStatus = { ...activeStatus, status: 'STOPPED' };
    }
  }

  const nifty50 = NIFTY50_SYMBOLS;
  const banknifty = getBankNiftySymbols();
  const nifty500 = readNifty500List();

  return NextResponse.json({
    success: true,
    status: activeStatus,
    ws_port: activeStatus.ws_port ?? 8975,
    quotes: quotes ?? { count: 0, quotes: {} },
    baseline: baseline ?? null,
    indexConstituents: {
      nifty50,
      banknifty,
      nifty500,
      next50: readIndexSymbols('niftynext50.csv'),
      midcap150: readIndexSymbols('niftymidcap150.csv'),
      smallcap250: readIndexSymbols('niftysmallcap250.csv'),
    },
  });
}

/** POST — start or stop the Daily Market bridge */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as { action?: string };
  const action = body.action ?? '';

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  // ── Stop Action ────────────────────────────────────────────────────────────
  if (action === 'stop') {
    fs.writeFileSync(STOP_TRIGGER, '');
    return NextResponse.json({ success: true, message: 'Stop trigger written' });
  }

  // ── Start Action ───────────────────────────────────────────────────────────
  if (action === 'start') {
    const status = readJson<StatusPayload>(STATUS_FILE);
    // STARTING counts: the bridge spends several seconds loading baselines and resolving
    // security ids before it flips to RUNNING, and the start lock is already released by then.
    if (
      status && status.pid &&
      (status.status === 'RUNNING' || status.status === 'STARTING') &&
      isPidRunning(Number(status.pid))
    ) {
      return NextResponse.json({
        success: true,
        message: status.status === 'STARTING' ? 'Bridge start already in progress' : 'Bridge already running',
        pid: status.pid,
        ws_port: status.ws_port ?? 8975,
      });
    }

    if (!acquireStartLock()) {
      return NextResponse.json({
        success: true,
        message: 'Bridge start already in progress',
        ws_port: status?.ws_port ?? 8975,
      });
    }

    try {
      if (fs.existsSync(STOP_TRIGGER)) {
        try { fs.unlinkSync(STOP_TRIGGER); } catch { /* ignore */ }
      }

      const freePort = await findFreePort(8975);
      const child = spawn(PYTHON_EXE, [BRIDGE_SCRIPT, '--ws-port', String(freePort)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();

      const initialStatus: StatusPayload = {
        status: 'STARTING',
        pid: child.pid,
        ws_port: freePort,
        subscribed: 0,
        started_at: new Date().toISOString(),
        last_update: new Date().toISOString(),
      };
      fs.writeFileSync(STATUS_FILE, JSON.stringify(initialStatus));

      return NextResponse.json({
        success: true,
        message: 'Bridge started',
        pid: child.pid,
        ws_port: freePort,
      });
    } finally {
      releaseStartLock();
    }
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
