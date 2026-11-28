import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe, spaced } from '@/lib/pyExec';

// Read-only market data: NIFTY / SENSEX index, NIFTY / SENSEX future, CRUDEOILM or CRUDEOIL future candles, or one option's premium candles (kind=option), for /index-scalper. Never places orders.
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'index_scalper_candles.py');

interface Result {
  candles?: { t: number; o: number; h: number; l: number; c: number }[];
  interval?: string;
  error?: string;
}

const cache = new Map<string, { data: Result; ts: number }>();
// The signals of every request waiting on one key's (deduped) spawn. The spawns run one at a time, so a page that
// switched instrument leaves its old fetches queued: when a spawn's turn comes and every request that wanted it has
// disconnected, it is skipped instead of holding the new instrument's chart back by ~5 s each.
const waiters = new Map<string, Set<AbortSignal>>();
class Abandoned extends Error {}
const TTL_MS = 20_000;

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const underlying = (sp.get('underlying') ?? 'NIFTY').toUpperCase();
  if (underlying !== 'NIFTY' && underlying !== 'SENSEX' && underlying !== 'CRUDEOILM' && underlying !== 'CRUDEOIL') {
    return NextResponse.json({ success: false, error: 'underlying must be NIFTY, SENSEX, CRUDEOILM or CRUDEOIL' }, { status: 400 });
  }
  // SENSEX trades on BSE: its future / options are BSE_FNO, the index is IDX_I id 51 (BSE_IDX answers DH-905; the bare
  // symbol can resolve to the wrong row, so the id is passed explicitly). docs/API_GOTCHAS.md "SENSEX splits three ways".
  const bse = underlying === 'SENSEX';
  const fno = bse ? 'BSE_FNO' : 'NSE_FNO';
  const interval = sp.get('interval') ?? '5';
  if (!['1', '3', '5', '15', '30', '60'].includes(interval)) {
    return NextResponse.json({ success: false, error: 'interval must be 1, 3, 5, 15, 30 or 60' }, { status: 400 });
  }
  const secIdRaw = sp.get('securityId');
  const secId = secIdRaw && /^\d+$/.test(secIdRaw) ? secIdRaw : null;
  // kind=option: premium candles of one option contract (its Dhan security id). Segment / instrument are fixed per
  // underlying here, never taken from the browser.
  const kind = sp.get('kind') ?? 'underlying';
  if (kind !== 'underlying' && kind !== 'option' && kind !== 'future') {
    return NextResponse.json({ success: false, error: 'kind must be underlying, future or option' }, { status: 400 });
  }
  // kind=future: the NIFTY / SENSEX future (by its Dhan id), for the chart's FUT pane. Crude's future is its underlying pane.
  if (kind === 'future' && ((underlying !== 'NIFTY' && underlying !== 'SENSEX') || !secId)) {
    return NextResponse.json({ success: false, error: 'kind=future is NIFTY / SENSEX only and needs a numeric securityId' }, { status: 400 });
  }
  if (kind === 'option' && !secId) {
    return NextResponse.json({ success: false, error: 'kind=option needs a numeric securityId' }, { status: 400 });
  }
  const daysRaw = Number(sp.get('days') ?? '10');
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(60, Math.floor(daysRaw))) : 10;
  // oi=1: open interest per bar ("oi"), futures only (the NIFTY / SENSEX future, crude's underlying pane); ignored on
  // the index and options. The trend strip's futures OI buildup reads it.
  const mcxU = underlying === 'CRUDEOILM' || underlying === 'CRUDEOIL';
  const withOi = sp.get('oi') === '1' && (kind === 'future' || (kind === 'underlying' && mcxU));
  const key = `idx-scalper:${underlying}:${kind}:${secId ?? ''}:${interval}:${days}${withOi ? ':oi' : ''}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) {
    return NextResponse.json({ success: true, ...hit.data }, { headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const mcx = underlying === 'CRUDEOILM' || underlying === 'CRUDEOIL';
    const args = ['--symbol', underlying, '--interval', interval, '--days', String(days)];
    if (withOi) args.push('--oi');
    if (kind === 'option') {
      args.push('--segment', mcx ? 'MCX_COMM' : fno, '--instrument', mcx ? 'OPTFUT' : 'OPTIDX');
    } else if (kind === 'future') {
      args.push('--segment', fno, '--instrument', 'FUTIDX');
    } else if (mcx) {
      args.push('--segment', 'MCX_COMM', '--instrument', 'FUTCOM');
    }
    if (kind === 'underlying' && bse) {
      // The SENSEX index itself: IDX_I / INDEX / 51, never a browser-supplied id.
      args.push('--segment', 'IDX_I', '--instrument', 'INDEX', '--security-id', '51');
    } else if (secId) {
      args.push('--security-id', secId);
    }
    let set = waiters.get(key);
    if (!set) { set = new Set(); waiters.set(key, set); }
    set.add(req.signal);
    const mine = set;
    let data: Result;
    try {
      data = await dedupe(key, () =>
        spaced('dhan-spawn:index-scalper-candles', () => {
          if ([...mine].every(s => s.aborted)) return Promise.reject(new Abandoned('abandoned'));
          return runPythonJson<Result>(SCRIPT, args, 40_000);
        }),
      );
    } finally {
      mine.delete(req.signal);
      if (mine.size === 0 && waiters.get(key) === mine) waiters.delete(key);
    }
    if (data.error) {
      if (hit) return NextResponse.json({ success: true, stale: true, ...hit.data }, { headers: { 'Cache-Control': 'no-store' } });
      return NextResponse.json({ success: false, error: data.error }, { status: 502 });
    }
    cache.set(key, { data, ts: Date.now() });
    return NextResponse.json({ success: true, ...data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof Abandoned) return NextResponse.json({ success: false, error: 'abandoned' }, { status: 499 });
    if (hit) return NextResponse.json({ success: true, stale: true, ...hit.data }, { headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
