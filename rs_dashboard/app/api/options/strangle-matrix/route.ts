import { NextRequest, NextResponse } from 'next/server';
import { fetchUnderlyingExpiries, fetchUnderlyingChain } from '@/lib/ultimateScannerDhan';
import { parseChainQuotes, calculateDte, STRIKE_STEPS, LOT_SIZES } from '@/lib/ultimateScannerEngine';
import { computeStrangleAtOffset, type StrangleCell } from '@/lib/strangleMath';
import type { UnderlyingType } from '@/lib/ultimateScannerTypes';

const MAX_EXPIRIES = 4;
const MAX_OFFSET = 15;

export async function GET(request: NextRequest) {
  try {
    const underlyingParam = (request.nextUrl.searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
    if (underlyingParam !== 'NIFTY' && underlyingParam !== 'SENSEX') {
      return NextResponse.json({ success: false, error: 'underlying must be NIFTY or SENSEX' }, { status: 400 });
    }
    const underlying = underlyingParam as UnderlyingType;

    const allExpiries = await fetchUnderlyingExpiries(underlying);
    const targetExpiries = allExpiries.slice(0, MAX_EXPIRIES);
    if (targetExpiries.length === 0) {
      return NextResponse.json({ success: false, error: 'No expiries available' }, { status: 502 });
    }

    // Fetch every expiry's chain concurrently — same pattern as
    // /api/ultimate-scanner/scan's VIX+chain Promise.all.
    // Wrap each fetch with its own catch so one bad expiry degrades to null
    // cells for that column instead of failing the whole matrix.
    const chainResults = await Promise.all(
      targetExpiries.map(expiry =>
        fetchUnderlyingChain(underlying, expiry).catch(() => ({
          chain: {},
          spot: 0,
          prevClose: 0,
        }))
      ),
    );

    const step = STRIKE_STEPS[underlying];
    const lotSize = LOT_SIZES[underlying];

    // spot should agree across expiries (same underlying); use the first
    // non-zero one returned.
    const spot = chainResults.find(r => r.spot > 0)?.spot ?? 0;

    const expiries = targetExpiries.map((expiry) => ({
      expiry,
      dte: calculateDte(expiry),
    }));

    // Precompute per-expiry values (parseChainQuotes, atmStrike, dte) once,
    // before the offset loop, to avoid 15× recomputation per expiry.
    const precomputed = targetExpiries.map((expiry, i) => {
      const { chain, spot: expirySpot } = chainResults[i];
      if (expirySpot <= 0) {
        return { quotes: null, atmStrike: null, dte: 0 };
      }
      const { quotes, strikes } = parseChainQuotes(chain);
      if (strikes.length === 0) {
        return { quotes: null, atmStrike: null, dte: 0 };
      }
      const atmStrike = strikes.reduce((prev, curr) =>
        Math.abs(curr - expirySpot) < Math.abs(prev - expirySpot) ? curr : prev
      );
      const dte = calculateDte(expiry);
      return { quotes, atmStrike, dte };
    });

    const rows: { offset: number; cells: (StrangleCell | null)[] }[] = [];

    if (spot > 0) {
      for (let offset = 1; offset <= MAX_OFFSET; offset++) {
        const cells: (StrangleCell | null)[] = targetExpiries.map((expiry, i) => {
          const { chain, spot: expirySpot } = chainResults[i];
          if (expirySpot <= 0) return null;
          const { quotes, atmStrike, dte } = precomputed[i];
          if (quotes === null || atmStrike === null) return null;
          return computeStrangleAtOffset({
            underlying,
            atmStrike,
            offset,
            step,
            spot: expirySpot,
            dte,
            lotSize,
            chainQuotes: quotes,
          });
        });
        rows.push({ offset, cells });
      }
    }

    return NextResponse.json({
      success: true,
      underlying,
      spot,
      expiries,
      rows,
    });
  } catch (err) {
    console.error('[/api/options/strangle-matrix GET]', err);
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
