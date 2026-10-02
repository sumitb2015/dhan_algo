import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';
import { GLOBAL_MARKETS } from '@/lib/globalMarkets';

// DXY + US 10Y/30Y yields from Yahoo. Live path: scripts/tools/yahoo_live_quote.py
// (1-min bars, one spawn for all keys), cached 15 s so every open tab shares it.
// Per-key fallback: latest synced daily bar from the Yahoo sync CSVs
// (download_yahoo_daily.py --target dxy|us10y|us30y).
const LIVE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'yahoo_live_quote.py');
const TTL_MS = 15_000;
let cache: { at: number; body: unknown } | null = null;

interface Live { ltp: number; prev_close: number; day_high: number; day_low: number; ts: number; closed?: boolean }

function eodQuote(csv: string) {
  const rows = fs.readFileSync(path.join(PROJECT_ROOT, 'Historical Data', csv), 'utf8').trim().split('\n').slice(1)
    .map(l => l.split(',')).filter(p => p.length >= 5 && Number(p[4]) > 0);
  if (rows.length < 2) throw new Error('not enough rows');
  const last = rows[rows.length - 1];
  const ltp = Number(last[4]);
  const prev = Number(rows[rows.length - 2][4]);
  return {
    date: last[0], ltp, prev_close: prev, change_pct: ((ltp - prev) / prev) * 100,
    day_high: Number(last[2]), day_low: Number(last[3]), source: 'yahoo-eod',
  };
}

export async function GET() {
  if (cache && Date.now() - cache.at < TTL_MS) return NextResponse.json(cache.body);

  let live: Record<string, Live> = {};
  try {
    live = await dedupe('global-live', () => runPythonJson<Record<string, Live>>(LIVE_SCRIPT, [], 30_000));
  } catch { /* fall back per key below */ }

  const quotes: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const m of GLOBAL_MARKETS) {
    const q = live[m.key];
    if (q && q.prev_close > 0) {
      quotes[m.key] = {
        ...q, date: new Date(q.ts).toISOString(),
        change_pct: ((q.ltp - q.prev_close) / q.prev_close) * 100, source: 'yahoo-live',
      };
      continue;
    }
    try { quotes[m.key] = eodQuote(m.csv); }
    catch (e) { errors.push(`${m.key}: ${String(e).slice(0, 80)}`); }
  }
  const body = { success: Object.keys(quotes).length > 0, quotes, errors };
  if (body.success) cache = { at: Date.now(), body };
  return NextResponse.json(body);
}
