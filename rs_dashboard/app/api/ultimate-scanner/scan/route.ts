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
    const sortCandidates = (a: ScannedStrategy, b: ScannedStrategy) => {
      if (filters.sortBy === 'rom') return b.romPct - a.romPct;
      if (filters.sortBy === 'pop') return b.popPct - a.popPct;
      if (filters.sortBy === 'premium') return b.netPremium - a.netPremium;
      if (filters.sortBy === 'distance') return b.distancePct - a.distancePct;
      return b.score - a.score;
    };
    allCandidates.sort(sortCandidates);

    // A flat maxResults cut here, applied before the client's strategy-type
    // pills filter this same response (see ScannerStep.tsx — switching pills
    // never refetches), silently starves any type whose margin formula gives
    // it a structurally lower RoM%/score than cheap-margin verticals. A
    // Short Strangle needs ~₹120k margin vs a Bull Put/Bear Call Spread's
    // ~₹18k, so spreads and Iron Condors fill every slot in the global top-N
    // and the Short Strangle pill shows zero candidates even when real ones
    // exist (verified against /options/strangle-matrix, which computes the
    // same short_strangle math unfiltered and shows plenty). Guarantee every
    // type keeps a minimum slice before the combined cap.
    const perTypeGuarantee = Math.max(10, Math.ceil(filters.maxResults / 5));
    const seenIds = new Set<string>();
    const shortlisted: ScannedStrategy[] = [];
    for (const c of allCandidates) {
      if (shortlisted.length >= filters.maxResults) break;
      shortlisted.push(c);
      seenIds.add(c.id);
    }
    const perTypeCounts = new Map<string, number>();
    for (const c of shortlisted) perTypeCounts.set(c.type, (perTypeCounts.get(c.type) ?? 0) + 1);
    for (const c of allCandidates) {
      if (seenIds.has(c.id)) continue;
      const count = perTypeCounts.get(c.type) ?? 0;
      if (count >= perTypeGuarantee) continue;
      shortlisted.push(c);
      seenIds.add(c.id);
      perTypeCounts.set(c.type, count + 1);
    }
    shortlisted.sort(sortCandidates);

    // Every candidate's estMargin is a flat per-strategy formula (e.g. a fixed
    // ₹120,000 for any 1-lot NIFTY strangle) — good enough to filter/rank the
    // full combinatorial search cheaply, but not the real netted margin Dhan
    // would actually block. Replace it with the real figure (via Dhan's own
    // multi-leg margin calculator) for the top candidates actually shown to
    // the user. Capped and sequential — doing this for every evaluated combo
    // (100s) would blow the request's time budget. Pacing/backoff against
    // Dhan's account-wide rate limit lives once, centrally, inside
    // fetchNettedMargin() (see ultimateScannerDhan.ts) — it's shared with
    // every other caller (e.g. the strangle-matrix background sweep), so no
    // extra delay is added here.
    const ENRICH_TOP_N = 12;
    const enrichCount = Math.min(ENRICH_TOP_N, shortlisted.length);
    for (let i = 0; i < enrichCount; i++) {
      // The client's Stop button aborts this request — no point spending more
      // Dhan margin calls once nobody is waiting on them.
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
