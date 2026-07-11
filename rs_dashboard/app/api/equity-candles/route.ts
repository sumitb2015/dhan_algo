import { NextRequest, NextResponse } from 'next/server';
import { readStockCSV } from '@/lib/dataLoader';
import { NIFTY50_SYMBOLS } from '@/lib/nifty50';

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
  error?: string;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbol = (searchParams.get('symbol') ?? '').toUpperCase().trim();

  if (!symbol || !NIFTY50_SYMBOLS.includes(symbol)) {
    return NextResponse.json(
      { success: false, symbol, candles: [], dataDate: null, error: 'Unknown or missing symbol' } satisfies EquityCandlesResponse,
      { status: 400 }
    );
  }

  try {
    // Return the full available history — the client controls the visible
    // window (period buttons) so users can pan/zoom back into older data
    // that's already loaded instead of hitting a server-side truncation wall.
    const rows = readStockCSV(symbol);
    const candles: CandleRow[] = rows.map((r) => ({
      date: r.date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));

    const dataDate = candles.length > 0 ? candles[candles.length - 1].date : null;

    return NextResponse.json({
      success: true,
      symbol,
      candles,
      dataDate,
    } satisfies EquityCandlesResponse);
  } catch (err) {
    console.error('[/api/equity-candles] Error:', err);
    return NextResponse.json(
      { success: false, symbol, candles: [], dataDate: null, error: String(err) } satisfies EquityCandlesResponse,
      { status: 500 }
    );
  }
}
