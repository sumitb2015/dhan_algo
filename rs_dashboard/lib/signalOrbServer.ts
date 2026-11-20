import { writeJsonAtomic } from '@/lib/lockedJsonFile';
import { globalOnce } from '@/lib/globalOnce';
import { istDateIso } from '@/lib/nseHolidays';
import { expiriesFor } from '@/lib/pnfContracts';
import { placePnfMarket } from '@/lib/pnfAutoOrders';
import { brokerLegs, resolvePnfLegs } from '@/lib/pnfOrderServer';
import { parsePnfOrder } from '@/lib/pnfOrderLogic';
import { MCX_LOT_MULTIPLIER } from '@/lib/positionPnl';
import { targetKey, type Target } from '@/lib/pnfTarget';
import { resolveOption } from '@/lib/pnfContracts';
import { pickTarget } from '@/lib/gearboxCore';
import { wsPrice, wsSync, wsWant } from '@/lib/freshMoneyWs';
import { ORB_CODE_VERSION, type Side } from '@/lib/signalOrb';
import { ORB_STATE_FILE, readOrbLedger } from '@/lib/signalOrbFile';
import {
  MAX_REJECTS, addLog, applyClientOp, closeRow, halt, liveRow, patchRow, realisedToday, trimRows, type OrbConfig, type OrbLedger, type OrbRow, type OrbSymbol,
} from '@/lib/signalOrbLedger';

// The Signal Orb's server: the one writer of debug/signal_orb_state.json, and its order path. Real money. Every mutation (client op
// or trade) runs on one in-process chain, so a trade and a config write never interleave. The browser names only WHAT to do
// (enter LONG, exit, reverse) and the decision price; contract, lots, broker quantity and the exit size come from the ledger and the
// broker's own lot here. A row is written BEFORE its order is sent, so a crash mid-send leaves a 'sending' row, never a lost position.

/** Rupees per point per lot: CRUDEOIL 100 barrels, CRUDEOILM 10. */
export const unitsPerLotOf = (sym: OrbSymbol): number => MCX_LOT_MULTIPLIER[sym] ?? (sym === 'CRUDEOIL' ? 100 : 10);
/** An option premium older than this (no change) is not used to book an entry. */
const OPT_FRESH_MS = 30_000;

type Reply = { status: number; body: Record<string, unknown> };
const chain = globalOnce('signalOrb.chain', () => ({ p: Promise.resolve() as Promise<unknown> }));

/** Runs `fn` after every earlier mutation; its returned ledger (if any) is written with rev + 1. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.p.then(fn, fn);
  chain.p = run.catch(() => undefined);
  return run;
}

function save(l: OrbLedger, now: number): OrbLedger {
  const next = { ...l, rows: trimRows(l.rows), rev: l.rev + 1, updatedAt: now };
  writeJsonAtomic(ORB_STATE_FILE, next, { pretty: true });
  return next;
}

/** The future the signal reads (and futures mode trades): the nearest expiry after today (never opened on its last day). */
export function orbContract(symbol: OrbSymbol, nowMs = Date.now()): Target | null {
  const today = istDateIso(nowMs);
  const exp = expiriesFor('futures', symbol).find(e => e > today);
  return exp ? { kind: 'futures', symbol, name: symbol, expiry: exp } : null;
}

/** The future a row's signal and stop read (rows written before options existed: their own target). */
export const signalTargetOf = (r: OrbRow): Target => r.signalTarget ?? r.target;

// ── Option premiums (Fresh Money's server WebSocket, as Gearbox Drive) ──────────────────────────────────────────────────────

const lastPremium = globalOnce('signalOrb.lastPremium', () => new Map<string, number>());

/** The option's WebSocket key (subscribing it), or null when the master list has no such MCX contract. */
function optionKey(t: Target): string | null {
  if (t.kind !== 'options' || !t.expiry || !t.strike || (t.side !== 'CE' && t.side !== 'PE')) return null;
  const c = resolveOption(t.symbol, t.expiry, t.strike, t.side);
  return c && c.segment === 'MCX_COMM' ? wsWant('MCX_COMM', c.securityId) : null;
}

/** The option's live premium, or null (no quote, or none fresh enough). Every quote seen is kept as the exit's fallback. */
function optionLtp(t: Target, now: number, maxAgeMs = OPT_FRESH_MS): number | null {
  const key = optionKey(t);
  if (!key) return null;
  wsSync();
  const p = wsPrice(key);
  if (!p) return null;
  lastPremium.set(targetKey(t), p.ltp);
  return now - (p.changedMs ?? p.sinceMs) <= maxAgeMs ? p.ltp : null;
}

/** The option an entry would sell now: BULL (LONG) sells a PE, BEAR (SHORT) a CE, ATM +/- the offset, nearest expiry after today. */
export function orbOptionTarget(cfg: Pick<OrbConfig, 'symbol' | 'strikeOffset'>, side: Side, futPrice: number, today: string): Target | string {
  return pickTarget(cfg.symbol, { action: 'SELL', opt: side === 'LONG' ? 'PE' : 'CE', offset: cfg.strikeOffset, expiry: 'nearest' }, futPrice, today);
}

export function orbState(): Reply {
  const ledger = readOrbLedger();
  const live = liveRow(ledger);
  const now = Date.now();
  const today = istDateIso(now);
  // An open row pins the contract (its exit must go to the contract it was opened on); the feed always reads the future.
  const contract = live ? signalTargetOf(live) : orbContract(ledger.config.symbol, now);
  let optLtp: number | null = null;
  let optCandidates: Target[] = [];
  if (live?.target.kind === 'options') {
    optLtp = optionLtp(live.target, now, Number.POSITIVE_INFINITY);
  } else if (!live && ledger.config.instrument === 'options' && ledger.engineActive && contract) {
    // keep the options an entry could sell subscribed, so their premium has settled by the time a bar flips the orb
    const fk = contract.expiry ? optionFutureKey(contract) : null;
    const fp = fk ? wsPrice(fk)?.ltp ?? null : null;
    if (fp) {
      optCandidates = (['LONG', 'SHORT'] as const).map(sd => orbOptionTarget(ledger.config, sd, fp, today)).filter((t): t is Target => typeof t !== 'string');
      for (const t of optCandidates) optionKey(t);
      wsSync();
    }
  }
  const unitsPerLot = live?.unitsPerLot ?? unitsPerLotOf(ledger.config.symbol);
  return { status: 200, body: { success: true, ledger, contract, unitsPerLot, optionLtp: optLtp, today, codeVersion: ORB_CODE_VERSION } };
}

/** The signal future's WebSocket key (subscribing it): the strike pick for the warm-up reads its price. */
function optionFutureKey(fut: Target): string | null {
  if (!fut.expiry) return null;
  const legs = resolvePnfLegs(fut);
  if (typeof legs === 'string' || !legs[0] || legs[0].segment !== 'MCX_COMM') return null;
  return wsWant('MCX_COMM', legs[0].securityId);
}

export function orbClientOp(op: unknown): Promise<Reply> {
  return serial(async () => {
    const now = Date.now();
    const r = applyClientOp(readOrbLedger(), op, now);
    if (!r.ok) return { status: r.status, body: { success: false, error: r.error } };
    return { status: 200, body: { success: true, ledger: save(r.ledger, now) } };
  });
}

export type TradeRequest = {
  action: 'enter' | 'exit' | 'reverse';
  side?: Side;
  /** Decision price: the live LTP the browser decided on (the ledger books it; the broker fill may differ). */
  price: number;
  /** enter / reverse: the closed bar the signal was read on (one bar acts once). */
  barT?: number;
  reason: string;
  /** exit: 'stop' arms the stop-out block; 'eod' / 'manual' do not. */
  exitKind?: 'stop' | 'eod' | 'manual';
  /** manual exits and the cutoff run with the engine off; automatic entries need it on. */
  auto: boolean;
  /** The tab's ORB_CODE_VERSION: entries / reversals from another version are refused (exits never are). */
  v?: string;
};

export function parseTrade(b: unknown): TradeRequest | string {
  if (!b || typeof b !== 'object') return 'Invalid request';
  const o = b as Record<string, unknown>;
  if (o.action !== 'enter' && o.action !== 'exit' && o.action !== 'reverse') return 'action must be enter, exit or reverse';
  const price = Number(o.price);
  if (!Number.isFinite(price) || price <= 0) return 'price must be a positive number';
  const reason = typeof o.reason === 'string' ? o.reason.slice(0, 160) : '';
  if (o.action === 'exit') {
    const exitKind = o.exitKind === 'stop' || o.exitKind === 'eod' ? o.exitKind : 'manual';
    return { action: 'exit', price, reason: reason || 'Exit', exitKind, auto: o.auto === true };
  }
  if (o.side !== 'LONG' && o.side !== 'SHORT') return 'side must be LONG or SHORT';
  const barT = Number(o.barT);
  if (!Number.isInteger(barT) || barT <= 0) return 'barT is required';
  return { action: o.action, side: o.side, price, barT, reason: reason || o.action, auto: true, v: typeof o.v === 'string' ? o.v : undefined };
}

const fail = (error: string, status = 400): Reply => ({ status, body: { success: false, error } });

/** What an options entry sells, and the premium it books: picked BEFORE the bar is consumed, so a missing quote retries next tick. */
type OptPick = { target: Target; premium: number };

function pickOption(l: OrbLedger, side: Side, futPrice: number, now: number, day: string): OptPick | string {
  const t = orbOptionTarget(l.config, side, futPrice, day);
  if (typeof t === 'string') return t;
  const premium = optionLtp(t, now);
  if (premium === null) return `No live premium for ${optLabel(t)} yet (WebSocket subscribing) - retrying`;
  return { target: t, premium };
}

const optLabel = (t: Target) => (t.kind === 'options' ? `${t.symbol} ${t.strike} ${t.side}` : `${t.symbol} FUT`);

export function orbTrade(req: TradeRequest): Promise<Reply> {
  return serial(async () => {
    let l = readOrbLedger();
    const now = Date.now();
    const day = istDateIso(now);
    const live = liveRow(l);

    if (req.action === 'exit') {
      if (!live) return fail('No open Orb position', 409);
      if (live.status !== 'open') return fail(`The position is ${live.status.toUpperCase()} - resolve it before exiting`, 409);
      const out = await exitRow(l, live, req, now);
      l = out.ledger;
      return { status: out.ok ? 200 : out.unknown ? 504 : 502, body: { success: out.ok, error: out.error, ledger: save(l, now) } };
    }

    // enter / reverse: automatic only, from a tab running this code, engine on, newer bar, loss limit
    if (req.v !== ORB_CODE_VERSION) return fail('This tab runs an older version of the Signal Orb - reload it (entries refused, exits still work)', 409);
    if (!l.engineActive) return fail(l.haltReason ? `Engine halted: ${l.haltReason}` : 'Auto is OFF', 409);
    if (req.barT! <= l.watermarkT) return fail('This bar was already acted on', 409);
    if (req.action === 'enter' && live) return fail('A position is already open', 409);
    if (req.action === 'reverse') {
      if (!live) return fail('Nothing to reverse', 409);
      if (live.status !== 'open') return fail(`The position is ${live.status.toUpperCase()}`, 409);
      if (live.side === req.side) return fail(`Already ${req.side}`, 409);
      if (live.day !== day) return fail('The open position is from an earlier day - close it by hand', 409);
      if ((live.target.kind === 'options') !== (l.config.instrument === 'options')) return fail('The open position is not the configured instrument - close it by hand', 409);
    }
    // options: the strike and its premium must be known before anything is sent (a reversal never closes into a sale it cannot price)
    let opt: OptPick | null = null;
    if (l.config.instrument === 'options') {
      const p = pickOption(l, req.side!, req.price, now, day);
      if (typeof p === 'string') return fail(p, 409);
      opt = p;
    }
    // the bar is consumed before any send: a retry of the same bar can never place a second order
    l = { ...l, watermarkT: req.barT! };
    if (req.action === 'reverse') {
      const out = await exitRow(l, live!, { ...req, action: 'exit', exitKind: 'manual', reason: `Reverse: ${req.reason}` }, now);
      l = out.ledger;
      if (!out.ok) return { status: out.unknown ? 504 : 502, body: { success: false, error: `Reverse stopped at the close: ${out.error}`, ledger: save(l, now) } };
    }
    if (realisedToday(l, l.mode, day) <= -l.config.dailyLossLimit) {
      l = halt(l, `Daily loss limit ₹${l.config.dailyLossLimit} reached`, now);
      return { status: 409, body: { success: false, error: l.haltReason, ledger: save(l, now) } };
    }
    const out = await enterRow(l, req.side!, req.price, opt, req.reason, now, day);
    l = out.ledger;
    return { status: out.ok ? 200 : out.unknown ? 504 : 502, body: { success: out.ok, error: out.error, ledger: save(l, now) } };
  });
}

type Step = { ok: boolean; unknown?: boolean; error?: string; ledger: OrbLedger };

function bumpReject(l: OrbLedger, msg: string, now: number): OrbLedger {
  const rejects = l.rejects + 1;
  const next = addLog({ ...l, rejects }, 'error', msg, now);
  return rejects >= MAX_REJECTS ? halt(next, `${rejects} orders rejected in a row`, now) : next;
}

/** The order side that opens a row: futures buy LONG / sell SHORT; an options row always SELLS its option. */
const openAction = (side: Side, opt: boolean): 'BUY' | 'SELL' => (opt ? 'SELL' : side === 'LONG' ? 'BUY' : 'SELL');
const closeAction = (r: OrbRow): 'BUY' | 'SELL' => (openAction(r.side, r.target.kind === 'options') === 'BUY' ? 'SELL' : 'BUY');

async function enterRow(l0: OrbLedger, side: Side, futPrice: number, opt: OptPick | null, reason: string, now: number, day: string): Promise<Step> {
  const { mode, config } = l0;
  const fut = orbContract(config.symbol, now);
  if (!fut) return { ok: false, error: `No live ${config.symbol} future in the master list`, ledger: addLog(l0, 'error', 'No contract', now) };
  const target = opt ? opt.target : fut;
  const entry = opt ? opt.premium : futPrice;
  const lots = config.lots;
  const action = openAction(side, !!opt);
  const what = `${action} ${optLabel(target)} x${lots}`;
  const row: OrbRow = {
    id: `orb-${now}`, mode, broker: config.broker, target, side, lots, units: 0, unitsPerLot: unitsPerLotOf(config.symbol),
    entry, signalTarget: fut, signalEntry: futPrice,
    entryAt: now, day, status: mode === 'SIM' ? 'open' : 'sending', ...(mode === 'SIM' ? {} : { sentAt: now }),
  };
  // a new entry means the stop-out block was lifted (the colour changed since the stop): it is cleared here
  let l: OrbLedger = { ...l0, rows: [...l0.rows, row], blockedSide: null };
  if (mode === 'SIM') return { ok: true, ledger: addLog({ ...l, rejects: 0 }, 'trade', `SIM ${side}: ${what} @ ${entry} - ${reason}`, now) };

  // REAL: the 'sending' row is on disk before the order leaves
  save(l, now);
  const legs = resolvePnfLegs(target);
  if (typeof legs === 'string') return { ok: false, error: legs, ledger: bumpReject(patchRow(l, row.id, { status: 'failed', note: legs }), legs, now) };
  const onBroker = await brokerLegs(config.broker, target, legs).catch((e: Error) => `Contract lookup failed: ${e.message}`);
  if (typeof onBroker === 'string') return { ok: false, error: onBroker, ledger: bumpReject(patchRow(l, row.id, { status: 'failed', note: onBroker }), onBroker, now) };
  const order = parsePnfOrder({ broker: config.broker, mode: 'REAL', target, action, lots, product: 'INTRADAY', source: 'bar' }, { uncapped: true });
  if (typeof order === 'string') return { ok: false, error: order, ledger: bumpReject(patchRow(l, row.id, { status: 'failed', note: order }), order, now) };
  const r = await placePnfMarket(order, 'pnf', 'orba');
  const outcome = String(r.body.outcome ?? '');
  const msg = String(r.body.message ?? r.body.error ?? '');
  const units = lots * onBroker[0].lotUnits;
  if (outcome === 'placed') {
    l = addLog(patchRow({ ...l, rejects: 0 }, row.id, { status: 'open', units }), 'trade', `REAL ${side}: ${what} @ ~${entry} - ${reason}`, now);
    return { ok: true, ledger: l };
  }
  if (outcome === 'unknown' || r.status === 504) {
    l = patchRow(l, row.id, { status: 'unknown', units, note: msg });
    return { ok: false, unknown: true, error: msg, ledger: halt(l, `Entry outcome UNKNOWN - check the ${config.broker} order book: ${msg}`, now) };
  }
  return { ok: false, error: msg, ledger: bumpReject(patchRow(l, row.id, { status: 'failed', note: msg }), `Entry refused: ${msg}`, now) };
}

/** The price a row is booked out at: the future's decision price, or the option's live premium (else the last one seen, else entry). */
function exitMark(row: OrbRow, futPrice: number, now: number): { px: number; note?: string } {
  if (row.target.kind !== 'options') return { px: futPrice };
  const live = optionLtp(row.target, now, Number.POSITIVE_INFINITY) ?? lastPremium.get(targetKey(row.target)) ?? null;
  return live !== null ? { px: live } : { px: row.entry, note: 'no premium quote: P&L booked at entry - check the broker fill' };
}

async function exitRow(l0: OrbLedger, row: OrbRow, req: TradeRequest, now: number): Promise<Step> {
  const tag = req.exitKind === 'stop' ? { blockedSide: row.side } : {};
  const mark = exitMark(row, req.price, now);
  const what = `${closeAction(row)} ${optLabel(row.target)}`;
  if (row.mode === 'SIM') {
    let l = addLog({ ...closeRow(l0, row.id, mark.px, req.reason, now), ...tag }, 'trade', `SIM exit ${row.side}: ${what} @ ${mark.px} - ${req.reason}`, now);
    if (mark.note) l = patchRow(l, row.id, { note: mark.note });
    return { ok: true, ledger: lossCheck(l, now) };
  }
  let l = patchRow(l0, row.id, { status: 'closing', sentAt: now });
  save(l, now);
  const order = parsePnfOrder({
    broker: row.broker, mode: 'REAL', target: row.target, source: 'bar',
    exitOwn: { side: closeAction(row), units: [row.units], product: 'INTRADAY' },
  });
  if (typeof order === 'string') return { ok: false, error: order, ledger: addLog(patchRow(l, row.id, { status: 'open' }), 'error', `Exit not sent: ${order}`, now) };
  const r = await placePnfMarket(order, 'pnf', 'orba');
  const outcome = String(r.body.outcome ?? '');
  const msg = String(r.body.message ?? r.body.error ?? '');
  if (outcome === 'placed' || outcome === 'flat') {
    const flat = outcome === 'flat' ? 'nothing was left at the broker (closed outside this page)' : undefined;
    const note = [flat, mark.note].filter(Boolean).join('; ') || undefined;
    l = addLog({ ...closeRow(l, row.id, mark.px, req.reason, now), ...tag, rejects: 0 }, 'trade', `REAL exit ${row.side}: ${what} @ ~${mark.px} - ${req.reason}${note ? ` (${note})` : ''}`, now);
    if (note) l = patchRow(l, row.id, { note });
    return { ok: true, ledger: lossCheck(l, now) };
  }
  if (outcome === 'unknown' || r.status === 504) {
    l = patchRow(l, row.id, { status: 'unknown', note: `exit unknown: ${msg}` });
    return { ok: false, unknown: true, error: msg, ledger: halt(l, `Exit outcome UNKNOWN - check the ${row.broker} positions: ${msg}`, now) };
  }
  // refused (incl. 409 busy / session down): the position is still open, the next tick retries the exit
  return { ok: false, error: msg, ledger: bumpReject(patchRow(l, row.id, { status: 'open' }), `Exit refused: ${msg}`, now) };
}

function lossCheck(l: OrbLedger, now: number): OrbLedger {
  const day = istDateIso(now);
  return realisedToday(l, l.mode, day) <= -l.config.dailyLossLimit && l.engineActive
    ? halt(l, `Daily loss limit ₹${l.config.dailyLossLimit} reached`, now) : l;
}
