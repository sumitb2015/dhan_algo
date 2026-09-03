import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PROJECT_ROOT, PYTHON_EXE, dedupe, spaced } from '@/lib/pyExec';
import {
  parseChainQuotes,
  scanOptionChain,
} from '@/lib/ultimateScannerEngine';
import type {
  ScanFilters,
  ScanResponse,
  ScannedStrategy,
  UnderlyingType,
} from '@/lib/ultimateScannerTypes';

const execFileAsync = promisify(execFile);
const FETCH_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_data_fetch.py');

interface VixResult {
  vix: number;
  prevClose: number;
  change: number;
  changePct: number;
  regime: string;
  advice: string;
}

function computeVixRegime(vix: number): { regime: string; advice: string } {
  if (vix <= 12.5) {
    return {
      regime: 'Low Volatility',
      advice: 'Premiums are low. Prioritize tight Bull Put / Bear Call spreads or calendar spreads. Strangles require larger moves for safety.',
    };
  } else if (vix <= 16.5) {
    return {
      regime: 'Normal / Ideal Volatility',
      advice: 'Ideal regime for range-bound credit spreads, Iron Condors, and short strangles. Healthy premium decay with balanced risk.',
    };
  } else if (vix <= 22.0) {
    return {
      regime: 'Elevated Volatility',
      advice: 'High premium collection opportunities. Use wider wings on Iron Condors and seek 2.5%+ OTM distance for credit spreads.',
    };
  } else {
    return {
      regime: 'High Volatility / Panic',
      advice: 'Extreme implied volatility. Strictly trade defined-risk credit spreads with wide safety buffers (3.5%+ OTM). Avoid undefined naked risk.',
    };
  }
}

async function fetchUnderlyingChain(underlying: string, expiry: string): Promise<{
  chain: Record<string, unknown>;
  spot: number;
  prevClose: number;
}> {
  const cacheKey = `scanner-chain:${underlying}:${expiry}`;
  const { stdout } = await dedupe(cacheKey, () =>
    spaced(`dhan-spawn:${underlying}`, () =>
      execFileAsync(
        PYTHON_EXE,
        [FETCH_SCRIPT, 'chain', '--underlying', underlying, '--expiry', expiry],
        { encoding: 'utf8', timeout: 45_000, windowsHide: true },
      ),
    ),
  );

  const jsonLine = (stdout ?? '').trim().split('\n').pop() ?? '{}';
  const parsed = JSON.parse(jsonLine) as {
    chain?: Record<string, unknown>;
    spot?: number;
    prev_close?: number;
    error?: string;
  };

  return {
    chain: parsed.chain ?? {},
    spot: parsed.spot ?? 0,
    prevClose: parsed.prev_close ?? 0,
  };
}

async function fetchUnderlyingExpiries(underlying: string): Promise<string[]> {
  try {
    const { stdout } = await dedupe(`scanner-expiries:${underlying}`, () =>
      spaced(`dhan-spawn:${underlying}`, () =>
        execFileAsync(
          PYTHON_EXE,
          [FETCH_SCRIPT, 'expiries', '--underlying', underlying],
          { encoding: 'utf8', timeout: 30_000, windowsHide: true },
        ),
      ),
    );
    const jsonLine = (stdout ?? '').trim().split('\n').pop() ?? '{}';
    const parsed = JSON.parse(jsonLine) as { expiries?: string[] };
    return parsed.expiries ?? [];
  } catch {
    return [];
  }
}

export async function POST(request: NextRequest): Promise<NextResponse<ScanResponse>> {
  try {
    const body = await request.json() as Partial<ScanFilters> & { broker?: string };
    
    const filters: ScanFilters = {
      underlying: body.underlying ?? 'ALL',
      expiry: body.expiry,
      minRom: Number(body.minRom ?? 1.5),
      minDistancePct: Number(body.minDistancePct ?? 1.0),
      maxDistancePct: Number(body.maxDistancePct ?? 6.0),
      riskProfile: body.riskProfile ?? 'all',
      strategyTypes: Array.isArray(body.strategyTypes) ? body.strategyTypes : [],
      maxResults: Number(body.maxResults ?? 60),
      sortBy: body.sortBy ?? 'score',
    };

    // 1. Fetch India VIX
    let vixInfo: VixResult = {
      vix: 13.5,
      prevClose: 13.5,
      change: 0,
      changePct: 0,
      regime: 'Normal Volatility',
      advice: 'Ideal regime for credit spreads and Iron Condors.',
    };

    try {
      const vixQuotesFile = path.join(PROJECT_ROOT, 'debug', 'live_indices_quotes.json');
      if (fs.existsSync(vixQuotesFile)) {
        const raw = JSON.parse(fs.readFileSync(vixQuotesFile, 'utf8'));
        const vixVal = raw['INDIA VIX']?.ltp || raw['INDIAVIX']?.ltp || raw['VIX']?.ltp;
        const prevClose = raw['INDIA VIX']?.prev_close || raw['INDIAVIX']?.prev_close || vixVal;
        if (vixVal && vixVal > 0) {
          const change = vixVal - (prevClose || vixVal);
          const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;
          const { regime, advice } = computeVixRegime(vixVal);
          vixInfo = {
            vix: Math.round(vixVal * 100) / 100,
            prevClose: Math.round(prevClose * 100) / 100,
            change: Math.round(change * 100) / 100,
            changePct: Math.round(changePct * 100) / 100,
            regime,
            advice,
          };
        }
      }
    } catch {}

    // 2. Determine target underlyings
    const targetUnderlyings: UnderlyingType[] = 
      filters.underlying === 'ALL'
        ? ['NIFTY', 'SENSEX']
        : [filters.underlying];

    const spotPrices: Record<string, number> = {};
    const allCandidates: ScannedStrategy[] = [];
    let scannedCount = 0;
    let totalCombos = 0;

    for (const u of targetUnderlyings) {
      // Resolve expiry
      let targetExpiry = filters.expiry;
      if (!targetExpiry) {
        const expiries = await fetchUnderlyingExpiries(u);
        targetExpiry = expiries[0];
      }

      if (!targetExpiry) continue;

      const { chain, spot } = await fetchUnderlyingChain(u, targetExpiry);
      if (spot > 0) {
        spotPrices[u] = spot;
      }

      const { quotes, strikes } = parseChainQuotes(chain);
      if (strikes.length > 0) {
        scannedCount += strikes.length;
        totalCombos += strikes.length * (strikes.length - 1);
        
        const found = scanOptionChain(
          u,
          targetExpiry,
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
          vix: 14,
          prevClose: 14,
          change: 0,
          changePct: 0,
          regime: 'Normal',
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
