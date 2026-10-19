import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';
import { pickZerodhaFuture, type ZerodhaFutureRow } from '@/lib/zerodhaOrderRules';

const CACHE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'zerodha_instruments_cache.py');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function cacheFileFor(underlying: string): string {
  return path.join(PROJECT_ROOT, 'debug', `zerodha_${underlying.toLowerCase()}_instruments.json`);
}

interface CachedInstrument {
  tradingsymbol: string;
  instrument_token: number;
  strike: number;
  expiry: string;
  instrument_type: 'CE' | 'PE';
  lot_size: number;
}

const SCALPER_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'scalper_api.py');
const freezeCache = new Map<string, { freezeQty: number | null; ts: number }>();
const FREEZE_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * The exchange freeze quantity for this expiry, from Dhan's instrument master (SM_FREEZE_QTY). Kite's own dump carries
 * none, and the figure is the exchange's, not the broker's, so it is the same in Kite's order units (contracts; lots
 * for MCX). Instrument metadata only — no Zerodha market data. Null when unavailable: the caller then keeps its
 * conservative per-underlying limit.
 */
async function exchangeFreezeQty(underlying: string, expiry: string): Promise<number | null> {
  const key = `${underlying}:${expiry}`;
  const hit = freezeCache.get(key);
  if (hit && Date.now() - hit.ts < FREEZE_TTL_MS) return hit.freezeQty;
  try {
    const r = await dedupe(`zerodha-freeze:${key}`, () =>
      runPythonJson<{ success: boolean; data?: { freezeQty?: number } }>(
        SCALPER_SCRIPT, ['lookup', '--underlying', underlying, '--expiry', expiry], 30_000));
    const q = r.success && Number(r.data?.freezeQty) > 1 ? Number(r.data?.freezeQty) : null;
    freezeCache.set(key, { freezeQty: q, ts: Date.now() });
    return q;
  } catch {
    return null;   // not cached: the next lookup retries
  }
}

async function ensureCache(underlying: string): Promise<CachedInstrument[]> {
  const cacheFile = cacheFileFor(underlying);
  const stale = !fs.existsSync(cacheFile) ||
    Date.now() - fs.statSync(cacheFile).mtimeMs > CACHE_MAX_AGE_MS;

  if (stale) {
    await dedupe(`zerodha-instruments-cache:${underlying}`, () =>
      runPythonJson<{ success: boolean; error?: string }>(CACHE_SCRIPT, ['--underlying', underlying], 60_000));
  }
  return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as CachedInstrument[];
}

/** Underlyings with a tradeable future (scripts/tools/zerodha_instruments_cache.py FUTURES_EXCHANGE). */
const FUTURES_UNDERLYINGS = new Set(['NIFTY', 'CRUDEOIL', 'CRUDEOILM']);

/** When a futures-cache rebuild last FAILED, per underlying: the script is not respawned (60 s timeout) on every lookup while Kite is down. */
const futuresBuildFailedAt = new Map<string, number>();
const FUTURES_RETRY_MS = 5 * 60_000;

/** The future to trade for this underlying, or null when it has none / the requested expiry is not listed / the cache cannot be built. */
async function futureFor(underlying: string, futureExpiry: string): Promise<{ trading_symbol: string; expiry: string; lot_size: number; exchange_segment: string } | null> {
  if (!FUTURES_UNDERLYINGS.has(underlying)) return null;
  try {
    const file = path.join(PROJECT_ROOT, 'debug', `zerodha_${underlying.toLowerCase()}_futures.json`);
    const stale = !fs.existsSync(file) || Date.now() - fs.statSync(file).mtimeMs > CACHE_MAX_AGE_MS;
    const lastFail = futuresBuildFailedAt.get(underlying) ?? 0;
    if (stale && Date.now() - lastFail > FUTURES_RETRY_MS) {
      try {
        const r = await dedupe(`zerodha-futures-cache:${underlying}`, () =>
          runPythonJson<{ success: boolean; error?: string }>(CACHE_SCRIPT, ['--underlying', underlying, '--futures'], 60_000));
        if (!r.success) throw new Error(r.error ?? 'futures cache build failed');
        futuresBuildFailedAt.delete(underlying);
      } catch (err) {
        futuresBuildFailedAt.set(underlying, Date.now());
        console.error('[scalper/zerodha/lookup] futures cache refresh failed (using the old file if any):', err);
      }
    }
    // An old file is still a valid contract list (a month's expiry does not change); only a missing one means no future.
    const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as ZerodhaFutureRow[];
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const f = pickZerodhaFuture(rows, futureExpiry || null, today);
    // `exchange` is Kite's own spelling (NFO / MCX), the one the order route takes.
    return f ? { trading_symbol: f.tradingsymbol, expiry: f.expiry, lot_size: f.lot_size ?? 1, exchange_segment: f.exchange ?? (underlying.startsWith('CRUDEOIL') ? 'MCX' : 'NFO') } : null;
  } catch (err) {
    console.error('[scalper/zerodha/lookup] futures cache failed:', err);
    return null;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const futureExpiry = searchParams.get('futureExpiry') ?? '';
  const underlying = (searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
  const expiry = searchParams.get('expiry') ?? '';

  if (!expiry) {
    return NextResponse.json({ success: false, error: 'expiry required' }, { status: 400 });
  }

  try {
    const all = await ensureCache(underlying);
    const rows = all.filter(r => r.expiry === expiry);
    if (!rows.length) {
      return NextResponse.json({ success: false, error: `No Zerodha options found for ${underlying} ${expiry}` });
    }

    const strikes: Record<string, { ceSymbol?: string; peSymbol?: string }> = {};
    let lotSize = 75;
    for (const r of rows) {
      lotSize = r.lot_size || lotSize;
      const key = String(Math.round(r.strike));
      if (!strikes[key]) strikes[key] = {};
      if (r.instrument_type === 'CE') strikes[key].ceSymbol = r.tradingsymbol;
      else strikes[key].peSymbol = r.tradingsymbol;
    }

    const freezeQty = await exchangeFreezeQty(underlying, expiry);
    const future = await futureFor(underlying, futureExpiry);
    return NextResponse.json({ success: true, data: { lotSize, strikes, future, ...(freezeQty ? { freezeQty } : {}) } });
  } catch (err) {
    console.error('[scalper/zerodha/lookup] error:', err);
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
