import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { readJsonFile, withFileLock, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { applyOp, validateOp, LedgerError, type LedgerFile } from '@/lib/bearishLedger';

// Ledger behind /bearish-strikes. Own file (never multi_leg_baskets.json — Multi-Leg Focus would
// reconcile paper legs away). Every mutation is a small named op applied under one cross-process
// file lock (lib/lockedJsonFile), so two tabs — or two Next bundles — cannot lose each other's update
// the way a whole-file overwrite would.

const FILE = path.join(PROJECT_ROOT, 'debug', 'bearish_strikes_state.json');
const LOCK = `${FILE}.lock`;
const LOCK_STALE_MS = 5_000;

function read(): LedgerFile {
  const raw = readJsonFile<Partial<LedgerFile>>(FILE);
  return { rev: Number(raw?.rev) || 0, positions: Array.isArray(raw?.positions) ? raw.positions : [] };
}

/** For a write: a file that exists but cannot be parsed is refused, never treated as empty — writing on top of it would
 *  erase every REAL row (and with it the alerts, stops and Exit buttons of live shorts). */
function readForWrite(): LedgerFile {
  if (fs.existsSync(FILE) && readJsonFile(FILE) == null) throw new LedgerError('ledger file is unreadable — fix or move debug/bearish_strikes_state.json', 500);
  return read();
}

export async function GET() {
  return NextResponse.json({ success: true, ...read() });
}

export async function POST(request: NextRequest) {
  const raw = await request.json().catch(() => null);
  try {
    const body = validateOp(raw);
    const next = await withFileLock(LOCK, LOCK_STALE_MS, 'bearish-strikes ledger', () => {
      const out = applyOp(readForWrite(), body);
      writeJsonAtomic(FILE, out, { pretty: true });
      return out;
    });
    return NextResponse.json({ success: true, ...next });
  } catch (err) {
    if (err instanceof LedgerError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
