import { NextRequest, NextResponse } from 'next/server';
import { readStockCSV, readNifty500List, listAvailableSymbols, KNOWN_INDICES, readIndexCSV } from '@/lib/dataLoader';
import { loadPreHistory, type PreHistory } from '@/lib/equityPreHistoryServer';

export interface CandleRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface EquityCandlesResponse {
  success: boolean;
  symbol: string;
  candles: CandleRow[];
  dataDate: string | null;
  /** Stocks only: Yahoo daily rows put in front of the CSV (which starts on 2019-01-01), rescaled onto its prices.
   *  `from` / `until` = the stitched span (rows before `until` are Yahoo's). */
  preHistory?: { status: PreHistory['status']; from?: string; until?: string; note?: string };
  error?: string;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbol = (searchParams.get('symbol') ?? '').toUpperCase().trim();

  const indexMeta = KNOWN_INDICES.find((m) => m.key === symbol);

  const available = new Set(listAvailableSymbols());
  const validSymbols = readNifty500List().filter((s) => available.has(s));

  if (!symbol || (!indexMeta && !validSymbols.includes(symbol))) {
    return NextResponse.json(
      { success: false, symbol, candles: [], dataDate: null, error: 'Unknown or missing symbol' } satisfies EquityCandlesResponse,
      { status: 400 }
    );
  }

  try {
    // Return the full available history — the client controls the visible
    // window (period buttons) so users can pan/zoom back into older data
    // that's already loaded instead of hitting a server-side truncation wall.
    const rows = indexMeta ? readIndexCSV(indexMeta) : readStockCSV(symbol);
    const csvCandles: CandleRow[] = rows.map((r) => ({
      date: r.date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
    // Rebased against the rows as shown (after dataLoader's split / bonus adjustments), so the seam lines up with them.
    const pre = indexMeta ? null : await loadPreHistory(symbol, csvCandles);
    const candles = pre && pre.rows.length > 0 ? [...pre.rows, ...csvCandles] : csvCandles;
    const preHistory = pre
      ? {
          status: pre.status,
          ...(pre.rows.length > 0 ? { from: pre.rows[0].date, until: csvCandles[0].date } : {}),
          ...(pre.note ? { note: pre.note } : {}),
        }
      : undefined;

    const dataDate = candles.length > 0 ? candles[candles.length - 1].date : null;

    return NextResponse.json({
      success: true,
      symbol,
      candles,
      dataDate,
      ...(preHistory ? { preHistory } : {}),
    } satisfies EquityCandlesResponse);
  } catch (err) {
    console.error('[/api/equity-candles] Error:', err);
    return NextResponse.json(
      { success: false, symbol, candles: [], dataDate: null, error: String(err) } satisfies EquityCandlesResponse,
      { status: 500 }
    );
  }
}
