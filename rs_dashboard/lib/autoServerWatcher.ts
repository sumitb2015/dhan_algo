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
import { targetKey, parseOptionIds } from '@/lib/pnfTarget';
import { indexSpotId } from '@/lib/pnfContracts';
import { premiumOf } from '@/lib/pnfIndexTradeServer';
import { chartPrice, guards, ownHeldQty, runtimeKey, stepRow, stopHit, type RowRuntime, type ServerGuardCfg } from '@/lib/autoServerGuard';
import { autoProductOf, autoWindow, carriesOvernight, rowMarket } from '@/lib/pnfAuto';
import { istMinuteOfDay, sessionWindow } from '@/lib/straddlePnfLive';
import { istDateIso } from '@/lib/nseHolidays';
import { closingSide, pendingAddUnits, type AutoOp } from '@/lib/pnfAutoLedger';
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

/**
 * Exits the row's own units, like the order route's `exitOwn`. Never resends an unknown outcome. `withPendingAdd`: the row has a stuck
 * pyramid add (adding / unknownAdd, see tick): the exit covers the confirmed units plus the pending add's, capped by what the broker shows,
 * and the close records whether the added lot was there.
 */
async function exitRow(scope: PnfScope, snap: AutoRow, reason: string, price: number, withPendingAdd = false, eod = false, rowReason?: string, premium?: number | null): Promise<void> {
  let row = snap;
  const t = () => Date.now() / 1000;
  const log = (text: string) => applyAutoLedgerOp(scope, { op: 'log', chart: row.chart, t: t(), text });
  const att = attempts.get(row.id) ?? { n: 0, nextAt: 0 };
  if (Date.now() < att.nextAt) return;
  // Whoever takes beginExit first owns this exit: a page that got there first (or a refusal) means the server stands down.
  const began = await applyAutoLedgerOp(scope, { op: 'beginExit', id: row.id, t: t(), ...(withPendingAdd ? { withPendingAdd: true } : {}) });
  if (!began.ok) return;
  // Sized from the row AS RESERVED, never the tick's snapshot: a pyramid add confirmed by a tab since the tick read the ledger changed its units
  // (an exit sized off the snapshot would close the row and leave the added lot at the broker with no row).
  const fresh = readAutoLedger(scope).rows.find(r => r.id === snap.id && r.state === 'exiting');
  const abort = async (why: string) => {
    await applyAutoLedgerOp(scope, { op: 'abortExit', id: row.id, note: why });
    const n = att.n + 1;
    // The end-of-day exit never stands down: an NRML position has 5 minutes before the close and no broker square-off behind it.
    const standDown = n >= MAX_ATTEMPTS && !eod;
    attempts.set(row.id, { n: standDown ? 0 : n, nextAt: Date.now() + (standDown ? STAND_DOWN_MS : EXIT_RETRY_MS) });
    await warn(scope, row, standDown
      ? `exit failed ${n} times (${why}) - standing down for a minute; close the position by hand if it matters`
      : `exit not sent (${why}); retrying in ${EXIT_RETRY_MS / 1000} s`);
  };
  if (!fresh) return void await abort('could not re-read the reserved row');
  row = fresh;
  const pend = withPendingAdd ? pendingAddUnits(row) : row.legs.map(() => 0);
  const broker = row.broker as PnfBroker;
  const busy = (g.__pnfOrderBusy ??= new Set());
  const closeGuard = (g.__pnfOrderGuard ??= new CloseGuard());
  // An index chart's row exits its OPTION (the contract it holds), on the option's own closing side; `price` is the index's (its chart).
  const contract = row.traded ? row.traded.target : row.target;
  const gkey = `${broker}|${targetKey(contract)}`;
  if (busy.has(gkey)) return void await abort('an order for this chart is already being sent');
  if (!closeGuard.tryStart(gkey, Date.now())) return void await abort('a close for this chart was just sent');
  busy.add(gkey);
  let sent = false;
  try {
    if (!brokerSessionOk(broker)) return void await abort(`${broker} session is not logged in`);
    const legs = resolvePnfLegs(contract);
    if (typeof legs === 'string') return void await abort(legs);
    const onBroker = await brokerLegs(broker, contract, legs).catch((e: Error) => `Contract lookup failed: ${e.message}`);
    if (typeof onBroker === 'string') return void await abort(onBroker);
    if (onBroker.length !== row.legs.length) return void await abort('the contract no longer matches the row');
    const rows = await brokerPositionRows(broker);
    if (!rows) return void await abort(`could not read the ${broker} positions`);
    const side = closingSide(row);
    const plans = onBroker.map((l, i) => ({ leg: l, ...planOwnExit(l.key, rows, side, row.legs[i].units + (pend[i] ?? 0), broker, autoProductOf(row.product)) }));
    // the broker held more than the confirmed units: the stuck add's lot was there (planOwnExit caps by the broker's own quantity)
    const pendingAdded = withPendingAdd ? plans.some((p, i) => p.qty > row.legs[i].units) : undefined;
    const results: LegResult[] = [];
    sent = plans.some(p => p.qty > 0);
    for (const p of plans) {
      results.push(p.qty > 0 ? await send(broker, p.leg, side, p.qty, p.product, false, 'pnfa') : { label: p.leg.label, side, qty: 0, product: p.product, status: 'flat' });
    }
    invalidateBrokerCache(broker);
    const outcome = sendOutcome(results);
    if (outcome === 'placed' || outcome === 'flat') {
      attempts.delete(row.id);
      // No bridge tick for the option: ask for one Dhan quote now (as the engine's own exit does) so the row is not booked with an unknown P&L.
      if (row.traded && !(premium && premium > 0)) premium = await premiumOf(row.traded.ids, `autoserver:exit:${row.id}`).catch(() => null);
      // `rowReason`: an exit that is the row's own rule (its stop), recorded as the page records it so an open tab does not read it as a guard trip
      await mustApply(scope, row.id, { op: 'close', id: row.id, exitT: t(), exitPrice: price, reason: rowReason ?? `server guard: ${reason}`, note: outcome === 'flat' ? 'already flat at the broker' : rowReason ? 'sent by the server watcher' : undefined,
        orderIds: results.filter(r => r.status === 'placed' && r.orderId).map(r => String(r.orderId)), ...(pendingAdded !== undefined ? { pendingAdded } : {}),
        ...(row.traded && premium && premium > 0 ? { exitPremium: premium } : {}) });   // a tab replaces the decision price with the fill
      if (pendingAdded !== undefined) await log(`server: chart ${row.chart}'s unresolved added lot was ${pendingAdded ? 'found at the broker and exited with the position' : 'not at the broker (dropped)'}`);
      await log(`${rowReason ? 'server' : 'server guard'} exited chart ${row.chart}: ${reason} @ ~${price.toFixed(2)}`);
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

// ── reconcile ─────────────────────────────────────────────────────────

/**
 * An open REAL row whose position the BROKER no longer shows (closed by hand in the broker's app, by the trade bar's square-off, or by the
 * broker's own MIS square-off) stays `open` in the ledger: nothing in AUTO looks at the book until an exit is due. That stale row blocks
 * its chart, keeps a server guard "protecting" nothing, and could later close a position it does not own. This closes it as flat once the
 * broker book has read flat for two passes in a row. It places NO order and books no P&L (the broker's book has the truth).
 */
const RECONCILE_EVERY_MS = 30_000;
const MIN_ROW_AGE_S = 90;
let lastReconcile = 0;
const flatPasses = new Map<string, number>();

async function reconcileFlat(): Promise<void> {
  if (Date.now() - lastReconcile < RECONCILE_EVERY_MS) return;
  lastReconcile = Date.now();
  const nowS = Date.now() / 1000;
  const byBroker = new Map<string, { scope: PnfScope; row: AutoRow }[]>();
  for (const scope of SCOPES) {
    for (const row of readAutoLedger(scope).rows) {
      if (row.mode !== 'REAL' || row.state !== 'open' || nowS - row.entryT < MIN_ROW_AGE_S) continue;
      if (!byBroker.has(row.broker)) byBroker.set(row.broker, []);
      byBroker.get(row.broker)!.push({ scope, row });
    }
  }
  for (const [brokerName, items] of byBroker) {
    const broker = brokerName as PnfBroker;
    if (!brokerSessionOk(broker)) continue;
    const book = await brokerPositionRows(broker);
    if (!book) continue;                                           // an unreadable book is not a flat one
    for (const { scope, row } of items) {
      const held = ownHeldQty(row, book, broker);
      if (held !== 0) { flatPasses.delete(row.id); continue; }        // still held, or a leg's broker key is unknown: never reconciled
      const seen = (flatPasses.get(row.id) ?? 0) + 1;
      flatPasses.set(row.id, seen);
      if (seen < 2) continue;
      flatPasses.delete(row.id);
      const began = await applyAutoLedgerOp(scope, { op: 'beginExit', id: row.id, t: nowS });
      if (!began.ok) continue;                                     // a page or an exit got there first
      await mustApply(scope, row.id, { op: 'close', id: row.id, exitT: nowS, exitPrice: row.entryPrice, reason: 'flat at broker', note: 'the broker shows no position for this row: closed outside AUTO (by hand, a square-off or the broker). No order sent; P&L is in the broker book.' });
      await applyAutoLedgerOp(scope, { op: 'log', chart: row.chart, t: nowS, text: `server: chart ${row.chart}'s ${row.side} ${row.lots}L row is flat at the broker - ledger row closed (no order sent)` });
    }
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
  loop.busy = true;
  try {
    if (pendingOps.size) await flushPending();                    // inside busy: two ticks never replay the same queued op
    await reconcileFlat().catch(err => console.error('[auto-server-guard] reconcile failed:', err));
    const file = readServerGuards();
    const now = Date.now();
    const today = istDateIso(now);
    const nowS = now / 1000;
    const minute = istMinuteOfDay(nowS);
    /** `cfg` set: the page's guard is synced for this row (stop-loss, target, ... enforced). Unset: the row only gets the end-of-day exit. */
    const todo: { scope: PnfScope; row: AutoRow; cfg: ServerGuardCfg | undefined; win: { open: number; entryCutoff: number; eodExit: number }; stuckAdd: boolean }[] = [];
    const allLive = SCOPES.flatMap(sc => readAutoLedger(sc).rows.filter(r => r.mode === 'REAL' && r.state !== 'closed'));
    // Same contract, broker AND product: exits are capped by that product's broker row only, so an MIS row cannot take an NRML row's units.
    // compared on the contract each row actually holds (an index chart's row: its option)
    const held = (r: AutoRow) => r.traded?.targetKey ?? r.targetKey;
    const hasSibling = (row: AutoRow) => allLive.some(r => r.id !== row.id && r.broker === row.broker && held(r) === held(row) && autoProductOf(r.product) === autoProductOf(row.product));
    const liveRuntimeKeys = new Set<string>();
    for (const scope of SCOPES) {
      for (const row of readAutoLedger(scope).rows) {
        if (row.mode !== 'REAL' || row.state === 'closed') continue;
        liveRuntimeKeys.add(runtimeKey(scope, row.chart, row.id));
        // A pyramid add stuck on the wire for a minute (the tab died after reserving it, or its outcome is unknown). Its confirmed lots must
        // keep their guard and end-of-day exit: the server exits them with the pending lot, capped by what the broker shows. That cap can only
        // be trusted when no other live REAL AUTO row holds the same contract at that broker (it would take that row's units).
        const stuckAdd = (row.state === 'adding' || row.state === 'unknownAdd') && nowS - (row.pendingSince ?? row.entryT) > 60;
        if (stuckAdd && hasSibling(row)) {
          await warn(scope, row, `chart ${row.chart}'s added lot has an unclear outcome and another AUTO row holds the same contract - no guard or end-of-day exit until it is resolved on the page (check the broker)`);
          continue;
        }
        if (stuckAdd) await warn(scope, row, `chart ${row.chart}'s added lot has an unclear outcome - resolve it on the page; the guard and end-of-day exit still cover the position`);
        if (row.state !== 'open' && !stuckAdd) continue;
        // An index chart's option row is guarded on the OPTION's P&L (premium vs entry premium) by the chart's rupee levels; box levels are
        // never applied to it (a box of the chart is an index move - stepRow ignores them for such a row, and the page syncs none).
        const cfg = guards(file.cfg[keyOf(scope, row.chart)], row) ? file.cfg[keyOf(scope, row.chart)] : undefined;
        // A row from an earlier day is not priced against today's market: it is reported, never exited on a stale entry price.
        // An NRML row whose end-of-day exit was missed is carried overnight with no broker square-off behind it: always said, guard or not.
        // An NRML NIFTY option row is carried overnight on purpose (carriesOvernight, judged at its entry): its stop and guard keep running
        // on later days, and on its expiry day (`carry` false) it gets the NRML end-of-day exit like any other row.
        const carried = carriesOvernight(row, row.entryT);
        const carry = carriesOvernight(row, nowS);
        if (row.day !== today && !carried) {
          const text = `chart ${row.chart}'s ${autoProductOf(row.product) === 'MARGIN' ? 'NRML ' : ''}position from ${row.day} is STILL OPEN - AUTO does not exit an earlier day's row; close it at the broker and resolve it on the page`;
          if (Date.now() - (lastWarned.get(`${scope}:${row.chart}:${text}`) ?? 0) >= WARN_REPEAT_MS) console.error(`[auto-server-guard] ${scope}: ${text}`);
          await warn(scope, row, text);
          continue;
        }
        const win = autoWindow(rowMarket(row), nowS, autoProductOf(row.product));
        if (!win || minute < win.open) continue;                      // shut today / before the open: nothing to act on
        // After the close an exit cannot trade: say so (once in a while) instead of sending orders into a shut market every few seconds.
        if (minute >= sessionWindow(rowMarket(row), nowS)[1]) { if (carry) continue; await warn(scope, row, `chart ${row.chart}'s position is still open after the market closed - not exited; check the broker and resolve it`); continue; }
        // An unguarded row without a stop is only looked at once its end-of-day time is near (no price is asked for before that).
        if (!cfg && row.stop === undefined && (carry || minute < win.eodExit - 2)) continue;
        todo.push({ scope, row, cfg, win, stuckAdd });
      }
    }
    // Runtime of rows that are over is dropped (the file would otherwise grow for ever).
    const stale = Object.keys(file.runtime).filter(k => !liveRuntimeKeys.has(k));
    if (stale.length) await update(f => ({ ...f, runtime: Object.fromEntries(Object.entries(f.runtime).filter(([k]) => liveRuntimeKeys.has(k))) }));
    if (todo.length === 0) return;
    // Ask the bridge for every watched row's contract (the page's own asks keep it running; with no page open this is what does).
    // `ids`: what the row's stop and guard are measured on (the chart's contract; an index chart's row: the INDEX). `optIds`: an index chart's
    // row's option, for its exit premium.
    const pairs: { item: (typeof todo)[number]; ids: [string, string][]; optIds: [string, string][] | null }[] = [];
    for (const item of todo) {
      const tr = item.row.traded;
      let ids: [string, string][], optIds: [string, string][] | null = null;
      if (tr) {
        const spot = indexSpotId(item.row.target.symbol);
        const m = parseOptionIds(tr.ids);
        if (!spot || !m) { await warn(item.scope, item.row, `cannot price the index or its option (${tr.ids}) - not watching`); continue; }
        ids = [['IDX_I', spot]];
        optIds = [[m.segment, m.securityId]];
      } else {
        const legs = resolvePnfLegs(item.row.target);
        if (typeof legs === 'string') { await warn(item.scope, item.row, `cannot resolve the contract (${legs}) - not watching`); continue; }
        ids = legs.map(l => [l.segment, l.securityId] as [string, string]);
      }
      pairs.push({ item, ids, optIds });
      askBridge(`autoserver:${item.scope}:${item.row.chart}`, [...ids, ...(optIds ?? [])] as WantedPair[], now);
    }
    ensureBridge(now);
    const { book } = readBridgeBook(now);
    for (const { item, ids, optIds } of pairs) {
      const { scope, row, cfg, win, stuckAdd } = item;
      const price = chartPrice(ids, book, now);
      const premium = optIds ? chartPrice(optIds, book, now) : null;
      if (!carriesOvernight(row, nowS) && minute >= win.eodExit) {
        // The end of day comes first and needs no price: the position must be flat before the broker's own square-off. With no price the
        // exit is booked at the entry price (as the tab's own end-of-day exit does when it has none) and the ledger says so.
        await exitRow(scope, row, price === null ? 'end of day (no live price)' : 'end of day', price ?? row.entryPrice, stuckAdd, true, undefined, premium);
        continue;
      }
      if (price === null) {
        if (cfg || row.stop !== undefined) await warn(scope, row, `no live price for chart ${row.chart} - not watching until the bridge has one`);
        continue;
      }
      // The row's own stop (Two-back / One-back) holds with or without a guard: the tab may be closed. The first to take beginExit sends it.
      if (stopHit(row, price)) {
        await exitRow(scope, row, `stop ${row.stop!.toFixed(2)} hit`, price, stuckAdd, false, 'stop', premium);
        continue;
      }
      if (!cfg) continue;
      // the guard's mark: the chart's price, or an index chart's option premium (its P&L is the option's)
      const mark = row.traded ? premium : price;
      if (mark === null) { await warn(scope, row, `no live premium for chart ${row.chart}'s option ${row.traded!.target.strike} ${row.traded!.target.side} - its MTM guard waits for one (its stop and end-of-day exit still hold)`); continue; }
      const cur = readServerGuards();
      const rtKey = runtimeKey(scope, row.chart, row.id);
      const step = stepRow(row, cfg, mark, cur.runtime[rtKey] ?? {});
      if (step.boxesUnreadable) await warn(scope, row, row.traded
        ? `chart ${row.chart} is an index chart: its box levels are not applied to the option it trades - only its rupee levels are enforced`
        : `chart ${row.chart}'s box levels cannot be read (no box size synced) - only its rupee levels are enforced`);
      const rt = cur.runtime[rtKey];
      if (!rt || rt.peak !== step.runtime.peak || rt.floor !== step.runtime.floor || rt.base !== step.runtime.base) {
        await update(f => ({ ...f, runtime: { ...f.runtime, [rtKey]: step.runtime } }));
      }
      if (!step.reason) continue;
      // The guard may have been switched off while this tick was working: act on the config as it is NOW.
      if (!guards(readServerGuards().cfg[keyOf(scope, row.chart)], row)) continue;
      await exitRow(scope, row, step.reason, price, stuckAdd, false, undefined, premium);
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
