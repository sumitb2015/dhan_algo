// Pure rules for the Price Ladder (/price-ladder): one ladder that trades an option (instrument X) either on the
// INDEX's price levels (XY mode — OptionX "Price Ladder XY") or on the option's own premium (plain mode). No IO here:
// lib/priceLadderServer.ts runs these on the server watcher, components/priceLadder/* draws them, and
// lib/priceLadder.test.ts pins them. Ownership follows dhan-terminal-position-ownership: a slice's quantity is what
// THIS ladder's own order filled, never the broker's net, and the broker only ever shrinks it.

import { levelCrossStep } from './focusToolRules.ts';
import { mcxSession } from './mcxSession.ts';
import { zerodhaSnapPrice, type ZerodhaContractInfo } from './zerodhaOrderRules.ts';

export type LadderMode = 'xy' | 'plain';
export type LadderBroker = 'dhan' | 'kotak' | 'zerodha';
export type LadderSide = 'BUY' | 'SELL';
export type OptType = 'CE' | 'PE';
export type LadderProduct = 'NRML' | 'MIS';
export type ClickType = 'LIMIT' | 'SL';

/** Per-click lot cap, checked by the API before anything is stored and again by the order routes ('pl' source). */
export const MAX_LADDER_LOTS = 20;
/** The index spot must be at most this old for an XY rule to act (fire or exit); older = paused. */
export const SPOT_STALE_MS = 5_000;
/** A slice opened this recently is not shrunk from an absent broker row: the position book lags a fresh fill. */
export const FILL_GRACE_MS = 20_000;
/** An order whose status never settles within this window becomes 'unknown' (held, never resent). */
export const SETTLE_TIMEOUT_MS = 60_000;
/** A rejected automatic exit is retried no sooner than this. */
export const EXIT_RETRY_MS = 15_000;
/** XY levels farther than this fraction from spot are refused (a mistyped or mis-scrolled level). */
export const MAX_LEVEL_DISTANCE = 0.05;
/** Intraday auto-exit (CLAUDE.md: 15:17 IST across all strategies). */
export const AUTO_EXIT_HHMM = 1517;
/** NSE/BSE F&O continuous session. Before the open an armed level never fires (pre-open prints are not tradeable);
 *  after the close no order is sent at all (an exit retried every 15 s until midnight would only be rejected). */
export const SESSION_OPEN_HHMM = 915;
export const SESSION_CLOSE_HHMM = 1530;

/** MCX underlyings the ladder trades (Dhan only): CRUDEOILM options, on their own futures month's price in XY. */
export const MCX_LADDER_UNDERLYINGS = ['CRUDEOILM'];
export const isMcxUnderlying = (u: string) => MCX_LADDER_UNDERLYINGS.includes(u);

export interface LadderSession { open: number; close: number; autoExit: number; autoExitLabel: string; note?: string }
/**
 * Trading hours per underlying for one IST date (hhmm). NSE/BSE F&O: 09:15-15:30, MIS squared off at 15:17. MCX:
 * lib/mcxSession.ts — 09:00 to 23:30 (US DST) or 23:55, MIS squared off 30 min before, MCX holidays and weekends
 * closed (open === close: nothing fires, REAL orders are held).
 */
export function sessionFor(underlying: string, day: string): LadderSession {
  if (isMcxUnderlying(underlying)) return mcxSession(day);
  return { open: SESSION_OPEN_HHMM, close: SESSION_CLOSE_HHMM, autoExit: AUTO_EXIT_HHMM, autoExitLabel: '15:17' };
}

export type SliceState =
  | 'armed'      // XY: waiting for the index to cross the entry level
  | 'placing'    // marked before the order is sent; becomes working / unknown / rejected
  | 'working'    // entry order at the broker, not yet filled (plain LIMIT/SL rests here)
  | 'open'       // filled: a position this ladder owns
  | 'exiting'    // exit order sent, not yet confirmed
  | 'closed' | 'cancelled' | 'rejected'
  | 'unknown';   // an order with an unknown outcome — never retried, the user resolves it

export interface LadderContract {
  underlying: string;
  expiry: string;          // YYYY-MM-DD
  strike: number;
  opt: OptType;
  /** Dhan security id (orders on Dhan, quotes for every broker). */
  securityId: string;
  /** The broker's own trading symbol (Kotak / Zerodha orders, positions and order book); Dhan uses the security id. */
  tradingSymbol?: string;
  lotSize: number;
  exchangeSegment: string; // Dhan segment: NSE_FNO / BSE_FNO / MCX_COMM
  /**
   * Rupees per unit of qty per point of premium, when it is not 1. MCX on Dhan: qty is in LOTS (lotSize 1), and one
   * CRUDEOILM lot is 10 barrels, so P&L and premium cost multiply by 10 (MCX_LOT_MULTIPLIER).
   */
  mult?: number;
  /**
   * The XY axis when it is not the index: an MCX option month moves with ITS OWN futures month (the nearest FUTCOM
   * expiring on or after the option), so its levels are that contract's price. Absent = the index spot.
   */
  ref?: { securityId: string; segment: string; expiry: string };
}

/** The key a contract's XY reference price is stored under in a price snapshot (`spots`). */
export function spotKey(c: Pick<LadderContract, 'underlying' | 'ref'>): string {
  return c.ref ? `${c.underlying}@${c.ref.segment}:${c.ref.securityId}` : c.underlying;
}
/** The underlying a spot key belongs to (the index name, or the part before '@'). */
export function spotKeyUnderlying(k: string): string {
  return k.split('@')[0];
}
/** The segment / security id behind a spot key that names a contract, or null for an index key. */
export function parseSpotKey(k: string): { segment: string; securityId: string } | null {
  const m = /^[^@]+@([A-Z_]+):(\d+)$/.exec(k);
  return m ? { segment: m[1], securityId: m[2] } : null;
}

/** Index-point exits around an XY entry. `tgtPts` 0 = no target (a Cover order: stop-loss only). */
export interface LadderBracket { tgtPts: number; slPts: number; trailPts?: number }

export interface LadderSlice {
  id: string;
  kind: LadderMode;
  broker: LadderBroker;
  mode: 'sim' | 'real';
  contract: LadderContract;
  side: LadderSide;
  lots: number;
  qty: number;             // units = lots x lotSize
  product: LadderProduct;
  state: SliceState;
  createdAt: number;
  updatedAt: number;
  // XY entry
  entryLevel?: number;
  entryDir?: 'above' | 'below';
  seenSafe?: boolean;
  bracket?: LadderBracket;
  // plain entry (resting broker order)
  orderType?: ClickType;
  limitPrice?: number;
  triggerPrice?: number;
  /** The entry is a MARKET order (an XY fire, or a '+1 lot' add): an id that never settles in 60 s is UNKNOWN. */
  market?: boolean;
  // order tracking
  orderId?: string;
  sentAt?: number;
  // position
  filledQty?: number;
  avg?: number;
  openedAt?: number;
  entryY?: number;         // index spot (XY) when it filled
  tgtY?: number;
  slY?: number;
  slY0?: number;           // the SL trailing steps from
  trailFrom?: number;      // the index level trailing measures its move from (entry, or where the SL was last reset)
  peakY?: number;
  // exit
  exitReason?: string;
  /** A manual exit asked for by the page; the watcher sends it on its next tick. */
  exitWanted?: string;
  exitOrderId?: string;
  exitSentAt?: number;
  exitQty?: number;
  exitAvg?: number;
  exitRetryAt?: number;
  closedAt?: number;
  note?: string;
}

export interface LadderEvent { at: number; level: 'info' | 'warn' | 'error'; msg: string; sliceId?: string }

export interface LadderState {
  date: string;
  slices: LadderSlice[];
  events: LadderEvent[];
  /** IST day the LIVE · REAL MONEY arm was switched on; only today's arm lets REAL opens through. */
  liveArmedOn?: string;
}

export const emptyLadderState = (date: string): LadderState => ({ date, slices: [], events: [] });

export const TERMINAL: ReadonlySet<SliceState> = new Set(['closed', 'cancelled', 'rejected']);
export const isLive = (s: LadderSlice) => !TERMINAL.has(s.state);

/** +1 when the position gains as the index rises (CE BUY, PE SELL), -1 when it gains as it falls. */
export function bias(opt: OptType, side: LadderSide): 1 | -1 {
  return (opt === 'CE') === (side === 'BUY') ? 1 : -1;
}

/**
 * Where on the ladder a click is a LIMIT-like order (the option is cheaper to buy / dearer to sell than now), relative
 * to the ladder's reference price. XY: a CE is cheaper below spot, a PE above it — the Put ladder reads inverted, as
 * in the OptionX video. Plain: below LTP to buy, above to sell. A click on the other side is a stop (breakout) entry.
 */
export function limitZone(mode: LadderMode, opt: OptType, side: LadderSide): 'below' | 'above' {
  if (mode === 'plain') return side === 'BUY' ? 'below' : 'above';
  const cheaperBelow = opt === 'CE';
  const wantCheaper = side === 'BUY';
  return cheaperBelow === wantCheaper ? 'below' : 'above';
}

export type ClickVerdict =
  | { ok: true; kind: 'limit' | 'stop'; dir: 'above' | 'below' }
  | { ok: false; error: string };

/** What clicking `level` on the BUY or SELL column means, given the ladder's reference price `ref`. */
export function classifyClick(p: {
  mode: LadderMode; opt: OptType; side: LadderSide; level: number; ref: number; orderType: ClickType;
}): ClickVerdict {
  const { mode, opt, side, level, ref, orderType } = p;
  if (!(level > 0)) return { ok: false, error: 'Pick a price on the ladder' };
  if (!(ref > 0)) return { ok: false, error: mode === 'xy' ? 'No live index price yet' : 'No live option price yet' };
  if (level === ref) return { ok: false, error: 'That is the current price — pick a level above or below it' };
  const dir = level < ref ? 'below' : 'above';
  const zone = limitZone(mode, opt, side);
  if (dir === zone) return { ok: true, kind: 'limit', dir };
  if (orderType !== 'SL') {
    return { ok: false, error: `A ${side} ${dir} the current price is a breakout entry — switch Order Type to SL` };
  }
  return { ok: true, kind: 'stop', dir };
}

/** XY levels must sit within MAX_LEVEL_DISTANCE of spot. */
export function levelSane(level: number, spot: number): boolean {
  return level > 0 && spot > 0 && Math.abs(level - spot) / spot <= MAX_LEVEL_DISTANCE;
}

/** Lots as a whole number 1..MAX_LADDER_LOTS, else null. */
export function capLots(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LADDER_LOTS) return null;
  return n;
}

/** A bracket as given, or null when it is unusable. SL is positive index points; target is positive, or 0 for a Cover
 *  order (SL only); trail is optional. */
export function cleanBracket(raw: unknown): LadderBracket | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tgt = Number(r.tgtPts), sl = Number(r.slPts), trail = Number(r.trailPts ?? 0);
  if (!(tgt >= 0) || !(sl > 0) || !Number.isFinite(tgt) || !Number.isFinite(sl)) return null;
  if (!(trail >= 0) || !Number.isFinite(trail)) return null;
  return trail > 0 ? { tgtPts: tgt, slPts: sl, trailPts: trail } : { tgtPts: tgt, slPts: sl };
}

/** One tick of an armed XY entry: fires only on a real cross from the safe side (Focus Tool's latch, buffer 0). */
export function entryStep(s: Pick<LadderSlice, 'entryLevel' | 'entryDir' | 'seenSafe'>, spot: number): { seenSafe: boolean; fire: boolean } {
  if (!(Number(s.entryLevel) > 0) || !s.entryDir) return { seenSafe: !!s.seenSafe, fire: false };
  const r = levelCrossStep(!!s.seenSafe, { level: String(s.entryLevel), dir: s.entryDir }, spot, 0);
  return { seenSafe: r.seenSafe, fire: r.hit };
}

/** Target and SL in index terms for a bracket entered at `entryY`, on the position's side of the index. */
export function bracketLevels(b: 1 | -1, entryY: number, br: LadderBracket): { tgtY?: number; slY: number } {
  return { ...(br.tgtPts > 0 ? { tgtY: entryY + b * br.tgtPts } : {}), slY: entryY - b * br.slPts };
}

/**
 * One tick of an open XY bracket. Trailing moves the SL by `trailPts` for every full `trailPts` the index has gone in
 * the position's favour from the entry, and only ever towards profit. Returns the (possibly moved) SL, the new peak,
 * and which side was hit. A target is checked before the SL on the same tick.
 */
export function bracketStep(
  s: Pick<LadderSlice, 'entryY' | 'tgtY' | 'slY' | 'slY0' | 'peakY' | 'bracket' | 'trailFrom'>, b: 1 | -1, spot: number,
): { hit: 'target' | 'sl' | null; slY?: number; peakY?: number } {
  if (!(spot > 0) || s.entryY == null) return { hit: null, slY: s.slY, peakY: s.peakY };
  const prevPeak = s.peakY ?? s.entryY;
  const peakY = b > 0 ? Math.max(prevPeak, spot) : Math.min(prevPeak, spot);
  let slY = s.slY;
  const trail = s.bracket?.trailPts ?? 0;
  if (trail > 0 && s.slY0 != null && slY != null) {
    const fav = (peakY - (s.trailFrom ?? s.entryY)) * b;
    const steps = Math.floor(fav / trail + 1e-9);
    const trailed = s.slY0 + b * steps * trail;
    slY = b > 0 ? Math.max(slY, trailed) : Math.min(slY, trailed);
  }
  if (s.tgtY != null && (b > 0 ? spot >= s.tgtY : spot <= s.tgtY)) return { hit: 'target', slY, peakY };
  if (slY != null && (b > 0 ? spot <= slY : spot >= slY)) return { hit: 'sl', slY, peakY };
  return { hit: null, slY, peakY };
}

/** Fresh enough to act on. */
export function spotFresh(at: number | null | undefined, now: number): boolean {
  return at != null && now - at <= SPOT_STALE_MS;
}

/** Settle an order from the broker's status. `wait` = still working; `filled` carries the traded qty/avg (a cancel
 *  or rejection after a partial fill counts as filled for what filled). */
export type OrderSettle =
  | { kind: 'wait'; filledQty: number }
  | { kind: 'filled'; filledQty: number; avg: number; final: boolean }
  | { kind: 'dead'; reason: string };

export function settleOrder(st: { orderStatus: string; filledQty: number; averageTradedPrice: number; quantity: number; reason?: string }): OrderSettle {
  const status = String(st.orderStatus || '').toUpperCase();
  const filled = Math.max(0, Number(st.filledQty) || 0);
  const avg = Number(st.averageTradedPrice) || 0;
  if (status === 'TRADED') return { kind: 'filled', filledQty: filled || st.quantity, avg, final: true };
  if (status === 'REJECTED' || status === 'CANCELLED' || status === 'EXPIRED') {
    return filled > 0 ? { kind: 'filled', filledQty: filled, avg, final: true } : { kind: 'dead', reason: st.reason || status };
  }
  return { kind: 'wait', filledQty: filled };
}

/**
 * Units to send to close `own` units of a position on `side` (the side that OPENED it), clamped by what the broker
 * still shows in that direction (dhan-terminal-position-ownership Invariant 2 / Triple Straddle's brokerCapacity):
 *  - broker read failed       -> own (fail open: an exit only reduces risk);
 *  - inside the fill grace     -> own (the book lags a fresh fill: no row yet, or an earlier flat row for the strike);
 *  - no matching broker row    -> 0 (it is gone; sending could open the opposite side);
 *  - row found                 -> min(own, what is left in that direction).
 */
export function exitQtyFor(own: number, side: LadderSide, broker: { failed: true } | { net: number | null }, inGrace: boolean): number {
  if ('failed' in broker) return own;
  // Inside the grace the book may not show the fill yet — as a missing row, or as an earlier same-day row still at 0.
  if (inGrace) return own;
  if (broker.net == null) return 0;
  const capacity = side === 'BUY' ? Math.max(0, broker.net) : Math.max(0, -broker.net);
  return Math.min(own, capacity);
}

/** P&L in rupees of an open (or closed, given the exit price) slice. */
export function slicePnl(s: Pick<LadderSlice, 'side' | 'avg' | 'filledQty'> & { contract?: Pick<LadderContract, 'mult'> }, price: number | null | undefined): number | null {
  if (!(Number(s.avg) > 0) || !(Number(s.filledQty) > 0) || !(Number(price) > 0)) return null;
  const dir = s.side === 'BUY' ? 1 : -1;
  return (Number(price) - Number(s.avg)) * Number(s.filledQty) * (s.contract?.mult ?? 1) * dir;
}

/**
 * A slice's P&L as it stands: a closed one at its exit average, an open / exiting one at `ltp`. `undefined` = the slice
 * has no P&L to count (never filled, cancelled, …); `null` = it should, but there is no price for it yet.
 */
export function sliceNowPnl(s: LadderSlice, ltp: number | null | undefined): number | null | undefined {
  if (s.state === 'closed') return slicePnl(s, s.exitAvg) ?? undefined;
  if (s.state === 'open' || s.state === 'exiting') return Number(s.filledQty) > 0 ? slicePnl(s, ltp) : undefined;
  return undefined;
}

/**
 * Total P&L over the slices `pick` selects, each open one priced by `ltpOf`. Null when nothing counts, or when any open
 * slice has no price — a partial sum would hide that leg's loss behind a number that looks complete.
 */
export function sumSlicePnl(slices: LadderSlice[], pick: (s: LadderSlice) => boolean, ltpOf: (s: LadderSlice) => number | null | undefined): number | null {
  let sum = 0, any = false;
  for (const s of slices) {
    if (!pick(s)) continue;
    const p = sliceNowPnl(s, ltpOf(s));
    if (p === undefined) continue;
    if (p === null) return null;
    sum += p; any = true;
  }
  return any ? sum : null;
}

/** The ladder's own net position on a contract (BUY +, SELL -), over open/exiting slices. */
export function ownNet(slices: LadderSlice[], securityId: string): { qty: number; avg: number | null } {
  let qty = 0, cost = 0;
  for (const s of slices) {
    if (s.contract.securityId !== securityId) continue;
    if (s.state !== 'open' && s.state !== 'exiting') continue;
    const q = Number(s.filledQty) || 0;
    const signed = s.side === 'BUY' ? q : -q;
    qty += signed;
    cost += signed * (Number(s.avg) || 0);
  }
  return { qty, avg: qty !== 0 ? cost / qty : null };
}

/** Prices for `count` ladder rows centred on `center`, highest first, on a `tick` grid. */
export function ladderRows(center: number, tick: number, count: number): number[] {
  if (!(center > 0) || !(tick > 0) || count < 1) return [];
  const mid = Math.round(center / tick) * tick;
  const half = Math.floor(count / 2);
  const out: number[] = [];
  for (let i = half; i > half - count; i--) {
    const v = mid + i * tick;
    if (v > 0) out.push(Number(v.toFixed(2)));
  }
  return out;
}

/** Snap a price onto a tick grid (2-decimal result). */
export function snapToStep(v: number, step: number): number {
  if (!(step > 0)) return v;
  return Number((Math.round(v / step) * step).toFixed(2));
}

/** HHMM in IST for a timestamp. */
export function istHhmm(now: number): number {
  const s = new Date(now).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = s.split(':').map(Number);
  return h * 100 + m;
}

export function istDay(now = Date.now()): string {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/**
 * A new IST day: terminal slices are dropped and armed XY entries cancelled (a level is a one-day price). Anything
 * still live at the broker (open, exiting, working, unknown) is carried — it was never confirmed closed. The REAL
 * arm lapses with the day by construction (`liveArmedOn`).
 */
export function rollDay(s: LadderState, today: string, now: number): LadderState {
  if (s.date === today) return s;
  const slices = s.slices
    .filter(x => !TERMINAL.has(x.state))
    .map(x => {
      if (x.state === 'armed' || (x.state === 'working' && x.mode === 'sim')) return { ...x, state: 'cancelled' as const, note: 'Expired with the day', updatedAt: now };
      // A broker order from an earlier session can no longer be read by id: the user checks Positions and resolves it.
      if (x.state === 'working' || x.state === 'placing') return { ...x, state: 'unknown' as const, note: 'Order from an earlier session — check Orders/Positions', updatedAt: now };
      return x;
    })
    .filter(x => !TERMINAL.has(x.state));
  return { date: today, slices, events: [], liveArmedOn: undefined };
}

/** REAL opens need today's arm. Exits never do. */
export function realArmed(s: LadderState, today: string): boolean {
  return s.liveArmedOn === today;
}

/** Keep the event log bounded. */
export function pushEvent(s: LadderState, e: LadderEvent, max = 200): LadderState {
  const events = [...s.events, e];
  return { ...s, events: events.length > max ? events.slice(events.length - max) : events };
}

// ── the watcher's per-tick decision (pure; lib/priceLadderServer.ts does the IO) ──

/** A status poll per working order at most this often. */
export const STATUS_POLL_MS = 1500;
/** A REAL order marked for sending but with no order id after this long was interrupted mid-send: UNKNOWN. */
export const PLACING_ORPHAN_MS = 30_000;

export interface TickPrices { spots: Record<string, { spot: number; at: number }>; ltps: Record<string, number> }

export const ev = (level: LadderEvent['level'], msg: string, sliceId?: string): LadderEvent =>
  ({ at: Date.now(), level, msg, ...(sliceId ? { sliceId } : {}) });

export function patchSlice(s: LadderState, id: string, patch: Partial<LadderSlice> | ((x: LadderSlice) => Partial<LadderSlice>)): LadderState {
  return {
    ...s,
    slices: s.slices.map(x => (x.id === id ? { ...x, ...(typeof patch === 'function' ? patch(x) : patch), updatedAt: Date.now() } : x)),
  };
}

export type Job =
  | { kind: 'open'; id: string }
  | { kind: 'close'; id: string }
  | { kind: 'settle'; id: string; which: 'entry' | 'exit' }
  | { kind: 'cancel'; id: string };

/** Decide this tick's work and mark every slice that will send an order — one locked write. */
export function planTick(
  s: LadderState, prices: TickPrices, now: number,
  io: { polledAt: (id: string) => number; mayCancel: (id: string) => boolean; busy?: (id: string) => boolean },
): { next: LadderState; jobs: Job[] } {
  const jobs: Job[] = [];
  const today = istDay(now);
  const hhmm = istHhmm(now);
  let next = s;
  for (const x of s.slices) {
    if (!isLive(x)) continue;
    // Hours are the contract's own market's (NSE/BSE vs MCX).
    const sess = sessionFor(x.contract.underlying, today);
    const afterClose = hhmm >= sess.autoExit;
    const sessionOpen = hhmm >= sess.open && hhmm < sess.close;
    const at = sess.autoExitLabel;
    const sp = prices.spots[spotKey(x.contract)];
    const fresh = !!sp && spotFresh(sp.at, now);
    const spot = fresh ? sp!.spot : 0;

    if (x.state === 'armed') {
      if (afterClose) { next = pushEvent(patchSlice(next, x.id, { state: 'cancelled', note: `Cancelled at ${at}` }), ev('info', `Armed level cancelled at ${at}`, x.id)); continue; }
      if (x.mode === 'real' && !realArmed(s, today)) {
        next = pushEvent(patchSlice(next, x.id, { state: 'cancelled', note: 'LIVE · REAL MONEY is off' }), ev('warn', 'REAL level cancelled: the live arm is off', x.id));
        continue;
      }
      if (!fresh) continue;
      // Before 09:15 the level is watched (the safe side is learned) but never fired.
      const r = entryStep(x, spot);
      if (r.fire && !sessionOpen) { if (r.seenSafe !== !!x.seenSafe) next = patchSlice(next, x.id, { seenSafe: r.seenSafe }); continue; }
      if (r.fire) {
        next = pushEvent(patchSlice(next, x.id, { state: 'placing', seenSafe: r.seenSafe, sentAt: now, entryY: spot, market: true }),
          ev('info', `${x.contract.underlying} ${spot.toFixed(2)} crossed ${x.entryLevel} — ${x.side} ${x.lots} lot(s) ${x.contract.strike}${x.contract.opt}`, x.id));
        jobs.push({ kind: 'open', id: x.id });
      } else if (r.seenSafe !== !!x.seenSafe) {
        next = patchSlice(next, x.id, { seenSafe: r.seenSafe });
      }
      continue;
    }

    // Orphan = marked, no order id, and no send still running (a slow placement is not an interrupted one).
    if (x.state === 'placing' && !x.orderId && x.mode === 'real' && !io.busy?.(x.id) && now - (x.sentAt ?? now) > PLACING_ORPHAN_MS) {
      next = pushEvent(patchSlice(next, x.id, { state: 'unknown', note: 'Order send was interrupted — check Orders/Positions' }), ev('error', 'Entry send interrupted: outcome unknown', x.id));
      continue;
    }

    // A SIM slice left mid-job by a server restart: an entry goes back to armed (it needs a fresh cross), an exit back to
    // open (its rule fires again on the next tick).
    if (x.mode === 'sim' && !io.busy?.(x.id) && x.state === 'placing' && now - (x.sentAt ?? now) > PLACING_ORPHAN_MS) {
      next = pushEvent(patchSlice(next, x.id, { state: 'armed', seenSafe: false }), ev('warn', 'SIM entry was interrupted — re-armed', x.id));
      continue;
    }
    if (x.mode === 'sim' && !io.busy?.(x.id) && x.state === 'exiting' && now - (x.exitSentAt ?? now) > PLACING_ORPHAN_MS) {
      next = pushEvent(patchSlice(next, x.id, { state: 'open', exitWanted: x.exitReason === 'Manual exit' ? 'Manual exit' : undefined }), ev('warn', 'SIM exit was interrupted — retrying', x.id));
      continue;
    }

    if (x.state === 'working') {
      if (afterClose && x.mode === 'sim') {
        next = patchSlice(next, x.id, { state: 'cancelled', note: `Cancelled at ${at}` });
        continue;
      }
      // REAL after 15:17: cancel at the broker AND keep settling, so a fill that beat the cancel becomes an owned
      // position (and is squared off on the next tick) instead of a slice stuck in 'working'.
      if (afterClose && x.mode === 'real' && x.orderId && io.mayCancel(x.id)) jobs.push({ kind: 'cancel', id: x.id });
      if (x.mode === 'sim') {
        const ltp = prices.ltps[x.contract.securityId];
        const hit = ltp > 0 && (x.orderType === 'SL'
          ? (x.side === 'BUY' ? ltp >= Number(x.triggerPrice) : ltp <= Number(x.triggerPrice))
          : (x.side === 'BUY' ? ltp <= Number(x.limitPrice) : ltp >= Number(x.limitPrice)));
        if (hit) {
          const avg = x.orderType === 'SL' ? ltp : Number(x.limitPrice);
          next = pushEvent(patchSlice(next, x.id, { state: 'open', filledQty: x.qty, avg, openedAt: now }), ev('info', `SIM ${x.side} filled @ ${avg.toFixed(2)}`, x.id));
        }
        continue;
      }
      if (x.orderId && now - io.polledAt(x.id) >= STATUS_POLL_MS) jobs.push({ kind: 'settle', id: x.id, which: 'entry' });
      continue;
    }

    if (x.state === 'exiting') {
      if (x.mode === 'real' && x.exitOrderId && now - io.polledAt(x.id) >= STATUS_POLL_MS) jobs.push({ kind: 'settle', id: x.id, which: 'exit' });
      if (x.mode === 'real' && !x.exitOrderId && !io.busy?.(x.id) && now - (x.exitSentAt ?? now) > PLACING_ORPHAN_MS) {
        next = pushEvent(patchSlice(next, x.id, { state: 'unknown', note: 'Exit send was interrupted — check Positions' }), ev('error', 'Exit send interrupted: outcome unknown', x.id));
      }
      continue;
    }

    if (x.state === 'open') {
      let reason: string | null = null;
      let patch: Partial<LadderSlice> = {};
      // 15:17 squares off intraday (MIS) only: NRML was chosen to be carried, and its bracket resumes at the next open.
      if (afterClose && x.product === 'MIS') reason = `Auto square-off ${at}`;
      else if (x.exitWanted) reason = x.exitWanted;
      else if (x.kind === 'xy' && x.bracket && fresh) {
        const r = bracketStep(x, bias(x.contract.opt, x.side), spot);
        if (r.slY !== x.slY || r.peakY !== x.peakY) patch = { slY: r.slY, peakY: r.peakY };
        if (r.hit) reason = r.hit === 'target' ? `Target ${x.tgtY}` : `${x.slY0 !== r.slY ? 'Trailing SL' : 'SL'} ${r.slY}`;
      }
      if (reason && x.exitRetryAt && now < x.exitRetryAt) reason = null;
      // Outside the session a REAL exit would only be rejected (and retried every 15 s): hold it and say so once.
      if (reason && x.mode === 'real' && !sessionOpen) {
        const note = 'Market closed — exit not sent; check this position at the broker';
        if (x.note !== note) next = pushEvent(patchSlice(next, x.id, { ...patch, note }), ev('warn', `${x.contract.strike}${x.contract.opt}: ${reason} due but the market is closed — not sent`, x.id));
        continue;
      }
      if (reason) {
        next = pushEvent(patchSlice(next, x.id, { ...patch, state: 'exiting', exitReason: reason, exitSentAt: now, exitOrderId: undefined, exitWanted: undefined }),
          ev('info', `${reason}${fresh ? ` (spot ${spot.toFixed(2)})` : ''} — exiting ${x.filledQty} ${x.contract.strike}${x.contract.opt}`, x.id));
        jobs.push({ kind: 'close', id: x.id });
      } else if (Object.keys(patch).length) {
        next = patchSlice(next, x.id, patch);
      }
    }
  }
  return { next, jobs };
}


// ── Zerodha order body ──

export type LadderOrderHow = { type: 'MARKET' } | { type: 'LIMIT'; price: number } | { type: 'SL'; trigger: number };

/**
 * Kite's /orders/regular body for a ladder order (same fields as /api/scalper/zerodha/order). MARKET carries Kite's
 * automatic market protection (-1). A stop goes as SL (stop-limit), never SL-M — Kite is believed to refuse SL-M on
 * index options (unconfirmed, see the vault) — with its limit 5% beyond the trigger so it still fills in a fast move.
 * Prices snap to the contract's tick. Pure.
 */
export function zerodhaLadderParams(
  symbol: string, exchange: string, side: LadderSide, qty: number, product: LadderProduct, how: LadderOrderHow,
  contract: ZerodhaContractInfo | null,
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    tradingsymbol: symbol, exchange, transaction_type: side,
    order_type: how.type === 'MARKET' ? 'MARKET' : how.type === 'LIMIT' ? 'LIMIT' : 'SL',
    quantity: qty, product, validity: 'DAY',
  };
  if (how.type === 'LIMIT') params.price = zerodhaSnapPrice(how.price, contract);
  if (how.type === 'SL') {
    params.trigger_price = zerodhaSnapPrice(how.trigger, contract);
    params.price = zerodhaSnapPrice(side === 'BUY' ? how.trigger * 1.05 : how.trigger * 0.95, contract);
  }
  if (how.type === 'MARKET') params.market_protection = -1;
  return params;
}
