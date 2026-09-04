import { NextRequest, NextResponse } from 'next/server';
import { fetchUnderlyingExpiries, fetchUnderlyingChain } from '@/lib/ultimateScannerDhan';
import { parseChainQuotes, calculateDte, STRIKE_STEPS, LOT_SIZES } from '@/lib/ultimateScannerEngine';
import { computeStrangleAtOffset, type StrangleCell } from '@/lib/strangleMath';
import type { UnderlyingType } from '@/lib/ultimateScannerTypes';
import { dedupe } from '@/lib/pyExec';
import { getCachedMargin, triggerMarginSweep, sweepStats } from '@/lib/marginSweep';

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
  marginSweep: { total: number; live: number; sweeping: boolean };
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
      // The margin-enrichment pass below can add several seconds to a cache
      // miss; without this, two requests racing the same miss (a second
      // browser tab, or a poll tick firing just as the cache expires) would
      // each independently rebuild the whole grid and double the Dhan calls
      // (chain fetches AND margin calls) in flight at once.
      const data = await dedupe(`build:${cacheKey}`, async (): Promise<StrangleMatrixData> => {
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
            const { quotes, atmStrike, dte } = precomputed[i];
            if (!quotes || atmStrike <= 0) return null;
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

        // Every cell's estMargin is a flat per-underlying constant — good
        // enough to compute the whole 5-expiry x 15-offset grid cheaply, but
        // not the real netted SPAN+exposure margin Dhan would actually block.
        // Overlay the real figure wherever a background sweep (marginSweep.ts)
        // has already fetched it via Dhan's own multi-leg margin calculator,
        // then kick off (or continue) that sweep for whatever's still stale —
        // fire-and-forget, not awaited, so this request never blocks on it.
        // At ~1 req/s a full 75-cell grid takes ~80s; the sweep runs across
        // requests/poll ticks rather than inside any single one of them.
        const allCells = rows
          .flatMap(row => row.cells.map((cell, expiryIdx) => ({ cell, dte: precomputed[expiryIdx]?.dte ?? 1 })))
          .filter((c): c is { cell: StrangleCell; dte: number } => c.cell !== null);

        for (const { cell, dte } of allCells) {
          const liveMargin = getCachedMargin(underlying, cell.putSecurityId, cell.callSecurityId);
          if (liveMargin !== null) {
            cell.estMargin = liveMargin;
            cell.romPct = Math.round((cell.netPremium / liveMargin) * 100 * 100) / 100;
            cell.romAnnualizedPct = Math.round((cell.romPct / Math.max(0.5, dte)) * 365);
            cell.marginSource = 'live';
          }
        }

        const sweepCandidates = allCells
          .filter(c => c.cell.putSecurityId && c.cell.callSecurityId)
          .map(c => ({ putSecurityId: c.cell.putSecurityId!, callSecurityId: c.cell.callSecurityId! }));
        triggerMarginSweep(underlying, lotSize, sweepCandidates);
        const marginSweep = sweepStats(underlying, sweepCandidates);

        const todayIso = new Date().toISOString().split('T')[0];
        return {
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
          marginSweep,
        };
      });

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
