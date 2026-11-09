import { askBridge, ensureBridge } from '@/lib/pnfLiveBridge';
import { recordWindowOpen } from '@/lib/pnfRecordWindow';
import type { WantedPair } from '@/lib/pnfWanted';

// Keeps NIFTY 50 (IDX_I 13) in the P&F / Renko price bridge's tick log (scripts/tools/pnf_ws.py -> debug/pnf_ticks/) for the whole
// NSE session, with every tab closed. Renko's Tick / 10-30 sec charts are built only from that log (Dhan has no sub-minute history),
// and the bridge records an instrument only while something asks for it: without this, closing the chart left a hole in the day.
// Asks the bridge exactly as an open chart would (same wanted file, same shared Market Data Hub connection). Read-only: no orders.

const NIFTY: WantedPair = ['IDX_I', '13'];
const ASKER = 'always-record:IDX_I:13';
// Every second, like an open chart: the bridge keeps at most WANTED_MAX_PAIRS asks, oldest dropped first, and NIFTY must never be the oldest.
const EVERY_MS = 1_000;

const state = ((globalThis as { __pnfAlwaysRecord?: { timer?: ReturnType<typeof setInterval> } }).__pnfAlwaysRecord ??= {});

function step(): void {
  const now = Date.now();
  if (!recordWindowOpen(now)) return;      // outside the window the ask simply ages out of the bridge's wanted set
  try {
    askBridge(ASKER, [NIFTY], now);
    ensureBridge(now);
  } catch (err) {
    console.warn('[pnf-always-record] could not ask the price bridge:', (err as Error).message);
  }
}

export function startPnfAlwaysRecord(): void {
  if (state.timer) return;
  state.timer = setInterval(step, EVERY_MS);
  state.timer.unref?.();
  step();
}
