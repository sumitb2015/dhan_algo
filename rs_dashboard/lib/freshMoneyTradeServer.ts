import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DEBUG_DIR, resolveCsvPath } from '@/lib/ivSnapshotFiles';
import { withFileLock, readJsonFile, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { istMinuteOfDay, istToday } from '@/lib/istTime';
import { isRegularSession } from '@/lib/nseHolidays';
import { mcxSession } from '@/lib/mcxSession';
import { MCX_LOT_MULTIPLIER } from '@/lib/positionPnl';
import { resolveOption } from '@/lib/pnfContracts';
import { fetchLtps } from '@/lib/dhanEquityQuote';
import { spotInstrument, wsPrice, wsSync, wsWant } from '@/lib/freshMoneyWs';
import { parsedDay } from '@/lib/freshMoneyFiles';
import { globalOnce } from '@/lib/globalOnce';
import {
  BROKERS, brokerContract, brokerFills, closeSlices, brokerName, brokerNets, brokerSessionOk, newCorrelationId, productCode, readOrder, sendOrder,
} from '@/lib/freshMoneyBrokers';
import {
  brokerUnits, buildPositions, closeCheck, closeQty, freshRestCache, contractHold, contractSettling, dueForCheck, effectiveState, hhmmToMin, isTerminal,
  bookNet, inFlightReducing, netKey, recentOrders, nextCheckDelay, orderKey, productWindow, reconcileDownQty, sessionGate, sessionMessage, unconfirmedQty,
  NSE_WINDOW, SENDING_STALE_MS, UNKNOWN_HOLD_MS, FM_MAX_LOTS_PER_ORDER, FM_MAX_POSITION_LOTS,
  type FmBroker, type FmLedger, type MissingSeen, type FmOrder, type FmPosition, type FmProduct, type FmSegment, type OptType, type SessionGate,
  type TradeWindow, type TxnSide,
} from '@/lib/freshMoneyTrades';
import { validateGlobalAmount, type FmGlobalExit } from './freshMoneyGlobalExit.ts';
import { runExitAll, type ExitAllResult } from './freshMoneyExitAll.ts';
import { priceExternalClose } from './freshMoneyExternalPrice.ts';
import {
  editExit, exitSummary, exitsOnOpen, parseExitDefaults, validateExitSpec, validateTrail, type CloseResult, type ExitDefaults, type FmExit,
} from '@/lib/freshMoneyExits';
import { armedQty, classifyEntry, entryLabel, levelProblem, type EntryKind, type FmEntry } from '@/lib/freshMoneyEntries';

/**
 * REAL MONEY. The Fresh Money board's trade engine (server only), shared by /api/fresh-money/trade (the B / S and ×
 * buttons) and the target / stop-loss watcher (lib/freshMoneyExitServer.ts), so a click and an automatic exit go
 * through ONE close path with the same rules.
 *
 * MARKET, intraday option orders on Dhan, Kotak or Zerodha (lib/freshMoneyBrokers.ts). Prices, the board and the
 * contract check are Dhan's whatever the broker; the order quantity is in the chosen broker's own unit (brokerUnits),
 * checked against its own master.
 *
 * The browser sends only underlying, expiry, strike, CE/PE, BUY/SELL and lots. The contract (security id, lot) is
 * resolved here from master_list.csv, and only for a strike and expiry that today's board snapshot actually shows, so
 * the page can never trade something it is not displaying. Lots are capped per order and per position (unconfirmed
 * orders counted as if they fill). NSE: new positions 09:15-15:17 IST on a regular session, closes until 15:30.
 * MCX (CRUDEOIL / CRUDEOILM): new positions from the open until the MIS auto-exit, closes until the close
 * (lib/mcxSession.ts: 23:30 / 23:55 by US DST, MCX holidays). MCX order quantity is LOTS (Dhan), and P&L is
 * multiplied by barrels per lot (MCX_LOT_MULTIPLIER) — dhan-crudeoil-trading.
 *
 * Ledger: debug/fresh_money_trades.json, this page's own orders (ownership + P&L basis) and per-position exit levels.
 * Every order is written as 'sending' BEFORE it goes out, so a crash mid-send leaves an UNKNOWN record rather than nothing.
 */

const LEDGER = path.join(DEBUG_DIR, 'fresh_money_trades.json');
const LOCK = `${LEDGER}.lock`;
const LOCK_STALE_MS = 15_000;
/** The exit watcher's heartbeat (lib/freshMoneyExitServer.ts), written every tick. */
export const EXIT_WATCHER_FILE = path.join(DEBUG_DIR, 'fresh_money_exit_watcher.json');
const WATCHER_ALIVE_MS = 10_000;
/** SENSEX is BSE; the contract resolver covers NSE and MCX only, so its board is watch-only. */
export const TRADABLE: ReadonlySet<string> = new Set(['NIFTY', 'BANKNIFTY', 'CRUDEOIL', 'CRUDEOILM']);
const isMcx = (u: string) => MCX_LOT_MULTIPLIER[u] !== undefined;
/** Broker reads per refresh, and the least gap between refreshes (every tab's poll shares one refresh). */
const READS_PER_REFRESH = 4;
/** An order this young is read on a fast schedule (see nextReadAt / refreshOrders). */
const YOUNG_ORDER_MS = 15_000;
const YOUNG_REFRESH_GAP_MS = 400;
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
/** MIS and NRML share the open and the close; NRML may open new positions until a minute before the close. */
export const gateNow = (u: string, product?: FmProduct): SessionGate => sessionGate(Date.now(), productWindow(windowFor(u), product));
const gateMessage = (u: string, gate: SessionGate, product?: FmProduct) =>
  sessionMessage(gate, productWindow(windowFor(u), product), marketName(u));

/** Minutes before the close from which an open NRML position is flagged (this page never squares NRML off). */
const NRML_WARN_MIN = 10;
/** From NRML_WARN_MIN before the close until the day roll (an open NRML position after the bell is carried). */
function nearClose(u: string, now: number): boolean {
  const w = windowFor(u);
  if (!w) return true;
  return istMinuteOfDay(now) >= w.close - NRML_WARN_MIN;
}

// ── ledger ────────────────────────────────────────────────────────────────────────────────────────────────────────

const LEDGER_READ_TRIES = 5;
const LEDGER_RETRY_MS = 20;
// An async wait: a blocking sleep would freeze every route and the exit watcher on this server while it retries.
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * The ledger file as it is on disk: null ONLY when there is no file. A file that exists but cannot be read or parsed
 * (Windows EBUSY / EPERM while another bundle renames its tmp over it, an antivirus scan) is retried briefly, then
 * THROWS — never read as "no orders today": mutateLedger would write that empty ledger back and erase the day's
 * positions and exit levels while the positions stay live at the broker.
 */
async function readLedgerFile(): Promise<FmLedger | null> {
  let lastErr: unknown = null;
  for (let i = 0; i < LEDGER_READ_TRIES; i++) {
    if (i > 0) await sleep(LEDGER_RETRY_MS);
    let text: string;
    try { text = fs.readFileSync(LEDGER, 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      lastErr = e; continue;
    }
    try { return JSON.parse(text) as FmLedger; } catch (e) { lastErr = e; }
  }
  throw new Error(`Fresh Money ledger unreadable (${String((lastErr as Error)?.message ?? lastErr)}) — nothing was changed`);
}

export async function loadLedger(): Promise<FmLedger> {
  const today = istToday();
  const l = await readLedgerFile();
  if (l && l.date === today) {
    if (Array.isArray(l.orders)) return l;
    // Today's file with no orders array is damaged, not empty: refuse rather than overwrite it.
    throw new Error('Fresh Money ledger is damaged (no orders list) — nothing was changed; check debug/fresh_money_trades.json');
  }
  // Day roll: MIS positions are squared off by the broker; keep yesterday's file for the record. An NRML position still
  // open is NOT carried into the new ledger (the user's choice, 2026-11-13: no auto-exit, warned from 10 min before the
  // close — `nrmlWarning`); it is then managed at the broker.
  if (l && typeof l.date !== 'string') throw new Error('Fresh Money ledger is damaged (no date) — nothing was changed; check debug/fresh_money_trades.json');
  if (l && l.date !== today) {
    try { fs.renameSync(LEDGER, path.join(DEBUG_DIR, `fresh_money_trades_${l.date}.json`)); } catch { /* raced */ }
  }
  return { date: today, orders: [] };
}

export const mutateLedger = <T>(fn: (l: FmLedger) => T): Promise<T> =>
  withFileLock(LOCK, LOCK_STALE_MS, 'Fresh Money ledger', async () => {
    const l = await loadLedger();
    const out = fn(l);
    writeJsonAtomic(LEDGER, l, { pretty: true });
    return out;
  });

// ── board: the expiry and strikes the page is showing ─────────────────────────────────────────────────────────────

/** A board this many minutes behind the clock (while its market is open) is stale: no new positions from it. */
const BOARD_STALE_MIN = 3;

/** Today's live board for `underlying`: its expiry, the strikes of the last snapshot and that snapshot's time (IST
 *  minutes). Null when there is none today, or when today's file is a 1-minute backfill (the board never shows those). */
export async function todaysBoard(underlying: string): Promise<{ expiry: string; strikes: Set<number>; lastMin: number } | null> {
  const file = resolveCsvPath(underlying, istToday(), true);
  if (!file) return null;
  const p = await parsedDay(file, true);
  const last = p?.snaps?.[p.snaps.length - 1];
  if (!p || !p.cumulative || !last || p.expiry < istToday()) return null;
  return { expiry: p.expiry, strikes: new Set(last.strikes.keys()), lastMin: last.min };
}

const istMinuteNow = () => istMinuteOfDay(Date.now(), true);

// ── broker reads ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Throttles and caches, ONE per server process: the trade route and the exit watcher are separate Next bundles, and with
 * module-level state each kept its own clock — two Kotak positions reads per 15 s, two REST price caches, two order-read
 * schedules (stCode 100025 "rate limit exceeded", 2026-11-11). lib/globalOnce.ts.
 */
interface ServerShared {
  restCache: { at: number; ids: string; data: Record<string, number> } | null;
  nextAt: Map<string, number>;
  attempts: Map<string, number>;
  lastRefresh: number;
  lastReconcile: Map<FmBroker, number>;
  stateVersion: number;
  /** An "Exit all" is running in this process (a second click / tab is refused, not queued). */
  exitAllBusy?: boolean;
  /** Last order-book read per broker for pricing an outside close. */
  lastExtPrice?: Map<FmBroker, number>;
  /** Contracts missing from a readable positions book, by `broker|netKey` (bookNet): shared by reconcile and close. */
  missing?: Map<string, MissingSeen>;
}
const shared = globalOnce<ServerShared>('__freshMoneyTradeServer', () => ({
  restCache: null, nextAt: new Map(), attempts: new Map(), lastRefresh: 0, lastReconcile: new Map(), stateVersion: 0,
}));

/**
 * Option LTPs for P&L: the WebSocket first (lib/freshMoneyWs.ts — asked for every open position, so its subscription is
 * kept alive while the position is open), REST only for the ones without a usable WebSocket price yet (a fresh
 * subscription, the bridge starting, the hub down). `source` says which one each price came from.
 */
export async function ltpsFor(items: { id: string; segment: FmSegment }[]): Promise<{ ltps: Record<string, number>; source: Record<string, 'ws' | 'rest'> }> {
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
  const cached = freshRestCache(shared.restCache, key, Date.now());
  if (cached) rest = cached;
  else {
    try {
      for (const seg of ['NSE_FNO', 'MCX_COMM'] as const) {
        const ids = missing.filter(i => i.segment === seg).map(i => i.id);
        if (ids.length) Object.assign(rest, await fetchLtps(seg, ids));
      }
      shared.restCache = { at: Date.now(), ids: key, data: rest };
    } catch {
      rest = freshRestCache(shared.restCache, key, Date.now()) ?? {}; // no price rather than an old one
    }
  }
  for (const i of missing) if (rest[i.id] > 0) { ltps[i.id] = rest[i.id]; source[i.id] = 'rest'; }
  return { ltps, source };
}

// Per-order re-read schedule (backoff), so a few settled-late orders cannot hog the reads and none is starved.
const { nextAt, attempts } = shared;

/** When to read an unsettled order next. A record with no order id is looked up every 2 s from the moment it can be
 *  UNKNOWN until its hold has run out (so a late booking is adopted before new orders on the contract are allowed),
 *  then with backoff. Before that ('sending', not yet stale) there is nothing to look up. */
function nextReadAt(o: FmOrder, now: number, attempts: number, changed: boolean): number {
  if (!o.orderId) {
    const staleAt = o.ts + SENDING_STALE_MS;
    if (now < staleAt) return staleAt;
    if (now < o.ts + UNKNOWN_HOLD_MS + 60_000) return now + 2_000;
  }
  // A just-placed MARKET order usually fills within a second: read it again quickly so the strike shows the position
  // at once (the 2 s / doubling schedule below is for orders that are slow to settle).
  const young = now - o.ts < YOUNG_ORDER_MS;
  if (young) return now + (changed ? 500 : Math.min(1_000, nextCheckDelay(attempts)));
  return now + (changed ? 2_000 : nextCheckDelay(attempts));
}

/** Bring unsettled orders up to date: at most READS_PER_REFRESH due orders, oldest due first, with backoff. */
export async function refreshOrders(): Promise<void> {
  const now = Date.now();
  if (now - shared.lastRefresh < YOUNG_REFRESH_GAP_MS) return;
  const ledger = await loadLedger();
  const youngOpen = ledger.orders.some(o => !isTerminal(effectiveState(o, now)) && now - o.ts < YOUNG_ORDER_MS);
  if (!youngOpen && now - shared.lastRefresh < REFRESH_GAP_MS) return;
  shared.lastRefresh = now;
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
  await mutateLedger(l => {
    for (const o of l.orders) {
      const u = updates.get(o.id);
      if (u) Object.assign(o, u);
    }
  });
  shared.stateVersion++; // the route's GET cache must not serve the state from before this fill
}

// ── down-only reconcile against the broker ───────────────────────────────────────────────────────────────────────

/** Positions-book reads for the reconcile, per broker (Kotak's book is rate limited, so it is read less often). */
const RECONCILE_GAP_MS: Record<FmBroker, number> = { dhan: 5_000, kotak: 15_000, zerodha: 10_000 };
const { lastReconcile } = shared;

/**
 * Write this page's positions DOWN to what each broker still holds (Invariant 2): an MIS auto square-off or a close from
 * another desk otherwise leaves a phantom position that is marked to market and counted toward the cap. The reduction
 * is a synthetic `external` record; priceExternalCloses then prices it from the broker's order book when one order fits
 * exactly, else it stays unknown (the day's booked P&L reads unknown, never a guess).
 * Skipped for a contract with an order in flight or placed in the last 20 s, and when the positions read fails.
 */
export async function reconcileWithBrokers(): Promise<void> {
  const now = Date.now();
  const ledger = await loadLedger();
  const open = buildPositions(ledger.orders, {}, now).filter(p => p.netQty !== 0 && !contractSettling(ledger.orders, p.key, now));
  for (const b of BROKERS) {
    const mine = open.filter(p => p.broker === b);
    if (!mine.length || now - (lastReconcile.get(b) ?? 0) < RECONCILE_GAP_MS[b] || !brokerSessionOk(b)) continue;
    lastReconcile.set(b, now);
    const nets = await brokerNets(b);
    if (!nets) continue;
    // A contract MISSING from the book is unknown (no reduction) until bookNet has seen it missing on several reads in a
    // row — then it is believed gone (0), the same verdict closePositionCore uses. Decided once per read.
    const seen = (shared.missing ??= new Map());
    const verdict = new Map<string, number | null>();
    for (const p of mine) {
      const nk = netKey(p.securityId, p.product);
      if (!verdict.has(nk)) verdict.set(nk, bookNet(nets, nk, `${b}|${nk}`, seen, now));
    }
    const brokerNet = (p: FmPosition) => verdict.get(netKey(p.securityId, p.product)) ?? null;
    if (!mine.some(p => reconcileDownQty(p.netQty, brokerNet(p), false) > 0)) continue;
    await mutateLedger(l => {
      // Re-decide against the ledger as it is inside the lock: an order may have been placed meanwhile.
      const t = Date.now();
      for (const p of buildPositions(l.orders, {}, t)) {
        if (p.broker !== b) continue;
        const drop = reconcileDownQty(p.netQty, brokerNet(p), contractSettling(l.orders, p.key, t));
        if (drop <= 0) continue;
        l.orders.push({
          id: randomUUID(), ts: t, underlying: p.underlying, expiry: p.expiry, strike: p.strike, opt: p.opt,
          securityId: p.securityId, broker: p.broker, priceId: p.priceId, segment: p.segment, lot: p.lot, mult: p.mult,
          side: p.netQty > 0 ? 'SELL' : 'BUY', product: p.product, qty: drop, close: true, external: true, correlationId: 'external',
          orderId: null, state: 'filled', filledQty: drop, avgPrice: null,
          reason: `Closed outside this page: ${brokerName(b)} no longer shows this quantity (MIS auto square-off or another desk)`,
        });
      }
    }).catch(() => {});
  }
  await priceExternalCloses().catch(() => {});
}

const EXT_PRICE_TRIES = 6;
const EXT_PRICE_GAP_MS = 20_000;

/**
 * Give an outside close (an `external` record) its real price from the broker's order book, when exactly one reading
 * fits (lib/freshMoneyExternalPrice.ts). Reads a book only while such a record is unpriced, at most every 20 s per
 * broker and 6 times per record; after that it stays unknown (Booked / P&L show "–", never a guess).
 */
async function priceExternalCloses(): Promise<void> {
  const now = Date.now();
  const todo = (await loadLedger()).orders.filter(o => o.external && o.avgPrice === null && (o.priceTries ?? 0) < EXT_PRICE_TRIES);
  for (const b of new Set(todo.map(o => o.broker ?? 'dhan'))) {
    const lastAt = (shared.lastExtPrice ??= new Map()).get(b) ?? 0;
    if (now - lastAt < EXT_PRICE_GAP_MS || !brokerSessionOk(b)) continue;
    shared.lastExtPrice.set(b, now);
    const book = await brokerFills(b);
    // An unreadable book (rate limit, network) says nothing about the close: it must not use up a try.
    if (!book) continue;
    await mutateLedger(l => {
      for (const o of l.orders) {
        if (!o.external || o.avgPrice !== null || (o.broker ?? 'dhan') !== b || (o.priceTries ?? 0) >= EXT_PRICE_TRIES) continue;
        o.priceTries = (o.priceTries ?? 0) + 1;
        const hit = priceExternalClose(o, l.orders, book, productCode(b, o.product));
        if (!hit) continue;
        o.avgPrice = hit.avgPrice;
        o.externalOrderIds = hit.orderIds;
        o.reason = `${o.reason ?? 'Closed outside this page'} — priced from ${brokerName(b)} order ${hit.orderIds.join(', ')}`;
      }
    }).catch(() => {});
    shared.stateVersion++;
  }
}

// ── state for the page ────────────────────────────────────────────────────────────────────────────────────────────

export interface FreshMoneyTradeState {
  date: string;
  tradable: string[];
  maxLots: number;
  maxPositionLots: number;
  /** Per underlying: 'open' = new positions allowed, 'close-only' after the cutoff, 'closed' outside the session. */
  sessions: Record<string, { gate: SessionGate; note: string | null; nrml?: { gate: SessionGate; note: string | null } }>;
  /** Open NRML positions near / after the close: this page does not square NRML off (null = nothing to say). */
  nrmlWarning: string | null;
  boardExpiry: Record<string, string | null>;
  /** Where each open position's LTP came from, by priceId: the WebSocket, or the REST fallback. */
  ltpSource: Record<string, 'ws' | 'rest'>;
  /** Whether each broker's session is usable (token present and not expired). */
  brokers: Record<FmBroker, boolean>;
  positions: FmPosition[];
  orders: (FmOrder & { effState: string })[];
  /** Per-position target / stop-loss, by position key. */
  exits: Record<string, FmExit>;
  /** The global (combined P&L, rupees) target / stop-loss, if one is set. */
  global: FmGlobalExit | null;
  /** Whether the server's exit watcher is running (its heartbeat is fresh). */
  exitWatcher: { alive: boolean; at: number | null };
  /** Today's level entries (armed, firing and ended), all brokers and underlyings. */
  entries: FmEntry[];
}

function exitWatcherStatus(now: number): { alive: boolean; at: number | null } {
  const at = Number(readJsonFile<{ at?: number }>(EXIT_WATCHER_FILE)?.at);
  return Number.isFinite(at) && at > 0 ? { alive: now - at <= WATCHER_ALIVE_MS, at } : { alive: false, at: null };
}

export async function buildState(): Promise<FreshMoneyTradeState> {
  await refreshOrders().catch(() => {});
  await reconcileWithBrokers().catch(() => {});
  const ledger = await loadLedger();
  const now = Date.now();
  const pre = buildPositions(ledger.orders, {}, now);
  const { ltps, source: ltpSource } = await ltpsFor(pre.filter(p => p.netQty !== 0).map(p => ({ id: p.priceId, segment: p.segment })));
  const boardExpiry: Record<string, string | null> = Object.fromEntries(await Promise.all(
    [...TRADABLE].map(async u => [u, (await todaysBoard(u).catch(() => null))?.expiry ?? null] as const),
  ));
  const sessions: FreshMoneyTradeState['sessions'] = {};
  for (const u of TRADABLE) {
    const g = gateNow(u), n = gateNow(u, 'NRML');
    sessions[u] = { gate: g, note: gateMessage(u, g), nrml: { gate: n, note: gateMessage(u, n, 'NRML') } };
  }
  const nrmlOpen = pre.filter(p => p.netQty !== 0 && p.product === 'NRML' && nearClose(p.underlying, now));
  const nrmlWarning = nrmlOpen.length
    ? `${nrmlOpen.length} NRML position${nrmlOpen.length === 1 ? '' : 's'} still open (${nrmlOpen.map(p => `${p.underlying} ${p.strike} ${p.opt}`).join(', ')}). This page does not square NRML off: close before the bell or it is carried overnight, and it leaves this page at the next day's roll.`
    : null;
  return {
    date: ledger.date,
    tradable: [...TRADABLE],
    maxLots: FM_MAX_LOTS_PER_ORDER,
    maxPositionLots: FM_MAX_POSITION_LOTS,
    sessions,
    nrmlWarning,
    boardExpiry,
    ltpSource,
    brokers: { dhan: brokerSessionOk('dhan'), kotak: brokerSessionOk('kotak'), zerodha: brokerSessionOk('zerodha') },
    positions: buildPositions(ledger.orders, ltps, now),
    orders: recentOrders(ledger.orders, now),
    exits: ledger.exits ?? {},
    global: ledger.global ?? null,
    exitWatcher: exitWatcherStatus(now),
    entries: ledger.entries ?? [],
  };
}

/** Set when an order was just recorded or answered: the route's GET cache must not serve the state from before it. */
export const tradeStateVersion = () => shared.stateVersion;

// ── place / close ─────────────────────────────────────────────────────────────────────────────────────────────────

type OrderBase = Omit<FmOrder, 'id' | 'ts' | 'correlationId' | 'orderId' | 'state' | 'filledQty' | 'avgPrice'>;

/** Session, hold and position-cap checks against the ledger as it is inside the lock (two quick clicks cannot both
 *  pass). The cap counts unconfirmed orders (UNKNOWN / in flight) as if they fill. */
function precheck(l: FmLedger, base: OrderBase): string | null {
  const now = Date.now();
  const gate = gateNow(base.underlying, base.product);
  if (gate === 'closed' || (gate === 'close-only' && !base.close)) return gateMessage(base.underlying, gate, base.product);
  const key = orderKey(base);
  const hold = contractHold(l.orders, key, now);
  if (hold === 'unknown') return 'An earlier order on this contract has an UNKNOWN outcome — check Positions/Orders; new orders on it are held for a minute';
  if (hold === 'pending') return 'An earlier order on this contract is still being confirmed — try again in a moment';
  if (base.close) return closeCheck(l.orders, key, base.side, base.qty, now);
  return capCheck(l, key, base.side, base.qty, base.lot, now);
}

/** The per-contract cap: what this page holds + unconfirmed orders + ARMED level entries (all counted as if they fill),
 *  plus this order. Only a move away from flat past the cap is refused (a reducing order never is). */
function capCheck(l: FmLedger, key: string, side: TxnSide, qty: number, lot: number, now: number): string | null {
  const held = buildPositions(l.orders, {}, now).find(p => p.key === key)?.netQty ?? 0;
  const exposure = held + unconfirmedQty(l.orders, key, now) + armedQty(l.entries, key);
  const after = exposure + (side === 'BUY' ? 1 : -1) * qty;
  if (Math.abs(after) > FM_MAX_POSITION_LOTS * lot && Math.abs(after) > Math.abs(exposure)) {
    return `That would take this contract past ${FM_MAX_POSITION_LOTS} lots (counting orders not yet confirmed and armed levels)`;
  }
  return null;
}

type SendResult = { kind: 'placed'; orderId: string; stamped?: boolean } | { kind: 'refused'; error: string; http: number }
  | { kind: 'rejected'; error: string; http: number } | { kind: 'unknown'; error: string };

/** Check + record (one lock) → send → record the outcome. A broker rejection is `rejected` (nothing was placed).
 *  `stamp`: an opening order's header target / stop-loss, written in the same lock when the contract is flat. */
async function sendOne(base: OrderBase, check = true, stamp?: ExitDefaults): Promise<SendResult> {
  const id = randomUUID();
  const correlationId = newCorrelationId(base.broker ?? 'dhan');
  let refused: string | null;
  let stamped = false;
  try {
    refused = await mutateLedger(l => {
      const why = check ? precheck(l, base) : null;
      if (why) return why;
      const now = Date.now();
      const key = orderKey(base);
      if (!base.close) {
        const next = exitsOnOpen(l.exits, l.orders, key, base.side, now, stamp ?? { target: null, sl: null });
        if (next !== (l.exits ?? {})) { l.exits = next; stamped = !!next[key]; }
      }
      l.orders.push({ ...base, id, ts: now, correlationId, orderId: null, state: 'sending', filledQty: 0, avgPrice: null });
      return null;
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
  await mutateLedger(l => { const o = l.orders.find(x => x.id === id); if (o) Object.assign(o, patch); }).catch(() => {});
  shared.stateVersion++;
  if (r.status === 'placed') return { kind: 'placed', orderId: r.orderId, stamped };
  if (r.status === 'unknown') return { kind: 'unknown', error: r.error };
  return { kind: 'rejected', error: r.error, http: r.http ?? 200 };
}

const asClose = (r: SendResult): CloseResult =>
  r.kind === 'unknown' ? { kind: 'unknown', error: r.error, partial: false }
    : r.kind === 'placed' ? { kind: 'placed', orderId: r.orderId } : r;

export interface OrderBody {
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
  /** Order: the header's target / stop-loss defaults, stamped onto a position this order opens. */
  exitDefaults?: unknown;
  /** setExit: the position's new levels (null = off). */
  target?: unknown;
  sl?: unknown;
  /** setExit: trailing stop-loss rule (null / absent = off; needs `sl`). */
  trail?: unknown;
  /** setGlobal: rupee amounts (null = off); both null = remove. */
  globalTarget?: unknown;
  globalSl?: unknown;
  /** Order: MIS (default) or NRML. */
  product?: unknown;
  /** arm: the index (MCX: futures) level, and the kind the page showed ('limit' | 'stop'): a mismatch is refused. */
  level?: unknown;
  expect?: unknown;
  /** cancelEntry: the entry's id. */
  id?: unknown;
}

const refuse = (error: string, http: number): CloseResult => ({ kind: 'refused', error, http });

type Resolved = { ok: true; base: OrderBase; defaults: ExitDefaults } | { ok: false; r: CloseResult };

/**
 * Every check a new order must pass, and its contract resolved, without sending anything: the B / S click, arming a
 * level entry, and that entry's fire all go through it (the fire re-checks the board, the session and the contract at
 * the moment it sends). Refusal = nothing sent.
 */
async function resolveOrder(b: OrderBody): Promise<Resolved> {
  const no = (error: string, http: number): Resolved => ({ ok: false, r: refuse(error, http) });
  const underlying = String(b.underlying ?? '').toUpperCase();
  if (!TRADABLE.has(underlying)) return no(`${underlying || 'This underlying'} is watch-only on this board`, 400);
  const opt: OptType | null = b.opt === 'CE' || b.opt === 'PE' ? b.opt : null;
  const side: TxnSide | null = b.side === 'BUY' || b.side === 'SELL' ? b.side : null;
  const strike = Number(b.strike);
  const lots = Number(b.lots);
  if (!opt || !side || !Number.isFinite(strike)) return no('opt (CE/PE), side (BUY/SELL) and strike are required', 400);
  if (!Number.isInteger(lots) || lots <= 0) return no('Lots must be a positive integer', 400);
  if (lots > FM_MAX_LOTS_PER_ORDER) return no(`Max ${FM_MAX_LOTS_PER_ORDER} lots per order`, 400);
  const defaults = parseExitDefaults(b.exitDefaults);
  if ('error' in defaults) return no(`${defaults.error} — nothing was sent`, 400);
  const broker = (b.broker ?? 'dhan') as FmBroker;
  if (!BROKERS.includes(broker)) return no(`Unknown broker ${b.broker}`, 400);
  if (!brokerSessionOk(broker)) return no(`${brokerName(broker)} is not logged in — nothing was sent`, 409);
  // Absent = MIS (pages from before the product choice). Anything else is refused, never coerced.
  if (b.product !== undefined && b.product !== 'MIS' && b.product !== 'NRML') return no('product must be MIS or NRML', 400);
  const product: FmProduct = b.product === 'NRML' ? 'NRML' : 'MIS';
  const gate = gateNow(underlying, product);
  if (gate !== 'open') return no(gateMessage(underlying, gate, product)!, 409);

  const board = await todaysBoard(underlying).catch(() => null);
  if (!board) return no(`No ${underlying} board snapshot today — the IV snapshot collector must be running to trade from this page`, 409);
  if (b.expiry !== board.expiry) return no(`The board's expiry is ${board.expiry} now — refresh before trading`, 409);
  if (!board.strikes.has(strike)) return no(`${strike} is not on today's board`, 400);
  const behind = istMinuteNow() - board.lastMin;
  if (behind > BOARD_STALE_MIN) {
    return no(`The board's last snapshot is ${Math.floor(behind)} min old — is the collector running? No new positions from a stale board`, 409);
  }

  const mcx = isMcx(underlying);
  const c = resolveOption(underlying, board.expiry, strike, opt);
  if (!c || c.segment !== (mcx ? 'MCX_COMM' : 'NSE_FNO') || !(c.lot > 0)) {
    return no(`No ${underlying} ${board.expiry} ${strike} ${opt} contract in the master list`, 400);
  }
  // The same contract on the chosen broker, in that broker's own unit (checked against its own master).
  const bc = broker === 'dhan' ? null : await brokerContract(broker, underlying, board.expiry, strike, opt);
  if (broker !== 'dhan' && !bc) return no(`${brokerName(broker)} does not list ${underlying} ${board.expiry} ${strike} ${opt}`, 400);
  const units = brokerUnits(broker, underlying, c.lot, bc?.brokerLot ?? null, mcx ? MCX_LOT_MULTIPLIER[underlying] : null);
  if ('error' in units) return no(units.error, 400);
  return {
    ok: true, defaults,
    base: {
      underlying, expiry: board.expiry, strike, opt, broker, securityId: bc?.handle ?? c.securityId, priceId: c.securityId,
      segment: c.segment as FmSegment, lot: units.lot, mult: units.mult, side, product, qty: lots * units.lot, close: false,
    },
  };
}

/** Resolve → send (sendOne re-checks session, holds and the cap inside the ledger lock) → the reply. */
async function placeResolved(base: OrderBase, defaults: ExitDefaults): Promise<CloseResult> {
  const r = await sendOne(base, true, defaults);
  if (r.kind === 'placed' && r.stamped) return { kind: 'placed', orderId: r.orderId, note: exitSummary(defaults) };
  return asClose(r);
}

/** One new order from the board's B / S buttons. Every check that refuses sends nothing. */
export async function placeOrderCore(b: OrderBody): Promise<CloseResult> {
  const res = await resolveOrder(b);
  return res.ok ? placeResolved(res.base, res.defaults) : res.r;
}

// ── level entries (index level → MARKET order; lib/freshMoneyEntries.ts) ─────────────────────────────────────────────

/** The board's price for this underlying and option expiry (index, or the option month's future on MCX) from the
 *  WebSocket bridge, asked for here so the watcher keeps it subscribed with every tab closed. Null = no usable price.
 *  WEBSOCKET ONLY, by design: never add a REST quote fallback here. Levels arm and fire on this price; the quote API is
 *  ~1 req/s, shared with every bridge, and serves old values after a 429 (dhan-fresh-money "Common Mistakes"). No
 *  WebSocket price = the level does not arm (the ticket says so) and an armed one does not fire (the count resets). */
export function spotNow(underlying: string, expiry: string): number | null {
  const inst = spotInstrument(underlying, expiry, isMcx(underlying));
  if (!inst) return null;
  const k = wsWant(inst.segment, inst.securityId);
  wsSync();
  return wsPrice(k)?.ltp ?? null;
}

/** The body an entry's fire re-resolves with: the order as it was armed. */
const entryBody = (e: FmEntry): OrderBody => ({
  broker: e.broker, underlying: e.underlying, expiry: e.expiry, strike: e.strike, opt: e.opt, side: e.side, lots: e.lots,
  product: e.product, exitDefaults: e.exitDefaults,
});

export type ArmResult = { ok: true; entry: FmEntry } | { ok: false; error: string; http: number };

/**
 * Arm a level entry: the same checks as a click (resolveOrder), a live price, a sane level, the kind the page showed,
 * and the per-contract cap (armed entries count as if they fill) inside the ledger lock. Sends nothing.
 */
export async function armEntryCore(b: OrderBody): Promise<ArmResult> {
  const res = await resolveOrder(b);
  if (!res.ok) return { ok: false, error: (res.r as { error: string }).error, http: (res.r as { http?: number }).http ?? 409 };
  const { base, defaults } = res;
  const level = Number(b.level);
  const spot = spotNow(base.underlying, base.expiry);
  const why = levelProblem(level, spot ?? NaN);
  if (why) return { ok: false, error: why, http: spot === null ? 409 : 400 };
  const v = classifyEntry(base.opt, base.side, level, spot!);
  const expect: EntryKind | null = b.expect === 'limit' || b.expect === 'stop' ? b.expect : null;
  if (expect && expect !== v.kind) {
    return { ok: false, error: `The price moved (${spot!.toFixed(2)}): ${level} is now a ${v.kind === 'limit' ? 'limit' : 'stop / breakout'} entry — check and arm again`, http: 409 };
  }
  const lots = Number(b.lots);
  const entry: FmEntry = {
    id: randomUUID(), ts: Date.now(), broker: base.broker ?? 'dhan', underlying: base.underlying, expiry: base.expiry,
    strike: base.strike, opt: base.opt, side: base.side, lots, product: base.product ?? 'MIS', exitDefaults: defaults,
    level, dir: v.dir, kind: v.kind, key: orderKey(base), qty: base.qty, lot: base.lot, state: 'armed', spotAtArm: spot!,
  };
  try {
    const err = await mutateLedger(l => {
      const gate = gateNow(base.underlying, base.product);
      if (gate !== 'open') return gateMessage(base.underlying, gate, base.product);
      const cap = capCheck(l, entry.key, entry.side, entry.qty, entry.lot, Date.now());
      if (cap) return cap;
      l.entries = [...(l.entries ?? []), entry];
      return null;
    });
    shared.stateVersion++;
    return err ? { ok: false, error: err, http: 409 } : { ok: true, entry };
  } catch (e) {
    return { ok: false, error: `Not armed — ${String((e as Error).message ?? e)}`, http: 503 };
  }
}

/** Cancel an ARMED entry (checked in the lock: one that has started firing cannot be taken back). */
export async function cancelEntryCore(b: OrderBody): Promise<{ ok: true } | { ok: false; error: string; http: number }> {
  const id = typeof b.id === 'string' ? b.id : '';
  if (!id) return { ok: false, error: 'id is required', http: 400 };
  try {
    const err = await mutateLedger(l => {
      const e = (l.entries ?? []).find(x => x.id === id);
      if (!e) return 'No such level entry today';
      if (e.state === 'firing' || e.state === 'sent') return 'Too late — this level has already fired; check Orders';
      if (e.state !== 'armed') return `This level is already ${e.state}`;
      e.state = 'cancelled';
      e.endedAt = Date.now();
      e.reason = 'Cancelled';
      return null;
    });
    shared.stateVersion++;
    return err ? { ok: false, error: err, http: 409 } : { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e), http: 503 };
  }
}

/**
 * Send a fired entry's order (the watcher has already claimed it 'firing' in the lock): re-resolved and re-checked now
 * (board, session, contract, holds, cap), then the click's own send. The order records what fired it.
 */
export async function fireEntryCore(e: FmEntry, spot: number): Promise<CloseResult> {
  const res = await resolveOrder(entryBody(e));
  if (!res.ok) return res.r;
  const trigger = `Level ${e.kind === 'limit' ? 'limit' : 'stop'} entry ${entryLabel(e)} — ${e.underlying} at ${spot.toFixed(2)}`;
  return placeResolved({ ...res.base, trigger }, res.defaults);
}

/** For the watcher: a new order on this contract must wait (an earlier one is in flight / UNKNOWN). */
export const contractHeld = (l: FmLedger, key: string) => contractHold(l.orders, key, Date.now()) !== null;

/** The Positions panel's per-position target / stop-loss edit (both null = remove). Changes no order. */
export async function setExitCore(b: OrderBody): Promise<{ ok: true } | { ok: false; error: string; http: number }> {
  const key = typeof b.key === 'string' ? b.key : '';
  if (!key) return { ok: false, error: 'key is required', http: 400 };
  const target = validateExitSpec(b.target);
  if (target && 'error' in target) return { ok: false, error: `Target: ${target.error}`, http: 400 };
  const sl = validateExitSpec(b.sl);
  if (sl && 'error' in sl) return { ok: false, error: `Stop-loss: ${sl.error}`, http: 400 };
  const trail = validateTrail(b.trail);
  if (trail && 'error' in trail) return { ok: false, error: trail.error, http: 400 };
  try {
    const err = await mutateLedger(l => {
      const now = Date.now();
      const pos = buildPositions(l.orders, {}, now).find(p => p.key === key);
      if (!pos) return 'This page holds no position on that contract';
      const x = editExit(l.exits?.[key], pos, target, sl, now, trail);
      if (x && 'error' in x) return x.error;
      const exits = { ...(l.exits ?? {}) };
      if (x) exits[key] = x; else delete exits[key];
      l.exits = exits;
      return null;
    });
    shared.stateVersion++;
    return err ? { ok: false, error: err, http: 409 } : { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e), http: 503 };
  }
}

/** The header's global target / stop-loss on the combined P&L, in rupees (both null = remove). Changes no order. */
export async function setGlobalCore(b: OrderBody): Promise<{ ok: true } | { ok: false; error: string; http: number }> {
  const target = validateGlobalAmount(b.globalTarget);
  if (target && typeof target === 'object') return { ok: false, error: `Target: ${target.error}`, http: 400 };
  const sl = validateGlobalAmount(b.globalSl);
  if (sl && typeof sl === 'object') return { ok: false, error: `Stop-loss: ${sl.error}`, http: 400 };
  try {
    const err = await mutateLedger(l => {
      if (l.global?.state === 'firing') return 'The global exit is being sent right now — try again in a moment';
      if (target === null && sl === null) { delete l.global; return null; }
      l.global = { target, sl, armedAt: Date.now(), state: 'watching' };
      return null;
    });
    shared.stateVersion++;
    return err ? { ok: false, error: err, http: 409 } : { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e), http: 503 };
  }
}

/**
 * Square off this page's position on `key` (`broker|contract`): the × button and the exit watcher. Never more than this
 * page's own fills, clamped to what the broker still shows; never a second close around one still unconfirmed; sliced
 * at the per-order cap, stopping at the first refusal or UNKNOWN. `trigger` is recorded on each close order.
 */
export async function closePositionCore(key: string, trigger?: string): Promise<CloseResult> {
  const ledger = await loadLedger();
  const now = Date.now();
  const pos = buildPositions(ledger.orders, {}, now).find(p => p.key === key);
  if (!pos || pos.netQty === 0) return refuse('This page holds no open position on that contract', 400);
  const gate = gateNow(pos.underlying);
  if (gate === 'closed') return refuse(gateMessage(pos.underlying, gate)!, 409);
  if (!brokerSessionOk(pos.broker)) return refuse(`${brokerName(pos.broker)} is not logged in — nothing was sent`, 409);
  const hold = contractHold(ledger.orders, key, now);
  if (hold) {
    return refuse(hold === 'unknown'
      ? 'An earlier order on this contract has an UNKNOWN outcome — check Positions/Orders before closing'
      : 'An earlier order on this contract is still being confirmed — try again in a moment', 409);
  }
  // Close only what is not already on its way out: a slow-to-confirm close must not be sent twice.
  const inFlight = inFlightReducing(ledger.orders, key, pos.netQty, now);
  const remaining = Math.max(0, Math.abs(pos.netQty) - inFlight);
  if (remaining === 0) return refuse('A close for this position is already in flight (unconfirmed) — check Orders before sending another', 409);
  const nets = await brokerNets(pos.broker);
  // Same verdict as the reconcile (bookNet): unreadable, or missing on a single read = size from this page's own fills;
  // missing on several reads in a row = gone (refused, the reconcile writes it off).
  const nk = netKey(pos.securityId, pos.product);
  const qty = closeQty(Math.sign(pos.netQty) * remaining, bookNet(nets, nk, `${pos.broker}|${nk}`, (shared.missing ??= new Map()), Date.now()));
  if (qty <= 0) {
    return refuse(`${brokerName(pos.broker)} shows no ${pos.product} position left in that direction — nothing was sent. It may have been closed elsewhere.`, 409);
  }
  const side: TxnSide = pos.netQty > 0 ? 'SELL' : 'BUY';
  // Cut at the per-order lot cap, and at Zerodha's freeze quantity: a close is sliced, never refused for its size.
  const parts = closeSlices(pos.broker, pos.securityId, qty, FM_MAX_LOTS_PER_ORDER * pos.lot, pos.underlying, pos.lot);
  let placedQty = 0;
  let lastId = '';
  for (let i = 0; i < parts.length; i++) {
    // Later slices skip the hold check: the previous slice is still 'pending' by design.
    const r = await sendOne({
      underlying: pos.underlying, expiry: pos.expiry, strike: pos.strike, opt: pos.opt, broker: pos.broker,
      securityId: pos.securityId, priceId: pos.priceId, segment: pos.segment, lot: pos.lot, mult: pos.mult, side,
      product: pos.product, qty: parts[i], close: true, ...(trigger ? { trigger } : {}),
    }, i === 0);
    if (r.kind === 'placed') { placedQty += parts[i]; lastId = r.orderId; continue; }
    // Never send the next slice around a refusal or an UNKNOWN; say exactly what did go out.
    if (placedQty === 0) return asClose(r);
    const done = `${placedQty} of ${qty} units were sent to close`;
    if (r.kind === 'unknown') return { kind: 'unknown', partial: true, error: `${done}; the next ${parts[i]} have UNKNOWN status. ${r.error}` };
    return { kind: 'partial', error: `${done}; the rest (${qty - placedQty}) was not: ${r.error}` };
  }
  return { kind: 'placed', orderId: lastId, ...(parts.length > 1 ? { note: `${parts.length} orders, ${qty} units` } : {}) };
}

/**
 * The header's "Exit all": square off EVERY open position this page holds (all underlyings and brokers) with MARKET
 * orders, shorts first, each through closePositionCore. One run at a time per server; a run already going = refused.
 */
export async function exitAllCore(): Promise<ExitAllResult | { busy: true }> {
  if (shared.exitAllBusy) return { busy: true };
  shared.exitAllBusy = true;
  try {
    const open = buildPositions((await loadLedger()).orders, {}, Date.now()).filter(p => p.netQty !== 0);
    return await runExitAll(open, key => closePositionCore(key, 'Exit all (header)'));
  } finally {
    shared.exitAllBusy = false;
    shared.stateVersion++;
  }
}
