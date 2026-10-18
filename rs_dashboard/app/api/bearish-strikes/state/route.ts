import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { applyOp, validateOp, LedgerError, type LedgerFile } from '@/lib/bearishLedger';

// Ledger behind /bearish-strikes. Own file (never multi_leg_baskets.json — Multi-Leg Focus would
// reconcile paper legs away). Every mutation is a small named op applied under one in-process
// lock, so two tabs cannot lose each other's update the way a whole-file overwrite would.

const FILE = path.join(PROJECT_ROOT, 'debug', 'bearish_strikes_state.json');

function read(): LedgerFile {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf-8')) as Partial<LedgerFile>;
    return { rev: Number(raw.rev) || 0, positions: Array.isArray(raw.positions) ? raw.positions : [] };
  } catch {
    return { rev: 0, positions: [] };
  }
}

function writeAtomic(data: LedgerFile) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, FILE);
}

let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => T): Promise<T> {
  const run = chain.then(fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

export async function GET() {
  return NextResponse.json({ success: true, ...read() });
}

export async function POST(request: NextRequest) {
  const raw = await request.json().catch(() => null);
  try {
    const body = validateOp(raw);
    const next = await locked(() => {
      const out = applyOp(read(), body);
      writeAtomic(out);
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
