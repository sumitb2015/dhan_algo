import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { pruneState, TS_MAX_LOTS, type TsPosition, type TsState } from '@/lib/tripleStraddle';

// Triple Straddle's own ledger. Deliberately NOT debug/multi_leg_baskets.json: the
// Multi-Leg Focus page reconciles every basket in that file against the broker and
// would wipe paper (SIM) legs as "flat at the broker".
const FILE = path.join(PROJECT_ROOT, 'debug', 'triple_straddle_state.json');

// In-process promise chain: a read-modify-write of one JSON file must never interleave.
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => T): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

function read(): TsState {
  try {
    if (!fs.existsSync(FILE)) return { positions: [] };
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf-8')) as Partial<TsState>;
    return { positions: Array.isArray(raw.positions) ? raw.positions : [], updatedAt: raw.updatedAt };
  } catch (err) {
    // Unreadable ledger must not be silently replaced by an empty one.
    throw new Error(`triple_straddle_state.json unreadable: ${String(err)}`);
  }
}

function write(state: TsState): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2), 'utf-8');
  fs.renameSync(tmp, FILE);
}

function validPosition(p: unknown): p is TsPosition {
  const x = p as TsPosition;
  return !!x && typeof x.id === 'string' && ['left', 'center', 'right'].includes(x.slot)
    && (x.side === 'B' || x.side === 'S') && (x.mode === 'SIM' || x.mode === 'REAL')
    && Number.isInteger(x.lots) && x.lots > 0 && x.lots <= TS_MAX_LOTS
    && Array.isArray(x.legs) && x.legs.length === 2 && typeof x.strike === 'number';
}

export async function GET(): Promise<NextResponse> {
  try {
    const state = await withLock(() => {
      const s = read();
      const pruned = pruneState(s);
      if (pruned.positions.length !== s.positions.length) write(pruned);
      return pruned;
    });
    return NextResponse.json({ success: true, data: state });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

/** Upsert one position by id. A CLOSED stored position is never reopened by a stale write. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json() as { position?: unknown };
    if (!validPosition(body.position)) {
      return NextResponse.json({ success: false, error: 'invalid position' }, { status: 400 });
    }
    const incoming = body.position;
    const state = await withLock(() => {
      const s = read();
      const existing = s.positions.find((p) => p.id === incoming.id);
      if (existing?.status === 'CLOSED' && incoming.status === 'OPEN') return s;
      const next: TsState = {
        positions: existing ? s.positions.map((p) => (p.id === incoming.id ? incoming : p)) : [...s.positions, incoming],
      };
      write(next);
      return next;
    });
    return NextResponse.json({ success: true, data: state });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
