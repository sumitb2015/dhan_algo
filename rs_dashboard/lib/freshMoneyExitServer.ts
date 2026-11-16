/**
 * REAL MONEY. The Fresh Money target / stop-loss watcher: started once per dashboard server from instrumentation.node.ts,
 * it ticks every 2 s with every tab closed and sends MARKET closes through the page's own close path
 * (closePositionCore — same sizing, holds and in-flight rules as the × button). It stops with the dashboard: the page
 * shows "Exits watcher STOPPED" from the heartbeat below. Idle (one ledger read per tick) while no position has levels.
 * The decisions are in lib/freshMoneyExitTick.ts / lib/freshMoneyExits.ts (pure, tested).
 *
 * The same loop runs the level-entry watcher (lib/freshMoneyEntryTick.ts): armed index levels fire a MARKET order
 * through the click's own send path (fireEntryCore). Idle (one ledger read) while nothing is armed.
 */
import { writeJsonAtomic } from '@/lib/lockedJsonFile';
import { brokerSessionOk } from '@/lib/freshMoneyBrokers';
import { runExitTick } from '@/lib/freshMoneyExitTick';
import type { Streak } from '@/lib/freshMoneyExits';
import type { FmPosition } from '@/lib/freshMoneyTrades';
import { runGlobalTick } from '@/lib/freshMoneyGlobalTick';
import { runEntryTick } from '@/lib/freshMoneyEntryTick';
import type { EntryStreak } from '@/lib/freshMoneyEntries';
import {
  EXIT_WATCHER_FILE, closePositionCore, contractHeld, fireEntryCore, gateNow, loadLedger, ltpsFor, mutateLedger, reconcileWithBrokers,
  refreshOrders, spotNow,
} from '@/lib/freshMoneyTradeServer';

const TAG = '[fm-exit]';
const TICK_MS = 2000;

interface Holder {
  timer: ReturnType<typeof setInterval>; busy: boolean; streaks: Map<string, Streak>; global: { cur: Streak | null };
  /** Level-entry breach streaks, by entry id (absent on a loop started before entries existed: a dev reload). */
  entryStreaks?: Map<string, EntryStreak>;
}
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
  // Entries first: a fill they produce is then guarded by the exit tick's stamped levels on its next pass.
  await runEntryTick({
    now: () => Date.now(),
    readLedger: loadLedger,
    mutate: mutateLedger,
    spot: spotNow,
    gate: (u, product) => gateNow(u, product),
    held: contractHeld,
    fire: fireEntryCore,
    log: (msg: string) => console.log(`[fm-entry] ${msg}`),
  }, (h.entryStreaks ??= new Map())).catch(err => console.error('[fm-entry] tick failed:', err));
  await runExitTick(deps, h.streaks);
  await runGlobalTick(deps, (h.global ??= { cur: null })); // a loop started before this field existed (dev reload) lacks it
}

export function startFreshMoneyExitLoop(): void {
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
