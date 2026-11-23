import { NextRequest, NextResponse } from 'next/server';
import { readStockCSVAsync, readNifty500List, readNifty50Index, readNifty500Index, listAvailableSymbols } from '@/lib/dataLoader';
import { NIFTY50_SYMBOLS } from '@/lib/nifty50';
import { getSector } from '@/lib/sectors';
import type { OHLCVRow } from '@/lib/rs';
import { computeScanner, assignRsScores, compareScannerResults } from '@/lib/scannerMath';
import type { ScannerParams, ScannerResult, ScannerResponse } from '@/lib/scannerTypes';
import { DEFAULT_SCANNER_PARAMS } from '@/lib/scannerTypes';

// Re-export so existing imports from this route file continue to work
export type { ScannerParams, ScannerResult, ScannerResponse };
export { DEFAULT_SCANNER_PARAMS };

// ─── Cache ────────────────────────────────────────────────────────────────────
interface ScannerCache { data: ScannerResponse; ts: number; }
const scannerCache = new Map<string, ScannerCache>();
const SCANNER_TTL = 5 * 60 * 1000;

// ─── Main scanner function ────────────────────────────────────────────────────

async function runScanner(indexType: string, params: ScannerParams): Promise<ScannerResponse> {
  const cacheKey = `${indexType}:${Object.values(params).join(',')}`;
  const cached = scannerCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SCANNER_TTL) return cached.data;

  let symbols: string[];
  let indexRows: OHLCVRow[];

  if (indexType === 'nifty50') {
    symbols = NIFTY50_SYMBOLS;
    indexRows = readNifty50Index();
  } else if (indexType === 'nifty500') {
    const list = readNifty500List();
    symbols = list;
    indexRows = await readNifty500Index(list);
  } else {
    symbols = listAvailableSymbols();
    indexRows = await readNifty500Index(readNifty500List());
  }

  const results: ScannerResult[] = [];

  await Promise.all(
    symbols.map(async (symbol) => {
      const rows = await readStockCSVAsync(symbol);
      const r = computeScanner(symbol, rows, indexRows, params, getSector(symbol));
      if (r) results.push(r);
    })
  );

  // RS percentile within this universe, then the default order (score → rsScore → volumeRatio).
  assignRsScores(results);
  results.sort(compareScannerResults);

  const dataDate = results.length > 0
    ? results.reduce((max, r) => r.latestDate > max ? r.latestDate : max, results[0].latestDate)
    : '';

  const data: ScannerResponse = {
    results,
    dataDate,
    universe: indexType,
    totalScanned: symbols.length,
    params,
  };

  scannerCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

// ─── Route handler ────────────────────────────────────────────────────────────

function parseIntParam(val: string | null, def: number): number {
  const n = parseInt(val ?? '', 10);
  return isNaN(n) ? def : n;
}

function parseFloatParam(val: string | null, def: number): number {
  const n = parseFloat(val ?? '');
  return isNaN(n) ? def : n;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const indexType = searchParams.get('index') ?? 'nifty50';

  const d = DEFAULT_SCANNER_PARAMS;
  const params: ScannerParams = {
    rsiPeriod:    parseIntParam(searchParams.get('rsiPeriod'),    d.rsiPeriod),
    emaPeriod1:   parseIntParam(searchParams.get('emaPeriod1'),   d.emaPeriod1),
    emaPeriod2:   parseIntParam(searchParams.get('emaPeriod2'),   d.emaPeriod2),
    emaPeriod3:   parseIntParam(searchParams.get('emaPeriod3'),   d.emaPeriod3),
    macdFast:     parseIntParam(searchParams.get('macdFast'),     d.macdFast),
    macdSlow:     parseIntParam(searchParams.get('macdSlow'),     d.macdSlow),
    macdSignal:   parseIntParam(searchParams.get('macdSignal'),   d.macdSignal),
    stPeriod:     parseIntParam(searchParams.get('stPeriod'),     d.stPeriod),
    stMultiplier: parseFloatParam(searchParams.get('stMultiplier'), d.stMultiplier),
    bbPeriod:     parseIntParam(searchParams.get('bbPeriod'),     d.bbPeriod),
    adxPeriod:    parseIntParam(searchParams.get('adxPeriod'),    d.adxPeriod),
    atrPeriod:    parseIntParam(searchParams.get('atrPeriod'),    d.atrPeriod),
    volMaPeriod:  parseIntParam(searchParams.get('volMaPeriod'),  d.volMaPeriod),
  };

  try {
    const data = await runScanner(indexType, params);
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('[/api/scanner] Error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
