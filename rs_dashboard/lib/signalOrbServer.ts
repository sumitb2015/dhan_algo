import { writeJsonAtomic } from '@/lib/lockedJsonFile';
import { globalOnce } from '@/lib/globalOnce';
import { istDateIso } from '@/lib/nseHolidays';
import { expiriesFor } from '@/lib/pnfContracts';
import { placePnfMarket } from '@/lib/pnfAutoOrders';
import { brokerLegs, resolvePnfLegs } from '@/lib/pnfOrderServer';
import { parsePnfOrder } from '@/lib/pnfOrderLogic';
import { MCX_LOT_MULTIPLIER } from '@/lib/positionPnl';
import type { Target } from '@/lib/pnfTarget';
import { ORB_CODE_VERSION, type Side } from '@/lib/signalOrb';
import { ORB_STATE_FILE, readOrbLedger } from '@/lib/signalOrbFile';
import {
  MAX_ORB_LOTS, MAX_REJECTS, addLog, applyClientOp, closeRow, halt, liveRow, patchRow, realisedToday, trimRows, type OrbLedger, type OrbRow,
} from '@/lib/signalOrbLedger';

// The Signal Orb's server: the one writer of debug/signal_orb_state.json, and its order path. Real money. Every mutation (client op
// or trade) runs on one in-process chain, so a trade and a config write never interleave. The browser names only WHAT to do
// (enter LONG, exit, reverse) and the decision price; contract, lots, broker quantity and the exit size come from the ledger and the
// broker's own lot here. A row is written BEFORE its order is sent, so a crash mid-send leaves a 'sending' row, never a lost position.

export const ORB_SYMBOL = 'CRUDEOILM';
const UNITS_PER_LOT = MCX_LOT_MULTIPLIER[ORB_SYMBOL] ?? 10;

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

/** The future the page trades: the nearest CRUDEOILM expiry after today (an expiring contract is never opened on its last day). */
export function orbContract(nowMs = Date.now()): Target | null {
  const today = istDateIso(nowMs);
  const exp = expiriesFor('futures', ORB_SYMBOL).find(e => e > today);
  return exp ? { kind: 'futures', symbol: ORB_SYMBOL, name: ORB_SYMBOL, expiry: exp } : null;
}

export function orbState(): Reply {
  const ledger = readOrbLedger();
  const live = liveRow(ledger);
  // An open row pins the contract (its exit must go to the contract it was opened on).
  const contract = live?.target ?? orbContract();
  return { status: 200, body: { success: true, ledger, contract, unitsPerLot: UNITS_PER_LOT, maxLots: MAX_ORB_LOTS, today: istDateIso(Date.now()), codeVersion: ORB_CODE_VERSION } };
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
    const out = await enterRow(l, req.side!, req.price, req.reason, now, day);
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

async function enterRow(l0: OrbLedger, side: Side, price: number, reason: string, now: number, day: string): Promise<Step> {
  const target = orbContract(now);
  if (!target) return { ok: false, error: `No live ${ORB_SYMBOL} future in the master list`, ledger: addLog(l0, 'error', 'No contract', now) };
  const { mode, config } = l0;
  const lots = Math.min(config.lots, MAX_ORB_LOTS);
  const row: OrbRow = {
    id: `orb-${now}`, mode, broker: config.broker, target, side, lots, units: 0, unitsPerLot: UNITS_PER_LOT,
    entry: price, entryAt: now, day, status: mode === 'SIM' ? 'open' : 'sending', ...(mode === 'SIM' ? {} : { sentAt: now }),
  };
  // a new entry means the stop-out block was lifted (the colour changed since the stop): it is cleared here
  let l: OrbLedger = { ...l0, rows: [...l0.rows, row], blockedSide: null };
  if (mode === 'SIM') return { ok: true, ledger: addLog({ ...l, rejects: 0 }, 'trade', `SIM ${side} ${lots} @ ${price} - ${reason}`, now) };

  // REAL: the 'sending' row is on disk before the order leaves
  save(l, now);
  const legs = resolvePnfLegs(target);
  if (typeof legs === 'string') return { ok: false, error: legs, ledger: bumpReject(patchRow(l, row.id, { status: 'failed', note: legs }), legs, now) };
  const onBroker = await brokerLegs(config.broker, target, legs).catch((e: Error) => `Contract lookup failed: ${e.message}`);
  if (typeof onBroker === 'string') return { ok: false, error: onBroker, ledger: bumpReject(patchRow(l, row.id, { status: 'failed', note: onBroker }), onBroker, now) };
  const order = parsePnfOrder({ broker: config.broker, mode: 'REAL', target, action: side === 'LONG' ? 'BUY' : 'SELL', lots, product: 'INTRADAY', source: 'bar' });
  if (typeof order === 'string') return { ok: false, error: order, ledger: bumpReject(patchRow(l, row.id, { status: 'failed', note: order }), order, now) };
  const r = await placePnfMarket(order, 'pnf', 'orba');
  const outcome = String(r.body.outcome ?? '');
  const msg = String(r.body.message ?? r.body.error ?? '');
  const units = lots * onBroker[0].lotUnits;
  if (outcome === 'placed') {
    l = addLog(patchRow({ ...l, rejects: 0 }, row.id, { status: 'open', units }), 'trade', `REAL ${side} ${lots} @ ~${price} - ${reason}`, now);
    return { ok: true, ledger: l };
  }
  if (outcome === 'unknown' || r.status === 504) {
    l = patchRow(l, row.id, { status: 'unknown', units, note: msg });
    return { ok: false, unknown: true, error: msg, ledger: halt(l, `Entry outcome UNKNOWN - check the ${config.broker} order book: ${msg}`, now) };
  }
  return { ok: false, error: msg, ledger: bumpReject(patchRow(l, row.id, { status: 'failed', note: msg }), `Entry refused: ${msg}`, now) };
}

async function exitRow(l0: OrbLedger, row: OrbRow, req: TradeRequest, now: number): Promise<Step> {
  const tag = req.exitKind === 'stop' ? { blockedSide: row.side } : {};
  if (row.mode === 'SIM') {
    const l = addLog({ ...closeRow(l0, row.id, req.price, req.reason, now), ...tag }, 'trade', `SIM exit ${row.side} @ ${req.price} - ${req.reason}`, now);
    return { ok: true, ledger: lossCheck(l, now) };
  }
  let l = patchRow(l0, row.id, { status: 'closing', sentAt: now });
  save(l, now);
  const order = parsePnfOrder({
    broker: row.broker, mode: 'REAL', target: row.target, source: 'bar',
    exitOwn: { side: row.side === 'LONG' ? 'SELL' : 'BUY', units: [row.units], product: 'INTRADAY' },
  });
  if (typeof order === 'string') return { ok: false, error: order, ledger: addLog(patchRow(l, row.id, { status: 'open' }), 'error', `Exit not sent: ${order}`, now) };
  const r = await placePnfMarket(order, 'pnf', 'orba');
  const outcome = String(r.body.outcome ?? '');
  const msg = String(r.body.message ?? r.body.error ?? '');
  if (outcome === 'placed' || outcome === 'flat') {
    const note = outcome === 'flat' ? 'nothing was left at the broker (closed outside this page)' : undefined;
    l = addLog({ ...closeRow(l, row.id, req.price, req.reason, now), ...tag, rejects: 0 }, 'trade', `REAL exit ${row.side} @ ~${req.price} - ${req.reason}${note ? ` (${note})` : ''}`, now);
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
