import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';
import { kotakGet, kotakRows, KOTAK_PATHS } from '@/lib/kotakToken';
import { shapeKotakHolding, type KotakHolding } from '@/lib/kotakShape';

// Server-side Kotak contract resolution for the desks that place Kotak orders from a Dhan-keyed view (Options Screener,
// Covered Call, Equity ticket, CSP desk). Contracts come from Kotak's own masters via scripts/tools/kotak_instruments_cache.py
// (the same cache, refresh rule and dedupe key as /api/scalper/kotak/lookup), never constructed from a symbol pattern.

const CACHE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'kotak_instruments_cache.py');
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

interface CachedOption {
  tradingsymbol: string; strike: number; expiry: string; instrument_type: 'CE' | 'PE' | 'FUT';
  lot_size: number; exchange_segment: string; tick?: number | null;
}
export interface KotakOptionContract { tradingsymbol: string; lotSize: number; segment: string; tick: number | null }
export interface KotakEquityContract { tradingsymbol: string; tick: number | null; token: string }

const stale = (f: string) => !fs.existsSync(f) || Date.now() - fs.statSync(f).mtimeMs > MAX_AGE_MS;

async function optionRows(underlying: string): Promise<CachedOption[]> {
  const u = underlying.toUpperCase();
  const file = path.join(PROJECT_ROOT, 'debug', `kotak_${u.toLowerCase()}_instruments.json`);
  if (stale(file)) {
    await dedupe(`kotak-instruments-cache:${u}`, () =>
      runPythonJson<{ success: boolean; error?: string }>(CACHE_SCRIPT, ['--underlying', u], 120_000));
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as CachedOption[];
}

/** The Kotak option for (underlying, expiry YYYY-MM-DD, strike, CE/PE), or null when Kotak does not list it. */
export async function kotakOptionContract(
  underlying: string, expiry: string, strike: number, type: 'CE' | 'PE',
): Promise<KotakOptionContract | null> {
  const rows = await optionRows(underlying);
  const hit = rows.find(r => r.instrument_type === type && r.expiry === expiry && Math.abs(r.strike - strike) < 1e-6);
  if (!hit || !(hit.lot_size > 0)) return null;
  return { tradingsymbol: hit.tradingsymbol, lotSize: hit.lot_size, segment: hit.exchange_segment || 'nse_fo', tick: hit.tick ?? null };
}

const EQUITY_FILE = path.join(PROJECT_ROOT, 'debug', 'kotak_nse_cm_equity.json');

/** The Kotak NSE cash contract for a plain symbol (RELIANCE -> RELIANCE-EQ), or null. */
export async function kotakEquityContract(symbol: string): Promise<KotakEquityContract | null> {
  if (stale(EQUITY_FILE)) {
    await dedupe('kotak-instruments-cache:EQUITY', () =>
      runPythonJson<{ success: boolean; error?: string }>(CACHE_SCRIPT, ['--equity'], 180_000));
  }
  const map = JSON.parse(fs.readFileSync(EQUITY_FILE, 'utf8')) as Record<string, { tradingsymbol: string; tick: number | null; instrument_token: string }>;
  const hit = map[symbol.toUpperCase()];
  return hit ? { tradingsymbol: hit.tradingsymbol, tick: hit.tick ?? null, token: hit.instrument_token } : null;
}

/** Kotak holdings. Throws when they cannot be read: callers that cap a SELL by holdings must fail closed. */
export async function kotakHoldings(): Promise<KotakHolding[]> {
  const json = await kotakGet(KOTAK_PATHS.holdings);
  return kotakRows(json).map(shapeKotakHolding).filter((h): h is KotakHolding => h != null);
}
