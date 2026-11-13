import { NextRequest, NextResponse } from 'next/server';
import { MCX_LOT_MULTIPLIER } from '@/lib/positionPnl';
import { istToday } from '@/lib/istTime';
import { isRegularSession } from '@/lib/nseHolidays';
import { mcxSession } from '@/lib/mcxSession';
import { pickPrevClose, spotInstrument, wsPrice, wsSync, wsWant } from '@/lib/freshMoneyWs';
import { fetchLatestPrevClose } from '@/lib/dhanDailyCloses';
import { globalOnce } from '@/lib/globalOnce';

// The board's live price from Dhan's WebSocket (lib/freshMoneyWs.ts): an MCX option month's own futures, or the index,
// with its change against the previous close. Polled every ~2 s by the page; each call keeps the subscription asked for.
// Read-only. `spot` null = no fresh WebSocket price yet (bridge starting, hub down): the page falls back and says so.
// Previous close: dhan-prevclose-pct-change Rule 2 (pickPrevClose) — trusted in session and cached for the day, never
// a flipped close read as 0.00% after the bell.

const UNDERLYINGS = new Set(['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'CRUDEOILM']);

export interface FreshMoneyLive {
  underlying: string;
  /** What the price is: the index name, or the futures contract (e.g. "CRUDEOILM NOV FUT"). */
  label: string | null;
  spot: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  /** When the price last changed (ms), null when it has not changed since we subscribed. */
  changedMs: number | null;
  instrument: string | null;
}

const prevCache: Map<string, { date: string; prev: number }> =
  ((globalThis as { __fmPrevClose?: Map<string, { date: string; prev: number }> }).__fmPrevClose ??= new Map());

// Out of session with nothing cached today (the price was first asked for after the bell, or the dashboard restarted
// since), the quote's `close` has already flipped to today's: read the previous close from Dhan's daily candles instead
// (the same source as the Top Indices strip). One request per instrument per day; a failure waits 5 min before the next
// try, so the ~2 s page poll never turns into a stream of historical-API calls. Never blocks the reply: the first poll
// still answers "–" and a later one has the value.
const candleFallback = globalOnce('__fmPrevCloseCandles', () => ({
  inflight: new Set<string>(),
  failedAt: new Map<string, number>(),
}));
const CANDLE_RETRY_MS = 5 * 60_000;

function fillFromCandles(key: string, securityId: string, segment: string, today: string): void {
  if (candleFallback.inflight.has(key)) return;
  const failed = candleFallback.failedAt.get(key);
  if (failed && Date.now() - failed < CANDLE_RETRY_MS) return;
  candleFallback.inflight.add(key);
  const instrument = segment === 'MCX_COMM' ? 'FUTCOM' : 'INDEX';
  fetchLatestPrevClose(Number(securityId), segment, instrument, today)
    .then(pc => {
      if (pc && pc > 0) { prevCache.set(key, { date: today, prev: pc }); candleFallback.failedAt.delete(key); }
      else candleFallback.failedAt.set(key, Date.now());
    })
    .catch(() => { candleFallback.failedAt.set(key, Date.now()); })
    .finally(() => { candleFallback.inflight.delete(key); });
}

function inSession(mcx: boolean): boolean {
  const today = istToday();
  const d = new Date(Date.now() + 19_800_000);
  const hhmm = d.getUTCHours() * 100 + d.getUTCMinutes();
  if (mcx) { const s = mcxSession(today); return hhmm >= s.open && hhmm < s.close; }
  return isRegularSession(today) && hhmm >= 915 && hhmm < 1530;
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const underlying = (sp.get('underlying') ?? '').toUpperCase();
  const expiry = sp.get('expiry') ?? '';
  if (!UNDERLYINGS.has(underlying) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    return NextResponse.json({ error: 'underlying and expiry (YYYY-MM-DD) are required' }, { status: 400 });
  }
  const mcx = MCX_LOT_MULTIPLIER[underlying] !== undefined;
  const empty: FreshMoneyLive = { underlying, label: null, spot: null, prevClose: null, change: null, changePct: null, changedMs: null, instrument: null };
  const inst = spotInstrument(underlying, expiry, mcx);
  if (!inst) return NextResponse.json(empty);
  const key = wsWant(inst.segment, inst.securityId);
  wsSync();
  const q = wsPrice(key);
  if (!q) return NextResponse.json({ ...empty, label: inst.label, instrument: key });

  const today = istToday();
  const live = inSession(mcx);
  const cached = prevCache.get(key);
  const cachedToday = cached && cached.date === today ? cached.prev : null;
  const prev = pickPrevClose(q.ltp, q.prevClose, live, cachedToday);
  if (live && q.prevClose && q.prevClose > 0) prevCache.set(key, { date: today, prev: q.prevClose });
  // A raw close that equals the last price out of session is the flipped one (pickPrevClose refused it): no cached value
  // means no in-session reading today, so go to the daily candles.
  if (!live && cachedToday === null) fillFromCandles(key, inst.securityId, inst.segment, today);
  const change = prev ? q.ltp - prev : null;
  return NextResponse.json({
    underlying, label: inst.label, spot: q.ltp, prevClose: prev,
    change, changePct: prev && change !== null ? (change / prev) * 100 : null,
    changedMs: q.changedMs, instrument: key,
  } satisfies FreshMoneyLive);
}
