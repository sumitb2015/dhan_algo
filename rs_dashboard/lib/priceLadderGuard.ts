import { patchSlice, pushEvent, ev, sumSlicePnl, sliceNowPnl, type LadderBroker, type LadderState } from './priceLadder.ts';
import { isPairLive, patchPair, sumPairPnl, pairNowPnl } from './priceLadderPair.ts';

// The Price Ladder's global MTM guard: one per broker + SIM/REAL mode, over every ladder position of that scope (slices
// and pairs). Target, stop, trailing and Protect Profit all read the same number — the ladder's own P&L (closed at
// their exits, open at live prices) — and when one trips, everything of that scope exits and armed levels are
// cancelled, then the guard switches itself off (re-arm it to carry on). Evaluated by the server watcher inside the
// ledger lock, so it works with every tab closed. It resets with the day (rollDay builds a fresh state).

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
  /** A rule tripped but an entry is still in flight (placing / a resting REAL order): the guard stays on, exiting whatever
   *  opens, and switches itself off only once nothing of its scope can still become a position. */
  tripped?: string;
}

export const guardKey = (broker: LadderBroker, mode: 'sim' | 'real') => `${broker}:${mode}`;

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

/** The scope's MTM: slices + pairs of this broker and mode. Null when nothing counts, or an open leg has no price. */
export function scopeMtm(s: LadderState, broker: LadderBroker, mode: 'sim' | 'real', ltps: Record<string, number>): number | null {
  const pickS = (x: { broker: LadderBroker; mode: 'sim' | 'real' }) => inScope(x, broker, mode);
  const slices = s.slices, pairs = s.pairs ?? [];
  const hasS = slices.some(x => pickS(x) && sliceNowPnl(x, ltps[x.contract.securityId]) !== undefined);
  const hasP = pairs.some(p => pickS(p) && pairNowPnl(p, ltps) !== undefined);
  if (!hasS && !hasP) return null;
  const a = hasS ? sumSlicePnl(slices, pickS, x => ltps[x.contract.securityId]) : 0;
  const b = hasP ? sumPairPnl(pairs, pickS, ltps) : 0;
  return a == null || b == null ? null : a + b;
}

const BROKERS: ReadonlySet<string> = new Set(['dhan', 'kotak', 'zerodha']);

/** An entry of this scope that may still fill: a market entry being sent, or a REAL order resting at the broker. */
function entryInFlight(s: LadderState, broker: LadderBroker, mode: 'sim' | 'real'): boolean {
  return s.slices.some(x => inScope(x, broker, mode) && (x.state === 'placing' || (x.state === 'working' && x.mode === 'real')))
    || (s.pairs ?? []).some(p => inScope(p, broker, mode) && p.state === 'placing');
}

/** Does the scope hold a position, or an order that could become one? (A guard with nothing to guard does not tick.) */
const inScope = (x: { broker: LadderBroker; mode: 'sim' | 'real' }, broker: LadderBroker, mode: 'sim' | 'real') => x.broker === broker && x.mode === mode;

/**
 * The watcher's step for every guard: advance peaks, and for one that trips, queue the exit of every open slice / pair
 * of its scope, cancel its armed levels, and switch it off. Returns the scopes that fired (the caller also cancels the
 * resting REAL entry orders at the broker, which cannot be done inside the lock).
 */
export function applyGuards(s: LadderState, ltps: Record<string, number>, now: number): { next: LadderState; fired: { broker: LadderBroker; mode: 'sim' | 'real'; reason: string }[] } {
  const guards = s.guards;
  if (!guards) return { next: s, fired: [] };
  let next = s;
  const fired: { broker: LadderBroker; mode: 'sim' | 'real'; reason: string }[] = [];
  for (const [key, g] of Object.entries(guards)) {
    if (!g.on) continue;
    const [broker, mode] = key.split(':') as [LadderBroker, 'sim' | 'real'];
    if (!BROKERS.has(broker) || (mode !== 'sim' && mode !== 'real')) continue;
    // A tripped guard keeps exiting what opens; otherwise read the rules.
    const r = g.tripped ? { guard: g, reason: g.tripped } : evalGuard(g, scopeMtm(next, broker, mode, ltps));
    if (!r.reason) {
      if (r.guard !== g) next = { ...next, guards: { ...next.guards, [key]: r.guard } };
      continue;
    }
    for (const x of next.slices) {
      if (!inScope(x, broker, mode)) continue;
      if (x.state === 'open' && !x.exitWanted) next = patchSlice(next, x.id, { exitWanted: r.reason });
      else if (x.state === 'armed' || (x.state === 'working' && x.mode === 'sim')) next = patchSlice(next, x.id, { state: 'cancelled', note: 'Cancelled by the MTM guard' });
    }
    for (const p of next.pairs ?? []) {
      if (!inScope(p, broker, mode) || !isPairLive(p)) continue;
      if (p.state === 'armed') next = patchPair(next, p.id, { state: 'cancelled', note: 'Cancelled by the MTM guard' });
      else if ((p.state === 'open' || p.state === 'broken' || p.state === 'rolling') && !p.exitWanted) next = patchPair(next, p.id, { exitWanted: r.reason });
    }
    const first = !g.tripped;
    if (first) {
      fired.push({ broker, mode, reason: r.reason });
      next = pushEvent(next, ev('warn', `MTM guard (${broker} ${mode.toUpperCase()}): ${r.reason} — exiting everything`));
    }
    // An entry still in flight can open after this write: stay on and exit it when it does.
    const pending = entryInFlight(next, broker, mode);
    next = { ...next, guards: { ...next.guards, [key]: pending
      ? { ...r.guard, tripped: r.reason, firedAt: g.firedAt ?? now, firedReason: undefined }
      : { ...r.guard, on: false, tripped: undefined, firedAt: g.firedAt ?? now, firedReason: r.reason } } };
  }
  return { next, fired };
}
