import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe, spaced } from '@/lib/pyExec';

// Read-only market data: NIFTY index / CRUDEOILM future candles, or one option's premium candles (kind=option), for /index-scalper. Never places orders.
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'index_scalper_candles.py');

interface Result {
  candles?: { t: number; o: number; h: number; l: number; c: number }[];
  interval?: string;
  error?: string;
}

const cache = new Map<string, { data: Result; ts: number }>();
const TTL_MS = 20_000;

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const underlying = (sp.get('underlying') ?? 'NIFTY').toUpperCase();
  if (underlying !== 'NIFTY' && underlying !== 'CRUDEOILM') {
    return NextResponse.json({ success: false, error: 'underlying must be NIFTY or CRUDEOILM' }, { status: 400 });
  }
  const interval = sp.get('interval') ?? '5';
  if (!['1', '3', '5', '15'].includes(interval)) {
    return NextResponse.json({ success: false, error: 'interval must be 1, 3, 5 or 15' }, { status: 400 });
  }
  const secIdRaw = sp.get('securityId');
  const secId = secIdRaw && /^\d+$/.test(secIdRaw) ? secIdRaw : null;
  // kind=option: premium candles of one option contract (its Dhan security id). Segment / instrument are fixed per
  // underlying here, never taken from the browser.
  const kind = sp.get('kind') ?? 'underlying';
  if (kind !== 'underlying' && kind !== 'option') {
    return NextResponse.json({ success: false, error: 'kind must be underlying or option' }, { status: 400 });
  }
  if (kind === 'option' && !secId) {
    return NextResponse.json({ success: false, error: 'kind=option needs a numeric securityId' }, { status: 400 });
  }
  const daysRaw = Number(sp.get('days') ?? '10');
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(60, Math.floor(daysRaw))) : 10;
  const key = `idx-scalper:${underlying}:${kind}:${secId ?? ''}:${interval}:${days}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) {
    return NextResponse.json({ success: true, ...hit.data }, { headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const args = ['--symbol', underlying, '--interval', interval, '--days', String(days)];
    if (kind === 'option') {
      args.push('--segment', underlying === 'CRUDEOILM' ? 'MCX_COMM' : 'NSE_FNO', '--instrument', underlying === 'CRUDEOILM' ? 'OPTFUT' : 'OPTIDX');
    } else if (underlying === 'CRUDEOILM') {
      args.push('--segment', 'MCX_COMM', '--instrument', 'FUTCOM');
    }
    if (secId) {
      args.push('--security-id', secId);
    }
    const data = await dedupe(key, () =>
      spaced('dhan-spawn:index-scalper-candles', () =>
        runPythonJson<Result>(SCRIPT, args, 40_000),
      ),
    );
    if (data.error) {
      if (hit) return NextResponse.json({ success: true, stale: true, ...hit.data }, { headers: { 'Cache-Control': 'no-store' } });
      return NextResponse.json({ success: false, error: data.error }, { status: 502 });
    }
    cache.set(key, { data, ts: Date.now() });
    return NextResponse.json({ success: true, ...data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (hit) return NextResponse.json({ success: true, stale: true, ...hit.data }, { headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
