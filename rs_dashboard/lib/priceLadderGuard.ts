import { patchSlice, pushEvent, ev, sumSlicePnl, sliceNowPnl, paneOf, type LadderBroker, type LadderState } from './priceLadder.ts';
import { isPairLive, patchPair, sumPairPnl, pairNowPnl } from './priceLadderPair.ts';
import { isBasketLive, patchBasket, sumBasketPnl, basketNowPnl } from './priceLadderBasket.ts';

// The Price Ladder's MTM guard: one per ladder pane + broker + SIM/REAL mode, over the positions THAT ladder placed
// (slices and pairs tagged with its pane; untagged = ladder 1, as in the tables). The two ladders never see or exit
// each other's positions, even on the same broker and mode. Target, stop, trailing and Protect Profit all read the same number — the ladder's own P&L (closed at
// their exits, open at live prices) — and when one trips, everything of that scope exits and armed levels are
// cancelled, then the guard switches itself off (re-arm it to carry on). Evaluated by the server watcher inside the
// ledger lock, so it works with every tab closed. At a new day rollDay keeps the levels but restores every guard OFF with no runtime state.

export interface LadderGuard {
  on: boolean;
  /** Exit when MTM reaches this many rupees of profit. */
  target?: number;
  /** Exit when MTM falls to this many rupees of loss (positive number). */
  stop?: number;
  /** Trailing: exit when MTM gives back this many rupees from its best. */
  trailBy?: number;
  /** Protect profit: once MTM has reached `lockAt`, never give back below `lockKeep`… */
  lockAt?: number;
  lockKeep?: number;
  /** …and for every further `lockStepEvery` of MTM, raise the locked profit by `lockStepKeep`. */
  lockStepEvery?: number;
  lockStepKeep?: number;
  // runtime
  peak?: number;
  floor?: number;
  firedAt?: number;
  firedReason?: string;
  /** A rule tripped but something of its scope is still live (an entry in flight, an exit being sent or retried, a leg
   *  waiting its turn): the guard stays on, re-queuing exits, and switches itself off only once nothing of its scope
   *  holds or can still become a position. */
  tripped?: string;
}

export type GuardPane = 1 | 2;
export type GuardScope = { broker: LadderBroker; mode: 'sim' | 'real'; pane: GuardPane };

/** Ladder 1 keeps the pre-pane key `broker:mode`, so a guard saved before panes stays ladder 1's; ladder 2 adds `:2`. */
export const guardKey = (broker: LadderBroker, mode: 'sim' | 'real', pane: GuardPane = 1) => `${broker}:${mode}${pane === 2 ? ':2' : ''}`;

const BROKERS: ReadonlySet<string> = new Set(['dhan', 'kotak', 'zerodha']);

/** The scope a stored key names, or null for a key this code did not write (it is then never evaluated). */
export function parseGuardKey(key: string): GuardScope | null {
  const [broker, mode, pane, ...rest] = key.split(':');
  if (rest.length || !BROKERS.has(broker) || (mode !== 'sim' && mode !== 'real') || (pane !== undefined && pane !== '2')) return null;
  return { broker: broker as LadderBroker, mode, pane: pane === '2' ? 2 : 1 };
}

/** Does this slice / pair belong to the guard's scope: same broker, same mode, placed by the same ladder. */
export const inScope = (x: { broker: LadderBroker; mode: 'sim' | 'real'; pane?: number }, sc: GuardScope) =>
  x.broker === sc.broker && x.mode === sc.mode && paneOf(x) === sc.pane;

const MAX_RS = 10_000_000;
const pos = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= MAX_RS ? Math.round(n * 100) / 100 : undefined;
};

/** Validate the page's settings into a guard (runtime fields start fresh). An error string refuses the request. */
export function cleanGuard(b: Record<string, unknown>): LadderGuard | string {
  const g: LadderGuard = {
    on: b.on === true,
    target: pos(b.target), stop: pos(b.stop), trailBy: pos(b.trailBy),
    lockAt: pos(b.lockAt), lockKeep: b.lockKeep === 0 || b.lockKeep === '0' ? 0 : pos(b.lockKeep),
    lockStepEvery: pos(b.lockStepEvery), lockStepKeep: pos(b.lockStepKeep),
  };
  if ((g.lockAt != null) !== (g.lockKeep != null)) return 'Protect profit needs both "when MTM reaches" and "lock"';
  if (g.lockAt != null && g.lockKeep! >= g.lockAt) return 'The locked profit must be below the level that triggers it';
  if ((g.lockStepEvery != null) !== (g.lockStepKeep != null)) return 'The lock step needs both "every" and "raise lock by"';
  if (g.lockStepEvery != null && g.lockAt == null) return 'The lock step belongs to Protect profit — set its level first';
  if (g.lockStepKeep != null && g.lockStepEvery != null && g.lockStepKeep > g.lockStepEvery) return 'Raise the lock by no more than the step itself';
  if (g.target != null && g.lockAt != null && g.lockAt >= g.target) return 'Protect profit should trigger below the target';
  if (g.on && g.target == null && g.stop == null && g.trailBy == null && g.lockAt == null) return 'Set a target, stop, trailing or protect-profit level first';
  return g;
}

/**
 * The guard to store when the user presses Save. Updating one that stays on keeps what it has learned (best MTM, the
 * profit already locked, a trip in progress); switching it off, or on again, starts fresh.
 */
export function carryRuntime(next: LadderGuard, old?: LadderGuard): LadderGuard {
  return next.on && old?.on ? { ...next, peak: old.peak, floor: old.floor, tripped: old.tripped, firedAt: old.firedAt } : next;
}

/** The locked profit for a given best MTM: 0 steps before the trigger, the base lock at it, then one step per `every`. */
export function lockFloor(g: LadderGuard, peak: number): number | null {
  if (g.lockAt == null || g.lockKeep == null || peak < g.lockAt) return null;
  const steps = g.lockStepEvery && g.lockStepKeep ? Math.floor((peak - g.lockAt) / g.lockStepEvery) : 0;
  return g.lockKeep + steps * (g.lockStepKeep ?? 0);
}

/** "dhan REAL" for ladder 1, "ladder 2 · dhan REAL" for ladder 2: the scope as events and the page name it. */
export const guardLabel = (sc: GuardScope) => `${sc.pane === 2 ? 'ladder 2 · ' : ''}${sc.broker} ${sc.mode.toUpperCase()}`;

/** One reading. Returns the guard with its peak / floor advanced and, when a rule tripped, why. No reading, no action. */
export function evalGuard(g: LadderGuard, mtm: number | null): { guard: LadderGuard; reason: string | null } {
  if (!g.on || mtm == null || !Number.isFinite(mtm)) return { guard: g, reason: null };
  const peak = Math.max(g.peak ?? mtm, mtm);
  const lf = lockFloor(g, peak);
  const floor = lf == null ? g.floor : Math.max(g.floor ?? lf, lf);
  const guard = peak === g.peak && floor === g.floor ? g : { ...g, peak, floor };
  const rs = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
  let reason: string | null = null;
  if (g.target != null && mtm >= g.target) reason = `MTM target ${rs(g.target)} hit`;
  else if (g.stop != null && mtm <= -g.stop) reason = `MTM stop-loss ${rs(g.stop)} hit`;
  else if (floor != null && mtm <= floor) reason = `Profit protected: MTM fell back to the locked ${rs(floor)}`;
  else if (g.trailBy != null && mtm <= peak - g.trailBy) reason = `Trailing MTM: gave back ${rs(g.trailBy)} from the peak ${rs(peak)}`;
  return { guard, reason };
}

/** The scope's MTM: slices + pairs of this ladder, broker and mode. Null when nothing counts, or an open leg has no price. */
export function scopeMtm(s: LadderState, sc: GuardScope, ltps: Record<string, number>): number | null {
  const pickS = (x: { broker: LadderBroker; mode: 'sim' | 'real'; pane?: number }) => inScope(x, sc);
  const slices = s.slices, pairs = s.pairs ?? [], baskets = s.baskets ?? [];
  const hasS = slices.some(x => pickS(x) && sliceNowPnl(x, ltps[x.contract.securityId]) !== undefined);
  const hasP = pairs.some(p => pickS(p) && pairNowPnl(p, ltps) !== undefined);
  const hasB = baskets.some(k => pickS(k) && basketNowPnl(k, ltps) !== undefined);
  if (!hasS && !hasP && !hasB) return null;
  const a = hasS ? sumSlicePnl(slices, pickS, x => ltps[x.contract.securityId]) : 0;
  const b = hasP ? sumPairPnl(pairs, pickS, ltps) : 0;
  const k = hasB ? sumBasketPnl(baskets, pickS, ltps) : 0;
  return a == null || b == null || k == null ? null : a + b + k;
}

/** Anything of this scope that holds a position or may become one (an unresolved UNKNOWN is the user's to settle). */
function scopeLive(s: LadderState, sc: GuardScope): boolean {
  return s.slices.some(x => inScope(x, sc) && (x.state === 'open' || x.state === 'exiting' || x.state === 'placing' || (x.state === 'working' && (x.mode === 'real' || x.filledQty))))
    || (s.pairs ?? []).some(p => inScope(p, sc) && (p.state === 'open' || p.state === 'broken' || p.state === 'rolling' || p.state === 'exiting' || p.state === 'placing'))
    || (s.baskets ?? []).some(b => inScope(b, sc) && (b.state === 'open' || b.state === 'exiting' || b.state === 'placing'));
}

/** A short (SELL) slice or pair of this scope that still holds, or is closing. */
function shortsPending(s: LadderState, sc: GuardScope): boolean {
  return s.slices.some(x => inScope(x, sc) && x.side === 'SELL' && (x.state === 'open' || x.state === 'exiting' || x.state === 'placing'))
    || (s.pairs ?? []).some(p => inScope(p, sc) && p.side === 'SELL' && (p.state === 'open' || p.state === 'broken' || p.state === 'rolling' || p.state === 'exiting' || p.state === 'placing'));
}

/**
 * The watcher's step for every guard: advance peaks, and for one that trips, queue the exit of every open slice / pair
 * of its scope, cancel its armed levels, and switch it off. Returns the scopes that fired (the caller also cancels the
 * resting REAL entry orders at the broker, which cannot be done inside the lock).
 */
export function applyGuards(s: LadderState, ltps: Record<string, number>, now: number): { next: LadderState; fired: (GuardScope & { reason: string })[] } {
  const guards = s.guards;
  if (!guards) return { next: s, fired: [] };
  let next = s;
  const fired: (GuardScope & { reason: string })[] = [];
  for (const [key, g] of Object.entries(guards)) {
    if (!g.on) continue;
    const sc = parseGuardKey(key);
    if (!sc) continue;
    const { mode } = sc;
    // A tripped guard keeps exiting what opens; otherwise read the rules.
    const r = g.tripped ? { guard: g, reason: g.tripped } : evalGuard(g, scopeMtm(next, sc, ltps));
    if (!r.reason) {
      if (r.guard !== g) next = { ...next, guards: { ...next.guards, [key]: r.guard } };
      continue;
    }
    // REAL: shorts exit first and a long (a hedge) only once no short of the scope is left, so a hedge can never go
    // while its short cover is still pending or rejected. SIM has no margin, so everything goes at once.
    const shortsLeft = mode === 'real' && shortsPending(next, sc);
    for (const x of next.slices) {
      if (!inScope(x, sc)) continue;
      if (x.state === 'open' && !x.exitWanted) {
        if (!shortsLeft || x.side === 'SELL') next = patchSlice(next, x.id, { exitWanted: r.reason });
      } else if (x.state === 'armed' || (x.state === 'working' && x.mode === 'sim')) next = patchSlice(next, x.id, { state: 'cancelled', note: 'Cancelled by the MTM guard' });
    }
    for (const p of next.pairs ?? []) {
      if (!inScope(p, sc) || !isPairLive(p)) continue;
      if (p.state === 'armed') next = patchPair(next, p.id, { state: 'cancelled', note: 'Cancelled by the MTM guard' });
      else if ((p.state === 'open' || p.state === 'broken' || p.state === 'rolling') && !p.exitWanted && (!shortsLeft || p.side === 'SELL')) next = patchPair(next, p.id, { exitWanted: r.reason });
    }
    for (const k of next.baskets ?? []) {
      if (!inScope(k, sc) || !isBasketLive(k)) continue;
      if (k.state === 'armed') next = patchBasket(next, k.id, { state: 'cancelled', note: 'Cancelled by the MTM guard' });
      else if (k.state === 'open' && !k.exitWanted) next = patchBasket(next, k.id, { exitWanted: r.reason });
    }
    const first = !g.tripped;
    if (first) {
      fired.push({ ...sc, reason: r.reason });
      next = pushEvent(next, ev('warn', `MTM guard (${guardLabel(sc)}): ${r.reason} — exiting everything this ladder placed`));
    }
    // Stay on until nothing of the scope is live: an exit that was rejected or is held (market closed) is re-queued by
    // the next tick, an entry in flight is exited when it opens, a long waits for its short.
    const pending = scopeLive(next, sc);
    next = { ...next, guards: { ...next.guards, [key]: pending
      ? { ...r.guard, tripped: r.reason, firedAt: g.firedAt ?? now, firedReason: undefined }
      : { ...r.guard, on: false, tripped: undefined, firedAt: g.firedAt ?? now, firedReason: r.reason } } };
  }
  return { next, fired };
}
