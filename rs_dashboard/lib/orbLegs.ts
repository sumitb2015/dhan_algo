// Signal Orb multi-leg orders: which contracts a structure trades and how its legs are sent. REAL MONEY (through the server).
// Every leg is its own single-option market order, so a BUY leg and a SELL leg can sit in one structure (the shared P&F order layer
// applies one action to all legs). Rules, as everywhere else in the repo: BUY legs go first and a bought leg is confirmed before a
// short goes out (the short is then margin-hedged); a leg cleanly refused after another went in reverses the placed ones; an UNKNOWN
// outcome is never reversed or resent (it may be live; the user resolves it); an exit covers shorts first, then sells the longs, and
// skips a long while a short is still open. Relative imports only and every network call comes in through LegDeps, so
// lib/orbLegs.test.ts runs this under `node --test`; lib/signalOrbServer.ts binds the real deps.

import { pickTarget } from './gearboxCore.ts';
import type { FnoRow } from './pnfContracts.ts';
import type { Target } from './pnfTarget.ts';

export type LegAction = 'BUY' | 'SELL';
export type Reply = { status: number; body: Record<string, unknown> };

/** A leg to open: its contract, whether it is bought or sold, lots and the broker's units per lot. */
export interface LegPlan { target: Target; action: LegAction; lots: number; lotUnits: number }
/** A leg to close: `action` is the CLOSING action (a short is closed by a BUY) and `units` the quantity the row owns. */
export interface CloseReq { target: Target; action: LegAction; units: number }

export interface LegDeps {
  open(plan: LegPlan): Promise<Reply>;
  close(req: CloseReq): Promise<Reply>;
  readOrder(id: string): Promise<{ orderStatus: string; filledQty: number; averageTradedPrice: number } | null>;
  sleep(ms: number): Promise<void>;
}

const FILL_POLLS = 10;
const FILL_POLL_MS = 1_000;

const opposite = (a: LegAction): LegAction => (a === 'BUY' ? 'SELL' : 'BUY');

// ── Which contracts ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A synthetic future: LONG = BUY the ATM call + SELL the ATM put, SHORT = BUY the ATM put + SELL the ATM call, same strike and
 * expiry (the nearest after today). Bought leg first. A reason string when it cannot be built.
 */
export function syntheticLegs(symbol: string, side: 'LONG' | 'SHORT', futPrice: number, today: string, from?: FnoRow[]): { target: Target; action: LegAction }[] | string {
  const long = side === 'LONG';
  const buy = pickTarget(symbol, { action: 'BUY', opt: long ? 'CE' : 'PE', offset: 0, expiry: 'nearest' }, futPrice, today, from);
  if (typeof buy === 'string') return buy;
  const sell = pickTarget(symbol, { action: 'SELL', opt: long ? 'PE' : 'CE', offset: 0, expiry: 'nearest' }, futPrice, today, from);
  if (typeof sell === 'string') return sell;
  if (buy.expiry !== sell.expiry || buy.strike !== sell.strike) return 'The synthetic legs did not resolve to one strike and expiry';
  return [{ target: buy, action: 'BUY' }, { target: sell, action: 'SELL' }];
}

/**
 * A short straddle (CE and PE at the ATM) or strangle (each `offset` strikes OTM): both legs SOLD, same expiry (the nearest after
 * today), CE first. A reason string when it cannot be built.
 */
export function premiumLegs(kind: 'straddle' | 'strangle', symbol: string, offset: number, futPrice: number, today: string, from?: FnoRow[]): { target: Target; action: LegAction }[] | string {
  const n = kind === 'straddle' ? 0 : offset;
  if (kind === 'strangle' && !(n >= 1)) return 'A strangle needs a strike offset of at least 1';
  const ce = pickTarget(symbol, { action: 'SELL', opt: 'CE', offset: n, expiry: 'nearest' }, futPrice, today, from);
  if (typeof ce === 'string') return ce;
  const pe = pickTarget(symbol, { action: 'SELL', opt: 'PE', offset: n, expiry: 'nearest' }, futPrice, today, from);
  if (typeof pe === 'string') return pe;
  if (ce.expiry !== pe.expiry) return 'The legs did not resolve to one expiry';
  if (kind === 'straddle' && ce.strike !== pe.strike) return 'The straddle legs did not resolve to one strike';
  if (kind === 'strangle' && !((ce.strike as number) > (pe.strike as number))) return 'The strangle strikes are inverted or equal - not sold';
  return [{ target: ce, action: 'SELL' }, { target: pe, action: 'SELL' }];
}

// ── Outcomes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Outcome =
  | { kind: 'placed'; orderId: string | null }
  | { kind: 'flat'; orderId: null }
  | { kind: 'rejected'; error: string }
  | { kind: 'unknown'; error: string };

/** What an order reply means: placed (or, for a close, nothing left), cleanly refused, or UNKNOWN (never treated as refused). */
export function outcomeOf(r: Reply): Outcome {
  const o = String(r.body.outcome ?? '');
  const error = String(r.body.message ?? r.body.error ?? 'Order refused');
  if (o === 'unknown' || r.status === 504) return { kind: 'unknown', error };
  if (o === 'placed') return { kind: 'placed', orderId: orderIdOf(r) };
  if (o === 'flat') return { kind: 'flat', orderId: null };
  return { kind: 'rejected', error };
}

function orderIdOf(r: Reply): string | null {
  const legs = r.body.legs;
  const id = Array.isArray(legs) ? (legs[0] as { orderId?: unknown } | undefined)?.orderId : undefined;
  return typeof id === 'string' && id ? id : null;
}

type Fill = { kind: 'traded'; price: number } | { kind: 'refused'; reason: string } | { kind: 'timeout' };

/** The broker's verdict on a placed order: TRADED (its average price), REJECTED / CANCELLED / EXPIRED with nothing filled, or none in 10 s. */
export async function pollFill(orderId: string | null, deps: LegDeps): Promise<Fill> {
  if (!orderId) return { kind: 'timeout' };
  for (let i = 0; i < FILL_POLLS; i++) {
    await deps.sleep(FILL_POLL_MS);
    const o = await deps.readOrder(orderId).catch(() => null);
    if (!o) continue;
    const s = o.orderStatus.toUpperCase();
    // TRADED with a fill is enough: some brokers report no average price on a market order, and the price decides nothing here
    if (s === 'TRADED' && (o.averageTradedPrice > 0 || o.filledQty > 0)) return { kind: 'traded', price: o.averageTradedPrice > 0 ? o.averageTradedPrice : 0 };
    if ((s === 'REJECTED' || s === 'CANCELLED' || s === 'EXPIRED') && !(o.filledQty > 0)) return { kind: 'refused', reason: s };
  }
  return { kind: 'timeout' };
}

const sendOpen = async (deps: LegDeps, p: LegPlan): Promise<Reply> => {
  try { return await deps.open(p); } catch (e) { return { status: 504, body: { success: false, outcome: 'unknown', error: `Order status unknown: ${(e as Error).message}` } }; }
};
const sendClose = async (deps: LegDeps, c: CloseReq): Promise<Reply> => {
  try { return await deps.close(c); } catch (e) { return { status: 504, body: { success: false, outcome: 'unknown', error: `Order status unknown: ${(e as Error).message}` } }; }
};

// ── Entry ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type EnterState = 'open' | 'rejected' | 'unknown' | 'skipped' | 'reversed';
export interface EnterRun { plan: LegPlan; state: EnterState; orderId: string | null; fillPrice: number | null; error?: string }
export interface EnterResult {
  /** Every leg is open. */
  ok: boolean;
  /** A leg's outcome is unknown, or a reversal failed: something may be live and the user must look. */
  unknown: boolean;
  error?: string;
  legs: EnterRun[];
}

/**
 * Sends the legs in order (the caller puts BUY legs first). A bought leg is confirmed filled before the next leg goes. A refusal
 * reverses the legs already open (shorts first); an unknown outcome stops everything and reverses nothing.
 */
export async function enterLegs(plans: LegPlan[], deps: LegDeps): Promise<EnterResult> {
  const legs: EnterRun[] = plans.map(plan => ({ plan, state: 'skipped' as EnterState, orderId: null, fillPrice: null }));
  const reverse = async (): Promise<string | null> => {
    // the legs that are open, shorts first: a sold leg is bought back before a bought leg is sold
    const open = legs.filter(r => r.state === 'open').sort((a, b) => (a.plan.action === 'SELL' ? -1 : 1) - (b.plan.action === 'SELL' ? -1 : 1));
    for (const r of open) {
      const rep = await sendClose(deps, { target: r.plan.target, action: opposite(r.plan.action), units: r.plan.lots * r.plan.lotUnits });
      const o = outcomeOf(rep);
      if (o.kind === 'placed' || o.kind === 'flat') r.state = 'reversed';
      else return `Could not reverse the ${r.plan.action} leg (${o.error}) - it is open alone, check the broker`;
    }
    return null;
  };
  for (let i = 0; i < legs.length; i++) {
    const run = legs[i];
    const o = outcomeOf(await sendOpen(deps, run.plan));
    if (o.kind === 'unknown') {
      run.state = 'unknown'; run.error = o.error;
      return { ok: false, unknown: true, error: o.error, legs };
    }
    if (o.kind === 'rejected') {
      run.state = 'rejected'; run.error = o.error;
      const failed = await reverse();
      return { ok: false, unknown: failed !== null, error: failed ?? o.error, legs };
    }
    run.state = 'open';
    run.orderId = o.kind === 'placed' ? o.orderId : null;
    // a bought leg is a hedge for what follows: be sure it filled before a short goes out
    if (run.plan.action === 'BUY' && i < legs.length - 1) {
      const f = await pollFill(run.orderId, deps);
      if (f.kind === 'traded') run.fillPrice = f.price;
      else if (f.kind === 'refused') {
        run.state = 'rejected'; run.error = `The bought leg was ${f.reason}`;
        const failed = await reverse();
        return { ok: false, unknown: failed !== null, error: failed ?? run.error, legs };
      } else {
        run.state = 'unknown'; run.error = 'The bought leg has no fill status yet - check the broker book';
        return { ok: false, unknown: true, error: run.error, legs };
      }
    }
  }
  return { ok: true, unknown: false, legs };
}

// ── Exit ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ExitState = 'closed' | 'open' | 'unknown';
export interface ExitRun { index: number; state: ExitState; flat: boolean; error?: string; /** the closing order (null: flat, or no id in the reply) */ orderId?: string | null }
export interface ExitResult {
  /** Every leg asked for is closed. */
  ok: boolean;
  unknown: boolean;
  error?: string;
  /** Results per leg, in the order they were attempted. */
  legs: ExitRun[];
}

/**
 * Closes the legs the row still holds: shorts first (bought back), then the longs (sold). A long is skipped while a short is not
 * confirmed closed - selling the hedge would leave the short naked. An unknown outcome stops everything (never resent).
 */
export async function exitLegs(legs: { target: Target; action: LegAction; units: number }[], deps: LegDeps): Promise<ExitResult> {
  const order = legs.map((l, index) => ({ l, index })).sort((a, b) => (a.l.action === 'SELL' ? 0 : 1) - (b.l.action === 'SELL' ? 0 : 1));
  const runs: ExitRun[] = [];
  let shortOpen = false;
  let firstError: string | undefined;
  for (const { l, index } of order) {
    if (l.action === 'BUY' && shortOpen) { runs.push({ index, state: 'open', flat: false, error: 'a short leg is still open' }); continue; }
    const o = outcomeOf(await sendClose(deps, { target: l.target, action: opposite(l.action), units: l.units }));
    if (o.kind === 'placed' || o.kind === 'flat') { runs.push({ index, state: 'closed', flat: o.kind === 'flat', orderId: o.orderId }); continue; }
    if (o.kind === 'unknown') {
      runs.push({ index, state: 'unknown', flat: false, error: o.error });
      return { ok: false, unknown: true, error: o.error, legs: runs };
    }
    runs.push({ index, state: 'open', flat: false, error: o.error });
    firstError ??= o.error;
    if (l.action === 'SELL') shortOpen = true;
  }
  return { ok: runs.every(r => r.state === 'closed'), unknown: false, error: firstError, legs: runs };
}
