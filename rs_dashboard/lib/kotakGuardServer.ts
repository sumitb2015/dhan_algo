import fs from 'fs';
import path from 'path';
import { kotakGet, kotakRows, KOTAK_PATHS, isKotakTokenValid, KotakRejectedError } from '@/lib/kotakToken';
import { placeKotakOrder } from '@/lib/kotakPlaceOrder';
import { shapeKotakPosition } from '@/lib/kotakShape';
import { joinKotakLtp, kotakSymbolMap, underlyingPrefix } from '@/lib/kotakLtpJoin';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { PROJECT_ROOT } from '@/lib/pyExec';
import {
  emptyGuardState, stepGuards, contractPricesFromBridges, type ServerGuardState, type PosView, type ExitOrder, type BridgeQuoteFile,
} from '@/lib/kotakGuardEngine';

// The server-resident Kotak guards (P&L Guard + brackets): file store, tick loop and order sending around the pure engine
// in lib/kotakGuardEngine.ts. The state lives in debug/kotak_server_guards.json and is re-read on every tick and every
// request, never cached in memory, because the instrumentation hook and each API route can run as separate module
// instances. Writes go through a lock file so a request and a tick cannot overwrite each other.

const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');
const STATE_FILE = path.join(DEBUG_DIR, 'kotak_server_guards.json');
const LOCK_FILE = `${STATE_FILE}.lock`;
const TICK_MS = 2500;
const QUOTES_FRESH_MS = 6000;
const LOCK_STALE_MS = 8000;

export const istDay = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

function readStateFile(): ServerGuardState {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<ServerGuardState>;
    return {
      date: String(s.date ?? istDay()), pnl: s.pnl ?? null,
      brackets: Array.isArray(s.brackets) ? s.brackets : [], watch: Array.isArray(s.watch) ? s.watch : [],
      events: Array.isArray(s.events) ? s.events : [],
    };
  } catch {
    return emptyGuardState(istDay());
  }
}

function writeStateFile(s: ServerGuardState): void {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

async function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_STALE_MS;
  for (;;) {
    try {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      fs.closeSync(fs.openSync(LOCK_FILE, 'wx'));
      break;
    } catch {
      try { if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(LOCK_FILE); } catch { /* raced */ }
      if (Date.now() > deadline) throw new Error('kotak guard state is locked');
      await new Promise(r => setTimeout(r, 25));
    }
  }
  try { return await fn(); } finally { try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ } }
}

/** Current state (read-only view; rolls to a fresh day without writing). */
export function readGuardState(): ServerGuardState {
  const s = readStateFile();
  return s.date === istDay() ? s : emptyGuardState(istDay());
}

/** Read-modify-write under the lock. The mutator returns the next state. */
export async function updateGuardState(mutate: (s: ServerGuardState) => ServerGuardState): Promise<ServerGuardState> {
  return withLock(() => {
    const cur = readStateFile();
    const base = cur.date === istDay() ? cur : emptyGuardState(istDay());
    const next = mutate(base);
    writeStateFile(next);
    return next;
  });
}

// ── prices ───────────────────────────────────────────────────────────

interface QuoteFile {
  expiry?: string; updated_at?: string;
  strikes?: Record<string, { ce?: { ltp?: number }; pe?: { ltp?: number } }>;
  extra?: Record<string, Record<string, { ce?: { ltp?: number }; pe?: { ltp?: number } }>>;
}

/** Tick-fresh prices from the live options bridge (while one is running); null when the file is absent or stale. */
function readQuoteFile(underlying: string): QuoteFile | null {
  try {
    const f = path.join(DEBUG_DIR, `live_options_quotes_dhan_${underlying.toLowerCase()}.json`);
    const q = JSON.parse(fs.readFileSync(f, 'utf8')) as QuoteFile;
    const at = Date.parse(String(q.updated_at ?? ''));
    return Number.isFinite(at) && Date.now() - at <= QUOTES_FRESH_MS ? q : null;
  } catch { return null; }
}

async function bridgePrice(symbol: string, maps: Map<string, Awaited<ReturnType<typeof kotakSymbolMap>>>, quotes: Map<string, QuoteFile | null>): Promise<number> {
  const u = underlyingPrefix(symbol);
  if (!u) return 0;
  if (!maps.has(u)) { try { maps.set(u, await kotakSymbolMap(u)); } catch { maps.set(u, {}); } }
  if (!quotes.has(u)) quotes.set(u, readQuoteFile(u));
  const info = maps.get(u)?.[symbol];
  const q = quotes.get(u);
  // A future has no CE/PE row in the chain buckets (it used to read the PE side at strike 0); its price comes from the
  // contracts bucket below.
  if (!info || !q || (info.side !== 'CE' && info.side !== 'PE')) return 0;
  const key = String(Math.round(info.strike));
  const side = info.side === 'CE' ? 'ce' : 'pe';
  const row = info.expiry === q.expiry ? q.strikes?.[key] : q.extra?.[info.expiry]?.[key];
  const ltp = Number(row?.[side]?.ltp);
  return ltp > 0 ? ltp : 0;
}

/** Every live bridge quotes file on disk (any underlying), for their `contracts` buckets. */
function readAllBridgeFiles(): BridgeQuoteFile[] {
  let names: string[] = [];
  try { names = fs.readdirSync(DEBUG_DIR).filter(n => /^live_options_quotes_dhan_[a-z]+\.json$/.test(n)); } catch { return []; }
  const out: BridgeQuoteFile[] = [];
  for (const n of names) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(DEBUG_DIR, n), 'utf8')) as BridgeQuoteFile); } catch { /* mid-write */ }
  }
  return out;
}

async function loadPositions(): Promise<PosView[]> {
  const shaped = kotakRows(await kotakGet(KOTAK_PATHS.positions)).map(shapeKotakPosition);
  const maps = new Map<string, Awaited<ReturnType<typeof kotakSymbolMap>>>();
  const quotes = new Map<string, QuoteFile | null>();
  // Read lazily, once per pass: only when some open leg is missing from its own underlying's chain.
  let contracts: Map<string, number> | null = null;
  const views: PosView[] = [];
  for (const p of shaped) {
    let ltp = 0;
    if (p.netQty !== 0) {
      // 1. The leg's own underlying's bridge (chain / off-expiry buckets). 2. Any fresh bridge's per-contract bucket -
      // another underlying, or a future. 3. loadPositionsPriced falls back to Dhan's option chain for what is left.
      ltp = await bridgePrice(p.tradingSymbol, maps, quotes);
      if (!(ltp > 0)) {
        contracts ??= contractPricesFromBridges(readAllBridgeFiles(), Date.now(), QUOTES_FRESH_MS);
        ltp = contracts.get(p.tradingSymbol) ?? 0;
      }
    }
    views.push({
      symbol: p.tradingSymbol, productRaw: p.productType, exchange: p.exchange || 'nse_fo', netQty: p.netQty,
      buyAvg: p.buyAvg, sellAvg: p.sellAvg, ltp, realized: p.realizedProfit, unrealized: 0,
    });
  }
  return views;
}

// ── orders ───────────────────────────────────────────────────────────

/** Throws on a refusal or an unknown outcome; the caller notes which. A timed-out exit that Kotak did book counts as sent. */
async function sendExit(e: ExitOrder): Promise<void> {
  const r = await placeKotakOrder({
    es: e.exchange, pc: e.productRaw || 'MIS', pr: '0', pt: 'MKT', qt: String(e.qty), rt: 'DAY', ts: e.symbol,
    tt: e.side, am: 'NO', dq: '0', mp: '0', pf: 'N', tp: '0', os: 'NEOTRADEAPI',
  });
  if (r.status === 'rejected') throw new KotakRejectedError(r.error);
  if (r.status === 'unknown') throw new Error(r.error);
}

// ── loop ─────────────────────────────────────────────────────────────

const G = globalThis as unknown as { __kotakGuardLoop?: { timer: ReturnType<typeof setInterval>; busy: boolean } };

async function tick(): Promise<void> {
  const loop = G.__kotakGuardLoop;
  if (!loop || loop.busy) return;
  const cur = readGuardState();
  if (!cur.pnl && cur.brackets.length === 0 && cur.watch.length === 0) return;
  loop.busy = true;
  try {
    if (!isKotakTokenValid()) return;   // nothing can be read or sent; the status route reports the session
    const positions = await loadPositionsPriced();
    const exits: ExitOrder[] = [];
    await updateGuardState(s => {
      const r = stepGuards(s, positions, Date.now(), istDay());
      exits.push(...r.exits);
      return r.state;
    });
    // The state change (guard removed) is saved BEFORE any order goes out: a crash mid-send can only under-fire, never double-fire.
    let coverFailed = false;
    let coversChecked = false;
    for (const e of exits) {
      if (e.phase === 'sell-long') {
        // Never sell a hedge from under a short that is still open: an order ACK is not a fill, so confirm the covers
        // actually took the shorts flat before the first long goes out.
        if (!coversChecked) {
          coversChecked = true;
          const covers = exits.filter(x => x.phase === 'cover-short');
          if (covers.length && !coverFailed) coverFailed = !(await shortsFlat(covers));
        }
        if (coverFailed) {
          await note('error', `${e.symbol}: NOT sold - a short leg is not confirmed closed, so the hedge is kept`);
          continue;
        }
      }
      try { await sendExit(e); }
      catch (err) {
        if (e.phase === 'cover-short') coverFailed = true;
        // Only an explicit refusal means nothing was placed; a timeout may have filled (the 10 s verify reports it).
        await note('error', err instanceof KotakRejectedError
          ? `${e.symbol}: exit order REJECTED - ${err.message}`
          : `${e.symbol}: exit order outcome unknown (${String((err as Error).message ?? err)}) - check the order book`);
      }
    }
    if (exits.length) invalidateBrokerCache('kotak');
  } catch (err) {
    console.error('[kotak-guard] tick failed:', err);
  } finally {
    loop.busy = false;
  }
}

/** True once every covered short shows flat in the position book (retried briefly: the book lags a fill). */
async function shortsFlat(covers: ExitOrder[]): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise(r => setTimeout(r, 800));
    try {
      const book = await loadPositions();
      if (covers.every(c => (book.find(p => p.symbol === c.symbol && p.productRaw === c.productRaw)?.netQty ?? 0) === 0)) return true;
    } catch { /* retry */ }
  }
  return false;
}

async function note(kind: 'error', text: string): Promise<void> {
  try { await updateGuardState(s => ({ ...s, events: [...s.events, { at: Date.now(), kind, text }].slice(-40) })); } catch { /* best effort */ }
}

/** Prices the book: live bridge first, Dhan option chain for what it missed. */
async function loadPositionsPriced(): Promise<PosView[]> {
  const views = await loadPositions();
  const open = views.filter(v => v.netQty !== 0);
  const need = open.filter(v => !(v.ltp > 0));
  if (need.length) {
    const rows = need.map(v => ({
      tradingSymbol: v.symbol, netQty: v.netQty, buyAvg: v.buyAvg, sellAvg: v.sellAvg,
      lastPrice: 0, unrealizedPnl: 0, realizedPnl: v.realized, totalPnl: v.realized, isOpen: true,
    }));
    try { await joinKotakLtp(rows); } catch { /* unpriced stays 0: the engine treats it as unknown */ }
    need.forEach((v, i) => { if (rows[i].lastPrice > 0) v.ltp = rows[i].lastPrice; });
  }
  for (const v of open) if (v.ltp > 0) v.unrealized = v.netQty * (v.ltp - (v.netQty > 0 ? v.buyAvg : v.sellAvg));
  return views;
}

/** Starts the watcher once per server process. Idempotent; safe to call from instrumentation and from the status route. */
export function startKotakGuardLoop(): void {
  if (G.__kotakGuardLoop) return;
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref();
  G.__kotakGuardLoop = { timer, busy: false };
  console.log('[kotak-guard] watcher started');
}
