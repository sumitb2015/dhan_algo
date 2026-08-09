import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import type { CandleBar, CandlePayload } from '@/lib/terminalTypes';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const BARS_DIR = path.join(PROJECT_ROOT, 'debug', 'intraday_bars');

/** Symbols are filenames, so anything outside this set is a path-traversal attempt. */
const SYMBOL_RE = /^[A-Z0-9&\-]{1,20}$/;

/**
 * Aggregate 1-minute bars to 5-minute on the NSE grid.
 *
 * Buckets must align to 09:15/09:20/... exactly as
 * lib/intraday_signals.resample_5m does, or the chart shows a different candle
 * than the one the strategy made its decision on. 09:15 is 555 minutes past
 * midnight and 555 is divisible by 5, so flooring minutes-since-midnight to a
 * multiple of 5 lands on the same grid.
 */
function to5m(bars: CandleBar[]): CandleBar[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  const buckets = new Map<string, CandleBar>();

  for (const b of bars) {
    // Parse "YYYY-MM-DD HH:MM:SS" literally rather than via `new Date`.
    // These stamps are IST-naive (the whole store is), so constructing a Date
    // reinterprets them in the server's timezone and toISOString() shifts them
    // again — that rendered the 09:15 session open as 06:25. String math has no
    // timezone to get wrong and matches resample_5m exactly.
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(b.t);
    if (!m) continue;
    const [, day, hh, mm] = m;

    const mins = Number(hh) * 60 + Number(mm);
    const floored = Math.floor(mins / 5) * 5;
    const key = `${day} ${pad(Math.floor(floored / 60))}:${pad(floored % 60)}:00`;

    const cur = buckets.get(key);
    if (!cur) {
      buckets.set(key, { ...b, t: key });
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  // Keys are fixed-width and chronological, so lexical order is time order.
  return [...buckets.keys()].sort().map((k) => buckets.get(k)!);
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const symbol = (params.get('symbol') ?? '').toUpperCase();
  const interval = params.get('interval') === '5' ? '5' : '1';

  const fail = (error: string, status: number): NextResponse =>
    NextResponse.json(
      { success: false, symbol, interval, updated_at: null, bars: [], error } satisfies CandlePayload,
      { status },
    );

  if (!symbol) return fail('symbol is required', 400);
  if (!SYMBOL_RE.test(symbol)) return fail('invalid symbol', 400);

  const file = path.join(BARS_DIR, `${symbol}.json`);
  // Defence in depth: even with the regex, never read outside BARS_DIR.
  if (path.dirname(path.resolve(file)) !== path.resolve(BARS_DIR)) {
    return fail('invalid symbol', 400);
  }
  if (!fs.existsSync(file)) {
    // Only watchlist and held symbols are published, so this is a normal state,
    // not an error — the UI shows "no live bars" rather than a failure.
    return NextResponse.json({
      success: true, symbol, interval, updated_at: null, bars: [],
      error: 'no live bars — symbol is not on the strategy watchlist',
    } satisfies CandlePayload);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      updated_at?: string; bars?: CandleBar[];
    };
    const bars = Array.isArray(raw.bars) ? raw.bars : [];
    return NextResponse.json({
      success: true,
      symbol,
      interval,
      updated_at: raw.updated_at ?? null,
      bars: interval === '5' ? to5m(bars) : bars,
    } satisfies CandlePayload);
  } catch (e) {
    return fail(String(e), 500);
  }
}
