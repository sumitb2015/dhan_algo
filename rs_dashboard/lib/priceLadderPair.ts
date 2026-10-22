// Pure rules for the Price Ladder's Pair mode: a straddle (one strike) or strangle (CE strike above PE strike) traded on
// its COMBINED premium (CE LTP + PE LTP). A click arms an entry level on that combined price; when it crosses, both legs
// fill together, and the bracket target / SL / continuous trailing SL run on the combined number — a hit exits both legs.
// Phase 1 is SIM only: a REAL pair is refused by the API and cancelled here. No IO; lib/priceLadderServer.ts runs
// planPairs on the server watcher and lib/priceLadderPair.test.ts pins it.

import {
  bracketLevels, entryStep, istDay, istHhmm, limitZone, openExitStep, pushEvent, sessionFor, slicePnl,
  type ClickType, type LadderBracket, type LadderBroker, type LadderContract, type LadderEvent, type LadderProduct,
  type LadderSide, type LadderState, type LadderZones,
} from './priceLadder.ts';

export type PairStructure = 'straddle' | 'strangle';
export type PairState = 'armed' | 'open' | 'closed' | 'cancelled';

/** One leg: its contract and, once filled / exited, its own fill prices (per unit of premium). */
export interface PairLeg { contract: LadderContract; avg?: number; exitAvg?: number }

export interface LadderPair {
  id: string;
  broker: LadderBroker;
  mode: 'sim' | 'real';
  structure: PairStructure;
  side: LadderSide;
  lots: number;
  /** Units per leg (lots x lotSize; both legs share the underlying's lot). */
  qty: number;
  product: LadderProduct;
  state: PairState;
  legs: { ce: PairLeg; pe: PairLeg };
  createdAt: number;
  updatedAt: number;
  // entry on the combined premium
  entryLevel?: number;
  entryDir?: 'above' | 'below';
  seenSafe?: boolean;
  orderType?: ClickType;
  zones?: LadderZones;
  bracket?: LadderBracket;
  // position (combined premium terms)
  openedAt?: number;
  entryY?: number;     // the combined fill (CE avg + PE avg)
  tgtY?: number;
  slY?: number;
  slY0?: number;
  peakY?: number;
  trailFrom?: number;
  // exit
  exitWanted?: string;
  exitReason?: string;
  closedAt?: number;
  note?: string;
}

/** Strike step per underlying: a strangle's legs sit a whole number of steps either side of its centre. */
export const PAIR_STRIKE_STEP: Record<string, number> = { NIFTY: 50, BANKNIFTY: 100, SENSEX: 100, CRUDEOILM: 50 };
/** Narrowest trailing distance on a pair, in combined-premium points (index-level slices use 1 point). */
export const MIN_PAIR_TRAIL_PTS = 0.5;

/** An entry level farther than this fraction from the combined premium is refused (a mis-scrolled click). */
export const MAX_PAIR_LEVEL_DISTANCE = 0.5;

export const isPairLive = (p: LadderPair) => p.state === 'armed' || p.state === 'open';

/** +1 when the pair gains as the combined premium rises (a long pair), -1 for a short one. */
export const pairBias = (side: LadderSide): 1 | -1 => (side === 'BUY' ? 1 : -1);

/** Level within MAX_PAIR_LEVEL_DISTANCE of the combined premium. */
export function pairLevelSane(level: number, combined: number): boolean {
  return level > 0 && combined > 0 && Math.abs(level - combined) / combined <= MAX_PAIR_LEVEL_DISTANCE;
}

const round2 = (v: number) => Number(v.toFixed(2));

/** CE + PE live premium, or null when either leg has no price (the pair's levels then pause). */
export function pairCombined(p: Pick<LadderPair, 'legs'>, ltps: Record<string, number>): number | null {
  const ce = ltps[p.legs.ce.contract.securityId], pe = ltps[p.legs.pe.contract.securityId];
  return ce > 0 && pe > 0 ? round2(ce + pe) : null;
}

/** "23200 straddle" / "23300/23100 strangle". */
export function pairName(p: Pick<LadderPair, 'legs' | 'structure'>): string {
  const ce = p.legs.ce.contract.strike, pe = p.legs.pe.contract.strike;
  return p.structure === 'straddle' ? `${ce} straddle` : `${ce}CE/${pe}PE strangle`;
}

/**
 * A pair's P&L in rupees as it stands: closed at its legs' exit prices, open at live LTPs. `undefined` = nothing to count
 * (never filled); `null` = it should count but a leg has no price (a partial sum would hide that leg's loss).
 */
export function pairNowPnl(p: LadderPair, ltps: Record<string, number>): number | null | undefined {
  if (p.state !== 'open' && p.state !== 'closed') return undefined;
  if (p.state === 'closed' && !(p.legs.ce.exitAvg && p.legs.pe.exitAvg)) return undefined;
  let sum = 0;
  for (const leg of [p.legs.ce, p.legs.pe]) {
    const price = p.state === 'closed' ? leg.exitAvg : ltps[leg.contract.securityId];
    const v = slicePnl({ side: p.side, avg: leg.avg, filledQty: p.qty, contract: leg.contract }, price);
    if (v == null) return null;
    sum += v;
  }
  return sum;
}

/** Total P&L over the pairs `pick` selects; null when an open one has no price, or nothing counts. */
export function sumPairPnl(pairs: LadderPair[], pick: (p: LadderPair) => boolean, ltps: Record<string, number>): number | null {
  let sum = 0, any = false;
  for (const p of pairs) {
    if (!pick(p)) continue;
    const v = pairNowPnl(p, ltps);
    if (v === undefined) continue;
    if (v === null) return null;
    sum += v; any = true;
  }
  return any ? sum : null;
}

export function patchPair(s: LadderState, id: string, patch: Partial<LadderPair> | ((p: LadderPair) => Partial<LadderPair>), now = Date.now()): LadderState {
  return {
    ...s,
    pairs: (s.pairs ?? []).map(p => (p.id === id ? { ...p, ...(typeof patch === 'function' ? patch(p) : patch), updatedAt: now } : p)),
  };
}

const pev = (level: LadderEvent['level'], msg: string, id: string, at: number): LadderEvent => ({ at, level, msg, sliceId: id });
const round05 = (v: number) => Number((Math.round(v / 0.05) * 0.05).toFixed(2));

/**
 * Each leg's fill when an armed pair crosses its level. A limit-like entry (Sell above / Buy below the combined) fills at
 * the LEVEL, as a resting limit would and as the plain ladder's SIM does — a jump through it in one tick must not book a
 * better price than was asked. The level is split between the legs in proportion to their live prices. A breakout fills
 * at market: the legs' live prices.
 */
export function pairEntryFills(p: Pick<LadderPair, 'side' | 'entryLevel' | 'entryDir'>, ce: number, pe: number): { ce: number; pe: number } {
  const level = Number(p.entryLevel);
  const limitLike = p.entryDir === limitZone('plain', 'CE', p.side);
  if (!limitLike || !(level > 0)) return { ce, pe };
  const ceFill = round05((ce * level) / (ce + pe));
  const peFill = round2(level - ceFill);
  return ceFill > 0 && peFill > 0 ? { ce: ceFill, pe: peFill } : { ce, pe };
}

/** The IST day a pair's legs expire, passed: nothing more can be priced or exited. */
export const pairExpired = (p: Pick<LadderPair, 'legs'>, today: string) => p.legs.ce.contract.expiry < today;

/**
 * One watcher tick for every live pair (pure; every time stamp is `now`): fire armed entries on a cross of the combined
 * premium, run open brackets, the MIS square-off and manual exits — all only inside the session (before the open the safe
 * side is learned; after the close an exit waits for the next open). SIM fills and exits happen here, both legs at once;
 * with either leg unpriced nothing fires and an exit waits. A pair whose expiry has passed is closed without a price.
 */
export function planPairs(s: LadderState, ltps: Record<string, number>, now: number): LadderState {
  const pairs = s.pairs ?? [];
  if (!pairs.some(isPairLive)) return s;
  const today = istDay(now);
  const hhmm = istHhmm(now);
  let next = s;
  const patch = (id: string, x: Partial<LadderPair>) => patchPair(next, id, x, now);
  const say = (st: LadderState, level: LadderEvent['level'], msg: string, id: string) => pushEvent(st, pev(level, msg, id, now));
  for (const p of pairs) {
    if (!isPairLive(p)) continue;
    const sess = sessionFor(p.legs.ce.contract.underlying, today);
    const afterClose = hhmm >= sess.autoExit;
    const sessionOpen = hhmm >= sess.open && hhmm < sess.close;
    const at = sess.autoExitLabel;
    const name = pairName(p);
    const c = pairCombined(p, ltps);

    if (p.state === 'armed') {
      if (afterClose || pairExpired(p, today)) { next = say(patch(p.id, { state: 'cancelled', note: `Cancelled at ${at}` }), 'info', `${name}: armed level cancelled at ${at}`, p.id); continue; }
      if (p.mode === 'real') { next = say(patch(p.id, { state: 'cancelled', note: 'Pair mode is SIM only for now' }), 'warn', `${name}: REAL pairs are not supported yet — cancelled`, p.id); continue; }
      if (c == null) continue;
      const r = entryStep(p, c);
      // Before the open the safe side is learned, but nothing fires on pre-open prints.
      if (r.fire && sessionOpen) {
        const fill = pairEntryFills(p, ltps[p.legs.ce.contract.securityId], ltps[p.legs.pe.contract.securityId]);
        const entryY = round2(fill.ce + fill.pe);
        const x: Partial<LadderPair> = {
          state: 'open', seenSafe: r.seenSafe, openedAt: now, entryY,
          legs: { ce: { ...p.legs.ce, avg: fill.ce }, pe: { ...p.legs.pe, avg: fill.pe } },
        };
        if (p.bracket) {
          // Measured from where it filled, so a jump through a breakout level cannot leave the SL already hit.
          const lv = bracketLevels(pairBias(p.side), entryY, p.bracket);
          Object.assign(x, { tgtY: lv.tgtY, slY: lv.slY, slY0: lv.slY, peakY: entryY, trailFrom: entryY });
        }
        next = say(patch(p.id, x), 'info', `SIM ${p.side} ${p.lots} lot(s) ${name} filled: CE ${fill.ce.toFixed(2)} + PE ${fill.pe.toFixed(2)} = ${entryY.toFixed(2)} (level ${p.entryLevel}, combined ${c.toFixed(2)})`, p.id);
      } else if (r.seenSafe !== !!p.seenSafe) {
        next = patch(p.id, { seenSafe: r.seenSafe });
      }
      continue;
    }

    // open
    if (pairExpired(p, today)) {
      // Past its expiry nothing prices: closed with no exit price (its P&L is not counted), so it cannot sit open forever.
      next = say(patch(p.id, { state: 'closed', exitReason: 'Expired', closedAt: now, exitWanted: undefined, note: 'Expired while open — no exit price (SIM)' }),
        'warn', `${name}: expired while open — closed without an exit price`, p.id);
      continue;
    }
    // Outside the session nothing acts: off-hours and pre-open prints are not tradeable, so the bracket and trail do not
    // read them and an exit waits for the open (said once).
    if (!sessionOpen) {
      const due = p.exitWanted || (afterClose && p.product === 'MIS');
      const note = 'Market closed — exits resume at the next open';
      if (due && p.note !== note) next = say(patch(p.id, { note }), 'warn', `${name}: exit due but the market is closed — waiting for the open`, p.id);
      continue;
    }
    const step = openExitStep(p, pairBias(p.side), c, afterClose, at);
    if (step.reason && c == null) {
      // Both legs exit together at their own prices: with one unpriced, wait (said once).
      const note = 'Exit waiting for both leg prices';
      next = p.note === note ? next : say(patch(p.id, { ...step.patch, note }), 'warn', `${name}: ${step.reason} due but a leg has no live price — waiting`, p.id);
      continue;
    }
    if (step.reason) {
      const ce = ltps[p.legs.ce.contract.securityId], pe = ltps[p.legs.pe.contract.securityId];
      next = say(patch(p.id, {
        ...step.patch, state: 'closed', exitReason: step.reason, exitWanted: undefined, closedAt: now, note: undefined,
        legs: { ce: { ...p.legs.ce, exitAvg: ce }, pe: { ...p.legs.pe, exitAvg: pe } },
      }), 'info', `SIM exit ${name} (${step.reason}): CE ${ce.toFixed(2)} + PE ${pe.toFixed(2)} = ${(ce + pe).toFixed(2)}`, p.id);
    } else if (Object.keys(step.patch).length || p.note) {
      next = patch(p.id, { ...step.patch, ...(p.note ? { note: undefined } : {}) });
    }
  }
  return next;
}
