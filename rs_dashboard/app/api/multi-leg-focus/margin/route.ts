import { NextRequest, NextResponse } from 'next/server';
import { dhanPost } from '@/lib/dhanToken';

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
    basketMargin: number;
    overallMargin: number;
    hedgeBenefit: number;
    spanMargin: number;
    exposureMargin: number;
  };
  ts: number;
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
          basketMargin: 0,
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
      const defaultSpot = underlying === 'BANKNIFTY' ? 51000 : underlying === 'SENSEX' ? 79000 : isCrude ? 8500 : 24000;
      // Dhan's crude quantity is in lots and needs scaling to barrels for rupee
      // math; every other broker already sends quantity in barrels (see
      // lib/multiLegFocus.ts's fallbackLotSize), so no further scaling there.
      const crudeMult = broker !== 'dhan' ? 1 : (underlying === 'CRUDEOIL' ? 100 : underlying === 'CRUDEOILM' ? 10 : 1);

      // 1. Calculate margin for each leg
      for (const leg of body.legs) {
        if (leg.status === 'CLOSED' || leg.quantity <= 0) {
          legMargins[leg.id] = 0;
          continue;
        }

        // BUY leg: broker margin is the option premium (cash debit)
        if (leg.side === 'B') {
          // On Dhan, crude quantity is in lots, so scale by barrel multiplier for rupee cash debit
          const mult = isCrude ? crudeMult : 1;
          const premium = Math.round((leg.price || 0) * leg.quantity * mult * 100) / 100;
          legMargins[leg.id] = premium;
          continue;
        }

        // SELL leg: writing option requires SPAN + exposure margin
        if (leg.securityId) {
          try {
            const res = await dhanPost('/margincalculator', {
              securityId: String(leg.securityId),
              exchangeSegment,
              transactionType: 'SELL',
              quantity: leg.quantity,
              productType: 'MARGIN',
              price: Number(leg.price) || 0,
            }) as Record<string, unknown>;

            const totalMargin = Number(res?.totalMargin ?? 0);
            if (totalMargin > 0) {
              legMargins[leg.id] = Math.round(totalMargin);
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

        // Fallback estimate (~11-12% of underlying contract value)
        const mult = isCrude ? crudeMult : 1;
        const estimatedMargin = Math.round(defaultSpot * leg.quantity * mult * 0.12);
        legMargins[leg.id] = estimatedMargin;
      }

      // 2. Calculate portfolio/basket margin with netting
      const activeLegsWithSecId = body.legs.filter(
        l => l.status !== 'CLOSED' && l.quantity > 0 && l.securityId
      );

      let basketMargin = 0;
      let spanMargin = 0;
      let exposureMargin = 0;

      if (activeLegsWithSecId.length > 0) {
        try {
          const scripList = activeLegsWithSecId.map(l => ({
            securityId: String(l.securityId),
            exchangeSegment,
            transactionType: l.side === 'B' ? 'BUY' : 'SELL',
            quantity: l.quantity,
            productType: 'MARGIN',
            price: Number(l.price) || 0,
          }));

          const multiRes = await dhanPost('/margincalculator/multi', {
            includePosition: false,
            includeOrders: false,
            scripList,
          }) as Record<string, unknown>;

          basketMargin = Math.round(Number(multiRes?.totalMargin ?? 0));
          spanMargin = Math.round(Number(multiRes?.spanMargin ?? 0));
          exposureMargin = Math.round(Number(multiRes?.exposure ?? 0));
        } catch {
          // Fallback: sum of leg margins
          basketMargin = Object.values(legMargins).reduce((a, b) => a + b, 0);
        }
      } else {
        basketMargin = Object.values(legMargins).reduce((a, b) => a + b, 0);
      }

      const overallMargin = Object.values(legMargins).reduce((a, b) => a + b, 0);
      const hedgeBenefit = Math.max(0, overallMargin - basketMargin);

      return {
        legMargins,
        basketMargin,
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
