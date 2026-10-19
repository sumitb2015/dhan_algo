import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '@/lib/pyExec';
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
