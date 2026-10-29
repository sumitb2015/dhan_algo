import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe, spaced } from '@/lib/pyExec';
import { DEFAULT_OFFSETS, isPnfUnderlying, parseAtmParam, parseOffsetsParam, roundToStep, strikesFor } from '@/lib/straddlePnfStrikes';
import { findEquity } from '@/lib/equityMaster';
import { isIndexSymbol, isSymbol } from '@/lib/straddlePnfSearch';
import { sessionOf, type Bar } from '@/lib/straddlePnf';

// Read-only market-data route for the Straddle P&F page: no order code lives here.
const BARS_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'straddle_pnf_candles.py');
const FUTURES_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'futures_pnf_candles.py');
const PRICE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'price_pnf_candles.py');
const SPOT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_data_fetch.py');

const SESSIONS = 3;
const CACHE_TTL = 20_000;
const cache = new Map<string, { ts: number; body: unknown }>();

interface FuturesScriptOut { error?: string; bars?: Record<string, Bar[]>; expiries?: Record<string, string>; errors?: Record<string, string> }
interface BarsScriptOut { error?: string; bars?: Record<string, Bar[]>; errors?: Record<string, string> }

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const underlying = (searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
  const expiry = searchParams.get('expiry') ?? '';
  const atmParam = parseAtmParam(searchParams.get('atm'));
  if (searchParams.get('mode') === 'price') return priceResponse(searchParams.get('kind') ?? '', (searchParams.get('symbol') ?? '').toUpperCase());

  if (!isPnfUnderlying(underlying)) {
    return NextResponse.json({ success: false, error: 'Only NIFTY and CRUDEOILM are supported' }, { status: 400 });
  }
  if (underlying === 'CRUDEOILM') return futuresResponse(underlying);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    return NextResponse.json({ success: false, error: 'expiry must be YYYY-MM-DD' }, { status: 400 });
  }
  const offsetsRaw = searchParams.get('offsets');
  const offsets = offsetsRaw === null ? DEFAULT_OFFSETS : parseOffsetsParam(offsetsRaw);
  if (!offsets) {
    return NextResponse.json({ success: false, error: 'offsets must be three distinct multiples of 50, e.g. -200,0,200 (max +-1000)' }, { status: 400 });
  }
  if (!atmParam) {
    return NextResponse.json({ success: false, error: 'atm must be "auto" or a positive number' }, { status: 400 });
  }

  let atm: number;
  if (atmParam.auto) {
    try {
      const spot = await dedupe(`straddle-pnf-spot:${underlying}`, () =>
        spaced(`dhan-spawn:${underlying}`, () =>
          runPythonJson<{ spot?: number; error?: string }>(SPOT_SCRIPT, ['ltp', '--underlying', underlying], 15_000),
        ),
      );
      if (spot.error || !(Number(spot.spot) > 0)) throw new Error(spot.error ?? 'no spot');
      atm = roundToStep(Number(spot.spot));
    } catch (e) {
      // A stale daily close would pick the wrong ATM during the session, so fail instead of guessing.
      return NextResponse.json({ success: false, error: `Could not determine ATM from spot (${(e as Error).message}); pass atm explicitly` }, { status: 502 });
    }
  } else {
    atm = atmParam.atm;
  }

  const key = `${underlying}:${expiry}:${atm}:${offsets.join(',')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return NextResponse.json(hit.body);

  const strikes = strikesFor(atm, offsets);
  if (strikes.some(k => !(k > 0))) {
    return NextResponse.json({ success: false, error: `ATM ${atm} with these offsets gives a strike at or below zero (${strikes.join(', ')})` }, { status: 400 });
  }
  try {
    const out = await dedupe(`straddle-pnf:${key}`, () =>
      runPythonJson<BarsScriptOut>(
        BARS_SCRIPT,
        ['--underlying', underlying, '--expiry', expiry, '--strikes', strikes.join(','), '--sessions', String(SESSIONS)],
        90_000,
      ),
    );
    if (out.error) return NextResponse.json({ success: false, error: out.error }, { status: 500 });

    const bars = out.bars ?? {};
    const lastT = Math.max(0, ...Object.values(bars).map(b => (b.length ? b[b.length - 1].t : 0)));
    const body = {
      success: true,
      atm,
      strikes,
      bars,
      errors: out.errors ?? {},
      dataDate: lastT ? sessionOf(lastT) : null,
    };
    if (Object.keys(bars).length) cache.set(key, { ts: Date.now(), body });
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ success: false, error: `Script error: ${(e as Error).message}` }, { status: 500 });
  }
}

/**
 * CRUDEOILM charts the nearest monthly FUTURES contract (no strikes, no expiry choice). Each contract is keyed by its
 * expiry as YYYYMMDD, which the page uses wherever the straddle mode uses a strike; `expiries` maps that key back to the date.
 */
async function futuresResponse(underlying: string) {
  const key = `futures:${underlying}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return NextResponse.json(hit.body);
  try {
    const out = await dedupe(`straddle-pnf:${key}`, () =>
      runPythonJson<FuturesScriptOut>(FUTURES_SCRIPT, ['--underlying', underlying, '--contracts', '1', '--sessions', String(SESSIONS)], 90_000),
    );
    if (out.error) return NextResponse.json({ success: false, error: out.error }, { status: 500 });
    const bars = out.bars ?? {};
    const expiries = out.expiries ?? {};
    const keys = Object.keys(expiries).sort();
    const lastT = Math.max(0, ...Object.values(bars).map(b => (b.length ? b[b.length - 1].t : 0)));
    const body = {
      success: true, mode: 'futures', atm: 0,
      strikes: keys.map(Number), expiries, bars, errors: out.errors ?? {},
      dataDate: lastT ? sessionOf(lastT) : null,
    };
    if (Object.keys(bars).length) cache.set(key, { ts: Date.now(), body });
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ success: false, error: `Script error: ${(e as Error).message}` }, { status: 500 });
  }
}

/** The plain price of an NSE index or cash equity (the search box's picks). The symbol must be a known index or an NSE cash-equity row. */
async function priceResponse(kind: string, symbol: string) {
  const known = kind === 'index' ? isIndexSymbol(symbol) : kind === 'equity' && isSymbol(symbol) && findEquity(symbol) !== null;
  if (!known) return NextResponse.json({ success: false, error: `Unknown ${kind || 'instrument'} "${symbol}"` }, { status: 400 });
  const key = `price:${kind}:${symbol}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return NextResponse.json(hit.body);
  try {
    const out = await dedupe(`straddle-pnf:${key}`, () =>
      runPythonJson<{ error?: string; bars?: Record<string, Bar[]>; name?: string; errors?: Record<string, string> }>(
        PRICE_SCRIPT, ['--kind', kind, '--symbol', symbol, '--sessions', String(SESSIONS)], 90_000),
    );
    if (out.error) return NextResponse.json({ success: false, error: out.error }, { status: 500 });
    const bars = out.bars ?? {};
    const lastT = Math.max(0, ...Object.values(bars).map(b => (b.length ? b[b.length - 1].t : 0)));
    const body = { success: true, mode: 'price', atm: 0, strikes: [0], name: out.name ?? symbol, bars, errors: out.errors ?? {}, dataDate: lastT ? sessionOf(lastT) : null };
    if (Object.keys(bars).length) cache.set(key, { ts: Date.now(), body });
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ success: false, error: `Script error: ${(e as Error).message}` }, { status: 500 });
  }
}
