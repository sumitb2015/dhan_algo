import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { PROJECT_ROOT, PYTHON_EXE } from '@/lib/pyExec';
import { withFileLock, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { getDhanCredentials, dhanGet, dhanDelete, dhanPost } from '@/lib/dhanToken';
import { placeDhanOrder } from '@/lib/dhanPlaceOrder';
import { reserveOrderSlot } from '@/lib/dhanOrderPacer';
import { placeKotakOrder } from '@/lib/kotakPlaceOrder';
import { buildKotakOrderPayload } from '@/lib/kotakOrderPayload';
import { kotakDerivativeBySymbol } from '@/lib/kotakContracts';
import { kotakGet, kotakPost, kotakRows, kotakLimits, KOTAK_PATHS, isKotakTokenValid } from '@/lib/kotakToken';
import { shapeKotakFunds, shapeKotakOrderStatus, shapeKotakPosition } from '@/lib/kotakShape';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { kiteGet, kiteDelete, isZerodhaTokenValid } from '@/lib/zerodhaToken';
import { placeZerodhaOrder } from '@/lib/zerodhaPlaceOrder';
import { shapeZerodhaOrderStatus, shapeZerodhaPosition } from '@/lib/zerodhaShape';
import { zerodhaLotCapError } from '@/lib/zerodhaOrderRules';
import { cachedZerodhaContract, slicesFor } from '@/lib/zerodhaContracts';
import { pacedMarginCall } from '@/lib/ultimateScannerDhan';
import {
  EXIT_RETRY_MS, FILL_GRACE_MS, SETTLE_TIMEOUT_MS, SPOT_STALE_MS,
  bias, bracketLevels, emptyLadderState, exitQtyFor, isLive, istDay, pushEvent,
  rollDay, settleOrder, spotFresh, planTick, patchSlice, ev, zerodhaLadderParams, spotKey, parseSpotKey, spotKeyUnderlying, isMcxUnderlying, MCX_LADDER_UNDERLYINGS,
  type Job, type LadderOrderHow, type LadderBroker, type LadderContract, type LadderSide, type LadderSlice, type LadderState,
} from '@/lib/priceLadder';
import {
  cutPairLeg, cutsNewestFirst, isPairLive, LEG_KEYS, pairName, patchPair, planPairs, settleLegEntry, settleLegExit, PAIR_EXIT_RETRY_MS,
  type LadderPair, type PairJob, type PairLegKey,
} from '@/lib/priceLadderPair';
import { applyGuards } from '@/lib/priceLadderGuard';
import { readLadderSettings } from '@/lib/priceLadderSettings';

// The Price Ladder's server watcher. It owns debug/price_ladder_state.json (re-read on every tick and every request,
// never cached, because the instrumentation hook and the API route can be separate module instances) and, about once
// a second, fires armed XY entries when the index crosses their level, settles orders against the broker, runs the
// bracket target / SL / trailing SL in index points, and squares off MIS at 15:17 IST (MCX crude: 23:00). It keeps working with every tab
// closed; it stops with the dashboard server.
//
// Every order follows the same three-step write: mark the slice ('placing' / 'exiting') under the lock BEFORE the
// order is sent, send outside the lock, then record the outcome under the lock — so a crash or a second process can
// never send the same order twice. An UNKNOWN outcome is held as state 'unknown' and never resent.

const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');
const STATE_FILE = path.join(DEBUG_DIR, 'price_ladder_state.json');
const LOCK_FILE = `${STATE_FILE}.lock`;
const LOCK_STALE_MS = 8000;
/** A SIM fill / exit with no option price yet waits up to this many 0.5 s reads (the price bridge's first subscription). */
const SIM_PRICE_WAIT_TRIES = 24;
const TICK_MS = 1000;
const RECONCILE_MS = 5000;
const TAG = '[price-ladder]';

/** Dhan index security ids for spot (IDX_I). */
export const INDEX_IDS: Record<string, string> = { NIFTY: '13', BANKNIFTY: '25', SENSEX: '51' };
export const LADDER_UNDERLYINGS = [...Object.keys(INDEX_IDS), ...MCX_LADDER_UNDERLYINGS];

export const dhanSegmentFor = (u: string) => (isMcxUnderlying(u) ? 'MCX_COMM' : u === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO');
export const kotakExchangeFor = (u: string) => (u === 'SENSEX' ? 'bse_fo' : 'nse_fo');
export const zerodhaExchangeFor = (u: string) => (u === 'SENSEX' ? 'BFO' : 'NFO');
/** Brokers that key orders and positions by their own trading symbol (Dhan keys by security id). */
const bySymbol = (b: LadderBroker) => b !== 'dhan';

// ── state file ────────────────────────────────────────────────────────

function readStateFile(): LadderState {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<LadderState>;
    const settings = readLadderSettings();
    return {
      date: String(s.date ?? istDay()),
      slices: Array.isArray(s.slices) ? s.slices : [],
      events: Array.isArray(s.events) ? s.events : [],
      ...(s.liveArmedOn ? { liveArmedOn: String(s.liveArmedOn) } : {}),
      ...(Array.isArray(s.pairs) && s.pairs.length ? { pairs: s.pairs } : {}),
      ...(s.guards && Object.keys(s.guards).length ? { guards: s.guards } : {}),
      ...(Number.isFinite(Number(s.rev)) ? { rev: Number(s.rev) } : {}),
      settings: s.settings ?? settings,
    };
  } catch (err) {
    // A missing file is a fresh start; an unreadable one must not be overwritten with an empty ledger that forgets
    // live positions — refuse instead (the caller surfaces the error).
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyLadderState(istDay());
    throw new Error(`price ladder state is unreadable: ${(err as Error).message}`);
  }
}

/** Current state (a read-only view, rolled to today without writing). */
export function readLadderState(): LadderState {
  return rollDay(readStateFile(), istDay(), Date.now());
}

/** Read-modify-write under the lock. The mutator returns the next state. */
export async function updateLadderState(mutate: (s: LadderState) => LadderState): Promise<LadderState> {
  return withFileLock(LOCK_FILE, LOCK_STALE_MS, 'price ladder state', () => {
    const raw = readStateFile();
    const base = rollDay(raw, istDay(), Date.now());
    if (base !== raw) writeJsonAtomic(STATE_FILE, base);
    const next = mutate(base);
    if (next === base) return base;
    // A revision per write, so a page can tell a late (older) view from the one it already shows. Time-based (at least
    // previous + 1): a recreated file must not restart at 1 under a page that already showed a higher number.
    const out = { ...next, rev: Math.max((base.rev ?? 0) + 1, Date.now()) };
    writeJsonAtomic(STATE_FILE, out);
    return out;
  });
}

// ── prices ────────────────────────────────────────────────────────────

interface SpotRead { spot: number; at: number; source: string }

/** Each bridge file is parsed at most once per loadPrices call (they are several hundred KB, read every second). */
type FileMemo = Map<string, Record<string, unknown> | null>;
function readJson(file: string, memo: FileMemo): Record<string, unknown> | null {
  if (memo.has(file)) return memo.get(file)!;
  let v: Record<string, unknown> | null = null;
  try { v = JSON.parse(fs.readFileSync(path.join(DEBUG_DIR, file), 'utf8')) as Record<string, unknown>; } catch { /* absent or mid-write */ }
  memo.set(file, v);
  return v;
}
const tsOf = (v: unknown): number => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : 0; };

/**
 * Spot from the indices hub file (live_indices_ws.py: the dedicated index feed), or null. The options and Focus Tool
 * bridge files are NOT used for spot: they stamp one file-wide updated_at whenever any option ticks, so a frozen index
 * value there would pass as fresh. SENSEX is not in that file: it comes from price_ladder_ws.py (loadPrices).
 */
function spotFromFiles(u: string, memo: FileMemo): SpotRead | null {
  const hub = readJson('live_indices_quotes.json', memo);
  const q = (hub?.quotes as Record<string, { ltp?: number }> | undefined)?.[u];
  if (!hub || !(Number(q?.ltp) > 0)) return null;
  const spot = Number(q!.ltp);
  const fileAt = tsOf(hub.updated_at);
  // The hub restamps updated_at every ~2 s from its in-memory ticks even when no index tick arrived, so the stamp alone
  // cannot tell a live index from a frozen one. The spot's own age is when its value last CHANGED (+ SPOT_STILL_MS of
  // allowance, an index can print the same value for a few seconds): a feed that stops ticking goes stale on its own.
  // A value first seen (a server restart, a feed that was already frozen) is not fresh until it is seen to change:
  // recorded at 0, so a leftover value can never look like a live cross. Keyed apart from any other source.
  const k = `file:${u}`;
  const seen = spotMoved.get(k);
  if (!seen) spotMoved.set(k, { spot, at: 0 });
  else if (seen.spot !== spot) spotMoved.set(k, { spot, at: fileAt || Date.now() });
  const movedAt = spotMoved.get(k)!.at;
  return { spot, at: movedAt ? Math.min(fileAt, movedAt + SPOT_STILL_MS) : 0, source: 'indices' };
}

/** How long an index may print an unchanged value before it is treated as a frozen feed. */
const SPOT_STILL_MS = 15_000;
/** The same for an MCX futures axis: crude mini can sit on one price longer in a quiet evening, so it gets more room. */
const FUT_STILL_MS = 60_000;
/** Last value and when it last changed, per underlying (in this server process; survives the module via globalThis). */
const spotMoved: Map<string, { spot: number; at: number }> =
  ((globalThis as { __priceLadderSpotMoved?: Map<string, { spot: number; at: number }> }).__priceLadderSpotMoved ??= new Map());

/** Option LTP from a bridge file when one covers this expiry and is fresh. */
function optionLtpFromFiles(c: LadderContract, now: number, memo: FileMemo): number | null {
  const strikeKey = String(c.strike);
  const leg = c.opt === 'CE' ? 'ce' : 'pe';
  const opt = readJson(`live_options_quotes_dhan_${c.underlying.toLowerCase()}.json`, memo);
  if (opt && now - tsOf(opt.updated_at) <= SPOT_STALE_MS) {
    const pick = (book: unknown) => Number((book as Record<string, Record<string, { ltp?: number }>> | undefined)?.[strikeKey]?.[leg]?.ltp) || 0;
    if (opt.expiry === c.expiry) { const v = pick(opt.strikes); if (v > 0) return v; }
    const extra = (opt.extra as Record<string, unknown> | undefined)?.[c.expiry];
    const v = pick(extra);
    if (v > 0) return v;
  }
  const fws = readJson('focus_tool_ws_quotes_dhan.json', memo);
  const fq = fws?.[c.underlying] as { expiry?: string; strikes?: unknown } | undefined;
  if (fws && fq?.expiry === c.expiry && now - tsOf(fws.updated_at) <= SPOT_STALE_MS) {
    const v = Number((fq.strikes as Record<string, Record<string, { ltp?: number }>> | undefined)?.[strikeKey]?.[leg]?.ltp) || 0;
    if (v > 0) return v;
  }
  return null;
}

// ── WebSocket prices ───────────────────────────────────────────────────
// Every price the ladder trades on comes from a Dhan WebSocket — never a REST quote, whose shared lane slows to one call
// per 10+ s after a 429 (seen live: CRUDEOILM's futures axis went stale with every reply ~31 s late). Index spots ride
// live_indices_ws.py's file and option LTPs the options bridges' files. Everything else (SENSEX, an MCX option month's
// futures axis, strikes no bridge covers) comes from scripts/tools/price_ladder_ws.py: a Python consumer of the shared
// market data hub (ONE Dhan connection; the hub only accepts Python consumers), which this server starts on demand. It
// reads what this process wants from debug/price_ladder_ws_wanted_<pid>.json and writes per-instrument LTPs with
// when each was first asked for (`since_ms`) and last CHANGED (`changed_ms`) — the hub keeps old ticks after an
// unsubscribe, so a value being present proves nothing about its age.
// No WebSocket price = no price: levels pause and SIM fills wait rather than act on an old quote.

const WS_WANTED_FILE = path.join(DEBUG_DIR, `price_ladder_ws_wanted_${process.pid}.json`);
const WS_QUOTES = 'price_ladder_ws_quotes.json';
const WS_STATUS_FILE = path.join(DEBUG_DIR, 'price_ladder_ws_status.json');
const WS_START_LOCK = path.join(DEBUG_DIR, 'price_ladder_ws_start.lock');
const WS_LOG = path.join(DEBUG_DIR, 'price_ladder_ws.log');
const WS_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'price_ladder_ws.py');
/** An instrument nobody has asked for in this long is dropped from the wanted list. */
const WS_WANT_TTL_MS = 30_000;
/** The bridge ignores a wanted file 60 s old: rewrite well inside that. */
const WS_REWRITE_MS = 20_000;
/** The bridge's quotes file / heartbeat older than this = the bridge is not running. */
const WS_FILE_STALE_MS = 3_000;
const WS_HEARTBEAT_STALE_MS = 10_000;
const WS_START_EVERY_MS = 30_000;
/** A subscription this old has had the hub's replay of the current last packet (hub scans every 3 s). */
const WS_SETTLED_MS = 8_000;

interface WsState { want: Map<string, number>; written: string; writtenAt: number; startAt: number }
const ws: WsState = ((globalThis as { __priceLadderWs?: WsState }).__priceLadderWs ??= { want: new Map(), written: '', writtenAt: 0, startAt: 0 });

interface WsQuote { ltp: number; ltt?: string; changed_ms: number | null; since_ms: number; high?: number; low?: number; prev_close?: number }

/** Ask the bridge for an instrument; returns its quote key (`SEGMENT:securityId`). */
function wsWant(segment: string, securityId: string): string {
  const k = `${segment}:${securityId}`;
  ws.want.set(k, Date.now());
  return k;
}

/** This process's wanted file (written on change and every 20 s) and the bridge started if it is not running. */
function syncWs(memo: FileMemo): void {
  const now = Date.now();
  for (const [k, at] of ws.want) if (now - at > WS_WANT_TTL_MS) ws.want.delete(k);
  const keys = [...ws.want.keys()].sort();
  const sig = keys.join(',');
  try {
    if (!keys.length) {
      if (ws.written) { fs.rmSync(WS_WANTED_FILE, { force: true }); ws.written = ''; }
      return;
    }
    if (sig !== ws.written || now - ws.writtenAt >= WS_REWRITE_MS) {
      writeJsonAtomic(WS_WANTED_FILE, { pid: process.pid, updated_ms: now, instruments: keys.map(k => k.split(':')) });
      ws.written = sig; ws.writtenAt = now;
    }
  } catch (err) {
    if (warnOnce('ws-wanted', 60_000)) console.warn(`${TAG} could not write the price bridge request:`, (err as Error).message);
    return;
  }
  if (bridgeRunning(memo) || now - ws.startAt < WS_START_EVERY_MS) return;
  ws.startAt = now;
  startBridge();
}

function bridgeRunning(memo: FileMemo): boolean {
  const q = readJson(WS_QUOTES, memo);
  if (q && Date.now() - Number(q.updated_ms) <= WS_FILE_STALE_MS) return true;
  try {
    const st = JSON.parse(fs.readFileSync(WS_STATUS_FILE, 'utf8')) as { status?: string; heartbeat_ms?: number };
    return st.status === 'RUNNING' && Date.now() - Number(st.heartbeat_ms) <= WS_HEARTBEAT_STALE_MS;
  } catch { return false; }
}

/** Spawn the bridge once (O_EXCL lock, stolen after a minute); the bridge itself refuses to run twice. */
function startBridge(): void {
  try {
    try {
      fs.writeFileSync(WS_START_LOCK, String(process.pid), { flag: 'wx' });
    } catch {
      const age = Date.now() - fs.statSync(WS_START_LOCK).mtimeMs;
      if (age < 60_000) return;                         // another process is starting it
      fs.writeFileSync(WS_START_LOCK, String(process.pid));
    }
    const log = fs.openSync(WS_LOG, 'a');
    const child = spawn(PYTHON_EXE, [WS_SCRIPT], { cwd: PROJECT_ROOT, detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.on('error', err => console.warn(`${TAG} price bridge failed to start:`, err.message));
    child.unref();
    fs.closeSync(log);
    // Released once the bridge has had time to write its heartbeat; a crash before then is retried 30 s later.
    setTimeout(() => { try { fs.rmSync(WS_START_LOCK, { force: true }); } catch { /* best effort */ } }, 15_000).unref?.();
    console.log(`${TAG} starting the price bridge (price_ladder_ws.py)`);
  } catch (err) {
    console.warn(`${TAG} could not start the price bridge:`, (err as Error).message);
  }
}

/** A bridge quote, or null when the bridge is not running or does not have it. */
function wsQuote(key: string, memo: FileMemo): WsQuote | null {
  const f = readJson(WS_QUOTES, memo);
  if (!f || Date.now() - Number(f.updated_ms) > WS_FILE_STALE_MS || f.hub_alive === false) return null;
  const q = (f.quotes as Record<string, WsQuote> | undefined)?.[key];
  return q && Number(q.ltp) > 0 ? q : null;
}

/** `days`: a futures axis's day high / low / quote `close` (previous close while its session runs) — display only. */
export interface PriceView {
  spots: Record<string, SpotRead>; ltps: Record<string, number>;
  days?: Record<string, { high: number | null; low: number | null; close: number | null }>;
}

/**
 * Spots for `underlyings` (spot keys: an index name, or a futures contract's key from spotKey()) and LTPs for
 * `contracts`, all from WebSocket feeds. A spot's age is when its value last CHANGED (a frozen feed goes stale on its
 * own; a value never seen to change is not fresh). An option LTP needs a settled subscription or a change since.
 */
export async function loadPrices(underlyings: string[], contracts: LadderContract[]): Promise<PriceView> {
  const now = Date.now();
  const memo: FileMemo = new Map();
  const spots: Record<string, SpotRead> = {};
  const ltps: Record<string, number> = {};
  const days: NonNullable<PriceView['days']> = {};
  for (const u of underlyings) {
    const fut = parseSpotKey(u);
    const f = fut ? null : spotFromFiles(u, memo);
    if (!fut) {
      const hub = readJson('live_indices_quotes.json', memo);
      const hq = (hub?.quotes as Record<string, { high?: number; low?: number; prev_close?: number }> | undefined)?.[u];
      if (hq) days[u] = { high: hq.high ?? null, low: hq.low ?? null, close: hq.prev_close ?? null };
    }
    if (f && spotFresh(f.at, now)) { spots[u] = f; continue; }
    const key = fut ? wsWant(fut.segment, fut.securityId) : INDEX_IDS[u] ? wsWant('IDX_I', INDEX_IDS[u]) : null;
    const q = key ? wsQuote(key, memo) : null;
    if (fut && q) days[u] = { high: q.high ?? null, low: q.low ?? null, close: q.prev_close ?? null };
    if (q && q.changed_ms != null) {
      // Fresh while it keeps changing: the still-allowance (an index may print one value for a few seconds, crude
      // mini longer in a quiet evening) after its last change.
      const still = fut ? FUT_STILL_MS : SPOT_STILL_MS;
      spots[u] = { spot: q.ltp, at: Math.min(now, q.changed_ms + still), source: 'ws' };
    } else if (f) {
      spots[u] = f;                                     // the stale file value, reported as stale
    } else if (q) {
      spots[u] = { spot: q.ltp, at: 0, source: 'ws (not moved yet)' };
    }
  }
  const seen = new Set<string>();
  for (const c of contracts) {
    if (seen.has(c.securityId)) continue;
    seen.add(c.securityId);
    const v = optionLtpFromFiles(c, now, memo);
    if (v) { ltps[c.securityId] = v; continue; }
    const q = wsQuote(wsWant(c.exchangeSegment, c.securityId), memo);
    // An option may not trade for minutes, so its LTP is not aged by change — but a value is only trusted once the
    // subscription has had time for the hub to replay the current packet (or it has changed since we asked).
    if (q && (q.changed_ms != null || now - q.since_ms >= WS_SETTLED_MS)) ltps[c.securityId] = q.ltp;
  }
  syncWs(memo);
  return { spots, ltps, days };
}

// ── broker IO ─────────────────────────────────────────────────────────

export type PlaceOutcome = { status: 'placed'; orderId: string } | { status: 'rejected'; error: string } | { status: 'unknown'; error: string };

export function brokerSessionOk(broker: LadderBroker): boolean {
  if (broker === 'kotak') return isKotakTokenValid();
  if (broker === 'zerodha') return isZerodhaTokenValid();
  try { getDhanCredentials(); return true; } catch { return false; }
}

const dhanProduct = (p: string) => (p === 'NRML' ? 'MARGIN' : 'INTRADAY');

/** Place one order for a slice's contract. `open` orders carry the 'pl' source (its lot cap); closes never do. */
export async function placeFor(
  s: Pick<LadderSlice, 'broker' | 'contract' | 'product'>, side: LadderSide, qty: number, open: boolean,
  how: LadderOrderHow = { type: 'MARKET' },
): Promise<PlaceOutcome> {
  // MCX is Dhan only: Kotak's and Kite's exchange mapping and quantity units here are NSE/BSE F&O's. Checked where the
  // order is built, not only where the contract was resolved, so no path can send crude to an equity F&O exchange.
  if (s.broker !== 'dhan' && (s.contract.exchangeSegment === 'MCX_COMM' || isMcxUnderlying(s.contract.underlying))) {
    return { status: 'rejected', error: `${s.contract.underlying} trades on Dhan only in the Price Ladder` };
  }
  if (s.broker === 'zerodha') return placeZerodha(s, side, qty, open, how);
  if (s.broker === 'kotak') {
    const symbol = s.contract.tradingSymbol;
    if (!symbol) return { status: 'rejected', error: 'No Kotak trading symbol for this contract' };
    const built = buildKotakOrderPayload({
      tradingsymbol: symbol, quantity: qty, side, exchange: kotakExchangeFor(s.contract.underlying), product: s.product,
      // A stop with a limit is an SL-limit ('SL'); without one, SL-M.
      orderType: how.type === 'MARKET' ? 'MARKET' : how.type === 'LIMIT' ? 'LIMIT' : how.limit ? 'SL' : 'SLM',
      ...(how.type === 'LIMIT' ? { price: how.price } : {}), ...(how.type === 'SL' ? { triggerPrice: how.trigger, ...(how.limit ? { price: how.limit } : {}) } : {}),
      ...(open ? { source: 'pl' } : {}),
    }, kotakDerivativeBySymbol(symbol, s.contract.underlying));
    if ('error' in built) return { status: 'rejected', error: built.error };
    const r = await placeKotakOrder(built.payload);
    if (r.status === 'placed') { invalidateBrokerCache('kotak'); return { status: 'placed', orderId: r.orderId }; }
    return r;
  }
  const r = await placeDhanOrder({
    securityId: s.contract.securityId, quantity: qty, side, exchangeSegment: s.contract.exchangeSegment,
    productType: dhanProduct(s.product),
    orderType: how.type === 'MARKET' ? 'MARKET' : how.type === 'LIMIT' ? 'LIMIT' : how.limit ? 'STOP_LOSS' : 'STOP_LOSS_MARKET',
    ...(how.type === 'LIMIT' ? { price: how.price } : {}), ...(how.type === 'SL' ? { triggerPrice: how.trigger, ...(how.limit ? { price: how.limit } : {}) } : {}),
    ...(open ? { source: 'pl' } : {}),
  });
  if (r.status === 'invalid') return { status: 'rejected', error: r.error };
  return r;
}

/** Same order body and checks as /api/scalper/zerodha/order (stops as SL, below): MARKET carries Kite's automatic market protection (-1),
 *  prices snap to the contract tick, opens are lot-capped under the 'pl' source, and a market order above the freeze
 *  quantity is refused (one slice = one order id). */
async function placeZerodha(
  s: Pick<LadderSlice, 'contract' | 'product'>, side: LadderSide, qty: number, open: boolean,
  how: LadderOrderHow,
): Promise<PlaceOutcome> {
  const symbol = s.contract.tradingSymbol;
  if (!symbol) return { status: 'rejected', error: 'No Zerodha trading symbol for this contract' };
  const contract = cachedZerodhaContract(symbol);
  const capError = zerodhaLotCapError(qty, open ? 'pl' : undefined, symbol, contract);
  if (capError) return { status: 'rejected', error: capError };
  const params = zerodhaLadderParams(symbol, zerodhaExchangeFor(s.contract.underlying), side, qty, s.product, how, contract);
  // A slice tracks ONE order id (its fill, its exit), so an order that Kite would need cut into several freeze-size
  // orders is refused, never sliced: the ledger would count only the first one's fill. The 20-lot cap keeps every
  // index under its freeze today (NIFTY 20 x 65 = 1300 < 1800).
  if (slicesFor(symbol, qty).length > 1) return { status: 'rejected', error: `${qty} is above the exchange freeze quantity for one Zerodha order — use fewer lots` };
  const r = await placeZerodhaOrder(params);
  if (r.status === 'placed') { invalidateBrokerCache('zerodha'); return { status: 'placed', orderId: r.orderId }; }
  return r;
}

export interface StatusRead { orderStatus: string; filledQty: number; averageTradedPrice: number; quantity: number; reason: string }

/** One order's status, or null when it could not be read this time. */
async function orderStatus(broker: LadderBroker, orderId: string, books?: OrderBooks): Promise<StatusRead | null> {
  try {
    if (broker === 'zerodha') {
      const rows = books ? await books.zerodha() : (await kiteGet('/orders') as Record<string, unknown>[]);
      const o = (Array.isArray(rows) ? rows : []).find(r => String(r.order_id ?? '') === orderId);
      return o ? shapeZerodhaOrderStatus(o, orderId) : null;
    }
    if (broker === 'kotak') {
      const rows = books ? await books.kotak() : kotakRows(await kotakGet(KOTAK_PATHS.orderBook));
      const o = rows.find(r => String(r.nOrdNo ?? r.orderId ?? '') === orderId);
      return o ? shapeKotakOrderStatus(o, orderId) : null;
    }
    const raw = await dhanGet(`/orders/${encodeURIComponent(orderId)}`, 5000);
    const o = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
    if (!o || typeof o !== 'object') return null;
    return {
      orderStatus: String(o.orderStatus ?? '').toUpperCase(), quantity: Number(o.quantity) || 0,
      filledQty: Number(o.filledQty) || 0, averageTradedPrice: Number(o.averageTradedPrice) || 0,
      reason: String(o.omsErrorDescription ?? o.omsErrorCode ?? ''),
    };
  } catch {
    return null;
  }
}

/** One order-book read per broker per tick (Kotak and Kite have no cheap per-order endpoint for this). */
interface OrderBooks { kotak: () => Promise<Record<string, unknown>[]>; zerodha: () => Promise<Record<string, unknown>[]> }

export async function cancelAtBroker(broker: LadderBroker, orderId: string): Promise<void> {
  if (broker === 'zerodha') { await kiteDelete(`/orders/regular/${encodeURIComponent(orderId)}`); invalidateBrokerCache('zerodha'); return; }
  if (broker === 'kotak') { await kotakPost(KOTAK_PATHS.cancelOrder, { on: orderId, am: 'NO' }); invalidateBrokerCache('kotak'); return; }
  // A cancel counts against Dhan's per-account order-rate window like a placement (CLAUDE.md: order-rate window).
  await reserveOrderSlot();
  await dhanDelete(`/orders/${encodeURIComponent(orderId)}`);
  invalidateBrokerCache('dhan');
}

/** Broker net qty per contract key (Dhan security id / Kotak symbol) + product, or null when the book is unreadable. */
async function brokerBook(broker: LadderBroker): Promise<Map<string, number> | null> {
  try {
    const out = new Map<string, number>();
    if (broker === 'zerodha') {
      const pos = await kiteGet('/portfolio/positions') as { net?: Record<string, unknown>[] } | null;
      for (const p of (pos?.net ?? []).map(shapeZerodhaPosition)) {
        const k = `${p.tradingSymbol}|${String(p.productType).toUpperCase()}`;
        out.set(k, (out.get(k) ?? 0) + (Number(p.netQty) || 0));
      }
      return out;
    }
    if (broker === 'kotak') {
      for (const p of kotakRows(await kotakGet(KOTAK_PATHS.positions)).map(shapeKotakPosition)) {
        const k = `${p.tradingSymbol}|${String(p.productType).toUpperCase()}`;
        out.set(k, (out.get(k) ?? 0) + (Number(p.netQty) || 0));
      }
      return out;
    }
    const rows = await dhanGet('/positions', 8000);
    for (const p of (Array.isArray(rows) ? rows : []) as Record<string, unknown>[]) {
      const k = `${String(p.securityId)}|${String(p.productType).toUpperCase()}`;
      out.set(k, (out.get(k) ?? 0) + (Number(p.netQty) || 0));
    }
    return out;
  } catch {
    return null;
  }
}

const bookKey = (s: LadderSlice) => (bySymbol(s.broker)
  ? `${s.contract.tradingSymbol}|${s.product}`
  : `${s.contract.securityId}|${dhanProduct(s.product)}`);

/** Funds available to trade (Dhan), or null when unreadable. */
export async function dhanAvailableFunds(): Promise<{ buy: number; sell: number } | null> {
  try {
    const f = await dhanGet('/fundlimit', 6000) as Record<string, unknown>;
    const v = Number(f.availabelBalance ?? f.availableBalance);
    if (!Number.isFinite(v)) return null;
    // Premium is paid from cash: collateral (pledged holdings) backs a short's margin but cannot pay for a BUY.
    const collateral = Number(f.collateralAmount) || 0;
    return { buy: Math.max(0, v - collateral), sell: v };
  } catch { return null; }
}

/**
 * What the account can spend, per broker: `buy` pays option premium (cash only — collateral cannot), `sell` backs a
 * short's margin (collateral included). Null = unreadable, which the caller treats as a refusal (fail closed).
 */
export async function availableFunds(broker: LadderBroker): Promise<{ buy: number; sell: number } | null> {
  try {
    if (broker === 'kotak') {
      const f = shapeKotakFunds(await kotakLimits(6000) as Record<string, unknown>);
      return { buy: f.cashBalance, sell: f.availableBalance };
    }
    if (broker === 'zerodha') {
      const m = await kiteGet('/user/margins') as { equity?: { net?: unknown; available?: { live_balance?: unknown } } } | null;
      const net = Number(m?.equity?.net);
      const cash = Number(m?.equity?.available?.live_balance);
      if (!Number.isFinite(net)) return null;
      return { buy: Number.isFinite(cash) ? Math.min(cash, net) : net, sell: net };
    }
    return await dhanAvailableFunds();
  } catch { return null; }
}

/** Dhan's margin for SELLING `qty` of a contract, or null when unreadable. */
export async function dhanSellMargin(c: LadderContract, qty: number, product: string, price: number): Promise<number | null> {
  try {
    const r = await pacedMarginCall(() => dhanPost('/margincalculator', {
      securityId: c.securityId, exchangeSegment: c.exchangeSegment, transactionType: 'SELL', quantity: qty,
      productType: dhanProduct(product), price,
    })) as Record<string, unknown>;
    const m = Number(r?.totalMargin ?? 0);
    return m > 0 ? m : null;
  } catch { return null; }
}

// ── the tick ──────────────────────────────────────────────────────────

const lastPoll = new Map<string, number>();
let lastReconcile = 0;
const warnedAt = new Map<string, number>();

function warnOnce(key: string, ms: number): boolean {
  const t = warnedAt.get(key) ?? 0;
  if (Date.now() - t < ms) return false;
  warnedAt.set(key, Date.now());
  return true;
}

/**
 * Slices / pairs with a job (order, cancel or status read) still running: the next ticks do not start another for them.
 * Counted, not a set — one tick can start two jobs for one pair (a settle and an exit retry), and the first to finish
 * must not clear the mark while the other is still on the wire.
 */
class InFlight {
  private n = new Map<string, number>();
  add(id: string): void { this.n.set(id, (this.n.get(id) ?? 0) + 1); }
  delete(id: string): void { const c = (this.n.get(id) ?? 0) - 1; if (c > 0) this.n.set(id, c); else this.n.delete(id); }
  has(id: string): boolean { return (this.n.get(id) ?? 0) > 0; }
}
const jobsInFlight: InFlight = ((globalThis as { __priceLadderJobCounts?: InFlight }).__priceLadderJobCounts ??= new InFlight());

/** Run an order the API route sends itself under the same in-flight mark, so the watcher never declares it orphaned. */
export async function withJob<T>(id: string, fn: () => Promise<T>): Promise<T> {
  jobsInFlight.add(id);
  try { return await fn(); } finally { jobsInFlight.delete(id); }
}

/** Record a route-sent order's outcome only if the slice is still where the route left it (the user may have resolved it). */
export async function commitIf(id: string, expect: LadderSlice['state'], apply: (s: LadderState) => LadderState): Promise<LadderState> {
  return updateLadderState(st => (st.slices.find(y => y.id === id)?.state === expect ? apply(st) : st));
}

/**
 * Record a job's outcome as soon as it is known, in its own locked write (retried: losing an order id that the broker
 * already returned would turn a live order into UNKNOWN). Applied only while the slice is still in the state the job
 * started from — the user may have resolved or cancelled it meanwhile.
 */
async function commit(id: string, expect: LadderSlice['state'], apply: (s: LadderState) => LadderState): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      await updateLadderState(st => (st.slices.find(y => y.id === id)?.state === expect ? apply(st) : st));
      return;
    } catch (err) {
      if (i === 4) console.error(`${TAG} could not record the outcome for ${id}:`, err);
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

/**
 * Every job runs on its own (one slow broker reply never holds another slice's stop) and writes its outcome the moment
 * it is known. Closes on one contract still share the broker capacity: the book is read once per broker and each close
 * takes its share synchronously before its own order goes out.
 */
async function runJobs(s: LadderState, jobs: Job[], prices: PriceView, pairJobs: PairJob[] = []): Promise<void> {
  const now = Date.now();
  const byId = new Map(s.slices.map(x => [x.id, x]));
  const books = new Map<LadderBroker, Map<string, number> | null>();
  const bookFor = async (b: LadderBroker) => { if (!books.has(b)) books.set(b, await brokerBook(b)); return books.get(b)!; };
  // Closes on one contract in one tick share the broker capacity, so two slices cannot both size off the same row.
  const used = new Map<string, number>();
  // One order-book read per broker serves every settle in this tick.
  let kotakBookP: Promise<Record<string, unknown>[]> | null = null;
  let zerodhaBookP: Promise<Record<string, unknown>[]> | null = null;
  const orderBooks: OrderBooks = {
    kotak: () => (kotakBookP ??= kotakGet(KOTAK_PATHS.orderBook).then(kotakRows)),
    zerodha: () => (zerodhaBookP ??= kiteGet('/orders').then(r => (Array.isArray(r) ? r as Record<string, unknown>[] : []))),
  };

  const one = async (j: Job): Promise<void> => {
    const x = byId.get(j.id);
    if (!x) return;
    let ltp = prices.ltps[x.contract.securityId] ?? 0;
    // A SIM fill or exit needs the option price; a contract armed moments ago may not be in this tick's snapshot yet
    // (seen live: the first cross on a new strike re-armed for lack of it). Wait for it — asking registers it with the
    // price bridge, whose first subscription takes a few seconds (the job runs on its own; other stops keep ticking).
    if (!(ltp > 0) && x.mode === 'sim' && (j.kind === 'open' || j.kind === 'close')) {
      for (let i = 0; i < SIM_PRICE_WAIT_TRIES && !(ltp > 0); i++) {
        ltp = (await loadPrices([], [x.contract])).ltps[x.contract.securityId] ?? 0;
        if (!(ltp > 0)) await new Promise(r => setTimeout(r, 500));
      }
    }
    const done = (apply: (st: LadderState) => LadderState) => commit(x.id, x.state, apply);

    if (j.kind === 'open') {
      if (x.mode === 'sim') {
        if (!(ltp > 0)) {
          await done(st => pushEvent(patchSlice(st, x.id, { state: 'armed', seenSafe: false }), ev('warn', 'SIM entry: no option price — re-armed for the next cross', x.id)));
          return;
        }
        await done(st => openedPatch(st, x, x.qty, ltp, now));
        return;
      }
      const r = await placeFor(x, x.side, x.qty, true);
      await done(st => afterSend(st, x.id, r, 'entry'));
      return;
    }

    if (j.kind === 'close') {
      const exitSide: LadderSide = x.side === 'BUY' ? 'SELL' : 'BUY';
      const own = Number(x.filledQty) || 0;
      if (x.mode === 'sim') {
        if (!(ltp > 0)) {
          await done(st => pushEvent(patchSlice(st, x.id, { state: 'open', exitRetryAt: now + 3000, exitWanted: keepWanted(x) }), ev('warn', 'SIM exit: no option price — retrying', x.id)));
          return;
        }
        await done(st => pushEvent(patchSlice(st, x.id, { state: 'closed', exitAvg: ltp, exitQty: own, closedAt: now }), ev('info', `SIM exit @ ${ltp.toFixed(2)}`, x.id)));
        return;
      }
      const book = await bookFor(x.broker);
      const key = bookKey(x);
      const inGrace = now - (x.openedAt ?? 0) < FILL_GRACE_MS;
      let qty: number;
      if (book == null) qty = exitQtyFor(own, x.side, { failed: true }, inGrace);
      else {
        const raw = book.has(key) ? book.get(key)! : null;
        const usedHere = used.get(key) ?? 0;
        const net = raw == null ? null : (x.side === 'BUY' ? raw - usedHere : raw + usedHere);
        qty = exitQtyFor(own, x.side, { net }, inGrace);
      }
      if (qty <= 0) {
        await done(st => pushEvent(patchSlice(st, x.id, { state: 'closed', exitQty: 0, exitAvg: ltp || undefined, closedAt: now, note: 'Not at the broker any more — closed outside the ladder' }), ev('warn', 'Exit skipped: the broker no longer shows this position', x.id)));
        return;
      }
      used.set(key, (used.get(key) ?? 0) + qty);
      const r = await placeFor(x, exitSide, qty, false);
      await done(st => afterSend(patchSlice(st, x.id, { exitQty: qty }), x.id, r, 'exit'));
      return;
    }

    if (j.kind === 'cancel') {
      try { await cancelAtBroker(x.broker, x.orderId!); } catch (err) { console.warn(`${TAG} cancel failed`, err); }
      return;
    }

    // settle
    lastPoll.set(x.id, Date.now());
    const orderId = j.which === 'entry' ? x.orderId : x.exitOrderId;
    if (!orderId) return;
    const st = await orderStatus(x.broker, orderId, orderBooks);
    const sentAt = j.which === 'entry' ? (x.sentAt ?? now) : (x.exitSentAt ?? now);
    if (!st) {
      // Plain resting orders can sit for hours; only a MARKET order that never shows up times out.
      if ((x.kind === 'xy' || x.market || j.which === 'exit') && now - sentAt > SETTLE_TIMEOUT_MS) {
        await done(s2 => pushEvent(patchSlice(s2, x.id, { state: 'unknown', note: `${j.which === 'entry' ? 'Entry' : 'Exit'} order ${orderId} never confirmed — check Orders/Positions` }), ev('error', `Order ${orderId} status unreadable for 60s: UNKNOWN`, x.id)));
      }
      return;
    }
    const v = settleOrder(st);
    if (v.kind === 'wait') {
      if ((x.kind === 'xy' || x.market || j.which === 'exit') && now - sentAt > SETTLE_TIMEOUT_MS) {
        await done(s2 => pushEvent(patchSlice(s2, x.id, { state: 'unknown', note: `Order ${orderId} still ${st.orderStatus} after 60s — check Orders` }), ev('error', `Order ${orderId} not settled in 60s: UNKNOWN`, x.id)));
      }
      return;
    }
    if (j.which === 'entry') {
      if (v.kind === 'dead') {
        const cancelled = /CANCEL/i.test(v.reason);
        await done(s2 => pushEvent(patchSlice(s2, x.id, { state: cancelled ? 'cancelled' : 'rejected', note: v.reason }), ev(cancelled ? 'info' : 'error', `Entry order ${v.reason}`, x.id)));
      } else {
        await done(s2 => openedPatch(s2, x, v.filledQty, v.avg || ltp, now));
      }
    } else {
      const exitQty = Number(x.exitQty) || Number(x.filledQty) || 0;
      if (v.kind === 'dead') {
        await done(s2 => pushEvent(patchSlice(s2, x.id, { state: 'open', exitRetryAt: now + EXIT_RETRY_MS, exitOrderId: undefined, exitWanted: keepWanted(x) }), ev('error', `Exit ${v.reason} — position still open${keepWanted(x) ? ', retrying in 15s' : ''}`, x.id)));
      } else {
        const filled = Math.min(v.filledQty, Number(x.filledQty) || 0);
        const left = (Number(x.filledQty) || 0) - filled;
        await done(s2 => {
            if (left <= 0) return pushEvent(patchSlice(s2, x.id, { state: 'closed', exitAvg: v.avg || ltp || undefined, closedAt: now }), ev('info', `Exited ${filled} @ ${(v.avg || ltp).toFixed(2)} (${x.exitReason})`, x.id));
            // Part of it closed: book that part as its own closed slice, keep the rest open under this id.
            const closedPart: LadderSlice = { ...x, id: `${x.id}-x${now.toString(36)}`, state: 'closed', filledQty: filled, qty: filled, exitAvg: v.avg || ltp || undefined, closedAt: now, updatedAt: now };
            const rest = patchSlice(s2, x.id, { state: 'open', filledQty: left, exitOrderId: undefined, exitRetryAt: now + EXIT_RETRY_MS, exitWanted: keepWanted(x), note: `Exit filled ${filled} of ${exitQty}` });
            return pushEvent({ ...rest, slices: [...rest.slices, closedPart] }, ev('warn', `Exit filled only ${filled} of ${exitQty}; ${left} still open`, x.id));
        });
      }
    }
  };

  await Promise.allSettled([
    ...jobs.map(async j => {
      jobsInFlight.add(j.id);
      try { await one(j); } catch (err) { console.error(`${TAG} job ${j.kind} ${j.id} failed:`, err); } finally { jobsInFlight.delete(j.id); }
    }),
    // Pair jobs share this tick's broker reads and close capacity: a slice and a pair leg on one contract never both
    // size an exit off the same broker row.
    ...pairJobs.map(async j => {
      jobsInFlight.add(j.id);
      try { await runPairJob(s, j, prices, { bookFor, used, orderBooks }); } catch (err) { console.error(`${TAG} pair job ${j.kind} ${j.id} failed:`, err); } finally { jobsInFlight.delete(j.id); }
    }),
  ]);
}

// ── pair jobs (Pair mode, REAL) ───────────────────────────────────────

interface JobCtx {
  bookFor: (b: LadderBroker) => Promise<Map<string, number> | null>;
  used: Map<string, number>;
  orderBooks: OrderBooks;
}

/** A pair leg in the shape the slice order IO takes (broker, contract, product). */
const legOrder = (p: LadderPair, k: PairLegKey) => ({ broker: p.broker, contract: p.legs[k].contract, product: p.product });
/** The broker book key of a pair leg (the same row a slice on that contract uses). */
const legBookKey = (p: LadderPair, k: PairLegKey) => bookKey({ broker: p.broker, contract: p.legs[k].contract, product: p.product } as LadderSlice);

/** Record a pair job's outcome only while the pair is still in the state the job started from (retried like commit). */
async function commitPair(id: string, expect: LadderPair['state'], apply: (p: LadderPair, s: LadderState) => LadderState): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      await updateLadderState(st => {
        const p = (st.pairs ?? []).find(y => y.id === id);
        return p && p.state === expect ? apply(p, st) : st;
      });
      return;
    } catch (err) {
      if (i === 4) console.error(`${TAG} could not record the outcome for pair ${id}:`, err);
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

/** A send that never throws: an exception is an unknown outcome (the order may have gone out). */
const safePlace = (...a: Parameters<typeof placeFor>): Promise<PlaceOutcome> =>
  placeFor(...a).catch((err: unknown) => ({ status: 'unknown' as const, error: String((err as Error)?.message ?? err) }));

async function runPairJob(s: LadderState, j: PairJob, prices: PriceView, ctx: JobCtx): Promise<void> {
  const p = (s.pairs ?? []).find(y => y.id === j.id);
  if (!p) return;
  const name = pairName(p);
  const now = Date.now();

  if (j.kind === 'pairOpen') {
    // Every leg not yet sent, together (MARKET, the 'pl' lot cap, the broker's own order body): both legs of a new pair
    // or '+1 lot', the new strike(s) of a roll. Every outcome is recorded.
    const toSend = LEG_KEYS.filter(k => !p.legs[k].orderId && !p.legs[k].entry);
    const out = await Promise.all(toSend.map(k => safePlace(legOrder(p, k), p.side, p.qty, true)));
    await commitPair(p.id, p.state, (cur, st) => {
      const legs = { ...cur.legs };
      const msgs: string[] = [];
      toSend.forEach((k, i) => {
        if (legs[k].contract.securityId !== p.legs[k].contract.securityId) return;
        const r = out[i];
        if (r.status === 'placed') legs[k] = { ...legs[k], orderId: r.orderId, entry: 'sent' };
        else if (r.status === 'rejected') { legs[k] = { ...legs[k], entry: 'dead', filledQty: 0, note: r.error }; msgs.push(`${k.toUpperCase()} rejected: ${r.error}`); }
        else { legs[k] = { ...legs[k], entry: 'unknown', unknown: 'entry', note: r.error }; msgs.push(`${k.toUpperCase()} UNKNOWN: ${r.error}`); }
      });
      const next = patchPair(st, p.id, { legs });
      return pushEvent(next, ev(msgs.length ? 'error' : 'info', `${name}: entry orders ${msgs.length ? msgs.join('; ') : 'placed'}`, p.id));
    });
    return;
  }

  if (j.kind === 'pairSettle') {
    lastPoll.set(p.id, Date.now());
    // Per leg: a working entry order, or a placed exit order (a roll can have one leg of each kind in flight).
    const reads = await Promise.all(LEG_KEYS.map(async k => {
      const l = p.legs[k];
      const entry = l.entry === 'sent' && !!l.orderId;
      const id = entry ? l.orderId : l.exitOrderId;
      if (!id) return undefined;
      const st = await orderStatus(p.broker, id, ctx.orderBooks);
      return { id, entry, v: st ? settleOrder(st) : null };
    }));
    await commitPair(p.id, p.state, (cur, st) => {
      const legs = { ...cur.legs };
      let msg = '';
      LEG_KEYS.forEach((k, i) => {
        const read = reads[i];
        if (read === undefined) return;
        const before = legs[k];
        const entry = read.entry;
        // Only for the order that was read: a leg that has since moved on to another order (a retried exit) keeps it.
        if ((entry ? before.orderId : before.exitOrderId) !== read.id || (entry && before.entry !== 'sent')) return;
        const v = read.v;
        const after = entry
          ? settleLegEntry(before, v, cur.sentAt ?? now, now)
          : settleLegExit(before, v, now, prices.ltps[before.contract.securityId]);
        legs[k] = after;
        if (entry && after.entry !== before.entry) msg += ` ${k.toUpperCase()} ${after.entry}${after.avg ? ` @ ${after.avg.toFixed(2)}` : ''}${after.entry === 'dead' ? ` (${after.note})` : ''};`;
        if (!entry && (after.held ?? 0) !== (before.held ?? 0)) msg += ` ${k.toUpperCase()} exited ${(before.held ?? 0) - (after.held ?? 0)} @ ${after.exitAvg?.toFixed(2) ?? '?'};`;
        if (!entry && v?.kind === 'dead') msg += ` ${k.toUpperCase()} exit ${v.reason} — retrying;`;
      });
      const next = patchPair(st, p.id, { legs });
      return msg ? pushEvent(next, ev(/dead|retrying|unknown/.test(msg) ? 'error' : 'info', `${name}:${msg}`, p.id)) : next;
    });
    return;
  }

  // pairClose: each leg marked for sending, sized against the broker book (never more than the broker still shows in
  // that direction, after any slice / leg on the same row this tick), then sent together.
  const exitSide: LadderSide = p.side === 'BUY' ? 'SELL' : 'BUY';
  const send = LEG_KEYS.filter(k => p.legs[k].exitSentAt && !p.legs[k].exitOrderId && (p.legs[k].held ?? 0) > 0);
  const book = send.length ? await ctx.bookFor(p.broker) : null;
  const inGrace = now - (p.openedAt ?? 0) < FILL_GRACE_MS;
  const sized = send.map(k => {
    const own = p.legs[k].held ?? 0;
    const key = legBookKey(p, k);
    let qty: number;
    if (book == null) qty = exitQtyFor(own, p.side, { failed: true }, inGrace);
    else {
      const raw = book.has(key) ? book.get(key)! : null;
      const usedHere = ctx.used.get(key) ?? 0;
      qty = exitQtyFor(own, p.side, { net: raw == null ? null : (p.side === 'BUY' ? raw - usedHere : raw + usedHere) }, inGrace);
    }
    if (qty > 0) ctx.used.set(key, (ctx.used.get(key) ?? 0) + qty);
    return { k, qty };
  });
  const out = await Promise.all(sized.map(({ k, qty }) => (qty > 0 ? safePlace(legOrder(p, k), exitSide, qty, false) : Promise.resolve(null))));
  await commitPair(p.id, p.state, (cur, st) => {
    const legs = { ...cur.legs };
    const msgs: string[] = [];
    sized.forEach(({ k, qty }, i) => {
      const r = out[i];
      const l = legs[k];
      if (r == null) {
        // The broker no longer shows it: closed outside the ladder (booked at the live price when there is one).
        Object.assign(legs, cutPairLeg({ ...cur, legs }, k, l.held ?? 0, prices.ltps[l.contract.securityId], now).legs);
        legs[k] = { ...legs[k], exitSentAt: undefined };
        msgs.push(`${k.toUpperCase()} not at the broker any more — closed outside the ladder`);
      } else if (r.status === 'placed') legs[k] = { ...l, exitOrderId: r.orderId, exitQty: qty };
      else if (r.status === 'rejected') { legs[k] = { ...l, exitSentAt: undefined, exitRetryAt: now + PAIR_EXIT_RETRY_MS, note: `Exit rejected: ${r.error}` }; msgs.push(`${k.toUpperCase()} exit rejected: ${r.error} — retrying in 15s`); }
      else { legs[k] = { ...l, unknown: 'exit', note: r.error }; msgs.push(`${k.toUpperCase()} exit UNKNOWN: ${r.error}`); }
    });
    const next = patchPair(st, p.id, { legs });
    return pushEvent(next, ev(msgs.length ? (msgs.some(m => /UNKNOWN|rejected/.test(m)) ? 'error' : 'warn') : 'info', `${name}: exit ${msgs.length ? msgs.join('; ') : `orders placed (${sized.map(x => `${x.qty} ${x.k.toUpperCase()}`).join(' + ')})`}`, p.id));
  });
}

export function openedPatch(s: LadderState, x: LadderSlice, qty: number, avg: number, now: number): LadderState {
  const patch: Partial<LadderSlice> = { state: 'open', filledQty: qty, avg: avg || undefined, openedAt: now };
  // A lot added to an open position arrives with that position's levels already set: it keeps them (one widget, one exit).
  if (x.kind === 'xy' && x.bracket && x.slY == null) {
    // The bracket keeps its planned distances (OptionX: 23180 -> 23223 / 23149) but is measured from the index level
    // where the entry actually fired: a gap through the level must not leave the SL already hit.
    const base = Number(x.entryY) || Number(x.entryLevel);
    const lv = bracketLevels(bias(x.contract.opt, x.side), base, x.bracket);
    Object.assign(patch, { entryY: base, tgtY: lv.tgtY, slY: lv.slY, slY0: lv.slY, peakY: base });
  }
  const label = x.mode === 'sim' ? 'SIM ' : '';
  const short = qty < x.qty ? ` (only ${qty} of ${x.qty})` : '';
  return pushEvent(patchSlice(s, x.id, patch), ev('info', `${label}${x.side} ${x.contract.strike}${x.contract.opt} filled ${qty}${short} @ ${avg ? avg.toFixed(2) : '?'}`, x.id));
}

/** A manual exit stays wanted after a failed attempt (an automatic one re-fires from its own rule). */
const keepWanted = (x: LadderSlice) => (x.exitReason === 'Manual exit' ? 'Manual exit' : undefined);

export function afterSend(s: LadderState, id: string, r: PlaceOutcome, which: 'entry' | 'exit'): LadderState {
  if (r.status === 'placed') {
    return patchSlice(s, id, which === 'entry' ? { state: 'working', orderId: r.orderId } : { state: 'exiting', exitOrderId: r.orderId });
  }
  if (r.status === 'unknown') {
    return pushEvent(patchSlice(s, id, { state: 'unknown', note: r.error }), ev('error', `${which === 'entry' ? 'Entry' : 'Exit'} UNKNOWN — ${r.error}`, id));
  }
  if (which === 'entry') return pushEvent(patchSlice(s, id, { state: 'rejected', note: r.error }), ev('error', `Entry rejected: ${r.error}`, id));
  return pushEvent(patchSlice(s, id, x => ({ state: 'open', exitRetryAt: Date.now() + EXIT_RETRY_MS, exitWanted: keepWanted(x) })), ev('error', `Exit rejected: ${r.error} — retrying in 15s`, id));
}

/**
 * Clamp REAL open slices DOWN to the broker (never up): when the broker shows less in a slice's direction than the
 * ladder holds on that contract, the newest slices outside the fill grace are closed as "closed outside the ladder".
 */
async function reconcileDown(s: LadderState, prices: PriceView, now: number): Promise<void> {
  const out: { kind: 'slice' | 'pair'; id: string; apply: (st: LadderState) => LadderState }[] = [];
  // One broker book row (contract + product) can hold slices AND pair legs: the ladder's whole ownership on it is
  // compared with the broker, so neither engine's units hide a gap in the other's.
  type Holder = { id: string; qty: number; openedAt: number; side: LadderSide; slice?: LadderSlice; pair?: { p: LadderPair; k: PairLegKey } };
  const groups = new Map<string, { broker: LadderBroker; holders: Holder[] }>();
  const add = (broker: LadderBroker, key: string, h: Holder) => {
    const k = `${broker}|${key}`;
    (groups.get(k) ?? groups.set(k, { broker, holders: [] }).get(k)!).holders.push(h);
  };
  for (const x of s.slices) {
    if (x.mode !== 'real' || x.state !== 'open') continue;
    add(x.broker, bookKey(x), { id: x.id, qty: Number(x.filledQty) || 0, openedAt: x.openedAt ?? 0, side: x.side, slice: x });
  }
  for (const p of s.pairs ?? []) {
    if (p.mode !== 'real' || (p.state !== 'open' && p.state !== 'broken')) continue;
    for (const k of LEG_KEYS) {
      if ((p.legs[k].held ?? 0) > 0) add(p.broker, legBookKey(p, k), { id: `${p.id}:${k}`, qty: p.legs[k].held!, openedAt: p.openedAt ?? 0, side: p.side, pair: { p, k } });
    }
  }
  if (!groups.size) return;
  const books = new Map<LadderBroker, Map<string, number> | null>();
  for (const [k, g] of groups) {
    const broker = g.broker;
    if (!books.has(broker)) books.set(broker, await brokerBook(broker));
    const book = books.get(broker);
    if (!book) continue;                                        // unreadable: leave the ledger alone
    if (g.holders.some(h => now - h.openedAt < FILL_GRACE_MS)) continue; // a fresh fill may not be in the book yet
    const raw = book.get(k.slice(broker.length + 1)) ?? 0;
    for (const side of ['BUY', 'SELL'] as const) {
      const mine = g.holders.filter(h => h.side === side);
      const capacity = side === 'BUY' ? Math.max(0, raw) : Math.max(0, -raw);
      const cuts = cutsNewestFirst(mine, capacity);
      for (const h of mine) {
        const cut = cuts.get(h.id);
        if (!cut) continue;
        if (h.pair) {
          const { p, k: leg } = h.pair;
          const ltp = prices.ltps[p.legs[leg].contract.securityId];
          out.push({
            kind: 'pair',
            id: p.id,
            apply: st => {
              const cur = (st.pairs ?? []).find(y => y.id === p.id);
              if (!cur || (cur.state !== 'open' && cur.state !== 'broken')) return st;
              const patch = cutPairLeg(cur, leg, Math.min(cut, cur.legs[leg].held ?? 0), ltp, now);
              return pushEvent(patchPair(st, p.id, patch, now), ev('error', `${pairName(cur)}: broker shows ${cut} fewer ${leg.toUpperCase()} — ${patch.state === 'closed' ? 'both legs gone, closed' : 'pair BROKEN, bracket stopped; exit what is left from the pair table'}`, p.id));
            },
          });
          continue;
        }
        const x = h.slice!;
        const ltp = prices.ltps[x.contract.securityId];
        out.push({
          kind: 'slice',
          id: x.id,
          apply: st => {
            const cur = st.slices.find(y => y.id === x.id);
            if (!cur || cur.state !== 'open') return st;
            const left = (Number(cur.filledQty) || 0) - cut;
            if (left <= 0) return pushEvent(patchSlice(st, x.id, { state: 'closed', exitQty: 0, exitAvg: ltp || undefined, closedAt: now, note: 'Closed outside the ladder' }), ev('warn', `${x.contract.strike}${x.contract.opt}: broker shows it closed — dropped from the ladder`, x.id));
            return pushEvent(patchSlice(st, x.id, { filledQty: left }), ev('warn', `${x.contract.strike}${x.contract.opt}: broker shows ${cut} fewer — ladder qty reduced`, x.id));
          },
        });
      }
    }
  }
  // Pair cuts check their own state inside apply (open or broken); slice cuts need the slice still open.
  for (const o of out) {
    if (o.kind === 'pair') await updateLadderState(o.apply);
    else await commit(o.id, 'open', o.apply);
  }
}

const LOOP_KEY = '__priceLadderLoop';
type LoopHolder = { [LOOP_KEY]?: { timer: ReturnType<typeof setInterval>; busy: boolean; startedAt?: number } };
/** No "price is stale" event this soon after the watcher starts. */
const START_GRACE_MS = 30_000;
const loopStartedAt = () => (globalThis as LoopHolder)[LOOP_KEY]?.startedAt ?? 0;

/** One resting REAL order pulled by a tripped guard. A failure is only an error if the order is still resting after it. */
async function guardCancel(x: LadderSlice): Promise<void> {
  try {
    await Promise.race([cancelAtBroker(x.broker, x.orderId!), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out after 8 s')), 8000))]);
  } catch (err) {
    console.error(`${TAG} guard cancel failed for ${x.orderId}:`, err);
    const still = readLadderState().slices.find(y => y.id === x.id)?.state === 'working';
    if (still) await updateLadderState(st => pushEvent(st, ev('error', `MTM guard: could not cancel the resting order ${x.orderId} (${(err as Error).message}) — cancel it at the broker; the guard stays on until it is gone`, x.id)));
  }
}

let reconciling = false;

async function tick(): Promise<void> {
  let s: LadderState;
  try { s = readLadderState(); } catch (err) {
    if (warnOnce('unreadable', 60_000)) console.error(`${TAG}`, (err as Error).message);
    return;
  }
  // UNKNOWN slices wait for the user and need nothing from the watcher; everything else live does.
  const live = s.slices.filter(x => isLive(x) && x.state !== 'unknown');
  const livePairs = (s.pairs ?? []).filter(isPairLive);
  if (!live.length && !livePairs.length) return;
  const now = Date.now();
  // Prices only for slices whose rules read them (armed / open XY need spot; SIM fills and exits need the option LTP).
  // An exiting REAL slice is priced too: its open units count in the MTM, and an unpriced one blinds the global guard.
  const priced = live.filter(x => x.state === 'armed' || x.state === 'open' || x.state === 'exiting' || (x.mode === 'sim' && x.state === 'working'));
  const underlyings = [...new Set(priced.map(x => spotKey(x.contract)))];
  // A pair's rules read both legs' premiums (its combined price).
  const pairLegs = livePairs.flatMap(p => [p.legs.ce.contract, p.legs.pe.contract, ...(p.rollTo?.ce ? [p.rollTo.ce] : []), ...(p.rollTo?.pe ? [p.rollTo.pe] : [])]);
  const prices: PriceView = priced.length || pairLegs.length
    ? await loadPrices(underlyings, [...priced.map(x => x.contract), ...pairLegs]) : { spots: {}, ltps: {} };

  for (const u of underlyings) {
    const needsSpot = live.some(x => spotKey(x.contract) === u && x.kind === 'xy' && (x.state === 'armed' || x.state === 'open'));
    const sp = prices.spots[u];
    // Not in the first moments after a start: a price is only trusted once it is seen to change (and the price bridge
    // may still be subscribing), so every start would otherwise log a "stale" that is not one.
    if (needsSpot && now - loopStartedAt() > START_GRACE_MS && !(sp && spotFresh(sp.at, now)) && warnOnce(`stale:${u}`, 60_000)) {
      await updateLadderState(st => pushEvent(st, ev('warn', `${spotKeyUnderlying(u)}${parseSpotKey(u) ? ' futures' : ''} price is stale — levels paused`)));
    }
  }

  const io = {
    // A slice whose previous job is still running is not polled again.
    polledAt: (id: string) => (jobsInFlight.has(id) ? Number.POSITIVE_INFINITY : lastPoll.get(id) ?? 0),
    mayCancel: (id: string) => !jobsInFlight.has(id) && warnOnce(`cancel:${id}`, 30_000),
    busy: (id: string) => jobsInFlight.has(id),
  };
  // Plan and mark inside the lock, so the jobs match exactly what was written (a request may have changed a slice
  // between our read and the lock). Opens and closes are protected by that mark: the next tick sees 'placing' /
  // 'exiting' and never sends them again.
  let jobs: Job[] = [];
  let pairJobs: PairJob[] = [];
  const planned = await updateLadderState(cur => {
    // The global MTM guards first: a trip queues every exit of its scope, which planTick then sends in this same write.
    const g = applyGuards(cur, prices.ltps, now);
    cur = g.next;
    const r = planTick(cur, prices, now, io);
    jobs = r.jobs;
    // Pairs: SIM fills / exits happen in this write; REAL orders are marked here and sent by the pair jobs below.
    const pr = planPairs(r.next, prices.ltps, now, io);
    pairJobs = pr.jobs;
    return pr.next;
  });
  // A tripped guard also pulls the resting REAL entry orders (a fill after the exit would reopen what it just closed).
  // Off the tick (a slow broker endpoint must not stall every other stop), retried every 30 s while one still rests.
  for (const [key, g] of Object.entries(planned.guards ?? {})) {
    if (!g.tripped) continue;
    const [broker, mode] = key.split(':');
    for (const x of planned.slices.filter(y => y.broker === broker && y.mode === mode && y.mode === 'real' && y.state === 'working' && y.orderId)) {
      if (!warnOnce(`guard-cancel:${x.id}`, 30_000)) continue;
      void guardCancel(x);
    }
  }
  // Not awaited: the watcher keeps ticking (and checking every other stop) while orders are on the wire.
  if (jobs.length || pairJobs.length) void runJobs(planned, jobs, prices, pairJobs);
  if (!reconciling && Date.now() - lastReconcile >= RECONCILE_MS) {
    lastReconcile = Date.now();
    reconciling = true;
    void reconcileDown(planned, prices, now).catch(err => console.error(`${TAG} reconcile failed:`, err)).finally(() => { reconciling = false; });
  }
}

/** Start the watcher once per server process (idempotent; a no-op file read each second while nothing is live). */
export function startPriceLadderLoop(): void {
  const g = globalThis as LoopHolder;
  if (g[LOOP_KEY]) return;
  const holder = { busy: false, startedAt: Date.now(), timer: setInterval(() => {
    if (holder.busy) return;
    holder.busy = true;
    tick().catch(err => console.error(`${TAG} tick failed:`, err)).finally(() => { holder.busy = false; });
  }, TICK_MS) };
  g[LOOP_KEY] = holder;
  console.log(`${TAG} watcher started`);
}
