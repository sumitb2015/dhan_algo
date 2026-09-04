import { NextRequest, NextResponse } from 'next/server';
import { dhanPost } from '@/lib/dhanToken';
import { pacedMarginCall } from '@/lib/ultimateScannerDhan';

interface LegInput {
  id: string;
  side: 'B' | 'S';
  option: 'CE' | 'PE';
  strike: number;
  lots: number;
  quantity: number;
  price: number;
  securityId?: string;
  status?: string;
}

interface MarginRequest {
  underlying: string;
  expiry: string;
  broker?: string;
  legs: LegInput[];
}

interface MarginCacheEntry {
  data: {
    legMargins: Record<string, number>;
    legMarginSource: Record<string, 'live' | 'estimate'>;
    basketMargin: number;
    basketMarginSource: 'live' | 'estimate';
    overallMargin: number;
    hedgeBenefit: number;
    spanMargin: number;
    exposureMargin: number;
  };
  ts: number;
}

/** One retry after a short delay before giving up and falling back to the
 * flat estimate — absorbs a single transient timeout/network blip without
 * needing the whole basket to wait for the estimate on every such blip.
 * Never retries a 429: it's the shared pacer's job (pacedMarginCall in
 * ultimateScannerDhan.ts) to back off and re-space subsequent calls after a
 * rate limit — an immediate 300ms retry is faster than the pacer's own
 * baseline cadence and would almost certainly re-hit the same throttle,
 * wasting the retry and holding up every other queued caller behind it. */
async function withOneRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if ((err as { status?: number })?.status === 429) throw err;
    await new Promise(resolve => setTimeout(resolve, 300));
    return fn();
  }
}

const marginCache = new Map<string, MarginCacheEntry>();
const CACHE_TTL_MS = 60_000; // 60s cache — margin requirements do not change on rapid ticks

const inflightMargins = new Map<string, Promise<MarginCacheEntry['data']>>();

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json() as MarginRequest | null;
    if (!body || !Array.isArray(body.legs) || body.legs.length === 0) {
      return NextResponse.json({
        success: true,
        data: {
          legMargins: {},
          legMarginSource: {},
          basketMargin: 0,
          basketMarginSource: 'live',
          overallMargin: 0,
          hedgeBenefit: 0,
          spanMargin: 0,
          exposureMargin: 0,
        },
      });
    }

    const underlying = (body.underlying || 'NIFTY').toUpperCase();
    const broker = body.broker || 'dhan';
    const isSensex = underlying === 'SENSEX';
    const isCrude = underlying === 'CRUDEOIL' || underlying === 'CRUDEOILM';
    const exchangeSegment = isSensex ? 'BSE_FNO' : (isCrude ? 'MCX_COMM' : 'NSE_FNO');

    // Composition-only cache key: strike/side/quantity/securityId (NO live LTP).
    // Rapid price ticks do not change SPAN/exposure requirements. Broker is
    // included because the same crude quantity means lots on Dhan but barrels
    // elsewhere (see crudeMult below).
    const cacheKey = `${underlying}:${broker}:${body.expiry}:${body.legs.map(l =>
      `${l.id}:${l.side}:${l.strike}:${l.quantity}:${l.securityId || ''}:${l.status || ''}`
    ).join('|')}`;

    const hit = marginCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
      return NextResponse.json({ success: true, data: hit.data });
    }

    // In-flight dedup: concurrent requests for the same basket composition share one evaluation
    if (inflightMargins.has(cacheKey)) {
      const data = await inflightMargins.get(cacheKey);
      return NextResponse.json({ success: true, data });
    }

    const computePromise = (async () => {
      const legMargins: Record<string, number> = {};
      const legMarginSource: Record<string, 'live' | 'estimate'> = {};
      const defaultSpot = underlying === 'BANKNIFTY' ? 51000 : underlying === 'SENSEX' ? 79000 : isCrude ? 8500 : 24000;
      // Dhan's crude quantity is in lots and needs scaling to barrels for rupee
      // math; every other broker already sends quantity in barrels (see
      // lib/multiLegFocus.ts's fallbackLotSize), so no further scaling there.
      const crudeMult = broker !== 'dhan' ? 1 : (underlying === 'CRUDEOIL' ? 100 : underlying === 'CRUDEOILM' ? 10 : 1);
      // Dhan's margin calculator is the only one of the three brokers this
      // dashboard supports that exposes a real SPAN+exposure endpoint —
      // Zerodha/Kotak legs always fall back to the flat estimate below, by
      // necessity rather than failure. legMarginSource still reports that
      // accurately as 'estimate' so the UI doesn't claim a live figure it
      // doesn't have.
      const hasLiveMarginApi = broker === 'dhan';

      // 1. Calculate margin for each leg
      for (const leg of body.legs) {
        if (leg.status === 'CLOSED' || leg.quantity <= 0) {
          legMargins[leg.id] = 0;
          legMarginSource[leg.id] = 'live';
          continue;
        }

        // BUY leg: broker margin is the option premium (cash debit) — this
        // IS the real figure, not an estimate; no margin call needed.
        if (leg.side === 'B') {
          // On Dhan, crude quantity is in lots, so scale by barrel multiplier for rupee cash debit
          const mult = isCrude ? crudeMult : 1;
          const premium = Math.round((leg.price || 0) * leg.quantity * mult * 100) / 100;
          legMargins[leg.id] = premium;
          legMarginSource[leg.id] = 'live';
          continue;
        }

        // SELL leg: writing option requires SPAN + exposure margin
        if (hasLiveMarginApi && leg.securityId) {
          try {
            // Shares the same account-wide lane as the strangle-matrix
            // sweep and the ultimate-scanner's enrichment (pacedMarginCall
            // in ultimateScannerDhan.ts) — without this, this route's own
            // per-leg calls could race those and collectively exceed
            // Dhan's rate limit even though each looks well-paced alone.
            const res = await pacedMarginCall(() => withOneRetry(() => dhanPost('/margincalculator', {
              securityId: String(leg.securityId),
              exchangeSegment,
              transactionType: 'SELL',
              quantity: leg.quantity,
              productType: 'MARGIN',
              price: Number(leg.price) || 0,
            }))) as Record<string, unknown>;

            const totalMargin = Number(res?.totalMargin ?? 0);
            if (totalMargin > 0) {
              legMargins[leg.id] = Math.round(totalMargin);
              legMarginSource[leg.id] = 'live';
              continue;
            }
          } catch (e) {
            // fall through to estimate on broker limit/outage
            const msg = (e as Error).message;
            if (!msg.includes('502') && !msg.includes('429')) {
              console.warn('[/api/multi-leg-focus/margin] leg margin calc fallback:', msg);
            }
          }
        }

        // Fallback estimate (~11-12% of underlying contract value) — used
        // only when a live figure genuinely isn't available: non-Dhan
        // broker, leg not yet resolved to a securityId, or the calculator
        // call itself failed after a retry.
        const mult = isCrude ? crudeMult : 1;
        const estimatedMargin = Math.round(defaultSpot * leg.quantity * mult * 0.12);
        legMargins[leg.id] = estimatedMargin;
        legMarginSource[leg.id] = 'estimate';
      }

      // 2. Calculate portfolio/basket margin with netting
      const activeLegsWithSecId = body.legs.filter(
        l => l.status !== 'CLOSED' && l.quantity > 0 && l.securityId
      );
      const allActiveLegsHaveSecId = activeLegsWithSecId.length ===
        body.legs.filter(l => l.status !== 'CLOSED' && l.quantity > 0).length;

      let basketMargin = 0;
      let basketMarginSource: 'live' | 'estimate' = 'estimate';
      let spanMargin = 0;
      let exposureMargin = 0;

      if (hasLiveMarginApi && activeLegsWithSecId.length > 0) {
        try {
          const scripList = activeLegsWithSecId.map(l => ({
            securityId: String(l.securityId),
            exchangeSegment,
            transactionType: l.side === 'B' ? 'BUY' : 'SELL',
            quantity: l.quantity,
            productType: 'MARGIN',
            price: Number(l.price) || 0,
          }));

          const multiRes = await pacedMarginCall(() => withOneRetry(() => dhanPost('/margincalculator/multi', {
            includePosition: false,
            includeOrders: false,
            scripList,
          }))) as Record<string, unknown>;

          basketMargin = Math.round(Number(multiRes?.totalMargin ?? 0));
          spanMargin = Math.round(Number(multiRes?.spanMargin ?? 0));
          exposureMargin = Math.round(Number(multiRes?.exposure ?? 0));
          // Only a true basket-wide netted figure counts as 'live' — if any
          // active leg was missing a securityId, this call only covered
          // part of the basket and the number is not the real netted total.
          basketMarginSource = allActiveLegsHaveSecId ? 'live' : 'estimate';
        } catch {
          // Fallback: sum of leg margins
          basketMargin = Object.values(legMargins).reduce((a, b) => a + b, 0);
          basketMarginSource = 'estimate';
        }
      } else {
        basketMargin = Object.values(legMargins).reduce((a, b) => a + b, 0);
        basketMarginSource = 'estimate';
      }

      const overallMargin = Object.values(legMargins).reduce((a, b) => a + b, 0);
      const hedgeBenefit = Math.max(0, overallMargin - basketMargin);

      return {
        legMargins,
        legMarginSource,
        basketMargin,
        basketMarginSource,
        overallMargin,
        hedgeBenefit,
        spanMargin,
        exposureMargin,
      };
    })();

    inflightMargins.set(cacheKey, computePromise);
    const resultData = await computePromise.finally(() => inflightMargins.delete(cacheKey));

    marginCache.set(cacheKey, { data: resultData, ts: Date.now() });

    // Prune stale cache entries if too large
    if (marginCache.size > 100) {
      const now = Date.now();
      for (const [k, v] of marginCache.entries()) {
        if (now - v.ts > CACHE_TTL_MS) marginCache.delete(k);
      }
    }

    return NextResponse.json({ success: true, data: resultData });
  } catch (err) {
    console.error('[/api/multi-leg-focus/margin] error:', err);
    return NextResponse.json({
      success: false,
      error: 'Failed to calculate margins',
      detail: String((err as Error).message),
    }, { status: 500 });
  }
}
