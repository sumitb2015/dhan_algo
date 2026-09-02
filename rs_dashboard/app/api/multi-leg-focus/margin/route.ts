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
const CACHE_TTL_MS = 15_000; // 15s cache

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
    const exchangeSegment = underlying === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO';

    // Cache key based on underlying, expiry, and relevant leg properties
    const cacheKey = `${underlying}:${body.expiry}:${body.legs.map(l =>
      `${l.id}:${l.side}:${l.strike}:${l.quantity}:${Math.round((l.price || 0) * 10) / 10}:${l.securityId || ''}:${l.status || ''}`
    ).join('|')}`;

    const hit = marginCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
      return NextResponse.json({ success: true, data: hit.data });
    }

    const legMargins: Record<string, number> = {};
    const defaultSpot = underlying === 'BANKNIFTY' ? 51000 : underlying === 'SENSEX' ? 79000 : 24000;

    // 1. Calculate margin for each leg
    await Promise.all(body.legs.map(async (leg) => {
      if (leg.status === 'CLOSED' || leg.quantity <= 0) {
        legMargins[leg.id] = 0;
        return;
      }

      // BUY leg: broker margin is the option premium (cash debit)
      if (leg.side === 'B') {
        const premium = Math.round((leg.price || 0) * leg.quantity * 100) / 100;
        legMargins[leg.id] = premium;
        return;
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
            return;
          }
        } catch {
          // fall through to estimate
        }
      }

      // Fallback estimate for index options (~10-11% of underlying contract value)
      const estimatedMargin = Math.round(defaultSpot * leg.quantity * 0.11);
      legMargins[leg.id] = estimatedMargin;
    }));

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

    const resultData = {
      legMargins,
      basketMargin,
      overallMargin,
      hedgeBenefit,
      spanMargin,
      exposureMargin,
    };

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
