import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DEBUG_DIR, resolveCsvPath } from '@/lib/ivSnapshotFiles';
import { withFileLock, readJsonFile, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { istToday } from '@/lib/istTime';
import { isRegularSession } from '@/lib/nseHolidays';
import { resolveOption } from '@/lib/pnfContracts';
import { placeDhanOrder } from '@/lib/dhanPlaceOrder';
import { readBrokerOrder } from '@/lib/brokerOrderStatus';
import { dhanGet } from '@/lib/dhanToken';
import { fetchLtps } from '@/lib/dhanEquityQuote';
import { dedupe } from '@/lib/pyExec';
import { parseSnapshotCsv, latestExpiry } from '@/lib/freshMoney';
import {
  buildPositions, closeQty, contractHold, dueForCheck, effectiveState, nextCheckDelay, sessionGate, sessionMessage, slices,
  stateFromBroker, unconfirmedQty,
  FM_MAX_LOTS_PER_ORDER, FM_MAX_POSITION_LOTS,
  type FmLedger, type FmOrder, type FmPosition, type OptType, type SessionGate, type TxnSide,
} from '@/lib/freshMoneyTrades';

/**
 * REAL MONEY. The Fresh Money board's B / S buttons: MARKET, INTRADAY option orders on Dhan.
 *
 * The browser sends only underlying, expiry, strike, CE/PE, BUY/SELL and lots. The contract (security id, lot) is
 * resolved here from master_list.csv, and only for a strike and expiry that today's board snapshot actually shows, so
 * the page can never trade something it is not displaying. Lots are capped per order and per position (unconfirmed
 * orders counted as if they fill). New positions only 09:15-15:17 IST on a regular NSE session; closes until 15:30.
 *
 * Ledger: debug/fresh_money_trades.json, this page's own orders (ownership + P&L basis). Every order is written as
 * 'sending' BEFORE it goes out, so a crash mid-send leaves an UNKNOWN record rather than nothing.
 */

const LEDGER = path.join(DEBUG_DIR, 'fresh_money_trades.json');
const LOCK = `${LEDGER}.lock`;
const LOCK_STALE_MS = 15_000;
/** SENSEX is BSE; the contract resolver covers NSE and MCX only, so its board is watch-only. */
const TRADABLE = new Set(['NIFTY', 'BANKNIFTY']);
const IDEMPOTENCY_TTL_MS = 60_000;
/** Broker reads per refresh, and the least gap between refreshes (every tab's poll shares one refresh). */
const READS_PER_REFRESH = 4;
const REFRESH_GAP_MS = 2_000;

const gateNow = (): SessionGate => sessionGate(Date.now(), isRegularSession(istToday()));

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

const boardCache = new Map<string, { key: string; expiry: string; strikes: Set<number> }>();

/** Today's board for `underlying`: its expiry and the strikes of the last snapshot. Null when there is none today. */
async function todaysBoard(underlying: string): Promise<{ expiry: string; strikes: Set<number> } | null> {
  const file = resolveCsvPath(underlying, istToday());
  if (!file) return null;
  const st = await fs.promises.stat(file);
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = boardCache.get(underlying);
  if (hit && hit.key === key) return hit;
  const snaps = parseSnapshotCsv(await fs.promises.readFile(file, 'utf8'));
  const expiry = latestExpiry(snaps);
  const last = [...snaps].reverse().find(s => s.expiry === expiry);
  if (!last || expiry < istToday()) return null;
  const entry = { key, expiry, strikes: new Set(last.strikes.keys()) };
  boardCache.set(underlying, entry);
  return entry;
}

// ── broker reads ──────────────────────────────────────────────────────────────────────────────────────────────────

let ltpCache: { at: number; ids: string; data: Record<string, number> } | null = null;

/** Last prices through the shared quote lane; the previous answer on a failed call, else {} (P&L shows unknown). */
async function ltpsFor(ids: string[]): Promise<Record<string, number>> {
  if (!ids.length) return {};
  const key = [...ids].sort().join(',');
  if (ltpCache && ltpCache.ids === key && Date.now() - ltpCache.at < 1_500) return ltpCache.data;
  try {
    const data = await fetchLtps('NSE_FNO', ids);
    ltpCache = { at: Date.now(), ids: key, data };
    return data;
  } catch {
    return ltpCache && ltpCache.ids === key ? ltpCache.data : {};
  }
}

/** The broker's INTRADAY net quantity on a contract, or null when the positions read fails. */
async function brokerNet(securityId: string): Promise<number | null> {
  try {
    const rows = await dhanGet('/positions', 6_000);
    if (!Array.isArray(rows)) return null;
    let net = 0;
    for (const r of rows as Record<string, unknown>[]) {
      if (String(r.securityId ?? '') === securityId && String(r.productType ?? '').toUpperCase() === 'INTRADAY') {
        net += Number(r.netQty) || 0;
      }
    }
    return net;
  } catch {
    return null;
  }
}

// Per-order re-read schedule (backoff), so a few settled-late orders cannot hog the reads and none is starved.
const nextAt = new Map<string, number>();
const attempts = new Map<string, number>();
let lastRefresh = 0;

/** Read one unsettled order from Dhan; returns the patch, or null when nothing new is known. */
async function readOne(o: FmOrder): Promise<Partial<FmOrder> | null> {
  if (!o.orderId) {
    // Sent with no clean reply (or the reply was lost): look it up by our correlationId until it shows up.
    if (effectiveState(o, Date.now()) !== 'unknown') return null;
    const raw = await dhanGet(`/orders/external/${o.correlationId}`, 5_000);
    const row = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | null;
    if (!row || String(row.correlationId ?? '') !== o.correlationId || !row.orderId) return null;
    // Adopt the order id; its fill and price are read through /orders/{id} next round (this lookup may omit them).
    const filledQty = Number(row.filledQty) || 0;
    const avgPrice = Number(row.averageTradedPrice) > 0 ? Number(row.averageTradedPrice) : null;
    return { orderId: String(row.orderId), filledQty, avgPrice, state: stateFromBroker(String(row.orderStatus ?? ''), filledQty, o.qty, avgPrice) };
  }
  const s = await readBrokerOrder(o.orderId, 'dhan');
  if (!s) return null;
  const avgPrice = s.averageTradedPrice > 0 ? s.averageTradedPrice : null;
  return {
    filledQty: s.filledQty,
    avgPrice,
    state: stateFromBroker(s.orderStatus, s.filledQty, o.qty, avgPrice),
    reason: s.reason || undefined,
  };
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
    try { patch = await readOne(o); } catch { /* unreadable (429, network): back off */ }
    const n = (attempts.get(o.id) ?? 0) + 1;
    attempts.set(o.id, patch ? 0 : n);
    nextAt.set(o.id, Date.now() + (patch ? 2_000 : nextCheckDelay(n)));
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

// ── GET: orders, positions ────────────────────────────────────────────────────────────────────────────────────────

export interface FreshMoneyTradeState {
  date: string;
  tradable: string[];
  maxLots: number;
  maxPositionLots: number;
  /** 'open' = new positions allowed, 'close-only' after 15:17 IST, 'closed' outside the session. */
  session: SessionGate;
  sessionNote: string | null;
  boardExpiry: Record<string, string | null>;
  positions: FmPosition[];
  orders: (FmOrder & { effState: string })[];
}

async function buildState(): Promise<FreshMoneyTradeState> {
  await refreshOrders().catch(() => {});
  const ledger = loadLedger();
  const now = Date.now();
  const pre = buildPositions(ledger.orders, {}, now);
  const ltps = await ltpsFor(pre.filter(p => p.netQty !== 0).map(p => p.securityId));
  const boardExpiry: Record<string, string | null> = {};
  for (const u of TRADABLE) boardExpiry[u] = (await todaysBoard(u).catch(() => null))?.expiry ?? null;
  const session = gateNow();
  return {
    date: ledger.date,
    tradable: [...TRADABLE],
    maxLots: FM_MAX_LOTS_PER_ORDER,
    maxPositionLots: FM_MAX_POSITION_LOTS,
    session,
    sessionNote: sessionMessage(session),
    boardExpiry,
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

const newCid = () => `fm${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 8)}`;

type OrderBase = Omit<FmOrder, 'id' | 'ts' | 'correlationId' | 'orderId' | 'state' | 'filledQty' | 'avgPrice'>;

/** Session, hold and position-cap checks against the ledger as it is inside the lock (two quick clicks cannot both
 *  pass). The cap counts unconfirmed orders (UNKNOWN / in flight) as if they fill. */
function precheck(l: FmLedger, base: OrderBase): string | null {
  const now = Date.now();
  const gate = gateNow();
  if (gate === 'closed' || (gate === 'close-only' && !base.close)) return sessionMessage(gate);
  const hold = contractHold(l.orders, base.securityId, now);
  if (hold === 'unknown') return 'An earlier order on this contract has an UNKNOWN outcome — check Positions/Orders; new orders on it are held for a minute';
  if (hold === 'pending') return 'An earlier order on this contract is still being confirmed — try again in a moment';
  if (base.close) return null;
  const held = buildPositions(l.orders, {}, now).find(p => p.securityId === base.securityId)?.netQty ?? 0;
  const exposure = held + unconfirmedQty(l.orders, base.securityId, now);
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
  const correlationId = newCid();
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

  const r = await placeDhanOrder({
    securityId: base.securityId, quantity: base.qty, side: base.side, orderType: 'MARKET',
    exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', source: 'fm', correlationId,
  });
  const patch: Partial<FmOrder> =
    r.status === 'placed' ? { state: 'pending', orderId: r.orderId }
      : r.status === 'unknown' ? { state: 'unknown', reason: r.error }
        : { state: 'rejected', reason: r.error };
  // If this write fails the record stays 'sending', reads as UNKNOWN after 30 s and is looked up by correlationId.
  await mutate(l => { const o = l.orders.find(x => x.id === id); if (o) Object.assign(o, patch); }).catch(() => {});
  stateCache = null;
  if (r.status === 'placed') return { kind: 'placed', orderId: r.orderId };
  if (r.status === 'unknown') return { kind: 'unknown', error: r.error };
  return { kind: 'rejected', error: r.error, http: r.status === 'invalid' ? r.http : 200 };
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
  const gate = gateNow();
  if (gate !== 'open') return reply({ success: false, error: sessionMessage(gate)! }, 409);

  const board = await todaysBoard(underlying).catch(() => null);
  if (!board) return reply({ success: false, error: `No ${underlying} board snapshot today — the IV snapshot collector must be running to trade from this page` }, 409);
  if (b.expiry !== board.expiry) return reply({ success: false, error: `The board's expiry is ${board.expiry} now — refresh before trading` }, 409);
  if (!board.strikes.has(strike)) return reply({ success: false, error: `${strike} is not on today's board` }, 400);

  const c = resolveOption(underlying, board.expiry, strike, opt);
  if (!c || c.segment !== 'NSE_FNO' || !(c.lot > 0)) return reply({ success: false, error: `No ${underlying} ${board.expiry} ${strike} ${opt} contract in the master list` }, 400);

  return replyFor(await sendOne({
    underlying, expiry: board.expiry, strike, opt, securityId: c.securityId, lot: c.lot,
    side, qty: lots * c.lot, close: false,
  }));
}

async function closePosition(b: OrderBody): Promise<NextResponse> {
  const securityId = String(b.securityId ?? '');
  const ledger = loadLedger();
  const now = Date.now();
  const pos = buildPositions(ledger.orders, {}, now).find(p => p.securityId === securityId);
  if (!pos || pos.netQty === 0) return reply({ success: false, error: 'This page holds no open position on that contract' }, 400);
  const gate = gateNow();
  if (gate === 'closed') return reply({ success: false, error: sessionMessage(gate)! }, 409);
  const hold = contractHold(ledger.orders, securityId, now);
  if (hold) {
    return reply({
      success: false,
      error: hold === 'unknown'
        ? 'An earlier order on this contract has an UNKNOWN outcome — check Positions/Orders before closing'
        : 'An earlier order on this contract is still being confirmed — try again in a moment',
    }, 409);
  }
  const qty = closeQty(pos.netQty, await brokerNet(securityId));
  if (qty <= 0) {
    return reply({ success: false, error: 'Dhan shows no INTRADAY position left in that direction — nothing was sent. It may have been closed elsewhere.' }, 409);
  }
  const side: TxnSide = pos.netQty > 0 ? 'SELL' : 'BUY';
  const parts = slices(qty, pos.lot);
  let placedQty = 0;
  let lastId = '';
  for (let i = 0; i < parts.length; i++) {
    // Later slices skip the hold check: the previous slice is still 'pending' by design.
    const r = await sendOne({
      underlying: pos.underlying, expiry: pos.expiry, strike: pos.strike, opt: pos.opt, securityId, lot: pos.lot,
      side, qty: parts[i], close: true,
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
  if (prior) return (await prior.result).clone();
  const result = run();
  idempotent.set(key, { at: now, result });
  try {
    return (await result).clone();
  } catch (err) {
    idempotent.delete(key);
    return reply({ success: false, error: `Order route error: ${String((err as Error).message ?? err)}`, unknown: true });
  }
}
