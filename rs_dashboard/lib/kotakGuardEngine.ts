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

export type GuardEventKind = 'armed' | 'fired' | 'pnl_fired' | 'dropped' | 'expired' | 'incomplete' | 'error';
export interface GuardEvent { at: number; kind: GuardEventKind; text: string }

export interface ExitWatch { symbol: string; product: GuardProduct; dir: 1 | -1; at: number }

export interface ServerGuardState {
  /** IST day the state belongs to; a new day starts empty (a guard never outlives its session). */
  date: string;
  pnl: SoftPnlGuard | null;
  brackets: ServerBracket[];
  watch: ExitWatch[];
  events: GuardEvent[];
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
}

export interface ExitOrder {
  symbol: string; exchange: string; productRaw: string;
  /** Absolute quantity, sent verbatim (Kotak counts MCX in barrels already). */
  qty: number;
  side: 'B' | 'S';
  /** Shorts are covered before longs are sold, so a hedge is never sold from under an open short. */
  phase: 'cover-short' | 'sell-long';
  reason: string;
}

export const EXIT_VERIFY_MS = 10_000;
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
  prev: ServerGuardState, positions: PosView[], now: number, today: string,
): { state: ServerGuardState; exits: ExitOrder[] } {
  const s: ServerGuardState = {
    ...prev, brackets: prev.brackets.map(b => ({ ...b })), watch: [...prev.watch], events: [...prev.events],
  };
  const exits: ExitOrder[] = [];

  if (s.date !== today) {
    if (s.pnl || s.brackets.length) pushEvent(s, now, 'expired', 'A new trading day started: yesterday\'s guards were discarded');
    s.date = today; s.pnl = null; s.brackets = []; s.watch = [];
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
      const pnl = positions.filter(inScope).reduce((sum, p) => sum + p.realized + p.unrealized, 0);
      const allPriced = scopeOpen.every(p => p.ltp > 0);
      const verdict = evaluateSoftPnlGuard(g, pnl, today, allPriced);
      if (verdict.fire) {
        s.pnl = null;   // disarm before exiting: it fires once
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

  exits.sort((a, b) => (a.phase === b.phase ? 0 : a.phase === 'cover-short' ? -1 : 1));
  return { state: s, exits };
}
