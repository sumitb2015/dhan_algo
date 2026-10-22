// Pure rules for the Price Ladder's Pair mode: a straddle (one strike) or strangle (CE strike above PE strike) traded on
// its COMBINED premium (CE LTP + PE LTP). A click arms an entry level on that combined price; when it crosses, both legs
// fill together, and the bracket target / SL / continuous trailing SL run on the combined number — a hit exits both legs.
// Phase 1 is SIM only: a REAL pair is refused by the API and cancelled here. No IO; lib/priceLadderServer.ts runs
// planPairs on the server watcher and lib/priceLadderPair.test.ts pins it.

import {
  bracketLevels, entryStep, istDay, istHhmm, limitZone, openExitStep, pushEvent, realArmed, sessionFor, slicePnl,
  type ClickType, type LadderBracket, type LadderBroker, type LadderContract, type LadderEvent, type LadderProduct,
  type LadderSide, type LadderState, type LadderZones,
} from './priceLadder.ts';

export type PairStructure = 'straddle' | 'strangle';
/**
 * armed → (REAL: placing →) open → (REAL: exiting →) closed. `unknown`: a leg's order outcome is unknown — nothing is
 * sent or reversed until the user resolves it. `broken`: a leg was closed outside the ladder — the bracket stops and
 * only an exit of what is left is sent (by the user, or the MIS square-off).
 */
export type PairState = 'armed' | 'placing' | 'open' | 'exiting' | 'rolling' | 'closed' | 'cancelled' | 'unknown' | 'broken';

/** One leg: its contract, its fills, and (REAL) its own entry / exit order. Prices are per unit of premium. */
export interface PairLeg {
  contract: LadderContract;
  avg?: number;
  /** Units this leg holds now (what filled, less what exited or was closed outside the ladder). */
  held?: number;
  /** Units exited so far and their average exit price (P&L of the closed part). */
  exitedQty?: number;
  exitAvg?: number;
  // REAL entry order
  orderId?: string;
  entry?: 'sent' | 'filled' | 'dead' | 'unknown';
  filledQty?: number;
  // REAL exit order: marked (exitSentAt) under the lock before it is sent, then its id, then settled
  exitSentAt?: number;
  exitOrderId?: string;
  exitQty?: number;
  exitRetryAt?: number;
  /** Which of this leg's orders has an unknown outcome. */
  unknown?: 'entry' | 'exit';
  /** Some or all of it was closed outside the ladder. */
  outside?: boolean;
  note?: string;
}

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
  /**
   * Per-leg stop: a leg that moves this % against its own fill exits BOTH legs (short: a leg rises by it — 100 = it
   * doubled; long: a leg falls by it). Absent = off. Runs alongside the combined bracket.
   */
  legSlPct?: number;
  /** A '+1 lot' added to an open pair: it opens on that pair's target / SL / trail rather than its own. */
  joinedTo?: string;
  /** REAL '+1 lot': its two entry orders are to be sent by the watcher on its next tick (marked, then sent). */
  sendWanted?: boolean;
  /**
   * A roll in progress (state `rolling`): the listed legs move to these contracts — both = a shift, one = a leg roll. The
   * old leg is closed in full before the new one opens (Inv 4); the other leg is not touched.
   */
  rollTo?: { ce?: LadderContract; pe?: LadderContract; steps: number };
  /** Realised P&L (rupees) of legs rolled away from this pair. */
  bookedPnl?: number;
  /** REAL: when the entry orders were marked for sending, and the combined at the cross. */
  sentAt?: number;
  crossY?: number;
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

/**
 * Lots the ladder holds, has on the wire or has armed on one contract / broker / mode / side — its single-option slices
 * AND every live pair with a leg on it: one 20-lot cap per contract across both. Armed levels count (the watcher fires
 * them at market without re-checking).
 */
export function lotsOnContract(st: LadderState, securityId: string, broker: LadderBroker, mode: 'sim' | 'real', side: LadderSide, exceptId?: string): number {
  const slices = st.slices
    .filter(x => x.id !== exceptId && x.contract.securityId === securityId && x.broker === broker && x.mode === mode && x.side === side
      && ['armed', 'open', 'exiting', 'placing', 'working'].includes(x.state))
    .reduce((a, x) => a + x.lots, 0);
  const pairs = (st.pairs ?? [])
    .filter(p => p.id !== exceptId && isPairLive(p) && p.broker === broker && p.mode === mode && p.side === side
      && (p.legs.ce.contract.securityId === securityId || p.legs.pe.contract.securityId === securityId
        || p.rollTo?.ce?.securityId === securityId || p.rollTo?.pe?.securityId === securityId))
    .reduce((a, p) => a + p.lots, 0);
  return slices + pairs;
}

export type PairLegKey = 'ce' | 'pe';
export const LEG_KEYS: readonly PairLegKey[] = ['ce', 'pe'];

export type PairJob = { kind: 'pairOpen'; id: string } | { kind: 'pairSettle'; id: string } | { kind: 'pairClose'; id: string };

/** Strike step per underlying: a strangle's legs sit a whole number of steps either side of its centre. */
export const PAIR_STRIKE_STEP: Record<string, number> = { NIFTY: 50, BANKNIFTY: 100, SENSEX: 100, CRUDEOILM: 50 };
/** Narrowest trailing distance on a pair, in combined-premium points (index-level slices use 1 point). */
export const MIN_PAIR_TRAIL_PTS = 0.5;

/** An entry level farther than this fraction from the combined premium is refused (a mis-scrolled click). */
export const MAX_PAIR_LEVEL_DISTANCE = 0.5;

export const isPairLive = (p: LadderPair) => p.state !== 'closed' && p.state !== 'cancelled';
/** Holds (or may hold) a position: everything live except a level still waiting to fire. */
export const pairHasPosition = (p: LadderPair) => isPairLive(p) && p.state !== 'armed';

/**
 * Units a leg holds now. A REAL leg that filled before the pair opened (placing / unknown) holds what filled — its P&L
 * must show while the other leg is in doubt. Older SIM rows have no `held`: the pair's qty while open.
 */
export const legHeld = (p: LadderPair, l: PairLeg): number =>
  l.held ?? (l.entry === 'filled' ? (l.filledQty ?? 0) : p.state === 'open' ? p.qty : 0);
/** Units a leg has exited. Older SIM rows: the pair's qty once closed at an exit price. */
const legExited = (p: LadderPair, l: PairLeg): number => l.exitedQty ?? (p.state === 'closed' && l.exitAvg ? p.qty : 0);

/** +1 when the pair gains as the combined premium rises (a long pair), -1 for a short one. */
export const pairBias = (side: LadderSide): 1 | -1 => (side === 'BUY' ? 1 : -1);

/** A leg-SL % for this side, or null: a short's leg may rise 1-1000 %, a long's fall 1-99 % (it cannot fall 100 %). */
export function cleanLegSlPct(raw: unknown, side: LadderSide): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n >= 1 && n <= (side === 'SELL' ? 1000 : 99) ? n : null;
}

/** The premium at which a leg's own stop hits (from its fill), or null without a fill / stop. */
export function legSlPrice(p: Pick<LadderPair, 'side' | 'legSlPct'>, l: PairLeg): number | null {
  if (!p.legSlPct || !(Number(l.avg) > 0)) return null;
  const f = p.side === 'SELL' ? 1 + p.legSlPct / 100 : 1 - p.legSlPct / 100;
  return round2(Number(l.avg) * f);
}

/** Why a leg's own stop exits the pair now ("Leg SL CE 1040.00"), or null. A leg with no live price is not judged. */
export function legSlReason(p: LadderPair, ltps: Record<string, number>): string | null {
  for (const k of LEG_KEYS) {
    const l = p.legs[k];
    const at = legSlPrice(p, l);
    const ltp = ltps[l.contract.securityId];
    if (at == null || !(ltp > 0) || legHeld(p, l) <= 0) continue;
    if (p.side === 'SELL' ? ltp >= at : ltp <= at) return `Leg SL ${k.toUpperCase()} ${at.toFixed(2)}`;
  }
  return null;
}

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
 * A pair's P&L in rupees as it stands: each leg's exited units at its exit average plus its held units at the live LTP.
 * `undefined` = nothing to count (never filled, or expired with no price); `null` = it should count but a held leg has no
 * price (a partial sum would hide that leg's loss).
 */
export function pairNowPnl(p: LadderPair, ltps: Record<string, number>): number | null | undefined {
  if (p.exitReason === 'Expired') return undefined;
  if (!(p.legs.ce.avg || p.legs.pe.avg) && !p.bookedPnl) return undefined;
  let sum = p.bookedPnl ?? 0;
  for (const leg of [p.legs.ce, p.legs.pe]) {
    if (!leg.avg) continue;
    const base = { side: p.side, avg: leg.avg, contract: leg.contract };
    const exited = legExited(p, leg), held = legHeld(p, leg);
    if (exited > 0) {
      const v = slicePnl({ ...base, filledQty: exited }, leg.exitAvg);
      if (v == null) return null;
      sum += v;
    }
    if (held > 0) {
      const v = slicePnl({ ...base, filledQty: held }, ltps[leg.contract.securityId]);
      if (v == null) return null;
      sum += v;
    }
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

/**
 * A leg's exit average after `qty` more units exit at `px`. With no usable price the units are booked at the leg's entry
 * average (zero P&L for that part) — an unpriced part must not blank the whole page's P&L for the rest of the day.
 */
export function blendExitAvg(l: PairLeg, qty: number, px: number | undefined): number | undefined {
  const prev = l.exitedQty ?? 0;
  const price = px && px > 0 ? px : l.avg;
  if (!(qty > 0) || !(price && price > 0)) return l.exitAvg;
  return Number((((l.exitAvg ?? 0) * prev + price * qty) / (prev + qty)).toFixed(2));
}

/** The IST day a pair's legs expire, passed: nothing more can be priced or exited. */
export const pairExpired = (p: Pick<LadderPair, 'legs'>, today: string) => p.legs.ce.contract.expiry < today;

/** A REAL order is checked against the broker at most this often. */
export const PAIR_POLL_MS = 1500;
/** A MARKET order with no final status after this long is UNKNOWN (held, never resent). */
export const PAIR_SETTLE_TIMEOUT_MS = 60_000;
/** Marked for sending but no order id and no send running after this long: the send was interrupted — UNKNOWN. */
export const PAIR_ORPHAN_MS = 30_000;
/** A rejected (or part-filled) exit order is sent again no sooner than this. */
export const PAIR_EXIT_RETRY_MS = 15_000;

/**
 * What a REAL pair's entry has come to once its two orders are sent (Inv 14: an unknown leg wins — stop, reverse
 * nothing). `open` = both legs filled in full; `unwind` = a leg died or filled short, so every filled unit is exited
 * (the user's rule: never leave one leg on its own); `wait` = an order is still working.
 */
export function pairEntryVerdict(p: Pick<LadderPair, 'legs' | 'qty'>): 'wait' | 'open' | 'unwind' | 'unknown' {
  const legs = [p.legs.ce, p.legs.pe];
  if (legs.some(l => l.entry === 'unknown')) return 'unknown';
  if (legs.some(l => l.entry == null || l.entry === 'sent')) return 'wait';
  if (legs.every(l => l.entry === 'filled' && (l.filledQty ?? 0) >= p.qty)) return 'open';
  return 'unwind';
}

/** A broker order's settled status (settleOrder's verdict), or null when it could not be read this time. */
export type LegSettle = { kind: 'wait'; filledQty: number } | { kind: 'filled'; filledQty: number; avg: number } | { kind: 'dead'; reason: string };

/** A leg's entry after a status read. Unreadable or still working past the timeout → unknown (never resent). */
export function settleLegEntry(l: PairLeg, v: LegSettle | null, sentAt: number, now: number): PairLeg {
  if (v?.kind === 'filled') return { ...l, entry: 'filled', filledQty: v.filledQty, avg: v.avg || l.avg };
  if (v?.kind === 'dead') return { ...l, entry: 'dead', filledQty: 0, note: v.reason };
  if (now - sentAt > PAIR_SETTLE_TIMEOUT_MS) return { ...l, entry: 'unknown', unknown: 'entry', note: `Order ${l.orderId} not confirmed in 60s — check Orders/Positions` };
  return l;
}

/**
 * A leg's exit after a status read. Filled: what filled leaves `held` and joins `exitedQty` at a weighted exit average;
 * anything left is sent again after PAIR_EXIT_RETRY_MS. Dead (rejected / cancelled): the leg still holds — sent again
 * after the retry wait. Unreadable or working past the timeout → unknown.
 */
export function settleLegExit(l: PairLeg, v: LegSettle | null, now: number, ltp?: number): PairLeg {
  const cleared = { exitOrderId: undefined, exitSentAt: undefined, exitQty: undefined };
  if (v?.kind === 'filled') {
    const held = l.held ?? 0;
    const done = Math.min(v.filledQty, l.exitQty ?? held, held);
    const exitAvg = blendExitAvg(l, done, v.avg || ltp);
    const left = held - done;
    return { ...l, ...cleared, held: left, exitedQty: (l.exitedQty ?? 0) + done, exitAvg, ...(left > 0 ? { exitRetryAt: now + PAIR_EXIT_RETRY_MS, note: `Exit filled ${done} — ${left} left` } : { exitRetryAt: undefined }) };
  }
  if (v?.kind === 'dead') return { ...l, ...cleared, exitRetryAt: now + PAIR_EXIT_RETRY_MS, note: `Exit ${v.reason} — retrying in 15s` };
  if (now - (l.exitSentAt ?? now) > PAIR_SETTLE_TIMEOUT_MS) return { ...l, unknown: 'exit', note: `Exit order ${l.exitOrderId} not confirmed in 60s — check Orders/Positions` };
  return l;
}

/** A leg that still holds units and has no exit order in flight, past any retry wait: ready to send its exit. */
export const legNeedsExitSend = (l: PairLeg, now: number) => (l.held ?? 0) > 0 && !l.exitSentAt && !l.exitOrderId && !l.unknown && !(l.exitRetryAt && now < l.exitRetryAt);

/** Settle work outstanding on a pair: an entry order working, or an exit order placed. */
const needsSettle = (p: LadderPair) => LEG_KEYS.some(k => {
  const l = p.legs[k];
  return (!!l.orderId && l.entry === 'sent') || !!l.exitOrderId;
});

export interface PairTickIo {
  /** When this pair's orders were last read from the broker (Infinity while a job for it is running). */
  polledAt: (id: string) => number;
  /** A job for this pair is running. */
  busy: (id: string) => boolean;
}
const NO_IO: PairTickIo = { polledAt: () => 0, busy: () => false };

/**
 * One watcher tick for every live pair (pure; every stamp is `now`). Entries fire on a cross of the combined premium
 * and exits act only inside the session (before the open the safe side is learned; after the close an exit waits for
 * the open). SIM fills and exits happen here, both legs at once. REAL pairs are marked here and their orders sent by the
 * returned jobs (lib/priceLadderServer.ts): `placing` → both entry orders, `pairEntryVerdict` → open / unwind / unknown;
 * `exiting` → each leg's exit (retried after a rejection) until both are flat. A pair past its expiry is closed without
 * a price.
 */
export function planPairs(s: LadderState, ltps: Record<string, number>, now: number, io: PairTickIo = NO_IO): { next: LadderState; jobs: PairJob[] } {
  const pairs = s.pairs ?? [];
  const jobs: PairJob[] = [];
  if (!pairs.some(isPairLive)) return { next: s, jobs };
  const today = istDay(now);
  const hhmm = istHhmm(now);
  let next = s;
  const patch = (id: string, x: Partial<LadderPair> | ((p: LadderPair) => Partial<LadderPair>)) => patchPair(next, id, x, now);
  const say = (st: LadderState, level: LadderEvent['level'], msg: string, id: string) => pushEvent(st, pev(level, msg, id, now));
  /** Start (or resume) exiting both legs: the REAL legs that hold units are marked for sending in this same write. */
  const beginExit = (p: LadderPair, reason: string, extra: Partial<LadderPair> = {}): void => {
    const legs = { ...p.legs };
    let send = false;
    for (const k of LEG_KEYS) {
      if (legNeedsExitSend(legs[k], now)) { legs[k] = { ...legs[k], exitSentAt: now, note: undefined }; send = true; }
    }
    next = say(patch(p.id, { ...extra, state: 'exiting', exitReason: reason, exitWanted: undefined, legs, note: undefined }),
      'info', `${pairName(p)}: ${reason} — exiting ${LEG_KEYS.filter(k => (legs[k].held ?? 0) > 0).map(k => `${legs[k].held} ${k.toUpperCase()}`).join(' + ') || 'nothing left'}`, p.id);
    if (send) jobs.push({ kind: 'pairClose', id: p.id });
  };
  for (const p of pairs) {
    if (!isPairLive(p)) continue;
    const sess = sessionFor(p.legs.ce.contract.underlying, today);
    const afterClose = hhmm >= sess.autoExit;
    const sessionOpen = hhmm >= sess.open && hhmm < sess.close;
    const at = sess.autoExitLabel;
    const name = pairName(p);
    const c = pairCombined(p, ltps);
    const real = p.mode === 'real';

    if (p.state === 'unknown') continue;              // the user resolves it; nothing automatic

    if (p.state === 'armed') {
      if (afterClose || pairExpired(p, today)) { next = say(patch(p.id, { state: 'cancelled', note: `Cancelled at ${at}` }), 'info', `${name}: armed level cancelled at ${at}`, p.id); continue; }
      if (real && !realArmed(s, today)) { next = say(patch(p.id, { state: 'cancelled', note: 'LIVE · REAL MONEY is off' }), 'warn', `${name}: REAL level cancelled — the live arm is off`, p.id); continue; }
      if (c == null) continue;
      const r = entryStep(p, c);
      // Before the open the safe side is learned, but nothing fires on pre-open prints.
      if (r.fire && sessionOpen && real) {
        // Marked before anything is sent: a crash or a second process can never send these two orders twice.
        next = say(patch(p.id, { state: 'placing', seenSafe: r.seenSafe, sentAt: now, crossY: c }),
          'info', `Combined ${c.toFixed(2)} crossed ${p.entryLevel} — ${p.side} ${p.lots} lot(s) ${name}: both legs at MARKET`, p.id);
        jobs.push({ kind: 'pairOpen', id: p.id });
      } else if (r.fire && sessionOpen) {
        const fill = pairEntryFills(p, ltps[p.legs.ce.contract.securityId], ltps[p.legs.pe.contract.securityId]);
        const entryY = round2(fill.ce + fill.pe);
        const x: Partial<LadderPair> = {
          state: 'open', seenSafe: r.seenSafe, openedAt: now, entryY,
          legs: {
            ce: { ...p.legs.ce, avg: fill.ce, held: p.qty, filledQty: p.qty, entry: 'filled' },
            pe: { ...p.legs.pe, avg: fill.pe, held: p.qty, filledQty: p.qty, entry: 'filled' },
          },
          ...pairBracketAt(p, entryY),
        };
        next = say(patch(p.id, x), 'info', `SIM ${p.side} ${p.lots} lot(s) ${name} filled: CE ${fill.ce.toFixed(2)} + PE ${fill.pe.toFixed(2)} = ${entryY.toFixed(2)} (level ${p.entryLevel}, combined ${c.toFixed(2)})`, p.id);
      } else if (r.seenSafe !== !!p.seenSafe) {
        next = patch(p.id, { seenSafe: r.seenSafe });
      }
      continue;
    }

    if (p.state === 'placing') {
      if (p.sendWanted) {
        // A REAL '+1 lot' written by the API: marked here (sentAt) in the same write that hands it to the order job.
        if (!sessionOpen || afterClose) {
          next = say(patch(p.id, { state: 'cancelled', sendWanted: undefined, note: 'Market closed before it was sent' }), 'warn', `${name}: +1 lot not sent — the market is closed`, p.id);
        } else {
          next = patch(p.id, { sendWanted: undefined, sentAt: now });
          jobs.push({ kind: 'pairOpen', id: p.id });
        }
        continue;
      }
      if (LEG_KEYS.some(k => p.legs[k].unknown)) {
        next = say(patch(p.id, { state: 'unknown', note: 'An entry order has an unknown outcome — check Orders/Positions, then resolve each leg' }), 'error', `${name}: entry UNKNOWN — nothing more is sent or reversed until you resolve it`, p.id);
        continue;
      }
      const sentNothing = LEG_KEYS.every(k => !p.legs[k].orderId && !p.legs[k].entry);
      if (sentNothing && !io.busy(p.id) && now - (p.sentAt ?? now) > PAIR_ORPHAN_MS) {
        next = say(patch(p.id, x => ({ state: 'unknown', note: 'Entry send was interrupted — check Orders/Positions',
          legs: { ce: { ...x.legs.ce, entry: 'unknown', unknown: 'entry' }, pe: { ...x.legs.pe, entry: 'unknown', unknown: 'entry' } } })),
        'error', `${name}: entry send interrupted — outcome UNKNOWN`, p.id);
        continue;
      }
      const v = pairEntryVerdict(p);
      if (v === 'open') {
        // The bracket is measured from the traded prices. A fill reported without an average (or resolved open with no
        // price) takes the live LTP; with neither, the pair waits — it must never open with a NaN SL / target.
        const ceAvg = p.legs.ce.avg || ltps[p.legs.ce.contract.securityId];
        const peAvg = p.legs.pe.avg || ltps[p.legs.pe.contract.securityId];
        if (!(ceAvg > 0) || !(peAvg > 0)) {
          const note = 'Both legs filled — waiting for a price to set the bracket';
          if (p.note !== note) next = say(patch(p.id, { note }), 'warn', `${name}: filled, but a leg has no fill price or live price yet — the bracket waits`, p.id);
          continue;
        }
        const ce = { ...p.legs.ce, avg: ceAvg }, pe = { ...p.legs.pe, avg: peAvg };
        const entryY = round2(ceAvg + peAvg);
        next = say(patch(p.id, {
          state: 'open', openedAt: now, note: undefined,
          legs: { ce: { ...ce, held: ce.filledQty }, pe: { ...pe, held: pe.filledQty } },
          // A '+1 lot' keeps the levels it joined (one target / SL for the whole position); a new pair gets its own.
          ...(p.joinedTo && p.slY != null ? { entryY: p.entryY ?? entryY } : { entryY, ...pairBracketAt(p, entryY) }),
        }), 'info', `${p.side} ${p.lots} lot(s) ${name} filled: CE ${ceAvg.toFixed(2)} + PE ${peAvg.toFixed(2)} = ${entryY.toFixed(2)} (crossed at ${p.crossY ?? '?'})`, p.id);
      } else if (v === 'unwind') {
        // Never one leg on its own: exit every unit that did fill. Nothing filled at all = nothing to undo.
        const legs = { ce: { ...p.legs.ce, held: p.legs.ce.filledQty ?? 0 }, pe: { ...p.legs.pe, held: p.legs.pe.filledQty ?? 0 } };
        const why = LEG_KEYS.map(k => (legs[k].entry === 'dead' ? `${k.toUpperCase()} ${legs[k].note ?? 'rejected'}` : (legs[k].filledQty ?? 0) < p.qty ? `${k.toUpperCase()} filled ${legs[k].filledQty ?? 0} of ${p.qty}` : '')).filter(Boolean).join('; ');
        if (!legs.ce.held && !legs.pe.held) {
          next = say(patch(p.id, { state: 'cancelled', legs, note: `Entry failed: ${why}` }), 'error', `${name}: entry failed (${why}) — nothing filled`, p.id);
        } else {
          next = say(patch(p.id, { legs }), 'error', `${name}: entry failed (${why}) — unwinding the filled leg`, p.id);
          // openedAt = now: the fill is seconds old and may not be in the broker's position book yet. Without the fill
          // grace the unwind would be sized to 0 and the leg booked as closed outside — leaving it naked at the broker.
          beginExit({ ...p, legs }, 'Entry failed — unwinding', { openedAt: now });
        }
      } else if (needsSettle(p) && now - io.polledAt(p.id) >= PAIR_POLL_MS) {
        jobs.push({ kind: 'pairSettle', id: p.id });
      }
      continue;
    }

    if (p.state === 'rolling') {
      const ro = p.rollTo;
      if (!ro) { next = patch(p.id, { state: 'open' }); continue; }
      const moving = LEG_KEYS.filter(k => ro[k]);
      if (LEG_KEYS.some(k => p.legs[k].unknown)) {
        next = say(patch(p.id, { state: 'unknown', note: 'A roll order has an unknown outcome — check Orders/Positions, then resolve each leg' }), 'error', `${name}: roll UNKNOWN — nothing more is sent until you resolve it`, p.id);
        continue;
      }
      if (real && needsSettle(p) && now - io.polledAt(p.id) >= PAIR_POLL_MS) jobs.push({ kind: 'pairSettle', id: p.id });
      // Phase 1: close the old leg(s) in full. Phase 2 (once flat): open the new strike(s). Phase 3: the verdict.
      const oldLegs = moving.filter(k => p.legs[k].contract.securityId !== ro[k]!.securityId);
      if (oldLegs.length) {
        const inFlight = oldLegs.some(k => p.legs[k].exitOrderId || p.legs[k].exitSentAt);
        if (oldLegs.every(k => (p.legs[k].held ?? 0) <= 0) && !inFlight) {
          // Flat: book what the old leg made, put the new contract in its place, and send its entry.
          let booked = p.bookedPnl ?? 0;
          const legs = { ...p.legs };
          for (const k of oldLegs) {
            const l = legs[k];
            booked += slicePnl({ side: p.side, avg: l.avg, filledQty: l.exitedQty ?? 0, contract: l.contract }, l.exitAvg) ?? 0;
            legs[k] = { contract: ro[k]! };
          }
          if (real) {
            if (!sessionOpen) continue;
            next = say(patch(p.id, { legs, bookedPnl: round2(booked), sentAt: now }), 'info', `${name}: old ${oldLegs.map(k => k.toUpperCase()).join(' + ')} closed — opening ${oldLegs.map(k => `${ro[k]!.strike}${k.toUpperCase()}`).join(' + ')} at MARKET`, p.id);
            jobs.push({ kind: 'pairOpen', id: p.id });
          } else {
            next = patch(p.id, { legs, bookedPnl: round2(booked) });
          }
          continue;
        }
        if (!sessionOpen) continue;
        if (real) {
          if (!io.busy(p.id) && oldLegs.some(k => legNeedsExitSend(p.legs[k], now))) {
            const legs = { ...p.legs };
            for (const k of oldLegs) if (legNeedsExitSend(legs[k], now)) legs[k] = { ...legs[k], exitSentAt: now };
            next = patch(p.id, { legs });
            jobs.push({ kind: 'pairClose', id: p.id });
          }
        } else {
          // SIM: the old leg closes at its live price (waits for one).
          if (oldLegs.some(k => !(ltps[p.legs[k].contract.securityId] > 0))) continue;
          const legs = { ...p.legs };
          for (const k of oldLegs) {
            const l = legs[k], px = ltps[l.contract.securityId], held = legHeld(p, l);
            legs[k] = { ...l, held: 0, exitedQty: (l.exitedQty ?? 0) + held, exitAvg: blendExitAvg(l, held, px) };
          }
          next = say(patch(p.id, { legs }), 'info', `SIM ${name}: rolled leg closed (${oldLegs.map(k => `${k.toUpperCase()} @ ${ltps[p.legs[k].contract.securityId].toFixed(2)}`).join(', ')})`, p.id);
        }
        continue;
      }
      // New strike(s) in place.
      if (!real) {
        const fresh = moving.filter(k => !p.legs[k].entry);
        if (fresh.length) {
          if (!sessionOpen || fresh.some(k => !(ltps[p.legs[k].contract.securityId] > 0))) continue;
          const legs = { ...p.legs };
          for (const k of fresh) legs[k] = { ...legs[k], avg: ltps[legs[k].contract.securityId], held: p.qty, filledQty: p.qty, entry: 'filled' };
          next = patch(p.id, { legs });
          continue;
        }
      }
      const sentNothing = moving.every(k => !p.legs[k].orderId && !p.legs[k].entry);
      if (real && sentNothing && !io.busy(p.id) && now - (p.sentAt ?? now) > PAIR_ORPHAN_MS) {
        next = say(patch(p.id, x => ({ state: 'unknown', note: 'Roll entry send was interrupted — check Orders/Positions',
          legs: { ...x.legs, ...Object.fromEntries(moving.map(k => [k, { ...x.legs[k], entry: 'unknown', unknown: 'entry' }])) } })),
        'error', `${name}: roll entry send interrupted — outcome UNKNOWN`, p.id);
        continue;
      }
      const v = pairEntryVerdict(p);
      if (v === 'open') {
        const ceAvg = p.legs.ce.avg || ltps[p.legs.ce.contract.securityId];
        const peAvg = p.legs.pe.avg || ltps[p.legs.pe.contract.securityId];
        if (!(ceAvg > 0) || !(peAvg > 0)) continue;
        const ce = { ...p.legs.ce, avg: ceAvg }, pe = { ...p.legs.pe, avg: peAvg };
        const entryY = round2(ceAvg + peAvg);
        const structure: PairStructure = ce.contract.strike === pe.contract.strike ? 'straddle' : 'strangle';
        next = say(patch(p.id, {
          state: 'open', rollTo: undefined, structure, entryY, note: undefined,
          legs: { ce: { ...ce, held: ce.held ?? ce.filledQty }, pe: { ...pe, held: pe.held ?? pe.filledQty } },
          // The bracket keeps its distances, measured from the new combined fill.
          ...pairBracketAt(p, entryY),
        }), 'info', `${pairName({ ...p, legs: { ce, pe }, structure })}: roll done — CE ${ceAvg.toFixed(2)} + PE ${peAvg.toFixed(2)} = ${entryY.toFixed(2)}`, p.id);
      } else if (v === 'unwind') {
        // The new leg failed: never one leg on its own — exit everything that is held.
        const legs = { ...p.legs };
        for (const k of moving) legs[k] = { ...legs[k], held: legs[k].filledQty ?? 0 };
        next = say(patch(p.id, { legs }), 'error', `${name}: roll failed (${moving.map(k => `${k.toUpperCase()} ${legs[k].entry === 'dead' ? legs[k].note ?? 'rejected' : `filled ${legs[k].filledQty ?? 0} of ${p.qty}`}`).join('; ')}) — unwinding the pair`, p.id);
        beginExit({ ...p, legs }, 'Roll failed — unwinding', { rollTo: undefined, openedAt: now });
      }
      continue;
    }

    if (p.state === 'exiting') {
      if (pairExpired(p, today)) {
        // An exit still being retried past expiry would only be rejected forever: the contract has settled at the broker.
        next = say(patch(p.id, { state: 'closed', exitReason: 'Expired', closedAt: now, note: 'Expired while exiting — settled at the broker; check Positions' }),
          'warn', `${name}: expired while its exit was still being retried — closed; check Positions`, p.id);
        continue;
      }
      if (LEG_KEYS.some(k => p.legs[k].unknown)) {
        next = say(patch(p.id, { state: 'unknown', note: 'An exit order has an unknown outcome — check Orders/Positions, then resolve each leg' }), 'error', `${name}: exit UNKNOWN — nothing more is sent until you resolve it`, p.id);
        continue;
      }
      const orphan = LEG_KEYS.find(k => p.legs[k].exitSentAt && !p.legs[k].exitOrderId && !io.busy(p.id) && now - Number(p.legs[k].exitSentAt) > PAIR_ORPHAN_MS);
      if (orphan) {
        next = say(patch(p.id, x => ({ state: 'unknown', note: 'Exit send was interrupted — check Positions', legs: { ...x.legs, [orphan]: { ...x.legs[orphan], unknown: 'exit' } } })),
          'error', `${name}: ${orphan.toUpperCase()} exit send interrupted — outcome UNKNOWN`, p.id);
        continue;
      }
      if (LEG_KEYS.every(k => (p.legs[k].held ?? 0) <= 0 && !p.legs[k].exitOrderId && !p.legs[k].exitSentAt)) {
        next = say(patch(p.id, { state: 'closed', closedAt: now, note: undefined }), 'info', `${name}: exited (${p.exitReason})`, p.id);
        continue;
      }
      if (needsSettle(p) && now - io.polledAt(p.id) >= PAIR_POLL_MS) jobs.push({ kind: 'pairSettle', id: p.id });
      // A leg whose exit was rejected (or part-filled) goes again once its wait is over — inside the session only.
      if (sessionOpen && !io.busy(p.id) && LEG_KEYS.some(k => legNeedsExitSend(p.legs[k], now))) {
        const legs = { ...p.legs };
        for (const k of LEG_KEYS) if (legNeedsExitSend(legs[k], now)) legs[k] = { ...legs[k], exitSentAt: now };
        next = patch(p.id, { legs });
        jobs.push({ kind: 'pairClose', id: p.id });
      }
      continue;
    }

    // open / broken
    if (pairExpired(p, today)) {
      // Past its expiry nothing prices: closed with no exit price (its P&L is not counted), so it cannot sit open forever.
      next = say(patch(p.id, { state: 'closed', exitReason: 'Expired', closedAt: now, exitWanted: undefined, note: real ? 'Expired while open — settled at the broker' : 'Expired while open — no exit price (SIM)' }),
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
    // A broken pair's bracket is off (its combined no longer describes what is held): only MIS / manual exits act.
    const step = openExitStep(p, pairBias(p.side), p.state === 'broken' ? null : c, afterClose, at);
    // A leg's own stop (open pairs only — a broken pair's bracket is off) exits both legs, never one alone.
    const reason = step.reason ?? (p.state === 'open' ? legSlReason(p, ltps) : null);
    if (real && reason) { beginExit(p, reason, step.patch); continue; }
    if (reason && c == null) {
      // SIM: both legs exit together at their own prices; with one unpriced, wait (said once).
      const note = 'Exit waiting for both leg prices';
      next = p.note === note ? next : say(patch(p.id, { ...step.patch, note }), 'warn', `${name}: ${reason} due but a leg has no live price — waiting`, p.id);
      continue;
    }
    if (reason) {
      const ce = ltps[p.legs.ce.contract.securityId], pe = ltps[p.legs.pe.contract.securityId];
      const shut = (l: PairLeg, px: number): PairLeg => ({ ...l, held: 0, exitedQty: (l.exitedQty ?? 0) + legHeld(p, l), exitAvg: px });
      next = say(patch(p.id, {
        ...step.patch, state: 'closed', exitReason: reason, exitWanted: undefined, closedAt: now, note: undefined,
        legs: { ce: shut(p.legs.ce, ce), pe: shut(p.legs.pe, pe) },
      }), 'info', `SIM exit ${name} (${reason}): CE ${ce.toFixed(2)} + PE ${pe.toFixed(2)} = ${(ce + pe).toFixed(2)}`, p.id);
    } else if (Object.keys(step.patch).length || (p.note && p.state === 'open')) {
      next = patch(p.id, { ...step.patch, ...(p.note && p.state === 'open' ? { note: undefined } : {}) });
    }
  }
  return { next, jobs };
}

/** The bracket levels for a pair filled at `entryY` (measured from the fill, so a gap through the level cannot leave the SL hit). */
function pairBracketAt(p: LadderPair, entryY: number): Partial<LadderPair> {
  if (!p.bracket) return {};
  const lv = bracketLevels(pairBias(p.side), entryY, p.bracket);
  return { tgtY: lv.tgtY, slY: lv.slY, slY0: lv.slY, peakY: entryY, trailFrom: entryY };
}

/**
 * Units of one broker book row (one contract, broker, product) that the ladder owns, cut down to what the broker shows
 * (down-only reconcile, Inv 2): holders are the ladder's open slices and pair legs on that row; the newest are cut first.
 * Returns how much to take from each holder id. Nothing is cut while any holder is inside its fill grace.
 */
export function cutsNewestFirst(holders: { id: string; qty: number; openedAt: number }[], capacity: number): Map<string, number> {
  const cuts = new Map<string, number>();
  let own = holders.reduce((a, h) => a + h.qty, 0);
  for (const h of [...holders].sort((a, b) => b.openedAt - a.openedAt)) {
    if (own <= capacity) break;
    const cut = Math.min(h.qty, own - capacity);
    if (cut > 0) { cuts.set(h.id, cut); own -= cut; }
  }
  return cuts;
}

/**
 * A pair leg cut by the reconcile (closed outside the ladder): it holds less (booked at `ltp` when known) and the pair is
 * BROKEN — its bracket stops and nothing is sent for the other leg (the user's rule). Both legs flat → closed.
 */
export function cutPairLeg(p: LadderPair, k: PairLegKey, cut: number, ltp: number | undefined, now: number): Partial<LadderPair> {
  const l = p.legs[k];
  const held = Math.max(0, (l.held ?? 0) - cut);
  const exitAvg = blendExitAvg(l, cut, ltp);
  const priced = ltp && ltp > 0 ? '' : ' (no live price — booked at entry)';
  const leg: PairLeg = { ...l, held, exitedQty: (l.exitedQty ?? 0) + cut, exitAvg, outside: true, note: `${cut} closed outside the ladder${priced}` };
  const legs = { ...p.legs, [k]: leg };
  const flat = LEG_KEYS.every(x => (legs[x].held ?? 0) <= 0);
  return flat
    ? { legs, state: 'closed', closedAt: now, exitReason: 'Closed outside the ladder' }
    : { legs, state: 'broken', note: `${k.toUpperCase()} closed outside the ladder — bracket stopped; exit what is left from the pair table` };
}

/**
 * The − on an open pair: one lot split off as its own pair that exits both legs at once (manual exit), the rest stays
 * open on the same levels. A one-lot pair simply exits. Only a whole pair (both legs holding its full qty) can split.
 */
export function splitOneLot(p: LadderPair, newId: string, now: number): { parent: Partial<LadderPair>; child: LadderPair | null } | string {
  if (p.state !== 'open') return 'Only an open pair can shed a lot';
  const lot = p.legs.ce.contract.lotSize;
  if (LEG_KEYS.some(k => legHeld(p, p.legs[k]) !== p.qty)) return 'Its legs no longer hold the same quantity — exit it from the pair table';
  if (p.lots <= 1) return { parent: { exitWanted: 'Manual exit (−1 lot)' }, child: null };
  const rest = p.qty - lot;
  const legRest = (l: PairLeg): PairLeg => ({ ...l, held: rest, filledQty: rest });
  const legOne = (l: PairLeg): PairLeg => ({ ...l, held: lot, filledQty: lot, exitedQty: 0, exitAvg: undefined, note: undefined });
  return {
    parent: { lots: p.lots - 1, qty: rest, legs: { ce: legRest(p.legs.ce), pe: legRest(p.legs.pe) } },
    child: { ...p, id: newId, lots: 1, qty: lot, legs: { ce: legOne(p.legs.ce), pe: legOne(p.legs.pe) }, joinedTo: p.id, exitWanted: 'Manual exit (−1 lot)', createdAt: now, updatedAt: now },
  };
}
