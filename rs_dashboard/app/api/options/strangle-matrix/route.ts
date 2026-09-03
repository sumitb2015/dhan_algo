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
    const chainResults = await Promise.all(
      targetExpiries.map(expiry => fetchUnderlyingChain(underlying, expiry)),
    );

    const step = STRIKE_STEPS[underlying];
    const lotSize = LOT_SIZES[underlying];

    // spot should agree across expiries (same underlying); use the first
    // non-zero one returned.
    const spot = chainResults.find(r => r.spot > 0)?.spot ?? 0;

    const expiries = targetExpiries.map((expiry, i) => ({
      expiry,
      dte: calculateDte(expiry),
    }));

    const rows: { offset: number; cells: (StrangleCell | null)[] }[] = [];

    if (spot > 0) {
      for (let offset = 1; offset <= MAX_OFFSET; offset++) {
        const cells: (StrangleCell | null)[] = targetExpiries.map((expiry, i) => {
          const { chain, spot: expirySpot } = chainResults[i];
          if (expirySpot <= 0) return null;
          const { quotes, strikes } = parseChainQuotes(chain);
          if (strikes.length === 0) return null;
          const atmStrike = strikes.reduce((prev, curr) =>
            Math.abs(curr - expirySpot) < Math.abs(prev - expirySpot) ? curr : prev
          );
          return computeStrangleAtOffset({
            underlying,
            atmStrike,
            offset,
            step,
            spot: expirySpot,
            dte: calculateDte(expiry),
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
