/**
 * REAL MONEY. The Fresh Money target / stop-loss watcher: started once per dashboard server from instrumentation.node.ts,
 * it ticks every 2 s with every tab closed and sends MARKET closes through the page's own close path
 * (closePositionCore — same sizing, holds and in-flight rules as the × button). It stops with the dashboard: the page
 * shows "Exits watcher STOPPED" from the heartbeat below. Idle (one ledger read per tick) while no position has levels.
 * The decisions are in lib/freshMoneyExitTick.ts / lib/freshMoneyExits.ts (pure, tested).
 */
import { writeJsonAtomic } from '@/lib/lockedJsonFile';
import { brokerSessionOk } from '@/lib/freshMoneyBrokers';
import { runExitTick } from '@/lib/freshMoneyExitTick';
import type { Streak } from '@/lib/freshMoneyExits';
import {
  EXIT_WATCHER_FILE, closePositionCore, gateNow, loadLedger, ltpsFor, mutateLedger,
} from '@/lib/freshMoneyTradeServer';

const TAG = '[fm-exit]';
const TICK_MS = 2000;

interface Holder { timer: ReturnType<typeof setInterval>; busy: boolean; streaks: Map<string, Streak> }
const LOOP_KEY = '__freshMoneyExitLoop';

async function tick(h: Holder): Promise<void> {
  try { writeJsonAtomic(EXIT_WATCHER_FILE, { pid: process.pid, at: Date.now() }); } catch { /* next tick retries */ }
  await runExitTick({
    now: () => Date.now(),
    readLedger: loadLedger,
    mutate: mutateLedger,
    prices: async items => (await ltpsFor(items)).ltps,
    canExit: p => gateNow(p.underlying) !== 'closed' && brokerSessionOk(p.broker),
    close: (key, reason) => closePositionCore(key, reason),
    log: msg => console.log(`${TAG} ${msg}`),
  }, h.streaks);
}

export function startFreshMoneyExitLoop(): void {
  const g = globalThis as unknown as Record<string, Holder | undefined>;
  if (g[LOOP_KEY]) return;
  const h: Holder = {
    busy: false,
    streaks: new Map(),
    timer: setInterval(() => {
      if (h.busy) return;
      h.busy = true;
      tick(h).catch(err => console.error(`${TAG} tick failed:`, err)).finally(() => { h.busy = false; });
    }, TICK_MS),
  };
  g[LOOP_KEY] = h;
  console.log(`${TAG} watcher started`);
}
