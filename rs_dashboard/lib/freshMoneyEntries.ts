/**
 * Fresh Money board — level entries (pure, no I/O). REAL MONEY.
 *
 * The XY ladder's model, strike by strike: an index level (MCX: the option month's future) is ARMED for one option, the
 * dashboard server watches that price and sends the option order AT MARKET when it crosses the level
 * (lib/freshMoneyEntryTick.ts → the click's own send path). Nothing rests at the broker.
 *
 * Limit vs stop is decided by where the level sits, as on the XY ladder (lib/priceLadder.ts limitZone):
 *   a CE is cheaper with the underlying LOWER, a PE with it HIGHER, so
 *   BUY CE below spot / SELL CE above / BUY PE above / SELL PE below = a LIMIT entry (a better price),
 *   the other side of spot = a STOP (breakout) entry.
 * The level is always on the far side of spot when armed, so it fires on the FIRST NEW tick at or past it (one cross, as
 * on the XY ladder): a tick counts only if the quote changed after the entry was armed, so an old print re-read from
 * the bridge file can never fire it. The watcher checks every 250 ms; the bridge writes every 0.5 s.
 */

import type { ExitDefaults } from './freshMoneyExits.ts';
import type { FmBroker, FmProduct, OptType, TxnSide } from './freshMoneyTrades.ts';

export type EntryDir = 'above' | 'below';
export type EntryKind = 'limit' | 'stop';
/** armed → firing (claimed in the ledger lock, then sent) → sent | unknown | rejected; or cancelled / expired. */
export type EntryState = 'armed' | 'firing' | 'sent' | 'unknown' | 'rejected' | 'cancelled' | 'expired';

export interface FmEntry {
  id: string;
  /** Epoch ms it was armed. */
  ts: number;
  broker: FmBroker;
  underlying: string;
  expiry: string;
  strike: number;
  opt: OptType;
  side: TxnSide;
  lots: number;
  product: FmProduct;
  /** The header's target / stop-loss at arm time, stamped onto the position the fire opens (like a click's). */
  exitDefaults: ExitDefaults;
  /** Index (MCX: futures) level that fires it. */
  level: number;
  /** Fires when the price is at or `above` / `below` the level. */
  dir: EntryDir;
  kind: EntryKind;
  /** The position key (lib/freshMoneyTrades orderKey) and signed order quantity, resolved when armed: armed entries count
   *  toward the per-contract cap as if they fill. */
  key: string;
  qty: number;
  /** Order quantity per lot (the broker's unit), for the cap message. */
  lot: number;
  state: EntryState;
  /** The price when it was armed (shown; the classification was made against it). */
  spotAtArm: number;
  firedAt?: number;
  spotAtFire?: number;
  /** The broker order id once placed. */
  orderId?: string;
  /** Why it ended (rejected / unknown / expired / cancelled), or the fire note. */
  reason?: string;
  endedAt?: number;
}

/** Furthest a level may be from the price when armed (the XY ladder's MAX_LEVEL_DISTANCE). */
export const MAX_ENTRY_DISTANCE = 0.05;
/** A 'firing' entry with no recorded outcome after this long (the dashboard stopped mid-send) becomes UNKNOWN. */
export const ENTRY_FIRING_STALE_MS = 60_000;

const ACTIVE: ReadonlySet<EntryState> = new Set(['armed', 'firing']);
export const entryActive = (s: EntryState) => ACTIVE.has(s);

/** Where a level is cheaper to buy (and dearer to sell) for this option: the XY ladder's limitZone. */
export function limitSide(opt: OptType, side: TxnSide): EntryDir {
  const cheaperBelow = opt === 'CE';
  return cheaperBelow === (side === 'BUY') ? 'below' : 'above';
}

/** The level's direction from the price and whether that makes it a limit or a stop entry. */
export function classifyEntry(opt: OptType, side: TxnSide, level: number, spot: number): { dir: EntryDir; kind: EntryKind } {
  const dir: EntryDir = level < spot ? 'below' : 'above';
  return { dir, kind: dir === limitSide(opt, side) ? 'limit' : 'stop' };
}

/** Why this level cannot be armed against `spot`, or null. */
export function levelProblem(level: number, spot: number): string | null {
  if (!Number.isFinite(level) || level <= 0) return 'Enter a level (a price of the underlying)';
  if (!Number.isFinite(spot) || spot <= 0) return 'No live price yet — try again in a few seconds';
  if (level === spot) return 'The level is the current price — it would fire at once; place a market order instead';
  if (Math.abs(level - spot) / spot > MAX_ENTRY_DISTANCE) {
    return `The level is more than ${MAX_ENTRY_DISTANCE * 100}% from the price (${spot.toFixed(2)}) — refused`;
  }
  return null;
}

/** True when `spot` is at or past the level in the entry's direction. */
export const entryBreached = (e: Pick<FmEntry, 'level' | 'dir'>, spot: number) => (e.dir === 'above' ? spot >= e.level : spot <= e.level);

/** A WebSocket quote of the watched price: last price and when it last changed (null = not since subscribing). */
export interface SpotQuote { ltp: number; changedMs: number | null }

/** Fire now: a quote that CHANGED after the entry was armed (a new tick, not an old print re-read) is at or past the
 *  level. No quote / an unchanged one = wait. */
export function entryFires(e: Pick<FmEntry, 'level' | 'dir' | 'ts'>, q: SpotQuote | null): boolean {
  return !!q && Number.isFinite(q.ltp) && q.changedMs !== null && q.changedMs > e.ts && entryBreached(e, q.ltp);
}

/** Quantity of ARMED entries on a contract, per direction (BUY / SELL, both >= 0). A firing one has its order record
 *  (or is about to) and is not counted twice. Kept apart so an armed SELL never offsets a BUY in the cap: each side is
 *  checked as if only it fills (an armed level may be cancelled or expire, leaving the other side's real fills). */
export function armedQty(entries: readonly FmEntry[] | undefined, key: string): { buy: number; sell: number } {
  let buy = 0, sell = 0;
  for (const e of entries ?? []) {
    if (e.state !== 'armed' || e.key !== key) continue;
    if (e.side === 'BUY') buy += e.qty; else sell += e.qty;
  }
  return { buy, sell };
}

/** The global (combined P&L) exit has fired, or tried to: the user's kill switch. No level may open anything after it. */
export const globalFired = (g: { state: string } | null | undefined) => !!g && g.state !== 'watching';

/** The entry's new fields once its order has answered (placed / unknown / refused / rejected). */
export function entryAfterFire(
  r: { kind: 'placed'; orderId: string } | { kind: 'unknown'; error: string } | { kind: 'partial'; error: string }
    | { kind: 'refused' | 'rejected'; error: string },
  now: number,
): Partial<FmEntry> {
  if (r.kind === 'placed') return { state: 'sent', orderId: r.orderId, endedAt: now };
  if (r.kind === 'unknown' || r.kind === 'partial') return { state: 'unknown', reason: `UNKNOWN — check the broker: ${r.error}`, endedAt: now };
  return { state: 'rejected', reason: r.error, endedAt: now };
}

/** Short label, e.g. "B ≤25,250" / "S ≥25,400". */
export function entryLabel(e: Pick<FmEntry, 'side' | 'dir' | 'level'>): string {
  return `${e.side === 'BUY' ? 'B' : 'S'} ${e.dir === 'above' ? '≥' : '≤'}${e.level.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}
