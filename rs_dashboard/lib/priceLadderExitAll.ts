import type { LadderState, LadderBroker } from './priceLadder';

// "Exit all" for the Price Ladder page: what one click would do across EVERY ladder (both panes, every broker, SIM and REAL).
// Pure and shared: the confirm dialog previews it from the ledger the page already holds, and the server rebuilds it under
// the ledger lock, so what you confirm is what runs (the signature must match, as in Scale +N).
//
// It reuses the per-ladder Exit's own mechanism: a position is only MARKED `exitWanted`, and the server watcher then sends
// the exit orders, each sized against the broker's own book with every existing guard. Nothing here sends an order.

export interface ExitAllGroup {
  broker: LadderBroker;
  mode: 'sim' | 'real';
  /** Positions that will be exited (a contract + side counts once, a pair or basket counts once). */
  positions: number;
  /** Armed levels and resting entry orders that "also cancel pending" would cancel. */
  pending: number;
}

export interface ExitAllPlan {
  /** Open slices / pairs / baskets to mark for exit. */
  sliceIds: string[];
  pairIds: string[];
  basketIds: string[];
  /** Armed levels and resting entry orders, cancelled only when the user ticks "also cancel pending". */
  cancelSliceIds: string[];
  cancelPairIds: string[];
  cancelBasketIds: string[];
  /** Positions to exit, counted the way the page's own counter does. */
  positions: number;
  /** UNKNOWN outcomes: the watcher never touches them, the user resolves each one first. */
  unknown: number;
  /** An entry order being sent right now: it may become a position after this plan was made. */
  inFlight: number;
  /** Already exiting or already marked: nothing more to do. */
  alreadyExiting: number;
  groups: ExitAllGroup[];
  /** Changes whenever anything to exit or cancel changes. */
  signature: string;
}

interface Row { id: string; state: string; broker: LadderBroker; mode: 'sim' | 'real'; exitWanted?: string }

/** FNV-1a: a short stable fingerprint of the id lists (not security, just "did anything change"). */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

export function planExitAll(st: LadderState): ExitAllPlan {
  const plan: ExitAllPlan = {
    sliceIds: [], pairIds: [], basketIds: [], cancelSliceIds: [], cancelPairIds: [], cancelBasketIds: [],
    positions: 0, unknown: 0, inFlight: 0, alreadyExiting: 0, groups: [], signature: '',
  };
  const groups = new Map<string, ExitAllGroup>();
  const group = (r: Row) => {
    const k = `${r.broker}|${r.mode}`;
    let g = groups.get(k);
    if (!g) groups.set(k, g = { broker: r.broker, mode: r.mode, positions: 0, pending: 0 });
    return g;
  };
  const held = new Set<string>(); // contract + broker + mode + side: "+1 lot" slices are one position

  const classify = (r: Row, exitStates: string[], cancelStates: string[], ids: string[], cancelIds: string[], countsAs: () => void) => {
    if (exitStates.includes(r.state)) {
      if (r.exitWanted) { plan.alreadyExiting++; return; }
      ids.push(r.id);
      countsAs();
    } else if (cancelStates.includes(r.state)) {
      cancelIds.push(r.id);
      group(r).pending++;
    } else if (r.state === 'exiting') plan.alreadyExiting++;
    else if (r.state === 'unknown') plan.unknown++;
    else if (r.state === 'placing') plan.inFlight++;
  };

  for (const x of st.slices) {
    const r = x as unknown as Row;
    classify(r, ['open'], ['armed', 'working'], plan.sliceIds, plan.cancelSliceIds, () => {
      const key = `${x.contract.securityId}|${x.broker}|${x.mode}|${x.side}`;
      if (!held.has(key)) { held.add(key); group(r).positions++; plan.positions++; }
    });
  }
  for (const p of st.pairs ?? []) {
    const r = p as unknown as Row;
    classify(r, ['open', 'broken', 'rolling'], ['armed'], plan.pairIds, plan.cancelPairIds, () => { group(r).positions++; plan.positions++; });
  }
  for (const b of st.baskets ?? []) {
    const r = b as unknown as Row;
    classify(r, ['open', 'broken'], ['armed'], plan.basketIds, plan.cancelBasketIds, () => { group(r).positions++; plan.positions++; });
  }

  plan.groups = [...groups.values()].sort((a, b) => a.broker.localeCompare(b.broker) || a.mode.localeCompare(b.mode));
  const sorted = (a: string[]) => [...a].sort().join(',');
  plan.signature = fingerprint([
    sorted(plan.sliceIds), sorted(plan.pairIds), sorted(plan.basketIds),
    sorted(plan.cancelSliceIds), sorted(plan.cancelPairIds), sorted(plan.cancelBasketIds),
  ].join('|'));
  return plan;
}
