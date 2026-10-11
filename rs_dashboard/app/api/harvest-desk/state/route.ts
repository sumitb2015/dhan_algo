import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { HD_KINDS } from '@/lib/harvestDeskControls';
import { HD_ALGO_KEYS, HD_EVENT_CAP, HD_MAX_LOTS, HD_UNDERLYINGS, isHdAlgoShape, pruneAlgos, type HdAlgo } from '@/lib/harvestDesk';

// Harvest Desk's own ledger (paper algos: controls, leg rows, cycle state, event log). Deliberately its
// own file: nothing else reads it, and no broker reconcile may treat a paper leg as a missing position.
const FILE = path.join(PROJECT_ROOT, 'debug', 'harvest_desk_state.json');
const MAX_ALGOS = 40;
const MAX_LEGS = 24;
const MAX_TOMBSTONES = 1000;
const KEEP_KEYS: ReadonlySet<string> = new Set(HD_ALGO_KEYS);

interface Ledger {
  /** Entries exactly as stored: ones this code does not recognise are carried through, never rewritten. */
  algos: unknown[];
  /** Ids deleted from the ledger. A save that was already on its way when the delete happened is refused. */
  deleted: Record<string, number>;
}

// In-process promise chain: a read-modify-write of one JSON file must never interleave.
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => T): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

function read(): Ledger {
  try {
    if (!fs.existsSync(FILE)) return { algos: [], deleted: {} };
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf-8')) as { algos?: unknown[]; deleted?: Record<string, number> };
    return { algos: Array.isArray(raw.algos) ? raw.algos : [], deleted: raw.deleted && typeof raw.deleted === 'object' ? raw.deleted : {} };
  } catch (err) {
    // An unreadable ledger must not be silently replaced by an empty one.
    throw new Error(`harvest_desk_state.json unreadable: ${String(err)}`);
  }
}

function write(l: Ledger): void {
  const ids = Object.entries(l.deleted).sort((a, b) => b[1] - a[1]).slice(0, MAX_TOMBSTONES);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ algos: l.algos, deleted: Object.fromEntries(ids), updatedAt: Date.now() }, null, 2), 'utf-8');
  fs.renameSync(tmp, FILE);
}

/** Why an incoming algo cannot be stored, or null. The message is shown to the user. */
function algoError(a: unknown): string | null {
  const x = a as HdAlgo;
  if (!isHdAlgoShape(x) || !x.id || typeof x.name !== 'string') return 'not an algo';
  if (!Number.isFinite(x.cycle) || !Number.isFinite(x.cumRealized)) return 'bad cycle / P&L numbers';
  if (!(HD_KINDS as readonly string[]).includes(x.kind) || !(HD_UNDERLYINGS as readonly string[]).includes(x.underlying)) return 'unknown strategy or underlying';
  if (!x.controls || typeof x.controls !== 'object' || Array.isArray(x.controls)) return 'missing controls';
  if (!Array.isArray(x.events) || x.events.length > 400 || !x.events.every((e) => e && Number.isFinite(e.t) && typeof e.k === 'string' && typeof e.msg === 'string')) return 'bad event log';
  if (!Array.isArray(x.windowsDone)) return 'bad windows list';
  if (x.legs.length > MAX_LEGS) return `${x.legs.length} legs (max ${MAX_LEGS})`;
  // The engine clamps every leg to HD_MAX_LOTS (lots on entry, maxLots, short sizing), so the same bound holds here.
  for (const [i, l] of x.legs.entries()) {
    if (!l || typeof l.id !== 'string' || (l.option !== 'CE' && l.option !== 'PE') || (l.side !== 'S' && l.side !== 'B')) return `leg ${i + 1} is malformed`;
    if (!Number.isFinite(l.lots) || l.lots < 0 || l.lots > HD_MAX_LOTS) return `leg ${i + 1} has ${l.lots} lots (max ${HD_MAX_LOTS})`;
    if (!Number.isFinite(l.openLots) || l.openLots < 0 || l.openLots > HD_MAX_LOTS) return `leg ${i + 1} holds ${l.openLots} lots (max ${HD_MAX_LOTS})`;
  }
  return null;
}

export async function GET(): Promise<NextResponse> {
  try {
    const l = await withLock(read);
    return NextResponse.json({ success: true, data: { algos: pruneAlgos(l.algos) } });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

type Result = { id: string; status: 'saved' | 'stale' | 'rejected'; rev?: number; error?: string };

/** Upsert one algo (`algo`) or several (`algos`, the page-close save). Each is judged on its own: one that
 *  cannot be stored never blocks the others. Conflicts use a server-owned revision, not the client clock:
 *  a save made from an older revision than the stored one is `stale`. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json() as { algo?: unknown; algos?: unknown };
    const list = (Array.isArray(body.algos) ? body.algos : [body.algo]) as (HdAlgo & { trimmedEvents?: boolean })[];
    if (!list.length || list.length > MAX_ALGOS || !list.every((x) => x && typeof x === 'object')) {
      return NextResponse.json({ success: false, error: 'malformed request' }, { status: 400 });
    }
    const out = await withLock(() => {
      const ledger = read();
      const results: Result[] = [];
      let dirty = false;
      for (const incoming of list) {
        const err = algoError(incoming);
        if (err) { results.push({ id: String(incoming.id), status: 'rejected', error: err }); continue; }
        if (ledger.deleted[incoming.id]) { results.push({ id: incoming.id, status: 'rejected', error: 'deleted' }); continue; }
        const idx = ledger.algos.findIndex((a) => isHdAlgoShape(a) && a.id === incoming.id);
        const existing = idx >= 0 ? (ledger.algos[idx] as HdAlgo) : undefined;
        if (!existing && ledger.algos.filter(isHdAlgoShape).length >= MAX_ALGOS) {
          results.push({ id: incoming.id, status: 'rejected', error: `at most ${MAX_ALGOS} algos` });
          continue;
        }
        // Stale = made from an older revision than the stored one, by a DIFFERENT page session. The same session
        // is only ever behind because the reply to its own earlier save was lost, so that save is accepted.
        if (existing && (incoming.rev ?? 0) < (existing.rev ?? 0) && !(incoming.writer && incoming.writer === existing.writer)) {
          results.push({ id: incoming.id, status: 'stale', rev: existing.rev });
          continue;
        }
        // Only the fields the desk stores are kept; anything else a client sends is dropped.
        const next = Object.fromEntries(Object.entries(incoming).filter(([k]) => KEEP_KEYS.has(k))) as unknown as HdAlgo;
        next.rev = (existing?.rev ?? 0) + 1;
        // A page-close save carries only the events newer than its last save: keep the stored older ones in front.
        if (incoming.trimmedEvents && existing) {
          const first = incoming.events[0]?.t ?? Infinity;
          const stored = Array.isArray(existing.events) ? existing.events : [];
          next.events = [...stored.filter((e) => e.t < first), ...incoming.events].slice(-HD_EVENT_CAP);
        }
        if (idx >= 0) ledger.algos[idx] = next; else ledger.algos.push(next);
        results.push({ id: incoming.id, status: 'saved', rev: next.rev });
        dirty = true;
      }
      if (dirty) write(ledger);
      return { results, algos: pruneAlgos(ledger.algos) };
    });
    return NextResponse.json({ success: true, results: out.results, data: { algos: out.algos } });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

/** Remove an algo and remember the id, so a save already on its way cannot bring it back.
 *  Refused while it still holds an open paper leg: close it first. */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json() as { id?: string };
    if (typeof body.id !== 'string' || !body.id) return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });
    const out = await withLock(() => {
      const ledger = read();
      const target = ledger.algos.find((a) => isHdAlgoShape(a) && a.id === body.id) as HdAlgo | undefined;
      if (target?.legs.some((l) => l && l.openLots > 0)) return { error: 'algo has open legs' as const };
      // Only an id that was actually stored gets a delete record, so arbitrary ids cannot crowd real ones out.
      if (!target) return { algos: pruneAlgos(ledger.algos) };
      ledger.algos = ledger.algos.filter((a) => !(isHdAlgoShape(a) && a.id === body.id));
      ledger.deleted[body.id as string] = Date.now();
      write(ledger);
      return { algos: pruneAlgos(ledger.algos) };
    });
    if ('error' in out) return NextResponse.json({ success: false, error: out.error }, { status: 409 });
    return NextResponse.json({ success: true, data: { algos: out.algos } });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
