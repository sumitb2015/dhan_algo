import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DEBUG_DIR, resolveCsvPath } from '@/lib/ivSnapshotFiles';
import { withFileLock, readJsonFile, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { istToday } from '@/lib/istTime';
import { isRegularSession } from '@/lib/nseHolidays';
import { mcxSession } from '@/lib/mcxSession';
import { MCX_LOT_MULTIPLIER } from '@/lib/positionPnl';
import { resolveOption } from '@/lib/pnfContracts';
import { fetchLtps } from '@/lib/dhanEquityQuote';
import { wsPrice, wsSync, wsWant } from '@/lib/freshMoneyWs';
import { dedupe } from '@/lib/pyExec';
import { parsedDay } from '@/lib/freshMoneyFiles';
import {
  BROKERS, brokerContract, brokerName, brokerNets, brokerSessionOk, newCorrelationId, readOrder, sendOrder,
} from '@/lib/freshMoneyBrokers';
import {
  brokerUnits, buildPositions, closeQty, contractHold, contractSettling, dueForCheck, effectiveState, hhmmToMin,
  inFlightReducing, nextCheckDelay, orderKey, reconcileDownQty, sessionGate, sessionMessage, slices, unconfirmedQty,
  NSE_WINDOW, SENDING_STALE_MS, UNKNOWN_HOLD_MS, FM_MAX_LOTS_PER_ORDER, FM_MAX_POSITION_LOTS,
  type FmBroker, type FmLedger, type FmOrder, type FmPosition, type FmSegment, type OptType, type SessionGate,
  type TradeWindow, type TxnSide,
} from '@/lib/freshMoneyTrades';

/**
 * REAL MONEY. The Fresh Money board's B / S buttons: MARKET, intraday option orders on Dhan, Kotak or Zerodha (the
 * page's broker picker; lib/freshMoneyBrokers.ts). Prices, the board and the contract check are Dhan's whatever the
 * broker; the order quantity is in the chosen broker's own unit (brokerUnits), checked against its own master.
 *
 * The browser sends only underlying, expiry, strike, CE/PE, BUY/SELL and lots. The contract (security id, lot) is
 * resolved here from master_list.csv, and only for a strike and expiry that today's board snapshot actually shows, so
 * the page can never trade something it is not displaying. Lots are capped per order and per position (unconfirmed
 * orders counted as if they fill). NSE: new positions 09:15-15:17 IST on a regular session, closes until 15:30.
 * MCX (CRUDEOIL / CRUDEOILM): new positions from the open until the MIS auto-exit, closes until the close
 * (lib/mcxSession.ts: 23:30 / 23:55 by US DST, MCX holidays). MCX order quantity is LOTS (Dhan), and P&L is
 * multiplied by barrels per lot (MCX_LOT_MULTIPLIER) — dhan-crudeoil-trading.
 *
 * Ledger: debug/fresh_money_trades.json, this page's own orders (ownership + P&L basis). Every order is written as
 * 'sending' BEFORE it goes out, so a crash mid-send leaves an UNKNOWN record rather than nothing.
 */

const LEDGER = path.join(DEBUG_DIR, 'fresh_money_trades.json');
const LOCK = `${LEDGER}.lock`;
const LOCK_STALE_MS = 15_000;
/** SENSEX is BSE; the contract resolver covers NSE and MCX only, so its board is watch-only. */
const TRADABLE = new Set(['NIFTY', 'BANKNIFTY', 'CRUDEOIL', 'CRUDEOILM']);
const isMcx = (u: string) => MCX_LOT_MULTIPLIER[u] !== undefined;
const IDEMPOTENCY_TTL_MS = 60_000;
/** Broker reads per refresh, and the least gap between refreshes (every tab's poll shares one refresh). */
const READS_PER_REFRESH = 4;
const REFRESH_GAP_MS = 2_000;

/** Today's trading window for this underlying's market, or null when that market is shut today. */
function windowFor(underlying: string): TradeWindow | null {
  const today = istToday();
  if (!isMcx(underlying)) return isRegularSession(today) ? NSE_WINDOW : null;
  const m = mcxSession(today);
  if (m.open >= m.close) return null;
  return { open: hhmmToMin(m.open), cutoff: hhmmToMin(m.autoExit), close: hhmmToMin(m.close) };
}
const marketName = (u: string) => (isMcx(u) ? 'MCX' : 'NSE');
const gateNow = (u: string): SessionGate => sessionGate(Date.now(), windowFor(u));
const gateMessage = (u: string, gate: SessionGate) => sessionMessage(gate, windowFor(u), marketName(u));

// ── ledger ────────────────────────────────────────────────────────────────────────────────────────────────────────

function loadLedger(): FmLedger {
  const today = istToday();
  const l = readJsonFile<FmLedger>(LEDGER);
  if (l && l.date === today && Array.isArray(l.orders)) return l;
  // Day roll: INTRADAY positions are squared off by the broker; keep yesterday's file for the record.
  if (l && l.date && l.date !== today) {
    try { fs.renameSync(LEDGER, path.join(DEBUG_DIR, `fresh_money_trades_${l.date}.json`)); } catch { /* raced */ }
  }
  return { date: today, orders: [] };
}

const mutate = <T>(fn: (l: FmLedger) => T): Promise<T> =>
  withFileLock(LOCK, LOCK_STALE_MS, 'Fresh Money ledger', () => {
    const l = loadLedger();
    const out = fn(l);
    writeJsonAtomic(LEDGER, l, { pretty: true });
    return out;
  });

// ── board: the expiry and strikes the page is showing ─────────────────────────────────────────────────────────────

/** A board this many minutes behind the clock (while its market is open) is stale: no new positions from it. */
const BOARD_STALE_MIN = 3;

/** Today's live board for `underlying`: its expiry, the strikes of the last snapshot and that snapshot's time (IST
 *  minutes). Null when there is none today, or when today's file is a 1-minute backfill (the board never shows those). */
async function todaysBoard(underlying: string): Promise<{ expiry: string; strikes: Set<number>; lastMin: number } | null> {
  const file = resolveCsvPath(underlying, istToday(), true);
  if (!file) return null;
  const p = await parsedDay(file, true);
  const last = p?.snaps?.[p.snaps.length - 1];
  if (!p || !p.cumulative || !last || p.expiry < istToday()) return null;
  return { expiry: p.expiry, strikes: new Set(last.strikes.keys()), lastMin: last.min };
}

const istMinuteNow = () => { const d = new Date(Date.now() + 19_800_000); return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60; };

// ── broker reads ──────────────────────────────────────────────────────────────────────────────────────────────────

let restCache: { at: number; ids: string; data: Record<string, number> } | null = null;

/**
 * Option LTPs for P&L: the WebSocket first (lib/freshMoneyWs.ts — asked for every open position, so its subscription is
 * kept alive while the position is open), REST only for the ones without a usable WebSocket price yet (a fresh
 * subscription, the bridge starting, the hub down). `source` says which one each price came from.
 */
async function ltpsFor(items: { id: string; segment: FmSegment }[]): Promise<{ ltps: Record<string, number>; source: Record<string, 'ws' | 'rest'> }> {
  const ltps: Record<string, number> = {};
  const source: Record<string, 'ws' | 'rest'> = {};
  if (!items.length) { wsSync(); return { ltps, source }; }
  const missing: { id: string; segment: FmSegment }[] = [];
  for (const i of items) {
    const q = wsPrice(wsWant(i.segment, i.id));
    if (q) { ltps[i.id] = q.ltp; source[i.id] = 'ws'; } else missing.push(i);
  }
  wsSync();
  if (!missing.length) return { ltps, source };
  const key = missing.map(i => `${i.segment}:${i.id}`).sort().join(',');
  let rest: Record<string, number> = {};
  if (restCache && restCache.ids === key && Date.now() - restCache.at < 1_500) rest = restCache.data;
  else {
    try {
      for (const seg of ['NSE_FNO', 'MCX_COMM'] as const) {
        const ids = missing.filter(i => i.segment === seg).map(i => i.id);
        if (ids.length) Object.assign(rest, await fetchLtps(seg, ids));
      }
      restCache = { at: Date.now(), ids: key, data: rest };
    } catch {
      rest = restCache && restCache.ids === key ? restCache.data : {};
    }
  }
  for (const i of missing) if (rest[i.id] > 0) { ltps[i.id] = rest[i.id]; source[i.id] = 'rest'; }
  return { ltps, source };
}

// Per-order re-read schedule (backoff), so a few settled-late orders cannot hog the reads and none is starved.
const nextAt = new Map<string, number>();
const attempts = new Map<string, number>();
let lastRefresh = 0;

/** When to read an unsettled order next. A record with no order id is looked up every 2 s from the moment it can be
 *  UNKNOWN until its hold has run out (so a late booking is adopted before new orders on the contract are allowed),
 *  then with backoff. Before that ('sending', not yet stale) there is nothing to look up. */
function nextReadAt(o: FmOrder, now: number, attempts: number, changed: boolean): number {
  if (!o.orderId) {
    const staleAt = o.ts + SENDING_STALE_MS;
    if (now < staleAt) return staleAt;
    if (now < o.ts + UNKNOWN_HOLD_MS + 60_000) return now + 2_000;
  }
  return now + (changed ? 2_000 : nextCheckDelay(attempts));
}

/** Bring unsettled orders up to date: at most READS_PER_REFRESH due orders, oldest due first, with backoff. */
async function refreshOrders(): Promise<void> {
  const now = Date.now();
  if (now - lastRefresh < REFRESH_GAP_MS) return;
  lastRefresh = now;
  const ledger = loadLedger();
  const due = dueForCheck(ledger.orders, nextAt, now, READS_PER_REFRESH);
  const updates = new Map<string, Partial<FmOrder>>();
  for (const o of due) {
    let patch: Partial<FmOrder> | null = null;
    try { patch = await readOrder(o, effectiveState(o, Date.now()) === 'unknown'); } catch { /* unreadable (429, network): back off */ }
    const n = patch ? 0 : (attempts.get(o.id) ?? 0) + 1;
    attempts.set(o.id, n);
    nextAt.set(o.id, nextReadAt({ ...o, ...(patch ?? {}) }, Date.now(), n, !!patch));
    if (patch) updates.set(o.id, patch);
  }
  if (!updates.size) return;
  await mutate(l => {
    for (const o of l.orders) {
      const u = updates.get(o.id);
      if (u) Object.assign(o, u);
    }
  });
}

// ── down-only reconcile against the broker ───────────────────────────────────────────────────────────────────────

/** Positions-book reads for the reconcile, per broker (Kotak's book is rate limited, so it is read less often). */
const RECONCILE_GAP_MS: Record<FmBroker, number> = { dhan: 5_000, kotak: 15_000, zerodha: 10_000 };
const lastReconcile = new Map<FmBroker, number>();

/**
 * Write this page's positions DOWN to what each broker still holds (Invariant 2): an MIS auto square-off or a close from
 * another desk otherwise leaves a phantom position that is marked to market and counted toward the cap. The reduction
 * is a synthetic `external` record with an unknown price (the day's booked P&L then reads unknown, never a guess).
 * Skipped for a contract with an order in flight or placed in the last 20 s, and when the positions read fails.
 */
async function reconcileWithBrokers(): Promise<void> {
  const now = Date.now();
  const ledger = loadLedger();
  const open = buildPositions(ledger.orders, {}, now).filter(p => p.netQty !== 0 && !contractSettling(ledger.orders, p.key, now));
  for (const b of BROKERS) {
    const mine = open.filter(p => p.broker === b);
    if (!mine.length || now - (lastReconcile.get(b) ?? 0) < RECONCILE_GAP_MS[b] || !brokerSessionOk(b)) continue;
    lastReconcile.set(b, now);
    const nets = await brokerNets(b);
    if (!nets) continue;
    if (!mine.some(p => reconcileDownQty(p.netQty, nets.get(p.securityId) ?? 0, false) > 0)) continue;
    await mutate(l => {
      // Re-decide against the ledger as it is inside the lock: an order may have been placed meanwhile.
      const t = Date.now();
      for (const p of buildPositions(l.orders, {}, t)) {
        if (p.broker !== b) continue;
        const drop = reconcileDownQty(p.netQty, nets.get(p.securityId) ?? 0, contractSettling(l.orders, p.key, t));
        if (drop <= 0) continue;
        l.orders.push({
          id: randomUUID(), ts: t, underlying: p.underlying, expiry: p.expiry, strike: p.strike, opt: p.opt,
          securityId: p.securityId, broker: p.broker, priceId: p.priceId, segment: p.segment, lot: p.lot, mult: p.mult,
          side: p.netQty > 0 ? 'SELL' : 'BUY', qty: drop, close: true, external: true, correlationId: 'external',
          orderId: null, state: 'filled', filledQty: drop, avgPrice: null,
          reason: `Closed outside this page: ${brokerName(b)} no longer shows this quantity (MIS auto square-off or another desk)`,
        });
      }
    }).catch(() => {});
  }
}

// ── GET: orders, positions ────────────────────────────────────────────────────────────────────────────────────────

export interface FreshMoneyTradeState {
  date: string;
  tradable: string[];
  maxLots: number;
  maxPositionLots: number;
  /** Per underlying: 'open' = new positions allowed, 'close-only' after the cutoff, 'closed' outside the session. */
  sessions: Record<string, { gate: SessionGate; note: string | null }>;
  boardExpiry: Record<string, string | null>;
  /** Where each open position's LTP came from, by priceId: the WebSocket, or the REST fallback. */
  ltpSource: Record<string, 'ws' | 'rest'>;
  /** Whether each broker's session is usable (token present and not expired). */
  brokers: Record<FmBroker, boolean>;
  positions: FmPosition[];
  orders: (FmOrder & { effState: string })[];
}

async function buildState(): Promise<FreshMoneyTradeState> {
  await refreshOrders().catch(() => {});
  await reconcileWithBrokers().catch(() => {});
  const ledger = loadLedger();
  const now = Date.now();
  const pre = buildPositions(ledger.orders, {}, now);
  const { ltps, source: ltpSource } = await ltpsFor(pre.filter(p => p.netQty !== 0).map(p => ({ id: p.priceId, segment: p.segment })));
  const boardExpiry: Record<string, string | null> = {};
  for (const u of TRADABLE) boardExpiry[u] = (await todaysBoard(u).catch(() => null))?.expiry ?? null;
  const sessions: FreshMoneyTradeState['sessions'] = {};
  for (const u of TRADABLE) { const g = gateNow(u); sessions[u] = { gate: g, note: gateMessage(u, g) }; }
  return {
    date: ledger.date,
    tradable: [...TRADABLE],
    maxLots: FM_MAX_LOTS_PER_ORDER,
    maxPositionLots: FM_MAX_POSITION_LOTS,
    sessions,
    boardExpiry,
    ltpSource,
    brokers: { dhan: brokerSessionOk('dhan'), kotak: brokerSessionOk('kotak'), zerodha: brokerSessionOk('zerodha') },
    positions: buildPositions(ledger.orders, ltps, now),
    orders: ledger.orders.slice(-40).reverse().map(o => ({ ...o, effState: effectiveState(o, now) })),
  };
}

let stateCache: { at: number; body: FreshMoneyTradeState } | null = null;

export async function GET() {
  if (stateCache && Date.now() - stateCache.at < 900) return NextResponse.json(stateCache.body);
  const body = await dedupe('fm-trade-state', buildState);
  stateCache = { at: Date.now(), body };
  return NextResponse.json(body);
}

// ── POST: place / close ───────────────────────────────────────────────────────────────────────────────────────────

const idempotent = new Map<string, { at: number; result: Promise<NextResponse> }>();

type Reply =
  | { success: true; order_id: string; note?: string }
  | { success: false; error: string; unknown?: boolean; partial?: boolean };

function reply(r: Reply, status = 200) {
  return NextResponse.json(r, { status: !r.success && r.unknown ? 504 : status });
}

type OrderBase = Omit<FmOrder, 'id' | 'ts' | 'correlationId' | 'orderId' | 'state' | 'filledQty' | 'avgPrice'>;

/** Session, hold and position-cap checks against the ledger as it is inside the lock (two quick clicks cannot both
 *  pass). The cap counts unconfirmed orders (UNKNOWN / in flight) as if they fill. */
function precheck(l: FmLedger, base: OrderBase): string | null {
  const now = Date.now();
  const gate = gateNow(base.underlying);
  if (gate === 'closed' || (gate === 'close-only' && !base.close)) return gateMessage(base.underlying, gate);
  const key = orderKey(base);
  const hold = contractHold(l.orders, key, now);
  if (hold === 'unknown') return 'An earlier order on this contract has an UNKNOWN outcome — check Positions/Orders; new orders on it are held for a minute';
  if (hold === 'pending') return 'An earlier order on this contract is still being confirmed — try again in a moment';
  if (base.close) return null;
  const held = buildPositions(l.orders, {}, now).find(p => p.key === key)?.netQty ?? 0;
  const exposure = held + unconfirmedQty(l.orders, key, now);
  const after = exposure + (base.side === 'BUY' ? 1 : -1) * base.qty;
  if (Math.abs(after) > FM_MAX_POSITION_LOTS * base.lot && Math.abs(after) > Math.abs(exposure)) {
    return `That would take this contract past ${FM_MAX_POSITION_LOTS} lots (counting orders not yet confirmed)`;
  }
  return null;
}

type SendResult = { kind: 'placed'; orderId: string } | { kind: 'refused'; error: string; http: number }
  | { kind: 'rejected'; error: string; http: number } | { kind: 'unknown'; error: string };

/** Check + record (one lock) → send → record the outcome. */
async function sendOne(base: OrderBase, check = true): Promise<SendResult> {
  const id = randomUUID();
  const correlationId = newCorrelationId(base.broker ?? 'dhan');
  let refused: string | null;
  try {
    refused = await mutate(l => {
      const why = check ? precheck(l, base) : null;
      if (!why) l.orders.push({ ...base, id, ts: Date.now(), correlationId, orderId: null, state: 'sending', filledQty: 0, avgPrice: null });
      return why;
    });
  } catch (e) {
    return { kind: 'refused', error: `Nothing sent — ${String((e as Error).message ?? e)}`, http: 503 };
  }
  if (refused) return { kind: 'refused', error: refused, http: 409 };

  const r = await sendOrder({ ...base, correlationId }, !base.close);
  const patch: Partial<FmOrder> =
    r.status === 'placed' ? { state: 'pending', orderId: r.orderId }
      : r.status === 'unknown' ? { state: 'unknown', reason: r.error }
        : { state: 'rejected', reason: r.error };
  // If this write fails the record stays 'sending', reads as UNKNOWN after 30 s and is looked up again.
  await mutate(l => { const o = l.orders.find(x => x.id === id); if (o) Object.assign(o, patch); }).catch(() => {});
  stateCache = null;
  if (r.status === 'placed') return { kind: 'placed', orderId: r.orderId };
  if (r.status === 'unknown') return { kind: 'unknown', error: r.error };
  return { kind: 'rejected', error: r.error, http: r.http ?? 200 };
}

function replyFor(r: SendResult): NextResponse {
  if (r.kind === 'placed') return reply({ success: true, order_id: r.orderId });
  if (r.kind === 'unknown') return reply({ success: false, unknown: true, error: r.error });
  return reply({ success: false, error: r.error }, r.http);
}

interface OrderBody {
  action?: string;
  underlying?: string;
  expiry?: string;
  strike?: number;
  opt?: string;
  side?: string;
  lots?: number;
  broker?: string;
  /** Close: the position's key (`broker|contract`). `securityId` alone = a Dhan position (older pages). */
  key?: string;
  securityId?: string;
  idempotencyKey?: string;
}

async function placeOrder(b: OrderBody): Promise<NextResponse> {
  const underlying = String(b.underlying ?? '').toUpperCase();
  if (!TRADABLE.has(underlying)) return reply({ success: false, error: `${underlying || 'This underlying'} is watch-only on this board` }, 400);
  const opt: OptType | null = b.opt === 'CE' || b.opt === 'PE' ? b.opt : null;
  const side: TxnSide | null = b.side === 'BUY' || b.side === 'SELL' ? b.side : null;
  const strike = Number(b.strike);
  const lots = Number(b.lots);
  if (!opt || !side || !Number.isFinite(strike)) return reply({ success: false, error: 'opt (CE/PE), side (BUY/SELL) and strike are required' }, 400);
  if (!Number.isInteger(lots) || lots <= 0) return reply({ success: false, error: 'Lots must be a positive integer' }, 400);
  if (lots > FM_MAX_LOTS_PER_ORDER) return reply({ success: false, error: `Max ${FM_MAX_LOTS_PER_ORDER} lots per order` }, 400);
  const broker = (b.broker ?? 'dhan') as FmBroker;
  if (!BROKERS.includes(broker)) return reply({ success: false, error: `Unknown broker ${b.broker}` }, 400);
  if (!brokerSessionOk(broker)) return reply({ success: false, error: `${brokerName(broker)} is not logged in — nothing was sent` }, 409);
  const gate = gateNow(underlying);
  if (gate !== 'open') return reply({ success: false, error: gateMessage(underlying, gate)! }, 409);

  const board = await todaysBoard(underlying).catch(() => null);
  if (!board) return reply({ success: false, error: `No ${underlying} board snapshot today — the IV snapshot collector must be running to trade from this page` }, 409);
  if (b.expiry !== board.expiry) return reply({ success: false, error: `The board's expiry is ${board.expiry} now — refresh before trading` }, 409);
  if (!board.strikes.has(strike)) return reply({ success: false, error: `${strike} is not on today's board` }, 400);
  const behind = istMinuteNow() - board.lastMin;
  if (behind > BOARD_STALE_MIN) {
    return reply({ success: false, error: `The board's last snapshot is ${Math.floor(behind)} min old — is the collector running? No new positions from a stale board` }, 409);
  }

  const mcx = isMcx(underlying);
  const c = resolveOption(underlying, board.expiry, strike, opt);
  if (!c || c.segment !== (mcx ? 'MCX_COMM' : 'NSE_FNO') || !(c.lot > 0)) {
    return reply({ success: false, error: `No ${underlying} ${board.expiry} ${strike} ${opt} contract in the master list` }, 400);
  }
  // The same contract on the chosen broker, in that broker's own unit (checked against its own master).
  const bc = broker === 'dhan' ? null : await brokerContract(broker, underlying, board.expiry, strike, opt);
  if (broker !== 'dhan' && !bc) return reply({ success: false, error: `${brokerName(broker)} does not list ${underlying} ${board.expiry} ${strike} ${opt}` }, 400);
  const units = brokerUnits(broker, underlying, c.lot, bc?.brokerLot ?? null, mcx ? MCX_LOT_MULTIPLIER[underlying] : null);
  if ('error' in units) return reply({ success: false, error: units.error }, 400);
  return replyFor(await sendOne({
    underlying, expiry: board.expiry, strike, opt, broker, securityId: bc?.handle ?? c.securityId, priceId: c.securityId,
    segment: c.segment as FmSegment, lot: units.lot, mult: units.mult, side, qty: lots * units.lot, close: false,
  }));
}

async function closePosition(b: OrderBody): Promise<NextResponse> {
  const key = typeof b.key === 'string' && b.key ? b.key : `dhan|${String(b.securityId ?? '')}`;
  const ledger = loadLedger();
  const now = Date.now();
  const pos = buildPositions(ledger.orders, {}, now).find(p => p.key === key);
  if (!pos || pos.netQty === 0) return reply({ success: false, error: 'This page holds no open position on that contract' }, 400);
  const gate = gateNow(pos.underlying);
  if (gate === 'closed') return reply({ success: false, error: gateMessage(pos.underlying, gate)! }, 409);
  if (!brokerSessionOk(pos.broker)) return reply({ success: false, error: `${brokerName(pos.broker)} is not logged in — nothing was sent` }, 409);
  const hold = contractHold(ledger.orders, key, now);
  if (hold) {
    return reply({
      success: false,
      error: hold === 'unknown'
        ? 'An earlier order on this contract has an UNKNOWN outcome — check Positions/Orders before closing'
        : 'An earlier order on this contract is still being confirmed — try again in a moment',
    }, 409);
  }
  // Close only what is not already on its way out: a slow-to-confirm close must not be sent twice.
  const inFlight = inFlightReducing(ledger.orders, key, pos.netQty, now);
  const remaining = Math.max(0, Math.abs(pos.netQty) - inFlight);
  if (remaining === 0) {
    return reply({ success: false, error: 'A close for this position is already in flight (unconfirmed) — check Orders before sending another' }, 409);
  }
  const nets = await brokerNets(pos.broker);
  const qty = closeQty(Math.sign(pos.netQty) * remaining, nets ? nets.get(pos.securityId) ?? 0 : null);
  if (qty <= 0) {
    return reply({ success: false, error: `${brokerName(pos.broker)} shows no intraday position left in that direction — nothing was sent. It may have been closed elsewhere.` }, 409);
  }
  const side: TxnSide = pos.netQty > 0 ? 'SELL' : 'BUY';
  const parts = slices(qty, pos.lot);
  let placedQty = 0;
  let lastId = '';
  for (let i = 0; i < parts.length; i++) {
    // Later slices skip the hold check: the previous slice is still 'pending' by design.
    const r = await sendOne({
      underlying: pos.underlying, expiry: pos.expiry, strike: pos.strike, opt: pos.opt, broker: pos.broker,
      securityId: pos.securityId, priceId: pos.priceId, segment: pos.segment, lot: pos.lot, mult: pos.mult, side,
      qty: parts[i], close: true,
    }, i === 0);
    if (r.kind === 'placed') { placedQty += parts[i]; lastId = r.orderId; continue; }
    // Never send the next slice around a refusal or an UNKNOWN; say exactly what did go out.
    if (placedQty === 0) return replyFor(r);
    const done = `${placedQty} of ${qty} units were sent to close`;
    if (r.kind === 'unknown') return reply({ success: false, unknown: true, partial: true, error: `${done}; the next ${parts[i]} have UNKNOWN status. ${r.error}` });
    return reply({ success: false, partial: true, error: `${done}; the rest (${qty - placedQty}) was not: ${r.error}` });
  }
  return reply({ success: true, order_id: lastId, note: parts.length > 1 ? `${parts.length} orders, ${qty} units` : undefined });
}

export async function POST(req: NextRequest) {
  const b = (await req.json().catch(() => null)) as OrderBody | null;
  if (!b) return reply({ success: false, error: 'Invalid JSON body' }, 400);
  const run = () => (b.action === 'close' ? closePosition(b) : b.action === 'order' ? placeOrder(b)
    : Promise.resolve(reply({ success: false, error: 'action must be order or close' }, 400)));

  const key = typeof b.idempotencyKey === 'string' && b.idempotencyKey.length >= 8 && b.idempotencyKey.length <= 64 ? b.idempotencyKey : null;
  if (!key) return run();
  const now = Date.now();
  for (const [k, v] of idempotent) if (now - v.at > IDEMPOTENCY_TTL_MS) idempotent.delete(k);
  const prior = idempotent.get(key);
  if (prior) {
    try { return (await prior.result).clone(); } catch (err) {
      return reply({ success: false, error: `Order route error: ${String((err as Error).message ?? err)}`, unknown: true });
    }
  }
  const result = run();
  idempotent.set(key, { at: now, result });
  try {
    return (await result).clone();
  } catch (err) {
    idempotent.delete(key);
    return reply({ success: false, error: `Order route error: ${String((err as Error).message ?? err)}`, unknown: true });
  }
}
