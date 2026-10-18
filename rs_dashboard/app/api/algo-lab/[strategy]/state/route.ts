import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { getStrategy, strategyConfig } from '@/lib/algoLab/registry';
import { applyOp, normalizeState, type LedgerOp } from '@/lib/algoLab/ledger';
import { AlgoError, type AlgoStateFile } from '@/lib/algoLab/types';

// Algo Lab ledger of one strategy (debug/algo_lab/<key>_state.json). GET = the file; POST = one op, applied by the
// pure lib/algoLab/ledger.ts applyOp, serialised per strategy and written atomically (tmp + rename).

const DIR = path.join(PROJECT_ROOT, 'debug', 'algo_lab');
const fileOf = (key: string) => path.join(DIR, `${key}_state.json`);

function read(key: string): AlgoStateFile {
  const def = getStrategy(key)!;
  const { fields, defaults } = strategyConfig(def);
  let raw: unknown = null;
  try {
    raw = JSON.parse(fs.readFileSync(fileOf(key), 'utf-8'));
  } catch {
    /* no file yet, or unreadable: start empty */
  }
  return normalizeState(key, fields, defaults, raw);
}

function writeAtomic(key: string, data: AlgoStateFile) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${fileOf(key)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, fileOf(key));
}

const chains = new Map<string, Promise<unknown>>();
function locked<T>(key: string, fn: () => T): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn);
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ strategy: string }> }) {
  const { strategy } = await params;
  if (!getStrategy(strategy)) return NextResponse.json({ success: false, error: 'unknown strategy' }, { status: 404 });
  return NextResponse.json({ success: true, ...read(strategy) });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ strategy: string }> }) {
  const { strategy } = await params;
  const def = getStrategy(strategy);
  if (!def) return NextResponse.json({ success: false, error: 'unknown strategy' }, { status: 404 });
  const body = (await request.json().catch(() => null)) as LedgerOp | null;
  if (!body || typeof body !== 'object' || typeof (body as { op?: unknown }).op !== 'string') {
    return NextResponse.json({ success: false, error: 'op required' }, { status: 400 });
  }
  const { fields, defaults } = strategyConfig(def);
  try {
    const next = await locked(strategy, () => {
      const cur = read(strategy);
      const out = applyOp(cur, body, fields, defaults);
      if (out !== cur) writeAtomic(strategy, out);
      return out;
    });
    return NextResponse.json({ success: true, ...next });
  } catch (err) {
    if (err instanceof AlgoError) return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
