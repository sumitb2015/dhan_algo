import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { GLOBAL_MARKETS } from '@/lib/globalMarkets';

// Reference closes + 52-week extremes for the /markets table's performance
// columns, read from the daily CSVs the data sync keeps up to date. The client
// combines these with the live LTP, so the numbers stay right whether or not
// today's row has been written yet (reference = last close on/before a date).
// Crude oil has no daily CSV, so its history cells stay empty.
const HIST = path.join(PROJECT_ROOT, 'Historical Data');
const INDIAN_CSV: Record<string, string> = {
  NIFTY: 'NIFTY_50_Daily_5Y.csv',
  BANKNIFTY: 'Indices/BANKNIFTY.csv',
  FINNIFTY: 'Indices/FINNIFTY.csv',
  IT: 'Indices/NIFTYIT.csv',
  AUTO: 'Indices/NIFTY_AUTO.csv',
  PHARMA: 'Indices/NIFTY_PHARMA.csv',
  METAL: 'Indices/NIFTY_METAL.csv',
  REALTY: 'Indices/NIFTY_REALTY.csv',
  VIX: 'Indices/INDIA_VIX.csv',
};

const TTL_MS = 5 * 60_000;
let cache: { at: number; body: unknown } | null = null;

interface Bar { d: string; h: number; l: number; c: number }

function readBars(rel: string): Bar[] {
  const lines = fs.readFileSync(path.join(HIST, rel), 'utf8').trim().split('\n').slice(1);
  const out: Bar[] = [];
  for (const line of lines) {
    const p = line.split(',');
    const c = Number(p[4]);
    if (p.length >= 5 && c > 0) out.push({ d: p[0].slice(0, 10), h: Number(p[2]), l: Number(p[3]), c });
  }
  return out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
}

// Wilder RSI(14) smoothing state after each bar. Returns the state after the last
// bar (n) and the one before it (n1): the client replays ONE more step with the
// live price, from whichever of the two precedes the current session.
const RSI_N = 14;
interface RsiState { ag: number; al: number; c: number }

function rsiStates(closes: number[]): { n: RsiState; n1: RsiState } | null {
  if (closes.length < RSI_N + 2) return null;
  let ag = 0, al = 0;
  for (let i = 1; i <= RSI_N; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= RSI_N; al /= RSI_N;
  let prev: RsiState = { ag, al, c: closes[RSI_N] };
  let cur = prev;
  for (let i = RSI_N + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    prev = cur;
    cur = { ag: (cur.ag * (RSI_N - 1) + Math.max(d, 0)) / RSI_N, al: (cur.al * (RSI_N - 1) + Math.max(-d, 0)) / RSI_N, c: closes[i] };
  }
  return { n: cur, n1: prev };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function summarize(bars: Bar[]) {
  if (bars.length < 2) return null;
  const today = new Date();
  const refClose = (target: string) => {
    let hit: Bar | null = null;
    for (const b of bars) { if (b.d <= target) hit = b; else break; }
    return hit ? hit.c : null;
  };
  const wk = new Date(today); wk.setDate(wk.getDate() - 7);
  const mo = new Date(today); mo.setMonth(mo.getMonth() - 1);
  const yr = new Date(today); yr.setDate(yr.getDate() - 365);
  const win = bars.filter(b => b.d >= iso(yr));
  return {
    last_date: bars[bars.length - 1].d,
    c1w: refClose(iso(wk)),
    c1m: refClose(iso(mo)),
    cytd: refClose(`${today.getFullYear() - 1}-12-31`),
    hi52: win.length ? Math.max(...win.map(b => b.h)) : null,
    lo52: win.length ? Math.min(...win.map(b => b.l)) : null,
    rsi: rsiStates(bars.map(b => b.c)),
  };
}

export async function GET() {
  if (cache && Date.now() - cache.at < TTL_MS) return NextResponse.json(cache.body);
  const files: Record<string, string> = { ...INDIAN_CSV };
  for (const m of GLOBAL_MARKETS) files[m.key] = m.csv;
  const history: Record<string, unknown> = {};
  for (const [key, rel] of Object.entries(files)) {
    try { const s = summarize(readBars(rel)); if (s) history[key] = s; } catch { /* missing CSV → empty cells */ }
  }
  const body = { success: true, history };
  cache = { at: Date.now(), body };
  return NextResponse.json(body);
}
