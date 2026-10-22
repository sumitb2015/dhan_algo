import fs from 'fs';
import path from 'path';
import { joinKotakLtp, underlyingPrefix, type KotakSymbolInfo } from '@/lib/kotakLtpJoin';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { withFileLock, writeJsonAtomic } from '@/lib/lockedJsonFile';
import {
  emptyGuardState, stepGuards, contractPricesFromBridges, type ServerGuardState, type PosView, type ExitOrder, type BridgeQuoteFile,
} from '@/lib/kotakGuardEngine';

// The broker-neutral half of the server-resident guards (P&L Guard + brackets): file store, tick loop, pricing and the
// cover-before-sell ordering around the pure engine in lib/kotakGuardEngine.ts. A broker supplies only an adapter (its
// session check, symbol map, position book and exit order) - Kotak's is lib/kotakGuardServer.ts, Zerodha's
// lib/zerodhaGuardServer.ts - so the safety rules live here once and the two cannot drift.
//
// The state lives in debug/<broker>_server_guards.json and is re-read on every tick and every request, never cached in
// memory, because the instrumentation hook and each API route can run as separate module instances. Writes go through a
// lock file so a request and a tick cannot overwrite each other.

/** An exit the broker explicitly refused (nothing was placed). Any other throw from `sendExit` is an unknown outcome. */
export class GuardExitRejected extends Error {}

export interface GuardAdapter {
  /** 'kotak' | 'zerodha': names the state file, the log prefix and the broker cache to invalidate. */
  key: 'kotak' | 'zerodha';
  isSessionValid(): boolean;
  /** tradingSymbol -> contract for one underlying (the broker's own instrument cache). */
  symbolMapFor(underlying: string): Promise<Record<string, KotakSymbolInfo>>;
  /** The full position book (flat rows included: they carry realised P&L), every `ltp` 0 - the core prices it. */
  loadBook(): Promise<PosView[]>;
  /** Sends one market exit. Throws GuardExitRejected on a refusal, any other Error when the outcome is unknown. */
  sendExit(e: ExitOrder): Promise<void>;
}

const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');
const TICK_MS = 2500;
const QUOTES_FRESH_MS = 6000;
const LOCK_STALE_MS = 8000;
const WARN_REPEAT_MS = 120_000;

export const istDay = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

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

export interface GuardServer {
  readGuardState(): ServerGuardState;
  updateGuardState(mutate: (s: ServerGuardState) => ServerGuardState): Promise<ServerGuardState>;
  startLoop(): void;
}

export function createGuardServer(adapter: GuardAdapter): GuardServer {
  const stateFile = path.join(DEBUG_DIR, `${adapter.key}_server_guards.json`);
  const lockFile = `${stateFile}.lock`;
  const tag = `[${adapter.key}-guard]`;

  function readStateFile(): ServerGuardState {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Partial<ServerGuardState>;
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
    writeJsonAtomic(stateFile, s);
  }

  const withLock = <T,>(fn: () => T | Promise<T>): Promise<T> => withFileLock(lockFile, LOCK_STALE_MS, `${adapter.key} guard state`, fn);

  /** Current state (read-only view; rolls to a fresh day without writing). */
  function readGuardState(): ServerGuardState {
    const s = readStateFile();
    return s.date === istDay() ? s : emptyGuardState(istDay());
  }

  /** Read-modify-write under the lock. The mutator returns the next state. */
  async function updateGuardState(mutate: (s: ServerGuardState) => ServerGuardState): Promise<ServerGuardState> {
    return withLock(() => {
      const cur = readStateFile();
      const base = cur.date === istDay() ? cur : emptyGuardState(istDay());
      const next = mutate(base);
      writeStateFile(next);
      return next;
    });
  }

  // ── prices ─────────────────────────────────────────────────────────

  async function bridgePrice(
    symbol: string, maps: Map<string, Record<string, KotakSymbolInfo>>, quotes: Map<string, QuoteFile | null>,
  ): Promise<number> {
    const u = underlyingPrefix(symbol);
    if (!u) return 0;
    if (!maps.has(u)) { try { maps.set(u, await adapter.symbolMapFor(u)); } catch { maps.set(u, {}); } }
    if (!quotes.has(u)) quotes.set(u, readQuoteFile(u));
    const info = maps.get(u)?.[symbol];
    const q = quotes.get(u);
    // A future has no CE/PE row in the chain buckets; its price comes from the contracts bucket.
    if (!info || !q || (info.side !== 'CE' && info.side !== 'PE')) return 0;
    const key = String(Math.round(info.strike));
    const side = info.side === 'CE' ? 'ce' : 'pe';
    const row = info.expiry === q.expiry ? q.strikes?.[key] : q.extra?.[info.expiry]?.[key];
    const ltp = Number(row?.[side]?.ltp);
    return ltp > 0 ? ltp : 0;
  }

  /** Prices the book: live bridge first, any bridge's per-contract bucket next, Dhan's option chain for what is left.
   *  A leg nothing could price stays 0, which the engine treats as unknown (the guard pauses on it). */
  async function loadPositionsPriced(): Promise<PosView[]> {
    const views = await adapter.loadBook();
    const maps = new Map<string, Record<string, KotakSymbolInfo>>();
    const quotes = new Map<string, QuoteFile | null>();
    let contracts: Map<string, number> | null = null;   // read lazily, once per pass
    for (const v of views) {
      if (v.netQty === 0) continue;
      v.ltp = await bridgePrice(v.symbol, maps, quotes);
      if (!(v.ltp > 0)) {
        contracts ??= contractPricesFromBridges(readAllBridgeFiles(), Date.now(), QUOTES_FRESH_MS);
        v.ltp = contracts.get(v.symbol) ?? 0;
      }
    }
    const need = views.filter(v => v.netQty !== 0 && !(v.ltp > 0));
    if (need.length) {
      const rows = need.map(v => ({
        tradingSymbol: v.symbol, netQty: v.netQty, buyAvg: v.buyAvg, sellAvg: v.sellAvg,
        lastPrice: 0, unrealizedPnl: 0, realizedPnl: v.realized, totalPnl: v.realized, isOpen: true,
      }));
      try { await joinKotakLtp(rows, adapter.symbolMapFor); } catch { /* unpriced stays 0 */ }
      need.forEach((v, i) => { if (rows[i].lastPrice > 0) v.ltp = rows[i].lastPrice; });
    }
    for (const v of views) if (v.netQty !== 0 && v.ltp > 0) v.unrealized = v.netQty * (v.ltp - (v.netQty > 0 ? v.buyAvg : v.sellAvg));
    return views;
  }

  // ── loop ───────────────────────────────────────────────────────────

  const G = globalThis as unknown as Record<string, { timer: ReturnType<typeof setInterval>; busy: boolean } | undefined>;
  const loopKey = `__${adapter.key}GuardLoop`;

  async function note(kind: 'error', text: string): Promise<void> {
    try { await updateGuardState(s => ({ ...s, events: [...s.events, { at: Date.now(), kind, text }].slice(-40) })); } catch { /* best effort */ }
  }

  /** A standing problem (session gone, book unreadable, leg unpriced) is reported once per REPEAT_MS, not every tick. */
  const lastWarned = new Map<string, number>();
  async function warn(text: string): Promise<void> {
    const now = Date.now();
    if (now - (lastWarned.get(text) ?? 0) < WARN_REPEAT_MS) return;
    lastWarned.set(text, now);
    await note('error', text);
  }

  /** True once every covered short shows flat in the position book (retried briefly: the book lags a fill). */
  async function shortsFlat(covers: ExitOrder[]): Promise<boolean> {
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise(r => setTimeout(r, 800));
      try {
        const book = await adapter.loadBook();
        if (covers.every(c => (book.find(p => p.symbol === c.symbol && p.productRaw === c.productRaw)?.netQty ?? 0) === 0)) return true;
      } catch { /* retry */ }
    }
    return false;
  }

  async function tick(): Promise<void> {
    const loop = G[loopKey];
    if (!loop || loop.busy) return;
    const cur = readGuardState();
    if (!cur.pnl && cur.brackets.length === 0 && cur.watch.length === 0) return;
    loop.busy = true;
    try {
      if (!adapter.isSessionValid()) {
        // Nothing can be read or sent, so the guard is NOT protecting anything: say so instead of idling silently.
        await warn(`${adapter.key} session is not valid - guards cannot watch or exit until you log in again`);
        return;
      }
      let positions: PosView[];
      try {
        positions = await loadPositionsPriced();
      } catch (err) {
        // A revoked token or a Kite/Neo outage looks valid to the file check; the first failing read is where it shows.
        await warn(`could not read the ${adapter.key} position book (${String((err as Error).message ?? err)}) - guards are not watching`);
        return;
      }
      const unpriced = positions.filter(p => p.netQty !== 0 && !(p.ltp > 0)).map(p => p.symbol);
      if (unpriced.length) await warn(`no live price for ${unpriced.join(', ')} - guards pause on ${unpriced.length === 1 ? 'it' : 'them'} (only a P&L loss limit can still fire)`);
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
        try { await adapter.sendExit(e); }
        catch (err) {
          if (e.phase === 'cover-short') coverFailed = true;
          // Only an explicit refusal means nothing was placed; a timeout may have filled (the 10 s verify reports it).
          await note('error', err instanceof GuardExitRejected
            ? `${e.symbol}: exit order REJECTED - ${err.message}`
            : `${e.symbol}: exit order outcome unknown (${String((err as Error).message ?? err)}) - check the order book`);
        }
      }
      if (exits.length) invalidateBrokerCache(adapter.key);
    } catch (err) {
      console.error(`${tag} tick failed:`, err);
    } finally {
      loop.busy = false;
    }
  }

  /** Starts the watcher once per server process. Idempotent; safe to call from instrumentation and from the status route. */
  function startLoop(): void {
    if (G[loopKey]) return;
    const timer = setInterval(() => { void tick(); }, TICK_MS);
    if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref();
    G[loopKey] = { timer, busy: false };
    console.log(`${tag} watcher started`);
  }

  return { readGuardState, updateGuardState, startLoop };
}
