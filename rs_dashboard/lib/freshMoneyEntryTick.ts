/**
 * Fresh Money level-entry watcher — one tick, every outside effect injected (testable without a broker). REAL MONEY:
 * `deps.fire` is the click's own send path (lib/freshMoneyTradeServer.ts fireEntryCore), wired by
 * lib/freshMoneyExitServer.ts in its OWN fast loop (every 250 ms), so a fire neither waits for nor delays the target /
 * stop-loss watcher.
 *
 * Each tick:
 *   - the global (combined P&L) exit has fired = the user's kill switch: every armed level is CANCELLED, none fires;
 *   - an armed entry whose product can no longer open (the MIS cutoff, NRML a minute before the close) is EXPIRED;
 *   - a 'firing' entry left without an outcome (the dashboard stopped mid-send) becomes UNKNOWN — never resent;
 *   - an armed entry whose watched price printed a NEW tick (changed after arming) at or past the level is CLAIMED
 *     ('firing') under the ledger lock — only if still 'armed' and no order on its contract is in flight, both decided
 *     in that lock — then sent, then its outcome recorded. At most once.
 * One fire per contract per tick; a contract with an order in flight waits (the entry stays armed).
 */
import { ENTRY_FIRING_STALE_MS, entryActive, entryAfterFire, entryFires, globalFired, type FmEntry, type SpotQuote } from './freshMoneyEntries.ts';
import type { CloseResult } from './freshMoneyExits.ts';
import type { FmLedger, SessionGate } from './freshMoneyTrades.ts';

export interface EntryTickDeps {
  now(): number;
  readLedger(): FmLedger | Promise<FmLedger>;
  mutate<T>(fn: (l: FmLedger) => T): Promise<T>;
  /** The board's price (index, or the option month's future) for this underlying + expiry, from the WebSocket only;
   *  null = no usable quote. */
  spot(underlying: string, expiry: string): SpotQuote | null;
  /** Whether new positions may open now for this underlying and product. */
  gate(underlying: string, product: FmEntry['product']): SessionGate;
  /** An order on this contract is still in flight / UNKNOWN: wait. Called inside the ledger lock. */
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

export async function runEntryTick(deps: EntryTickDeps): Promise<void> {
  const l = await deps.readLedger();
  const active = (l.entries ?? []).filter(e => entryActive(e.state));
  if (!active.length) return;
  const now = deps.now();

  for (const e of active) {
    if (e.state === 'firing' && now - (e.firedAt ?? 0) > ENTRY_FIRING_STALE_MS) {
      await update(deps, e.id, 'firing', {
        state: 'unknown', endedAt: now, reason: 'UNKNOWN — the dashboard stopped while this level was being sent; check the broker',
      });
    }
  }
  const armedNow = active.filter(e => e.state === 'armed');
  if (!armedNow.length) return;

  if (globalFired(l.global)) {
    await deps.mutate(m => {
      for (const e of m.entries ?? []) {
        if (e.state === 'armed') Object.assign(e, { state: 'cancelled', endedAt: now, reason: 'Cancelled: the total target / stop-loss fired' });
      }
    });
    deps.log('global exit fired: armed levels cancelled');
    return;
  }

  const armed: FmEntry[] = [];
  for (const e of armedNow) {
    if (deps.gate(e.underlying, e.product) !== 'open') {
      if (await update(deps, e.id, 'armed', { state: 'expired', endedAt: now, reason: `Expired: ${e.product} can no longer open new positions today` })) {
        deps.log(`expired ${e.underlying} ${e.strike} ${e.opt} ${e.side} @ ${e.level}`);
      }
      continue;
    }
    armed.push(e);
  }
  if (!armed.length) return;

  const quotes = new Map<string, SpotQuote | null>();
  const quoteOf = (e: FmEntry) => {
    const k = `${e.underlying}|${e.expiry}`;
    if (!quotes.has(k)) quotes.set(k, deps.spot(e.underlying, e.expiry));
    return quotes.get(k)!;
  };
  const firedKeys = new Set<string>();
  for (const e of armed) {
    const q = quoteOf(e);
    if (!q || !entryFires(e, q) || firedKeys.has(e.key)) continue;
    // Claim: still armed, no order in flight on the contract, no global exit — all decided inside the lock.
    const claimed = await deps.mutate(m => {
      const x = (m.entries ?? []).find(y => y.id === e.id);
      if (!x || x.state !== 'armed' || globalFired(m.global) || deps.held(m, e.key)) return false;
      Object.assign(x, { state: 'firing', firedAt: deps.now(), spotAtFire: q.ltp });
      return true;
    });
    if (!claimed) continue;
    firedKeys.add(e.key);
    deps.log(`fire ${e.underlying} ${e.strike} ${e.opt} ${e.side} ${e.lots} lot(s): ${e.underlying} ${q.ltp} vs level ${e.level}`);
    let r: CloseResult;
    try {
      r = await deps.fire(e, q.ltp);
    } catch (err) {
      r = { kind: 'unknown', error: String((err as Error)?.message ?? err), partial: false };
    }
    await update(deps, e.id, 'firing', entryAfterFire(r, deps.now()))
      .catch(err => deps.log(`could not record the outcome of ${e.id}: ${String(err)}`));
  }
}
