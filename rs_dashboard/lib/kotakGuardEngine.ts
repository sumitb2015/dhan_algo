// The decision half of the server-resident Kotak guards. Kotak has no broker-side P&L exit or bracket (Dhan's pnlExit and
// Super Order), so the dashboard SERVER watches them: this file is the pure step function (state + positions in, new
// state + exit orders out); lib/kotakGuardServer.ts owns the file, the timers and the orders.
//
// Single executor by design. The tab only registers a guard and reads its status; it never fires one, so closing it cannot
// leave a guard unwatched and two executors cannot both close the same leg. A guard is removed from the state BEFORE its
// exit is sent (at most once); an exit that has not taken the position down ~10 s later is reported as `incomplete`, not
// silently retried (a retry on a book that lags a fill would flip the position).

import {
  guardProductOf, evaluateSoftPnlGuard, matchPendingBracket,
  type GuardProduct, type PendingSoftBracket, type SoftPnlGuard,
} from './softGuards.ts';

export interface ServerBracket extends PendingSoftBracket {
  id: string;
  state: 'pending' | 'armed';
  /** Best price seen since arming (min for a short, max for a long); 0 = none yet. Drives the 1:1 trail. */
  best: number;
  /** Entry average of the position when it armed. */
  entry: number;
}

export type GuardEventKind = 'armed' | 'fired' | 'pnl_fired' | 'locked' | 'dropped' | 'expired' | 'incomplete' | 'error';
export interface GuardEvent { at: number; kind: GuardEventKind; text: string }

export interface ExitWatch { symbol: string; product: GuardProduct; dir: 1 | -1; at: number }

/** Set when the P&L loss limit fires: for the rest of the IST day every NEW in-scope position is squared off on sight and
 *  dashboard orders that add exposure are refused (lib/kotakDayLock.ts). The day roll clears it. */
export interface GuardLock { at: number; reason: string; products: string[] }

/** Whether the watcher can actually protect right now (written each tick; the banner shows it). */
export interface GuardHealth { watching: boolean; reason: string; at: number }

export interface ServerGuardState {
  /** IST day the state belongs to; a new day starts empty (a guard never outlives its session). */
  date: string;
  pnl: SoftPnlGuard | null;
  brackets: ServerBracket[];
  watch: ExitWatch[];
  events: GuardEvent[];
  /** Day lock set by a fired loss limit; null/absent = unlocked. */
  lock?: GuardLock | null;
  /** `symbol|product` -> when a lock flatten was sent. A leg listed here is NEVER re-sent on its own (a lagging book would make a
   *  second market order flip the position); the only way back out is `lockRetry`, set when the broker explicitly refused. */
  lockSent?: Record<string, number>;
  /** `symbol|product` -> earliest time a REFUSED (nothing placed) lock flatten may be sent again. */
  lockRetry?: Record<string, number>;
  /** IST day the daily default guard was auto-armed, so a manual clear is not re-armed the same day. */
  autoArmedDate?: string;
  health?: GuardHealth;
}

export interface PosView {
  symbol: string;
  /** The broker's own product string (MIS / NRML), sent back verbatim on the close. */
  productRaw: string;
  exchange: string;
  netQty: number;
  buyAvg: number;
  sellAvg: number;
  /** Live price; 0 = unknown. */
  ltp: number;
  realized: number;
  unrealized: number;
  /** Held over from an earlier day (Kotak cf* quantities). Its P&L against the carry average is not a day P&L, so it is left
   *  out of the loss limit's sum and is not "new" for the lock's flatten-on-sight. Unset = not carried. */
  carried?: boolean;
}

export interface ExitOrder {
  symbol: string; exchange: string; productRaw: string;
  /** Absolute quantity, sent verbatim (Kotak counts MCX in barrels already). */
  qty: number;
  side: 'B' | 'S';
  /** Shorts are covered before longs are sold, so a hedge is never sold from under an open short. */
  phase: 'cover-short' | 'sell-long';
  reason: string;
  /** Sent by the day lock (not a bracket or the loss limit itself): the adapter clears the leg's resting exit orders first. */
  lock?: boolean;
}

/** Options of one step. `lockOnLoss`: a fired LOSS limit locks the day (Kotak only: its order gate and banner exist). */
export interface StepOptions { lockOnLoss?: boolean }

/** The key a lock flatten is remembered under. */
export const lockKey = (symbol: string, productRaw: string): string => `${symbol}|${guardProductOf(productRaw)}`;

export const EXIT_VERIFY_MS = 10_000;
/** A lock flatten the broker REFUSED is tried again after this long (never every tick). An accepted or unknown-outcome one is not retried. */
export const LOCK_RETRY_MS = 10_000;

/** The parts of a live options bridge's quotes file (debug/live_options_quotes_dhan_<u>.json) the guards read. */
export interface BridgeQuoteFile {
  updated_at?: string;
  /** Whole contracts the Advanced Scalper asked this bridge to price, on ANY underlying, keyed by Kotak trading symbol. */
  contracts?: Record<string, { ltp?: number }>;
}

/**
 * Kotak trading symbol -> LTP from the `contracts` bucket of every FRESH bridge file. The Advanced Scalper has whichever
 * bridge it runs price every open Kotak leg, so a CRUDEOIL leg has a price while only the NIFTY bridge is running - but
 * only in NIFTY's file, which is why every file is read, not just the leg's own underlying. A stale file contributes
 * nothing (the guard then treats the leg as unpriced and pauses rather than act on an old price).
 */
export function contractPricesFromBridges(files: BridgeQuoteFile[], now: number, freshMs: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of files) {
    const at = Date.parse(String(f.updated_at ?? ''));
    if (!Number.isFinite(at) || now - at > freshMs) continue;
    for (const [symbol, q] of Object.entries(f.contracts ?? {})) {
      const ltp = Number(q?.ltp);
      if (ltp > 0 && !out.has(symbol)) out.set(symbol, ltp);
    }
  }
  return out;
}
const MAX_EVENTS = 40;

export function emptyGuardState(today: string): ServerGuardState {
  return { date: today, pnl: null, brackets: [], watch: [], events: [] };
}

const productOf = (p: PosView): GuardProduct => guardProductOf(p.productRaw);
const dirOf = (p: PosView): 1 | -1 => (p.netQty > 0 ? 1 : -1);

function exitFor(p: PosView, reason: string): ExitOrder {
  return {
    symbol: p.symbol, exchange: p.exchange, productRaw: p.productRaw, qty: Math.abs(p.netQty),
    side: p.netQty > 0 ? 'S' : 'B', phase: p.netQty > 0 ? 'sell-long' : 'cover-short', reason,
  };
}

/** Which level (if any) has been hit, with the 1:1 trail the terminal's own position guard uses. */
export function bracketVerdict(b: ServerBracket, ltp: number): { hit: 'Target hit' | 'SL hit' | 'Trail SL hit' | null; best: number } {
  const isLong = b.dir > 0;
  if (!(ltp > 0)) return { hit: null, best: b.best };
  if ((isLong && ltp >= b.target) || (!isLong && ltp <= b.target)) return { hit: 'Target hit', best: b.best };
  if (!b.trail) {
    return { hit: (isLong && ltp <= b.sl) || (!isLong && ltp >= b.sl) ? 'SL hit' : null, best: b.best };
  }
  if (!(b.entry > 0)) return { hit: (isLong && ltp <= b.sl) || (!isLong && ltp >= b.sl) ? 'SL hit' : null, best: b.best };
  const risk = Math.abs(b.sl - b.entry);
  const best = b.best === 0 ? ltp : (isLong ? Math.max(b.best, ltp) : Math.min(b.best, ltp));
  const trailSl = isLong ? best - risk : best + risk;
  const trailActive = isLong ? trailSl > b.sl : trailSl < b.sl;
  const level = trailActive ? trailSl : b.sl;
  const crossed = (isLong && ltp <= level) || (!isLong && ltp >= level);
  return { hit: crossed ? (trailActive ? 'Trail SL hit' : 'SL hit') : null, best };
}

function pushEvent(s: ServerGuardState, now: number, kind: GuardEventKind, text: string) {
  s.events = [...s.events, { at: now, kind, text }].slice(-MAX_EVENTS);
}

/**
 * One tick. `positions` is the full Kotak book (flat rows included: they carry realised P&L). Returns the next state and the
 * exits to send, shorts first. Never mutates its input.
 */
export function stepGuards(
  prev: ServerGuardState, positions: PosView[], now: number, today: string, opts: StepOptions = {},
): { state: ServerGuardState; exits: ExitOrder[] } {
  const s: ServerGuardState = {
    ...prev, brackets: prev.brackets.map(b => ({ ...b })), watch: [...prev.watch], events: [...prev.events],
    lockSent: { ...(prev.lockSent ?? {}) }, lockRetry: { ...(prev.lockRetry ?? {}) },
  };
  const exits: ExitOrder[] = [];

  if (s.date !== today) {
    if (s.pnl || s.brackets.length || s.lock) pushEvent(s, now, 'expired', 'A new trading day started: yesterday\'s guards and day lock were discarded');
    s.date = today; s.pnl = null; s.brackets = []; s.watch = []; s.lock = null; s.lockSent = {}; s.lockRetry = {};
  }

  const open = positions.filter(p => p.netQty !== 0);
  const exiting = new Set<string>();   // one exit per (symbol, product) per tick, whoever triggers it first

  // ── Exits sent earlier: did they take the position down?
  s.watch = s.watch.filter(w => {
    const still = open.find(p => p.symbol === w.symbol && productOf(p) === w.product && dirOf(p) === w.dir);
    if (!still) return false;
    if (now - w.at < EXIT_VERIFY_MS) return true;
    pushEvent(s, now, 'incomplete', `${w.symbol}: exit sent but ${Math.abs(still.netQty)} is still open - check the broker and exit by hand`);
    return false;
  });

  // ── Software brackets
  const survivors: ServerBracket[] = [];
  for (const b of s.brackets) {
    if (b.state === 'pending') {
      if (now - b.at >= b.ttlMs) { pushEvent(s, now, 'expired', `${b.symbol}: the bracketed entry never showed in the book - bracket dropped`); continue; }
      const row = open.find(p => matchPendingBracket([b], { tradingSymbol: p.symbol, productType: p.productRaw, netQty: p.netQty }));
      if (!row) { survivors.push(b); continue; }
      const armed: ServerBracket = { ...b, state: 'armed', best: 0, entry: (b.dir > 0 ? row.buyAvg : row.sellAvg) || 0 };
      pushEvent(s, now, 'armed', `${b.symbol}: bracket armed, target ${b.target} / SL ${b.sl}${b.trail ? ' / trail' : ''}`);
      survivors.push(armed);
      continue;
    }
    const row = open.find(p => p.symbol === b.symbol && productOf(p) === b.product && dirOf(p) === b.dir);
    if (!row) { pushEvent(s, now, 'dropped', `${b.symbol}: position closed - bracket removed`); continue; }
    const v = bracketVerdict(b, row.ltp);
    if (!v.hit) { survivors.push({ ...b, best: v.best }); continue; }
    const key = `${row.symbol}|${productOf(row)}`;
    if (exiting.has(key)) continue;
    exiting.add(key);
    exits.push(exitFor(row, `Bracket: ${v.hit} at ${row.ltp}`));
    s.watch.push({ symbol: row.symbol, product: productOf(row), dir: b.dir, at: now });
    pushEvent(s, now, 'fired', `${b.symbol}: ${v.hit} at ${row.ltp} (target ${b.target} / SL ${b.sl}) - exiting`);
  }
  s.brackets = survivors;

  // ── Account P&L Guard
  if (s.pnl) {
    const g = s.pnl;
    const inScope = (p: PosView) => g.products.includes(productOf(p));
    const scopeOpen = open.filter(inScope);
    if (scopeOpen.length > 0) {
      // Carried legs are excluded: their P&L against the carry average is cumulative, not today's (see PosView.carried).
      const pnl = positions.filter(p => inScope(p) && !p.carried).reduce((sum, p) => sum + p.realized + p.unrealized, 0);
      const allPriced = scopeOpen.every(p => p.ltp > 0);
      const verdict = evaluateSoftPnlGuard(g, pnl, today, allPriced);
      if (verdict.fire) {
        s.pnl = null;   // disarm before exiting: it fires once
        // A LOSS fire locks the day (a profit target is the user's win: no lock). Anything new in scope is flattened below.
        if (opts.lockOnLoss && g.loss > 0 && pnl <= -g.loss) {
          s.lock = { at: now, reason: verdict.reason, products: [...g.products] };
          pushEvent(s, now, 'locked', `${verdict.reason} - Kotak is locked for the rest of the day: new positions are squared off on sight`);
        }
        pushEvent(s, now, 'pnl_fired', `${verdict.reason} - exiting ${scopeOpen.length} leg(s)`);
        for (const p of scopeOpen) {
          const key = `${p.symbol}|${productOf(p)}`;
          if (exiting.has(key)) continue;   // a bracket already sent this leg's exit this tick
          exiting.add(key);
          exits.push(exitFor(p, verdict.reason));
          s.watch.push({ symbol: p.symbol, product: productOf(p), dir: dirOf(p), at: now });
        }
        // Brackets on the legs being closed have nothing left to do.
        s.brackets = s.brackets.filter(b => !scopeOpen.some(p => p.symbol === b.symbol && productOf(p) === b.product));
      }
    }
  }

  // ── Day lock: flatten on sight. Runs every tick while locked, so a position opened afterwards (from any tool or the Kotak
  // app) is closed within one tick. Carried legs are not "new" and are left alone; a leg already being exited (watch / this
  // tick) is left alone. ONE flatten per leg: it is never re-sent on a timer (an accepted market order whose fill the book has
  // not shown yet would be doubled and flip the position - the same reason a bracket exit is never retried). Only a flatten
  // the broker explicitly REFUSED comes back, via `lockRetry`, which the tick loop sets.
  if (s.lock) {
    const lock = s.lock;
    const lockOpen = open.filter(p => lock.products.includes(productOf(p)) && !p.carried);
    const openKeys = new Set(lockOpen.map(p => lockKey(p.symbol, p.productRaw)));
    // A leg that closed (or was never sent) forgets its memory, so the same contract opened again later is flattened too.
    for (const k of Object.keys(s.lockSent ?? {})) if (!openKeys.has(k)) { delete s.lockSent![k]; delete s.lockRetry![k]; }
    for (const p of lockOpen) {
      const key = lockKey(p.symbol, p.productRaw);
      if (exiting.has(key)) continue;
      if (s.watch.some(w => w.symbol === p.symbol && w.product === productOf(p) && w.dir === dirOf(p))) continue;
      const sent = s.lockSent?.[key];
      const retryAt = s.lockRetry?.[key];
      if (sent !== undefined && !(retryAt !== undefined && now >= retryAt)) continue;
      exiting.add(key);
      s.lockSent = { ...s.lockSent, [key]: now };
      delete s.lockRetry![key];
      exits.push({ ...exitFor(p, 'Day loss limit hit - flattening on sight'), lock: true });
      s.watch.push({ symbol: p.symbol, product: productOf(p), dir: dirOf(p), at: now });
      pushEvent(s, now, 'locked', `${p.symbol}: opened after the loss limit fired - squaring off`);
    }
    // The leg the loss limit itself exited this tick is remembered too, so the lock never sends it a second flatten.
    for (const e of exits) {
      const k = lockKey(e.symbol, e.productRaw);
      if (!(k in (s.lockSent ?? {}))) s.lockSent = { ...s.lockSent, [k]: now };
    }
  }

  exits.sort((a, b) => (a.phase === b.phase ? 0 : a.phase === 'cover-short' ? -1 : 1));
  return { state: s, exits };
}
