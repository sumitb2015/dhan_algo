import { STRATEGY_CATEGORIES, nearestStrike, type StrategyTemplate } from './basketStrategies.ts';
import {
  bracketLevels, entryStep, istDay, istHhmm, openExitStep, pushEvent, realArmed, sessionFor, slicePnl,
  type ClickType, type LadderBracket, type LadderBroker, type LadderEvent, type LadderProduct, type LadderSide, type LadderState, type LadderZones,
} from './priceLadder.ts';
import { blendExitAvg, fillLeg, legNeedsExitSend, pairBias, PAIR_ORPHAN_MS, PAIR_POLL_MS, type PairLeg } from './priceLadderPair.ts';

// Pure rules for the Price Ladder's Basket mode: a prebuilt multi-leg strategy (iron condor, butterfly, ...) traded on its
// NET premium. Release 1 is SIM only (the server refuses REAL baskets), so the planner below fills and exits in this write;
// the record already carries the REAL states and per-leg order fields the release-2 order jobs will use.
//
// The axis is the net premium magnitude A = |sum of (leg side x ratio x price)|, always positive. `side` is the CASH direction:
// SELL = receive A (a credit), BUY = pay A (a debit). A strategy as defined is either a credit or a debit; taken in the
// matching direction its legs are as defined, in the other direction every leg is mirrored. Each leg stores the side it is
// actually traded on, so a held basket's A rises/falls like a pair's combined premium and pairBias / entryStep /
// openExitStep apply unchanged (profit BUY = A up, SELL = A down).

export type BasketState = 'armed' | 'placing' | 'open' | 'broken' | 'exiting' | 'closed' | 'cancelled' | 'unknown';

/** A leg of a basket: a pair-style leg (contract, fills, REAL order fields) plus the side it trades on and its lots ratio. */
export interface BasketLeg extends PairLeg {
  /** A stable id of the leg inside its basket ('l0', 'l1', ...). */
  key: string;
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
  /** Cash direction: SELL = receive the net premium, BUY = pay it. For a synthetic future (`kind: 'syn'`) it is the direction: BUY = long. */
  side: LadderSide;
  /** 'syn' = a synthetic future (long: BUY CE + SELL PE at `synStrike`); its axis is the synthetic price, not the net premium. */
  kind?: 'syn';
  synStrike?: number;
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
  /** REAL entry: the hedges (BUY legs) go first and must fill in full before the shorts (SELL legs) are sent. */
  phase?: 'hedges' | 'shorts';
  /** REAL Buy / Sell Market: written `placing` by the API; the watcher marks it sent and starts the order job on its next tick. */
  sendWanted?: boolean;
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
export interface DraftLeg {
  side: LadderSide; opt: 'CE' | 'PE'; strike: number; ratio: number;
  /** A calendar / diagonal's far-expiry leg: resolved on the basket's far expiry instead of its (near) expiry. */
  far?: boolean;
}

/** The wire form of a draft in the page's price request: `strike:opt:S|B:ratio` plus `:F:<far expiry>` on a far leg. */
export function draftToParam(legs: readonly DraftLeg[], farExpiry: string): string {
  return legs.map(l => `${l.strike}:${l.opt}:${l.side === 'SELL' ? 'S' : 'B'}:${l.ratio}${l.far ? `:F:${farExpiry}` : ''}`).join(',');
}

/** Parses `draftToParam`; the far expiry rides on the far legs themselves (null when a far leg has none or the date is malformed). */
export function draftFromParam(param: string): { legs: DraftLeg[]; farExpiry: string | null } {
  let farExpiry: string | null = null;
  const legs = param.split(',').filter(Boolean).slice(0, 12).map((t): DraftLeg => {
    const [strike, opt, side, ratio, flag, exp] = t.split(':');
    const far = flag === 'F';
    if (far && /^\d{4}-\d{2}-\d{2}$/.test(exp ?? '')) farExpiry = exp;
    return { strike: Number(strike), opt: opt as 'CE' | 'PE', side: side === 'S' ? 'SELL' : 'BUY', ratio: Number(ratio), ...(far ? { far: true } : {}) };
  });
  return { legs, farExpiry };
}

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

/** The baskets the Ladder offers: single-expiry templates and calendars / diagonals (two expiries); not the DTE-window ones (flyagonal, low-gamma diagonal). */
export interface BasketTemplateInfo { category: string; key: string; name: string; legs: StrategyTemplate['legs'] }
export function basketTemplates(): BasketTemplateInfo[] {
  const out: BasketTemplateInfo[] = [];
  for (const [category, list] of Object.entries(STRATEGY_CATEGORIES)) {
    for (const t of list) {
      if (t.dte) continue;
      out.push({ category, key: t.key, name: t.name, legs: t.legs });
    }
  }
  return out;
}

/** A template's legs at the current ATM: strike = the nearest LISTED strike to ATM + offset x step (the Baskets page's rule). */
export function draftFromTemplate(legs: StrategyTemplate['legs'], atm: number, step: number, listed: readonly number[]): DraftLeg[] {
  return legs.map(l => {
    const target = atm + l.offset * step;
    return { side: l.side === 'B' ? 'BUY' : 'SELL', opt: l.option, strike: (listed.length ? nearestStrike([...listed], target) : target) ?? atm, ratio: l.ratio, ...(l.expiryRole === 'far' ? { far: true } : {}) };
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
    // A near and a far leg on one strike are different contracts (a calendar), so the expiry is part of the key.
    const x = l.far ? 'F' : '';
    const k = `${l.strike}${l.opt}${l.side}${x}`;
    if (seen.has(k)) return `${l.strike}${l.opt} is in the basket twice on the same side — raise its ratio instead`;
    // The same contract bought AND sold nets out: usually a template squeezed onto a short strike list, never a real leg pair.
    const opposite = `${l.strike}${l.opt}${l.side === 'BUY' ? 'SELL' : 'BUY'}${x}`;
    if (seen.has(opposite)) return `${l.strike}${l.opt} is both bought and sold — change one leg's strike`;
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

/**
 * The basket's live net premium A in its own cash direction, or null when a leg has no price / it nets to nothing.
 * A synthetic future's axis is its synthetic price `K + CE - PE` instead (the legs trade as BUY CE + SELL PE for a long, the
 * mirror for a short, so CE - PE is the same sum in both directions); that is an index level, never near zero.
 */
export function basketCombined(b: Pick<LadderBasket, 'legs' | 'side' | 'kind' | 'synStrike'>, ltps: Record<string, number>): number | null {
  let v = 0;
  for (const l of b.legs) {
    const px = ltps[l.contract.securityId];
    if (!(px > 0)) return null;
    v += (l.side === 'BUY' ? 1 : -1) * l.ratio * px;
  }
  const a = round2(b.side === 'BUY' ? v : -v);
  if (b.kind === 'syn') return b.synStrike ? round2(b.synStrike + a) : null;
  return a > 0 ? a : null;
}

/** A synthetic future's two legs at strike `k` as the draft shows them: long = BUY CE + SELL PE, short = the mirror. */
export function draftSyn(k: number, side: LadderSide): DraftLeg[] {
  const [ce, pe]: LadderSide[] = side === 'BUY' ? ['BUY', 'SELL'] : ['SELL', 'BUY'];
  return [{ side: ce, opt: 'CE', strike: k, ratio: 1 }, { side: pe, opt: 'PE', strike: k, ratio: 1 }];
}

/** The synthetic price K + CE - PE from the two live premiums, or null when either has no price. */
export function synAxis(k: number, ce: number | undefined, pe: number | undefined): number | null {
  if (!(k > 0) || !(ce != null && ce > 0) || !(pe != null && pe > 0)) return null;
  return round2(k + ce - pe);
}

/** The nearest strike on the `step` grid to the spot (the synthetic's strike), or null with no spot. */
export function synStrikeFor(spot: number, step: number): number | null {
  return spot > 0 && step > 0 ? Math.round(spot / step) * step : null;
}

/** How far the synthetic price may sit from the index before it is treated as a bad print (one stale leg shifts it by a whole move). */
export const SYN_MAX_BASIS = 0.015;
/** True when the synthetic price is within SYN_MAX_BASIS of the spot. An unknown spot passes (the leg prices are already fresh-gated). */
export const synSane = (synth: number, spot: number | undefined): boolean => !(spot != null && spot > 0) || Math.abs(synth - spot) / spot <= SYN_MAX_BASIS;

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

/** True once any leg's expiry has passed (for a calendar, the near leg): nothing more can be priced as a whole. */
/** A calendar / diagonal: the legs do not share one expiry. */
export const mixedExpiry = (b: Pick<LadderBasket, 'legs'>) => new Set(b.legs.map(l => l.contract.expiry)).size > 1;
export const basketExpired = (b: Pick<LadderBasket, 'legs'>, today: string) => b.legs.some(l => l.contract.expiry < today);

/** The bracket levels for a basket filled at `entryY` (measured from the fill, so a gap through the level cannot leave the SL hit). */
function bracketAt(b: LadderBasket, entryY: number): Partial<LadderBasket> {
  if (!b.bracket) return {};
  const lv = bracketLevels(pairBias(b.side), entryY, b.bracket);
  return { tgtY: lv.tgtY, slY: lv.slY, slY0: lv.slY, peakY: entryY, trailFrom: entryY };
}

/**
 * One watcher tick for every live basket (pure; every stamp is `now`). An armed level fires on a cross of the net premium inside
 * the session: SIM fills every leg at its live price at once; REAL is marked `placing` (hedges phase first) and the order jobs
 * send the legs. An open basket exits on its bracket / trail, a manual exit, or the MIS square-off. A basket past its expiry is
 * closed without a price.
 */
export function planBaskets(s: LadderState, ltps: Record<string, number>, now: number, io: BasketTickIo = NO_IO): { next: LadderState; jobs: BasketJob[] } {
  const baskets = s.baskets ?? [];
  const jobs: BasketJob[] = [];
  if (!baskets.some(isBasketLive)) return { next: s, jobs };
  const today = istDay(now);
  const hhmm = istHhmm(now);
  let next = s;
  const patch = (id: string, x: Partial<LadderBasket> | ((b: LadderBasket) => Partial<LadderBasket>)) => patchBasket(next, id, x, now);
  const say = (st: LadderState, level: LadderEvent['level'], msg: string, id: string) => pushEvent(st, bev(level, msg, id, now));
  /** Start (or resume) exiting: the REAL legs allowed to exit now (shorts first) are marked for sending in this same write. */
  const beginExit = (b: LadderBasket, reason: string, extra: Partial<LadderBasket> = {}): void => {
    const send = exitLegs(b, now).map(l => l.key);
    const legs = b.legs.map(l => (send.includes(l.key) ? { ...l, exitSentAt: now, note: undefined } as BasketLeg : l));
    next = say(patch(b.id, { ...extra, state: 'exiting', exitReason: reason, exitWanted: undefined, legs, note: undefined }),
      'info', `${basketName(b)}: ${reason} — exiting ${legs.filter(l => (l.held ?? 0) > 0).map(l => `${l.held} ${l.contract.strike}${l.contract.opt}`).join(' + ') || 'nothing left'}`, b.id);
    if (send.length) jobs.push({ kind: 'basketClose', id: b.id });
  };
  for (const b of baskets) {
    if (!isBasketLive(b)) continue;
    const real = b.mode === 'real';
    const sess = sessionFor(b.legs[0].contract.underlying, today, s.settings?.mcxAutoExitTime, s.settings?.nseAutoExitTime);
    const afterClose = hhmm >= sess.autoExit;
    const sessionOpen = hhmm >= sess.open && hhmm < sess.close;
    const at = sess.autoExitLabel;
    const name = basketName(b);
    let c = basketCombined(b, ltps);
    // A synthetic with one leg's print stale or wrong sits far from the index: pause its levels (entry and bracket) rather than
    // fire on it. An exit due (manual / square-off) needs only the leg prices, so it still runs.
    if (c != null && b.kind === 'syn' && !synSane(c, io.spotOf?.(b))) c = null;

    if (b.state === 'unknown') continue;                 // the user resolves it; nothing automatic

    if (b.state === 'armed') {
      if (afterClose || basketExpired(b, today)) { next = say(patch(b.id, { state: 'cancelled', note: `Cancelled at ${at}` }), 'info', `${name}: armed level cancelled at ${at}`, b.id); continue; }
      if (real && !realArmed(s, today)) { next = say(patch(b.id, { state: 'cancelled', note: 'LIVE · REAL MONEY is off' }), 'warn', `${name}: REAL level cancelled — the live arm is off`, b.id); continue; }
      if (c == null) continue;
      const r = entryStep(b, c);
      if (r.fire && sessionOpen && real) {
        // Marked before anything is sent: a crash or a second process can never send these orders twice.
        next = say(patch(b.id, { state: 'placing', phase: firstPhase(b), seenSafe: r.seenSafe, sentAt: now, crossY: c }),
          'info', `Net ${c.toFixed(2)} crossed ${b.entryLevel} — ${b.side} ${b.lots} lot(s) ${name}: ${phaseLegs(b, 'hedges').length ? 'hedges first, then the shorts' : 'every leg at MARKET'}`, b.id);
        jobs.push({ kind: 'basketOpen', id: b.id });
      } else if (r.fire && sessionOpen) {
        const legs = b.legs.map(l => fillLeg(l, basketLegQty(b.lots, l.ratio, l.contract.lotSize), ltps[l.contract.securityId]) as BasketLeg);
        const entryY = basketCombined({ ...b, legs }, Object.fromEntries(legs.map(l => [l.contract.securityId, l.avg!]))) ?? c;
        next = say(patch(b.id, { state: 'open', seenSafe: r.seenSafe, openedAt: now, entryY, legs, ...bracketAt(b, entryY) }),
          'info', `SIM ${b.side} ${b.lots} lot(s) ${name} filled at net ${entryY.toFixed(2)} (level ${b.entryLevel}, net ${c.toFixed(2)})`, b.id);
      } else if (r.seenSafe !== !!b.seenSafe) {
        next = patch(b.id, { seenSafe: r.seenSafe });
      }
      continue;
    }

    if (b.state === 'placing') {
      if (!real) continue;
      if (b.sendWanted) {
        // A REAL Buy / Sell Market written by the API: marked here (sentAt) in the same write that hands it to the order job.
        if (!sessionOpen || afterClose) {
          next = say(patch(b.id, { state: 'cancelled', sendWanted: undefined, note: 'Market closed before it was sent' }), 'warn', `${name}: market order not sent — the market is closed`, b.id);
        } else {
          next = patch(b.id, { sendWanted: undefined, sentAt: now });
          jobs.push({ kind: 'basketOpen', id: b.id });
        }
        continue;
      }
      if (b.legs.some(l => l.unknown)) {
        next = say(patch(b.id, { state: 'unknown', note: 'An entry order has an unknown outcome — check Orders/Positions, then resolve each leg' }), 'error', `${name}: entry UNKNOWN — nothing more is sent or reversed until you resolve it`, b.id);
        continue;
      }
      // The CURRENT phase's legs were marked for sending but none has an order id and no send is running: the send was
      // interrupted (e.g. the shorts after the hedges filled). Those legs are UNKNOWN; the user resolves them (the filled hedges stay).
      const phaseKeys = new Set(phaseLegs(b, b.phase ?? 'shorts').map(l => l.key));
      const sentNothing = b.legs.filter(l => phaseKeys.has(l.key)).every(l => !l.orderId && !l.entry);
      if (sentNothing && !io.busy(b.id) && now - (b.sentAt ?? now) > PAIR_ORPHAN_MS) {
        next = say(patch(b.id, x => ({ state: 'unknown', note: 'Entry send was interrupted — check Orders/Positions',
          legs: x.legs.map(l => (phaseKeys.has(l.key) ? { ...l, entry: 'unknown', unknown: 'entry' } as BasketLeg : l)) })), 'error', `${name}: entry send interrupted — outcome UNKNOWN`, b.id);
        continue;
      }
      const v = basketEntryVerdict(b);
      if (v === 'advance') {
        // Every hedge filled in full: only now are the shorts sent.
        next = say(patch(b.id, { phase: 'shorts', sentAt: now }), 'info', `${name}: hedges filled — sending the shorts`, b.id);
        jobs.push({ kind: 'basketOpen', id: b.id });
      } else if (v === 'open') {
        // The bracket is measured from the traded prices. A fill reported without an average takes the live LTP; with neither the basket waits.
        const avgs = b.legs.map(l => l.avg || ltps[l.contract.securityId]);
        if (avgs.some(a => !(a > 0))) {
          const note = 'Every leg filled — waiting for a price to set the bracket';
          if (b.note !== note) next = say(patch(b.id, { note }), 'warn', `${name}: filled, but a leg has no fill price or live price yet — the bracket waits`, b.id);
          continue;
        }
        const legs = b.legs.map((l, i) => ({ ...l, avg: avgs[i], held: l.filledQty } as BasketLeg));
        const entryY = basketCombined({ ...b, legs }, Object.fromEntries(legs.map(l => [l.contract.securityId, l.avg!]))) ?? c ?? 0;
        next = say(patch(b.id, { state: 'open', phase: undefined, openedAt: now, note: undefined, entryY, legs, ...bracketAt(b, entryY) }),
          'info', `${b.side} ${b.lots} lot(s) ${name} filled at net ${entryY.toFixed(2)} (crossed at ${b.crossY ?? '?'})`, b.id);
      } else if (v === 'unwind') {
        // Never a partial structure: exit every unit that did fill (shorts first). Nothing filled at all = nothing to undo.
        const legs = b.legs.map(l => ({ ...l, held: l.filledQty ?? 0 }) as BasketLeg);
        const why = legs.map(l => (l.entry === 'dead' ? `${l.contract.strike}${l.contract.opt} ${l.note ?? 'rejected'}` : !legFull(b, l) && l.entry !== 'sent' && l.entry != null ? `${l.contract.strike}${l.contract.opt} filled ${l.filledQty ?? 0} of ${basketLegQty(b.lots, l.ratio, l.contract.lotSize)}` : '')).filter(Boolean).join('; ') || 'a leg did not fill';
        if (legs.every(l => !(l.held ?? 0))) {
          next = say(patch(b.id, { state: 'cancelled', legs, note: `Entry failed: ${why}` }), 'error', `${name}: entry failed (${why}) — nothing filled`, b.id);
        } else {
          next = say(patch(b.id, { legs }), 'error', `${name}: entry failed (${why}) — unwinding what filled`, b.id);
          // openedAt = now: the fills are seconds old and may not be in the broker's book yet (the fill grace), so the unwind is not sized to 0.
          beginExit({ ...b, legs }, 'Entry failed — unwinding', { openedAt: now });
        }
      } else if (needsSettle(b) && now - io.polledAt(b.id) >= PAIR_POLL_MS) {
        jobs.push({ kind: 'basketSettle', id: b.id });
      }
      continue;
    }

    if (b.state === 'exiting') {
      if (!real) continue;
      if (basketExpired(b, today)) {
        next = say(patch(b.id, { state: 'closed', exitReason: 'Expired', closedAt: now, note: 'Expired while exiting — settled at the broker; check Positions' }),
          'warn', `${name}: expired while its exit was still being retried — closed; check Positions`, b.id);
        continue;
      }
      if (b.legs.some(l => l.unknown)) {
        next = say(patch(b.id, { state: 'unknown', note: 'An exit order has an unknown outcome — check Orders/Positions, then resolve each leg' }), 'error', `${name}: exit UNKNOWN — nothing more is sent until you resolve it`, b.id);
        continue;
      }
      const orphan = b.legs.find(l => l.exitSentAt && !l.exitOrderId && !io.busy(b.id) && now - Number(l.exitSentAt) > PAIR_ORPHAN_MS);
      if (orphan) {
        next = say(patch(b.id, x => ({ state: 'unknown', note: 'Exit send was interrupted — check Positions', legs: x.legs.map(l => (l.key === orphan.key ? { ...l, unknown: 'exit' } as BasketLeg : l)) })),
          'error', `${name}: ${orphan.contract.strike}${orphan.contract.opt} exit send interrupted — outcome UNKNOWN`, b.id);
        continue;
      }
      if (b.legs.every(l => (l.held ?? 0) <= 0 && !l.exitOrderId && !l.exitSentAt)) {
        next = say(patch(b.id, { state: 'closed', closedAt: now, note: undefined }), 'info', `${name}: exited (${b.exitReason})`, b.id);
        continue;
      }
      if (needsSettle(b) && now - io.polledAt(b.id) >= PAIR_POLL_MS) jobs.push({ kind: 'basketSettle', id: b.id });
      // The next leg(s) allowed to exit (shorts first; hedges once no short is held) go inside the session only.
      const send = exitLegs(b, now);
      if (sessionOpen && !io.busy(b.id) && send.length) {
        const keys = send.map(l => l.key);
        next = patch(b.id, { legs: b.legs.map(l => (keys.includes(l.key) ? { ...l, exitSentAt: now } as BasketLeg : l)) });
        jobs.push({ kind: 'basketClose', id: b.id });
      }
      continue;
    }

    // open / broken
    if (b.state !== 'open' && b.state !== 'broken') continue;
    if (basketExpired(b, today)) {
      next = say(patch(b.id, { state: 'closed', exitReason: 'Expired', closedAt: now, exitWanted: undefined, note: real ? `Expired while open — settled at the broker${mixedExpiry(b) ? '; the far leg may still be open, check Positions' : ''}` : 'Expired while open — no exit price (SIM)' }),
        'warn', `${name}: expired while open — closed without an exit price${mixedExpiry(b) ? ' (the far-expiry leg may still be open — check Positions)' : ''}`, b.id);
      continue;
    }
    // Outside the session nothing acts: the bracket does not read off-hours prints and an exit waits for the open (said once).
    if (!sessionOpen) {
      const due = b.exitWanted || (afterClose && b.product === 'MIS');
      const note = 'Market closed — exits resume at the next open';
      if (due && b.note !== note) next = say(patch(b.id, { note }), 'warn', `${name}: exit due but the market is closed — waiting for the open`, b.id);
      continue;
    }
    // A broken basket's bracket is off (its net no longer describes what is held): only MIS / manual exits act.
    // The bracket reads the net premium; a manual / MIS exit needs only every leg's price (a net that has fallen to nothing
    // must not strand the exit). So the net is passed only while it is a usable price.
    const step = openExitStep(b, pairBias(b.side), b.state === 'broken' ? null : c, afterClose, at);
    if (real && step.reason) { beginExit(b, step.reason, step.patch); continue; }
    const allPriced = b.legs.every(l => ltps[l.contract.securityId] > 0);
    if (step.reason && !allPriced) {
      const note = 'Exit waiting for every leg price';
      next = b.note === note ? next : say(patch(b.id, { ...step.patch, note }), 'warn', `${name}: ${step.reason} due but a leg has no live price — waiting`, b.id);
      continue;
    }
    if (step.reason) {
      const legs = b.legs.map(l => ({ ...l, held: 0, exitedQty: (l.exitedQty ?? 0) + basketLegHeld(l), exitAvg: blendExitAvg(l, basketLegHeld(l), ltps[l.contract.securityId]) } as BasketLeg));
      next = say(patch(b.id, { ...step.patch, state: 'closed', exitReason: step.reason, exitWanted: undefined, closedAt: now, note: undefined, legs }),
        'info', `SIM exit ${name} (${step.reason})${c != null ? ` at net ${c.toFixed(2)}` : ''}`, b.id);
    } else if (Object.keys(step.patch).length || (b.note && b.state === 'open')) {
      next = patch(b.id, { ...step.patch, ...(b.note && b.state === 'open' ? { note: undefined } : {}) });
    }
  }
  return { next, jobs };
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
  // A broken basket (a leg closed outside the ladder) can only exit whole: its legs no longer hold their full quantities.
  const cands = (st.baskets ?? []).filter(b => want.has(b.id) && (b.state === 'open' || (pct === 100 && b.state === 'broken')) && !b.exitWanted).sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0));
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

// ── REAL placement (release 2) ───────────────────────────────────────────────────────────────────────────────────
// Hedges first, shorts second (dhan-terminal-position-ownership Inv 9): the BUY legs go together and must all fill in full
// before any SELL leg is sent, so a naked short never exists. If a hedge fails nothing is short and the filled hedges are
// simply sold again; if a short then fails or part-fills, every filled leg is unwound — shorts covered first, then the hedges.
// An unknown outcome stops everything and reverses nothing (Inv 14). Exits are the mirror: cover the shorts, and only once
// none is held (or in flight) sell the hedges.

export type BasketJob = { kind: 'basketOpen' | 'basketSettle' | 'basketClose'; id: string };
export interface BasketTickIo {
  /** When this basket's orders were last read from the broker (Infinity while a job for it runs). */
  polledAt: (id: string) => number;
  /** A job for this basket is running. */
  busy: (id: string) => boolean;
  /** The fresh index spot of a synthetic basket's underlying (for the basis bound), or undefined when it has none. */
  spotOf?: (b: LadderBasket) => number | undefined;
}
const NO_IO: BasketTickIo = { polledAt: () => 0, busy: () => false };

/** The tighter cap on a REAL basket's lots for this first REAL release (the per-contract 20-lot cap still applies). */
export const MAX_REAL_BASKET_LOTS = 5;
/** A REAL synthetic future is capped lower still until it has run live (2026-10-27). */
export const MAX_REAL_SYN_LOTS = 2;

/** The legs the phase sends: hedges (BUY) first; shorts (SELL) once the hedges are filled. */
export const phaseLegs = (b: Pick<LadderBasket, 'legs'>, phase: 'hedges' | 'shorts'): BasketLeg[] => b.legs.filter(l => (phase === 'hedges' ? l.side === 'BUY' : l.side === 'SELL'));

/** The first phase that has legs: a basket of only SELL legs (a short strangle) starts at the shorts. */
export const firstPhase = (b: Pick<LadderBasket, 'legs'>): 'hedges' | 'shorts' => (phaseLegs(b, 'hedges').length ? 'hedges' : 'shorts');

const legFull = (b: Pick<LadderBasket, 'lots'>, l: BasketLeg) => (l.filledQty ?? 0) >= basketLegQty(b.lots, l.ratio, l.contract.lotSize);

/**
 * What a REAL basket's entry has come to. `advance` = the hedges are all filled in full: send the shorts. `open` = every leg
 * filled in full. `unwind` = a leg died or part-filled (every filled unit is exited, shorts first). `wait` = an order is
 * still working or not yet sent. `unknown` wins over everything (stop, reverse nothing).
 */
export function basketEntryVerdict(b: Pick<LadderBasket, 'legs' | 'lots' | 'phase'>): 'wait' | 'advance' | 'open' | 'unwind' | 'unknown' {
  if (b.legs.some(l => l.entry === 'unknown')) return 'unknown';
  const phase = b.phase ?? 'shorts';
  const considered = phase === 'hedges' ? phaseLegs(b, 'hedges') : b.legs;
  if (considered.some(l => l.entry == null || l.entry === 'sent')) return 'wait';
  if (considered.every(l => l.entry === 'filled' && legFull(b, l))) return phase === 'hedges' ? 'advance' : 'open';
  return 'unwind';
}

/**
 * The legs whose exit may be sent now. Shorts are covered first; hedges only once no short is held or has an exit in flight
 * (a hedge must never go while its short cover is still pending or was rejected).
 */
export function exitLegs(b: Pick<LadderBasket, 'legs'>, now: number): BasketLeg[] {
  const shortsActive = b.legs.some(l => l.side === 'SELL' && ((l.held ?? 0) > 0 || !!l.exitOrderId || !!l.exitSentAt));
  const pool = shortsActive ? b.legs.filter(l => l.side === 'SELL') : b.legs.filter(l => l.side === 'BUY');
  return pool.filter(l => legNeedsExitSend(l, now));
}

/** Settle work outstanding: an entry order working, or an exit order placed. */
const needsSettle = (b: LadderBasket) => b.legs.some(l => (!!l.orderId && l.entry === 'sent') || !!l.exitOrderId);

/**
 * A basket leg cut by the reconcile (closed outside the ladder): it holds less (booked at `ltp` when known) and the basket is
 * BROKEN — its bracket stops and nothing is sent for the other legs. Every leg flat → closed.
 */
export function cutBasketLeg(b: LadderBasket, key: string, cut: number, ltp: number | undefined, now: number): Partial<LadderBasket> {
  const l = b.legs.find(x => x.key === key)!;
  const held = Math.max(0, (l.held ?? 0) - cut);
  const exitAvg = blendExitAvg(l, cut, ltp);
  const priced = ltp && ltp > 0 ? '' : ' (no live price — booked at entry)';
  const legs = b.legs.map(x => (x.key === key ? { ...x, held, exitedQty: (x.exitedQty ?? 0) + cut, exitAvg, outside: true, note: `${cut} closed outside the ladder${priced}` } as BasketLeg : x));
  return legs.every(x => (x.held ?? 0) <= 0)
    ? { legs, state: 'closed', closedAt: now, exitReason: 'Closed outside the ladder' }
    : { legs, state: 'broken', note: `${l.contract.strike}${l.contract.opt} closed outside the ladder — bracket stopped; exit what is left from the baskets table` };
}

/** Every basket leg that still holds units has the same share of its full quantity (so a share of the lots can be split off). */
export const basketIntact = (b: LadderBasket) => b.legs.every(l => basketLegHeld(l) === basketLegQty(b.lots, l.ratio, l.contract.lotSize));

/** Does a basket have a SELL leg (it is short something)? Hedge-only baskets (a long straddle) wait for a scope's shorts to cover. */
export const basketHasShort = (b: Pick<LadderBasket, 'legs'>) => b.legs.some(l => l.side === 'SELL');

export { needsSettle as basketNeedsSettle, PAIR_POLL_MS as BASKET_POLL_MS, PAIR_ORPHAN_MS as BASKET_ORPHAN_MS };
