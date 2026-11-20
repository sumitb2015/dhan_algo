import { askBridge, ensureBridge } from '@/lib/pnfLiveBridge';
import { readGbLedger } from '@/lib/gearboxFile';
import { istDateIso } from '@/lib/nseHolidays';
import { gbRecordPairs, mcxRecordOpen } from '@/lib/gearboxAlwaysRecordCore';

// Keeps Gearbox Drive's crude future (the configured underlying's signal future, plus the future of any live FUT row) in the P&F /
// Renko price bridge's tick log (scripts/tools/pnf_ws.py -> debug/pnf_ticks/) for the whole MCX session, with every tab closed.
// Gearbox's 5-30 s bars are built only from that log (Dhan has no sub-minute history), and the bridge records an instrument only
// while something asks for it. Same pattern as lib/pnfAlwaysRecord.ts (NIFTY, NSE window). Read-only: no orders.

// Every second, like an open chart: the bridge keeps at most WANTED_MAX_PAIRS asks, oldest dropped first.
const EVERY_MS = 1_000;

const state = ((globalThis as { __gearboxAlwaysRecord?: { timer?: ReturnType<typeof setInterval> } }).__gearboxAlwaysRecord ??= {});

function step(): void {
  const now = Date.now();
  if (!mcxRecordOpen(now)) return;      // outside the session the asks simply age out of the bridge's wanted set
  try {
    const pairs = gbRecordPairs(readGbLedger(), istDateIso(now));
    if (!pairs.length) return;
    for (const p of pairs) askBridge(`gearbox-record:${p[0]}:${p[1]}`, [p], now);
    ensureBridge(now);
  } catch (err) {
    console.warn('[gearbox-always-record] could not ask the price bridge:', (err as Error).message);
  }
}

export function startGearboxAlwaysRecord(): void {
  if (state.timer) return;
  state.timer = setInterval(step, EVERY_MS);
  state.timer.unref?.();
  step();
}
