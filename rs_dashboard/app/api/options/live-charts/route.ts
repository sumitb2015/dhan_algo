import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_chart_fetch.py');

const KINDS = ['expiries', 'strikes', 'straddle', 'rolling-straddle', 'strangle', 'strategy'] as const;
type Kind = (typeof KINDS)[number];

// Straddle/rolling-straddle/strategy fetch one leg per unique strike touched (plus the spot
// series) - each can take several seconds under Dhan's ~1 req/s intraday pacing (see
// options_chart_fetch.py's _fetch_intraday gate).
const TIMEOUT_MS = 60_000;

// Mirrors MAX_DAYS in options_chart_fetch.py.
const MAX_DAYS = 10;

// Mirrors the UNDERLYINGS table in options_chart_fetch.py. Allowlisted rather than passed through
// so an arbitrary query string never reaches the spawned python's argv.
// FINNIFTY is in the python table but deliberately not in the UI's CHART_UNDERLYINGS, so the
// route accepts a superset of what the panels can ask for.
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX', 'CRUDEOIL'];

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const kind = searchParams.get('kind') as Kind | null;
  if (!kind || !KINDS.includes(kind)) {
    return NextResponse.json({ success: false, error: `kind must be one of ${KINDS.join(', ')}` }, { status: 400 });
  }

  const underlying = (searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
  if (!UNDERLYINGS.includes(underlying)) {
    return NextResponse.json({ success: false, error: `underlying must be one of ${UNDERLYINGS.join(', ')}` }, { status: 400 });
  }
  const args: string[] = [kind, '--underlying', underlying];

  if (kind !== 'expiries') {
    const expiry = searchParams.get('expiry');
    if (!expiry) return NextResponse.json({ success: false, error: 'expiry required' }, { status: 400 });
    args.push('--expiry', expiry);
  }

  if (kind === 'straddle') {
    const strike = searchParams.get('strike');
    if (!strike) return NextResponse.json({ success: false, error: 'strike required' }, { status: 400 });
    args.push('--strike', strike);
  }

  if (kind === 'strangle') {
    const ceStrike = searchParams.get('ce_strike');
    const peStrike = searchParams.get('pe_strike');
    if (!ceStrike || !peStrike) {
      return NextResponse.json({ success: false, error: 'ce_strike and pe_strike required' }, { status: 400 });
    }
    args.push('--ce-strike', ceStrike, '--pe-strike', peStrike);
    args.push('--ce-lots', searchParams.get('ce_lots') ?? '1');
    args.push('--pe-lots', searchParams.get('pe_lots') ?? '1');
  }

  if (kind === 'strategy') {
    const legs = searchParams.get('legs');
    if (!legs) return NextResponse.json({ success: false, error: 'legs required' }, { status: 400 });
    args.push('--legs', legs);
  }

  if (kind === 'straddle' || kind === 'rolling-straddle' || kind === 'strangle' || kind === 'strategy') {
    args.push('--interval', searchParams.get('interval') ?? '1');
    const days = Number(searchParams.get('days') ?? '2');
    args.push('--days', String(Number.isFinite(days) ? Math.min(MAX_DAYS, Math.max(1, Math.round(days))) : 2));
    const indicators = searchParams.get('indicators');
    if (indicators) args.push('--indicators', indicators);
    // rolling-straddle has no --include-spot: it always carries a per-candle `spot` field
    // (the strike-selection series it already fetches), which the panel's Spot toggle reads
    // client-side. Passing the flag anyway would be an argparse "unrecognized arguments" exit.
    if (kind !== 'rolling-straddle' && searchParams.get('include_spot') === '1') args.push('--include-spot');
  }

  try {
    // Dedupe identical concurrent requests (e.g. two browser tabs polling the same chart) -
    // no additional per-underlying spawn pacing here (unlike /api/options/chain): the script
    // itself already paces its own option-chain/intraday Dhan calls internally, so serializing
    // whole spawns on top would only add latency without protecting anything further.
    const dedupeKey = `live-charts:${kind}:${args.join('|')}`;
    const data = await dedupe(dedupeKey, () => runPythonJson<Record<string, unknown>>(SCRIPT, args, TIMEOUT_MS));

    if (data.error) {
      return NextResponse.json({ success: false, error: String(data.error) }, { status: 502 });
    }
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string };
    console.error('[/api/options/live-charts] error:', e.message, e.stderr ?? '');
    return NextResponse.json({ success: false, error: `Script error: ${String(e.message)}` }, { status: 500 });
  }
}
