import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';
import { MAX_SESSIONS, validateSimParams, type ExpiryInfo } from '@/lib/straddleSim';
import { sessionOf, type Bar } from '@/lib/straddlePnf';

// Read-only: replays straddle history from the local expired-options store (Options Data/nifty_options.db). No broker call, no orders.
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'straddle_sim_data.py');

const EXPIRY_TTL = 60 * 60 * 1000;
const LOAD_TTL = 10 * 60 * 1000;
let expiryCache: { ts: number; list: ExpiryInfo[] } | null = null;
const loadCache = new Map<string, { ts: number; body: unknown }>();

const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

async function expiryList(): Promise<ExpiryInfo[]> {
  if (expiryCache && Date.now() - expiryCache.ts < EXPIRY_TTL) return expiryCache.list;
  const out = await dedupe('straddle-sim-expiries', () =>
    runPythonJson<{ error?: string; expiries?: ExpiryInfo[] }>(SCRIPT, ['--mode', 'expiries', '--limit', '40'], 30_000),
  );
  if (out.error || !out.expiries) throw new Error(out.error ?? 'no expiries');
  expiryCache = { ts: Date.now(), list: out.expiries };
  return out.expiries;
}

interface LoadOut {
  error?: string; expiry: string; atm: number; strikes: number[]; preloadSession: string | null; sessions: string[];
  bars: Record<string, Bar[]>; coverage: Record<string, number>; spotT: number[]; spotV: number[];
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  if (searchParams.get('mode') === 'expiries') {
    try {
      return NextResponse.json({ success: true, expiries: await expiryList() });
    } catch (e) {
      return NextResponse.json({ success: false, error: `Could not read the options store: ${(e as Error).message}` }, { status: 500 });
    }
  }

  const params = {
    index: searchParams.get('index') ?? 'NIFTY',
    expiry: searchParams.get('expiry') ?? '',
    from: searchParams.get('from') ?? '',
    to: searchParams.get('to') ?? '',
    atm: searchParams.get('atm') ?? 'auto',
  };
  let known: ExpiryInfo[] | null = null;
  try { known = await expiryList(); } catch { /* the loader repeats the range check against the store itself */ }
  const v = validateSimParams(params, known, istToday());
  if (!v.ok) return NextResponse.json({ success: false, error: v.error }, { status: 400 });

  const key = `${params.expiry}:${params.from}:${params.to}:${v.atm}`;
  const hit = loadCache.get(key);
  if (hit && Date.now() - hit.ts < LOAD_TTL) return NextResponse.json(hit.body);

  try {
    const out = await dedupe(`straddle-sim:${key}`, () =>
      runPythonJson<LoadOut>(
        SCRIPT,
        ['--mode', 'load', '--expiry', params.expiry, '--from', params.from, '--to', params.to, '--atm', String(v.atm)],
        60_000,
      ),
    );
    if (out.error) return NextResponse.json({ success: false, error: out.error }, { status: 400 });
    if (out.sessions.length > MAX_SESSIONS) {
      return NextResponse.json({ success: false, error: `Replay at most ${MAX_SESSIONS} sessions at a time (that range has ${out.sessions.length}).` }, { status: 400 });
    }
    const firstT = Math.min(...Object.values(out.bars).filter(b => b.length).map(b => b[0].t), Infinity);
    // The replay starts at the first bar of the first replay session (the preload day's bars come before it).
    const replayStartT = Math.min(
      ...Object.values(out.bars).flatMap(b => b.filter(x => sessionOf(x.t) === out.sessions[0]).slice(0, 1).map(x => x.t)),
      Infinity,
    );
    const body = { success: true, ...out, replayStartT: Number.isFinite(replayStartT) ? replayStartT : firstT };
    loadCache.set(key, { ts: Date.now(), body });
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ success: false, error: `Script error: ${(e as Error).message}` }, { status: 500 });
  }
}
