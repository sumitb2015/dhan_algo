/**
 * Fresh Money level-entry watcher — one tick, every outside effect injected (testable without a broker). REAL MONEY:
 * `deps.fire` is the click's own send path (lib/freshMoneyTradeServer.ts fireEntryCore), wired by
 * lib/freshMoneyExitServer.ts, which runs this every 2 s next to the exit watcher.
 *
 * Each tick re-reads the ledger (the route and this loop can be separate module instances; the file is the truth):
 *   - an armed entry whose product can no longer open (the MIS cutoff, NRML a minute before the close) is EXPIRED;
 *   - a 'firing' entry left without an outcome (the dashboard stopped mid-send) becomes UNKNOWN — never resent;
 *   - an armed entry breached on two checks in a row is CLAIMED ('firing') under the ledger lock, then sent, then its
 *     outcome recorded. At most once: only an entry still 'armed' in the lock can be claimed.
 * A contract with an order still in flight waits a tick rather than firing into the hold (a refusal would reject it).
 */
import {
  ENTRY_FIRING_STALE_MS, entryActive, entryAfterFire, entryStep, type EntryStreak, type FmEntry,
} from './freshMoneyEntries.ts';
import type { CloseResult } from './freshMoneyExits.ts';
import type { FmLedger, SessionGate } from './freshMoneyTrades.ts';

export interface EntryTickDeps {
  now(): number;
  readLedger(): FmLedger | Promise<FmLedger>;
  mutate<T>(fn: (l: FmLedger) => T): Promise<T>;
  /** The board's price (index, or the option month's future) for this underlying + expiry; null = no usable price. */
  spot(underlying: string, expiry: string): number | null;
  /** Whether new positions may open now for this underlying and product. */
  gate(underlying: string, product: FmEntry['product']): SessionGate;
  /** An order on this contract is still in flight / UNKNOWN: wait. */
  held(l: FmLedger, key: string): boolean;
  fire(e: FmEntry, spot: number): Promise<CloseResult>;
  log(msg: string): void;
}

/** Write `patch` to entry `id` only if it is still in `expect` state (the record this tick decided on). */
async function update(deps: EntryTickDeps, id: string, expect: FmEntry['state'], patch: Partial<FmEntry>): Promise<boolean> {
  return deps.mutate(l => {
    const e = (l.entries ?? []).find(x => x.id === id);
    if (!e || e.state !== expect) return false;
    Object.assign(e, patch);
    return true;
  });
}

export async function runEntryTick(deps: EntryTickDeps, streaks: Map<string, EntryStreak>): Promise<void> {
  const l = await deps.readLedger();
  const active = (l.entries ?? []).filter(e => entryActive(e.state));
  for (const id of [...streaks.keys()]) if (!active.some(e => e.id === id && e.state === 'armed')) streaks.delete(id);
  if (!active.length) return;
  const now = deps.now();

  for (const e of active) {
    if (e.state === 'firing' && now - (e.firedAt ?? 0) > ENTRY_FIRING_STALE_MS) {
      await update(deps, e.id, 'firing', {
        state: 'unknown', endedAt: now, reason: 'UNKNOWN — the dashboard stopped while this level was being sent; check the broker',
      });
    }
  }

  const armed: FmEntry[] = [];
  for (const e of active) {
    if (e.state !== 'armed') continue;
    if (deps.gate(e.underlying, e.product) !== 'open') {
      if (await update(deps, e.id, 'armed', { state: 'expired', endedAt: now, reason: `Expired: ${e.product} can no longer open new positions today` })) {
        streaks.delete(e.id);
        deps.log(`expired ${e.underlying} ${e.strike} ${e.opt} ${e.side} @ ${e.level}`);
      }
      continue;
    }
    armed.push(e);
  }
  if (!armed.length) return;

  const prices = new Map<string, number | null>();
  const priceOf = (e: FmEntry) => {
    const k = `${e.underlying}|${e.expiry}`;
    if (!prices.has(k)) prices.set(k, deps.spot(e.underlying, e.expiry));
    return prices.get(k)!;
  };
  const firedKeys = new Set<string>();
  for (const e of armed) {
    const spot = priceOf(e);
    const step = entryStep(e, spot, streaks.get(e.id) ?? null, now);
    if (step.streak) streaks.set(e.id, step.streak); else streaks.delete(e.id);
    if (!step.fire || spot === null) continue;
    // One fire per contract per tick, and none into an order still in flight: the next tick fires it (the streak stays).
    if (firedKeys.has(e.key) || deps.held(await deps.readLedger(), e.key)) continue;
    const claimed = await update(deps, e.id, 'armed', { state: 'firing', firedAt: deps.now(), spotAtFire: spot });
    if (!claimed) continue;
    firedKeys.add(e.key);
    streaks.delete(e.id);
    deps.log(`fire ${e.underlying} ${e.strike} ${e.opt} ${e.side} ${e.lots} lot(s): ${e.underlying} ${spot} vs level ${e.level}`);
    let r: CloseResult;
    try {
      r = await deps.fire(e, spot);
    } catch (err) {
      r = { kind: 'unknown', error: String((err as Error)?.message ?? err), partial: false };
    }
    const patch = entryAfterFire(r, deps.now());
    await update(deps, e.id, 'firing', patch).catch(err => deps.log(`could not record the outcome of ${e.id}: ${String(err)}`));
  }
}
