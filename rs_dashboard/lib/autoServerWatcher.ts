import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { withFileLock, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { applyAutoLedgerOp, readAutoLedger } from '@/lib/pnfAutoServer';
import { askBridge, ensureBridge, readBridgeBook } from '@/lib/pnfLiveBridge';
import { brokerLegs, resolvePnfLegs } from '@/lib/pnfOrderServer';
import { send, describe } from '@/lib/pnfOrderExec';
import { sendOutcome, planOwnExit, type LegResult, type PnfBroker } from '@/lib/pnfOrderLogic';
import { brokerPositionRows, brokerSessionOk } from '@/lib/priceLadderServer';
import { CloseGuard } from '@/lib/priceLadderClose';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { targetKey } from '@/lib/pnfTarget';
import { chartPrice, guards, runtimeKey, stepRow, type RowRuntime, type ServerGuardCfg } from '@/lib/autoServerGuard';
import { autoWindow, rowMarket } from '@/lib/pnfAuto';
import { istMinuteOfDay } from '@/lib/straddlePnfLive';
import { istDateIso } from '@/lib/nseHolidays';
import type { AutoOp } from '@/lib/pnfAutoLedger';
import type { AutoRow } from '@/lib/pnfAutoLedger';
import type { PnfScope } from '@/lib/pnfScope';
import type { WantedPair } from '@/lib/pnfWanted';

// The server-side exit watcher for REAL AUTO positions of the P&F / Renko pages. The browser tab runs AUTO; if it closes, sleeps or
// loses its network, nothing exits. This watcher enforces the page's MTM guard levels (which include the stop-loss) on every open
// REAL AUTO row from the dashboard SERVER, so the position is protected with the tab closed. It places no entries and runs no strategy
// rules (the opposite-brick exit stays in the tab): exits and the guard only.
//
// The page syncs its guard levels per chart (POST /api/straddle-pnf/server-guard -> debug/auto_server_guards.json). A row is measured
// from its own entry price. A trip goes through the ledger exactly like a page exit (beginExit under the ledger lock -> exitOwn order ->
// close / markUnknown / abortExit), so a page and the server racing on one row cannot both exit it: whoever takes beginExit first owns
// it. An unknown outcome is never resent. Prices come from the same bridge as the page (lib/pnfLiveBridge.ts).

const STATE_FILE = path.join(PROJECT_ROOT, 'debug', 'auto_server_guards.json');
const LOCK_FILE = `${STATE_FILE}.lock`;
const TICK_MS = 2500;
const WARN_REPEAT_MS = 120_000;
const SCOPES: PnfScope[] = ['pnf', 'renko'];

export interface ServerGuardsFile { v: 1; cfg: Record<string, ServerGuardCfg>; runtime: Record<string, RowRuntime> }
const EMPTY: ServerGuardsFile = { v: 1, cfg: {}, runtime: {} };
const keyOf = (scope: PnfScope, chart: number) => `${scope}:${chart}`;

export function readServerGuards(): ServerGuardsFile {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<ServerGuardsFile>;
    return { v: 1, cfg: j.cfg && typeof j.cfg === 'object' ? j.cfg : {}, runtime: j.runtime && typeof j.runtime === 'object' ? j.runtime : {} };
  } catch { return { ...EMPTY, cfg: {}, runtime: {} }; }
}

async function update(mutate: (f: ServerGuardsFile) => ServerGuardsFile): Promise<ServerGuardsFile> {
  return withFileLock(LOCK_FILE, 8_000, 'AUTO server guards', () => {
    const next = mutate(readServerGuards());
    writeJsonAtomic(STATE_FILE, next);
    return next;
  });
}

/** Sets (or, with null, removes) one chart's synced guard. Called by the sync route. */
export async function setServerGuard(scope: PnfScope, chart: 1 | 2, cfg: ServerGuardCfg | null): Promise<void> {
  await update(f => {
    const cfgs = { ...f.cfg };
    let runtime = f.runtime;
    if (cfg) cfgs[keyOf(scope, chart)] = cfg;
    else {
      delete cfgs[keyOf(scope, chart)];
      // switched off: its rows' peak / locked floor / baseline go with it, so switching it on again starts fresh (as the page's does)
      runtime = Object.fromEntries(Object.entries(f.runtime).filter(([k]) => !k.startsWith(`${scope}:${chart}:`)));
    }
    return { ...f, cfg: cfgs, runtime };
  });
}

// ── exit ──────────────────────────────────────────────────────────────

type G = { __pnfOrderGuard?: CloseGuard; __pnfOrderBusy?: Set<string> };
const g = globalThis as G;

/** A rejected / unsendable exit is not tried again for this long, and after MAX_ATTEMPTS in a row the watcher stands down for a minute and says so. */
const EXIT_RETRY_MS = 10_000;
const MAX_ATTEMPTS = 5;
const STAND_DOWN_MS = 60_000;
const attempts = new Map<string, { n: number; nextAt: number }>();

/** A ledger write that failed after an order was sent (a lock timeout): kept and retried every tick, never dropped. */
const pendingOps = new Map<string, { scope: PnfScope; op: AutoOp; tries: number }>();
async function flushPending(): Promise<void> {
  for (const [id, p] of [...pendingOps]) {
    const r = await applyAutoLedgerOp(p.scope, p.op);
    if (r.ok || ++p.tries >= 20) { pendingOps.delete(id); if (!r.ok) console.error(`[auto-server-guard] gave up recording ${p.op.op} for ${id}: ${r.error}`); }
  }
}
/** Applies an op that MUST land (the order is already out); on failure it is queued and retried. */
async function mustApply(scope: PnfScope, rowId: string, op: AutoOp): Promise<void> {
  const r = await applyAutoLedgerOp(scope, op);
  if (!r.ok) { pendingOps.set(rowId, { scope, op, tries: 0 }); console.error(`[auto-server-guard] could not record ${op.op} for ${rowId} (${r.error}); it is retried`); }
}

/** Exits the row's own units, like the order route's `exitOwn`. Never resends an unknown outcome. */
async function exitRow(scope: PnfScope, row: AutoRow, reason: string, price: number): Promise<void> {
  const t = () => Date.now() / 1000;
  const log = (text: string) => applyAutoLedgerOp(scope, { op: 'log', chart: row.chart, t: t(), text });
  const att = attempts.get(row.id) ?? { n: 0, nextAt: 0 };
  if (Date.now() < att.nextAt) return;
  // Whoever takes beginExit first owns this exit: a page that got there first (or a refusal) means the server stands down.
  const began = await applyAutoLedgerOp(scope, { op: 'beginExit', id: row.id, t: t() });
  if (!began.ok) return;
  const abort = async (why: string) => {
    await applyAutoLedgerOp(scope, { op: 'abortExit', id: row.id, note: why });
    const n = att.n + 1;
    attempts.set(row.id, { n: n >= MAX_ATTEMPTS ? 0 : n, nextAt: Date.now() + (n >= MAX_ATTEMPTS ? STAND_DOWN_MS : EXIT_RETRY_MS) });
    await warn(scope, row, n >= MAX_ATTEMPTS
      ? `exit failed ${n} times (${why}) - standing down for a minute; close the position by hand if it matters`
      : `exit not sent (${why}); retrying in ${EXIT_RETRY_MS / 1000} s`);
  };
  const broker = row.broker as PnfBroker;
  const busy = (g.__pnfOrderBusy ??= new Set());
  const closeGuard = (g.__pnfOrderGuard ??= new CloseGuard());
  const gkey = `${broker}|${targetKey(row.target)}`;
  if (busy.has(gkey)) return void await abort('an order for this chart is already being sent');
  if (!closeGuard.tryStart(gkey, Date.now())) return void await abort('a close for this chart was just sent');
  busy.add(gkey);
  let sent = false;
  try {
    if (!brokerSessionOk(broker)) return void await abort(`${broker} session is not logged in`);
    const legs = resolvePnfLegs(row.target);
    if (typeof legs === 'string') return void await abort(legs);
    const onBroker = await brokerLegs(broker, row.target, legs).catch((e: Error) => `Contract lookup failed: ${e.message}`);
    if (typeof onBroker === 'string') return void await abort(onBroker);
    if (onBroker.length !== row.legs.length) return void await abort('the contract no longer matches the row');
    const rows = await brokerPositionRows(broker);
    if (!rows) return void await abort(`could not read the ${broker} positions`);
    const side = row.side === 'BUY' ? 'SELL' : 'BUY';
    const plans = onBroker.map((l, i) => ({ leg: l, ...planOwnExit(l.key, rows, side, row.legs[i].units, broker) }));
    const results: LegResult[] = [];
    sent = plans.some(p => p.qty > 0);
    for (const p of plans) {
      results.push(p.qty > 0 ? await send(broker, p.leg, side, p.qty, p.product, false, 'pnfa') : { label: p.leg.label, side, qty: 0, product: p.product, status: 'flat' });
    }
    invalidateBrokerCache(broker);
    const outcome = sendOutcome(results);
    if (outcome === 'placed' || outcome === 'flat') {
      attempts.delete(row.id);
      await mustApply(scope, row.id, { op: 'close', id: row.id, exitT: t(), exitPrice: price, reason: `server guard: ${reason}`, note: outcome === 'flat' ? 'already flat at the broker' : undefined });
      await log(`server guard exited chart ${row.chart}: ${reason} @ ~${price.toFixed(2)}`);
    } else if (outcome === 'unknown' || outcome === 'partial') {
      await mustApply(scope, row.id, { op: 'markUnknown', id: row.id, note: `server guard exit: ${describe(outcome, results)}` });
      await log('server guard exit outcome unknown - check Orders/Positions, then resolve it');
    } else {
      await abort(describe(outcome, results));
    }
  } catch (err) {
    // After a send began, a throw is an unknown outcome (the order may be live); before it, nothing was sent.
    if (sent) { await mustApply(scope, row.id, { op: 'markUnknown', id: row.id, note: `server guard exit: ${(err as Error).message}` }); await log('server guard exit outcome unknown - check Orders/Positions'); }
    else await abort((err as Error).message);
  } finally {
    busy.delete(gkey);
    closeGuard.finish(gkey, Date.now(), sent);
  }
}

// ── loop ──────────────────────────────────────────────────────────────

const L = globalThis as unknown as Record<string, { timer: ReturnType<typeof setInterval>; busy: boolean } | undefined>;
const LOOP_KEY = '__autoServerWatcherLoop';
const lastWarned = new Map<string, number>();

async function warn(scope: PnfScope, row: AutoRow, text: string): Promise<void> {
  const k = `${scope}:${row.chart}:${text}`;
  if (Date.now() - (lastWarned.get(k) ?? 0) < WARN_REPEAT_MS) return;
  lastWarned.set(k, Date.now());
  await applyAutoLedgerOp(scope, { op: 'log', chart: row.chart, t: Date.now() / 1000, text: `server guard: ${text}` });
}

async function tick(): Promise<void> {
  const loop = L[LOOP_KEY];
  if (!loop || loop.busy) return;
  if (pendingOps.size) await flushPending();
  const file = readServerGuards();
  if (!Object.values(file.cfg).some(c => c.on)) return;
  loop.busy = true;
  try {
    const now = Date.now();
    const today = istDateIso(now);
    const todo: { scope: PnfScope; row: AutoRow; cfg: ServerGuardCfg }[] = [];
    const liveRuntimeKeys = new Set<string>();
    for (const scope of SCOPES) {
      for (const row of readAutoLedger(scope).rows) {
        if (row.mode === 'REAL' && row.state !== 'closed') liveRuntimeKeys.add(runtimeKey(scope, row.chart, row.id));
        const cfg = file.cfg[keyOf(scope, row.chart)];
        if (!guards(cfg, row)) continue;
        // A row from an earlier day is not priced against today's market: it is reported, never exited on a stale entry price.
        if (row.day !== today) { await warn(scope, row, `chart ${row.chart}'s open row is from ${row.day}, not today - not guarded; check the broker and resolve it`); continue; }
        todo.push({ scope, row, cfg });
      }
    }
    // Runtime of rows that are over is dropped (the file would otherwise grow for ever).
    const stale = Object.keys(file.runtime).filter(k => !liveRuntimeKeys.has(k));
    if (stale.length) await update(f => ({ ...f, runtime: Object.fromEntries(Object.entries(f.runtime).filter(([k]) => liveRuntimeKeys.has(k))) }));
    if (todo.length === 0) return;
    // Ask the bridge for every guarded row's contract (the page's own asks keep it running; with no page open this is what does).
    const pairs: { item: (typeof todo)[number]; ids: [string, string][] }[] = [];
    for (const item of todo) {
      const legs = resolvePnfLegs(item.row.target);
      if (typeof legs === 'string') { await warn(item.scope, item.row, `cannot resolve the contract (${legs}) - not watching`); continue; }
      const ids = legs.map(l => [l.segment, l.securityId] as [string, string]);
      pairs.push({ item, ids });
      askBridge(`autoserver:${item.scope}:${item.row.chart}`, ids as WantedPair[], now);
    }
    ensureBridge(now);
    const { book } = readBridgeBook(now);
    for (const { item, ids } of pairs) {
      const { scope, row, cfg } = item;
      const win = autoWindow(rowMarket(row), now / 1000);
      const minute = istMinuteOfDay(now / 1000);
      // Outside the session there is no price worth acting on; at the end-of-day time the position is squared off like the tab would.
      if (!win || minute < win.open) continue;
      const price = chartPrice(ids, book, now);
      if (minute >= win.eodExit) {
        if (price !== null) await exitRow(scope, row, 'end of day', price);
        else await warn(scope, row, `end of day but no live price for chart ${row.chart} - the position is NOT squared off; close it by hand`);
        continue;
      }
      if (price === null) { await warn(scope, row, `no live price for chart ${row.chart} - not watching until the bridge has one`); continue; }
      const cur = readServerGuards();
      const rtKey = runtimeKey(scope, row.chart, row.id);
      const step = stepRow(row, cfg, price, cur.runtime[rtKey] ?? {});
      if (step.boxesUnreadable) await warn(scope, row, `chart ${row.chart}'s box levels cannot be read (no box size synced) - only its rupee levels are enforced`);
      const rt = cur.runtime[rtKey];
      if (!rt || rt.peak !== step.runtime.peak || rt.floor !== step.runtime.floor || rt.base !== step.runtime.base) {
        await update(f => ({ ...f, runtime: { ...f.runtime, [rtKey]: step.runtime } }));
      }
      if (!step.reason) continue;
      // The guard may have been switched off while this tick was working: act on the config as it is NOW.
      if (!guards(readServerGuards().cfg[keyOf(scope, row.chart)], row)) continue;
      await exitRow(scope, row, step.reason, price);
    }
  } catch (err) {
    console.error('[auto-server-guard] tick failed:', err);
  } finally {
    loop.busy = false;
  }
}

/** Starts the watcher once per server process. Idempotent (instrumentation and the sync route both call it). */
export function startAutoServerLoop(): void {
  if (L[LOOP_KEY]) return;
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref();
  L[LOOP_KEY] = { timer, busy: false };
  console.log('[auto-server-guard] watcher started');
}
