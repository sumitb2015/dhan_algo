import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, dedupe, spaced, runPythonJson } from '@/lib/pyExec';

// Kotak's positions payload carries no last-traded price at all (see
// lib/kotakShape.ts and dhan-broker-positions invariant 3) — `unrealizedProfit`
// and `lastTradedPrice` both come back 0/unset for every open leg, which the
// dashboard's Consolidated Portfolio Balance Sheet then renders as "—" / +₹0
// rather than inventing a mark. This module supplies the LTP the skill says
// to join in: an option's price is set by the exchange, not the broker, so
// Dhan's option chain is authoritative for a Kotak-held leg too.
//
// Kotak's OWN trading-symbol format is not decoded here — it uses two
// different encodings (compact monthly vs single-char-month weekly, see
// components/MarketDashboard.tsx's parseContract) and getting the expiry
// epoch math wrong from a regex is exactly the bug kotak_instruments_cache.py
// already had to fix once. Reusing that cache (the same one
// /api/scalper/kotak/symbol-lookup reads) sidesteps re-deriving it.

const KOTAK_CACHE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'kotak_instruments_cache.py');
const OPTIONS_FETCH_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_data_fetch.py');
// Matches /api/scalper/kotak/symbol-lookup's own cache lifetime so the two
// routes agree on when the on-disk cache is stale, rather than one refreshing
// a file the other still considers fresh.
const KOTAK_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
// Matches /api/options/chain's in-memory TTL.
const CHAIN_CACHE_TTL_MS = 10_000;

interface KotakSymbolInfo { expiry: string; strike: number; side: 'CE' | 'PE' }
type ChainSide = { last_price?: number };
type ChainOc = Record<string, { ce?: ChainSide; pe?: ChainSide }>;

function kotakCacheFile(underlying: string): string {
  return path.join(PROJECT_ROOT, 'debug', `kotak_${underlying.toLowerCase()}_instruments.json`);
}

/** tradingSymbol -> {expiry, strike, side} for one underlying, refreshing the
 *  on-disk cache if stale. Same dedupe key as the symbol-lookup route, so a
 *  concurrent refresh from either place collapses onto one Python spawn. */
async function kotakSymbolMap(underlying: string): Promise<Record<string, KotakSymbolInfo>> {
  const file = kotakCacheFile(underlying);
  const stale = !fs.existsSync(file) || Date.now() - fs.statSync(file).mtimeMs > KOTAK_CACHE_MAX_AGE_MS;
  if (stale) {
    await dedupe(`kotak-instruments-cache:${underlying}`, () =>
      runPythonJson<{ success: boolean; error?: string }>(KOTAK_CACHE_SCRIPT, ['--underlying', underlying], 120_000));
  }
  const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as
    { tradingsymbol: string; strike: number; expiry: string; instrument_type: 'CE' | 'PE' }[];
  const map: Record<string, KotakSymbolInfo> = {};
  for (const r of rows) map[r.tradingsymbol] = { expiry: r.expiry, strike: r.strike, side: r.instrument_type };
  return map;
}

const chainCache = new Map<string, { ts: number; oc: ChainOc }>();

/** Dhan's option-chain `oc` map for one underlying/expiry. Same dedupe +
 *  pacing keys as /api/options/chain so a concurrent request for the same
 *  underlying/expiry (from either route) shares one Python spawn / Dhan call
 *  instead of racing Dhan's ~1-call/3s option-chain rate limit. */
async function fetchChainOc(underlying: string, expiry: string): Promise<ChainOc> {
  const cacheKey = `${underlying}:${expiry}`;
  const hit = chainCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CHAIN_CACHE_TTL_MS) return hit.oc;

  const parsed = await dedupe(`options-chain:${cacheKey}`, () =>
    spaced(`dhan-spawn:${underlying}`, () =>
      runPythonJson<{ chain?: { oc?: ChainOc }; error?: string }>(
        OPTIONS_FETCH_SCRIPT,
        ['chain', '--underlying', underlying, '--expiry', expiry],
        45_000,
      )));

  const oc = parsed.chain?.oc ?? {};
  chainCache.set(cacheKey, { ts: Date.now(), oc });
  return oc;
}

function underlyingPrefix(tradingSymbol: string): string {
  return /^[A-Z]+/.exec(tradingSymbol.toUpperCase())?.[0] ?? '';
}

function chainStrikeKey(strike: number): string {
  return strike.toFixed(6);
}

interface JoinablePosition {
  tradingSymbol: string;
  netQty: number;
  buyAvg: number;
  sellAvg: number;
  lastPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  totalPnl: number;
  isOpen: boolean;
}

/**
 * Mutates open, unpriced legs in place with a live LTP joined from Dhan's
 * option chain, recomputing unrealizedPnl/totalPnl from it. Legs whose
 * underlying/expiry/strike can't be resolved (cache miss, dead Kotak/Dhan
 * session) are left exactly as they were — lastPrice 0 is the honest
 * "unknown" outcome the rest of this codebase already settled on, not
 * something to paper over with a guessed mark.
 */
export async function joinKotakLtp(positions: JoinablePosition[]): Promise<void> {
  const unpriced = positions.filter(p => p.isOpen && p.lastPrice <= 0);
  if (unpriced.length === 0) return;

  const underlyings = [...new Set(unpriced.map(p => underlyingPrefix(p.tradingSymbol)).filter(Boolean))];
  const symbolMaps: Record<string, Record<string, KotakSymbolInfo>> = {};
  await Promise.all(underlyings.map(async u => {
    try { symbolMaps[u] = await kotakSymbolMap(u); } catch { symbolMaps[u] = {}; }
  }));

  const infoFor = (p: JoinablePosition): KotakSymbolInfo | undefined =>
    symbolMaps[underlyingPrefix(p.tradingSymbol)]?.[p.tradingSymbol];

  // One chain fetch per distinct (underlying, expiry) actually held, not one per leg.
  const groups = new Map<string, { underlying: string; expiry: string }>();
  for (const p of unpriced) {
    const info = infoFor(p);
    if (!info) continue;
    const u = underlyingPrefix(p.tradingSymbol);
    groups.set(`${u}:${info.expiry}`, { underlying: u, expiry: info.expiry });
  }

  const chains: Record<string, ChainOc> = {};
  await Promise.all([...groups.entries()].map(async ([key, { underlying, expiry }]) => {
    try { chains[key] = await fetchChainOc(underlying, expiry); } catch { chains[key] = {}; }
  }));

  for (const p of unpriced) {
    const info = infoFor(p);
    if (!info) continue;
    const oc = chains[`${underlyingPrefix(p.tradingSymbol)}:${info.expiry}`];
    const strikeRow = oc?.[chainStrikeKey(info.strike)];
    const ltp = Number(info.side === 'CE' ? strikeRow?.ce?.last_price : strikeRow?.pe?.last_price);
    if (!(ltp > 0)) continue;

    const avg = p.netQty > 0 ? p.buyAvg : p.sellAvg;
    const unrealized = p.netQty * (ltp - avg);
    p.lastPrice = ltp;
    p.unrealizedPnl = unrealized;
    p.totalPnl = unrealized + p.realizedPnl;
  }
}
