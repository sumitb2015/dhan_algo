import { NextRequest, NextResponse } from 'next/server';
import {
  fetchLiveIndiaVix,
  fetchUnderlyingChain,
  fetchUnderlyingExpiries,
  fetchNettedMargin,
  type MarginLeg,
} from '@/lib/ultimateScannerDhan';
import {
  parseChainQuotes,
  scanOptionChain,
} from '@/lib/ultimateScannerEngine';
import type {
  ScanFilters,
  ScanResponse,
  ScannedStrategy,
} from '@/lib/ultimateScannerTypes';

export async function POST(request: NextRequest): Promise<NextResponse<ScanResponse>> {
  try {
    const body = await request.json() as Partial<ScanFilters> & { broker?: string };

    const filters: ScanFilters = {
      underlying: body.underlying ?? 'NIFTY',
      expiry: body.expiry,
      minRom: Number(body.minRom ?? 1.0),
      minDistancePct: Number(body.minDistancePct ?? 0.5),
      maxDistancePct: Number(body.maxDistancePct ?? 5.0),
      riskProfile: body.riskProfile ?? 'all',
      strategyTypes: Array.isArray(body.strategyTypes) ? body.strategyTypes : [],
      maxResults: Number(body.maxResults ?? 60),
      sortBy: body.sortBy ?? 'score',
    };

    const u = filters.underlying;

    // Fetch VIX and the underlying's chain concurrently.
    const [vixInfo, resolvedExpiry, chainResult] = await (async () => {
      let targetExpiry = filters.expiry;
      const [vix, expiryList] = await Promise.all([
        fetchLiveIndiaVix(),
        targetExpiry ? Promise.resolve<string[]>([]) : fetchUnderlyingExpiries(u),
      ]);
      if (!targetExpiry) targetExpiry = expiryList[0];
      if (!targetExpiry) return [vix, undefined, null] as const;
      const chain = await fetchUnderlyingChain(u, targetExpiry);
      return [vix, targetExpiry, chain] as const;
    })();

    const spotPrices: Record<string, number> = {};
    const allCandidates: ScannedStrategy[] = [];
    let scannedCount = 0;
    let totalCombos = 0;

    if (resolvedExpiry && chainResult) {
      const { chain, spot } = chainResult;
      if (spot > 0) {
        spotPrices[u] = spot;
      }

      const { quotes, strikes } = parseChainQuotes(chain);
      if (strikes.length > 0) {
        scannedCount += strikes.length;
        totalCombos += strikes.length * (strikes.length - 1);

        const found = scanOptionChain(
          u,
          resolvedExpiry,
          spot,
          quotes,
          strikes,
          filters,
          vixInfo.vix,
        );
        allCandidates.push(...found);
      }
    }

    // Sort combined results
    allCandidates.sort((a, b) => {
      if (filters.sortBy === 'rom') return b.romPct - a.romPct;
      if (filters.sortBy === 'pop') return b.popPct - a.popPct;
      if (filters.sortBy === 'premium') return b.netPremium - a.netPremium;
      if (filters.sortBy === 'distance') return b.distancePct - a.distancePct;
      return b.score - a.score;
    });

    const shortlisted = allCandidates.slice(0, filters.maxResults);

    // Every candidate's estMargin is a flat per-strategy formula (e.g. a fixed
    // ₹120,000 for any 1-lot NIFTY strangle) — good enough to filter/rank the
    // full combinatorial search cheaply, but not the real netted margin Dhan
    // would actually block. Replace it with the real figure (via Dhan's own
    // multi-leg margin calculator) for the top candidates actually shown to
    // the user. Capped and sequential, paced to respect Dhan's ~1 req/s limit —
    // doing this for every evaluated combo (100s) would blow both the request's
    // time budget and the rate limit.
    const ENRICH_TOP_N = 12;
    const enrichCount = Math.min(ENRICH_TOP_N, shortlisted.length);
    for (let i = 0; i < enrichCount; i++) {
      // The client's Stop button aborts this request — no point spending more
      // Dhan margin calls (or the pacing delay) once nobody is waiting on them.
      if (request.signal.aborted) break;
      const candidate = shortlisted[i];
      const legs: MarginLeg[] = candidate.legs.map(leg => ({
        side: leg.side,
        securityId: leg.securityId ?? '',
        quantity: leg.lots * leg.lotSize,
      }));
      if (legs.some(leg => !leg.securityId)) continue;

      const liveMargin = await fetchNettedMargin(candidate.underlying, legs);
      if (liveMargin !== null) {
        candidate.estMargin = liveMargin;
        candidate.romPct = Math.round((candidate.netPremium / liveMargin) * 100 * 100) / 100;
        candidate.romAnnualizedPct = Math.round((candidate.romPct / Math.max(1, candidate.dte)) * 365);
        candidate.marginSource = 'live';
      }
      if (i < enrichCount - 1) {
        await new Promise(resolve => setTimeout(resolve, 1100));
      }
    }

    return NextResponse.json({
      success: true,
      spotPrices,
      vix: vixInfo,
      scannedCount,
      combosEvaluated: totalCombos,
      shortlistedCount: shortlisted.length,
      candidates: shortlisted,
      dataDate: new Date().toISOString().split('T')[0],
    });
  } catch (err: unknown) {
    console.error('[/api/ultimate-scanner/scan error]', err);
    return NextResponse.json(
      {
        success: false,
        error: String((err as Error).message || err),
        spotPrices: {},
        vix: {
          vix: 11.34,
          prevClose: 11.34,
          change: 0,
          changePct: 0,
          regime: 'Low Volatility',
          advice: 'Scan error',
        },
        scannedCount: 0,
        combosEvaluated: 0,
        shortlistedCount: 0,
        candidates: [],
      },
      { status: 500 },
    );
  }
}
