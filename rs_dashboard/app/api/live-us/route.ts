import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { isPidRunning } from '@/lib/processCheck';
import { PYTHON_EXE } from '@/lib/pyExec';
import {
  bridgeHealth, buildUsRow, nextWatchlist, US_WATCHLIST_MAX, type BridgeStatus, type RawUsQuote,
} from '@/lib/usStocks';
import { getUsMaster, US_DEBUG_DIR } from '@/lib/usStocksServer';

export const dynamic = 'force-dynamic';

// Live US stocks (Dhan Global Stocks feed). READ-ONLY: no US order is placed anywhere in this route.
//   GET                     -> bridge health + the watchlist rows with their latest quotes
//   POST {action:'start'}   -> spawn scripts/tools/live_us_ws.py (atomic start lock, one instance)
//   POST {action:'stop'}    -> write debug/live_us_stop.trigger
//   POST {action:'add'|'remove', id}  -> edit debug/live_us_watchlist.json (serialised, validated against the master)
const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const BRIDGE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'live_us_ws.py');
const WATCHLIST_FILE = path.join(US_DEBUG_DIR, 'live_us_watchlist.json');
const QUOTES_FILE = path.join(US_DEBUG_DIR, 'live_us_quotes.json');
const STATUS_FILE = path.join(US_DEBUG_DIR, 'live_us_status.json');
const STOP_TRIGGER = path.join(US_DEBUG_DIR, 'live_us_stop.trigger');
const START_LOCK = path.join(US_DEBUG_DIR, 'live_us_start.lock');
const LOCK_STALE_MS = 30_000;

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}

function readWatchlist(): string[] {
  const w = readJson<{ ids?: unknown }>(WATCHLIST_FILE);
  return Array.isArray(w?.ids) ? w.ids.map(String).filter(s => /^\d{1,9}$/.test(s)) : [];
}

// Two tabs adding a symbol at once must not both read the old list and have the later write drop the earlier one.
let writeQueue: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => T): Promise<T> {
  const result = writeQueue.then(fn, fn);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

function writeWatchlist(ids: string[]): void {
  fs.mkdirSync(US_DEBUG_DIR, { recursive: true });
  const tmp = `${WATCHLIST_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ids }));
  fs.renameSync(tmp, WATCHLIST_FILE);
}

/** `wx` is O_EXCL: exactly one concurrent Start creates the file. A lock older than LOCK_STALE_MS is from a start that
 *  crashed before releasing, so it is stolen rather than blocking the bridge forever. */
function acquireStartLock(): boolean {
  try { fs.writeFileSync(START_LOCK, String(Date.now()), { flag: 'wx' }); return true; } catch { /* held, or dir missing */ }
  try {
    if (Date.now() - fs.statSync(START_LOCK).mtimeMs > LOCK_STALE_MS) {
      fs.unlinkSync(START_LOCK);
      fs.writeFileSync(START_LOCK, String(Date.now()), { flag: 'wx' });
      return true;
    }
  } catch { /* lost the steal race */ }
  return false;
}

function health(): { status: BridgeStatus | null; health: ReturnType<typeof bridgeHealth> } {
  const status = readJson<BridgeStatus>(STATUS_FILE);
  const alive = typeof status?.pid === 'number' ? isPidRunning(status.pid) : false;
  return { status, health: bridgeHealth(status, alive, Date.now()) };
}

export async function GET(): Promise<NextResponse> {
  let master;
  try { master = await getUsMaster(); } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : 'US instrument list unavailable' }, { status: 502 });
  }
  const h = health();
  const quotes = readJson<{ updated_at?: number; connected?: boolean; market_status?: unknown; quotes?: Record<string, RawUsQuote> }>(QUOTES_FILE);
  const now = Date.now();
  const rows = readWatchlist().flatMap(id => {
    const inst = master.byId.get(id);
    return inst ? [buildUsRow(inst, quotes?.quotes?.[id], now)] : [];
  });
  // Quotes on disk may be from an earlier session. They are still returned (a last snapshot is useful) but `health` and
  // `quotesAgeMs` tell the page whether they are live; the page must not present them as live unless health === 'live'.
  const quotesAgeMs = typeof quotes?.updated_at === 'number' ? Math.max(0, now - quotes.updated_at) : null;
  return NextResponse.json({
    success: true, health: h.health, status: h.status, rows, marketStatus: quotes?.market_status ?? null,
    quotesAgeMs, serverTime: now, max: US_WATCHLIST_MAX, masterSource: master.loadedFrom,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => ({})) as { action?: string; id?: unknown };
  const action = String(body.action ?? '');

  if (action === 'stop') {
    fs.mkdirSync(US_DEBUG_DIR, { recursive: true });
    fs.writeFileSync(STOP_TRIGGER, '');
    return NextResponse.json({ success: true });
  }

  if (action === 'add' || action === 'remove') {
    let master;
    try { master = await getUsMaster(); } catch (err) {
      return NextResponse.json({ success: false, error: err instanceof Error ? err.message : 'US instrument list unavailable' }, { status: 502 });
    }
    const out = await withWriteLock(() => {
      const v = nextWatchlist(readWatchlist(), action, String(body.id ?? ''), master.ids);
      if (!v.ok) return { ok: false as const, error: v.error };
      writeWatchlist(v.ids);
      return { ok: true as const, ids: v.ids };
    });
    if (!out.ok) return NextResponse.json({ success: false, error: out.error }, { status: 400 });
    return NextResponse.json({ success: true, ids: out.ids });
  }

  if (action === 'start') {
    fs.mkdirSync(US_DEBUG_DIR, { recursive: true });
    if (!acquireStartLock()) return NextResponse.json({ success: true, message: 'Start already in progress' });
    try {
      const cur = health();
      if (cur.health === 'live' || cur.health === 'idle' || cur.health === 'reconnecting' || cur.health === 'stale') {
        return NextResponse.json({ success: true, message: 'Bridge already running', pid: cur.status?.pid });
      }
      try { fs.unlinkSync(STOP_TRIGGER); } catch { /* none */ }
      // Append to a log so a silent death leaves a traceback to read.
      const logFd = fs.openSync(path.join(US_DEBUG_DIR, 'live_us_ws.log'), 'a');
      const child = spawn(PYTHON_EXE, ['-u', BRIDGE_SCRIPT], { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true });
      child.unref();
      fs.closeSync(logFd);
      // Hold the lock until the bridge has written its own status, so a second click cannot spawn a second copy
      // during the startup window (the Python side also refuses, but this keeps the log clean).
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 250));
        const st = readJson<BridgeStatus>(STATUS_FILE);
        if (st?.pid === child.pid) break;
      }
      return NextResponse.json({ success: true, message: 'Bridge started', pid: child.pid });
    } finally {
      try { fs.unlinkSync(START_LOCK); } catch { /* already gone */ }
    }
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
