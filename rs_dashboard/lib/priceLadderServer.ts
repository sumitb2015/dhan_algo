import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { withFileLock, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { getDhanCredentials, dhanGet, dhanDelete, dhanPost } from '@/lib/dhanToken';
import { pacedQuoteCall } from '@/lib/dhanQuotePacer';
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
  type Job, type LadderBroker, type LadderContract, type LadderSide, type LadderSlice, type LadderState,
} from '@/lib/priceLadder';

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
const TICK_MS = 1000;
const RECONCILE_MS = 5000;
const REST_QUOTE_MS = 2000;
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
    return {
      date: String(s.date ?? istDay()),
      slices: Array.isArray(s.slices) ? s.slices : [],
      events: Array.isArray(s.events) ? s.events : [],
      ...(s.liveArmedOn ? { liveArmedOn: String(s.liveArmedOn) } : {}),
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
    if (next !== base) writeJsonAtomic(STATE_FILE, next);
    return next;
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
 * value there would pass as fresh. SENSEX is not on the hub and comes from the paced REST quote instead.
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
  const seen = spotMoved.get(u);
  if (!seen || seen.spot !== spot) spotMoved.set(u, { spot, at: fileAt || Date.now() });
  const movedAt = spotMoved.get(u)!.at;
  return { spot, at: Math.min(fileAt, movedAt + SPOT_STILL_MS), source: 'indices' };
}

/** How long an index may print an unchanged value before it is treated as a frozen feed. */
const SPOT_STILL_MS = 15_000;
/** The same for an MCX futures axis: crude mini can sit on one price longer in a quiet evening, so it gets more room. */
const FUT_STILL_MS = 60_000;
/** When `key`'s value last changed (recorded on first sight). */
function movedAt(key: string, v: number, at: number): number {
  const seen = spotMoved.get(key);
  if (!seen || seen.spot !== v) spotMoved.set(key, { spot: v, at });
  return spotMoved.get(key)!.at;
}
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

// One paced REST call (index spots + option LTPs in a single /marketfeed/ltp request) at most every 2 s, for what no
// file could supply. Every caller (the watcher's tick, each tab's poll) registers what it needs in `wanted`, and each
// fetch asks for everything wanted recently — so callers asking for different contracts never starve each other.
// Values are cached per key with their own time. Shares the account-wide quote lane with every other dashboard caller.
const WANT_TTL_MS = 10_000;
const wantedSpots = new Map<string, number>();
const wantedContracts = new Map<string, { c: LadderContract; at: number }>();
const restSpots = new Map<string, { v: number; at: number }>();
const restLtps = new Map<string, { v: number; at: number }>();
let restAt = 0;
const attemptedAt = new Map<string, number>();
let restInFlight: Promise<void> | null = null;

async function refreshRest(underlyings: string[], contracts: LadderContract[]): Promise<void> {
  const now = Date.now();
  // A spot key is an index name (IDX_I) or names a contract (an MCX futures month: its own segment).
  for (const u of underlyings) if (INDEX_IDS[u] || parseSpotKey(u)) wantedSpots.set(u, now);
  for (const c of contracts) wantedContracts.set(c.securityId, { c, at: now });
  // A fetch already under way may not include keys asked for after it started: wait for it, then fetch again at once
  // if anything asked for here is still missing (the quote lane itself spaces the calls). Otherwise one per 2 s.
  if (restInFlight) await restInFlight;
  // "Missing" = no fresh value AND not asked of Dhan in the last 2 s: a key Dhan returns nothing for (an illiquid strike)
  // or a run of failed fetches then waits for the normal cadence instead of making every caller fetch again.
  const have = (m: Map<string, { at: number }>, k: string) => { const r = m.get(k); return !!r && Date.now() - r.at <= SPOT_STALE_MS; };
  const triedRecently = (k: string) => Date.now() - (attemptedAt.get(k) ?? 0) < REST_QUOTE_MS;
  const missing = underlyings.some(u => (INDEX_IDS[u] || parseSpotKey(u)) && !have(restSpots, u) && !triedRecently(`u:${u}`))
    || contracts.some(c => !have(restLtps, c.securityId) && !triedRecently(`c:${c.securityId}`));
  if (restInFlight) return restInFlight;
  if (!missing && Date.now() - restAt < REST_QUOTE_MS) return;
  for (const [k, at] of wantedSpots) if (now - at > WANT_TTL_MS) wantedSpots.delete(k);
  for (const [k, w] of wantedContracts) if (now - w.at > WANT_TTL_MS) wantedContracts.delete(k);
  const us = [...wantedSpots.keys()];
  const cs = [...wantedContracts.values()].map(w => w.c);
  const body: Record<string, number[]> = {};
  for (const u of us) {
    const ref = parseSpotKey(u);
    if (ref) (body[ref.segment] ??= []).push(Number(ref.securityId));
    else (body.IDX_I ??= []).push(Number(INDEX_IDS[u]));
  }
  for (const c of cs) (body[c.exchangeSegment] ??= []).push(Number(c.securityId));
  if (!Object.keys(body).length) return;
  restAt = Date.now();
  for (const u of us) attemptedAt.set(`u:${u}`, restAt);
  for (const c of cs) attemptedAt.set(`c:${c.securityId}`, restAt);
  restInFlight = (async () => {
    try {
      const res = await pacedQuoteCall(() => dhanPost('/marketfeed/ltp', body, 5000)) as { data?: Record<string, Record<string, { last_price?: number }>> };
      const at = Date.now();
      for (const u of us) {
        const ref = parseSpotKey(u);
        const v = Number(ref ? res.data?.[ref.segment]?.[ref.securityId]?.last_price : res.data?.IDX_I?.[INDEX_IDS[u]]?.last_price) || 0;
        if (v > 0) restSpots.set(u, { v, at });
      }
      for (const c of cs) {
        const v = Number(res.data?.[c.exchangeSegment]?.[c.securityId]?.last_price) || 0;
        if (v > 0) restLtps.set(c.securityId, { v, at });
      }
    } catch (err) {
      const e = err as { busy?: boolean; status?: number };
      if (!e.busy && e.status !== 429) console.warn(`${TAG} REST quote failed:`, (err as Error).message);
    } finally {
      restInFlight = null;
    }
  })();
  return restInFlight;
}

export interface PriceView { spots: Record<string, SpotRead>; ltps: Record<string, number> }

/**
 * Spots for `underlyings` (spot keys: an index name, or a futures contract's key from spotKey()) and LTPs for
 * `contracts`: files first (indices only — a futures axis always comes from the paced REST quote), REST for the rest.
 */
export async function loadPrices(underlyings: string[], contracts: LadderContract[]): Promise<PriceView> {
  const now = Date.now();
  const memo: FileMemo = new Map();
  const spots: Record<string, SpotRead> = {};
  const ltps: Record<string, number> = {};
  const needU: string[] = [];
  for (const u of underlyings) {
    const f = parseSpotKey(u) ? null : spotFromFiles(u, memo);
    if (f && spotFresh(f.at, now)) spots[u] = f; else needU.push(u);
  }
  const needC: LadderContract[] = [];
  const seen = new Set<string>();
  for (const c of contracts) {
    if (seen.has(c.securityId)) continue;
    seen.add(c.securityId);
    const v = optionLtpFromFiles(c, now, memo);
    if (v) ltps[c.securityId] = v; else needC.push(c);
  }
  if (needU.length || needC.length) {
    await refreshRest(needU, needC);
    for (const u of needU) {
      const r = restSpots.get(u);
      if (!r) continue;
      // A futures axis has no feed of its own to go quiet: REST keeps returning the last price, stamped with the fetch
      // time. Age it by when the value last CHANGED (as the indices hub is), so a frozen price pauses levels and stops.
      const fut = parseSpotKey(u);
      const at = fut ? Math.min(r.at, movedAt(u, r.v, r.at) + FUT_STILL_MS) : r.at;
      spots[u] = { spot: r.v, at, source: 'rest' };
    }
    for (const c of needC) { const r = restLtps.get(c.securityId); if (r && Date.now() - r.at <= SPOT_STALE_MS) ltps[c.securityId] = r.v; }
  }
  return { spots, ltps };
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
  how: { type: 'MARKET' } | { type: 'LIMIT'; price: number } | { type: 'SL'; trigger: number } = { type: 'MARKET' },
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
      orderType: how.type === 'MARKET' ? 'MARKET' : how.type === 'LIMIT' ? 'LIMIT' : 'SLM',
      ...(how.type === 'LIMIT' ? { price: how.price } : {}), ...(how.type === 'SL' ? { triggerPrice: how.trigger } : {}),
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
    orderType: how.type === 'MARKET' ? 'MARKET' : how.type === 'LIMIT' ? 'LIMIT' : 'STOP_LOSS_MARKET',
    ...(how.type === 'LIMIT' ? { price: how.price } : {}), ...(how.type === 'SL' ? { triggerPrice: how.trigger } : {}),
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
  how: { type: 'MARKET' } | { type: 'LIMIT'; price: number } | { type: 'SL'; trigger: number },
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

/** Slices with a job (order, cancel or status read) still running: the next ticks do not start another for them. */
const jobsInFlight: Set<string> = ((globalThis as { __priceLadderJobs?: Set<string> }).__priceLadderJobs ??= new Set());

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
async function runJobs(s: LadderState, jobs: Job[], prices: PriceView): Promise<void> {
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
    // (seen live: the first cross on a new strike re-armed for lack of it). Ask for it now — loadPrices waits for a fetch.
    if (!(ltp > 0) && x.mode === 'sim' && (j.kind === 'open' || j.kind === 'close')) {
      ltp = (await loadPrices([], [x.contract])).ltps[x.contract.securityId] ?? 0;
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

  await Promise.allSettled(jobs.map(async j => {
    jobsInFlight.add(j.id);
    try { await one(j); } catch (err) { console.error(`${TAG} job ${j.kind} ${j.id} failed:`, err); } finally { jobsInFlight.delete(j.id); }
  }));
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
  const out: { id: string; apply: (st: LadderState) => LadderState }[] = [];
  const groups = new Map<string, LadderSlice[]>();
  for (const x of s.slices) {
    if (x.mode !== 'real' || x.state !== 'open') continue;
    const k = `${x.broker}|${bookKey(x)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(x);
  }
  if (!groups.size) return;
  const books = new Map<LadderBroker, Map<string, number> | null>();
  for (const [k, xs] of groups) {
    const broker = xs[0].broker;
    if (!books.has(broker)) books.set(broker, await brokerBook(broker));
    const book = books.get(broker);
    if (!book) continue;                                        // unreadable: leave the ledger alone
    if (xs.some(x => now - (x.openedAt ?? 0) < FILL_GRACE_MS)) continue; // a fresh fill may not be in the book yet
    const raw = book.get(k.slice(broker.length + 1)) ?? 0;
    for (const side of ['BUY', 'SELL'] as const) {
      const mine = xs.filter(x => x.side === side).sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
      let own = mine.reduce((a, x) => a + (Number(x.filledQty) || 0), 0);
      const capacity = side === 'BUY' ? Math.max(0, raw) : Math.max(0, -raw);
      for (const x of mine) {
        if (own <= capacity) break;
        const cut = Math.min(Number(x.filledQty) || 0, own - capacity);
        own -= cut;
        const ltp = prices.ltps[x.contract.securityId];
        out.push({
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
  for (const o of out) await commit(o.id, 'open', o.apply);
}

const LOOP_KEY = '__priceLadderLoop';
type LoopHolder = { [LOOP_KEY]?: { timer: ReturnType<typeof setInterval>; busy: boolean } };

let reconciling = false;

async function tick(): Promise<void> {
  let s: LadderState;
  try { s = readLadderState(); } catch (err) {
    if (warnOnce('unreadable', 60_000)) console.error(`${TAG}`, (err as Error).message);
    return;
  }
  // UNKNOWN slices wait for the user and need nothing from the watcher; everything else live does.
  const live = s.slices.filter(x => isLive(x) && x.state !== 'unknown');
  if (!live.length) return;
  const now = Date.now();
  // Prices only for slices whose rules read them (armed / open XY need spot; SIM fills and exits need the option LTP).
  const priced = live.filter(x => x.state === 'armed' || x.state === 'open' || (x.mode === 'sim' && (x.state === 'working' || x.state === 'exiting')));
  const underlyings = [...new Set(priced.map(x => spotKey(x.contract)))];
  const prices: PriceView = priced.length ? await loadPrices(underlyings, priced.map(x => x.contract)) : { spots: {}, ltps: {} };

  for (const u of underlyings) {
    const needsSpot = live.some(x => spotKey(x.contract) === u && x.kind === 'xy' && (x.state === 'armed' || x.state === 'open'));
    const sp = prices.spots[u];
    if (needsSpot && !(sp && spotFresh(sp.at, now)) && warnOnce(`stale:${u}`, 60_000)) {
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
  const planned = await updateLadderState(cur => { const r = planTick(cur, prices, now, io); jobs = r.jobs; return r.next; });
  // Not awaited: the watcher keeps ticking (and checking every other stop) while orders are on the wire.
  if (jobs.length) void runJobs(planned, jobs, prices);
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
  const holder = { busy: false, timer: setInterval(() => {
    if (holder.busy) return;
    holder.busy = true;
    tick().catch(err => console.error(`${TAG} tick failed:`, err)).finally(() => { holder.busy = false; });
  }, TICK_MS) };
  g[LOOP_KEY] = holder;
  console.log(`${TAG} watcher started`);
}
