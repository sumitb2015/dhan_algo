import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { HD_KINDS } from '@/lib/harvestDeskControls';
import { HD_MAX_LOTS, HD_UNDERLYINGS, pruneAlgos, type HdAlgo } from '@/lib/harvestDesk';

// Harvest Desk's own ledger (paper algos: controls, leg rows, cycle state, event log). Deliberately its
// own file: nothing else reads it, and no broker reconcile may treat a paper leg as a missing position.
const FILE = path.join(PROJECT_ROOT, 'debug', 'harvest_desk_state.json');
const MAX_ALGOS = 40;
const MAX_LEGS = 24;

// In-process promise chain: a read-modify-write of one JSON file must never interleave.
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => T): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/** The stored list exactly as written. Writes start from this, so an entry the reader does not
 *  recognise is carried through untouched instead of being dropped by the next save. */
function read(): HdAlgo[] {
  try {
    if (!fs.existsSync(FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf-8')) as { algos?: HdAlgo[] };
    return Array.isArray(raw.algos) ? raw.algos : [];
  } catch (err) {
    // An unreadable ledger must not be silently replaced by an empty one.
    throw new Error(`harvest_desk_state.json unreadable: ${String(err)}`);
  }
}

function write(algos: HdAlgo[]): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ algos, updatedAt: Date.now() }, null, 2), 'utf-8');
  fs.renameSync(tmp, FILE);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
/** True for an entry the desk wrote itself; anything else in the file is carried through, never touched. */
const isKnown = (a: unknown): a is HdAlgo => isObj(a) && typeof a.id === 'string' && Array.isArray(a.legs);

function validAlgo(a: unknown): a is HdAlgo {
  const x = a as HdAlgo;
  if (!x || x.v !== 1 || typeof x.id !== 'string' || !x.id || typeof x.name !== 'string') return false;
  if (!Number.isFinite(x.updatedAt) || x.updatedAt <= 0 || !Number.isFinite(x.cycle) || !Number.isFinite(x.cumRealized)) return false;
  if (!(HD_KINDS as readonly string[]).includes(x.kind) || !(HD_UNDERLYINGS as readonly string[]).includes(x.underlying)) return false;
  if (!x.controls || typeof x.controls !== 'object' || !Array.isArray(x.legs) || x.legs.length > MAX_LEGS) return false;
  // The engine clamps every leg to HD_MAX_LOTS (lots on entry, maxLots, short sizing), so the same bound holds here.
  return x.legs.every((l) => l && typeof l.id === 'string' && (l.option === 'CE' || l.option === 'PE')
    && (l.side === 'S' || l.side === 'B') && Number.isFinite(l.lots) && l.lots >= 0 && l.lots <= HD_MAX_LOTS
    && Number.isFinite(l.openLots) && l.openLots >= 0 && l.openLots <= HD_MAX_LOTS);
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ success: true, data: { algos: pruneAlgos(await withLock(read)) } });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

/** Upsert one algo (`algo`) or several (`algos`, used by the page-close save) by id. A write older than the
 *  stored copy is ignored (out-of-order saves) and reported as `stale`. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json() as { algo?: unknown; algos?: unknown };
    const list = Array.isArray(body.algos) ? body.algos : [body.algo];
    if (!list.length || list.length > MAX_ALGOS || !list.every(validAlgo)) {
      return NextResponse.json({ success: false, error: 'invalid algo' }, { status: 400 });
    }
    const out = await withLock(() => {
      let all = read();
      let stale = false;
      let dirty = false;
      for (const incoming of list as HdAlgo[]) {
        const existing = all.find((a) => isKnown(a) && a.id === incoming.id);
        if (!existing && all.filter(isKnown).length >= MAX_ALGOS) return { error: `at most ${MAX_ALGOS} algos` as const };
        if (existing && existing.updatedAt > incoming.updatedAt) { stale = true; continue; }
        all = existing ? all.map((a) => (isKnown(a) && a.id === incoming.id ? incoming : a)) : [...all, incoming];
        dirty = true;
      }
      if (dirty) write(all);
      return { algos: all, stale };
    });
    if ('error' in out) return NextResponse.json({ success: false, error: out.error }, { status: 400 });
    return NextResponse.json({ success: true, data: { algos: pruneAlgos(out.algos) }, stale: out.stale });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

/** Remove an algo. Refused while it still holds an open paper leg: close it first. */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json() as { id?: string };
    if (typeof body.id !== 'string' || !body.id) return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });
    const out = await withLock(() => {
      const all = read();
      const target = all.find((a) => isKnown(a) && a.id === body.id);
      if (target?.legs.some((l) => l && l.openLots > 0)) return { error: 'algo has open legs' as const };
      const next = all.filter((a) => !(isKnown(a) && a.id === body.id));
      if (next.length !== all.length) write(next);
      return { algos: pruneAlgos(next) };
    });
    if ('error' in out) return NextResponse.json({ success: false, error: out.error }, { status: 409 });
    return NextResponse.json({ success: true, data: { algos: out.algos } });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
