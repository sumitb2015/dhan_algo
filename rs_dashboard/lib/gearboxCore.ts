import { writeJsonAtomic } from './lockedJsonFile.ts';
import { globalOnce } from './globalOnce.ts';
import { istDateIso } from './nseHolidays.ts';
import { istMinuteOfDay } from './istTime.ts';
import { mcxSession } from './mcxSession.ts';
import { MCX_LOT_MULTIPLIER } from './positionPnl.ts';
import { atmStrike, expiriesFor, resolveOption, strikesFor, type FnoRow } from './pnfContracts.ts';
import { parsePnfOrder } from './pnfOrderLogic.ts';
import type { Target } from './pnfTarget.ts';
import { gbStateFile, readGbLedger } from './gearboxFile.ts';
import {
  MAX_REAL_LOTS, MAX_SIM_LOTS, addLog, applyClientOp, entryBlock, isLive, liveRow, trimRows,
  type Dir, type DirLeg, type GbLedger, type GbMode, type GbRow, type GbUnderlying,
} from './gearboxLedger.ts';

// Gearbox Drive's server core: the one writer of debug/gearbox_state.json and its order path. REAL MONEY (Dhan MCX options).
// Every mutation (client op, trade, lastLtp refresh) runs on one in-process chain, so a trade and a config write never interleave.
// The browser names only WHAT to do (open LONG / SHORT, exit, reverse); contract, strike, lots, broker quantity and the exit size
// come from the ledger and the server's own prices here. A REAL row is written BEFORE its order is sent, and an UNKNOWN outcome is
// never resent. Relative imports only: everything that touches the network or the broker comes in through GbDeps, so
// lib/gearboxServer.test.ts runs this under `node --test`; lib/gearboxServer.ts binds the real deps.

type Reply = { status: number; body: Record<string, unknown> };
export type Quote = { ltp: number; ageMs: number };
type PlaceFn = (order: Exclude<ReturnType<typeof parsePnfOrder>, string>, scope: 'pnf', tag: 'gbx') => Promise<Reply>;

export interface GbDeps {
  now(): number;
  /** The signal future's WebSocket price for options of `optExpiry` (spotInstrument(u, optExpiry, true)); null = none. */
  price(u: GbUnderlying, optExpiry: string): Quote | null;
  /** An option's WebSocket price (MCX_COMM); null = none. */
  optionPrice(t: Target): Quote | null;
  place: PlaceFn;
  readOrder(id: string): Promise<{ orderStatus: string; filledQty: number; averageTradedPrice: number } | null>;
  sleep(ms: number): Promise<void>;
  /** The broker's quantity for one lot of `t` on Dhan (brokerLegs' lotUnits; 1 on Dhan MCX), or why it cannot be traded. */
  lotUnits(t: Target): Promise<number | string>;
  /** Master F&O rows to resolve contracts in; omitted = master_list.csv. Tests only. */
  fno?: FnoRow[];
}

/** A future price older than this refuses an open (exits are never refused for a stale price). */
export const FUT_FRESH_MS = 10_000;
/** A SIM close uses the option's LTP only when it is this fresh; else the row's lastLtp. */
const OPT_FRESH_MS = 10_000;
/** After a placed order: read its status every second, up to ten times. */
const FILL_POLLS = 10;
const FILL_POLL_MS = 1_000;
const LTP_WRITE_EVERY_MS = 3_000;

const chain = globalOnce('gearbox.chain', () => ({ p: Promise.resolve() as Promise<unknown> }));
const ltpWrite = globalOnce('gearbox.ltpWrite', () => ({ at: 0 }));

/** Runs `fn` after every earlier Gearbox mutation (trade, client op, lastLtp write, square-off). */
export function gbSerial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.p.then(fn, fn);
  chain.p = run.catch(() => undefined);
  return run;
}

/** Writes the ledger with rev + 1. Call only inside gbSerial. */
export function saveGbLedger(l: GbLedger, now: number): GbLedger {
  const next = { ...l, rows: trimRows(l.rows), rev: l.rev + 1, updatedAt: now };
  writeJsonAtomic(gbStateFile(), next, { pretty: true });
  return next;
}

const fail = (error: string, status = 400): Reply => ({ status, body: { success: false, error } });
const opposite = (a: 'BUY' | 'SELL'): 'BUY' | 'SELL' => (a === 'BUY' ? 'SELL' : 'BUY');
const patchRow = (l: GbLedger, id: string, p: Partial<GbRow>): GbLedger => ({ ...l, rows: l.rows.map(r => (r.id === id ? { ...r, ...p } : r)) });
const unitsPerLotOf = (u: GbUnderlying) => MCX_LOT_MULTIPLIER[u] ?? (u === 'CRUDEOIL' ? 100 : 10);
const capOf = (m: GbMode) => (m === 'REAL' ? MAX_REAL_LOTS : MAX_SIM_LOTS);
const optName = (t: Target) => `${t.symbol} ${t.expiry} ${t.strike} ${t.side}`;

// ── Contract pick ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The option expiry a leg trades: "nearest" = the first listed expiry AFTER today (never one expiring today). */
export function legExpiry(u: GbUnderlying, leg: DirLeg, today: string, from?: FnoRow[]): string {
  const exps = expiriesFor('options', u, from);
  if (leg.expiry === 'nearest') return exps.find(e => e > today) ?? `No ${u} option expiry after ${today} in the master list`;
  if (!exps.includes(leg.expiry)) return `${u} options expiring ${leg.expiry} are not listed`;
  if (leg.expiry <= today) return `${u} options expiring ${leg.expiry} expire today - pick a later expiry`;
  return leg.expiry;
}
const isIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** The option a leg trades at future price `futLtp`: ATM of the listed strikes, `offset` strikes OTM (CE up, PE down). */
export function pickTarget(u: GbUnderlying, leg: DirLeg, futLtp: number, today: string, from?: FnoRow[]): Target | string {
  const exp = legExpiry(u, leg, today, from);
  if (!isIso(exp)) return exp;
  if (!(futLtp > 0)) return 'No futures price to pick the strike from';
  const strikes = strikesFor(u, exp, from);
  const atm = atmStrike(strikes, futLtp);
  if (atm === null) return `No ${u} strikes listed for ${exp}`;
  const i = strikes.indexOf(atm) + (leg.opt === 'CE' ? leg.offset : -leg.offset);
  if (i < 0 || i >= strikes.length) return `Strike offset ${leg.offset} is outside the listed ${u} ${exp} strikes`;
  const strike = strikes[i];
  if (!resolveOption(u, exp, strike, leg.opt, from)) return `No ${u} ${strike} ${leg.opt} expiring ${exp}`;
  return { kind: 'options', symbol: u, name: u, expiry: exp, strike, side: leg.opt };
}

/** The signal future for options of `optExpiry`: the first future expiring on or after it (spotInstrument's rule). */
export function futureTarget(u: GbUnderlying, optExpiry: string, from?: FnoRow[]): Target | null {
  const exp = expiriesFor('futures', u, from).find(e => e >= optExpiry);
  return exp ? { kind: 'futures', symbol: u, name: u, expiry: exp } : null;
}

// ── Requests ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type TradeReq = {
  action: 'open' | 'exit' | 'reverse';
  dir?: Dir;
  underlying: GbUnderlying;
  /** The future price the browser decided on: recorded for slippage display only, never used to price a fill. */
  decisionPrice: number;
  reason: string;
  /** What the page believes the mode / broker are: a mismatch with the ledger is refused (the page is out of date). */
  mode?: GbMode;
  broker?: string;
};

export function parseTrade(b: unknown): TradeReq | string {
  if (!b || typeof b !== 'object') return 'Invalid request';
  const o = b as Record<string, unknown>;
  if (o.action !== 'open' && o.action !== 'exit' && o.action !== 'reverse') return 'action must be open, exit or reverse';
  if (o.underlying !== 'CRUDEOIL' && o.underlying !== 'CRUDEOILM') return 'underlying must be CRUDEOIL or CRUDEOILM';
  const decisionPrice = Number(o.decisionPrice);
  if (typeof o.decisionPrice !== 'number' || !Number.isFinite(decisionPrice) || decisionPrice <= 0) return 'decisionPrice must be a positive number';
  if (o.mode !== undefined && o.mode !== 'SIM' && o.mode !== 'REAL') return 'mode must be SIM or REAL';
  if (o.broker !== undefined && typeof o.broker !== 'string') return 'broker must be a string';
  const reason = typeof o.reason === 'string' ? o.reason.slice(0, 160) : '';
  const base = {
    underlying: o.underlying as GbUnderlying, decisionPrice,
    ...(o.mode !== undefined ? { mode: o.mode as GbMode } : {}), ...(o.broker !== undefined ? { broker: o.broker as string } : {}),
  };
  if (o.action === 'exit') return { action: 'exit', ...base, reason: reason || 'Exit' };
  if (o.dir !== 'LONG' && o.dir !== 'SHORT') return 'dir must be LONG or SHORT';
  return { action: o.action, dir: o.dir, ...base, reason: reason || o.action };
}

// ── State ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function gbState(deps: GbDeps): Reply {
  const now = deps.now();
  const today = istDateIso(now);
  const ledger = readGbLedger();
  const u = ledger.config.underlying;
  const nearest = legExpiry(u, { action: 'BUY', opt: 'CE', offset: 0, expiry: 'nearest' }, today, deps.fno);
  const future = isIso(nearest) ? futureTarget(u, nearest, deps.fno) : null;
  const futQuote = isIso(nearest) ? deps.price(u, nearest) : null;

  // What each button would trade now (at the future of that leg's own expiry). Asking for its price keeps it subscribed.
  const contracts: Record<Dir, Target | null> = { LONG: null, SHORT: null };
  const contractPrices: Record<Dir, Quote | null> = { LONG: null, SHORT: null };
  const contractErrors: Record<Dir, string | null> = { LONG: null, SHORT: null };
  for (const d of ['LONG', 'SHORT'] as const) {
    const leg = ledger.config.map[d];
    const exp = legExpiry(u, leg, today, deps.fno);
    const fq = !isIso(exp) ? null : exp === nearest ? futQuote : deps.price(u, exp);
    const t = !isIso(exp) ? exp : fq && fq.ageMs <= FUT_FRESH_MS ? pickTarget(u, leg, fq.ltp, today, deps.fno) : 'No fresh futures price';
    if (typeof t === 'string') { contractErrors[d] = t; continue; }
    contracts[d] = t;
    contractPrices[d] = deps.optionPrice(t);
  }

  // Every live row's option stays subscribed; a fresh price refreshes its lastLtp (the square-off's SIM fallback).
  const rowPrices: Record<string, Quote | null> = {};
  const fresh: Record<string, number> = {};
  for (const r of ledger.rows) {
    if (!isLive(r)) continue;
    const q = deps.optionPrice(r.target);
    rowPrices[r.id] = q;
    if (q && q.ageMs <= OPT_FRESH_MS && q.ltp !== r.lastLtp) fresh[r.id] = q.ltp;
  }
  if (Object.keys(fresh).length && now - ltpWrite.at >= LTP_WRITE_EVERY_MS) {
    ltpWrite.at = now;
    void gbSerial(async () => {
      const l = readGbLedger();
      if (!l.rows.some(r => isLive(r) && fresh[r.id] !== undefined)) return;
      saveGbLedger({ ...l, rows: l.rows.map(r => (isLive(r) && fresh[r.id] !== undefined ? { ...r, lastLtp: fresh[r.id] } : r)) }, deps.now());
    }).catch(() => undefined);
  }

  return {
    status: 200,
    body: {
      success: true, ledger, future, contracts, contractErrors,
      prices: { future: futQuote, contracts: contractPrices, rows: rowPrices },
      caps: { REAL: MAX_REAL_LOTS, SIM: MAX_SIM_LOTS }, unitsPerLot: unitsPerLotOf(u),
      today, session: mcxSession(today),
    },
  };
}

export function gbClientOp(op: unknown, deps: Pick<GbDeps, 'now'>): Promise<Reply> {
  return gbSerial(async () => {
    const now = deps.now();
    const r = applyClientOp(readGbLedger(), op, now);
    if (!r.ok) return fail(r.error, r.status);
    // applyClientOp already stamps rev + 1
    const next = { ...r.ledger, rows: trimRows(r.ledger.rows) };
    writeJsonAtomic(gbStateFile(), next, { pretty: true });
    return { status: 200, body: { success: true, ledger: next } };
  });
}

// ── Trades ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Step = { ok: boolean; unknown?: boolean; error?: string; ledger: GbLedger };
type Fill = { kind: 'traded'; price: number } | { kind: 'refused'; reason: string } | { kind: 'timeout' };

/** The broker's verdict on a placed order: TRADED (with its average price), REJECTED / CANCELLED / EXPIRED, or no verdict in 10 s. */
async function pollFill(orderId: string | null, deps: GbDeps): Promise<Fill> {
  if (!orderId) return { kind: 'timeout' };
  for (let i = 0; i < FILL_POLLS; i++) {
    await deps.sleep(FILL_POLL_MS);
    const o = await deps.readOrder(orderId).catch(() => null);
    if (!o) continue;
    const s = o.orderStatus.toUpperCase();
    if (s === 'TRADED' && o.averageTradedPrice > 0) return { kind: 'traded', price: o.averageTradedPrice };
    // a cancelled remainder after a partial fill is not a clean refusal: leave it to the timeout (UNKNOWN)
    if ((s === 'REJECTED' || s === 'CANCELLED' || s === 'EXPIRED') && !(o.filledQty > 0)) return { kind: 'refused', reason: s };
  }
  return { kind: 'timeout' };
}

const orderIdOf = (r: Reply): string | null => {
  const legs = r.body.legs;
  const id = Array.isArray(legs) ? (legs[0] as { orderId?: unknown } | undefined)?.orderId : undefined;
  return typeof id === 'string' && id ? id : null;
};

async function placeSafely(deps: GbDeps, order: Exclude<ReturnType<typeof parsePnfOrder>, string>): Promise<Reply> {
  try {
    return await deps.place(order, 'pnf', 'gbx');
  } catch (e) {
    // the send may have reached the broker: never treated as refused
    return { status: 504, body: { success: false, outcome: 'unknown', error: `Order status unknown: ${(e as Error).message}` } };
  }
}

const hhmm = (ms: number) => { const m = istMinuteOfDay(ms); return Math.floor(m / 60) * 100 + (m % 60); };

type OpenPlan = { leg: DirLeg; target: Target; lots: number; lotUnits: number; optLtp: number };

/** Every check an entry needs, before anything is sent (a reverse runs these BEFORE its exit, so it never exits for nothing). */
async function planOpen(l: GbLedger, req: TradeReq, deps: GbDeps, now: number, today: string): Promise<OpenPlan | Reply> {
  const { mode, config } = l;
  if (req.underlying !== config.underlying) return fail(`The page trades ${config.underlying} now - reload it`, 409);
  const block = entryBlock(l, today);
  if (block) return fail(`${block} - new entries are blocked today (Exit still works)`, 409);
  const cap = capOf(mode);
  if (!Number.isInteger(config.lots) || config.lots < 1 || config.lots > cap) return fail(`${config.lots} lots is over the ${cap}-lot ${mode} cap - nothing was sent`, 409);
  if (mode === 'REAL' && config.broker !== 'dhan') return fail('REAL is Dhan-only', 400);
  const s = mcxSession(today);
  const t = hhmm(now);
  if (s.open === s.close) return fail(`MCX is closed today (${s.note ?? 'no session'})`, 409);
  if (t < s.open || t >= s.autoExit) return fail(`Entries run ${String(s.open).padStart(4, '0')}-${s.autoExitLabel} IST (square-off time) - nothing was sent`, 409);
  const leg = config.map[req.dir!];
  const exp = legExpiry(req.underlying, leg, today, deps.fno);
  if (!isIso(exp)) return fail(exp, 409);
  const fut = deps.price(req.underlying, exp);
  if (!fut) return fail('No live futures price on the server - nothing was sent', 409);
  if (fut.ageMs > FUT_FRESH_MS) return fail(`The futures price is ${Math.round(fut.ageMs / 1000)} s old - nothing was sent`, 409);
  const target = pickTarget(req.underlying, leg, fut.ltp, today, deps.fno);
  if (typeof target === 'string') return fail(target, 409);
  const opt = deps.optionPrice(target);
  if (!opt) return fail(`No live price for ${optName(target)} yet - try again in a few seconds`, 409);
  const lotUnits = await deps.lotUnits(target).catch((e: Error) => `Contract lookup failed: ${e.message}`);
  if (typeof lotUnits === 'string') return fail(lotUnits, 409);
  if (!(lotUnits > 0)) return fail('Order size check failed - nothing was sent', 500);
  return { leg, target, lots: config.lots, lotUnits, optLtp: opt.ltp };
}

async function openRow(l0: GbLedger, req: TradeReq, p: OpenPlan, deps: GbDeps, now: number, today: string): Promise<Step> {
  const { mode, config } = l0;
  const row: GbRow = {
    id: `gbx-${now}`, mode, broker: config.broker, underlying: req.underlying, dir: req.dir!, leg: { ...p.leg }, target: p.target,
    lots: p.lots, units: p.lots * p.lotUnits, unitsPerLot: unitsPerLotOf(req.underlying),
    entry: p.optLtp, entryDecision: req.decisionPrice, entryAt: now, reason: req.reason, day: today,
    status: mode === 'SIM' ? 'open' : 'sending', lastLtp: p.optLtp,
  };
  const what = `${req.dir} ${p.leg.action} ${p.lots} x ${optName(p.target)}`;
  let l: GbLedger = { ...l0, rows: [...l0.rows, row] };
  if (mode === 'SIM') return { ok: true, ledger: addLog(l, 'trade', `SIM ${what} @ ${p.optLtp} - ${req.reason}`, now) };

  // REAL: the 'sending' row is on disk before the order leaves
  l = saveGbLedger(l, now);
  const order = parsePnfOrder({ broker: config.broker, mode: 'REAL', target: p.target, action: p.leg.action, lots: p.lots, product: 'INTRADAY', source: 'bar' });
  if (typeof order === 'string') return { ok: false, error: order, ledger: addLog(patchRow(l, row.id, { status: 'failed', note: order }), 'error', `Entry not sent: ${order}`, now) };
  const r = await placeSafely(deps, order);
  const outcome = String(r.body.outcome ?? '');
  const msg = String(r.body.message ?? r.body.error ?? '');
  const orderId = orderIdOf(r);
  if (outcome === 'placed') {
    l = patchRow(l, row.id, { status: 'open', ...(orderId ? { entryOrderId: orderId } : {}) });
    const fill = await pollFill(orderId, deps);
    if (fill.kind === 'traded') {
      return { ok: true, ledger: addLog(patchRow(l, row.id, { entry: fill.price }), 'trade', `REAL ${what} filled @ ${fill.price} - ${req.reason}`, deps.now()) };
    }
    if (fill.kind === 'refused') {
      const note = `entry ${fill.reason} by the broker`;
      return { ok: false, error: `Entry ${fill.reason}`, ledger: addLog(patchRow(l, row.id, { status: 'failed', note }), 'error', `REAL ${what}: ${note}`, deps.now()) };
    }
    const ltp = deps.optionPrice(p.target)?.ltp ?? p.optLtp;
    l = patchRow(l, row.id, { entry: ltp, note: 'fill price not confirmed - booked at the option LTP' });
    return { ok: true, ledger: addLog(l, 'warn', `REAL ${what} placed; fill price not confirmed in ${FILL_POLLS} s - booked at LTP ${ltp}`, deps.now()) };
  }
  if (outcome === 'unknown' || r.status === 504) {
    l = patchRow(l, row.id, { status: 'unknown', note: msg, ...(orderId ? { entryOrderId: orderId } : {}) });
    return { ok: false, unknown: true, error: msg, ledger: addLog(l, 'error', `Entry outcome UNKNOWN - check the ${config.broker} order book: ${msg}`, now) };
  }
  return { ok: false, error: msg || 'Entry refused', ledger: addLog(patchRow(l, row.id, { status: 'failed', note: msg }), 'error', `Entry refused: ${msg}`, now) };
}

function closed(l: GbLedger, row: GbRow, price: number, reason: string, now: number, extra: Partial<GbRow> = {}): GbLedger {
  return patchRow(l, row.id, { status: 'closed', exit: price, exitAt: now, reason, ...extra });
}

/**
 * Closes one open row: SIM at the option's fresh LTP (else lastLtp, logged); REAL by sending ONLY this row's units (exitOwn, capped
 * by the broker row) and waiting for the fill. Refused -> the row stays open. No verdict / unknown -> the row goes UNKNOWN, never
 * resent. Call inside gbSerial; the caller saves the returned ledger (the REAL 'closing' row is saved here, before the send).
 */
export async function closeRowNow(l0: GbLedger, row: GbRow, reason: string, deps: GbDeps, decisionPrice?: number): Promise<Step> {
  const now = deps.now();
  const q = deps.optionPrice(row.target);
  const freshLtp = q && q.ageMs <= OPT_FRESH_MS ? q.ltp : null;
  const dec = decisionPrice !== undefined ? { exitDecision: decisionPrice } : {};
  const what = `${row.dir} ${row.leg.action} ${row.lots} x ${optName(row.target)}`;
  if (row.mode === 'SIM') {
    let price = freshLtp;
    let l = l0;
    if (price === null) {
      price = row.lastLtp ?? q?.ltp ?? row.entry;
      const src = row.lastLtp !== undefined ? 'last good price' : q ? 'stale LTP' : 'entry price (no price at all)';
      l = addLog(l, 'warn', `SIM exit ${optName(row.target)}: no fresh option price - closed at the ${src} ${price}`, now);
    }
    return { ok: true, ledger: addLog(closed(l, row, price, reason, now, dec), 'trade', `SIM exit ${what} @ ${price} - ${reason}`, now) };
  }

  let l = saveGbLedger(patchRow(l0, row.id, { status: 'closing' }), now);
  const order = parsePnfOrder({
    broker: row.broker, mode: 'REAL', target: row.target, source: 'bar',
    exitOwn: { side: opposite(row.leg.action), units: [row.units], product: 'INTRADAY' },
  });
  if (typeof order === 'string') return { ok: false, error: order, ledger: addLog(patchRow(l, row.id, { status: 'open' }), 'error', `Exit not sent: ${order}`, now) };
  const r = await placeSafely(deps, order);
  const outcome = String(r.body.outcome ?? '');
  const msg = String(r.body.message ?? r.body.error ?? '');
  const orderId = orderIdOf(r);
  const fallback = () => freshLtp ?? row.lastLtp ?? row.entry;
  if (outcome === 'flat') {
    const note = 'nothing was left at the broker (closed outside this page)';
    const price = fallback();
    return { ok: true, ledger: addLog(closed(l, row, price, reason, deps.now(), { ...dec, note }), 'trade', `REAL exit ${what} @ ~${price} - ${reason} (${note})`, deps.now()) };
  }
  if (outcome === 'placed') {
    l = patchRow(l, row.id, orderId ? { exitOrderId: orderId } : {});
    const fill = await pollFill(orderId, deps);
    if (fill.kind === 'traded') {
      return { ok: true, ledger: addLog(closed(l, row, fill.price, reason, deps.now(), dec), 'trade', `REAL exit ${what} filled @ ${fill.price} - ${reason}`, deps.now()) };
    }
    if (fill.kind === 'refused') {
      return { ok: false, error: `Exit ${fill.reason} by the broker - the position is still open`, ledger: addLog(patchRow(l, row.id, { status: 'open' }), 'error', `REAL exit ${what} ${fill.reason} - still open`, deps.now()) };
    }
    const note = `exit placed, no fill confirmed in ${FILL_POLLS} s - check the ${row.broker} positions`;
    return { ok: false, unknown: true, error: note, ledger: addLog(patchRow(l, row.id, { status: 'unknown', note }), 'error', `REAL exit ${what}: ${note}`, deps.now()) };
  }
  if (outcome === 'unknown' || r.status === 504) {
    const note = `exit unknown: ${msg}`;
    return { ok: false, unknown: true, error: msg, ledger: addLog(patchRow(l, row.id, { status: 'unknown', note, ...(orderId ? { exitOrderId: orderId } : {}) }), 'error', `Exit outcome UNKNOWN - check the ${row.broker} positions: ${msg}`, now) };
  }
  // refused (incl. 409 busy / session down): nothing went out, the position is still open
  return { ok: false, error: msg || 'Exit refused', ledger: addLog(patchRow(l, row.id, { status: 'open' }), 'error', `Exit refused: ${msg}`, now) };
}

const stepReply = (s: Step, now: number, prefix = ''): Reply => ({
  status: s.ok ? 200 : s.unknown ? 504 : 502,
  body: { success: s.ok, ...(s.error ? { error: prefix + s.error } : {}), ...(s.unknown ? { unknown: true } : {}), ledger: saveGbLedger(s.ledger, now) },
});

export function gbTrade(req: TradeReq, deps: GbDeps): Promise<Reply> {
  return gbSerial(async () => {
    const l = readGbLedger();
    const now = deps.now();
    const today = istDateIso(now);
    if (req.mode !== undefined && req.mode !== l.mode) return fail(`The ledger is in ${l.mode} - reload the page (nothing was sent)`, 409);
    if (req.broker !== undefined && req.broker !== 'dhan') return fail('REAL is Dhan-only in Gearbox Drive (Kotak / Zerodha are off) - nothing was sent', 400);
    if (req.broker !== undefined && req.broker !== l.config.broker) return fail('The broker changed - reload the page (nothing was sent)', 409);
    const live = liveRow(l, req.underlying);
    const notOpen = (r: GbRow) => fail(`The position is ${r.status.toUpperCase()} - resolve it first`, 409);

    if (req.action === 'exit') {
      if (!live) return fail(`No open ${req.underlying} position`, 409);
      if (live.status !== 'open') return notOpen(live);
      return stepReply(await closeRowNow(l, live, req.reason, deps, req.decisionPrice), now);
    }

    if (req.action === 'open') {
      if (live) {
        if (live.status !== 'open') return notOpen(live);
        if (live.dir === req.dir) return fail(`Already ${req.dir}`, 409);
        return fail(`A ${live.dir} position is open - reverse or exit it first`, 409);
      }
      const plan = await planOpen(l, req, deps, now, today);
      if ('status' in plan) return plan;
      return stepReply(await openRow(l, req, plan, deps, now, today), now);
    }

    // reverse: every entry check first, then the exit, and the new leg only once the exit is confirmed filled
    if (!live) return fail('Nothing to reverse', 409);
    if (live.status !== 'open') return notOpen(live);
    if (live.dir === req.dir) return fail(`Already ${req.dir}`, 409);
    const plan = await planOpen(l, req, deps, now, today);
    if ('status' in plan) return fail(`Reverse refused, nothing was sent: ${String(plan.body.error)}`, plan.status);
    const out = await closeRowNow(l, live, `Reverse: ${req.reason}`, deps, req.decisionPrice);
    if (!out.ok) return stepReply(out, now, 'Reverse stopped at the close: ');
    const after = deps.now();
    const block = entryBlock(out.ledger, today);
    if (block) return { status: 409, body: { success: false, error: `Closed; ${block} - the new leg was not opened`, ledger: saveGbLedger(out.ledger, after) } };
    return stepReply(await openRow(out.ledger, req, plan, deps, after, today), after);
  });
}
