import { realDeps } from '@/lib/gearboxServer';
import { gearboxSquareOffTickCore } from '@/lib/gearboxSquareOffCore';
import type { GbDeps } from '@/lib/gearboxCore';

// Gearbox's square-off watcher: closes every live row at the MCX auto-exit with every tab closed. Logic and rules live in
// lib/gearboxSquareOffCore.ts (tested with stubbed deps); this file binds the real broker deps and runs the 5 s loop.

export { squareOffDue } from '@/lib/gearboxSquareOffCore';

const TICK_MS = 5_000;
const LOOP_KEY = '__gearboxSquareOffLoop';

export const gearboxSquareOffTick = (deps: GbDeps = realDeps): Promise<void> => gearboxSquareOffTickCore(deps);

/** Starts the 5 s loop once per process. A tick with no live row is one file read. */
export function startGearboxSquareOffLoop(): void {
  const g = globalThis as unknown as Record<string, { timer: ReturnType<typeof setInterval>; busy: boolean } | undefined>;
  if (g[LOOP_KEY]) return;
  const h = { busy: false, timer: null as unknown as ReturnType<typeof setInterval> };
  h.timer = setInterval(() => {
    if (h.busy) return;
    h.busy = true;
    gearboxSquareOffTick().catch(err => console.error('[gearbox-squareoff] tick failed:', err)).finally(() => { h.busy = false; });
  }, TICK_MS);
  g[LOOP_KEY] = h;
  console.log('[gearbox-squareoff] watcher started');
}
