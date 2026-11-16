/**
 * REAL MONEY. The Fresh Money target / stop-loss watcher: started once per dashboard server from instrumentation.node.ts,
 * it ticks every 2 s with every tab closed and sends MARKET closes through the page's own close path
 * (closePositionCore — same sizing, holds and in-flight rules as the × button). It stops with the dashboard: the page
 * shows "Exits watcher STOPPED" from the heartbeat below. Idle (one ledger read per tick) while no position has levels.
 * The decisions are in lib/freshMoneyExitTick.ts / lib/freshMoneyExits.ts (pure, tested).
 *
 * A SEPARATE fast loop (every 250 ms) runs the level-entry watcher (lib/freshMoneyEntryTick.ts): armed index levels fire
 * a MARKET order through the click's own send path (fireEntryCore) on the first new WebSocket tick past the level. Its
 * own loop so a fire never waits for, nor delays, the stops (2026-11-16: firing inside this 2 s loop with two checks
 * took 3-4 s and slipped 5 points). It reads the ledger at most once a second (every claim re-checks in the lock).
 */
import type { FmLedger } from '@/lib/freshMoneyTrades';
import { writeJsonAtomic } from '@/lib/lockedJsonFile';
import { brokerSessionOk } from '@/lib/freshMoneyBrokers';
import { runExitTick } from '@/lib/freshMoneyExitTick';
import type { Streak } from '@/lib/freshMoneyExits';
import type { FmPosition } from '@/lib/freshMoneyTrades';
import { runGlobalTick } from '@/lib/freshMoneyGlobalTick';
import { runEntryTick } from '@/lib/freshMoneyEntryTick';
import {
  ENTRY_WATCHER_FILE, EXIT_WATCHER_FILE, closePositionCore, contractHeld, fireEntryCore, gateNow, loadLedger, ltpsFor, mutateLedger,
  reconcileWithBrokers, refreshOrders, spotQuoteNow,
} from '@/lib/freshMoneyTradeServer';

const TAG = '[fm-exit]';
const TICK_MS = 2000;

interface Holder { timer: ReturnType<typeof setInterval>; busy: boolean; streaks: Map<string, Streak>; global: { cur: Streak | null } }
const LOOP_KEY = '__freshMoneyExitLoop';

async function tick(h: Holder): Promise<void> {
  try { writeJsonAtomic(EXIT_WATCHER_FILE, { pid: process.pid, at: Date.now() }); } catch { /* next tick retries */ }
  const deps = {
    now: () => Date.now(),
    readLedger: loadLedger,
    mutate: mutateLedger,
    prices: async (items: Parameters<typeof ltpsFor>[0]) => (await ltpsFor(items)).ltps,
    canExit: (p: FmPosition) =>
      gateNow(p.underlying) !== 'closed' && brokerSessionOk(p.broker),
    close: (key: string, reason: string) => closePositionCore(key, reason),
    log: (msg: string) => console.log(`${TAG} ${msg}`),
    // Order fills and the down-only reconcile, otherwise run only by the page's poll (paused in a hidden tab).
    // Both throttle themselves (2 s; 5 / 10 / 15 s per broker).
    refresh: async () => { await refreshOrders().catch(() => {}); await reconcileWithBrokers().catch(() => {}); },
  };
  await runExitTick(deps, h.streaks);
  await runGlobalTick(deps, (h.global ??= { cur: null })); // a loop started before this field existed (dev reload) lacks it
}

// ── level entries: their own fast loop ───────────────────────────────────────────────────────────────────────────

const ENTRY_TICK_MS = 250;
/** The ledger is re-read at most this often (and right after any write); prices are read every tick. */
const ENTRY_LEDGER_MS = 1000;
const ENTRY_HEARTBEAT_MS = 1000;
const ENTRY_LOOP_KEY = '__freshMoneyEntryLoop';

interface EntryHolder { timer: ReturnType<typeof setInterval>; busy: boolean; cache: { at: number; l: FmLedger } | null; beatAt: number }

function startFreshMoneyEntryLoop(): void {
  const g = globalThis as unknown as Record<string, EntryHolder | undefined>;
  if (g[ENTRY_LOOP_KEY]) return;
  const h: EntryHolder = { busy: false, cache: null, beatAt: 0, timer: null as unknown as ReturnType<typeof setInterval> };
  const deps = {
    now: () => Date.now(),
    readLedger: async () => {
      if (h.cache && Date.now() - h.cache.at < ENTRY_LEDGER_MS) return h.cache.l;
      const l = await loadLedger();
      h.cache = { at: Date.now(), l };
      return l;
    },
    // Every write drops the cache: the next tick decides on the ledger as it now is.
    mutate: async <T,>(fn: (l: FmLedger) => T): Promise<T> => { try { return await mutateLedger(fn); } finally { h.cache = null; } },
    spot: spotQuoteNow,
    gate: (u: string, product: 'MIS' | 'NRML') => gateNow(u, product),
    held: contractHeld,
    fire: fireEntryCore,
    log: (msg: string) => console.log(`[fm-entry] ${msg}`),
  };
  h.timer = setInterval(() => {
    const now = Date.now();
    if (now - h.beatAt >= ENTRY_HEARTBEAT_MS) {
      h.beatAt = now;
      try { writeJsonAtomic(ENTRY_WATCHER_FILE, { pid: process.pid, at: now }); } catch { /* next beat retries */ }
    }
    if (h.busy) return;
    h.busy = true;
    runEntryTick(deps).catch(err => console.error('[fm-entry] tick failed:', err)).finally(() => { h.busy = false; });
  }, ENTRY_TICK_MS);
  g[ENTRY_LOOP_KEY] = h;
  console.log('[fm-entry] level watcher started');
}

export function startFreshMoneyExitLoop(): void {
  startFreshMoneyEntryLoop();
  const g = globalThis as unknown as Record<string, Holder | undefined>;
  if (g[LOOP_KEY]) return;
  const h: Holder = {
    busy: false,
    streaks: new Map(),
    global: { cur: null },
    timer: setInterval(() => {
      if (h.busy) return;
      h.busy = true;
      tick(h).catch(err => console.error(`${TAG} tick failed:`, err)).finally(() => { h.busy = false; });
    }, TICK_MS),
  };
  g[LOOP_KEY] = h;
  console.log(`${TAG} watcher started`);
}
