import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';
import {
  applyOp,
  DEFAULT_CONFIG,
  LedgerError,
  type BreakdownStateFile,
  type LedgerOp,
} from '@/lib/breakdownLedger';

const FILE = path.join(PROJECT_ROOT, 'debug', 'breakdown_scalper_state.json');

const todayStr = () => new Date().toISOString().slice(0, 10);

function read(): BreakdownStateFile {
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf-8')) as Partial<BreakdownStateFile>;
      return {
        rev: Number(raw.rev) || 0,
        mode: raw.mode === 'REAL' ? 'REAL' : 'SIM',
        config: { ...DEFAULT_CONFIG, ...(raw.config || {}) },
        positions: Array.isArray(raw.positions) ? raw.positions : [],
        logs: Array.isArray(raw.logs) ? raw.logs : [],
        date: typeof raw.date === 'string' ? raw.date : todayStr(),
      };
    }
  } catch {
    // fallback to initial
  }

  return {
    rev: 0,
    mode: 'SIM',
    config: DEFAULT_CONFIG,
    positions: [],
    logs: [],
    date: todayStr(),
  };
}

function writeAtomic(data: BreakdownStateFile) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, FILE);
}

let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => T): Promise<T> {
  const run = chain.then(fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function GET() {
  return NextResponse.json({ success: true, ...read() });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as LedgerOp | null;
  if (!body || typeof body !== 'object' || typeof (body as { op?: unknown }).op !== 'string') {
    return NextResponse.json({ success: false, error: 'op required' }, { status: 400 });
  }

  try {
    const next = await locked(() => {
      const current = read();
      const out = applyOp(current, body);
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
