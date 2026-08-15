import { NextRequest, NextResponse } from 'next/server';
import { readStockCSV } from '@/lib/dataLoader';

function pctMove(closes: number[], lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const prev = closes[closes.length - 1 - lookback];
  if (!prev) return null;
  return ((closes[closes.length - 1] - prev) / prev) * 100;
}

/** 1D / 5D / cycle (21-session) move for a symbol, from the daily CSV that
 *  readStockCSV() already patches with today's live quote. */
export async function GET(req: NextRequest) {
  const symbol = (new URL(req.url).searchParams.get('symbol') ?? '').toUpperCase();
  if (!symbol) {
    return NextResponse.json({ success: false, error: 'symbol is required' }, { status: 400 });
  }

  const closes = readStockCSV(symbol).map((r) => r.close).filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length === 0) {
    return NextResponse.json({ success: false, error: `No daily history for ${symbol}` }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    symbol,
    move1d: pctMove(closes, 1),
    move5d: pctMove(closes, 5),
    moveCycle: pctMove(closes, 21),
  });
}
