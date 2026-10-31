import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';
import { findEquity } from '@/lib/equityMaster';
import { isIndexSymbol, isSymbol } from '@/lib/straddlePnfSearch';
import { resolveFuture, resolveOption, type Contract } from '@/lib/pnfContracts';
import { sessionOf, type Bar } from '@/lib/straddlePnf';
import { tailSessions } from '@/lib/pnfTail';
import type { PnfLegInput } from '@/lib/pnfOrderLogic';

// Read-only market-data route for the Point & Figure page: an NSE index or stock price, or an F&O contract (a future, one option,
// or a CE + PE straddle). No order code lives here. Contracts are resolved server-side from master_list.csv: the browser names
// underlying / expiry / strike / type, never a security id.
const PRICE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'price_pnf_candles.py');

/** Completed sessions of history; the scripts add today's bars on top, so the chart always has 10 full days behind it. */
const SESSIONS = 10;
/** Cash equities show every stored session (the script stitches the downloaded 1-min history to the live API window). */
const EQUITY_SESSIONS = 8000;
/** A future / option / straddle shows every session the API still serves (the script caps the window at ~85 days): TradingView shows a contract from its first day. */
const CONTRACT_SESSIONS = 200;
/** An NSE index: two years of 1-minute bars (stored file, then the API), and one daily close per day before that (2019 on) for the 1d / 1w / 1M charts. */
const INDEX_SESSIONS = 4000;
const CACHE_TTL = 20_000;
/** Every contract (underlying x expiry x strike x side) is its own key, so the cache is pruned on write and capped. */
const CACHE_MAX = 12;
const cache = new Map<string, { ts: number; body: unknown }>();

function remember(key: string, body: unknown) {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.ts >= CACHE_TTL) cache.delete(k);
  cache.delete(key);                                   // re-insert at the end: Map order = age
  cache.set(key, { ts: now, body });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

interface Instrument { segment: string; security_id: string }
interface ScriptOut { error?: string; instrument?: Instrument; instruments?: Instrument[]; bars?: Record<string, Bar[]>; name?: string; errors?: Record<string, string>; anchor_t?: number }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('mode');
  const tail = Math.min(30, Math.max(0, Math.floor(Number(searchParams.get('tail')) || 0)));
  if (mode === 'price') return priceResponse(searchParams.get('kind') ?? '', (searchParams.get('symbol') ?? '').toUpperCase(), tail);
  if (mode === 'contract') return contractResponse(searchParams, tail);
  return NextResponse.json({ success: false, error: 'Use mode=price&kind=index|equity&symbol=… or mode=contract&kind=futures|options&underlying=…&expiry=…' }, { status: 400 });
}

/** The 30 s refresh asks for `tail` sessions only (`&tail=3`); the first load takes the whole history. */
function forTail(body: Record<string, unknown>, tail: number): Record<string, unknown> {
  if (!(tail >= 1)) return body;
  const bars = body.bars as Record<string, Bar[]>;
  return { ...body, bars: Object.fromEntries(Object.entries(bars).map(([k, v]) => [k, tailSessions(v, tail)])), tail };
}

async function run(key: string, args: string[], fallbackName: string, contracts?: PnfLegInput[], sessions = SESSIONS, tail = 0) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return NextResponse.json(forTail(hit.body as Record<string, unknown>, tail));
  try {
    const out = await dedupe(`straddle-pnf:${key}`, () => runPythonJson<ScriptOut>(PRICE_SCRIPT, [...args, '--sessions', String(sessions)], 90_000));
    if (out.error) return NextResponse.json({ success: false, error: out.error }, { status: 500 });
    const bars = out.bars ?? {};
    const lastT = Math.max(0, ...Object.values(bars).map(b => (b.length ? b[b.length - 1].t : 0)));
    const instruments = out.instruments ?? (out.instrument ? [out.instrument] : []);
    const body = {
      success: true, atm: 0, strikes: [0], name: out.name ?? fallbackName, instrument: instruments[0] ?? null, instruments,
      contracts: contracts ?? instruments.map(i => ({ segment: i.segment, securityId: i.security_id, instrument: 'EQUITY', displayName: fallbackName, lot: 1, expiry: '' })),
      bars,
      errors: out.errors ?? {}, anchorT: out.anchor_t ?? null, dataDate: lastT ? sessionOf(lastT) : null,
    };
    if (Object.keys(bars).length) remember(key, body);
    return NextResponse.json(forTail(body, tail));
  } catch (e) {
    return NextResponse.json({ success: false, error: `Script error: ${(e as Error).message}` }, { status: 500 });
  }
}

/** The plain price of an NSE index or cash equity. The symbol must be a known index or an NSE cash-equity row. */
async function priceResponse(kind: string, symbol: string, tail = 0) {
  const known = kind === 'index' ? isIndexSymbol(symbol) : kind === 'equity' && isSymbol(symbol) && findEquity(symbol) !== null;
  if (!known) return NextResponse.json({ success: false, error: `Unknown ${kind || 'instrument'} "${symbol}"` }, { status: 400 });
  const eq = kind === 'equity' ? findEquity(symbol) : null;
  const contracts: PnfLegInput[] | undefined = eq
    ? [{ segment: 'NSE_EQ', securityId: eq.securityId, instrument: 'EQUITY', displayName: eq.name, lot: 1, expiry: '' }]
    : undefined;
  return run(`price:${kind}:${symbol}`, ['--kind', kind, '--symbol', symbol], symbol, contracts, kind === 'equity' ? EQUITY_SESSIONS : INDEX_SESSIONS, tail);
}

/** A future (one leg), one option (one leg) or a CE + PE straddle (two legs, CE first) on one strike. */
async function contractResponse(p: URLSearchParams, tail = 0) {
  const kind = p.get('kind');
  const underlying = (p.get('underlying') ?? '').toUpperCase();
  const expiry = p.get('expiry') ?? '';
  if ((kind !== 'futures' && kind !== 'options') || !isSymbol(underlying) || !DATE_RE.test(expiry)) {
    return NextResponse.json({ success: false, error: 'Use kind=futures|options, an underlying symbol and expiry=YYYY-MM-DD' }, { status: 400 });
  }
  let legs: (Contract & { underlying?: string; strike?: number; optionType?: 'CE' | 'PE' })[];
  let name: string;
  if (kind === 'futures') {
    const f = resolveFuture(underlying, expiry);
    if (!f) return NextResponse.json({ success: false, error: `No ${underlying} future expiring ${expiry}` }, { status: 400 });
    legs = [{ ...f, underlying, expiry }];
    name = f.displayName;
  } else {
    const strike = Number(p.get('strike'));
    const type = p.get('type');
    if (!(strike > 0) || (type !== 'CE' && type !== 'PE' && type !== 'STRADDLE')) {
      return NextResponse.json({ success: false, error: 'Options need strike=<price> and type=CE|PE|STRADDLE' }, { status: 400 });
    }
    const sides: ('CE' | 'PE')[] = type === 'STRADDLE' ? ['CE', 'PE'] : [type];
    const found = sides.map(t => resolveOption(underlying, expiry, strike, t));
    if (found.some(c => c === null)) {
      return NextResponse.json({ success: false, error: `No ${underlying} ${strike} ${type === 'STRADDLE' ? 'CE + PE' : type} expiring ${expiry}` }, { status: 400 });
    }
    legs = found.map((c, i) => ({ ...c!, underlying, expiry, strike, optionType: sides[i] }));
    name = type === 'STRADDLE' ? `${legs[0].displayName.replace(/ CALL$/, '')} STRADDLE` : legs[0].displayName;
  }
  const legArg = legs.map(l => `${l.segment}:${l.securityId}:${l.instrument}`).join(',');
  return run(`contract:${legArg}`, ['--kind', 'contract', '--legs', legArg, '--name', name], name, legs, CONTRACT_SESSIONS, tail);
}
