import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { readNifty50Index } from '@/lib/dataLoader';
import { isPidRunning } from '@/lib/processCheck';
import { PYTHON_EXE } from '@/lib/pyExec';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'get_trade_pnl_by_segment.py');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');
const TRADE_HISTORY_FILE = path.join(DEBUG_DIR, 'portfolio_trade_history.json');
const SYNC_STATUS_FILE = path.join(DEBUG_DIR, 'portfolio_trades_sync_status.json');

interface SyncStatus {
  pid: number;
  started: string;
  done: boolean;
  finished?: string;
  // Set by get_trade_pnl_by_segment.py when Dhan's /trades endpoint errors. Without it a broker-side
  // outage looks identical to "nothing new to sync" and the page just shows stale days.
  error?: string | null;
}

function readSyncStatus(): SyncStatus | null {
  try {
    if (!fs.existsSync(SYNC_STATUS_FILE)) return null;
    return JSON.parse(fs.readFileSync(SYNC_STATUS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function isSyncRunning(): boolean {
  const status = readSyncStatus();
  if (!status || status.done || !status.pid) return false;
  const running = isPidRunning(status.pid);
  if (!running) {
    try { fs.writeFileSync(SYNC_STATUS_FILE, JSON.stringify({ ...status, done: true })); } catch { /* ignore */ }
  }
  return running;
}

export async function GET() {
  try {
    const syncRunning = isSyncRunning();
    const syncError = syncRunning ? null : (readSyncStatus()?.error ?? null);
    if (!fs.existsSync(TRADE_HISTORY_FILE)) {
      return NextResponse.json({ success: true, available: false, syncRunning, syncError });
    }
    const data = JSON.parse(fs.readFileSync(TRADE_HISTORY_FILE, 'utf-8'));

    // "Trading Days" (available NSE market days in the reporting window) is distinct from "Traded On"
    // (days the account actually placed a trade) — reuse the Nifty 50 index CSV as the real market
    // calendar rather than assuming every weekday is a trading day (misses exchange holidays). Return
    // the actual dates (not just a total count) so the frontend can scope this per week/month too.
    let marketTradingDates: string[] = [];
    if (data.fromDate && data.toDate) {
      const nifty = readNifty50Index();
      marketTradingDates = nifty.filter((r) => r.date >= data.fromDate && r.date <= data.toDate).map((r) => r.date);
    }

    return NextResponse.json({ success: true, available: true, syncRunning, syncError, marketTradingDates, ...data });
  } catch {
    return NextResponse.json({ success: true, available: false, syncRunning: false });
  }
}

// POST { action: "sync" } — incremental sync: refetches only from the last stored trade date and
// recomputes (~seconds), vs the full 2-year refetch the Reports page runs (~5 min).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.action !== 'sync') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
  if (isSyncRunning()) {
    return NextResponse.json({ started: false, alreadyRunning: true });
  }
  if (!fs.existsSync(TRADE_HISTORY_FILE)) {
    return NextResponse.json(
      { started: false, error: 'No base data yet — run "Trade P&L by Segment" from Reports first (full fetch).' },
      { status: 409 },
    );
  }

  const child = spawn(PYTHON_EXE, [SCRIPT, '--incremental'], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  child.unref();

  try {
    fs.writeFileSync(SYNC_STATUS_FILE, JSON.stringify({ pid: child.pid, started: new Date().toISOString(), done: false, error: null }));
  } catch { /* ignore */ }

  return NextResponse.json({ started: true, pid: child.pid });
}
