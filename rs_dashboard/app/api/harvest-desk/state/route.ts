import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { HD_KINDS, defaultControls, type HdControlValue } from '@/lib/harvestDeskControls';
import { HD_ALGO_KEYS, HD_EVENT_CAP, HD_LEG_KEYS, HD_MAX_LOTS, HD_UNDERLYINGS, isHdAlgoShape, pruneAlgos, type HdAlgo } from '@/lib/harvestDesk';

// Harvest Desk's own ledger (paper algos: controls, leg rows, cycle state, event log). Deliberately its
// own file: nothing else reads it, and no broker reconcile may treat a paper leg as a missing position.
const FILE = path.join(PROJECT_ROOT, 'debug', 'harvest_desk_state.json');
const MAX_ALGOS = 40;
const MAX_LEGS = 24;
const MAX_TOMBSTONES = 1000;
const KEEP_KEYS: ReadonlySet<string> = new Set(HD_ALGO_KEYS);
const KEEP_LEG_KEYS: ReadonlySet<string> = new Set(HD_LEG_KEYS);
const LEG_NUMBERS = ['strikeValue', 'lots', 'slPct', 'tgtPct', 'strike', 'openLots', 'avgEntry', 'firstEntry', 'entryDelta', 'realized', 'lastPx', 'lastPxAt', 'reentryPx', 'reentries', 'openedAt'] as const;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

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
  if (!isHdAlgoShape(x) || !x.id || !ID_RE.test(x.id) || typeof x.name !== 'string' || x.name.length > 200) return 'not an algo';
  if (!['ACTIVE', 'PAUSED', 'DONE'].includes(x.phase) || !['INTRADAY', 'MARGIN'].includes(x.product) || typeof x.armed !== 'boolean') return 'bad phase / product / armed flag';
  // Accounting totals are never defaulted: an unreadable one is refused with its name, not silently zeroed.
  if (!Number.isFinite(x.cycle)) return 'cycle is not a number';
  if (!Number.isFinite(x.cumRealized)) return 'cumRealized is not a number';
  const whole = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 2 ** 31);
  if (!whole(x.rev) || !whole(x.wseq)) return 'bad revision / save sequence';
  if (x.writer !== undefined && (typeof x.writer !== 'string' || x.writer.length > 80)) return 'bad writer id';
  if (!(HD_KINDS as readonly string[]).includes(x.kind) || !(HD_UNDERLYINGS as readonly string[]).includes(x.underlying)) return 'unknown strategy or underlying';
  if (!x.controls || typeof x.controls !== 'object' || Array.isArray(x.controls)) return 'missing controls';
  if (!Array.isArray(x.events) || x.events.length > 400 || !x.events.every((e) => e && Number.isFinite(e.t) && typeof e.k === 'string' && typeof e.msg === 'string')) return 'bad event log';
  if (!Array.isArray(x.windowsDone)) return 'bad windows list';
  if (x.legs.length > MAX_LEGS) return `${x.legs.length} legs (max ${MAX_LEGS})`;
  // The engine clamps every leg to HD_MAX_LOTS (lots on entry, maxLots, short sizing), so the same bound holds here.
  for (const [i, l] of x.legs.entries()) {
    if (!l || typeof l.id !== 'string' || (l.option !== 'CE' && l.option !== 'PE') || (l.side !== 'S' && l.side !== 'B')) return `leg ${i + 1} is malformed`;
    // `lots` is a setting (a cleared box can read as null) and is repaired below; the lots HELD are position state.
    if (isNum(l.lots) && (l.lots < 0 || l.lots > HD_MAX_LOTS)) return `leg ${i + 1} has ${l.lots} lots (max ${HD_MAX_LOTS})`;
    if (!isNum(l.openLots) || l.openLots < 0 || l.openLots > HD_MAX_LOTS) return `leg ${i + 1} holds an unreadable or out-of-range lot count (${String(l.openLots)}, max ${HD_MAX_LOTS})`;
  }
  return null;
}

/** The stored shape of an incoming algo: only known fields, with the nested values the engine reads made safe.
 *  A value that JSON turned into null (NaN / Infinity) or that an older copy simply lacks is not a reason to
 *  refuse the algo for ever: it is coerced to a default, or dropped where the engine rebuilds it. */
function cleanAlgo(raw: HdAlgo): { algo: HdAlgo } | { error: string } {
  const a = Object.fromEntries(Object.entries(raw).filter(([k]) => KEEP_KEYS.has(k))) as unknown as HdAlgo;
  const defaults = defaultControls(a.kind);
  // controls: flat name -> number | string | boolean. A broken value falls back to the strategy's documented default.
  const entries = Object.entries(a.controls);
  if (entries.length > 150) return { error: 'too many controls' };
  const controls: Record<string, HdControlValue> = {};
  for (const [k, v] of entries) {
    if (k.length > 60) continue;
    if (isNum(v) || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 200)) controls[k] = v;
    else if (defaults[k] !== undefined) controls[k] = defaults[k];
  }
  a.controls = controls;
  // legs: known fields only. Settings are repaired; numbers that describe a position are never invented.
  const hasOpen = a.legs.some((l) => l.openLots > 0);
  const legs: HdAlgo['legs'] = [];
  for (const [i, l] of a.legs.entries()) {
    const c = Object.fromEntries(Object.entries(l).filter(([k, v]) => KEEP_LEG_KEYS.has(k) && v !== null)) as Record<string, unknown>;
    const open = (c.openLots as number) > 0;
    for (const k of LEG_NUMBERS) if (c[k] !== undefined && !isNum(c[k])) delete c[k];
    if (!isNum(c.lots)) c.lots = c.role === 'short' ? 0 : 1;                 // setting
    for (const k of ['strikeValue', 'reentries'] as const) if (!isNum(c[k])) c[k] = 0;   // settings / counters
    if (!isNum(c.realized)) { if (l.realized === undefined) c.realized = 0; else return { error: `leg ${i + 1}: realized P&L is not a number` }; }
    if (open) {
      if (!isNum(c.avgEntry)) return { error: `leg ${i + 1} is open but its entry price is unreadable` };
      if (!isNum(c.strike)) return { error: `leg ${i + 1} is open but its strike is unreadable` };
    } else if (!isNum(c.avgEntry)) c.avgEntry = 0;
    for (const k of ['role', 'strikeBy', 'expiry', 'status'] as const) if (typeof c[k] !== 'string') c[k] = k === 'expiry' ? '' : k === 'status' ? 'IDLE' : k === 'role' ? 'main' : 'ATM';
    legs.push(c as unknown as HdAlgo['legs'][number]);
  }
  a.legs = legs;
  // events: newest HD_EVENT_CAP, trimmed
  a.events = a.events.slice(-HD_EVENT_CAP).map((e) => ({ t: e.t, k: e.k.slice(0, 20), msg: e.msg.slice(0, 600) }));
  a.windowsDone = a.windowsDone.filter((w) => typeof w === 'string').slice(0, 20);
  // state the engine rebuilds when it is missing
  if (a.vwap) {
    const v = a.vwap;
    const ok = isNum(v.strike) && typeof v.expiry === 'string' && Array.isArray(v.bars) && Array.isArray(v.ticks) && v.bars.length <= 1000 && v.ticks.length <= 400
      && [...v.bars, ...v.ticks, v.cur, v.curMin].every(isNum);
    if (!ok) a.vwap = undefined;
  }
  const entryOk = !a.entry || ['imbalance', 'atm', 'premiumUnits', 'premiumRs', 'at'].every((k) => isNum((a.entry as unknown as Record<string, unknown>)[k]));
  if (!entryOk) { if (hasOpen) return { error: 'the entry baseline of a running algo is unreadable' }; a.entry = undefined; }
  a.trail = { armed: !!a.trail?.armed, ...(isNum(a.trail?.best) ? { best: a.trail.best } : {}) };
  // Plain numbers: absent in an older copy = 0. Present but unreadable is only zeroed while nothing is open: on a
  // running algo a zero would silently disable a percent stop or reset the trail peak.
  const n = a as unknown as Record<string, unknown>;
  for (const k of ['refPremiumRs', 'dayStartPnl', 'peakMtm', 'tradesToday', 'peakEquity', 'longDebit', 'shortCredit']) {
    if (n[k] === undefined) n[k] = 0;
    else if (!isNum(n[k])) { if (hasOpen) return { error: `${k} is unreadable on a running algo` }; n[k] = 0; }
  }
  if (typeof a.halved !== 'boolean') a.halved = false;
  a.staleCloses = (Array.isArray(a.staleCloses) ? a.staleCloses : []).filter((x) => typeof x === 'string').slice(-20).map((x) => x.slice(0, 200));
  if (!a.staleCloses.length) a.staleCloses = undefined;
  return { algo: a };
}

export async function GET(): Promise<NextResponse> {
  try {
    const l = await withLock(read);
    return NextResponse.json({ success: true, data: { algos: pruneAlgos(l.algos) } });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

type Result = { id: string; status: 'saved' | 'stale' | 'rejected'; rev?: number; wseq?: number; error?: string; own?: boolean };

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
        if (Object.hasOwn(ledger.deleted, incoming.id)) { results.push({ id: incoming.id, status: 'rejected', error: 'deleted' }); continue; }
        const idx = ledger.algos.findIndex((a) => isHdAlgoShape(a) && a.id === incoming.id);
        const existing = idx >= 0 ? (ledger.algos[idx] as HdAlgo) : undefined;
        if (!existing && ledger.algos.filter(isHdAlgoShape).length >= MAX_ALGOS) {
          results.push({ id: incoming.id, status: 'rejected', error: `at most ${MAX_ALGOS} algos` });
          continue;
        }
        // Which save is current. Within one page session saves carry a counter, and only a newer one wins: a lost
        // reply is harmless, and a late older request can never overwrite a newer one. A DIFFERENT session must
        // have been made from the stored revision or later, or it is stale.
        if (existing) {
          const sameSession = !!incoming.writer && incoming.writer === existing.writer;
          const stale = sameSession ? (incoming.wseq ?? 0) <= (existing.wseq ?? 0) : (incoming.rev ?? 0) < (existing.rev ?? 0);
          if (stale) { results.push({ id: incoming.id, status: 'stale', rev: existing.rev, wseq: existing.wseq, own: sameSession }); continue; }
        }
        // Only the fields the desk stores are kept, and the nested values the engine reads are checked.
        const cleaned = cleanAlgo(incoming);
        if ('error' in cleaned) { results.push({ id: incoming.id, status: 'rejected', error: cleaned.error }); continue; }
        const next = cleaned.algo;
        next.rev = (existing?.rev ?? 0) + 1;
        // A page-close save carries only the events from its last save on: keep the stored older ones in front. Two
        // sessions writing one algo is already ruled out by the leader lock and the revision check above.
        if (incoming.trimmedEvents && existing) {
          const fresh = next.events;               // already trimmed and capped by cleanAlgo
          const first = fresh[0]?.t ?? Infinity;
          const stored = Array.isArray(existing.events) ? existing.events : [];
          next.events = [...stored.filter((e) => e.t < first), ...fresh].slice(-HD_EVENT_CAP);
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
    if (typeof body.id !== 'string' || !ID_RE.test(body.id)) return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });
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
