import { NextRequest, NextResponse } from 'next/server';
import { readStockCSV } from '@/lib/dataLoader';

function pctMove(closes: number[], lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const prev = closes[closes.length - 1 - lookback];
  if (!prev) return null;
  return ((closes[closes.length - 1] - prev) / prev) * 100;
}

/** Previous month's expiry — the last same-weekday of the preceding month.
 *  Mirrors prev_monthly_expiry() in scripts/tools/csp_scanner.py. */
function prevMonthlyExpiry(expiry: Date): Date {
  const lastPrevMonth = new Date(Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth(), 0));
  const offset = (lastPrevMonth.getUTCDay() - expiry.getUTCDay() + 7) % 7;
  lastPrevMonth.setUTCDate(lastPrevMonth.getUTCDate() - offset);
  return lastPrevMonth;
}

/** 1D / 5D / cycle move for a symbol, from the daily CSV that readStockCSV()
 *  already patches with today's live quote.
 *
 *  "Cycle" means the option cycle — the session after the previous monthly
 *  expiry through today — so it covers the life of the contract being rolled,
 *  the same anchor the scanner's Cycle column uses. Without an `expiry` it
 *  falls back to a 21-session lookback, which is roughly one cycle. */
export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const symbol = (params.get('symbol') ?? '').toUpperCase();
  const expiry = params.get('expiry') ?? '';
  if (!symbol) {
    return NextResponse.json({ success: false, error: 'symbol is required' }, { status: 400 });
  }

  const bars = readStockCSV(symbol).filter((r) => Number.isFinite(r.close) && r.close > 0);
  if (bars.length === 0) {
    return NextResponse.json({ success: false, error: `No daily history for ${symbol}` }, { status: 404 });
  }
  const closes = bars.map((r) => r.close);

  let moveCycle = pctMove(closes, 21);
  let cycleStart: string | null = null;
  const expiryDate = expiry ? new Date(`${expiry.slice(0, 10)}T00:00:00Z`) : null;
  if (expiryDate && !Number.isNaN(expiryDate.getTime())) {
    const prevExpiry = prevMonthlyExpiry(expiryDate).toISOString().slice(0, 10);
    const open = bars.find((r) => r.date > prevExpiry);
    // Only override when the CSV actually reaches back that far; otherwise the
    // 21-session fallback is the more honest number.
    if (open && open.close > 0) {
      cycleStart = open.date;
      moveCycle = ((closes[closes.length - 1] - open.close) / open.close) * 100;
    }
  }

  return NextResponse.json({
    success: true,
    symbol,
    move1d: pctMove(closes, 1),
    move5d: pctMove(closes, 5),
    moveCycle,
    cycleStart,
  });
}
