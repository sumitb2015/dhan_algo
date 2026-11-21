import { writeJsonAtomic } from '@/lib/lockedJsonFile';
import { globalOnce } from '@/lib/globalOnce';
import { isNseSessionDay, istDateIso } from '@/lib/nseHolidays';
import { expiriesFor } from '@/lib/pnfContracts';
import { placePnfMarket } from '@/lib/pnfAutoOrders';
import { brokerLegs, resolvePnfLegs } from '@/lib/pnfOrderServer';
import { parsePnfOrder } from '@/lib/pnfOrderLogic';
import { MCX_LOT_MULTIPLIER } from '@/lib/positionPnl';
import { targetKey, type Target } from '@/lib/pnfTarget';
import { resolveOption } from '@/lib/pnfContracts';
import { pickTarget } from '@/lib/gearboxCore';
import { readBrokerOrder } from '@/lib/brokerOrderStatus';
import { enterLegs, exitLegs, premiumLegs, syntheticLegs, type LegDeps } from '@/lib/orbLegs';
import { premiumEntryCheck } from '@/lib/orbFocus';
import { isTradingDayFor } from '@/lib/focusToolUnderlyings';
import { istMinuteOfDay } from '@/lib/istTime';
import { orbMarginBlock } from '@/lib/orbMargin';
import { wsPrice, wsSync, wsWant } from '@/lib/freshMoneyWs';
import { ORB_CODE_VERSION, hhmmToMin, type Side } from '@/lib/signalOrb';
import { ORB_STATE_FILE, readOrbLedger } from '@/lib/signalOrbFile';
import {
  MAX_REJECTS, addLog, applyClientOp, closeRow, closeRowLegs, halt, isLegInstrument, isPremiumInstrument, legsAfterClose, liveRow, patchRow, realisedToday, rowInstrument, statusAfterUnknown, trimRows,
  type OrbBroker, type OrbConfig, type OrbLedger, type OrbLeg, type OrbRow, type OrbSymbol,
} from '@/lib/signalOrbLedger';

// The Signal Orb's server: the one writer of debug/signal_orb_state.json, and its order path. Real money. Every mutation (client op
// or trade) runs on one in-process chain, so a trade and a config write never interleave. The browser names only WHAT to do
// (enter LONG, exit, reverse) and the decision price; contract, lots, broker quantity and the exit size come from the ledger and the
// broker's own lot here. A row is written BEFORE its order is sent, so a crash mid-send leaves a 'sending' row, never a lost position.

/**
 * Rupees per point per lot: crude's barrels per lot (CRUDEOIL 100, CRUDEOILM 10), or NIFTY's master lot (it changes with NSE's
 * revisions, so it is read from the master through the contract's own leg, never hard-coded). 0 = it could not be resolved.
 */
export function unitsPerLotOf(sym: OrbSymbol, nowMs = Date.now()): number {
  if (sym !== 'NIFTY') return MCX_LOT_MULTIPLIER[sym] ?? (sym === 'CRUDEOIL' ? 100 : 10);
  const fut = orbContract(sym, nowMs);
  const legs = fut ? resolvePnfLegs(fut) : null;
  const u = legs && typeof legs !== 'string' ? legs[0]?.unitsPerLot : null;
  return u && u > 0 ? u : 0;
}
/**
 * REAL arm for the straddle / strangle (the server enters them with every tab closed, so the browser's per-page-load ARM cannot be
 * what allows it): set by an explicit ARM click, good for that IST day only, kept in memory so a dashboard restart disarms.
 */
const armed = globalOnce('signalOrb.armed', () => ({ day: '' }));
export const isArmedToday = (now: number): boolean => armed.day === istDateIso(now);

/** When an open straddle / strangle first had no live premium on a leg (0 = priced). In memory: the watcher and the state route share it. */
export const premiumBlind = globalOnce('signalOrb.premiumBlind', () => ({ since: 0, warnedAt: 0 }));

/** An option premium older than this (no change) is not used to book an entry. */
const OPT_FRESH_MS = 30_000;

export type Reply = { status: number; body: Record<string, unknown> };
const chain = globalOnce('signalOrb.chain', () => ({ p: Promise.resolve() as Promise<unknown> }));

/** Runs `fn` after every earlier mutation; its returned ledger (if any) is written with rev + 1. */
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.p.then(fn, fn);
  chain.p = run.catch(() => undefined);
  return run;
}

export function save(l: OrbLedger, now: number): OrbLedger {
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

export const lastPremium = globalOnce('signalOrb.lastPremium', () => new Map<string, number>());

/** The option's WebSocket key (subscribing it), or null when the master list has no such MCX contract. */
function optionKey(t: Target): string | null {
  if (t.kind !== 'options' || !t.expiry || !t.strike || (t.side !== 'CE' && t.side !== 'PE')) return null;
  const c = resolveOption(t.symbol, t.expiry, t.strike, t.side);
  return c ? wsWant(c.segment, c.securityId) : null;
}

/** The option's live premium, or null (no quote, or none fresh enough). Every quote seen is kept as the exit's fallback. */
export function optionLtp(t: Target, now: number, maxAgeMs = OPT_FRESH_MS): number | null {
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
  let legLtps: (number | null)[] | null = null;
  let optCandidates: Target[] = [];
  if (live?.legs) {
    // a multi-leg row: each open leg's live premium (a closed leg keeps the premium it closed at)
    legLtps = live.legs.map(g => (g.status === 'open' || g.status === 'unknown' ? optionLtp(g.target, now, Number.POSITIVE_INFINITY) : g.exit ?? null));
  } else if (live?.target.kind === 'options') {
    optLtp = optionLtp(live.target, now, Number.POSITIVE_INFINITY);
  } else if (!live && (ledger.config.instrument === 'options' || isLegInstrument(ledger.config.instrument)) && ledger.engineActive && contract) {
    // keep the options an entry could trade subscribed, so their premium has settled by the time a bar flips the orb
    const fk = contract.expiry ? optionFutureKey(contract) : null;
    const fp = fk ? wsPrice(fk)?.ltp ?? null : null;
    if (fp) {
      optCandidates = (['LONG', 'SHORT'] as const).flatMap(sd => {
        if (isPremiumInstrument(ledger.config.instrument)) {
          if (sd === 'SHORT') return [];   // one pair: not directional
          const g = premiumLegs(ledger.config.instrument as 'straddle' | 'strangle', ledger.config.symbol, ledger.config.strikeOffset, fp, today);
          return typeof g === 'string' ? [] : g.map(x => x.target);
        }
        if (ledger.config.instrument === 'synthetic') { const g = syntheticLegs(ledger.config.symbol, sd, fp, today); return typeof g === 'string' ? [] : g.map(x => x.target); }
        const t = orbOptionTarget(ledger.config, sd, fp, today);
        return typeof t === 'string' ? [] : [t];
      });
      for (const t of optCandidates) optionKey(t);
      wsSync();
    }
  }
  const unitsPerLot = live?.unitsPerLot ?? unitsPerLotOf(ledger.config.symbol, now);
  return { status: 200, body: { success: true, ledger, contract, unitsPerLot, optionLtp: optLtp, legLtps, armedToday: isArmedToday(now), premiumBlindMs: premiumBlind.since > 0 ? now - premiumBlind.since : 0, today, codeVersion: ORB_CODE_VERSION } };
}

/** The signal future's WebSocket key (subscribing it): the strike pick for the warm-up reads its price. */
export function optionFutureKey(fut: Target): string | null {
  if (!fut.expiry) return null;
  const legs = resolvePnfLegs(fut);
  if (typeof legs === 'string' || !legs[0] || legs[0].segment === 'NSE_EQ') return null;
  return wsWant(legs[0].segment, legs[0].securityId);
}

export function orbClientOp(op: unknown): Promise<Reply> {
  return serial(async () => {
    const now = Date.now();
    const kind = (op as { op?: unknown } | null)?.op;
    if (kind === 'arm' || kind === 'disarm') {
      if (kind === 'arm' && readOrbLedger().mode !== 'REAL') return fail('ARM applies to REAL mode only', 409);
      armed.day = kind === 'arm' ? istDateIso(now) : '';
      return { status: 200, body: { success: true, armedToday: kind === 'arm' } };
    }
    // any mode switch disarms: REAL is armed again by the user, never inherited
    if (kind === 'setMode') armed.day = '';
    const r = applyClientOp(readOrbLedger(), op, now);
    if (!r.ok) return { status: r.status, body: { success: false, error: r.error } };
    return { status: 200, body: { success: true, ledger: save(r.ledger, now) } };
  });
}

export type TradeRequest = {
  action: 'enter' | 'exit' | 'reverse' | 'enterNow';
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
  if (o.action !== 'enter' && o.action !== 'exit' && o.action !== 'reverse' && o.action !== 'enterNow') return 'action must be enter, exit, reverse or enterNow';
  // a straddle / strangle is sold on the server's own prices: nothing but the click is needed
  if (o.action === 'enterNow') return { action: 'enterNow', price: 1, reason: 'Enter now', auto: false };
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

/** What a synthetic entry trades and the premium of each leg (a missing quote on any leg refuses the whole entry: it retries next tick). */
type SynPick = { legs: { target: Target; action: 'BUY' | 'SELL'; premium: number }[] };

function pickSynthetic(l: OrbLedger, side: Side, futPrice: number, now: number, day: string): SynPick | string {
  const legs = syntheticLegs(l.config.symbol, side, futPrice, day);
  if (typeof legs === 'string') return legs;
  const out: SynPick['legs'] = [];
  for (const g of legs) {
    const premium = optionLtp(g.target, now);
    if (premium === null) return `No live premium for ${optLabel(g.target)} yet (WebSocket subscribing) - retrying`;
    out.push({ ...g, premium });
  }
  return { legs: out };
}

export const optLabel = (t: Target) => (t.kind === 'options' ? `${t.symbol} ${t.strike} ${t.side}` : `${t.symbol} FUT`);

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

    // a straddle / strangle is not signal-driven: it is sold on its own schedule (the server loop) or by Enter now
    if (req.action === 'enterNow') return orbEnterPremiumCore(l, now, true);
    if (isPremiumInstrument(l.config.instrument)) return fail('A straddle / strangle is not entered by the signal: it is sold at its entry time, or with Enter now', 409);
    // enter / reverse: automatic only, from a tab running this code, engine on, newer bar, loss limit
    if (req.v !== ORB_CODE_VERSION) return fail('This tab runs an older version of the Signal Orb - reload it (entries refused, exits still work)', 409);
    if (l.config.symbol === 'NIFTY' && !isNseSessionDay(day)) return fail('NSE is closed today - no NIFTY entries', 409);
    if (!l.engineActive) return fail(l.haltReason ? `Engine halted: ${l.haltReason}` : 'Auto is OFF', 409);
    if (req.barT! <= l.watermarkT) return fail('This bar was already acted on', 409);
    if (req.action === 'enter' && live) return fail('A position is already open', 409);
    if (req.action === 'reverse') {
      if (!live) return fail('Nothing to reverse', 409);
      if (live.status !== 'open') return fail(`The position is ${live.status.toUpperCase()}`, 409);
      if (live.side === req.side) return fail(`Already ${req.side}`, 409);
      if (live.day !== day) return fail('The open position is from an earlier day - close it by hand', 409);
      if (rowInstrument(live) !== l.config.instrument) return fail('The open position is not the configured instrument - close it by hand', 409);
    }
    // options: the strike and its premium must be known before anything is sent (a reversal never closes into a sale it cannot price)
    let opt: OptPick | null = null;
    if (l.config.instrument === 'options') {
      const p = pickOption(l, req.side!, req.price, now, day);
      if (typeof p === 'string') return fail(p, 409);
      opt = p;
    }
    let syn: SynPick | null = null;
    if (l.config.instrument === 'synthetic') {
      const p = pickSynthetic(l, req.side!, req.price, now, day);
      if (typeof p === 'string') return fail(p, 409);
      syn = p;
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
    const out = syn ? await enterStructure(l, 'synthetic', req.side!, req.price, syn, req.reason, now, day) : await enterRow(l, req.side!, req.price, opt, req.reason, now, day);
    l = out.ledger;
    return { status: out.ok ? 200 : out.unknown ? 504 : 502, body: { success: out.ok, error: out.error, ledger: save(l, now) } };
  });
}

export type Step = { ok: boolean; unknown?: boolean; error?: string; ledger: OrbLedger };

export function bumpReject(l: OrbLedger, msg: string, now: number): OrbLedger {
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
  const unitsPerLot = unitsPerLotOf(config.symbol, now);
  if (!(unitsPerLot > 0)) return { ok: false, error: `No lot size for ${config.symbol} in the master list`, ledger: addLog(l0, 'error', 'No lot size', now) };
  const target = opt ? opt.target : fut;
  const entry = opt ? opt.premium : futPrice;
  const lots = config.lots;
  const action = openAction(side, !!opt);
  const what = `${action} ${optLabel(target)} x${lots}`;
  const row: OrbRow = {
    id: `orb-${now}`, mode, broker: config.broker, target, side, lots, units: 0, unitsPerLot,
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
  if (row.legs) return exitStructure(l0, row, req, now);
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

export function lossCheck(l: OrbLedger, now: number): OrbLedger {
  const day = istDateIso(now);
  return realisedToday(l, l.mode, day) <= -l.config.dailyLossLimit && l.engineActive
    ? halt(l, `Daily loss limit ₹${l.config.dailyLossLimit} reached`, now) : l;
}

// ── Multi-leg rows (synthetic future) ───────────────────────────────────────────────────────────────────────────────────────

/** The real order path for a structure's legs: each leg is its own single-option market order through the P&F order layer (tag 'orba'). */
export const legDeps = (broker: OrbBroker): LegDeps => ({
  open: async p => {
    const order = parsePnfOrder({ broker, mode: 'REAL', target: p.target, action: p.action, lots: p.lots, product: 'INTRADAY', source: 'bar' }, { uncapped: true });
    return typeof order === 'string' ? { status: 400, body: { success: false, outcome: 'rejected', error: order } } : placePnfMarket(order, 'pnf', 'orba');
  },
  close: async c => {
    const order = parsePnfOrder({ broker, mode: 'REAL', target: c.target, source: 'bar', exitOwn: { side: c.action, units: [c.units], product: 'INTRADAY' } });
    return typeof order === 'string' ? { status: 400, body: { success: false, outcome: 'rejected', error: order } } : placePnfMarket(order, 'pnf', 'orba');
  },
  readOrder: id => readBrokerOrder(id, broker),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
});

const legWord = (g: { action: 'BUY' | 'SELL'; target: Target }) => `${g.action} ${optLabel(g.target)}`;

export async function enterStructure(l0: OrbLedger, structure: 'synthetic' | 'straddle' | 'strangle', side: Side, futPrice: number, pick: SynPick, reason: string, now: number, day: string): Promise<Step> {
  const { mode, config } = l0;
  const fut = orbContract(config.symbol, now);
  if (!fut) return { ok: false, error: `No live ${config.symbol} future in the master list`, ledger: addLog(l0, 'error', 'No contract', now) };
  const unitsPerLot = unitsPerLotOf(config.symbol, now);
  if (!(unitsPerLot > 0)) return { ok: false, error: `No lot size for ${config.symbol} in the master list`, ledger: addLog(l0, 'error', 'No lot size', now) };
  const lots = config.lots;
  const what = `${structure === 'synthetic' ? `${side} synthetic` : `short ${structure}`} ${pick.legs.map(legWord).join(' + ')} x${lots}`;
  const legs: OrbLeg[] = pick.legs.map(g => ({ target: g.target, action: g.action, entry: g.premium, units: 0, status: 'open' }));
  const row: OrbRow = {
    id: `orb-${now}`, mode, broker: config.broker, target: legs[0].target, side, lots, units: 0, unitsPerLot, entry: legs[0].entry,
    structure, legs, signalTarget: fut, signalEntry: futPrice,
    entryAt: now, day, status: mode === 'SIM' ? 'open' : 'sending', ...(mode === 'SIM' ? {} : { sentAt: now }),
  };
  // a new entry means the stop-out block was lifted (the colour changed since the stop): it is cleared here
  let l: OrbLedger = { ...l0, rows: [...l0.rows, row], blockedSide: null };
  if (mode === 'SIM') {
    // a paper leg still carries units (lots x the contract's lot): the straddle rules only judge a leg the row owns
    const simUnits = pick.legs.map(g => { const rl = resolvePnfLegs(g.target); return lots * (typeof rl === 'string' ? 1 : rl[0]?.lot ?? 1); });
    const paper = patchRow(l, row.id, { units: simUnits[0], legs: legs.map((g, i) => ({ ...g, units: simUnits[i] })) });
    return { ok: true, ledger: addLog({ ...paper, rejects: 0 }, 'trade', `SIM ${what} - ${reason}`, now) };
  }

  // (the config already refuses it; this keeps a hand-edited ledger from reaching a broker lookup)
  if (config.broker === 'zerodha') return { ok: false, error: 'Zerodha is not supported for this structure yet', ledger: addLog(l0, 'error', 'Entry not sent: Zerodha is not supported for this structure', now) };
  // REAL: contract units and funds are checked BEFORE the row is written or anything is sent (nothing to undo if they refuse)
  const lotUnits: number[] = [];
  for (const g of pick.legs) {
    const rl = resolvePnfLegs(g.target);
    if (typeof rl === 'string') return { ok: false, error: rl, ledger: addLog(l0, 'error', `Entry not sent: ${rl}`, now) };
    const onBroker = await brokerLegs(config.broker, g.target, rl).catch((e: Error) => `Contract lookup failed: ${e.message}`);
    if (typeof onBroker === 'string') return { ok: false, error: onBroker, ledger: addLog(l0, 'error', `Entry not sent: ${onBroker}`, now) };
    lotUnits.push(onBroker[0].lotUnits);
  }
  const block = await orbMarginBlock(config.broker, pick.legs.map((g, i) => ({ target: g.target, action: g.action, lots, lotUnits: lotUnits[i], unitsPerLot, premium: g.premium })));
  if (block) return { ok: false, error: block, ledger: addLog(l0, 'error', `Entry refused: ${block}`, now) };

  save(l, now);   // the 'sending' row is on disk before the first order leaves
  const res = await enterLegs(pick.legs.map((g, i) => ({ target: g.target, action: g.action, lots, lotUnits: lotUnits[i] })), legDeps(config.broker));
  const legsOut: OrbLeg[] = legs.map((g, i) => {
    const st = res.legs[i].state;
    return { ...g, units: lots * lotUnits[i], status: st === 'open' ? 'open' : st === 'unknown' ? 'unknown' : 'failed', ...(st === 'unknown' ? { note: 'outcome unknown' } : {}) };
  });
  const units = legsOut[0].units;
  if (res.ok) {
    l = addLog(patchRow({ ...l, rejects: 0 }, row.id, { status: 'open', units, legs: legsOut }), 'trade', `REAL ${what} - ${reason}`, now);
    return { ok: true, ledger: l };
  }
  if (res.unknown) {
    // a straddle / strangle whose OTHER leg is open stays 'open': that leg keeps its stops (the unknown one is never resent)
    l = patchRow(l, row.id, { status: statusAfterUnknown(row, legsOut), units, legs: legsOut, note: res.error });
    return { ok: false, unknown: true, error: res.error, ledger: halt(l, `Entry outcome UNKNOWN - check the ${config.broker} order book and positions: ${res.error}`, now) };
  }
  return { ok: false, error: res.error, ledger: bumpReject(patchRow(l, row.id, { status: 'failed', legs: legsOut, note: res.error }), `Entry refused: ${res.error}`, now) };
}

export async function exitStructure(l0: OrbLedger, row: OrbRow, req: TradeRequest, now: number): Promise<Step> {
  const tag = req.exitKind === 'stop' ? { blockedSide: row.side } : {};
  const legs = row.legs ?? [];
  // each leg's booking price: its live premium, else the last one seen; a leg with neither is booked at entry (and the note says so)
  let unpriced = false;
  const marks = legs.map(g => {
    if (g.status === 'closed') return g.exit ?? g.entry;
    const m = optionLtp(g.target, now, Number.POSITIVE_INFINITY) ?? lastPremium.get(targetKey(g.target)) ?? null;
    if (m === null) unpriced = true;
    return m;
  });
  const note = unpriced ? 'no premium quote on a leg: its P&L is booked at entry - check the broker fills' : undefined;
  const what = `exit ${row.structure === 'synthetic' ? `${row.side} synthetic` : `short ${row.structure}`} ${legs.map(g => `${g.action === 'BUY' ? 'SELL' : 'BUY'} ${optLabel(g.target)}`).join(' + ')}`;
  if (row.mode === 'SIM') {
    let l = addLog({ ...closeRowLegs(l0, row.id, marks, req.reason, now), ...tag }, 'trade', `SIM ${what} - ${req.reason}`, now);
    if (note) l = patchRow(l, row.id, { note });
    return { ok: true, ledger: lossCheck(l, now) };
  }
  let l = patchRow(l0, row.id, { status: 'closing', sentAt: now });
  save(l, now);
  const todo = legs.map((g, i) => ({ g, i })).filter(x => x.g.status === 'open');
  const res = await exitLegs(todo.map(x => ({ target: x.g.target, action: x.g.action, units: x.g.units })), legDeps(row.broker));
  // per-leg bookkeeping: a closed leg is booked, the rest stay open for the next try
  const after = legs.map(g => ({ ...g }));
  for (const r of res.legs) {
    const i = todo[r.index].i;
    if (r.state === 'closed') after[i] = { ...after[i], status: 'closed', exit: marks[i] ?? after[i].entry };
    else if (r.state === 'unknown') after[i] = { ...after[i], status: 'unknown', note: 'exit unknown' };
  }
  if (res.ok) {
    const flat = res.legs.some(r => r.flat) ? 'a leg was already flat at the broker (closed outside this page)' : undefined;
    const notes = [flat, note].filter(Boolean).join('; ') || undefined;
    l = addLog({ ...closeRowLegs(patchRow(l, row.id, { legs: after }), row.id, marks, req.reason, now), ...tag, rejects: 0 }, 'trade', `REAL ${what} - ${req.reason}${notes ? ` (${notes})` : ''}`, now);
    if (notes) l = patchRow(l, row.id, { note: notes });
    return { ok: true, ledger: lossCheck(l, now) };
  }
  if (res.unknown) {
    // the legs the loop never reached stay open (and judged); only the unknown one waits for the user
    l = patchRow(l, row.id, { status: statusAfterUnknown(row, after), legs: after, note: `exit unknown: ${res.error}` });
    return { ok: false, unknown: true, error: res.error, ledger: halt(l, `Exit outcome UNKNOWN - check the ${row.broker} positions: ${res.error}`, now) };
  }
  // refused part-way: the legs that did close are booked, the rest are still open and the next tick retries them
  return { ok: false, error: res.error, ledger: bumpReject(patchRow(l, row.id, { status: 'open', legs: after }), `Exit refused: ${res.error}`, now) };
}

// ── Straddle / strangle: the server sells and manages them (lib/orbFocus.ts decides, the Focus Tool's own rules) ───────────────

export type SideQuote = { ltp: number; ageMs: number };

/** The signal future's live price for strike selection: fresh, else null. */
function futureNow(symbol: OrbSymbol, now: number): number | null {
  const fut = orbContract(symbol, now);
  const key = fut ? optionFutureKey(fut) : null;
  if (!key) return null;
  wsSync();
  const p = wsPrice(key);
  return p && now - (p.changedMs ?? p.sinceMs) <= 15_000 ? p.ltp : null;
}

/**
 * Sells the configured straddle / strangle. `manual` = the Enter now click (no entry-time wait; still needs a trading day, the
 * cutoff not reached and, in REAL, the ARM). The automatic path also needs Auto on and the day's single entry still unused.
 * Call inside `serial`.
 */
export async function orbEnterPremiumCore(l: OrbLedger, now: number, manual: boolean): Promise<Reply> {
  const cfg = l.config;
  const day = istDateIso(now);
  if (!isPremiumInstrument(cfg.instrument)) return fail('Trade is not set to Straddle or Strangle', 409);
  if (liveRow(l)) return fail('A position is already open', 409);
  if (l.haltReason) return fail(`Engine halted: ${l.haltReason}`, 409);
  if (!manual && l.premiumEntryDay === day) return fail('Already entered today', 409);
  if (l.mode === 'REAL' && !isArmedToday(now)) return fail('REAL is not armed - press ARM first', 409);
  const minute = istMinuteOfDay(now);
  const nowHm = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const gate = premiumEntryCheck({
    entryTime: manual ? '00:00' : cfg.premium.entryTime, cutoffHm: cfg.eodExit, nowHm, autoOn: manual ? true : l.engineActive, flat: true,
    tradingDay: isTradingDayFor(cfg.symbol === 'NIFTY' ? 'NIFTY' : 'CRUDEOILM', day),
  });
  if (!gate.enter) return fail(gate.reason, 409);
  if (!manual && minute >= hhmmToMin(cfg.entryEnd)) return fail(`past the entry window (${cfg.entryEnd})`, 409);
  const fp = futureNow(cfg.symbol, now);
  if (fp === null) return fail('No live future price on the server yet - retrying', 409);
  const legs = premiumLegs(cfg.instrument as 'straddle' | 'strangle', cfg.symbol, cfg.strikeOffset, fp, day);
  if (typeof legs === 'string') return fail(legs, 409);
  const picked: SynPick['legs'] = [];
  for (const g of legs) {
    const premium = optionLtp(g.target, now);
    if (premium === null) return fail(`No live premium for ${optLabel(g.target)} yet (WebSocket subscribing) - retrying`, 409);
    picked.push({ ...g, premium });
  }
  const out = await enterStructure(l, cfg.instrument as 'straddle' | 'strangle', 'SHORT', fp, { legs: picked }, manual ? 'Enter now' : `Entry ${cfg.premium.entryTime}`, now, day);
  // a row exists (sent, refused or unknown): that is the day's entry. A margin / contract refusal wrote no row and may retry.
  const latched = out.ledger.rows.length > l.rows.length ? { ...out.ledger, premiumEntryDay: day } : out.ledger;
  return { status: out.ok ? 200 : out.unknown ? 504 : 502, body: { success: out.ok, error: out.error, ledger: save(latched, now) } };
}

/** The automatic entry (the loop): serialised with every other mutation, re-reads the ledger inside the chain. */
export function orbEnterPremiumAuto(): Promise<Reply> {
  return serial(async () => orbEnterPremiumCore(readOrbLedger(), Date.now(), false));
}

/**
 * Closes ONE leg of a straddle / strangle (its SL, its target or its cost stop). After an SL the other open leg gets its cost stop
 * (when SL-to-cost is on); when no leg is left open the row is closed. Call inside `serial`.
 */
export async function exitOneLeg(l0: OrbLedger, row: OrbRow, index: number, why: 'sl' | 'tgt' | 'cost', reason: string, now: number): Promise<Step> {
  const legs = row.legs ?? [];
  const g = legs[index];
  if (!g || g.status !== 'open') return { ok: true, ledger: l0 };
  const mark = optionLtp(g.target, now, Number.POSITIVE_INFINITY) ?? lastPremium.get(targetKey(g.target)) ?? null;
  const px = mark ?? g.entry;
  const note = mark === null ? 'no premium quote: this leg is booked at entry - check the broker fill' : undefined;
  const word = `${g.action === 'BUY' ? 'SELL' : 'BUY'} ${optLabel(g.target)}`;
  const finish = (l: OrbLedger, tagWord: string): Step => {
    // after a leg's SL, the other open leg gets its cost stop (Focus: SL to cost) when that option is on
    const c = legsAfterClose(legs, index, px, why === 'sl' && l0.config.premium.slToCost);
    let out = patchRow(l, row.id, { legs: c.legs, status: 'open', note });
    if (!c.anyHeld) {
      out = closeRowLegs(out, row.id, c.legs.map(x => x.exit ?? null), `${reason}`, now);
      out = lossCheck(addLog({ ...out, rejects: 0 }, 'trade', `${tagWord} exit (last leg) ${word} @ ${px} - ${reason}`, now), now);
    } else {
      out = addLog({ ...out, rejects: 0 }, 'trade', `${tagWord} leg ${why.toUpperCase()} ${word} @ ${px} - ${reason}`, now);
    }
    return { ok: true, ledger: out };
  };
  if (row.mode === 'SIM') return finish(l0, 'SIM');
  let l = patchRow(l0, row.id, { status: 'closing', sentAt: now });
  save(l, now);
  const res = await exitLegs([{ target: g.target, action: g.action, units: g.units }], legDeps(row.broker));
  if (res.ok) return finish(l, 'REAL');
  if (res.unknown) {
    // only this leg is unknown: the other leg stays open and keeps being judged; this one is never resent
    const unk = legs.map((x, i) => (i === index ? { ...x, status: 'unknown' as const, note: 'exit unknown' } : x));
    l = patchRow(l, row.id, { legs: unk, status: statusAfterUnknown(row, unk), note: `leg exit unknown: ${res.error}` });
    return { ok: false, unknown: true, error: res.error, ledger: halt(l, `Leg exit outcome UNKNOWN - check the ${row.broker} positions: ${res.error}`, now) };
  }
  return { ok: false, error: res.error, ledger: bumpReject(patchRow(l, row.id, { status: 'open' }), `Leg exit refused: ${res.error}`, now) };
}
