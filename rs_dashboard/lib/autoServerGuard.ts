// The pure core of the server-side AUTO guard (lib/autoServerWatcher.ts): what an open REAL AUTO row is worth now, and whether the
// page's MTM guard levels (rupee or box target / stop / trailing / protect profit) have tripped. The browser tab normally does this;
// the server repeats it so an open position is still protected with the tab closed. Each row is measured from its OWN entry price
// (its P&L is 0 at entry), so no baseline has to survive a restart. Pure (tested in lib/autoServerGuard.test.ts).
import { evalGuard, type LadderGuard } from './priceLadderGuard.ts';
import { effectiveGuard, noteBoxes } from './pnfGuardBoxes.ts';
import { holdsPosition, rowPnl, type AutoRow } from './pnfAutoLedger.ts';
import { autoProductOf, planOwnExit, type BookRow, type PnfBroker } from './pnfOrderLogic.ts';

/** The guard levels the page syncs to the server (the runtime fields - peak, floor, tripped - are the server's own). */
export type GuardLevels = Pick<LadderGuard, 'target' | 'stop' | 'trailBy' | 'lockAt' | 'lockKeep' | 'lockStepEvery' | 'lockStepKeep' | 'targetBoxes' | 'stopBoxes'>;

export interface ServerGuardCfg {
  on: boolean;
  /** Only a row of this broker and mode is guarded (the page's guard belongs to one account and mode). */
  broker: string;
  mode: 'PAPER' | 'REAL';
  levels: GuardLevels;
  /** The chart's box size in price points, to turn box levels into rupees (box x the row's rupees per point). */
  boxPts: number | null;
  updatedMs: number;
}

/** `base`: the row's P&L when the guard first saw it, when the guard was switched on AFTER the entry (the page measures from there too). */
export interface RowRuntime { peak?: number; floor?: number; base?: number }

/** Does this config guard this row? */
export const guards = (cfg: ServerGuardCfg | undefined, row: Pick<AutoRow, 'broker' | 'mode' | 'state'>): cfg is ServerGuardCfg =>
  !!cfg && cfg.on && holdsPosition(row) && row.mode === 'REAL' && cfg.mode === 'REAL' && cfg.broker === row.broker;

/**
 * One reading. `price`: the chart's live price (a straddle: CE + PE). The MTM is measured like the page's guard: from the entry price
 * when the guard was on before the position opened, from the P&L the row had when the guard was switched on otherwise (a position
 * already down 3000 when a Rs 1000 stop is set gets 1000 of further loss, not an instant exit). Returns the row's runtime (peak, floor,
 * that baseline) and, when a rule tripped, why.
 */
export function stepRow(row: AutoRow, cfg: ServerGuardCfg, price: number, runtime: RowRuntime): { runtime: RowRuntime; mtm: number; reason: string | null; boxesUnreadable: boolean } {
  const raw = rowPnl(row.side, row.entryPrice, price, row.unitsPerPoint);
  const base = runtime.base ?? (row.entryT * 1000 < cfg.updatedMs ? raw : 0);
  const mtm = raw - base;
  const g: LadderGuard = { on: true, ...cfg.levels, peak: runtime.peak, floor: runtime.floor };
  const rpb = cfg.boxPts !== null && cfg.boxPts > 0 && row.unitsPerPoint > 0 ? cfg.boxPts * row.unitsPerPoint : null;
  const r = evalGuard(effectiveGuard(g, rpb), mtm);
  const boxLevels = cfg.levels.targetBoxes !== undefined || cfg.levels.stopBoxes !== undefined;
  return { runtime: { peak: r.guard.peak, floor: r.guard.floor, base }, mtm, reason: r.reason ? noteBoxes(g, rpb, r.reason) : null, boxesUnreadable: boxLevels && rpb === null };
}

/** A leg's last tick older than this is not a price: a frozen subscription would mix a stale leg into a straddle's sum. */
export const QUOTE_MAX_AGE_MS = 10 * 60_000;

/** A chart's price from the bridge's book: the sum of its legs' prices, or null unless EVERY leg has a recently ticked price. */
export function chartPrice(ids: [string, string][], book: Record<string, { ltp: number; changed_ms: number | null }> | undefined, now: number): number | null {
  if (!book || ids.length === 0) return null;
  let sum = 0;
  for (const [seg, id] of ids) {
    const q = book[`${seg}:${id}`];
    if (!q || !(Number(q.ltp) > 0) || !q.changed_ms || now - Number(q.changed_ms) > QUOTE_MAX_AGE_MS) return null;
    sum += Number(q.ltp);
  }
  return sum;
}

/** Runtime keys are per scope + chart + row, so switching a chart's guard off can drop exactly its runtime. */
export const runtimeKey = (scope: string, chart: number, rowId: string) => `${scope}:${chart}:${rowId}`;

/**
 * How many units of an open REAL row the broker still shows, summed over its legs (an exit closes at most this much: the row's own
 * units, capped by its own product's book row in its direction). null when a leg has no broker key, i.e. it cannot be told. 0 means the broker
 * is flat for this row: the position was closed outside AUTO (by hand, a square-off, the broker).
 */
export function ownHeldQty(row: Pick<AutoRow, 'side' | 'legs' | 'product' | 'traded'>, book: BookRow[], broker: PnfBroker): number | null {
  if (row.legs.length === 0 || row.legs.some(l => !l.key)) return null;
  // an index chart's row holds its option on the OPTION's own side (a bearish SELL CE is a short)
  const closing = (row.traded?.action ?? row.side) === 'BUY' ? 'SELL' : 'BUY';
  return row.legs.reduce((n, l) => n + planOwnExit(l.key as string, book, closing, l.units, broker, autoProductOf(row.product)).qty, 0);
}

/**
 * A Two-back / One-back row's protective stop against the live price (as the page's decideAuto: a long at or below it, a short at or
 * above it). The stop is a plain price level saved on the row, so the server enforces it with the tab closed. False without a stop.
 */
export function stopHit(row: Pick<AutoRow, 'side' | 'stop'>, price: number | null): boolean {
  if (row.stop === undefined || !Number.isFinite(row.stop) || price === null) return false;
  return row.side === 'BUY' ? price <= row.stop : price >= row.stop;
}
