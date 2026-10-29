import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';
import { findEquity } from '@/lib/equityMaster';
import { isIndexSymbol, isSymbol } from '@/lib/straddlePnfSearch';
import { sessionOf, type Bar } from '@/lib/straddlePnf';

// Read-only market-data route for the Point & Figure page (index / stock price, CRUDEOILM futures): no order code and no options live here.
const FUTURES_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'futures_pnf_candles.py');
const PRICE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'price_pnf_candles.py');

const SESSIONS = 10;
const CACHE_TTL = 20_000;
const cache = new Map<string, { ts: number; body: unknown }>();

interface FuturesScriptOut { error?: string; bars?: Record<string, Bar[]>; expiries?: Record<string, string>; errors?: Record<string, string> }

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get('mode') === 'price') return priceResponse(searchParams.get('kind') ?? '', (searchParams.get('symbol') ?? '').toUpperCase());
  if ((searchParams.get('underlying') ?? '').toUpperCase() === 'CRUDEOILM') return futuresResponse('CRUDEOILM');
  return NextResponse.json({ success: false, error: 'Use mode=price&kind=index|equity&symbol=… or underlying=CRUDEOILM (there are no options charts)' }, { status: 400 });
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
