import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe, spaced } from '@/lib/pyExec';
import { combineStraddleBars } from '@/lib/indexScalperStraddleBars';

// Read-only market data: NIFTY / SENSEX index, NIFTY / SENSEX future, CRUDEOILM or CRUDEOIL future candles, one option's premium candles (kind=option), or a straddle's CE + PE premium (kind=straddle&ceId=&peId=), for /index-scalper. Never places orders.
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'index_scalper_candles.py');

interface Result {
  candles?: { t: number; o: number; h: number; l: number; c: number; v?: number }[];
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

/** One cached, deduped, queued Python fetch. A fresh error with a cached copy serves the copy (`stale`). */
async function fetchCandles(key: string, args: string[], signal: AbortSignal): Promise<Result & { stale?: boolean }> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;
  let set = waiters.get(key);
  if (!set) { set = new Set(); waiters.set(key, set); }
  set.add(signal);
  const mine = set;
  let data: Result;
  try {
    data = await dedupe(key, () =>
      spaced('dhan-spawn:index-scalper-candles', () => {
        if ([...mine].every(s => s.aborted)) return Promise.reject(new Abandoned('abandoned'));
        return runPythonJson<Result>(SCRIPT, args, 40_000);
      }),
    );
  } catch (err) {
    if (err instanceof Abandoned) throw err;
    if (hit) return { stale: true, ...hit.data };
    throw err;
  } finally {
    mine.delete(signal);
    if (mine.size === 0 && waiters.get(key) === mine) waiters.delete(key);
  }
  if (data.error) return hit ? { stale: true, ...hit.data } : data;
  cache.set(key, { data, ts: Date.now() });
  return data;
}

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
  if (kind !== 'underlying' && kind !== 'option' && kind !== 'future' && kind !== 'straddle') {
    return NextResponse.json({ success: false, error: 'kind must be underlying, future, option or straddle' }, { status: 400 });
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
  const mcx = underlying === 'CRUDEOILM' || underlying === 'CRUDEOIL';
  const withOi = sp.get('oi') === '1' && (kind === 'future' || (kind === 'underlying' && mcx));
  const mcxArgs = (): string[] => ['--segment', mcx ? 'MCX_COMM' : fno, '--instrument', mcx ? 'OPTFUT' : 'OPTIDX'];
  const base = ['--symbol', underlying, '--interval', interval, '--days', String(days)];
  const ok = (data: Result & { stale?: boolean }) => NextResponse.json({ success: true, ...data }, { headers: { 'Cache-Control': 'no-store' } });

  try {
    if (kind === 'straddle') {
      // Both legs are fetched as ordinary option candles (each cached / queued under its own key, so a CE pane on the
      // same strike shares the fetch) and combined here; a leg that fails fails the straddle (never one leg alone).
      const ceId = sp.get('ceId'), peId = sp.get('peId');
      if (!ceId || !peId || !/^\d+$/.test(ceId) || !/^\d+$/.test(peId)) {
        return NextResponse.json({ success: false, error: 'kind=straddle needs numeric ceId and peId' }, { status: 400 });
      }
      const leg = (id: string) => fetchCandles(`idx-scalper:${underlying}:option:${id}:${interval}:${days}`, [...base, ...mcxArgs(), '--security-id', id], req.signal);
      const [ce, pe] = await Promise.all([leg(ceId), leg(peId)]);
      const err = ce.error ?? pe.error;
      if (err || !ce.candles || !pe.candles) return NextResponse.json({ success: false, error: err ?? 'No candles' }, { status: 502 });
      return ok({ candles: combineStraddleBars(ce.candles, pe.candles), interval: ce.interval, ...(ce.stale || pe.stale ? { stale: true } : {}) });
    }
    const args = [...base];
    if (withOi) args.push('--oi');
    if (kind === 'option') {
      args.push(...mcxArgs());
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
    const data = await fetchCandles(`idx-scalper:${underlying}:${kind}:${secId ?? ''}:${interval}:${days}${withOi ? ':oi' : ''}`, args, req.signal);
    if (data.error) return NextResponse.json({ success: false, error: data.error }, { status: 502 });
    return ok(data);
  } catch (err) {
    if (err instanceof Abandoned) return NextResponse.json({ success: false, error: 'abandoned' }, { status: 499 });
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
