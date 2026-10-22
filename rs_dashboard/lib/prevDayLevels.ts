import { getDhanCredentials } from './dhanToken.ts';
import { istDay, isMcxUnderlying } from './priceLadder.ts';

// Previous day's high / low / close for the Price Ladder's PDH / PDL marks (XY mode). Dhan only (the repo's data rule):
// daily candles from /charts/historical — no CSV or other-source fallback; no Dhan answer = no mark. The ladder's view
// is rebuilt up to 4x a second, so it never waits on this: `prevDayLevelsNow` returns what is cached and starts at most
// one background fetch per key; a failure is remembered for FAIL_RETRY_MS so a broken token or an unknown id cannot
// turn every view build into a Dhan call.

const DHAN_HISTORICAL_URL = 'https://api.dhan.co/v2/charts/historical';
/** After a failed / empty fetch, the next try waits this long. */
const FAIL_RETRY_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 5000;

export interface PrevDayLevel { high: number; low: number; close: number }

const INDEX_IDS: Record<string, string> = { NIFTY: '13', BANKNIFTY: '25', SENSEX: '51' };

interface Memo { ok: Map<string, PrevDayLevel>; failedAt: Map<string, number>; inFlight: Set<string> }
const memo: Memo = ((globalThis as { __prevDayLevels?: Memo }).__prevDayLevels ??= { ok: new Map(), failedAt: new Map(), inFlight: new Set() });

/**
 * The last complete day before `today` (IST) in a Dhan daily-candle reply, or null. Pure. Rows with a non-positive
 * price are skipped (a holiday placeholder must not become a level).
 */
export function pickPrevDay(json: { high?: number[]; low?: number[]; close?: number[]; timestamp?: number[] }, today: string): PrevDayLevel | null {
  const ts = json.timestamp ?? [];
  let last: PrevDayLevel | null = null;
  for (let i = 0; i < ts.length; i++) {
    const day = new Date(ts[i] * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const h = Number(json.high?.[i]), l = Number(json.low?.[i]), c = Number(json.close?.[i]);
    if (day < today && h > 0 && l > 0 && c > 0) last = { high: h, low: l, close: c };
  }
  return last;
}

/** The Dhan instrument for an underlying's daily candles: the index, or for MCX the option month's own futures. */
function instrumentFor(u: string, mcxFuturesId?: string | null): { securityId: string; exchangeSegment: string; instrument: string } | null {
  if (isMcxUnderlying(u)) return mcxFuturesId ? { securityId: mcxFuturesId, exchangeSegment: 'MCX_COMM', instrument: 'FUTCOM' } : null;
  return INDEX_IDS[u] ? { securityId: INDEX_IDS[u], exchangeSegment: 'IDX_I', instrument: 'INDEX' } : null;
}

async function fetchPrevDay(key: string, inst: NonNullable<ReturnType<typeof instrumentFor>>, today: string): Promise<void> {
  try {
    const creds = getDhanCredentials();
    const to = new Date();
    const from = new Date(to.getTime() - 10 * 86_400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const res = await fetch(DHAN_HISTORICAL_URL, {
      method: 'POST',
      headers: { 'access-token': creds.token, 'client-id': creds.clientId, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...inst, oi: false, fromDate: fmt(from), toDate: fmt(to) }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const lv = res.ok ? pickPrevDay(await res.json(), today) : null;
    if (lv) { memo.ok.set(key, lv); memo.failedAt.delete(key); } else memo.failedAt.set(key, Date.now());
  } catch {
    memo.failedAt.set(key, Date.now());
  } finally {
    memo.inFlight.delete(key);
  }
}

/**
 * Cached previous-day levels, or null while unknown. Never waits: a miss starts one background fetch (none while one
 * is running, or within FAIL_RETRY_MS of a failure); the next view build picks up its result.
 */
export function prevDayLevelsNow(underlying: string, mcxFuturesId?: string | null): PrevDayLevel | null {
  const u = underlying.toUpperCase();
  const today = istDay();
  const key = `${today}:${u}:${mcxFuturesId ?? ''}`;
  const hit = memo.ok.get(key);
  if (hit) return hit;
  const inst = instrumentFor(u, mcxFuturesId);
  if (!inst || memo.inFlight.has(key)) return null;
  const failed = memo.failedAt.get(key);
  if (failed != null && Date.now() - failed < FAIL_RETRY_MS) return null;
  memo.inFlight.add(key);
  void fetchPrevDay(key, inst, today);
  return null;
}
