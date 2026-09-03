import { NextRequest, NextResponse } from 'next/server';
import { fetchUnderlyingExpiries, fetchUnderlyingChain } from '@/lib/ultimateScannerDhan';
import { parseChainQuotes, calculateDte, STRIKE_STEPS, LOT_SIZES } from '@/lib/ultimateScannerEngine';
import { computeStrangleAtOffset, type StrangleCell } from '@/lib/strangleMath';
import type { UnderlyingType } from '@/lib/ultimateScannerTypes';

const MAX_EXPIRIES = 5;
const MAX_OFFSET = 15;

interface StrangleMatrixData {
  underlying: UnderlyingType;
  spot: number;
  prevClose: number;
  change: number;
  changePct: number;
  atmStrike: number;
  step: number;
  lotSize: number;
  dataDate: string;
  expiries: { expiry: string; dte: number; atmStrike: number }[];
  rows: { offset: number; cells: (StrangleCell | null)[] }[];
  stale?: boolean;
}

interface CacheEntry {
  data: StrangleMatrixData;
  ts: number;
  ttl: number;
}

const serverCache = new Map<string, CacheEntry>();
const LIVE_CACHE_TTL_MS = 10_000;

export async function GET(request: NextRequest) {
  try {
    const underlyingParam = (request.nextUrl.searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
    if (underlyingParam !== 'NIFTY' && underlyingParam !== 'SENSEX' && underlyingParam !== 'BANKNIFTY') {
      return NextResponse.json({ success: false, error: 'underlying must be NIFTY, BANKNIFTY, or SENSEX' }, { status: 400 });
    }
    const underlying = underlyingParam as UnderlyingType;
    const cacheKey = `strangle-matrix:${underlying}`;
    const paceKey = `dhan-strangle-matrix:${underlying}`;

    const hit = serverCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < hit.ttl) {
      return NextResponse.json({ success: true, ...hit.data }, {
        headers: { 'Cache-Control': 'no-store' }
      });
    }

    try {
      const allExpiries = await fetchUnderlyingExpiries(underlying, paceKey);
      const targetExpiries = allExpiries.slice(0, MAX_EXPIRIES);
      if (targetExpiries.length === 0) {
        throw new Error('No expiries available');
      }

      // Fetch every expiry's chain concurrently
      const chainResults = await Promise.all(
        targetExpiries.map(expiry =>
          fetchUnderlyingChain(underlying, expiry, paceKey).catch(() => ({
            chain: {},
            spot: 0,
            prevClose: 0,
          }))
        ),
      );

      const step = STRIKE_STEPS[underlying] || 50;
      const lotSize = LOT_SIZES[underlying] || 65;

      const spot = chainResults.find(r => r.spot > 0)?.spot ?? 0;
      const prevClose = chainResults.find(r => r.prevClose > 0)?.prevClose ?? spot;
      const change = spot > 0 && prevClose > 0 ? Math.round((spot - prevClose) * 100) / 100 : 0;
      const changePct = prevClose > 0 ? Math.round((change / prevClose) * 10000) / 100 : 0;

      // Precompute per-expiry values once
      const precomputed = targetExpiries.map((expiry, i) => {
        const { chain, spot: expirySpot } = chainResults[i];
        const effectiveSpot = expirySpot > 0 ? expirySpot : spot;
        if (effectiveSpot <= 0) {
          return { quotes: null, atmStrike: 0, dte: 0 };
        }
        const { quotes, strikes } = parseChainQuotes(chain);
        if (strikes.length === 0) {
          return { quotes: null, atmStrike: 0, dte: 0 };
        }
        const atmStrike = strikes.reduce((prev, curr) =>
          Math.abs(curr - effectiveSpot) < Math.abs(prev - effectiveSpot) ? curr : prev
        );
        const dte = calculateDte(expiry);
        return { quotes, atmStrike, dte };
      });

      if (spot <= 0) {
        throw new Error('No chain data available for any expiry');
      }

      // Overall ATM strike
      const primaryAtm = precomputed[0]?.atmStrike || Math.round(spot / step) * step;

      const expiries = targetExpiries.map((expiry, i) => ({
        expiry,
        dte: precomputed[i].dte,
        atmStrike: precomputed[i].atmStrike || primaryAtm,
      }));

      const rows: { offset: number; cells: (StrangleCell | null)[] }[] = [];

      for (let offset = 1; offset <= MAX_OFFSET; offset++) {
        const cells: (StrangleCell | null)[] = targetExpiries.map((expiry, i) => {
          if (!precomputed[i].quotes) return null;
          const { quotes, atmStrike, dte } = precomputed[i];
          if (quotes === null || atmStrike <= 0) return null;
          const { spot: expirySpot } = chainResults[i];
          return computeStrangleAtOffset({
            underlying,
            atmStrike,
            offset,
            step,
            spot: expirySpot > 0 ? expirySpot : spot,
            dte,
            lotSize,
            chainQuotes: quotes,
          });
        });
        rows.push({ offset, cells });
      }

      const todayIso = new Date().toISOString().split('T')[0];
      const data: StrangleMatrixData = {
        underlying,
        spot,
        prevClose,
        change,
        changePct,
        atmStrike: primaryAtm,
        step,
        lotSize,
        dataDate: todayIso,
        expiries,
        rows,
      };

      serverCache.set(cacheKey, { data, ts: Date.now(), ttl: LIVE_CACHE_TTL_MS });

      return NextResponse.json({ success: true, ...data }, {
        headers: { 'Cache-Control': 'no-store' }
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[/api/options/strangle-matrix] Error building matrix:', message);

      if (hit) {
        return NextResponse.json({ success: true, ...hit.data, stale: true }, {
          headers: { 'Cache-Control': 'no-store' }
        });
      }

      return NextResponse.json({ success: false, error: message }, { status: 502 });
    }
  } catch (err) {
    console.error('[/api/options/strangle-matrix GET]', err);
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
}

