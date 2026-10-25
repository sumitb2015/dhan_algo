import { STRATEGY_CATEGORIES, nearestStrike, type StrategyTemplate } from './basketStrategies.ts';
import {
  bracketLevels, entryStep, istDay, istHhmm, openExitStep, pushEvent, sessionFor, slicePnl,
  type ClickType, type LadderBracket, type LadderBroker, type LadderEvent, type LadderProduct, type LadderSide, type LadderState, type LadderZones,
} from './priceLadder.ts';
import { blendExitAvg, fillLeg, pairBias, type PairLeg } from './priceLadderPair.ts';

// Pure rules for the Price Ladder's Basket mode: a prebuilt multi-leg strategy (iron condor, butterfly, ...) traded on its
// NET premium. Release 1 is SIM only (the server refuses REAL baskets), so the planner below fills and exits in this write;
// the record already carries the REAL states and per-leg order fields the release-2 order jobs will use.
//
// The axis is the net premium magnitude A = |sum of (leg side x ratio x price)|, always positive. `side` is the CASH direction:
// SELL = receive A (a credit), BUY = pay A (a debit). A strategy as defined is either a credit or a debit; taken in the
// matching direction its legs are as defined, in the other direction every leg is mirrored. Each leg stores the side it is
// actually traded on, so a held basket's A rises/falls like a pair's combined premium and pairBias / entryStep /
// openExitStep apply unchanged (profit BUY = A up, SELL = A down).

export type BasketState = 'armed' | 'placing' | 'open' | 'exiting' | 'closed' | 'cancelled' | 'unknown';

/** A leg of a basket: a pair-style leg (contract, fills, REAL order fields) plus the side it trades on and its lots ratio. */
export interface BasketLeg extends PairLeg {
  /** The side actually traded (already mirrored for the opposite direction). */
  side: LadderSide;
  /** Lots of this leg per basket lot (a butterfly's body is 2). */
  ratio: number;
}

export interface LadderBasket {
  id: string;
  /** Template key and display name ('iron-condor', 'Iron Condor'). */
  strategy: string;
  name: string;
  broker: LadderBroker;
  mode: 'sim' | 'real';
  /** Cash direction: SELL = receive the net premium, BUY = pay it. */
  side: LadderSide;
  lots: number;
  product: LadderProduct;
  state: BasketState;
  legs: BasketLeg[];
  createdAt: number;
  updatedAt: number;
  // entry on the net premium
  entryLevel?: number;
  entryDir?: 'above' | 'below';
  seenSafe?: boolean;
  orderType?: ClickType;
  zones?: LadderZones;
  bracket?: LadderBracket;
  /** Realised P&L (rupees) of legs rolled away or closed out of this basket. */
  bookedPnl?: number;
  sentAt?: number;
  crossY?: number;
  // position (net premium terms)
  openedAt?: number;
  entryY?: number;
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
  /** The ladder pane that placed it when two are open (absent = ladder 1). */
  pane?: 2;
}

/** A leg as the page edits it before anything is armed: the side AS DEFINED by the strategy, not yet oriented. */
export interface DraftLeg { side: LadderSide; opt: 'CE' | 'PE'; strike: number; ratio: number }

export const MAX_BASKET_LEGS = 8;
export const MAX_BASKET_RATIO = 10;

const round2 = (v: number) => Number(v.toFixed(2));
const bev = (level: LadderEvent['level'], msg: string, id: string, at: number): LadderEvent => ({ at, level, msg, sliceId: id });

export const isBasketLive = (b: LadderBasket) => b.state !== 'closed' && b.state !== 'cancelled';
/** Holds (or may hold) a position: everything live except a level still waiting to fire. */
export const basketHasPosition = (b: LadderBasket) => isBasketLive(b) && b.state !== 'armed';

/** Units one leg holds when the basket holds all of its lots. */
export const basketLegQty = (lots: number, ratio: number, lotSize: number) => lots * ratio * lotSize;

export const basketLegHeld = (l: BasketLeg): number => l.held ?? (l.entry === 'filled' ? (l.filledQty ?? 0) : 0);

/** The listed strikes of every basket the Ladder offers: single-expiry templates only (a calendar / diagonal needs two expiries). */
export interface BasketTemplateInfo { category: string; key: string; name: string; legs: StrategyTemplate['legs'] }
export function basketTemplates(): BasketTemplateInfo[] {
  const out: BasketTemplateInfo[] = [];
  for (const [category, list] of Object.entries(STRATEGY_CATEGORIES)) {
    for (const t of list) {
      if (t.dte || t.legs.some(l => l.expiryRole === 'far')) continue;
      out.push({ category, key: t.key, name: t.name, legs: t.legs });
    }
  }
  return out;
}

/** A template's legs at the current ATM: strike = the nearest LISTED strike to ATM + offset x step (the Baskets page's rule). */
export function draftFromTemplate(legs: StrategyTemplate['legs'], atm: number, step: number, listed: readonly number[]): DraftLeg[] {
  return legs.map(l => {
    const target = atm + l.offset * step;
    return { side: l.side === 'B' ? 'BUY' : 'SELL', opt: l.option, strike: (listed.length ? nearestStrike([...listed], target) : target) ?? atm, ratio: l.ratio };
  });
}

/** A draft that can be traded: 1..MAX_BASKET_LEGS legs, whole ratios, no two legs on the same strike + option + side. */
export function validateDraft(legs: readonly DraftLeg[]): string | null {
  if (!legs.length) return 'A basket needs at least one leg';
  if (legs.length > MAX_BASKET_LEGS) return `A basket has at most ${MAX_BASKET_LEGS} legs`;
  const seen = new Set<string>();
  for (const l of legs) {
    if (l.side !== 'BUY' && l.side !== 'SELL') return 'Every leg needs a side';
    if (l.opt !== 'CE' && l.opt !== 'PE') return 'Every leg needs CE or PE';
    if (!(l.strike > 0)) return 'Every leg needs a strike';
    if (!Number.isInteger(l.ratio) || l.ratio < 1 || l.ratio > MAX_BASKET_RATIO) return `Leg ratios are whole numbers 1-${MAX_BASKET_RATIO}`;
    const k = `${l.strike}${l.opt}${l.side}`;
    if (seen.has(k)) return `${l.strike}${l.opt} is in the basket twice on the same side — raise its ratio instead`;
    seen.add(k);
  }
  return null;
}

/**
 * The draft's net premium from live prices: `a` = |net| (> 0), `credit` = the strategy as defined receives money. Null when
 * a leg has no price or the strategy nets to nothing (the ladder then has no axis).
 */
export function basketAxis(legs: readonly DraftLeg[], priceOf: (l: DraftLeg) => number | undefined): { a: number; credit: boolean } | null {
  let d = 0;
  for (const l of legs) {
    const px = priceOf(l);
    if (!(px != null && px > 0)) return null;
    d += (l.side === 'BUY' ? 1 : -1) * l.ratio * px;
  }
  const a = round2(Math.abs(d));
  return a > 0 ? { a, credit: d < 0 } : null;
}

/** The side each leg trades on for a cash direction: as defined when the direction matches the strategy's credit/debit, else mirrored. */
export function orientLegs<T extends { side: LadderSide }>(legs: readonly T[], cash: LadderSide, credit: boolean): (T & { side: LadderSide })[] {
  const asDefined = (cash === 'SELL') === credit;
  return legs.map(l => ({ ...l, side: asDefined ? l.side : (l.side === 'BUY' ? 'SELL' : 'BUY') }));
}

/** The basket's live net premium A in its own cash direction, or null when a leg has no price / it nets to nothing. */
export function basketCombined(b: Pick<LadderBasket, 'legs' | 'side'>, ltps: Record<string, number>): number | null {
  let v = 0;
  for (const l of b.legs) {
    const px = ltps[l.contract.securityId];
    if (!(px > 0)) return null;
    v += (l.side === 'BUY' ? 1 : -1) * l.ratio * px;
  }
  const a = round2(b.side === 'BUY' ? v : -v);
  return a > 0 ? a : null;
}

/** "Iron Condor 22400/22500/22700/22800": the strategy and its distinct strikes. */
export function basketName(b: Pick<LadderBasket, 'name' | 'legs'>): string {
  const strikes = [...new Set(b.legs.map(l => l.contract.strike))].sort((x, y) => x - y);
  return `${b.name} ${strikes.join('/')}`;
}

/**
 * A basket's P&L in rupees: each leg's exited units at its exit average plus its held units at the live LTP, each on the
 * side that leg traded. `undefined` = nothing to count; `null` = a held leg has no price (a partial sum would hide a loss).
 */
export function basketNowPnl(b: LadderBasket, ltps: Record<string, number>): number | null | undefined {
  if (b.exitReason === 'Expired') return undefined;
  if (!b.legs.some(l => l.avg) && !b.bookedPnl) return undefined;
  let sum = b.bookedPnl ?? 0;
  for (const l of b.legs) {
    if (!l.avg) continue;
    const base = { side: l.side, avg: l.avg, contract: l.contract };
    const exited = l.exitedQty ?? 0, held = basketLegHeld(l);
    if (exited > 0) {
      const v = slicePnl({ ...base, filledQty: exited }, l.exitAvg);
      if (v == null) return null;
      sum += v;
    }
    if (held > 0) {
      const v = slicePnl({ ...base, filledQty: held }, ltps[l.contract.securityId]);
      if (v == null) return null;
      sum += v;
    }
  }
  return sum;
}

/** Total P&L over the baskets `pick` selects; null when an open one has no price, or nothing counts. */
export function sumBasketPnl(baskets: readonly LadderBasket[], pick: (b: LadderBasket) => boolean, ltps: Record<string, number>): number | null {
  let sum = 0, any = false;
  for (const b of baskets) {
    if (!pick(b)) continue;
    const v = basketNowPnl(b, ltps);
    if (v === undefined) continue;
    if (v === null) return null;
    sum += v; any = true;
  }
  return any ? sum : null;
}

export function patchBasket(s: LadderState, id: string, patch: Partial<LadderBasket> | ((b: LadderBasket) => Partial<LadderBasket>), now = Date.now()): LadderState {
  return { ...s, baskets: (s.baskets ?? []).map(b => (b.id === id ? { ...b, ...(typeof patch === 'function' ? patch(b) : patch), updatedAt: now } : b)) };
}

/** The IST day a basket's legs expire (they share one expiry), passed: nothing more can be priced. */
export const basketExpired = (b: Pick<LadderBasket, 'legs'>, today: string) => b.legs.some(l => l.contract.expiry < today);

/** The bracket levels for a basket filled at `entryY` (measured from the fill, so a gap through the level cannot leave the SL hit). */
function bracketAt(b: LadderBasket, entryY: number): Partial<LadderBasket> {
  if (!b.bracket) return {};
  const lv = bracketLevels(pairBias(b.side), entryY, b.bracket);
  return { tgtY: lv.tgtY, slY: lv.slY, slY0: lv.slY, peakY: entryY, trailFrom: entryY };
}

/**
 * One watcher tick for every live SIM basket (pure; every stamp is `now`). An armed level fires on a cross of the net premium
 * inside the session: every leg fills at its live price at once. An open basket exits on its bracket / trail, a manual exit,
 * or the MIS square-off, every leg at its live price (waiting while one has none). A basket past its expiry is closed without
 * a price. REAL baskets are not handled here (release 2).
 */
export function planBaskets(s: LadderState, ltps: Record<string, number>, now: number): { next: LadderState } {
  const baskets = s.baskets ?? [];
  if (!baskets.some(b => isBasketLive(b) && b.mode === 'sim')) return { next: s };
  const today = istDay(now);
  const hhmm = istHhmm(now);
  let next = s;
  const patch = (id: string, x: Partial<LadderBasket>) => patchBasket(next, id, x, now);
  const say = (st: LadderState, level: LadderEvent['level'], msg: string, id: string) => pushEvent(st, bev(level, msg, id, now));
  for (const b of baskets) {
    if (!isBasketLive(b) || b.mode !== 'sim') continue;
    const sess = sessionFor(b.legs[0].contract.underlying, today, s.settings?.mcxAutoExitTime, s.settings?.nseAutoExitTime);
    const afterClose = hhmm >= sess.autoExit;
    const sessionOpen = hhmm >= sess.open && hhmm < sess.close;
    const at = sess.autoExitLabel;
    const name = basketName(b);
    const c = basketCombined(b, ltps);

    if (b.state === 'armed') {
      if (afterClose || basketExpired(b, today)) { next = say(patch(b.id, { state: 'cancelled', note: `Cancelled at ${at}` }), 'info', `${name}: armed level cancelled at ${at}`, b.id); continue; }
      if (c == null) continue;
      const r = entryStep(b, c);
      if (r.fire && sessionOpen) {
        const legs = b.legs.map(l => fillLeg(l, basketLegQty(b.lots, l.ratio, l.contract.lotSize), ltps[l.contract.securityId]) as BasketLeg);
        const entryY = basketCombined({ legs, side: b.side }, Object.fromEntries(legs.map(l => [l.contract.securityId, l.avg!]))) ?? c;
        next = say(patch(b.id, { state: 'open', seenSafe: r.seenSafe, openedAt: now, entryY, legs, ...bracketAt(b, entryY) }),
          'info', `SIM ${b.side} ${b.lots} lot(s) ${name} filled at net ${entryY.toFixed(2)} (level ${b.entryLevel}, net ${c.toFixed(2)})`, b.id);
      } else if (r.seenSafe !== !!b.seenSafe) {
        next = patch(b.id, { seenSafe: r.seenSafe });
      }
      continue;
    }

    if (b.state !== 'open') continue;
    if (basketExpired(b, today)) {
      next = say(patch(b.id, { state: 'closed', exitReason: 'Expired', closedAt: now, exitWanted: undefined, note: 'Expired while open — no exit price (SIM)' }),
        'warn', `${name}: expired while open — closed without an exit price`, b.id);
      continue;
    }
    // Outside the session nothing acts: the bracket does not read off-hours prints and an exit waits for the open (said once).
    if (!sessionOpen) {
      const due = b.exitWanted || (afterClose && b.product === 'MIS');
      const note = 'Market closed — exits resume at the next open';
      if (due && b.note !== note) next = say(patch(b.id, { note }), 'warn', `${name}: exit due but the market is closed — waiting for the open`, b.id);
      continue;
    }
    const step = openExitStep(b, pairBias(b.side), c, afterClose, at);
    if (step.reason && c == null) {
      const note = 'Exit waiting for every leg price';
      next = b.note === note ? next : say(patch(b.id, { ...step.patch, note }), 'warn', `${name}: ${step.reason} due but a leg has no live price — waiting`, b.id);
      continue;
    }
    if (step.reason) {
      const legs = b.legs.map(l => ({ ...l, held: 0, exitedQty: (l.exitedQty ?? 0) + basketLegHeld(l), exitAvg: blendExitAvg(l, basketLegHeld(l), ltps[l.contract.securityId]) } as BasketLeg));
      next = say(patch(b.id, { ...step.patch, state: 'closed', exitReason: step.reason, exitWanted: undefined, closedAt: now, note: undefined, legs }),
        'info', `SIM exit ${name} (${step.reason}) at net ${c!.toFixed(2)}`, b.id);
    } else if (Object.keys(step.patch).length || b.note) {
      next = patch(b.id, { ...step.patch, ...(b.note ? { note: undefined } : {}) });
    }
  }
  return { next };
}

/**
 * Split `k` lots off an open basket as its own basket that exits at the next tick (the rest keeps its levels). A whole
 * basket (k = all its lots) just gets `exitWanted`. Only a basket whose legs all hold their full quantity can split.
 */
export function splitBasketLots(b: LadderBasket, k: number, newId: string, now: number): { parent: Partial<LadderBasket>; child: LadderBasket | null } | string {
  if (b.state !== 'open') return 'Only an open basket can shed lots';
  if (!Number.isInteger(k) || k < 1) return 'Lots to exit must be a whole number';
  if (b.legs.some(l => basketLegHeld(l) !== basketLegQty(b.lots, l.ratio, l.contract.lotSize))) return 'Its legs no longer hold their full quantity — exit it from the baskets table';
  if (k >= b.lots) return { parent: { exitWanted: 'Manual exit' }, child: null };
  const rest = b.lots - k;
  const scaled = (l: BasketLeg, lots: number): BasketLeg => { const q = basketLegQty(lots, l.ratio, l.contract.lotSize); return { ...l, held: q, filledQty: q }; };
  return {
    parent: { lots: rest, legs: b.legs.map(l => scaled(l, rest)) },
    child: { ...b, id: newId, lots: k, legs: b.legs.map(l => ({ ...scaled(l, k), exitedQty: 0, exitAvg: undefined, note: undefined })), bookedPnl: undefined, exitWanted: `Manual exit (−${k} lot${k === 1 ? '' : 's'})`, createdAt: now, updatedAt: now },
  };
}

/**
 * The 25 / 50 / 75 / Exit buttons: exit a share of the open baskets on the shown legs. 100 = every open basket exits; below
 * that `pct` of the total lots, rounded down, goes oldest first, a basket larger than what is left shedding that many lots.
 */
export function applyBasketShare(st: LadderState, ids: readonly string[], pct: number, now: number, newId: () => string): { next: LadderState; lots: number } | string {
  if (![25, 50, 75, 100].includes(pct)) return 'pct must be 25, 50, 75 or 100';
  const want = new Set(ids);
  const cands = (st.baskets ?? []).filter(b => want.has(b.id) && b.state === 'open' && !b.exitWanted).sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0));
  if (!cands.length) return 'Nothing is open to exit';
  const total = cands.reduce((a, b) => a + b.lots, 0);
  let next = st;
  if (pct === 100) {
    for (const b of cands) next = patchBasket(next, b.id, { exitWanted: 'Manual exit' }, now);
    return { next, lots: total };
  }
  let left = Math.floor((total * pct) / 100);
  if (left < 1) return `${pct}% of ${total} lot(s) is less than one lot — pick a larger share`;
  const out = left;
  for (const b of cands) {
    if (left <= 0) break;
    const take = Math.min(left, b.lots);
    const cur = (next.baskets ?? []).find(y => y.id === b.id)!;
    const sp = splitBasketLots(cur, take, newId(), now);
    if (typeof sp === 'string') return sp;
    next = patchBasket(next, b.id, sp.parent, now);
    if (sp.child) next = { ...next, baskets: [...(next.baskets ?? []), sp.child] };
    left -= take;
  }
  return { next, lots: out };
}

/** Lots this basket puts on one contract and side (ratio x lots): the 20-lot cap counts them with every slice and pair. */
export const basketLotsOn = (b: LadderBasket, securityId: string, side: LadderSide): number =>
  b.legs.filter(l => l.contract.securityId === securityId && l.side === side).reduce((a, l) => a + b.lots * l.ratio, 0);
