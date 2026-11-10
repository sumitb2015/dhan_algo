/**
 * Start / stop / status of the MCX OI collectors (scripts/tools/crudeoil_oi_collector.py --underlying CRUDEOIL|CRUDEOILM),
 * shared by /api/crudeoil-oi-collector (the pages' Start / Stop) and the server's auto-start scheduler, so the two can
 * never disagree about "is one running" or start a second one. Market data only, no orders.
 *
 * Files per underlying (u = crudeoil | crudeoilm): debug/<u>_oi_collector_status.json (written by the collector),
 * <u>_oi_stop.trigger (consumed by it), <u>_oi_collector_manual_stop.json ({date}: the user pressed Stop today, so the
 * scheduler leaves it off until tomorrow or the next Start), <u>_oi_collector_stdout.log (its console, so a start that
 * dies is diagnosable).
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { isPidRunning } from '@/lib/processCheck';
import { PROJECT_ROOT, PYTHON_EXE } from '@/lib/pyExec';
import { readJsonFile, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { istToday } from '@/lib/istTime';
import { mcxSession } from '@/lib/mcxSession';
import { shouldAutoStart } from '@/lib/crudeCollectorRules';

export const CRUDE_COLLECTOR_UNDERLYINGS = ['CRUDEOIL', 'CRUDEOILM'] as const;
export type CrudeUnderlying = (typeof CRUDE_COLLECTOR_UNDERLYINGS)[number];

const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'crudeoil_oi_collector.py');
const file = (u: CrudeUnderlying, suffix: string) => path.join(DEBUG_DIR, `${u.toLowerCase()}_${suffix}`);
const statusFile = (u: CrudeUnderlying) => file(u, 'oi_collector_status.json');
const stopTrigger = (u: CrudeUnderlying) => file(u, 'oi_stop.trigger');
const manualStopFile = (u: CrudeUnderlying) => file(u, 'oi_collector_manual_stop.json');

/** A started collector needs a few seconds to write its first status: no second start meanwhile. */
const START_GRACE_MS = 20_000;

interface Shared { recentStarts: Map<string, number>; autoAttempts: Map<string, number>; schedulerOn: boolean }
// On globalThis: the route and the scheduler can be separate module instances in one server.
const g = ((globalThis as { __crudeCollector?: Shared }).__crudeCollector ??= { recentStarts: new Map(), autoAttempts: new Map(), schedulerOn: false });

export function parseCrudeUnderlying(raw: unknown): CrudeUnderlying | null {
  const u = raw == null || raw === '' ? 'CRUDEOIL' : String(raw).toUpperCase();
  return (CRUDE_COLLECTOR_UNDERLYINGS as readonly string[]).includes(u) ? (u as CrudeUnderlying) : null;
}

export interface CollectorStatus { pid?: number | string; status?: string; reason?: string; [k: string]: unknown }

/** The collector's own status, with RUNNING / WAITING turned into STOPPED (crashed) when its pid is gone. */
export function collectorStatus(u: CrudeUnderlying): CollectorStatus {
  const st = readJsonFile<CollectorStatus>(statusFile(u));
  if (!st) return { status: 'STOPPED' };
  if (st.pid && (st.status === 'RUNNING' || st.status === 'WAITING') && !isPidRunning(Number(st.pid))) {
    return { ...st, status: 'STOPPED', reason: 'crashed' };
  }
  return st;
}

const alive = (st: CollectorStatus) => (st.status === 'RUNNING' || st.status === 'WAITING') && !!st.pid;

/** Start one unless it is already running or starting. `manual` (a Start press) also clears today's Stop. */
export function startCollector(u: CrudeUnderlying, manual: boolean): { started: boolean; message: string; pid?: number } {
  if (manual) fs.rmSync(manualStopFile(u), { force: true });
  const st = collectorStatus(u);
  if (alive(st)) return { started: false, message: 'Collector already running', pid: Number(st.pid) };
  const last = g.recentStarts.get(u) ?? 0;
  if (Date.now() - last < START_GRACE_MS) return { started: false, message: 'Collector is starting' };
  g.recentStarts.set(u, Date.now());
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.rmSync(stopTrigger(u), { force: true }); // a stale trigger would stop the fresh process at once
  const log = fs.openSync(file(u, 'oi_collector_stdout.log'), 'a');
  try {
    const child = spawn(PYTHON_EXE, [SCRIPT, '--underlying', u], { cwd: PROJECT_ROOT, detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.on('error', err => console.warn(`[crude-collector] ${u} failed to start:`, err.message));
    child.unref();
    return { started: true, message: 'Collector started', pid: child.pid };
  } finally {
    fs.closeSync(log);
  }
}

/** Stop it, and remember the user did so today: the scheduler will not restart it until tomorrow or the next Start. */
export function stopCollector(u: CrudeUnderlying): void {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(stopTrigger(u), '');
  writeJsonAtomic(manualStopFile(u), { date: istToday(), at: new Date().toISOString() });
}

const SCHEDULER_TICK_MS = 60_000;

/** One scheduler pass: start each collector that should be running in today's MCX session and is not. */
export function autoStartTick(now = Date.now()): void {
  const today = istToday();
  const session = mcxSession(today);
  const ist = new Date(now + 19_800_000);
  const nowMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  for (const u of CRUDE_COLLECTOR_UNDERLYINGS) {
    const stoppedToday = readJsonFile<{ date?: string }>(manualStopFile(u))?.date === today;
    const lastAttempt = g.autoAttempts.get(u);
    const go = shouldAutoStart({
      open: session.open, close: session.close, nowMin, running: alive(collectorStatus(u)), stoppedToday,
      sinceLastAttemptMs: lastAttempt === undefined ? Infinity : now - lastAttempt,
    });
    if (!go) continue;
    g.autoAttempts.set(u, now);
    try {
      const r = startCollector(u, false);
      if (r.started) console.log(`[crude-collector] auto-started ${u} (pid ${r.pid}) for the MCX session`);
    } catch (err) {
      console.warn(`[crude-collector] could not auto-start ${u}:`, (err as Error).message);
    }
  }
}

/** Run the scheduler in this server (once per process). Started from instrumentation.node.ts. */
export function startCrudeCollectorScheduler(): void {
  if (g.schedulerOn) return;
  g.schedulerOn = true;
  const tick = () => { try { autoStartTick(); } catch (err) { console.warn('[crude-collector] scheduler tick failed:', err); } };
  setTimeout(tick, 5_000).unref?.();
  setInterval(tick, SCHEDULER_TICK_MS).unref?.();
  console.log('[crude-collector] auto-start scheduler on (CRUDEOIL, CRUDEOILM during the MCX session)');
}
