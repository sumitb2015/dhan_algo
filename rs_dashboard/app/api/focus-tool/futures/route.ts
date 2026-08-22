import { NextResponse } from 'next/server';
import path from 'path';
import { getDhanCredentials } from '@/lib/dhanToken';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';
import { UNDERLYINGS } from '@/lib/focusTool';

// Live NIFTY / BANKNIFTY / SENSEX futures LTPs + % change for the Focus Tool
// header strip.
//
// Nothing else in the dashboard served these: /api/scalper/top-indices is index
// SPOT, and /api/futures is CSV-historical with no live price at all.
//
// Two-stage by necessity. A futures security id is only valid until its contract
// expires, so it cannot be hardcoded the way an index id can — but resolving it
// costs a ~2s Python spawn (mostly master-list load), which is far too slow for
// a header polled every few seconds. So the ids are resolved once per IST day
// via focus_tool_futs.py and then quoted directly over Dhan's batched OHLC
// endpoint from Node. Same split /api/scalper/top-indices uses for CRUDEOIL.
//
// % change needs the same flip guard /api/scalper/top-indices already uses:
// Dhan's `ohlc.close` flips from yesterday's close to today's the moment the
// 15:30 bell rings, so naively recomputing the percentage from it every poll
// collapses to a confident (wrong) 0.00% after hours. Fixed the same way: cache
// the first genuine (pre-flip) close seen each IST day per underlying and reuse
// it for the rest of the session — see prevCloseCache/rejectFlippedClose below.
// Costs no extra API call: Dhan's OHLC endpoint already returns `ohlc.close`
// alongside `last_price` in the same batched response fetchQuotes() already
// makes for LTP.

const FUTS_SCRIPT   = path.join(PROJECT_ROOT, 'scripts', 'tools', 'focus_tool_futs.py');
const DHAN_OHLC_URL = 'https://api.dhan.co/v2/marketfeed/ohlc';

const QUOTE_TTL_MS = 2000;

interface Contract {
  security_id: number;
  segment: string;
  expiry: string;
  symbol: string;
}

type ContractMap = Record<string, Contract>;

function istToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Yesterday's close per underlying, keyed "<IST date>:<underlying>" — same
// pattern as top-indices/route.ts's prevCloseCache. Populated once a genuine
// (non-flipped) value is seen and reused for the rest of the day.
const prevCloseCache = new Map<string, number>();

/** Drop entries from previous days so the map doesn't grow forever across a
 *  long-lived `next start` process. */
function prunePrevCloseCache(day: string): void {
  for (const key of prevCloseCache.keys()) {
    if (!key.startsWith(`${day}:`)) prevCloseCache.delete(key);
  }
}

/**
 * Reject a `close` that is really today's close masquerading as yesterday's —
 * Dhan flips this field at the closing bell, at which point it equals the
 * last price. See top-indices/route.ts's identical helper for the full
 * rationale (including the accepted false positive when a symbol genuinely
 * sits at exactly its previous close).
 */
function rejectFlippedClose(ltp: number, close: number): number {
  return close > 0 && close !== ltp ? close : 0;
}

// ── Contract ids, resolved once per IST day ──────────────────────────────────

let contractCache: { day: string; contracts: ContractMap } | null = null;
let resolveFailedFor = '';

/**
 * Cached contract ids, or null if not resolved yet.
 *
 * NON-BLOCKING: a miss kicks off resolution in the background and returns null,
 * so the first request after a restart answers immediately (with no prices)
 * rather than holding the header hostage to a Python spawn. The next poll a
 * second or two later has them. `dedupe` collapses several open tabs' concurrent
 * first hit onto a single spawn.
 */
function getContracts(): ContractMap | null {
  const day = istToday();
  if (contractCache?.day === day) return contractCache.contracts;
  // One failed resolution per day is enough — otherwise a permanently
  // unresolvable contract spawns Python on every single poll.
  if (resolveFailedFor === day) return null;

  void dedupe(`focus-futs:${day}`, () =>
    runPythonJson<{ success?: boolean; data?: ContractMap }>(FUTS_SCRIPT, [], 30_000))
    .then(out => {
      const contracts = out?.data ?? {};
      if (Object.keys(contracts).length > 0) {
        contractCache = { day, contracts };
      } else {
        resolveFailedFor = day;
      }
    })
    .catch(() => { resolveFailedFor = day; });

  return null;
}

// ── Quotes ───────────────────────────────────────────────────────────────────

interface FutQuote { ltp: number; change_pct: number | null }

let quoteCache: { ts: number; quotes: Record<string, FutQuote> } | null = null;

/** Batch every resolved contract into one OHLC call, grouped by segment. */
async function fetchQuotes(contracts: ContractMap): Promise<Record<string, FutQuote>> {
  const { clientId, token } = getDhanCredentials();
  if (!clientId || !token) throw new Error('Dhan credentials unavailable — run login.py');

  const body: Record<string, number[]> = {};
  for (const c of Object.values(contracts)) {
    (body[c.segment] ??= []).push(c.security_id);
  }

  const res = await fetch(DHAN_OHLC_URL, {
    method: 'POST',
    headers: {
      'access-token': token,
      'client-id': clientId,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });

  const json = (await res.json()) as {
    status?: string;
    Data?: unknown;
    data?: Record<string, Record<string, { last_price?: number; ohlc?: { close?: number } }>>;
  };
  // Throw rather than return {}: GET reports the reason, and with Dhan's ~1 req/s
  // OHLC limit shared across pollers a rejected call is exactly what tends to
  // happen. A silently blank header would be unexplainable.
  if (json.status !== 'success') {
    throw new Error(`ohlc ${res.status}: ${JSON.stringify(json.Data ?? json.status).slice(0, 120)}`);
  }

  const day = istToday();
  prunePrevCloseCache(day);

  const quotes: Record<string, FutQuote> = {};
  for (const [underlying, c] of Object.entries(contracts)) {
    const row = json.data?.[c.segment]?.[String(c.security_id)];
    const ltp = Number(row?.last_price ?? 0);
    if (!(ltp > 0)) continue;

    const key = `${day}:${underlying}`;
    const cached = prevCloseCache.get(key);
    const fresh = rejectFlippedClose(ltp, Number(row?.ohlc?.close ?? 0));
    if (!cached && fresh > 0) prevCloseCache.set(key, fresh);
    const prevClose = cached ?? fresh;

    quotes[underlying] = {
      ltp,
      change_pct: prevClose > 0 ? ((ltp - prevClose) / prevClose) * 100 : null,
    };
  }
  return quotes;
}

export async function GET() {
  const contracts = getContracts();
  if (!contracts) {
    return NextResponse.json({
      success: true, resolving: true, contracts: {}, quotes: {},
      order: UNDERLYINGS,
      error: resolveFailedFor === istToday() ? 'Futures contracts could not be resolved today' : null,
    });
  }

  // A short TTL, because several header instances and the row table all poll.
  // Dhan rate-limits OHLC at roughly one request a second.
  if (quoteCache && Date.now() - quoteCache.ts < QUOTE_TTL_MS) {
    return NextResponse.json({
      success: true, contracts, quotes: quoteCache.quotes,
      order: UNDERLYINGS, cached: true, updated_at: new Date(quoteCache.ts).toISOString(),
    });
  }

  try {
    const quotes = await fetchQuotes(contracts);
    quoteCache = { ts: Date.now(), quotes };
    return NextResponse.json({
      success: true, contracts, quotes,
      order: UNDERLYINGS, updated_at: new Date().toISOString(),
    });
  } catch (err) {
    // Serve the last good quotes rather than blanking the strip — a stale price
    // labelled stale beats no price at all on a rate-limit blip.
    return NextResponse.json({
      success: false,
      contracts,
      quotes: quoteCache?.quotes ?? {},
      order: UNDERLYINGS,
      stale: Boolean(quoteCache),
      updated_at: quoteCache ? new Date(quoteCache.ts).toISOString() : null,
      error: String(err instanceof Error ? err.message : err),
    });
  }
}
