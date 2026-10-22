import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';
import { zerodhaContractFromRows, zerodhaUnderlyingOf, zerodhaOrderSlices, type ZerodhaCachedContract, type ZerodhaContractInfo } from '@/lib/zerodhaOrderRules';

/** Parsed cache files by path, re-read only when the file changes: every order and slice calls this, and the options file is large. */
const rowsCache = new Map<string, { mtimeMs: number; rows: ZerodhaCachedContract[] }>();
function cachedRows(file: string): ZerodhaCachedContract[] | null {
  try {
    const mtimeMs = fs.statSync(file).mtimeMs;
    const hit = rowsCache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.rows;
    const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as ZerodhaCachedContract[];
    rowsCache.set(file, { mtimeMs, rows });
    return rows;
  } catch { return null; }   // missing or unreadable
}

/** The cached contract for a symbol, read from disk only (never spawns the cache script on an order path). */
export function cachedZerodhaContract(symbol: string): ZerodhaContractInfo | null {
  const underlying = zerodhaUnderlyingOf(symbol);
  if (!underlying) return null;
  // Options first, then the futures file (a future's tick differs: an MCX future ticks at 1.00, NIFTY's at 0.10).
  for (const kind of ['instruments', 'futures']) {
    const rows = cachedRows(path.join(PROJECT_ROOT, 'debug', `zerodha_${underlying.toLowerCase()}_${kind}.json`));
    const hit = rows ? zerodhaContractFromRows(rows, symbol) : null;
    if (hit) return hit;
  }
  return null;
}

/** `qty` of `symbol` as orders under the exchange freeze quantity (one order when the contract is not in the cache). */
export function slicesFor(symbol: string, qty: number): number[] {
  return zerodhaOrderSlices(qty, zerodhaUnderlyingOf(symbol), cachedZerodhaContract(symbol)?.lotSize ?? null);
}

const CACHE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'zerodha_instruments_cache.py');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const zerodhaInstrumentFile = (underlying: string) => path.join(PROJECT_ROOT, 'debug', `zerodha_${underlying.toLowerCase()}_instruments.json`);

/**
 * The path of Kite's option instrument dump for `underlying`, refreshed through scripts/tools/zerodha_instruments_cache.py
 * when missing or older than a day (one run at a time per underlying). Throws if the refresh fails; the file may still
 * hold an older dump. Shared by /api/scalper/zerodha/lookup and the Price Ladder.
 */
export async function ensureZerodhaInstrumentCache(underlying: string): Promise<string> {
  const file = zerodhaInstrumentFile(underlying);
  let stale = true;
  try { stale = Date.now() - fs.statSync(file).mtimeMs > CACHE_MAX_AGE_MS; } catch { /* missing */ }
  if (stale) {
    await dedupe(`zerodha-instruments-cache:${underlying}`, () =>
      runPythonJson<{ success: boolean; error?: string }>(CACHE_SCRIPT, ['--underlying', underlying], 60_000));
  }
  return file;
}

interface ZerodhaOptionRow extends ZerodhaCachedContract { strike: number; expiry: string; instrument_type: 'CE' | 'PE' }
export interface ZerodhaOptionContract { tradingsymbol: string; lotSize: number; tick: number | null; exchange: 'NFO' | 'BFO' }

/**
 * The Kite option for (underlying, expiry YYYY-MM-DD, strike, CE/PE) from Kite's own instrument dump (refreshed by
 * scripts/tools/zerodha_instruments_cache.py when older than a day, same dedupe key as /api/scalper/zerodha/lookup), or
 * null when Kite does not list it. Instrument metadata only: no Zerodha market data. SENSEX options trade on BFO.
 */
export async function zerodhaOptionContract(underlying: string, expiry: string, strike: number, type: 'CE' | 'PE'): Promise<ZerodhaOptionContract | null> {
  let file: string;
  try { file = await ensureZerodhaInstrumentCache(underlying); } catch { file = zerodhaInstrumentFile(underlying); }  // use what is on disk
  const rows = cachedRows(file) as ZerodhaOptionRow[] | null;
  const hit = rows?.find(r => r.instrument_type === type && r.expiry === expiry && Math.abs(Number(r.strike) - strike) < 1e-6);
  if (!hit || !(Number(hit.lot_size) > 0)) return null;
  return {
    tradingsymbol: hit.tradingsymbol, lotSize: Number(hit.lot_size),
    tick: Number(hit.tick_size) > 0 ? Number(hit.tick_size) : null, exchange: underlying === 'SENSEX' ? 'BFO' : 'NFO',
  };
}
