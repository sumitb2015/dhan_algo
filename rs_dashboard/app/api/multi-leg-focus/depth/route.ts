import { NextRequest, NextResponse } from 'next/server';
import { getDhanCredentials } from '@/lib/dhanToken';
import { getDhanStrikeLookup } from '@/lib/dhanStrikeLookup';
import { dedupe } from '@/lib/pyExec';
import { pacedQuoteCall } from '@/lib/dhanQuotePacer';

// Top-of-book (best bid/ask) for the legs a Multi-leg Focus order is about to open.
// Market data always comes from Dhan (repo rule), whichever broker trades the basket:
// non-Dhan legs are resolved to Dhan security ids through getDhanStrikeLookup.
// POST /marketfeed/quote is limited to ~1 request/second, so calls are serialised
// through the account-wide quote lane (lib/dhanQuotePacer.ts: 429-aware, capped queue)
// and identical concurrent requests share one upstream call.

const QUOTE_URL = 'https://api.dhan.co/v2/marketfeed/quote';
const QUOTE_TIMEOUT_MS = 6_000;
const MAX_LEGS = 30;

interface LegIn { strike: number; option: 'CE' | 'PE'; expiry: string; securityId?: string }
interface Depth { bid: number; ask: number; bidQty: number; askQty: number; ltp: number }
type QuoteLevel = { price?: number; quantity?: number };
type QuoteRow = { last_price?: number; depth?: { buy?: QuoteLevel[]; sell?: QuoteLevel[] } };

function segmentFor(underlying: string): string {
  if (underlying === 'SENSEX') return 'BSE_FNO';
  if (underlying === 'CRUDEOIL' || underlying === 'CRUDEOILM') return 'MCX_COMM';
  return 'NSE_FNO';
}

// Identical requests inside this window reuse the last answer (a double-click or two
// terminals asking for the same strikes must not spend two of the account's ~1/s calls).
const CACHE_TTL_MS = 1_000;
const recent = new Map<string, { at: number; rows: Record<string, QuoteRow> }>();

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { underlying?: string; legs?: LegIn[] };
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }); }
  const underlying = String(body.underlying ?? '');
  const legs = Array.isArray(body.legs) ? body.legs : [];
  if (!underlying || !legs.length || legs.length > MAX_LEGS) {
    return NextResponse.json({ success: false, error: `Need underlying and 1-${MAX_LEGS} legs` }, { status: 400 });
  }
  for (const l of legs) {
    if (!Number.isFinite(Number(l.strike)) || (l.option !== 'CE' && l.option !== 'PE') || !/^\d{4}-\d{2}-\d{2}$/.test(String(l.expiry))) {
      return NextResponse.json({ success: false, error: 'Each leg needs strike, option (CE/PE) and expiry (YYYY-MM-DD)' }, { status: 400 });
    }
  }

  // Resolve Dhan security ids (client-supplied for Dhan baskets, master-list lookup otherwise).
  const lookups = new Map<string, Awaited<ReturnType<typeof getDhanStrikeLookup>>>();
  await Promise.all([...new Set(legs.filter(l => !l.securityId).map(l => l.expiry))].map(async exp => {
    lookups.set(exp, await getDhanStrikeLookup(underlying, exp));
  }));
  const keyOf = (l: LegIn) => `${l.expiry}:${l.strike}:${l.option}`;
  const idByKey = new Map<string, string>();
  for (const l of legs) {
    const entry = lookups.get(l.expiry)?.strikes[String(l.strike)];
    const id = String(l.securityId || (l.option === 'CE' ? entry?.ceId : entry?.peId) || '');
    if (/^\d+$/.test(id)) idByKey.set(keyOf(l), id);   // client-supplied ids are untrusted: digits only
  }
  const ids = [...new Set(idByKey.values())].sort();
  if (!ids.length) return NextResponse.json({ success: true, data: {} });

  try {
    const { clientId, token } = getDhanCredentials();
    const segment = segmentFor(underlying);
    const cacheKey = `${segment}:${ids.join(',')}`;
    const hit = recent.get(cacheKey);
    const rows = (hit && Date.now() - hit.at < CACHE_TTL_MS) ? hit.rows : await dedupe(`mlf-depth:${cacheKey}`, () => pacedQuoteCall(async () => {
      const res = await fetch(QUOTE_URL, {
        method: 'POST',
        headers: { 'access-token': token, 'client-id': clientId, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ [segment]: ids.map(Number) }),
        signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
      });
      // Tagged so the shared lane widens its gap for every caller.
      if (res.status === 429) throw Object.assign(new Error('Dhan quote rate limited (429)'), { status: 429 });
      if (!res.ok) throw new Error(`Dhan quote HTTP ${res.status}`);
      const json = await res.json() as { data?: Record<string, Record<string, QuoteRow>> };
      const got = json.data?.[segment] ?? {};
      recent.set(cacheKey, { at: Date.now(), rows: got });
      if (recent.size > 50) for (const [k, v] of recent) if (Date.now() - v.at > CACHE_TTL_MS) recent.delete(k);
      return got;
    }));

    const data: Record<string, Depth> = {};
    for (const l of legs) {
      const id = idByKey.get(keyOf(l));
      const row = id ? rows[id] : undefined;
      if (!row || !row.depth) continue; // absent => the client reads it as 'unknown', never 'no_market'
      const buy = row.depth?.buy?.[0], sell = row.depth?.sell?.[0];
      data[keyOf(l)] = {
        bid: Number(buy?.price ?? 0), ask: Number(sell?.price ?? 0),
        bidQty: Number(buy?.quantity ?? 0), askQty: Number(sell?.quantity ?? 0),
        ltp: Number(row.last_price ?? 0),
      };
    }
    return NextResponse.json({ success: true, data });
  } catch (err) {
    // A busy/rate-limited lane is expected under load: the client reads any failure as
    // 'unavailable' and carries on, so keep this quiet and fast.
    const e = err as { busy?: boolean; status?: number; message?: string };
    if (!e.busy && e.status !== 429) console.error('[/api/multi-leg-focus/depth] failed:', err);
    return NextResponse.json({ success: false, error: String(e.message ?? err) }, { status: e.busy || e.status === 429 ? 429 : 502 });
  }
}
